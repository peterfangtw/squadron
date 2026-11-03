/**
 * Where one inbound event goes. Pure apart from the window lookup a fresh
 * session needs: it reads only what it is handed, so each of D8, D9, D17, D18
 * and D20 is a test. The engine acts on what this returns.
 */

import { openQuestion } from '../coordination/answer';
import { sameSessionStart } from '../model';
import type { WindowClaim } from '../model';
import { closeDescendants } from '../../ui/closing';
import { allowed } from './allow';
import type { Deduper } from './allow';
import { newJob, pickFolder } from './jobs';
import * as picker from './picker';
import type {
  ConversationPlace,
  Inbound,
  Notice,
  Routed,
  SenderId,
  SessionAddr,
  Watched
} from './model';
import { decodePayload, resolveRefs } from './store';
import type { ConversationRecord } from './store';
import * as words from './words';

/** How old a message may be and still act (a duration). An older one waited
 *  out an outage; its sender is asked to send it again (user, 2026-10-10). */
export const LATE_MS = 15 * 60_000;

export type RouteContext = {
  allowlist: readonly SenderId[];
  deduper: Deduper;
  now: number;
  store: readonly ConversationRecord[];
  /** The board as last observed. */
  board: readonly Watched[];
  /** Roots the engine started that no board has shown yet: live, and busy
   *  with their first prompt. */
  starting?: readonly SessionAddr[];
  /** Sessions an End or a lifetime is taking down: no longer running for a
   *  reply, though the board still shows them until the next pass. */
  ending?: readonly SessionAddr[];
  claims: readonly WindowClaim[];
  /** The window a fresh session starts in, with no fallback (D26):
   *  `freshWindow` over the claims. */
  windowFor(cwd: string): Promise<{ window: WindowClaim } | { refuse: Notice }>;
};

/**
 * The allowlist first, before dedupe, the store or any reply, so a stranger's
 * event has no side effect at all (D9). Then a repeat delivery, then the event.
 */
export async function route(event: Inbound, ctx: RouteContext): Promise<Routed> {
  const dropped = admit(event, ctx);
  return dropped ?? routeAdmitted(event, ctx);
}

export function admit(
  event: Inbound,
  ctx: Pick<RouteContext, 'allowlist' | 'deduper' | 'now'>
): Extract<Routed, { kind: 'drop' }> | undefined {
  if (!allowed(event.sender, ctx.allowlist)) return { kind: 'drop', why: 'stranger' };
  if (event.kind === 'message' && event.text.trim() === '') return { kind: 'drop', why: 'empty' };
  if (!ctx.deduper.admit(event.id, ctx.now)) return { kind: 'drop', why: 'repeat' };
  return undefined;
}

export async function routeAdmitted(event: Inbound, ctx: RouteContext): Promise<Routed> {
  switch (event.kind) {
    case 'message':
      return typed(event, ctx);
    case 'press':
      return pressed(event, ctx);
    case 'command':
      return commanded(event, ctx);
  }
}

/**
 * Typed text. Top-level starts a job (D24); in a known conversation it goes to
 * the root (D17), or to a fresh session where an ended root ran (D23). In a
 * thread Remote never started, an @mention joins it: a job under the thread's
 * root. Anything else there starts nothing (U6).
 */
