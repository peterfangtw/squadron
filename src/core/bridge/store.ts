/**
 * The conversation store: which conversation at the messenger belongs to which
 * session, written down so a reload finds it again. One file per conversation
 * under `remote/conversations/`, written only by the window that holds Remote
 * (D37), and button payloads that are short keys into it.
 */

import * as platform from '../platform';
import { isPickerDraft, type PickerDraft, type Choice } from './picker';
import { randomBytes, randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as incoming from '../incoming';
import * as holder from '../remote/holder';
import { DEDUPE_MS } from './allow';
import * as messageFacts from '../message_facts';
import { isBrand } from '../brands';
import { readJson, writeAtomicJson } from '../files';
import { CONVERSATIONS_DIR, HEARD_FILE } from '../paths';
import { sameSessionStart } from '../model';
import type { BrandId } from '../model';
import type {
  Button,
  ConversationId,
  MessageRef,
  Inbound,
  ReactionStatus,
  Notice,
  NoticeKind,
  SenderId,
  SessionAddr,
  ThreadRead,
  Watched,
  IncomingAdmission,
  IncomingDenied,
  IncomingRefusal,
  LaunchAttempt,
  ReceiverIdentity
} from './model';

/** What a button does once pressed. The verb and its target stay here, and the
 *  payload carries only `<conversationId>.<actionId>`. */
export type ButtonAction = {
  id: string;
  verb: 'deny' | 'end' | 'end-confirm' | 'cancel' | 'stop' | 'pick' | 'choose';
  /** The folder a `pick` starts the held prompt in. */
  folder?: string;
  generation?: number;
  choice?: Choice;
};

export type NoticeRecord = {
  id: string;
  kind: NoticeKind;
  /** The post that carries the buttons. */
  message: MessageRef;
  /** Absent on a notice no session is behind: a folder picker, a list, help. */
  target?: SessionAddr;
  requestId?: string;
  /** On a finished, failed or stopped notice, the edge it was posted for, so
   *  a pass a rebuild cut short does not post it again from the next engine. */
  answered?: Answered;
  /** With `answeredAt`, the PRD's first-goal metric: notice to answer. */
  postedAt: number;
  answeredAt?: number;
  settled?: string;
  /** On an End confirm, the descent it counted (D21), and exactly what
   *  `end-confirm` ends. */
  members?: SessionAddr[];
  actions: ButtonAction[];
  /** The notice as posted, kept when it can be settled: an adapter settles by
   *  rendering it again with the buttons replaced, after a reload too. */
  notice?: Notice;
};

/** The count of ended turns once the turn a notice answers closed, or the
 *  exit a stop answers. Either is its session's once: the count only rises. */
export type Answered = { turnsEnded: number } | { exit: NonNullable<Watched['exit']> };

/** The session a conversation follows. Matched by pid and start time, which
 *  neither moves on `/clear` nor repeats across a resume, as a sessionId does. */
export type ConversationRoot = {
  pid: number;
  startedAt: number;
  sessionId: string;
  brand: BrandId;
  cwd: string;
  label: string;
  /** The engine started this root — a new job or a D23 fresh session — so
   *  it ends once its cache goes cold (`lifetime.ts`). Never set on a
   *  running session adopted for its first notice. */
  remoteSpawned?: true;
};

export type MessageAccess = Readonly<{
  revision: number;
  state: 'held' | 'starting' | 'intended' | 'active' | 'closed';
  attempt?: LaunchAttempt;
  execution?: 'unresolved' | 'launched' | 'not-started' | 'retired-unknown';
  retiredAttempts?: readonly { attemptId: string; execution: 'not-started' }[];
  receiver?: ReceiverIdentity;
  reason?: IncomingRefusal;
  closedAt?: number;
  ownerEndedAt?: number;
}>;

export type MessageRecord = {
  id: string;
  correlation: string;
  ref: MessageRef;
  at: number;
  desired: ReactionStatus;
  applied?: ReactionStatus;
  retryAt?: number;
  failures?: number;
  uncertainEffect?: true;
  reactionRetired?: true;
  delivery: 'admitted' | 'held' | 'attempted' | 'settled';
  event?: Extract<Inbound, { kind: 'message' }>;
  target?: SessionAddr;
  terminal?: true;
  incoming?: IncomingAdmission | IncomingDenied;
  access?: MessageAccess;
};

export type ConversationRecord = {
  schema: 1 | 2 | 3;
  revision?: number;
  id: ConversationId;
  /** The `MessengerEntry.id` it lives at. */
  messenger: string;
  anchor: string;
  /** Every ref a reply may name: the anchor, and the message of each post. */
  refs: string[];
  /** Where a reply-chain adapter answers next. */
  latest: MessageRef;
  /** The sender a notice here @mentions. */
  owner: SenderId;
  /** `held` is a new job waiting for its folder (D24, D39): no root yet. */
  state: 'held' | 'live';
  root?: ConversationRoot;
  rootCorrelation?: string;
  /** Earlier roots' sessionIds: D23's pointer at the ended session's record,
   *  and D16's fallback for a child whose root has gone. */
  past: string[];
  held?: {
    prompt: string;
    folders: string[];
    expiresAt: number;
    picker?: PickerDraft;
    correlation?: string;
    /** Why a joined thread was not read, for the started notice to say. */
    threadUnread?: Extract<ThreadRead, { ok: false }>['reason'];
  };
  messages?: MessageRecord[];
  /** Started by an @mention in a thread Remote did not start: each later
   *  mention re-reads that thread for the agent. */
  joined?: true;
  /** How many of that thread's messages the session has been told of: all
   *  the last read saw, kept in the file or not, and the mention it was read
   *  for. A re-read past it says how many are new. */
  threadRead?: number;
  /** The newest `NOTICES_KEPT`. */
  notices: NoticeRecord[];
  createdAt: number;
  updatedAt: number;
};

export const NOTICES_KEPT = 50;

/** The smallest payload any messenger in `messenger_capabilities.md` takes is
 *  64 bytes; this leaves it room to spare. */
export const PAYLOAD_MAX = 16;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Eight base32 characters, 40 random bits: short enough for a payload. */
export function conversationId(): ConversationId {
  const bytes = randomBytes(5);
  let bits = 0;
  let value = 0;
  let id = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id;
}

/**
 * Every conversation on this machine. A file that is torn, foreign, malformed
 * or from a later schema is skipped, never thrown over.
 */
export async function readConversations(): Promise<ConversationRecord[]> {
  return (await readConversationInventory()).records;
}

/** Consistency metadata only; a stored descriptor cannot authorize a fetch. */
export async function readStoredConversation(id: string): Promise<ConversationRecord | undefined> {
  if (!incoming.incomingString(id) || path.basename(id) !== id || id === '.' || id === '..')
    return undefined;
  const record = readConversation(await readJson(path.join(CONVERSATIONS_DIR, `${id}.json`)));
  return record?.id === id ? record : undefined;
}

export async function readConversationInventory(): Promise<{
  records: ConversationRecord[];
  complete: boolean;
}> {
  let names: string[];
  try {
    names = await fs.readdir(CONVERSATIONS_DIR);
  } catch (error) {
    return { records: [], complete: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  let complete = true;
  const read = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const raw: unknown = JSON.parse(
            await fs.readFile(path.join(CONVERSATIONS_DIR, name), 'utf8')
          );
          const record = readConversation(raw);
          if (!record) complete = false;
          return record;
        } catch {
          complete = false;
          return undefined;
        }
      })
  );
  const records = read.filter((record): record is ConversationRecord => record !== undefined);
  denyIncomingCollisions(records);
  return { records, complete };
}

