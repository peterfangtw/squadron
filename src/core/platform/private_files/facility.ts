import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { host } from '../host';
import type { Identity } from './index';

declare const __SQUADRON_PRIVATE_FILES_SHA256__: string;

export interface Artifact {
  readonly executable: string;
  readonly sha256: string;
}

export interface Request {
  readonly operation: 'check' | 'ensure' | 'create' | 'open' | 'read';
  readonly purpose: 'directory' | 'managed' | 'attachment';
  readonly path: string;
  readonly maximum: number;
  readonly signal?: AbortSignal;
  readonly expires: number;
}

export class NativeFailure extends Error {
  readonly code: string | undefined;
  constructor(
    readonly kind: 'io' | 'refused',
    readonly reason: string
  ) {
    super(`private-files native ${kind}: ${reason}`);
    const errors: Readonly<Record<string, string>> = {
      '2': 'ENOENT',
      '3': 'ENOENT',
      '5': 'EACCES',
      '32': 'EBUSY',
      '80': 'EEXIST',
      '183': 'EEXIST'
    };
    this.code = kind === 'io' ? (errors[reason] ?? 'EIO') : undefined;
  }
}

interface Frame {
  readonly kind: number;
  readonly bytes: Buffer;
}

/** Location data never supplies the expected hash. It comes from the same-version bundle. */
export function artifactAt(extensionRoot: string): Artifact {
  if (!path.isAbsolute(extensionRoot) || typeof __SQUADRON_PRIVATE_FILES_SHA256__ !== 'string')
    throw new Error('private-files build pin unavailable');
  return {
    executable: path.join(extensionRoot, 'dist/helpers/private-files-v1.exe'),
    sha256: __SQUADRON_PRIVATE_FILES_SHA256__
  };
}

export async function artifactFromLocator(file: string): Promise<Artifact> {
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await boundedFile(file, 16384))
  );
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('private-files invalid locator');
  const record = value as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    record.protocol !== 1 ||
    typeof record.extensionRoot !== 'string' ||
    record.extensionRoot.length > 4096 ||
    !path.isAbsolute(record.extensionRoot)
  )
    throw new Error('private-files incompatible locator');
  return artifactAt(record.extensionRoot);
}

/** Copied verbs carry the build pin and consume the locator beside their payload. */
export async function artifactBeside(directory: string): Promise<Artifact> {
  if (path.basename(directory) === '.scripts')
    return artifactFromLocator(path.join(directory, 'private-files-v1.locator.json'));
  return artifactAt(path.resolve(directory, '..'));
}

/** One explicit operation owner; construction starts no work. Close awaits every owned child. */
export class Facility {
  private disposed = false;
  private live = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly children = new Set<Child>();
  private readonly ending = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private birth: string | undefined;

  constructor(private readonly artifact: Artifact) {}

  async directory(root: string): Promise<string> {
    const signal = this.shutdown.signal;
    const release = await this.admit(signal);
    let child: Child | undefined;
    try {
      await this.verify();
      child = this.launch(['directory', String(process.pid), root], signal);
      const fields = control(await child.receive()).split('\n');
      if (
        fields.length !== 6 ||
        fields[0] !== '1' ||
        fields[1] !== 'directory' ||
        fields[2] !== String(process.pid) ||
        !/^[0-9]{1,19}$/.test(fields[3] ?? '') ||
        !/^S-1-[0-9-]+$/.test(fields[4] ?? '') ||
        fields[5] !== path.join(root, `squadron-incoming-${fields[4]}`)
      )
        throw new Error('private-files directory reply mismatch');
      await child.finish();
      signal.throwIfAborted();
      return fields[5];
    } finally {
      if (child) await this.finish(child, release);
      else release();
    }
  }

