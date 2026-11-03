import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  checkoutRoots,
  headSha,
  liveBranchFields,
  readCheckout,
  readTree,
  readWorktrees,
  repoRoots,
  shaAt,
  withProcessCwd,
  type HeadPass
} from '../../core/git';
import type { Session } from '../../core/model';
import { linkDir } from '../helpers';

/**
 * The structures git actually writes, built by hand. Every shape here was read
 * off a real repository first — see `docs/reference/git_state.md` — because the
 * whole module is a parse of files another program owns.
 */

const temp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'squadron-git-'));

/** An ordinary checkout: `.git` is a directory, and HEAD names a branch. */
async function checkout(dir: string, head = 'ref: refs/heads/main\n'): Promise<string> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), head);
  return dir;
}

/**
 * A linked worktree: the tree's `.git` is a one-line pointer, and its HEAD
 * lives in the admin directory beside a `commondir` back to the main `.git`.
 */
function worktree(
  main: string,
  tree: string,
  name: string,
  head = 'ref: refs/heads/side\n',
  pointer?: string
): Promise<string> {
  return linked(path.join(main, '.git'), tree, name, head, pointer);
}

/**
 * A bare repository — `git clone --bare`. The git directory *is* the repository:
 * HEAD sits in it, and there is no checkout above it to hold a `.git`.
 */
async function bare(dir: string, head = 'ref: refs/heads/main\n'): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'HEAD'), head);
  return dir;
}

/**
 * A submodule: the working directory's `.git` is a file naming the
 * superproject's `.git/modules/<name>`, which has no `commondir` — that absence
 * is what keeps it its own project.
 */
async function submodule(
  sup: string,
  name: string,
  head = 'ref: refs/heads/main\n'
): Promise<{ gitDir: string; tree: string }> {
  const gitDir = await bare(path.join(sup, '.git', 'modules', name), head);
  const tree = path.join(sup, name);
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);
  // What `git submodule add` writes, verbatim: the tree, relative to the git
  // directory, under `[core]` and below the keys git puts first.
  await fs.writeFile(
    path.join(gitDir, 'config'),
    ['[core]', '\tbare = false', `\tworktree = ${path.relative(gitDir, tree)}`, ''].join('\n')
  );
  return { gitDir, tree };
}

