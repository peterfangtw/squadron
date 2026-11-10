import { incomingPlatformFixture } from '../remote/incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';

type Store = typeof import('../../core/bridge/store');
type Paths = typeof import('../../core/paths');
type Prune = typeof import('../../core/prune');

let store: Store;
let paths: Paths;
let prune: Prune;

let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  store = await import('../../core/bridge/store');
  paths = await import('../../core/paths');
  prune = await import('../../core/prune');
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

const ROOT = { pid: 4100, startedAt: 1_700_000_000_000, windowId: 'w1' };
const CHILD = { pid: 4101, startedAt: 1_700_000_005_000, windowId: 'w1' };

function notice(id: string, over: Partial<import('../../core/bridge/store').NoticeRecord> = {}) {
  return {
    id,
    kind: 'permission' as const,
    message: `m-${id}`,
    target: ROOT,
    requestId: `r-${id}`,
    postedAt: 1_700_000_100_000,
    actions: [
      { id: 'a1', verb: 'deny' as const },
      { id: 'a2', verb: 'end' as const }
    ],
    ...over
  };
}

/** Ids are minted here rather than by the store, so a describe body can build
 *  its fixtures before the store is imported. */
let minted = 0;

function record(
  over: Partial<import('../../core/bridge/store').ConversationRecord> = {}
): import('../../core/bridge/store').ConversationRecord {
  return {
    schema: 1,
    id: `conv${String(minted++).padStart(4, '0')}`,
    messenger: 'fake',
    anchor: 'A1',
    refs: ['A1'],
    latest: 'A1',
    owner: 'T1:U1',
    state: 'live',
    root: {
      pid: ROOT.pid,
      startedAt: ROOT.startedAt,
      sessionId: 's-root',
      brand: 'claude',
      cwd: '/repo',
      label: 'repo · fix the build'
    },
    past: [],
    notices: [],
    createdAt: 1_700_000_000_500,
    updatedAt: 1_700_000_000_500,
    ...over
  };
}

