import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import type { LoginChild, LoginCompletion, LoginDisposal } from './index';

/** Terminal authority survives the UI record, including unconfirmed Windows job cleanup. */
export class Operation extends EventEmitter implements LoginChild {
  readonly stdout = new PassThrough({ highWaterMark: 65536 });
  readonly stderr = new PassThrough({ highWaterMark: 65536 });
  readonly expires = Date.now() + 300000;
  private readonly monotonicExpiry = performance.now() + 300000;
  readonly done: Promise<void>;
  cause: LoginCompletion | undefined;
  child: ChildProcess | undefined;
  birth: string | undefined;
  unresolved: LoginDisposal['unresolved'] = [];
  private closed = false;
  private started = false;
  private bytes = 0;
  private transportBytes = 0;
  private readonly shutdown = new AbortController();
  private resolve!: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly lifetime: ReturnType<typeof setTimeout>;

  constructor(
    private readonly release: () => void,
    private readonly requestStop?: () => void,
    private readonly forceAfterMs: number = 2000
  ) {
    super();
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.lifetime = this.after(300000, () => this.fail('Console login expired.'));
  }

  get ready(): boolean {
    return this.started;
  }

  markReady(): void {
    if (this.started || this.closed || this.cause) return;
    this.started = true;
    this.emit('ready');
  }

  after(ms: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  clear(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  output(stream: 'stdout' | 'stderr', bytes: Buffer): void {
    if (this.closed || this.cause) return;
    this.bytes += bytes.length;
    if (this.expired() || this.bytes > 1048576 || this.buffered() + bytes.length > 262144) {
      this.fail('Console login output or lifetime limit exceeded.');
      return;
    }
    this[stream].write(bytes);
  }

  get signal(): AbortSignal {
    return this.shutdown.signal;
  }

  expired(): boolean {
    return Date.now() >= this.expires || performance.now() >= this.monotonicExpiry;
  }

  transport(bytes: number): void {
    this.transportBytes = bytes;
    if (this.buffered() > 262144) this.fail('Console login transport limit exceeded.');
  }

  private buffered(): number {
    return (
      this.transportBytes +
      this.stdout.readableLength +
      this.stdout.writableLength +
      this.stderr.readableLength +
      this.stderr.writableLength
    );
  }

  fail(reason: string): void {
    if (this.closed || this.cause) return;
    this.cause = { kind: 'failed', reason };
    this.emit('error', new Error(reason));
    this.stop();
  }

  cancel(): void {
    if (this.closed || this.cause) return;
    this.cause = { kind: 'cancelled', reason: 'Login cancelled.' };
    this.stop();
  }

  private stop(): void {
    this.shutdown.abort();
    this.requestStop?.();
    this.child?.stdin?.end();
    this.after(this.forceAfterMs, () => {
      this.child?.kill();
    });
  }

  finish(completion: LoginCompletion): void {
    if (this.closed) return;
    if (completion.kind === 'exited' && this.expired()) this.fail('Console login expired.');
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clear(this.lifetime);
    this.stdout.end();
    this.stderr.end();
    if (!this.unresolved.length) this.release();
    this.emit('close', this.cause ?? completion);
    this.resolve();
  }

  async dispose(): Promise<LoginDisposal> {
    this.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      })
    ]);
    if (timer) clearTimeout(timer);
    return {
      unresolved: this.unresolved.length
        ? this.unresolved
        : this.closed || !this.child
          ? []
          : [{ pid: this.child.pid, birth: this.birth }]
    };
  }
}
