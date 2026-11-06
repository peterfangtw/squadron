import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { tempHome, homeEnv, linkDir, disposeHome } from '../helpers';

let scratch: typeof import('../../core/scratch');
let home: string;
before(async () => {
  home = await tempHome();
  scratch = await import('../../core/scratch');
});
after(async () => {
  await disposeHome(home);
});

describe('managed scratch working directories', () => {
  it('isolates attempts, reuses a repeated attempt, and cannot escape through its id', async () => {
    const root = path.join(home, 'allocation', '.squadron', 'scratch');
    const first = await scratch.allocateScratch(root, '../../outside');
    const repeated = await scratch.allocateScratch(root, '../../outside');
    const second = await scratch.allocateScratch(root, 'another attempt');
    assert.equal(path.dirname(first.cwd), root);
    assert.equal(first.cwd, repeated.cwd);
    assert.notEqual(first.cwd, second.cwd);
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    await fs.writeFile(path.join(first.cwd, 'result.txt'), 'keep me');
    await scratch.discardEmptyScratch(first);
    assert.equal(await fs.readFile(path.join(first.cwd, 'result.txt'), 'utf8'), 'keep me');
    await scratch.discardEmptyScratch(second);
    await assert.rejects(fs.stat(second.cwd), { code: 'ENOENT' });
  });

  it('refuses a scratch root under an enclosing repository', async () => {
    const repo = path.join(home, 'dotfiles');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo], { env: homeEnv(home) });
    const root = path.join(repo, 'home', '.squadron', 'scratch');
    await assert.rejects(scratch.allocateScratch(root, 'blocked'), /inside the Git repository/);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  });

  it('does not recreate a deleted conversation directory on Resume', async () => {
    const root = path.join(home, 'resume', '.squadron', 'scratch');
    const allocation = await scratch.allocateScratch(root, 'gone');
    await scratch.discardEmptyScratch(allocation);
    await assert.rejects(scratch.checkScratchResume(root, allocation.cwd), /no longer exists/);
    await assert.rejects(fs.stat(allocation.cwd), { code: 'ENOENT' });
    await scratch.checkScratchResume(root, path.join(home, 'ordinary-missing'));
  });

  it('canonicalizes a missing root through an existing directory alias', async () => {
    const real = path.join(home, 'real');
    const alias = path.join(home, 'alias');
    await fs.mkdir(real);
    await linkDir(real, alias);
    const lexical = path.join(alias, 'missing', 'scratch');
    const canonical = await scratch.canonicalDirectory(lexical);
    assert.equal(canonical, path.join(await fs.realpath(real), 'missing', 'scratch'));
    await scratch.allocateScratch(canonical, 'canonical');
    assert.equal(await scratch.canonicalDirectory(lexical), canonical);
  });
});
