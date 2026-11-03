import type { Effects, Files } from './index';

/** PR #3's bound, retained only by provenance; R2/A4 tuning requires Windows evidence. */
const LEGACY_ATTEMPTS = 40;
const LEGACY_WAIT_MS = 250;

// A held Windows read handle can deny rename; state writes allow at most two seconds of waits.
const STATE_RETRIES = 20;
const STATE_WAIT_MS = 100;

export function files(effects: Effects): Files {
  return {
    async syncDirectory(directory): Promise<void> {
      const handle = await effects.open(directory, 'r');
      try {
        await handle.sync();
      } catch (error) {
        // Node directory flush returns EPERM on Windows; file flush remains required.
        if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') throw error;
      } finally {
        await handle.close();
      }
    },
    async replace(source, destination, budget): Promise<void> {
      if (budget.kind === 'state' && !budget.legacyRetry)
        return replaceState(effects, source, destination);
      for (let attempt = 0; ; attempt++) {
        try {
          await effects.rename(source, destination);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (
            !budget.legacyRetry ||
            !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') ||
            attempt >= LEGACY_ATTEMPTS - 1
          )
            throw error;
          await effects.sleep(LEGACY_WAIT_MS);
        }
      }
    },
    // Measured 2026-10-30 with 8-12 processes on one lock file: 18 of 13,532 attempts refused the
    // read, each clearing within 1.4 ms. Cause unknown; deleting under an open handle does not.
    contended: (error) => (error as NodeJS.ErrnoException)?.code === 'EPERM'
  };
}

type Target = { version: string; readOnly: boolean };

async function replaceState(effects: Effects, source: string, destination: string): Promise<void> {
  const before = await target(effects, destination);
  let firstError: unknown;
  try {
    await effects.rename(source, destination);
    return;
  } catch (error) {
    if (!renameLock(error) || !before || before.readOnly) throw error;
    firstError = error;
  }
  for (let retry = 0; retry < STATE_RETRIES; retry++) {
    await effects.sleep(STATE_WAIT_MS);
    const current = await target(effects, destination);
    if (!current || current.readOnly || current.version !== before.version) break;
    try {
      await effects.rename(source, destination);
      return;
    } catch (error) {
      if (!renameLock(error)) throw error;
    }
  }
  throw firstError;
}

function renameLock(error: unknown): boolean {
  return ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

async function target(effects: Effects, file: string): Promise<Target | undefined> {
  try {
    const stat = await effects.stat(file);
    return {
      version: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'),
      readOnly: (stat.mode & 0o200) === 0
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { version: 'missing', readOnly: false }
      : undefined;
  }
}
