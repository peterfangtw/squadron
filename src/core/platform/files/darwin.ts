import type { Effects, Files } from './index';
import * as fs from 'node:fs';
import * as regular from './regular';

/** Also the unchanged, unverified legacy path on other POSIX hosts. */
export function files(effects: Effects): Files {
  return {
    // O_NONBLOCK lets fstat reject a FIFO before its open waits for a writer.
    readRegular: (file, maxBytes) =>
      regular.readRegular(file, maxBytes, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK),
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
