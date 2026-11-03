import * as fx from '../fixtures/slack_replies';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as allow from '../../core/bridge/allow';
import type { Inbound } from '../../core/bridge/model';
import * as port from '../../core/bridge/port';
import * as fake from '../../core/bridge/fake';
import { fakeHarness, portContract } from './bridge_helpers';
import { CREDENTIALS } from '../slack/slack_helpers';

describe('the messenger registry', () => {
  it('refuses an id it does not hold, including one an object inherits', () => {
    assert.equal(port.messenger('nope'), undefined);
    assert.equal(port.messenger('constructor'), undefined);
    assert.equal(port.messenger('toString'), undefined);
  });

  it('refuses a messenger whose button payload cannot carry a store key', () => {
    assert.equal(port.unfit(fake.fakeMessenger({ payloadMax: 16 }), 'Chat'), undefined);
    assert.equal(
      port.unfit(fake.fakeMessenger({ payloadMax: 15 }), 'Chat'),
      'Chat cannot carry Remote’s buttons, so Remote cannot run on it.'
    );
  });

  it('refuses a messenger whose notice cannot carry two buttons', () => {
    assert.equal(port.unfit(fake.fakeMessenger({ perNotice: 2 }), 'Chat'), undefined);
    assert.equal(
      port.unfit(fake.fakeMessenger({ perNotice: 1 }), 'Chat'),
      'Chat cannot carry Remote’s buttons, so Remote cannot run on it.'
    );
  });

  it('registers no messenger that rule would refuse', async (t) => {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(fx.authTest())));
    const credentials: Record<string, Record<string, string>> = { slack: CREDENTIALS };
    for (const entry of port.messengers()) {
      const created = await entry.create(credentials[entry.id] ?? {});
      assert.ok(created.ok, entry.id);
      assert.equal(port.unfit(created.messenger, entry.label), undefined, entry.id);
    }
  });

  it('holds the fake, unlisted', async () => {
    const entry = port.messenger('fake');
    assert.ok(entry);
    assert.equal(entry.listed, false);
    assert.ok(port.messengers().includes(entry));
    const created = await entry.create({});
    assert.equal(created.ok, true);
  });

  it('asks the fake for one token, so a host can store it and turn-on reads it', () => {
    const entry = port.messenger('fake');
    assert.ok(entry);
    assert.deepEqual(
      entry.setup.fields.map((field) => field.key),
      ['token']
    );
    const allowlist = ['phone'];
    const fields = entry.setup.fields;
    assert.deepEqual(allow.canTurnOn({ fields, credentials: {}, allowlist }), {
      ok: false,
      reason: 'Remote needs the Token first.'
    });
    assert.deepEqual(allow.canTurnOn({ fields, credentials: { token: 't' }, allowlist }), {
      ok: true
    });
  });
});

describe('a setup check', () => {
  /** What the port promises of every outcome: an explicit kind, a step that
   *  indexes the entry's own steps, facts as label and value. */
  function assertShape(result: port.SetupCheck, steps: number, id: string): void {
    switch (result.kind) {
      case 'ok':
        for (const fact of result.facts) {
          assert.equal(typeof fact.label, 'string', id);
          assert.equal(typeof fact.value, 'string', id);
        }
        return;
      case 'setup':
        assert.ok(Number.isInteger(result.step), id);
        assert.ok(result.step >= 0 && result.step < steps, id);
        assert.ok(result.reason.length > 0, id);
        return;
      case 'unreachable':
        assert.ok(result.reason.length > 0, id);
        return;
      default:
        assert.fail(`${id}: no such kind ${JSON.stringify(result)}`);
    }
  }

  it('answers in the port’s shape for every registered entry that has one', async () => {
    for (const entry of port.messengers()) {
      if (!entry.check) continue;
      const result = await entry.check({}, new AbortController().signal);
      assertShape(result, entry.setup.create?.steps.length ?? 0, entry.id);
    }
  });

  it('answers ok from the fake, with what it found', async () => {
    const result = await fake.fakeEntry.check?.({}, new AbortController().signal);
    assert.equal(result?.kind, 'ok');
    assert.ok(result?.kind === 'ok' && result.facts.length > 0);
  });

  it('gives the fake steps and an existing-app row, so its guide draws something', () => {
    const create = fake.fakeEntry.setup.create;
    assert.equal(create?.steps.length, 2);
    assert.ok((create?.existing ?? []).length > 0);
  });
});

// One fake per shape the seam abstracts: a threaded messenger with a large
// payload and edits, and a reply-chain one with a small payload, with and
// without edits.
portContract('thread, 2000-byte payloads, edit', () =>
  fakeHarness({ shape: 'thread', payloadMax: 2000, edit: true })
);
portContract('chain, 64-byte payloads, edit', () =>
  fakeHarness({ shape: 'chain', payloadMax: 64, edit: true })
);
portContract('chain, 64-byte payloads, no edit', () =>
  fakeHarness({ shape: 'chain', payloadMax: 64, edit: false })
);

