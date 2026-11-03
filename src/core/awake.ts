/**
 * Whether this machine should be kept awake, and how much awake is left in it.
 * The rule lives here, pure, so every safeguard is a test.
 * `host/keepawake.ts` owns the child process and the two triggers.
 *
 * One coffee at a time. A window that sees work runs
 * `caffeinate -i -t LEASE -w <host pid>` and looks again shortly before it
 * wears off. Still working, it drinks another. Nothing working, it lets it
 * lapse. There is no poll: the lease is the clock, and a session changing state
 * is the other trigger.
 *
 * However this extension dies, the machine is awake for at most `LEASE_MS`
 * longer. That is why the cup draws the lease and not a longer horizon.
 *
 * Every window holds for itself, with no election and no shared file. OS
 * assertions stack, so the machine sleeps when the last one lapses, and a
 * window dying releases exactly its own hold.
 *
 * Read `docs/reference/macos_power.md` before editing. The design rests on the
 * flag semantics it records.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from './files';
import type { Reading } from './platform/power';
import { AWAKE_DIR } from './paths';
import type { Session } from './model';
import { BATTERY_FLOOR_PCT, LEASE_MS, REFILL_MARGIN_MS, SILENCE_MS } from '../ui/lease';

/**
 * The keeper's figures, declared in `ui/lease.ts` because the Keep-awake drawer
 * draws them and cannot import this file. Their reasons are there.
 */
export { BATTERY_FLOOR_PCT, LEASE_MS, REFILL_MARGIN_MS, SILENCE_MS };

/**
 * How often a holder refused for the battery looks at the power again (an
 * interval). Nothing else would: no session frame comes while Remote holds for
 * nobody, and nothing tells the keeper the power changed. One `pmset` a minute
 * while unplugged and nearly flat; plugging in holds within it.
 */
export const BATTERY_RECHECK_MS = 60_000;

/**
 * The keeper's one Reconciler deadline, which two things share: the refill
 * before the lease in hand runs out, and `BATTERY_RECHECK_MS`'s next look. The
 * lease wearing off cancels its refill and must leave the recheck, which falls
 * due about then: with Remote holding for nobody, nothing else would look at
 * the power again.
 */
export class AwakeDeadlines {
  private refillAt: number | undefined;
  private recheckAt: number | undefined;

  /** A check is running: every deadline already due is the one it serves. */
  served(now: number): void {
    if (this.refillAt !== undefined && this.refillAt <= now) this.refillAt = undefined;
    if (this.recheckAt !== undefined && this.recheckAt <= now) this.recheckAt = undefined;
  }

  /** The refill, or none when no lease is in hand; the deadline to schedule. */
  refill(at: number | undefined): number | undefined {
    this.refillAt = at;
    return this.next();
  }

  /** The battery's next look, or none; the deadline to schedule. */
  recheck(at: number | undefined): number | undefined {
    this.recheckAt = at;
    return this.next();
  }

  private next(): number | undefined {
    if (this.refillAt === undefined) return this.recheckAt;
    if (this.recheckAt === undefined) return this.refillAt;
    return Math.min(this.refillAt, this.recheckAt);
  }
}

/**
 * Whether the lease in hand is still asked for. One poured for an optional
 * reason alone — Remote, Warm, or both, with no session working — is wanted
 * only while one of them holds, and is cut the moment neither does rather than
 * left to run out: you switched it off, or Warm's window lapsed. Any other lease runs to `-t`, which is what makes a session
 * going idle cost nothing.
 */
export function leaseWanted(lease: { optional: boolean }, optionalHolds: boolean): boolean {
  return !lease.optional || optionalHolds;
}

/**
 * How long a record outlives the window that wrote it, which is not how much
 * coffee is left (see `readHolds`). One lease plus a margin, because a window
 * still running rewrites well inside its own lease, so an older record is a
 * window that is gone.
 */
export const HOLD_STALE_MS = LEASE_MS + 60_000;

/** Why the machine is or is not being kept awake, in the panel's own words. */
export type AwakeReason = 'drinking' | 'idle' | 'stale' | 'battery' | 'off' | 'unsupported';

