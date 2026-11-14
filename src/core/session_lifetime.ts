import * as control from './control';
import * as platform from './platform';
import * as scan from './scan';
import * as processes from './platform/processes';
import type { SessionTransport } from './session';

/** Root and known members only; process snapshots do not establish containment. */
/** Unresolved is missing proof or a pending accepted kill; failed is native refusal. */
export type CleanupResult = 'gone' | 'unresolved' | 'failed';
export const CLEANUP_WAIT_MS = 5_000;
const STDIN_GRACE_MS = 5_000;
export const CLI_REAP_GRACE_MS = 8_000;

/** All a lifetime reads of its child: the native pid, its native exit, and its owner's own ask to end. */
export type NativeChild = Pick<SessionTransport, 'pid' | 'exited' | 'close'>;

export type DurableObservation = {
  begin(): Promise<number>;
  commit(
    generation: number,
    members: readonly control.TreeMember[],
    table: scan.ProcessTable,
    coverage: 'observed' | 'limited',
    root?: control.TreeMember & { startSource: processes.StartSource }
  ): Promise<void>;
  /**
   * The root exited with no native identity ever established and nothing else
   * retained: no later observation can learn a member. Records why, without
   * claiming cleanup; ownership stays unresolved.
   */
  unprovable?(): Promise<void>;
};

type LifetimeOwner = {
  durableObservation?: DurableObservation;
  remember?(members: readonly control.TreeMember[]): Promise<void>;
  gone?(): Promise<void>;
  observed?(result: CleanupResult): void;
};

/** Owns the native child before an adapter can fail, and after opening settles. */
export class SessionLifetime {
  private observationQueue: Promise<unknown> = Promise.resolve();
  private rootIdentity?: control.TreeMember & { startSource: processes.StartSource };
  private readonly captured: Promise<scan.ProcessTable>;
  private readonly cleanup = new Set<() => void>();
  private stopping?: Promise<CleanupResult>;
  private closed = false;
  private pipesClosed = false;
  private readonly members = new Map<number, control.TreeMember>();
  private reconciling?: Promise<CleanupResult>;
  private coverageLimited = false;
  private nativeRootExited = false;
  private readonly nativeWaiters = new Set<() => void>();
  private retry?: NodeJS.Timeout;
  private retryDelay = 1_000;
  private released = false;
  private initialSettled = false;
  /** Durable ownership that no observation can ever resolve, recorded once. */
  private unprovableRecorded = false;
  private resolveTermination!: () => void;
  readonly terminated: Promise<void> = new Promise((resolve) => {
    this.resolveTermination = resolve;
  });

  constructor(
    private readonly transport: NativeChild,
    private readonly owner: LifetimeOwner = {}
  ) {
    this.captured = this.readTable(true);
    // A failed durable observation stays owned; close/reconcile retries the write.
    void this.captured
      .catch(() => undefined)
      .then(() => {
        this.initialSettled = true;
      });
    void transport.exited?.then((native) => {
      if (!native) return;
      this.nativeRootExited = true;
      for (const done of this.nativeWaiters) done();
      if (this.closed) void this.reconcile();
    });
  }

  async capture(): Promise<void> {
    await this.captured;
  }

  register(cleanup: () => void): void {
    if (this.closed) cleanup();
    else this.cleanup.add(cleanup);
  }

