import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as util from 'node:util';
import * as api from '../../core/slack/api';
import * as fx from '../fixtures/slack_replies';

const TOKEN = 'xoxb-SENTINEL-bot-0000';
const APP_TOKEN = 'xapp-SENTINEL-app-0000';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Answer = {
  status?: number;
  retryAfter?: string;
  /** The `x-oauth-scopes` header, when the reply carries one. */
  scopes?: string;
  json?: unknown;
  throws?: boolean;
};

/** A `fetch` that records each call and answers it from `answer`, in Slack's
 *  reply shape. */
function recorder(answer: (call: Call, n: number) => Answer | Promise<Answer>): {
  fetch: api.Fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: api.Fetch = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const a = await answer(call, calls.length - 1);
    if (a.throws) {
      throw new Error(`connect ECONNREFUSED ${url} ${init.headers.Authorization ?? ''}`);
    }
    return {
      status: a.status ?? 200,
      headers: {
        get: (name) => {
          const key = name.toLowerCase();
          if (key === 'retry-after') return a.retryAfter ?? null;
          return key === 'x-oauth-scopes' ? (a.scopes ?? null) : null;
        }
      },
      json: () =>
        a.json === undefined
          ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
          : Promise.resolve(a.json)
    };
  };
  return { fetch, calls };
}

