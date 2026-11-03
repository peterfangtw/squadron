import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Inbound } from '../../core/bridge/model';
import type { Backlog, Messenger } from '../../core/bridge/port';
import { disposeHome } from '../helpers';
import {
  boot,
  stopBridges,
  T0,
  OWNER,
  home,
  catching,
  fake,
  paths,
  words,
  make,
  finished,
  saved,
  begin
} from './bridge_engine_helpers';

before(async () => {
  await boot();
});

after(async () => {
  await stopBridges();
  await disposeHome(home);
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

describe('the engine: catching up after a gap', () => {
  const MINUTE = 60_000;
  beforeEach(() => fs.rm(paths.HEARD_FILE, { force: true }));

  /** Lets the catch-up's read settle and its step join the chain. */
  async function settle(t: ReturnType<typeof make>): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    await t.drain();
  }

  /** An engine over a held fake whose messages are stamped `clock.at`, with
   *  a root's conversation open and the link up once, so a watermark is set. */
  async function opened() {
    const clock = { at: T0 + 10_000 };
    const messenger = fake.fakeMessenger({ held: true, now: () => clock.at });
    const t = make({ messenger });
    await begin(t.bridge);
    messenger.link({ kind: 'connected' });
    await settle(t);
    const { root, post } = await finished({ ...t, messenger });
    return { t, messenger, clock, root, post };
  }

  it('routes a reply missed while the link was down, once, when it comes back', async () => {
    const { t, messenger, clock, post } = await opened();
    messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    messenger.missed(OWNER, 'and the docs', { in: post.posted.anchor });
    await settle(t);
    assert.equal(t.verbs.of('send').length, 0, 'nothing while the link is down');
    messenger.link({ kind: 'connected' });
    await settle(t);
    assert.deepEqual(
      t.verbs.of('send').map((c) => c.args[1]),
      ['and the docs']
    );
  });

  it('reads a window again after a read that failed, though live messages came since', async () => {
    const clock = { at: T0 + 10_000 };
    const inner = fake.fakeMessenger({ held: true, now: () => clock.at });
    const asked: number[] = [];
    let failing = false;
    const flaky: Messenger = {
      ...inner,
      backlog: {
        since(anchors, after, signal) {
          asked.push(after);
          return failing
            ? Promise.reject(new Error('the network is down'))
            : inner.backlog!.since(anchors, after, signal);
        }
      }
    };
    const t = make({ messenger: flaky });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await settle(t);
    const { post } = await finished({ ...t, messenger: inner });
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    inner.missed(OWNER, 'in the gap', { in: post.posted.anchor });
    failing = true;
    inner.link({ kind: 'connected' });
    await settle(t);
    clock.at += 1_000;
    inner.say(OWNER, 'live', { in: post.posted.anchor });
    await settle(t);
    failing = false;
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.link({ kind: 'connected' });
    await settle(t);
    assert.equal(asked.at(-1), asked.at(-2), 'the second read starts where the failed one did');
    assert.deepEqual(
      t.verbs.of('send').map((c) => c.args[1]),
      ['live', 'in the gap']
    );
    assert.ok(t.logs.some((line) => line.includes('the network is down')));
  });

  it('does not act twice after a reload while a window waits to be read again', async () => {
    const clock = { at: T0 + 10_000 };
    const inner = fake.fakeMessenger({ held: true, now: () => clock.at });
    let failing = false;
    const flaky: Messenger = {
      ...inner,
      backlog: {
        since: (anchors, after, signal) =>
          failing
            ? Promise.reject(new Error('the network is down'))
            : inner.backlog!.since(anchors, after, signal)
      }
    };
    const t = make({ messenger: flaky });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await settle(t);
    const { root, post } = await finished({ ...t, messenger: inner });
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    inner.missed(OWNER, 'in the gap', { in: post.posted.anchor });
    failing = true;
    inner.link({ kind: 'connected' });
    await settle(t);
    clock.at += 1_000;
    inner.say(OWNER, 'live', { in: post.posted.anchor });
    await settle(t);
    await t.bridge.stop();

    failing = false;
    const next = make({ messenger: flaky });
    await begin(next.bridge, [root]);
    inner.link({ kind: 'connected' });
    await settle(next);
    assert.deepEqual(
      [...t.verbs.of('send'), ...next.verbs.of('send')].map((c) => c.args[1]),
      ['live', 'in the gap']
    );
  });

  it('keeps a window held when a second return overlaps a first that succeeds', async () => {
    const inner = fake.fakeMessenger({ held: true });
    const asked: number[] = [];
    const reads: (() => Promise<import('../../core/bridge/port').Backlog>)[] = [];
    const gate: { open?: () => void } = {};
    const scripted: Messenger = {
      ...inner,
      backlog: {
        since(anchors, after, signal) {
          asked.push(after);
          const next = reads.shift();
          return next ? next() : inner.backlog!.since(anchors, after, signal);
        }
      }
    };
    const t = make({ messenger: scripted });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await settle(t);
    const { post } = await finished({ ...t, messenger: inner });
    reads.push(
      async () => {
        await new Promise<void>((resolve) => (gate.open = resolve));
        return { events: [], missed: 0 };
      },
      () => Promise.reject(new Error('the network is down'))
    );
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.link({ kind: 'connected' });
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.link({ kind: 'connected' });
    gate.open?.();
    await settle(t);
    inner.say(OWNER, 'live', { in: post.posted.anchor });
    await settle(t);
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.link({ kind: 'connected' });
    await settle(t);
    assert.equal(asked.at(-1), asked.at(-2), 'the failed read is read again');
  });

  it('abandons a read in flight when it stops, and routes nothing', async () => {
    const inner = fake.fakeMessenger({ held: true });
    const signals: AbortSignal[] = [];
    const hung: Messenger = {
      ...inner,
      backlog: {
        since(_anchors, _after, signal) {
          signals.push(signal);
          return new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          );
        }
      }
    };
    const t = make({ messenger: hung });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await t.bridge.stop();
    assert.equal(signals[0]?.aborted, true);
    assert.equal(t.verbs.calls.length, 0);
  });

  for (const late of ['success', 'rejection'] as const) {
    it(`frees the chain from a read that ignores abort, and a late ${late} does nothing`, async (c) => {
      c.mock.timers.enable({ apis: ['setTimeout'] });
      const inner = fake.fakeMessenger({ held: true });
      let asked = false;
      let answer!: (found: Backlog) => void;
      let refuse!: (err: Error) => void;
      const deaf: Messenger = {
        ...inner,
        backlog: {
          since() {
            asked = true;
            return new Promise((resolve, reject) => {
              answer = resolve;
              refuse = reject;
            });
          }
        }
      };
      const t = make({ messenger: deaf });
      await begin(t.bridge);
      inner.link({ kind: 'connected' });
      assert.ok(asked, 'the link coming up reads the backlog');
      const heard = await fs.readFile(paths.HEARD_FILE, 'utf8');
      c.mock.timers.tick(catching.CATCH_UP_MS);
      const missed = inner.missed(OWNER, 'sent while down');
      assert.ok(missed);

      let drained = false;
      void t.drain().then(() => (drained = true));
      for (let i = 0; i < 20 && !drained; i++) await new Promise((r) => setImmediate(r));
      assert.ok(drained, 'routing goes on after the read times out');

      if (late === 'success') answer({ events: [missed], missed: 0 });
      else refuse(new Error('late'));
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      await t.drain();
      assert.equal(t.verbs.calls.length, 0, 'nothing routed');
      assert.deepEqual(inner.posts(), [], 'nothing posted');
      assert.deepEqual(inner.reactionEffects(), [], 'no received status');
      assert.deepEqual(await saved(), [], 'nothing admitted');
      assert.equal(await fs.readFile(paths.HEARD_FILE, 'utf8'), heard, 'the watermark stays');
      await t.bridge.stop();
    });
  }

  it('stops without waiting on a read that ignores abort', async () => {
    const inner = fake.fakeMessenger({ held: true });
    let answer!: (found: Backlog) => void;
    const deaf: Messenger = {
      ...inner,
      backlog: { since: () => new Promise((resolve) => (answer = resolve)) }
    };
    const t = make({ messenger: deaf });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    let stopped = false;
    void t.bridge.stop().then(() => (stopped = true));
    for (let i = 0; i < 20 && !stopped; i++) await new Promise((r) => setImmediate(r));
    assert.ok(stopped, 'stop does not wait on the abandoned read');
    answer({ events: [inner.missed(OWNER, 'sent while down')], missed: 0 });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(t.verbs.calls.length, 0);
    assert.deepEqual(await saved(), []);
  });

  it('survives a read that throws as it is asked, and reads that window again', async () => {
    const clock = { at: T0 + 10_000 };
    const inner = fake.fakeMessenger({ held: true, now: () => clock.at });
    const asked: number[] = [];
    const brittle: Messenger = {
      ...inner,
      backlog: {
        since(anchors, after, signal) {
          asked.push(after);
          if (asked.length === 1) throw new Error('no socket');
          return inner.backlog!.since(anchors, after, signal);
        }
      }
    };
    const t = make({ messenger: brittle });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await settle(t);
    assert.ok(
      t.logs.some((line) => line.includes('no socket')),
      t.logs.join('\n')
    );
    clock.at += 1_000;
    inner.say(OWNER, 'live since');
    await settle(t);
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.link({ kind: 'connected' });
    await settle(t);
    assert.equal(asked.length, 2);
    assert.equal(asked[1], asked[0], 'the failed window is read again');
  });

  it('logs a message a stop cut short, by kind and id', async () => {
    const gate: { open?: () => void } = {};
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    const { port } = t.verbs;
    const send = port.send.bind(port);
    port.send = async (a, text) => {
      await new Promise<void>((resolve) => (gate.open = resolve));
      return send(a, text);
    };
    const said = t.messenger.say(OWNER, 'cut', { in: post.posted.anchor });
    for (let i = 0; i < 10 && gate.open === undefined; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const stopping = t.bridge.stop();
    gate.open?.();
    await stopping;
    assert.ok(
      t.logs.some((line) => line.includes('cut short') && line.includes(String(said?.id))),
      t.logs.join('\n')
    );
    assert.ok(!t.logs.some((line) => line.includes('cut') && line.includes('"cut"')));
  });

  it('answers late ones once per conversation across engine rebuilds', async (context) => {
    const { t, messenger, clock, root, post } = await opened();
    context.after(() => t.bridge.stop());
    messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    for (const text of ['one', 'two', 'three']) {
      messenger.missed(OWNER, text, { in: post.posted.anchor });
    }
    t.advance(20 * MINUTE);
    messenger.link({ kind: 'connected' });
    await settle(t);
    assert.equal(t.verbs.of('send').length, 0);
    const missed = messenger
      .posts()
      .filter((p) => p.notice.body === words.missedOfflineNotice.body);
    assert.equal(missed.length, 1);
    await t.bridge.stop();
    for (let i = 0; i < 2; i++) {
      const next = make({ messenger, now: t.now });
      context.after(() => next.bridge.stop());
      await begin(next.bridge, [root]);
      messenger.link({ kind: 'connected' });
      await settle(next);
      assert.equal(
        messenger.posts().filter((p) => p.notice.body === words.missedOfflineNotice.body).length,
        1,
        'a rebuild must not refuse a suppressed message again'
      );
      assert.equal(next.verbs.of('send').length, 0);
      await next.bridge.stop();
    }
    const messages = (await saved()).flatMap((record) => record.messages ?? []);
    assert.equal(messages.length, 3);
    assert.ok(messages.every((message) => message.delivery === 'settled' && message.terminal));
    assert.ok(messages.every((message) => message.event === undefined));
  });

  it('answers each late place once across a partial read, a cut replay and a rebuild', async (context) => {
    const { t, messenger, clock, root, post } = await opened();
    context.after(() => t.bridge.stop());
    const thread = post.posted.anchor;
    messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    const dms: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      messenger.missed(OWNER, text, { in: thread });
      const dm = messenger.missed(OWNER, `dm ${text}`);
      assert.ok(dm.kind === 'message');
      dms.push(dm.ref);
    }
    t.advance(20 * MINUTE);
    const backlog = messenger.backlog!;
    const reading = backlog.since.bind(backlog);
    backlog.since = async (anchors, after, signal) => {
      backlog.since = reading;
      const found = await reading(anchors, after, signal);
      const unread = (e: Inbound) => e.kind === 'message' && e.refs[0] === thread;
      return { events: found.events.filter((e) => !unread(e)), missed: 1 };
    };
    const late = () =>
      messenger.posts().filter((p) => p.notice.body === words.missedOfflineNotice.body);
    const posting = messenger.post.bind(messenger);
    let stopping: Promise<void> | undefined;
    messenger.post = (place, notice) => {
      const cut = notice.body === words.missedOfflineNotice.body && 'under' in place;
      if (!cut || place.under !== thread) return posting(place, notice);
      stopping ??= t.bridge.stop();
      return Promise.reject(new Error('cut'));
    };
    messenger.link({ kind: 'connected' });
    await settle(t);
    assert.equal(late().length, 3, 'the first read answers each DM it reached');
    messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    messenger.link({ kind: 'connected' });
    await settle(t);
    await stopping;
    assert.equal(late().length, 3, 'the stop cuts the reply in the thread');
    messenger.post = posting;
    const next = make({ messenger, now: t.now });
    context.after(() => next.bridge.stop());
    await begin(next.bridge, [root]);
    await settle(next);
    assert.deepEqual(
      late().map((p) => p.place),
      [...dms.map((under) => ({ under })), { under: thread }],
      'one reply per place, none again after the rebuild'
    );
    assert.equal(next.verbs.of('send').length + next.verbs.of('start').length, 0);
    await next.bridge.stop();
    const messages = (await saved()).flatMap((record) => record.messages ?? []);
    assert.equal(messages.length, 6);
    assert.ok(messages.every((message) => message.delivery === 'settled' && message.terminal));
  });

  it('answers each late top-level DM under its own message', async (context) => {
    const { t, messenger, clock } = await opened();
    context.after(() => t.bridge.stop());
    messenger.link({ kind: 'reconnecting', reason: 'dropped' });
    clock.at += 1_000;
    const messages = ['one', 'two'].map((text) => messenger.missed(OWNER, text));
    t.advance(20 * MINUTE);
    messenger.link({ kind: 'connected' });
    await settle(t);
    assert.deepEqual(
      messenger
        .posts()
        .filter((p) => p.notice.body === words.missedOfflineNotice.body)
        .map((p) => p.place),
      messages.map((message) => {
        assert.ok(message.kind === 'message');
        return { under: message.ref };
      })
    );
    assert.equal(t.verbs.of('start').length, 0);
    assert.equal(t.verbs.of('send').length, 0);
  });

  it('routes what it caught up before a live message that arrived meanwhile', async () => {
    /** Once armed, the next read waits until the test opens it. */
    const gate: { armed?: boolean; open?: () => void } = {};
    const inner = fake.fakeMessenger({ held: true });
    const slow: Messenger = {
      ...inner,
      backlog: {
        async since(anchors, after, signal) {
          if (gate.armed) await new Promise<void>((resolve) => (gate.open = resolve));
          return inner.backlog!.since(anchors, after, signal);
        }
      }
    };
    const t = make({ messenger: slow });
    await begin(t.bridge);
    inner.link({ kind: 'connected' });
    await settle(t);
    const { post } = await finished({ ...t, messenger: inner });
    inner.link({ kind: 'reconnecting', reason: 'dropped' });
    inner.missed(OWNER, 'first', { in: post.posted.anchor });
    gate.armed = true;
    inner.link({ kind: 'connected' });
    inner.say(OWNER, 'second', { in: post.posted.anchor });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    gate.open?.();
    await settle(t);
    assert.deepEqual(
      t.verbs.of('send').map((c) => c.args[1]),
      ['first', 'second']
    );
  });

  it('catches up after a restart what it never began routing', async () => {
    const { t, messenger, clock, root, post } = await opened();
    await t.bridge.stop();
    clock.at += 1_000;
    messenger.missed(OWNER, 'while reloading', { in: post.posted.anchor });
    const next = make({ messenger });
    await begin(next.bridge, [root]);
    messenger.link({ kind: 'connected' });
    await settle(next);
    assert.deepEqual(
      next.verbs.of('send').map((c) => c.args[1]),
      ['while reloading']
    );
  });

  it('catches up nothing after a person turns Remote on', async () => {
    const { t, messenger, clock, root, post } = await opened();
    await t.bridge.stop();
    clock.at += 1_000;
    messenger.missed(OWNER, 'from before', { in: post.posted.anchor });
    const next = make({ messenger, fresh: true });
    next.advance(5_000);
    await begin(next.bridge, [root]);
    messenger.link({ kind: 'connected' });
    await settle(next);
    assert.equal(next.verbs.of('send').length, 0);
  });
});
