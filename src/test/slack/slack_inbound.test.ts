import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Inbound } from '../../core/bridge/model';
import * as inbound from '../../core/slack/inbound';
import * as wire from '../../core/slack/wire';
import * as env from '../fixtures/slack_envelopes';

const SELF: wire.Identity = { userId: env.BOT_USER, teamId: env.TEAM, botId: env.BOT_ID };
const OWNER = `${env.TEAM}:${env.OWNER}`;

/** A fixture frame, narrowed as the socket narrows it, then mapped. */
function map(frame: Record<string, unknown>): readonly Inbound[] {
  const { envelope } = wire.narrowEnvelope(frame);
  assert.ok(envelope, 'the fixture narrows');
  assert.ok(envelope.type !== 'hello' && envelope.type !== 'disconnect');
  return inbound.toInbound(envelope, SELF);
}

function one(frame: Record<string, unknown>): Inbound {
  const events = map(frame);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  return event;
}

describe('fromHistory', () => {
  /** A row as `conversations.history` returns it: no channel, no channel
   *  type, and here no team, which the bot's own then stands for. */
  const row = (over: Record<string, unknown> = {}) => {
    const { channel: _c, channel_type: _t, team: _team, event_ts: _e, ...kept } = env.dmMessage();
    return { ...kept, ...over };
  };
  const read = (rows: Record<string, unknown>[]) =>
    wire.readMessages(rows, env.DM).map((event) => inbound.fromHistory(event, SELF));

  it('maps a history row exactly as the live event it would have been', () => {
    const [mapped] = read([row()]);
    assert.deepEqual(mapped, one(env.eventsApi(env.dmMessage())));
  });

  it("carries a thread reply's anchor", () => {
    const [mapped] = read([row({ ts: '1760000010.000300', thread_ts: env.P1_TS })]);
    assert.ok(mapped?.kind === 'message');
    assert.deepEqual(mapped.refs, [`${env.DM}:${env.P1_TS}`]);
  });

  it("drops the bot's own rows, other bots', and edits", () => {
    assert.deepEqual(
      read([
        row({ user: env.BOT_USER }),
        row({ bot_id: 'B0OTHER01' }),
        row({ subtype: 'message_changed' })
      ]),
      [undefined, undefined, undefined]
    );
  });
});

describe('toInbound, messages', () => {
  it('maps a top-level DM to a direct message with no refs', () => {
    assert.deepEqual(one(env.eventsApi(env.dmMessage())), {
      kind: 'message',
      id: `${env.DM}:1760000005.000200`,
      sender: { id: OWNER },
      text: 'run the tests & tell me',
      addressed: 'direct',
      refs: [],
      ref: `${env.DM}:1760000005.000200`,
      at: 1_760_000_005_000
    });
  });

  it("carries a DM thread reply's anchor as its ref", () => {
    const event = one(env.eventsApi(env.dmThreadReply(), { eventId: 'Ev0FIXTURE02' }));
    assert.ok(event.kind === 'message');
    assert.equal(event.id, `${env.DM}:1760000010.000300`);
    assert.deepEqual(event.refs, [`${env.DM}:${env.P1_TS}`]);
    assert.equal(event.ref, `${env.DM}:1760000010.000300`);
    assert.equal(event.text, 'hello from phone');
  });

  it('keys a message by where it sits, so a redelivery under a new event id is a repeat', () => {
    const once = one(env.eventsApi(env.dmMessage(), { eventId: 'Ev1', envelopeId: 'a' }));
    const again = one(env.eventsApi(env.dmMessage(), { eventId: 'Ev2', envelopeId: 'b' }));
    assert.equal(once.id, again.id);
  });

  it('maps a top-level channel @mention, without the mention', () => {
    const event = one(env.eventsApi(env.appMention()));
    assert.ok(event.kind === 'message');
    assert.equal(event.addressed, 'mention');
    assert.equal(event.text, 'what is running?');
    assert.deepEqual(event.refs, []);
    assert.equal(event.ref, `${env.CHANNEL}:1760000040.000600`);
  });

  it("keys a Slack Connect guest's @mention in a thread on the guest's own team", () => {
    const event = one(env.eventsApi(env.appMentionInThreadFromGuest()));
    assert.ok(event.kind === 'message');
    assert.deepEqual(event.sender, { id: `${env.GUEST_TEAM}:${env.GUEST}` });
    assert.deepEqual(event.refs, [`${env.CHANNEL}:1760000040.000600`]);
  });

  it('keeps the text of a message with a file', () => {
    const event = one(env.eventsApi(env.fileShare()));
    assert.ok(event.kind === 'message');
    assert.equal(event.text, 'see this');
  });

  it('keeps a thread reply also sent to the channel', () => {
    const event = one(env.eventsApi({ ...env.dmThreadReply(), subtype: 'thread_broadcast' }));
    assert.ok(event.kind === 'message');
    assert.deepEqual(event.refs, [`${env.DM}:${env.P1_TS}`]);
  });

  it("drops the bot's own echo, another bot, an edit and a join", () => {
    const otherBot = { ...env.dmMessage(), user: 'U0OTHERBT', bot_id: 'B0OTHER01' };
    const join = { ...env.dmMessage(), subtype: 'channel_join', text: '<@U0OWNER01> has joined' };
    const selfNoBotId = { ...env.botEcho(), bot_id: undefined };
    for (const event of [env.botEcho(), otherBot, env.messageChanged(), join, selfNoBotId]) {
      assert.deepEqual(map(env.eventsApi(event)), [], JSON.stringify(event));
    }
  });

  it('drops an @mention from the bot itself or another bot', () => {
    const fromBot = { ...env.appMention(), user: env.BOT_USER };
    const otherBot = { ...env.appMention(), bot_id: 'B0OTHER01' };
    assert.deepEqual(map(env.eventsApi(fromBot)), []);
    assert.deepEqual(map(env.eventsApi(otherBot)), []);
  });

  it('drops a message from a channel, which no subscription addresses to the bot', () => {
    const channel = { ...env.dmMessage(), channel: env.CHANNEL, channel_type: 'channel' };
    assert.deepEqual(map(env.eventsApi(channel)), []);
  });

  it('falls back to the envelope team when the event names none', () => {
    const bare = { ...env.dmMessage(), team: undefined };
    const event = one(env.eventsApi(bare));
    assert.deepEqual(event.sender, { id: OWNER });
  });
});

