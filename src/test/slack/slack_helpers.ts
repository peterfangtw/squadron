import type { Button } from '../../core/bridge/model';
import * as messenger from '../../core/slack/messenger';
import type * as socket from '../../core/slack/socket';
import * as wire from '../../core/slack/wire';
import type { Observed, PortFixture, PortHarness } from '../bridge/bridge_helpers';
import * as env from '../fixtures/slack_envelopes';
import * as fx from '../fixtures/slack_replies';

export const BOT_TOKEN = 'xoxb-SENTINEL-bot-0000';
export const APP_TOKEN = 'xapp-SENTINEL-app-0000';
export const CREDENTIALS = { botToken: BOT_TOKEN, appToken: APP_TOKEN };

/** One Web API call as Slack received it, its body parsed back. */
export type ApiCall = {
  method: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
};

/** One upload of bytes to the URL `files.getUploadURLExternal` handed out. */
export type UploadCall = { url: string; headers: Record<string, string>; bytes: Uint8Array };

/** A socket the test plays Slack's side of. `close` and `terminate` only
 *  record; `drop` is the close event. */
export class FakeSocket implements socket.SocketLike {
  sent: string[] = [];
  closedWith?: number;

  constructor(
    readonly url: string,
    private readonly events: socket.SocketEvents
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }
  ping(): void {
    this.events.alive();
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.closedWith = -1;
  }

  frame(value: unknown): void {
    this.events.message(JSON.stringify(value));
  }
  drop(): void {
    this.events.close();
  }
  /** The envelope ids this socket acked, in order. */
  acks(): string[] {
    return this.sent.flatMap((text) => {
      const parsed = JSON.parse(text) as { envelope_id?: unknown };
      return typeof parsed.envelope_id === 'string' ? [parsed.envelope_id] : [];
    });
  }
}

/** One `chat.postMessage` and where it landed. */
export type Landed = { args: Record<string, unknown>; channel: string; ts: string };

export type FakeSlack = {
  deps: messenger.SlackDeps;
  calls: ApiCall[];
  /** Every `chat.postMessage`, with the channel and ts Slack answered. */
  posted: Landed[];
  uploads: UploadCall[];
  sockets: FakeSocket[];
  /** The newest socket the adapter has not closed, once it has opened one. */
  socket(): Promise<FakeSocket>;
  /** Every ack across every socket. */
  acked(): number;
  /** Messages people sent, as history holds them: what
   *  `conversations.history` and `.replies` answer from. */
  said: Record<string, unknown>[];
  /** Display names `users.info` answers, by member id. An id with none is
   *  `user_not_found`. */
  names: Record<string, string>;
};

/**
 * Slack's side of the adapter: a `fetch` that answers the Web API in Slack's
 * own reply shape (`fixtures/slack_replies.ts`) and records each call, and a
 * socket opener the test drives. `chat.postMessage` to a user id lands in the
 * bot DM, as Slack's does, and each post gets the next `ts`.
 *
 * `refuse` names methods that answer `ok: false` with the given code,
 * `limited` methods that answer every call `429` with `Retry-After`
 * (`retryAfter`, default `1`), and `throws` methods whose `fetch` rejects,
 * naming the request's headers as a careless network error would.
 * `conversations.history` and `.replies` answer from `said` between `oldest`
 * and `latest` (both exclusive), `limit` rows a page behind a cursor;
 * `parentEveryPage` puts a thread's parent at the top of each later page too.
 */
