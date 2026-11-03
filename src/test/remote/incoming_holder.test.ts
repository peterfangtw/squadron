import {
  incomingPlatformFixture,
  resetPrivateFiles,
  INCOMING_TEST_MS
} from './incoming_platform_helpers';
import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import type { Budget } from '../../core/platform/files';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, beforeEach, it, mock } from 'node:test';
import type { FetchFileIdentity } from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import * as incomingCache from '../../core/remote/incoming_cache';
import { Facility, NativeFailure } from '../../core/platform/private_files/facility';
import * as rig from './incoming_bridge_helpers';
import { tempHome, resetDir } from '../helpers';

let paths: typeof import('../../core/paths');
let store: typeof import('../../core/bridge/store');
let requests: typeof import('../../core/coordination/requests');
let serve: typeof import('../../core/remote/serve_fetch');
let scan: typeof import('../../core/scan');
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
  requests = await import('../../core/coordination/requests');
  serve = await import('../../core/remote/serve_fetch');
  scan = await import('../../core/scan');
  cwd = path.join(home, 'native');
  await fs.mkdir(cwd);
  const temporary = path.join(home, 'temporary');
  await fs.mkdir(temporary);
  mock.method(os, 'tmpdir', () => temporary);
});
beforeEach(async () => {
  await resetDir(paths.REMOTE_DIR);
  await resetDir(paths.LIVE_DIR);
  await resetDir(paths.REQUESTS_DIR);
  await resetPrivateFiles();
});
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((t) => t.close()));
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(want: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await want()) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  assert.ok(await want());
}
async function make() {
  const calls: string[] = [];
  const provider: NonNullable<Messenger['incomingFiles']> = {
    version: 1,
    installId: 'install',
    refusal: () => 'provider-unavailable',
    verify: () => Promise.resolve(true),
    metadata: () => {
      calls.push('metadata');
      return Promise.resolve({ name: 'file.txt', size: 5 });
    },
    download: () => {
      calls.push('download');
      return Promise.resolve(
        (async function* () {
          yield await Promise.resolve(Buffer.from('bytes'));
        })()
      );
    }
  };
  const t = await rig.make(cwd, { switch: true, incomingFiles: provider });
  rigs.push(t);
  t.send();
  await t.drain();
  const [record] = await store.readConversations();
  const message = record?.messages?.[0];
  const child = t.started[0];
  assert.ok(record && message && child && message.incoming && !('denied' in message.incoming));
  const identity: FetchFileIdentity = {
    holder: t.holder,
    receiver: child.owner.receiverIdentity,
    currentSessionId: child.handle.state.sessionId!,
    conversation: record.id,
    correlation: message.correlation,
    fileId: message.incoming.files[0]!.id
  };
  const fetch = (who = identity) =>
    t.remote.fetch({ requestId: crypto.randomUUID(), identity: who });
  return { t, provider, calls, identity, fetch };
}

