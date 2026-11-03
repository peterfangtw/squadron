import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Inbound, Notice } from '../../core/bridge/model';
import type { LinkState, Messenger, SetupCheck } from '../../core/bridge/port';
import * as port from '../../core/bridge/port';
import * as api from '../../core/slack/api';
import * as manifest from '../../core/slack/manifest';
import * as messenger from '../../core/slack/messenger';
import * as render from '../../core/slack/render';
import * as env from '../fixtures/slack_envelopes';
import * as fx from '../fixtures/slack_replies';
import { APP_TOKEN, BOT_TOKEN, CREDENTIALS, fakeSlack, methods } from './slack_helpers';

const OWNER = `${env.TEAM}:${env.OWNER}`;

function slackOn(fake = fakeSlack()): { slack: Messenger; fake: ReturnType<typeof fakeSlack> } {
  return { slack: messenger.slackMessenger(CREDENTIALS, fake.deps), fake };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('the Slack entry', () => {
  it('is registered as slack, listed, with its name', () => {
    const entry = port.messenger('slack');
    assert.equal(entry, messenger.slackEntry);
    assert.equal(entry?.listed, true);
    assert.equal(entry?.label, 'Slack');
    assert.ok(port.messengers().includes(messenger.slackEntry));
  });

  it('asks for the two tokens, each with its prefix in the label', () => {
    const { fields } = messenger.slackEntry.setup;
    assert.deepEqual(
      fields.map((field) => field.key),
      ['botToken', 'appToken']
    );
    assert.ok(fields[0]?.label.includes('xoxb-'));
    assert.ok(fields[1]?.label.includes('xapp-'));
  });

  it('says where each token comes from, the app-level one with its scope', () => {
    const [bot, app] = messenger.slackEntry.setup.fields;
    assert.equal(bot?.help, 'Bot User OAuth Token, from Install App. Starts xoxb-.');
    assert.equal(
      app?.help,
      `From Basic Information, App-Level Tokens, with ${manifest.APP_TOKEN_SCOPE}. Starts xapp-.`
    );
  });

  it('asks for a member id alone, keeping team:user for a guest from another workspace', () => {
    const { sender } = messenger.slackEntry.setup;
    assert.match(sender.help, /member id/);
    assert.match(sender.help, /T…:U…/);
    assert.match(sender.placeholder ?? '', /^U[A-Z0-9]+$/);
    assert.equal(sender.space?.label, 'Workspace');
    assert.match(sender.space?.placeholder ?? '', /^T[A-Z0-9]+$/);
  });

  it('carries the manifest to copy and the steps to make the app', () => {
    const create = messenger.slackEntry.setup.create;
    assert.ok(create);
    assert.ok(create.steps.length >= 3);
    assert.deepEqual(JSON.parse(create.copy?.text ?? ''), manifest.slackManifest());
    assert.equal(create.link, manifest.manifestUrl());
  });

  it('titles each step to make the app', () => {
    const steps = messenger.slackEntry.setup.create?.steps ?? [];
    assert.ok(steps.every((step) => step.title.length > 0 && step.text.length > 0));
  });

  it("lists an existing app's configuration from the manifest it would be created from", () => {
    const m = manifest.slackManifest();
    const rows = new Map(
      (messenger.slackEntry.setup.create?.existing ?? []).map((row) => [row.label, row.value])
    );
    assert.equal(rows.get('Bot scopes'), m.oauth_config.scopes.bot.join(', '));
    assert.equal(rows.get('Bot events'), m.settings.event_subscriptions.bot_events.join(', '));
    assert.equal(rows.get('Slash command'), manifest.SLASH_COMMAND);
    assert.equal(rows.get('Socket Mode'), 'on');
    assert.equal(rows.get('Interactivity'), 'on');
    assert.equal(rows.get('App Home'), 'Messages tab on, not read-only');
  });

  it('names the app-level scope from one constant, in the step and the existing rows', () => {
    const create = messenger.slackEntry.setup.create;
    const scope = manifest.APP_TOKEN_SCOPE;
    assert.equal(scope, 'connections:write');
    assert.ok(create?.steps[1]?.text.includes(scope));
    assert.equal(create?.existing?.find((row) => row.label === 'App-level token')?.value, scope);
  });

  it('explains how an existing app enables message reactions', () => {
    const rows = messenger.slackEntry.setup.create?.existing ?? [];
    const guidance = rows.find((row) => row.label === 'Message reactions')?.value ?? '';
    assert.match(guidance, /reactions:write/);
    assert.match(guidance, /reinstall/i);
  });

  it('explains how an existing app enables thread context', () => {
    const rows = messenger.slackEntry.setup.create?.existing ?? [];
    const guidance = rows.find((row) => row.label === 'Thread context')?.value ?? '';
    assert.match(guidance, /channels:history/);
    assert.match(guidance, /groups:history/);
    assert.doesNotMatch(guidance, /users:read/);
    assert.match(guidance, /reinstall/i);
  });

  it('explains how an existing app enables author names', () => {
    const rows = messenger.slackEntry.setup.create?.existing ?? [];
    const guidance = rows.find((row) => row.label === 'Author names')?.value ?? '';
    assert.match(guidance, /users:read/);
    assert.match(guidance, /reinstall/i);
  });

  it('creates a messenger from two well-formed tokens', async (t) => {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(fx.authTest())));
    const created = await messenger.slackEntry.create(CREDENTIALS);
    assert.equal(created.ok, true);
    if (created.ok) assert.equal(created.messenger.id, 'slack');
  });

  it('refuses a missing token, a wrong prefix and a swapped pair, in a sentence', async () => {
    const cases: Record<string, string>[] = [
      { appToken: APP_TOKEN },
      { botToken: BOT_TOKEN },
      { botToken: 'xoxp-user-token', appToken: APP_TOKEN },
      { botToken: BOT_TOKEN, appToken: 'xoxb-another' },
      { botToken: APP_TOKEN, appToken: BOT_TOKEN }
    ];
    const reasons = await Promise.all(
      cases.map(async (credentials) => {
        const created = await messenger.slackEntry.create(credentials);
        assert.equal(created.ok, false, JSON.stringify(credentials));
        return created.ok ? '' : created.reason;
      })
    );
    for (const reason of reasons) {
      assert.match(reason, /^[A-Z].*\.$/);
      assert.ok(!reason.includes('SENTINEL'), reason);
    }
    assert.match(reasons[4] ?? '', /swapped|wrong way round/);
  });
});

