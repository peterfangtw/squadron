import type * as reconcile from './reconcile';
import * as warm from './warm';
import type { SessionHandle } from './adapter';
import type { Session } from './model';
import type { WarmPolicy } from './warm_policy';
import type { Act } from './coordination/route';

const CHANGE_DEBOUNCE_MS = 1000;

/** What a pass reads of an owned session's handle. */
export type WarmHandle = Pick<SessionHandle, 'warm'> & {
  readonly state: Pick<SessionHandle['state'], 'warmTurn'>;
};

/** The window's half of the warmer: its sessions, the settings, and the two
 *  writes a pass makes. `host/warm.ts` supplies them. */
export type WarmerPorts = {
  /** This window's owned sessions, as the registry reads them now. */
  sessions(): Session[];
  handle(pid: number): WarmHandle | undefined;
  policy(): WarmPolicy;
  setWarm(pid: number, on: false): Promise<Act>;
  setWarmFailure(pid: number, at: number | undefined): void;
  log(line: string): void;
};

type Failure = { handle: WarmHandle; at: number };

/** Activation-scoped: closed panels still have idle pipes whose caches expire. */
export class CacheWarmer {
  private disposed = false;
  private readonly failures = new Map<number, Failure>();
  /** When this window last saw the policy change: a window that ended before
   *  it never lapses. */
  private policySeenAt = Date.now();
  readonly registration: reconcile.CheckRegistration;

  constructor(
    runtime: reconcile.Reconciler,
    private readonly ports: WarmerPorts
  ) {
    this.registration = runtime.register('cache warm', CHANGE_DEBOUNCE_MS, () =>
      Promise.resolve().then(() => this.once())
    );
  }

  private once(): void {
    if (this.disposed) return;
    // One reading per pass: the lapse, both `warmDue`s and the deadline agree.
    const policy = this.ports.policy();
    const sessions = this.ports.sessions();
    const live = new Set(
      sessions.filter((session) => !session.warmPort?.exited).map((session) => session.pid)
    );
    for (const pid of this.failures.keys()) {
      if (!live.has(pid)) this.failures.delete(pid);
    }
    for (const session of sessions) {
      const handle = this.ports.handle(session.pid);
      if (!handle || session.warmPort?.exited) continue;
      const failure = this.failures.get(session.pid);
      if (failure && (failure.handle !== handle || failure.at !== session.updatedAt)) {
        this.failures.delete(session.pid);
        this.ports.setWarmFailure(session.pid, undefined);
      }
      if (session.warmPort && warm.warmLapsed(session, Date.now(), policy, this.policySeenAt)) {
        // The registry takes the choice before its file write, so the rest of
        // this pass already reads the switch off.
        void this.ports
          .setWarm(session.pid, false)
          .then((off) =>
            this.ports.log(
              `cache warm window over: pid ${session.pid} ${off.ok ? 'switching off' : off.reason}`
            )
          );
        continue;
      }
      const turn = handle.state.warmTurn;
      if (turn?.failed) {
        this.fail(session, handle, 'turn failed');
      }
      const decision = warm.warmDue(
        session,
        session.warmPort,
        this.failures.get(session.pid)?.at,
        Date.now(),
        policy
      );
      if (!decision.due || !handle.warm) continue;
      try {
        const result = handle.warm.ping();
        if (result.ok) {
          this.ports.log(
            `cache warm: pid ${session.pid} (ttl ${session.cache?.ttlMs ?? 'unknown'}, source ${session.cache?.source ?? 'unknown'})`
          );
        } else {
          this.fail(session, handle, result.reason);
        }
      } catch (err) {
        this.fail(session, handle, err instanceof Error ? err.message : String(err));
      }
    }
    // Accepted writes latch synchronously. Read again so in-flight pings and
    // refused writes cannot leave their consumed, past deadline armed.
    let next: number | undefined;
    for (const session of this.ports.sessions()) {
      const ping = warm.nextWarmAt(
        warm.warmDue(
          session,
          session.warmPort,
          this.failures.get(session.pid)?.at,
          Date.now(),
          policy
        )
      );
      // A window that ended mid-turn is reconsidered when the turn's end
      // changes the session; a timer already past would re-run every second.
      const ends = session.warmPort ? warm.warmEndsAt(session, policy) : undefined;
      const lapse = ends !== undefined && ends > Date.now() ? ends : undefined;
      for (const deadline of [ping, lapse]) {
        if (deadline !== undefined && (next === undefined || deadline < next)) next = deadline;
      }
    }
    this.registration.schedule(next);
  }

  /** A setting moved: no window that has already ended may now lapse, and
   *  every deadline is recomputed from the new figures. */
  policyChanged(): void {
    this.policySeenAt = Date.now();
    this.registration.requestCheck();
  }

  private fail(session: Session, handle: WarmHandle, reason: string): void {
    const previous = this.failures.get(session.pid);
    if (previous?.handle === handle && previous.at === session.updatedAt) return;
    this.failures.set(session.pid, { handle, at: session.updatedAt });
    this.ports.setWarmFailure(session.pid, session.updatedAt);
    this.ports.log(`cache warm refused: pid ${session.pid} — ${reason}`);
  }

  dispose(): void {
    this.registration.dispose();
    this.disposed = true;
    this.failures.clear();
  }
}
