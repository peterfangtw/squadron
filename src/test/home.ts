import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as fixtureRoots from '../../scripts/fixture-roots.cjs';

/**
 * Test rig. Two things the modules under test need and cannot be told:
 *
 * - where `~/.claude` and `~/.squadron` are. `paths.ts` resolves both from
 *   `os.homedir()` when it is first required, so tests point the home at a
 *   temp directory and then `await import(...)` the module under test — a
 *   static import would run first.
 * - a live `claude` process. Discovery cross-checks every session file against
 *   the process table, so a fixture alone proves nothing.
 */

/**
 * Points the home at an empty directory and returns it. Call before importing.
 *
 * Both variables, because win32's `os.homedir()` reads `USERPROFILE`: with only
 * `HOME` moved, a Windows run wrote into and deleted the real `~/.squadron`
 * (2026-10-10).
 */
export async function tempHome(): Promise<string> {
  refuseEarlyPaths();
  const home = fixtureRoots.create();
  homes.add(home);
  Object.assign(process.env, homeEnv(home));
  // The real CLI roots otherwise, whichever home this says.
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']) delete process.env[name];
  if (os.homedir() !== home) {
    throw new Error(`os.homedir() is ${os.homedir()} after moving the home to ${home}`);
  }
  // Git for Windows' system config sets `core.autocrlf=true`, which every repo
  // a test creates would inherit; a global one in this home outranks it.
  await fs.writeFile(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = false\n');
  return home;
}

/**
 * Removes a home `tempHome()` made, once the suite's children and writers
 * have closed. Each suite calls it from its own `after`: nothing registers a
 * hook for it, and a direct `node --test` has no sandbox to sweep after it.
 * A file Windows still holds open (a child closing a beat late) is retried,
 * boundedly; a home that still cannot go is an error, not a quiet leak.
 */
export async function disposeHome(home: string): Promise<void> {
  if (!homes.has(home)) throw new Error(`refusing to dispose ${home}: not a home tempHome() made`);
  for (let attempt = 0; ; attempt++) {
    try {
      fixtureRoots.remove(home);
      homes.delete(home);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 30 || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(code ?? ''))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Every home `tempHome()` made in this process. The guards below check against
 * these rather than `os.tmpdir()`: under `affected.mjs` the whole process
 * already runs in a sandbox home inside it, which a guard on the temp dir alone
 * would wave through.
 */
const homes = new Set<string>();

/** At or below a home `tempHome()` made. */
function inTempHome(file: string): boolean {
  return [...homes].some((home) => file === home || inside(home, file));
}

/** What a spawned child needs in its `env` to share the temp home. */
export function homeEnv(
  home: string
): Record<'HOME' | 'USERPROFILE' | 'TMP' | 'TEMP' | 'TMPDIR', string> {
  return fixtureRoots.environment(home);
}

/**
 * Removes a directory the module under test computed. Refuses one outside a
 * temp home: when `tempHome()` did not take, that directory is the reader's own.
 */
export async function resetDir(dir: string): Promise<void> {
  const home = os.homedir();
  if (!inTempHome(home) || !inside(home, dir)) {
    throw new Error(`refusing to remove ${dir}: os.homedir() is ${home}, not a temp home`);
  }
  fixtureRoots.validate(home, dir);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * `paths.ts` reads the home once, when it is first required. A static import
 * that reaches it — directly or through any module — runs before `tempHome()`,
 * and every root it exports is then the real home's, which no later assertion
 * on `os.homedir()` can see.
 */
// A relative module specifier would match the test selector and still open no
// repository file. The guard only needs a module that is already loaded.
function refuseEarlyPaths(): void {
  const marker = `${path.sep}core${path.sep}paths.js`;
  for (const key of Object.keys(require.cache)) {
    if (!key.endsWith(marker)) continue;
    const loaded: unknown = require.cache[key]?.exports;
    const state = (loaded as { STATE_DIR?: unknown } | undefined)?.STATE_DIR;
    if (typeof state === 'string' && !inTempHome(state)) {
      throw new Error(
        `core/paths was required before tempHome() and resolved ${state}; ` +
          'import the module under test with `await import()` after tempHome()'
      );
    }
  }
}

/** Strictly below `parent`; a different drive on win32 is not. */
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function testPlatform(): NodeJS.Platform {
  return process.platform;
}

/**
 * `skip` for a test that makes a path unreadable or unwritable with `chmod`.
 * On win32 `chmod` sets only the read-only attribute: it never stops a read,
 * and a directory ignores it.
 */
export const modeBitsSkip: false | string =
  testPlatform() === 'win32' &&
  'win32: chmod cannot make a file or directory unreadable or unwritable';

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}
