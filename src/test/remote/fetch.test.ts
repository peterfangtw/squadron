import { incomingPlatformFixture, resetPrivateFiles } from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, it, mock } from 'node:test';
import type { FetchFileIdentity, FetchFileReply } from '../../core/bridge/model';
import * as rig from '../incoming_fetch_helpers';
import * as children from './incoming_owner_helpers';
import { tempHome, resetDir, needsFileSymlinks } from '../helpers';

let paths: typeof import('../../core/paths');
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
  cwd = path.join(home, 'native');
  await fs.mkdir(cwd);
  const temporary = path.join(home, 'temporary');
  await fs.mkdir(temporary);
  mock.method(os, 'tmpdir', () => temporary);
});
beforeEach(async () => {
  await resetDir(paths.CONVERSATIONS_DIR);
  await resetDir(paths.LIVE_DIR);
  await resetDir(paths.REQUESTS_DIR);
  await fs.rm(paths.HEARD_FILE, { force: true });
  await resetPrivateFiles();
});
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((t) => t.close()));
});
async function make(options: Parameters<typeof rig.make>[1] = {}) {
  const t = await rig.make(cwd, options);
  rigs.push(t);
  return t;
}
function refused(reply: FetchFileReply, code: string): void {
  assert.equal(reply.kind, 'refused');
  assert.equal(reply.kind === 'refused' && reply.code, code);
  assert.equal('path' in reply, false);
}
async function admitted(options: Parameters<typeof rig.make>[1] = {}) {
  const t = await make(options);
  t.send();
  await t.drain();
  const view = await t.view();
  return { t, view, identity: t.identity(view) };
}

it(
  'recognized original image bytes keep a safe reader suffix through cache hits and expiry cleanup',
  {},
  async () => {
    const { t, identity } = await admitted();
    const png = rig.PNG_BYTES;
    t.bytes(png);
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    assert.equal(path.extname(first.path), '.png');
    assert.deepEqual(await fs.readFile(first.path), png);
    const cached = await t.fetch(identity);
    assert.ok(cached.kind === 'fetched');
    assert.equal(cached.path, first.path);
    assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
    const manifestPath = await rig.waitForFile(t, '.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.expiresAt = Date.now() - 1;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const refetched = await t.fetch(identity);
    assert.ok(refetched.kind === 'fetched');
    assert.equal(path.extname(refetched.path), '.png');
    assert.notEqual(refetched.path, first.path);
    await assert.rejects(fs.stat(first.path), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(refetched.path), png);
  }
);

for (const brand of ['claude', 'grok', 'codex'] as const)
  it(
    `${brand}: native receipt fetch writes actual bytes, reauthorizes a cache hit and refetches deleted/expired bytes; empty is valid`,
    {},
    async () => {
      const { t, identity } = await admitted({ brand });
      const first = await t.fetch(identity);
      assert.equal(first.kind, 'fetched');
      assert.ok(first.kind === 'fetched');
      assert.equal(await fs.readFile(first.path, 'utf8'), 'actual local bytes');
      assert.equal(first.localRoot, t.capability.localRoot);
      assert.ok(!path.basename(first.path).includes('untrusted'));
      assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
      const hit = await t.fetch(identity);
      assert.ok(hit.kind === 'fetched');
      assert.equal(hit.path, first.path);
      assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
      await fs.unlink(first.path);
      assert.equal((await t.fetch(identity)).kind, 'fetched');
      assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 2);
      const manifestPath = await rig.waitForFile(t, '.json');
      const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      raw.expiresAt = Date.now() - 1;
      await fs.writeFile(manifestPath, JSON.stringify(raw));
      t.bytes(Buffer.alloc(0));
      const empty = await t.fetch(identity);
      assert.ok(empty.kind === 'fetched');
      assert.equal(empty.bytes, 0);
      assert.equal((await fs.stat(empty.path)).size, 0);
      assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 3);
      await t.bridge.closeIncoming(identity.conversation, identity.correlation);
      t.calls.length = 0;
      refused(await t.fetch(identity), 'closed');
      assert.deepEqual(t.calls, []);
    }
  );

