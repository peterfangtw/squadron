import { incomingPlatformFixture } from '../remote/incoming_platform_helpers';
import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import type { Budget } from '../../core/platform/files';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import * as rig from '../remote/incoming_bridge_helpers';
import * as children from '../remote/incoming_owner_helpers';
import { tempHome, resetDir } from '../helpers';
import type { Reply } from '../../core/coordination/requests';

let paths: typeof import('../../core/paths');
let store: typeof import('../../core/bridge/store');
let cwd: string;
const rigs: Awaited<ReturnType<typeof rig.make>>[] = [];
let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  paths = await import('../../core/paths');
  store = await import('../../core/bridge/store');
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'incoming-bridge-')));
});
beforeEach(async () => {
  await resetDir(paths.CONVERSATIONS_DIR);
  await resetDir(paths.LIVE_DIR);
  await resetDir(paths.REQUESTS_DIR);
  await fs.rm(paths.HEARD_FILE, { force: true });
});
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});
async function make(options: Parameters<typeof rig.make>[1] = {}) {
  const result = await rig.make(cwd, options);
  rigs.push(result);
  return result;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(want: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await want()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await want());
}

it(
  'commits a known receiver before real delivery; withheld acknowledgement resolves outside routing through its owner receipt',
  { timeout: 10_000 },
  async () => {
    const entered = deferred<Reply>();
    const release = deferred<Reply>();
    const t = await make({
      foreign: true,
      sendReply: (reply) => {
        entered.resolve(reply);
        return release.promise;
      }
    });
    t.send();
    const original = await entered.promise;
    try {
      const view = await t.view();
      assert.equal(view.access.state, 'intended');
      assert.deepEqual(view.access.receiver, t.started[0]?.owner.receiverIdentity);
      const saved = (await store.readConversations())[0]?.messages?.[0];
      assert.equal(saved?.access?.state, 'intended');
      assert.ok(saved?.incoming && !('denied' in saved.incoming));
      await t.bridge.recoverIncoming(view.conversation, view.correlation);
      assert.equal((await t.view()).access.state, 'active');
      assert.equal(t.started[0]?.owner.snapshot().incomingDeliveries.length, 1);
      assert.equal(await t.bridge.closeIncoming(view.conversation, view.correlation), true);
      assert.equal((await t.view()).denial, 'closed');
    } finally {
      release.resolve(original);
    }
    await t.drain();
    assert.equal((await t.view()).access.state, 'closed');
  }
);

it(
  'new picker launch commits exact intent; lost reply and holder reload recover from original destination after fact eviction',
  { timeout: 20_000 },
  async () => {
    const launched = deferred<Reply>();
    const release = deferred<Reply>();
    const t = await make({
      root: false,
      foreign: true,
      startReply: (reply) => {
        launched.resolve(reply);
        return release.promise;
      }
    });
    t.send(0, 'inspect it', []);
    await t.drain();
    const pressing = t.press('Use window default');
    const reply = await launched.promise;
    try {
      assert.equal(t.started.length, 1);
      const child = t.started[0];
      assert.ok(child);
      const before = await t.view();
      assert.equal(before.access.state, 'starting');
      assert.equal(before.access.execution, 'unresolved');
      const attempt = before.access.attempt;
      assert.ok(attempt);
      assert.deepEqual(attempt.host, t.capability.host);
      assert.equal(attempt.cwd, cwd);
      assert.equal(attempt.selection, 'default');
      assert.deepEqual(child.owner.snapshot().remoteLaunchEvidence?.attempt, attempt);
      await children.until(
        child.handle,
        (handle) => !handle.state.running && (handle.state.turnsEnded ?? 0) >= 1
      );
      for (let n = 0; n < 260; n++) {
        const ended = child.handle.state.turnsEnded ?? 0;
        await child.route.messages!.send(
          `ordinary ${n}`,
          undefined,
          undefined,
          undefined,
          undefined,
          `other-${n}`
        );
        await children.until(
          child.handle,
          (handle) => !handle.state.running && (handle.state.turnsEnded ?? 0) > ended
        );
      }
      assert.equal(
        child.handle.state.messageFacts?.some((fact) => fact.correlation === before.correlation),
        false
      );
      await child.publish();
      await t.bridge.recoverIncoming(before.conversation, before.correlation);
      assert.equal((await t.view()).access.state, 'active');
      assert.deepEqual((await t.view()).access.receiver, child.owner.receiverIdentity);
      assert.equal(
        child.owner.snapshot().remoteLaunchEvidence?.attempt.attemptId,
        attempt.attemptId
      );
    } finally {
      release.resolve({ ...reply, ok: false, unsure: true, reason: 'reply lost' });
    }
    await pressing;
    await t.reload();
    await t.observe();
    const view = await t.view();
    await t.bridge.recoverIncoming(view.conversation, view.correlation);
    assert.equal((await t.view()).access.state, 'active');
    assert.equal(t.started.length, 1);
    assert.equal((await store.readConversations())[0]?.root?.pid, t.started[0]?.pid);
  }
);