/** The same, under whichever git directory owns the worktree — bare or not. */
async function linked(
  gitDir: string,
  tree: string,
  name: string,
  head = 'ref: refs/heads/side\n',
  pointer?: string
): Promise<string> {
  const admin = path.join(gitDir, 'worktrees', name);
  await fs.mkdir(admin, { recursive: true });
  await fs.writeFile(path.join(admin, 'HEAD'), head);
  await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
  // git's own way back out to the tree: an absolute path to its `.git` file.
  await fs.writeFile(path.join(admin, 'gitdir'), `${path.join(tree, '.git')}\n`);
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${pointer ?? admin}\n`);
  return tree;
}

describe('readCheckout', () => {
  it('reads the branch of an ordinary checkout', async () => {
    const dir = await checkout(await temp());
    assert.deepEqual(await readCheckout(dir), { repoRoot: dir, branch: 'main' });
  });

  it('finds the repo from a directory deep inside it', async () => {
    const dir = await checkout(await temp());
    const deep = path.join(dir, 'src', 'webview');
    await fs.mkdir(deep, { recursive: true });
    assert.deepEqual(await readCheckout(deep), { repoRoot: dir, branch: 'main' });
  });

  it('keeps a branch name with slashes in it whole', async () => {
    const dir = await checkout(await temp(), 'ref: refs/heads/feat/paste-images\n');
    assert.equal((await readCheckout(dir))?.branch, 'feat/paste-images');
  });

  it('reports a detached head as a short sha', async () => {
    const dir = await checkout(await temp(), '3dc45c82f2334b9df73e8dd6df476b834292412b\n');
    assert.deepEqual(await readCheckout(dir), {
      repoRoot: dir,
      branch: '3dc45c8',
      detached: true
    });
  });

  it('reads a linked worktree as the repo it was cut from', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    assert.deepEqual(await readCheckout(tree), {
      repoRoot: main,
      branch: 'side',
      worktree: true
    });
  });

  it('folds a worktree that lives inside the repo it came from', async () => {
    // This project's own layout: `.worktrees/<name>`, under the repo.
    const main = await checkout(await temp());
    const tree = await worktree(main, path.join(main, '.worktrees', 'wt'), 'wt');
    assert.equal((await readCheckout(tree))?.repoRoot, main);
  });

  it('resolves a pointer written relative to the tree', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(
      main,
      path.join(root, 'side'),
      'side',
      'ref: refs/heads/side\n',
      path.join('..', 'main', '.git', 'worktrees', 'side')
    );
    assert.equal((await readCheckout(tree))?.repoRoot, main);
  });

  it('reads a worktree that is on a detached head of its own', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(
      main,
      path.join(root, 'side'),
      'side',
      '3dc45c82f2334b9df73e8dd6df476b834292412b\n'
    );
    assert.deepEqual(await readCheckout(tree), {
      repoRoot: main,
      branch: '3dc45c8',
      detached: true,
      worktree: true
    });
  });

  it('reads a worktree of a bare repository as that repository', async () => {
    // `git clone --bare repo.git` then `worktree add`: no main checkout exists,
    // so the git directory itself is the only path that stands for the repo.
    // Taking the directory above it names the folder the bare repo is kept in.
    const root = await temp();
    const repo = await bare(path.join(root, 'repo.git'));
    const tree = await linked(repo, path.join(root, 'feat'), 'feat', 'ref: refs/heads/feat\n');

    assert.deepEqual(await readCheckout(tree), {
      repoRoot: repo,
      branch: 'feat',
      worktree: true
    });
  });

  it('keeps two bare repositories kept side by side apart', async () => {
    const root = await temp();
    const one = await bare(path.join(root, 'one.git'));
    const two = await bare(path.join(root, 'two.git'));
    const first = await linked(one, path.join(root, 'a'), 'a');
    const second = await linked(two, path.join(root, 'b'), 'b');

    assert.equal((await readCheckout(first))?.repoRoot, one);
    assert.equal((await readCheckout(second))?.repoRoot, two);
  });

  it('takes a bare repo kept inside a checkout as the repo, not its host', async () => {
    // The one case that separates asking whether `<above>/.git` merely exists
    // from asking whether it is this worktree's own `commondir`: both answer
    // `outer` for the first question, and only the second is right.
    const outer = await checkout(await temp());
    const repo = await bare(path.join(outer, 'repo.git'));
    const tree = await linked(repo, path.join(outer, 'feat'), 'feat', 'ref: refs/heads/feat\n');

    assert.equal((await readCheckout(tree))?.repoRoot, repo);
  });

  it("reads a worktree cut from a submodule as that submodule's checkout", async () => {
    // `<super>/.git/modules/<name>` is the common directory, and the directory
    // above it holds every submodule of the superproject at once. `core.worktree`
    // is the way back to the one tree that is this submodule's.
    const root = await temp();
    const sup = await checkout(path.join(root, 'sup'));
    const { tree: sub } = await submodule(sup, 'sub');
    const tree = await linked(
      path.join(sup, '.git', 'modules', 'sub'),
      path.join(root, 'subwt'),
      'subwt'
    );

    assert.equal((await readCheckout(tree))?.repoRoot, sub);
  });

  it('falls back to the git directory when the tree that key names is gone', async () => {
    // `git submodule deinit` leaves the module directory and its `core.worktree`
    // behind, pointing at nothing.
    const root = await temp();
    const sup = await checkout(path.join(root, 'sup'));
    const { gitDir, tree: sub } = await submodule(sup, 'sub');
    await fs.rm(sub, { recursive: true, force: true });
    const tree = await linked(gitDir, path.join(root, 'subwt'), 'subwt');

    assert.equal((await readCheckout(tree))?.repoRoot, gitDir);
  });

  it('reads no worktree key out of a section that is not core', async () => {
    const root = await temp();
    const repo = await bare(path.join(root, 'repo.git'));
    await fs.writeFile(
      path.join(repo, 'config'),
      ['[core]', '\tbare = true', '[remote "origin"]', '\tworktree = ../elsewhere', ''].join('\n')
    );
    const tree = await linked(repo, path.join(root, 'feat'), 'feat', 'ref: refs/heads/feat\n');

    assert.equal((await readCheckout(tree))?.repoRoot, repo);
  });

  it('treats a submodule as its own project, not a second tree of the parent', async () => {
    // Same pointer shape, but into `.git/modules/<name>`, which has no
    // `commondir` — that absence is the whole distinction.
    const parent = await checkout(await temp());
    const { tree: sub } = await submodule(parent, 'vendor', 'ref: refs/heads/v2\n');

    assert.deepEqual(await readCheckout(sub), { repoRoot: sub, branch: 'v2' });
  });

  it('yields nothing for a directory in no repository at all', async () => {
    assert.equal(await readCheckout(await temp()), undefined);
  });

  it('yields nothing rather than climbing out of a directory that is gone', async () => {
    // The trap this guards: a worktree removed from inside its own repo. Walking
    // up from the dead path lands in the repo above and would put *its* branch
    // on a card whose tree no longer exists.
    const main = await checkout(await temp());
    const tree = await worktree(main, path.join(main, '.claude', 'worktrees', 'wt'), 'wt');
    assert.equal((await readCheckout(tree))?.branch, 'side');

    await fs.rm(tree, { recursive: true, force: true });
    assert.equal(await readCheckout(tree), undefined);
  });

  it('follows a branch that changes under a live session', async () => {
    const dir = await checkout(await temp());
    assert.equal((await readCheckout(dir))?.branch, 'main');

    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal((await readCheckout(dir))?.branch, 'other');
  });

  it('forgets a checkout whose git directory goes away, and finds it again', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    assert.equal((await readCheckout(tree))?.worktree, true);

    // `git worktree remove` takes the admin directory; the tree may linger.
    await fs.rm(path.join(main, '.git', 'worktrees'), { recursive: true, force: true });
    assert.equal(await readCheckout(tree), undefined);

    await worktree(main, tree, 'side');
    assert.equal((await readCheckout(tree))?.worktree, true);
  });

  it('finds a worktree cut into a directory it had already looked at', async () => {
    // The board bug this is for: `git worktree add .worktrees/<name>` into a
    // path a session already ran in. The first read climbs into the repo above,
    // and while that answer was memoed the card kept the repo's branch and the
    // tree headed a group of its own for as long as the panel lived.
    const main = await checkout(await temp());
    const tree = path.join(main, '.worktrees', 'wt');
    await fs.mkdir(tree, { recursive: true });
    assert.deepEqual(await readCheckout(tree), { repoRoot: main, branch: 'main' });

    await worktree(main, tree, 'wt');
    assert.deepEqual(await readCheckout(tree), {
      repoRoot: main,
      branch: 'side',
      worktree: true
    });
  });

  it('finds a repository initialised between a directory and its old repo', async () => {
    const main = await checkout(await temp());
    const deep = path.join(main, 'vendor', 'thing', 'src');
    await fs.mkdir(deep, { recursive: true });
    assert.equal((await readCheckout(deep))?.repoRoot, main);

    // Two levels above the directory asked about, so the nearer repository has
    // to win on a re-read — not only a `.git` at the cwd itself.
    const inner = await checkout(path.join(main, 'vendor', 'thing'), 'ref: refs/heads/own\n');
    assert.deepEqual(await readCheckout(deep), { repoRoot: inner, branch: 'own' });
  });

  it('says nothing about a checkout whose pointer cannot be read', async () => {
    const main = await checkout(await temp());
    const tree = path.join(main, '.claude', 'worktrees', 'wt');
    await fs.mkdir(tree, { recursive: true });
    await fs.writeFile(path.join(tree, '.git'), 'this is not a gitdir line\n');
    // Not the repo above it: a `.git` that cannot be read still marks a
    // checkout boundary, so the walk stops here rather than borrowing a branch.
    assert.equal(await readCheckout(tree), undefined);
  });
});

/**
 * The memo a refresh pass carries. Every assertion here changes HEAD under a
 * live directory, which is a `git checkout` typed in a terminal.
 */
describe('readCheckout in a pass', () => {
  it('reads HEAD again in the next pass, so a terminal checkout lands', async () => {
    const dir = await checkout(await temp());
    assert.equal((await readCheckout(dir, new Map()))?.branch, 'main');

    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal((await readCheckout(dir, new Map()))?.branch, 'other');
  });

  it('shares one read between two sessions in the same checkout', async () => {
    // The overlap this is for: N sessions in one worktree, each asked for
    // separately, each with a cwd of its own somewhere under the repo.
    const dir = await checkout(await temp());
    const deep = path.join(dir, 'src', 'webview');
    await fs.mkdir(deep, { recursive: true });
    const pass: HeadPass = new Map();
    assert.equal((await readCheckout(dir, pass))?.branch, 'main');

    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal((await readCheckout(deep, pass))?.branch, 'main');
  });

  it('keeps a worktree and the repo it was cut from apart in one pass', async () => {
    // Two git directories, not one — the admin directory under
    // `.git/worktrees/<name>` is what the key has to be.
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    const pass: HeadPass = new Map();
    assert.equal((await readCheckout(main, pass))?.branch, 'main');
    assert.equal((await readCheckout(tree, pass))?.branch, 'side');
  });

  it('yields nothing for a checkout with no HEAD, twice in a pass', async () => {
    const dir = await checkout(await temp());
    await fs.rm(path.join(dir, '.git', 'HEAD'));
    const pass: HeadPass = new Map();
    assert.equal(await readCheckout(dir, pass), undefined);
    assert.equal(await readCheckout(dir, pass), undefined);
  });
});

describe('readWorktrees', () => {
  it('lists the main checkout and every linked worktree', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const one = await worktree(main, path.join(root, 'one'), 'one', 'ref: refs/heads/one\n');
    const two = await worktree(main, path.join(root, 'two'), 'two', 'ref: refs/heads/two\n');

    const trees = await readWorktrees(main);
    assert.deepEqual(
      [...trees].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: main, main: true, branch: 'main' },
        { path: one, branch: 'one' },
        { path: two, branch: 'two' }
      ].sort((a, b) => a.path.localeCompare(b.path))
    );
  });

  it('reports a worktree on a detached head', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    await worktree(
      main,
      path.join(root, 'side'),
      'side',
      '3dc45c82f2334b9df73e8dd6df476b834292412b\n'
    );

    const side = (await readWorktrees(main)).find((tree) => !tree.main);
    assert.deepEqual(side, {
      path: path.join(root, 'side'),
      branch: '3dc45c8',
      detached: true
    });
  });

  it('yields the main checkout alone when the repo has no worktrees directory', async () => {
    const main = await checkout(await temp());
    assert.deepEqual(await readWorktrees(main), [{ path: main, main: true, branch: 'main' }]);
  });

  it('drops an admin directory whose tree has been deleted', async () => {
    // `rm -rf` of a tree leaves its admin directory behind, so the listing names
    // a directory that is not there — `docs/reference/git_state.md`.
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    await fs.rm(tree, { recursive: true, force: true });

    assert.deepEqual(await readWorktrees(main), [{ path: main, main: true, branch: 'main' }]);
  });

  it('lists the linked trees of a bare repository, and no main checkout', async () => {
    const root = await temp();
    const repo = await bare(path.join(root, 'repo.git'));
    const tree = await linked(repo, path.join(root, 'feat'), 'feat', 'ref: refs/heads/feat\n');

    assert.deepEqual(await readWorktrees(repo), [{ path: tree, branch: 'feat' }]);
  });

  it('lists a submodule, whose git directory is not inside it', async () => {
    // The `.git` file used to break the `HEAD` read and answer with nothing.
    const parent = await checkout(await temp());
    const { tree } = await submodule(parent, 'vendor', 'ref: refs/heads/v2\n');

    assert.deepEqual(await readWorktrees(tree), [{ path: tree, main: true, branch: 'v2' }]);
  });

  it('yields nothing at all for a directory that is not a repository', async () => {
    assert.deepEqual(await readWorktrees(await temp()), []);
  });
});

describe('shaAt', () => {
  const SHA = '3dc45c82f2334b9df73e8dd6df476b834292412b';

  /** A loose ref: one file per branch, the sha and a newline. */
  async function loose(repo: string, branch: string, sha: string): Promise<void> {
    const file = path.join(repo, '.git', 'refs', 'heads', branch);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${sha}\n`);
  }

  it('reads a loose ref', async () => {
    const main = await checkout(await temp());
    await loose(main, 'main', SHA);
    assert.equal(await shaAt({ repoRoot: main, branch: 'main' }), SHA);
  });

  it('falls back to packed-refs, past the comment and the peeled lines', async () => {
    // The shape `git gc` leaves: a header comment, one line per ref sorted, and
    // a `^`-peeled line under an annotated tag.
    const main = await checkout(await temp());
    await fs.writeFile(
      path.join(main, '.git', 'packed-refs'),
      [
        '# pack-refs with: peeled fully-peeled sorted ',
        `1111111111111111111111111111111111111111 refs/tags/v1`,
        `^${SHA}`,
        `${SHA} refs/heads/main`,
        ''
      ].join('\n')
    );
    assert.equal(await shaAt({ repoRoot: main, branch: 'main' }), SHA);
  });

  it('takes a branch name with regex metacharacters in it literally', async () => {
    // `feat/a+b` is a legal branch name, and unescaped it is a pattern that
    // matches `feat/aab` — the line above the one asked for, and sorted there.
    const main = await checkout(await temp());
    await fs.writeFile(
      path.join(main, '.git', 'packed-refs'),
      [
        `1111111111111111111111111111111111111111 refs/heads/feat/aab`,
        `${SHA} refs/heads/feat/a+b`,
        ''
      ].join('\n')
    );
    assert.equal(await shaAt({ repoRoot: main, branch: 'feat/a+b' }), SHA);
  });

  it('reads a ref from a bare repository, whose root is the git directory', async () => {
    const repo = await bare(path.join(await temp(), 'repo.git'));
    const file = path.join(repo, 'refs', 'heads', 'main');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${SHA}\n`);

    assert.equal(await shaAt({ repoRoot: repo, branch: 'main' }), SHA);
  });

  it('reads a ref through a `.git` file, which is what a submodule has', async () => {
    // What lets the diff watcher follow a submodule's branch — `src/host/diff.ts`.
    const parent = await checkout(await temp());
    const { gitDir, tree } = await submodule(parent, 'vendor');
    const file = path.join(gitDir, 'refs', 'heads', 'main');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${SHA}\n`);

    assert.equal(await shaAt({ repoRoot: tree, branch: 'main' }), SHA);
  });

  it('yields nothing for a branch neither file names', async () => {
    const main = await checkout(await temp());
    await loose(main, 'main', SHA);
    assert.equal(await shaAt({ repoRoot: main, branch: 'gone' }), undefined);
  });
});