function readConversation(raw: unknown): ConversationRecord | undefined {
  if (!isConversation(raw)) return undefined;
  if (raw.rootCorrelation !== undefined && !messageFacts.isCorrelation(raw.rootCorrelation))
    delete raw.rootCorrelation;
  if (raw.held?.correlation !== undefined && !messageFacts.isCorrelation(raw.held.correlation))
    delete raw.held.correlation;
  if (raw.messages !== undefined)
    raw.messages = Array.isArray(raw.messages) ? raw.messages.filter(isMessage) : [];
  const badRevision = raw.schema === 3 && !isRevision(raw.revision);
  if (badRevision) raw.revision = 0;
  for (const message of raw.messages ?? []) {
    const admission = incoming.readIncomingAdmission(message.incoming);
    if (admission !== undefined) {
      message.incoming = admission;
      if (
        raw.schema !== 3 ||
        badRevision ||
        (!('denied' in admission) &&
          (admission.id !== message.id ||
            admission.ref !== message.ref ||
            admission.correlation !== message.correlation ||
            admission.messengerId !== raw.messenger))
      )
        message.incoming = deniedAdmission();
    }
    if (message.incoming) {
      const access = readMessageAccess(message.access, raw, message);
      message.access =
        access ??
        deniedAccess(
          message.access?.revision,
          message.at,
          'denied' in message.incoming ? 'admission-denied' : 'evidence-unavailable'
        );
    } else delete message.access;
    // Replay input is not a second copy of admission provenance.
    if (message.event) delete message.event.incoming;
  }
  denyIncomingCollisions([raw]);
  return raw;
}