for (const brand of ['claude', 'grok', 'codex'] as const) {
  it(
    `${brand}: idle, queued, permission and person-answer deliveries keep each original; dismissal closes only its queue row`,
    { timeout: 20_000 },
    async () => {
      const t = await make({ brand });
      const child = t.started[0];
      assert.ok(child);
      t.send(0, 'slow');
      await t.drain();
      await children.until(child.handle, (handle) => handle.state.running);
      t.send(1, 'inspect first');
      await t.drain();
      t.send(2, 'inspect second');
      await t.drain();
      t.send(7, 'inspect third');
      await t.drain();
      const first = await t.view('original-1');
      const second = await t.view('original-2');
      assert.equal(first.access.state, 'active');
      assert.equal(second.access.state, 'active');
      const row = child.handle.state.queued.find((row) => row.correlation === first.correlation);
      assert.ok(row);
      assert.equal(child.handle.messages?.dismiss(row.id), true);
      await t.observe();
      await eventually(async () => (await t.view('original-1')).access.state === 'closed');
      assert.equal((await t.view('original-2')).access.state, 'active');
      await child.handle.messages?.sendNow();
      await children.until(
        child.handle,
        (handle) => !handle.state.running && handle.state.queued.length === 0
      );
      await t.observe();
      assert.equal((await t.view('original-2')).access.state, 'active');
      assert.deepEqual(
        new Set(child.handle.state.messageTurn),
        new Set([second.correlation, (await t.view('original-7')).correlation])
      );
      const old = child.owner.receiverIdentity;
      const question = brand === 'codex' ? 'question request' : 'ask';
      t.send(3, question);
      await t.drain();
      await children.until(child.handle, (handle) => handle.state.pending.some((ask) => ask.ask));
      await t.observe();
      t.send(4, 'blue');
      await t.drain();
      assert.equal((await t.view('original-4')).access.state, 'active');
      const answered = await t.view('original-4');
      assert.equal(
        child.owner
          .snapshot()
          .incomingDeliveries.find((receipt) => receipt.correlation === answered.correlation)
          ?.outcome,
        'person-answer'
      );
      await children.until(child.handle, (handle) => !handle.state.running);
      const permission = brand === 'codex' ? 'patch request' : brand === 'grok' ? 'perm' : 'write';
      t.send(5, permission);
      await t.drain();
      await children.until(child.handle, (handle) => handle.state.pending.some((ask) => !ask.ask));
      await t.observe();
      t.send(6, 'inspect after permission');
      await t.drain();
      assert.equal((await t.view('original-6')).access.state, 'active');
      assert.deepEqual((await t.view('original-0')).access.receiver, old);
      assert.equal((await t.view('original-0')).access.state, 'active');
    }
  );
}