/** What one window has written down about the coffee it is holding. */
export type HoldRecord = {
  windowId: string;
  /** When this window's current coffee wears off. The only clock anything draws. */
  until: number;
  /** The pids being held for, so a reader can say what is keeping it awake. */
  sessions: number[];
  reason: AwakeReason;
  /** Held because Remote is on, so a reader can say what is keeping the
   *  machine up when `sessions` is empty. Older windows ignore it. */
  remote?: true;
  /** Held for these sessions' Warm. Older windows ignore it. */
  warmSessions?: number[];
  power?: Reading;
  /** Liveness mark, as on every other per-window file here. */
  writtenAt: number;
};

/** Everything the rule needs, and nothing that would make it impure. */
export type AwakeInput = {
  sessions: readonly Session[];
  power: Reading | undefined;
  now: number;
  enabled: boolean;
  /** This OS can take the lock (`platform.power.holds`), resolved by the
   *  caller so the rule stays pure. */
  holds: boolean;
  /** This window holds Remote: a person away from the desk is waiting on the
   *  machine, busy or not (D4). Absent is off. */
  remote?: boolean;
  /** The pids with Warm on, when this window holds for Warm. Absent or empty
   *  is none. */
  warm?: readonly number[];
};

export type AwakeVerdict = {
  drink: boolean;
  reason: AwakeReason;
  /** The pids counted as working. Empty unless `drink`. */
  sessions: number[];
  /** Drinking because Remote is on. */
  remote?: true;
  /** Drinking for these sessions' Warm. */
  warmSessions?: number[];
  /** When to look again, epoch ms: refused for the battery with Remote or
   *  Warm holding. */
  recheckAt?: number;
};

/**
 * Whether to drink, and why. An OS that cannot take the lock cannot hold
 * whatever the setting says, so `unsupported` outranks `off`. A battery about to
 * die outranks any work, because the work dies with the machine either way.
 *
 * Absent power is not a refusal. A desktop has no battery and a read can fail.
 * Both answer `undefined`, and reading that as nearly flat would never hold on
 * hardware with no battery to flatten.
 *
 * The staleness brake is per session, so a wedged session beside a live one
 * still holds, and the record names only what really keeps the lock.
 *
 * Remote and Warm rank below the lock's support, the setting and the battery (U11),
 * and above the sessions: either drinks with nothing working, and the brake
 * only decides which pids the record names.
 */
export function decide(input: AwakeInput): AwakeVerdict {
  const no = (reason: AwakeReason): AwakeVerdict => ({ drink: false, reason, sessions: [] });

  if (!input.holds) {
    return no('unsupported');
  }
  if (!input.enabled) {
    return no('off');
  }
  const warm = input.warm ?? [];
  if (input.power && !input.power.onAC && input.power.pct < BATTERY_FLOOR_PCT) {
    return input.remote || warm.length > 0
      ? { ...no('battery'), recheckAt: input.now + BATTERY_RECHECK_MS }
      : no('battery');
  }

  // A command backgrounded at the end of a turn is still work: an `idle` session
  // with a barrel running went to sleep with it on 2026-10-06.
  const busy = input.sessions.filter((session) => session.status === 'busy' || session.hasCommand);
  const working = busy.filter((session) => input.now - session.updatedAt < SILENCE_MS);
  if (input.remote || warm.length > 0) {
    return {
      drink: true,
      reason: 'drinking',
      sessions: working.map((session) => session.pid),
      ...(input.remote ? { remote: true as const } : {}),
      ...(warm.length > 0 ? { warmSessions: [...warm] } : {})
    };
  }
  if (busy.length === 0) {
    return no('idle');
  }
  if (working.length === 0) {
    return no('stale');
  }

  return { drink: true, reason: 'drinking', sessions: working.map((session) => session.pid) };
}

/**
 * When the machine stops being held: the last lease to lapse, or zero. The
 * machine stays awake until the last assertion lapses, so the merge takes the
 * maximum, not the newest writer. Hence one file per window: a shared
 * last-writer-wins file is wrong when a second window joins a running hold.
 *
 * The cup's level is computed in `webview/cafe.ts`. Computed here, it changed on
 * every push and kept the panel from skipping one.
 */
