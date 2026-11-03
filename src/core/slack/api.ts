/**
 * Slack's Web API over `fetch`: the one place that owns the bearer header, the
 * JSON-versus-form choice, error mapping and the 429 wait. Every other file
 * calls a method by name.
 *
 * A token goes into a request header and nowhere else. A thrown error names
 * the method and Slack's error code, never a header, a body or the error
 * `fetch` threw, so no failure path can carry a token out.
 */

import * as wire from './wire';

/** The slice of `fetch` this uses, so a test can pass a recorder. The global
 *  `fetch` fits it. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchReply>;
export type FetchInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};
export type FetchReply = {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
};

export class SlackError extends Error {
  constructor(
    readonly method: string,
    /** Slack's `error` string, or one of ours: `ratelimited` after the
     *  retries, `request_failed`, `http_<status>`, `unreadable_reply`,
     *  `timed_out` for a request unanswered at `CALL_MS`, and `closed` for a
     *  call whose signal aborted before it was answered. */
    readonly code: string,
    readonly retryAfterSeconds?: number
  ) {
    super(`${method}: ${code}`);
    this.name = 'SlackError';
  }
}

/**
 * Whether a call that failed with `code` may still have been carried out:
 * Slack's answer never arrived (`request_failed`, `timed_out`, or `closed` by
 * an abort mid-call), came from something in front of it (`http_<status>`),
 * or could not be read. A code Slack stated, `ratelimited` included, is its
 * refusal.
 */
export function unanswered(code: string): boolean {
  return (
    code === 'request_failed' ||
    code === 'timed_out' ||
    code === 'closed' ||
    code === 'unreadable_reply' ||
    code.startsWith('http_')
  );
}

/**
 * How long one request may go unanswered before it is abandoned (a duration),
 * reply body included. Unbounded, a hung request waits out undici's own
 * timeouts, 300 s each for the headers and the body, and holds the engine's
 * chain behind it: every inbound event and pass, and turn-off, a rebuild and
 * the holder's release.
 */
export const CALL_MS = 30_000;
/** Retries after a rate limit, beyond the first call. */
const RETRIES = 3;
/** The most a call waits on rate limits in all, before it gives up. */
const RETRY_BUDGET_MS = 60_000;
/** The wait when a limited reply names none it can be read for. */
const DEFAULT_RETRY_MS = 1_000;

/**
 * POST one method and give back the ok reply's body.
 *
 * The body is JSON unless `form` is set. Slack takes JSON on its write
 * methods only; a read method, and `files.getUploadURLExternal`, take a form.
 * An aborted `signal` ends the call where it is, rate-limit wait included,
 * and nothing is sent after it. Each request is also abandoned at `CALL_MS`.
 */
export async function callApi(
  fetch: Fetch,
  token: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  options: { form?: boolean; signal?: AbortSignal } = {}
): Promise<Readonly<Record<string, unknown>>> {
  return (await callForReply(fetch, token, method, args, options)).body;
}

/** An ok reply: its body, and the token's scopes when the reply's
 *  `x-oauth-scopes` header names them. */
export type Replied = { body: Readonly<Record<string, unknown>>; scopes?: readonly string[] };

/** `callApi`, keeping what the reply's headers said beside its body. */
export async function callForReply(
  fetch: Fetch,
  token: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  options: { form?: boolean; signal?: AbortSignal } = {}
): Promise<Replied> {
  const { signal } = options;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      throw new SlackError(method, 'closed');
    }
    const outcome = await callOnce(fetch, token, method, args, options.form === true, signal);
    if (signal?.aborted) {
      throw new SlackError(method, 'closed');
    }
    if (outcome.kind === 'ok') {
      return { body: outcome.body, ...(outcome.scopes && { scopes: outcome.scopes }) };
    }
    if (outcome.kind === 'error') {
      throw new SlackError(method, outcome.code);
    }
    if (attempt >= RETRIES || waited + outcome.retryMs > RETRY_BUDGET_MS) {
      const seconds = outcome.retryMs / 1000;
      throw new SlackError(
        method,
        'ratelimited',
        Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 999999 ? seconds : undefined
      );
    }
    waited += outcome.retryMs;
    await wait(outcome.retryMs, signal);
  }
}