export function fakeSlack(
  options: {
    refuse?: Readonly<Record<string, string>>;
    limited?: readonly string[];
    /** `Retry-After` for `limited`, in seconds. Default `1`. */
    retryAfter?: string;
    throws?: readonly string[];
    /** Each later page of `conversations.replies` repeats the parent. */
    parentEveryPage?: boolean;
    /** The upload URL never answers, and fails once its signal aborts. */
    hangUploads?: boolean;
  } = {}
): FakeSlack {
  const calls: ApiCall[] = [];
  const posted: Landed[] = [];
  const uploads: UploadCall[] = [];
  const sockets: FakeSocket[] = [];
  const said: Record<string, unknown>[] = [];
  const names: Record<string, string> = {};
  let posts = 0;

  const reply = (json: unknown, status = 200) => ({
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(json)
  });

  const fetch = (
    url: string,
    init: {
      method: 'POST';
      headers: Record<string, string>;
      body: string | Uint8Array<ArrayBuffer>;
      signal?: AbortSignal;
    }
  ) => {
    if (options.throws?.some((name) => url.endsWith(name))) {
      return Promise.reject(
        new Error(`connect ECONNREFUSED ${url} ${JSON.stringify(init.headers)}`)
      );
    }
    if (!url.startsWith('https://slack.com/api/')) {
      uploads.push({ url, headers: init.headers, bytes: init.body as Uint8Array });
      if (options.hangUploads) {
        return new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          });
        });
      }
      return Promise.resolve(reply(undefined));
    }
    const method = url.slice('https://slack.com/api/'.length);
    const args = parseBody(init.headers, init.body as string);
    calls.push({ method, args, headers: init.headers });
    if (options.limited?.includes(method)) {
      return Promise.resolve({
        ...reply(undefined, 429),
        headers: { get: () => options.retryAfter ?? '1' }
      });
    }
    const refused = options.refuse?.[method];
    return Promise.resolve(reply(refused === undefined ? answer(method, args) : fx.error(refused)));
  };

  const answer = (method: string, args: Record<string, unknown>): unknown => {
    switch (method) {
      case 'auth.test':
        return fx.authTest();
      case 'apps.connections.open':
        return fx.connectionsOpen();
      case 'chat.postMessage': {
        const to = String(args.channel);
        const channel = /^[UW]/.test(to) ? env.DM : to;
        const ts = `1760000100.${String(++posts).padStart(6, '0')}`;
        posted.push({ args, channel, ts });
        return fx.postMessage(channel, ts);
      }
      case 'reactions.add':
      case 'reactions.remove':
        return { ok: true };
      case 'chat.update':
        return fx.update(String(args.channel), String(args.ts));
      case 'chat.getPermalink':
        return {
          ok: true,
          channel: args.channel,
          permalink: `https://squad.slack.com/archives/${String(args.channel)}/p${String(args.message_ts).replace('.', '')}`
        };
      case 'files.getUploadURLExternal':
        return fx.uploadUrl();
      case 'files.completeUploadExternal':
        return fx.completeUpload();
      case 'users.info': {
        const name = names[String(args.user)];
        return name === undefined
          ? fx.error('user_not_found')
          : { ok: true, user: { id: args.user, profile: { display_name: name } } };
      }
      case 'conversations.history':
      case 'conversations.replies': {
        const oldest = Number(args.oldest ?? 0);
        const latest = args.latest === undefined ? Infinity : Number(args.latest);
        const thread = method === 'conversations.replies' ? String(args.ts) : undefined;
        const rows = said.filter(
          (row) =>
            row.channel === args.channel &&
            Number(row.ts) > oldest &&
            Number(row.ts) < latest &&
            (thread === undefined
              ? row.thread_ts === undefined || row.thread_ts === row.ts
              : row.thread_ts === thread || row.ts === thread)
        );
        // History is newest first, a thread oldest first, as Slack answers.
        const ordered = thread === undefined ? [...rows].reverse() : rows;
        const start = Number(args.cursor ?? 0);
        const end = start + Number(args.limit ?? ordered.length);
        const parent =
          options.parentEveryPage && start > 0 ? ordered.filter((row) => row.ts === thread) : [];
        return fx.messages(
          [...parent, ...ordered.slice(start, end)].map(
            ({ channel: _c, channel_type: _t, ...row }) => row
          ),
          end < ordered.length ? String(end) : ''
        );
      }
      default:
        return fx.error('unknown_method');
    }
  };

  const openSocket: socket.OpenSocket = (url, events) => {
    const fake = new FakeSocket(url, events);
    sockets.push(fake);
    return fake;
  };

  return {
    deps: { fetch, openSocket },
    calls,
    posted,
    uploads,
    sockets,
    said,
    names,
    async socket() {
      for (let spin = 0; spin < 100; spin++) {
        const newest = sockets.at(-1);
        if (newest && newest.closedWith === undefined) return newest;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('the adapter opened no socket');
    },
    acked: () => sockets.reduce((sum, s) => sum + s.acks().length, 0)
  };
}

/** A JSON body as itself; a form with an array or object value read back
 *  from its JSON, as Slack reads `blocks` and `files`. */