export function denyIncomingCollisions(
  records: readonly ConversationRecord[]
): ConversationRecord[] {
  const index = new IncomingCollisionIndex();
  const changed = new Set<ConversationRecord>();
  for (const record of records) {
    for (const message of record.messages ?? []) {
      for (const row of index.remember(record, message)) {
        const prior = row.message.access;
        denyMessageIncoming(row.message);
        if (prior !== row.message.access) changed.add(row.record);
      }
    }
  }
  return [...changed];
}

type IndexedMessage = { record: ConversationRecord; message: MessageRecord };

export class IncomingCollisionIndex {
  private readonly indexes = [
    new Map<string, Set<IndexedMessage>>(),
    new Map<string, Set<IndexedMessage>>(),
    new Map<string, Set<IndexedMessage>>()
  ];
  private readonly rows = new Map<MessageRecord, IndexedMessage>();

  remember(record: ConversationRecord, message: MessageRecord): Set<IndexedMessage> {
    const row = { record, message };
    this.rows.set(message, row);
    const collisions = new Set<IndexedMessage>();
    this.keys(record, message).forEach((key, at) => {
      const index = this.indexes[at];
      if (!index) return;
      const owners = index.get(key) ?? new Set<IndexedMessage>();
      owners.add(row);
      index.set(key, owners);
      if (owners.size > 1) for (const owner of owners) collisions.add(owner);
    });
    return collisions;
  }

  forget(message: MessageRecord): void {
    const row = this.rows.get(message);
    if (!row) return;
    this.keys(row.record, message).forEach((key, at) => {
      const index = this.indexes[at];
      const owners = index?.get(key);
      owners?.delete(row);
      if (owners?.size === 0) index?.delete(key);
    });
    this.rows.delete(message);
  }

  private keys(record: ConversationRecord, message: MessageRecord): string[] {
    return [
      JSON.stringify([record.messenger, message.id]),
      JSON.stringify([record.messenger, message.ref]),
      message.correlation
    ];
  }
}

export function denyMessageIncoming(message: MessageRecord): void {
  if (!message.incoming) message.incoming = deniedAdmission();
  if (message.access?.state === 'closed') return;
  message.access = Object.freeze({
    ...message.access,
    ...deniedAccess(
      Math.min((message.access?.revision ?? 0) + 1, Number.MAX_SAFE_INTEGER),
      message.at
    )
  });
}

function deniedAdmission(): IncomingDenied {
  return Object.freeze({ version: 1, denied: 'admission-denied' });
}

function deniedAccess(
  revision: unknown,
  at: number,
  reason: IncomingRefusal = 'admission-denied'
): MessageAccess {
  return Object.freeze({
    revision: isRevision(revision) ? revision : 0,
    state: 'closed',
    reason,
    closedAt: at
  });
}

function readRetiredAttempts(value: unknown): MessageAccess['retiredAttempts'] {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const retired: { attemptId: string; execution: 'not-started' }[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object' || !incoming.incomingBounded(entry)) return undefined;
    const raw = entry as { attemptId?: unknown; execution?: unknown };
    if (
      !incoming.incomingUuid(raw.attemptId) ||
      raw.execution !== 'not-started' ||
      seen.has(raw.attemptId)
    )
      return undefined;
    seen.add(raw.attemptId);
    retired.push(Object.freeze({ attemptId: raw.attemptId, execution: 'not-started' }));
  }
  return Object.freeze(retired);
}

