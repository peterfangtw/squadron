/**
 * An in-memory messenger: the seam's second adapter, and a real one. The tests
 * drive the core through it, and the host runs it in place of a real messenger
 * so every PRD scenario can play in an IDE with no network.
 *
 * Two shapes, so the core is proved against both ways a messenger groups a
 * conversation without naming either: `thread` keeps one anchor per
 * conversation and a reply names it; `chain` makes every post its own ref and
 * a reply names the message it answers.
 */

import type {
  Attachment,
  CommandName,
  ConversationPlace,
  Inbound,
  MessageRef,
  Notice,
  Place,
  Posted,
  ReactionStatus,
  SenderId,
  ThreadRead
} from './model';
import type {
  AccountRule,
  Connection,
  Credentials,
  LinkState,
  Messenger,
  MessengerEntry,
  SetupCheck,
  Sink
} from './port';

export type FakeOptions = {
  shape?: 'thread' | 'chain';
  payloadMax?: number;
  textMax?: number;
  perNotice?: number;
  edit?: boolean;
  maxBytes?: number;
  /** `connect()` stays `connecting` until `link` first moves it. A test seam:
   *  the host drives it from a file so a real panel can show every state. */
  held?: boolean;
  now?: () => number;
  /** What `fakeEntry.create` was handed. */
  credentials?: Credentials;
};

/** One notice as posted: the text of each post it took, in order. `notice`
 *  carries the buttons or the settled word it shows now. */
export type FakePost = { place: Place; notice: Notice; posted: Posted; parts: readonly string[] };
export type FakeSettle = { message: MessageRef; notice: Notice };
export type FakeFile = { place: ConversationPlace; attachment: Attachment; posted: Posted };
export type FakeReaction = { message: MessageRef; status: ReactionStatus };

/** A file as the outbox records it: its size in place of its bytes. */
export type FakeFileRecord = Omit<FakeFile, 'attachment'> & {
  attachment: Omit<Attachment, 'bytes'> & { size: number };
};

export type FakeRecord =
  | ({ kind: 'post' } & FakePost)
  | ({ kind: 'settle' } & FakeSettle)
  | ({ kind: 'file' } & FakeFileRecord)
  | ({ kind: 'reaction' } & FakeReaction);

export interface FakeMessenger extends Messenger {
  readonly shape: 'thread' | 'chain';
  /** The bot's own sender id; a message from it is an echo and is dropped. */
  readonly bot: SenderId;
  /** Narrows the port's optional capability: this adapter always reads a thread. */
  readonly thread: NonNullable<Messenger['thread']>;
  /** Kept on the instance, as an adapter keeps its tokens in a field, so a
   *  regression that writes the messenger anywhere writes these too. */
  readonly credentials: Credentials;
  /**
   * A person's message. `in` names a conversation by its anchor, `replyTo` a
   * message it answers; with neither it is top-level. Returns what the sink was
   * handed, or nothing for a dropped echo.
   */
  say(
    sender: SenderId,
    text: string,
    where?: { in?: string; replyTo?: MessageRef; addressed?: 'direct' | 'mention' }
  ): Inbound | undefined;
  /** A button pressed. `on` defaults to the latest post carrying `payload`. */
  press(sender: SenderId, payload: string, on?: MessageRef): Inbound;
  /** Command text, as the command surface would carry it. */
  command(sender: SenderId, name: string, args?: string): Inbound;
  /** A person's message sent while the link was down: not delivered, and
   *  read back by `backlog`. Placed as `say` places it. */
  missed(
    sender: SenderId,
    text: string,
    where?: { in?: string; replyTo?: MessageRef; addressed?: 'direct' | 'mention' }
  ): Inbound;
  /** Messages already in the thread `anchor` names — the same string `say`'s
   *  `in` takes — from whoever `author` names. Not delivered, and `backlog`
   *  does not read them: they are context for `thread.read`, not events. */
  earlier(
    anchor: MessageRef,
    messages: readonly { author: string; text: string; files?: readonly string[] }[]
  ): void;
  /** The next `thread.read` that runs answers `{ ok: false, reason }`, once.
   *  An aborted read leaves it armed; a second call before a read replaces
   *  the reason. */
  failRead(reason: Extract<ThreadRead, { ok: false }>['reason']): void;
  /** The bot's own post coming back; dropped, and acked. */
  echo(posted: Posted): void;
  /** Move the open connection's state, firing its listeners. */
  link(state: LinkState): void;
  posts(): readonly FakePost[];
  settles(): readonly FakeSettle[];
  attachments(): readonly FakeFile[];
  reactionEffects(): readonly FakeReaction[];
  /** Fired on every post, settle, file and reaction as it happens. Returns the
   *  unsubscribe. */
  onRecord(listener: (record: FakeRecord) => void): () => void;
  /** Deliveries acked, dropped ones included. */
  acked(): number;
}

