import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MaybePosted, type Attachment } from '../../core/bridge/model';
import type { ConversationRecord } from '../../core/bridge/store';
import type { Messenger } from '../../core/bridge/port';
import { disposeHome } from '../helpers';
import {
  boot,
  stopBridges,
  APP,
  T0,
  OWNER,
  home,
  engine,
  fake,
  store,
  paths,
  words,
  watched,
  addr,
  permission,
  claim,
  make,
  finished,
  saved,
  begin,
  chooseDefault
} from './bridge_engine_helpers';

before(async () => {
  await boot();
});

after(async () => {
  await stopBridges();
  await disposeHome(home);
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

describe('the engine: attachments (R3)', () => {
  const file = (name: string, bytes: number) =>
    Promise.resolve({
      bytes: Buffer.from('x'.repeat(bytes)),
      name,
      mime: 'text/plain'
    } satisfies Attachment);

  it('posts a child’s file into its root’s conversation, its head above the caption', async () => {
    const t = make();
    await begin(t.bridge);
    const { root, post } = await finished(t);
    const child = watched(11, { parentSessionId: 's10' });
    await t.bridge.observe([root, child], []);
    const sent = await t.bridge.attach(addr(child), {
      ...(await file('a.txt', 10)),
      caption: 'the log'
    });
    assert.deepEqual(sent, { ok: true });
    const [attached] = t.messenger.attachments();
    assert.deepEqual(attached?.place, {
      conversation: { anchor: post.posted.anchor, latest: post.posted.message }
    });
    assert.equal(attached?.attachment.head, 'n11 · spawned by n10');
    assert.equal(attached?.attachment.caption, 'n11 · spawned by n10\n\nthe log');
    const [record] = await saved();
    assert.equal(record?.notices.length, 1, 'the file is not a notice');
    assert.ok(record?.refs.includes(attached?.posted.message ?? ''));
  });

  it('opens the root’s conversation with a notice when there is none, then sends', async () => {
    const t = make();
    await begin(t.bridge);
    const root = watched(10, { status: 'busy' });
    await t.bridge.observe([root], []);
    assert.deepEqual(await t.bridge.attach(addr(root), await file('b.txt', 10)), { ok: true });
    const [opener] = t.messenger.posts();
    assert.deepEqual(opener?.place, { home: OWNER });
    assert.equal(opener?.notice.kind, 'attached');
    assert.equal(opener?.notice.mention, OWNER);
    const [attached] = t.messenger.attachments();
    assert.equal(attached?.posted.anchor, opener?.posted.anchor);
    assert.equal(attached?.attachment.head, undefined);
    const [record] = await saved();
    assert.equal(record?.root?.pid, 10);
    assert.deepEqual(
      record?.notices.map((n) => n.kind),
      ['attached']
    );
  });

  it('refuses without files, over maxBytes, and for a session not on the board', async () => {
    const plain = fake.fakeMessenger();
    const { files: _files, ...noFiles } = plain;
    const without = make({ messenger: noFiles });
    await begin(without.bridge, [watched(10)], []);
    assert.deepEqual(await without.bridge.attach(addr(watched(10)), await file('c.txt', 1)), {
      ok: false,
      reason: words.NO_FILES
    });

    const small = make({ fake: { maxBytes: 10 } });
    await begin(small.bridge, [watched(10)], []);
    assert.deepEqual(await small.bridge.attach(addr(watched(10)), await file('d.txt', 11)), {
      ok: false,
      reason: words.tooLarge('Test messenger', 10)
    });
    assert.deepEqual(await small.bridge.attach(addr(watched(12)), await file('e.txt', 1)), {
      ok: false,
      reason: words.NOT_ON_BOARD
    });
    assert.equal(small.messenger.posts().length, 0);
  });

  it('refuses a session the board still holds after it exited, and posts nothing', async () => {
    const t = make();
    const gone = { ...watched(10), exit: { code: 1, signal: null } };
    await begin(t.bridge, [gone], []);
    const posts = t.messenger.posts().length;
    const attached = t.messenger.attachments().length;
    assert.deepEqual(await t.bridge.attach(addr(gone), await file('x.txt', 1)), {
      ok: false,
      reason: words.SESSION_ENDED
    });
    assert.equal(t.messenger.posts().length, posts);
    assert.equal(t.messenger.attachments().length, attached);
  });

  it('gives a failed send as the reason, once', async () => {
    const plain = fake.fakeMessenger();
    let tries = 0;
    const broken: Messenger = {
      ...plain,
      files: {
        maxBytes: 100,
        send: () => {
          tries++;
          return Promise.reject(new Error('upload refused'));
        }
      }
    };
    const t = make({ messenger: broken });
    await begin(t.bridge, [watched(10)], []);
    const sent = await t.bridge.attach(addr(watched(10)), await file('f.txt', 1));
    assert.deepEqual(sent, { ok: false, reason: 'upload refused' });
    assert.equal(tries, 1);
  });

  it('says a send that may have posted is unsure, not refused', async () => {
    const plain = fake.fakeMessenger();
    const lost: Messenger = {
      ...plain,
      files: {
        maxBytes: 100,
        send: () => Promise.reject(new MaybePosted('the reply was cut off'))
      }
    };
    const t = make({ messenger: lost });
    await begin(t.bridge, [watched(10)], []);
    const sent = await t.bridge.attach(addr(watched(10)), await file('g.txt', 1));
    assert.deepEqual(sent, { ok: false, reason: 'the reply was cut off', unsure: true });
  });
});

describe('the engine: credentials stay out of the store', () => {
  const SENTINEL = 'xoxb-sentinel-0000';

  /** A pass that opens, posts and settles, then the conversation files that
   *  hold the sentinel. */
  async function leaked(messenger: Messenger): Promise<string[]> {
    const t = make({ messenger });
    try {
      await begin(t.bridge);
      const root = watched(10, { status: 'waiting' }, [permission('p0')]);
      await t.bridge.observe([root, watched(11, { parentSessionId: 's10' })], [claim('w1', APP)]);
      await t.bridge.observe([{ ...root, pending: [] }], [claim('w1', APP)]);
    } finally {
      await t.bridge.stop();
    }
    const names = await fs.readdir(paths.CONVERSATIONS_DIR);
    assert.ok(names.length > 0);
    const texts = await Promise.all(
      names.map((name) => fs.readFile(path.join(paths.CONVERSATIONS_DIR, name), 'utf8'))
    );
    return names.filter((_, i) => texts[i]?.includes(SENTINEL));
  }

  it('writes no file containing the sentinel credential', async () => {
    const created = await fake.fakeEntry.create({ token: SENTINEL });
    assert.ok(created.ok);
    assert.deepEqual(await leaked(created.messenger), []);
  });

  it('would see a serialized credential in a record: the check can fail', async (t) => {
    const created = await fake.fakeEntry.create({ token: SENTINEL });
    assert.ok(created.ok);
    const write = store.writeConversation;
    t.mock.method(store, 'writeConversation', (record: ConversationRecord) =>
      write({ ...record, adapter: { token: SENTINEL } } as ConversationRecord)
    );
    assert.notDeepEqual(await leaked(created.messenger), []);
  });
});

describe('the engine: a thread it joins', () => {
  const W1 = [claim('w1', APP)];
  const ANCHOR = 'thread-root';
  const COLLEAGUES = [
    { author: 'Ana', text: 'the deploy failed at step 3' },
    { author: 'CI bot', text: 'build 812 red', files: ['log.txt'] }
  ];

  type Input = { prompt: string };
  const startPrompt = (t: ReturnType<typeof make>) =>
    (t.verbs.of('start')[0]?.args[0] as Input | undefined)?.prompt ?? '';

  /** A mention in a thread Remote never started, taken through its picker. */
  async function join(t: ReturnType<typeof make>, f = t.messenger) {
    await begin(t.bridge, [], W1);
    f.say(OWNER, 'weigh in', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    await chooseDefault({ ...t, messenger: f });
  }

  it('starts in the thread with its earlier messages in a file the prompt names', async () => {
    const t = make();
    t.messenger.earlier(ANCHOR, COLLEAGUES);
    await join(t);
    const file = path.join(paths.THREADS_DIR, `${(await saved())[0]?.id}.md`);
    assert.equal(startPrompt(t), `weigh in\n\n${words.threadPointer(file, 2)}`);
    const written = await fs.readFile(file, 'utf8');
    for (const line of COLLEAGUES) assert.ok(written.includes(line.text), line.text);
    assert.ok(written.includes('Files: log.txt'));
    assert.ok(t.messenger.posts().every((p) => p.posted.anchor === ANCHOR));
    const started = t.messenger.posts().at(-1)?.notice;
    assert.equal(started?.kind, 'started');
    assert.equal(started?.body, 'Started in app');
    const [record] = await saved();
    assert.equal(record?.joined, true);
    assert.equal(record?.threadRead, 3, 'the two read, and the mention');
  });

  for (const reason of ['scope', 'unreachable'] as const) {
    it(`starts with the message alone, and says so, when the read answers ${reason}`, async () => {
      const t = make();
      t.messenger.earlier(ANCHOR, COLLEAGUES);
      t.messenger.failRead(reason);
      await join(t);
      assert.equal(startPrompt(t), 'weigh in');
      const started = t.messenger.posts().at(-1)?.notice;
      assert.equal(started?.kind, 'started');
      assert.equal(started?.body, `Started in app\n\n${words.threadUnreadLine(reason)}`);
      const [record] = await saved();
      assert.equal(record?.joined, true);
      assert.equal(record?.threadRead, undefined);
    });
  }

  it('starts with the message alone, and says nothing, on a messenger that cannot read', async () => {
    const f = fake.fakeMessenger();
    const { thread: _thread, ...blind } = f;
    const t = make({ messenger: blind });
    f.earlier(ANCHOR, COLLEAGUES);
    await join(t, f);
    assert.equal(startPrompt(t), 'weigh in');
    assert.equal(f.posts().at(-1)?.notice.body, 'Started in app');
    assert.equal((await saved())[0]?.joined, true);
  });

  it('gives up on a read that never answers after THREAD_READ_MS, and starts', async (c) => {
    c.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fake.fakeMessenger();
    let asked!: () => void;
    const reading = new Promise<void>((resolve) => (asked = resolve));
    const hung: Messenger = {
      ...f,
      thread: {
        read: () => {
          asked();
          return new Promise(() => undefined);
        }
      }
    };
    const t = make({ messenger: hung });
    await begin(t.bridge, [], W1);
    f.say(OWNER, 'weigh in', { in: ANCHOR, addressed: 'mention' });
    await reading;
    c.mock.timers.tick(engine.THREAD_READ_MS);
    await t.drain();
    assert.equal(f.posts().at(-1)?.notice.kind, 'picker');
    assert.equal((await saved())[0]?.held?.threadUnread, 'unreachable');
  });

  it('abandons a read in flight when it stops', async () => {
    const f = fake.fakeMessenger();
    let asked!: () => void;
    const reading = new Promise<void>((resolve) => (asked = resolve));
    const hung: Messenger = {
      ...f,
      thread: {
        read: () => {
          asked();
          return new Promise(() => undefined);
        }
      }
    };
    const t = make({ messenger: hung });
    await begin(t.bridge, [], W1);
    f.say(OWNER, 'weigh in', { in: ANCHOR, addressed: 'mention' });
    await reading;
    await t.bridge.stop();
    assert.equal(f.posts().length, 0);
  });

  it('tells a later mention what is new in the thread since, and nothing when nothing is', async () => {
    const t = make();
    t.messenger.earlier(ANCHOR, COLLEAGUES);
    await join(t);
    const root = watched(501, { startedAt: T0 + 501 });
    await t.bridge.observe([root], W1);
    const file = path.join(paths.THREADS_DIR, `${(await saved())[0]?.id}.md`);

    t.messenger.earlier(ANCHOR, [
      { author: 'Ana', text: 'rolled back' },
      { author: 'Bo', text: 'still red on main' }
    ]);
    t.messenger.say(OWNER, 'and now?', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    const [second] = t.verbs.of('send');
    assert.deepEqual(second?.args, [addr(root), `and now?\n\n${words.threadRefreshLine(file, 2)}`]);
    const written = await fs.readFile(file, 'utf8');
    assert.ok(written.includes('still red on main'));

    t.messenger.say(OWNER, 'thanks', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    assert.deepEqual(t.verbs.of('send')[1]?.args, [addr(root), 'thanks']);

    t.messenger.earlier(ANCHOR, [{ author: 'Ana', text: 'green again' }]);
    t.messenger.failRead('unreachable');
    t.messenger.say(OWNER, 'ok?', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    assert.deepEqual(t.verbs.of('send')[2]?.args, [addr(root), 'ok?']);
    assert.ok(!(await fs.readFile(file, 'utf8')).includes('green again'), 'the file is kept');

    t.messenger.say(OWNER, 'now?', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    assert.deepEqual(t.verbs.of('send')[3]?.args, [
      addr(root),
      `now?\n\n${words.threadRefreshLine(file, 2)}`
    ]);
  });

  it('counts what is new past a cut, where the file holds no more than it did', async () => {
    const f = fake.fakeMessenger();
    const lines = COLLEAGUES.map((line, i) => ({ ...line, at: T0 + i }));
    let total = 2500;
    const windowed: Messenger = {
      ...f,
      thread: { read: () => Promise.resolve({ ok: true, lines, truncated: true, total }) }
    };
    const t = make({ messenger: windowed });
    await join(t, f);
    const file = path.join(paths.THREADS_DIR, `${(await saved())[0]?.id}.md`);
    assert.equal(startPrompt(t), `weigh in\n\n${words.threadPointer(file, lines.length)}`);
    assert.ok((await fs.readFile(file, 'utf8')).includes('Earlier messages were cut.'));
    assert.equal((await saved())[0]?.threadRead, 2501);
    const root = watched(501, { startedAt: T0 + 501 });
    await t.bridge.observe([root], W1);

    total = 2503;
    f.say(OWNER, 'and now?', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    assert.deepEqual(t.verbs.of('send')[0]?.args, [
      addr(root),
      `and now?\n\n${words.threadRefreshLine(file, 2)}`
    ]);
    assert.equal((await saved())[0]?.threadRead, 2504);
  });

  it('points a fresh session at the whole thread, which it has not read', async () => {
    const t = make();
    t.messenger.earlier(ANCHOR, COLLEAGUES);
    await join(t);
    await t.bridge.observe([watched(501, { startedAt: T0 + 501 })], W1);
    await t.bridge.observe([], W1);
    const file = path.join(paths.THREADS_DIR, `${(await saved())[0]?.id}.md`);
    t.messenger.say(OWNER, 'again', { in: ANCHOR, addressed: 'mention' });
    await t.drain();
    const fresh = t.verbs.of('start')[1]?.args[0] as Input | undefined;
    assert.ok(fresh);
    assert.ok(fresh.prompt.startsWith('again\n\n'));
    assert.ok(fresh.prompt.endsWith(words.threadPointer(file, 3)));
    assert.equal((await saved())[0]?.threadRead, 4);
  });

  it('leaves a reply in a conversation it did not join as typed', async () => {
    const t = make();
    await begin(t.bridge);
    const { root, post } = await finished(t);
    t.messenger.earlier(post.posted.anchor, COLLEAGUES);
    t.messenger.say(OWNER, 'next', { in: post.posted.anchor, addressed: 'mention' });
    await t.drain();
    assert.deepEqual(t.verbs.of('send')[0]?.args, [addr(root), 'next']);
    assert.equal((await saved())[0]?.joined, undefined);
  });
});
