/**
 * The bridge's own shapes: a conversation, what arrives from a messenger, what
 * is posted to one, and the address of a session. No messenger's wire is
 * spelled here — threads, topics and reply chains exist only inside an adapter
 * (PRD D5), and the core sees opaque refs.
 */

import type { PendingRequest } from '../live';
import type { MessageFact } from '../message_facts';
import type { BrandId, Session } from '../model';
import type { StartSource } from '../platform/processes';
import type { NewJob, Picked } from './jobs';
import type { ButtonAction } from './store';
import type { HeldBecause } from './words';

/** Eight base32 characters, minted by the store. Short because a button
 *  payload carries it (`<conversationId>.<actionId>`, at most 16 bytes). */
export type ConversationId = string;

/** One message at the messenger, as the adapter names it. Opaque to the core. */
export type MessageRef = string;

export type ReactionStatus = 'received' | 'queued' | 'processing' | 'done';

/** Whatever the adapter calls a stable identity for a person. The allowlist
 *  compares these exactly (D9). */
export type SenderId = string;

export type Sender = { id: SenderId };

/**
 * Where a post goes.
 *
 * - `home`: the sender's own direct conversation with the bot. Every
 *   conversation the bridge opens starts there (D34), and every command's
 *   reply goes there, since a command has no message to thread under.
 * - `under`: the thread under a person's own message (D24); that message is
 *   the conversation's anchor.
 * - `conversation`: everything else. A thread adapter posts under `anchor`, a
 *   reply-chain adapter replies to `latest`.
 */
export type Place =
  | { home: SenderId }
  | { under: MessageRef }
  | { conversation: { anchor: string; latest: MessageRef } };

export type ConversationPlace = Extract<Place, { conversation: unknown }>;

/**
 * What one post left behind. A notice the adapter split into several posts
 * still returns one: `message` is the post that carries the buttons, and
 * `anchor` is the first post when this one opened the conversation, else the
 * conversation's own anchor. The posts between are never refs.
 */
export type Posted = { message: MessageRef; anchor: string };

/** The commands a messenger's command surface names. Any other command text,
 *  or none, arrives as `help` with the raw text in `args`. */
export type CommandName = 'list' | 'new' | 'end' | 'help';

/**
 * One event from the messenger, after the adapter has dropped what was not
 * addressed to the bot and the bot's own echoes (D8). `id` is the adapter's
 * own unique id for the delivery, which is what dedupe keys on: a messenger
 * may deliver one event twice.
 *
 * `refs` is every ref the adapter can name for where a message sits — the
 * thread's anchor, or the message a reply answers. A top-level message carries
 * none, and neither does a command.
 */
export type Inbound =
  | {
      kind: 'message';
      incoming?: IncomingDescriptors | IncomingDenied;
      id: string;
      sender: Sender;
      text: string;
      addressed: 'direct' | 'mention';
      refs: readonly string[];
      /** This message's own ref: the anchor if it starts a job (D24). */
      ref: MessageRef;
      at: number;
    }
  | { kind: 'press'; id: string; sender: Sender; payload: string; message: MessageRef }
  | {
      kind: 'command';
      id: string;
      sender: Sender;
      name: CommandName;
      args: string;
      refs: readonly string[];
    };

/** What a notice is for. The store keys answer times on it, and an adapter may
 *  pick a fallback's lead from it; nothing in it is a messenger's word. */
export type NoticeKind =
  /** A session waits on the person (D19): an open question, or a permission
   *  with Deny and End. */
  | 'question'
  | 'permission'
  /** A turn ended: a root's finish with its last reply, or any session's
   *  failure. */
  | 'finished'
  | 'failed'
  /** A root that stopped with its turn open, ended by nobody Remote knows of. */
  | 'stopped'
  /** A root with a conversation ended any other way, not by Remote's End. */
  | 'closed'
  /** A reply reached a root that had ended; a fresh session takes it (D23). */
  | 'ended'
  /** A remote-spawned root ended once its cache went cold (U6, amended). */
  | 'lapsed'
  /** An agent sent a file into a conversation that did not exist yet. */
  | 'attached'
  /** Which folder a new job starts in (D24). */
  | 'picker'
  /** A new job started; a command's job is anchored on it. */
  | 'started'
  /** End's confirm, counting the descent it would end (D21). */
  | 'confirm'
  /** A reply that was held rather than delivered, with Stop. */
  | 'receipt'
  | 'list'
  | 'help'
  /** Anything the bridge cannot do, said as a post. */
  | 'refusal';