it(
  'wrong destination, duplicate candidates and stale activation deny recovery; late older evidence never replaces a newer routing root',
  {},
  async () => {
    const t = await make({
      root: false,
      startReply: () => Promise.resolve({ ok: false, unsure: true, reason: 'original reply lost' })
    });
    t.queries(false);
    t.send(0, 'inspect it', []);
    await t.drain();
    await t.press('Use window default');
    const old = await t.view();
    const attempt = old.access.attempt;
    assert.ok(attempt);
    const child = t.started[0];
    assert.ok(child);
    const challenge = crypto.randomUUID();
    assert.equal(
      await t.host.evidence(
        [child.owner, child.owner],
        challenge,
        { kind: 'attempt', attempt },
        () => child.publish()
      ),
      undefined
    );
    for (const mutated of [
      { ...attempt, host: { ...attempt.host, incarnation: crypto.randomUUID() } },
      { ...attempt, cwd: path.dirname(attempt.cwd) },
      { ...attempt, admissionDigest: 'b'.repeat(64) }
    ])
      assert.equal(await t.evidence({ kind: 'attempt', attempt: mutated }), undefined);
    assert.equal(old.access.state, 'starting');
    t.queries(true);
    const proof = await t.evidence({ kind: 'attempt', attempt });
    assert.ok(proof);
    const newer = await children.child(t.host, 'claude', cwd);
    t.started.push(newer);
    const [record] = await store.readConversations();
    assert.ok(record);
    // A loaded newer root is independent of the original message's access receiver.
    await t.bridge.stop();
    assert.ok(newer.handle.state.sessionId);
    record.root = {
      pid: newer.pid,
      startedAt: newer.startedAt,
      sessionId: newer.handle.state.sessionId,
      cwd,
      brand: 'claude',
      label: 'newer'
    };
    record.rootCorrelation = 'newer-original';
    record.revision = (record.revision ?? 0) + 1;
    assert.equal(await store.writeConversation(record), true);
    await t.reload();
    await t.observe([newer]);
    await t.bridge.recoverIncoming(old.conversation, old.correlation);
    const current = await t.view();
    const result = await t.bridge.resolveIncomingReceiver(
      {
        conversation: current.conversation,
        correlation: current.correlation,
        revision: current.access.revision,
        generation: current.generation,
        digest: attempt.admissionDigest,
        attemptId: attempt.attemptId
      },
      proof
    );
    assert.equal(result, 'unchanged');
    assert.equal((await store.readConversations())[0]?.root?.pid, newer.pid);
    assert.deepEqual((await t.view()).access.receiver, child.owner.receiverIdentity);
  }
);

it(
  'a closure beats an older intended write; no speculative projection or late assignment can reopen it',
  {},
  async (context) => {
    const t = await make();
    const entered = deferred<void>();
    const release = deferred<void>();
    const rename = fs.rename;
    let held = true;
    context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (held && args[1] === path.join(paths.CONVERSATIONS_DIR, 'abcdefgh.json')) {
        const record = JSON.parse(
          await fs.readFile(args[0], 'utf8')
        ) as import('../../core/bridge/store').ConversationRecord;
        if (record.messages?.some((message) => message.access?.state === 'intended')) {
          held = false;
          entered.resolve();
          await release.promise;
        }
      }
      return rename(...args);
    });
    t.send();
    try {
      await entered.promise;
      const before = await t.view();
      assert.equal(before.access.receiver, undefined);
      const closing = t.bridge.closeIncoming(before.conversation, before.correlation);
      assert.equal(
        t.bridge.accessSnapshot(before.conversation, before.correlation)?.denial,
        'closed'
      );
      release.resolve();
      await closing;
      await t.drain();
      const closed = await t.view();
      assert.equal(closed.access.state, 'closed');
      assert.equal(closed.denial, 'closed');
      assert.equal(t.started[0]?.owner.snapshot().incomingDeliveries.length, 0);
      await t.reload();
      assert.equal((await t.view()).access.state, 'closed');
    } finally {
      release.resolve();
    }
  }
);