describe('the conversation store', () => {
  it('reads back what it wrote, an End confirm’s counted members included', async () => {
    const written = record({
      notices: [
        notice('n1', { answeredAt: 1_700_000_160_000, settled: 'Denied' }),
        notice('n2', {
          kind: 'confirm',
          requestId: undefined,
          members: [ROOT, CHILD],
          actions: [
            { id: 'a3', verb: 'end-confirm' },
            { id: 'a4', verb: 'cancel' }
          ]
        })
      ],
      past: ['s-older']
    });
    // `undefined` is not a JSON value, so the comparison is against what JSON keeps.
    const expected = JSON.parse(JSON.stringify(written)) as unknown;

    assert.equal(await store.writeConversation(written), true);

    assert.deepEqual(await store.readConversations(), [expected]);
  });

  it('reads back a root of every brand an adapter registers, and drops one none does', async () => {
    const { BRANDS } = await import('../../core/brands');
    const rooted = (brand: string) =>
      record({
        root: { ...record().root!, brand } as import('../../core/bridge/store').ConversationRoot
      });
    const each = BRANDS.map((brand) => rooted(brand));
    const unknown = rooted('nobody');
    for (const one of [...each, unknown]) assert.equal(await store.writeConversation(one), true);
    const read = await store.readConversations();
    assert.deepEqual(read.map((one) => one.root?.brand).sort(), [...BRANDS].sort());
  });

  it('reads back a remote-spawned root, a root without the mark, and drops a malformed mark', async () => {
    const root = record().root!;
    const marked = record({ root: { ...root, remoteSpawned: true } });
    const plain = record();
    const bad = record({
      root: { ...root, remoteSpawned: 'yes' } as unknown as typeof root
    });
    for (const one of [marked, plain, bad]) assert.equal(await store.writeConversation(one), true);
    const read = await store.readConversations();
    assert.deepEqual(
      read.map((one) => [one.id, one.root?.remoteSpawned]).sort(),
      [
        [marked.id, true],
        [plain.id, undefined]
      ].sort()
    );
  });

  it('reads back a joined thread’s mark and count, a record without them, and drops malformed ones', async () => {
    const joined = record({ joined: true, threadRead: 22 });
    const plain = record();
    const badCount = record({ joined: true, threadRead: '22' as unknown as number });
    const badMark = record({ joined: 'yes' as unknown as true });
    for (const one of [joined, plain, badCount, badMark])
      assert.equal(await store.writeConversation(one), true);
    const read = await store.readConversations();
    assert.deepEqual(
      read.sort((a, b) => a.id.localeCompare(b.id)),
      [joined, plain].map((one) => JSON.parse(JSON.stringify(one)) as unknown)
    );
  });

  it('reads back why a held prompt’s thread was not read, and drops an unknown reason', async () => {
    const heldWith = (threadUnread: unknown) =>
      record({
        state: 'held',
        root: undefined,
        held: {
          prompt: 'weigh in',
          folders: ['/a'],
          expiresAt: 1_700_000_600_000,
          threadUnread: threadUnread as 'scope'
        }
      });
    const scope = heldWith('scope');
    const unreachable = heldWith('unreachable');
    const bad = heldWith('forbidden');
    for (const one of [scope, unreachable, bad])
      assert.equal(await store.writeConversation(one), true);
    const read = await store.readConversations();
    assert.deepEqual(read.map((one) => one.held?.threadUnread).sort(), ['scope', 'unreachable']);
  });

  it('keeps the notice as posted, so a settle can render it again, and skips a torn one', async () => {
    const posted = {
      kind: 'permission' as const,
      mention: 'T1:U1',
      head: 'repo · fix the build',
      body: 'Waiting for permission: rm',
      code: 'rm -rf build',
      buttons: [{ label: 'Deny', payload: 'conv.a1', tone: 'danger' as const }]
    };
    const kept = record({ notices: [notice('n1', { notice: posted })] });
    const torn = record({ notices: [notice('n1')] });
    await store.writeConversation(kept);
    await store.writeConversation(torn);
    const file = path.join(paths.CONVERSATIONS_DIR, `${torn.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { notices: object[] };
    raw.notices = [{ ...raw.notices[0], notice: { kind: 'permission', buttons: 'none' } }];
    await fs.writeFile(file, JSON.stringify(raw));

    const read = await store.readConversations();
    assert.deepEqual(
      read.map((r) => r.id),
      [kept.id]
    );
    assert.deepEqual(read[0]?.notices[0]?.notice, posted);
  });

  it('reads back a held prompt, which has no root yet', async () => {
    const held = record({
      state: 'held',
      root: undefined,
      held: { prompt: 'make the tests pass', folders: ['/a', '/b'], expiresAt: 1_700_000_600_000 },
      notices: [
        notice('n1', {
          kind: 'picker',
          target: undefined,
          requestId: undefined,
          actions: [
            { id: 'p1', verb: 'pick', folder: '/a' },
            { id: 'p2', verb: 'pick', folder: '/b' }
          ]
        })
      ]
    });
    const expected = JSON.parse(JSON.stringify(held)) as unknown;

    await store.writeConversation(held);

    assert.deepEqual(await store.readConversations(), [expected]);
  });

  it('keeps the last 50 notices', async () => {
    const many = record({ notices: Array.from({ length: 55 }, (_, i) => notice(`n${i}`)) });

    await store.writeConversation(many);

    const [read] = await store.readConversations();
    assert.equal(read?.notices.length, store.NOTICES_KEPT);
    assert.equal(read?.notices[0]?.id, 'n5');
    assert.equal(read?.notices.at(-1)?.id, 'n54');
  });

  it('lands overlapping writes of one conversation in the order they were made', async () => {
    const id = 'overlaps';
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.writeConversation(record({ id, updatedAt: i })))
    );

    const read = await store.readConversations();
    assert.deepEqual(
      read.map((r) => r.updatedAt),
      [19]
    );
  });

  it('skips a corrupt, a malformed and a future-schema file, and reads the rest', async () => {
    const good = record();
    await store.writeConversation(good);
    await fs.writeFile(path.join(paths.CONVERSATIONS_DIR, 'torn.json'), '{"schema":1,"id":');
    await writeJson(path.join(paths.CONVERSATIONS_DIR, 'shape.json'), {
      ...record(),
      refs: 'A1'
    });
    await writeJson(path.join(paths.CONVERSATIONS_DIR, 'notice.json'), {
      ...record(),
      notices: [{ ...notice('n1'), target: { pid: '4100' } }]
    });
    await writeJson(path.join(paths.CONVERSATIONS_DIR, 'future.json'), {
      ...record(),
      schema: 4
    });

    const read = await store.readConversations();

    assert.deepEqual(
      read.map((r) => r.id),
      [good.id]
    );
  });

  it('reads a machine that has never written one as empty', async () => {
    assert.deepEqual(await store.readConversations(), []);
  });

  it('mints ids of eight base32 characters', () => {
    const ids = new Set(Array.from({ length: 200 }, () => store.conversationId()));
    assert.equal(ids.size, 200);
    for (const id of ids) {
      assert.match(id, /^[a-z2-7]{8}$/);
    }
  });
});

describe('resolveRefs', () => {
  // Thread mode: every reply in the thread names its anchor.
  const thread = record({ anchor: 'T-anchor', refs: ['T-anchor', 'T-m1', 'T-m2'], latest: 'T-m2' });
  // Chain mode: each post is its own ref, and a reply names the one it answers.
  const chain = record({ anchor: 'C-p1', refs: ['C-p1', 'C-p2', 'C-p3'], latest: 'C-p3' });
  const records = [thread, chain];

  it('resolves a reply in a thread by its anchor', () => {
    assert.equal(store.resolveRefs(records, ['T-anchor'])?.id, thread.id);
  });

  it('resolves a reply in a chain by any post it answers, not only the latest', () => {
    assert.equal(store.resolveRefs(records, ['C-p2'])?.id, chain.id);
  });

  it('resolves nothing for a top-level message or a ref nobody posted', () => {
    assert.equal(store.resolveRefs(records, []), undefined);
    assert.equal(store.resolveRefs(records, ['elsewhere']), undefined);
  });
});

describe('conversationOfRoot', () => {
  const live = record();
  const held = record({ state: 'held', root: undefined });

  it('finds the conversation whose root is this pid and start', () => {
    assert.equal(store.conversationOfRoot([held, live], ROOT)?.id, live.id);
  });

  it('does not take a recycled pid for the root', () => {
    assert.equal(
      store.conversationOfRoot([live], { pid: ROOT.pid, startedAt: ROOT.startedAt + 60_000 }),
      undefined
    );
  });
});

describe('button payloads', () => {
  it('round-trips a conversation and an action', () => {
    const payload = store.encodePayload('abcd2345', 'a1');
    assert.equal(payload, 'abcd2345.a1');
    assert.deepEqual(store.decodePayload(payload ?? ''), {
      conversation: 'abcd2345',
      action: 'a1'
    });
  });

  it('takes exactly 16 bytes and refuses 17', () => {
    assert.equal(store.encodePayload('abcd2345', 'abcdefg')?.length, store.PAYLOAD_MAX);
    assert.equal(store.encodePayload('abcd2345', 'abcdefgh'), undefined);
    assert.equal(store.decodePayload('abcd2345.abcdefgh'), undefined);
  });

  it('refuses what is not two printable, dot-free halves', () => {
    for (const [conversation, action] of [
      ['', 'a1'],
      ['abcd2345', ''],
      ['ab.cd', 'a1'],
      ['abcd2345', 'a\n'],
      ['abcd2345', 'é']
    ] as const) {
      assert.equal(
        store.encodePayload(conversation, action),
        undefined,
        JSON.stringify([conversation, action])
      );
    }
    for (const payload of ['', 'abcd2345', '.a1', 'abcd2345.', 'a.b.c', 'abcd 345.a1']) {
      assert.equal(store.decodePayload(payload), undefined, JSON.stringify(payload));
    }
  });
});

describe('the conversation sweep', () => {
  it('the holder forgets an ordinary conversation past the month; a non-holder cannot race its loaded writer', async () => {
    const aged = async (name: string, days: number) => {
      const file = path.join(paths.CONVERSATIONS_DIR, name);
      const when = new Date(Date.now() - days * prune.DAY_MS);
      await writeJson(file, record({ id: name.replace(/\.json$/, ''), updatedAt: when.getTime() }));
      await fs.utimes(file, when, when);
      return file;
    };
    const stale = await aged('old.json', 31);
    const recent = await aged('new.json', 29);
    const torn = await aged('old.json.900.0.tmp', 31);

    await prune.pruneStatus();
    assert.equal(await exists(stale), true);
    const holders = await import('../../core/remote/holder');
    const fake = await import('../../core/bridge/fake');
    const verbs = await import('../../core/remote/verbs');
    const engine = await import('../../core/bridge/bridge');
    const owner = {
      windowId: 'cleanup',
      label: 'cleanup',
      pid: process.pid,
      startedAt: 1,
      since: Date.now()
    };
    const table = { starts: new Map([[process.pid, 1]]) };
    assert.deepEqual(await holders.acquireHolder(owner, table, []), { ok: true });
    const bridge = new engine.Bridge({
      messenger: fake.fakeMessenger(),
      allowlist: ['owner'],
      holder: owner,
      clock: Date.now,
      verbs: verbs.remoteVerbs({
        windowId: 'cleanup',
        owned: () => undefined,
        end: () => false,
        start: () => Promise.resolve({ ok: false, reason: 'unavailable', outcome: 'stopped' }),
        ask: () => Promise.resolve({ ok: false, kind: 'silent', reason: 'unavailable', file: '' }),
        board: () => [],
        claims: () => Promise.resolve([]),
        signal: () => Promise.resolve([])
      })
    });
    try {
      await bridge.load();
      await bridge.housekeep(table);
    } finally {
      await bridge.stop();
      await holders.releaseHolder(owner);
    }

    assert.equal(await exists(stale), false);
    assert.equal(await exists(torn), false);
    assert.equal(await exists(recent), true);
  });

  it('makes the conversation store on activate, and not the holder file', () => {
    const dirs: readonly string[] = paths.STORE_DIRS;
    assert.ok(dirs.includes(paths.REMOTE_DIR));
    assert.ok(dirs.includes(paths.CONVERSATIONS_DIR));
    // `ensureHome` mkdirs every entry; a directory at this path would make
    // every acquire fail.
    assert.ok(!dirs.includes(paths.HOLDER_FILE));
  });
});

describe('persisted job stages', () => {
  it('isolates a null held draft from valid conversations', async () => {
    const good = record();
    await store.writeConversation(good);
    await writeJson(path.join(paths.CONVERSATIONS_DIR, 'null-held.json'), {
      ...record(),
      schema: 2,
      state: 'held',
      held: null
    });
    assert.deepEqual(await store.readConversations(), [good]);
  });

  it('preserves the destination before any post and skips malformed stage records', async () => {
    const kept = record({
      schema: 2,
      state: 'held',
      root: undefined,
      anchor: '',
      refs: [],
      latest: '',
      notices: [],
      held: {
        prompt: 'original',
        folders: ['/work'],
        expiresAt: 1_700_000_600_000,
        picker: {
          stage: 'model',
          generation: 4,
          page: 0,
          published: 0,
          destination: { under: 'original-message' },
          folder: { folder: '/work', windowId: 'selected' },
          catalog: { models: { brands: [], models: [] }, remoteSelection: { defaultTarget: {} } }
        }
      }
    });
    await store.writeConversation(kept);
    const draft = kept.held!.picker!;
    for (const bad of [
      { ...draft, stage: 'future' },
      { ...draft, folder: undefined },
      { ...draft, generation: -1 },
      { ...draft, destination: { unknown: true } },
      { ...draft, stage: 'starting', target: { effort: 10 } },
      { ...draft, catalog: { models: { models: [null], brands: [] } } }
    ]) {
      const other = record({
        ...kept,
        id: store.conversationId(),
        held: { ...kept.held!, picker: bad as unknown as typeof draft }
      });
      await store.writeConversation(other);
    }
    assert.deepEqual(await store.readConversations(), [JSON.parse(JSON.stringify(kept))]);
  });
});

it('bounds applied terminal messages while retaining unfinished cleanup', async () => {
  const messages: import('../../core/bridge/store').MessageRecord[] = Array.from(
    { length: 257 },
    (_, i) => ({
      id: `e${i}`,
      correlation: `c${i}`,
      ref: `m${i}`,
      at: i,
      delivery: 'settled',
      terminal: true,
      desired: 'done',
      applied: 'done'
    })
  );
  messages.push({
    id: 'cleanup',
    correlation: 'cleanup',
    ref: 'original',
    at: 0,
    delivery: 'settled',
    terminal: true,
    desired: 'done',
    applied: 'processing',
    retryAt: 1000
  });
  messages.push({
    id: 'uncertain',
    correlation: 'uncertain',
    ref: 'late-original',
    at: 0,
    delivery: 'settled',
    terminal: true,
    desired: 'done',
    applied: 'done',
    uncertainEffect: true
  });
  await store.writeConversation(record({ messages }));
  const [read] = await store.readConversations();
  assert.equal(read?.messages?.length, 258);
  assert.equal(read?.messages?.[0]?.id, 'e1');
  assert.equal(read?.messages?.at(-2)?.id, 'cleanup');
  assert.equal(read?.messages?.at(-1)?.id, 'uncertain');
});

it('snapshots admission before later mutations can change an in-flight write', async () => {
  const message: import('../../core/bridge/store').MessageRecord = {
    id: 'a',
    correlation: 'a',
    ref: 'original',
    at: 0,
    delivery: 'admitted',
    desired: 'received'
  };
  const one = record({ messages: [message] });
  const writing = store.writeConversation(one);
  message.delivery = 'attempted';
  one.messages?.push({ ...message, id: 'b', correlation: 'b' });
  await writing;
  const [read] = await store.readConversations();
  assert.equal(read?.messages?.length, 1);
  assert.equal(read?.messages?.[0]?.delivery, 'admitted');
});

describe('Bridge incoming admission persistence', () => {
  type Message = Extract<import('../../core/bridge/model').Inbound, { kind: 'message' }>;
  const bridges: import('../../core/bridge/bridge').Bridge[] = [];
  const T0 = 1_700_000_000_000;
  const descriptors = {
    version: 1 as const,
    installId: 'install-one',
    omitted: 0,
    files: [
      { id: 'first', source: 'opaque:install-one:first', cacheKey: 'fake_first', name: 'one.txt' },
      { id: 'second', source: 'opaque:install-one:second', cacheKey: 'fake_second', size: 42 }
    ]
  };
  const event = (over: Partial<Message> = {}): Message => ({
    kind: 'message',
    id: 'original',
    ref: 'original-ref',
    refs: ['A1'],
    sender: { id: 'T1:U2' },
    addressed: 'direct',
    text: 'inspect these',
    at: T0 + 100,
    incoming: descriptors,
    ...over
  });

  beforeEach(() => fs.rm(paths.HEARD_FILE, { force: true }));

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  });

  async function make(
    options: { held?: boolean; send?: import('../../core/bridge/bridge').SessionVerbs['send'] } = {}
  ) {
    const engine = await import('../../core/bridge/bridge');
    const fake = await import('../../core/bridge/fake');
    const messenger = fake.fakeMessenger({ held: true, now: () => T0 + 200 });
    let deliver: import('../../core/bridge/port').Sink = () => undefined;
    const sent: string[] = [];
    const bridge = new engine.Bridge({
      messenger: {
        ...messenger,
        connect(sink) {
          deliver = sink;
          return messenger.connect(sink);
        }
      },
      allowlist: ['T1:U1', 'T1:U2'],
      clock: () => T0 + 200,
      verbs: {
        async send(addr, text, correlation) {
          sent.push(text);
          return options.send ? options.send(addr, text, correlation) : { ok: true };
        },
        answer: () => Promise.resolve({ ok: true }),
        interrupt: () => Promise.resolve({ ok: true }),
        deny: () => Promise.resolve({ ok: true }),
        end: () => Promise.resolve({ ok: true }),
        start: () => Promise.resolve({ ok: false, reason: 'not used', outcome: 'stopped' }),
        lastReply: () => Promise.resolve(undefined)
      }
    });
    bridges.push(bridge);
    await bridge.load();
    await bridge.observe(
      options.held
        ? []
        : [
            {
              session: {
                pid: ROOT.pid,
                startedAt: ROOT.startedAt,
                windowId: 'w1',
                sessionId: 's-root',
                name: 'worker',
                cwd: path.resolve('/repo'),
                transcript: '',
                status: 'idle',
                updatedAt: T0,
                hasCommand: false,
                source: 'owned'
              },
              label: 'worker',
              pending: []
            }
          ],
      options.held
        ? [
            {
              id: 'w1',
              label: 'window',
              app: 'Code',
              folder: path.resolve('/repo'),
              shellPids: [],
              updatedAt: T0
            }
          ]
        : []
    );
    bridge.connect();
    return { bridge, messenger, sent, deliver, drain: () => bridge.tick(T0 + 200) };
  }

  it('commits original provenance before send and keeps it through attempt, settlement and reload', async () => {
    await store.writeConversation(record());
    let atSend: import('../../core/bridge/store').MessageRecord | undefined;
    const t = await make({
      send: async () => {
        atSend = (await store.readConversations())[0]?.messages?.[0];
        return { ok: false, reason: 'definite refusal' };
      }
    });
    t.deliver(event());
    await t.drain();
    assert.equal(t.sent.length, 1);
    assert.ok(atSend);
    assert.equal(atSend.delivery, 'attempted');
    const [saved] = await store.readConversations();
    assert.equal(saved?.schema, 3);
    const incoming = atSend.incoming;
    assert.ok(incoming && !('denied' in incoming));
    assert.equal(incoming.senderId, 'T1:U2');
    assert.equal(incoming.installId, 'install-one');
    assert.equal(incoming.eventAt, T0 + 100);
    assert.equal(incoming.admittedAt, T0 + 200);
    assert.equal(incoming.id, 'original');
    assert.equal(incoming.ref, 'original-ref');
    assert.equal(incoming.correlation, atSend.correlation);
    assert.equal(incoming.messengerId, 'fake');
    assert.deepEqual(incoming.files, descriptors.files);
    assert.match(String(incoming.digest), /^[a-f0-9]{64}$/);
    assert.equal(saved?.messages?.[0]?.event, undefined);
    assert.equal(saved?.messages?.[0]?.delivery, 'settled');
    assert.deepEqual(saved.messages[0].incoming, incoming);
    await t.bridge.stop();
    const next = await make();
    next.deliver(
      event({
        incoming: {
          ...descriptors,
          files: [
            ...descriptors.files,
            { id: 'third', source: 'opaque:third', cacheKey: 'fake_third' }
          ]
        }
      })
    );
    await next.drain();
    assert.equal(next.sent.length, 0);
    assert.deepEqual((await store.readConversations())[0]!.messages![0]!.incoming, incoming);
  });

  it('keeps ordered admission through held picker reload without copying it into replay or picker data', async () => {
    const t = await make({ held: true });
    const original = event({ refs: [] });
    t.deliver(original);
    await t.drain();
    const [held] = await store.readConversations();
    assert.equal(held?.schema, 3);
    assert.equal(held?.messages?.[0]?.delivery, 'held');
    const incoming = held?.messages?.[0]?.incoming;
    assert.ok(incoming && !('denied' in incoming));
    assert.equal(held?.held?.correlation, incoming.correlation);
    assert.equal(held?.messages?.[0]?.event, undefined);
    assert.equal(Reflect.get(held.held, 'incoming'), undefined);
    assert.deepEqual(held?.messages?.[0]?.access, { state: 'held', revision: 0 });
    await t.bridge.stop();
    const next = await make({ held: true });
    next.deliver(original);
    await next.drain();
    const [reloaded] = await store.readConversations();
    assert.deepEqual(reloaded?.messages?.[0]?.incoming, incoming);
    assert.ok(reloaded.revision! > held.revision!);
    assert.equal(reloaded?.schema, 3);
    assert.equal(next.sent.length, 0);
  });

  for (const change of ['source', 'install', 'id', 'sender', 'time', 'ref', 'order'] as const)
    it(`denies duplicate ${change} collisions without replacing original admission or sending twice`, async () => {
      await store.writeConversation(record());
      const t = await make();
      const original = event();
      t.deliver(original);
      await t.drain();
      const first = (await store.readConversations())[0]!.messages![0]!;
      const changed = structuredClone(original);
      if (change === 'source')
        changed.incoming = {
          ...descriptors,
          files: [{ ...descriptors.files[0]!, source: 'different-source' }, descriptors.files[1]!]
        };
      if (change === 'install') changed.incoming = { ...descriptors, installId: 'install-two' };
      if (change === 'id')
        changed.incoming = {
          ...descriptors,
          files: [...descriptors.files, { id: 'new', source: 'new-source', cacheKey: 'fake_new' }]
        };
      if (change === 'sender') changed.sender = { id: 'T1:U1' };
      if (change === 'time') changed.at++;
      if (change === 'ref') changed.ref = 'other-ref';
      if (change === 'order')
        changed.incoming = { ...descriptors, files: [...descriptors.files].reverse() };
      t.deliver(changed);
      await t.bridge.stop();
      const saved = (await store.readConversations())[0]!.messages![0]!;
      assert.deepEqual(saved.incoming, first.incoming);
      assert.equal(saved.access?.state, 'closed');
      assert.equal(saved.access?.reason, 'admission-denied');
      assert.ok(saved.access.revision > first.access!.revision);
      assert.equal(t.sent.length, 1);
    });

  it('normalizes invalid optional metadata before committing, and snapshots provider-owned descriptor objects', async () => {
    await store.writeConversation(record());
    const t = await make();
    const original = event({
      incoming: {
        ...descriptors,
        files: [{ ...descriptors.files[0]!, mime: 'bad\nmetadata', size: -1 }]
      }
    });
    t.deliver(original);
    (original.incoming as unknown as { files: { source: string }[] }).files[0]!.source =
      'mutated-later';
    original.text = 'mutated-later';
    await t.drain();
    const admission = (await store.readConversations())[0]!.messages![0]!.incoming;
    assert.ok(admission && !('denied' in admission));
    assert.deepEqual(admission.files, [descriptors.files[0]]);
    assert.equal(t.sent.length, 1);
    assert.ok(t.sent[0]?.startsWith('inspect these\n\n'));
    assert.equal(t.sent[0]?.includes('mutated-later'), false);
  });

  for (const bad of [
    null,
    { version: 2 },
    { ...descriptors, files: [{ id: 'bad', source: 'x'.repeat(2049), cacheKey: 'fake_bad' }] },
    { ...descriptors, files: [{ id: 'bad', source: 'opaque', cacheKey: '../bad' }] }
  ])
    it(`retains text and reactions for malformed incoming and never upgrades on redelivery (${JSON.stringify(bad).slice(0, 60)})`, async () => {
      await store.writeConversation(record());
      const t = await make();
      t.deliver(event({ incoming: bad as Message['incoming'] }));
      await t.drain();
      await t.bridge.stop();
      const saved = (await store.readConversations())[0]!.messages![0]!;
      assert.deepEqual(saved.incoming, { version: 1, denied: 'admission-denied' });
      assert.equal(saved.access?.state, 'closed');
      assert.deepEqual(t.sent, ['inspect these']);
      assert.ok(t.messenger.reactionEffects().some((effect) => effect.message === 'original-ref'));
      const next = await make();
      next.deliver(event());
      await next.drain();
      await next.bridge.stop();
      assert.deepEqual(
        (await store.readConversations())[0]!.messages![0]!.incoming,
        saved.incoming
      );
      assert.equal(next.sent.length, 0);
    });

  it('does not retroactively admit files for schema-1/2 text or missing schema-3 provenance', async () => {
    for (const schema of [1, 2, 3] as const) {
      await fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true });
      await fs.rm(paths.HEARD_FILE, { force: true });
      const t = await make();
      await t.bridge.stop();
      const legacy = record({
        schema,
        revision: schema === 3 ? 1 : undefined,
        messages: [
          {
            id: 'original',
            ref: 'original-ref',
            correlation: 'legacy-correlation',
            at: T0,
            desired: 'done',
            applied: 'done',
            delivery: 'settled',
            terminal: true
          }
        ]
      });
      await writeJson(path.join(paths.CONVERSATIONS_DIR, `${legacy.id}.json`), legacy);
      const next = await make();
      next.deliver(event());
      await next.drain();
      await next.bridge.stop();
      const rows = (await store.readConversations()).flatMap((r) => r.messages ?? []);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.correlation, 'legacy-correlation');
      assert.equal(rows[0]?.desired, 'done');
      assert.ok(rows[0]?.incoming === undefined || 'denied' in rows[0].incoming);
      assert.equal(next.sent.length, 0);
    }
  });

  it('does not deliver when the admission save fails, and does not promise speculative provenance', async () => {
    const initial = record();
    await store.writeConversation(initial);
    const t = await make();
    const file = path.join(paths.CONVERSATIONS_DIR, `${initial.id}.json`);
    const before = await fs.readFile(file, 'utf8');
    await fs.rm(file);
    await fs.mkdir(file);
    try {
      t.deliver(event());
      await t.drain();
      await t.bridge.stop();
      assert.equal(t.sent.length, 0);
    } finally {
      await fs.rm(file, { recursive: true });
      await fs.writeFile(file, before);
    }
    const [saved] = await store.readConversations();
    assert.equal(saved?.messages, undefined);
    const next = await make();
    next.deliver(event());
    await next.drain();
    assert.equal(next.sent.length, 1, 'first successful durable admission may deliver');
  });

  it('denies colliding refs and persisted correlations across rows while keeping their text/reaction state', async () => {
    await store.writeConversation(record());
    const t = await make();
    t.deliver(event());
    await t.drain();
    t.deliver(event({ id: 'different-id' }));
    await t.drain();
    await t.bridge.stop();
    const [saved] = await store.readConversations();
    assert.equal(saved?.messages?.length, 2);
    assert.ok(saved.messages.every((m) => m.access?.state === 'closed'));
    assert.equal(saved.messages[0]?.incoming && 'denied' in saved.messages[0].incoming, false);
    const other = structuredClone(saved);
    other.id = 'other-conversation';
    other.messages = [structuredClone(saved.messages[0]!)];
    await writeJson(path.join(paths.CONVERSATIONS_DIR, `${other.id}.json`), other);
    const read = await store.readConversations();
    assert.equal(read.length, 2);
    assert.ok(read.flatMap((r) => r.messages ?? []).every((m) => m.access?.state === 'closed'));
    assert.ok(read.flatMap((r) => r.messages ?? []).every((m) => m.desired === 'received'));
  });

  it('rejects stale revision and widening writes at the real store entrypoint', async () => {
    await store.writeConversation(record());
    const t = await make();
    t.deliver(event());
    await t.drain();
    await t.bridge.stop();
    const [saved] = await store.readConversations();
    assert.ok(saved?.messages?.[0]?.incoming);
    assert.equal(await store.writeConversation(saved), false);
    const substituted = structuredClone(saved);
    substituted.revision!++;
    substituted.messages![0]!.id = 'substituted-id';
    assert.equal(await store.writeConversation(substituted), false);
    const changed = structuredClone(saved);
    changed.revision!++;
    const admission = changed.messages![0]!.incoming!;
    assert.ok(!('denied' in admission));
    const codec = await import('../../core/incoming');
    const wider = {
      ...admission,
      files: [...admission.files, { id: 'extra', source: 'extra-source', cacheKey: 'fake_extra' }]
    };
    changed.messages![0]!.incoming = { ...wider, digest: codec.admissionDigest(wider) };
    assert.equal(await store.writeConversation(changed), false);
    const newer = structuredClone(saved);
    newer.revision!++;
    newer.updatedAt++;
    assert.equal(await store.writeConversation(newer), true);
    assert.equal(await store.writeConversation(saved), false);
    assert.deepEqual(
      (await store.readConversations())[0]?.messages?.[0]?.incoming,
      saved.messages[0].incoming
    );
  });

  it('isolates malformed stored access or admission without hiding text, and makes denial durable on the next save', async () => {
    await store.writeConversation(record());
    const t = await make();
    t.deliver(event());
    await t.drain();
    await t.bridge.stop();
    const [saved] = await store.readConversations();
    assert.ok(saved);
    const file = path.join(paths.CONVERSATIONS_DIR, `${saved.id}.json`);
    const codec = await import('../../core/incoming');
    for (const mutate of [
      (r: typeof saved) => {
        r.messages![0]!.access = null as unknown as import('../../core/bridge/store').MessageAccess;
      },
      (r: typeof saved) => {
        r.messages![0]!.incoming = {
          version: 2
        } as unknown as import('../../core/bridge/store').MessageRecord['incoming'];
      },
      (r: typeof saved) => {
        r.revision = -1;
      },
      (r: typeof saved) => {
        const admission = r.messages![0]!.incoming!;
        assert.ok(!('denied' in admission));
        const wrong = { ...admission, id: 'other-id' };
        r.messages![0]!.incoming = { ...wrong, digest: codec.admissionDigest(wrong) };
      }
    ]) {
      const raw = structuredClone(saved);
      mutate(raw);
      await writeJson(file, raw);
      const [read] = await store.readConversations();
      assert.ok(read?.messages?.[0]);
      assert.equal(read.messages[0].access?.state, 'closed');
      assert.equal(read.messages[0].desired, saved.messages![0]!.desired);
      read.revision!++;
      assert.equal(await store.writeConversation(read), true);
      const next = await make();
      next.deliver(event());
      await next.drain();
      await next.bridge.stop();
      assert.equal(next.sent.length, 0);
      assert.equal((await store.readConversations())[0]?.messages?.[0]?.access?.state, 'closed');
    }
  });

  it('rejects a save whose rename landed but directory flush failed before allowing a prompt', async (context) => {
    await store.writeConversation(record());
    const t = await make();
    const open = fs.open;
    context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === paths.CONVERSATIONS_DIR)
        context.mock.method(handle, 'sync', () => Promise.reject(new Error('flush unavailable')));
      return handle;
    });
    t.deliver(event());
    await t.drain();
    await t.bridge.stop();
    assert.equal(t.sent.length, 0);
    const [saved] = await store.readConversations();
    assert.ok(saved?.messages?.[0]?.incoming);
    assert.equal(saved.messages[0].delivery, 'admitted');
    assert.equal(saved.messages[0].access?.state, 'held');
    assert.equal(saved.messages[0].target, undefined);
  });

  it('round-trips exact attempt/receiver storage and rejects stale access or receiver replacement', async () => {
    await store.writeConversation(record());
    const t = await make();
    t.deliver(event());
    await t.drain();
    await t.bridge.stop();
    const [saved] = await store.readConversations();
    assert.ok(saved?.messages?.[0]);
    const message = saved.messages[0];
    const original = message.incoming;
    assert.ok(original && !('denied' in original));
    const fixture = await import('../incoming_helpers');
    const attempt = {
      ...fixture.attempt,
      conversation: saved.id,
      messageId: message.id,
      correlation: message.correlation,
      admissionDigest: original.digest
    };
    message.access = { revision: 1, state: 'starting', attempt, execution: 'unresolved' };
    saved.revision!++;
    assert.equal(await store.writeConversation(saved), true);
    assert.deepEqual((await store.readConversations())[0]?.messages?.[0]?.access, message.access);
    message.access = {
      ...message.access,
      revision: 2,
      state: 'active',
      receiver: fixture.receiver,
      execution: 'launched'
    };
    saved.revision!++;
    assert.equal(await store.writeConversation(saved), true);
    const stale = structuredClone(saved);
    stale.revision!++;
    stale.messages![0]!.access = { ...message.access, revision: 1 };
    assert.equal(await store.writeConversation(stale), false);
    const replacement = structuredClone(saved);
    replacement.revision!++;
    replacement.messages![0]!.access = {
      ...message.access,
      revision: 3,
      receiver: { ...fixture.receiver, incarnation: fixture.UUID }
    };
    assert.equal(await store.writeConversation(replacement), false);
    store.denyMessageIncoming(message);
    assert.equal(message.access.attempt?.attemptId, attempt.attemptId);
    assert.deepEqual(message.access.receiver, fixture.receiver);
    saved.revision!++;
    assert.equal(await store.writeConversation(saved), true);
    const [closed] = await store.readConversations();
    assert.deepEqual(closed?.messages?.[0]?.incoming, original);
    assert.equal(closed?.messages?.[0]?.access?.state, 'closed');
    const reopening = structuredClone(closed);
    reopening.revision!++;
    reopening.messages![0]!.access = { revision: 4, state: 'held' };
    assert.equal(await store.writeConversation(reopening), false);
  });
});
