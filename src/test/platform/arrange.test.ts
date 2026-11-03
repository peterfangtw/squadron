import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import { tempHome, testPlatform } from '../helpers';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

type Arrange = typeof import('../../core/arrange');

let home: string;
let arrange: Arrange;

const dir = () => path.join(home, '.squadron', 'arrange');

before(async () => {
  home = await tempHome();
  arrange = await import('../../core/arrange');
});

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

/** The one file in the directory, whatever it is called. */
async function onlyFile(): Promise<string> {
  const names = await fs.readdir(dir());
  assert.equal(names.length, 1, `expected one file, found ${names.join(', ')}`);
  return path.join(dir(), names[0] ?? '');
}

describe('the arrangement store', () => {
  it('has nothing to say before anything has been dragged', async () => {
    await reset();
    assert.equal((await arrange.readArrangements()).size, 0);
  });

  it('round-trips two groups, keyed by cwd', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [
      { pid: 11, startedAt: 1000 },
      { pid: 22, startedAt: 2000 }
    ]);
    await arrange.writeArrangement('/tmp/beta', [{ pid: 33, startedAt: 3000 }]);

    const orders = await arrange.readArrangements();
    assert.deepEqual(orders.get(platform.paths.key('/tmp/alpha'))?.slots, [
      { pid: 11, startedAt: 1000 },
      { pid: 22, startedAt: 2000 }
    ]);
    assert.deepEqual(orders.get(platform.paths.key('/tmp/beta'))?.slots, [
      { pid: 33, startedAt: 3000 }
    ]);
  });

  it('names a file from the cwd alone, and the same cwd the same way', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    const first = await onlyFile();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 22, startedAt: 2000 }]);
    assert.equal(await onlyFile(), first);

    await arrange.writeArrangement('/tmp/beta', [{ pid: 33, startedAt: 3000 }]);
    assert.equal((await fs.readdir(dir())).length, 2);
  });

  it('re-arranging a group replaces its order rather than appending to it', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 22, startedAt: 2000 }]);

    const orders = await arrange.readArrangements();
    assert.equal(orders.size, 1);
    assert.deepEqual(orders.get(platform.paths.key('/tmp/alpha'))?.slots, [
      { pid: 22, startedAt: 2000 }
    ]);
  });

  it('leaves no temp file behind, and none that a panel would parse', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    assert.deepEqual(
      (await fs.readdir(dir())).filter((n) => !n.endsWith('.json')),
      []
    );
  });

  // A crashed write leaves its temp behind. It does not end in `.json`, which is
  // both why the panel's watcher ignores it and why this cannot read it as an
  // order.
  it('does not read a temp file a crashed write left behind', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    await fs.writeFile(
      path.join(dir(), 'abandoned.json.999.0.tmp'),
      JSON.stringify({ schema: 1, cwd: '/tmp/ghost', updatedAt: 1, slots: [] })
    );

    const orders = await arrange.readArrangements();
    assert.deepEqual([...orders.keys()], ['/tmp/alpha']);
  });

  it('skips what it cannot trust and keeps the group that is fine', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    const bad = {
      'newer.json': { schema: 2, cwd: '/tmp/newer', updatedAt: 1, slots: [] },
      'noslots.json': { schema: 1, cwd: '/tmp/noslots', updatedAt: 1 },
      // A slot on pid alone would place a card with nothing bounding a recycled
      // pid, which is the one thing the guard exists to stop.
      'unguarded.json': {
        schema: 1,
        cwd: '/tmp/unguarded',
        updatedAt: 1,
        slots: [{ pid: 44 }]
      }
    };
    for (const [name, value] of Object.entries(bad)) {
      await fs.writeFile(path.join(dir(), name), JSON.stringify(value));
    }
    await fs.writeFile(path.join(dir(), 'garbage.json'), '{ half writ');
    await fs.writeFile(path.join(dir(), 'README'), 'nothing to see');

    const orders = await arrange.readArrangements();
    assert.deepEqual([...orders.keys()], ['/tmp/alpha']);
  });

  // Forward only: a file written under a name keys no longer give (a win32
  // lower-drive hash from before keys folded) stays on disk, unread, and cannot
  // shadow the current file however the directory lists them.
  it('reads only the file the current key names, whatever else holds that cwd', async () => {
    await reset();
    const cwd = path.join(home, 'Repo');
    const spelled = testPlatform() === 'win32' ? cwd.charAt(0).toLowerCase() + cwd.slice(1) : cwd;
    const legacy = (slots: { pid: number; startedAt: number }[]) =>
      JSON.stringify({ schema: 1, cwd: spelled, updatedAt: 1, slots });
    const stale = new Set(['ffffffffffffffff.json', `${sha(spelled)}.json`]);
    stale.delete(`${sha(platform.paths.key(cwd))}.json`);
    await fs.mkdir(dir(), { recursive: true });
    for (const name of stale) {
      await fs.writeFile(path.join(dir(), name), legacy([{ pid: 1, startedAt: 1 }]));
    }

    await arrange.writeArrangement(cwd, [{ pid: 2, startedAt: 2 }]);
    let orders = await arrange.readArrangements();
    assert.equal(orders.size, 1);
    assert.deepEqual(orders.get(platform.paths.key(spelled))?.slots, [{ pid: 2, startedAt: 2 }]);

    await arrange.writeArrangement(spelled, [{ pid: 3, startedAt: 3 }]);
    orders = await arrange.readArrangements();
    assert.deepEqual(orders.get(platform.paths.key(cwd))?.slots, [{ pid: 3, startedAt: 3 }]);
    assert.equal(orders.get(platform.paths.key(cwd))?.cwd, spelled);
    for (const name of stale) await fs.access(path.join(dir(), name));
  });

  it('clears every order and leaves the directory readable', async () => {
    await reset();
    await arrange.writeArrangement('/tmp/alpha', [{ pid: 11, startedAt: 1000 }]);
    await arrange.writeArrangement('/tmp/beta', [{ pid: 22, startedAt: 2000 }]);

    await arrange.clearArrangements();

    assert.deepEqual(await fs.readdir(dir()), []);
    assert.equal((await arrange.readArrangements()).size, 0);
  });

  it('clears on a machine that has never dragged, without complaint', async () => {
    await reset();
    await assert.doesNotReject(arrange.clearArrangements());
  });
});
