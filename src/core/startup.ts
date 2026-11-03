import { performance } from 'node:perf_hooks';
import * as perf from './perf';
import type { BrandId } from './model';
import type { RemoteLaunchEvidence } from './bridge/model';
import { CLEANUP_WAIT_MS, type SessionLifetime, type CleanupResult } from './session_lifetime';

/** Policy ceiling, independent of a caller's shorter transport wait. */
export const STARTUP_MS = 90_000;
export const OPEN_REQUEST_MS = 30_000;
export const CONTROL_REPLY_MS = 30_000;

export type StartOutcome =
  | {
      ok: true;
      pid: number;
      startedAt: number;
      brand: BrandId;
      sessionId?: string;
      remoteLaunchEvidence?: RemoteLaunchEvidence;
      startupVersion?: 1;
      attemptId?: string;
    }
  | {
      ok: false;
      reason: string;
      cause?: 'pick' | 'startup' | 'timeout' | 'cancelled';
      notStarted?: true;
      unsure?: true;
      startupVersion?: 1;
      attemptId?: string;
    };

export class StartupUnknown extends Error {}

export class StartupStopped extends Error {
  constructor(
    override readonly cause: 'cancelled' | 'timeout',
    readonly stage: string
  ) {
    super(cause === 'cancelled' ? 'Session start cancelled.' : 'Session start timed out.');
  }
}

/** One opening operation; its deadline ends at handoff, not at model completion. */
export class StartupAttempt {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly began = performance.now();
  private readonly deadline: number;
  private readonly timer: NodeJS.Timeout;
  private finished = false;
  private currentStage = 'preparing';
  outcome?: StartOutcome;
  cleanup?: Promise<CleanupResult>;
  private lifetime?: SessionLifetime;
  private running?: Promise<StartOutcome>;
  private admittedPrompt = false;
  private cancelling?: Promise<StartOutcome>;
  private readonly abort = (): void => {
    if (this.lifetime && !this.admittedPrompt) this.cleanup = this.lifetime.close();
  };

  constructor(
    readonly id: string,
    budgetMs = STARTUP_MS,
    private readonly log?: (line: string) => void
  ) {
    this.deadline = this.began + budgetMs;
    this.timer = setTimeout(() => this.stop('timeout'), budgetMs);
    this.signal.addEventListener('abort', this.abort, { once: true });
    this.note('created');
  }

  own(lifetime: SessionLifetime): void {
    this.lifetime = lifetime;
    void lifetime.terminated.then(() => this.confirmCleanup());
    if (this.signal.aborted) this.abort();
  }

  admitPrompt(): void {
    this.check();
    this.admittedPrompt = true;
  }

  get stage(): string {
    return this.currentStage;
  }
  set stage(value: string) {
    if (value === this.currentStage) return;
    this.currentStage = value;
    this.note(value);
  }

  async reconcile(): Promise<StartOutcome | undefined> {
    if (this.outcome && !this.outcome.ok && !this.admittedPrompt && this.lifetime && this.cleanup) {
      const state = await this.lifetime.reconcile();
      if (state === 'gone') this.confirmCleanup();
    }
    return this.outcome;
  }

  run(work: () => Promise<StartOutcome>): Promise<StartOutcome> {
    this.running ??= this.execute(work);
    return this.running;
  }

  private async execute(work: () => Promise<StartOutcome>): Promise<StartOutcome> {
    let result: StartOutcome;
    try {
      result = await this.wait('preparing', async () => {
        const outcome = await work();
        if (outcome.ok && this.admittedPrompt && !this.signal.aborted) this.finish('handed-off');
        return outcome;
      });
    } catch (error) {
      result = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        cause: error instanceof StartupStopped ? error.cause : 'startup',
        ...(error instanceof StartupUnknown ? { unsure: true } : {})
      };
    }
    this.finish(result.ok ? 'handed-off' : 'refused');
    return this.settle(result);
  }

  cancelHandoff(): Promise<StartOutcome | undefined> {
    if (!this.outcome?.ok || this.admittedPrompt || !this.lifetime)
      return Promise.resolve(this.outcome);
    this.lifetime.closePipes();
    this.cancelling ??= this.settle({
      ok: false,
      cause: 'cancelled',
      reason: 'Session start cancelled.'
    });
    return this.cancelling;
  }

  private async settle(result: StartOutcome): Promise<StartOutcome> {
    if (!result.ok) {
      if (this.admittedPrompt) result = { ...result, notStarted: undefined, unsure: true };
      else if (this.lifetime) {
        this.cleanup = this.lifetime.close();
        let timer: NodeJS.Timeout | undefined;
        const state = await Promise.race([
          this.cleanup,
          new Promise<'unresolved'>((resolve) => {
            timer = setTimeout(() => resolve('unresolved'), CLEANUP_WAIT_MS);
          })
        ]);
        clearTimeout(timer);
        result = {
          ...result,
          notStarted: state === 'gone' ? true : undefined,
          unsure: state === 'gone' ? undefined : true
        };
        this.note(`cleanup ${state}; descendant coverage ${this.lifetime.descendantCoverage}`);
      } else if (!result.unsure) result = { ...result, notStarted: true, unsure: undefined };
    }
    this.outcome = { ...result, startupVersion: 1, attemptId: this.id };
    if (this.cleanup)
      void this.cleanup.then((state) => {
        if (state === 'gone') this.confirmCleanup();
      });
    return this.outcome;
  }

  private confirmCleanup(): void {
    if (this.outcome && !this.outcome.ok && !this.admittedPrompt)
      this.outcome = { ...this.outcome, unsure: undefined, notStarted: true };
  }

  remaining(cap = Infinity): number {
    this.check();
    return Math.max(1, Math.min(cap, this.deadline - performance.now()));
  }

  check(): void {
    if (!this.finished && performance.now() >= this.deadline) this.stop('timeout');
    if (this.signal.aborted) throw this.signal.reason;
  }

  stop(cause: 'cancelled' | 'timeout' = 'cancelled'): void {
    if (this.finished || this.signal.aborted) return;
    clearTimeout(this.timer);
    this.controller.abort(new StartupStopped(cause, this.stage));
    this.note(cause);
  }

  async wait<T>(stage: string, work: () => Promise<T>): Promise<T> {
    this.check();
    this.stage = stage;
    this.note(stage);
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            this.signal.reason instanceof Error
              ? this.signal.reason
              : new Error('Session start cancelled.')
          );
        this.signal.addEventListener('abort', abort, { once: true });
      });
      const value = await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return work();
        }),
        stopped
      ]);
      this.check();
      return value;
    } finally {
      if (abort) this.signal.removeEventListener('abort', abort);
    }
  }

  finish(outcome: string): void {
    if (this.finished) return;
    this.finished = true;
    perf.record('startup', performance.now() - this.began);
    clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.abort);
    this.note(outcome);
  }

  private note(event: string): void {
    this.log?.(`startup ${this.id} ${event} ${Math.round(performance.now() - this.began)}ms`);
  }
}
