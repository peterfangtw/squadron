/**
 * The notice policy: which conversation a session posts in (D16), and what two
 * observations of the board say should be posted (D19, D20, D34). Pure — the
 * engine reads the board and the store, and posts what this returns.
 */

import * as path from 'path';
import { catalogFor } from '../catalog';
import type { PendingRequest } from '../live';
import { isMidTurn, sameSessionStart, type Session } from '../model';
import { shownModel } from '../model_names';
import { buildLineage } from '../../ui/views';
import { conversationOfRoot } from './store';
import type { Answered, ConversationRecord, NoticeRecord } from './store';
import type { SessionAddr, Watched } from './model';
import type { Who } from './words';

/**
 * Where one session's notice goes. `open` is a root with no conversation yet,
 * whose first notice opens one (D34).
 */
export type Destination = {
  conversation: { existing: ConversationRecord } | { open: Watched };
  /** D19's role: whether this session is the root its conversation follows. */
  role: 'root' | 'child';
  /** That root's label, for a child's head. */
  root: string;
  /** A child's root has exited or left the board: a reply here reaches a
   *  session that knows nothing of the child (D23), so it cannot answer it. */
  rootEnded?: true;
};

export type NoticeEdge =
  | { kind: 'waiting'; target: Watched; request: PendingRequest; to: Destination }
  /** `answered` is absent for a turn read off the status edge, which carries
   *  no count to tell it from the next. */
  | { kind: 'finished' | 'failed'; target: Watched; to: Destination; answered?: Answered }
  /** A root stopped with its turn open: its window holds its exit. */
  | { kind: 'stopped'; target: Watched; to: Destination; answered: Answered }
  /** A root with a conversation ended, neither mid-turn nor by Remote's End.
   *  A session closes once, so the store's `closed` notice is its key. */
  | { kind: 'closed'; target: Watched; to: Destination }
  /** A request that closed: its notice settles "No longer waiting". */
  | { kind: 'settle'; conversation: ConversationRecord; notice: NoticeRecord };

/**
 * D16 over the live board, with the family reading of U1.
 *
 * Walks live parents to the top — a parent is the live session whose
 * `sessionId` is the `parentSessionId` (`buildLineage`), else the live session
 * the origin stamp names, since a stamp still names the fan-out when its
 * middle has gone. If the top has a conversation, that is it. Otherwise a
 * conversation whose root, present or past, is the top's parent or origin,
 * or whose past is the top (an exited top whose reply started afresh, D23),
 * keeps the family in one thread although its root has ended. Otherwise the
 * top is a root of its own.
 */
export function conversationFor(
  watched: Watched,
  board: readonly Watched[],
  store: readonly ConversationRecord[]
): Destination {
  const top = topOf(watched, board);
  const role = roleOf(watched, top, top.label);
  const ended = role.role === 'child' && top.exit !== undefined ? { rootEnded: true as const } : {};
  const own = conversationOfRoot(store, top.session);
  if (own) return { conversation: { existing: own }, ...role, ...ended };
  const family = familyConversation(top, store);
  if (family) {
    return {
      conversation: { existing: family },
      role: 'child',
      root: family.root?.label ?? top.label,
      rootEnded: true
    };
  }
  return { conversation: { open: top }, ...role, ...ended };
}

/** Who a notice about `target` names in its head: the model and effort the
 *  card shows, and a child's root and step. */
export function whoOf(target: Watched, to: Destination): Who {
  const session = target.session;
  const where = session.repoRoot ?? session.cwd;
  const model = modelName(session);
  return {
    label: target.label,
    repo: path.basename(where) || where,
    ...(model === undefined ? {} : { model }),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(to.role === 'child' ? { root: to.root } : {}),
    ...(to.role === 'child' && to.rootEnded && { rootEnded: true }),
    ...(to.role === 'child' && target.step !== undefined ? { step: target.step } : {})
  };
}