describe('a Slack account', () => {
  const { accounts } = messenger.slackEntry;

  it('is a member id, U… or an Enterprise Grid W…', () => {
    for (const account of ['U0123ABCD', 'W0123ABCD']) {
      assert.equal(accounts.refuse(account), undefined, account);
    }
  });

  it('is a whole team:user sender id as it stands, for a guest and for a list from before', () => {
    assert.equal(accounts.refuse(`${env.GUEST_TEAM}:${env.GUEST}`), undefined);
    assert.equal(
      accounts.sender(`${env.GUEST_TEAM}:${env.GUEST}`, env.TEAM),
      `${env.GUEST_TEAM}:${env.GUEST}`
    );
  });

  it('is composed with the workspace into the sender a message from it carries', () => {
    assert.equal(accounts.sender(env.OWNER, env.TEAM), OWNER);
  });

  it('waits on the workspace when it is a member id alone', () => {
    assert.equal(accounts.sender(env.OWNER, undefined), undefined);
  });

  it('refuses what is not one, saying what one looks like', () => {
    const cases: [string, RegExp][] = [
      ['T0SQUAD01', /workspace id/],
      ['peter@example.com', /not a name or an email/],
      ['@peter', /not a name or an email/],
      ['u0123abcd', /capitals/],
      ['T0SQUAD01:peter', /starts with U/],
      ['T0SQUAD01:U1:U2', /starts with U/],
      ['C0123ABCD', /starts with U/]
    ];
    for (const [account, reason] of cases) {
      assert.match(accounts.refuse(account) ?? '', reason, account);
      assert.match(accounts.refuse(account) ?? '', /^[A-Z].*\.$/, account);
    }
  });

  it('takes a T… or E… workspace and refuses anything else', () => {
    assert.equal(accounts.refuseSpace('T0SQUAD01'), undefined);
    assert.equal(accounts.refuseSpace('E0GRID001'), undefined);
    for (const space of ['U0OWNER01', 't0squad01', 'squad', '']) {
      assert.match(accounts.refuseSpace(space) ?? '', /starts with T/, space);
    }
  });

  it('only ever composes a sender a notice can mention and open a DM to', () => {
    const accepted = ['U0123ABCD', 'W0123ABCD', `${env.GUEST_TEAM}:${env.GUEST}`];
    for (const account of accepted) {
      const id = accounts.sender(account, env.TEAM);
      assert.ok(id !== undefined && render.userOf(id) !== undefined, account);
    }
  });
});