it(
  'holder dispatch remains independent of metadata and allows a later request scan and reaction work',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    let scans = 0;
    const nativeScan = scan.scanProcesses.bind(scan);
    context.mock.method(scan, 'scanProcesses', (...args: Parameters<typeof nativeScan>) => {
      scans++;
      return nativeScan(...args);
    });
    const { t, provider, identity, calls } = await make();
    const controls: { kind: string; ms: number }[] = [];
    const entered = deferred<void>();
    const held = deferred<{ size: number }>();
    provider.metadata = () => {
      entered.resolve();
      return held.promise;
    };
    const file = await requests.postRequest({
      kind: 'fetchFile',
      version: 1,
      windowId: t.holder.host.windowId,
      ...identity
    });
    assert.ok(file);
    const firstScan = requests.claimRequests(t.holder.host.windowId, (request) =>
      request.kind === 'fetchFile' ? serve.serveFetchFile(request, t.remote) : { ok: false }
    );
    await entered.promise;
    const native = await import('../../core/coordination/serve_owned');
    const child = t.started[0]!;
    const ownerHelpers = await import('./incoming_owner_helpers');
    await child.route.messages!.send('slow');
    await ownerHelpers.until(child.handle, (handle) => handle.state.running);
    const drive = async (body: import('../../core/coordination/requests').RequestBody) => {
      const at = performance.now();
      const control = await requests.postRequest(body);
      assert.ok(control);
      await requests.claimRequests(
        t.holder.host.windowId,
        (request) => native.serveOwned(request, t.port) ?? { ok: false }
      );
      assert.equal((await requests.awaitReply(control, 1000))?.ok, true);
      controls.push({ kind: body.kind, ms: performance.now() - at });
    };
    await drive({
      kind: 'interrupt',
      windowId: t.holder.host.windowId,
      remote: t.holder.host.windowId,
      pid: child.pid,
      startedAt: child.startedAt
    });
    await ownerHelpers.until(child.handle, (handle) => !handle.state.running);
    await child.route.messages!.send('write');
    await ownerHelpers.until(child.handle, (handle) => handle.state.pending.length > 0);
    await drive({
      kind: 'deny',
      windowId: t.holder.host.windowId,
      remote: t.holder.host.windowId,
      pid: child.pid,
      startedAt: child.startedAt,
      requestId: child.handle.state.pending[0]!.requestId
    });
    await ownerHelpers.until(child.handle, (handle) => !handle.state.running);
    const closeAt = performance.now();
    const control = await requests.postRequest({
      kind: 'close',
      windowId: t.holder.host.windowId,
      pid: child.pid,
      startedAt: child.startedAt
    });
    assert.ok(control);
    let ended = false;
    await requests.claimRequests(
      t.holder.host.windowId,
      (request) =>
        native.serveOwned(request, {
          ...t.port,
          end: () => {
            ended = true;
            return true;
          }
        }) ?? { ok: false }
    );
    controls.push({ kind: 'close', ms: performance.now() - closeAt });
    assert.equal(ended, true);
    assert.equal((await requests.awaitReply(control, 1000))?.ok, true);
    t.messenger.link({ kind: 'connected' });
    await t.remote.tick();
    assert.ok(t.messenger.reactionEffects().length > 0);
    const offAt = performance.now();
    const stopping = t.remote.turnOff();
    assert.equal(t.remote.incomingHolder(), undefined);
    await stopping;
    controls.push({ kind: 'off', ms: performance.now() - offAt });
    await firstScan;
    const reply = await requests.awaitReply(file, 1000);
    assert.equal(reply?.fetchFile?.kind, 'refused');
    assert.equal(reply?.fetchFile?.kind === 'refused' && reply.fetchFile.code, 'remote-off');
    held.resolve({ size: 5 });
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(
      calls.filter((call) => call === 'download'),
      []
    );
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
    context.diagnostic(
      JSON.stringify({
        flow: 'one native receiver, withheld metadata, independent request files',
        scans,
        controls
      })
    );
  }
);

it(
  'off drains active partials without waiting for an abort-ignoring stream; rebuild preserves completed byte expiry and closes withdrawn access',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, provider, identity, fetch } = await make();
    const first = await fetch();
    assert.ok(first.kind === 'fetched');
    const held = deferred<IteratorResult<Uint8Array>>();
    const entered = deferred<void>();
    await fs.unlink(first.path);
    provider.download = () =>
      Promise.resolve({
        [Symbol.asyncIterator]() {
          return {
            next() {
              entered.resolve();
              return held.promise;
            },
            return: () => new Promise(() => {})
          };
        }
      });
    const pending = fetch();
    await entered.promise;
    await t.remote.turnOff();
    assert.equal((await pending).kind, 'refused');
    assert.ok(
      !(await fs.readdir(t.capability.localRoot)).some((name) =>
        /\.(partial|reserve|manifest)$/.test(name)
      )
    );
    held.resolve({ done: false, value: Buffer.from('late bytes') });
    provider.download = () =>
      Promise.resolve(
        (async function* () {
          yield await Promise.resolve(Buffer.from('bytes'));
        })()
      );
    assert.equal((await t.remote.turnOn()).ok, true);
    const renewedIdentity = { ...identity, holder: t.holder };
    const recovered = await fetch(renewedIdentity);
    assert.ok(recovered.kind === 'fetched');
    const manifest = recovered.path.replace(/\.bytes$/, '.json');
    const before = JSON.parse(await fs.readFile(manifest, 'utf8')).expiresAt;
    await t.remote.settingsChanged();
    assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).expiresAt, before);
    assert.equal((await fetch(renewedIdentity)).kind, 'refused');
    assert.equal((await fetch({ ...identity, holder: t.holder })).kind, 'fetched');
    await t.policy([]);
    await t.policy(['owner']);
    assert.equal((await t.remote.turnOn()).ok, true);
    assert.equal((await fetch({ ...identity, holder: t.holder })).kind, 'refused');
    assert.equal((await store.readConversations())[0]?.messages?.[0]?.access?.state, 'closed');
  }
);