it(
  'failed withdrawal denies its current generation; saved closures survive re-addition and reload',
  {},
  async (context) => {
    const t = await make();
    t.send();
    await t.drain();
    const active = await t.view();
    assert.equal(active.access.state, 'active');
    const destination = path.join(paths.CONVERSATIONS_DIR, 'abcdefgh.json');
    const budgets: Budget[] = [];
    let attempts = 0;
    let waits = 0;
    const backend = win32.files({
      stat: () => Promise.reject(new Error('target metadata unavailable')),
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: (source, to) => {
        if (to === destination) attempts++;
        return fs.rename(source, to);
      },
      sleep: () => {
        waits++;
        return Promise.resolve();
      }
    });
    context.mock.method(platform.files, 'replace', (source: string, to: string, budget: Budget) => {
      if (to === destination) budgets.push(budget);
      return backend.replace(source, to, budget);
    });
    const rename = fs.rename;
    let failing = true;
    context.mock.method(fs, 'rename', (...args: Parameters<typeof fs.rename>) =>
      failing && args[1] === path.join(paths.CONVERSATIONS_DIR, 'abcdefgh.json')
        ? Promise.reject(
            Object.assign(new Error('closure persistence unavailable'), { code: 'EBUSY' })
          )
        : rename(...args)
    );
    const current = { messengerId: 'fake', installId: 'install', allowedIds: ['owner'] };
    assert.equal(
      await t.bridge.observeIncomingPolicy({ ...current, allowedIds: [] }, t.holder),
      false
    );
    assert.equal((await t.view()).denial, 'admission-denied');
    assert.ok(budgets.length > 0);
    assert.deepEqual(
      budgets,
      budgets.map(() => ({ kind: 'owned' }))
    );
    assert.equal(attempts, budgets.length);
    assert.equal(waits, 0);
    assert.equal(await t.bridge.observeIncomingPolicy(current, t.holder), false);
    assert.equal((await t.view()).denial, 'admission-denied');
    assert.equal((await store.readConversations())[0]?.messages?.[0]?.access?.state, 'active');
    await t.bridge.stop();
    failing = false;
    await t.reload();
    assert.equal(
      (await t.view()).access.state,
      'active',
      'a lost uncommitted withdrawal cannot be reconstructed'
    );
    assert.equal(
      await t.bridge.observeIncomingPolicy({ ...current, installId: 'other' }, t.holder),
      true
    );
    assert.equal((await t.view()).denial, 'wrong-install');
    assert.equal(await t.bridge.observeIncomingPolicy(current, t.holder), true);
    await t.reload();
    assert.equal((await t.view()).access.state, 'closed');
    assert.equal((await t.view()).denial, 'wrong-install');
  }
);

