/**
 * Slack as a `Messenger`: the one object the Remote host constructs, and the
 * registry entry that is the whole of the core's knowledge that Slack exists.
 * It sits beside the brand seam (`core/adapter.ts`) as the messenger seam:
 * one line in `core/bridge/port.ts` plus this package.
 *
 * The two tokens live in this closure and nowhere else. No field of the
 * messenger holds one, and every failure names a method and Slack's code.
 */

import type {
  Attachment,
  ConversationPlace,
  Inbound,
  MessageRef,
  Notice,
  Place,
  Posted,
  ReactionStatus,
  ThreadRead
} from '../bridge/model';
import type {
  AccountRule,
  Backlog,
  Connection,
  Credentials,
  Created,
  LinkState,
  Messenger,
  MessengerEntry,
  SetupCheck,
  SetupRow,
  Sink
} from '../bridge/port';
import * as api from './api';
import * as files from './files';
import * as download from './download';
import * as inbound from './inbound';
import * as manifest from './manifest';
import * as render from './render';
import * as socket from './socket';
import * as wire from './wire';
import * as ws from './ws';

/** The network, as constructor arguments only: a setting that could point
 *  `fetch` elsewhere is a place the bot token would follow. */
export type SlackDeps = {
  fetch: api.Fetch & files.UploadFetch;
  openSocket: socket.OpenSocket;
};

export type SlackCredentials = { botToken: string; appToken: string };

/** A button value is at most 2,000 characters, and an `actions` block holds
 *  at most 25 elements. Payloads are printable ASCII, so characters are
 *  bytes. */
const PAYLOAD_MAX = 2000;
const PER_NOTICE = 25;
const PRINTABLE = /^[\x20-\x7e]*$/;

/** `conversations.replies`' codes for a thread that is not there. */
const NOT_FOUND = new Set(['thread_not_found', 'message_not_found']);

/** The most messages a joined thread's read keeps: the newest before the
 *  mention. */
export const THREAD_WINDOW = 2000;

/** Refusals a person fixes by reinstalling the app or inviting the bot. */
const SCOPE_REFUSAL = new Set(['missing_scope', 'not_in_channel', 'channel_not_found']);

const STATUS_REACTIONS: Readonly<Record<ReactionStatus, string>> = {
  received: 'eyes',
  queued: 'hourglass_flowing_sand',
  processing: 'gear',
  done: 'white_check_mark'
};

