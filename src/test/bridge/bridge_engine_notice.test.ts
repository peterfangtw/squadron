import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { SessionAddr, Watched } from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import { disposeHome } from '../helpers';
import {
  boot,
  stopBridges,
  APP,
  OWNER,
  home,
  engine,
  fake,
  paths,
  words,
  watched,
  addr,
  permission,
  claim,
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

describe('the engine: notices', () => {
  it('opens one conversation for a root and its child waiting in the same pass', async () => {
    const t = make();
    await begin(t.bridge);
    const root = watched(10, { status: 'waiting' }, [permission('p0')]);
    const child = watched(11, { parentSessionId: 's10', status: 'waiting' }, [permission('p1')]);
    await t.bridge.observe([root, child], []);
    const posts = t.messenger.posts();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0]?.place, { home: OWNER });
    assert.ok(posts[1] && 'conversation' in posts[1].place);
    assert.equal(posts[0]?.notice.mention, OWNER);
    const records = await saved();
    assert.equal(records.length, 1);
    assert.deepEqual(
      records[0]?.notices.map((n) => [n.requestId, n.target?.pid]),
      [
        ['p0', 10],
        ['p1', 11]
      ]
    );
  });

  for (const brand of [undefined, 'grok', 'codex'] as const) {
    it(`keeps a ${brand ?? 'legacy'} root's brand across unbranded observations and accepts a stated brand`, async () => {
      const root = watched(10, { brand, status: 'waiting' }, [permission('p0')]);
      const first = make();
      await begin(first.bridge, [root]);
      assert.equal((await saved())[0]?.root?.brand, brand ?? 'claude');
      await first.bridge.stop();

      const unbranded = {
        ...root,
        session: { ...root.session, brand: undefined, sessionId: 'after-clear' }
      };
      const second = make();
      await begin(second.bridge, [unbranded]);
      const [record] = await saved();
      assert.equal(record?.root?.brand, brand ?? 'claude');
      assert.equal(record?.root?.sessionId, 'after-clear');
      assert.deepEqual(record?.past, ['s10']);

      const stated = brand === 'codex' ? 'grok' : 'codex';
      await second.bridge.observe(
        [{ ...unbranded, session: { ...unbranded.session, brand: stated } }],
        []
      );
      assert.equal((await saved())[0]?.root?.brand, stated);
      await second.bridge.stop();
    });
  }

  it('does not post a waiting request twice across a reload', async () => {
    const root = watched(10, { status: 'waiting' }, [permission('p0')]);
    const messenger = fake.fakeMessenger();
    const first = make({ messenger });
    await begin(first.bridge, [root], []);
    first.bridge.stop();
    const second = make({ messenger });
    await begin(second.bridge, [root], []);
    assert.equal(messenger.posts().length, 1);
  });

  it('settles a closed request after a reload by rendering the stored notice again', async () => {
    const root = watched(10, { status: 'waiting' }, [permission('p0')]);
    const messenger = fake.fakeMessenger();
    const first = make({ messenger });
    await begin(first.bridge, [root], []);
    first.bridge.stop();
    const shown = { ...messenger.posts()[0]?.notice };
    const second = make({ messenger });
    await begin(second.bridge, [root], []);
    await second.bridge.observe([{ ...root, pending: [] }], []);
    const settle = messenger.settles()[0];
    assert.ok(settle && shown.body !== undefined);
    assert.equal(settle.notice.settled, words.NO_LONGER_WAITING);
    assert.equal(settle.notice.body, shown.body);
    assert.deepEqual(settle.notice.buttons, []);
  });

  it('settles on its first pass a request that closed while Remote was off', async () => {
    const asking = watched(10, { status: 'waiting' }, [permission('p0')]);
    const gone = watched(11, { status: 'waiting' }, [permission('p1')]);
    const kept = watched(12, { status: 'waiting' }, [permission('p2')]);
    const messenger = fake.fakeMessenger();
    const first = make({ messenger });
    await begin(first.bridge, [asking, gone, kept], []);
    await first.bridge.stop();
    assert.equal(messenger.posts().length, 3);

    const second = make({ messenger });
    await begin(second.bridge, [{ ...asking, pending: [] }, kept], []);
    const settled = messenger.settles().map((s) => s.notice.settled);
    assert.deepEqual(settled, [words.NO_LONGER_WAITING, words.NO_LONGER_WAITING]);
    await second.bridge.observe([{ ...asking, pending: [] }, kept], []);
    assert.equal(messenger.settles().length, 2);
    assert.equal(messenger.posts().length, 3);
  });

  it('posts a root’s finish with its last reply', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    assert.match(post.notice.body, /All done\./);
    assert.deepEqual(t.verbs.of('lastReply')[0]?.args, [addr(watched(10))]);
  });

  it('logs a post that throws, leaves the store as it was, and tries it again', async () => {
    const messenger = fake.fakeMessenger();
    let down = true;
    const flaky: Messenger = {
      ...messenger,
      post: (place, notice) =>
        down ? Promise.reject(new Error('the network is down')) : messenger.post(place, notice)
    };
    const t = make({ messenger: flaky });
    await begin(t.bridge);
    const root = watched(10, { status: 'waiting' }, [permission('p0')]);
    await t.bridge.observe([root], []);
    assert.deepEqual(await saved(), []);
    assert.ok(t.logs.some((line) => line.includes('the network is down')));
    down = false;
    const next = { ...root, pending: [permission('p0'), permission('p1')] };
    await t.bridge.observe([next], []);
    const records = await saved();
    assert.equal(records.length, 1);
    assert.deepEqual(
      records[0]?.notices.map((n) => n.requestId),
      ['p0', 'p1']
    );
    assert.equal(records[0]?.anchor, messenger.posts()[0]?.posted.anchor);
  });

  it('keeps posting when the store cannot be written', async () => {
    await fs.mkdir(path.dirname(paths.CONVERSATIONS_DIR), { recursive: true });
    await fs.writeFile(paths.CONVERSATIONS_DIR, 'not a directory');
    try {
      const t = make();
      await begin(t.bridge, [watched(10, { status: 'waiting' }, [permission('p0')])], []);
      await t.bridge.observe(
        [watched(10, { status: 'waiting' }, [permission('p0'), permission('p1')])],
        []
      );
      assert.equal(t.messenger.posts().length, 2);
      assert.ok(t.logs.some((line) => /not written/.test(line)));
    } finally {
      await fs.rm(paths.CONVERSATIONS_DIR, { force: true });
    }
  });
});