async function typed(
  event: Extract<Inbound, { kind: 'message' }>,
  ctx: RouteContext
): Promise<Routed> {
  const text = event.text.trim();
  if (text === '') return { kind: 'drop', why: 'empty' };
  if (ctx.now - event.at > LATE_MS) {
    return {
      kind: 'refuse',
      reason: 'late',
      place: { under: event.refs[0] ?? event.ref },
      notice: words.missedOfflineNotice
    };
  }
  const sender = event.sender.id;
  if (event.refs.length === 0) {
    return {
      kind: 'job',
      sender,
      text,
      place: { under: event.ref },
      job: newJob(ctx.claims, ctx.now)
    };
  }
  const record = resolveRefs(ctx.store, event.refs);
  if (event.addressed === 'mention' && (record === undefined || unborn(record))) {
    return {
      kind: 'job',
      sender,
      text,
      place: { under: record?.anchor ?? event.refs[0] ?? event.ref },
      job: newJob(ctx.claims, ctx.now),
      joined: true
    };
  }
  if (record === undefined) return { kind: 'orphan', place: { under: event.ref } };
  const here = placeOf(record);
  if (record.state === 'held') {
    return record.held === undefined
      ? { kind: 'orphan', place: here }
      : {
          kind: 'refuse',
          reason: 'unavailable',
          place: here,
          notice:
            record.held.picker?.stage === 'starting'
              ? words.startUnknownNotice
              : words.pickFirstNotice
        };
  }
  const root = record.root;
  if (root === undefined) return { kind: 'orphan', place: here };
  const going = onBoardAddr(ctx.ending ?? [], root) !== undefined;
  const live = going ? undefined : running(ctx.board, root);
  const starting = live === undefined ? onBoardAddr(ctx.starting ?? [], root) : undefined;
  if (starting !== undefined) {
    return {
      kind: 'reply',
      verb: 'send',
      because: 'busy',
      to: starting,
      label: root.label,
      text,
      conversation: record.id
    };
  }
  if (live === undefined) {
    const found = await ctx.windowFor(root.cwd);
    if ('refuse' in found)
      return { kind: 'refuse', reason: 'unavailable', place: here, notice: found.refuse };
    return {
      kind: 'fresh',
      conversation: record.id,
      windowId: found.window.id,
      cwd: root.cwd,
      text,
      brand: root.brand,
      past: root.sessionId
    };
  }
  return { ...replyVerb(live), to: addrOf(live), label: live.label, text, conversation: record.id };
}

/**
 * A conversation with nothing behind it yet: the record admission mints for a
 * message in a thread no record names. A held one whose picker was cancelled,
 * or one whose root has come and gone, has history and is not.
 */
function unborn(record: ConversationRecord): boolean {
  return (
    record.state === 'live' &&
    record.root === undefined &&
    record.past.length === 0 &&
    record.held === undefined
  );
}

/**
 * D20: one open question is answered (an interrupt, then delivery); anything
 * else is a send the outbox may hold, and the receipt says why.
 */
function replyVerb(root: Watched) {
  const { pending } = root;
  const [only] = pending;
  if (only !== undefined && pending.length === 1 && openQuestion(pending, only.requestId).ok) {
    return { kind: 'reply' as const, verb: 'answer' as const, requestId: only.requestId };
  }
  const because: words.HeldBecause | undefined =
    pending.length > 1
      ? 'several'
      : pending.length === 1
        ? 'permission'
        : root.session.status === 'busy'
          ? 'busy'
          : undefined;
  return { kind: 'reply' as const, verb: 'send' as const, ...(because ? { because } : {}) };
}

/** A button: the verb and its target come from the store, never the payload. */
function pressed(event: Extract<Inbound, { kind: 'press' }>, ctx: RouteContext): Routed {
  const decoded = decodePayload(event.payload);
  const record = decoded && ctx.store.find((r) => r.id === decoded.conversation);
  const found = record && actionIn(record, decoded.action);
  if (record === undefined || found === undefined) return { kind: 'drop', why: 'unknown' };
  const { notice, action } = found;
  const at = { conversation: record.id, notice: notice.id };
  if (notice.settled !== undefined) return { kind: 'stale', ...at, word: notice.settled };
  switch (action.verb) {
    case 'choose': {
      const draft = record.held?.picker;
      if (notice.message !== event.message || !picker.accepts(draft, action.generation))
        return { kind: 'drop', why: 'unknown' };
      return { kind: 'choose', ...at, action };
    }
    case 'pick': {
      if (record.held?.picker !== undefined) return { kind: 'drop', why: 'unknown' };
      const folder = action.folder;
      if (record.held === undefined || folder === undefined) {
        return { kind: 'stale', ...at, word: words.expiredWord };
      }
      return {
        kind: 'pick',
        ...at,
        folder,
        picked: pickFolder(record.held, folder, ctx.claims, ctx.now)
      };
    }
    case 'cancel':
      return { kind: 'cancel', ...at };
    case 'end-confirm': {
      const target = notice.target && running(ctx.board, notice.target);
      if (target === undefined) return { kind: 'stale', ...at, word: words.SESSION_ENDED };
      return { kind: 'end-confirmed', ...at, to: addrOf(target), members: notice.members ?? [] };
    }
  }
  const target = notice.target && running(ctx.board, notice.target);
  if (target === undefined) return { kind: 'stale', ...at, word: words.SESSION_ENDED };
  switch (action.verb) {
    case 'deny': {
      const request = target.pending.find((r) => r.requestId === notice.requestId);
      if (request === undefined) return { kind: 'stale', ...at, word: words.NO_LONGER_WAITING };
      return {
        kind: 'deny',
        ...at,
        to: addrOf(target),
        requestId: request.requestId,
        reason: request.canDenyReason !== false
      };
    }
    case 'end':
      return endOf(target, ctx.board, record.owner, record.id);
    // To the verb whatever the board says: a pass up to `REMOTE_CHANGE_MS` old
    // reads a turn begun since as idle, and only the window holding the pipe
    // knows whether one runs ("Status is live, never disk").
    case 'stop':
      return { kind: 'stop', ...at, to: addrOf(target) };
  }
}

