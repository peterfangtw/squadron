import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { describe, it } from 'node:test';

import * as pipe from '../../core/session';

describe('launch files', () => {
  it('creates parents, skips identical content, and reports failures without throwing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-launch-'));
    try {
      const file = { path: path.join(root, 'nested', 'profile.md'), content: 'instructions' };
      assert.deepEqual(await pipe.writeLaunchFiles([file]), []);
      assert.equal(await fs.readFile(file.path, 'utf8'), file.content);
      await fs.utimes(file.path, 1, 1);
      assert.deepEqual(await pipe.writeLaunchFiles([file]), []);
      assert.equal((await fs.stat(file.path)).mtimeMs, 1000);
      const failures = await pipe.writeLaunchFiles([
        { path: path.join(file.path, 'invalid'), content: 'no' }
      ]);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.path, path.join(file.path, 'invalid'));
      assert.deepEqual(await pipe.writeLaunchFiles(undefined), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