/** A `tone` the adapter may render — a red Deny or End — and nothing it must. */
export type Button = { label: string; payload: string; tone?: 'danger' };

/** A `Button` before it has a payload: its label, tone, and action without an id. */
export type ActionButton = Omit<Button, 'payload'> & { action: Omit<ButtonAction, 'id'> };

/**
 * A notice in our words; the adapter renders it. `body` is standard markdown
 * as the agent wrote it — the adapter converts it to its own markup, splits it
 * at its own limit and supplies the plain-text fallback a phone push reads.
 *
 * Posted once, then only ever settled: `settled` replaces the buttons, and
 * nothing replaces the text (D14).
 */
export type Notice = {
  kind: NoticeKind;
  /** Who to @mention, when this notice asks for the person (D15). */
  mention?: SenderId;
  /** Repo, session name, and the model and effort it ran at; a child's adds "spawned by <root> · step N". */
  head?: string;
  body: string;
  /** One line set apart, such as the command a permission asks to run. */
  code?: string;
  buttons?: readonly Button[];
  settled?: string;
  /** The same content as rows, for a messenger that draws a table; `body`
   *  stays what every other reader shows. */
  table?: NoticeTable;
};

/** A `Notice` whose buttons carry semantic actions instead of payloads.
 *  `buttons` stays optional so a question can offer none. Not posted or stored. */
export type ActionNotice = Omit<Notice, 'buttons'> & { buttons?: readonly ActionButton[] };

/** Literal text, or a link drawn as `text`. Words fill a gap with `—`, so an
 *  adapter never decides what a missing value looks like. */
export type TableCell = string | { link: string; text: string };

/**
 * Rows of cells under named columns. `caption` heads the table and every part
 * an adapter splits it into, so a split never loses what the rows are of.
 * `wrap` asks for a column whose text runs long to wrap rather than be cut.
 */
export type NoticeTable = {
  caption: string;
  columns: readonly { title: string; wrap?: true }[];
  rows: readonly (readonly TableCell[])[];
};

/**
 * A file an agent sends to its own conversation (M3). `caption` is the agent's
 * markdown, `head` the child's "<child> · spawned by <root>" line, which the
 * engine puts above the caption as one block.
 *
 * `bytes`, not a path: the holder read them through every check
 * (`readChecked`), at most M3's cap, and a path read again later could name
 * anything by then.
 */
export type Attachment = {
  bytes: Uint8Array;
  name: string;
  mime: string;
  caption?: string;
  head?: string;
};

/**
 * What sending an attachment came to. `unsure` is a failure after the
 * messenger may have taken the file: the reader may have it, and sending it
 * again may post it twice.
 */
export type Attached = { ok: true } | { ok: false; reason: string; unsure?: true };

/**
 * What `Messenger.files.send` throws when the file may have reached the
 * conversation although the call failed: the messenger was asked to share it
 * and its answer never arrived or could not be read.
 */
export class MaybePosted extends Error {
  override readonly name = 'MaybePosted';
}

/**
 * One message of a thread the bot joined, as the agent reads it. `author` is
 * the messenger's label for whoever wrote it — a person or another bot — and
 * `files` the names of what it carried, never the bytes.
 */
export type ThreadLine = { author: string; text: string; at: number; files?: readonly string[] };

/**
 * What reading a thread came to. `scope`: the messenger refused for want of a
 * permission a person can grant. `unreachable`: anything else — the network, a
 * rate limit, an abort. `lines` may be the newest of more: `total` counts
 * every message older than `before` the read saw, the bot's own excluded, and
 * `truncated` says earlier ones were left out of `lines`.
 */
export type ThreadRead =
  | { ok: true; lines: readonly ThreadLine[]; truncated: boolean; total: number }
  | { ok: false; reason: 'scope' | 'unreachable' };

/**
 * A session, addressed as the request files address one. No `sessionId`: it
 * moves on `/clear`, and whoever needs one looks it up on the observed board.
 */
export type SessionAddr = { pid: number; startedAt: number; windowId: string };