it(
  'wrong original/file, sibling, replacement, PID/start/source/cwd/host and session mismatches make zero provider calls',
  {},
  async () => {
    const { t, identity } = await admitted();
    const sibling = await t.port.start({ cwd, prompt: 'ordinary' });
    assert.ok(sibling.ok);
    const second = t.started[1];
    assert.ok(second);
    const cases: [string, FetchFileIdentity][] = [
      ['unknown-message', { ...identity, conversation: 'guess' }],
      ['unknown-message', { ...identity, correlation: 'guess' }],
      ['unknown-file', { ...identity, fileId: 'guess' }],
      [
        'wrong-receiver',
        {
          ...identity,
          receiver: second.owner.receiverIdentity,
          currentSessionId: second.handle.state.sessionId!
        }
      ],
      [
        'wrong-receiver',
        { ...identity, receiver: { ...identity.receiver, pid: identity.receiver.pid + 1 } }
      ],
      [
        'wrong-receiver',
        {
          ...identity,
          receiver: { ...identity.receiver, osStartedAt: identity.receiver.osStartedAt + 1 }
        }
      ],
      [
        'unsupported-version',
        {
          ...identity,
          receiver: { ...identity.receiver, startSource: 'unknown' as 'ps-lstart-v1' }
        }
      ],
      [
        'wrong-receiver',
        { ...identity, receiver: { ...identity.receiver, incarnation: crypto.randomUUID() } }
      ],
      [
        'wrong-receiver',
        { ...identity, receiver: { ...identity.receiver, cwd: path.dirname(cwd) } }
      ],
      [
        'wrong-receiver',
        {
          ...identity,
          receiver: {
            ...identity.receiver,
            host: { ...identity.receiver.host, incarnation: crypto.randomUUID() }
          }
        }
      ],
      ['wrong-receiver', { ...identity, currentSessionId: 'guessed-id' }],
      ['remote-off', { ...identity, holder: { ...identity.holder, generation: 99 } }]
    ];
    for (const [code, request] of cases) {
      refused(await t.fetch(request), code);
      assert.deepEqual(t.calls, [], code);
    }
    t.messenger.incomingFiles = undefined;
    refused(await t.fetch(identity), 'unsupported-capability');
    assert.deepEqual(t.calls, []);
  }
);

for (const policy of ['sender', 'install', 'source'] as const)
  it(`${policy} mismatch cannot return previously cached bytes or call provider`, {}, async () => {
    const { t, identity } = await admitted();
    assert.equal((await t.fetch(identity)).kind, 'fetched');
    t.calls.length = 0;
    if (policy === 'sender')
      await t.bridge.observeIncomingPolicy(
        { messengerId: 'fake', installId: 'install', allowedIds: [] },
        t.holder
      );
    if (policy === 'install') t.messenger.incomingFiles = { ...t.provider, installId: 'other' };
    if (policy === 'source') {
      const original = t.send();
      assert.ok(original.incoming && !('denied' in original.incoming));
      t.deliver({
        ...original,
        incoming: {
          ...original.incoming,
          files: [{ ...original.incoming.files[0]!, source: 'changed' }]
        }
      });
      await t.drain();
    }
    refused(await t.fetch(identity), policy === 'install' ? 'wrong-install' : 'admission-denied');
    assert.deepEqual(t.calls, []);
  });

it(
  '/clear changes consistency ID while preserving only the actual native receiver',
  {},
  async () => {
    const { t, identity } = await admitted();
    const child = t.started[0]!;
    assert.equal((await child.route.messages!.send('conversation-reset-probe')).ok, true);
    await children.until(
      child.handle,
      (handle) => handle.state.sessionId !== identity.currentSessionId
    );
    refused(await t.fetch(identity), 'wrong-receiver');
    assert.deepEqual(t.calls, []);
    assert.equal(
      (await t.fetch({ ...identity, currentSessionId: child.handle.state.sessionId! })).kind,
      'fetched'
    );
  }
);