it(
  'ten pending requests wake on evidence without routing; the eleventh is refused and Off drains all ten',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t, provider, identity, fetch } = await make();
    const actual = t.port.evidence!.bind(t.port);
    t.port.evidence = () => Promise.resolve(undefined);
    const awake = deferred<void>();
    let verified = 0;
    provider.verify = () => {
      if (++verified === 10) awake.resolve();
      return new Promise(() => {});
    };
    const at = performance.now();
    const pending = Array.from({ length: 10 }, () => fetch());
    const extra = await fetch();
    assert.equal(extra.kind === 'refused' && extra.code, 'capacity');
    t.port.evidence = actual;
    t.remote.noticeChange();
    try {
      await Promise.race([
        awake.promise,
        Promise.all(pending).then((replies) => {
          throw new Error(
            `evidence wake failed: ${JSON.stringify(replies.map((reply) => (reply.kind === 'refused' ? { kind: reply.kind, code: reply.code } : { kind: reply.kind })))}`
          );
        })
      ]);
      assert.equal(verified, 10);
    } finally {
      const offAt = performance.now();
      await t.remote.turnOff();
      const replies = await Promise.all(pending);
      context.diagnostic(
        JSON.stringify({
          stage: 'evidence-wake-and-off-drain',
          ms: performance.now() - at,
          drainMs: performance.now() - offAt,
          verified,
          replies: replies.map((reply) =>
            reply.kind === 'refused' ? { kind: reply.kind, code: reply.code } : { kind: reply.kind }
          )
        })
      );
      assert.ok(replies.every((reply) => reply.kind === 'refused' && reply.code === 'remote-off'));
    }
    const off = await fetch(identity);
    assert.equal(off.kind === 'refused' && off.code, 'remote-off');
  }
);

it(
  'two concurrent native fetches retain final authorization and record materialization and physical drain separately',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t, fetch } = await make();
    const stages: { stage: string; ms: number; kind: string; reason?: string }[] = [];
    const observe = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
      const at = performance.now();
      try {
        const value = await run();
        stages.push({ stage, ms: performance.now() - at, kind: 'ok' });
        return value;
      } catch (error) {
        stages.push({
          stage,
          ms: performance.now() - at,
          kind:
            error instanceof NativeFailure
              ? error.kind
              : error instanceof incomingCache.CacheRefusal
                ? 'cache-refusal'
                : 'failed',
          reason:
            error instanceof NativeFailure
              ? error.reason
              : error instanceof incomingCache.CacheRefusal
                ? error.code
                : undefined
        });
        throw error;
      }
    };
    /* eslint-disable @typescript-eslint/unbound-method -- Wrappers below restore each original receiver with apply. */
    const start = Facility.prototype.start;
    context.mock.method(
      Facility.prototype,
      'start',
      function (this: Facility, ...args: Parameters<typeof start>) {
        return observe('helper-admission-start', () => start.apply(this, args));
      }
    );
    const find = incomingCache.IncomingCache.prototype.find;
    context.mock.method(
      incomingCache.IncomingCache.prototype,
      'find',
      function (this: incomingCache.IncomingCache, ...args: Parameters<typeof find>) {
        return observe('cache-queue-find', () => find.apply(this, args));
      }
    );
    const reserve = incomingCache.IncomingCache.prototype.reserve;
    context.mock.method(
      incomingCache.IncomingCache.prototype,
      'reserve',
      function (this: incomingCache.IncomingCache, ...args: Parameters<typeof reserve>) {
        return observe('cache-queue-reserve', () => reserve.apply(this, args));
      }
    );
    const release = incomingCache.IncomingCache.prototype.release;
    context.mock.method(
      incomingCache.IncomingCache.prototype,
      'release',
      function (this: incomingCache.IncomingCache, ...args: Parameters<typeof release>) {
        return observe('physical-release', () => release.apply(this, args));
      }
    );
    const evidence = t.port.evidence!.bind(t.port);
    t.port.evidence = (...args) => observe('evidence', () => evidence(...args));
    const materialize = incomingCache.IncomingCache.prototype.materialize;
    context.mock.method(
      incomingCache.IncomingCache.prototype,
      'materialize',
      function (this: incomingCache.IncomingCache, ...args: Parameters<typeof materialize>) {
        return observe('download-materialization', () => materialize.apply(this, args));
      }
    );
    const validate = incomingCache.IncomingCache.prototype.validate;
    context.mock.method(
      incomingCache.IncomingCache.prototype,
      'validate',
      function (this: incomingCache.IncomingCache, ...args: Parameters<typeof validate>) {
        return observe('final-byte-validation', () => validate.apply(this, args));
      }
    );
    /* eslint-enable @typescript-eslint/unbound-method */
    try {
      const replies = await Promise.all(
        Array.from({ length: 2 }, () => observe('fetch-return', fetch))
      );
      context.diagnostic(
        JSON.stringify({
          stage: 'native-replies',
          replies: replies.map((reply) =>
            reply.kind === 'refused' ? { kind: reply.kind, code: reply.code } : { kind: reply.kind }
          )
        })
      );
      assert.ok(replies.every((reply) => reply.kind === 'fetched'));
    } finally {
      await observe('off-drain', () => t.remote.turnOff());
      context.diagnostic(JSON.stringify({ stages, parentUsage: process.resourceUsage() }));
    }
  }
);