describe('the Slack setup check', () => {
  type Reply = { status?: number; json?: unknown; scopes?: string; retryAfter?: string };
  const SCOPES = manifest.slackManifest().oauth_config.scopes.bot;
  const OK: Record<string, Reply> = {
    'apps.connections.open': { json: fx.connectionsOpen() },
    'auth.test': { json: fx.authTest(), scopes: SCOPES.join(',') }
  };

  /** A `fetch` answering each Web API method from `replies`, recording the
   *  method and the bearer it was asked with. */
  function slackFor(replies: Record<string, Reply>): {
    fetch: api.Fetch;
    asked: { method: string; auth: string }[];
  } {
    const asked: { method: string; auth: string }[] = [];
    const fetch: api.Fetch = (url, init) => {
      const method = url.slice('https://slack.com/api/'.length);
      asked.push({ method, auth: init.headers.Authorization ?? '' });
      const reply = replies[method] ?? { status: 404 };
      const headers: Record<string, string | undefined> = {
        'x-oauth-scopes': reply.scopes,
        'retry-after': reply.retryAfter
      };
      return Promise.resolve({
        status: reply.status ?? 200,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        json: () =>
          reply.json === undefined
            ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
            : Promise.resolve(reply.json)
      });
    };
    return { fetch, asked };
  }

  function check(
    replies: Record<string, Reply>,
    credentials: Record<string, string> = CREDENTIALS,
    deadlineMs?: number
  ): { result: Promise<SetupCheck>; asked: { method: string; auth: string }[] } {
    const { fetch, asked } = slackFor(replies);
    const result = messenger.checkSlack(credentials, new AbortController().signal, {
      fetch,
      ...(deadlineMs !== undefined && { deadlineMs })
    });
    return { result, asked };
  }

  const stepOf = (result: SetupCheck): number | undefined =>
    result.kind === 'setup' ? result.step : undefined;

  it('fails the app-level step without asking Slack when both tokens are missing, or swapped', async () => {
    const pairs: Record<string, string>[] = [{}, { botToken: APP_TOKEN, appToken: BOT_TOKEN }];
    for (const credentials of pairs) {
      const { result, asked } = check(OK, credentials);
      assert.equal(stepOf(await result), 1, JSON.stringify(credentials));
      assert.deepEqual(asked, []);
    }
  });

  it('fails the bot step without asking Slack for a bot token of the wrong kind', async () => {
    const { result, asked } = check(OK, { botToken: 'xoxp-user-token', appToken: APP_TOKEN });
    assert.equal(stepOf(await result), 2);
    assert.deepEqual(asked, []);
  });

  it('fails the app-level step when both tokens are bad, asking with that token alone', async () => {
    const { result, asked } = check({
      'apps.connections.open': { json: fx.error('invalid_auth') },
      'auth.test': { json: fx.error('invalid_auth') }
    });
    assert.equal(stepOf(await result), 1);
    assert.deepEqual(asked, [{ method: 'apps.connections.open', auth: `Bearer ${APP_TOKEN}` }]);
  });

  it('fails the app-level step for a token without its scope, and names the scope', async () => {
    const { result } = check({
      ...OK,
      'apps.connections.open': { json: fx.error('missing_scope') }
    });
    const out = await result;
    assert.equal(stepOf(out), 1);
    assert.ok(out.kind === 'setup' && out.reason.includes(manifest.APP_TOKEN_SCOPE), out.kind);
  });

  it('fails the bot step for a revoked bot token, asked with the bot token', async () => {
    const { result, asked } = check({ ...OK, 'auth.test': { json: fx.error('token_revoked') } });
    assert.equal(stepOf(await result), 2);
    assert.deepEqual(asked.at(-1), { method: 'auth.test', auth: `Bearer ${BOT_TOKEN}` });
  });

  it('fails the bot step for a scope the manifest asks for and the token lacks, by name', async () => {
    const without = SCOPES.filter((scope) => scope !== 'chat:write').join(',');
    const { result } = check({ ...OK, 'auth.test': { json: fx.authTest(), scopes: without } });
    const out = await result;
    assert.equal(stepOf(out), 2);
    assert.ok(out.kind === 'setup' && out.reason.includes('chat:write'), out.kind);
  });

  it('passes with the workspace and bot named and the scopes checked', async () => {
    const { result } = check(OK);
    assert.deepEqual(await result, {
      kind: 'ok',
      facts: [
        { label: 'Workspace', value: 'Squad' },
        { label: 'Bot', value: '@squadron' },
        { label: 'Scopes', value: 'checked' },
        { label: 'Incoming files', value: 'available' },
        { label: 'Message reactions', value: 'available' },
        { label: 'Thread context', value: 'available' },
        { label: 'Author names', value: 'available' }
      ],
      space: env.TEAM
    });
  });

  it('keeps text setup available without incoming-file scope and gives reinstall guidance', async () => {
    const scopes = SCOPES.filter((scope) => scope !== 'files:read').join(',');
    const out = await check({ ...OK, 'auth.test': { json: fx.authTest(), scopes } }).result;
    assert.equal(out.kind, 'ok');
    const fact =
      out.kind === 'ok' ? out.facts.find((row) => row.label === 'Incoming files') : undefined;
    assert.match(fact?.value ?? '', /files:read/);
    assert.match(fact?.value ?? '', /reinstall/i);
  });

  it('keeps essential setup working when only reaction permission is missing', async () => {
    const scopes = SCOPES.filter((scope) => scope !== 'reactions:write').join(',');
    const out = await check({ ...OK, 'auth.test': { json: fx.authTest(), scopes } }).result;
    assert.equal(out.kind, 'ok');
    const fact =
      out.kind === 'ok' ? out.facts.find((row) => row.label === 'Message reactions') : undefined;
    assert.match(fact?.value ?? '', /reactions:write/);
    assert.match(fact?.value ?? '', /reinstall/i);
  });

  it('stays ok on the scope set from before thread context, and says it is unavailable', async () => {
    const before = [
      'app_mentions:read',
      'chat:write',
      'commands',
      'files:write',
      'im:history',
      'reactions:write'
    ].join(',');
    const out = await check({ ...OK, 'auth.test': { json: fx.authTest(), scopes: before } }).result;
    assert.equal(out.kind, 'ok');
    const fact =
      out.kind === 'ok' ? out.facts.find((row) => row.label === 'Thread context') : undefined;
    assert.equal(
      fact?.value,
      'Unavailable: add channels:history, groups:history to the app and reinstall it.'
    );
    const names =
      out.kind === 'ok' ? out.facts.find((row) => row.label === 'Author names') : undefined;
    assert.equal(
      names?.value,
      'Unavailable, so authors show as @U…: add users:read to the app and reinstall it.'
    );
  });

  it('reads the thread without users:read, and says authors show as member ids', async () => {
    const scopes = SCOPES.filter((scope) => scope !== 'users:read').join(',');
    const out = await check({ ...OK, 'auth.test': { json: fx.authTest(), scopes } }).result;
    assert.equal(out.kind, 'ok');
    const facts = out.kind === 'ok' ? out.facts : [];
    assert.equal(facts.find((row) => row.label === 'Thread context')?.value, 'available');
    assert.match(facts.find((row) => row.label === 'Author names')?.value ?? '', /@U…/);
  });

  it('names only the thread scope that is missing', async () => {
    const scopes = SCOPES.filter((scope) => scope !== 'groups:history').join(',');
    const out = await check({ ...OK, 'auth.test': { json: fx.authTest(), scopes } }).result;
    assert.equal(out.kind, 'ok');
    const fact =
      out.kind === 'ok' ? out.facts.find((row) => row.label === 'Thread context') : undefined;
    assert.match(fact?.value ?? '', /Unavailable: add groups:history /);
    assert.doesNotMatch(fact?.value ?? '', /channels:history/);
  });

  it('passes without claiming the scopes when Slack does not report them', async () => {
    const { result } = check({ ...OK, 'auth.test': { json: fx.authTest() } });
    const out = await result;
    assert.equal(out.kind, 'ok');
    assert.deepEqual(
      out.kind === 'ok' ? out.facts.find((fact) => fact.label === 'Scopes') : undefined,
      { label: 'Scopes', value: 'not reported' }
    );
    assert.deepEqual(
      out.kind === 'ok' ? out.facts.find((fact) => fact.label === 'Message reactions') : undefined,
      { label: 'Message reactions', value: 'not reported' }
    );
    assert.deepEqual(
      out.kind === 'ok' ? out.facts.find((fact) => fact.label === 'Thread context') : undefined,
      { label: 'Thread context', value: 'not reported' }
    );
    assert.deepEqual(
      out.kind === 'ok' ? out.facts.find((fact) => fact.label === 'Author names') : undefined,
      { label: 'Author names', value: 'not reported' }
    );
  });

  it('says Slack could not be reached on a 500, blaming no step', async () => {
    const { result } = check({ ...OK, 'apps.connections.open': { status: 500 } });
    assert.equal((await result).kind, 'unreachable');
  });

  it('says Slack could not be reached when a rate limit outlasts the deadline', async () => {
    const limited: Reply = { status: 429, retryAfter: '5', json: fx.rateLimited() };
    const started = Date.now();
    const { result, asked } = check({ ...OK, 'apps.connections.open': limited }, CREDENTIALS, 50);
    assert.equal((await result).kind, 'unreachable');
    assert.ok(Date.now() - started < 4_000, 'the check waited out the Retry-After');
    assert.equal(asked.length, 1);
  });

  it('carries no token in any outcome’s reason or facts', async () => {
    const cases: Record<string, Reply>[] = [
      OK,
      { ...OK, 'auth.test': { json: fx.authTest() } },
      { ...OK, 'apps.connections.open': { json: fx.error('invalid_auth') } },
      { ...OK, 'apps.connections.open': { json: fx.error('missing_scope') } },
      { ...OK, 'auth.test': { json: fx.error('token_revoked') } },
      { ...OK, 'auth.test': { json: fx.authTest(), scopes: 'commands' } },
      { ...OK, 'auth.test': { json: fx.error(BOT_TOKEN) } },
      { ...OK, 'apps.connections.open': { json: fx.error(APP_TOKEN) } },
      { ...OK, 'apps.connections.open': { status: 500 } },
      { ...OK, 'apps.connections.open': { status: 200 } }
    ];
    const credentials = [
      CREDENTIALS,
      { botToken: APP_TOKEN, appToken: BOT_TOKEN },
      { botToken: BOT_TOKEN, appToken: 'xoxb-SENTINEL-app-0000' },
      { botToken: 'xoxp-SENTINEL-user-0000', appToken: APP_TOKEN }
    ];
    const outcomes = [
      ...(await Promise.all(cases.map((replies) => check(replies).result))),
      ...(await Promise.all(credentials.map((c) => check(OK, c).result)))
    ];
    assert.deepEqual([...new Set(outcomes.map((out) => out.kind))].sort(), [
      'ok',
      'setup',
      'unreachable'
    ]);
    for (const out of outcomes) assert.ok(!JSON.stringify(out).includes('SENTINEL'), out.kind);
  });
});