describe('repoRoots', () => {
  it('maps worktrees, and nothing else', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    const loose = await temp();
    // A package inside the repo also has a root above it. Folding on that would
    // put every app in a monorepo under one heading, which is not what a
    // worktree fold is for.
    const pkg = path.join(main, 'packages', 'api');
    await fs.mkdir(pkg, { recursive: true });

    const roots = await repoRoots([main, tree, loose, pkg]);
    assert.deepEqual([...roots], [[tree, main]]);
  });
});

describe('checkoutRoots', () => {
  it('maps every checkout to its repository, whatever kind it is', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    const loose = await temp();
    const pkg = path.join(main, 'packages', 'api');
    await fs.mkdir(pkg, { recursive: true });

    const roots = await checkoutRoots([main, tree, loose, pkg]);
    // The plain checkout is the entry `repoRoots` drops, and the only one a
    // window is likely to be open on.
    assert.equal(roots.get(main), main);
    assert.equal(roots.get(tree), main);
    assert.equal(roots.get(pkg), main);
    assert.equal(roots.get(loose), undefined);
  });
});

describe('liveBranchFields', () => {
  it('stamps the live chip and leaves grouping fields off', () => {
    assert.deepEqual(
      liveBranchFields({ repoRoot: '/repo', branch: 'side', detached: false, worktree: true }),
      { branch: 'side', detached: false, liveWorktree: true }
    );
    assert.deepEqual(liveBranchFields({ repoRoot: '/repo', branch: 'main' }), {
      branch: 'main',
      detached: undefined,
      liveWorktree: false
    });
    assert.equal(liveBranchFields({ repoRoot: '/repo' }), undefined);
  });
});

