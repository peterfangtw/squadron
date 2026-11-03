import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';

it('post-checkout accepts nested worktrees and reports outside locations', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-worktree-'));
  const root = path.join(temp, 'primary repo 中文');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const git = (cwd: string, ...args: string[]): cp.SpawnSyncReturns<string> =>
    cp.spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const ok = (cwd: string, ...args: string[]): string => {
    const result = git(cwd, ...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(root);
    ok(root, 'init', '--quiet', '--initial-branch=fixture');
    ok(root, 'config', 'core.autocrlf', 'false');
    ok(root, 'config', 'user.name', 'fixture');
    ok(root, 'config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync(path.join(root, '.githooks'));
    const hook = path.join(root, '.githooks/post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    ok(root, 'add', '.githooks');
    ok(root, 'commit', '--quiet', '-m', 'old hook');
    const base = ok(root, 'rev-parse', 'HEAD');
    fs.copyFileSync(path.resolve(__dirname, '../../..', '.githooks/post-checkout'), hook);
    ok(root, 'add', '.githooks');
    ok(root, 'commit', '--quiet', '-m', 'fixture');
    ok(root, 'config', 'core.hooksPath', '.githooks');

    const old = path.join(root, '.worktrees', 'old base');
    ok(root, 'worktree', 'add', '--quiet', '--detach', old, base);
    assert.equal(
      fs.readFileSync(path.join(old, '.githooks/post-checkout'), 'utf8'),
      '#!/bin/sh\nexit 1\n'
    );
    assert.equal(ok(root, 'config', 'core.hooksPath'), '.githooks');

    const inside = path.join(root, '.worktrees', 'nested', 'inside 中文');
    ok(root, 'worktree', 'add', '--quiet', '--detach', inside);
    ok(inside, 'worktree', 'add', '--quiet', '--detach', path.join(root, '.worktrees', 'peer'));

    const alias = path.join(temp, 'primary alias');
    fs.symlinkSync(root, alias, 'junction');
    ok(alias, 'worktree', 'add', '--quiet', '--detach', path.join(alias, '.worktrees', 'linked'));
    const escape = path.join(temp, 'escape');
    fs.mkdirSync(escape);
    fs.symlinkSync(escape, path.join(root, '.worktrees', 'escape'), 'junction');

    for (const outside of [
      path.join(temp, 'outside 中文'),
      path.join(root, '.worktrees-sibling', 'outside'),
      path.join(root, '.worktrees', 'escape', 'outside')
    ]) {
      const result = git(inside, 'worktree', 'add', '--quiet', '--detach', outside);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /This worktree is outside/);
      assert.match(result.stderr, /git .*worktree move/);
      assert.equal(fs.existsSync(path.join(outside, '.git')), true);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