function readMessageAccess(
  value: unknown,
  record: ConversationRecord,
  message: MessageRecord
): MessageAccess | undefined {
  if (!isObject(value)) return undefined;
  const raw = value as Partial<MessageAccess>;
  const { retiredAttempts: _retired, ...bounded } = raw;
  if (!incoming.incomingBounded(bounded)) return undefined;
  if (
    !isRevision(raw.revision) ||
    !['held', 'starting', 'intended', 'active', 'closed'].includes(String(raw.state))
  )
    return undefined;
  const admission = message.incoming;
  if (!admission) return undefined;
  if ('denied' in admission) {
    return raw.state === 'closed' &&
      incoming.incomingRefusal(raw.reason) &&
      isTime(raw.closedAt) &&
      raw.attempt === undefined &&
      raw.receiver === undefined &&
      raw.execution === undefined
      ? Object.freeze({
          revision: raw.revision,
          state: 'closed',
          reason: raw.reason,
          closedAt: raw.closedAt
        })
      : undefined;
  }
  const retired = readRetiredAttempts(raw.retiredAttempts);
  if (raw.retiredAttempts !== undefined && retired === undefined) return undefined;
  const attempt = incoming.readLaunchAttempt(raw.attempt);
  if (attempt && retired?.some((entry) => entry.attemptId === attempt.attemptId)) return undefined;
  const receiver = incoming.readReceiverIdentity(raw.receiver);
  if ((raw.attempt !== undefined && !attempt) || (raw.receiver !== undefined && !receiver))
    return undefined;
  if (
    attempt &&
    (attempt.conversation !== record.id ||
      attempt.messageId !== message.id ||
      attempt.correlation !== message.correlation ||
      attempt.admissionDigest !== admission.digest)
  )
    return undefined;
  if (
    raw.execution !== undefined &&
    !['unresolved', 'launched', 'not-started', 'retired-unknown'].includes(raw.execution)
  )
    return undefined;
  if ((attempt === undefined) !== (raw.execution === undefined)) return undefined;
  if (
    attempt &&
    receiver &&
    (!incoming.sameHost(attempt.host, receiver.host) ||
      attempt.cwd !== receiver.cwd ||
      (attempt.target.brand !== undefined && attempt.target.brand !== receiver.brand))
  )
    return undefined;
  if (
    (raw.state === 'held' && (receiver || attempt)) ||
    (raw.state === 'starting' && (!attempt || receiver)) ||
    ((raw.state === 'intended' || raw.state === 'active') && !receiver)
  )
    return undefined;
  if (raw.state === 'closed') {
    if (!incoming.incomingRefusal(raw.reason) || !isTime(raw.closedAt)) return undefined;
    if (raw.ownerEndedAt !== undefined && !isTime(raw.ownerEndedAt)) return undefined;
  } else if (
    raw.reason !== undefined ||
    raw.closedAt !== undefined ||
    raw.ownerEndedAt !== undefined
  )
    return undefined;
  return Object.freeze({
    revision: raw.revision,
    state: raw.state as MessageAccess['state'],
    ...(attempt && raw.execution ? { attempt, execution: raw.execution } : {}),
    ...(retired ? { retiredAttempts: retired } : {}),
    ...(receiver ? { receiver } : {}),
    ...(raw.state === 'closed' && raw.reason !== undefined && raw.closedAt !== undefined
      ? {
          reason: raw.reason,
          closedAt: raw.closedAt,
          ...(raw.ownerEndedAt !== undefined ? { ownerEndedAt: raw.ownerEndedAt } : {})
        }
      : {})
  });
}

