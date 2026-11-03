import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { showAtHead, showAtTree } from '../../core/git_show';

/**
 * Against real repositories, unlike `git.test.ts` next door — the module runs
 * git rather than parsing its files, so a hand-built `.git` would prove nothing
 * about what `git show` resolves.
 */

const run = promisify(execFile);

/**
 * `GIT_*` stripped, per `src/test/AGENTS.md`. The gate runs from the pre-commit
 * hook, which exports `GIT_DIR` and `GIT_INDEX_FILE` pointing at *this*
 * checkout, and they beat `-C` — so without this the temp repo's commands
 * silently read the repository being committed.
 */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

/**
 * A repository with one commit. The realpath matters: `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`, and `git worktree
 * add` records the resolved form — the trap `src/test/AGENTS.md` records for the
 * smoke fixtures, and the worktree case below turns on it.
 */
async function repo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-show-')));
  const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'at head\n');
  await fs.mkdir(path.join(dir, 'src', 'core'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'core', 'deep.txt'), 'deep at head\n');
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

describe('showAtHead', () => {
  it('reads a tracked file as HEAD has it, not as the tree has it', async () => {
    const dir = await repo();
    const file = path.join(dir, 'tracked.txt');
    await fs.writeFile(file, 'changed in the tree\n');
    assert.equal(await showAtHead(file), 'at head\n');
  });

  it('resolves a file in a subdirectory', async () => {
    // The case a repo-root-relative path gets wrong: `git show HEAD:<path>`
    // resolves from the root, so only asking in the file's own directory works.
    const dir = await repo();
    assert.equal(await showAtHead(path.join(dir, 'src', 'core', 'deep.txt')), 'deep at head\n');
  });

  it('reads a linked worktree’s own HEAD, not the repo it was cut from', async () => {
    const dir = await repo();
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const tree = path.join(dir, 'wt');
    await git('worktree', 'add', '-b', 'side', tree);
    await fs.writeFile(path.join(tree, 'tracked.txt'), 'side at head\n');
    await run('git', ['add', '-A'], { cwd: tree, env: CLEAN });
    await run('git', ['commit', '-m', 'side'], { cwd: tree, env: CLEAN });

    // `repoRoot` would have named `dir`, still on `main`, and answered 'at head\n'.
    assert.equal(await showAtHead(path.join(tree, 'tracked.txt')), 'side at head\n');
  });

  it('reads a file larger than execFile’s 1 MB default buffer', async () => {
    // The one way this module could lie. Node's default `maxBuffer` is 1 MB and
    // overrunning it *rejects* rather than truncates, so without the explicit
    // ceiling a large before-image comes back empty — which the diff then draws
    // as a file wholly added. A regression that drops `maxBuffer` fails here.
    const dir = await repo();
    const file = path.join(dir, 'big.txt');
    const body = 'a line of some length to make this add up\n'.repeat(40_000);
    assert.ok(body.length > 1024 * 1024, 'fixture must exceed the 1 MB default');
    await fs.writeFile(file, body);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('add', 'big.txt');
    await git('commit', '-m', 'big');
    await fs.writeFile(file, 'truncated in the tree\n');
    assert.equal(await showAtHead(file), body);
  });

  it('still reads a tracked file that has been deleted from the tree', async () => {
    // The left-hand side of the deleted-file diff: HEAD still has it, which is
    // the whole reason that tab has anything to show.
    const dir = await repo();
    const file = path.join(dir, 'tracked.txt');
    await fs.rm(file);
    assert.equal(await showAtHead(file), 'at head\n');
  });

  it('reads HEAD rather than the index for a file staged mid-session', async () => {
    const dir = await repo();
    const file = path.join(dir, 'tracked.txt');
    await fs.writeFile(file, 'staged, not committed\n');
    await run('git', ['add', 'tracked.txt'], { cwd: dir, env: CLEAN });
    assert.equal(await showAtHead(file), 'at head\n');
  });

  it('ignores an inherited GIT_DIR, which would otherwise beat -C', async () => {
    // How this was found: git exports `GIT_DIR` and `GIT_INDEX_FILE` into every
    // hook, so the pre-commit gate ran these reads against the checkout being
    // committed and the tracked-file cases came back empty. `CLEAN` above only
    // protects the fixture's *own* git calls — the module under test spawns its
    // own, and had to be taught the same thing.
    const dir = await repo();
    // A different body under the same name, or this passes either way: both
    // repos would answer 'at head\n' and the wrong one would look right.
    const elsewhere = await repo();
    await fs.writeFile(path.join(elsewhere, 'tracked.txt'), 'the wrong repository\n');
    await run('git', ['add', '-A'], { cwd: elsewhere, env: CLEAN });
    await run('git', ['commit', '-m', 'decoy'], { cwd: elsewhere, env: CLEAN });

    const was = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    try {
      assert.equal(await showAtHead(path.join(dir, 'tracked.txt')), 'at head\n');
    } finally {
      if (was === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = was;
    }
  });

  it('yields empty for a relative path rather than reading its own cwd', async () => {
    // `dirname('x.txt')` is `.`, so this would ask whatever directory the
    // extension host happens to be in and could answer with a *different* file
    // of the same basename — content, and wrong, where every other failure here
    // is content-free.
    assert.equal(await showAtHead('tracked.txt'), '');
  });

  it('yields empty for an untracked file, which is wholly added', async () => {
    const dir = await repo();
    const file = path.join(dir, 'fresh.txt');
    await fs.writeFile(file, 'never committed\n');
    assert.equal(await showAtHead(file), '');
  });

  it('yields empty for a directory that is no repository at all', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-show-bare-'));
    await fs.writeFile(path.join(dir, 'loose.txt'), 'no repo here\n');
    assert.equal(await showAtHead(path.join(dir, 'loose.txt')), '');
  });

  it('yields empty for a path whose directory does not exist', async () => {
    // `-C` on a missing directory is a spawn-time failure rather than a git
    // one, and the contract has to be the same for both.
    const dir = await repo();
    assert.equal(await showAtHead(path.join(dir, 'gone', 'file.txt')), '');
  });
});

