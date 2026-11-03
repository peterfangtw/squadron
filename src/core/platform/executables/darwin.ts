/**
 * POSIX executable lookup. Linux and the other non-win32 hosts select it too,
 * unverified and unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { compose, NONE, run, type Effects, type Executables, type Locator } from './index';

export function executables(effects: Effects): Executables {
  return compose(locator(effects), effects);
}

function locator(effects: Effects): Locator {
  /** Whether this path is a file this process may execute. Both halves matter:
   *  a directory answers `access` happily, and a downloaded binary with no
   *  `+x` is a real thing to find on someone's machine. */
  async function runnable(file: string): Promise<boolean> {
    try {
      if (!(await effects.stat(file)).isFile()) return false;
      await effects.access(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return {
    join: (dir, name) => path.join(dir, name),
    // A leading `~` is what a person types into a settings box, and not
    // something any API expands for us.
    expand: (file) =>
      /^~(?=$|\/)/.test(file) ? path.join(effects.homedir(), file.slice(1)) : path.resolve(file),
    locate: async (file) => ((await runnable(file)) ? run(file) : NONE),
    searchPath: (env) =>
      (env.PATH ?? '')
        .split(path.delimiter)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        // An empty entry is `.` to a shell, and must not be here.
        .filter(Boolean)
  };
}
