/**
 * A turn's writes, taken off the working tree instead of off the frames.
 *
 * A `Write` frame carries a path and a body, so a pill can be drawn from it. A
 * `Bash` frame carries one string, the shell (or a `python3` inside it) does the
 * writing, and nothing anywhere records that a file changed — so the turn draws
 * nothing and reads as having produced nothing. Shell is 3.2× the two writer
 * tools combined on this machine, and the census in
 * `TASK_done_write_pill_coverage_claude.md` closes parsing as a way back: the
 * command string *contains the file body*, and HTML is made of `>`.
 *
 * What is recoverable is the effect. Snapshot the whole tree at each turn
 * boundary and diff consecutive snapshots, and the write is there however it was
 * made. `TASK_done_turn_checkpoints.md` is the plan and the measurements.
 *
 * **A snapshot is a tree object and nothing else.** No ref, no commit, no
 * rollback — `t3code` writes a `commit-tree` under `refs/t3/checkpoints/…`
 * because it also ships rollback, and the ref lifecycle is the price of that
 * feature rather than of this one. A baseline only has to outlive its own turn,
 * and `git gc --auto` prunes at two weeks, so the loose objects are safe for far
 * longer than they are wanted. Verified, along with everything else here, in a
 * scratch repository on 2026-08-22.
 *
 * In `core/` and not `host/` because the rules are the part worth testing, and
 * spawning from `core/` has a precedent with the same shape: `core/git_show.ts`,
 * which states the argument in full.
 */

import * as platform from './platform';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { headSha, type Tree } from './git';
import type { Written } from './transcript';
import * as checkpointModel from './checkpoint_model';

const run = promisify(execFile);

/**
 * A backstop, not a latency budget — `core/git_show.ts` sets one for the same
 * reason. This one is also on the path that holds a turn back (see the plan's
 * *The baseline blocks the drain*), so a git that never returns would leave the
 * reader's prompt unsent rather than merely leave a diff tab spinning.
 */
const SPAWN_MS = 10_000;

/**
 * `--numstat` is small — three fields a line — but a turn that ran `git
 * checkout` diffs every file between two commits, and `execFile` *rejects*
 * rather than truncates on overrun. Rule 3 withholds on that turn anyway, so the
 * only cost of hitting this is losing a diff nobody would have drawn.
 */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * The files git leaves in a working tree's git directory while an operation is
 * unfinished, in the order they are worth reporting. Read 2026-08-22 off git
 * 2.39 by conflicting each operation and listing what appeared.
 *
 * A linked worktree keeps its own, so this reads `tree.gitDir` and never the
 * repository's — two worktrees can be mid-merge independently.
 *
 * `MERGE_MSG` and `AUTO_MERGE` also appear and are deliberately not here:
 * `MERGE_MSG` survives a *completed* merge until the next one, so it would
 * report an operation that finished hours ago.
 */
