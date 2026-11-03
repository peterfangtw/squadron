/**
 * The board Remote sees: every session a window drives, as the notice policy
 * reads one (`Watched`). This window's from its handles, every other window's
 * from its published record, live or holding its exit, both joined to lineage
 * so D16's walk has a parent to climb. No `discoverAll`: the twin's facts —
 * git, effort, `hasCommand` — are ones the policy never reads, and a pass that
 * read `~/.claude` would cost every 5 s what the policy does not need.
 *
 * Background and hand-started sessions never appear: neither has a window to
 * drive it, so neither has anything Remote could do to it.
 */

import type { SessionAddr, Watched } from '../bridge/model';
import * as words from '../bridge/words';
import { spawnedBy, type LineageEntry } from '../coordination/lineage';
import type { PendingRequest } from '../live';
import type { MessageFact } from '../message_facts';
import { sameSessionStart, type Session } from '../model';
import { liveRecords, type PublishedLive } from '../published';
import { displayName } from '../../ui/views';

/** One session this window drives, read off its handle. */
export type OwnSession = {
  receiverIdentity?: import('../bridge/model').ReceiverIdentity;
  remoteLaunchEvidence?: import('../bridge/model').RemoteLaunchEvidence;
  incomingDeliveries?: readonly import('../bridge/model').IncomingDeliveryEvidence[];
  session: Session;
  pending: readonly PendingRequest[];
  messageFacts?: readonly MessageFact[];
  exit?: { code: number | null; signal: string | null };
};

export type BoardInput = {
  windowId: string;
  own: readonly OwnSession[];
  /** Every record on the machine; the dead are dropped here, against `starts`,
   *  bar those that hold their exit. */
  published: ReadonlyMap<number, PublishedLive>;
  starts: ReadonlyMap<number, number>;
  lineage: ReadonlyMap<number, LineageEntry>;
  /** The step each session's run is on, by sessionId, where a run says. */
  steps?: ReadonlyMap<string, number>;
};

export function remoteBoard(input: BoardInput): Watched[] {
  const mine = new Set(input.own.map((one) => one.session.pid));
  // A record that holds its exit is a crash its window still draws, kept so
  // the notice policy sees it stop; an End or a close removes the record.
  const exited = [...input.published.values()].filter((record) => record.exit !== undefined);
  // Memory is fresher than the file this window wrote from it.
  const foreign = [...liveRecords(input.published, input.starts), ...exited].filter(
    (record) => !mine.has(record.session.pid)
  );
  return [...input.own, ...foreign]
    .filter((one) => one.session.windowId !== undefined)
    .map((one) => watched(one, input));
}

/** What `RemoteHost.attachTarget` answers: the session, or why a file cannot
 *  go to it, in the words `Bridge.attach` would use. */
export type Target =
  { ok: true; session: Session; maxBytes: number } | { ok: false; reason: string };

export function findTarget(
  board: readonly Watched[],
  addr: SessionAddr,
  starts: ReadonlyMap<number, number>,
  files: { readonly maxBytes: number } | undefined
): Target {
  if (!sameSessionStart(starts.get(addr.pid), addr.startedAt)) {
    return { ok: false, reason: words.SESSION_ENDED };
  }
  const found = board.find(
    (one) =>
      one.session.pid === addr.pid &&
      one.session.windowId === addr.windowId &&
      sameSessionStart(one.session.startedAt, addr.startedAt)
  );
  if (!found) return { ok: false, reason: words.NOT_ON_BOARD };
  if (found.exit) return { ok: false, reason: words.SESSION_ENDED };
  if (!files) return { ok: false, reason: words.NO_FILES };
  return { ok: true, session: found.session, maxBytes: files.maxBytes };
}

function watched(one: OwnSession | PublishedLive, input: BoardInput): Watched {
  const session = { ...one.session, ...spawnedBy(input.lineage, one.session) };
  const step = input.steps?.get(session.sessionId);
  return {
    session,
    receiverIdentity: one.receiverIdentity,
    remoteLaunchEvidence: one.remoteLaunchEvidence,
    incomingDeliveries: one.incomingDeliveries,
    pending: one.pending,
    ...(one.messageFacts === undefined ? {} : { messageFacts: one.messageFacts }),
    label: displayName(session),
    ...(one.exit === undefined ? {} : { exit: one.exit }),
    ...(step === undefined ? {} : { step })
  };
}
