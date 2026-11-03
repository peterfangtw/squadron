import * as fs from 'fs/promises';
import * as path from 'path';
import type { Session } from './model';

/**
 * Where a working directory sits in git, read from git's own files rather than
 * by running it: `git rev-parse` would be a process per session per poll.
 *
 * Every shape here was read off real repositories before it was coded against,
 * and the record is `docs/reference/git_state.md`.
 */

export type Checkout = {
  /**
   * The main checkout's root. A linked worktree reports the repo it was cut
   * from, which is what folds its sessions into that repo's group. Where the
   * repository's git directory does not sit inside a checkout — a bare repo, a
   * submodule's `.git/modules/<name>` — there is no such root, and it reports
   * that git directory instead as the only path that stands for the repository.
   * A submodule is the exception that reads its way back: its git directory
   * names the checkout in `core.worktree`, so both it and the worktrees cut from
   * it report that one tree.
   */
  repoRoot: string;
  /** What HEAD names: a branch, or a short sha when `detached`. */
  branch?: string;
  detached?: boolean;
  /** A linked worktree — `git worktree add` — not the repo's own tree. */
  worktree?: boolean;
};

type Location = { gitDir: string; treeRoot: string; repoRoot: string; worktree?: boolean };

/**
 * **Nothing here remembers where a directory sits in git, by design.** A memo
 * per path of the walk and the `commondir` hop outlives its answer: after `git
 * worktree add` into a directory already looked at, it keeps the repo the first
 * walk climbed into, so the card wears that repo's branch and the tree heads a
 * group of its own for the panel's life. `git init` in a watched subdirectory,
 * and a checkout replaced in place, are the same shape.
 *
 * Every re-check cheap enough to fix that costs what the walk costs, because it
 * *is* the walk: the stats it would redo are the stats the walk does. Measured,
 * 12 sessions in one poll on a warm cache, a memo kept honest that way runs 45us
 * ahead of walking and no more — 78us against 120us where the cwd is the
 * checkout, 221us against 268us two levels below it. The poll is 3000ms
 * (`POLL_MS`, `host/panel.ts`). Any directory in no repository already walks to
 * the filesystem root every poll, and this walk stops at the checkout.
 *
 * HEAD has its own memo, `HeadPass`, which lives for one refresh pass.
 */

/**
 * One refresh pass's HEAD reads, keyed on the git directory read. Created by
 * whoever owns the pass and dropped with it: the next poll is a new map and
 * reads HEAD again, so a `git checkout` typed in a terminal reaches the card.
 *
 * The promise, not the value: a pass fans out over its sessions at once, so
 * every caller for one repository arrives before the first read has resolved.
 */
export type HeadPass = Map<string, Promise<string | undefined>>;

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function stat(file: string) {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}

/** `ref: refs/heads/<branch>`, or the commit itself when HEAD is detached. */
function parseHead(raw: string): { branch?: string; detached?: boolean } {
  const head = raw.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (ref) {
    // Branch names carry slashes — `feat/paste-images` — so this takes the
    // whole remainder and never splits it.
    return { branch: ref };
  }
  // Shown short, the way git prints it. Any hex length, because a repository
  // can be sha256 and then the sha is 64 characters rather than 40.
  return /^[0-9a-f]{7,}$/.test(head) ? { branch: head.slice(0, 7), detached: true } : {};
}

/**
 * Whether this directory is itself a checkout, and what serves it.
 *
 * An unreadable `.git` still answers "yes" (see `gitDirAt`). Climbing past would
 * hand the card the branch of whatever repo lies above — which for this
 * project, whose worktrees live at `.worktrees/<name>`, is the repo the worktree
 * came from.
 */
