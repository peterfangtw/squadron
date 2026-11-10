import { incomingPlatformFixture } from '../remote/incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import type { AccessExpectation, AccessProjection, AccessLedger } from '../../core/bridge/access';
import * as rigs from '../remote/incoming_bridge_helpers';
import * as children from '../remote/incoming_owner_helpers';
import { tempHome, resetDir } from '../helpers';

let access: typeof import('../../core/bridge/access');
let store: typeof import('../../core/bridge/store');
let paths: typeof import('../../core/paths');
let cwd: string;
const activeRigs: Awaited<ReturnType<typeof rigs.make>>[] = [];
let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  access = await import('../../core/bridge/access');
  store = await import('../../core/bridge/store');
  paths = await import('../../core/paths');
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'incoming-ledger-')));
});
beforeEach(async () => {
  await resetDir(paths.CONVERSATIONS_DIR);
  await resetDir(paths.LIVE_DIR);
  await resetDir(paths.REQUESTS_DIR);
  await fs.rm(paths.HEARD_FILE, { force: true });
});
afterEach(async () => {
  await Promise.all(activeRigs.splice(0).map((rig) => rig.close()));
});
function expected(view: AccessProjection): AccessExpectation {
  assert.ok(!('denied' in view.admission));
  return {
    conversation: view.conversation,
    correlation: view.correlation,
    generation: view.generation,
    revision: view.access.revision,
    digest: view.admission.digest,
    ...(view.access.attempt ? { attemptId: view.access.attempt.attemptId } : {})
  };
}

async function admitted() {
  const t = await rigs.make(cwd, { root: false });
  activeRigs.push(t);
  t.send(0, 'inspect it', []);
  await t.drain();
  await t.bridge.stop();
  const [record] = await store.readConversations();
  assert.ok(record);
  const message = record.messages?.[0];
  assert.ok(message?.incoming && !('denied' in message.incoming));
  const ledger: AccessLedger = new access.AccessLedger({
    mutate: (step) => step(),
    clock: Date.now,
    changed: () => {},
    async save(record) {
      record.revision = (record.revision ?? 0) + 1;
      const capture = ledger.capture(record);
      const wrote = await store.writeConversation(record);
      ledger.written(record, capture, wrote);
      return wrote;
    }
  });
  ledger.load([record], true, 'fake');
  assert.equal(
    await ledger.observe(
      { messengerId: 'fake', installId: 'install', allowedIds: ['owner'] },
      t.holder
    ),
    true
  );
  const view = () => {
    const snapshot = ledger.snapshot(record.id, message.correlation);
    assert.ok(snapshot);
    return snapshot;
  };
  const child = await children.child(t.host, 'claude', cwd);
  t.started.push(child);
  const attempt = children.attempt(child.owner, t.holder, {
    conversation: record.id,
    messageId: message.id,
    correlation: message.correlation,
    admissionDigest: message.incoming.digest
  });
  return { t, ledger, record, message, child, attempt, view };
}

it(
  'compares exact committed attempts and one immutable receiver using production-minted prepared and accepted evidence',
  {},
  async () => {
    const t = await admitted();
    const held = t.view();
    assert.equal(await t.ledger.begin(expected(held), t.attempt), 'committed');
    const starting = t.view();
    assert.equal(
      await t.ledger.begin(expected(starting), {
        ...t.attempt,
        target: { model: undefined, effort: undefined, brand: 'claude' }
      }),
      'unchanged'
    );
    const sent = await t.child.owner.start(
      t.attempt,
      async () => {
        const prepared = await t.child.owner.evidence(
          crypto.randomUUID(),
          { kind: 'attempt', attempt: t.attempt },
          t.child.publish
        );
        assert.ok(prepared);
        assert.equal(prepared.launch?.stage, 'prepared');
        assert.equal(await t.ledger.resolve(expected(starting), prepared), 'pending');
        assert.equal(t.view().access.receiver, undefined);
        return t.child.route.messages!.send(
          'inspect it',
          undefined,
          undefined,
          undefined,
          undefined,
          t.attempt.correlation
        );
      },
      t.child.publish,
      () => Promise.resolve(true)
    );
    assert.equal(sent.ok, true);
    const proof = await t.child.owner.evidence(
      crypto.randomUUID(),
      { kind: 'attempt', attempt: t.attempt },
      t.child.publish
    );
    assert.ok(proof);
    for (const changed of [
      { digest: 'b'.repeat(64) },
      { revision: starting.access.revision + 1 },
      { attemptId: crypto.randomUUID() }
    ])
      assert.equal(
        await t.ledger.resolve({ ...expected(starting), ...changed }, proof),
        'conflict'
      );
    assert.equal(await t.ledger.resolve(expected(starting), proof), 'committed');
    const assigned = t.view();
    assert.equal(await t.ledger.resolve(expected(assigned), proof), 'unchanged');
    const other = await children.child(t.t.host, 'claude', cwd);
    t.t.started.push(other);
    assert.equal(
      await t.ledger.intend(expected(assigned), other.owner.receiverIdentity),
      'conflict'
    );
    assert.deepEqual(t.view().access.receiver, t.child.owner.receiverIdentity);
    assert.equal(held.access.state, 'held');
    assert.equal(Reflect.set(assigned.access.receiver!, 'pid', 9), false);
    assert.equal(Reflect.set(assigned.access, 'state', 'held'), false);
    t.ledger.dispose();
    assert.equal(await t.ledger.resolve(expected(assigned), proof), 'closed');
  }
);

