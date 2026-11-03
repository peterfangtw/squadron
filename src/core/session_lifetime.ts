import * as control from './control';
import * as platform from './platform';
import * as scan from './scan';
import type { SessionTransport } from './session';

/** Root and known members only; process snapshots do not establish containment. */
/** Unresolved is missing proof or a pending accepted kill; failed is native refusal. */
export type CleanupResult = 'gone' | 'unresolved' | 'failed';
export const CLEANUP_WAIT_MS = 5_000;
const STDIN_GRACE_MS = 5_000;
const CLI_REAP_GRACE_MS = 8_000;

/** All a lifetime reads of its child: the native pid, its native exit, and its owner's own ask to end. */
export type NativeChild = Pick<SessionTransport, 'pid' | 'exited' | 'close'>;

type LifetimeOwner = {
  remember?(members: readonly control.TreeMember[]): Promise<void>;
  gone?(): Promise<void>;
  observed?(result: CleanupResult): void;
};

/** Owns the native child before an adapter can fail, and after opening settles. */
export class SessionLifetime {
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
  private resolveTermination!: () => void;
  readonly terminated: Promise<void> = new Promise((resolve) => {
    this.resolveTermination = resolve;
  });

  constructor(
    private readonly transport: NativeChild,
    private readonly owner: LifetimeOwner = {}
  ) {
    this.captured = scan.scanProcesses(true).then(async (table) => {
      const pid = transport.pid;
      const startedAt = pid === undefined ? undefined : table.starts.get(pid);
      if (pid !== undefined && startedAt !== undefined && !this.nativeRootExited)
        this.members.set(pid, control.snapshotMember(pid, table));
      await this.remember(table);
      return table;
    });
    // A failed durable observation stays owned; close/reconcile retries the write.
    void this.captured.catch(() => undefined);
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
      const closing = await scan.scanProcesses(true);
      await this.captured.catch(() => undefined);
      try {
        await this.remember(closing);
      } finally {
        this.closePipes();
      }
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
    clearTimeout(this.retry);
    this.retry = undefined;
    const previous = this.close();
    const next = previous.then((result) =>
      result === 'gone'
        ? result
        : this.observe(async () => this.reap(await scan.scanProcesses(true)))
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
      if (result === 'gone' && !this.released) {
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
    } else if (!this.retry) {
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
    if (startedAt !== undefined && root?.startedAt === startedAt) {
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

  /**
   * The retained members deepest first by their current ancestry, the root
   * last. Depth counts the chain of retained, still-exact parents in this
   * table, so a member whose parent is gone or a stranger (reparented) ranks
   * with the shallowest, still before the root. Ties keep the order retained.
   */
  private ordered(table: scan.ProcessTable): control.TreeMember[] {
    const pid = this.transport.pid;
    const depth = (member: control.TreeMember): number => {
      if (member.pid === pid) return -1;
      let found = 0;
      const seen = new Set([member.pid]);
      for (let parent = table.parents.get(member.pid); parent !== undefined && !seen.has(parent);) {
        const known = this.members.get(parent);
        if (!known || table.starts.get(parent) !== known.startedAt) break;
        seen.add(parent);
        found++;
        parent = table.parents.get(parent);
      }
      return found;
    };
    return this.knownMembers
      .map((member, at) => ({ member, at, depth: depth(member) }))
      .sort((a, b) => b.depth - a.depth || a.at - b.at)
      .map(({ member }) => member);
  }

  private async reap(closing: scan.ProcessTable): Promise<CleanupResult> {
    const pid = this.transport.pid;
    if (pid === undefined) return 'gone';
    // Keep the native observation even if the first persistence attempt failed.
    await this.captured.catch(() => undefined);
    await this.remember(closing);
    if (this.provedGone(closing)) return 'gone';
    const startedAt = this.members.get(pid)?.startedAt;
    if (startedAt === undefined) {
      this.coverageLimited = true;
      return 'unresolved';
    }
    if (!closing.complete) return 'unresolved';
    if (this.absent(closing)) return 'gone';
    await this.stdinGrace();
    const fresh = await scan.scanProcesses(true);
    if (!fresh.complete) return 'unresolved';
    await this.remember(fresh);
    if (this.absent(fresh)) return 'gone';
    platform.processes.signal(this.ordered(fresh), 'stop', fresh);
    await this.pause(control.REAP_GRACE_MS);
    const stubborn = await scan.scanProcesses(true);
    if (!stubborn.complete) return 'unresolved';
    await this.remember(stubborn);
    let root = stubborn;
    if (stubborn.starts.get(pid) === startedAt) {
      platform.processes.signal(
        this.ordered(stubborn).filter((member) => member.pid !== pid),
        'kill',
        stubborn
      );
      await this.pause(CLI_REAP_GRACE_MS - control.REAP_GRACE_MS);
      root = await scan.scanProcesses(true);
      if (!root.complete) return 'unresolved';
      await this.remember(root);
    }
    const members = this.ordered(root);
    const outcomes = platform.processes.signal(members, 'kill', root);
    await this.pause(100);
    const final = await scan.scanProcesses(true);
    if (!final.complete) return 'unresolved';
    // The confirmation read is an observation too: what it shows below a
    // retained member is ours before absence is judged.
    await this.remember(final);
    if (this.absent(final)) return 'gone';
    const refused = members.some(
      (member, at) =>
        final.starts.get(member.pid) === member.startedAt &&
        (outcomes[at] === 'refused' || typeof outcomes[at] === 'object')
    );
    return refused ? 'failed' : 'unresolved';
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
