import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { afterEach, before, beforeEach, it } from 'node:test';
import type { SessionVerbs } from '../../core/bridge/bridge';
import type { Inbound, ReactionStatus, Watched } from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import type { ConversationRecord } from '../../core/bridge/store';
import type { MessageFact } from '../../core/message_facts';
import { resetDir, tempHome } from '../helpers';

let engine: typeof import('../../core/bridge/bridge');
let fake: typeof import('../../core/bridge/fake');
let store: typeof import('../../core/bridge/store');
let paths: typeof import('../../core/paths');
const OWNER = 'owner';
const engines: import('../../core/bridge/bridge').Bridge[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((bridge) => bridge.stop()));
});
const T0 = 1_700_000_000_000;

before(async () => {
  await tempHome();
  engine = await import('../../core/bridge/bridge');
  fake = await import('../../core/bridge/fake');
  store = await import('../../core/bridge/store');
  paths = await import('../../core/paths');
});
beforeEach(async () => {
  await resetDir(paths.CONVERSATIONS_DIR);
  await fs.rm(paths.HEARD_FILE, { force: true });
});

function root(facts?: readonly MessageFact[], busy = false): Watched {
  return {
    label: 'worker',
    pending: [],
    ...(facts === undefined ? {} : { messageFacts: facts }),
    session: {
      pid: 10,
      startedAt: T0,
      updatedAt: T0,
      sessionId: 's10',
      windowId: 'w1',
      cwd: '/repo',
      name: 'worker',
      brand: 'claude',
      source: 'owned',
      transcript: '',
      status: busy ? 'busy' : 'idle',
      hasCommand: false,
      turnsEnded: 0
    }
  };
}

async function seed(): Promise<void> {
  const record: ConversationRecord = {
    schema: 1,
    id: 'abcdefgh',
    messenger: 'fake',
    owner: OWNER,
    anchor: 'thread',
    refs: ['thread'],
    latest: 'thread',
    state: 'live',
    root: {
      pid: 10,
      startedAt: T0,
      sessionId: 's10',
      brand: 'claude',
      cwd: '/repo',
      label: 'worker'
    },
    past: [],
    notices: [],
    createdAt: T0,
    updatedAt: T0
  };
  assert.equal(await store.writeConversation(record), true);
}

function make(
  options: {
    effect?: (ref: string, status: ReactionStatus, signal?: AbortSignal) => Promise<void>;
    messenger?: import('../../core/bridge/fake').FakeMessenger;
    send?: SessionVerbs['send'];
    busy?: boolean;
    allowlist?: readonly string[];
    claims?: readonly import('../../core/model').WindowClaim[];
  } = {}
) {
  const messenger = options.messenger ?? fake.fakeMessenger({ now: () => T0 + 1000 });
  const effects: { ref: string; status: ReactionStatus }[] = [];
  const sent: { text: string; correlation?: string }[] = [];
  const network: Messenger = {
    ...messenger,
    reactions: {
      async set(ref, status, signal) {
        effects.push({ ref, status });
        await options.effect?.(ref, status, signal);
      }
    }
  };
  const verbs: SessionVerbs = {
    async send(addr, text, correlation) {
      sent.push({ text, ...(correlation === undefined ? {} : { correlation }) });
      return options.send
        ? options.send(addr, text, correlation)
        : { ok: true, queued: options.busy ? 1 : 0 };
    },
    answer: () => Promise.resolve({ ok: true }),
    interrupt: () => Promise.resolve({ ok: true }),
    deny: () => Promise.resolve({ ok: true }),
    end: () => Promise.resolve({ ok: true }),
    start: () => Promise.resolve({ ok: true, pid: 20, startedAt: T0 + 20, brand: 'claude' }),
    lastReply: () => Promise.resolve(undefined)
  };
  let now = T0 + 1000;
  /** The engine's retry registration, as the Reconciler would hold it. */
  const retry: { at?: number; check?: () => Promise<void>; disposed?: boolean } = {};
  const bridge = new engine.Bridge({
    messenger: network,
    verbs,
    allowlist: options.allowlist ?? [OWNER],
    clock: () => now,
    register: (_name, check) => {
      retry.check = check;
      return {
        schedule: (at) => {
          if (retry.disposed) assert.fail('scheduled after dispose');
          if (at === undefined) delete retry.at;
          else retry.at = at;
        },
        dispose: () => {
          retry.disposed = true;
        }
      };
    }
  });
  engines.push(bridge);
  return {
    bridge,
    messenger,
    effects,
    sent,
    /** When the engine last asked to retry a status. */
    retryAt: () => retry.at,
    /** The Reconciler firing that registration. */
    retry: () => retry.check?.(),
    disposed: () => retry.disposed === true,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    async begin() {
      await bridge.load();
      await bridge.observe([root(undefined, options.busy)], options.claims ?? []);
      bridge.connect();
    },
    drain: () => bridge.tick(now),
    say(text: string) {
      const event = messenger.say(OWNER, text, { in: 'thread' });
      assert.ok(event?.kind === 'message');
      return event;
    },
    statuses(ref: string) {
      return effects.filter((e) => e.ref === ref).map((e) => e.status);
    }
  };
}