describe('the fake', () => {
  it('records each post and settle once, as it happens, in order', async () => {
    const { messenger } = fakeHarness();
    const seen: string[] = [];
    messenger.onRecord((record) => seen.push(record.kind));
    const first = await messenger.post(
      { home: 'U1' },
      { kind: 'permission', body: 'May I?', buttons: [{ label: 'Deny', payload: 'c1.a' }] }
    );
    await messenger.post({ home: 'U1' }, { kind: 'finished', body: 'Done.' });
    await messenger.edit?.settle(first.message, {
      kind: 'permission',
      body: 'May I?',
      settled: 'Denied'
    });
    assert.deepEqual(seen, ['post', 'post', 'settle']);
    assert.equal(messenger.posts().length, 2);
    assert.equal(messenger.settles().length, 1);
  });

  it('holds connecting until the link driver moves it, firing once per move', () => {
    const { messenger } = fakeHarness({ held: true });
    const link = messenger.connect(() => undefined);
    const moves: string[] = [];
    link.onState((state) => moves.push(state.kind));
    assert.equal(link.state.kind, 'connecting');
    messenger.link({ kind: 'connected' });
    assert.equal(link.state.kind, 'connected');
    messenger.link({ kind: 'reconnecting', reason: 'the socket dropped' });
    messenger.link({ kind: 'failed', reason: 'the token was revoked', retry: false });
    assert.deepEqual(moves, ['connected', 'reconnecting', 'failed']);
  });

  it('connects at once when not held', () => {
    const { messenger } = fakeHarness();
    assert.equal(messenger.connect(() => undefined).state.kind, 'connected');
  });

  it('reads a top-level message as having no ref, in either shape', () => {
    for (const shape of ['thread', 'chain'] as const) {
      const { messenger } = fakeHarness({ shape });
      const events: Inbound[] = [];
      messenger.connect((event) => events.push(event));
      messenger.say('U1', 'start something');
      const said = events[0];
      assert.equal(said?.kind, 'message');
      if (said?.kind === 'message') assert.deepEqual(said.refs, [], shape);
    }
  });

  it('turns command text it cannot name into help, raw', () => {
    const { messenger } = fakeHarness();
    const events: Inbound[] = [];
    messenger.connect((event) => events.push(event));
    messenger.command('U1', 'list');
    messenger.command('U1', 'frobnicate', 'now');
    const [list, other] = events;
    assert.equal(list?.kind === 'command' && list.name, 'list');
    assert.ok(other?.kind === 'command');
    assert.equal(other.name, 'help');
    assert.equal(other.args, 'frobnicate now');
    assert.deepEqual(other.refs, []);
  });

  it('records a file sent into a conversation, and links an anchor it knows', async () => {
    const { messenger } = fakeHarness();
    const posted = await messenger.post({ home: 'U1' }, { kind: 'finished', body: 'Done.' });
    const place = { conversation: { anchor: posted.anchor, latest: posted.message } };
    const bytes = Buffer.from('png');
    await messenger.files?.send(place, { bytes, name: 'a.png', mime: 'image/png' });
    assert.deepEqual(
      messenger.attachments().map((a) => a.attachment.name),
      ['a.png']
    );
    assert.ok(await messenger.links?.to(posted.anchor));
    assert.equal(await messenger.links?.to('nowhere'), undefined);
  });

  it('reads seeded lines oldest first, without the bot', async () => {
    const { messenger } = fakeHarness({ now: () => 5_000 });
    const anchor = 'C1';
    const signal = new AbortController().signal;
    messenger.earlier(anchor, [
      { author: 'Ada', text: 'the first reply', files: ['a.png'] },
      { author: 'Cy', text: 'no files', files: [] },
      { author: messenger.bot, text: 'already answered' }
    ]);
    messenger.earlier('C2', [{ author: 'Bea', text: 'another thread' }]);
    messenger.say('U1', 'and then this', { in: anchor });
    const mention = messenger.say('U1', 'weigh in', { in: anchor, addressed: 'mention' });
    messenger.say('U1', 'after it', { in: anchor });
    if (mention?.kind !== 'message') assert.fail('the mention was not delivered');
    assert.deepEqual(await messenger.thread.read(anchor, mention.ref, signal), {
      ok: true,
      truncated: false,
      total: 3,
      lines: [
        { author: 'Ada', text: 'the first reply', at: 5_000, files: ['a.png'] },
        { author: 'Cy', text: 'no files', at: 5_001 },
        { author: 'U1', text: 'and then this', at: 5_004 }
      ]
    });
    assert.deepEqual(await messenger.thread.read(anchor, 'no-such-ref', signal), {
      ok: true,
      lines: [],
      truncated: false,
      total: 0
    });
    const backlog = await messenger.backlog?.since([anchor], 0, signal);
    assert.deepEqual(
      backlog?.events.flatMap((event) => (event.kind === 'message' ? [event.text] : [])),
      ['and then this', 'weigh in', 'after it']
    );
  });

  it('answers an armed read failure once, and an abort does not spend it', async () => {
    const { messenger } = fakeHarness({ now: () => 5_000 });
    const anchor = 'C1';
    const signal = new AbortController().signal;
    messenger.earlier(anchor, [{ author: 'Ada', text: 'still there' }]);
    const mention = messenger.say('U1', 'weigh in', { in: anchor, addressed: 'mention' });
    if (mention?.kind !== 'message') assert.fail('the mention was not delivered');
    const aborted = new AbortController();
    aborted.abort();
    messenger.failRead('scope');
    assert.deepEqual(await messenger.thread.read(anchor, mention.ref, aborted.signal), {
      ok: false,
      reason: 'unreachable'
    });
    assert.deepEqual(await messenger.thread.read(anchor, mention.ref, signal), {
      ok: false,
      reason: 'scope'
    });
    messenger.failRead('unreachable');
    assert.deepEqual(await messenger.thread.read(anchor, mention.ref, signal), {
      ok: false,
      reason: 'unreachable'
    });
    assert.deepEqual(await messenger.thread.read(anchor, mention.ref, signal), {
      ok: true,
      truncated: false,
      total: 1,
      lines: [{ author: 'Ada', text: 'still there', at: 5_000 }]
    });
  });
});