/**
 * One session as the notice policy sees it: the published record's shape plus
 * the label its notices carry, so a session in another window, read from
 * `live/`, and one in this window, read from its handle, are the same input.
 */
export type Watched = {
  receiverIdentity?: ReceiverIdentity;
  remoteLaunchEvidence?: RemoteLaunchEvidence;
  incomingDeliveries?: readonly IncomingDeliveryEvidence[];
  session: Session;
  messageFacts?: readonly MessageFact[];
  pending: readonly PendingRequest[];
  label: string;
  exit?: { code: number | null; signal: string | null };
  /** The workflow step the session is on, when its run says; a child's
   *  notice head names it. */
  step?: number;
};

/**
 * Where routing sent one inbound event. A button acts only on the session it
 * names (D18); typed text acts only on the root (D17).
 */
export type Routed =
  /**
   * Nothing to do: a stranger (D9), a repeat delivery, a message with no text
   * (an image with no caption; v1 reads text only), or a press whose payload
   * names no button the store holds.
   */
  | { kind: 'drop'; why: 'stranger' | 'repeat' | 'empty' | 'unknown' }
  /** Typed text for the root: `send`, or `answer` its one open question. */
  | {
      kind: 'reply';
      verb: 'send' | 'answer';
      to: SessionAddr;
      label: string;
      text: string;
      conversation: ConversationId;
      /** The question `answer` withdraws. */
      requestId?: string;
      /** Why the outbox would hold it, for the receipt when it does (D20). */
      because?: HeldBecause;
    }
  /** A reply to a root that has ended: a fresh session where it ran (D23), in
   *  the window that holds that directory (D26). */
  | {
      kind: 'fresh';
      conversation: ConversationId;
      windowId: string;
      cwd: string;
      text: string;
      brand: BrandId;
      /** The ended root's sessionId, for the pointer at its record. */
      past: string;
    }
  /** A top-level message or `new`: a new job (D24), placed under the person's
   *  message or, for a command, at their home. `joined`: an @mention in a
   *  thread Remote never started, placed under that thread's root, whose
   *  earlier messages the engine reads for the agent. */
  | { kind: 'job'; sender: SenderId; text: string; place: Place; job: NewJob; joined?: true }
  /** A folder tapped on a held prompt, judged against the windows open now. */
  | {
      kind: 'pick';
      conversation: ConversationId;
      notice: string;
      folder: string;
      picked: Picked;
    }
  | {
      kind: 'choose';
      conversation: ConversationId;
      notice: string;
      action: import('./store').ButtonAction;
    }
  | { kind: 'stop'; to: SessionAddr; conversation: ConversationId; notice: string }
  | {
      kind: 'deny';
      to: SessionAddr;
      requestId: string;
      /** Whether the request takes a reason (`canDenyReason`). */
      reason: boolean;
      conversation: ConversationId;
      notice: string;
    }
  /**
   * End asks first, counting the descent it would end. From a button, the
   * confirm goes in that button's conversation; from `end <pid>`, which has
   * none, it goes to the sender's home.
   */
  | {
      kind: 'end';
      to: SessionAddr;
      label: string;
      members: readonly SessionAddr[];
      conversation?: ConversationId;
      sender: SenderId;
    }
  /** End confirmed: exactly the members the confirm counted. */
  | {
      kind: 'end-confirmed';
      to: SessionAddr;
      members: readonly SessionAddr[];
      conversation: ConversationId;
      notice: string;
    }
  | { kind: 'cancel'; conversation: ConversationId; notice: string }
  | { kind: 'list'; sender: SenderId }
  | { kind: 'help'; sender: SenderId; text: string }
  /** A reply in a thread the store does not know: told so, starts nothing. */
  | { kind: 'orphan'; place: Place }
  /** Something the person asked that cannot be done, said where they asked. */
  | { kind: 'refuse'; reason: 'late'; place: { under: MessageRef }; notice: Notice }
  | { kind: 'refuse'; reason: 'unavailable'; place: Place; notice: Notice }
  /** A button whose request or session has gone: settled with what happened. */
  | { kind: 'stale'; conversation: ConversationId; notice: string; word: string };

/** Nonsecret provider provenance; source remains opaque outside its adapter. */
export type IncomingFile = Readonly<{
  id: string;
  source: string;
  cacheKey: string;
  name?: string;
  mime?: string;
  size?: number;
}>;