const COMMANDS: readonly CommandName[] = ['list', 'new', 'end'];

type Kept = {
  anchor: string;
  ref: MessageRef;
  from: SenderId;
  author: string;
  text: string;
  at: number;
  files?: readonly string[];
};

/** Printable ASCII, the alphabet every messenger's payload takes. */
const PRINTABLE = /^[\x20-\x7e]*$/;

export function fakeMessenger(options: FakeOptions = {}): FakeMessenger {
  const shape = options.shape ?? 'thread';
  const payloadMax = options.payloadMax ?? 2000;
  const textMax = options.textMax ?? 4000;
  const perNotice = options.perNotice ?? 25;
  const now = options.now ?? Date.now;
  const bot = 'fake-bot';

  /** Every message at the fake, the bot's and the people's, by ref: which
   *  conversation it sits in, and who wrote it. */
  const messages = new Map<MessageRef, { anchor: string; from: SenderId }>();
  /** The newest message in each conversation, by anchor. */
  const latest = new Map<string, MessageRef>();
  const posts: FakePost[] = [];
  /** Every person's message, delivered or missed, with its conversation:
   *  the fake's history, which `backlog` reads. */
  const said: { event: Extract<Inbound, { kind: 'message' }>; anchor: string }[] = [];
  /** What `thread.read` answers from: `say`, `missed` and `earlier`. A person's
   *  author is the sender id. */
  const kept: Kept[] = [];
  let threadFailure: Extract<ThreadRead, { ok: false }>['reason'] | undefined;
  /** Whom each conversation is with: its home post's person, or the person
   *  whose top-level message opened it. The fake's direct conversations. */
  const withWhom = new Map<string, SenderId>();
  const settles: FakeSettle[] = [];
  const files: FakeFile[] = [];
  const reactions: FakeReaction[] = [];
  const recorders = new Set<(record: FakeRecord) => void>();
  let open: FakeConnection | undefined;
  let refs = 0;
  let ids = 0;
  /** The last message's `at`: each is later than the one before, as a real
   *  messenger's timestamps are unique within a conversation. */
  let lastAt = 0;
  let acks = 0;

  const mint = (prefix: string) => `${prefix}${++refs}`;
  const stamp = (): number => (lastAt = Math.max(now(), lastAt + 1));
  /** This fake's own prefix on every delivery id: the engine keeps the ids
   *  it saw across a reload, and a second fake counting from one again would
   *  read as repeats, as no real messenger's ids do. */
  const run = Math.random().toString(36).slice(2, 8);
  const delivery = () => `${run}.e${++ids}`;

  const record = (entry: FakeRecord) => {
    for (const listener of [...recorders]) listener(entry);
  };

  const remember = (ref: MessageRef, anchor: string, from: SenderId) => {
    messages.set(ref, { anchor, from });
    latest.set(anchor, ref);
  };

  /** A person's message, placed and remembered; nothing for the bot's own. */
  const compose = (
    sender: SenderId,
    text: string,
    where: { in?: string; replyTo?: MessageRef; addressed?: 'direct' | 'mention' }
  ): Extract<Inbound, { kind: 'message' }> | undefined => {
    const ref = mint('u');
    const { replyTo } = where;
    const thread = where.in ?? (replyTo && (messages.get(replyTo)?.anchor ?? replyTo));
    const answers = replyTo ?? (where.in === undefined ? undefined : latest.get(where.in));
    const named = shape === 'thread' ? thread : answers;
    const anchor = thread ?? ref;
    remember(ref, anchor, sender);
    // No clock tick: a dropped echo must not move the next person's `at`.
    if (sender === bot) {
      kept.push({ anchor, ref, from: bot, author: bot, text, at: lastAt });
      return undefined;
    }
    const at = stamp();
    kept.push({ anchor, ref, from: sender, author: sender, text, at });
    const event = {
      kind: 'message' as const,
      id: delivery(),
      sender: { id: sender },
      text,
      addressed: where.addressed ?? 'direct',
      refs: named === undefined ? [] : [named],
      ref,
      at
    };
    said.push({ event, anchor });
    if (thread === undefined && event.addressed === 'direct') withWhom.set(ref, sender);
    return event;
  };

  /** Hand an event to the open sink and ack it whatever the sink does. */
  const deliver = (event: Inbound | undefined) => {
    try {
      if (event) open?.sink(event);
    } catch {
      // The core's failure is not the delivery's: the ack still goes.
    } finally {
      acks++;
    }
  };

  /** Where a post's first part lands, and the conversation it is in. */
  const placed = (place: Place, first: MessageRef): { anchor: string; parent?: MessageRef } => {
    if ('home' in place) return { anchor: first };
    if ('under' in place) {
      const anchor = messages.get(place.under)?.anchor ?? place.under;
      return shape === 'thread' ? { anchor } : { anchor: place.under, parent: place.under };
    }
    const { anchor, latest: newest } = place.conversation;
    return shape === 'thread' ? { anchor } : { anchor, parent: newest };
  };

  /** Why the fake cannot carry this notice, if it cannot. */
  const check = (notice: Notice): string | undefined => {
    const buttons = notice.buttons ?? [];
    if (buttons.length > perNotice) return `A notice carries at most ${perNotice} buttons.`;
    return buttons.every((b) => b.payload.length <= payloadMax && PRINTABLE.test(b.payload))
      ? undefined
      : `A button payload is at most ${payloadMax} bytes of printable ASCII.`;
  };

  const messenger: FakeMessenger = {
    id: 'fake',
    shape,
    bot,
    credentials: options.credentials ?? {},
    text: { max: textMax },
    buttons: { payloadMax, perNotice },

    close(): void {
      open?.close();
    },

    connect(sink: Sink): Connection {
      open?.close();
      open = new FakeConnection(
        sink,
        options.held ? { kind: 'connecting' } : { kind: 'connected' }
      );
      return open;
    },

    post(place, notice) {
      const refused = check(notice);
      if (refused) return Promise.reject(new Error(refused));
      const parts = split(render(notice), textMax);
      const first = mint('m');
      const { anchor } = placed(place, first);
      if ('home' in place) withWhom.set(anchor, place.home);
      let ref = first;
      parts.forEach((_, i) => {
        if (i > 0) ref = mint('m');
        remember(ref, anchor, bot);
      });
      const post: FakePost = { place, notice, posted: { message: ref, anchor }, parts };
      posts.push(post);
      record({ kind: 'post', ...post });
      return Promise.resolve(post.posted);
    },

    ...(options.edit === false
      ? {}
      : {
          edit: {
            settle(message: MessageRef, notice: Notice): Promise<void> {
              const post = posts.find((p) => p.posted.message === message);
              if (!post) return Promise.reject(new Error(`No post ${message} to settle.`));
              const { settled } = notice;
              post.notice = {
                ...post.notice,
                buttons: notice.buttons ?? [],
                ...(settled === undefined ? {} : { settled })
              };
              const entry: FakeSettle = { message, notice };
              settles.push(entry);
              record({ kind: 'settle', ...entry });
              return Promise.resolve();
            }
          }
        }),

    reactions: {
      set(message, status, signal) {
        if (signal?.aborted) return Promise.reject(new Error('closed'));
        const effect: FakeReaction = { message, status };
        reactions.push(effect);
        record({ kind: 'reaction', ...effect });
        return Promise.resolve();
      }
    },

    files: {
      maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
      send(place, attachment) {
        const ref = mint('f');
        const { anchor } = placed(place, ref);
        remember(ref, anchor, bot);
        const entry: FakeFile = { place, attachment, posted: { message: ref, anchor } };
        files.push(entry);
        const { bytes, ...rest } = attachment;
        record({ kind: 'file', ...entry, attachment: { ...rest, size: bytes.length } });
        return Promise.resolve(entry.posted);
      }
    },

    links: {
      to: (anchor) =>
        Promise.resolve(latest.has(anchor) ? `fake://conversation/${anchor}` : undefined)
    },

    say(sender, text, where = {}) {
      const event = compose(sender, text, where);
      deliver(event);
      return event;
    },

    missed(sender, text, where = {}) {
      const event = compose(sender, text, where);
      if (!event) throw new Error('The bot cannot miss its own message.');
      return event;
    },

    earlier(anchor, messages) {
      for (const message of messages) {
        const ref = mint('u');
        remember(ref, anchor, message.author);
        const { files } = message;
        kept.push({
          anchor,
          ref,
          from: message.author,
          author: message.author,
          text: message.text,
          at: stamp(),
          ...(files !== undefined && files.length > 0 ? { files } : {})
        });
      }
    },

    failRead(reason) {
      threadFailure = reason;
    },

    backlog: {
      since(anchors, after) {
        const people = new Set(anchors.flatMap((a) => withWhom.get(a) ?? []));
        const read = ({ event, anchor }: (typeof said)[number]) =>
          anchor === event.ref ? people.has(event.sender.id) : anchors.includes(anchor);
        const events = said
          .filter((entry) => entry.event.at > after && read(entry))
          .map(({ event }) => event);
        return Promise.resolve({ events, missed: 0 });
      }
    },

    thread: {
      read(anchor, before, signal) {
        if (signal.aborted) return Promise.resolve({ ok: false, reason: 'unreachable' });
        if (threadFailure !== undefined) {
          const reason = threadFailure;
          threadFailure = undefined;
          return Promise.resolve({ ok: false, reason });
        }
        const bound = kept.find((message) => message.ref === before)?.at;
        // Without `before`'s time, no message is known to be older.
        if (bound === undefined) {
          return Promise.resolve({ ok: true, lines: [], truncated: false, total: 0 });
        }
        const lines = kept
          .filter(
            (message) => message.anchor === anchor && message.from !== bot && message.at < bound
          )
          .sort((a, b) => a.at - b.at)
          .map(({ author, text, at, files }) => ({
            author,
            text,
            at,
            ...(files === undefined ? {} : { files })
          }));
        return Promise.resolve({ ok: true, lines, truncated: false, total: lines.length });
      }
    },

    press(sender, payload, on) {
      const carrier =
        on ??
        [...posts].reverse().find((p) => p.notice.buttons?.some((b) => b.payload === payload))
          ?.posted.message ??
        '';
      const event: Inbound = {
        kind: 'press',
        id: delivery(),
        sender: { id: sender },
        payload,
        message: carrier
      };
      deliver(event);
      return event;
    },

    command(sender, name, args = '') {
      const known = COMMANDS.find((command) => command === name);
      const event: Inbound = {
        kind: 'command',
        id: delivery(),
        sender: { id: sender },
        name: known ?? 'help',
        args: known ? args : [name, args].filter(Boolean).join(' '),
        refs: []
      };
      deliver(event);
      return event;
    },

    echo() {
      deliver(undefined);
    },

    link(state) {
      if (!open) throw new Error('The fake has no open connection to move.');
      open.move(state);
    },

    posts: () => posts,
    settles: () => settles,
    attachments: () => files,
    reactionEffects: () => reactions,
    onRecord(listener) {
      recorders.add(listener);
      return () => recorders.delete(listener);
    },
    acked: () => acks
  };
  return messenger;
}