/** Origin vs live cwd only — the rest is noise for the overlay. */
function sess(over: Partial<Session> & Pick<Session, 'cwd'>): Session {
  return {
    pid: 1,
    sessionId: 's',
    name: 'n',
    status: 'idle',
    hasCommand: false,
    startedAt: 0,
    updatedAt: 0,
    transcript: '',
    ...over
  };
}

describe('withProcessCwd', () => {
  it('leaves the session unchanged when process cwd is unset', async () => {
    const session = sess({ cwd: '/repo', liveCwd: '/repo/.worktrees/wt' });
    const next = await withProcessCwd(session, undefined);
    assert.equal(next, session);
    assert.equal(next.liveCwd, '/repo/.worktrees/wt');
  });

  it('clears liveCwd when process cwd is the origin', async () => {
    const origin = await temp();
    const session = sess({ cwd: origin, liveCwd: path.join(origin, 'claimed') });
    const next = await withProcessCwd(session, origin);
    assert.equal(next.cwd, origin);
    assert.equal(next.liveCwd, undefined);
  });

  it('sets liveCwd when process cwd is a different directory', async () => {
    const origin = await temp();
    const live = await temp();
    const next = await withProcessCwd(sess({ cwd: origin }), live);
    assert.equal(next.cwd, origin);
    assert.equal(next.liveCwd, live);
  });

  it('does not treat /var vs /private/var as a move', async () => {
    // macOS tmpdir is `/var/folders/…`; `lsof` prints `/private/var/folders/…`.
    // String equality used to pin a phantom liveCwd for the life of a session
    // (`live.test.ts`, ee23278).
    const origin = await temp();
    const resolved = await fs.realpath(origin);
    const session = sess({ cwd: origin, liveCwd: resolved });
    const next = await withProcessCwd(session, resolved);
    assert.equal(next.liveCwd, undefined);
    assert.equal(next.cwd, origin);
  });

  it('keeps one liveCwd when frames and process already agree', async () => {
    const origin = await temp();
    const live = await temp();
    const next = await withProcessCwd(sess({ cwd: origin, liveCwd: live }), live);
    assert.equal(next.liveCwd, live);
    assert.equal(next.cwd, origin);
  });

  it('drops a frame-claimed move that realpath says is the origin', async () => {
    const origin = await temp();
    const link = path.join(await temp(), 'link');
    await linkDir(origin, link);
    const next = await withProcessCwd(sess({ cwd: origin, liveCwd: link }), link);
    assert.equal(next.liveCwd, undefined);
  });

  it('does not treat a missing path as a move', async () => {
    const origin = await temp();
    const session = sess({ cwd: origin, liveCwd: '/repo/.worktrees/wt' });
    const next = await withProcessCwd(session, path.join(origin, 'gone'));
    assert.equal(next, session);
    assert.equal(next.liveCwd, '/repo/.worktrees/wt');
  });
});

