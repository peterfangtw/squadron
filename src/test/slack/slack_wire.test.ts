import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as wire from '../../core/slack/wire';
import * as fx from '../fixtures/slack_envelopes';

/** Narrow, and require a typed envelope of `type`. */
function narrowed<T extends wire.Envelope['type']>(
  raw: unknown,
  type: T
): Extract<wire.Envelope, { type: T }> {
  const { envelope } = wire.narrowEnvelope(raw);
  assert.ok(envelope, 'expected a typed envelope');
  assert.equal(envelope.type, type);
  return envelope as Extract<wire.Envelope, { type: T }>;
}

/** A deep copy with one dotted path deleted. */
function without(raw: Record<string, unknown>, dotted: string): Record<string, unknown> {
  const copy = structuredClone(raw);
  const keys = dotted.split('.');
  const last = keys.pop() ?? '';
  let at: Record<string, unknown> = copy;
  for (const key of keys) {
    at = at[key] as Record<string, unknown>;
  }
  delete at[last];
  return copy;
}

describe('narrowEnvelope: the connection frames', () => {
  it('reads hello, with the connection count and time', () => {
    const hello = narrowed(fx.hello(), 'hello');
    assert.equal(hello.numConnections, 1);
    assert.equal(hello.approximateConnectionTime, 18060);
    assert.equal(wire.narrowEnvelope(fx.hello()).envelopeId, undefined);
  });

  it('reads each disconnect reason', () => {
    for (const reason of ['warning', 'refresh_requested', 'link_disabled']) {
      assert.equal(narrowed(fx.disconnect(reason), 'disconnect').reason, reason);
    }
  });
});

describe('narrowEnvelope: events', () => {
  it('reads a top-level DM', () => {
    const env = narrowed(fx.eventsApi(fx.dmMessage()), 'events_api');
    assert.equal(env.envelopeId, 'e1f0c3a2-0000-4000-8000-000000000001');
    assert.equal(env.eventId, 'Ev0FIXTURE01');
    assert.equal(env.teamId, fx.TEAM);
    assert.equal(env.retryAttempt, 0);
    assert.deepEqual(env.event, {
      type: 'message',
      channel: fx.DM,
      ts: '1760000005.000200',
      user: fx.OWNER,
      text: 'run the tests &amp; tell me',
      team: fx.TEAM,
      channelType: 'im'
    });
  });

  it('reads a DM thread reply with its thread', () => {
    const { event } = narrowed(fx.eventsApi(fx.dmThreadReply()), 'events_api');
    assert.equal(event.type, 'message');
    assert.equal(event.threadTs, fx.P1_TS);
  });

  it("reads the bot's own echo with its bot id, for the inbound map to drop", () => {
    const { event } = narrowed(fx.eventsApi(fx.botEcho()), 'events_api');
    assert.equal(event.type === 'message' && event.botId, fx.BOT_ID);
    assert.equal(event.user, fx.BOT_USER);
  });

  it('reads an edit and a file share by subtype', () => {
    const edit = narrowed(fx.eventsApi(fx.messageChanged()), 'events_api').event;
    assert.equal(edit.type === 'message' && edit.subtype, 'message_changed');
    assert.equal(edit.user, undefined);
    const share = narrowed(fx.eventsApi(fx.fileShare()), 'events_api').event;
    assert.equal(share.type === 'message' && share.subtype, 'file_share');
    assert.equal(share.text, 'see this');
  });

  it('reads an @mention at top level and in a thread, with a guest team', () => {
    const top = narrowed(fx.eventsApi(fx.appMention()), 'events_api').event;
    assert.deepEqual(top, {
      type: 'app_mention',
      channel: fx.CHANNEL,
      ts: '1760000040.000600',
      user: fx.OWNER,
      text: `<@${fx.BOT_USER}> what is running?`,
      team: fx.TEAM
    });
    const guest = narrowed(fx.eventsApi(fx.appMentionInThreadFromGuest()), 'events_api').event;
    assert.equal(guest.threadTs, '1760000040.000600');
    assert.equal(guest.userTeam, fx.GUEST_TEAM);
  });

  it('keeps a retry attempt', () => {
    const env = narrowed(fx.eventsApi(fx.dmMessage(), { retryAttempt: 2 }), 'events_api');
    assert.equal(env.retryAttempt, 2);
  });
});