/** The name the card would print. The session's brand's catalog only: another
 *  brand's row must not answer, and a session that stated no brand keeps the
 *  spelling it did state. Unstated is omitted, not filled in. */
function modelName(session: Session): string | undefined {
  const stated = session.model || session.modelPick;
  if (!stated) return undefined;
  if (session.brand === undefined) return stated;
  return (
    shownModel(catalogFor(session.brand), session.model, session.modelPick, session.contextSize)
      ?.text ?? stated
  );
}

function roleOf(watched: Watched, top: Watched, label: string) {
  return { role: same(watched, top) ? ('root' as const) : ('child' as const), root: label };
}

function topOf(watched: Watched, board: readonly Watched[]): Watched {
  const sessions = board.map((w) => w.session);
  const lineage = buildLineage(sessions);
  const byPid = new Map(board.map((w) => [w.session.pid, w]));
  const byId = new Map(
    board.filter((w) => w.session.sessionId !== '').map((w) => [w.session.sessionId, w])
  );
  // A recycled pid or a resumed twin can write a cycle; the walk stops at the
  // first session it has already passed.
  const seen = new Set<number>();
  let at = watched;
  for (;;) {
    seen.add(at.session.pid);
    const parentPid = lineage.get(at.session.pid)?.parent;
    const origin = at.session.originSessionId;
    const next =
      (parentPid === undefined ? undefined : byPid.get(parentPid)) ??
      (origin === undefined || origin === at.session.sessionId ? undefined : byId.get(origin));
    if (next === undefined || seen.has(next.session.pid)) return at;
    at = next;
  }
}

