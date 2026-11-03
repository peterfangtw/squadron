import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import * as seedFiles from '../smoke/seed';
import { linkDir, modeBitsSkip, needsFileSymlinks, testPlatform } from '../helpers';

async function fixture(): Promise<{ root: string; seed: string; home: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-seed-')));
  const seed = path.join(root, 'seed');
  const home = path.join(root, 'home');
  await fs.mkdir(seed);
  await fs.mkdir(home);
  return { root, seed, home };
}

it('restores exact seed bytes, removed files, types and metadata while retaining only excluded descendants', async () => {
  const { root, seed, home } = await fixture();
  try {
    await fs.mkdir(path.join(seed, 'dir'));
    await fs.writeFile(path.join(seed, 'dir', 'removed'), 'restore');
    await fs.writeFile(path.join(seed, 'same-size'), 'seed');
    await fs.writeFile(path.join(seed, 'file'), 'file replaces directory');
    await fs.mkdir(path.join(home, 'file'));
    await fs.writeFile(path.join(home, 'file', 'stale'), 'delete');
    await fs.writeFile(path.join(home, 'dir'), 'directory replaces file');
    await fs.writeFile(path.join(home, 'same-size'), 'live');
    await fs.mkdir(path.join(home, '.host', 'keep'), { recursive: true });
    await fs.writeFile(path.join(home, '.host', 'keep', 'claim'), 'host');
    await fs.writeFile(path.join(home, '.host', 'stale'), 'delete');
    await fs.writeFile(path.join(home, 'extra'), 'delete');
    const stamp = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(path.join(seed, 'same-size'), stamp, stamp);
    await fs.utimes(path.join(home, 'same-size'), stamp, stamp);
    await fs.chmod(path.join(seed, 'same-size'), 0o751);
    await fs.chmod(path.join(home, 'same-size'), 0o751);
    await fs.utimes(path.join(seed, 'dir'), stamp, stamp);
    assert.deepEqual(seedFiles.drift(seed, home, ['.host/keep']).sort(), [
      '.host/stale',
      'dir',
      'dir/removed',
      'extra',
      'file',
      'file/stale'
    ]);
    seedFiles.restore(seed, home, ['.host/keep']);
    assert.equal(await fs.readFile(path.join(home, 'same-size'), 'utf8'), 'seed');
    assert.equal(await fs.readFile(path.join(home, 'dir', 'removed'), 'utf8'), 'restore');
    assert.equal(await fs.readFile(path.join(home, 'file'), 'utf8'), 'file replaces directory');
    assert.deepEqual(await fs.readdir(path.join(home, '.host')), ['keep']);
    assert.equal(await fs.readFile(path.join(home, '.host', 'keep', 'claim'), 'utf8'), 'host');
    assert.equal(await fs.stat(path.join(home, 'extra')).catch(() => undefined), undefined);
    assert.equal((await fs.stat(path.join(home, 'same-size'))).mtimeMs, stamp.getTime());
    assert.equal((await fs.stat(path.join(home, 'dir'))).mtimeMs, stamp.getTime());
    if (testPlatform() !== 'win32')
      assert.equal((await fs.stat(path.join(home, 'same-size'))).mode & 0o777, 0o751);
    assert.deepEqual(seedFiles.drift(seed, home, ['.host/keep']), []);
    seedFiles.restore(seed, home, ['.host/keep']);
    assert.deepEqual(seedFiles.drift(seed, home, ['.host/keep']), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not traverse destination links or replace an ancestor of excluded state; failed restore can be repeated', async () => {
  const { root, seed, home } = await fixture();
  try {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'untouched');
    await linkDir(outside, path.join(home, 'linked'));
    seedFiles.restore(seed, home, []);
    assert.equal(await fs.lstat(path.join(home, 'linked')).catch(() => undefined), undefined);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
    await fs.writeFile(path.join(seed, 'first'), 'restored before failure');
    await fs.mkdir(path.join(seed, '.host'));
    await linkDir(outside, path.join(home, '.host'));
    assert.throws(
      () => seedFiles.restore(seed, home, ['.host/keep']),
      /ancestor of host-owned path/
    );
    assert.equal((await fs.lstat(path.join(home, '.host'))).isSymbolicLink(), true);
    await fs.rm(path.join(home, '.host'));
    seedFiles.restore(seed, home, ['.host/keep']);
    assert.deepEqual(seedFiles.drift(seed, home, ['.host/keep']), []);
    assert.throws(() => seedFiles.restore(home, home, []), /separate trees/);
    assert.throws(() => seedFiles.restore(root, home, []), /separate trees/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it(
  'preserves literal dangling and relative file links without copying their targets',
  { skip: needsFileSymlinks() },
  async () => {
    const { root, seed, home } = await fixture();
    try {
      await fs.writeFile(path.join(seed, 'file'), 'seed');
      await fs.symlink('file', path.join(seed, 'relative'));
      await fs.symlink('absent', path.join(seed, 'dangling'));
      await fs.mkdir(path.join(home, 'relative'));
      seedFiles.restore(seed, home, []);
      assert.equal(await fs.readlink(path.join(home, 'relative')), 'file');
      assert.equal(await fs.readlink(path.join(home, 'dangling')), 'absent');
      assert.equal(await fs.stat(path.join(home, 'absent')).catch(() => undefined), undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it(
  'repairs restrictive directory modes before restore and removal, then reapplies seed modes',
  { skip: modeBitsSkip },
  async () => {
    const { root, seed, home } = await fixture();
    const seeded = path.join(seed, 'kept');
    const live = path.join(home, 'kept');
    const extra = path.join(home, 'extra');
    const replaced = path.join(home, 'replaced');
    try {
      for (const dir of [seeded, live, extra, replaced]) await fs.mkdir(dir);
      await fs.writeFile(path.join(seeded, 'file'), 'seed');
      await fs.writeFile(path.join(live, 'file'), 'live');
      await fs.writeFile(path.join(live, 'stale'), 'delete');
      await fs.writeFile(path.join(extra, 'stale'), 'delete');
      await fs.writeFile(path.join(replaced, 'stale'), 'delete');
      await fs.writeFile(path.join(seed, 'replaced'), 'seed file');
      for (const dir of [seeded, live, extra, replaced]) await fs.chmod(dir, 0o555);
      seedFiles.restore(seed, home, []);
      assert.equal(await fs.readFile(path.join(live, 'file'), 'utf8'), 'seed');
      assert.deepEqual(await fs.readdir(live), ['file']);
      assert.equal((await fs.stat(live)).mode & 0o777, 0o555);
      assert.equal(await fs.stat(extra).catch(() => undefined), undefined);
      assert.equal(await fs.readFile(replaced, 'utf8'), 'seed file');
      seedFiles.restore(seed, home, []);
      assert.deepEqual(seedFiles.drift(seed, home, []), []);
    } finally {
      for (const dir of [seeded, live, extra, replaced])
        await fs.chmod(dir, 0o755).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