it(
  '400-day live receipts survive a concurrent non-holder sweep/write; unavailable scans never establish death, exact native death closes loaded and persisted access',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, identity, fetch } = await make();
    const publication = path.join(paths.LIVE_DIR, `${identity.receiver.pid}.json`);
    await t.started[0]!.publish();
    const conversation = path.join(paths.CONVERSATIONS_DIR, `${identity.conversation}.json`);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60_000);
    await fs.utimes(conversation, old, old);
    await fs.utimes(publication, old, old);
    t.advance(400 * 24 * 60 * 60_000);
    const prune = await import('../../core/prune');
    await Promise.all([prune.pruneStatus(), fetch(), t.remote.housekeep()]);
    assert.equal((await fetch()).kind, 'fetched');
    assert.ok(await fs.stat(publication));
    const current = await scan.scanProcesses(true);
    t.scan({ ...current, complete: false, starts: new Map() });
    await t.remote.housekeep();
    assert.equal((await store.readConversations())[0]?.messages?.[0]?.access?.state, 'active');
    t.scan(undefined);
    await t.started[0]!.close();
    await t.remote.housekeep();
    assert.equal((await store.readConversations())[0]?.messages?.[0]?.access?.state, 'closed');
    assert.equal((await fetch()).kind, 'refused');
    await t.remote.settingsChanged();
    assert.equal((await fetch({ ...identity, holder: t.holder })).kind, 'refused');
  }
);

it(
  'holder crash sweep removes only managed abandoned/expired files, preserves active partials and neighbors, and permits authorized refetch',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, provider, fetch } = await make();
    const first = await fetch();
    assert.ok(first.kind === 'fetched');
    const manifest = first.path.replace(/\.bytes$/, '.json');
    const raw = JSON.parse(await fs.readFile(manifest, 'utf8'));
    raw.expiresAt = Date.now() - 1;
    await fs.writeFile(manifest, JSON.stringify(raw));
    const base = path.basename(first.path, '.bytes').replace(/[0-9a-f-]{36}$/, crypto.randomUUID());
    const abandoned = path.join(t.capability.localRoot, `${base}.partial`);
    await fs.writeFile(abandoned, 'abandoned', { mode: 0o600 });
    const neighbor = path.join(t.capability.localRoot, 'neighbor.txt');
    await fs.writeFile(neighbor, 'keep');
    await t.remote.housekeep();
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'keep');
    assert.equal(await fs.stat(abandoned).catch(() => undefined), undefined);
    const held = deferred<void>();
    const entered = deferred<void>();
    provider.download = () =>
      Promise.resolve(
        (async function* () {
          yield await Promise.resolve(Buffer.from('pending'));
          entered.resolve();
          await held.promise;
        })()
      );
    const pending = fetch();
    await entered.promise;
    await t.remote.housekeep();
    assert.ok((await fs.readdir(t.capability.localRoot)).some((name) => name.endsWith('.partial')));
    held.resolve();
    const recovered = await pending;
    assert.ok(recovered.kind === 'fetched');
    assert.equal(recovered.bytes, 7);
    assert.equal(await fs.readFile(recovered.path, 'utf8'), 'pending');
  }
);

