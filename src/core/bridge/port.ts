/**
 * The messenger seam: the port an adapter fills, and the registry of adapters.
 *
 * A messenger's wire format lives in its own package beside this one, and the
 * registry below is the whole of the core's knowledge that it exists — one
 * import and one entry, as `core/adapter.ts` registers the brands. Nothing else
 * in `core/bridge/` names a messenger, its thread key or its markup.
 *
 * What a messenger can do is stated as capabilities: required members every
 * messenger in `docs/reference/messenger_capabilities.md` can meet, and
 * optional objects whose presence is the support. A caller without the object
 * cannot compile the call, and no core code branches on `Messenger.id`.
 */

import type {
  Attachment,
  ConversationPlace,
  Inbound,
  IncomingFile,
  MessageRef,
  Notice,
  Place,
  Posted,
  ReactionStatus,
  SenderId,
  ThreadRead
} from './model';
import * as slack from '../slack/messenger';
import * as fake from './fake';
import { PAYLOAD_MAX } from './store';

/**
 * Called once per inbound event, synchronously. The adapter acks the delivery
 * straight after, whatever happens to the event later and whether or not this
 * throws: a messenger that waits on its ack redelivers, and the core never
 * holds one up.
 */
export type Sink = (event: Inbound) => void;

/**
 * The link to the messenger, in words the Remote surface draws.
 *
 * **The link fails only when a person must act.** One rule for every adapter:
 *
 * - `reconnecting`: network trouble — a dropped socket, a missed ping. The
 *   adapter retries on its own backoff, indefinitely, and nothing above it adds
 *   a reconnect timer.
 * - `failed`: the adapter has stopped and will not reconnect by itself — a bad
 *   or revoked credential, a setting at the messenger switched off. It stays
 *   failed until a person acts: new credentials, Remote off and on, a reload.
 *   `retry: true` is reserved for a stop that clears without a person; no
 *   adapter emits it and nothing reconnects on it.
 * - `connected`: up, though `warning` may name a condition that loses events,
 *   such as a second client holding the same app.
 *
 * A reason or a warning is the adapter's words about its own link, for the
 * panel. The host redacts it before storing it.
 */
export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'connected'; warning?: string }
  | { kind: 'reconnecting'; reason: string }
  | { kind: 'failed'; reason: string; retry: boolean };

export interface Connection {
  readonly state: LinkState;
  /** Called on every move of `state`. Returns the unsubscribe. */
  onState(listener: (state: LinkState) => void): () => void;
  close(): void;
}

/** What a backlog read found, and how many conversations it could not read. */
export type Backlog = { events: readonly Inbound[]; missed: number };

/**
 * One messenger, connected or not. Posts and links work before the connection
 * is up; only inbound events need it.
 *
 * The port has no append and no update-text: a notice is posted once and then
 * only settled, so nothing can stream (D14).
 */
export interface Messenger {
  readonly id: string;
  readonly incomingFiles?: {
    readonly version: 1;
    readonly installId: string;
    verify(file: IncomingFile, signal: AbortSignal): Promise<boolean>;
    refusal(error: unknown): `provider-${string}`;
    metadata(
      file: IncomingFile,
      signal: AbortSignal
    ): Promise<{
      name?: string;
      mime?: string;
      size?: number;
    }>;
    download(
      file: IncomingFile,
      options: { signal: AbortSignal; maxBytes: number }
    ): Promise<AsyncIterable<Uint8Array>>;
  };
  readonly reactions?: {
    set(message: MessageRef, status: ReactionStatus, signal?: AbortSignal): Promise<void>;
  };
  connect(sink: Sink): Connection;
  /** Abandons every call in flight, made before any connection or since, and
   *  closes the connection: what stopping the engine does, so no hung post
   *  holds a turn-off. A later `connect` starts afresh. */
  close(): void;
  /** Rejects a notice the messenger cannot carry — a button payload over
   *  `buttons.payloadMax`, more buttons than `buttons.perNotice` — before
   *  anything is posted. */
  post(place: Place, notice: Notice): Promise<Posted>;
  /** The longest text one post carries. Longer text the adapter splits or
   *  caps itself; the core caps a notice's body well above this. */
  readonly text: { readonly max: number };
  /** `payloadMax` in bytes of printable ASCII. */
  readonly buttons: { readonly payloadMax: number; readonly perNotice: number };
  /** Replace a posted notice's buttons with its `settled` word. Without it, a
   *  settle degrades to a follow-up post. */
  readonly edit?: { settle(message: MessageRef, notice: Notice): Promise<void> };
  /** Send a file into a conversation. `maxBytes` is the largest the messenger
   *  takes, so an oversized file is refused before any request is written. */
  readonly files?: {
    readonly maxBytes: number;
    send(place: ConversationPlace, attachment: Attachment): Promise<Posted>;
  };
  /** The URL of a conversation, by its anchor. A promise because a messenger's
   *  documented permalink can be a call; a URL built from an undocumented form
   *  is not used. */
  readonly links?: { to(anchor: string): Promise<string | undefined> };
  /** Messages people sent while the link was down, read back from the
   *  messenger's own history: those after `after` (ms, against `Inbound`'s
   *  `at`) in the conversations `anchors` name, and top-level in the direct
   *  conversations those sit in, in `at` order, each mapped as its live
   *  delivery would have been, id included, so a copy that also arrives live
   *  is a repeat. A person with no anchor in a direct conversation is not
   *  read. A conversation it cannot read is counted in `missed`, not
   *  thrown. */
  readonly backlog?: {
    since(anchors: readonly MessageRef[], after: number, signal: AbortSignal): Promise<Backlog>;
  };
  /** A thread the bot is joining: every message under `anchor` older than
   *  `before`, the bot's own excluded, oldest first. Never rejects. */
  readonly thread?: {
    read(anchor: MessageRef, before: MessageRef, signal: AbortSignal): Promise<ThreadRead>;
  };
}

