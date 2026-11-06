/**
 * The live half of an owned session, published where another window can read it.
 *
 * Status, model and open dialogs live in the owning host's memory. Published
 * metadata lets shims, waits and discovery read them beside a live twin.
 *
 * A file rather than a query, for the same reason claims and lineage are files:
 * the panel's poll already reads per-session files and degrades a missing one to
 * "nothing to show", where a query costs a round trip per remote session per
 * poll and has to be answered whether or not the owning window has a panel open.
 *
 * Nothing here is trusted on its own. A record is only ever read beside a twin
 * `discover` accepted as live, and a child dies with its host's stdin — so a
 * record with no live twin is a record from a window that is gone, and the
 * reader ignores it rather than resurrecting a card.
 */

import * as platform from './platform';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as incoming from './incoming';
import { isStartSource } from './platform/processes';
import * as sessionTarget from './session_target';
import type {
  ReceiverIdentity,
  RemoteLaunchEvidence,
  IncomingDeliveryEvidence
} from './bridge/model';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from './files';
import type { PendingRequest, QueuedMessage } from './live';
import { readMessageFacts, type MessageFact } from './message_facts';
import { sameSessionStart, type Session } from './model';
import { wrapperOf, type Ancestry, type ProcessTable, type Proc } from './scan';
import { LIVE_DIR } from './paths';
import { isBrand, sessionBrand, type BrandId } from './brands';

/**
 * What another window needs to draw and act on a held row — no image bytes.
 *
 * `images` is the count rather than the blocks: the bytes stay in the process
 * that holds the pipe, and all a remote row does with them is say they are
 * there, which is the difference between a blank row and a legible one.
 */
export type PublishedQueued = Pick<QueuedMessage, 'id' | 'text' | 'queuedAt'> & {
  images?: number;
};

/**
 * One owned session as its window sees it.
 *
 * `session` is exactly what `host/sessions.ts:fromLive` built, `windowId`
 * included — that function is already the one definition of what an owned card
 * is, and a second mapping here would be a second chance to disagree with it.
 * What a `Session` has no room for rides beside it.
 *
 * The git fields are deliberately *not* here. `discover` reads them from `.git`
 * for the twin, no frame carries them, and the reading window already has them.
 */
export type PublishedLive = {
  stopping?: { members: readonly { pid: number; startedAt: number }[] };
  receiverIdentity?: ReceiverIdentity;
  remoteLaunchEvidence?: RemoteLaunchEvidence;
  incomingDeliveries?: readonly IncomingDeliveryEvidence[];
  schema: 1;
  session: Session;
  pending: PendingRequest[];
  queued: PublishedQueued[];
  messageFacts?: readonly MessageFact[];
  exit?: { code: number | null; signal: string | null };
};

/** Every write and removal, in the order they were asked for. */
let chain: Promise<void> = Promise.resolve();

/**
 * Both of the callers below are fire-and-forget — nothing awaits a publish, and
 * an ending removes the record without knowing whether a write is still in the
 * air — so without this the filesystem decides the order. Two ways that goes
 * wrong, and both are the same fix: a removal that overtakes the write it was
 * meant to undo leaves the record on disk for a session that has ended, and two
 * writes whose renames land out of order pin the older state until the session
 * next changes.
 *
 * One chain for the machine rather than one per pid: these are sub-millisecond
 * file writes for the handful of sessions one window drives, so the parallelism
 * a per-pid key would buy back is worth less than the bookkeeping it costs.
 *
 * Neither step rejects, which is what lets the chain be `then(step, step)` and
 * never need a `catch` of its own.
 */