function parseBody(headers: Record<string, string>, body: string): Record<string, unknown> {
  if ((headers['Content-Type'] ?? '').startsWith('application/json')) {
    return JSON.parse(body) as Record<string, unknown>;
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    args[key] = /^[[{]/.test(value) ? (JSON.parse(value) as unknown) : value;
  }
  return args;
}

/** The method names of `calls`, in order. */
export function methods(calls: readonly ApiCall[]): string[] {
  return calls.map((call) => call.method);
}

/**
 * The Slack adapter as a `PortHarness`: each fixture becomes the envelope
 * Slack would send for it, on the socket the adapter opened, and what was
 * posted is read back off the recorded `chat.postMessage` and `chat.update`
 * bodies. Provisional with the fixtures it builds on (M1 Notes).
 */
export function slackHarness(): PortHarness & { fake: FakeSlack } {
  const fake = fakeSlack();
  const slack = messenger.slackMessenger(CREDENTIALS, fake.deps);
  const greeted = new WeakSet<FakeSocket>();
  let ids = 0;

  /** The open socket, said hello on once, as Slack opens each one. */
  const live = async (): Promise<FakeSocket> => {
    const ws = await fake.socket();
    if (!greeted.has(ws)) {
      greeted.add(ws);
      ws.frame(env.hello());
    }
    return ws;
  };

  return {
    fake,
    messenger: slack,
    async inject(fixture: PortFixture) {
      if (fixture.kind === 'missed') {
        const frame = envelopeFor(fixture, ++ids);
        const event = (frame.payload as { event: Record<string, unknown> }).event;
        fake.said.push(event);
        return;
      }
      const ws = await live();
      ws.frame(envelopeFor(fixture, ++ids));
    },
    observed: () => observe(fake),
    acked: () => fake.acked()
  };
}

/** What Slack sends when a person does `fixture`. */
function envelopeFor(fixture: PortFixture, n: number): Record<string, unknown> {
  // A millisecond apart, as two messages a person sends are: `at` is whole
  // milliseconds.
  const ts = `1760000200.${String(n * 1000).padStart(6, '0')}`;
  const ids = { envelopeId: `harness-${n}`, eventId: `EvHARNESS${n}` };
  switch (fixture.kind) {
    case 'reply':
    case 'missed': {
      const [team, user] = fixture.sender.split(':');
      const thread = refOf(fixture.to.anchor);
      return env.eventsApi(
        {
          ...env.dmThreadReply(),
          text: fixture.text,
          user,
          team,
          channel: thread.channel,
          ts,
          event_ts: ts,
          thread_ts: thread.ts
        },
        ids
      );
    }
    case 'press': {
      const [team, user] = fixture.sender.split(':');
      const on = refOf(fixture.on.message);
      const frame = env.blockActions();
      const payload = frame.payload as Record<string, unknown>;
      const [action] = payload.actions as Record<string, unknown>[];
      return {
        ...frame,
        envelope_id: ids.envelopeId,
        payload: {
          ...payload,
          user: { id: user, username: 'owner', name: 'owner', team_id: team },
          container: {
            type: 'message',
            message_ts: on.ts,
            channel_id: on.channel,
            is_ephemeral: false
          },
          actions: [{ ...action, value: fixture.payload }]
        }
      };
    }
    case 'echo': {
      const of = refOf(fixture.of.message);
      return env.eventsApi(
        { ...env.botEcho(), channel: of.channel, ts: of.ts, event_ts: of.ts },
        ids
      );
    }
  }
}

function refOf(ref: string): { channel: string; ts: string } {
  const parsed = wire.parseRef(ref);
  if (parsed === undefined) throw new Error(`not a Slack ref: ${ref}`);
  return parsed;
}

/** The recorded posts, one entry per notice: a post that is not a reply in
 *  an earlier notice's thread starts one. Each post's blocks are its latest,
 *  so a settle's `chat.update` shows. */
function observe(fake: FakeSlack): Observed[] {
  const notices: { first: Landed; posts: Landed[] }[] = [];
  for (const post of fake.posted) {
    const owner = notices.find(
      (notice) => notice.first.channel === post.channel && post.args.thread_ts === notice.first.ts
    );
    if (owner) owner.posts.push(post);
    else notices.push({ first: post, posts: [post] });
  }
  return notices.map(({ posts }) => {
    const views = posts.map((post) => blocksNow(fake, post));
    const last = views.at(-1) ?? [];
    const settled = last.find((block) => block.type === 'context');
    const lastPost = posts.at(-1);
    return {
      message: lastPost ? `${lastPost.channel}:${lastPost.ts}` : '',
      parts: views.map(visible),
      buttons: buttonsIn(last),
      ...(settled === undefined ? {} : { settled: contextText(settled) })
    };
  });
}

type Block = Record<string, unknown>;

function blocksNow(fake: FakeSlack, post: Landed): Block[] {
  const update = fake.calls
    .filter(
      (call) =>
        call.method === 'chat.update' &&
        call.args.channel === post.channel &&
        call.args.ts === post.ts
    )
    .at(-1);
  return ((update ?? post).args.blocks ?? []) as Block[];
}

/** What a person reads in one post, entities read back as characters. */
function visible(blocks: readonly Block[]): string {
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case 'section':
          return [unescape((block.text as { text: string }).text)];
        case 'markdown':
          return [unescape(block.text as string)];
        case 'rich_text':
          return [JSON.stringify(block.elements)];
        default:
          return [];
      }
    })
    .join('\n');
}

function buttonsIn(blocks: readonly Block[]): Button[] {
  const actions = blocks.find((block) => block.type === 'actions');
  const elements = (actions?.elements ?? []) as Record<string, unknown>[];
  return elements.map((element) => ({
    label: (element.text as { text: string }).text,
    payload: element.value as string,
    ...(element.style === 'danger' ? { tone: 'danger' as const } : {})
  }));
}

function contextText(block: Block): string {
  const [element] = block.elements as { text: string }[];
  return unescape(element?.text ?? '');
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
