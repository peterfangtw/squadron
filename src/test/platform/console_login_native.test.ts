import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, after, describe, it } from 'node:test';
import * as build from '../../../scripts/console-login-helper.mjs';
import * as roots from '../../../scripts/fixture-roots.cjs';
import * as win32 from '../../core/platform/console_login/win32';
import type { ConsoleLogin, LoginChild, LoginCompletion } from '../../core/platform/console_login';
import * as executables from '../../core/platform/executables';
import * as helpers from '../helpers';
import * as net from 'node:net';

const nativeSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows console helper';
const owners: ConsoleLogin[] = [];
const unresolvedOwners = new Set<ConsoleLogin>();
interface Descendant {
  pid: number;
  birth: string;
  port: number;
  root: { pid: number; birth: string };
  outputType?: number;
  errorType?: number;
  outputClosed?: boolean;
  errorClosed?: boolean;
}
let home: string, script: string, fixture: string, artifact: { executable: string; sha256: string };
function owner(ownerPid = process.pid, spawned?: (child: cp.ChildProcess) => void): ConsoleLogin {
  const result = win32.consoleLogin({
    architecture: 'x64',
    artifact: () => artifact,
    readArtifact: win32.readArtifact,
    ownerPid,
    spawn: (file, args, options) => {
      const child = cp.spawn(file, args, {
        ...options,
        env: { ...process.env, ...roots.environment(home) }
      });
      if (!args.length) spawned?.(child);
      return child;
    }
  });
  owners.push(result);
  return result;
}
function start(backend: ConsoleLogin, args: string[]): LoginChild {
  const result = backend.run(executables.named(script, process.execPath), args, { cwd: home });
  assert.ok(result.supported && result.status === 'ok');
  return result.value;
}
function collect(
  child: LoginChild
): Promise<{ completion: LoginCompletion; out: string; err: string; errors: string[] }> {
  const output: Buffer[] = [],
    error: Buffer[] = [],
    errors: string[] = [];
  child.stdout.on('data', (bytes: Buffer) => output.push(bytes));
  child.stderr.on('data', (bytes: Buffer) => error.push(bytes));
  child.on('error', (value) => errors.push(value.message));
  return new Promise((resolve) =>
    child.on('close', (completion) =>
      resolve({
        completion,
        out: Buffer.concat(output).toString('utf8'),
        err: Buffer.concat(error).toString('utf8'),
        errors
      })
    )
  );
}