describe('showAtTree', () => {
  it('keeps captured content after HEAD moves, including literal names and deleted parents', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const literal = path.join(dir, '..notes');
    const globName = path.join(dir, '[notes].txt');
    const large = path.join(dir, 'large.txt');
    const body = 'snapshot beyond the default buffer\n'.repeat(40_000);
    assert.ok(body.length > 1024 * 1024);
    await fs.writeFile(literal, 'literal baseline\n');
    await fs.writeFile(globName, 'literal bracket baseline\n');
    await fs.writeFile(path.join(dir, 'n.txt'), 'glob decoy\n');
    await fs.writeFile(large, body);
    await git('add', '-A');
    const tree = (await git('write-tree')).stdout.trim();
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'new HEAD\n');
    await fs.writeFile(literal, 'new literal HEAD\n');
    await git('add', '-A');
    await git('commit', '-m', 'later HEAD');
    await fs.rm(path.join(dir, 'src'), { recursive: true });

    assert.equal(await showAtTree(dir, tree, path.join(dir, 'tracked.txt')), 'at head\n');
    assert.equal(await showAtTree(dir, tree, literal), 'literal baseline\n');
    assert.equal(await showAtTree(dir, tree, globName), 'literal bracket baseline\n');
    assert.equal(await showAtTree(dir, tree, large), body);
    assert.equal(
      await showAtTree(dir, tree, path.join(dir, 'src', 'core', 'deep.txt')),
      'deep at head\n'
    );
  });

  it('resolves empty blobs and absent paths as empty even after HEAD gains content', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const empty = path.join(dir, 'empty.txt');
    const added = path.join(dir, 'later', 'added.txt');
    await fs.writeFile(empty, '');
    await git('add', '-A');
    const tree = (await git('write-tree')).stdout.trim();
    await fs.mkdir(path.dirname(added));
    await fs.writeFile(empty, 'now nonempty\n');
    await fs.writeFile(added, 'now tracked\n');
    await git('add', '-A');
    await git('commit', '-m', 'add later content');

    assert.equal(await showAtTree(dir, tree, empty), '');
    assert.equal(await showAtTree(dir, tree, added), '');
    assert.equal(await showAtHead(empty), 'now nonempty\n');
    assert.equal(await showAtHead(added), 'now tracked\n');
  });

  it('reports invalid, unavailable and non-tree baselines separately from empty content', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const tree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim();
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
    const blob = (await git('rev-parse', 'HEAD:tracked.txt')).stdout.trim();
    const file = path.join(dir, 'tracked.txt');
    const cases: [string, string, string][] = [
      [dir, '', file],
      [dir, '--help', file],
      [dir, 'HEAD', file],
      [dir, 'a'.repeat(39), file],
      [dir, 'a'.repeat(65), file],
      [dir, '0'.repeat(40), file],
      [dir, commit, file],
      [dir, blob, file],
      ['relative-root', tree, file],
      [dir, tree, 'tracked.txt'],
      [dir, tree, path.join(dir, '..', 'outside.txt')],
      [dir, tree, path.join(`${dir}-sibling`, 'tracked.txt')],
      [dir, tree, path.join(dir, 'src')],
      [path.join(dir, 'missing-root'), tree, path.join(dir, 'missing-root', 'tracked.txt')]
    ];
    for (const [root, base, absPath] of cases) {
      assert.equal(
        await showAtTree(root, base, absPath),
        undefined,
        JSON.stringify({ root, base, absPath })
      );
    }
  });

  it('reads a linked worktree baseline with inherited Git routing variables stripped', async (t) => {
    const dir = await repo();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    const worktree = path.join(dir, 'wt');
    await git('worktree', 'add', '-b', 'side', worktree);
    const file = path.join(worktree, 'tracked.txt');
    await fs.writeFile(file, 'worktree snapshot\n');
    await run('git', ['add', '-A'], { cwd: worktree, env: CLEAN });
    const tree = (await run('git', ['write-tree'], { cwd: worktree, env: CLEAN })).stdout.trim();
    await fs.writeFile(file, 'live after snapshot\n');
    const decoy = await repo();
    t.after(() => fs.rm(decoy, { recursive: true, force: true }));
    const wasDir = process.env.GIT_DIR;
    const wasIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_DIR = path.join(decoy, '.git');
    process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index');
    try {
      assert.equal(await showAtTree(worktree, tree, file), 'worktree snapshot\n');
    } finally {
      if (wasDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = wasDir;
      if (wasIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = wasIndex;
    }
  });
});
