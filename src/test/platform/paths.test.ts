import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { homeEnv, tempHome, testPlatform } from '../helpers';

type Paths = typeof import('../../core/paths');

let paths: Paths;

before(async () => {
  const root = await tempHome();
  const home = path.join(root, "person's home");
  await fs.mkdir(home);
  Object.assign(process.env, homeEnv(home));
  paths = await import('../../core/paths');
});

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

describe('ensureHome', () => {
  it('creates every store dir and leaves Claude sidecars and the order file alone', async () => {
    await paths.ensureHome();
    assert.equal(paths.WARM_DIR, path.join(paths.STATE_DIR, 'warm'));
    assert.ok(paths.STORE_DIRS.includes(paths.WARM_DIR));
    assert.equal(paths.THREADS_DIR, path.join(paths.REMOTE_DIR, 'threads'));
    assert.ok(paths.STORE_DIRS.includes(paths.THREADS_DIR));

    for (const dir of paths.STORE_DIRS) {
      assert.equal(await exists(dir), true, dir);
    }
    assert.equal(await exists(paths.DUMP_DIR), false);
    assert.equal(await exists(paths.WORKFLOW_ORDER_FILE), false);
    assert.equal(await exists(path.join(paths.STATE_DIR, 'placements')), false);
  });

  it('is fine to call again on a tree that already exists', async () => {
    await assert.doesNotReject(paths.ensureHome());
  });
});

describe('STEP_COMMAND', () => {
  it(
    'is one shell word even when HOME needs quoting',
    {
      todo:
        testPlatform() === 'win32' &&
        'win32: STEP_COMMAND is sh-quoted, and this check runs /bin/sh; port it with the row — W1.3'
    },
    () => {
      const parsed = childProcess
        .execFileSync(
          '/bin/sh',
          ['-c', `set -- ${paths.stepCommand('posix')} next; printf '%s\\n' "$#" "$1" "$2"`],
          { encoding: 'utf8' }
        )
        .trim()
        .split('\n');

      assert.deepEqual(parsed, ['2', paths.STEP_BIN, 'next']);
    }
  );
});
