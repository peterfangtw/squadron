import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { repoRoot } from '../helpers';

/**
 * `.githooks/reference-transaction`, run by real git against a throwaway
 * repository. Only this hook and its policy reader are copied in, so other
 * hooks cannot act on the fixture. Assertions cover actual staging/main moves.
 */

const HOOK = path.join(repoRoot(), '.githooks', 'reference-transaction');

/** Git's variables beat `cwd` when the gate runs from a hook (`release.test.ts`, `CLEAN`). */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

type Ran = { code: number; err: string };

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(pack = false): {
  git: (...args: string[]) => Ran;
  out: (...args: string[]) => string;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-githooks-'));
  dirs.push(dir);
  const hooks = path.join(dir, '.hooks');
  fs.mkdirSync(hooks);
  fs.copyFileSync(HOOK, path.join(hooks, 'reference-transaction'));
  fs.chmodSync(path.join(hooks, 'reference-transaction'), 0o755);
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const name of [
    'integration.mjs',
    'checkpoints.mjs',
    'verification_processes.mjs',
    'observation.mjs'
  ])
    fs.copyFileSync(path.join(repoRoot(), 'scripts', name), path.join(dir, 'scripts', name));
  const opts = { cwd: dir, env: CLEAN, encoding: 'utf8' as const, stdio: 'pipe' as const };
  const out = (...args: string[]): string => execFileSync('git', args, opts).trim();
  const git = (...args: string[]): Ran => {
    try {
      execFileSync('git', args, opts);
      return { code: 0, err: '' };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { code: failure.status ?? 1, err: failure.stderr ?? '' };
    }
  };
  out('init', '--quiet', '--initial-branch=staging');
  out('config', 'user.name', 't');
  out('config', 'user.email', 't@t');
  out('commit', '--quiet', '--allow-empty', '-m', 'a');
  out('branch', 'main');
  // Before the hook, so a case about deleting a packed `main` does not also
  // depend on the hook letting `pack-refs` through.
  if (pack) out('pack-refs', '--all');
  out('config', 'core.hooksPath', hooks);
  return { git, out, dir };
}

describe('reference-transaction', () => {
  it('lets pack-refs move main into packed-refs, where it stays', () => {
    const { git, out, dir } = repo();
    const before = out('rev-parse', 'main');
    assert.deepEqual(git('pack-refs', '--all'), { code: 0, err: '' });
    assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'main')), false);
    assert.equal(out('rev-parse', 'main'), before);
  });

  it('refuses branch -D main, loose or packed', () => {
    for (const pack of [false, true]) {
      const { git } = repo(pack);
      const ran = git('branch', '-D', 'main');
      assert.notEqual(ran.code, 0, `packed: ${pack}`);
      assert.match(ran.err, /refusing to move main/);
      assert.equal(git('rev-parse', '--verify', '--quiet', 'main').code, 0);
    }
  });

  it('refuses update-ref -d main naming its old value, loose or packed', () => {
    for (const pack of [false, true]) {
      const { git, out } = repo(pack);
      const ran = git('update-ref', '-d', 'refs/heads/main', out('rev-parse', 'main'));
      assert.notEqual(ran.code, 0, `packed: ${pack}`);
      assert.equal(git('rev-parse', '--verify', '--quiet', 'main').code, 0);
    }
  });

  it('still refuses a main ahead of staging, and takes a fast-forward to it', () => {
    const { git, out } = repo();
    out('checkout', '--quiet', '-b', 'feat/change');
    out('commit', '--quiet', '--allow-empty', '-m', 'b');
    const tree = out('rev-parse', 'HEAD^{tree}');
    const stray = out('commit-tree', tree, '-p', 'HEAD', '-m', 'stray');
    assert.notEqual(git('update-ref', 'refs/heads/main', stray).code, 0);
    out('update-ref', 'refs/remotes/origin/staging', 'HEAD');
    out('update-ref', 'refs/heads/staging', 'HEAD');
    assert.equal(git('update-ref', 'refs/heads/main', 'staging').code, 0);
  });

  it('refuses unverified staging updates, including fast-forward merges and direct commits', () => {
    const { git, out } = repo();
    const before = out('rev-parse', 'staging');
    out('checkout', '--quiet', '-b', 'feat/change');
    out('commit', '--quiet', '--allow-empty', '-m', 'feature');
    assert.notEqual(git('update-ref', 'refs/heads/staging', 'HEAD').code, 0);
    out('checkout', '--quiet', 'staging');
    const merge = git('merge', '--ff-only', 'feat/change');
    assert.notEqual(merge.code, 0);
    assert.match(merge.err, /staging/);
    assert.equal(out('rev-parse', 'staging'), before);
    assert.notEqual(git('commit', '--quiet', '--allow-empty', '-m', 'direct').code, 0);
    assert.equal(out('rev-parse', 'staging'), before);
  });

  it('permits staging to catch up to a fetched remote result and survives pack-refs', () => {
    const { git, out } = repo();
    out('checkout', '--quiet', '-b', 'feat/change');
    out('commit', '--quiet', '--allow-empty', '-m', 'feature');
    out('update-ref', 'refs/remotes/origin/staging', 'HEAD');
    assert.equal(git('update-ref', 'refs/heads/staging', 'HEAD').code, 0);
    assert.equal(git('pack-refs', '--all').code, 0);
    assert.notEqual(git('branch', '-D', 'staging').code, 0);
  });
});