  async start(request: Request): Promise<Session> {
    validateRequest(request);
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(request.signal ? [request.signal] : [])
    ]);
    // Incoming expiry tests mock Date.now; helper deadlines must keep real wall time.
    const began = new Date().getTime();
    const release = await this.admit(signal);
    let child: Child | undefined;
    try {
      if (this.disposed) throw new Error('private-files owner disposed');
      await this.verify();
      signal.throwIfAborted();
      if (new Date().getTime() - began >= 5000 || new Date().getTime() >= request.expires)
        throw new Error('private-files startup expired');
      if (this.birth === undefined) {
        const identity = this.launch(['identity', String(process.pid)], signal);
        child = identity;
        try {
          const fields = control(await identity.receive()).split('\n');
          if (
            fields.length !== 5 ||
            fields[0] !== '1' ||
            fields[1] !== 'identity' ||
            fields[2] !== String(process.pid) ||
            !/^[0-9]{1,19}$/.test(fields[3] ?? '') ||
            !/^S-1-/.test(fields[4] ?? '')
          )
            throw new Error('private-files owner identity mismatch');
          await identity.finish();
          this.birth = fields[3];
        } finally {
          await this.end(identity);
          child = undefined;
        }
      }
      signal.throwIfAborted();
      if (new Date().getTime() - began >= 5000 || new Date().getTime() >= request.expires)
        throw new Error('private-files startup expired');
      child = this.launch([], signal);
      const nonce = crypto.randomBytes(16).toString('hex');
      const expiry = Math.min(request.expires, new Date().getTime() + 120000);
      await child.send(
        1,
        Buffer.from(
          [
            '1',
            nonce,
            process.pid,
            this.birth,
            expiry,
            request.operation,
            request.purpose,
            request.maximum,
            request.path
          ].join('\n')
        )
      );
      const fields = control(await child.receive()).split('\n');
      signal.throwIfAborted();
      if (this.disposed || new Date().getTime() - began >= 5000 || new Date().getTime() >= expiry)
        throw new Error('private-files late startup');
      if (
        fields.length !== 7 ||
        fields[0] !== '1' ||
        fields[1] !== nonce ||
        fields[2] !== '0' ||
        !/^[0-9a-f]{32}$/.test(fields[3] ?? '') ||
        fields[4] !== 'ready' ||
        !/^win32-file-id-v1:[a-f0-9]{16}:[a-f0-9]{32}$/.test(fields[5] ?? '')
      )
        throw new Error('private-files startup reply mismatch');
      const heldChild = child;
      const session = new Session(
        child,
        nonce,
        fields[3] ?? '',
        fields[5] as Identity,
        numeric(fields[6]),
        { ...request, expires: expiry },
        async () => {
          await this.finish(heldChild, release);
        }
      );
      if (request.operation === 'check' || request.operation === 'ensure') await session.close();
      return session;
    } catch (error) {
      if (child) await this.finish(child, release);
      else release();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort();
    await Promise.all([...this.children].map((child) => this.end(child)));
    await Promise.all(this.ending);
  }

  private async verify(): Promise<void> {
    if (
      host !== 'win32' ||
      process.arch !== 'x64' ||
      !path.isAbsolute(this.artifact.executable) ||
      !/^[a-f0-9]{64}$/.test(this.artifact.sha256)
    )
      throw new Error('private-files unsupported artifact/target');
    const record: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await boundedFile(this.artifact.executable.replace(/\.exe$/, '.json'), 16384)
      )
    );
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new Error('private-files invalid manifest');
    const manifest = record as Record<string, unknown>;
    if (
      manifest.schema !== 1 ||
      manifest.protocol !== 1 ||
      manifest.target !== 'win32-x64' ||
      manifest.framework !== '4.8.1' ||
      manifest.policy !== 'development-unsigned' ||
      manifest.sha256 !== this.artifact.sha256
    )
      throw new Error('private-files manifest mismatch');
    const bytes = await boundedFile(this.artifact.executable, 1048576);
    if (
      bytes.length > 1048576 ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== this.artifact.sha256
    )
      throw new Error('private-files artifact digest mismatch');
  }

  private launch(args: string[], signal: AbortSignal): Child {
    signal.throwIfAborted();
    const child = new Child(this.artifact.executable, args, signal);
    this.children.add(child);
    return child;
  }

  private async end(child: Child): Promise<void> {
    const ended = child.stop();
    this.ending.add(ended);
    try {
      await ended;
      this.children.delete(child);
    } finally {
      this.ending.delete(ended);
    }
  }

  private async finish(child: Child, release: () => void): Promise<void> {
    void child.closure.then(() => {
      this.children.delete(child);
      release();
    });
    await this.end(child);
  }

  private async admit(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('private-files owner disposed');
    if (this.live >= 2) {
      if (this.waiters.length >= 32) throw new Error('private-files admission full');
      await new Promise<void>((resolve, reject) => {
        const remove = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          const at = this.waiters.indexOf(ready);
          if (at >= 0) this.waiters.splice(at, 1);
        };
        const ready = (): void => {
          remove();
          resolve();
        };
        const abort = (): void => {
          remove();
          reject(new Error('private-files admission cancelled'));
        };
        const timer = setTimeout(() => {
          remove();
          reject(new Error('private-files admission expired'));
        }, 5000);
        signal.addEventListener('abort', abort, { once: true });
        this.waiters.push(ready);
      });
    } else this.live++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.live--;
    };
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }
}

export class Session {
  private sequence = 0;
  private busy = false;
  private ended: Promise<void> | undefined;
  private boundBytes = 0;