export function slackMessenger(
  credentials: SlackCredentials,
  deps: SlackDeps = { fetch: globalThis.fetch, openSocket: ws.openSocket },
  authenticated?: wire.Identity
): Messenger {
  /** What closing the newest connection or the messenger aborts: every Web
   *  API call made since this messenger was made or last reconnected, a post
   *  queued behind a rate-limited one included. Posts made before `connect()`
   *  share it. */
  let lifetime = new AbortController();
  let newest: Connection | undefined;
  const slack = api.slackApi(deps.fetch, credentials.botToken, () => lifetime.signal);
  /** Permalinks by anchor, for the life of one connection. */
  let links = new Map<string, Promise<string | undefined>>();
  /** The bot as `auth.test` named it, for mapping history; asked again after
   *  a failure. */
  let self: Promise<wire.Identity> | undefined;

  return {
    id: 'slack',
    ...(authenticated
      ? {
          incomingFiles: download.incomingFiles(
            slack,
            globalThis.fetch,
            credentials.botToken,
            authenticated,
            () => lifetime.signal
          )
        }
      : {}),
    text: { max: render.CHUNK_MAX },
    buttons: { payloadMax: PAYLOAD_MAX, perNotice: PER_NOTICE },

    connect(sink: Sink): Connection {
      links = new Map();
      if (lifetime.signal.aborted) {
        lifetime = new AbortController();
      }
      newest = connection(sink);
      return newest;
    },

    close(): void {
      newest?.close();
      lifetime.abort();
    },

    async post(place: Place, notice: Notice): Promise<Posted> {
      const refused = refusal(notice);
      if (refused !== undefined) {
        throw new Error(refused);
      }
      const target = where(place);
      if (target === undefined) {
        throw new api.SlackError('chat.postMessage', 'bad_place');
      }
      return postChunks(target, render.renderNotice(notice));
    },

    edit: {
      async settle(message: MessageRef, notice: Notice): Promise<void> {
        const at = wire.parseRef(message);
        if (at === undefined) {
          throw new api.SlackError('chat.update', 'bad_ref');
        }
        const { text, blocks } = render.renderSettled(notice);
        await slack.update({ channel: at.channel, ts: at.ts, text, blocks });
      }
    },

    reactions: {
      async set(message: MessageRef, status: ReactionStatus, signal?: AbortSignal): Promise<void> {
        const at = wire.parseRef(message);
        if (at === undefined) throw new api.SlackError('reactions.add', 'bad_message');
        const bounded = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
        const name = STATUS_REACTIONS[status];
        const target = { channel: at.channel, timestamp: at.ts };
        await slack.addReaction({ ...target, name }, bounded);
        for (const other of Object.values(STATUS_REACTIONS)) {
          if (other !== name) await slack.removeReaction({ ...target, name: other }, bounded);
        }
      }
    },

    files: {
      maxBytes: files.FILE_MAX,
      send: (place: ConversationPlace, attachment: Attachment) =>
        files.uploadFile(slack, deps.fetch, place, attachment, lifetime.signal)
    },

    backlog: {
      since: (anchors, after, signal) => backlog(anchors, after, signal)
    },

    thread: {
      read: (anchor, before, signal) => readThread(anchor, before, signal)
    },

    links: {
      to(anchor: string): Promise<string | undefined> {
        const known = links.get(anchor);
        if (known !== undefined) {
          return known;
        }
        const at = wire.parseRef(anchor);
        if (at === undefined) {
          return Promise.resolve(undefined);
        }
        const asked = slack.permalink(at.channel, at.ts).catch(() => {
          // Not cached, so the next ask tries again.
          links.delete(anchor);
          return undefined;
        });
        links.set(anchor, asked);
        return asked;
      }
    }
  };

  /** The link, from the socket's moves, with each envelope mapped and handed
   *  to the sink one event at a time. */
  function connection(sink: Sink): Connection {
    const listeners = new Set<(state: LinkState) => void>();
    let state: LinkState = { kind: 'connecting' };
    const mode = socket.openSocketMode({
      fetch: deps.fetch,
      api: slack,
      appToken: credentials.appToken,
      openSocket: deps.openSocket,
      onEnvelope(envelope, self) {
        for (const event of inbound.toInbound(envelope, self)) deliver(sink, event);
      },
      onState(next) {
        state = next;
        for (const listener of [...listeners]) listener(next);
      }
    });
    const link: Connection = {
      get state() {
        return state;
      },
      onState(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
        mode.close();
        links = new Map();
        // An older connection closing leaves the newer one's calls alone.
        if (newest === link) {
          lifetime.abort();
        }
      }
    };
    return link;
  }

  /**
   * Each DM the anchors sit in, read after `after`, and each anchor's thread.
   * A channel anchor is skipped: catch-up does not read channels, even when
   * `channels:history` is granted. A DM's id starts `D`; asking
   * `conversations.info` would need `im:read`, which the manifest does not
   * ask for.
   */
  async function backlog(
    anchors: readonly MessageRef[],
    after: number,
    signal: AbortSignal
  ): Promise<Backlog> {
    const bot = await identity(signal);
    const oldest = (after / 1000).toFixed(6);
    const threads = anchors.flatMap((anchor) => {
      const at = wire.parseRef(anchor);
      return at?.channel.startsWith('D') ? [at] : [];
    });
    const channels = [...new Set(threads.map((at) => at.channel))];
    const reads = await Promise.allSettled([
      ...channels.map((channel) => slack.history(channel, oldest, signal)),
      ...threads.map((at) => slack.replies(at.channel, at.ts, oldest, signal).catch(gone))
    ]);
    const seen = new Set<string>();
    const events: Extract<Inbound, { kind: 'message' }>[] = [];
    for (const read of reads) {
      if (read.status === 'rejected') continue;
      for (const message of read.value) {
        const event = inbound.fromHistory(message, bot);
        if (event?.kind !== 'message' || event.at <= after || seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    events.sort((a, b) => a.at - b.at);
    return { events, missed: reads.filter((read) => read.status === 'rejected').length };
  }

  function identity(signal: AbortSignal): Promise<wire.Identity> {
    self ??= slack.authTest(signal).catch((error: unknown) => {
      self = undefined;
      throw error;
    });
    return self;
  }

  /** Never rejects. A refusal a person can fix is `scope`; everything else,
   *  an abort before the range ends included, is `unreachable`. */
  async function readThread(
    anchor: MessageRef,
    before: MessageRef,
    signal: AbortSignal
  ): Promise<ThreadRead> {
    const root = wire.parseRef(anchor);
    const cut = wire.parseRef(before);
    if (root === undefined || cut === undefined) return { ok: false, reason: 'unreachable' };
    try {
      const bot = await identity(signal);
      const kept: wire.MessageEvent[] = [];
      let total = 0;
      let last = -Infinity;
      for await (const page of slack.replyPages(root.channel, root.ts, cut.ts, signal)) {
        for (const row of page) {
          const ts = Number(row.ts);
          // Oldest first, so a row no newer than the last is one already counted.
          if (!(ts < Number(cut.ts)) || ts <= last || ownMessage(row, bot)) continue;
          last = ts;
          total++;
          kept.push(row);
        }
        if (kept.length > THREAD_WINDOW) kept.splice(0, kept.length - THREAD_WINDOW);
      }
      const names = new Map<string, string | undefined>();
      const lines = [];
      for (const row of kept) {
        lines.push({
          author: await authorOf(row, names, signal),
          // No bot id: a mention of the bot in someone else's message is part of what was said.
          text: inbound.plainText(row.text ?? ''),
          at: Math.floor(Number(row.ts) * 1000),
          ...(row.fileNames !== undefined && { files: row.fileNames })
        });
      }
      return { ok: true, lines, truncated: total > kept.length, total };
    } catch (error) {
      return { ok: false, reason: scopeRefusal(error) ? 'scope' : 'unreachable' };
    }
  }

  /** `users.info`, once per member for this read. A failure falls back; an
   *  abort fails the read. */
  async function authorOf(
    row: wire.MessageEvent,
    names: Map<string, string | undefined>,
    signal: AbortSignal
  ): Promise<string> {
    const named = row.user === undefined ? undefined : await displayName(row.user, names, signal);
    if (named !== undefined) return named;
    return row.botName ?? row.username ?? (row.user === undefined ? '' : `@${row.user}`);
  }

  async function displayName(
    user: string,
    names: Map<string, string | undefined>,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (names.has(user)) return names.get(user);
    try {
      const name = await slack.userInfo(user, signal);
      names.set(user, name);
      return name;
    } catch (error) {
      if (signal.aborted || (error instanceof api.SlackError && error.code === 'closed')) {
        throw error;
      }
      names.set(user, undefined);
      return undefined;
    }
  }

  function ownMessage(row: wire.MessageEvent, bot: wire.Identity): boolean {
    return row.user === bot.userId || (bot.botId !== undefined && row.botId === bot.botId);
  }

  function scopeRefusal(error: unknown): boolean {
    return error instanceof api.SlackError && SCOPE_REFUSAL.has(error.code);
  }

  /** A thread Slack no longer has (its root deleted) is read as empty: it
   *  holds nothing to catch up, and counted as missed it would hold every
   *  later catch-up's window open. */
  function gone(error: unknown): wire.MessageEvent[] {
    if (error instanceof api.SlackError && NOT_FOUND.has(error.code)) return [];
    throw error;
  }

  /** Each chunk in order, the later ones in the thread the first one is in or
   *  opened. */
  async function postChunks(target: Target, chunks: readonly render.Chunk[]): Promise<Posted> {
    let channel = target.channel;
    let threadTs = target.threadTs;
    let anchor = target.anchor;
    let message: string | undefined;
    for (const chunk of chunks) {
      const landed = await slack.post({
        channel,
        text: chunk.text,
        blocks: chunk.blocks,
        ...(threadTs !== undefined && { threadTs })
      });
      message = wire.slackRef(landed.channel, landed.ts);
      if (message === undefined) {
        throw new api.SlackError('chat.postMessage', 'unreadable_reply');
      }
      channel = landed.channel;
      threadTs ??= landed.ts;
      anchor ??= message;
    }
    if (message === undefined || anchor === undefined) {
      throw new api.SlackError('chat.postMessage', 'empty_notice');
    }
    return { message, anchor };
  }
}

/** Where a post goes: a channel, the thread in it, and the conversation's
 *  anchor when the place already names one. */
type Target = { channel: string; threadTs?: string; anchor?: string };

/** `home` posts to the user id, which Slack opens as the bot DM; `under` and
 *  `conversation` post in the thread of the message they name. */
function where(place: Place): Target | undefined {
  if ('home' in place) {
    const user = render.userOf(place.home);
    return user === undefined ? undefined : { channel: user };
  }
  const anchor = 'under' in place ? place.under : place.conversation.anchor;
  const at = wire.parseRef(anchor);
  return at === undefined ? undefined : { channel: at.channel, threadTs: at.ts, anchor };
}

/** Why Slack cannot carry this notice, before anything is posted. These go to
 *  the core's log, never to a person. */
function refusal(notice: Notice): string | undefined {
  const buttons = notice.buttons ?? [];
  if (buttons.length > PER_NOTICE) {
    return `A Slack notice carries at most ${PER_NOTICE} buttons.`;
  }
  return buttons.every((b) => b.payload.length <= PAYLOAD_MAX && PRINTABLE.test(b.payload))
    ? undefined
    : `A Slack button payload is at most ${PAYLOAD_MAX} bytes of printable ASCII.`;
}

/** One event to the sink. A throw is the core's to log; the events after it
 *  in the same envelope still go. */
function deliver(sink: Sink, event: Inbound): void {
  try {
    sink(event);
  } catch {
    // The ack goes out regardless (socket.ts).
  }
}

const SETUP_STEPS = [
  {
    title: 'Create the app from the manifest',
    text: 'Open the link below, or go to api.slack.com/apps, choose Create New App, then From a manifest, pick your workspace and paste the manifest. Create the app.'
  },
  {
    title: 'Generate the app-level token',
    text: `Under Basic Information, App-Level Tokens, choose Generate Token and Scopes. Add ${manifest.APP_TOKEN_SCOPE}, generate it, and paste the xapp- token here.`
  },
  {
    title: 'Install it, copy the bot token',
    text: 'Under Install App, install it to your workspace and allow it. Paste the Bot User OAuth Token, which starts xoxb-, here.'
  },
  {
    title: 'Message the bot',
    text: 'A direct message to the bot is the simple path. To use it in a channel, invite it there and @mention it each time.'
  }
];

/** What an app made by hand must be set to, read off the manifest the link
 *  would create it from, so the two cannot disagree. */
function existingApp(): SetupRow[] {
  const m = manifest.slackManifest();
  const on = (value: boolean) => (value ? 'on' : 'off');
  const home = m.features.app_home;
  return [
    { label: 'Bot scopes', value: m.oauth_config.scopes.bot.join(', ') },
    ...manifest.OPTIONAL_SCOPES.map(({ feature, scopes }) => ({
      label: feature,
      value: optionalInstallLine(scopes)
    })),
    { label: 'App-level token', value: manifest.APP_TOKEN_SCOPE },
    { label: 'Bot events', value: m.settings.event_subscriptions.bot_events.join(', ') },
    { label: 'Socket Mode', value: on(m.settings.socket_mode_enabled) },
    { label: 'Interactivity', value: on(m.settings.interactivity.is_enabled) },
    {
      label: 'App Home',
      value: `Messages tab ${on(home.messages_tab_enabled)}, ${home.messages_tab_read_only_enabled ? 'read-only' : 'not read-only'}`
    },
    { label: 'Slash command', value: m.features.slash_commands.map((c) => c.command).join(', ') }
  ];
}

const SENDER_HELP =
  'Your member id, which starts with U: your profile, then ⋯, then Copy member ID. Someone in another workspace (Slack Connect) is their workspace id and member id with a colon between: T…:U….';

const SPACE_HELP =
  'The workspace the app is installed in, by its id. Check fills it in from the bot token. In a browser, Slack’s address reads app.slack.com/client/T…/.';

const MEMBER_ID =
  'A member id starts with U, like U0123ABCD: your profile, then ⋯, then Copy member ID.';

/**
 * What an allowed account is to Slack: a member id, sent as
 * `<workspace>:<member>` (`inbound.ts`), so it is composed with the workspace
 * setting; or that whole sender id as it stands, which is how a guest from
 * another workspace is allowed and how a hand-edited list may hold one. No
 * case folding: an id is the identity.
 */
export const slackAccounts: AccountRule = {
  refuse(account: string): string | undefined {
    const parts = account.split(':');
    if (parts.length === 2) {
      const [team = '', user = ''] = parts;
      return wire.isTeam(team) && wire.isMember(user) ? undefined : MEMBER_ID;
    }
    if (parts.length > 2) return MEMBER_ID;
    if (wire.isMember(account)) return undefined;
    if (wire.isTeam(account)) {
      return 'That is a workspace id. An account is a member id, which starts with U.';
    }
    if (account.includes('@')) {
      return 'An account is a member id, not a name or an email: your profile, then ⋯, then Copy member ID.';
    }
    if (wire.isMember(account.toUpperCase())) return 'A member id is in capitals, like U0123ABCD.';
    return MEMBER_ID;
  },
  refuseSpace(space: string): string | undefined {
    return wire.isTeam(space) ? undefined : 'A workspace id starts with T, like T0123ABCD.';
  },
  sender(account: string, space: string | undefined): string | undefined {
    if (account.includes(':')) return account;
    return space === undefined ? undefined : `${space}:${account}`;
  }
};

export const slackEntry: MessengerEntry = {
  id: 'slack',
  label: 'Slack',
  listed: true,
  setup: {
    fields: [
      {
        key: 'botToken',
        label: 'Bot token (xoxb-…)',
        help: 'Bot User OAuth Token, from Install App. Starts xoxb-.'
      },
      {
        key: 'appToken',
        label: 'App-level token (xapp-…)',
        help: `From Basic Information, App-Level Tokens, with ${manifest.APP_TOKEN_SCOPE}. Starts xapp-.`
      }
    ],
    sender: {
      help: SENDER_HELP,
      placeholder: 'U0123ABCD',
      space: { label: 'Workspace', help: SPACE_HELP, placeholder: 'T0123ABCD' }
    },
    create: {
      steps: SETUP_STEPS,
      existing: existingApp(),
      copy: { label: 'Manifest', text: JSON.stringify(manifest.slackManifest(), null, 2) },
      link: manifest.manifestUrl()
    }
  },
  accounts: slackAccounts,
  create(credentials: Credentials, signal?: AbortSignal): Created | Promise<Created> {
    const refused = credentialsRefusal(credentials);
    if (refused !== undefined) return { ok: false, reason: refused.reason };
    return bootstrap(credentials, signal);
  },
  check: (credentials, signal) => checkSlack(credentials, signal)
};

async function bootstrap(credentials: Credentials, signal?: AbortSignal): Promise<Created> {
  const deadline = AbortSignal.timeout(CHECK_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const self = await api.slackApi(globalThis.fetch, credentials.botToken ?? '').authTest(bounded);
    if (bounded.aborted) return { ok: false, reason: 'Slack did not answer in time.' };
    if (!wire.isTeam(self.teamId) || !wire.isMember(self.userId))
      return { ok: false, reason: 'Slack returned an unreadable installation.' };
    return {
      ok: true,
      messenger: slackMessenger(
        { botToken: credentials.botToken ?? '', appToken: credentials.appToken ?? '' },
        undefined,
        self
      )
    };
  } catch (error) {
    const verdict = failed(error, BOT_STEP, (code) => `Slack refused the bot token (${code}).`);
    return {
      ok: false,
      reason: verdict.reason
    };
  }
}

/** `SETUP_STEPS`' indexes for the two tokens. */
const APP_STEP = 1;
const BOT_STEP = 2;

/** How long a whole check may take (a duration). Short of `api.CALL_MS`, so a
 *  hung request or a long `Retry-After` reads as unreachable while the reader
 *  still waits on it. */
const CHECK_MS = 15_000;

/**
 * Whether two tokens would connect, asked the way a turn-on asks, without
 * connecting: `apps.connections.open` with the app-level token, whose
 * single-use URL is dropped unread and expires on its own, then `auth.test`
 * with the bot token, whose scopes are held against the manifest's.
 *
 * Runs under `signal` and `CHECK_MS` together. It shares
 * `apps.connections.open`'s rate limit with reconnects, so it keeps Slack's
 * `Retry-After` through `callApi` and retries nothing itself. Never rejects.
 */
export async function checkSlack(
  credentials: Credentials,
  signal: AbortSignal,
  options: { fetch?: api.Fetch; deadlineMs?: number } = {}
): Promise<SetupCheck> {
  const refused = credentialsRefusal(credentials);
  if (refused !== undefined) {
    return { kind: 'setup', ...refused };
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? CHECK_MS);
  try {
    return await askSlack(
      options.fetch ?? globalThis.fetch,
      credentials,
      AbortSignal.any([signal, deadline.signal])
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The two calls, in the order the steps make the tokens. */
async function askSlack(
  fetch: api.Fetch,
  credentials: Credentials,
  signal: AbortSignal
): Promise<SetupCheck> {
  try {
    await api.openConnection(fetch, (credentials.appToken ?? '').trim(), signal);
  } catch (error) {
    return failed(error, APP_STEP, appRefused);
  }
  let asked: api.BotScopes;
  try {
    asked = await api.slackApi(fetch, (credentials.botToken ?? '').trim()).authScopes(signal);
  } catch (error) {
    return failed(error, BOT_STEP, (code) => `Slack refused the bot token (${code}).`);
  }
  const { identity, scopes } = asked;
  const wanted = manifest.slackManifest().oauth_config.scopes.bot;
  const optional = new Set(manifest.OPTIONAL_SCOPES.flatMap((entry) => entry.scopes));
  const missing = wanted.filter(
    (scope) => scopes !== undefined && !optional.has(scope) && !scopes.includes(scope)
  );
  if (missing.length > 0) {
    return {
      kind: 'setup',
      step: BOT_STEP,
      reason: `The bot token is missing ${missing.join(', ')}. Add the manifest's scopes to the app and reinstall it.`
    };
  }
  return {
    kind: 'ok',
    facts: [
      { label: 'Workspace', value: identity.team ?? identity.teamId },
      { label: 'Bot', value: identity.user === undefined ? identity.userId : `@${identity.user}` },
      { label: 'Scopes', value: scopes === undefined ? 'not reported' : 'checked' },
      ...optionalFacts(scopes)
    ],
    space: identity.teamId
  };
}

/** Available only when every scope of the feature is on the token. A missing
 *  one is named; an unreported header names none of them. */
function optionalFacts(granted: readonly string[] | undefined): SetupRow[] {
  return manifest.OPTIONAL_SCOPES.map(({ feature, scopes, without }) => ({
    label: feature,
    value: optionalFact(scopes, without, granted)
  }));
}

function optionalFact(
  needed: readonly string[],
  without: string | undefined,
  granted: readonly string[] | undefined
): string {
  if (granted === undefined) return 'not reported';
  const missing = needed.filter((scope) => !granted.includes(scope));
  if (missing.length === 0) return 'available';
  const fix = `add ${missing.join(', ')} to the app and reinstall it.`;
  return without === undefined ? `Unavailable: ${fix}` : `Unavailable, so ${without}: ${fix}`;
}

function optionalInstallLine(scopes: readonly string[]): string {
  return `For an existing app, add ${scopes.join(', ')} under OAuth & Permissions, then reinstall the app to the workspace. Messaging works without it.`;
}

function appRefused(code: string): string {
  return code === 'missing_scope'
    ? `The app-level token does not have ${manifest.APP_TOKEN_SCOPE}. Generate one that does.`
    : `Slack refused the app-level token (${code}).`;
}

/** A refusal only a person can fix fails `step`; anything else could not
 *  ask. Slack's codes are snake_case, so a code that is not one — which a
 *  token never is — is not repeated. */
function failed(
  error: unknown,
  step: number,
  refused: (code: string) => string
): Exclude<SetupCheck, { kind: 'ok' }> {
  const code =
    error instanceof api.SlackError && /^[a-z0-9_]+$/.test(error.code) ? error.code : undefined;
  if (code !== undefined && api.fatal(code)) {
    return { kind: 'setup', step, reason: refused(code) };
  }
  return { kind: 'unreachable', reason: unreachable(code) };
}

function unreachable(code: string | undefined): string {
  switch (code) {
    case 'closed':
    case 'timed_out':
      return 'Slack did not answer in time.';
    case 'ratelimited':
      return 'Slack is limiting requests from this app. Check again in a minute.';
    case undefined:
      return 'Slack could not be reached.';
    default:
      return `Slack could not be reached (${code}).`;
  }
}

/** A token missing, of the wrong kind, or the pair pasted into each other's
 *  fields, as the earliest setup step that would fix it: the app-level
 *  token's before the bot token's, the order the steps make them. Said
 *  without the token. */
function credentialsRefusal(
  credentials: Credentials
): { step: number; reason: string } | undefined {
  const bot = (credentials.botToken ?? '').trim();
  const app = (credentials.appToken ?? '').trim();
  if (bot.startsWith('xapp-') && app.startsWith('xoxb-')) {
    return {
      step: APP_STEP,
      reason:
        'The two tokens are swapped: the bot token starts xoxb- and the app-level token xapp-.'
    };
  }
  if (app === '') {
    return { step: APP_STEP, reason: 'Paste the app-level token, which starts xapp-.' };
  }
  if (!app.startsWith('xapp-')) {
    return {
      step: APP_STEP,
      reason:
        'The app-level token starts xapp-. Generate one under Basic Information, App-Level Tokens.'
    };
  }
  if (bot === '') {
    return { step: BOT_STEP, reason: 'Paste the bot token, which starts xoxb-.' };
  }
  if (!bot.startsWith('xoxb-')) {
    return {
      step: BOT_STEP,
      reason: 'The bot token starts xoxb-. Copy the Bot User OAuth Token from Install App.'
    };
  }
  return undefined;
}
