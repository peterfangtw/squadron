import { execFileSync, spawn } from 'child_process';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WindowClaim } from '../core/model';
import type * as win32Processes from '../core/platform/processes/win32';
import {
  disposeHome,
  homeEnv,
  modeBitsSkip,
  resetDir,
  tempHome,
  testPlatform,
  writeJson
} from './home';

export { disposeHome, homeEnv, modeBitsSkip, resetDir, tempHome, testPlatform, writeJson };

export function posixShell(): { bin: string; skip: false } | { skip: string } {
  if (testPlatform() !== 'win32') return { bin: 'sh', skip: false };
  const bin = gitBash();
  return bin === undefined
    ? { skip: 'env: Git Bash is unavailable for the POSIX quoting oracle' }
    : { bin, skip: false };
}

/**
 * Git for Windows' `bin\bash.exe`, win32 only. Every `git.exe` on PATH is a
 * candidate, not the first: Grok puts its embedded MinGit first on its tool
 * shells' PATH, and that one ships no `bin\bash.exe` (observed 2026-10-27).
 * A bare `bash.exe` on PATH is the last candidate. Each must answer `uname -s`
 * as MINGW or MSYS, which `System32\bash.exe` (WSL) does not.
 */
export function gitBash(): string | undefined {
  const where = (name: string): string[] => {
    try {
      return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const viaGit = where('git').flatMap((git) => {
    try {
      const execPath = execFileSync(git, ['--exec-path'], {
        encoding: 'utf8',
        windowsHide: true
      }).trim();
      return [path.resolve(execPath, '../../../bin/bash.exe')];
    } catch {
      return [];
    }
  });
  return [...viaGit, ...where('bash')].find((bin) => {
    try {
      const kernel = execFileSync(bin, ['--noprofile', '--norc', '-c', 'uname -s'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });
      return /^(MINGW|MSYS)/.test(kernel);
    } catch {
      return false;
    }
  });
}

/** Repo root. This file stays at `src/test/`, so `out/test/helpers.js` is two levels below it. */
/**
 * A live window's claim with Orchestration on: what a write verb's gate
 * (`cli/gate.ts`) reads before it lets a bundle go any further.
 */
export function liveClaim(over: Partial<WindowClaim> = {}): WindowClaim {
  return {
    id: 'window',
    label: 'fixture',
    app: 'IDE',
    shellPids: [],
    orchestration: true,
    updatedAt: Date.now(),
    ...over
  };
}

/** `liveClaim` written where `readClaims` looks under `home`. */
export async function writeLiveClaim(home: string, over: Partial<WindowClaim> = {}): Promise<void> {
  const claim = liveClaim(over);
  await writeJson(path.join(home, '.squadron', 'windows', `${claim.id}.json`), claim);
}

export function repoRoot(): string {
  return path.join(__dirname, '..', '..');
}

/** `out/`, one level above this file's compiled directory. */
export function outRoot(): string {
  return path.join(__dirname, '..');
}

/**
 * A directory link that needs no privilege anywhere. On win32 a symlink needs
 * Developer Mode or elevation and a junction needs neither; `realpath` and
 * `lstat` treat both as links. Elsewhere the type is ignored, so macOS and
 * Linux get the symlink they always did.
 */
export function linkDir(target: string, at: string): Promise<void> {
  return fs.symlink(target, at, 'junction');
}

let fileLinks: boolean | undefined;

/**
 * `skip` for a test of how the product treats a symlinked *file*. Such a
 * link has no unprivileged substitute on win32 — a hard link or a copy is not
 * a link to the product — and a machine that cannot make one cannot have the
 * file the test guards either.
 */
export function needsFileSymlinks(): false | string {
  fileLinks ??= probeFileLink();
  if (fileLinks) return false;
  return testPlatform() === 'win32'
    ? 'win32: a file symlink needs Developer Mode or elevation'
    : 'env: this filesystem makes no file symlinks';
}

function probeFileLink(): boolean {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'squadron-link-'));
  try {
    fsSync.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

/** `stop` ends the process and resolves once it has closed and its files are gone. */
export type FakeProcess = { pid: number; stop: () => Promise<void> };

/**
 * The selected Windows capability's effects for a test that supplies every
 * table itself: a read fails before any spawn (no Windows directory), and
 * `kill` is the test's own.
 */
export function tablesSupplied(
  kill: (pid: number, signal: NodeJS.Signals) => void
): win32Processes.Win32Effects {
  const none = (): never => {
    throw new Error('this test supplies its tables');
  };
  return { windowsDirectory: undefined, run: none, start: none, kill, record: () => {} };
}

/**
 * A live process that `ps` reports as `claude`. A symlink rather than a copy:
 * the kernel still executes the signed `/bin/sleep`, and `argv[0]` — which is
 * all the scanner looks at — is the name we linked it as.
 */
export function fakeClaude(seconds = 120): Promise<FakeProcess> {
  return fakeNamed('claude', seconds);
}

export function fakeGrok(seconds = 120): Promise<FakeProcess> {
  return fakeNamed('grok', seconds);
}

/**
 * A live child of this process that `ps` reports as a shell, which is what a
 * session running a command looks like from the outside. Still `/bin/sleep`
 * underneath: a real `sh -c` would exec its command and leave no shell behind.
 * On win32 it is `bash`, a Windows tool shell (`scan.ts` `WINDOWS_SHELLS`).
 */
export function fakeShell(): Promise<FakeProcess> {
  return fakeNamed(testPlatform() === 'win32' ? 'bash' : 'zsh', 120);
}

/** `seconds` is the fixture's lifetime; `boot.ts` says why the barrel picks its own. */
async function fakeNamed(name: string, seconds: number): Promise<FakeProcess> {
  if (testPlatform() === 'win32') return fakeWindowsNamed(name, seconds);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-bin-'));
  const bin = path.join(dir, name);
  await fs.symlink('/bin/sleep', bin);

  const child = spawn(bin, [String(seconds)], { stdio: 'ignore' });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // `ps` can lag the spawn by a beat on a loaded machine.
  await new Promise((resolve) => setTimeout(resolve, 250));

  return {
    pid: child.pid ?? 0,
    stop: async () => {
      child.kill('SIGKILL');
      await closed;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * win32: a copy of the system's 45 KB `PING.EXE` named `<name>.exe`, pinging
 * loopback once a second. The table names a Windows row by its image, so it
 * reads as `name`, and `-n` is a first argument, so a `claude` is not taken
 * for the CLI's plumbing. A copy, because a hard link to `node.exe` is
 * refused without elevation (EPERM, 2026-10-26). Its file is removed only
 * after the process has closed: Windows will not delete a running image.
 */
async function fakeWindowsNamed(name: string, seconds: number): Promise<FakeProcess> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-bin-'));
  const bin = path.join(dir, `${name}.exe`);
  await fs.copyFile(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'),
    bin
  );
  const child = spawn(bin, ['-n', String(seconds + 1), '127.0.0.1'], {
    stdio: 'ignore',
    windowsHide: true
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return {
    pid: child.pid ?? 0,
    stop: async () => {
      child.kill('SIGKILL');
      await closed;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  };
}

/** 100 ns units from 1601 to 1970. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/**
 * A Claude pid file's `procStart` for a process the table dates at `ms`, as
 * this platform's CLI writes it: a canonical FILETIME on win32 (2.1.296),
 * which a Windows table requires (processes Step 4 F1); `ps`-style UTC
 * elsewhere.
 */
export function procStartFor(ms: number): string {
  return testPlatform() === 'win32'
    ? String(BigInt(ms) * 10_000n + FILETIME_UNIX_EPOCH)
    : utcProcStart(ms);
}

/** `ps`-style local time, which is what the CLI records in UTC. */
export function utcProcStart(ms: number): string {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`
  );
}

/**
 * One window of a reading, by id. Windows are a list rather than two named
 * fields, so a test that used to say `usage?.session` says `win(usage, 'session')`
 * — and a brand that never states a window gets `undefined` here rather than a
 * field that silently reads as absent.
 */
type TestWindow = {
  id: string;
  short: string;
  pct?: number | null;
  resetsAt?: number;
  /** When this window's figure was observed — see `RateWindow.at`. Declared here
   *  too so a test can assert the age a merged figure carried with it. */
  at?: number;
};

export function win(
  view: { windows: TestWindow[] } | undefined,
  id: string
): TestWindow | undefined {
  return view?.windows.find((window) => window.id === id);
}

/** The most recent assistant row, including a row still being written. */
export function threadText(
  handle: Pick<import('../core/adapter').SessionHandle, 'thread'>
): string {
  const shot = handle.thread.snapshot();
  const rows = [...shot.recent.exchanges];
  shot.tail.forEach((row, added) => rows.splice(row.position + added, 0, row.exchange));
  for (const row of rows.reverse()) {
    if ('role' in row && row.role === 'assistant' && row.text) return row.text;
  }
  return '';
}

export type ThreadState = import('../core/live').LiveState & { words: string };

export function threadState(
  handle: Pick<import('../core/adapter').SessionHandle, 'state' | 'thread'>
): ThreadState {
  return { ...handle.state, words: threadText(handle) };
}

/** Text changes notify the thread independently of the card state. */
export function onThreadState(
  handle: import('../core/adapter').SessionHandle,
  listener: (state: ThreadState) => void
): () => void {
  const changed = () => listener(threadState(handle));
  const stopState = handle.onChange(changed);
  const stopThread = handle.thread.onChange(changed);
  return () => {
    stopState();
    stopThread();
  };
}
