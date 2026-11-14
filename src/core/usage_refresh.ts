import type { BrandUsage, LiveRead } from './usage';
import * as usage from './usage';
import type { SessionHandle, UsageSource } from './adapter';
import { sessionBrand } from './brands';
import type { BrandId, Session } from './model';
import type { CheckRegistration, Reconciler } from './reconcile';
import { RETRY_MS } from './signin';
import { LIVE_ACTIVE_MS, LIVE_SLACK_MS, type LiveHint } from './usage_policy';

export type UsageRefreshPorts = {
  brands(): Promise<readonly BrandUsage[]>;
  observations(): Promise<readonly BrandUsage[]>;
  sessions(): readonly Session[];
  /** What answers an activity-driven read for this account here, or nothing. */
  liveReader?(entry: BrandUsage): LiveRead | undefined;
  retryAt?(): number | undefined;
  now(this: void): number;
  log(line: string): void;
};

/**
 * One host's serial usage work; all hosts share admission and reading freshness.
 *
 * Three tenants. Passive observations land as they arrive; activity-driven
 * reads follow this window's turns; the hourly fallback reads an account no
 * observation has reached for an interval. Each has its own registration, so
 * a fallback's temporary child holds up neither of the others.
 */
export class UsageRefresher {
  readonly registration: CheckRegistration;
  readonly observations: CheckRegistration;
  readonly live: CheckRegistration;
  private readonly abort = new AbortController();
  private readonly hints = new LiveHints();
  private pending: Promise<void> = Promise.resolve();
  private observing: Promise<void> = Promise.resolve();
  private reading: Promise<void> = Promise.resolve();

  constructor(
    runtime: Reconciler,
    private readonly ports: UsageRefreshPorts
  ) {
    this.observations = runtime.register('usage observations', 1_000, () => {
      this.observing = this.ingest();
      return this.observing;
    });
    this.live = runtime.register('live usage', 1_000, () => {
      this.reading = this.readActive();
      return this.reading;
    });
    this.registration = runtime.register('account usage', 1_000, () => {
      this.pending = this.check();
      return this.pending;
    });
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    this.registration.dispose();
    this.observations.dispose();
    this.live.dispose();
    await Promise.all([this.pending, this.observing, this.reading]);
  }

  /** Activity-driven reads for every brand this window's sessions moved. */
  private async readActive(): Promise<void> {
    const due: number[] = [];
    try {
      for (const entry of await this.ports.observations()) {
        if (this.abort.signal.aborted) return;
        const hint = this.hints.hint(entry.brand);
        if (hint.since === undefined && !hint.busy) continue;
        const read = this.ports.liveReader?.(entry);
        if (!read) continue;
        try {
          const after = await usage.readLive(entry, hint, read, {
            now: this.ports.now(),
            signal: this.abort.signal,
            clock: this.ports.now,
            cover: (stamp) => {
              this.hints.covered(entry.brand, stamp);
              return this.hints.hint(entry.brand);
            }
          });
          if (after !== undefined) due.push(after);
        } catch (error) {
          this.ports.log(
            `usage: ${entry.brand}: ${error instanceof Error ? error.message : String(error)}`
          );
          // A release or a reading that could not be written is retried, not forgotten.
          due.push(this.ports.now() + LIVE_ACTIVE_MS);
        }
      }
    } finally {
      if (!this.abort.signal.aborted) this.live.schedule(due.length ? Math.min(...due) : undefined);
    }
  }