it(
  'loss of the holder during final evidence denies and discards newly published bytes; live takeover is refused until teardown',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, identity, fetch } = await make();
    const holders = await import('../../core/remote/holder');
    const actual = t.port.evidence!.bind(t.port);
    let proofs = 0;
    t.port.evidence = async (challenge, query) => {
      const proof = await actual(challenge, query);
      if (++proofs === 3)
        await fs.writeFile(
          paths.HOLDER_FILE,
          JSON.stringify({
            windowId: 'replacement',
            label: 'new',
            pid: process.pid,
            startedAt: identity.holder.host.osStartedAt,
            since: Date.now(),
            incoming: {
              ...identity.holder,
              host: {
                ...identity.holder.host,
                windowId: 'replacement',
                incarnation: crypto.randomUUID()
              }
            }
          })
        );
      return proof;
    };
    const reply = await fetch();
    assert.equal(reply.kind, 'refused');
    await eventually(
      async () =>
        !(await fs.readdir(t.capability.localRoot)).some((name) => name.endsWith('.bytes'))
    );
    await t.remote.turnOff();
    assert.equal((await holders.namedHolder())?.windowId, 'replacement');
  }
);

it(
  'the actual holder enforces two downloads per receiver and four across native receivers, including duplicate fetches',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, provider, identity } = await make();
    await t.remote.turnOff();
    const seed = (await store.readConversations())[0]!;
    for (let n = 1; n < 3; n++) {
      const result = await t.port.start({ cwd });
      assert.ok(result.ok);
      const child = t.started[n]!;
      const record = {
        ...structuredClone(seed),
        schema: 1 as const,
        revision: undefined,
        id: `thread${n}x`,
        anchor: `thread-${n}`,
        latest: `thread-${n}`,
        refs: [`thread-${n}`],
        messages: [],
        root: {
          ...seed.root!,
          pid: child.pid,
          startedAt: child.startedAt,
          sessionId: child.handle.state.sessionId!
        }
      };
      assert.equal(await store.writeConversation(record), true);
    }
    await t.observe();
    assert.equal((await t.remote.turnOn()).ok, true);
    const identities = [{ ...identity, holder: t.holder }];
    for (let n = 1; n < 3; n++) {
      t.send(n, 'inspect it', [`thread-${n}`]);
      await t.drain();
      const record = (await store.readConversations()).find(
        (record) => record.anchor === `thread-${n}`
      )!;
      const message = record.messages![0]!;
      identities.push({
        ...identity,
        holder: t.holder,
        receiver: t.started[n]!.owner.receiverIdentity,
        currentSessionId: t.started[n]!.handle.state.sessionId!,
        conversation: record.id,
        correlation: message.correlation,
        fileId: `file-${n}`
      });
    }
    const held = deferred<IteratorResult<Uint8Array>>();
    const filled = deferred<void>();
    const downloads: string[] = [];
    provider.download = (file) => {
      downloads.push(file.id);
      if (downloads.length === 4) filled.resolve();
      return Promise.resolve({
        [Symbol.asyncIterator]() {
          return { next: () => held.promise };
        }
      });
    };
    const pending = identities.flatMap((who) =>
      Array.from({ length: 3 }, () =>
        t.remote.fetch({ requestId: crypto.randomUUID(), identity: who })
      )
    );
    await Promise.race([
      filled.promise,
      Promise.all(pending).then((replies) => {
        throw new Error(`downloads ended before filling their quota: ${JSON.stringify(replies)}`);
      })
    ]);
    await t.remote.housekeep();
    assert.equal(downloads.length, 4);
    assert.ok(identities.every((who) => downloads.filter((id) => id === who.fileId).length <= 2));
    assert.equal(
      (await fs.readdir(t.capability.localRoot)).filter((name) => name.endsWith('.reserve')).length,
      4
    );
    await t.remote.turnOff();
    assert.ok((await Promise.all(pending)).every((reply) => reply.kind === 'refused'));
    held.resolve({ done: true, value: undefined });
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
  }
);