  constructor(
    private readonly child: Child,
    private readonly nonce: string,
    private readonly token: string,
    readonly identity: Identity,
    readonly size: number,
    private readonly request: Request,
    private readonly end: () => Promise<void>
  ) {}

  async bound(file: string): Promise<boolean> {
    if (file.length > 32000 || /[\r\n\0]/.test(file))
      throw new Error('private-files invalid binding path');
    return (await this.command('bound', 0, 0, file)) as boolean;
  }

  async boundSize(file: string): Promise<number | undefined> {
    return (await this.bound(file)) ? this.boundBytes : undefined;
  }

  /** Chunk bytes are provisional until the helper acknowledges whole-read validation. */
  async readAll(): Promise<Buffer> {
    if (this.request.operation !== 'read') throw new Error('private-files managed read required');
    try {
      const bytes = Buffer.alloc(this.size);
      for (let at = 0; at < bytes.length; at += 65536) {
        const chunk = (await this.command(
          'read',
          at,
          Math.min(65536, bytes.length - at)
        )) as Buffer;
        chunk.copy(bytes, at);
      }
      await this.command('complete');
      await this.close();
      this.child.assertActive();
      if (new Date().getTime() >= this.request.expires)
        throw new Error('private-files session expired');
      return bytes;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async command(
    operation: 'bound' | 'sync' | 'write' | 'read' | 'complete',
    offset = 0,
    data: Buffer | number = 0,
    file = this.request.path
  ): Promise<boolean | Buffer | void> {
    if (this.busy || this.ended) throw new Error('private-files session unavailable');
    if (this.request.signal?.aborted || new Date().getTime() >= this.request.expires) {
      await this.close();
      throw new Error('private-files session expired');
    }
    if (
      operation === 'write' &&
      (!Buffer.isBuffer(data) || data.length > 65536 || this.request.operation !== 'create')
    )
      throw new Error('private-files invalid write');
    if (
      operation === 'read' &&
      (typeof data !== 'number' ||
        !Number.isSafeInteger(data) ||
        data < 0 ||
        data > 65536 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > this.size + (this.request.operation === 'open' ? 1 : 0) - data ||
        (this.request.operation !== 'open' && this.request.operation !== 'read'))
    )
      throw new Error('private-files invalid read');
    this.busy = true;
    try {
      const sequence = ++this.sequence;
      const fields = ['1', this.nonce, sequence, this.token, operation];
      if (operation === 'bound') fields.push(file);
      if (operation === 'write') fields.push((data as Buffer).length);
      if (operation === 'read') fields.push(offset, data as number);
      await this.child.send(1, Buffer.from(fields.join('\n')));
      if (operation === 'write') await this.child.send(2, data as Buffer);
      const reply = control(await this.child.receive()).split('\n');
      this.child.assertActive();
      if (new Date().getTime() >= this.request.expires)
        throw new Error('private-files session expired');
      if (
        reply.length !== (operation === 'bound' ? 7 : 6) ||
        reply[0] !== '1' ||
        reply[1] !== this.nonce ||
        reply[2] !== String(sequence) ||
        reply[3] !== this.token ||
        reply[4] !== operation
      )
        throw new Error('private-files reply mismatch');
      if (operation === 'bound') {
        if (reply[5] !== 'true' && reply[5] !== 'false')
          throw new Error('private-files binding reply mismatch');
        this.boundBytes = numeric(reply[6]);
        return reply[5] === 'true';
      }
      if (operation === 'read') {
        const received = numeric(reply[5]);
        if (received > (data as number) || (this.request.operation === 'read' && received !== data))
          throw new Error('private-files read reply mismatch');
        const frame = await this.child.receive();
        this.child.assertActive();
        if (new Date().getTime() >= this.request.expires)
          throw new Error('private-files session expired');
        if (frame.kind !== 2 || frame.bytes.length !== received)
          throw new Error('private-files payload mismatch');
        return frame.bytes;
      }
      if (operation === 'write' && numeric(reply[5]) !== (data as Buffer).length)
        throw new Error('private-files write reply mismatch');
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  close(): Promise<void> {
    return (this.ended ??= this.end());
  }
}

class Child {
  private readonly process: cp.ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private exited = false;
  private readonly frames: Frame[] = [];
  private pending: { resolve(frame: Frame): void; reject(error: Error): void } | undefined;
  private bytes = Buffer.alloc(0);
  private failure: Error | undefined;
  private stderr = 0;
  private ending: Promise<void> | undefined;

  get closure(): Promise<void> {
    return this.closed;
  }

  constructor(
    executable: string,
    args: string[],
    private readonly signal: AbortSignal
  ) {
    this.process = cp.spawn(executable, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.closed = new Promise<void>((resolve) =>
      this.process.once('close', () => {
        signal.removeEventListener('abort', abort);
        this.exited = true;
        this.pending?.reject(new Error('private-files child closed'));
        this.pending = undefined;
        resolve();
      })
    );
    const abort = (): void => {
      this.fail(new Error('private-files child cancelled'));
      void this.stop().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    this.process.on('error', (error) => this.fail(error));
    this.process.stdin.on('error', (error: Error) => this.fail(error));
    this.process.stderr.on('data', (bytes: Buffer) => {
      this.stderr += bytes.length;
      if (this.stderr > 16384) this.fail(new Error('private-files stderr limit'));
    });
    this.process.stdout.on('data', (bytes: Buffer) => this.parse(bytes));
    if (signal.aborted) abort();
  }

  async send(kind: number, bytes: Buffer): Promise<void> {
    this.assertActive();
    if (this.failure) throw this.failure;
    if (bytes.length > (kind === 1 ? 98304 : 65536))
      throw new Error('private-files input frame limit');
    const frame = Buffer.allocUnsafe(bytes.length + 5);
    frame.writeUInt32LE(bytes.length + 1);
    frame[4] = kind;
    bytes.copy(frame, 5);
    await timeout(
      new Promise<void>((resolve, reject) =>
        this.process.stdin.write(frame, (error) => (error ? reject(error) : resolve()))
      ),
      5000
    );
  }

  assertActive(): void {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }

  async receive(): Promise<Frame> {
    if (this.failure) throw this.failure;
    const queued = this.frames.shift();
    if (queued) return queued;
    if (this.exited) throw new Error('private-files child closed');
    if (this.pending) throw new Error('private-files concurrent command');
    try {
      return await timeout(
        new Promise<Frame>((resolve, reject) => {
          this.pending = { resolve, reject };
        }),
        5000
      );
    } finally {
      this.pending = undefined;
    }
  }

  async finish(): Promise<void> {
    await timeout(this.closed, 5000);
    if (this.process.exitCode !== 0) throw new Error('private-files unsuccessful exit');
  }

  stop(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return (this.ending ??= (async () => {
      this.process.stdin.destroy();
      const kill = setTimeout(() => this.process.kill(), 1000);
      try {
        await timeout(this.closed, 5000);
      } catch {
        throw new Error('private-files child exit unconfirmed; owner retains admission');
      } finally {
        clearTimeout(kill);
      }
    })());
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.process.stdin.destroy();
  }

  private parse(chunk: Buffer): void {
    if (this.failure) return;
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > 2 * (98304 + 5)) {
      this.fail(new Error('private-files output buffer limit'));
      return;
    }
    while (this.bytes.length >= 5) {
      const length = this.bytes.readUInt32LE(0),
        kind = this.bytes[4];
      if ((kind !== 1 && kind !== 2) || length < 1 || length > (kind === 1 ? 98305 : 65537)) {
        this.fail(new Error('private-files output frame limit'));
        return;
      }
      if (this.bytes.length < length + 4) return;
      const frame = { kind, bytes: Buffer.from(this.bytes.subarray(5, length + 4)) };
      this.bytes = this.bytes.subarray(length + 4);
      if (this.pending) {
        this.pending.resolve(frame);
        this.pending = undefined;
      } else if (this.frames.length < 2) this.frames.push(frame);
      else {
        this.fail(new Error('private-files unsolicited output'));
        return;
      }
    }
  }
}

function control(frame: Frame): string {
  if (frame.kind !== 1) throw new Error('private-files control frame required');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(frame.bytes);
  const failure = /^1\nfailed\n(io|refused)\n([a-z0-9-]{1,64})$/.exec(value);
  if (failure) throw new NativeFailure(failure[1] as 'io' | 'refused', failure[2] ?? 'malformed');
  return value;
}

function numeric(value: string | undefined): number {
  if (
    value === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('private-files invalid numeric reply');
  return Number(value);
}

function validateRequest(request: Request): void {
  if (
    !Number.isSafeInteger(request.maximum) ||
    request.maximum < 0 ||
    !Number.isSafeInteger(request.expires) ||
    request.expires <= new Date().getTime() ||
    request.path.length > 32000 ||
    /[\r\n\0]/.test(request.path)
  )
    throw new Error('private-files invalid request');
}

async function boundedFile(file: string, maximum: number): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > maximum)
    throw new Error('private-files artifact unavailable');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw new Error('private-files artifact unavailable');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count !== stat.size || (await handle.stat()).size !== stat.size)
      throw new Error('private-files artifact changed');
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

async function timeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('private-files deadline')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
