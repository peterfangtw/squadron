/**
 * How long a remote-spawned session lives (U6, amended 2026-10-10): one the
 * engine started — a new job or a D23 fresh session — is ended once its
 * prompt cache has gone cold, so a reply after that starts a fresh one (D23)
 * rather than re-sending a whole cold context. Never a session started in the
 * panel or spawned by an agent: only a conversation's root the engine marked
 * `remoteSpawned` is read.
 *
 * The clock is the cache clock that exists: `cacheUntil`, the brand's
 * lifetime after the last confirmed cache traffic. A Warm ping is cache
 * traffic, so a warmed session lives until its warm window lapses plus one
 * lifetime with nothing here naming Warm.
 */

import * as cacheTtl from '../cache_ttl';
import { sameSessionStart, type Session } from '../model';
import { closeDescendants } from '../../ui/closing';
import type { SessionAddr, Watched } from './model';
import { addrOf, onBoard } from './route';
import type { ConversationRecord } from './store';

/** A remote-spawned root and its descent, and when they go cold together. */
export type Lapse = {
  record: ConversationRecord;
  root: Watched;
  /** The live descent End's confirm would count (D21), ended with the root. */
  members: SessionAddr[];
  at: number;
  /** The root's own lifetime: how long a refused end waits to be tried again. */
  retryMs: number;
};

/**
 * Every remote-spawned root on the board whose family is idle, with the
 * family's deadline: the latest of the root's and each live descendant's.
 * A root idle on `squadron-wait` goes cold while its fan-out works, and its
 * child's finish is what wakes it, so the child's clock is the family's.
 * Any member not idle holds the whole family; a root `ending` is skipped.
 */
export function lapses(
  records: readonly ConversationRecord[],
  board: readonly Watched[],
  ending: readonly SessionAddr[]
): Lapse[] {
  return records.flatMap((record) => {
    const marked = record.root?.remoteSpawned ? record.root : undefined;
    const root = marked && onBoard(board, marked);
    const going = ending.some(
      (a) => a.pid === marked?.pid && sameSessionStart(a.startedAt, marked.startedAt)
    );
    if (!root || root.exit !== undefined || going) return [];
    const own = coldAt(root.session);
    if (own === undefined || !idle(root)) return [];
    const below = closeDescendants(
      root.session.pid,
      board.map((w) => w.session)
    ).flatMap((s) => {
      const w = onBoard(board, s);
      return w && w.exit === undefined ? [w] : [];
    });
    if (!below.every(idle)) return [];
    const at = Math.max(own, ...below.flatMap((w) => coldAt(w.session) ?? []));
    return [
      {
        record,
        root,
        members: below.map(addrOf),
        at,
        retryMs: root.session.cache?.ttlMs ?? 0
      }
    ];
  });
}

/** Idle as the ruling means it: not working, not waiting on the person, not
 *  warming. `unknown` is not idle, so a session nobody can read is kept. */
function idle(w: Watched): boolean {
  const s = w.session;
  return (
    w.exit === undefined &&
    s.status === 'idle' &&
    w.pending.length === 0 &&
    s.waitingFor === undefined &&
    !s.warming &&
    !s.warmPort?.running &&
    !s.warmPort?.inFlight
  );
}

/** When this session's cache goes cold. A lifetime stated with no traffic
 *  stamped counts from the last real turn; no lifetime stated, never. */
function coldAt(session: Session): number | undefined {
  const until = cacheTtl.cacheUntil(session);
  if (until !== undefined) return until;
  const ttl = session.cache?.ttlMs;
  return cacheTtl.validTtl(ttl) ? session.updatedAt + ttl : undefined;
}