/** `ms` on the clock, cut short by `signal`; the caller checks which. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The codes after which only a person can bring the link back: a bad,
 *  revoked or wrong-kind token, a deactivated account, Socket Mode off, and
 *  the refusals `auth.test` and `apps.connections.open` document for a token
 *  missing a scope or a grant, or a workspace policy (an IP allowlist, an
 *  admin's suspension, two-factor). Their transient codes — `internal_error`,
 *  `service_unavailable`, a migration in progress — are left to the backoff. */
const FATAL = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'not_allowed_token_type',
  'link_disabled',
  'missing_scope',
  'no_permission',
  'team_access_not_granted',
  'access_denied',
  'accesslimited',
  'ekm_access_denied',
  'enterprise_is_restricted',
  'forbidden_team',
  'two_factor_setup_required',
  'missing_args'
]);

export function fatal(code: string): boolean {
  return FATAL.has(code);
}

/** The Web API as the bot, with the bot token held in this closure. */
export interface SlackApi {
  /** `signal` in place of the messenger's lifetime: the connection asks this
   *  under its own. */
  authTest(signal?: AbortSignal): Promise<wire.Identity>;
  authScopes(signal?: AbortSignal): Promise<BotScopes>;
  fileInfo(file: string, signal: AbortSignal): Promise<wire.FileInfo>;
  /** `chat.postMessage`. One post per channel is in flight at a time, so a
   *  split notice's chunks and successive notices land in order. */
  post(message: OutMessage & { threadTs?: string }): Promise<{ channel: string; ts: string }>;
  update(message: OutMessage & { ts: string }): Promise<void>;
  addReaction(reaction: Reaction, signal?: AbortSignal): Promise<void>;
  removeReaction(reaction: Reaction, signal?: AbortSignal): Promise<void>;
  permalink(channel: string, ts: string): Promise<string>;
  /** `conversations.history`: a channel's messages after `oldest`, every
   *  page up to `HISTORY_PAGES`, each named with `channel`. */
  history(channel: string, oldest: string, signal?: AbortSignal): Promise<wire.MessageEvent[]>;
  /** `conversations.replies`: the thread under `ts`, after `oldest`, the same
   *  way. */
  replies(
    channel: string,
    ts: string,
    oldest: string,
    signal?: AbortSignal
  ): Promise<wire.MessageEvent[]>;
  /** `conversations.replies`: the thread under `ts` older than `latest`, one
   *  page at a time at `THREAD_LIMIT`, oldest first, until the range ends.
   *  No page cap: `signal` is the bound. */
  replyPages(
    channel: string,
    ts: string,
    latest: string,
    signal: AbortSignal
  ): AsyncIterable<wire.MessageEvent[]>;
  /** `users.info`: the display name, else the real name, else `undefined`. */
  userInfo(user: string, signal?: AbortSignal): Promise<string | undefined>;
  /** `signal`, on both upload calls, in place of the messenger's lifetime:
   *  the upload bounds its three calls under one deadline. */
  uploadUrl(
    filename: string,
    length: number,
    signal?: AbortSignal
  ): Promise<{ uploadUrl: string; fileId: string }>;
  completeUpload(
    upload: {
      fileId: string;
      title: string;
      channel: string;
      threadTs?: string;
      initialComment?: string;
    },
    signal?: AbortSignal
  ): Promise<void>;
}

/** `auth.test` for a person: the workspace and bot by name, and the bot
 *  token's scopes when the reply's header names them. */
export type BotScopes = { identity: wire.NamedIdentity; scopes?: readonly string[] };

export type OutMessage = { channel: string; text: string; blocks?: readonly unknown[] };
export type Reaction = { channel: string; timestamp: string; name: string };

/** The most pages one history read takes, at `HISTORY_LIMIT` each: past that
 *  an outage is long enough that what it held is past acting on anyway. */
export const HISTORY_PAGES = 10;
const HISTORY_LIMIT = 200;
/** A page of a joined thread's read: the most objects one
 *  `conversations.replies` call returns to an internal app, which a
 *  manifest-made one is (`docs/reference/messenger_capabilities.md`, Rate
 *  limits). */
export const THREAD_LIMIT = 1000;

/** `lifetime` is read as each call is made, so a call keeps the signal it
 *  started under, a post queued behind another included. */