describe('the Slack messenger, posting', () => {
  const asked: Notice = {
    kind: 'permission',
    mention: OWNER,
    head: 'squadron · build',
    body: 'Waiting for permission: Bash',
    buttons: [{ label: 'Deny', payload: 'k3x9.a', tone: 'danger' }]
  };

  it('posts home to the user id and anchors on the post that opened it', async () => {
    const { slack, fake } = slackOn();
    const posted = await slack.post({ home: OWNER }, asked);
    assert.deepEqual(methods(fake.calls), ['chat.postMessage']);
    const [call] = fake.calls;
    assert.equal(call?.args.channel, env.OWNER);
    assert.equal(call?.args.thread_ts, undefined);
    assert.deepEqual(call?.args.blocks, render.renderNotice(asked)[0]?.blocks);
    assert.equal(call?.args.text, render.renderNotice(asked)[0]?.text);
    assert.deepEqual(posted, {
      message: `${env.DM}:1760000100.000001`,
      anchor: `${env.DM}:1760000100.000001`
    });
  });

  it('threads a split notice under its first chunk, and names the last as the message', async () => {
    const { slack, fake } = slackOn();
    const body = Array.from(
      { length: 900 },
      (_, n) => `line ${n} of a long reply that goes on`
    ).join('\n');
    const posted = await slack.post({ home: OWNER }, { ...asked, body });
    const chunks = render.renderNotice({ ...asked, body });
    assert.ok(chunks.length > 1);
    assert.equal(fake.calls.length, chunks.length);
    assert.deepEqual(
      fake.calls.map((call) => [call.args.channel, call.args.thread_ts]),
      chunks.map((_, i) => (i === 0 ? [env.OWNER, undefined] : [env.DM, '1760000100.000001']))
    );
    assert.deepEqual(posted, {
      message: `${env.DM}:1760000100.${String(chunks.length).padStart(6, '0')}`,
      anchor: `${env.DM}:1760000100.000001`
    });
  });

  it("posts under a person's message, which anchors the conversation", async () => {
    const { slack, fake } = slackOn();
    const under = `${env.CHANNEL}:1760000040.000600`;
    const posted = await slack.post({ under }, asked);
    assert.equal(fake.calls[0]?.args.channel, env.CHANNEL);
    assert.equal(fake.calls[0]?.args.thread_ts, '1760000040.000600');
    assert.equal(posted.anchor, under);
  });

  it("posts into a conversation's thread by its anchor", async () => {
    const { slack, fake } = slackOn();
    const anchor = `${env.DM}:${env.P1_TS}`;
    const posted = await slack.post({ conversation: { anchor, latest: anchor } }, asked);
    assert.equal(fake.calls[0]?.args.channel, env.DM);
    assert.equal(fake.calls[0]?.args.thread_ts, env.P1_TS);
    assert.equal(posted.anchor, anchor);
  });

  it('refuses before posting: too many buttons, a long payload, a payload not ASCII', async () => {
    const { slack, fake } = slackOn();
    const many = Array.from({ length: 26 }, (_, i) => ({ label: `b${i}`, payload: `k.${i}` }));
    await assert.rejects(slack.post({ home: OWNER }, { ...asked, buttons: many }));
    await assert.rejects(
      slack.post(
        { home: OWNER },
        { ...asked, buttons: [{ label: 'x', payload: 'a'.repeat(2001) }] }
      )
    );
    await assert.rejects(
      slack.post({ home: OWNER }, { ...asked, buttons: [{ label: 'x', payload: 'é' }] })
    );
    await assert.rejects(slack.post({ home: 'not-a-slack-id' }, asked));
    assert.deepEqual(fake.calls, []);
  });

  it('settles through chat.update with the settled render', async () => {
    const { slack, fake } = slackOn();
    const posted = await slack.post({ home: OWNER }, asked);
    const settled = { ...asked, buttons: [], settled: 'Denied' };
    await slack.edit?.settle(posted.message, settled);
    const update = fake.calls.at(-1);
    assert.equal(update?.method, 'chat.update');
    assert.equal(update?.args.channel, env.DM);
    assert.equal(update?.args.ts, '1760000100.000001');
    assert.deepEqual(update?.args.blocks, render.renderSettled(settled).blocks);
  });

  it('declares what it carries', () => {
    const { slack } = slackOn();
    assert.equal(slack.text.max, 11_000);
    assert.deepEqual(slack.buttons, { payloadMax: 2000, perNotice: 25 });
    assert.ok(slack.files);
    assert.equal(slack.files.maxBytes, 1_000_000_000);
  });

  it('asks for a permalink once per anchor, and again after a failure', async () => {
    const fake = fakeSlack();
    const { slack } = slackOn(fake);
    const anchor = `${env.DM}:${env.P1_TS}`;
    const first = await slack.links?.to(anchor);
    const second = await slack.links?.to(anchor);
    assert.equal(first, `https://squad.slack.com/archives/${env.DM}/p1760000000000100`);
    assert.equal(second, first);
    assert.deepEqual(methods(fake.calls), ['chat.getPermalink']);
    assert.equal(await slack.links?.to('not a ref'), undefined);

    const refusing = fakeSlack({ refuse: { 'chat.getPermalink': 'message_not_found' } });
    const other = slackOn(refusing).slack;
    assert.equal(await other.links?.to(anchor), undefined);
    assert.equal(await other.links?.to(anchor), undefined);
    assert.equal(refusing.calls.length, 2, 'a failure is not cached');
  });
});