// Each real delivery costs ~9 whole-conversation durable writes and 3 fresh
// process scans. At ~11 writes, 260 deliveries alone took 48 s at load 3 and
// past 300 s in a full gate. Two 256-entry windows are what this crosses, and
// neither needs that many Bridge deliveries: the native fact window takes
// ordinary turns on the pipe, and the store's reaction window takes settled
// history, as the metadata-ceiling case below seeds it.
it(
  'originals past both 256 windows retain real owner receipts through reload without old reactions or delivery replay',
  { timeout: 60_000 },
  async () => {
    const t = await make();
    const child = t.started[0];
    assert.ok(child);
    const deliver = async (n: number) => {
      t.send(n);
      await t.drain();
      await children.until(
        child.handle,
        (handle) => !handle.state.running && handle.state.queued.length === 0
      );
      await t.observe();
    };
    for (let n = 0; n < 4; n++) await deliver(n);
    const original = await t.view();
    assert.equal(original.access.state, 'active');
    for (let n = 0; n < 256; n++) {
      const ended = child.handle.state.turnsEnded ?? 0;
      await child.route.messages!.send(
        `ordinary ${n}`,
        undefined,
        undefined,
        undefined,
        undefined,
        `other-${n}`
      );
      await children.until(
        child.handle,
        (handle) => !handle.state.running && (handle.state.turnsEnded ?? 0) > ended
      );
    }
    assert.equal(
      child.handle.state.messageFacts?.some((fact) => fact.correlation === original.correlation),
      false
    );
    await t.bridge.stop();
    const [record] = await store.readConversations();
    assert.ok(record?.messages);
    record.messages = [
      ...record.messages,
      ...Array.from({ length: 252 }, (_, n) => ({
        id: `history-${n}`,
        correlation: crypto.randomUUID(),
        ref: `history-ref-${n}`,
        at: Date.now(),
        desired: 'done' as const,
        applied: 'done' as const,
        delivery: 'settled' as const,
        terminal: true as const
      }))
    ];
    record.revision = (record.revision ?? 0) + 1;
    assert.equal(await store.writeConversation(record), true);
    await t.reload();
    for (let n = 4; n < 8; n++) await deliver(n);
    assert.equal(child.owner.snapshot().incomingDeliveries.length, 8);
    const [saved] = await store.readConversations();
    assert.equal(saved?.messages?.length, 260);
    assert.deepEqual(
      saved.messages?.filter((message) => message.reactionRetired).map((message) => message.id),
      ['original-0', 'original-1', 'original-2', 'original-3']
    );
    assert.equal((await t.view()).access.state, 'active');
    const before = t.messenger.reactionEffects().length;
    await t.reload();
    const admitted = saved.messages?.[0];
    assert.ok(admitted?.incoming && !('denied' in admitted.incoming));
    t.deliver({
      kind: 'message',
      id: admitted.id,
      ref: admitted.ref,
      refs: ['thread'],
      sender: { id: 'owner' },
      text: 'inspect it',
      addressed: 'direct',
      at: admitted.incoming.eventAt,
      incoming: {
        version: 1,
        installId: admitted.incoming.installId,
        omitted: 0,
        files: admitted.incoming.files
      }
    });
    await t.drain();
    assert.equal(child.owner.snapshot().incomingDeliveries.length, 8);
    assert.equal(t.messenger.reactionEffects().length, before);
    assert.deepEqual((await t.view()).access.receiver, original.access.receiver);
  }
);

it(
  'failed intent publication stays unavailable until acknowledged retry, without a prompt before the retry',
  {},
  async (context) => {
    const t = await make();
    const open = fs.open;
    let fail = true;
    context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (fail && args[0] === paths.CONVERSATIONS_DIR) {
        const [record] = await store.readConversations();
        if (record?.messages?.some((message) => message.access?.state === 'intended'))
          context.mock.method(handle, 'sync', () =>
            Promise.reject(new Error('intent flush failure'))
          );
      }
      return handle;
    });
    t.send();
    await t.drain();
    assert.equal((await t.view()).access.receiver, undefined);
    assert.equal((await t.view()).denial, 'storage-unavailable');
    assert.equal(t.started[0]?.owner.snapshot().incomingDeliveries.length, 0);
    fail = false;
    assert.equal(await t.bridge.retryIncomingWrites(), true);
    await t.reload();
    await t.drain();
    assert.equal((await t.view()).access.state, 'active');
    assert.equal(t.started[0]?.owner.snapshot().incomingDeliveries.length, 1);
  }
);