/** Lets every pending promise run, without moving the mocked clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function rejection(promise: Promise<unknown>): Promise<api.SlackError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof api.SlackError, `not a SlackError: ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
}

describe('callApi', () => {
  it('POSTs JSON with the bearer token to the named method', async () => {
    const { fetch, calls } = recorder(() => ({ json: fx.postMessage('D0DM00001', '1.2') }));
    const body = await api.callApi(fetch, TOKEN, 'chat.postMessage', {
      channel: 'D0DM00001',
      text: 'hi'
    });
    assert.equal(body.ts, '1.2');
    assert.deepEqual(calls, [
      {
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({ channel: 'D0DM00001', text: 'hi' })
      }
    ]);
  });

  it('form-encodes when asked, a nested value as JSON', async () => {
    const { fetch, calls } = recorder(() => ({ json: fx.uploadUrl() }));
    await api.callApi(
      fetch,
      TOKEN,
      'files.getUploadURLExternal',
      { filename: 'a b.png', length: 12, alt: { x: 1 } },
      { form: true }
    );
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const params = new URLSearchParams(call.body);
    assert.equal(params.get('filename'), 'a b.png');
    assert.equal(params.get('length'), '12');
    assert.equal(params.get('alt'), '{"x":1}');
  });

  it("rejects a non-ok reply with the method and Slack's code", async () => {
    const { fetch } = recorder(() => ({ json: fx.error('channel_not_found') }));
    const error = await rejection(api.callApi(fetch, TOKEN, 'chat.postMessage', {}));
    assert.equal(error.method, 'chat.postMessage');
    assert.equal(error.code, 'channel_not_found');
    assert.equal(error.message, 'chat.postMessage: channel_not_found');
  });

  it('names an HTTP failure, an unreadable body and a network failure by code', async () => {
    const http = recorder(() => ({ status: 500, json: undefined }));
    assert.equal(
      (await rejection(api.callApi(http.fetch, TOKEN, 'auth.test', {}))).code,
      'http_500'
    );
    const garbled = recorder(() => ({ json: undefined }));
    assert.equal(
      (await rejection(api.callApi(garbled.fetch, TOKEN, 'auth.test', {}))).code,
      'unreadable_reply'
    );
    const down = recorder(() => ({ throws: true }));
    assert.equal(
      (await rejection(api.callApi(down.fetch, TOKEN, 'auth.test', {}))).code,
      'request_failed'
    );
  });
});

describe('callApi under a rate limit', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('waits the Retry-After it was given, then retries', async () => {
    const { fetch, calls } = recorder((_, n) =>
      n === 0 ? { status: 429, retryAfter: '2', json: fx.rateLimited() } : { json: fx.authTest() }
    );
    const done = api.callApi(fetch, TOKEN, 'auth.test', {});
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal((await done).user_id, 'U0BOT0001');
  });

  it('treats a ratelimited body like a 429', async () => {
    const { fetch, calls } = recorder((_, n) =>
      n === 0 ? { retryAfter: '1', json: fx.rateLimited() } : { json: fx.authTest() }
    );
    const done = api.callApi(fetch, TOKEN, 'auth.test', {});
    await flush();
    mock.timers.tick(1000);
    await flush();
    assert.equal(calls.length, 2);
    await done;
  });

  it('gives up after three retries', async () => {
    const { fetch, calls } = recorder(() => ({
      status: 429,
      retryAfter: '1',
      json: fx.rateLimited()
    }));
    const done = rejection(api.callApi(fetch, TOKEN, 'chat.postMessage', {}));
    for (let i = 0; i < 5; i++) {
      await flush();
      mock.timers.tick(1000);
    }
    const error = await done;
    assert.equal(calls.length, 4);
    assert.equal(error.code, 'ratelimited');
  });

  it('gives up at once on a wait that would pass 60 s in all', async () => {
    const { fetch, calls } = recorder((_, n) => ({
      status: 429,
      retryAfter: n === 0 ? '45' : '30',
      json: fx.rateLimited()
    }));
    const done = rejection(api.callApi(fetch, TOKEN, 'chat.postMessage', {}));
    await flush();
    mock.timers.tick(45_000);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal((await done).code, 'ratelimited');
    assert.equal(calls.length, 2);
  });

  it('waits a second when Retry-After is missing or unreadable', async () => {
    const { fetch, calls } = recorder((_, n) =>
      n === 0
        ? { status: 429, retryAfter: 'soon', json: fx.rateLimited() }
        : { json: fx.authTest() }
    );
    const done = api.callApi(fetch, TOKEN, 'auth.test', {});
    await flush();
    mock.timers.tick(999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    await done;
  });
});

describe('callApi under its own deadline', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  /** A `fetch` that never answers, and rejects as the global one does once
   *  its signal aborts. */
  const hung: api.Fetch = (_, init) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  it('abandons a request unanswered after CALL_MS, as a call that may have run', async () => {
    const done = rejection(api.callApi(hung, TOKEN, 'chat.postMessage', {}));
    await flush();
    mock.timers.tick(api.CALL_MS - 1);
    await flush();
    let settled = false;
    void done.then(() => (settled = true));
    await flush();
    assert.equal(settled, false, 'gave up before the deadline');
    mock.timers.tick(1);
    const error = await done;
    assert.equal(error.code, 'timed_out');
    assert.equal(api.unanswered(error.code), true);
  });

  it('bounds every call SlackApi makes, under the lifetime signal it was given', async () => {
    const lifetime = new AbortController();
    const slack = api.slackApi(hung, TOKEN, () => lifetime.signal);
    const calls = [
      slack.post({ channel: 'C1', text: 'hi' }),
      slack.update({ channel: 'C1', ts: '1.0', text: 'hi' }),
      slack.permalink('C1', '1.0'),
      slack.uploadUrl('a.txt', 3),
      slack.completeUpload({ fileId: 'F1', title: 'a.txt', channel: 'C1' })
    ].map((call) => rejection(call));
    await flush();
    mock.timers.tick(api.CALL_MS);
    for (const error of await Promise.all(calls)) assert.equal(error.code, 'timed_out');

    const closed = rejection(slack.post({ channel: 'C2', text: 'hi' }));
    await flush();
    lifetime.abort();
    assert.equal((await closed).code, 'closed', 'the lifetime no longer cuts a call short');
  });
});

describe('fatal', () => {
  it('names the codes only a person can clear', () => {
    for (const code of [
      'invalid_auth',
      'not_authed',
      'token_revoked',
      'token_expired',
      'account_inactive',
      'not_allowed_token_type',
      'link_disabled'
    ]) {
      assert.equal(api.fatal(code), true, code);
    }
    for (const code of ['ratelimited', 'request_failed', 'http_503', 'channel_not_found']) {
      assert.equal(api.fatal(code), false, code);
    }
  });
});

describe('fatal, for what only a person can grant', () => {
  it('names the scope, permission and policy refusals Slack documents', () => {
    for (const code of [
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
    ]) {
      assert.equal(api.fatal(code), true, code);
    }
  });

  it('leaves what passes on its own to the backoff', () => {
    for (const code of [
      'internal_error',
      'fatal_error',
      'service_unavailable',
      'request_timeout',
      'team_added_to_org',
      'org_login_required'
    ]) {
      assert.equal(api.fatal(code), false, code);
    }
  });
});

