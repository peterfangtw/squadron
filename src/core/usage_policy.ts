/** The fallback: an account read when no observation has arrived for this long. */
export const USAGE_REFRESH_MS = 60 * 60_000;

/** Interval, not duration: the shortest gap between two activity-driven reads
 *  of one brand, machine-wide. Pushes are not held to it. */
export const LIVE_ACTIVE_MS = 60_000;
/** Duration: how long a turn's end settles before its read, so its own push
 *  can land first and sessions ending together share one read. */
export const LIVE_SETTLE_MS = 2_000;
/** Interval: the next activity-driven read after one failed or was abandoned. */
export const LIVE_FAILURE_MS = 5 * 60_000;
/** Duration: the longest an activity-driven read may take before it counts
 *  as failed. */
export const LIVE_TIMEOUT_MS = 10_000;
/** Duration: an observation this much older than a turn's end still covers
 *  it, since a push arrives with the response before the turn's close. */
export const LIVE_SLACK_MS = 5_000;

/** Why an account may have moved: a turn that ended at `since`, and whether a
 *  turn is running now. */
export type LiveHint = { since?: number; busy: boolean };

/**
 * When the next activity-driven read is due, or never.
 *
 * Both shapes are fixed by facts that only a new observation moves, so asking
 * again later never postpones a read. A turn end is due after its settle and
 * the bound; a running turn once per bound off the last observation.
 */
export function liveDue(
  facts: LiveHint & { observedAt?: number; activeAfter?: number }
): number | undefined {
  const last = facts.observedAt ?? 0;
  const floor = facts.activeAfter ?? 0;
  const covered = facts.since !== undefined && last >= facts.since - LIVE_SLACK_MS;
  const due = [
    facts.since !== undefined && !covered
      ? Math.max(facts.since + LIVE_SETTLE_MS, last + LIVE_ACTIVE_MS, floor)
      : undefined,
    facts.busy ? Math.max(last + LIVE_ACTIVE_MS, floor) : undefined
  ].filter((value): value is number => value !== undefined);
  return due.length ? Math.min(...due) : undefined;
}