export function latestUntil(records: readonly HoldRecord[]): number {
  return Math.max(0, ...records.map((record) => record.until));
}

/** What the panel draws: a live lease and what it holds for, or why there
 *  isn't one. */
export type CafeView =
  | {
      reason: 'drinking';
      until: number;
      /** Distinct pids across every live lease, as each was poured. */
      sessions: number;
      /** A live lease was poured with Remote on. */
      remote?: true;
      /** Distinct pids across every live lease poured for Warm. */
      warmSessions?: number;
    }
  | { reason: Exclude<AwakeReason, 'drinking'> };

/**
 * The coffee as the cup needs it, given every window's hold and this instant.
 * A `drinking` record is not a hold now: a window that died mid-hold leaves
 * one, and its `caffeinate` released with it. Only a running lease counts.
 *
 * With nothing holding, the freshest record says why: every window on a nearly
 * flat battery says `battery`. No record means `idle`, because a window with
 * nothing working writes none. A leftover `drinking` record also reads `idle`,
 * because nothing is holding.
 */
export function cafeView(holds: readonly HoldRecord[], now: number): CafeView {
  const held = holds.filter((hold) => hold.reason === 'drinking' && hold.until > now);
  const until = latestUntil(held);
  if (until > 0) {
    const sessions = new Set(held.flatMap((hold) => hold.sessions)).size;
    const warmSessions = new Set(
      held.flatMap((hold) => (Array.isArray(hold.warmSessions) ? hold.warmSessions : []))
    ).size;
    return {
      reason: 'drinking',
      until,
      sessions,
      ...(held.some((hold) => hold.remote) ? { remote: true as const } : {}),
      ...(warmSessions > 0 ? { warmSessions } : {})
    };
  }
  const freshest = holds.reduce<HoldRecord | undefined>(
    (best, hold) => (best === undefined || hold.writtenAt > best.writtenAt ? hold : best),
    undefined
  );
  const reason = freshest?.reason;
  return { reason: reason === undefined || reason === 'drinking' ? 'idle' : reason };
}

function holdFile(windowId: string): string {
  return path.join(AWAKE_DIR, `${encodeURIComponent(windowId)}.json`);
}

/** Best effort: a machine that cannot write this still stays awake, and only
 *  the cup goes quiet. */
export async function writeHold(record: HoldRecord): Promise<void> {
  try {
    await fs.mkdir(AWAKE_DIR, { recursive: true });
  } catch {
    return;
  }
  await writeAtomicJson(holdFile(record.windowId), record, 'beat');
}

export async function clearHold(windowId: string): Promise<void> {
  await fs.rm(holdFile(windowId), { force: true }).catch(() => {});
}

/**
 * Every window's hold, with dead ones removed as read, because nothing else
 * sweeps this directory and a record left behind is a cup that never empties.
 *
 * Swept on `writtenAt`, not `until`. A window refused for `battery` or `stale`
 * writes a record with its lease in the past, so the cup can say why it is
 * empty. Sweeping on the lease would make "nothing working" and "battery nearly
 * flat" identical.
 */
export async function readHolds(now = Date.now()): Promise<HoldRecord[]> {
  const gone: string[] = [];
  const records = await readJsonDir(AWAKE_DIR, (raw, name) => {
    if (isHold(raw) && now - raw.writtenAt <= HOLD_STALE_MS) {
      return raw;
    }
    gone.push(name);
    return undefined;
  });
  await Promise.all(
    gone.map((name) => fs.rm(path.join(AWAKE_DIR, name), { force: true }).catch(() => {}))
  );
  return records;
}

/**
 * `until` is checked for finiteness rather than cast, because an absent number
 * makes every comparison against it false, so the file is neither used nor
 * swept and lives forever.
 */
function isHold(value: unknown): value is HoldRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<HoldRecord>;
  return (
    typeof record.windowId === 'string' &&
    typeof record.until === 'number' &&
    Number.isFinite(record.until) &&
    typeof record.writtenAt === 'number' &&
    Number.isFinite(record.writtenAt) &&
    Array.isArray(record.sessions) &&
    typeof record.reason === 'string'
  );
}
