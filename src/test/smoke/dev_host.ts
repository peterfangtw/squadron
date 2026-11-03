import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import * as playwright from 'playwright-core';
import * as win32Paths from '../../core/platform/paths/win32';
import * as ownership from './ownership';
import * as ide from './ide';

const run = util.promisify(childProcess.execFile);
const REPO = path.resolve(__dirname, '../../..');

export async function worktrees(): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: REPO,
      timeout: 5000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      )
    });
    return stdout
      .split('\0')
      .filter((s) => s.startsWith('worktree '))
      .map((s) => s.slice(9));
  } catch {
    // Release candidates are archive extracts, without git metadata.
    return [REPO];
  }
}

export async function closePreviousHosts(
  repos: string[],
  ports?: ownership.CleanupPorts
): Promise<void> {
  const rows = await (ports?.read ?? ownership.readProcesses)();
  const images = new Set(ide.candidates().map((file) => path.win32.basename(file).toLowerCase()));
  const hosts = [...rows.values()].filter((row) => {
    if (row.image !== undefined) return windowsHost(row, repos, images);
    const command = row.command ?? '';
    // ps does not quote argv: match the executable boundary before inspecting flags.
    if (!/^\/(?:\S| (?!-))*?\.app\/Contents\/MacOS\/[^\s]+\s/.test(command)) return false;
    return repos.some((repo) => {
      const flag = ` --extensionDevelopmentPath=${repo}`;
      const at = command.indexOf(flag);
      if (at < 0) return false;
      const rest = command.slice(at + flag.length);
      return rest === '' || /^ --?[a-zA-Z]/.test(rest);
    });
  });
  for (const host of hosts) {
    const launch = ownership.ownLaunch('previous-dev-host', host);
    // Older CLI launches share the caller's group. Own descendants, never that group.
    launch.groups = false;
    ownership.observeLaunch(launch, rows);
    console.log(`closing previous dev host ${host.pid}`);
    await ownership.cleanupLaunch(launch, ports);
  }
}

/**
 * A win32 row is a dev host of `repos` when its image is the IDE's, it is the
 * main process (Electron's helpers carry `--type=`), and one argument word is
 * the flag naming a repo. Windows command lines quote the word whole
 * (`"--extensionDevelopmentPath=C:\…"`, Playwright's spelling); git lists a
 * worktree as `C:/…`. Image and flag name ignore case; the path compares by its
 * win32 key, which folds only the drive letter and separators, because a
 * case-sensitive directory holds `acme-web` and `Acme-Web` as two worktrees.
 */
function windowsHost(
  row: ownership.ProcessIdentity,
  repos: string[],
  images: ReadonlySet<string>
): boolean {
  const command = row.command ?? '';
  if (!images.has((row.image ?? '').toLowerCase()) || /(?:^|[\s"])--type=/.test(command))
    return false;
  const key = (raw: string): string => WIN32_PATHS.key(path.win32.resolve(raw));
  const flagged = new Set(
    (command.match(/"[^"]*"|\S+/g) ?? []).flatMap((word) => {
      const value = /^--extensiondevelopmentpath=(.*)$/i.exec(word.replace(/^"|"$/g, ''))?.[1];
      return value ? [key(value)] : [];
    })
  );
  return repos.some((repo) => flagged.has(key(repo)));
}

/** A command line here is always win32's, whichever OS reads the table. */
const WIN32_PATHS = win32Paths.paths();

async function manualHost(): Promise<void> {
  const connection = await ownership.connectWorker();
  try {
    const profile = path.join(connection.paths.profile, 'data');
    const binary = await ide.installed();
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(
      path.join(profile, 'User/settings.json'),
      JSON.stringify({
        'update.mode': 'none',
        'update.showReleaseNotes': false,
        'extensions.ignoreRecommendations': true,
        'workbench.startupEditor': 'none'
      })
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('VSCODE_')
      )
    );
    const id = await connection.allocate();
    const app = await playwright._electron.launch({
      executablePath: process.env['SQUADRON_SMOKE_LAUNCHER'],
      args: [
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--use-inmemory-secretstorage',
        `--user-data-dir=${profile}`,
        `--extensions-dir=${path.join(connection.paths.profile, 'ext')}`,
        `--extensionDevelopmentPath=${REPO}`,
        '--new-window',
        REPO
      ],
      env: { ...env, SQUADRON_SMOKE_IDE: binary, SQUADRON_SMOKE_LAUNCH: id }
    });
    await new Promise<void>((resolve) => app.once('close', resolve));
    await connection.finish(id);
  } finally {
    await connection.release();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--close')) {
    await closePreviousHosts(await worktrees());
  } else if (process.env['SQUADRON_SMOKE_SOCKET']) {
    await manualHost();
  } else {
    const runner = await import('./runner');
    process.exitCode = await runner.runSmoke([__filename]);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