describe('SlackApi', () => {
  it('reads auth.test as the bot user and team', async () => {
    const { fetch, calls } = recorder(() => ({ json: fx.authTest() }));
    const identity = await api.slackApi(fetch, TOKEN).authTest();
    assert.deepEqual(identity, { userId: 'U0BOT0001', teamId: 'T0SQUAD01', botId: 'B0BOT0001' });
    assert.equal(calls[0]?.url, 'https://slack.com/api/auth.test');
  });

  it("reads the bot token's scopes off the reply's header, with the workspace and bot named", async () => {
    const { fetch, calls } = recorder(() => ({
      json: fx.authTest(),
      scopes: 'chat:write,im:history, commands'
    }));
    const checked = await api.slackApi(fetch, TOKEN).authScopes();
    assert.deepEqual(checked, {
      identity: {
        userId: 'U0BOT0001',
        teamId: 'T0SQUAD01',
        botId: 'B0BOT0001',
        team: 'Squad',
        user: 'squadron'
      },
      scopes: ['chat:write', 'im:history', 'commands']
    });
    assert.equal(calls[0]?.url, 'https://slack.com/api/auth.test');
  });

  it('reports no scopes, and no error, when the reply has no scope header', async () => {
    const { fetch } = recorder(() => ({ json: fx.authTest() }));
    const checked = await api.slackApi(fetch, TOKEN).authScopes();
    assert.equal(checked.scopes, undefined);
    assert.equal(checked.identity.team, 'Squad');
  });

  it('keeps authTest to the three ids when the reply names them and carries scopes', async () => {
    const { fetch } = recorder(() => ({ json: fx.authTest(), scopes: 'chat:write' }));
    const identity = await api.slackApi(fetch, TOKEN).authTest();
    assert.deepEqual(identity, { userId: 'U0BOT0001', teamId: 'T0SQUAD01', botId: 'B0BOT0001' });
  });

  it('reads users.info as a display name, on a form', async () => {
    const { fetch, calls } = recorder(() => ({
      json: {
        ok: true,
        user: { id: 'U0OWNER01', real_name: 'Ada Lovelace', profile: { display_name: 'Ada' } }
      }
    }));
    assert.equal(await api.slackApi(fetch, TOKEN).userInfo('U0OWNER01'), 'Ada');
    const call = calls[0];
    assert.equal(call?.url, 'https://slack.com/api/users.info');
    assert.equal(call?.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(call?.body).get('user'), 'U0OWNER01');
  });

  it('throws missing_scope from users.info as a SlackError', async () => {
    const { fetch } = recorder(() => ({ json: fx.error('missing_scope') }));
    const error = await rejection(api.slackApi(fetch, TOKEN).userInfo('U0OWNER01'));
    assert.equal(error.method, 'users.info');
    assert.equal(error.code, 'missing_scope');
  });

  it('posts with unfurls off and the thread in Slack spelling', async () => {
    const { fetch, calls } = recorder(() => ({
      json: fx.postMessage('D0DM00001', '1760000001.000100')
    }));
    const posted = await api.slackApi(fetch, TOKEN).post({
      channel: 'U0OWNER01',
      text: 'hi',
      blocks: [{ type: 'markdown', text: 'hi' }],
      threadTs: '1760000000.000100'
    });
    assert.deepEqual(posted, { channel: 'D0DM00001', ts: '1760000001.000100' });
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
      channel: 'U0OWNER01',
      text: 'hi',
      blocks: [{ type: 'markdown', text: 'hi' }],
      thread_ts: '1760000000.000100',
      unfurl_links: false,
      unfurl_media: false
    });
  });

  it('updates, links, and runs the two upload calls', async () => {
    const { fetch, calls } = recorder((call) => {
      const method = call.url.split('/').pop();
      if (method === 'chat.update') return { json: fx.update('D0DM00001', '1.2') };
      if (method === 'chat.getPermalink') return { json: fx.permalink('D0DM00001') };
      if (method === 'files.getUploadURLExternal') return { json: fx.uploadUrl() };
      return { json: fx.completeUpload() };
    });
    const slack = api.slackApi(fetch, TOKEN);
    await slack.update({ channel: 'D0DM00001', ts: '1.2', text: 'settled', blocks: [] });
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
      channel: 'D0DM00001',
      ts: '1.2',
      text: 'settled',
      blocks: []
    });
    assert.equal(
      await slack.permalink('D0DM00001', '1760000000.000100'),
      'https://squad.slack.com/archives/D0DM00001/p1760000000000100'
    );
    assert.equal(calls[1]?.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1]?.body)), {
      channel: 'D0DM00001',
      message_ts: '1760000000.000100'
    });
    assert.deepEqual(await slack.uploadUrl('shot.png', 12), {
      uploadUrl: 'https://files.slack.com/upload/v1/fixture-upload',
      fileId: 'F0FILE0002'
    });
    assert.equal(calls[2]?.headers['Content-Type'], 'application/x-www-form-urlencoded');
    await slack.completeUpload({
      fileId: 'F0FILE0002',
      title: 'shot.png',
      channel: 'D0DM00001',
      threadTs: '1760000000.000100',
      initialComment: 'here'
    });
    assert.deepEqual(JSON.parse(calls[3]?.body ?? ''), {
      files: [{ id: 'F0FILE0002', title: 'shot.png' }],
      channel_id: 'D0DM00001',
      thread_ts: '1760000000.000100',
      initial_comment: 'here'
    });
  });

  it('rejects a reply missing the field it was called for', async () => {
    const { fetch } = recorder(() => ({ json: { ok: true } }));
    const slack = api.slackApi(fetch, TOKEN);
    for (const [method, call] of [
      ['auth.test', slack.authTest()],
      ['chat.postMessage', slack.post({ channel: 'D0DM00001', text: 'x' })],
      ['chat.getPermalink', slack.permalink('D0DM00001', '1.2')],
      ['files.getUploadURLExternal', slack.uploadUrl('a', 1)],
      ['apps.connections.open', api.openConnection(fetch, APP_TOKEN)]
    ] as const) {
      const error = await rejection(call);
      assert.deepEqual([error.method, error.code], [method, 'unreadable_reply']);
    }
  });

  it('opens a Socket Mode connection with the app token', async () => {
    const { fetch, calls } = recorder(() => ({ json: fx.connectionsOpen() }));
    const url = await api.openConnection(fetch, APP_TOKEN);
    assert.match(url, /^wss:\/\//);
    assert.equal(calls[0]?.headers.Authorization, `Bearer ${APP_TOKEN}`);
    assert.equal(calls[0]?.url, 'https://slack.com/api/apps.connections.open');
  });
});

