import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as git from './git';
import * as platform from './platform';
import { STATE_DIR } from './paths';

export const SCRATCH_DIR = path.join(STATE_DIR, 'scratch');
let root: Promise<string> | undefined;

export function scratchRoot(): Promise<string> {
  return (root ??= canonicalDirectory(SCRATCH_DIR));
}

/** Resolve existing ancestors too: the first launch must not change the board's key. */
export async function canonicalDirectory(directory: string): Promise<string> {
  let ancestor = path.resolve(directory);
  const remaining: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(ancestor), ...remaining);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(directory);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(directory);
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function checkScratchRoot(directory: string): Promise<void> {
  // readCheckout deliberately ignores a missing cwd; check its existing ancestor before mkdir.
  let ancestor = directory;
  while (!(await fs.stat(ancestor).catch(() => undefined))?.isDirectory()) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const checkout = await git.readCheckout(ancestor);
  if (checkout) {
    throw new Error(
      `Cannot start a scratch session inside the Git repository ${checkout.repoRoot}. Open a folder to start a session there.`
    );
  }
}

export type ScratchAllocation = { cwd: string; created: boolean };

export async function checkScratchResume(directory: string, cwd: string): Promise<void> {
  if (!platform.paths.contains(directory, cwd)) return;
  await checkScratchRoot(directory);
  const info = await fs.stat(cwd).catch(() => undefined);
  if (!info?.isDirectory())
    throw new Error(`The scratch conversation directory no longer exists: ${cwd}`);
}

export async function allocateScratch(
  directory: string,
  attemptId: string
): Promise<ScratchAllocation> {
  await checkScratchRoot(directory);
  await fs.mkdir(directory, { recursive: true });
  const realRoot = await fs.realpath(directory);
  if (platform.paths.key(realRoot) !== platform.paths.key(directory)) {
    throw new Error('The scratch directory changed. Reload this window before starting a session.');
  }
  const name = crypto.createHash('sha256').update(attemptId).digest('hex').slice(0, 24);
  const cwd = path.join(realRoot, name);
  try {
    await fs.mkdir(cwd);
    return { cwd, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await fs.lstat(cwd);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('The scratch session directory is not a directory.');
    return { cwd, created: false };
  }
}

export async function discardEmptyScratch(allocation: ScratchAllocation): Promise<void> {
  if (allocation.created) await fs.rmdir(allocation.cwd).catch(() => {});
}
