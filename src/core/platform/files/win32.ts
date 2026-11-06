import type { Effects, Files } from './index';

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
    replace: (source, destination) => effects.rename(source, destination),
    // Measured 2026-10-30 with 8-12 processes on one lock file: 18 of 13,532 attempts refused the
    // read, each clearing within 1.4 ms. Cause unknown; deleting under an open handle does not.
    contended: (error) => (error as NodeJS.ErrnoException)?.code === 'EPERM'
  };
}