it(
  'receiver and machine byte budgets charge old sparse files through the holder until safe crash cleanup enables refetch',
  { timeout: INCOMING_TEST_MS },
  async () => {
    const { t, identity, calls, fetch } = await make();
    const own = crypto.createHash('sha256').update(JSON.stringify(identity.receiver)).digest('hex');
    for (const [receiver, bytes] of [
      [own, 100 * 1024 * 1024],
      ['f'.repeat(64), 500 * 1024 * 1024]
    ] as const) {
      const file = path.join(
        t.capability.localRoot,
        `sqincoming-v1-${receiver}-${'e'.repeat(64)}-${crypto.randomUUID()}.partial`
      );
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.truncate(bytes);
      await handle.close();
      calls.length = 0;
      const denied = await fetch();
      assert.equal(denied.kind === 'refused' && denied.code, 'capacity');
      assert.deepEqual(calls, []);
      await t.remote.housekeep();
      assert.equal(await fs.stat(file).catch(() => undefined), undefined);
      const fetched = await fetch();
      assert.ok(fetched.kind === 'fetched');
      await fs.unlink(fetched.path);
      await fs.unlink(fetched.path.replace(/\.bytes$/, '.json'));
    }
  }
);

it(
  'a failed rebuild releases the renewed native holder generation so another window can acquire',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t } = await make();
    const holders = await import('../../core/remote/holder');
    const ownership = await import('../../core/owned_incoming');
    const original = t.holder;
    context.mock.method(t.messenger, 'connect', () => {
      throw new Error('rebuild cannot connect');
    });
    await t.remote.settingsChanged();
    assert.ok(t.holder.generation > original.generation);
    assert.equal(t.remote.holds(), false);
    assert.equal(await holders.namedHolder(), undefined);
    const native = await new ownership.IncomingHost('other-window').capability();
    assert.ok(native);
    const next = {
      windowId: native.host.windowId,
      label: 'other',
      pid: native.host.pid,
      startedAt: native.host.osStartedAt,
      since: Date.now(),
      incoming: { host: native.host, generation: 1 }
    };
    assert.deepEqual(
      await holders.acquireHolder(next, await scan.scanProcesses(true), [{ id: next.windowId }]),
      { ok: true }
    );
    await holders.releaseHolder(next);
  }
);

it(
  'death of a long-closed receiver commits cleanup evidence before its original falls outside the reaction tail',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t, identity } = await make();
    const ownerHelpers = await import('./incoming_owner_helpers');
    await ownerHelpers.until(t.started[0]!.handle, (handle) => !handle.state.running);
    await t.observe();
    await eventually(async () => {
      const original = (await store.readConversations())[0]?.messages?.[0];
      return !!original?.terminal && original.applied === original.desired;
    });
    await t.policy(['other']);
    await t.remote.turnOff();
    t.advance(400 * 24 * 60 * 60_000);
    const record = (await store.readConversations())[0]!;
    const original = record.messages![0]!;
    assert.equal(original.access?.state, 'closed');
    const at = Date.now();
    record.messages!.push(
      ...Array.from({ length: 300 }, (_, n) => ({
        id: `ordinary-${n}`,
        ref: `ordinary-ref-${n}`,
        correlation: `ordinary-${n}`,
        at,
        desired: 'done' as const,
        applied: 'done' as const,
        terminal: true as const,
        delivery: 'settled' as const
      }))
    );
    record.revision = (record.revision ?? 0) + 1;
    assert.equal(await store.writeConversation(record, at + 400 * 24 * 60 * 60_000), true);
    assert.ok(
      (await store.readConversations())[0]?.messages?.some((one) => one.id === original.id)
    );
    await t.policy(['owner']);
    assert.equal((await t.remote.turnOn()).ok, true);
    await t.started[0]!.close();
    const rename = fs.rename.bind(fs);
    let failed = false;
    context.mock.method(fs, 'rename', (...args: Parameters<typeof fs.rename>) => {
      if (!failed && args[1] === path.join(paths.CONVERSATIONS_DIR, `${record.id}.json`)) {
        failed = true;
        return Promise.reject(new Error('death closure write unavailable'));
      }
      return rename(...args);
    });
    await t.remote.housekeep();
    assert.equal(failed, true);
    assert.equal(
      (await store.readConversations())[0]?.messages?.find((one) => one.id === original.id)?.access
        ?.ownerEndedAt,
      undefined
    );
    t.advance(26 * 60_000);
    await t.remote.housekeep();
    const closed = (await store.readConversations())[0]?.messages?.find(
      (one) => one.id === original.id
    );
    assert.equal(typeof closed?.access?.ownerEndedAt, 'number');
    assert.equal(
      (
        await t.remote.fetch({
          requestId: crypto.randomUUID(),
          identity: { ...identity, holder: t.holder }
        })
      ).kind,
      'refused'
    );
  }
);