describe('the engine: notices owed after a failed post', () => {
  /** The fake, with posts that throw while `down` is set. */
  function flaky() {
    const messenger = fake.fakeMessenger();
    const net = { down: false };
    const wrapped: Messenger = {
      ...messenger,
      post: (place, notice) =>
        net.down ? Promise.reject(new Error('the network is down')) : messenger.post(place, notice)
    };
    return { messenger, wrapped, net };
  }

  it('posts a failed finish on the next pass, once, and asks for that pass', async () => {
    const f = flaky();
    const t = make({ messenger: f.wrapped });
    await begin(t.bridge);
    const root = watched(10);
    await t.bridge.observe([root], []);
    f.net.down = true;
    const after = { ...root, session: { ...root.session, turnsEnded: 1 } };
    await t.bridge.observe([after], []);
    assert.equal(f.messenger.posts().length, 0);
    assert.equal(t.bridge.nextDeadline(), t.now() + engine.OWED_RETRY_MS);

    f.net.down = false;
    await t.bridge.observe([after], []);
    await t.bridge.observe([after], []);
    assert.deepEqual(
      f.messenger.posts().map((p) => p.notice.kind),
      ['finished']
    );
    assert.equal(t.bridge.nextDeadline(), undefined);
  });

  it('posts nothing for a request that closed before the retry', async () => {
    const f = flaky();
    const t = make({ messenger: f.wrapped });
    await begin(t.bridge);
    f.net.down = true;
    const asking = watched(10, { status: 'waiting' }, [permission('p0')]);
    await t.bridge.observe([asking], []);
    f.net.down = false;
    await t.bridge.observe([{ ...asking, pending: [] }], []);
    assert.equal(f.messenger.posts().length, 0);
    assert.equal(f.messenger.settles().length, 0);
  });

  it('posts a failed stop on the next pass', async () => {
    const f = flaky();
    const t = make({ messenger: f.wrapped });
    await begin(t.bridge);
    await finished({ ...t, messenger: f.messenger });
    const busy = watched(10, { status: 'busy', turnsEnded: 1 });
    await t.bridge.observe([busy], []);
    f.net.down = true;
    const gone: Watched = { ...busy, exit: { code: 1, signal: null } };
    await t.bridge.observe([gone], []);
    f.net.down = false;
    await t.bridge.observe([gone], []);
    await t.bridge.observe([gone], []);
    assert.deepEqual(
      f.messenger.posts().map((p) => p.notice.kind),
      ['finished', 'stopped']
    );
  });

  it('hands what it owes to the engine a rebuild makes', async () => {
    const f = flaky();
    const first = make({ messenger: f.wrapped });
    await begin(first.bridge);
    const root = watched(10);
    await first.bridge.observe([root], []);
    f.net.down = true;
    const after = { ...root, session: { ...root.session, turnsEnded: 1 } };
    await first.bridge.observe([after], []);
    const carried = first.bridge.observation();
    await first.bridge.stop();

    f.net.down = false;
    const second = make({ messenger: f.wrapped, ...(carried ? { observed: carried } : {}) });
    await second.bridge.load();
    await second.bridge.observe([after], []);
    assert.deepEqual(
      f.messenger.posts().map((p) => p.notice.kind),
      ['finished']
    );
  });
});

