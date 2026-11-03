import { discoverAll } from '../core/adapter';
import { readClaims } from '../core/coordination/claims';
import type { PendingRequest } from '../core/live';
import { Session, WindowClaim, sameSessionStart } from '../core/model';
import { readStatedNames } from '../core/names';
import { PublishedLive, readPublished } from '../core/published';
import type { TargetFailure } from '../core/session_target';
import { foldTwins } from '../ui/views';
import { NO_WINDOW } from './gate';

/**
 * The panel's fold, from outside it: claims first, because with no window
 * running there is no board to be empty — exit 3, not an empty list.
 */
export async function loadBoard(): Promise<
  | {
      ok: true;
      sessions: Session[];
      claims: WindowClaim[];
      published: Map<number, PublishedLive>;
    }
  | { ok: false; code: 3; reason: string }
> {
  const claims = await readClaims();
  if (claims.length === 0) {
    return { ok: false, code: 3, reason: NO_WINDOW };
  }
  const published = await readPublished();
  return {
    ok: true,
    // Handed back as well as folded: `squadron-list` names the window each
    // session runs in, and a window's *label* is only on its claim. Send,
    // answer and rename pass this same observation to `resolveTarget`.
    claims,
    // The stated names too, or `squadron-list` would answer with the name a
    // renamed card stopped wearing — which is exactly the divergence the store
    // exists to close, said to an agent instead of to a reader.
    sessions: foldTwins([], await discoverAll(), published, await readStatedNames()),
    // And the records themselves: a session's open requests ride on its record
    // and not on the folded `Session`, and `squadron-list` prints them.
    published
  };
}

/**
 * The requests a session is blocked on, off the record its window published —
 * only when that record is this run of it. A pid is recycled, and a record
 * whose session has exited stays on disk until the reader dismisses its card.
 */
export function openRequests(
  session: Session,
  published: ReadonlyMap<number, PublishedLive>
): PendingRequest[] {
  const record = published.get(session.pid);
  return record &&
    record.exit === undefined &&
    sameSessionStart(record.session.startedAt, session.startedAt)
    ? record.pending
    : [];
}

/**
 * The shared refusal for a resolved target. `act` stays the verb's own word
 * (`send on`, `answer on`, `rename`); this does not choose the verb's policy.
 * A missing owner claim is not a failure here.
 */
export function targetRefusal(reason: TargetFailure, who: string, act: string): string {
  switch (reason) {
    case 'background':
      return `${who} is a background session the CLI's own daemon runs; there is no pipe to ${act}`;
    case 'unpublished':
      return `no window publishes a pipe for ${who}, so there is nothing to ${act}`;
    case 'owner-missing':
      return `${who} has a pipe, but no window claims it — nothing here can be asked to deliver`;
    case 'exited':
      return `${who} has exited, so there is nothing to ${act}`;
    case 'invalid':
      return `${who} has invalid control facts, so there is nothing to ${act}`;
  }
}