describe('readTree', () => {
  it('uses one capture identity through a symlink without changing board grouping', async () => {
    const dir = await checkout(await fs.realpath(await temp()));
    const alias = path.join(await temp(), 'alias');
    await linkDir(dir, alias);
    assert.deepEqual(await readTree(alias), await readTree(dir));
    assert.equal((await readCheckout(alias))?.repoRoot, alias);
  });

  it('answers the checkout itself, with the git directory that serves it', async () => {
    const dir = await checkout(await temp());
    assert.deepEqual(await readTree(dir), {
      treeRoot: await fs.realpath(dir),
      gitDir: path.join(await fs.realpath(dir), '.git')
    });
  });

  it('answers the checkout root for a directory inside it, not that directory', async () => {
    const dir = await checkout(await temp());
    const deep = path.join(dir, 'src', 'core');
    await fs.mkdir(deep, { recursive: true });
    assert.equal((await readTree(deep))?.treeRoot, await fs.realpath(dir));
  });

  /**
   * The whole reason this exists beside `readCheckout`. Two worktrees of one
   * repository share a `repoRoot` — that is what folds their cards into one
   * group — and share no working tree at all, so a tenancy key built on
   * `repoRoot` would call them the same tree and contest every turn in both.
   */
  it('tells two linked worktrees of one repo apart, where repoRoot cannot', async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const one = await worktree(main, path.join(root, 'one'), 'one');
    const two = await worktree(main, path.join(root, 'two'), 'two');

    assert.equal((await readCheckout(one))?.repoRoot, main);
    assert.equal((await readCheckout(two))?.repoRoot, main);

    const [a, b] = [await readTree(one), await readTree(two)];
    assert.equal(a?.treeRoot, await fs.realpath(one));
    assert.equal(b?.treeRoot, await fs.realpath(two));
    assert.notEqual(a?.gitDir, b?.gitDir);
  });

  /** This project's own layout: the worktree lives under the repo it came from,
   *  so the walk must stop at the tree's own `.git` pointer and not climb. */
  it('does not climb out of a worktree that lives inside its own repo', async () => {
    const main = await checkout(await temp());
    const tree = await worktree(main, path.join(main, '.worktrees', 'wt'), 'wt');
    assert.equal((await readTree(tree))?.treeRoot, await fs.realpath(tree));
  });

  it('answers nothing outside a repository, and nothing for a directory that is gone', async () => {
    assert.equal(await readTree(await temp()), undefined);
    assert.equal(await readTree(path.join(await temp(), 'never')), undefined);
    assert.equal(await readTree(''), undefined);
  });
});

