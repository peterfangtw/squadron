import * as cacheTtl from './cache_ttl';
import { isMidTurn, type Session, type SessionStatus, type WarmTurn } from './model';
import type { WarmPolicy } from './warm_policy';

export { WARM_HIT_SHARE, WARM_MISS_SHARE, warmVerdict } from './warm_policy';

/** Raw transport facts, separate from the status maintenance is shown as. */
export type WarmPortFacts = {
  status: SessionStatus;
  running: boolean;
  queued: number;
  pending: number;
  exited: boolean;
  inFlight: boolean;
  turn?: WarmTurn;
};

export type WarmHeld =
  | 'unsupported'
  | 'busy'
  | 'ask'
  | 'queued'
  | 'ended'
  | 'warming'
  | 'short-ttl'
  | 'window-short'
  | 'failed'
  | 'no-cache';
export type WarmReason = WarmHeld | 'off' | 'not-yet' | 'window-over' | 'expired';
export type WarmDecision =
  | { due: true; reason?: never; held?: never; nextAt?: never }
  | { due: false; reason: WarmReason; held?: WarmHeld; nextAt?: number };

export function portFacts(state: {
  status: SessionStatus;
  running: boolean;
  queued: readonly unknown[];
  pending: readonly unknown[];
  exit?: unknown;
  inFlight?: unknown;
  warmTurn?: WarmTurn;
}): WarmPortFacts {
  return {
    status: state.status,
    running: state.running,
    queued: state.queued.length,
    pending: state.pending.length,
    exited: state.exit !== undefined,
    inFlight: state.inFlight !== undefined,
    turn: state.warmTurn
  };
}

/** A held session contributes no timer. Only owned/config changes reconsider it. */
export function warmDue(
  session: Session,
  port: WarmPortFacts | undefined,
  lastFailure: number | undefined,
  now: number,
  policy: WarmPolicy
): WarmDecision {
  const held = (reason: WarmHeld): WarmDecision => ({ due: false, reason, held: reason });
  if (!port) return held('unsupported');
  if (!session.warm) return { due: false, reason: 'off' };
  if (port.exited || session.closing) return held('ended');
  if (lastFailure === session.updatedAt || port.turn?.failed) return held('failed');
  if (port.turn && port.turn.phase !== 'closed') return held('warming');
  if (port.pending || session.waitingFor) return held('ask');
  if (port.queued) return held('queued');
  if (session.status !== 'idle' || port.status !== 'idle' || port.running || port.inFlight)
    return held('busy');
  const until = cacheTtl.cacheUntil(session);
  const cache = session.cache;
  if (until === undefined || !cache) return held('no-cache');
  if (cache.ttlMs <= policy.marginMs) return held('short-ttl');
  const endsAt = windowEnd(session, policy);
  if (!Number.isFinite(now) || !Number.isFinite(endsAt) || now >= endsAt)
    return { due: false, reason: 'window-over' };
  if (now >= until) return { due: false, reason: 'expired' };
  const nextAt = until - policy.marginMs;
  if (nextAt >= endsAt) {
    // Even the first ping after a real turn would land past the window's end.
    return cache.ttlMs - policy.marginMs >= policy.windowMs
      ? held('window-short')
      : { due: false, reason: 'window-over' };
  }
  return now >= nextAt ? { due: true } : { due: false, reason: 'not-yet', nextAt };
}

/** The pids with Warm switched on: what keep-awake holds for. The switch
 *  alone — a ping is the warmer acting on it, and never feeds back. The switch
 *  goes off when you turn it off or its window lapses (`warmLapsed`). */
export function warmOn(sessions: readonly Session[]): number[] {
  return sessions.filter((session) => session.warm === true).map((session) => session.pid);
}

/** When keeping a switched-on session warm stops: the window after its last
 *  real turn. A ping does not move `updatedAt`, so it never extends this. */
export function warmEndsAt(session: Session, policy: WarmPolicy): number | undefined {
  return session.warm ? windowEnd(session, policy) : undefined;
}

function windowEnd(session: Session, policy: WarmPolicy): number {
  return session.updatedAt + policy.windowMs;
}

/** The window is over and the switch should go off. A session working or
 *  waiting on a dialog is inside a turn whose end moves the window; a ping in
 *  flight is let finish. A switch armed after the window waits for the next
 *  real turn's. A window that had already ended when the policy last changed
 *  (`policySeenAt`) never lapses: a shrink or a typo stops pings, it does not
 *  switch anything off. */
export function warmLapsed(
  session: Session,
  now: number,
  policy: WarmPolicy,
  policySeenAt: number
): boolean {
  const endsAt = warmEndsAt(session, policy);
  if (endsAt === undefined || now < endsAt || endsAt < policySeenAt) return false;
  if (session.warmArmedAt !== undefined && session.warmArmedAt >= endsAt) return false;
  if (isMidTurn(session.status)) return false;
  return !session.warmPort?.running && !session.warmPort?.inFlight;
}

export function nextWarmAt(decision: WarmDecision): number | undefined {
  return decision.nextAt;
}