async function turns(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

it('acknowledges each admitted message while an earlier send is blocked', async () => {
  await seed();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const t = make({
    send: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    }
  });
  await t.begin();
  const a = t.say('one');
  await pending;
  const b = t.say('two');
  await turns();
  assert.deepEqual(t.statuses(a.ref), ['received']);
  assert.deepEqual(t.statuses(b.ref), ['received']);
  release();
  const stopping = t.bridge.stop();
  await stopping;
});

it('follows correlation evidence instead of queued:0 or another turn finishing', async () => {
  await seed();
  const t = make();
  await t.begin();
  const event = t.say('same text');
  await t.drain();
  const correlation = t.sent[0]?.correlation;
  assert.ok(correlation);
  await t.bridge.observe(
    [{ ...root(), session: { ...root().session, turnsEnded: 4, endedOutcome: 'done' } }],
    []
  );
  await turns();
  assert.deepEqual(t.statuses(event.ref), ['received']);
  await t.bridge.observe([root([{ correlation, phase: 'processing' }])], []);
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'processing');
  await t.bridge.observe([root([{ correlation, phase: 'done' }])], []);
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'done');
  await t.bridge.stop();
});

it('returns definite unsuccessful work to received and leaves unknown work at its last confirmed state', async () => {
  await seed();
  const t = make({ busy: true });
  await t.begin();
  const event = t.say('held');
  await t.drain();
  const correlation = t.sent[0]?.correlation;
  assert.ok(correlation);
  await t.bridge.observe([root([{ correlation, phase: 'queued' }])], []);
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'queued');
  await t.bridge.observe([root([{ correlation, phase: 'processing' }])], []);
  await turns();
  await t.bridge.observe([root([{ correlation, phase: 'unknown' }])], []);
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'processing');
  await t.bridge.observe([root([{ correlation, phase: 'unsuccessful' }])], []);
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'received');
  assert.ok(!t.statuses(event.ref).includes('done'));
  await t.bridge.stop();
});

