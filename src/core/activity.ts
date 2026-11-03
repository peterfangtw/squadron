import type { SessionStatus } from './model';

/**
 * Whether a state change carries session activity, or only our bookkeeping.
 *
 * `prompt` is a model turn put on the wire, even before the child answers;
 * `agent` is the child's own news; `local` is a panel edit that invoked no
 * model. A slash command is local even though Claude carries it in a user frame.
 *
 * **`agent` is about what the change carries, not which callback it arrived
 * in.** Grok reports a turn's outcome in the *reply* to `session/prompt`
 * (`grok/session.ts`, `stopReason`) — a request of ours, and the agent's own
 * news. Claude's usage answer arrives down the same kind of round trip and is
 * the account's news, not the session's. A tag named for the transport would
 * have to get one of those two wrong.
 *
 * `local` is the default at every `apply`, so a verb added later is quiet by
 * construction — and that direction is the safe one to be wrong in. A tag
 * forgotten leaves a stamp that stops moving, which a reader can notice;
 * the reverse gives a plausible but false reading.
 */
export type ChangeOrigin = 'agent' | 'prompt' | 'local';

/**
 * The host's activity-clock policy, kept headless because `host/` cannot be.
 *
 * `warm` is a latched `LiveState.warmTurn`: a ping is maintenance, so neither
 * its write, its deltas, its end nor the trailing idle behind it is activity.
 */
export function advancesActivityClock(change: {
  origin: ChangeOrigin;
  status: SessionStatus;
  turned: boolean;
  warm: boolean;
}): boolean {
  if (change.warm) {
    return false;
  }
  return (
    change.origin === 'prompt' ||
    (change.origin === 'agent' && (change.turned || change.status !== 'idle'))
  );
}

export function advancesCacheClock(change: {
  origin: ChangeOrigin;
  running: boolean;
  wasRunning: boolean;
  cacheTraffic?: boolean;
}): boolean {
  return (
    change.cacheTraffic !== false &&
    change.origin === 'agent' &&
    (change.cacheTraffic === true || change.running || change.wasRunning)
  );
}