describe('headSha', () => {
  it('reads a branch HEAD through to the sha the ref file holds', async () => {
    const dir = await checkout(await temp());
    await fs.mkdir(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
    assert.equal(await headSha({ treeRoot: dir, gitDir: path.join(dir, '.git') }), 'a'.repeat(40));
  });

  it('reads a detached HEAD as the sha it already is', async () => {
    const dir = await checkout(await temp(), `${'b'.repeat(40)}\n`);
    assert.equal(await headSha({ treeRoot: dir, gitDir: path.join(dir, '.git') }), 'b'.repeat(40));
  });

  it('falls back to packed-refs, which is where a fresh clone keeps them', async () => {
    const dir = await checkout(await temp());
    await fs.writeFile(
      path.join(dir, '.git', 'packed-refs'),
      [
        '# pack-refs with: peeled fully-peeled sorted',
        `${'c'.repeat(40)} refs/heads/main`,
        ''
      ].join('\n')
    );
    assert.equal(await headSha({ treeRoot: dir, gitDir: path.join(dir, '.git') }), 'c'.repeat(40));
  });

  /**
   * A linked worktree keeps its own HEAD in its admin directory and shares
   * `refs/heads` with the repository, so the read has to hop `commondir` — the
   * admin directory has no `refs` of its own.
   */
  it("reads a linked worktree's own HEAD against the repo's shared refs", async () => {
    const root = await temp();
    const main = await checkout(path.join(root, 'main'));
    const tree = await worktree(main, path.join(root, 'side'), 'side');
    await fs.mkdir(path.join(main, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(main, '.git', 'refs', 'heads', 'side'), `${'d'.repeat(40)}\n`);

    const at = await readTree(tree);
    assert.ok(at);
    assert.equal(await headSha(at), 'd'.repeat(40));
  });

  it('answers nothing for a repository with no commit yet', async () => {
    const dir = await checkout(await temp());
    assert.equal(await headSha({ treeRoot: dir, gitDir: path.join(dir, '.git') }), undefined);
  });
});