describe('SlackApi reads history', () => {
  const row = (ts: string, over: Record<string, unknown> = {}) => ({
    type: 'message',
    user: 'U0OWNER01',
    text: `at ${ts}`,
    ts,
    ...over
  });

  it('pages history by cursor, after oldest, and names the channel on each message', async () => {
    const { fetch, calls } = recorder((_, n) => ({
      json:
        n === 0
          ? fx.messages([row('1760000300.000200')], 'page2')
          : fx.messages([row('1760000300.000100')])
    }));
    const read = await api.slackApi(fetch, TOKEN).history('D0DM00001', '1760000000.000000');
    assert.deepEqual(
      read.map((m) => [m.channel, m.ts]),
      [
        ['D0DM00001', '1760000300.000200'],
        ['D0DM00001', '1760000300.000100']
      ]
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://slack.com/api/conversations.history', 'https://slack.com/api/conversations.history']
    );
    const first = new URLSearchParams(calls[0]?.body);
    assert.equal(first.get('channel'), 'D0DM00001');
    assert.equal(first.get('oldest'), '1760000000.000000');
    assert.equal(first.get('cursor'), null);
    assert.equal(new URLSearchParams(calls[1]?.body).get('cursor'), 'page2');
  });

  it("reads a thread's replies after oldest", async () => {
    const { fetch, calls } = recorder(() => ({
      json: fx.messages([row('1760000300.000300', { thread_ts: '1760000000.000100' })])
    }));
    const read = await api
      .slackApi(fetch, TOKEN)
      .replies('D0DM00001', '1760000000.000100', '1760000000.000000');
    assert.deepEqual(
      read.map((m) => [m.threadTs, m.ts]),
      [['1760000000.000100', '1760000300.000300']]
    );
    const args = new URLSearchParams(calls[0]?.body);
    assert.equal(calls[0]?.url, 'https://slack.com/api/conversations.replies');
    assert.equal(args.get('ts'), '1760000000.000100');
    assert.equal(args.get('oldest'), '1760000000.000000');
  });

  it("pages a thread's replies before latest to the end of the range, past the page limit", async () => {
    const pages = api.HISTORY_PAGES + 2;
    const { fetch, calls } = recorder((_, n) => ({
      json: fx.messages(
        [row(`1760000300.${String(n).padStart(6, '0')}`)],
        n + 1 < pages ? `page${n + 1}` : ''
      )
    }));
    const read = [];
    for await (const page of api
      .slackApi(fetch, TOKEN)
      .replyPages(
        'C0CHAN001',
        '1760000000.000100',
        '1760000900.000100',
        new AbortController().signal
      )) {
      read.push(...page);
    }
    assert.equal(read.length, pages);
    assert.equal(calls.length, pages);
    const first = new URLSearchParams(calls[0]?.body);
    assert.equal(first.get('ts'), '1760000000.000100');
    assert.equal(first.get('latest'), '1760000900.000100');
    assert.equal(first.get('inclusive'), 'false');
    assert.equal(first.get('limit'), String(api.THREAD_LIMIT));
    assert.equal(first.get('oldest'), null);
    assert.equal(new URLSearchParams(calls.at(-1)?.body).get('cursor'), `page${pages - 1}`);
  });

  it('skips a row it cannot read, and stops at a page limit', async () => {
    const { fetch, calls } = recorder(() => ({
      json: fx.messages([row('not-a-ts'), row('1760000300.000100')], 'again')
    }));
    const read = await api.slackApi(fetch, TOKEN).history('D0DM00001', '1760000000.000000');
    assert.equal(calls.length, api.HISTORY_PAGES);
    assert.equal(read.length, api.HISTORY_PAGES);
  });
});