it(
  'stable dismissal closes cached access when recent facts no longer hold the original',
  {},
  async () => {
    const t = await make();
    const child = t.started[0]!;
    await child.route.messages!.send('slow down');
    await children.until(child.handle, (handle) => handle.state.running);
    t.send();
    await t.drain();
    const view = await t.view();
    const identity = t.identity(view);
    assert.equal((await t.fetch(identity)).kind, 'fetched');
    const queued = child.handle.state.queued.find((row) => row.correlation === view.correlation);
    assert.ok(queued);
    assert.equal(child.handle.messages!.dismiss(queued.id), true);
    // Recent facts are not the permission owner. The native registry retains the dismissal receipt.
    child.handle.state.messageFacts = [];
    t.calls.length = 0;
    refused(await t.fetch(identity), 'closed');
    assert.deepEqual(t.calls, []);
  }
);

it(
  'tampered bytes and a symlinked cache entry refuse while neighboring files survive',
  { skip: needsFileSymlinks() },
  async () => {
    const { t, identity } = await admitted();
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    const neighbor = path.join(t.capability.localRoot, 'unrelated.txt');
    await fs.writeFile(neighbor, 'keep');
    await fs.writeFile(first.path, 'tampered', { mode: 0o600 });
    refused(await t.fetch(identity), 'invalid-path');
    await fs.unlink(first.path);
    await fs.symlink(neighbor, first.path);
    refused(await t.fetch(identity), 'invalid-path');
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'keep');
    assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
  }
);

it(
  'overflow and provider failure clean partials and sanitize errors; a later valid fetch succeeds',
  {},
  async () => {
    const { t, identity } = await admitted();
    t.provider.download = () =>
      Promise.resolve(
        (async function* () {
          yield await Promise.resolve(Buffer.alloc(10 * 1024 * 1024));
          yield Buffer.from('excess');
        })()
      );
    refused(await t.fetch(identity), 'too-large');
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    t.provider.download = () => Promise.reject(new Error('https://private.example/token-secret'));
    t.provider.refusal = () => 'provider-https://private.example/token-secret';
    const failed = await t.fetch(identity);
    refused(failed, 'storage-unavailable');
    assert.equal(JSON.stringify(failed).includes('token-secret'), false);
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    t.provider.download = () =>
      Promise.resolve(
        (async function* () {
          yield await Promise.resolve(Buffer.from('recovered'));
        })()
      );
    assert.equal((await t.fetch(identity)).kind, 'fetched');
  }
);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const cause of ['close', 'dispose', 'abort', 'generation', 'install', 'owner-exit'] as const)
  it(
    `${cause} during a stalled stream exposes no path, cleans partials and rejects late bytes`,
    {},
    async () => {
      const { t, identity } = await admitted();
      const entered = deferred<void>(),
        release = deferred<void>();
      t.provider.download = () =>
        Promise.resolve(
          (async function* () {
            yield Buffer.from('first');
            entered.resolve();
            await release.promise;
            yield Buffer.from('late');
          })()
        );
      const abort = new AbortController();
      const fetching = t.fetch(identity, abort.signal);
      await entered.promise;
      await rig.waitForFile(t, '.partial');
      if (cause === 'close')
        await t.bridge.closeIncoming(identity.conversation, identity.correlation);
      if (cause === 'dispose') t.files.dispose();
      if (cause === 'abort') abort.abort();
      if (cause === 'generation')
        await t.bridge.observeIncomingPolicy(
          { messengerId: 'fake', installId: 'install', allowedIds: ['owner'] },
          { ...t.holder, generation: 2 }
        );
      if (cause === 'install') {
        t.messenger.incomingFiles = { ...t.provider, installId: 'other' };
        await t.bridge.observeIncomingPolicy(
          { messengerId: 'fake', installId: 'other', allowedIds: ['owner'] },
          t.holder
        );
      }
      if (cause === 'owner-exit') {
        t.started[0]!.remove();
        release.resolve();
      }
      let reply: FetchFileReply;
      try {
        reply = await fetching;
      } finally {
        release.resolve();
      }
      if (cause === 'owner-exit') {
        refused(reply, 'evidence-unavailable');
        assert.equal((await t.view()).access.state, 'active');
      } else
        refused(
          reply,
          cause === 'dispose' || cause === 'generation'
            ? 'remote-off'
            : cause === 'install'
              ? 'wrong-install'
              : 'closed'
        );
      assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
      assert.equal(t.changed.size, 0);
    }
  );

