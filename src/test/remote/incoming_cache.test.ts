import { incomingPlatformFixture } from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { tempHome } from '../helpers';

type Paths = typeof import('../../core/paths');

let paths: Paths;
let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  paths = await import('../../core/paths');
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

describe('managed incoming byte accounting', () => {
  async function cacheRig(context: import('node:test').TestContext) {
    const os = await import('node:os');
    const crypto = await import('node:crypto');
    const fixtures = await import('../incoming_fetch_helpers');
    const directory = path.join(os.homedir(), `cache-storage-${crypto.randomUUID()}`);
    await fs.mkdir(directory);
    context.mock.method(os, 'tmpdir', () => directory);
    await fs.rm(paths.HEARD_FILE, { force: true });
    const t = await fixtures.make(directory);
    t.send();
    await t.drain();
    const view = await t.view();
    assert.ok(!('denied' in view.admission));
    return {
      t,
      view,
      admission: view.admission,
      file: view.admission.files[0]!,
      identity: t.identity(view)
    };
  }

  it('charges old-holder orphan bytes against receiver and machine caps before metadata/download, preserving neighbors', async (context) => {
    const crypto = await import('node:crypto');
    const { t, identity } = await cacheRig(context);
    const root = t.capability.localRoot;
    const neighbor = path.join(root, 'neighbor.txt');
    await fs.writeFile(neighbor, 'keep');
    const own = crypto.createHash('sha256').update(JSON.stringify(identity.receiver)).digest('hex');
    const old = path.join(
      root,
      `sqincoming-v1-${own}-${'e'.repeat(64)}-${crypto.randomUUID()}.partial`
    );
    const other = path.join(
      root,
      `sqincoming-v1-${'f'.repeat(64)}-${'e'.repeat(64)}-${crypto.randomUUID()}.bytes`
    );
    try {
      const handle = await fs.open(old, 'wx', 0o600);
      await handle.truncate(100 * 1024 * 1024);
      await handle.close();
      let reply = await t.fetch(identity);
      assert.equal(reply.kind === 'refused' && reply.code, 'capacity');
      assert.ok(t.calls.every((call) => call.startsWith('verify')));
      await fs.unlink(old);
      t.calls.length = 0;
      const foreign = await fs.open(other, 'wx', 0o600);
      await foreign.truncate(500 * 1024 * 1024);
      await foreign.close();
      reply = await t.fetch(identity);
      assert.equal(reply.kind === 'refused' && reply.code, 'capacity');
      assert.ok(t.calls.every((call) => call.startsWith('verify')));
      assert.equal((await fs.stat(other)).size, 500 * 1024 * 1024);
      assert.equal(await fs.readFile(neighbor, 'utf8'), 'keep');
      await fs.unlink(other);
      assert.equal((await t.fetch(identity)).kind, 'fetched');
    } finally {
      await t.close();
    }
  });

  it('refuses legacy numeric roots and a replaced private root before creating bytes', async (context) => {
    const storage = await import('../../core/remote/incoming_cache');
    const platform = await import('../../core/platform');
    const { t, admission, file, identity } = await cacheRig(context);
    const bytes = new storage.IncomingCache();
    const reservation = await bytes.reserve(t.capability, admission, file, identity.receiver);
    assert.ok(reservation);
    const backup = `${reservation.root}-held`;
    let moved = false;
    const stream = async function* () {
      yield await Promise.resolve(Buffer.from('must not write'));
    };
    const signal = new AbortController().signal;
    const invalidRoot = (error: unknown): boolean =>
      error instanceof storage.CacheRefusal && error.code === 'invalid-path';
    try {
      const legacy = {
        ...reservation,
        rootIdentity: undefined,
        rootIno: 1,
        rootDev: 1
      } as unknown as import('../../core/remote/incoming_cache').Reservation;
      await assert.rejects(bytes.materialize(legacy, stream(), signal), invalidRoot);
      await assert.rejects(fs.stat(reservation.partial), { code: 'ENOENT' });
      await fs.rename(reservation.root, backup);
      moved = true;
      const replacement = await platform.privateFiles.ensure();
      assert.ok(replacement.supported && replacement.status === 'ok');
      await assert.rejects(bytes.materialize(reservation, stream(), signal), invalidRoot);
      assert.deepEqual(await fs.readdir(reservation.root), []);
    } finally {
      if (moved) {
        await fs.rmdir(reservation.root);
        await fs.rename(backup, reservation.root);
      }
      await bytes.release(reservation);
      await t.close();
    }
  });

  it('serializes simultaneous local reservations at two per receiver/four per machine, and counts prior-instance reservations', async (context) => {
    const storage = await import('../../core/remote/incoming_cache');
    const { t, admission, file, identity } = await cacheRig(context);
    const bytes = new storage.IncomingCache();
    const held: import('../../core/remote/incoming_cache').Reservation[] = [];
    try {
      const own = await Promise.all(
        Array.from({ length: 3 }, () =>
          bytes.reserve(t.capability, admission, file, identity.receiver)
        )
      );
      held.push(...own.filter((value) => value !== undefined));
      assert.equal(held.length, 2);
      assert.equal(own.filter((value) => value === undefined).length, 1);
      const opened = await t.port.start({ cwd: identity.receiver.cwd, prompt: 'ordinary' });
      assert.ok(opened.ok);
      const other = t.started[1]!.owner.receiverIdentity;
      const second = await Promise.all(
        Array.from({ length: 2 }, () => bytes.reserve(t.capability, admission, file, other))
      );
      held.push(...second.filter((value) => value !== undefined));
      assert.equal(held.length, 4);
      const third = await t.port.start({ cwd: identity.receiver.cwd, prompt: 'ordinary' });
      assert.ok(third.ok);
      const nextInstance = new storage.IncomingCache();
      assert.equal(
        await nextInstance.reserve(
          t.capability,
          admission,
          file,
          t.started[2]!.owner.receiverIdentity
        ),
        undefined
      );
      const released = held.pop()!;
      await bytes.release(released);
      const recovered = await nextInstance.reserve(
        t.capability,
        admission,
        file,
        t.started[2]!.owner.receiverIdentity
      );
      assert.ok(recovered);
      held.push(recovered);
      const first = held[0]!;
      const partial = await fs.open(first.partial, 'wx', 0o600);
      await partial.truncate(500 * 1024 * 1024);
      await partial.close();
      await assert.rejects(
        nextInstance.reserve(t.capability, admission, file, other),
        (error: unknown) => error instanceof storage.CacheRefusal && error.code === 'capacity'
      );
      assert.equal((await fs.stat(first.partial)).size, 500 * 1024 * 1024);
      await fs.unlink(first.partial);
      await fs.writeFile(
        first.reservation,
        JSON.stringify({ version: 1, receiver: 'f'.repeat(64), bytes: 10 * 1024 * 1024 }),
        { mode: 0o600 }
      );
      await assert.rejects(
        nextInstance.reserve(t.capability, admission, file, other),
        (error: unknown) =>
          error instanceof storage.CacheRefusal && error.code === 'storage-unavailable'
      );
    } finally {
      await Promise.all(held.map((reservation) => bytes.release(reservation)));
      await t.close();
    }
    assert.deepEqual(await fs.readdir(t.capability.localRoot), []);
  });

  it('refuses caller roots, oversized/torn manifests and changed partials without publishing a path', async (context) => {
    const storage = await import('../../core/remote/incoming_cache');
    const { t, admission, file, identity } = await cacheRig(context);
    const bytes = new storage.IncomingCache();
    let reservation: import('../../core/remote/incoming_cache').Reservation | undefined;
    try {
      await assert.rejects(
        bytes.reserve(
          { ...t.capability, localRoot: identity.receiver.cwd },
          admission,
          file,
          identity.receiver
        ),
        (error: unknown) => error instanceof storage.CacheRefusal && error.code === 'invalid-path'
      );
      reservation = await bytes.reserve(t.capability, admission, file, identity.receiver);
      assert.ok(reservation);
      const content = await bytes.materialize(
        reservation,
        (async function* () {
          yield await Promise.resolve(Buffer.from('original'));
        })(),
        new AbortController().signal
      );
      await fs.writeFile(reservation.partial, 'modified');
      await assert.rejects(
        bytes.publish(reservation, content, {}, new AbortController().signal, () => true),
        (error: unknown) => error instanceof storage.CacheRefusal && error.code === 'invalid-path'
      );
      await bytes.release(reservation);
      reservation = undefined;
      const fetched = await t.fetch(identity);
      assert.ok(fetched.kind === 'fetched');
      const manifest = fetched.path.replace(/\.bytes$/, '.json');
      await fs.writeFile(manifest, 'x'.repeat(4097));
      let reply = await t.fetch(identity);
      assert.equal(reply.kind === 'refused' && reply.code, 'storage-unavailable');
      await fs.writeFile(manifest, '{');
      reply = await t.fetch(identity);
      assert.equal(reply.kind, 'refused');
      assert.equal('path' in reply, false);
      assert.equal(t.calls.filter((call) => call.startsWith('download')).length, 1);
    } finally {
      if (reservation) await bytes.release(reservation);
      await t.close();
    }
  });
  it('a mutated valid manifest key cannot associate intact bytes with another admitted file', async (context) => {
    const { t, identity } = await cacheRig(context);
    try {
      const first = await t.fetch(identity);
      assert.ok(first.kind === 'fetched');
      t.send(1);
      await t.drain();
      t.bytes(Buffer.from('different admitted bytes'));
      const secondIdentity = t.identity(await t.view('original-1'));
      const second = await t.fetch(secondIdentity);
      assert.ok(second.kind === 'fetched');
      const firstManifest = first.path.replace(/\.bytes$/, '.json');
      const secondManifest = second.path.replace(/\.bytes$/, '.json');
      const original = JSON.parse(await fs.readFile(firstManifest, 'utf8'));
      const other = JSON.parse(await fs.readFile(secondManifest, 'utf8'));
      await fs.unlink(secondManifest);
      await fs.unlink(second.path);
      original.key = other.key;
      await fs.writeFile(firstManifest, JSON.stringify(original));
      t.calls.length = 0;
      const reply = await t.fetch(secondIdentity);
      assert.equal(reply.kind === 'refused' && reply.code, 'storage-unavailable');
      assert.equal('path' in reply, false);
      assert.ok(t.calls.every((call) => call.startsWith('verify')));
      assert.equal(await fs.readFile(first.path, 'utf8'), 'actual local bytes');
    } finally {
      await t.close();
    }
  });
});