function inOrder<T>(step: () => Promise<T>): Promise<T> {
  const next = chain.then(step, step);
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Writes one session's record. Best effort: a machine that cannot write this
 * still drives the session perfectly well from the window that owns it, and
 * every other window degrades to the card it shows today.
 *
 * Temp-then-rename, for the reason `writeAtomicJson` states: a card that blinks
 * out while another window is mid-write is the whole failure this avoids.
 */
export function publishLive(record: PublishedLive, required = false): Promise<boolean> {
  const pid = record.session.pid;
  return inOrder(async () => {
    // Schema-1 readers in older windows reject the whole record without this field.
    const file = path.join(LIVE_DIR, `${pid}.json`);
    const body = { ...record, liveText: '' };
    if (!required) return writeAtomicJson(file, body);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(LIVE_DIR, { recursive: true });
      const encoded = JSON.stringify(body);
      const output = await fs.open(tmp, 'wx', 0o600);
      try {
        await output.writeFile(encoded);
        await output.sync();
      } finally {
        await output.close();
      }
      await platform.files.replace(tmp, file);
      await platform.files.syncDirectory(LIVE_DIR);
      return (await fs.readFile(file, 'utf8')) === encoded;
    } catch {
      return false;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
}

/**
 * The pid a `live/` path names, or `undefined` for any other file.
 *
 * The spelling of that path is `publishLive`'s, so the reading of it stays in
 * the same file: a watcher elsewhere sorting events by directory would
 * otherwise be a second place that knows records are `<pid>.json`. The
 * directory is the watcher's spelling against ours, so it compares by key.
 */
export function livePid(file: string): number | undefined {
  if (platform.paths.key(path.dirname(file)) !== platform.paths.key(LIVE_DIR)) {
    return undefined;
  }
  // Only the name `publishLive` writes; any other asks for the full refresh.
  const name = /^([1-9]\d*)\.json$/.exec(path.basename(file))?.[1];
  const pid = Number(name);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/**
 * Forgets a session's record. Never throws: a file already gone is the outcome.
 *
 * Ordered against `publishLive` rather than racing it: the whole point of
 * calling this is that the session has ended, and a write still in flight when
 * it was called would otherwise rename the record back into place a moment
 * later, for a session no window will ever publish for again.
 */
export function removePublished(pid: number): Promise<void> {
  return inOrder(() => fs.rm(path.join(LIVE_DIR, `${pid}.json`), { force: true }).catch(() => {}));
}

/** Original receipts have no age cutoff; only positive exact owner death permits crash cleanup. */
export async function pruneIncomingPublished(
  table: Pick<import('./scan').ProcessTable, 'starts' | 'complete' | 'startSource'>
): Promise<void> {
  for (const [pid, record] of await readPublished()) {
    const receiver = record.receiverIdentity;
    if (!receiver || !incoming.ownerDead(receiver.host, table)) continue;
    await inOrder(async () => {
      const file = path.join(LIVE_DIR, `${pid}.json`);
      try {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink()) return;
        const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        const current =
          raw && typeof raw === 'object' && 'receiverIdentity' in raw
            ? incoming.readReceiverIdentity(raw.receiverIdentity)
            : undefined;
        const after = await fs.lstat(file);
        if (
          current &&
          incoming.sameReceiver(current, receiver) &&
          before.ino === after.ino &&
          before.dev === after.dev
        )
          await fs.unlink(file);
      } catch {
        /* Missing or changed files defer cleanup. */
      }
    });
  }
}

/**
 * Every record on the machine, by pid.
 *
 * Unreadable, half-written, foreign and future-schema files are skipped rather
 * than thrown over: this is read on the panel's poll, and one bad file must not
 * cost the whole board. The pid in the name has to agree with the pid inside,
 * which is the cheapest guard against a record renamed under a key it never
 * described.
 */
export async function readPublished(): Promise<Map<number, PublishedLive>> {
  const found = await readJsonDir(LIVE_DIR, (raw, name) => {
    const pid = Number(path.basename(name, '.json'));
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const record = decodePublished(raw, pid);
    return record ? ([pid, record] as const) : undefined;
  });
  return new Map(found);
}

/**
 * Every record, for a caller that must not read a failure as absence: resume
 * ownership and wait evidence. `readPublished` stays the display read.
 *
 * A missing directory is a machine that has published nothing, and a file gone
 * between the listing and its read was removed. Anything else that stopped a
 * read is kept: `listed` is false when `live/` could not be listed, and
 * `unreadable` names each `<pid>.json` that could not be read, parsed or
 * decoded (a newer schema included), because that pid may be an owner whose
 * record says so. A record that decodes but names no conversation it could
 * own (`identified`) is unreadable too, never a read record of some other
 * conversation. Files not named `<pid>.json` are not records.
 */
export type PublishedEvidence = {
  records: ReadonlyMap<number, PublishedLive>;
  listed: boolean;
  unreadable: ReadonlySet<number>;
};

export async function readPublishedEvidence(): Promise<PublishedEvidence> {
  const records = new Map<number, PublishedLive>();
  const unreadable = new Set<number>();
  let names: string[];
  try {
    names = await fs.readdir(LIVE_DIR);
  } catch (error) {
    const listed = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return { records, listed, unreadable };
  }
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
      if (!Number.isSafeInteger(pid)) return;
      const reading = await readPublishedOne(pid);
      if (reading.kind === 'found' && identified(reading.record)) records.set(pid, reading.record);
      else if (reading.kind !== 'missing') unreadable.add(pid);
    })
  );
  return { records, listed: true, unreadable };
}