describe('narrowEnvelope: presses and commands', () => {
  it('reads a button press with its message and value', () => {
    const env = narrowed(fx.blockActions(), 'interactive');
    assert.equal(env.envelopeId, 'e1f0c3a2-0000-4000-8000-000000000004');
    assert.deepEqual(env.payload, {
      type: 'block_actions',
      userId: fx.OWNER,
      userTeam: fx.TEAM,
      teamId: fx.TEAM,
      channel: fx.DM,
      messageTs: fx.P1_TS,
      actions: [{ actionId: 'sq.0', value: 'k3x9' }]
    });
  });

  it('reads a slash command, empty text included', () => {
    const env = narrowed(fx.slashCommand('list'), 'slash_commands');
    assert.deepEqual(env, {
      type: 'slash_commands',
      envelopeId: 'e1f0c3a2-0000-4000-8000-000000000005',
      command: '/squadron',
      text: 'list',
      userId: fx.OWNER,
      teamId: fx.TEAM,
      channelId: fx.DM
    });
    assert.equal(narrowed(fx.slashCommand(''), 'slash_commands').text, '');
  });
});

describe('narrowEnvelope degrades and never throws', () => {
  it('keeps the envelope id of a type it does not know, so it is still acked', () => {
    const out = wire.narrowEnvelope({ type: 'some_future_type', envelope_id: 'x-1', payload: {} });
    assert.deepEqual(out, { envelopeId: 'x-1' });
  });

  it('drops an event type nobody subscribed to, keeping the id', () => {
    const raw = fx.eventsApi({ type: 'app_home_opened', user: fx.OWNER, channel: fx.DM });
    assert.deepEqual(wire.narrowEnvelope(raw), {
      envelopeId: 'e1f0c3a2-0000-4000-8000-000000000001'
    });
  });

  it('drops an interactive payload that is not a message button press', () => {
    const raw = fx.blockActions();
    (raw.payload as Record<string, unknown>).type = 'view_submission';
    assert.equal(wire.narrowEnvelope(raw).envelope, undefined);
    const inView = without(fx.blockActions(), 'payload.container.message_ts');
    assert.equal(wire.narrowEnvelope(inView).envelope, undefined);
  });

  it('drops an envelope missing a field the docs promise, and keeps its id', () => {
    const cases: [Record<string, unknown>, string][] = [
      [fx.eventsApi(fx.dmMessage()), 'payload.event_id'],
      [fx.eventsApi(fx.dmMessage()), 'payload.event'],
      [fx.eventsApi(fx.dmMessage()), 'payload.event.channel'],
      [fx.eventsApi(fx.dmMessage()), 'payload.event.ts'],
      [fx.eventsApi(fx.appMention()), 'payload.event.user'],
      [fx.blockActions(), 'payload.user'],
      [fx.blockActions(), 'payload.container.channel_id'],
      [fx.slashCommand('list'), 'payload.user_id'],
      [fx.slashCommand('list'), 'payload.team_id'],
      [fx.slashCommand('list'), 'payload.command'],
      [fx.slashCommand('list'), 'payload.text']
    ];
    for (const [raw, path] of cases) {
      const out = wire.narrowEnvelope(without(raw, path));
      assert.equal(out.envelope, undefined, path);
      assert.equal(out.envelopeId, raw.envelope_id, path);
    }
  });

  it('gives a smaller shape when an optional field is missing or mistyped', () => {
    const raw = fx.eventsApi(fx.dmMessage());
    const event = (raw.payload as Record<string, Record<string, unknown>>).event ?? {};
    event.text = 42;
    delete event.team;
    const env = narrowed(raw, 'events_api');
    assert.equal(env.event.text, undefined);
    assert.equal(env.event.team, undefined);
    const press = fx.blockActions();
    const actions = (press.payload as Record<string, unknown[]>).actions ?? [];
    actions.push({ action_id: 'sq.1', type: 'button' }, 'junk');
    assert.equal(narrowed(press, 'interactive').payload.actions.length, 1);
  });

  it('drops a ts or an id that would not survive the ref encoding', () => {
    const badTs = fx.eventsApi({ ...fx.dmMessage(), ts: 'yesterday' });
    assert.equal(wire.narrowEnvelope(badTs).envelope, undefined);
    const badChannel = fx.eventsApi({ ...fx.dmMessage(), channel: 'D0:X' });
    assert.equal(wire.narrowEnvelope(badChannel).envelope, undefined);
    const badThread = narrowed(fx.eventsApi({ ...fx.dmMessage(), thread_ts: 'x' }), 'events_api');
    assert.equal(badThread.event.threadTs, undefined);
  });

  it('reads anything at all without throwing', () => {
    const junk: unknown[] = [
      undefined,
      null,
      0,
      'hello',
      [],
      [fx.hello()],
      {},
      { type: 42 },
      { type: 'events_api' },
      { type: 'events_api', envelope_id: 7, payload: 'x' },
      { type: 'events_api', envelope_id: 'y', payload: { event: [] } },
      { type: 'interactive', envelope_id: 'z', payload: { type: 'block_actions', actions: {} } },
      { type: 'hello', num_connections: 'two', debug_info: null },
      { type: 'disconnect', reason: 3 }
    ];
    for (const raw of junk) {
      assert.doesNotThrow(() => wire.narrowEnvelope(raw));
    }
    assert.deepEqual(wire.narrowEnvelope({ type: 'events_api', envelope_id: 7 }), {});
    assert.equal(
      narrowed({ type: 'hello', num_connections: 'two' }, 'hello').numConnections,
      undefined
    );
  });
});

