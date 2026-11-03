import { refused as loginRefused, type ConsoleLogin } from './console_login';
import * as darwinLogin from './console_login/darwin';
import * as win32Login from './console_login/win32';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Effects as FileEffects, Files } from './files';
import * as darwinFiles from './files/darwin';
import * as win32Files from './files/win32';
import { promisify } from 'util';
import { host } from './host';
import type { Commands } from './commands';
import * as darwinCommands from './commands/darwin';
import * as win32Commands from './commands/win32';
import type { Effects as LauncherEffects, Launchers } from './launchers';
import * as darwinLaunchers from './launchers/darwin';
import * as win32Launchers from './launchers/win32';
import type { Effects as ExecutableEffects, Executables } from './executables';
import * as darwinExecutables from './executables/darwin';
import * as win32Executables from './executables/win32';
import * as perf from '../perf';
import { refused as memoryRefused, type Effects as MemoryEffects, type Memory } from './memory';
import * as darwinMemory from './memory/darwin';
import * as linuxMemory from './memory/linux';
import * as win32Memory from './memory/win32';
import type { Effects as ListenerEffects, Listeners } from './listeners';
import * as darwinListeners from './listeners/darwin';
import * as win32Listeners from './listeners/win32';
import type { Paths } from './paths';
import * as darwinPaths from './paths/darwin';
import * as win32Paths from './paths/win32';
import { refused, type Effects as PowerEffects, type Power } from './power';
import * as darwinPower from './power/darwin';
import * as win32Power from './power/win32';
import type { Effects as PrivateFileEffects, PrivateFiles } from './private_files';
import * as darwinPrivateFiles from './private_files/darwin';
import * as win32PrivateFiles from './private_files/win32';
import * as privateFacility from './private_files/facility';
import type { Effects as ProcessEffects, Processes } from './processes';
import * as darwinProcesses from './processes/darwin';
import * as win32Processes from './processes/win32';
import * as win32Run from './processes/win32_run';

export type Implementations<T> = {
  darwin: () => T;
  win32: () => T;
  linux?: () => T;
  /** Identical legacy POSIX path, or an inert unsupported implementation. */
  posix: () => T;
};

/**
 * Called once per capability at composition; factories capture only their own effects.
 * Each call site is marked pure because a factory starts nothing: esbuild then drops
 * a capability a CLI bundle never reads, 2–9 KB of growth per verb instead of 27–35 KB.
 */
export function select<T>(implementations: Implementations<T>, os: NodeJS.Platform = host): T {
  if (os === 'darwin') return implementations.darwin();
  if (os === 'win32') return implementations.win32();
  if (os === 'linux' && implementations.linux) return implementations.linux();
  return implementations.posix();
}

const execFileText = promisify(execFile);

/** The machine's own files and children, as the executables capability uses them. */
export const executableEffects: ExecutableEffects = {
  stat: (file) => fs.stat(file),
  access: (file, mode) => fs.access(file, mode),
  readText: (file) => fs.readFile(file, 'utf8'),
  homedir: () => os.homedir(),
  spawn: (file, args, options) => spawn(file, args, options),
  execFile: (file, args, options) => execFileText(file, args, options)
};

export const executables: Executables = /* @__PURE__ */ select({
  darwin: () => darwinExecutables.executables(executableEffects),
  win32: () => win32Executables.executables(executableEffects),
  posix: () => darwinExecutables.executables(executableEffects)
});

const fileEffects: FileEffects = {
  stat: (file) => fs.stat(file),
  open: (directory, flags) => fs.open(directory, flags),
  rename: (source, destination) => fs.rename(source, destination),
  sleep: (ms) => sleep(ms)
};

export const files: Files = /* @__PURE__ */ select({
  darwin: () => darwinFiles.files(fileEffects),
  win32: () => win32Files.files(fileEffects),
  posix: () => darwinFiles.files(fileEffects)
});

const processEffects: ProcessEffects = {
  // Every table read is one `ps` in the panel's counters, a failed one too.
  async run(file, args, options) {
    const began = performance.now();
    try {
      return (await execFileText(file, args, { ...options, encoding: 'utf8' })).stdout;
    } finally {
      perf.record('ps', performance.now() - began);
    }
  },
  // Read at the call, never captured, so the live `process.kill` decides.
  kill: (pid, signal) => {
    process.kill(pid, signal);
  }
};

/**
 * Windows PowerShell, absolute and hidden, never through PATH: one bounded
 * run per one-shot read, or one owned child with all three streams piped.
 * Its working directory is PowerShell's own, so a reader never holds a
 * caller's directory open against removal.
 */