it(
  'an aborted cache-hit renewal preserves the prior completed-content expiry while teardown drains its local rename',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t, fetch } = await make();
    const first = await fetch();
    assert.ok(first.kind === 'fetched');
    const manifest = first.path.replace(/\.bytes$/, '.json');
    context.mock.method(Date, 'now', () => first.expiresAt - 60 * 60_000);
    const rename = fs.rename.bind(fs);
    const entered = deferred<void>();
    const release = deferred<void>();
    context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      const [from, to] = args;
      if (String(from).endsWith('.manifest') && to === manifest) {
        entered.resolve();
        await release.promise;
      }
      return rename(from, to);
    });
    const budgets: Budget[] = [];
    let attempts = 0;
    let waits = 0;
    const backend = win32.files({
      stat: () => Promise.reject(new Error('target metadata unavailable')),
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: (source, to) => {
        if (to === manifest) attempts++;
        return fs.rename(source, to);
      },
      sleep: () => {
        waits++;
        return Promise.resolve();
      }
    });
    context.mock.method(platform.files, 'replace', (source: string, to: string, budget: Budget) => {
      if (to === manifest) budgets.push(budget);
      return backend.replace(source, to, budget);
    });
    const fetching = fetch();
    await entered.promise;
    const off = t.remote.turnOff();
    assert.equal((await fetching).kind, 'refused');
    release.resolve();
    await off;
    assert.deepEqual(budgets, [{ kind: 'owned' }, { kind: 'owned' }]);
    assert.equal(attempts, 2);
    assert.equal(waits, 0);
    assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).expiresAt, first.expiresAt);
    assert.equal(await fs.readFile(first.path, 'utf8'), 'bytes');
  }
);

it(
  'Off during held construction cannot revive a native holder challenge when that same build resumes',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t } = await make();
    const loaded = deferred<void>(),
      resumeLoad = deferred<void>();
    const passing = deferred<void>(),
      resumePass = deferred<void>();
    const inventory = store.readConversationInventory.bind(store);
    context.mock.method(store, 'readConversationInventory', async () => {
      loaded.resolve();
      await resumeLoad.promise;
      return inventory();
    });
    const pass = t.remote.pass.bind(t.remote);
    context.mock.method(t.remote, 'pass', async () => {
      passing.resolve();
      await resumePass.promise;
      return pass();
    });
    const rebuilding = t.remote.settingsChanged();
    await loaded.promise;
    const stopping = t.remote.turnOff();
    try {
      assert.equal(t.remote.incomingHolder(), undefined);
      resumeLoad.resolve();
      await passing.promise;
      const native = await import('../../core/coordination/serve_owned');
      const challenged = await native.serveOwned(
        {
          kind: 'incomingEvidenceV1',
          version: 1,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          windowId: t.holder.host.windowId,
          expectedHost: t.holder.host,
          challenge: crypto.randomUUID(),
          query: { kind: 'holder', holder: t.holder }
        },
        { ...t.port, currentIncomingHolder: () => t.remote.incomingHolder() }
      );
      assert.equal(challenged?.ok, false);
      assert.equal(challenged?.incomingHolderEvidence, undefined);
      assert.ok(
        await fs.stat(paths.HOLDER_FILE),
        'queued teardown has not released the holder yet'
      );
    } finally {
      resumeLoad.resolve();
      resumePass.resolve();
      await rebuilding;
      await stopping;
    }
    assert.equal(t.remote.incomingHolder(), undefined);
    assert.equal(await fs.stat(paths.HOLDER_FILE).catch(() => undefined), undefined);
  }
);

it(
  'a host with no owner check (W6.6) downloads nothing and writes nothing into the managed cache',
  { timeout: INCOMING_TEST_MS },
  async (context) => {
    const { t, calls, fetch } = await make();
    const refused = (await import('../../core/platform/private_files/win32')).privateFiles();
    for (const name of ['dir', 'ensure', 'check', 'read', 'create', 'open'] as const)
      context.mock.method(platform.privateFiles, name, refused[name]);
    const reply = await fetch();
    assert.equal(reply.kind === 'refused' && reply.code, 'invalid-path');
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
  }
);