function familyConversation(
  top: Watched,
  store: readonly ConversationRecord[]
): ConversationRecord | undefined {
  const names = [top.session.parentSessionId, top.session.originSessionId].filter(
    (id): id is string => id !== undefined && id !== ''
  );
  const own = top.session.sessionId;
  const rooted = (record: ConversationRecord, id: string) =>
    record.root?.sessionId === id || record.past.includes(id);
  const family = (record: ConversationRecord) =>
    names.some((id) => rooted(record, id)) || (own !== '' && record.past.includes(own));
  return store
    .filter((record) => record.state === 'live' && family(record))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** What the policy needs to tell a crash from an End someone asked for. */
export type Stops = {
  /** Sessions an End from Remote is taking down. */
  ending?: readonly SessionAddr[];
};

/**
 * What changed between two observations, as notices to post or settle.
 *
 * - A request id added → `waiting`, for a root or a child (D19), unless the
 *   store already holds a notice for it (a reload). A session's first
 *   observation counts its open requests as added (U2).
 * - A request id gone, or its session gone → `settle` on its stored notice.
 * - A turn that ended → `finished` for a root, `failed` for anyone, silent
 *   for an interruption and for a child's finish. Read off `turnsEnded` when
 *   both observations carry it, since a finish that at once drains a held
 *   reply is `busy` on both; else off the status edge. A session's first
 *   observation is a baseline and ends no turn.
 * - A root that ended between the two observations — its exit, or gone from
 *   the board — unless an End from Remote ended it (`Stops`), whose confirm
 *   already says so:
 *   - busy or waiting before, holding its exit after, with no turn closed
 *     between (an interruption included) → `stopped`;
 *   - else, when it has a conversation → `closed`, after any finish the same
 *     pass read. A desk End, a window's close and an idle crash all land
 *     here; a session with no conversation stays silent (D34).
 *   A child stays silent, as its finish does. A session already exited on
 *   the earlier observation has said so, and leaving the board after is its
 *   card dismissed. An exited session holds no open request.
 * - A finish, failure or stop the store already holds a notice for (the count
 *   or the exit it answered), or a close it holds a `closed` notice for, is
 *   not posted again, as a waiting one is not: a rebuild hands the next
 *   engine the board a cut pass began from.
 */
export function noticeEdges(
  previous: readonly Watched[],
  next: readonly Watched[],
  store: readonly ConversationRecord[],
  stops: Stops = {}
): NoticeEdge[] {
  const edges: NoticeEdge[] = [];
  const later = (w: Watched) => next.find((n) => same(n, w));
  for (const before of previous) {
    const after = later(before);
    const open = new Set(
      after?.exit === undefined ? (after?.pending.map((r) => r.requestId) ?? []) : []
    );
    for (const request of before.pending) {
      if (open.has(request.requestId)) continue;
      const found = storedNotice(store, before, request.requestId);
      if (found && found.notice.settled === undefined) edges.push({ kind: 'settle', ...found });
    }
  }
  for (const before of previous) {
    const after = later(before);
    if (after?.exit === undefined || !endedBetween(before, after, stops)) continue;
    if (!stoppedOpen(before, after)) continue;
    const answered = { exit: after.exit };
    if (postedFor(store, before, answered)) continue;
    const to = conversationFor(before, previous, store);
    if (to.role === 'root') edges.push({ kind: 'stopped', target: before, to, answered });
  }
  for (const after of next) {
    const before = previous.find((p) => same(p, after));
    const had = new Set(before?.pending.map((r) => r.requestId) ?? []);
    for (const request of after.exit === undefined ? after.pending : []) {
      if (had.has(request.requestId)) continue;
      if (storedNotice(store, after, request.requestId)) continue;
      edges.push({
        kind: 'waiting',
        target: after,
        request,
        to: conversationFor(after, next, store)
      });
    }
    if (before === undefined) continue;
    const ended = turnEnded(before, after);
    if (ended === undefined) continue;
    const count = after.session.turnsEnded;
    const answered = count === undefined ? {} : { answered: { turnsEnded: count } };
    if (answered.answered && postedFor(store, after, answered.answered)) continue;
    const to = conversationFor(after, next, store);
    if (ended === 'failed') edges.push({ kind: 'failed', target: after, to, ...answered });
    else if (to.role === 'root') edges.push({ kind: 'finished', target: after, to, ...answered });
  }
  for (const before of previous) {
    const after = later(before);
    if (!endedBetween(before, after, stops) || saidClosed(store, before)) continue;
    if (after?.exit !== undefined && stoppedOpen(before, after)) continue;
    const to = conversationFor(before, previous, store);
    if (to.role === 'root' && 'existing' in to.conversation) {
      edges.push({ kind: 'closed', target: before, to });
    }
  }
  return edges;
}

/**
 * The first pass after a load has no earlier observation, so `noticeEdges`
 * sees no request close. A request answered or a session ended while Remote
 * was off leaves its stored notice open; this settles every one whose request
 * the board does not hold now.
 */
export function closedWhileAway(
  board: readonly Watched[],
  store: readonly ConversationRecord[]
): NoticeEdge[] {
  const edges: NoticeEdge[] = [];
  for (const conversation of store) {
    for (const notice of conversation.notices) {
      const { requestId, target } = notice;
      if (requestId === undefined || target === undefined || notice.settled !== undefined) continue;
      const session = board.find(
        (w) =>
          w.session.pid === target.pid && sameSessionStart(w.session.startedAt, target.startedAt)
      );
      if (session?.pending.some((r) => r.requestId === requestId)) continue;
      edges.push({ kind: 'settle', conversation, notice });
    }
  }
  return edges;
}

/**
 * Whether `before`, exited on `after`, stopped with its turn open. Only an
 * exit says so. A crash leaves its window holding the exit, and the card
 * drawn until dismissed: in the handle here, in the published record from
 * another window. An End at the desk and a window's close drop both at once,
 * so a session that leaves the board was ended or closed: `closed`, not this.
 */
function stoppedOpen(before: Watched, after: Watched): boolean {
  const { status } = before.session;
  if (!isMidTurn(status)) return false;
  if (countRose(before, after)) return false;
  return turnEnded(before, after) === undefined;
}

/** Whether `before` ended between the two observations — its exit, or gone
 *  from the board — and no End from Remote did it. One exited on the earlier
 *  observation has said so; its leaving after is its card dismissed. */
function endedBetween(before: Watched, after: Watched | undefined, stops: Stops): boolean {
  if (before.exit !== undefined || (after !== undefined && after.exit === undefined)) return false;
  return !(stops.ending ?? []).some(
    (a) => a.pid === before.session.pid && sameSessionStart(a.startedAt, before.session.startedAt)
  );
}

/** A turn closed between the two observations, however it ended: an
 *  interruption says nothing of its own, and is no stop either. */
function countRose(before: Watched, after: Watched): boolean {
  const was = before.session.turnsEnded;
  const now = after.session.turnsEnded;
  return was !== undefined && now !== undefined && now > was;
}

/**
 * How a turn between the two observations ended: `finished`, `failed`, or
 * nothing to say. A rise in the count reads the outcome its own close wrote
 * (`endedOutcome`), since the next turn starting clears `turnOutcome`; an
 * outcome nobody stated is a finish (`core/events.ts`). One edge however far
 * the count rose. A warm ping never moves the count, and on the status edge
 * `warming` on the earlier observation marks it.
 */
function turnEnded(before: Watched, after: Watched): 'finished' | 'failed' | undefined {
  const was = before.session.turnsEnded;
  const now = after.session.turnsEnded;
  if (was !== undefined && now !== undefined) {
    if (now <= was) return undefined;
    return byOutcome(after.session.endedOutcome ?? 'done');
  }
  const from = before.session.status;
  if (!isMidTurn(from)) return undefined;
  if (after.session.status !== 'idle' || before.session.warming) return undefined;
  const outcome = after.session.turnOutcome;
  return outcome === undefined ? undefined : byOutcome(outcome);
}

function byOutcome(outcome: 'done' | 'interrupted' | 'error') {
  if (outcome === 'error') return 'failed' as const;
  return outcome === 'done' ? ('finished' as const) : undefined;
}

function storedNotice(
  store: readonly ConversationRecord[],
  watched: Watched,
  requestId: string
): { conversation: ConversationRecord; notice: NoticeRecord } | undefined {
  for (const conversation of store) {
    const notice = conversation.notices.find(
      (n) =>
        n.requestId === requestId &&
        n.target !== undefined &&
        n.target.pid === watched.session.pid &&
        sameSessionStart(n.target.startedAt, watched.session.startedAt)
    );
    if (notice) return { conversation, notice };
  }
  return undefined;
}

/** Whether a notice in the store already answered this edge of `watched`. */
function postedFor(
  store: readonly ConversationRecord[],
  watched: Watched,
  answered: Answered
): boolean {
  return store.some((conversation) =>
    conversation.notices.some(
      (n) => n.answered !== undefined && sameAnswered(n.answered, answered) && isAbout(n, watched)
    )
  );
}

/** Whether the store already said `watched` closed. */
function saidClosed(store: readonly ConversationRecord[], watched: Watched): boolean {
  return store.some((conversation) =>
    conversation.notices.some((n) => n.kind === 'closed' && isAbout(n, watched))
  );
}

function isAbout(notice: NoticeRecord, watched: Watched): boolean {
  return (
    notice.target !== undefined &&
    notice.target.pid === watched.session.pid &&
    sameSessionStart(notice.target.startedAt, watched.session.startedAt)
  );
}

function sameAnswered(a: Answered, b: Answered): boolean {
  if ('turnsEnded' in a) return 'turnsEnded' in b && a.turnsEnded === b.turnsEnded;
  return 'exit' in b && a.exit.code === b.exit.code && a.exit.signal === b.exit.signal;
}

function same(a: Watched, b: Watched): boolean {
  return (
    a.session.pid === b.session.pid && sameSessionStart(a.session.startedAt, b.session.startedAt)
  );
}