describe('the engine: a root that stops before finishing (D19, as ruled 2026-10-10)', () => {
  const exited = (w: Watched): Watched => ({ ...w, exit: { code: 1, signal: null } });

  it('posts once with the mention and settles its ask, then a reply starts afresh (D23)', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    const waiting = watched(10, { status: 'waiting', turnsEnded: 1 }, [permission('p1')]);
    await t.bridge.observe([waiting], [claim('w1', APP)]);
    await t.bridge.observe([exited(waiting)], [claim('w1', APP)]);
    await t.bridge.observe([exited(waiting)], [claim('w1', APP)]);
    const stopped = t.messenger.posts().filter((p) => p.notice.kind === 'stopped');
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]?.notice.mention, OWNER);
    assert.equal(stopped[0]?.posted.anchor, post.posted.anchor);
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, words.NO_LONGER_WAITING);
    t.messenger.say(OWNER, 'keep going', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('send').length, 0);
    assert.equal(t.verbs.of('start').length, 1);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'ended');
  });

  it('keeps a live child in the conversation after its exited root’s reply started afresh', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    const busy = watched(10, { status: 'busy', turnsEnded: 1 });
    const child = watched(11, { status: 'busy', parentSessionId: 's10', originSessionId: 's10' });
    await t.bridge.observe([busy, child], [claim('w1', APP)]);
    await t.bridge.observe([exited(busy), child], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'keep going', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('start').length, 1);
    const asking = { ...child, pending: [permission('p1')] };
    await t.bridge.observe([exited(busy), asking], [claim('w1', APP)]);
    const ask = t.messenger.posts().at(-1);
    assert.equal(ask?.notice.kind, 'permission');
    assert.equal(ask?.posted.anchor, post.posted.anchor);
    assert.equal((await saved()).length, 1);
  });

  it('settles the receipt of a reply its outbox held, whose words went with it', async () => {
    const t = make({ answers: { send: { ok: true, queued: 1 } } });
    await begin(t.bridge);
    const { post } = await finished(t);
    const busy = watched(10, { status: 'busy', turnsEnded: 1 });
    await t.bridge.observe([busy], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'and the tests', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'receipt');
    await t.bridge.observe([exited(busy)], [claim('w1', APP)]);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'stopped');
    const settled = t.messenger.settles().at(-1)?.notice;
    assert.equal(settled?.kind, 'receipt');
    assert.equal(settled?.settled, words.NOT_DELIVERED);
  });

  it('posts for another window’s busy root whose record says it exited', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    const busy = watched(10, { status: 'busy', turnsEnded: 1, windowId: 'w2' });
    await t.bridge.observe([busy], []);
    await t.bridge.observe([exited(busy)], []);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'stopped');
    assert.equal(t.messenger.posts().at(-1)?.posted.anchor, post.posted.anchor);
  });

  it('says closed, not stopped, for another window’s busy root that leaves the board: an End there', async () => {
    const t = make();
    await begin(t.bridge);
    await finished(t);
    await t.bridge.observe([watched(10, { status: 'busy', turnsEnded: 1, windowId: 'w2' })], []);
    await t.bridge.observe([], []);
    assert.deepEqual(
      t.messenger.posts().map((p) => p.notice.kind),
      ['finished', 'closed']
    );
  });

  it('posts nothing for a root it ended itself, whose exit its window then saw', async () => {
    const t = make();
    await begin(t.bridge);
    const root = watched(10, { status: 'busy' }, [permission('p0')]);
    await t.bridge.observe([root], []);
    const end = t.messenger.posts()[0]?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(end);
    t.messenger.press(OWNER, end.payload);
    await t.drain();
    const yes = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes);
    t.messenger.press(OWNER, yes.payload);
    await t.drain();
    await t.bridge.observe([exited(root)], []);
    await t.bridge.observe([], []);
    assert.deepEqual(
      t.messenger.posts().map((p) => p.notice.kind),
      ['permission', 'confirm']
    );
  });
});

