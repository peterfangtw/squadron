import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TextDecoder } from 'util';
import type { ChildProcess } from 'child_process';
import { invoke, spawned } from '../executables/internal';
import type { ConsoleLogin, Effects } from './index';
import { Operation } from './operation';
import { refused } from './index';

declare const __SQUADRON_CONSOLE_LOGIN_SHA256__: string;

export interface WindowsEffects extends Effects {
  readonly architecture: string;
  artifact(): { executable: string; sha256: string };
  readArtifact(file: string): Promise<Buffer>;
  readonly ownerPid: number;
}

export function artifactAt(directory: string): { executable: string; sha256: string } {
  if (typeof __SQUADRON_CONSOLE_LOGIN_SHA256__ !== 'string')
    throw new Error('Console login build pin unavailable.');
  return {
    executable: path.resolve(directory, 'helpers/console-login-v1.exe'),
    sha256: __SQUADRON_CONSOLE_LOGIN_SHA256__
  };
}

export async function readArtifact(file: string): Promise<Buffer> {
  const held = await fs.open(file, 'r');
  try {
    const stat = await held.stat();
    if (!stat.isFile() || stat.size < 512 || stat.size > 1048576)
      throw new Error('Console login artifact size refused.');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await held.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Console login artifact changed.');
    return bytes.subarray(0, bytesRead);
  } finally {
    await held.close();
  }
}

export function consoleLogin(effects: WindowsEffects): ConsoleLogin {
  if (effects.architecture !== 'x64') return refused('win32');
  let live: Operation | undefined;
  let birth: string | undefined;
  let disposal: ReturnType<ConsoleLogin['dispose']> | undefined;
  return {
    support: { supported: true },
    run(program, args, options) {
      if (disposal || live)
        return {
          supported: true,
          status: 'failed',
          reason: 'Console login is busy or cleanup is unresolved.'
        };
      return spawned(() =>
        invoke(program, args, (image, argv) => {
          if (
            !path.win32.isAbsolute(image) ||
            !/\.(exe|com)$/i.test(image) ||
            !path.win32.isAbsolute(options.cwd) ||
            [image, options.cwd, ...argv].some((text) => text.includes('\0')) ||
            argv.length > 4096
          )
            throw new Error('Console login requires an absolute executable, cwd and valid argv.');
          const operation = new Operation(
            () => {
              live = undefined;
            },
            undefined,
            4000
          );
          live = operation;
          // Admission returns before preflight can emit any event.
          queueMicrotask(() => {
            void prepare(operation, image, argv, options.cwd, options.beforeLaunch);
          });
          return operation;
        })
      );
    },
    dispose() {
      return (disposal ??= live?.dispose() ?? Promise.resolve({ unresolved: [] }));
    }
  };

  async function prepare(
    operation: Operation,
    image: string,
    argv: string[],
    cwd: string,
    beforeLaunch?: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const preparationDeadline = performance.now() + 5000;
    const preparing = operation.after(5000, () =>
      operation.fail('Console login preparation expired.')
    );
    try {
      if (operation.cause) {
        operation.finish(operation.cause);
        return;
      }
      const artifact = effects.artifact();
      if (
        !path.win32.isAbsolute(artifact.executable) ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        crypto
          .createHash('sha256')
          .update(await effects.readArtifact(artifact.executable))
          .digest('hex') !== artifact.sha256
      )
        throw new Error('Console login artifact verification failed.');
      if (operation.cause) {
        operation.finish(operation.cause);
        return;
      }
      if (performance.now() >= preparationDeadline)
        throw new Error('Console login preparation expired.');
      if (birth === undefined) {
        let identity: Record<string, unknown> | undefined;
        const result = await native(
          operation,
          effects,
          artifact.executable,
          ['owner-identity', String(effects.ownerPid)],
          (kind, bytes) => {
            if (kind !== 1 || identity) throw new Error('Console login identity protocol failed.');
            identity = control(bytes);
          }
        );
        if (operation.cause) {
          operation.finish(operation.cause);
          return;
        }
        if (
          result !== 0 ||
          !identity ||
          identity.version !== 1 ||
          identity.pid !== effects.ownerPid ||
          typeof identity.birth !== 'string' ||
          !/^[0-9]{1,19}$/.test(identity.birth)
        )
          throw new Error('Console login owner identity failed.');
        birth = identity.birth;
      }
      if (performance.now() >= preparationDeadline)
        throw new Error('Console login preparation expired.');
      await beforeLaunch?.(operation.signal);
      if (performance.now() >= preparationDeadline)
        throw new Error('Console login preparation expired.');
      if (operation.cause || operation.expired()) {
        operation.finish(operation.cause ?? { kind: 'failed', reason: 'Login expired.' });
        return;
      }
      operation.clear(preparing);
      const nonce = crypto.randomBytes(16).toString('hex');
      let ready = false;
      let cleaned = false;
      let completion: { kind: 'exited'; code: number } | undefined;
      const starting = operation.after(10000, () =>
        operation.fail('Console login did not become ready.')
      );
      const readyDeadline = performance.now() + 10000;
      const request = frame(
        1,
        Buffer.from(
          JSON.stringify({
            version: 1,
            kind: 'start',
            nonce,
            ownerPid: effects.ownerPid,
            ownerBirth: birth,
            image,
            args: argv,
            cwd,
            expires: operation.expires
          })
        )
      );
      const result = await native(
        operation,
        effects,
        artifact.executable,
        [],
        (kind, bytes) => {
          if (cleaned) throw new Error('Console login output after completion.');
          if (kind === 2 || kind === 3) {
            if (!ready || bytes.length > 65536)
              throw new Error('Console login output protocol failed.');
            operation.output(kind === 2 ? 'stdout' : 'stderr', bytes);
            return;
          }
          const value = control(bytes);
          if (value.version !== 1 || value.nonce !== nonce)
            throw new Error('Console login protocol mismatch.');
          if (
            kind === 1 &&
            value.kind === 'ready' &&
            !ready &&
            value.helperPid === operation.child?.pid &&
            Number.isSafeInteger(value.cliPid) &&
            (value.cliPid as number) > 0 &&
            (value.cliPid as number) <= 2147483647 &&
            typeof value.cliBirth === 'string' &&
            /^[0-9]{1,19}$/.test(value.cliBirth) &&
            typeof value.helperBirth === 'string' &&
            /^[0-9]{1,19}$/.test(value.helperBirth)
          ) {
            if (performance.now() >= readyDeadline)
              throw new Error('Console login did not become ready.');
            ready = true;
            operation.birth = value.helperBirth;
            operation.unresolved = [
              {
                kind: 'job',
                pid: value.cliPid as number,
                birth: value.cliBirth,
                monitor: { pid: operation.child?.pid, birth: value.helperBirth }
              }
            ];
            operation.clear(starting);
            operation.markReady();
          } else if (
            kind === 4 &&
            value.kind === 'exited' &&
            ready &&
            Number.isInteger(value.code) &&
            value.cleaned === true
          ) {
            cleaned = true;
            if (operation.expired()) throw new Error('Console login expired.');
            completion = { kind: 'exited', code: value.code as number };
          } else if (kind === 5 && value.kind === 'cleaned' && !cleaned) {
            cleaned = true;
            operation.fail(
              typeof value.reason === 'string' && /^[a-z-]{1,64}$/.test(value.reason)
                ? `Console login stopped after confirmed cleanup: ${value.reason}.`
                : 'Console login stopped after confirmed cleanup.'
            );
          } else throw new Error('Console login unexpected frame.');
        },
        request,
        () => cleaned
      );
      if (!operation.cause && (result !== 0 || !completion))
        operation.fail('Console login helper failed or closed without completion.');
      operation.finish(
        completion ?? operation.cause ?? { kind: 'failed', reason: 'Console login incomplete.' }
      );
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : 'Console login failed.');
      // native() settles only on close. Preflight errors own no child.
      if (!operation.child)
        operation.finish(operation.cause ?? { kind: 'failed', reason: 'Console login failed.' });
    } finally {
      operation.clear(preparing);
    }
  }
}