export function slackApi(
  fetch: Fetch,
  token: string,
  lifetime: () => AbortSignal | undefined = () => undefined
): SlackApi {
  const reply = (
    method: string,
    args: Readonly<Record<string, unknown>>,
    options: { form?: boolean; signal?: AbortSignal } = {}
  ): Promise<Replied> =>
    callForReply(fetch, token, method, args, { signal: lifetime(), ...options });
  const call = async (
    method: string,
    args: Readonly<Record<string, unknown>>,
    options: { form?: boolean; signal?: AbortSignal } = {}
  ): Promise<Readonly<Record<string, unknown>>> => (await reply(method, args, options)).body;
  const lanes = new Map<string, Promise<void>>();

  /** Runs `job` after every earlier job on `channel` has settled. */
  function inLane<T>(channel: string, job: () => Promise<T>): Promise<T> {
    const result = (lanes.get(channel) ?? Promise.resolve()).then(job);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    lanes.set(channel, tail);
    void tail.then(() => {
      if (lanes.get(channel) === tail) {
        lanes.delete(channel);
      }
    });
    return result;
  }

  /** Every page of a read method, in the order Slack gave them, up to
   *  `HISTORY_PAGES`. */
  async function pages(
    method: string,
    channel: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): Promise<wire.MessageEvent[]> {
    const read: wire.MessageEvent[] = [];
    let page = 0;
    for await (const one of walk(method, channel, { ...args, limit: HISTORY_LIMIT }, signal)) {
      read.push(...one);
      if (++page === HISTORY_PAGES) break;
    }
    return read;
  }

  /** Each page of a read method, in the order Slack gave them, until its
   *  cursor runs out. */
  async function* walk(
    method: string,
    channel: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined
  ): AsyncGenerator<wire.MessageEvent[]> {
    let cursor: string | undefined;
    do {
      const body = await call(
        method,
        { ...args, ...(cursor !== undefined && { cursor }) },
        { form: true, ...(signal && { signal }) }
      );
      const one = wire.readPage(body, channel);
      if (one === undefined) {
        throw new SlackError(method, 'unreadable_reply');
      }
      yield one.messages;
      cursor = one.cursor;
    } while (cursor !== undefined);
  }

  return {
    async fileInfo(file, signal) {
      const body = await call('files.info', { file }, { form: true, signal });
      return read('files.info', body, wire.readFileInfo);
    },

    async authTest(signal) {
      const body = await call('auth.test', {}, { form: true, ...(signal && { signal }) });
      const { userId, teamId, botId } = read('auth.test', body, wire.readAuthTest);
      return { userId, teamId, ...(botId !== undefined && { botId }) };
    },

    async authScopes(signal) {
      const { body, scopes } = await reply(
        'auth.test',
        {},
        { form: true, ...(signal && { signal }) }
      );
      return { identity: read('auth.test', body, wire.readAuthTest), ...(scopes && { scopes }) };
    },

    post({ channel, text, blocks, threadTs }) {
      const signal = lifetime();
      return inLane(channel, async () => {
        const body = await call(
          'chat.postMessage',
          {
            channel,
            text,
            ...(blocks && { blocks }),
            ...(threadTs !== undefined && { thread_ts: threadTs }),
            unfurl_links: false,
            unfurl_media: false
          },
          { ...(signal && { signal }) }
        );
        return read('chat.postMessage', body, wire.readPosted);
      });
    },

    async update({ channel, ts, text, blocks }) {
      await call('chat.update', { channel, ts, text, ...(blocks && { blocks }) });
    },

    async addReaction(reaction, signal) {
      try {
        await call('reactions.add', reaction, { ...(signal && { signal }) });
      } catch (error) {
        // Slack documents already_reacted for this token's existing reaction.
        if (!(error instanceof SlackError && error.code === 'already_reacted')) throw error;
      }
    },

    async removeReaction(reaction, signal) {
      try {
        await call('reactions.remove', reaction, { ...(signal && { signal }) });
      } catch (error) {
        // Slack removes only the caller's reaction; no_reaction also covers another author.
        if (!(error instanceof SlackError && error.code === 'no_reaction')) throw error;
      }
    },

    history(channel, oldest, signal) {
      return pages('conversations.history', channel, { channel, oldest }, signal);
    },

    replies(channel, ts, oldest, signal) {
      return pages('conversations.replies', channel, { channel, ts, oldest }, signal);
    },

    replyPages(channel, ts, latest, signal) {
      return walk(
        'conversations.replies',
        channel,
        { channel, ts, latest, inclusive: false, limit: THREAD_LIMIT },
        signal
      );
    },

    async userInfo(user, signal) {
      const body = await call('users.info', { user }, { form: true, ...(signal && { signal }) });
      return wire.readUserInfo(body);
    },

    async permalink(channel, ts) {
      const body = await call('chat.getPermalink', { channel, message_ts: ts }, { form: true });
      return read('chat.getPermalink', body, wire.readPermalink);
    },

    async uploadUrl(filename, length, signal) {
      const body = await call(
        'files.getUploadURLExternal',
        { filename, length },
        { form: true, ...(signal && { signal }) }
      );
      return read('files.getUploadURLExternal', body, wire.readUploadUrl);
    },

    async completeUpload({ fileId, title, channel, threadTs, initialComment }, signal) {
      await call(
        'files.completeUploadExternal',
        {
          files: [{ id: fileId, title }],
          channel_id: channel,
          ...(threadTs !== undefined && { thread_ts: threadTs }),
          ...(initialComment !== undefined && { initial_comment: initialComment })
        },
        { ...(signal && { signal }) }
      );
    }
  };
}