  private async ingest(): Promise<void> {
    if (this.hints.observe(this.ports.sessions(), this.ports.now())) this.live.requestCheck();
    const brands = await this.ports.observations();
    for (const brand of brands) {
      if (this.abort.signal.aborted) return;
      try {
        await usage.noteSessionUsage(brand, this.ports.sessions());
      } catch (error) {
        this.ports.log(
          `usage: ${brand.brand}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async check(): Promise<void> {
    let next = this.ports.now() + RETRY_MS;
    try {
      const brands = await this.ports.brands();
      const due: number[] = [];
      for (const brand of brands) {
        if (this.abort.signal.aborted) return;
        if (!brand.signedIn) continue;
        try {
          const after = await usage.walkUsage(brand, {
            sessions: this.ports.sessions(),
            now: this.ports.now(),
            signal: this.abort.signal,
            clock: this.ports.now
          });
          if (typeof after === 'number') due.push(after);
        } catch (error) {
          this.ports.log(
            `usage: ${brand.brand}: ${error instanceof Error ? error.message : String(error)}`
          );
          due.push(this.ports.now() + brand.source.everyMs);
        }
      }
      const retry = this.ports.retryAt?.();
      if (retry !== undefined) due.push(retry);
      if (due.length) next = Math.min(...due);
    } catch (error) {
      this.ports.log(`usage: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.abort.signal.aborted) this.registration.schedule(next);
    }
  }
}

/**
 * What this window's sessions say about quota that may have moved: a turn
 * that ended, and a turn running now. Never an observation itself.
 *
 * A turn end is the rise of `turnsEnded`, which counts real turns only, so a
 * warm ping, a local command and a usage read are no hint. A card counts from
 * zero: an owned session never outlives its host, so turns it shows at first
 * sight ended here, a fast first one before the first pass. The first
 * unsatisfied turn end is kept until an observation covers it, so later ones
 * cannot postpone its read; the newest is kept too, so covering the first
 * cannot drop it. `waiting` is a person's turn, not the account's.
 */
export class LiveHints {
  private readonly turns = new Map<string, number>();
  private readonly since = new Map<BrandId, number>();
  private readonly latest = new Map<BrandId, number>();
  private busy = new Set<BrandId>();

  /** Whether any brand's hint changed. */
  observe(sessions: readonly Session[], now: number): boolean {
    let changed = false;
    const seen = new Set<string>();
    const busy = new Set<BrandId>();
    for (const session of sessions) {
      const brand = sessionBrand(session.brand);
      const key = `${session.pid}:${session.startedAt}`;
      const turns = session.turnsEnded ?? 0;
      const before = this.turns.get(key) ?? 0;
      seen.add(key);
      this.turns.set(key, turns);
      if (turns > before) {
        if (!this.since.has(brand)) {
          this.since.set(brand, now);
          changed = true;
        }
        this.latest.set(brand, now);
      }
      if (session.status === 'busy' && !session.warming) busy.add(brand);
    }
    for (const key of this.turns.keys()) if (!seen.has(key)) this.turns.delete(key);
    if (busy.size !== this.busy.size || [...busy].some((brand) => !this.busy.has(brand)))
      changed = true;
    this.busy = busy;
    return changed;
  }

  hint(brand: BrandId): LiveHint {
    const since = this.since.get(brand);
    return since === undefined
      ? { busy: this.busy.has(brand) }
      : { since, busy: this.busy.has(brand) };
  }

  /** Retire the turn ends an observation arrived for; a newer one stays. */
  covered(brand: BrandId, observedAt: number | undefined): void {
    const since = this.since.get(brand);
    const latest = this.latest.get(brand) ?? since;
    if (since === undefined || latest === undefined || observedAt === undefined) return;
    if (observedAt >= latest - LIVE_SLACK_MS) {
      this.since.delete(brand);
      this.latest.delete(brand);
    } else if (observedAt >= since - LIVE_SLACK_MS) this.since.set(brand, latest);
  }
}

/**
 * The reader an activity-driven read may use: an owned session's pipe, or a
 * source that declares it starts no child. Anything else waits for the
 * fallback, since a temporary CLI child per turn is the cost this avoids.
 */
export function liveReaderFor(
  source: UsageSource,
  handle: SessionHandle['usage'] | undefined,
  override?: string
): LiveRead | undefined {
  if (handle) return (signal) => handle.read(signal);
  if (source.childless) return (signal) => source.read(override, { signal });
  return undefined;
}