it('a hung reaction cannot delay delivery and stop aborts its pending effect', async () => {
  await seed();
  const signals: AbortSignal[] = [];
  const t = make({
    effect: async (_ref, _status, signal) => {
      assert.ok(signal);
      signals.push(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    }
  });
  await t.begin();
  t.say('delivered');
  await t.drain();
  assert.equal(t.sent.length, 1);
  await t.bridge.stop();
  assert.equal(signals[0]?.aborted, true);
});

it('retries the latest desired status at a newly scheduled deadline without another session event', async () => {
  await seed();
  let failing = true;
  const t = make({
    effect: () => (failing ? Promise.reject(new Error('cleanup failed')) : Promise.resolve())
  });
  await t.begin();
  const event = t.say('work');
  await t.drain();
  const correlation = t.sent[0]?.correlation;
  assert.ok(correlation);
  await t.bridge.observe([root([{ correlation, phase: 'done' }])], []);
  await turns();
  await eventually(() => t.retryAt() !== undefined);
  const at = t.retryAt();
  assert.ok(at !== undefined && at > t.now());
  assert.equal(t.bridge.nextDeadline(), undefined, 'a retry wakes no routing pass');
  failing = false;
  t.advance(at - t.now());
  await t.retry();
  await turns();
  await eventually(() => t.statuses(event.ref).at(-1) === 'done');
  await t.bridge.stop();
});

it('a reload arms the retry its records carry, and a stop disposes it', async () => {
  await seed();
  const t = make({ effect: () => Promise.reject(new Error('cleanup failed')) });
  await t.begin();
  t.say('work');
  await t.drain();
  await eventually(() => t.retryAt() !== undefined);
  await t.bridge.stop();
  assert.ok(t.disposed());
  const next = make();
  await next.bridge.load();
  assert.ok(next.retryAt() !== undefined, 'armed from the saved deadline, with no pass');
  await next.bridge.stop();
  assert.ok(next.disposed());
});

it('reload reconciles an uncertain accepted send by token without replaying it', async () => {
  await seed();
  const t = make({ send: () => Promise.resolve({ ok: false, reason: 'ack lost', unsure: true }) });
  await t.begin();
  const event = t.say('uncertain');
  await t.drain();
  const correlation = t.sent[0]?.correlation;
  assert.ok(correlation);
  await t.bridge.stop();
  const next = make();
  await next.bridge.load();
  await next.bridge.observe([root([{ correlation, phase: 'done' }])], []);
  await turns();
  assert.equal(next.sent.length, 0);
  await eventually(() => next.statuses(event.ref).at(-1) === 'done');
  await next.bridge.stop();
});

it('admits a live copy once while backlog routing waits behind pending work', async () => {
  await seed();
  const messenger = fake.fakeMessenger({ held: true, now: () => T0 + 2000 });
  const t = make({ messenger });
  await t.begin();
  messenger.link({ kind: 'reconnecting', reason: 'network' });
  const missed: Inbound = messenger.missed(OWNER, 'missed', { in: 'thread' });
  messenger.link({ kind: 'connected' });
  await t.drain();
  await turns();
  assert.equal(t.sent.length, 1);
  assert.ok(missed.kind === 'message');
  assert.equal(t.statuses(missed.ref)[0], 'received');
  await t.bridge.stop();
});

async function eventually(test: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 2000;
  while (!(await test()) && Date.now() < until)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.ok(await test(), 'expected status did not arrive');
}

it('reload resumes a second durably admitted message without replaying the earlier uncertain send', async () => {
  await seed();
  let release: () => void = () => undefined;
  const t = make({
    send: () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, reason: 'lost acknowledgement', unsure: true });
      })
  });
  await t.begin();
  const first = t.say('first');
  const second = t.say('second');
  await eventually(() => t.sent.length === 1);
  await eventually(async () => {
    const messages = (await store.readConversations()).flatMap((r) => r.messages ?? []);
    return messages.some(
      (m) => m.id === second.id && m.delivery === 'admitted' && m.event?.id === second.id
    );
  });
  const stopping = t.bridge.stop();
  release();
  await stopping;
  const next = make();
  await next.begin();
  await next.drain();
  assert.deepEqual(
    next.sent.map((s) => s.text),
    ['second']
  );
  const messages = (await store.readConversations()).flatMap((r) => r.messages ?? []);
  assert.equal(messages.find((m) => m.id === first.id)?.delivery, 'attempted');
  assert.equal(messages.find((m) => m.id === second.id)?.delivery, 'attempted');
});

it('admits catch-up receipts while the routing chain waits on an earlier live send', async () => {
  await seed();
  let release: () => void = () => undefined;
  const messenger = fake.fakeMessenger({ now: () => T0 + 2000 });
  const t = make({
    messenger,
    send: () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      })
  });
  await t.begin();
  t.say('blocked');
  await eventually(() => t.sent.length === 1);
  messenger.link({ kind: 'reconnecting', reason: 'offline' });
  const missed = messenger.missed(OWNER, 'catch up', { in: 'thread' });
  assert.ok(missed.kind === 'message');
  messenger.link({ kind: 'connected' });
  await eventually(() => t.statuses(missed.ref)[0] === 'received');
  assert.equal(t.sent.length, 1);
  const stopping = t.bridge.stop();
  release();
  await stopping;
});

