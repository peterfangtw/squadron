import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { testPlatform } from '../helpers';

/**
 * Stock VS Code, which is what this repo targets, and the only host smoke and
 * the dev host run against — a fork's build is an extra variable in every
 * failure there and bought nothing the extension is written to depend on.
 * `SQUADRON_IDE` alone, when a run is pointed at another stock build by hand;
 * otherwise where this OS's installer puts it: the per-user Windows install
 * (observed 2026-10-27, 1.143.1) before the machine-wide one.
 */
export function candidates(env: NodeJS.ProcessEnv = process.env): string[] {
  // A run pointed at a host by hand never falls back to another one.
  if (env['SQUADRON_IDE']) return [env['SQUADRON_IDE']];
  const stock =
    testPlatform() === 'win32'
      ? [
          env['LOCALAPPDATA'] &&
            path.join(env['LOCALAPPDATA'], 'Programs', 'Microsoft VS Code', 'Code.exe'),
          env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Microsoft VS Code', 'Code.exe')
        ]
      : ['/Applications/Visual Studio Code.app/Contents/MacOS/Code'];
  return stock.filter((p): p is string => !!p);
}

/** The first candidate that is installed, or a failure naming them all — a
 *  suite that silently skipped would read as a suite that passed. */
export async function installed(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const list = candidates(env);
  for (const candidate of list) {
    const found = await fs.stat(candidate).then(
      (stat) => stat.isFile(),
      () => false
    );
    if (found) return candidate;
  }
  throw new Error(`no IDE to run against; looked in:\n  ${list.join('\n  ')}`);
}

/**
 * The host's version from its bundled `package.json`, or null. macOS keeps it
 * at `Contents/Resources/app`; Windows beside `Code.exe` at `resources/app`,
 * or since 2026 under one commit-named folder (`e646868227/resources/app`).
 * Two such folders (an update in flight) name no version.
 */
export async function version(executable: string): Promise<string | null> {
  const dir = path.dirname(executable);
  const places = [
    path.resolve(dir, '../Resources/app/package.json'),
    path.join(dir, 'resources', 'app', 'package.json')
  ];
  const nested: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory())
      nested.push(path.join(dir, entry.name, 'resources', 'app', 'package.json'));
  }
  const found: string[] = [];
  for (const file of [...places, ...nested]) {
    try {
      const product = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown };
      if (typeof product.version === 'string') found.push(product.version);
    } catch {
      // Not this layout.
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}