it(
  'only a proven native no-start permits a new attempt; retired IDs persist and cannot be replayed',
  {},
  async (context) => {
    const t = await admitted();
    assert.equal(await t.ledger.begin(expected(t.view()), t.attempt), 'committed');
    const open = fs.open;
    context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === paths.LIVE_DIR)
        context.mock.method(handle, 'sync', () =>
          Promise.reject(new Error('required owner publication failed'))
        );
      return handle;
    });
    const result = await t.child.owner.start(
      t.attempt,
      () => {
        throw new Error('an uncommitted marker cannot send');
      },
      t.child.publish,
      () => Promise.resolve(true)
    );
    assert.deepEqual(result, { ok: false, outcome: 'stopped' });
    assert.equal(await t.ledger.notStarted(expected(t.view())), 'committed');
    context.mock.restoreAll();
    const next = await children.child(t.t.host, 'claude', cwd);
    t.t.started.push(next);
    const retry = { ...t.attempt, attemptId: crypto.randomUUID() };
    assert.equal(await t.ledger.begin(expected(t.view()), retry), 'committed');
    assert.deepEqual(t.view().access.retiredAttempts, [
      { attemptId: t.attempt.attemptId, execution: 'not-started' }
    ]);
    assert.equal(await t.ledger.begin(expected(t.view()), t.attempt), 'conflict');
    assert.equal(
      (await store.readConversations())[0]?.messages?.[0]?.access?.retiredAttempts?.[0]?.attemptId,
      t.attempt.attemptId
    );
    assert.equal(
      await t.child.owner.evidence(
        crypto.randomUUID(),
        { kind: 'attempt', attempt: t.attempt },
        t.child.publish
      ),
      undefined
    );
    assert.equal(
      (
        await next.owner.start(
          retry,
          () =>
            next.route.messages!.send(
              'inspect it',
              undefined,
              undefined,
              undefined,
              undefined,
              retry.correlation
            ),
          next.publish,
          () => Promise.resolve(true)
        )
      ).ok,
      true
    );
    const proof = await next.owner.evidence(
      crypto.randomUUID(),
      { kind: 'attempt', attempt: retry },
      next.publish
    );
    assert.ok(proof);
    assert.equal(await t.ledger.resolve(expected(t.view()), proof), 'committed');
    assert.deepEqual(t.view().access.receiver, next.owner.receiverIdentity);
  }
);

it(
  'cancellation retains unresolved original execution after years and never permits another attempt',
  {},
  async () => {
    const t = await admitted();
    assert.equal(await t.ledger.begin(expected(t.view()), t.attempt), 'committed');
    assert.equal(await t.ledger.close(t.record.id, t.message.correlation, 'closed'), true);
    t.record.updatedAt -= 400 * 86_400_000;
    assert.equal(
      await store.writeConversation({ ...t.record, revision: (t.record.revision ?? 0) + 1 }),
      true
    );
    const [saved] = await store.readConversations();
    assert.ok(saved);
    assert.equal(saved.messages?.[0]?.access?.execution, 'unresolved');
    assert.equal(saved.messages?.[0]?.access?.attempt?.attemptId, t.attempt.attemptId);
    assert.equal(
      await t.ledger.begin(expected(t.view()), { ...t.attempt, attemptId: crypto.randomUUID() }),
      'closed'
    );
    assert.equal(t.child.owner.snapshot().remoteLaunchEvidence, undefined);
  }
);