/** Holder lifetime fences cross-process writes; the local queue compares committed revisions. */
export function writeConversation(
  record: ConversationRecord,
  now = Date.now(),
  owner?: holder.Holder
): Promise<boolean> {
  const kept = structuredClone({ ...record, notices: record.notices.slice(-NOTICES_KEPT) });
  if (kept.messages?.some((message) => message.incoming !== undefined)) kept.schema = 3;
  return inOrder(async () => {
    if (owner && !(await holder.ownsHolder(owner))) return false;
    const file = path.join(CONVERSATIONS_DIR, `${kept.id}.json`);
    let prior: ConversationRecord | undefined;
    try {
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      prior = readConversation(raw);
      if (!prior) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (kept.messages)
      kept.messages = retainedMessages(
        kept.messages,
        now,
        new Set(
          prior?.messages
            ?.filter((message) => incomingNeedsRetention(message, now))
            .map((message) => message.id)
        )
      );
    if (prior?.schema === 3 && kept.schema !== 3) return false;
    if (kept.schema !== 3) return writeAtomicJson(file, kept, 'state');
    if (!isRevision(kept.revision) || kept.revision <= (prior?.revision ?? 0)) return false;
    // Compare inside the existing ordered writer, after all earlier saves have landed.
    const decoded = readConversation(kept);
    if (!decoded || !preservesIncoming(prior, decoded, now)) return false;
    return writeDurableConversation(file, decoded, owner);
  });
}

function preservesIncoming(
  prior: ConversationRecord | undefined,
  next: ConversationRecord,
  now: number
): boolean {
  const oldRows = new Map((prior?.messages ?? []).map((message) => [message.id, message]));
  const oldRefs = new Map((prior?.messages ?? []).map((message) => [message.ref, message]));
  const oldCorrelations = new Map(
    (prior?.messages ?? []).map((message) => [message.correlation, message])
  );
  const nextIds = new Set(next.messages?.map((message) => message.id));
  for (const message of next.messages ?? []) {
    const old = oldRows.get(message.id);
    if (!old) {
      const colliding = oldRefs.get(message.ref) ?? oldCorrelations.get(message.correlation);
      if (colliding && !nextIds.has(colliding.id)) return false;
      continue;
    }
    if (
      JSON.stringify(old.incoming) !== JSON.stringify(message.incoming) &&
      !(old.incoming === undefined && message.incoming && 'denied' in message.incoming)
    )
      return false;
    if (!old.access) continue;
    const retired = new Set(message.access?.retiredAttempts?.map((entry) => entry.attemptId));
    if (
      !message.access ||
      message.access.revision < old.access.revision ||
      (JSON.stringify(old.access) !== JSON.stringify(message.access) &&
        message.access.revision <= old.access.revision) ||
      (old.access.state === 'closed' && message.access.state !== 'closed') ||
      (old.access.ownerEndedAt !== undefined &&
        old.access.ownerEndedAt !== message.access.ownerEndedAt) ||
      (old.access.retiredAttempts?.some((entry) => !retired.has(entry.attemptId)) ?? false) ||
      (old.access.attempt &&
        message.access.attempt &&
        !incoming.sameLaunchAttempt(old.access.attempt, message.access.attempt) &&
        (old.access.execution !== 'not-started' ||
          !message.access.retiredAttempts?.some(
            (entry) => entry.attemptId === old.access?.attempt?.attemptId
          ))) ||
      (old.access.receiver &&
        (!message.access.receiver ||
          !incoming.sameReceiver(old.access.receiver, message.access.receiver)))
    )
      return false;
  }
  for (const old of prior?.messages ?? []) {
    if (incomingNeedsRetention(old, now) && !nextIds.has(old.id)) return false;
  }
  return true;
}

async function writeDurableConversation(
  file: string,
  record: ConversationRecord,
  owner?: holder.Holder
): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const output = await fs.open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(JSON.stringify(record));
      await output.sync();
    } finally {
      await output.close();
    }
    if (owner && !(await holder.ownsHolder(owner))) {
      await fs.rm(temporary, { force: true });
      return false;
    }
    await platform.files.replace(temporary, file, { kind: 'owned' });
    await platform.files.syncDirectory(path.dirname(file));
    return true;
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export const MESSAGES_KEPT = 256;

export function incomingNeedsRetention(message: MessageRecord, now = Date.now()): boolean {
  const access = message.access;
  return (
    !!message.incoming &&
    !('denied' in message.incoming) &&
    (!access ||
      access.state !== 'closed' ||
      access.execution === 'unresolved' ||
      ((!!access.receiver || (!!access.attempt && access.execution !== 'not-started')) &&
        access.ownerEndedAt === undefined) ||
      access.reason === 'evidence-unavailable' ||
      now - (access.ownerEndedAt ?? access.closedAt ?? now) <= DEDUPE_MS)
  );
}