it(
  'missing evidence has a bounded pending result, counts duplicates and releases every waiter on timeout',
  {},
  async (context) => {
    const { t, identity } = await admitted();
    t.queries(false);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = Array.from({ length: 10 }, () => t.fetch(identity));
    refused(await t.fetch(identity), 'capacity');
    assert.equal(t.changed.size, 10);
    assert.deepEqual(t.calls, []);
    context.mock.timers.tick(45_000);
    const results = await Promise.all(pending);
    assert.ok(results.every((reply) => reply.kind === 'pending' && reply.retryable));
    assert.equal(t.changed.size, 0);
    assert.deepEqual(t.calls, []);
    context.mock.timers.reset();
    t.queries(true);
    assert.equal((await t.fetch(identity)).kind, 'fetched');
  }
);

it(
  'metadata stall and capacity use the remaining startup budget; timeout cannot publish late completion',
  {},
  async (context) => {
    const { t, identity } = await admitted();
    const entered = deferred<void>(),
      release = deferred<{ size: number }>();
    t.provider.metadata = async () => {
      entered.resolve();
      return release.promise;
    };
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fetching = t.fetch(identity);
    await entered.promise;
    context.mock.timers.tick(45_000);
    refused(await fetching, 'timeout');
    release.resolve({ size: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    assert.equal(t.changed.size, 0);
    context.mock.timers.reset();
  }
);

it(
  'concurrent downloads cap at two for a receiver; capacity wake rechecks admission and shares evidence',
  {},
  async () => {
    const { t, identity } = await admitted();
    const entered = deferred<void>(),
      release = deferred<void>();
    let downloads = 0,
      queries = 0;
    const evidence = t.verbs.incomingEvidence!.bind(t.verbs);
    t.verbs.incomingEvidence = async (...args) => {
      queries++;
      return evidence(...args);
    };
    t.provider.download = () => {
      downloads++;
      if (downloads === 2) entered.resolve();
      return Promise.resolve(
        (async function* () {
          await release.promise;
          yield Buffer.from('done');
        })()
      );
    };
    const pending = Array.from({ length: 3 }, () => t.fetch(identity));
    await entered.promise;
    assert.equal(downloads, 2);
    await t.bridge.closeIncoming(identity.conversation, identity.correlation);
    release.resolve();
    const results = await Promise.all(pending);
    assert.ok(results.every((reply) => reply.kind === 'refused' && reply.code === 'closed'));
    assert.equal(downloads, 2);
    assert.ok(queries < 9, `${queries} owner queries`);
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    assert.equal(t.changed.size, 0);
  }
);

it(
  'a source verification refusal makes no metadata/download call and cannot use cached content',
  {},
  async () => {
    const { t, identity } = await admitted();
    assert.equal((await t.fetch(identity)).kind, 'fetched');
    t.calls.length = 0;
    t.provider.verify = () => Promise.resolve(false);
    refused(await t.fetch(identity), 'wrong-install');
    assert.deepEqual(t.calls, []);
  }
);

it(
  'cache tampering during fresh owner evidence is rechecked before the path reply',
  {},
  async () => {
    const { t, identity } = await admitted();
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    const evidence = t.verbs.incomingEvidence!.bind(t.verbs);
    let queries = 0;
    t.verbs.incomingEvidence = async (...args) => {
      const proof = await evidence(...args);
      if (++queries === 2) await fs.writeFile(first.path, 'changed');
      return proof;
    };
    refused(await t.fetch(identity), 'invalid-path');
    assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
  }
);

it(
  'startup consumes thirty seconds of the one forty-five second budget before stalled metadata',
  {},
  async (context) => {
    const { t, identity } = await admitted();
    t.queries(false);
    const queried = deferred<void>(),
      metadata = deferred<void>(),
      release = deferred<Record<string, never>>();
    const evidence = t.verbs.incomingEvidence!.bind(t.verbs);
    t.verbs.incomingEvidence = async (...args) => {
      const proof = await evidence(...args);
      queried.resolve();
      return proof;
    };
    t.provider.metadata = async () => {
      metadata.resolve();
      return release.promise;
    };
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fetching = t.fetch(identity);
    await queried.promise;
    context.mock.timers.tick(30_000);
    t.queries(true);
    t.wake();
    await metadata.promise;
    context.mock.timers.tick(15_000);
    refused(await fetching, 'timeout');
    release.resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.changed.size, 0);
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    context.mock.timers.reset();
  }
);

it(
  'an evidence wake arriving before the wait is installed is retained and does not busy poll',
  {},
  async () => {
    const { t, identity } = await admitted();
    const evidence = t.verbs.incomingEvidence!.bind(t.verbs);
    let queries = 0;
    t.verbs.incomingEvidence = async (...args) => {
      if (++queries === 1) {
        t.wake();
        return undefined;
      }
      return evidence(...args);
    };
    assert.equal((await t.fetch(identity)).kind, 'fetched');
    assert.ok(queries <= 5, `${queries} queries`);
    assert.equal(t.started.length, 1);
    assert.equal(t.changed.size, 0);
  }
);

it(
  'forty holder waiters across five native receivers deny the forty-first before allocating another subscription',
  {},
  async () => {
    const { t, identity } = await admitted();
    const identities = [identity];
    for (let n = 1; n < 5; n++) {
      t.send(n, 'inspect it', []);
      await t.drain();
      await t.press('Use window default');
      const view = await t.view(`original-${n}`);
      identities.push(t.identity(view, t.started[n]));
    }
    t.queries(false);
    const pending = identities.flatMap((one) => Array.from({ length: 8 }, () => t.fetch(one)));
    assert.equal(t.changed.size, 40);
    refused(await t.fetch(identity), 'capacity');
    assert.equal(t.changed.size, 40);
    t.files.dispose();
    const replies = await Promise.all(pending);
    assert.ok(replies.every((reply) => reply.kind === 'refused' && reply.code === 'remote-off'));
    assert.deepEqual(t.calls, []);
    assert.equal(t.changed.size, 0);
  }
);

it(
  'admitted oversized metadata refuses before any provider call; a sibling file failure preserves successful bytes',
  {},
  async () => {
    const { t, identity } = await admitted();
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    t.deliver({
      kind: 'message',
      id: 'large',
      ref: 'ref-large',
      refs: ['thread'],
      sender: { id: 'owner' },
      addressed: 'direct',
      text: 'inspect it',
      at: Date.now(),
      incoming: {
        version: 1,
        installId: 'install',
        omitted: 0,
        files: [
          {
            id: 'file-large',
            source: 'opaque:install:large',
            cacheKey: 'fake_large',
            size: 10 * 1024 * 1024 + 1
          }
        ]
      }
    });
    await t.drain();
    t.calls.length = 0;
    refused(await t.fetch(t.identity(await t.view('large'))), 'too-large');
    assert.deepEqual(t.calls, []);
    t.send(1);
    await t.drain();
    t.provider.download = () => Promise.reject(new Error('private provider failure'));
    refused(await t.fetch(t.identity(await t.view('original-1'))), 'provider-unavailable');
    assert.equal(await fs.readFile(first.path, 'utf8'), 'actual local bytes');
    const hit = await t.fetch(identity);
    assert.ok(hit.kind === 'fetched');
    assert.equal(hit.path, first.path);
  }
);

it(
  'Stop and ordinary completion preserve access to the same native receiving process',
  {},
  async () => {
    const t = await make();
    t.send(0, 'slow down');
    await t.drain();
    const child = t.started[0]!;
    await children.until(child.handle, (handle) => handle.state.running);
    const identity = t.identity(await t.view());
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    assert.equal((await child.route.turn!.interrupt()).ok, true);
    await children.until(child.handle, (handle) => !handle.state.running);
    const hit = await t.fetch(identity);
    assert.ok(hit.kind === 'fetched');
    assert.equal(hit.path, first.path);
    assert.equal((await t.view()).access.state, 'active');
    assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
  }
);

it(
  'a successful cache hit renews twenty-four hours from that fetch without touching the conversation',
  {},
  async (context) => {
    const { t, identity } = await admitted();
    const first = await t.fetch(identity);
    assert.ok(first.kind === 'fetched');
    let now = first.expiresAt - 60 * 60 * 1000;
    context.mock.method(Date, 'now', () => now);
    const conversation = path.join(paths.CONVERSATIONS_DIR, `${identity.conversation}.json`);
    const before = await fs.stat(conversation);
    const hit = await t.fetch(identity);
    assert.ok(hit.kind === 'fetched');
    assert.equal(hit.path, first.path);
    assert.equal(hit.expiresAt, now + 24 * 60 * 60 * 1000);
    const manifest = JSON.parse(await fs.readFile(hit.path.replace(/\.bytes$/, '.json'), 'utf8'));
    assert.equal(manifest.expiresAt, hit.expiresAt);
    assert.equal((await fs.stat(conversation)).mtimeMs, before.mtimeMs);
    now = first.expiresAt + 1;
    const later = await t.fetch(identity);
    assert.ok(later.kind === 'fetched');
    assert.equal(later.path, first.path);
    assert.equal(later.expiresAt, now + 24 * 60 * 60 * 1000);
    assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
  }
);

it(
  'a merged native turn fetches each constituent original independently and cannot borrow its sibling’s file',
  {},
  async () => {
    const t = await make();
    const child = t.started[0]!;
    await child.route.messages!.send('slow');
    await children.until(child.handle, (handle) => handle.state.running);
    t.send(1, 'inspect first');
    await t.drain();
    t.send(2, 'inspect second');
    await t.drain();
    const first = t.identity(await t.view('original-1'));
    const second = t.identity(await t.view('original-2'));
    assert.deepEqual(
      new Set(child.handle.state.queued.map((row) => row.correlation)),
      new Set([first.correlation, second.correlation])
    );
    await child.handle.messages!.sendNow();
    await children.until(
      child.handle,
      (handle) => !handle.state.running && handle.state.queued.length === 0
    );
    assert.deepEqual(
      new Set(child.handle.state.messageTurn),
      new Set([first.correlation, second.correlation])
    );
    const a = await t.fetch(first);
    const b = await t.fetch(second);
    assert.ok(a.kind === 'fetched' && b.kind === 'fetched');
    assert.notEqual(a.path, b.path);
    assert.equal(await fs.readFile(a.path, 'utf8'), 'actual local bytes');
    assert.equal(await fs.readFile(b.path, 'utf8'), 'actual local bytes');
    t.calls.length = 0;
    refused(await t.fetch({ ...first, fileId: second.fileId }), 'unknown-file');
    assert.deepEqual(t.calls, []);
  }
);