const IN_PROGRESS: readonly [string, string][] = [
  ['MERGE_HEAD', 'merge'],
  ['REBASE_HEAD', 'rebase'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect']
];

async function inProgress(tree: Tree): Promise<string | undefined> {
  for (const [marker, name] of IN_PROGRESS) {
    try {
      await fs.stat(path.join(tree.gitDir, marker));
      return name;
    } catch {
      // Absent is the common case and the only other one.
    }
  }
  return undefined;
}

/**
 * The index this module stages into: one per **owner** per working tree.
 *
 * Inside the git directory, so it is never in the tree, never staged and never
 * anything `.gitignore` has an opinion about. A linked worktree's git directory
 * is its own `worktrees/<name>` admin directory, so trees of one repository do
 * not share these.
 *
 * **Per owner, and that is a correctness decision rather than a performance
 * one.** One index per tree was the first design and it has a failure nobody
 * would ever find: a `git add` killed with SIGKILL leaves `<index>.lock`
 * behind, and every later capture on that tree then fails with exit 128 —
 * forever, across restarts, silently. A person notices a stale `.git/index.lock`
 * within seconds because every git command they export type fails; nothing ever types a
 * command against this file. Splitting per owner bounds that blast radius to one
 * session, and `unlockStale` below clears it outright.
 *
 * It also removes a race worth naming, because the guarantee is weaker than it
 * looks: a capture is **two** lock acquisitions with an unlocked gap between
 * them (`write-tree` takes the lock too, every time). Two owners sharing an
 * index could interleave `add`, `add`, `write-tree` and hand the first one a
 * tree containing the second one's staging. Observed 2026-08-22. Per owner,
 * there is no second writer to interleave with.
 *
 * **Kept warm between captures rather than made fresh.** `t3code` writes a
 * `randomUUID` index per capture and deletes it, which forces a `read-tree HEAD`
 * to seed it and re-stats the whole tree every time. Measured on 3,305 tracked
 * files: fresh 129ms, warm 43ms, and one fewer subprocess. Warm is also
 * *correct* under git's default stat settings and not merely faster — `add -A`
 * stages removals, so it answers the same tree as a fresh index across an edit,
 * a deleted file and a branch switch taken under it. Not an absolute: a cold
 * `read-tree` index has no stat data and re-hashes everything, where a warm one
 * inherits git's refresh heuristics, so `core.trustctime=false` against a
 * same-size mtime-preserving rewrite can answer the old tree. Narrow, accepted,
 * and stated here rather than discovered.
 */
function indexFile(tree: Tree, owner: string): string {
  const digest = createHash('sha256').update(owner).digest('hex');
  return path.join(tree.gitDir, `squadron-${digest}.index`);
}

export async function copyIndex(
  tree: Tree,
  sourceOwner: string,
  destinationOwner: string,
  mode: 'seed' | 'publish'
): Promise<boolean> {
  const source = indexFile(tree, sourceOwner);
  const destination = indexFile(tree, destinationOwner);
  const temporary = `${destination}.${randomUUID()}.next`;
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(source, 'r');
    const stat = await file.stat();
    await fs.writeFile(temporary, await file.readFile(), { flag: 'wx', mode: 0o600 });
    // Git's racy-clean cutoff is the index mtime. A newer copy can hide a same-stat
    // rewrite (real-Git probe, 2026-10-05). Round down so timestamp conversion is safe.
    const cutoff = Math.floor(stat.mtimeMs / 1000);
    await fs.utimes(temporary, cutoff, cutoff);
    if (mode === 'seed') await fs.link(temporary, destination);
    else await platform.files.replace(temporary, destination);
    return true;
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * How long a lock on *our own* index must have sat before it is assumed dead.
 *
 * Generous against `SPAWN_MS`, because the only legitimate holder is a capture
 * of ours that has not returned — and captures for one owner are serialised by
 * the caller, so a lock older than a stalled capture could ever be is nobody's.
 */
const STALE_LOCK_MS = 60_000;

/**
 * Clears a lock left behind on our own index, and answers whether it did.
 *
 * Only ever *our* file, which is what makes deleting a lock defensible at all —
 * the usual advice against it is about `.git/index.lock`, where the holder may
 * be a git the reader is running. Nothing but this module writes here.
 *
 * Verified 2026-08-22: a SIGTERM'd `git add` cleans its own lock, so the
 * subprocess timeout below never produces one; only SIGKILL, a panic or a lost
 * machine does.
 */
async function unlockStale(tree: Tree, owner: string): Promise<boolean> {
  const lock = `${indexFile(tree, owner)}.lock`;
  try {
    const { mtimeMs } = await fs.stat(lock);
    if (Date.now() - mtimeMs < STALE_LOCK_MS) {
      return false;
    }
    await fs.rm(lock, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The environment for a capture: git's own variables stripped, then the one we
 * mean put back.
 *
 * `GIT_DIR` and `GIT_INDEX_FILE` **beat `-C`**, and git exports both into every
 * hook — so a capture inheriting them would stage the repository being
 * committed into that repository's own index. `core/git_show.ts` pays for this
 * trap by stripping; this module has to strip *and* set, which is why the two
 * steps are one function here rather than a shared helper.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function stagingEnv(tree: Tree, owner: string): NodeJS.ProcessEnv {
  return { ...cleanEnv(), GIT_INDEX_FILE: indexFile(tree, owner) };
}

function git(tree: Tree, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return run('git', args, {
    cwd: tree.treeRoot,
    env,
    timeout: SPAWN_MS,
    maxBuffer: MAX_BYTES
  });
}

/**
 * This tree as it stands, or nothing.
 *
 * **Nothing is the whole failure contract**, and every caller must degrade to
 * drawing no pill rather than to drawing a wrong one. It is answered for a
 * directory in no repository, for a `git` that is absent or hangs, and for a
 * losing race on the index: two
 * captures for one owner racing means git's own `index.lock`, and the loser dies
 * cleanly having touched nothing. Rule 1 re-baselines every turn, so a lost
 * capture costs one turn's pill and repairs itself. A lock left behind by a
 * SIGKILL would not repair itself, which is what `unlockStale` is for.
 *
 * `owner` scopes the index — see `indexFile`. Callers pass the session id, so a
 * poisoned index costs one session rather than a whole checkout.
 *
 * A tree **mid-merge still answers**, carrying `op`. The reader's index has
 * unmerged entries and `write-tree` would refuse it; ours does not, because
 * `add -A` stages the working tree's own bytes, conflict markers and all. That
 * is a true picture of the tree, so it is reported rather than suppressed — and
 * the attribution it cannot support is the gate's business, not the capture's.
 *
 * The reader's own index, HEAD and reflog are never touched — that is what
 * `GIT_INDEX_FILE` buys, and the test asserts it against a staged file.
 */
export async function capture(
  tree: Tree,
  owner: string
): Promise<checkpointModel.Snapshot | undefined> {
  const startedAt = Date.now();
  const env = stagingEnv(tree, owner);
  try {
    // `read-tree HEAD` only seeds a *fresh* index, and re-running it would throw
    // away the stat cache that makes the warm case cheap. `add -A` needs no
    // seed: it stages the whole tree either way, only slower.
    try {
      await git(tree, ['add', '-A', '--', '.'], env);
    } catch (error) {
      // One retry, and only where a lock nobody is holding is what stopped it.
      // Without this a single SIGKILL ends checkpointing for that session
      // permanently and without a symptom anyone would look for.
      if (!(await unlockStale(tree, owner))) {
        throw error;
      }
      await git(tree, ['add', '-A', '--', '.'], env);
    }
    const written = (await git(tree, ['write-tree'], env)).stdout.trim();
    if (!/^[0-9a-f]{40,}$/.test(written)) {
      return undefined;
    }
    // Both read from git's files rather than asked of a subprocess, so they cost
    // nothing on top of the two spawns above — see `headSha`.
    const [head, op] = await Promise.all([headSha(tree), inProgress(tree)]);
    return {
      tree: written,
      at: Date.now(),
      startedAt,
      ...(head === undefined ? {} : { head }),
      ...(op === undefined ? {} : { op })
    };
  } catch {
    return undefined;
  }
}

/**
 * What changed between two snapshots of one tree, by **absolute** path — the
 * shape `Authored.files` is already in, so nothing downstream has to know where
 * these came from.
 *
 * An empty `files` is "these trees are identical", which is a real answer and
 * not the same as nothing: a turn that changed no file has a checkpoint and no
 * pills, where a turn whose capture failed has neither.
 *
 * A path in `files` and not in `sizes` is a **binary** file — `--numstat`
 * writes `-` in both columns — and draws a pill with no counts, which is
 * already what the dock does for a write `sizeOf` could not read. The two are
 * one shape on purpose.
 *
 * **`-z`, always.** Without it git quotes any path holding a space or a
 * non-ASCII byte, and unquoting is a second parse of another program's
 * escaping. With it the record is `<add>\t<del>\t<path>\0` and the path is
 * verbatim — which also means the path may itself contain a tab, so the two
 * separators are found from the left rather than by splitting the record.
 *
 * Renames report as a delete and an add, because `-r` without `-M` does not look
 * for them. That is the honest reading at pill granularity — a renamed file's
 * new path is a thing the turn produced — and one fewer knob.
 */
export async function changesBetween(
  tree: Tree,
  from: string,
  to: string
): Promise<checkpointModel.TurnChanges | undefined> {
  if (!from || !to) {
    return undefined;
  }
  if (from === to) {
    return { files: [], sizes: {} };
  }
  let stdout: string;
  try {
    // No `GIT_INDEX_FILE`: `diff-tree` compares two objects and never reads the
    // index, so pointing it at ours would only take a lock it does not need.
    stdout = (await git(tree, ['diff-tree', '-r', '--numstat', '-z', from, to], cleanEnv())).stdout;
  } catch {
    return undefined;
  }

  const files: string[] = [];
  const sizes: Record<string, Written> = {};
  for (const record of stdout.split('\0')) {
    if (!record) {
      continue;
    }
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) {
      continue;
    }
    const file = path.resolve(tree.treeRoot, record.slice(second + 1));
    files.push(file);
    const add = Number(record.slice(0, first));
    const del = Number(record.slice(first + 1, second));
    if (Number.isInteger(add) && Number.isInteger(del)) {
      sizes[file] = { add, del };
    }
  }
  return { files, sizes };
}

/**
 * Every move HEAD made between two shas, named the way git's own reflog names
 * it — or nothing, which means *cannot say* and must be read as such.
 *
 * This is what rule 3 is actually asking, and a sha comparison alone is the
 * wrong question. Measured over 2,154 transcripts: **18.9% of writer turns run
 * `git commit`**, against 3.9% that move HEAD by anything else. A commit does
 * not touch a single working-tree file, so the diff across it is still exactly
 * the turn's own writes — withholding on "HEAD moved" would go silent on nearly
 * one turn in five, and precisely the ones that finished something.
 *
 * `<gitDir>/logs/HEAD` separates them for free. Every operation that rewrites
 * the working tree writes its own action there — `checkout:`, `reset:`,
 * `cherry-pick:`, `revert:`, `rebase (start|pick|finish):`, `merge <x>:
 * Fast-forward` — and only a commit writes one beginning `commit`, in its three
 * spellings (`commit`, `commit (initial)`, `commit (amend)`). Verified against
 * git 2.39 on 2026-08-22 by running each verb and reading the file.
 *
 * It is a **file read and no subprocess**, which is what lets rule 3 stay as
 * cheap as the rest of this, and it is per working tree: a linked worktree keeps
 * its own reflog at `worktrees/<name>/logs/HEAD`, which is `tree.gitDir`.
 *
 * The fast-forward `git pull` is the case worth naming, because it is the one a
 * commits-versus-not test built on ancestry would have let through: the incoming
 * commits are ordinary and linear, so H0 really is an ancestor of H1 and no
 * merge commit exists — and the working tree is rewritten all the same. The
 * reflog calls it `merge`, so it is caught.
 *
 * Nothing is returned when the reflog is missing (`core.logAllRefUpdates=false`),
 * when it has been expired, or when the chain from `to` cannot be walked back to
 * `from` at all. The caller must withhold on that, not wave it through — an
 * unexplained HEAD move is the case rule 3 exists for.
 */
export async function headMoves(
  tree: Tree,
  from: string,
  to: string
): Promise<string[] | undefined> {
  if (from === to) {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(tree.gitDir, 'logs', 'HEAD'), 'utf8');
  } catch {
    return undefined;
  }

  // `<old> <new> <who> <when> <tz>\t<action>`. Read newest-first and walked
  // backwards from `to`, so a reflog holding several turns' worth answers about
  // this pair alone.
  const entries: { old: string; next: string; action: string }[] = [];
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const [old, next] = line.slice(0, tab).split(' ');
    if (!old || !next) {
      continue;
    }
    // The detail after the colon is a branch name or a commit subject — free
    // text from the reader's own repository, and nothing here should carry it.
    const action = line.slice(tab + 1);
    const colon = action.indexOf(':');
    entries.push({ old, next, action: colon < 0 ? action : action.slice(0, colon) });
  }

  const moves: string[] = [];
  let at = to;
  for (let i = entries.length - 1; i >= 0 && at !== from; i--) {
    const entry = entries[i];
    if (entry?.next !== at) {
      continue;
    }
    moves.push(entry.action);
    at = entry.old;
  }
  // Walked off the end without reaching the baseline: the reflog does not
  // account for this move, so nothing is known about it.
  return at === from ? moves.reverse() : undefined;
}

/**
 * Drops the index an owner warmed.
 *
 * One file per session per working tree, and on a 3,305-file checkout it is not
 * small. Nothing reads it once the session is gone, and it lives in `<gitDir>`
 * rather than in `STATE_DIR`, so the seven-day sweep in `core/prune.ts` never
 * reaches it — a host killed outright leaks one, which is the same named blind
 * spot the lock has and is bounded the same way.
 */
export async function forgetIndex(tree: Tree, owner: string): Promise<void> {
  try {
    const file = indexFile(tree, owner);
    try {
      await fs.access(`${file}.lock`);
      if (!(await unlockStale(tree, owner))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const names = await fs.readdir(tree.gitDir);
    await Promise.all(
      [
        file,
        ...names
          .filter((name) => name.startsWith(`${path.basename(file)}.`) && name.endsWith('.next'))
          .map((name) => path.join(tree.gitDir, name))
      ].map((name) => fs.rm(name, { force: true }))
    );
  } catch {
    // A file we cannot delete costs a few hundred kilobytes in somebody's
    // `.git`. Nothing a session should hear about.
  }
}

/** A failed cached seed can be retried cold only when no Git holds its index. */
export async function discardFailedSeed(tree: Tree, owner: string): Promise<boolean> {
  try {
    await fs.access(`${indexFile(tree, owner)}.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await forgetIndex(tree, owner);
      return true;
    }
  }
  return false;
}