it('keeps receipt-only refusals durably and does not react to strangers, empty messages or commands', async () => {
  const t = make();
  await t.begin();
  t.messenger.say('stranger', 'hello');
  t.messenger.say(OWNER, '   ');
  t.messenger.command(OWNER, 'help');
  const event = t.messenger.say(OWNER, 'no open folder');
  assert.ok(event?.kind === 'message');
  await t.drain();
  const messages = (await store.readConversations()).flatMap((r) => r.messages ?? []);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.ref, event.ref);
  assert.equal(messages[0]?.delivery, 'settled');
  assert.deepEqual(
    t.effects.map((e) => e.ref),
    [event.ref]
  );
  await t.bridge.stop();
  const next = make();
  await next.begin();
  await next.drain();
  assert.equal(next.sent.length, 0);
});

it('a picker-held original is queued until expiry clears its active status', async () => {
  const t = make({
    claims: [
      { id: 'w1', label: 'window', app: 'Code', folder: '/repo', shellPids: [], updatedAt: T0 }
    ]
  });
  await t.begin();
  const event = t.messenger.say(OWNER, 'new job');
  assert.ok(event?.kind === 'message');
  await t.drain();
  await eventually(() => t.statuses(event.ref).at(-1) === 'queued');
  const [record] = await store.readConversations();
  assert.equal(record?.state, 'held');
  assert.equal(record?.messages?.[0]?.correlation, record?.held?.correlation);
  assert.ok(record?.held);
  t.advance(record.held.expiresAt - t.now());
  await t.drain();
  await eventually(() => t.statuses(event.ref).at(-1) === 'received');
  assert.ok(!t.statuses(event.ref).includes('done'));
});

it('an older uncertain start reconciles its message without replacing a newer conversation root', async () => {
  await seed();
  const [record] = await store.readConversations();
  assert.ok(record);
  record.rootCorrelation = 'newer';
  record.messages = [
    {
      id: 'old-message',
      correlation: 'older',
      ref: 'old-ref',
      at: T0,
      desired: 'received',
      delivery: 'attempted'
    }
  ];
  await store.writeConversation(record);
  const t = make();
  await t.bridge.load();
  const old = {
    ...root([{ correlation: 'older', phase: 'done' }]),
    session: { ...root().session, pid: 99, sessionId: 'old-start' }
  };
  await t.bridge.observe([root(), old], []);
  await eventually(() => t.statuses('old-ref').at(-1) === 'done');
  await t.bridge.stop();
  const [saved] = await store.readConversations();
  assert.equal(saved?.root?.pid, 10);
  assert.equal(saved?.messages?.[0]?.target?.pid, 99);
});

for (const overlap of [false, true])
  it(`repairs the newest reaction after late settlement (${overlap ? 'during cleanup' : 'after cleanup'})`, async (context) => {
    const statuses = await import('../../core/bridge/message_status');
    await seed();
    const [record] = await store.readConversations();
    assert.ok(record);
    const message: import('../../core/bridge/store').MessageRecord = {
      id: 'late',
      correlation: 'late',
      ref: 'late-ref',
      at: T0,
      desired: 'received',
      delivery: 'attempted'
    };
    record.messages = [message];
    let release: () => void = () => undefined;
    let releaseLatest: () => void = () => undefined;
    const calls: ReactionStatus[] = [];
    let now = T0;
    const base = fake.fakeMessenger();
    const updates = new statuses.MessageReactions({
      messenger: {
        ...base,
        reactions: {
          set(_ref, status) {
            calls.push(status);
            if (calls.length === 1)
              return new Promise((resolve) => {
                release = resolve;
              });
            if (overlap && calls.length === 2)
              return new Promise((resolve) => {
                releaseLatest = resolve;
              });
            return Promise.resolve();
          }
        }
      },
      clock: () => now,
      save: () => Promise.resolve(true),
      changed: () => undefined,
      log: () => undefined
    });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      updates.remember(record, message);
      updates.desire(message, 'received');
      updates.desire(message, 'done');
      context.mock.timers.tick(statuses.REACTION_CALL_MS);
      await turns();
      assert.deepEqual(calls, ['received', 'done']);
      assert.equal(message.applied, overlap ? undefined : 'done');
      release();
      await turns();
      assert.equal(message.applied, undefined);
      releaseLatest();
      await turns();
      now += statuses.REACTION_RETRY_MS;
      updates.tick(now);
      await turns();
      assert.deepEqual(calls, ['received', 'done', 'done']);
      assert.equal(message.applied, 'done');
    } finally {
      await updates.stop();
    }
  });