export type IncomingDescriptors = Readonly<{
  version: 1;
  installId: string;
  files: readonly IncomingFile[];
  omitted: number;
}>;

/** A malformed original admission cannot be upgraded by a replay copy. */
export type IncomingDenied = Readonly<{ version: 1; denied: 'admission-denied' }>;

export type IncomingAdmission = Readonly<{
  version: 1;
  id: string;
  ref: MessageRef;
  correlation: string;
  eventAt: number;
  admittedAt: number;
  senderId: SenderId;
  messengerId: string;
  installId: string;
  files: readonly IncomingFile[];
  omitted: number;
  digest: string;
}>;

/** Exact OS evidence is separate from SessionAddr's tolerant routing stamp. */
export type HostIdentity = Readonly<{
  version: 1;
  windowId: string;
  pid: number;
  osStartedAt: number;
  startSource: StartSource;
  incarnation: string;
}>;

export type ReceiverIdentity = Readonly<{
  version: 1;
  host: HostIdentity;
  pid: number;
  osStartedAt: number;
  startSource: StartSource;
  incarnation: string;
  brand: BrandId;
  cwd: string;
}>;

export type IncomingHolder = Readonly<{ host: HostIdentity; generation: number }>;

export type LaunchAttempt = Readonly<{
  version: 1;
  attemptId: string;
  conversation: ConversationId;
  messageId: string;
  correlation: string;
  admissionDigest: string;
  host: HostIdentity;
  cwd: string;
  target: Readonly<import('../model').LaunchTarget>;
  selection: import('../model_listing').SelectionSource;
  holder: IncomingHolder;
  createdAt: number;
}>;

/** Prepared is a candidate; only accepted prompt evidence can activate access. */
export type RemoteLaunchEvidence = Readonly<{
  version: 1;
  attempt: LaunchAttempt;
  receiver: ReceiverIdentity;
  marker: string;
  stage: 'prepared' | 'accepted';
  dismissed?: true;
}>;

export type IncomingDelivery = Readonly<{
  version: 1;
  receiver: ReceiverIdentity;
  correlation: string;
  admissionDigest: string;
}>;

export type IncomingDeliveryEvidence = IncomingDelivery &
  Readonly<{
    outcome: 'send' | 'queued' | 'person-answer';
    acceptedAt: number;
    dismissed?: true;
  }>;

export type IncomingAccess = Readonly<{ version: 1; host: HostIdentity; localRoot: string }>;

export type IncomingEvidenceQuery =
  | Readonly<{ kind: 'receiver'; receiver: ReceiverIdentity }>
  | Readonly<{ kind: 'attempt'; attempt: LaunchAttempt }>
  | Readonly<{ kind: 'delivery'; delivery: IncomingDelivery }>;

export type IncomingEvidence = Readonly<{
  version: 1;
  challenge: string;
  host: HostIdentity;
  query: IncomingEvidenceQuery;
  receiver: ReceiverIdentity;
  currentSessionId: string;
  launch?: RemoteLaunchEvidence;
  delivery?: IncomingDeliveryEvidence;
}>;

export type IncomingRefusal =
  | 'unknown-message'
  | 'unknown-file'
  | 'closed'
  | 'wrong-receiver'
  | 'admission-denied'
  | 'wrong-install'
  | 'unsupported-version'
  | 'unsupported-capability'
  | 'remote-off'
  | 'evidence-unavailable'
  | 'storage-unavailable'
  | 'capacity'
  | 'too-large'
  | 'timeout'
  | 'invalid-path'
  | `provider-${string}`;

export type FetchFileIdentity = Readonly<{
  holder: IncomingHolder;
  receiver: ReceiverIdentity;
  currentSessionId: string;
  conversation: ConversationId;
  correlation: string;
  fileId: string;
}>;

export type FetchFileReply = Readonly<{
  version: 1;
  requestId: string;
  identity: FetchFileIdentity;
}> &
  (
    | Readonly<{
        kind: 'fetched';
        cacheKey: string;
        name?: string;
        mime?: string;
        bytes: number;
        path: string;
        localRoot: string;
        expiresAt: number;
      }>
    | Readonly<{ kind: 'pending'; retryable: true }>
    | Readonly<{ kind: 'refused'; code: IncomingRefusal }>
  );
