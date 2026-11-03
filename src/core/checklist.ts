/** One session's list: how many steps, how many finished, and when the newest
 *  of them was last written — which is what dates the list as a whole. */
export type Checklist = { total: number; completed: number; newestAt: number };

/**
 * Both staleness tests, on any list-shaped statement about a session — the
 * CLI's own, or a finished workflow run standing in for one (`host/panel.ts`).
 *
 * Pure, and separate from the reads in `claude/checklist.ts`, because a second
 * author of the same card word must be held to the same two rules rather than
 * to a copy of them that drifts.
 */
export function speaks(
  list: Checklist,
  dated: { promptAt?: number; ackAt?: number } = {}
): boolean {
  const { promptAt, ackAt } = dated;
  if (promptAt !== undefined && list.newestAt < promptAt) {
    return false;
  }
  if (list.completed >= list.total && ackAt !== undefined && list.newestAt <= ackAt) {
    return false;
  }
  return true;
}