const win32ProcessEffects: win32Processes.Win32Effects = {
  // Read at the call; the reader refuses a missing or relative one before any spawn.
  get windowsDirectory() {
    return process.env.SystemRoot;
  },
  run: win32Run.boundedRun((file, args, options) =>
    spawn(file, [...args], { ...options, cwd: path.win32.dirname(file) })
  ),
  start: (file, args) =>
    spawn(file, [...args], { cwd: path.win32.dirname(file), windowsHide: true }),
  kill: (pid, signal) => processEffects.kill(pid, signal),
  record: (ms) => perf.record('ps', ms)
};

export const processes: Processes = /* @__PURE__ */ select({
  darwin: () => darwinProcesses.processes(processEffects),
  win32: () => win32Processes.processes(win32ProcessEffects),
  posix: () => darwinProcesses.processes(processEffects)
});

export const paths: Paths = /* @__PURE__ */ select({
  darwin: () => darwinPaths.paths(),
  win32: () => win32Paths.paths(),
  posix: () => darwinPaths.paths()
});

export const commands: Commands = /* @__PURE__ */ select({
  darwin: () => darwinCommands.commands(),
  win32: () => win32Commands.commands(),
  posix: () => darwinCommands.commands()
});

const launcherEffects: LauncherEffects = {
  async mkdir(dir) {
    await fs.mkdir(dir, { recursive: true });
  },
  copyFile: (source, destination) => fs.copyFile(source, destination),
  chmod: (file, mode) => fs.chmod(file, mode)
};

export const launchers: Launchers = /* @__PURE__ */ select({
  darwin: () => darwinLaunchers.launchers(launcherEffects),
  win32: () =>
    win32Launchers.launchers({
      ...launcherEffects,
      runtime: process.execPath,
      environment: process.env,
      readFile: (file) => fs.readFile(file, 'utf8'),
      lstat: (file) => fs.lstat(file),
      report: (message) => console.warn(message),
      writeFile: (file, text) => fs.writeFile(file, text, { flag: 'wx' }),
      replace: (source, destination) => files.replace(source, destination, { kind: 'owned' }),
      remove: (file) => fs.rm(file, { force: true })
    }),
  posix: () => darwinLaunchers.launchers(launcherEffects)
});

const powerEffects: PowerEffects = {
  async run(file, args, options) {
    return (await execFileText(file, [...args], { ...options, encoding: 'utf8' })).stdout;
  },
  spawn: (file, args) => spawn(file, [...args], { stdio: 'ignore' })
};

export const power: Power = /* @__PURE__ */ select({
  darwin: () => darwinPower.power(powerEffects),
  win32: () => win32Power.power(),
  // Linux's nearest lock is systemd-inhibit, and neither it nor a reader was
  // ever built: the same refusal as before the seam.
  posix: () => refused(host, 'no sleep assertion or battery reader')
});

const memoryEffects: MemoryEffects = {
  async run(file, options) {
    return (await execFileText(file, { ...options, encoding: 'utf8' })).stdout;
  },
  readText: (file) => fs.readFile(file, 'utf8'),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem()
};

export const memory: Memory = /* @__PURE__ */ select({
  darwin: () => darwinMemory.memory(memoryEffects),
  linux: () => linuxMemory.memory(memoryEffects),
  win32: () => win32Memory.memory(memoryEffects),
  posix: () => memoryRefused(host)
});

const listenerEffects: ListenerEffects = {
  async run(file, args, options) {
    return (await execFileText(file, args, { ...options, windowsHide: true })).stdout;
  }
};

export const listeners: Listeners = /* @__PURE__ */ select({
  darwin: () => darwinListeners.listeners(listenerEffects),
  win32: () =>
    win32Listeners.listeners({
      run: (file, args, options) => listenerEffects.run(file, args, options),
      get windowsDirectory() {
        return process.env.SystemRoot;
      }
    }),
  posix: () => darwinListeners.listeners(listenerEffects)
});

const privateFileEffects: PrivateFileEffects = {
  // Read at the call, never captured, so the live uid and temp directory decide.
  uid: () => process.getuid?.(),
  tmpdir: () => os.tmpdir()
};

export const privateFiles: PrivateFiles = /* @__PURE__ */ select({
  darwin: () => darwinPrivateFiles.privateFiles(privateFileEffects),
  win32: () =>
    win32PrivateFiles.privateFiles({
      artifact: () => privateFacility.artifactBeside(__dirname),
      tmpdir: () => os.tmpdir()
    }),
  posix: () => darwinPrivateFiles.privateFiles(privateFileEffects)
});

export const consoleLogin: ConsoleLogin = /* @__PURE__ */ select({
  darwin: () =>
    darwinLogin.consoleLogin({ spawn: (file, args, options) => spawn(file, args, options) }),
  win32: () =>
    win32Login.consoleLogin({
      architecture: process.arch,
      spawn: (file, args, options) => spawn(file, args, options),
      artifact: () => win32Login.artifactAt(__dirname),
      readArtifact: win32Login.readArtifact,
      ownerPid: process.pid
    }),
  posix: () => loginRefused(host)
});