/** Only the holder calls this, in the same Bridge mutation queue that owns the loaded copy. */
export function removeConversation(
  record: ConversationRecord,
  owner: holder.Holder
): Promise<boolean> {
  return inOrder(async () => {
    if (!(await holder.ownsHolder(owner))) return false;
    const file = path.join(CONVERSATIONS_DIR, `${record.id}.json`);
    const current = await readJson<ConversationRecord>(file);
    if (!current || current.revision !== record.revision || current.schema !== record.schema)
      return false;
    await fs.rm(file, { force: true });
    return true;
  });
}

export function pruneConversationTemps(owner: holder.Holder, now: number): Promise<void> {
  return inOrder(async () => {
    if (!(await holder.ownsHolder(owner))) return;
    for (const name of await fs.readdir(CONVERSATIONS_DIR).catch(() => [])) {
      if (!/^[a-z0-9]+\.json\.(?:[0-9]+\.[0-9]+|[0-9a-f-]{36})\.tmp$/.test(name)) continue;
      const file = path.join(CONVERSATIONS_DIR, name);
      const stat = await fs.lstat(file).catch(() => undefined);
      if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > 30 * 24 * 60 * 60_000)
        await fs.unlink(file).catch(() => {});
    }
  });
}

export function retainedMessages(
  messages: readonly MessageRecord[],
  now = Date.now(),
  requiredIncoming?: ReadonlySet<string>
): MessageRecord[] {
  const settled = new Set(
    messages
      .filter(
        (m) => m.terminal && (m.applied === m.desired || m.reactionRetired) && !m.uncertainEffect
      )
      .slice(-MESSAGES_KEPT)
  );
  return messages.flatMap((m) => {
    const reactionNeeded =
      !m.terminal ||
      (!m.reactionRetired && m.applied !== m.desired) ||
      m.uncertainEffect ||
      settled.has(m);
    if (reactionNeeded) return [m];
    return incomingNeedsRetention(m, now) || requiredIncoming?.has(m.id)
      ? [{ ...m, reactionRetired: true as const }]
      : [];
  });
}

/** What a catch-up reads after, and the delivery ids already routed, each
 *  with when it was first seen, so reading a window again acts on nothing
 *  twice. */
export type Heard = { at: number; seen: readonly (readonly [string, number])[] };

/** The kept watermark, or nothing when none is kept or the file cannot be
 *  read. An id that does not read as one is dropped. */
export async function readHeard(): Promise<Heard | undefined> {
  const raw = await readJson<unknown>(HEARD_FILE);
  if (!raw || typeof raw !== 'object') return undefined;
  const { at, seen } = raw as { at?: unknown; seen?: unknown };
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const ids = Array.isArray(seen)
    ? seen.flatMap((entry: unknown) =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1])
          ? [[entry[0], entry[1]] as const]
          : []
      )
    : [];
  return { at, seen: ids };
}

/** Writes the watermark, in order with this store's other writes. */
export function writeHeard(heard: Heard): Promise<boolean> {
  return inOrder(() => writeAtomicJson(HEARD_FILE, heard, 'state'));
}

let chain: Promise<unknown> = Promise.resolve();

function inOrder<T>(step: () => Promise<T>): Promise<T> {
  const next = chain.then(step, step);
  chain = next.catch(() => {});
  return next;
}

/** The conversation a message sits in: the one whose refs hold any of its
 *  refs. A top-level message names none, and so resolves to nothing. */
export function resolveRefs(
  records: readonly ConversationRecord[],
  refs: readonly string[]
): ConversationRecord | undefined {
  if (refs.length === 0) return undefined;
  return records.find((record) => refs.some((ref) => record.refs.includes(ref)));
}

export function conversationOfRoot(
  records: readonly ConversationRecord[],
  root: Pick<SessionAddr, 'pid' | 'startedAt'>
): ConversationRecord | undefined {
  return records.find(
    (record) =>
      record.root?.pid === root.pid && sameSessionStart(record.root.startedAt, root.startedAt)
  );
}

/** `<conversationId>.<actionId>`, or nothing when that is not printable ASCII
 *  within `PAYLOAD_MAX` bytes. */