describe('the engine: a root that closes', () => {
  it('says so once in its conversation, unmentioned, and a reply starts afresh (D23)', async () => {
    const t = make();
    await begin(t.bridge);
    const { root, post } = await finished(t);
    await t.bridge.observe([], [claim('w1', APP)]);
    await t.bridge.observe([], [claim('w1', APP)]);
    const closed = t.messenger.posts().filter((p) => p.notice.kind === 'closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.notice.mention, undefined);
    assert.equal(closed[0]?.posted.anchor, post.posted.anchor);
    const [record] = await saved();
    assert.equal(record?.notices.at(-1)?.target?.pid, root.session.pid);
    t.messenger.say(OWNER, 'one more thing', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('start').length, 1);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'ended');
  });

  it('settles the receipt of a reply its outbox held', async () => {
    const t = make({ answers: { send: { ok: true, queued: 1 } } });
    await begin(t.bridge);
    const { post } = await finished(t);
    const busy = watched(10, { status: 'busy', turnsEnded: 1 });
    await t.bridge.observe([busy], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'and the tests', { in: post.posted.anchor });
    await t.drain();
    await t.bridge.observe([], [claim('w1', APP)]);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'closed');
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, words.NOT_DELIVERED);
  });

  it('posts nothing for a root with no conversation', async () => {
    const t = make();
    await begin(t.bridge);
    await t.bridge.observe([watched(10)], []);
    await t.bridge.observe([], []);
    assert.deepEqual(t.messenger.posts(), []);
  });

  it('posts nothing for a root it ended itself, gone from the board', async () => {
    const t = make();
    await begin(t.bridge);
    await finished(t);
    const end = t.messenger.posts().length;
    t.messenger.command(OWNER, 'end', '10');
    await t.drain();
    const yes = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes, 'a confirm');
    t.messenger.press(OWNER, yes.payload);
    await t.drain();
    await t.bridge.observe([], [claim('w1', APP)]);
    assert.equal(t.messenger.posts().length, end + 1, 'the confirm, and nothing after it');
  });

  it('posts a close that failed on the next pass, once', async () => {
    const messenger = fake.fakeMessenger();
    const net = { down: false };
    const t = make({
      messenger: {
        ...messenger,
        post: (place, notice) =>
          net.down
            ? Promise.reject(new Error('the network is down'))
            : messenger.post(place, notice)
      }
    });
    await begin(t.bridge);
    await finished({ ...t, messenger });
    net.down = true;
    await t.bridge.observe([], []);
    net.down = false;
    await t.bridge.observe([], []);
    await t.bridge.observe([], []);
    assert.deepEqual(
      messenger.posts().map((p) => p.notice.kind),
      ['finished', 'closed']
    );
  });

  it('a pass cut short between two closes posts only the second from the next engine', async () => {
    const messenger = fake.fakeMessenger();
    const t = make({
      messenger: {
        ...messenger,
        post(place, notice) {
          if (notice.kind !== 'closed' || !notice.body.startsWith('n12')) {
            return messenger.post(place, notice);
          }
          // The rebuild lands as the second close posts.
          void t.bridge.stop();
          return Promise.reject(new Error('stopped'));
        }
      }
    });
    const busy = [watched(10, { status: 'busy' }), watched(12, { status: 'busy' })];
    await begin(t.bridge, busy, []);
    await t.bridge.observe(
      [10, 12].map((pid) => watched(pid, { turnsEnded: 1, endedOutcome: 'done' })),
      []
    );
    await t.bridge.observe([], []);
    assert.deepEqual(
      messenger.posts().map((p) => p.notice.kind),
      ['finished', 'finished', 'closed']
    );

    const next = make({ observed: t.bridge.observation() });
    await begin(next.bridge, [], []);
    assert.deepEqual(
      next.messenger.posts().map((p) => p.notice.body),
      ['n12 closed. A reply here starts a new session where it ran.'],
      'the close already posted posted again'
    );
  });
});