it(
  'metadata ceilings refuse only new files, preserve earlier real access and load all history intact',
  {},
  async () => {
    const t = await make();
    t.send();
    await t.drain();
    const original = await t.view();
    assert.equal(original.access.state, 'active');
    await t.bridge.stop();
    const [record] = await store.readConversations();
    assert.ok(record);
    const source = record.messages?.[0];
    assert.ok(source?.incoming && !('denied' in source.incoming));
    const incoming = await import('../../core/incoming');
    function history(prefix: string): import('../../core/bridge/store').MessageRecord[] {
      const admission = source!.incoming;
      assert.ok(admission && !('denied' in admission));
      return Array.from({ length: 350 }, (_, n) => {
        const id = `${prefix}-${n}`;
        const correlation = crypto.randomUUID();
        const body = { ...admission, id, ref: `${id}-ref`, correlation };
        return {
          ...source!,
          id,
          ref: body.ref,
          correlation,
          incoming: { ...body, digest: incoming.admissionDigest(body) },
          access: { revision: 0, state: 'held' },
          delivery: 'settled',
          terminal: true,
          reactionRetired: true
        };
      });
    }
    record.messages = [source, ...history('conversation')];
    record.revision = (record.revision ?? 0) + 1;
    assert.equal(await store.writeConversation(record), true);
    await t.reload();
    t.send(1);
    await t.drain();
    assert.equal((await t.view('original-1')).denial, 'capacity');
    assert.deepEqual((await t.view()).access.receiver, original.access.receiver);
    await t.bridge.stop();
    const template = (await store.readConversations())[0];
    assert.ok(template);
    for (const id of ['other001', 'other002', 'other003']) {
      assert.equal(
        await store.writeConversation({
          ...template,
          id,
          anchor: id,
          refs: [id],
          latest: id,
          messages: history(id),
          revision: 1
        }),
        true
      );
    }
    assert.equal(
      await store.writeConversation({
        ...template,
        id: 'fresh001',
        anchor: 'fresh-thread',
        refs: ['fresh-thread'],
        latest: 'fresh-thread',
        messages: [],
        revision: 1
      }),
      true
    );
    await t.reload();
    t.send(2, 'ordinary text at machine capacity', ['fresh-thread']);
    await t.drain();
    assert.equal((await t.view('original-2')).denial, 'capacity');
    assert.equal(t.started.length, 1);
    assert.equal(
      (await store.readConversations()).find((row) => row.id === 'abcdefgh')?.messages?.length,
      352
    );
    assert.equal((await t.view()).access.state, 'active');
  }
);

it(
  'fresh file replies commit a new exact attempt without transferring the ended receiver’s files',
  {},
  async () => {
    const t = await make();
    t.send();
    await t.drain();
    const old = await t.view();
    const first = t.started[0];
    assert.ok(first);
    await children.until(first.handle, (handle) => !handle.state.running);
    await first.close();
    await t.observe();
    t.send(1, 'inspect a fresh file');
    await t.drain();
    const fresh = await t.view('original-1');
    assert.equal(t.started.length, 2);
    assert.equal(fresh.access.state, 'active');
    assert.equal(fresh.access.attempt?.selection, 'default');
    assert.equal(fresh.access.attempt?.cwd, cwd);
    assert.deepEqual(fresh.access.attempt?.host, t.capability.host);
    assert.deepEqual(fresh.access.receiver, t.started[1]?.owner.receiverIdentity);
    assert.deepEqual((await t.view()).access.receiver, old.access.receiver);
    assert.notDeepEqual(fresh.access.receiver, old.access.receiver);
  }
);

it(
  'held picker cancellation and expiry close only their originals; empty file-only input remains inert',
  {},
  async () => {
    const t = await make({ root: false });
    t.send(0, 'inspect it', []);
    await t.drain();
    const held = await t.view();
    assert.equal(held.access.state, 'held');
    assert.equal(held.access.receiver, undefined);
    await t.press('Cancel');
    assert.equal((await t.view()).access.state, 'closed');
    await t.reload();
    assert.equal((await t.view()).access.state, 'closed');
    t.send(1, 'inspect another', []);
    await t.drain();
    t.advance(10 * 60_000 + 1);
    await t.drain();
    assert.equal((await t.view('original-1')).access.state, 'closed');
    t.send(2, '', []);
    await t.drain();
    assert.equal(
      (await store.readConversations())
        .flatMap((record) => record.messages ?? [])
        .some((message) => message.id === 'original-2'),
      false
    );
    assert.equal(t.started.length, 0);
  }
);