export function encodePayload(conversation: ConversationId, action: string): string | undefined {
  const payload = `${conversation}.${action}`;
  return decodePayload(payload) ? payload : undefined;
}

export function decodePayload(
  payload: string
): { conversation: ConversationId; action: string } | undefined {
  if (payload.length > PAYLOAD_MAX || !/^[!-~]+$/.test(payload)) return undefined;
  const parts = payload.split('.');
  if (parts.length !== 2) return undefined;
  const [conversation = '', action = ''] = parts;
  if (conversation === '' || action === '') return undefined;
  return { conversation, action };
}

function isConversation(value: unknown): value is ConversationRecord {
  if (!isObject(value)) return false;
  const record = value as Partial<ConversationRecord>;
  return (
    (record.schema === 1 || record.schema === 2 || record.schema === 3) &&
    (record.held === undefined || isHeld(record.held)) &&
    (record.schema !== 2 || record.held === undefined || record.held.picker !== undefined) &&
    (record.schema !== 1 || record.held?.picker === undefined) &&
    typeof record.id === 'string' &&
    typeof record.messenger === 'string' &&
    typeof record.anchor === 'string' &&
    isStrings(record.refs) &&
    typeof record.latest === 'string' &&
    typeof record.owner === 'string' &&
    (record.state === 'held' || record.state === 'live') &&
    (record.root === undefined || isRoot(record.root)) &&
    isStrings(record.past) &&
    (record.joined === undefined || record.joined === true) &&
    (record.threadRead === undefined ||
      (Number.isSafeInteger(record.threadRead) && record.threadRead >= 0)) &&
    Array.isArray(record.notices) &&
    record.notices.every(isNotice) &&
    isTime(record.createdAt) &&
    isTime(record.updatedAt)
  );
}

const STATUSES: readonly ReactionStatus[] = ['received', 'queued', 'processing', 'done'];

function isMessage(value: unknown): value is MessageRecord {
  if (!isObject(value)) return false;
  const m = value as Partial<MessageRecord>;
  return (
    typeof m.id === 'string' &&
    messageFacts.isCorrelation(m.correlation) &&
    typeof m.ref === 'string' &&
    isTime(m.at) &&
    STATUSES.includes(m.desired as ReactionStatus) &&
    (m.applied === undefined || STATUSES.includes(m.applied)) &&
    (m.retryAt === undefined || isTime(m.retryAt)) &&
    (m.failures === undefined || (Number.isSafeInteger(m.failures) && m.failures >= 0)) &&
    (m.uncertainEffect === undefined || m.uncertainEffect === true) &&
    (m.reactionRetired === undefined || m.reactionRetired === true) &&
    ['admitted', 'held', 'attempted', 'settled'].includes(String(m.delivery)) &&
    (m.target === undefined || isAddr(m.target)) &&
    (m.terminal === undefined || m.terminal === true) &&
    (m.event === undefined || isMessageEvent(m.event))
  );
}

function isMessageEvent(value: unknown): boolean {
  if (!isObject(value)) return false;
  const e = value as Partial<Extract<Inbound, { kind: 'message' }>>;
  return (
    e.kind === 'message' &&
    typeof e.id === 'string' &&
    typeof e.ref === 'string' &&
    typeof e.text === 'string' &&
    isTime(e.at) &&
    isStrings(e.refs) &&
    isObject(e.sender) &&
    typeof e.sender.id === 'string' &&
    (e.addressed === 'direct' || e.addressed === 'mention')
  );
}

function isRoot(value: unknown): value is ConversationRoot {
  if (!isObject(value)) return false;
  const root = value as Partial<ConversationRoot>;
  return (
    isPid(root.pid) &&
    isTime(root.startedAt) &&
    typeof root.sessionId === 'string' &&
    isBrand(root.brand) &&
    typeof root.cwd === 'string' &&
    typeof root.label === 'string' &&
    (root.remoteSpawned === undefined || root.remoteSpawned === true)
  );
}

function isHeld(value: unknown): value is NonNullable<ConversationRecord['held']> {
  if (!isObject(value)) return false;
  const held = value as Partial<NonNullable<ConversationRecord['held']>>;
  return (
    typeof held.prompt === 'string' &&
    isStrings(held.folders) &&
    isTime(held.expiresAt) &&
    (held.picker === undefined || isPickerDraft(held.picker)) &&
    (held.threadUnread === undefined ||
      held.threadUnread === 'scope' ||
      held.threadUnread === 'unreachable')
  );
}