async function checkoutAt(dir: string): Promise<Location | undefined> {
  const gitDir = await gitDirAt(dir);
  if (!gitDir) {
    return undefined;
  }

  // `commondir` is git's own way back to the main `.git`, and the thing that
  // tells the two pointers apart: a worktree has one, a submodule does not.
  // Reading it beats assuming the `<main>/.git/worktrees/<name>` shape, and a
  // submodule stays its own project rather than folding into the superproject.
  const common = await readText(path.join(gitDir, 'commondir'));
  if (!common) {
    return { gitDir, treeRoot: dir, repoRoot: dir };
  }
  const commonDir = path.resolve(gitDir, common.trim());

  // The directory above the common git directory is the main checkout *where
  // there is one*, and a worktree's sessions group under it. A bare repo's
  // worktrees and a submodule's have none, and the dirname is then a stranger
  // they share (`docs/reference/git_state.md`).
  //
  // So `above` is the checkout only when its own git directory is this
  // worktree's `commondir`. A plain `stat` for `<above>/.git` fails one case: a
  // bare repo kept *inside* a checkout, where it answers with the enclosing
  // repo. Otherwise the common git directory stands for the repository: stable,
  // distinct per repository, and carrying no `.git` of its own, which is how the
  // readers below know there is no main checkout to report.
  const above = path.dirname(commonDir);
  if ((await gitDirAt(above)) === commonDir) {
    return { gitDir, treeRoot: dir, repoRoot: above, worktree: true };
  }
  return {
    gitDir,
    treeRoot: dir,
    repoRoot: (await coreWorktree(commonDir)) ?? commonDir,
    worktree: true
  };
}

/**
 * The checkout a git directory was told to serve, from `core.worktree` in its
 * `config` — for the git directories that do not sit inside one.
 *
 * A submodule's `.git/modules/<name>` names its tree this way and git writes the
 * key itself: `worktree = ../../../vendor`, relative to the git directory, read
 * 2026-08-21 off `git submodule add` (git 2.39). Without it a submodule's own
 * checkout and the worktrees cut from it head two groups for one repository.
 * A bare repo has no such key — `bare = true` instead — and `--separate-git-dir`
 * writes neither, so both fall through to the git directory itself.
 *
 * Only where the tree is still there: `git submodule deinit` leaves the module
 * directory and this key behind, and a root nothing is at would group cards
 * under a directory the reader cannot open.
 */
async function coreWorktree(gitDir: string): Promise<string | undefined> {
  const config = await readText(path.join(gitDir, 'config'));
  if (config === undefined) {
    return undefined;
  }
  // Sections and keys are both case-insensitive, and `[remote "origin"]` has to
  // read as `remote` — the name ends at the first space or bracket.
  let core = false;
  for (const line of config.split('\n')) {
    const section = /^\s*\[([^\]\s]+)/.exec(line)?.[1];
    if (section !== undefined) {
      core = section.toLowerCase() === 'core';
      continue;
    }
    const value = core ? /^\s*worktree\s*=\s*(.*?)\s*$/i.exec(line)?.[1] : undefined;
    if (value === undefined || value === '') {
      continue;
    }
    // Quoted when the path has trailing space or an escape in it; nothing else
    // here needs unescaping, and a path that does is left as git wrote it.
    const tree = path.resolve(gitDir, value.replace(/^"(.*)"$/, '$1'));
    return (await stat(tree))?.isDirectory() ? tree : undefined;
  }
  return undefined;
}

/**
 * The git directory a directory owns, without the `commondir` hop — so a linked
 * worktree answers with its own admin directory rather than with the repo's.
 *
 * Nothing, and only nothing, means "not a checkout": an unreadable or
 * unparseable `.git` still answers with itself, because it marks the boundary
 * and the walk must stop at it. What is reported for it stops downstream
 * instead — the HEAD read in `readCheckout` is then a path under a regular file,
 * and it fails.
 */
async function gitDirAt(dir: string): Promise<string | undefined> {
  const dot = path.join(dir, '.git');
  const info = await stat(dot);
  if (!info) {
    return undefined;
  }
  if (info.isDirectory()) {
    return dot;
  }
  // A linked worktree replaces `.git` with a one-line pointer — and so does a
  // submodule, at `.git/modules/<name>`.
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dot)) ?? '')?.[1];
  return pointer ? path.resolve(dir, pointer) : dot;
}

async function locate(dir: string): Promise<Location | undefined> {
  for (let at = dir; ;) {
    const location = await checkoutAt(at);
    if (location) {
      return location;
    }
    const up = path.dirname(at);
    if (up === at) {
      return undefined;
    }
    at = up;
  }
}