/**
 * Whether a record says which conversation it holds, the fields resume and
 * waits join on: a string session id (empty for a fresh session that has none
 * yet; a resume always carries the id it resumes), a known brand or none (a
 * legacy record, read as the default brand), and a real start.
 */
export function identified(record: PublishedLive): boolean {
  const { sessionId, brand, startedAt } = record.session as Partial<Session>;
  return (
    typeof sessionId === 'string' &&
    (brand === undefined || isBrand(brand)) &&
    typeof startedAt === 'number' &&
    Number.isFinite(startedAt) &&
    startedAt > 0
  );
}

/**
 * One discovery pass's reads, for a caller that judges the board it builds
 * (`coordination/wait_board.ts`). Records are read once, here, and every brand
 * joins against these same records; each brand reads its own files once and
 * says what it could not decode. So the board and its confidence describe one
 * read, not a board and a later reread.
 */
export type PassEvidence = {
  published: PublishedEvidence;
  /** False once a brand's own directory could not be listed. */
  listed: boolean;
  /** Pids whose brand file could not be read or decoded. */
  unread: Set<number>;
  /**
   * Pids a brand positively knows finished although the process runs: a
   * Claude pooled worker whose job is done or failed.
   */
  retired: Set<number>;
};

export function passEvidence(published: PublishedEvidence): PassEvidence {
  return { published, listed: true, unread: new Set(), retired: new Set() };
}

/** Whether every record a running pid could have was read. */
export function publicationsKnown(
  evidence: Pick<PublishedEvidence, 'listed' | 'unreadable'>,
  running: Pick<ProcessTable, 'starts'>
): boolean {
  return evidence.listed && ![...evidence.unreadable].some((pid) => running.starts.has(pid));
}

/** The pid and start a published session is known by: always its spawned root. */
export type PublishedProcess = { pid: number; startedAt: number };

/**
 * The published session a recognized `brand` process stands for, or nothing:
 * the record is the only proof a Grok or Codex process is ours.
 *
 * Its own pid when a record was published for it on that start. Otherwise
 * the runtime root that wraps it (`wrapperOf`), when the root has a record of
 * this brand on the root's own start, so a stale record on a recycled pid, a
 * brandless legacy one (read as Claude) and any process nobody published are
 * dropped. The session keeps the root's pid and start, which is what the
 * owned card, lineage and every control check name.
 */
