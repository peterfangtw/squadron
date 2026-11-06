import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { it } from 'node:test';
import { StateDirectoryWatches } from '../../core/state_watch';
import { disposeHome, tempHome } from '../helpers';

it('watches state stores through create/delete/recreate while excluding scratch and closing cleanly', async (t) => {
  const home = await tempHome();
  const root = path.join(home, '.squadron');
  const live = path.join(root, 'live');
  const scratch = path.join(root, 'scratch');
  await fs.mkdir(live, { recursive: true });
  await fs.mkdir(path.join(scratch, 'node_modules'), { recursive: true });
  const active = new Set<string>();
  let changes = 0;
  const watches = new StateDirectoryWatches(root, {
    watch(directory) {
      active.add(directory);
      return {
        dispose: () => {
          active.delete(directory);
        }
      };
    },
    changed: () => {
      changes++;
    }
  });
  try {
    await watches.start();
    assert.deepEqual([...active], [live]);
    assert.equal(changes, 0, 'initial registration adds no redundant refresh');
    await watches.notice(scratch);
    await watches.notice(path.join(scratch, 'node_modules'));
    await watches.notice(path.join(root, '..', 'unrelated'));
    await fs.writeFile(path.join(root, 'usage.json'), '{}');
    await watches.notice(path.join(root, 'usage.json'));
    assert.deepEqual([...active], [live]);
    assert.equal(changes, 0);
    const added = path.join(root, 'future-store');
    await fs.mkdir(added);
    await watches.notice(added);
    await watches.notice(added);
    assert.ok(active.has(added));
    assert.equal(changes, 1, 'a newly watched store announces files that predate registration');
    await fs.rmdir(added);
    await watches.notice(added);
    assert.equal(active.has(added), false);
    assert.equal(changes, 2);
    await fs.mkdir(added);
    await watches.notice(added);
    assert.ok(active.has(added));
    const late = path.join(root, 'late-store');
    await fs.mkdir(late);
    let began!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalStat = fs.lstat;
    t.mock.method(fs, 'lstat', async (directory: Parameters<typeof fs.lstat>[0]) => {
      if (directory === late) {
        began();
        await held;
      }
      return originalStat(directory);
    });
    const pending = watches.notice(late);
    await started;
    watches.dispose();
    release();
    await pending;
    await watches.start();
    await watches.notice(added);
    assert.equal(active.size, 0, 'late discovery cannot recreate disposed watches');
  } finally {
    watches.dispose();
    await disposeHome(home);
  }
});