it('a reload does not deliver an admission from a sender whose access was removed', async () => {
  await seed();
  const [record] = await store.readConversations();
  assert.ok(record);
  record.messages = [
    {
      id: 'revoked',
      correlation: 'revoked',
      ref: 'original',
      at: T0,
      delivery: 'admitted',
      desired: 'received',
      event: {
        kind: 'message',
        id: 'revoked',
        sender: { id: OWNER },
        text: 'before removal',
        addressed: 'direct',
        refs: ['thread'],
        ref: 'original',
        at: T0
      }
    }
  ];
  await store.writeConversation(record);
  const t = make({ allowlist: ['someone-else'] });
  await t.begin();
  await t.drain();
  assert.equal(t.sent.length, 0);
});

it('unchanged authoritative facts cannot bypass an outstanding reaction retry deadline', async () => {
  await seed();
  const t = make({ effect: () => Promise.reject(new Error('temporary failure')) });
  await t.begin();
  const event = t.say('work');
  await t.drain();
  const correlation = t.sent[0]?.correlation;
  assert.ok(correlation);
  await t.bridge.observe([root([{ correlation, phase: 'processing' }])], []);
  await eventually(() => t.retryAt() !== undefined);
  const attempts = t.statuses(event.ref).length;
  const deadline = t.retryAt();
  await t.bridge.observe([root([{ correlation, phase: 'processing' }])], []);
  await t.bridge.observe([root([{ correlation, phase: 'processing' }])], []);
  await turns();
  assert.equal(t.statuses(event.ref).length, attempts);
  assert.equal(t.retryAt(), deadline);
});

it('restores queued for an original prompt still held by a folder picker', async () => {
  await seed();
  const [record] = await store.readConversations();
  assert.ok(record);
  record.schema = 2;
  record.state = 'held';
  delete record.root;
  record.held = {
    prompt: 'pick a folder',
    folders: ['/repo'],
    expiresAt: T0 + 600_000,
    correlation: 'held-token',
    picker: {
      stage: 'folder',
      generation: 0,
      page: 0,
      published: 0,
      destination: { under: 'held-ref' }
    }
  };
  record.messages = [
    {
      id: 'held-message',
      correlation: 'held-token',
      ref: 'held-ref',
      at: T0,
      desired: 'received',
      delivery: 'held'
    }
  ];
  await store.writeConversation(record);
  const t = make();
  await t.bridge.load();
  await eventually(() => t.statuses('held-ref').at(-1) === 'queued');
  await t.bridge.stop();
  const [saved] = await store.readConversations();
  assert.equal(saved?.messages?.[0]?.desired, 'queued');
  assert.equal(saved?.messages?.[0]?.delivery, 'held');
  assert.equal(t.sent.length, 0);
});

it('repairs received after a processing effect partially fails during interruption', async () => {
  const statuses = await import('../../core/bridge/message_status');
  await seed();
  const [record] = await store.readConversations();
  assert.ok(record);
  const message: import('../../core/bridge/store').MessageRecord = {
    id: 'partial',
    correlation: 'partial',
    ref: 'partial-ref',
    at: T0,
    desired: 'received',
    delivery: 'attempted'
  };
  record.messages = [message];
  const calls: ReactionStatus[] = [];
  let fail = () => {};
  const updates = new statuses.MessageReactions({
    messenger: {
      ...fake.fakeMessenger(),
      reactions: {
        set(_ref, status) {
          calls.push(status);
          if (status === 'processing')
            return new Promise<void>((_resolve, reject) => {
              fail = () => reject(new Error('cleanup failed'));
            });
          return Promise.resolve();
        }
      }
    },
    clock: () => T0,
    save: () => Promise.resolve(true),
    changed: () => {},
    log: () => {}
  });
  try {
    updates.remember(record, message);
    updates.desire(message, 'received');
    await turns();
    updates.desire(message, 'processing');
    updates.desire(message, 'received');
    fail();
    await turns();
    assert.deepEqual(calls, ['received', 'processing', 'received']);
    assert.equal(message.applied, 'received');
  } finally {
    await updates.stop();
  }
});