/**
 * The checkout a working directory sits in, or nothing at all — outside a
 * repository, or once the checkout has gone away under a running session. The
 * caller shows less rather than showing something untrue.
 */
export async function readCheckout(
  cwd: string,
  pass: HeadPass = new Map()
): Promise<Checkout | undefined> {
  if (!cwd) {
    return undefined;
  }
  const key = path.resolve(cwd);
  // The working directory itself, before the walk: a directory that is gone
  // must not climb into the repo above it and report its branch.
  if (!(await stat(key))?.isDirectory()) {
    return undefined;
  }

  const location = await locate(key);
  if (!location) {
    return undefined;
  }

  const memo = pass.get(location.gitDir) ?? readText(path.join(location.gitDir, 'HEAD'));
  pass.set(location.gitDir, memo);
  const head = await memo;
  if (head === undefined) {
    // The checkout went away under a live session — a worktree whose admin
    // directory was removed reads as a boundary with no HEAD.
    return undefined;
  }

  return {
    repoRoot: location.repoRoot,
    ...(location.worktree ? { worktree: true } : {}),
    ...parseHead(head)
  };
}

/** One live working tree: the directory a session's writes actually land in. */
export type Tree = { treeRoot: string; gitDir: string };

const captureAliases = new Map<string, Set<string>>();
const captureRoots = new Map<string, string>();

/** Root aliases proved by readTree, without following a possibly deleted leaf. */
export function treeAliases(treeRoot: string): readonly string[] {
  return [...(captureAliases.get(captureRoots.get(treeRoot) ?? treeRoot) ?? [])];
}

export function fileIdentity(
  treeRoot: string,
  file: string,
  aliases: readonly string[] = []
): string {
  const canonical = captureRoots.get(treeRoot) ?? treeRoot;
  const resolved = path.resolve(file);
  for (const root of [canonical, treeRoot, ...aliases, ...treeAliases(canonical)]) {
    const relative = path.relative(root, resolved);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return path.join(canonical, relative);
    }
  }
  return resolved;
}

/**
 * The working tree a directory sits in — **not** the repository it belongs to.
 *
 * `readCheckout`'s `repoRoot` is the *main* checkout's root even for a linked
 * worktree. That makes it the wrong answer to "may these two sessions overwrite
 * each other": two worktrees of one repository share a `repoRoot` and share no
 * working tree, and keying tenancy on it would call every turn in both
 * contested. This answer is the directory whose `.git` the walk stopped at.
 *
 * `gitDir` rides along because it is unique per working tree (a linked
 * worktree's is its own `worktrees/<name>` admin directory) and is the only
 * place a caller may put a file that is neither in the tree nor shared with the
 * repo's other trees.
 *
 * Separate from `readCheckout` rather than a field on `Checkout`. The dock's
 * poll reaches it when a transcript read has windows to fold: `readWindows`
 * calls `readExecution`, which calls this.
 */
export async function readTree(cwd: string): Promise<Tree | undefined> {
  if (!cwd) {
    return undefined;
  }
  const key = path.resolve(cwd);
  // The same guard `readCheckout` opens with, and for the same reason: a
  // directory that is gone must not climb into the repo above it.
  if (!(await stat(key))?.isDirectory()) {
    return undefined;
  }
  const location = await locate(key);
  if (!location) return undefined;
  try {
    const [treeRoot, gitDir] = await Promise.all([
      fs.realpath(location.treeRoot),
      fs.realpath(location.gitDir)
    ]);
    const aliases = captureAliases.get(treeRoot) ?? new Set<string>();
    const previous = captureRoots.get(location.treeRoot);
    if (previous !== undefined && previous !== treeRoot)
      captureAliases.get(previous)?.delete(location.treeRoot);
    aliases.add(location.treeRoot);
    captureAliases.set(treeRoot, aliases);
    captureRoots.set(location.treeRoot, treeRoot);
    captureRoots.set(treeRoot, treeRoot);
    return { treeRoot, gitDir };
  } catch {
    return undefined;
  }
}