export function publishedProcess(
  proc: Proc,
  brand: BrandId,
  records: ReadonlyMap<number, PublishedLive>,
  table: Ancestry
): PublishedProcess | undefined {
  if (sameSessionStart(records.get(proc.pid)?.session.startedAt, proc.startedAt)) {
    return { pid: proc.pid, startedAt: proc.startedAt };
  }
  const root = wrapperOf(table, proc);
  const startedAt = root === undefined ? undefined : table.starts.get(root);
  const record = root === undefined ? undefined : records.get(root);
  if (root === undefined || startedAt === undefined || !record) return undefined;
  return sessionBrand(record.session.brand) === brand &&
    sameSessionStart(record.session.startedAt, startedAt)
    ? { pid: root, startedAt }
    : undefined;
}

export type PublicationReading =
  { kind: 'missing' | 'unknown' } | { kind: 'found'; record: PublishedLive };

/** Unlike display discovery, an unreadable record cannot prove that no owner publishes it. */
export async function readPublishedOne(pid: number): Promise<PublicationReading> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(LIVE_DIR, `${pid}.json`), 'utf8'));
    const record = decodePublished(raw, pid);
    return record ? { kind: 'found', record } : { kind: 'unknown' };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown' };
  }
}

function decodePublished(raw: unknown, pid: number): PublishedLive | undefined {
  const record = raw as Partial<PublishedLive> | undefined;
  if (!usable(record, pid)) return undefined;
  const {
    messageFacts: evidence,
    receiverIdentity: identity,
    remoteLaunchEvidence: launch,
    incomingDeliveries: deliveries,
    ...body
  } = record;
  const messageFacts = readMessageFacts(evidence);
  const decoded = incoming.readReceiverIdentity(identity);
  const receiverIdentity =
    decoded &&
    decoded.pid === pid &&
    decoded.host.windowId === record.session.windowId &&
    decoded.cwd === record.session.cwd &&
    decoded.brand === record.session.brand
      ? decoded
      : undefined;
  const marker = incoming.readRemoteLaunchEvidence(launch);
  const remoteLaunchEvidence =
    receiverIdentity && marker && incoming.sameReceiver(receiverIdentity, marker.receiver)
      ? marker
      : undefined;
  const receipts = readDeliveries(deliveries, receiverIdentity);
  return {
    ...body,
    session:
      'control' in record.session
        ? { ...record.session, control: sessionTarget.controlOf(record.session) }
        : record.session,
    ...(messageFacts === undefined ? {} : { messageFacts }),
    ...(receiverIdentity === undefined ? {} : { receiverIdentity }),
    ...(remoteLaunchEvidence === undefined ? {} : { remoteLaunchEvidence }),
    ...(receipts === undefined ? {} : { incomingDeliveries: receipts })
  };
}

/**
 * The records whose session is still running, joined against the process table.
 *
 * **The rule at the top of this file, as code.** A record is only ever read
 * beside a twin `discover` accepted as live, and until row 71 every reader had
 * that twin in hand by construction — `ui/views.ts:promote` folds onto one and
 * can do nothing else. The resume picker is the reader that does not
 * (`host/session_open.ts`), and reading records without the join is how it came
 * to call a conversation live for the seven days `core/prune.ts` takes to clear
 * a force-quit window's `live/`.
 *
 * Two tests, and a record needs both. `exit` is the owning window saying so
 * itself, and it stays on disk until the reader dismisses the card — so a
 * session that ended *here* is still published, and a reader that skips this
 * one lets it back in the moment the board has correctly let it out. The start
 * match is for the window that never got to say it: nothing sweeps `live/` when
 * a host is force-quit. A start match rather than a bare "is that pid alive",
 * because a pid is recycled — the same guard, for the same reason, that
 * `core/control.ts` puts in front of every signal.
 */
export function liveRecords(
  published: ReadonlyMap<number, PublishedLive>,
  starts: ReadonlyMap<number, number>
): PublishedLive[] {
  return [...published].flatMap(([pid, record]) =>
    !record.stopping &&
    record.exit === undefined &&
    sameSessionStart(starts.get(pid), record.session.startedAt)
      ? [record]
      : []
  );
}

