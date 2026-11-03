/**
 * A file as HEAD or a captured tree has it, for the diff behind a turn's counts.
 *
 * A new file rather than a function in `core/git.ts`, so that module's
 * no-subprocess invariant stays readable at the file level; and in `core/`
 * rather than `host/`, because the path resolution and the failure contract
 * below are exactly what wants a test. Both arguments in full, with the seven
 * `core/` modules that already spawn:
 * `docs/tasks/TASK_done_change_size.md` §Key Decisions.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A backstop, not a latency budget — the same reason `platform/power/darwin.ts` sets one.
 * Without it a git that never returns (a stalled network filesystem, a repo
 * mid-`gc`) leaves the diff tab waiting forever, since nothing throws.
 */
const SPAWN_MS = 5000;

/**
 * Node's `execFile` default is 1 MB, and overrunning it *rejects* rather than
 * truncates — so the default would turn a large file's before-image into the
 * empty string, which reads as "wholly added". The webview withholds the click
 * well below this, so this is the backstop and never the binding limit.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The environment with git's own variables taken out.
 *
 * `GIT_DIR` and `GIT_INDEX_FILE` **beat `-C`**, so a process that inherited them
 * asks the repository they name rather than the one the file is in — the answer
 * is then a different repo's `HEAD`, or nothing, and this module's whole
 * contract is that `-C <dirname>` decides. Not hypothetical: git exports both
 * into every hook, so the pre-commit gate ran these reads against the checkout
 * being committed and two tests came back empty. The same trap
 * `src/test/AGENTS.md` records for tests, paid here instead, because the fix
 * belongs to the caller of `git` rather than to whoever happens to spawn us.
 */
function withoutGitVars(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * What `HEAD` has at this path, or the empty string.
 *
 * **Asked in the file's own directory.** `git show HEAD:<path>` resolves from
 * the *repo root*, never from the process's directory, so a path relative to a
 * cwd is wrong for any session in a subdirectory. `readCheckout().repoRoot` is
 * worse: a linked worktree reports the repo it was cut from
 * (`git.ts` — `commondir`), a different tree on a different branch, so its
 * `HEAD` is not the one the reader is looking at. `git -C <dirname>` with a
 * `./`-prefixed basename is cwd-relative *inside the work tree*, which is right
 * in both cases and needs no cwd from the caller.
 *
 * **Empty is the whole failure contract.** An untracked file genuinely is wholly
 * added, and so is a path in no repository at all; a diff against nothing states
 * that correctly. Nothing here reports — panel feedback belongs in the dock, and
 * there is nothing worth saying about a file git has never seen.
 */
export async function showAtHead(absPath: string): Promise<string> {
  // The one input where empty-is-safe stops holding: `dirname` of a relative
  // path is `.`, so this would ask the *extension host's* own directory and can
  // come back with a different file of the same basename — content, and wrong,
  // where every other failure here is content-free. `core/transcript.ts`
  // resolves before this is ever called, which makes this a guard rather than a
  // branch anything reaches today.
  if (!path.isAbsolute(absPath)) {
    return '';
  }
  try {
    const { stdout } = await run(
      'git',
      // Every argument is fixed or `HEAD:`-prefixed, so no `--` is needed to keep
      // a file named `-x` from being read as a flag.
      ['-C', path.dirname(absPath), 'show', `HEAD:./${path.basename(absPath)}`],
      { timeout: SPAWN_MS, maxBuffer: MAX_BYTES, env: withoutGitVars() }
    );
    return stdout;
  } catch {
    return '';
  }
}

/** Empty is a resolved before-image; undefined means the baseline is unavailable. */
export async function showAtTree(
  treeRoot: string,
  tree: string,
  absPath: string
): Promise<string | undefined> {
  if (!/^[0-9a-f]{40,64}$/.test(tree) || !path.isAbsolute(treeRoot) || !path.isAbsolute(absPath)) {
    return undefined;
  }
  const relative = path.relative(treeRoot, absPath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const options = { timeout: SPAWN_MS, maxBuffer: MAX_BYTES, env: withoutGitVars() };
  try {
    const kind = await run('git', ['-C', treeRoot, 'cat-file', '-t', tree], options);
    if (kind.stdout.trim() !== 'tree') return undefined;
    // A successful ls-tree distinguishes an absent path from an unavailable object.
    const entry = await run(
      'git',
      [
        '-C',
        treeRoot,
        '--literal-pathspecs',
        'ls-tree',
        '-z',
        tree,
        '--',
        `./${relative.split(path.sep).join('/')}`
      ],
      options
    );
    if (entry.stdout === '') return '';
    const blob = /^\d{6} blob ([0-9a-f]{40,64})\t/.exec(entry.stdout)?.[1];
    if (!blob) return undefined;
    const content = await run('git', ['-C', treeRoot, 'cat-file', 'blob', blob], options);
    return content.stdout;
  } catch {
    return undefined;
  }
}