/**
 * What this working tree's HEAD points at, as a full sha — read from git's own
 * files, so it costs the same as the walk above and no subprocess.
 *
 * The **sha** and not the branch name, because the caller is asking whether HEAD
 * *moved*: `git reset --hard`, `git merge` and `git commit` all leave the branch
 * name exactly where it was. A tenancy check on the name alone would call a
 * `reset --hard` — which rewrites the tree by every file between two commits —
 * an ordinary turn.
 *
 * Three shapes, all observed: a detached HEAD is the sha itself; a branch HEAD
 * is a loose file under `refs/heads`; and after a `gc` or a fresh clone that
 * file is gone and the ref is only in `packed-refs`. A linked worktree keeps its
 * own HEAD in its admin directory and shares `refs/heads` with the repository,
 * so the ref read hops `commondir` — the admin directory has none of its own.
 *
 * Nothing means no answer, never a guess: a repository before its first commit
 * has a HEAD naming a ref that does not exist, and the caller must not treat
 * that as "unchanged".
 */
export async function headSha(tree: Tree): Promise<string | undefined> {
  const head = (await readText(path.join(tree.gitDir, 'HEAD')))?.trim();
  if (head === undefined) {
    return undefined;
  }
  // Any hex length, as in `parseHead`.
  if (/^[0-9a-f]{7,}$/.test(head)) {
    return head;
  }
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) {
    return undefined;
  }
  const common = await readText(path.join(tree.gitDir, 'commondir'));
  const refsDir = common ? path.resolve(tree.gitDir, common.trim()) : tree.gitDir;
  const loose = (await readText(path.join(refsDir, ref)))?.trim();
  if (loose) {
    return loose;
  }
  const packed = await readText(path.join(refsDir, 'packed-refs'));
  return packed === undefined
    ? undefined
    : new RegExp(`^([0-9a-f]+) ${escapeRe(ref)}$`, 'm').exec(packed)?.[1];
}

/** A branch of a repository, as `refs/heads` files it. */
export type Ref = { repoRoot: string; branch: string };

/** What that ref points at: the loose file, else `packed-refs` (see `headSha`). */
export async function shaAt(ref: Ref): Promise<string | undefined> {
  const gitDir = (await gitDirAt(ref.repoRoot)) ?? ref.repoRoot;
  const loose = await readText(path.join(gitDir, 'refs', 'heads', ref.branch));
  if (loose !== undefined) {
    return loose.trim();
  }
  const packed = await readText(path.join(gitDir, 'packed-refs'));
  if (packed === undefined) {
    return undefined;
  }
  // `<sha> refs/heads/<branch>`, one per line. Anchoring on the whole name is
  // what skips the `#`-comment and the `^`-peeled lines beside it.
  return new RegExp(`^([0-9a-f]+) refs/heads/${escapeRe(ref.branch)}$`, 'm').exec(packed)?.[1];
}