describe('toInbound, presses', () => {
  it('maps a press to its payload and the message it was on', () => {
    assert.deepEqual(one(env.blockActions()), {
      kind: 'press',
      id: 'e1f0c3a2-0000-4000-8000-000000000004',
      sender: { id: OWNER },
      payload: 'k3x9',
      message: `${env.DM}:${env.P1_TS}`
    });
  });

  it('gives each action in one envelope its own id', () => {
    const frame = env.blockActions();
    const payload = frame.payload as Record<string, unknown>;
    const [action] = payload.actions as Record<string, unknown>[];
    payload.actions = [action, { ...action, action_id: 'sq.1', value: 'k3xa' }];
    const events = map(frame);
    assert.deepEqual(
      events.map((event) => event.id),
      ['e1f0c3a2-0000-4000-8000-000000000004', 'e1f0c3a2-0000-4000-8000-000000000004.1']
    );
  });
});

describe('toInbound, commands', () => {
  function command(text: string): Inbound {
    const event = one(env.slashCommand(text));
    assert.ok(event.kind === 'command');
    assert.equal(event.id, 'e1f0c3a2-0000-4000-8000-000000000005');
    assert.deepEqual(event.sender, { id: OWNER });
    assert.deepEqual(event.refs, []);
    return event;
  }

  it('maps list, new and end', () => {
    assert.deepEqual(pick(command('list')), { name: 'list', args: '' });
    assert.deepEqual(pick(command('end 4821')), { name: 'end', args: '4821' });
  });

  // The manifest sets `should_escape: false`, so Slack sends the text as typed.
  it('keeps the text as typed: no markup read, no entity decoded', () => {
    assert.deepEqual(pick(command('new render <button>Hi</button>')), {
      name: 'new',
      args: 'render <button>Hi</button>'
    });
    assert.deepEqual(pick(command('new keep &lt; unchanged')), {
      name: 'new',
      args: 'keep &lt; unchanged'
    });
    assert.deepEqual(pick(command('<b>list</b> &amp;')), {
      name: 'help',
      args: '<b>list</b> &amp;'
    });
  });

  it('maps anything else, or nothing, to help with the text', () => {
    assert.deepEqual(pick(command('frobnicate now')), { name: 'help', args: 'frobnicate now' });
    assert.deepEqual(pick(command('')), { name: 'help', args: '' });
  });

  it('drops a command that is not ours', () => {
    const frame = env.slashCommand('list');
    (frame.payload as Record<string, unknown>).command = '/other';
    assert.deepEqual(map(frame), []);
  });

  function pick(event: Inbound): { name: string; args: string } {
    assert.ok(event.kind === 'command');
    return { name: event.name, args: event.args };
  }
});

describe('plainText', () => {
  it("turns Slack's escaped text back into the person's words", () => {
    assert.equal(inbound.plainText('a &amp; b &lt;c&gt;'), 'a & b <c>');
    assert.equal(
      inbound.plainText('see <https://example.com|the docs>'),
      'see the docs (https://example.com)'
    );
    assert.equal(
      inbound.plainText('see <https://example.com|https://example.com> and <https://x.dev>'),
      'see https://example.com and https://x.dev'
    );
    assert.equal(
      inbound.plainText('ask <@U0GUEST01> and <@U0OWNER01|owner>'),
      'ask @U0GUEST01 and @owner'
    );
    assert.equal(inbound.plainText('in <#C0CHAN001|general> <!here>'), 'in #general @here');
    assert.equal(
      inbound.plainText('<https://x.dev?a=1&amp;b=2|a &amp; b>'),
      'a & b (https://x.dev?a=1&b=2)'
    );
  });

  it('removes only the leading mention of the bot', () => {
    assert.equal(
      inbound.plainText(`<@${env.BOT_USER}>  tell <@${env.BOT_USER}> hi`, env.BOT_USER),
      `tell @${env.BOT_USER} hi`
    );
    assert.equal(inbound.plainText('<@U0OWNER01> hi', env.BOT_USER), '@U0OWNER01 hi');
  });
});

describe('parseCommand', () => {
  it('reads the first word, in any case, and keeps the rest as it was', () => {
    assert.deepEqual(inbound.parseCommand('  NEW   run  it '), { name: 'new', args: 'run  it' });
    assert.deepEqual(inbound.parseCommand('end'), { name: 'end', args: '' });
    assert.deepEqual(inbound.parseCommand('listing'), { name: 'help', args: 'listing' });
  });
});