it(
  'original manifests reach picker starts, held rows and person answers without replay widening',
  {},
  async (context) => {
    const t = await make({ root: false, foreign: true });
    const prompts: string[] = [];
    const start = t.verbs.start.bind(t.verbs);
    context.mock.method(t.verbs, 'start', (input: Parameters<typeof start>[0]) => {
      prompts.push(input.prompt);
      return start(input);
    });
    const event: Extract<import('../../core/bridge/model').Inbound, { kind: 'message' }> = {
      kind: 'message',
      id: 'original-0',
      ref: 'ref-0',
      refs: [],
      sender: { id: 'owner' },
      addressed: 'direct',
      text: 'inspect these',
      at: Date.now(),
      incoming: {
        version: 1,
        installId: 'install',
        omitted: 2,
        files: [
          {
            id: 'file-0',
            source: 'private:first',
            cacheKey: 'fake_0',
            name: 'a"`$()\' name.txt',
            mime: 'text/plain',
            size: 7
          },
          {
            id: "file' with spaces",
            source: 'private:second',
            cacheKey: 'fake_1',
            name: 'second.txt'
          }
        ]
      }
    };
    t.deliver(event);
    await t.drain();
    const view = await t.view();
    const command = `'${path.join(paths.BIN_DIR, 'squadron-fetch-file').replaceAll("'", "'\\''")}' --conversation-id ${view.conversation} --message-id ${view.correlation} --file-id file-0`;
    await t.press('Use window default');
    assert.ok(prompts[0]?.includes(command), prompts[0]);
    assert.match(prompts[0] ?? '', /Read images with your native image reader/);
    assert.ok(
      prompts[0]?.includes(
        JSON.stringify({ id: 'file-0', name: 'a"`$()\' name.txt', mime: 'text/plain', size: 7 })
      )
    );
    assert.ok(prompts[0]?.includes('"omitted":2'));
    assert.ok(prompts[0]?.includes("--file-id 'file'\\'' with spaces'"));
    assert.equal(prompts[0]?.includes('private:'), false);
    assert.ok(
      t.messenger
        .posts()
        .some((post) => post.notice.kind === 'picker' && post.notice.body.includes(command))
    );
    const child = t.started[0]!;
    await children.until(child.handle, (handle) => !handle.state.running);
    await t.observe();
    t.deliver({
      ...event,
      incoming: {
        version: 1,
        installId: 'install',
        omitted: 0,
        files: [{ id: 'extra', source: 'private:extra', cacheKey: 'fake_extra' }]
      }
    });
    await t.drain();
    assert.equal(prompts.length, 1);
    t.send(1, 'slow', [event.ref]);
    await t.drain();
    await children.until(child.handle, (handle) => handle.state.running);
    t.send(2, 'inspect next', [event.ref]);
    await t.drain();
    const next = await t.view('original-2');
    const queued = child.handle.state.queued.find((row) => row.correlation === next.correlation);
    assert.ok(
      queued?.text.includes(`--message-id ${next.correlation} --file-id file-2`),
      queued?.text
    );
    assert.equal(queued?.text.includes(`--message-id ${view.correlation}`), false);
    assert.ok(t.messenger.posts().at(-1)?.notice.body.includes(`--message-id ${next.correlation}`));
    await child.handle.messages!.sendNow();
    await children.until(child.handle, (handle) => !handle.state.running);
    t.send(3, 'ask', [event.ref]);
    await t.drain();
    await children.until(child.handle, (handle) => handle.state.pending.some((ask) => ask.ask));
    await t.observe();
    const answers: string[] = [];
    const answer = t.verbs.answer.bind(t.verbs);
    context.mock.method(t.verbs, 'answer', (...args: Parameters<typeof answer>) => {
      answers.push(args[2]);
      return answer(...args);
    });
    t.send(4, 'blue', [event.ref]);
    await t.drain();
    const answered = await t.view('original-4');
    assert.ok(answers[0]?.includes(`--message-id ${answered.correlation} --file-id file-4`));
    assert.equal(answers[0]?.includes('private:'), false);
  }
);