describe('the Slack messenger, reading back what the link missed', () => {
  const signal = () => new AbortController().signal;

  it('reads each DM once and each DM thread, and never a channel', async () => {
    const { slack, fake } = slackOn();
    const anchors = [
      `${env.DM}:${env.P1_TS}`,
      `${env.DM}:1760000001.000100`,
      `${env.CHANNEL}:1760000002.000100`
    ];
    await slack.backlog?.since(anchors, 0, signal());
    const asked = fake.calls
      .filter((call) => call.method.startsWith('conversations.'))
      .map((call) => [call.method, call.args.channel, call.args.ts]);
    assert.deepEqual(asked, [
      ['conversations.history', env.DM, undefined],
      ['conversations.replies', env.DM, env.P1_TS],
      ['conversations.replies', env.DM, '1760000001.000100']
    ]);
  });

  it('reads a thread Slack cannot find as empty, not as missed', async () => {
    const { slack } = slackOn(
      fakeSlack({ refuse: { 'conversations.replies': 'thread_not_found' } })
    );
    const read = await slack.backlog?.since([`${env.DM}:${env.P1_TS}`], 0, signal());
    assert.equal(read?.missed, 0);
  });

  it('counts a conversation it could not read, and keeps what it could', async () => {
    const { slack, fake } = slackOn(
      fakeSlack({ refuse: { 'conversations.replies': 'internal_error' } })
    );
    fake.said.push({ ...env.dmMessage(), ts: '1760000300.000000' });
    const read = await slack.backlog?.since([`${env.DM}:${env.P1_TS}`], 0, signal());
    assert.equal(read?.missed, 1);
    assert.deepEqual(
      read?.events.map((e) => e.id),
      [`${env.DM}:1760000300.000000`]
    );
  });
});