describe('the engine: what it hands over', () => {
  it('a pass cut short hands over the board it began from, so its notices still post', async () => {
    const t = make();
    await begin(t.bridge, [watched(10, { status: 'busy' })], []);
    // The stop lands inside the pass, as a rebuild's does, before the finish posts.
    t.verbs.port.lastReply = () => {
      void t.bridge.stop();
      return Promise.resolve('All done.');
    };
    await t.bridge.observe([watched(10, { turnsEnded: 1, endedOutcome: 'done' })], []);
    assert.deepEqual(t.messenger.posts(), []);

    const next = make({ observed: t.bridge.observation() });
    await begin(next.bridge, [watched(10, { turnsEnded: 1, endedOutcome: 'done' })], []);
    assert.deepEqual(
      next.messenger.posts().map((p) => p.notice.kind),
      ['finished']
    );
  });

  it('a pass cut short between two finishes posts only the second from the next engine', async () => {
    const t = make();
    await begin(t.bridge, [watched(10, { status: 'busy' }), watched(11, { status: 'busy' })], []);
    const done = [
      watched(10, { turnsEnded: 1, endedOutcome: 'done' }),
      watched(11, { turnsEnded: 1, endedOutcome: 'done' })
    ];
    // The first finish posts and saves; the rebuild lands while the second
    // reads its reply.
    t.verbs.port.lastReply = (a) => {
      if (a.pid === 11) void t.bridge.stop();
      return Promise.resolve(`reply of ${a.pid}`);
    };
    await t.bridge.observe(done, []);
    assert.deepEqual(
      t.messenger.posts().map((p) => p.notice.body),
      ['reply of 10']
    );

    const next = make({ observed: t.bridge.observation() });
    await begin(next.bridge, done, []);
    assert.deepEqual(
      next.messenger.posts().map((p) => p.notice.body),
      ['All done.'],
      'the finish already posted posted again'
    );
    assert.deepEqual(
      next.verbs.of('lastReply').map((c) => (c.args[0] as SessionAddr).pid),
      [11]
    );
  });

  it('a pass cut short after a stop posts that stop once', async () => {
    const t = make();
    await begin(t.bridge, [watched(10, { status: 'busy' }), watched(11, { status: 'busy' })], []);
    const board = [
      { ...watched(10, { status: 'busy' }), exit: { code: 1, signal: null } },
      watched(11, { turnsEnded: 1, endedOutcome: 'done' })
    ];
    t.verbs.port.lastReply = () => {
      void t.bridge.stop();
      return Promise.resolve('All done.');
    };
    await t.bridge.observe(board, []);
    assert.deepEqual(
      t.messenger.posts().map((p) => p.notice.kind),
      ['stopped']
    );

    const next = make({ observed: t.bridge.observation() });
    await begin(next.bridge, board, []);
    assert.deepEqual(
      next.messenger.posts().map((p) => p.notice.kind),
      ['finished'],
      'the stop already posted posted again'
    );
  });

  it('hands over the latest board once every edge of it was tried', async () => {
    const t = make();
    await begin(t.bridge, [watched(10, { status: 'busy' })], []);
    await t.bridge.observe([watched(10, { turnsEnded: 1, endedOutcome: 'done' })], []);
    assert.equal(t.messenger.posts().length, 1);
    const next = make({ observed: t.bridge.observation() });
    await begin(next.bridge, [watched(10, { turnsEnded: 1, endedOutcome: 'done' })], []);
    assert.deepEqual(next.messenger.posts(), []);
  });
});