/** The credential values a messenger is created with, by field key. They go
 *  into the adapter and nowhere else: no core shape has a field for them. */
export type Credentials = Readonly<Record<string, string>>;

/** One credential the messenger needs. `help` says where to find it, as the
 *  token row's tip. */
export type CredentialField = { key: string; label: string; help?: string };

/** One step of making the bot: the short name a checklist row shows, and the
 *  whole instruction the guide shows. */
export type SetupStep = { title: string; text: string };

/** A label and its value, as a row draws them. */
export type SetupRow = { label: string; value: string };

/**
 * What the settings surface draws for a messenger, all of it the adapter's own
 * words, so the surface never names the messenger.
 */
export type MessengerSetup = {
  fields: readonly CredentialField[];
  /** How to find your own account for the allowlist, and what one looks like
   *  in its field. `space` is the messenger-level place an account belongs
   *  to, in the messenger's own word (a workspace), when its accounts need
   *  one: drawn as its own setting. */
  sender: {
    help: string;
    placeholder?: string;
    space?: { label: string; help: string; placeholder?: string };
  };
  /** Making the bot: ordered steps, a blob to copy, a link to start from, and
   *  what an app made by hand must be configured with. */
  create?: {
    steps: readonly SetupStep[];
    existing?: readonly SetupRow[];
    copy?: { label: string; text: string };
    link?: string;
  };
};

/**
 * What a setup check found, with a kind so nothing parses the reason.
 *
 * - `ok`: the messenger accepted the credentials; `facts` are what it said
 *   back, for a reader (a workspace, a bot name), and `space` the id of the
 *   space they belong to, when the messenger has spaces.
 * - `setup`: a person must redo a step. `step` indexes the entry's own
 *   `setup.create.steps`, so nothing drawing it names the messenger.
 * - `unreachable`: the messenger could not be asked — the network, a rate
 *   limit, its own outage. No step is blamed.
 *
 * No reason or fact carries a credential.
 */
export type SetupCheck =
  | { kind: 'ok'; facts: readonly SetupRow[]; space?: string }
  | { kind: 'setup'; step: number; reason: string }
  | { kind: 'unreachable'; reason: string };

export type Created = { ok: true; messenger: Messenger } | { ok: false; reason: string };

/**
 * What an allowed account is to this messenger, since only it knows how it
 * spells a sender. An account is what a person enters — a member id, say —
 * and the sender id the core matches is composed from it and the space.
 */
export type AccountRule = {
  /** Why `account` can never be one of this messenger's accounts, in a
   *  sentence that says what one looks like; nothing when it can be. */
  refuse(account: string): string | undefined;
  /** The same for a space id. */
  refuseSpace(space: string): string | undefined;
  /** The sender id `account` arrives as, or nothing while it needs a space
   *  and `space` is missing. Asked only of an account `refuse` admits. */
  sender(account: string, space: string | undefined): SenderId | undefined;
};

/**
 * A messenger as the registry offers it. `create` refuses credentials it can
 * tell are wrong without a network call, in a sentence. `listed: false` keeps
 * an entry out of the default choice and the settings list.
 */
export type MessengerEntry = {
  id: string;
  /** The messenger's name as a reader knows it, for "larger than <x> takes". */
  label: string;
  listed: boolean;
  setup: MessengerSetup;
  accounts: AccountRule;
  create(credentials: Credentials, signal?: AbortSignal): Created | Promise<Created>;
  /** Asks the messenger whether these credentials would connect, without
   *  connecting. Resolves in bounded time, and early when `signal` aborts;
   *  never rejects, since a failure it cannot place is `unreachable`. */
  check?(credentials: Credentials, signal: AbortSignal): Promise<SetupCheck>;
};

/**
 * Why Remote cannot run on `messenger`, or nothing. Every button carries a
 * store key of up to `PAYLOAD_MAX` bytes, so a messenger whose payload is
 * shorter could post no button at all; and Deny with End, or End with
 * Cancel, are two on one notice. Asked of the built messenger, since its
 * capabilities are the instance's; `bridge_port.test.ts` holds every
 * registered one to it.
 */
export function unfit(messenger: Messenger, label: string): string | undefined {
  const { payloadMax, perNotice } = messenger.buttons;
  return payloadMax < PAYLOAD_MAX || perNotice < 2
    ? `${label} cannot carry Remote’s buttons, so Remote cannot run on it.`
    : undefined;
}

/** A record rather than register calls, so the list does not depend on import
 *  order. One import and one line here add a messenger. */
const MESSENGERS: Readonly<Record<string, MessengerEntry>> = {
  fake: fake.fakeEntry,
  slack: slack.slackEntry
};

/** `Object.hasOwn`, because a settings id of `constructor` would otherwise
 *  index to a truthy non-entry and be called. */
export function messenger(id: string): MessengerEntry | undefined {
  return Object.hasOwn(MESSENGERS, id) ? MESSENGERS[id] : undefined;
}

/** Every registered entry, listed or not. */
export function messengers(): readonly MessengerEntry[] {
  return Object.values(MESSENGERS);
}