describe('the Slack messenger, reading a thread it is joining', () => {
  const signal = () => new AbortController().signal;
  const root = '1760000001.000100';
  const mention = '1760000005.000100';
  const anchor = `${env.CHANNEL}:${root}`;
  const before = `${env.CHANNEL}:${mention}`;

  function threadRow(ts: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { channel: env.CHANNEL, thread_ts: root, ts, ...over };
  }

  it('reads earlier messages from a person and another bot, and not its own', async () => {
    const { slack, fake } = slackOn();
    fake.names[env.OWNER] = 'Ada';
    fake.said.push(
      threadRow(root, {
        user: env.OWNER,
        text: 'the question',
        files: [
          { id: 'F0FILE0001', name: 'a.png' },
          { id: 'F0FILE0002', name: 'b.pdf' }
        ]
      }),
      threadRow('1760000002.000100', {
        user: env.OWNER,
        text: `<@${env.BOT_USER}> look &amp; see`
      }),
      threadRow('1760000003.000100', { user: env.BOT_USER, text: 'as the bot user' }),
      threadRow('1760000003.000200', { bot_id: env.BOT_ID, text: 'as the bot id' }),
      threadRow('1760000004.000100', {
        bot_id: 'B0OTHER01',
        username: 'analyzer',
        bot_profile: { name: 'Analyzer' },
        text: 'half the thread'
      }),
      threadRow(mention, { user: env.OWNER, text: 'the mention' }),
      threadRow('1760000006.000100', { user: env.OWNER, text: 'after' })
    );
    const read = await slack.thread?.read(anchor, before, signal());
    assert.deepEqual(read, {
      ok: true,
      truncated: false,
      total: 3,
      lines: [
        { author: 'Ada', text: 'the question', at: 1760000001000, files: ['a.png', 'b.pdf'] },
        { author: 'Ada', text: `@${env.BOT_USER} look & see`, at: 1760000002000 },
        { author: 'Analyzer', text: 'half the thread', at: 1760000004000 }
      ]
    });
    const replies = fake.calls.find((call) => call.method === 'conversations.replies');
    assert.equal(replies?.args.channel, env.CHANNEL);
    assert.equal(replies?.args.ts, root);
    assert.equal(replies?.args.latest, mention);
    assert.equal(replies?.args.inclusive, 'false');
    assert.equal(replies?.args.limit, String(api.THREAD_LIMIT));
    assert.deepEqual(
      fake.calls.filter((call) => call.method === 'users.info').map((call) => call.args.user),
      [env.OWNER]
    );
  });

  it('names a person @U… when users.info refuses', async () => {
    const { slack, fake } = slackOn(fakeSlack({ refuse: { 'users.info': 'missing_scope' } }));
    fake.said.push(threadRow('1760000002.000100', { user: env.OWNER, text: 'hello' }));
    const read = await slack.thread?.read(anchor, before, signal());
    assert.deepEqual(read, {
      ok: true,
      truncated: false,
      total: 1,
      lines: [{ author: `@${env.OWNER}`, text: 'hello', at: 1760000002000 }]
    });
  });

  it('reads a missing scope, an absent membership and a missing channel as scope', async () => {
    for (const code of ['missing_scope', 'not_in_channel', 'channel_not_found']) {
      const { slack } = slackOn(fakeSlack({ refuse: { 'conversations.replies': code } }));
      assert.deepEqual(await slack.thread?.read(anchor, before, signal()), {
        ok: false,
        reason: 'scope'
      });
    }
  });

  it('reads any other failure, a rate limit past its wait, or an abort as unreachable', async () => {
    const refused = slackOn(fakeSlack({ refuse: { 'conversations.replies': 'internal_error' } }));
    assert.deepEqual(await refused.slack.thread?.read(anchor, before, signal()), {
      ok: false,
      reason: 'unreachable'
    });

    const limited = slackOn(fakeSlack({ limited: ['conversations.replies'], retryAfter: '0' }));
    assert.deepEqual(await limited.slack.thread?.read(anchor, before, signal()), {
      ok: false,
      reason: 'unreachable'
    });

    const aborted = new AbortController();
    aborted.abort();
    const { slack, fake } = slackOn();
    assert.deepEqual(await slack.thread?.read(anchor, before, aborted.signal), {
      ok: false,
      reason: 'unreachable'
    });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(await slack.thread?.read('not a ref', before, signal()), {
      ok: false,
      reason: 'unreachable'
    });
    assert.deepEqual(fake.calls, []);
  });

  /** `n` replies by Ada under `root`, a second apart from `from`. */
  function replies(n: number, from = 1760001000): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) =>
      threadRow(`${from + i}.000100`, { user: env.OWNER, text: `reply ${i}` })
    );
  }

  it('keeps the newest replies before the mention past its window, and counts them all', async () => {
    const { slack, fake } = slackOn();
    fake.names[env.OWNER] = 'Ada';
    const extra = 50;
    const earlier = replies(messenger.THREAD_WINDOW + extra);
    const mentionAt = `${1760001000 + earlier.length}.000100`;
    fake.said.push(
      ...earlier,
      threadRow(mentionAt, { user: env.OWNER, text: 'the mention' }),
      ...replies(3, 1760009000)
    );
    const read = await slack.thread?.read(anchor, `${env.CHANNEL}:${mentionAt}`, signal());
    if (read?.ok !== true) assert.fail();
    assert.equal(read.truncated, true);
    assert.equal(read.total, earlier.length);
    assert.equal(read.lines.length, messenger.THREAD_WINDOW);
    assert.equal(read.lines[0]?.text, `reply ${extra}`);
    assert.equal(read.lines.at(-1)?.text, `reply ${earlier.length - 1}`);
    const asked = fake.calls.filter((call) => call.method === 'conversations.replies');
    assert.equal(asked.length, Math.ceil(earlier.length / api.THREAD_LIMIT));
    assert.ok(asked.every((call) => call.args.latest === mentionAt));
    assert.equal(fake.calls.filter((call) => call.method === 'users.info').length, 1);

    const more = replies(2, 1760009500);
    const nextAt = '1760009600.000100';
    fake.said.push(...more, threadRow(nextAt, { user: env.OWNER, text: 'and now?' }));
    const again = await slack.thread?.read(anchor, `${env.CHANNEL}:${nextAt}`, signal());
    if (again?.ok !== true) assert.fail();
    assert.equal(again.total, read.total + 1 + 3 + more.length, 'the mention, after, and two');
    assert.equal(again.lines.length, messenger.THREAD_WINDOW);
    assert.equal(again.lines.at(-1)?.text, 'reply 1');
  });

  it('says nothing was cut when the thread fits its window', async () => {
    const { slack, fake } = slackOn();
    const earlier = replies(messenger.THREAD_WINDOW);
    const mentionAt = '1760009000.000100';
    fake.said.push(...earlier, threadRow(mentionAt, { user: env.OWNER, text: 'the mention' }));
    const read = await slack.thread?.read(anchor, `${env.CHANNEL}:${mentionAt}`, signal());
    if (read?.ok !== true) assert.fail();
    assert.equal(read.truncated, false);
    assert.equal(read.total, earlier.length);
    assert.equal(read.lines.length, earlier.length);
  });

  it('counts a parent Slack repeats on every page once', async () => {
    const { slack, fake } = slackOn(fakeSlack({ parentEveryPage: true }));
    const earlier = [threadRow(root, { user: env.OWNER, text: 'the question' }), ...replies(2500)];
    const mentionAt = '1760009000.000100';
    fake.said.push(...earlier, threadRow(mentionAt, { user: env.OWNER, text: 'the mention' }));
    const read = await slack.thread?.read(anchor, `${env.CHANNEL}:${mentionAt}`, signal());
    if (read?.ok !== true) assert.fail();
    assert.equal(read.total, earlier.length);
    assert.equal(read.lines.filter((line) => line.text === 'the question').length, 0);
  });

  it('reads an abort before the range ends as unreachable', async () => {
    const fake = fakeSlack();
    fake.said.push(...replies(api.THREAD_LIMIT + 1));
    const mentionAt = `${env.CHANNEL}:1760009000.000100`;
    const reading = new AbortController();
    const fetch = ((url: string, init: never) => {
      if (url.endsWith('conversations.replies')) reading.abort();
      return fake.deps.fetch(url, init);
    }) as typeof fake.deps.fetch;
    const slack = messenger.slackMessenger(CREDENTIALS, { ...fake.deps, fetch });
    assert.deepEqual(await slack.thread?.read(anchor, mentionAt, reading.signal), {
      ok: false,
      reason: 'unreachable'
    });
    assert.equal(fake.calls.filter((call) => call.method === 'conversations.replies').length, 1);
  });
});