class FakeConnection implements Connection {
  private listeners = new Set<(state: LinkState) => void>();
  private closed = false;

  constructor(
    private readonly handler: Sink,
    public state: LinkState
  ) {}

  /** The sink while open; a closed connection delivers nothing. */
  get sink(): Sink {
    return this.closed ? () => undefined : this.handler;
  }

  onState(listener: (state: LinkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  move(state: LinkState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

/** The notice as plain text: who it asks, what it is about, what it says. */
function render(notice: Notice): string {
  return [
    notice.mention === undefined ? undefined : `@${notice.mention}`,
    notice.head,
    notice.body,
    notice.code === undefined ? undefined : `\`${notice.code}\``
  ]
    .filter((line) => line !== undefined && line !== '')
    .join('\n');
}

/** Cut at the last newline that fits, else hard at `max`. */
function split(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > 0 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(cut > 0 ? at + 1 : at);
  }
  parts.push(rest);
  return parts;
}

/** What the fake's check answers unless the host builds it with another
 *  verdict. */
const CHECKED: SetupCheck = {
  kind: 'ok',
  facts: [{ label: 'Messenger', value: 'Test messenger' }]
};

/** Any id with no whitespace in it, which is also what it arrives as: the
 *  fake's senders are whatever a driver says, so the space changes none. */
const FAKE_ACCOUNTS: AccountRule = {
  refuse: (account) =>
    /\s/.test(account) ? 'The test messenger takes an id with no spaces in it.' : undefined,
  refuseSpace: (space) =>
    /\s/.test(space) ? 'The test messenger takes a space with no spaces in it.' : undefined,
  sender: (account) => account
};

/** A messenger entry whose check is always there. */
export type FakeEntry = MessengerEntry & Required<Pick<MessengerEntry, 'check'>>;

/** The fake's registry entry, its check answering `verdict` whatever it is
 *  handed. The host builds one from `squadron.remote.fakeCheck`, so a real
 *  panel can draw every outcome with no network. */
export function fakeEntryWith(verdict: SetupCheck): FakeEntry {
  return {
    id: 'fake',
    label: 'Test messenger',
    listed: false,
    setup: {
      // Never read by the fake. It is here so a real host stores one credential
      // through its input box and `SecretStorage` with the fake selected.
      fields: [{ key: 'token', label: 'Token' }],
      sender: {
        help: 'Any id without a space in it. The test messenger takes it as it is.',
        // Drawn so a real panel has the row; no sender is composed from it.
        space: { label: 'Space', help: 'Any id. The test messenger keys no sender on it.' }
      },
      // Two steps, so a failed check has a step either side of it to mark.
      create: {
        steps: [
          { title: 'Store a token', text: 'Paste any token. The test messenger reads none.' },
          { title: 'Send a message', text: 'Drop an event into the inbox the host reads.' }
        ],
        existing: [{ label: 'Token', value: 'any text' }]
      }
    },
    accounts: FAKE_ACCOUNTS,
    create: (credentials) => ({ ok: true, messenger: fakeMessenger({ credentials }) }),
    check: () => Promise.resolve(verdict)
  };
}

export const fakeEntry: FakeEntry = fakeEntryWith(CHECKED);
