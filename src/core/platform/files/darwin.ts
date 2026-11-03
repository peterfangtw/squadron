import type { Effects, Files } from './index';

/** Also the unchanged, unverified legacy path on other POSIX hosts. */
export function files(effects: Effects): Files {
  return {
    async syncDirectory(directory): Promise<void> {
      const handle = await effects.open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    replace: (source, destination) => effects.rename(source, destination),
    contended: () => false
  };
}
