import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import type { Effects as CopyEffects, Launchers } from './index';

export interface Effects extends CopyEffects {
  /** The actual extension host's executable; D1 applies only to our bundles. */
  readonly runtime: string;
  /** Read at install, to name a non-ASCII runtime through a variable cmd expands. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  writeFile(file: string, text: string): Promise<void>;
  readFile(file: string): Promise<string>;
  lstat(file: string): Promise<Pick<Stats, 'isFile'>>;
  report(message: string): void;
  /** Complete-file publication, with the platform's owned-file budget. */
  replace(source: string, destination: string): Promise<void>;
  remove(file: string): Promise<void>;
}

/**
 * Git Bash runs the extensionless sh wrapper; Windows PowerShell and cmd run
 * `name.cmd`. Both start the captured runtime on the same `.scripts/` payload.
 */
export function launchers(effects: Effects): Launchers {
  return {
    async installHelperLocator(binDir, extensionRoot) {
      if (!path.win32.isAbsolute(extensionRoot) || extensionRoot.length > 4096) return;
      const destination = path.win32.join(binDir, '.scripts', 'private-files-v1.locator.json');
      try {
        await effects.mkdir(path.win32.dirname(destination));
        await publish(effects, destination, (tmp) =>
          effects.writeFile(tmp, JSON.stringify({ schema: 1, protocol: 1, extensionRoot }))
        );
      } catch {
        effects.report('Squadron could not publish its private-files helper location.');
      }
    },
    scriptPath,
    // PowerShell hands the extensionless sh file to its file association.
    verbPath: (binDir, name, shell) =>
      path.win32.join(binDir, shell === 'posix' ? name : `${name}.cmd`),
    // Observed drive paths carry this inline form in both shells (2026-10-27).
    scriptCommand: () => ({
      program: effects.runtime,
      quoting: 'quoted',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }),
    async install(binDir, name, bundle) {
      const script = scriptPath(binDir, name);
      try {
        await effects.mkdir(path.win32.dirname(script));
        await publish(effects, script, (tmp) => effects.copyFile(bundle, tmp));
      } catch {
        // One missing bundle is one command lost.
        return;
      }
      // Git Bash rewrites a POSIX-looking argument (`/runs/x`, `--cwd-path=/tmp`)
      // for a native child unless MSYS_NO_PATHCONV is set (2026-10-27).
      // Doubled backslashes are lost earlier, at the native-to-bash -c hop;
      // commands.carries refuses them independently of MSYS path conversion.
      const sh = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 MSYS_NO_PATHCONV=1 exec ${shellPath(effects.runtime)} ${shellPath(script)} "$@"\n`;
      await publish(effects, path.win32.join(binDir, name), async (tmp) => {
        await effects.writeFile(tmp, sh);
        await effects.chmod(tmp, 0o755);
      }).catch(() => {});
      const cmd = cmdText(effects, name);
      if (cmd === undefined) return;
      const destination = path.win32.join(binDir, `${name}.cmd`);
      if (!(await admitLauncher(effects, destination))) return;
      await publish(effects, destination, (tmp) => effects.writeFile(tmp, cmd)).catch(() => {});
    }
  };
}

const CMD_MARKER = 'rem Squadron launcher, rewritten on each activation.';

/** Marked launchers are generated runtime bindings, refreshed even after edits. */
async function admitLauncher(effects: Effects, destination: string): Promise<boolean> {
  try {
    let stat: Pick<Stats, 'isFile'>;
    try {
      stat = await effects.lstat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (stat.isFile()) {
      const text = await effects.readFile(destination);
      if (text.split(/\r?\n/).includes(CMD_MARKER)) return true;
    }
  } catch {
    // Unknown ownership is a refusal, including unreadable files and links.
  }
  effects.report(
    `Squadron preserved launcher ${destination}: not a recognized owned regular file.`
  );
  return false;
}

/** An adjacent `.js` is a PATHEXT command and can invoke Windows Script Host. */
function scriptPath(binDir: string, name: string): string {
  return path.win32.join(binDir, '.scripts', `${name}.js`);
}

async function publish(
  effects: Effects,
  destination: string,
  write: (temporary: string) => Promise<void>
): Promise<void> {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await write(temporary);
    await effects.replace(temporary, destination);
  } finally {
    await effects.remove(temporary).catch(() => {});
  }
}

/** Git Bash accepts drive paths with forward slashes, including spaces and Unicode. */
function shellPath(native: string): string {
  return `'${native.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

/**
 * cmd decodes a batch file in the console code page (950 on the observed
 * machine), so the text stays ASCII: the payload through `%~dp0`, which cmd
 * expands as UTF-16, and a non-ASCII runtime through a variable naming its
 * prefix. Neither expansion is re-expanded; a literal `%` is doubled. `%*`
 * forwards the arguments as cmd received them. Delayed expansion is off so a
 * `!` received from the caller survives inside the launcher; it cannot undo
 * expansion in the calling shell. `setlocal` also scopes the runtime switch.
 * Undefined when the runtime cannot be named in ASCII: that verb keeps only
 * its sh wrapper.
 */
function cmdText(effects: Effects, name: string): string | undefined {
  const runtime = cmdRuntime(effects.runtime, effects.environment);
  if (runtime === undefined) return undefined;
  return [
    '@echo off',
    CMD_MARKER,
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${runtime}" "%~dp0.scripts\\${name}.js" %*`,
    ''
  ].join('\r\n');
}

const PREFIXES = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramFiles(x86)'];

function cmdRuntime(
  runtime: string,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined {
  const ascii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);
  const escape = (text: string): string => text.replaceAll('%', '%%');
  if (ascii(runtime)) return escape(runtime);
  for (const name of PREFIXES) {
    const key = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
    const prefix = key === undefined ? undefined : environment[key];
    if (!prefix) continue;
    const base = prefix.replace(/\\+$/, '');
    const rest = runtime.slice(base.length);
    const under = runtime.slice(0, base.length).toLowerCase() === base.toLowerCase();
    if (under && rest.startsWith('\\') && ascii(rest)) {
      return `%${name}%${escape(rest)}`;
    }
  }
  return undefined;
}