describe(
  'packaged Windows console login',
  { skip: nativeSkip, timeout: 60000 + 10 * 30000 + 50000 + 90000 },
  () => {
    before(
      async () => {
        home = roots.create('squadron-console-native-');
        script = path.join(home, "CLI 空白 & 'quote.js");
        const manifest = build.prepare(helpers.repoRoot()) as { sha256: string };
        artifact = {
          executable: path.join(helpers.repoRoot(), 'dist/helpers/console-login-v1.exe'),
          sha256: manifest.sha256
        };
        fixture = path.join(home, 'native-fixture.exe');
        cp.execFileSync(
          path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
          [
            '/nologo',
            '/target:exe',
            `/out:${fixture}`,
            path.join(helpers.repoRoot(), 'src/test/fixtures/console_login_native.cs')
          ],
          { windowsHide: true, timeout: 10000 }
        );
        await fs.writeFile(
          script,
          `
      const mode = process.argv[2];
      if (!process.stdin.isTTY) process.exit(23);
      if (mode === 'normal') {
        process.stdout.write(JSON.stringify(process.argv.slice(3)));
        process.stderr.write('stderr-中文-☕');
      } else if (mode === 'flood') {
        const chunk = Buffer.alloc(65536);
        function write() { while (process.stdout.write(chunk)) {} process.stdout.once('drain',write); } write();
      } else {
        process.on('SIGINT', () => process.exit(0));
        process.stdout.write('waiting\\n'); setInterval(() => {}, 1000);
      }
    `
        );
      },
      { timeout: 60000 }
    );
    after(
      async () => {
        try {
          for (const backend of owners) {
            const result = await backend.dispose();
            if (unresolvedOwners.has(backend)) assert.equal(result.unresolved[0]?.kind, 'job');
            else assert.deepEqual(result, { unresolved: [] });
          }
        } finally {
          if (home) roots.remove(home);
        }
      },
      { timeout: 90000 }
    );

    it(
      'supplies console stdin and exact runtime/script argv, with independent UTF-8 streams',
      { timeout: 30000 },
      async () => {
        const args = ['', 'space 空白', 'a"b', 'trailing\\', '&|<>^!%PATH%', 'line\nbreak'];
        const result = await collect(start(owner(), ['normal', ...args]));
        assert.deepEqual(result.completion, { kind: 'exited', code: 0 });
        assert.deepEqual(JSON.parse(result.out), args);
        assert.equal(result.err, 'stderr-中文-☕');
        assert.deepEqual(result.errors, []);
      }
    );

    it('runs a native COM image admitted by the executable owner', { timeout: 30000 }, async () => {
      const file = path.join(home, 'native-target.com');
      await fs.copyFile(fixture, file);
      for (const forward of [false, true]) {
        const result = owner().run(
          executables.named(forward ? file.replaceAll('\\', '/') : file),
          ['normal'],
          { cwd: forward ? home.replaceAll('\\', '/') : home }
        );
        assert.ok(result.supported && result.status === 'ok');
        const completed = await collect(result.value);
        assert.deepEqual(completed.completion, { kind: 'exited', code: 0 });
        assert.equal(completed.out, 'native');
      }
    });

    it(
      'acknowledges a pre-job refusal and admits a replacement login',
      { timeout: 30000 },
      async () => {
        const backend = owner();
        const failed = await collect(start(backend, ['x'.repeat(33000)]));
        assert.equal(failed.completion.kind, 'failed');
        assert.equal(failed.errors.length, 1);
        assert.deepEqual((await collect(start(backend, ['normal']))).completion, {
          kind: 'exited',
          code: 0
        });
      }
    );

    it('accepts a drive-root working directory', { timeout: 30000 }, async () => {
      const result = owner().run(executables.named(fixture), ['normal'], {
        cwd: path.parse(home).root
      });
      assert.ok(result.supported && result.status === 'ok');
      const completed = await collect(result.value);
      assert.deepEqual(completed.completion, { kind: 'exited', code: 0 });
      assert.equal(completed.out, 'native');
    });

    it(
      'latches cancellation over a CLI exit of zero, refuses overlap, then permits a confirmed replacement',
      { timeout: 30000 },
      async () => {
        const backend = owner(),
          child = start(backend, ['hold']);
        const completed = collect(child);
        await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
        const busy = backend.run(executables.named(script, process.execPath), ['normal'], {
          cwd: home
        });
        assert.ok(busy.supported && busy.status === 'failed');
        child.cancel();
        child.cancel();
        const held = backend.run(executables.named(script, process.execPath), ['normal'], {
          cwd: home
        });
        assert.ok(
          held.supported && held.status === 'failed',
          'replacement waits for job cleanup acknowledgement'
        );
        assert.equal((await completed).completion.kind, 'cancelled');
        assert.deepEqual((await collect(start(backend, ['normal']))).completion, {
          kind: 'exited',
          code: 0
        });
      }
    );

    it(
      'cancels preflight without launch and fails output overflow with confirmed cleanup',
      { timeout: 30000 },
      async () => {
        const backend = owner(),
          child = start(backend, ['hold']);
        const completed = collect(child);
        child.cancel();
        assert.equal((await completed).completion.kind, 'cancelled');
        const flood = await collect(start(backend, ['flood']));
        assert.equal(flood.completion.kind, 'failed');
        assert.equal(flood.errors.length, 1);
      }
    );

    it('refuses changed artifact bytes before native launch', { timeout: 30000 }, async () => {
      const backend = win32.consoleLogin({
        architecture: 'x64',
        artifact: () => ({ ...artifact, sha256: '0'.repeat(64) }),
        readArtifact: win32.readArtifact,
        ownerPid: process.pid,
        spawn() {
          throw new Error('artifact mismatch must not spawn');
        }
      });
      owners.push(backend);
      const result = await collect(start(backend, ['normal']));
      assert.equal(result.completion.kind, 'failed');
      assert.match(result.errors[0] ?? '', /artifact verification/);
    });

    it(
      'confirms exact contained descendants before replacement after cancellation, drain failure and normal root exit',
      { timeout: 30000 },
      async (t) => {
        for (const mode of ['tree', 'drain', 'exit-tree']) {
          let monitor: cp.ChildProcess | undefined;
          const backend = owner(process.pid, (child) => {
            monitor = child;
          });
          const started = performance.now();
          const result = backend.run(executables.named(fixture), [mode], { cwd: home });
          assert.ok(result.supported && result.status === 'ok');
          const child = result.value;
          const completed = collect(child);
          const value = await descendant(child);
          if (mode === 'tree') {
            assert.ok(monitor?.pid);
            const resources: unknown = JSON.parse(
              cp
                .execFileSync(
                  fixture,
                  ['resources', String(monitor.pid), String(value.root.pid), String(value.pid)],
                  {
                    windowsHide: true,
                    timeout: 6000,
                    env: { ...process.env, ...roots.environment(home) }
                  }
                )
                .toString()
            );
            t.diagnostic(JSON.stringify({ mode, readyMs: performance.now() - started, resources }));
          }
          if (mode === 'exit-tree') {
            assert.equal(value.outputType, 3, 'captured stdout was inherited as a pipe');
            assert.equal(value.errorType, 3, 'captured stderr was inherited as a pipe');
            assert.equal(value.outputClosed, true);
            assert.equal(value.errorClosed, true);
          }
          if (mode === 'tree') child.cancel();
          const receipt = await completed;
          t.diagnostic(
            JSON.stringify({
              mode,
              descendant: value,
              completion: receipt.completion,
              errors: receipt.errors
            })
          );
          assert.equal(
            receipt.completion.kind,
            mode === 'tree' ? 'cancelled' : mode === 'drain' ? 'failed' : 'exited'
          );
          await listenerGone(value.port);
          assert.match(member('observe', value), /^(gone|exited|replaced)$/);
          assert.deepEqual((await collect(start(backend, ['normal']))).completion, {
            kind: 'exited',
            code: 0
          });
        }
      }
    );

    it('confirms contained cleanup after exact owner loss', { timeout: 30000 }, async (t) => {
      const caller = cp.spawn(
        process.execPath,
        ['-e', 'process.stdin.resume(); process.stdout.write("ready");'],
        {
          windowsHide: true,
          env: { ...process.env, ...roots.environment(home) }
        }
      );
      const callerClosed = new Promise<void>((resolve) => caller.on('close', () => resolve()));
      try {
        await new Promise<void>((resolve) => caller.stdout.once('data', () => resolve()));
        assert.ok(caller.pid);
        const backend = owner(caller.pid);
        const result = backend.run(executables.named(fixture), ['tree'], { cwd: home });
        assert.ok(result.supported && result.status === 'ok');
        const completed = collect(result.value);
        const value = await descendant(result.value);
        caller.kill();
        await callerClosed;
        assert.equal((await completed).completion.kind, 'failed');
        await listenerGone(value.port);
        assert.match(member('observe', value), /^(gone|exited|replaced)$/);
        assert.deepEqual(await backend.dispose(), { unresolved: [] });
        t.diagnostic(
          JSON.stringify({ mode: 'owner-loss', ownerPid: caller.pid, descendant: value })
        );
      } finally {
        caller.kill();
        await callerClosed;
      }
    });

    it(
      'retains admission and unresolved job identity after forced monitor death',
      { timeout: 30000 },
      async (t) => {
        let monitor: cp.ChildProcess | undefined;
        const backend = owner(process.pid, (child) => {
          monitor = child;
        });
        unresolvedOwners.add(backend);
        const result = backend.run(executables.named(fixture), ['tree'], { cwd: home });
        assert.ok(result.supported && result.status === 'ok');
        const completed = collect(result.value);
        const value = await descendant(result.value);
        assert.ok(monitor?.pid);
        monitor.kill();
        assert.equal((await completed).completion.kind, 'failed');
        const replacement = backend.run(executables.named(fixture), ['normal'], { cwd: home });
        assert.ok(
          replacement.supported && replacement.status === 'failed',
          'monitor death cannot release admission'
        );
        const disposal = await backend.dispose();
        assert.equal(disposal.unresolved.length, 1);
        assert.equal(disposal.unresolved[0]?.kind, 'job');
        assert.equal(disposal.unresolved[0]?.pid, value.root.pid);
        assert.equal(disposal.unresolved[0]?.birth, value.root.birth);
        assert.equal(disposal.unresolved[0]?.monitor?.pid, monitor.pid);
        assert.match(disposal.unresolved[0]?.birth ?? '', /^[0-9]{1,19}$/);
        // The fixture independently waits for this exact descendant, without promoting the backend's evidence.
        assert.match(member('wait-member', value), /^(gone|exited|replaced)$/);
        await listenerGone(value.port);
        t.diagnostic(JSON.stringify({ mode: 'forced-monitor-death', descendant: value, disposal }));
      }
    );

    it(
      'rejects malformed, oversized, partial and unknown-version native controls within the startup bound',
      { timeout: 50000 },
      async () => {
        const bodies = [
          Buffer.from('{'),
          Buffer.from(JSON.stringify({ version: 2 })),
          Buffer.from([1, 1, 128, 1, 0]),
          Buffer.from([1, 4])
        ];
        for (let at = 0; at < bodies.length; at++) {
          const body = bodies[at]!;
          const child = cp.spawn(artifact.executable, [], {
            windowsHide: true,
            env: { ...process.env, ...roots.environment(home) }
          });
          child.stdout.resume();
          child.stderr.resume();
          const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
          const timer = setTimeout(() => {
            child.kill();
          }, 12000);
          if (at < 2) {
            const head = Buffer.alloc(5);
            head[0] = 1;
            head.writeUInt32LE(body.length, 1);
            child.stdin.end(Buffer.concat([head, body]));
          } else child.stdin.end(body);
          assert.equal(await closed, 31);
          clearTimeout(timer);
        }
      }
    );
  }
);

function descendant(child: LoginChild): Promise<Descendant> {
  return new Promise((resolve) =>
    child.stdout.once('data', (bytes: Buffer) =>
      resolve(JSON.parse(bytes.toString().trim()) as Descendant)
    )
  );
}

async function listenerGone(port: number): Promise<void> {
  const connected = await new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
  assert.equal(
    connected,
    false,
    'the grandchild callback listener is gone immediately after confirmed cleanup'
  );
}

function member(mode: string, value: { pid: number; birth: string }): string {
  return cp
    .execFileSync(fixture, [mode, String(value.pid), value.birth], {
      windowsHide: true,
      timeout: 6000,
      env: { ...process.env, ...roots.environment(home) }
    })
    .toString();
}
