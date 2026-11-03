/**
 * The per-window claim files, read side.
 *
 * Split out of `host/windows.ts` — which still owns publishing, since only a
 * window knows its own terminals — because the spawn CLI needs the same reading
 * and cannot import `vscode`. Two readers with a staleness horizon each is how
 * the CLI came to disagree with the panel about which windows were alive.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonDir } from '../files';
import { STATE_DIR } from '../paths';
import * as platform from '../platform';
import { WindowClaim } from '../model';

export const WINDOWS_DIR = path.join(STATE_DIR, 'windows');

/** A claim older than this is from a window that died without cleaning up. */
export const CLAIM_STALE_MS = 90_000;

/**
 * Every live window's claim. A stale or malformed file is removed as it is
 * read: nothing else sweeps them, and a claim left behind is a window the panel
 * keeps offering to send work to.
 */
export async function readClaims(): Promise<WindowClaim[]> {
  const gone: string[] = [];
  const claims = await readJsonDir(WINDOWS_DIR, (raw, name) => {
    if (isClaim(raw) && Date.now() - raw.updatedAt <= CLAIM_STALE_MS) {
      return raw;
    }
    gone.push(name);
    return undefined;
  });
  await Promise.all(
    gone.map((name) => fs.rm(path.join(WINDOWS_DIR, name), { force: true }).catch(() => {}))
  );
  return claims;
}

/**
 * Whether a window open on `folder` owns `cwd`. The separator is what keeps
 * `/repo` off `/repo-two`. `windowForCwd`'s folder tier.
 */
export function folderContains(folder: string, cwd: string): boolean {
  // **Normalised first, or the prefix test is not a containment test.**
  // `/repo/../../tmp/evil` starts with `/repo/` and names `/tmp/evil`, which is
  // where `path.join` and `createTerminal` would both take it — so a raw
  // `startsWith` let a request file point a window's terminal anywhere on the
  // machine while passing a guard that read as sound.
  return platform.paths.contains(path.resolve(folder), path.resolve(cwd));
}

/**
 * The window that holds `cwd`, by its folder or its repository, newest first
 * within a tier.
 *
 * The folder tier is containment, deepest folder first, so a subfolder of a
 * folder that is no repository is held too. The repo match is the one that
 * matters for a worktree: a linked worktree's path is not any window's folder.
 *
 * `resolve` is `git.checkoutRoots` outside a test, not `repoRoots`: the map has
 * to hold the *windows*, and a worktree-only map holds none of them.
 *
 * `fallback` is the newest window when neither tier matches — what a spawn
 * wants. The bridge passes `false`: a fresh session in a cwd no window holds is
 * refused, never sent to whichever window answered last (PRD D26).
 */
export async function windowForCwd(
  live: readonly WindowClaim[],
  cwd: string,
  resolve: (folders: Iterable<string>) => Promise<Map<string, string>>,
  { fallback }: { fallback: boolean }
): Promise<WindowClaim | undefined> {
  const claims = [...live].sort((a, b) => b.updatedAt - a.updatedAt);

  // Compared resolved: a CLI states the cwd its own process resolved, and a
  // window keeps the spelling it was opened with, so `/tmp/x` holds nothing
  // of `/private/tmp/x` as spelled. Resolved once per call, never per pair.
  const folders = claims.map((c) => c.folder).filter((f): f is string => f !== undefined);
  const real = await realpaths([cwd, ...folders]);
  const here = real.get(cwd) ?? cwd;
  const held = (folder: string | undefined) =>
    folder === undefined ? undefined : real.get(folder);
  const holding = claims.filter((c) => {
    const folder = held(c.folder);
    return folder !== undefined && folderContains(folder, here);
  });
  const deepest = holding.sort((a, b) => depth(held(b.folder)) - depth(held(a.folder)))[0];
  if (deepest) return deepest;

  // `roots` answers by the spellings it was handed; the repos it answers with
  // are what compare.
  const roots = await resolve([...folders, cwd]);
  const mine = roots.get(cwd);
  if (mine !== undefined) {
    const repo = platform.paths.key(mine);
    const sameRepo = claims.find((c) => {
      const root = c.folder === undefined ? undefined : roots.get(c.folder);
      return root !== undefined && platform.paths.key(root) === repo;
    });
    if (sameRepo) return sameRepo;
  }
  return fallback ? claims[0] : undefined;
}

/** Each path as its process would resolve it, or as spelled (normalised)
 *  where it cannot be: a folder gone since its window claimed it. */
async function realpaths(paths: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  const real = await Promise.all(
    unique.map((one) => fs.realpath(one).catch(() => path.resolve(one)))
  );
  return new Map(unique.map((one, i) => [one, real[i] ?? path.resolve(one)]));
}

/** `sort` is stable, so equal depths keep the newest-first order. */
function depth(folder: string | undefined): number {
  return folder === undefined ? 0 : path.resolve(folder).length;
}

/**
 * Whether a parsed file can be read as a claim, narrowed field by field the way
 * every other reader of another program's files here narrows.
 *
 * `updatedAt` is what makes this more than tidiness. Cast rather than checked,
 * a file without one gave `Date.now() - undefined === NaN`, and every
 * comparison against `NaN` is false — so the claim was neither swept as stale
 * nor rejected as malformed. Nothing else sweeps this directory, so it stayed
 * forever, offered as a live window to send work to. Failing the check is
 * therefore removal and not a skip: the alternative is the immortal file again,
 * one poll at a time.
 *
 * `id`, `label` and `app` are required because a window is addressed by the
 * first and drawn as the next two; `shellPids` because every earlier build
 * required it.
 */
function isClaim(value: unknown): value is WindowClaim {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const claim = value as Partial<WindowClaim>;
  return (
    typeof claim.id === 'string' &&
    typeof claim.label === 'string' &&
    typeof claim.app === 'string' &&
    Array.isArray(claim.shellPids) &&
    typeof claim.updatedAt === 'number' &&
    Number.isFinite(claim.updatedAt)
  );
}