/** A command has no message to thread under: its reply goes home. */
function commanded(event: Extract<Inbound, { kind: 'command' }>, ctx: RouteContext): Routed {
  const sender = event.sender.id;
  switch (event.name) {
    case 'list':
      return { kind: 'list', sender };
    case 'help':
      return { kind: 'help', sender, text: event.args };
    case 'new': {
      const text = event.args.trim();
      if (text === '') return { kind: 'help', sender, text: '' };
      return {
        kind: 'job',
        sender,
        text,
        place: { home: sender },
        job: newJob(ctx.claims, ctx.now)
      };
    }
    case 'end': {
      const pid = /^\d+$/.test(event.args.trim()) ? Number(event.args.trim()) : undefined;
      const target = ctx.board.find((w) => w.session.pid === pid && w.exit === undefined);
      if (target === undefined) {
        return {
          kind: 'refuse',
          reason: 'unavailable',
          place: { home: sender },
          notice: words.noSuchSessionNotice(event.args)
        };
      }
      return endOf(target, ctx.board, sender);
    }
  }
}

/** End's confirm counts the descent on the board now (D21); the press that
 *  confirms ends exactly that. */
function endOf(
  target: Watched,
  board: readonly Watched[],
  sender: SenderId,
  conversation?: string
): Routed {
  const below = closeDescendants(
    target.session.pid,
    board.map((w) => w.session)
  );
  return {
    kind: 'end',
    to: addrOf(target),
    label: target.label,
    members: below.map((s) => ({ pid: s.pid, startedAt: s.startedAt, windowId: s.windowId ?? '' })),
    ...(conversation === undefined ? {} : { conversation }),
    sender
  };
}

function actionIn(record: ConversationRecord, id: string) {
  for (const notice of record.notices) {
    const action = notice.actions.find((a) => a.id === id);
    if (action) return { notice, action };
  }
  return undefined;
}

/** A session on the board, matched by pid and start: a recycled pid is
 *  somebody else. */
export function onBoard(
  board: readonly Watched[],
  at: Pick<SessionAddr, 'pid' | 'startedAt'>
): Watched | undefined {
  return board.find(
    (w) => w.session.pid === at.pid && sameSessionStart(w.session.startedAt, at.startedAt)
  );
}

/** A session on the board whose process has not exited: what routing means by
 *  on the board. This window keeps an exited card drawn until it is
 *  dismissed, and a reply to it starts afresh (D23) like one to a root gone. */
function running(
  board: readonly Watched[],
  at: Pick<SessionAddr, 'pid' | 'startedAt'>
): Watched | undefined {
  const found = onBoard(board, at);
  return found?.exit === undefined ? found : undefined;
}

function onBoardAddr(
  addrs: readonly SessionAddr[],
  at: Pick<SessionAddr, 'pid' | 'startedAt'>
): SessionAddr | undefined {
  return addrs.find((a) => a.pid === at.pid && sameSessionStart(a.startedAt, at.startedAt));
}

export function addrOf(w: Watched): SessionAddr {
  return { pid: w.session.pid, startedAt: w.session.startedAt, windowId: w.session.windowId ?? '' };
}

export function placeOf(record: Pick<ConversationRecord, 'anchor' | 'latest'>): ConversationPlace {
  return { conversation: { anchor: record.anchor, latest: record.latest } };
}