  close(): Promise<CleanupResult> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.observe(async () => {
      if (this.owner.durableObservation) await this.captured.catch(() => undefined);
      const closing = await this.readTable();
      await this.captured.catch(() => undefined);
      this.closePipes();
      return this.reap(closing);
    });
    return this.stopping;
  }

  /** The root's pid, for naming its cleanup. */
  get pid(): number | undefined {
    return this.transport.pid;
  }

  get descendantCoverage(): 'observed' | 'limited' {
    return this.coverageLimited ? 'limited' : 'observed';
  }

  get knownMembers(): readonly control.TreeMember[] {
    return [...this.members.values()];
  }

  /** Immediate cancellation and deactivation can close pipes without awaiting a scan. */
  closePipes(): void {
    if (this.pipesClosed) return;
    this.pipesClosed = true;
    for (const cleanup of this.cleanup) {
      try {
        cleanup();
      } catch {
        /* The native backstop still owns the child. */
      }
    }
    this.cleanup.clear();
    try {
      this.transport.close();
    } catch {
      /* Native identity still controls escalation. */
    }
  }

  /** Host waiting is bounded separately; native flush/reap grace never accelerates. */
  shutdown(): Promise<CleanupResult> {
    this.closePipes();
    return this.closed ? this.reconcile() : this.close();
  }

  reconcile(): Promise<CleanupResult> {
    if (this.reconciling) return this.reconciling;
    if (this.unprovableRecorded) return Promise.resolve('unresolved');
    clearTimeout(this.retry);
    this.retry = undefined;
    const previous = this.close();
    const next = previous.then((result) =>
      result === 'gone' ? result : this.observe(async () => this.reap(await this.readTable()))
    );
    this.stopping = next;
    this.reconciling = next.finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async observe(work: () => Promise<CleanupResult>): Promise<CleanupResult> {
    let result: CleanupResult = 'unresolved';
    try {
      result = await work();
      if (this.unprovable()) {
        // Native exit is not durable absence: no identity was ever retained.
        result = 'unresolved';
        if (!this.unprovableRecorded) {
          await this.owner.durableObservation?.unprovable?.();
          this.unprovableRecorded = true;
        }
      } else if (result === 'gone' && !this.released) {
        await this.owner.gone?.();
        this.released = true;
        this.resolveTermination();
      }
    } catch {
      result = 'unresolved';
      this.closePipes();
    }
    this.owner.observed?.(result);
    if (result === 'gone') {
      clearTimeout(this.retry);
      this.retry = undefined;
    } else if (!this.retry && !this.unprovableRecorded) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.reconcile();
      }, this.retryDelay);
      this.retry.unref();
      this.retryDelay = Math.min(30_000, this.retryDelay * 2);
    }
    return result;
  }

  private async remember(table: scan.ProcessTable): Promise<void> {
    const pid = this.transport.pid;
    if (pid === undefined) return;
    if (!table.complete) this.coverageLimited = true;
    const startedAt = table.starts.get(pid);
    // A later PID occupant cannot establish an identity missed at spawn.
    const root = this.members.get(pid);
    if (
      startedAt !== undefined &&
      root?.startedAt === startedAt &&
      (!this.owner.durableObservation || table.complete)
    ) {
      for (const member of control.snapshotTree(pid, table)) this.members.set(member.pid, member);
      this.members.set(pid, control.snapshotMember(pid, table));
    } else this.coverageLimited = true;
    if (table.complete) this.adopt(table);
    if (this.closed && this.provedGone(table)) return;
    await this.owner.remember?.(this.knownMembers);
  }

  /**
   * What runs below each retained member that still has its exact start, read
   * from a complete table only. A tool that outlived the root keeps its own
   * children ours: Sol's review saw a grandchild of a retained tool in three
   * action reads, and a lifetime that looked below the root alone released
   * capacity while it ran. Nothing is adopted below a recycled number or a dead
   * one: that is a stranger's child.
   */
  private adopt(table: scan.ProcessTable): void {
    const pid = this.transport.pid;
    for (const member of [...this.members.values()]) {
      if (member.pid === pid || table.starts.get(member.pid) !== member.startedAt) continue;
      for (const child of control.snapshotTree(member.pid, table))
        this.members.set(child.pid, child);
    }
  }

  /** Only the initial capture can establish root provenance. */
  get initialRoot(): (control.TreeMember & { startSource: processes.StartSource }) | undefined {
    return this.rootIdentity;
  }

  private readTable(initial = false): Promise<scan.ProcessTable> {
    const read = async (): Promise<scan.ProcessTable> => {
      const durable = this.owner.durableObservation;
      const generation = durable ? await durable.begin() : undefined;
      const table = await scan.scanProcesses(true);
      const pid = this.transport.pid;
      if (initial && pid !== undefined && !this.nativeRootExited && table.starts.has(pid)) {
        const root = control.snapshotMember(pid, table);
        if (table.complete && processes.isStartSource(table.startSource))
          this.rootIdentity = { ...root, startSource: table.startSource };
        if (!durable || this.rootIdentity) this.members.set(pid, root);
      }
      // A changed native clock cannot supply absence or new ownership evidence.
      if (durable && this.rootIdentity && table.startSource !== this.rootIdentity.startSource)
        table.complete = false;
      await this.remember(table);
      if (durable && generation !== undefined)
        await durable.commit(
          generation,
          this.knownMembers,
          table,
          this.descendantCoverage,
          this.rootIdentity
        );
      return table;
    };
    if (!this.owner.durableObservation) return read();
    const next = this.observationQueue.then(read);
    this.observationQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Durable ownership with no root identity after the initial capture settled,
   * no retained member and a native root exit. `remember` only adds members
   * through the exact root or beneath retained ones, so retrying learns nothing.
   */
  private unprovable(): boolean {
    return (
      this.owner.durableObservation !== undefined &&
      this.initialSettled &&
      this.nativeRootExited &&
      this.rootIdentity === undefined &&
      this.members.size === 0
    );
  }

  private ordered(table: scan.ProcessTable): control.TreeMember[] {
    return control.orderLifetimeMembers(this.transport.pid, this.knownMembers, table);
  }

  private async reap(closing: scan.ProcessTable): Promise<CleanupResult> {
    const pid = this.transport.pid;
    if (pid === undefined) return 'gone';
    // Keep the native observation even if the first persistence attempt failed.
    await this.captured.catch(() => undefined);
    if (this.provedGone(closing)) return 'gone';
    const startedAt = this.members.get(pid)?.startedAt;
    if (startedAt === undefined) {
      this.coverageLimited = true;
      return 'unresolved';
    }
    if (!closing.complete) return 'unresolved';
    if (this.absent(closing)) return 'gone';
    await this.stdinGrace();
    const fresh = await this.readTable();
    if (!fresh.complete) return 'unresolved';
    if (this.absent(fresh)) return 'gone';
    this.signal(this.ordered(fresh), 'stop', fresh);
    await this.pause(control.REAP_GRACE_MS);
    const stubborn = await this.readTable();
    if (!stubborn.complete) return 'unresolved';
    let root = stubborn;
    if (stubborn.starts.get(pid) === startedAt) {
      platform.processes.signal(
        this.ordered(stubborn).filter((member) => member.pid !== pid),
        'kill',
        stubborn
      );
      await this.pause(CLI_REAP_GRACE_MS - control.REAP_GRACE_MS);
      root = await this.readTable();
      if (!root.complete) return 'unresolved';
    }
    const members = this.ordered(root);
    const outcomes = this.signal(members, 'kill', root);
    await this.pause(100);
    const final = await this.readTable();
    if (!final.complete) return 'unresolved';
    // The confirmation read is an observation too: what it shows below a
    // retained member is ours before absence is judged.
    if (this.absent(final)) return 'gone';
    const refused = members.some(
      (member, at) =>
        final.starts.get(member.pid) === member.startedAt &&
        (outcomes[at] === 'refused' || typeof outcomes[at] === 'object')
    );
    return refused ? 'failed' : 'unresolved';
  }

  private signal(
    members: readonly control.TreeMember[],
    intent: 'stop' | 'kill',
    table: scan.ProcessTable
  ): ReturnType<typeof platform.processes.signal> {
    return members.flatMap((member) =>
      platform.processes.signal(
        [member],
        intent,
        table,
        member.pid === this.transport.pid ? { alone: true } : undefined
      )
    );
  }

  private provedGone(table: scan.ProcessTable): boolean {
    const pid = this.transport.pid;
    return (
      pid === undefined ||
      (this.nativeRootExited && this.knownMembers.every((member) => member.pid === pid)) ||
      (table.complete === true &&
        this.absent(table) &&
        (this.members.has(pid) || !table.starts.has(pid)))
    );
  }

  private absent(table: scan.ProcessTable): boolean {
    return this.knownMembers.every((member) => table.starts.get(member.pid) !== member.startedAt);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private stdinGrace(): Promise<void> {
    if (this.nativeRootExited) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.nativeWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, STDIN_GRACE_MS);
      this.nativeWaiters.add(done);
    });
  }
}
