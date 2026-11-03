/** Extracted from host/panel.ts — session lookup verbs (H56). */
import { routeTo as resolveRoute, type Route } from '../core/coordination/route';
import { ownedSession, stateName } from './sessions';

export type { Route };

/**
 * Which handle can act on this pid: this window's, or a refusal.
 *
 * **There is no second arm since row 71.** This used to resolve a session
 * another window drives, off its published record, and hand back a handle that
 * posted request files to that window. The board no longer draws such a card,
 * so nothing can reach one: the panel's sessions are what this window started
 * plus background ones, and a background session is discovered and never owned.
 * A pid that is not ours is refused with `UNROUTED`.
 */
export function routeTo(pid: number): Route {
  return resolveRoute({
    owned: ownedSession(pid),
    // The rename writer, closed over the pid: `stateName` states the name, not
    // the CLI, so every owned card takes one whether or not its brand has a
    // door. Handed in rather than imported there, so `core/coordination/route.ts` stays
    // free of `host/`.
    stateName: (title: string) => stateName(pid, title)
  });
}