describe('SlackApi keeps one post in flight per channel', () => {
  /** A fetch whose replies wait until the test releases them, in order. */
  function held(): { fetch: api.Fetch; calls: Call[]; release: () => void } {
    const gates: (() => void)[] = [];
    let ts = 0;
    const { fetch, calls } = recorder((call) => {
      const channel = (JSON.parse(call.body) as { channel: string }).channel;
      const reply = fx.postMessage(channel, `1760000000.00000${++ts}`);
      return new Promise<Answer>((resolve) => gates.push(() => resolve({ json: reply })));
    });
    return { fetch, calls, release: () => gates.shift()?.() };
  }

  it('serialises two posts to one channel', async () => {
    const { fetch, calls, release } = held();
    const slack = api.slackApi(fetch, TOKEN);
    const first = slack.post({ channel: 'D0DM00001', text: 'one' });
    const second = slack.post({ channel: 'D0DM00001', text: 'two' });
    await flush();
    assert.equal(calls.length, 1);
    release();
    await first;
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1]?.body ?? '').text, 'two');
    release();
    await second;
  });

  it('runs posts to two channels side by side', async () => {
    const { fetch, calls, release } = held();
    const slack = api.slackApi(fetch, TOKEN);
    const a = slack.post({ channel: 'D0DM00001', text: 'a' });
    const b = slack.post({ channel: 'C0CHAN001', text: 'b' });
    await flush();
    assert.equal(calls.length, 2);
    release();
    release();
    await Promise.all([a, b]);
  });

  it('lets the next post run after one fails', async () => {
    const { fetch, calls } = recorder((_, n) =>
      n === 0 ? { json: fx.error('msg_too_long') } : { json: fx.postMessage('D0DM00001', '1.3') }
    );
    const slack = api.slackApi(fetch, TOKEN);
    const first = rejection(slack.post({ channel: 'D0DM00001', text: 'one' }));
    const second = slack.post({ channel: 'D0DM00001', text: 'two' });
    assert.equal((await first).code, 'msg_too_long');
    assert.equal((await second).ts, '1.3');
    assert.equal(calls.length, 2);
  });
});

describe('the token never leaves in an error', () => {
  it('appears in no thrown message, name or stack, on every failure path', async () => {
    const answers: Answer[] = [
      { json: fx.error('invalid_auth') },
      { status: 500, json: undefined },
      { json: undefined },
      { throws: true },
      { json: { ok: true } }
    ];
    for (const answer of answers) {
      const { fetch } = recorder(() => answer);
      const slack = api.slackApi(fetch, TOKEN);
      for (const call of [
        slack.authTest(),
        slack.post({ channel: 'D0DM00001', text: 'x' }),
        api.openConnection(fetch, APP_TOKEN)
      ]) {
        const error = await rejection(call);
        const said = `${util.inspect(error, { depth: 5 })} ${JSON.stringify(error)}`;
        assert.doesNotMatch(said, /SENTINEL/);
      }
    }
  });
});