describe('refs are <channel>:<ts>', () => {
  it('round-trips a channel and a ts', () => {
    const ref = wire.slackRef(fx.DM, fx.P1_TS);
    assert.equal(ref, `${fx.DM}:${fx.P1_TS}`);
    assert.deepEqual(wire.parseRef(ref ?? ''), { channel: fx.DM, ts: fx.P1_TS });
  });

  it('refuses anything else', () => {
    assert.equal(wire.slackRef('', fx.P1_TS), undefined);
    assert.equal(wire.slackRef(fx.DM, 'now'), undefined);
    assert.equal(wire.slackRef('d0dm', fx.P1_TS), undefined);
    for (const ref of [
      '',
      ':',
      'D0DM00001',
      `D0DM00001:${fx.P1_TS}:x`,
      `:${fx.P1_TS}`,
      'D0DM00001:1.'
    ]) {
      assert.equal(wire.parseRef(ref), undefined, ref);
    }
  });
});

describe('a Web API reply', () => {
  it('reads ok with its body, and an error with its code', () => {
    assert.deepEqual(wire.narrowReply({ ok: true, ts: '1.2' }), {
      ok: true,
      body: { ok: true, ts: '1.2' }
    });
    assert.deepEqual(wire.narrowReply({ ok: false, error: 'channel_not_found' }), {
      ok: false,
      error: 'channel_not_found'
    });
  });

  it('reads a reply it cannot parse as an error of its own, never a throw', () => {
    for (const raw of [undefined, null, 'ok', [], {}, { ok: 'yes' }, { ok: false }]) {
      assert.deepEqual(wire.narrowReply(raw), { ok: false, error: 'unreadable_reply' });
    }
  });
});