const NOTICE_KINDS: readonly NoticeKind[] = [
  'question',
  'permission',
  'finished',
  'failed',
  'stopped',
  'closed',
  'ended',
  'lapsed',
  'attached',
  'picker',
  'started',
  'confirm',
  'receipt',
  'list',
  'help',
  'refusal'
];

const VERBS: readonly ButtonAction['verb'][] = [
  'deny',
  'end',
  'end-confirm',
  'cancel',
  'stop',
  'pick',
  'choose'
];

function isNotice(value: unknown): value is NoticeRecord {
  if (!isObject(value)) return false;
  const notice = value as Partial<NoticeRecord>;
  return (
    typeof notice.id === 'string' &&
    NOTICE_KINDS.includes(notice.kind as NoticeKind) &&
    typeof notice.message === 'string' &&
    (notice.target === undefined || isAddr(notice.target)) &&
    (notice.requestId === undefined || typeof notice.requestId === 'string') &&
    (notice.answered === undefined || isAnswered(notice.answered)) &&
    isTime(notice.postedAt) &&
    (notice.answeredAt === undefined || isTime(notice.answeredAt)) &&
    (notice.settled === undefined || typeof notice.settled === 'string') &&
    (notice.members === undefined ||
      (Array.isArray(notice.members) && notice.members.every(isAddr))) &&
    Array.isArray(notice.actions) &&
    notice.actions.every(isAction) &&
    (notice.notice === undefined || isPosted(notice.notice))
  );
}

function isPosted(value: unknown): value is Notice {
  if (!isObject(value)) return false;
  const notice = value as Partial<Notice>;
  return (
    NOTICE_KINDS.includes(notice.kind as NoticeKind) &&
    typeof notice.body === 'string' &&
    isOptionalString(notice.mention) &&
    isOptionalString(notice.head) &&
    isOptionalString(notice.code) &&
    isOptionalString(notice.settled) &&
    (notice.buttons === undefined ||
      (Array.isArray(notice.buttons) && notice.buttons.every(isButton)))
  );
}

function isButton(value: unknown): value is Button {
  if (!isObject(value)) return false;
  const button = value as Partial<Button>;
  return (
    typeof button.label === 'string' &&
    typeof button.payload === 'string' &&
    (button.tone === undefined || button.tone === 'danger')
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isAction(value: unknown): value is ButtonAction {
  if (!isObject(value)) return false;
  const action = value as Partial<ButtonAction>;
  return (
    typeof action.id === 'string' &&
    VERBS.includes(action.verb as ButtonAction['verb']) &&
    (action.folder === undefined || typeof action.folder === 'string') &&
    (action.generation === undefined ||
      (Number.isSafeInteger(action.generation) && action.generation >= 0)) &&
    (action.verb !== 'choose' || (action.generation !== undefined && isChoice(action.choice)))
  );
}

function isAddr(value: unknown): value is SessionAddr {
  if (!isObject(value)) return false;
  const addr = value as Partial<SessionAddr>;
  return isPid(addr.pid) && isTime(addr.startedAt) && typeof addr.windowId === 'string';
}

function isAnswered(value: unknown): value is Answered {
  if (!isObject(value)) return false;
  if ('turnsEnded' in value) return Number.isInteger(value.turnsEnded);
  if (!('exit' in value) || !isObject(value.exit)) return false;
  const exit = value.exit as Partial<NonNullable<Watched['exit']>>;
  return (
    (exit.code === null || typeof exit.code === 'number') &&
    (exit.signal === null || typeof exit.signal === 'string')
  );
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isChoice(value: unknown): value is Choice {
  if (!isObject(value)) return false;
  const choice = value as Partial<Choice>;
  return (
    ['folder', 'model', 'effort', 'default', 'older', 'back', 'page', 'retry', 'cancel'].includes(
      String(choice.command)
    ) &&
    (choice.value === undefined || typeof choice.value === 'string') &&
    (choice.index === undefined || (Number.isSafeInteger(choice.index) && choice.index >= 0))
  );
}