/** A branch name is git's, not ours — `feat/a+b` is legal and `+` is a quantifier. */
function escapeRe(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One working tree of a repository — the main checkout, or a linked worktree. */
export type Worktree = {
  /** The working directory itself, which is what a dev server is started in. */
  path: string;
  /** What its HEAD names: a branch, or a short sha when `detached`. */
  branch?: string;
  detached?: boolean;
  /** The repo's own tree, as opposed to one `git worktree add` cut. */
  main?: boolean;
};

/**
 * Every working tree a repository has. The main checkout comes from
 * `<gitDir>/HEAD`; each linked worktree has an admin directory under
 * `<gitDir>/worktrees/<name>` holding its `HEAD`, and a `gitdir` file naming the
 * `.git` *file* inside the tree. A bare repository has no main checkout and
 * answers with its linked trees alone.
 *
 * The reverse of `readCheckout`: "what trees does this repo have", which a
 * servers section asks once per group.
 *
 * Never an error. An absent or unreadable `.git/worktrees` is a repository with
 * one tree, the common case, so a changed git layout shrinks a section rather
 * than breaking the panel.
 */
export async function readWorktrees(repoRoot: string): Promise<Worktree[]> {
  // Nothing owned means the root *is* the git directory, and a repository with
  // no checkout has no main tree to report — `repo.git/HEAD` reads perfectly
  // well and would otherwise be listed as one.
  const owned = await gitDirAt(repoRoot);
  const gitDir = owned ?? repoRoot;
  const head = owned === undefined ? undefined : await readText(path.join(gitDir, 'HEAD'));
  const trees: Worktree[] =
    head === undefined ? [] : [{ path: repoRoot, main: true, ...parseHead(head) }];

  let names: string[];
  try {
    names = await fs.readdir(path.join(gitDir, 'worktrees'));
  } catch {
    return trees;
  }

  const linked = await Promise.all(
    names.map(async (name) => {
      const admin = path.join(gitDir, 'worktrees', name);
      const pointer = await readText(path.join(admin, 'gitdir'));
      const treeHead = await readText(path.join(admin, 'HEAD'));
      if (!pointer || treeHead === undefined) {
        return undefined;
      }
      // `gitdir` names the tree's `.git` file, so the tree is one level up. A
      // removed tree leaves its admin directory behind — the trap in
      // `docs/reference/git_state.md` — so the directory has to be there.
      const tree = path.dirname(path.resolve(repoRoot, pointer.trim()));
      if (!(await stat(tree))?.isDirectory()) {
        return undefined;
      }
      return { path: tree, ...parseHead(treeHead) } satisfies Worktree;
    })
  );

  return [...trees, ...linked.filter((tree): tree is Worktree => tree !== undefined)];
}

/**
 * Origin repos for the window folders that are worktrees. A worktree opened as
 * its own IDE window would otherwise seed a group of its own.
 *
 * Worktrees only, deliberately. Every folder inside a repository has a root
 * above it — `packages/api` reports the monorepo — and folding on that would
 * collapse headings that have nothing to do with worktrees.
 */
export function repoRoots(folders: Iterable<string>): Promise<Map<string, string>> {
  return rootsOf(folders, (checkout) => checkout.worktree === true);
}

/**
 * The repository each folder belongs to, whatever kind of checkout it is —
 * which is the question "may these two paths be served by the same window".
 * The filter above is exactly wrong for that: a window is almost always open on
 * an ordinary checkout, so worktrees-only drops every window from the map.
 */
export function checkoutRoots(folders: Iterable<string>): Promise<Map<string, string>> {
  return rootsOf(folders, () => true);
}

/**
 * The git fields that follow a session onto the directory it is standing in.
 * `worktree` and `repoRoot` stay on the origin — see `Session.liveWorktree`.
 * Absent when the live checkout has no branch to name.
 */
export function liveBranchFields(
  live: Checkout
): { branch: string; detached?: boolean; liveWorktree: boolean } | undefined {
  if (live.branch === undefined) {
    return undefined;
  }
  return {
    branch: live.branch,
    detached: live.detached,
    liveWorktree: live.worktree === true
  };
}

async function resolved(dir: string): Promise<string | undefined> {
  try {
    return await fs.realpath(dir);
  } catch {
    return undefined;
  }
}

/**
 * Overlay process cwd onto a session. Unreadable → leave the frames
 * (Claude `init` `liveCwd` survives; Grok has none). Same directory as origin
 * → no `liveCwd`. Otherwise the process directory is the chip.
 *
 * Either side missing is not a move: treating a throw as a chdir would invent
 * `liveCwd` for a vanished tmpdir.
 */
export async function withProcessCwd(
  session: Session,
  processCwd: string | undefined
): Promise<Session> {
  if (!processCwd) {
    return session;
  }
  const [live, origin] = await Promise.all([resolved(processCwd), resolved(session.cwd)]);
  if (live === undefined || origin === undefined) {
    return session;
  }
  if (live === origin) {
    if (session.liveCwd === undefined) {
      return session;
    }
    const next = { ...session };
    delete next.liveCwd;
    return next;
  }
  return { ...session, liveCwd: processCwd };
}

/**
 * Folder to repo root, for the checkouts `keep` accepts. The two readers above
 * differ only in `keep`.
 */
async function rootsOf(
  folders: Iterable<string>,
  keep: (checkout: Checkout) => boolean
): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  await Promise.all(
    [...folders].map(async (folder) => {
      const checkout = await readCheckout(folder);
      if (checkout && keep(checkout)) {
        roots.set(folder, checkout.repoRoot);
      }
    })
  );
  return roots;
}