/** `apps.connections.open`, with the app-level token: the `wss://` URL for
 *  one Socket Mode connection. The URL carries a ticket, so it is never
 *  logged. */
export async function openConnection(
  fetch: Fetch,
  appToken: string,
  signal?: AbortSignal
): Promise<string> {
  const body = await callApi(
    fetch,
    appToken,
    'apps.connections.open',
    {},
    {
      form: true,
      ...(signal && { signal })
    }
  );
  return read('apps.connections.open', body, wire.readConnectionUrl);
}

type Outcome =
  | { kind: 'ok'; body: Readonly<Record<string, unknown>>; scopes?: readonly string[] }
  | { kind: 'limited'; retryMs: number }
  | { kind: 'error'; code: string };

/** One request, under `signal` and its own `CALL_MS` deadline. */
async function callOnce(
  fetch: Fetch,
  token: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  form: boolean,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), CALL_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let stop: () => void = () => {};
  const interrupted = new Promise<Outcome>((resolve) => {
    stop = () => resolve({ kind: 'error', code: 'closed' });
  });
  bounded.addEventListener('abort', stop, { once: true });
  try {
    if (bounded.aborted) stop();
    const outcome = await Promise.race([
      request(fetch, token, method, args, form, bounded),
      interrupted
    ]);
    return outcome.kind !== 'ok' && deadline.signal.aborted
      ? { kind: 'error', code: 'timed_out' }
      : outcome;
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener('abort', stop);
  }
}

async function request(
  fetch: Fetch,
  token: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  form: boolean,
  signal: AbortSignal
): Promise<Outcome> {
  let reply: FetchReply;
  try {
    reply = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': form
          ? 'application/x-www-form-urlencoded'
          : 'application/json; charset=utf-8'
      },
      body: form ? formBody(args) : JSON.stringify(args),
      signal
    });
  } catch {
    // What `fetch` threw can name the request; none of it leaves.
    return { kind: 'error', code: 'request_failed' };
  }
  const retryMs = retryAfterMs(reply.headers.get('retry-after'));
  if (reply.status === 429) {
    return { kind: 'limited', retryMs };
  }
  if (reply.status < 200 || reply.status >= 300) {
    return { kind: 'error', code: `http_${reply.status}` };
  }
  const parsed = wire.narrowReply(await reply.json().catch(() => undefined));
  if (parsed.ok) {
    const scopes = scopesOf(reply.headers.get('x-oauth-scopes'));
    return { kind: 'ok', body: parsed.body, ...(scopes && { scopes }) };
  }
  return parsed.error === 'ratelimited'
    ? { kind: 'limited', retryMs }
    : { kind: 'error', code: parsed.error };
}

/** A string as itself and anything else as JSON: `12` for a number, and the
 *  form Slack reads for `blocks` and `files`. */
function formBody(args: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return params.toString();
}

/** `x-oauth-scopes` is the token's scopes, comma-separated. Absent says
 *  nothing about them; present and empty is a token with none. */
function scopesOf(header: string | null): readonly string[] | undefined {
  if (header === null) return undefined;
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
}

/** `Retry-After` is whole seconds. */
function retryAfterMs(header: string | null): number {
  return header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : DEFAULT_RETRY_MS;
}

function read<T>(
  method: string,
  body: Readonly<Record<string, unknown>>,
  reader: (body: Readonly<Record<string, unknown>>) => T | undefined
): T {
  const value = reader(body);
  if (value === undefined) {
    throw new SlackError(method, 'unreadable_reply');
  }
  return value;
}