/** Stopping ownership remains evidence even after the native root has exited. */
export function stoppingConversations(
  published: ReadonlyMap<number, PublishedLive>,
  table: ProcessTable
): PublishedLive[] {
  return [...published.values()].filter(
    (record) =>
      record.stopping &&
      (!table.complete ||
        sameSessionStart(table.starts.get(record.session.pid), record.session.startedAt) ||
        record.stopping.members.some((member) => table.starts.get(member.pid) === member.startedAt))
  );
}

/**
 * Whether another window holds a conversation, for a resume that would start
 * a second child on its transcript. `held` on any live or stopping record
 * that matches. `free` only on a complete table from a recognized clock,
 * because only that proves a matching record's process gone: an incomplete
 * table may have left out the very row, and a failed one is empty. And only
 * when every record that could name it was read: an unlisted `live/`, or an
 * unreadable record at a pid the table still runs, may be the owner's.
 * Otherwise `unknown`, which a caller refuses and may retry.
 *
 * An unreadable record at a pid a complete table does not run is passed over.
 * That leaves one gap: it may have been a stopping record whose members still
 * run, which nothing unreadable can say.
 */
export type ConversationOwner = 'held' | 'free' | 'unknown';

export function conversationOwner(
  published: PublishedEvidence,
  table: ProcessTable,
  matches: (session: PublishedLive['session']) => boolean
): ConversationOwner {
  const mine = new Map([...published.records].filter(([, record]) => matches(record.session)));
  if (stoppingConversations(mine, table).length > 0) return 'held';
  if (liveRecords(mine, table.starts).length > 0) return 'held';
  return table.complete === true &&
    isStartSource(table.startSource) &&
    publicationsKnown(published, table)
    ? 'free'
    : 'unknown';
}

/** One entry of the queue, as `usable` requires every entry to be. */
function isPublishedQueued(value: unknown): value is PublishedQueued {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const q = value as Partial<PublishedQueued>;
  return typeof q.id === 'string' && typeof q.text === 'string' && typeof q.queuedAt === 'number';
}

/**
 * Whether a parsed record can be read as one.
 *
 * `schema` is checked by equality rather than by a floor, so a build that meets
 * a *newer* writer ignores it instead of reading fields it does not know the
 * meaning of. `startedAt` is required because it is what the reader matches
 * against the twin's, and a record that cannot be matched cannot be trusted.
 */
function usable(raw: Partial<PublishedLive> | undefined, pid: number): raw is PublishedLive {
  return (
    !!raw &&
    raw.schema === 1 &&
    !!raw.session &&
    raw.session.pid === pid &&
    typeof raw.session.startedAt === 'number' &&
    (raw.stopping === undefined ||
      (!!raw.stopping &&
        typeof raw.stopping === 'object' &&
        Array.isArray(raw.stopping.members) &&
        raw.stopping.members.every(
          (member) =>
            member &&
            Number.isSafeInteger(member.pid) &&
            member.pid > 1 &&
            Number.isFinite(member.startedAt)
        ))) &&
    Array.isArray(raw.pending) &&
    Array.isArray(raw.queued) &&
    raw.queued.every(isPublishedQueued)
  );
}

function readDeliveries(
  value: unknown,
  receiver: ReceiverIdentity | undefined
): readonly IncomingDeliveryEvidence[] | undefined {
  if (!receiver || !Array.isArray(value)) return undefined;
  const receipts: IncomingDeliveryEvidence[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    const receipt = incoming.readIncomingDeliveryEvidence(raw);
    if (
      !receipt ||
      !incoming.sameReceiver(receipt.receiver, receiver) ||
      seen.has(receipt.correlation)
    )
      return undefined;
    seen.add(receipt.correlation);
    receipts.push(receipt);
  }
  return Object.freeze(receipts);
}
