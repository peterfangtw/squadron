import * as path from 'path';
import type { Effects, Launchers } from './index';

/**
 * Copy one bundle beside the others and mark it executable. The bundle
 * already carries its shebang (`scripts/esbuild.mjs`); these bytes are not
 * rewritten. Also the unchanged, unverified legacy path on other POSIX hosts.
 */
export function launchers(effects: Effects): Launchers {
  return {
    installHelperLocator: () => Promise.resolve(),
    scriptPath,
    verbPath: (binDir, name) => scriptPath(binDir, name),
    // The hook text Codex and Claude trust by its bytes: Node off PATH.
    scriptCommand: () => ({ program: '/usr/bin/env node', quoting: 'literal' }),
    async install(binDir, name, bundle) {
      try {
        await effects.mkdir(binDir);
        const destination = scriptPath(binDir, name);
        await effects.copyFile(bundle, destination);
        await effects.chmod(destination, 0o755);
      } catch {
        // One missing bundle is one command lost.
      }
    }
  };
}

function scriptPath(binDir: string, name: string): string {
  return path.join(binDir, name);
}