describe('the Slack messenger, connected', () => {
  it('maps envelopes to the sink, acks each, and reports the link', async () => {
    const { slack, fake } = slackOn();
    const events: Inbound[] = [];
    const states: LinkState[] = [];
    const link = slack.connect((event) => events.push(event));
    link.onState((state) => states.push(state));
    assert.equal(link.state.kind, 'connecting');
    const ws = await fake.socket();
    ws.frame(env.hello());
    assert.equal(link.state.kind, 'connected');
    ws.frame(env.eventsApi(env.dmThreadReply()));
    ws.frame(env.eventsApi(env.botEcho(), { envelopeId: 'echo-1' }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'message');
    assert.deepEqual(ws.acks(), ['e1f0c3a2-0000-4000-8000-000000000001', 'echo-1']);
    assert.deepEqual(
      states.map((state) => state.kind),
      ['connected']
    );
    link.close();
    assert.equal(ws.closedWith, 1000);
  });

  it('keeps one throwing delivery from losing the next', async () => {
    const { slack, fake } = slackOn();
    const seen: string[] = [];
    const link = slack.connect((event) => {
      seen.push(event.id);
      throw new Error('the core fell over');
    });
    const ws = await fake.socket();
    ws.frame(env.hello());
    ws.frame(env.eventsApi(env.dmMessage(), { eventId: 'Ev1', envelopeId: 'a' }));
    ws.frame(env.eventsApi(env.dmMessage(), { eventId: 'Ev2', envelopeId: 'b' }));
    const ref = `${env.DM}:1760000005.000200`;
    assert.deepEqual(seen, [ref, ref]);
    assert.deepEqual(ws.acks(), ['a', 'b']);
    link.close();
  });

  it('posts before the socket is up', async () => {
    const { slack, fake } = slackOn();
    const link = slack.connect(() => undefined);
    const posted = await slack.post({ home: OWNER }, { kind: 'finished', body: 'Done.' });
    assert.ok(posted.message);
    assert.equal(fake.sockets.length, 0, 'no socket yet');
    link.close();
  });

  it('fails, and says why, when the bot token is refused', async () => {
    const fake = fakeSlack({ refuse: { 'auth.test': 'invalid_auth' } });
    const { slack } = slackOn(fake);
    const link = slack.connect(() => undefined);
    const states: LinkState[] = [];
    link.onState((state) => states.push(state));
    for (let spin = 0; spin < 20 && states.length === 0; spin++) await flush();
    assert.equal(states[0]?.kind, 'failed');
    assert.equal(link.state.kind, 'failed');
  });
});

describe('the Slack messenger, closed', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  const done: Notice = { kind: 'finished', body: 'Done.' };

  /** Runs pending work and the mocked clock until nothing more is called. */
  async function settle(): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      await flush();
      mock.timers.tick(60_000);
    }
    await flush();
  }

  it("cancels a post's rate-limit wait, and the post queued behind it", async () => {
    const fake = fakeSlack({ limited: ['chat.postMessage'] });
    const { slack } = slackOn(fake);
    const link = slack.connect(() => undefined);
    const first = slack.post({ home: OWNER }, done);
    const second = slack.post({ home: OWNER }, done);
    first.catch(() => undefined);
    second.catch(() => undefined);
    for (let spin = 0; spin < 20 && !methods(fake.calls).includes('chat.postMessage'); spin++)
      await flush();
    link.close();
    await settle();
    assert.equal(methods(fake.calls).filter((m) => m === 'chat.postMessage').length, 1);
    await assert.rejects(first, { code: 'closed' });
    await assert.rejects(second, { code: 'closed' });
  });

  it("cancels the connection's own auth.test wait", async () => {
    const fake = fakeSlack({ limited: ['auth.test'] });
    const { slack } = slackOn(fake);
    const link = slack.connect(() => undefined);
    for (let spin = 0; spin < 20 && fake.calls.length === 0; spin++) await flush();
    link.close();
    await settle();
    assert.deepEqual(methods(fake.calls), ['auth.test']);
  });

  it('a close abandons an upload in flight, so a half-open one holds nothing up', async () => {
    const fake = fakeSlack({ hangUploads: true });
    const { slack } = slackOn(fake);
    const link = slack.connect(() => undefined);
    const anchor = `${env.DM}:1760000000.000100`;
    const sent = slack.files?.send(
      { conversation: { anchor, latest: anchor } },
      { bytes: Buffer.from('notes'), name: 'notes.js', mime: 'text/javascript' }
    );
    for (let spin = 0; spin < 200 && fake.uploads.length === 0; spin++) await flush();
    assert.equal(fake.uploads.length, 1, 'the upload never began');
    link.close();
    await assert.rejects(Promise.resolve(sent), { code: 'closed' });
  });

  it('a close of the messenger abandons an upload begun before any connection', async () => {
    const fake = fakeSlack({ hangUploads: true });
    const { slack } = slackOn(fake);
    const anchor = `${env.DM}:1760000000.000100`;
    const sent = slack.files?.send(
      { conversation: { anchor, latest: anchor } },
      { bytes: Buffer.from('notes'), name: 'notes.js', mime: 'text/javascript' }
    );
    for (let spin = 0; spin < 200 && fake.uploads.length === 0; spin++) await flush();
    assert.equal(fake.uploads.length, 1, 'the upload never began');
    slack.close();
    await assert.rejects(Promise.resolve(sent), { code: 'closed' });
  });

  it('refuses a post after close without calling, and posts again once reconnected', async () => {
    const { slack, fake } = slackOn();
    slack.connect(() => undefined).close();
    await assert.rejects(slack.post({ home: OWNER }, done), { code: 'closed' });
    assert.ok(!methods(fake.calls).includes('chat.postMessage'));
    const link = slack.connect(() => undefined);
    assert.ok((await slack.post({ home: OWNER }, done)).message);
    link.close();
  });
});