function control(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Console login invalid control.');
  return value as Record<string, unknown>;
}

function frame(kind: number, bytes: Buffer): Buffer {
  if (bytes.length > 98304) throw new Error('Console login control limit exceeded.');
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32LE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/** The native child remains owned until close, including error and forced-stop paths. */
function native(
  operation: Operation,
  effects: WindowsEffects,
  file: string,
  args: string[],
  receive: (kind: number, bytes: Buffer) => void,
  request?: Buffer,
  cleanupConfirmed?: () => boolean
): Promise<number | null> {
  return new Promise((resolve) => {
    const child: ChildProcess = effects.spawn(file, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    operation.child = child;
    operation.birth = undefined;
    if (request)
      operation.unresolved = [
        {
          kind: 'job',
          pid: undefined,
          birth: undefined,
          monitor: { pid: child.pid, birth: undefined }
        }
      ];
    let pending = Buffer.alloc(0),
      diagnostic = 0;
    child.on('error', () => operation.fail('Console login helper could not start.'));
    child.stdin?.on('error', () => operation.fail('Console login control pipe failed.'));
    child.stderr?.on('data', (bytes: Buffer) => {
      diagnostic += bytes.length;
      if (diagnostic > 16384) operation.fail('Console login diagnostic limit exceeded.');
    });
    child.stdout?.on('data', (bytes: Buffer) => {
      try {
        if (pending.length + bytes.length > 262144)
          throw new Error('Console login transport limit exceeded.');
        operation.transport(pending.length + bytes.length);
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= 5) {
          const size = pending.readUInt32LE(1),
            kind = pending[0];
          if (size > 98304 || kind === undefined)
            throw new Error('Console login frame limit exceeded.');
          if (pending.length < size + 5) break;
          const body = pending.subarray(5, 5 + size);
          pending = pending.subarray(5 + size);
          operation.transport(pending.length);
          receive(kind, body);
        }
      } catch (error) {
        operation.fail(error instanceof Error ? error.message : 'Console login framing failed.');
      }
    });
    child.on('close', (code) => {
      if (pending.length && !operation.cause) operation.fail('Console login incomplete frame.');
      if (cleanupConfirmed?.()) operation.unresolved = [];
      operation.child = undefined;
      operation.transport(0);
      resolve(code);
    });
    if (request) child.stdin?.write(request);
    if (operation.cause) child.stdin?.end();
  });
}