describe('auth.test', () => {
  it('reads the workspace and bot names beside the ids, and drops a name that is not text', () => {
    const body = { ok: true, team_id: 'T0SQUAD01', user_id: 'U0BOT0001', team: 'Squad', user: 7 };
    assert.deepEqual(wire.readAuthTest(body), {
      userId: 'U0BOT0001',
      teamId: 'T0SQUAD01',
      team: 'Squad'
    });
  });
});

describe('a history row', () => {
  const row = (ts: string, over: Record<string, unknown> = {}) => ({
    user: fx.OWNER,
    text: 'hello',
    ts,
    ...over
  });

  it('reads a bot row by its profile name and username', () => {
    assert.deepEqual(
      wire.readMessages(
        [
          row('1760000300.000100', {
            user: undefined,
            text: 'earlier',
            subtype: 'bot_message',
            bot_id: 'B0OTHER01',
            username: 'analyzer',
            bot_profile: { id: 'B0OTHER01', name: 'Analyzer' }
          })
        ],
        fx.CHANNEL
      ),
      [
        {
          type: 'message',
          channel: fx.CHANNEL,
          ts: '1760000300.000100',
          text: 'earlier',
          subtype: 'bot_message',
          botId: 'B0OTHER01',
          username: 'analyzer',
          botName: 'Analyzer'
        }
      ]
    );
  });

  it('reads a user row with two file names', () => {
    assert.deepEqual(
      wire.readMessages(
        [
          row('1760000300.000200', {
            files: [
              { id: 'F0FILE0001', name: 'a.png' },
              { id: 'F0FILE0002', name: 'b.pdf' }
            ]
          })
        ],
        fx.CHANNEL
      ),
      [
        {
          type: 'message',
          channel: fx.CHANNEL,
          ts: '1760000300.000200',
          user: fx.OWNER,
          text: 'hello',
          fileNames: ['a.png', 'b.pdf'],
          files: {
            files: [
              { id: 'F0FILE0001', name: 'a.png' },
              { id: 'F0FILE0002', name: 'b.pdf' }
            ],
            omitted: 0
          }
        }
      ]
    );
  });

  it('drops a malformed files entry and keeps the row', () => {
    const read = wire.readMessages(
      [
        row('1760000300.000300', {
          username: 4,
          bot_profile: 'nope',
          files: [{ name: 'a.png' }, { name: 12 }, 'junk', { id: 'F3' }, null]
        }),
        row('1760000300.000400', { files: 'nope' })
      ],
      fx.CHANNEL
    );
    assert.deepEqual(
      read.map((event) => event.fileNames),
      [['a.png'], undefined]
    );
    assert.equal(read[0]?.username, undefined);
    assert.equal(read[0]?.botName, undefined);
    assert.equal(read[0]?.text, 'hello');
    assert.equal(read[1]?.text, 'hello');
  });
});

describe('users.info', () => {
  it('reads the display name, else a real name, else nothing', () => {
    assert.equal(
      wire.readUserInfo({
        user: { real_name: 'Top', profile: { display_name: 'Ada', real_name: 'Profile' } }
      }),
      'Ada'
    );
    assert.equal(
      wire.readUserInfo({
        user: { real_name: 'Top', profile: { display_name: '', real_name: 'Profile' } }
      }),
      'Profile'
    );
    assert.equal(
      wire.readUserInfo({
        user: { real_name: 'Top', profile: { display_name: '   ', real_name: '   ' } }
      }),
      'Top'
    );
    assert.equal(wire.readUserInfo({ user: { real_name: 'Top' } }), 'Top');
    assert.equal(
      wire.readUserInfo({ user: { name: 'ada', profile: { display_name: '' } } }),
      undefined
    );
    assert.equal(wire.readUserInfo({}), undefined);
    assert.equal(wire.readUserInfo({ user: 'U0OWNER01' }), undefined);
  });
});