describe('Slack message reactions', () => {
  const original = `${env.DM}:${env.P1_TS}`;
  const names = ['eyes', 'hourglass_flowing_sand', 'gear', 'white_check_mark'];

  it('adds each status to the original message before removing the other reserved reactions', async () => {
    const { slack, fake } = slackOn();
    assert.ok(slack.reactions);
    for (const [i, status] of (['received', 'queued', 'processing', 'done'] as const).entries()) {
      fake.calls.length = 0;
      await slack.reactions.set(original, status);
      assert.deepEqual(
        fake.calls.map(({ method, args }) => ({ method, args })),
        [
          {
            method: 'reactions.add',
            args: { channel: env.DM, timestamp: env.P1_TS, name: names[i] }
          },
          ...names
            .filter((name) => name !== names[i])
            .map((name) => ({
              method: 'reactions.remove',
              args: { channel: env.DM, timestamp: env.P1_TS, name }
            }))
        ]
      );
    }
  });

  it('cleans up even when add is already present and the old bot reactions are absent', async () => {
    const { slack, fake } = slackOn(
      fakeSlack({
        refuse: { 'reactions.add': 'already_reacted', 'reactions.remove': 'no_reaction' }
      })
    );
    assert.ok(slack.reactions);
    await slack.reactions.set(original, 'done');
    assert.deepEqual(methods(fake.calls), [
      'reactions.add',
      'reactions.remove',
      'reactions.remove',
      'reactions.remove'
    ]);
  });

  it('rejects failed add without cleanup, and failed cleanup without claiming success', async () => {
    for (const [method, code, expected] of [
      ['reactions.add', 'missing_scope', ['reactions.add']],
      ['reactions.remove', 'internal_error', ['reactions.add', 'reactions.remove']]
    ] as const) {
      const { slack, fake } = slackOn(fakeSlack({ refuse: { [method]: code } }));
      assert.ok(slack.reactions);
      await assert.rejects(
        slack.reactions.set(original, 'processing'),
        (error: unknown) =>
          error instanceof api.SlackError && error.method === method && error.code === code
      );
      assert.deepEqual(methods(fake.calls), expected);
      await slack.post({ home: OWNER }, { kind: 'refusal', body: 'messaging still works' });
      assert.equal(fake.posted.length, 1);
    }
  });

  it('resolves only when all cleanup calls finish, independently of a pending chat post', async () => {
    const fake = fakeSlack();
    let releasePost!: () => void;
    let releaseCleanup!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const fetch: typeof fake.deps.fetch = async (url, init) => {
      assert.ok(typeof init.body === 'string');
      const reply = await fake.deps.fetch(url, { ...init, body: init.body });
      if (url.endsWith('chat.postMessage')) await postGate;
      if (url.endsWith('reactions.remove')) await cleanupGate;
      return reply;
    };
    const slack = messenger.slackMessenger(CREDENTIALS, { ...fake.deps, fetch });
    assert.ok(slack.reactions);
    const post = slack.post({ under: original }, { kind: 'refusal', body: 'pending' });
    await flush();
    let settled = false;
    const reaction = slack.reactions.set(original, 'received').then(() => {
      settled = true;
    });
    await flush();
    assert.ok(methods(fake.calls).includes('reactions.add'));
    assert.ok(methods(fake.calls).includes('reactions.remove'));
    assert.equal(settled, false);
    releaseCleanup();
    await reaction;
    assert.equal(settled, true);
    releasePost();
    await post;
  });

  it('rejects an invalid ref before any request', async () => {
    const { slack, fake } = slackOn();
    assert.ok(slack.reactions);
    await assert.rejects(slack.reactions.set('not-a-ref', 'received'), /bad_message/);
    assert.deepEqual(fake.calls, []);
  });
});

describe('Slack reaction lifetime and rate limits', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('uses bounded retries and aborts on either the caller or messenger closing', async () => {
    for (const stop of ['caller', 'messenger'] as const) {
      const { slack, fake } = slackOn(fakeSlack({ limited: ['reactions.remove'] }));
      assert.ok(slack.reactions);
      const controller = new AbortController();
      const work = slack.reactions.set(`${env.DM}:${env.P1_TS}`, 'received', controller.signal);
      const rejected = assert.rejects(work, /closed/);
      await flush();
      mock.timers.tick(1000);
      await flush();
      assert.deepEqual(methods(fake.calls), [
        'reactions.add',
        'reactions.remove',
        'reactions.remove'
      ]);
      if (stop === 'caller') controller.abort();
      else slack.close();
      await rejected;
      mock.timers.tick(60_000);
      await flush();
      assert.equal(fake.calls.length, 3);
    }
  });

  it('abandons an unanswered reaction under the existing API deadline', async () => {
    const fake = fakeSlack();
    const slack = messenger.slackMessenger(CREDENTIALS, {
      ...fake.deps,
      fetch: async (url, init) => {
        if (url.endsWith('reactions.add'))
          return new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            });
          });
        assert.ok(typeof init.body === 'string');
        return fake.deps.fetch(url, { ...init, body: init.body });
      }
    });
    assert.ok(slack.reactions);
    const rejected = assert.rejects(
      slack.reactions.set(`${env.DM}:${env.P1_TS}`, 'received'),
      /timed_out/
    );
    await flush();
    mock.timers.tick(api.CALL_MS);
    await rejected;
    assert.deepEqual(fake.calls, []);
  });
});
