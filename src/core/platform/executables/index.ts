/**
 * Finding a CLI on this machine, and starting what was found.
 *
 * A child of the extension host has no shell, so the search is done here, in
 * the open (`core/bin.ts` says why a login shell is not the answer). Which
 * locations a brand prefers stays in `bin`; this answers what a path is as an
 * executable on this OS, what `PATH` lists, and how a found program is run.
 *
 * A found `Program` is opaque invocation authority: only this capability reads
 * which file and runtime it names, or starts it, so no caller pairs a runner
 * with another path or assembles runner-first argv.
 */

import type {
  ChildProcess,
  ChildProcessByStdio,
  ChildProcessWithoutNullStreams,
  ExecFileOptions,
  SpawnOptions,
  SpawnOptionsWithStdioTuple,
  SpawnOptionsWithoutStdio,
  StdioNull,
  StdioPipe
} from 'child_process';
import type { Readable } from 'stream';
import type { Failed, Success } from '../unsupported';

import { invoke, named, spawned, type Program } from './internal';
export { named, Program } from './internal';

/** Where a brand looks, in its own order of preference. */
export type Candidates = {
  /** The user's setting. Named, it is the only candidate: a path that does
   *  not resolve refuses rather than searching on. */
  setting?: string;
  /** Where the CLI's installer puts it, absolute. Tried before `PATH`. */
  installed: string;
  /** The bare name looked up along `PATH`, in `PATH`'s order. */
  name: string;
};

export type Search =
  | {
      kind: 'found';
      program: Program;
      /** The executable, or under a runner the script: for a log line only. */
      path: string;
      source: 'setting' | 'home' | 'path';
    }
  /** The setting named `file`, which is not one this process can start. */
  | { kind: 'setting'; file: string; refused?: string }
  | { kind: 'missing'; refused?: string };

/** What a spawn returned: the child, or the synchronous throw as a refusal.
 *  Asynchronous failures still arrive as the child's `'error'` event. */
export type Spawned<C> = Success<C> | Failed;

export type Executables = {
  find(candidates: Candidates, env: NodeJS.ProcessEnv): Promise<Search>;
  /** `windowsHide`: without it every child of a GUI host flashes a console
   *  window on win32. No effect elsewhere. */
  spawn(
    program: Program,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio
  ): Spawned<ChildProcessWithoutNullStreams>;
  spawn(
    program: Program,
    args: readonly string[],
    options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>
  ): Spawned<ChildProcessByStdio<null, Readable, Readable>>;
  /** Run to its exit, its output as text. Rejects as `execFile` does, with
   *  `stdout` and `stderr` on the error — a synchronous throw included. */
  exec(
    program: Program,
    args: readonly string[],
    options: Omit<ExecFileOptions, 'encoding' | 'windowsHide'>
  ): Promise<{ stdout: string; stderr: string }>;
};

/** What one path turned out to be. `refused` is a file that answers to the
 *  name and cannot be started from here, said so the refusal can name it. */
export type Located =
  | { kind: 'run'; path: string; runner?: string }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string };

export const NONE: Located = { kind: 'none' };

export function run(file: string, runner?: string): Located {
  return runner ? { kind: 'run', path: file, runner } : { kind: 'run', path: file };
}

/** The half of the capability each OS answers differently. */
export type Locator = {
  join(dir: string, name: string): string;
  /** A setting as a person typed it, as the path it means. */
  expand(file: string): string;
  locate(file: string, env: NodeJS.ProcessEnv): Promise<Located>;
  /** The directories `PATH` names, in its order, with no empty entry. */
  searchPath(env: NodeJS.ProcessEnv): string[];
};

export type Effects = {
  stat(file: string): Promise<{ isFile(): boolean; size: number }>;
  access(file: string, mode: number): Promise<void>;
  readText(file: string): Promise<string>;
  homedir(): string;
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions & { encoding: 'utf8' }
  ): Promise<{ stdout: string; stderr: string }>;
};

/** The capability, from one OS's locator and the effects it runs on. */
export function compose(locator: Locator, effects: Effects): Executables {
  return {
    find: (candidates, env) => find(locator, candidates, env),
    spawn(program: Program, args: readonly string[], options: SpawnOptions) {
      return spawned(() =>
        invoke(program, args, (file, argv) =>
          effects.spawn(file, argv, { ...options, windowsHide: true })
        )
      );
    },
    // Async so a synchronous throw from `execFile` (a NUL) rejects instead.
    async exec(program, args, options) {
      return invoke(program, args, (file, argv) =>
        effects.execFile(file, argv, { ...options, encoding: 'utf8', windowsHide: true })
      );
    }
  } as Executables;
}

async function find(
  locator: Locator,
  candidates: Candidates,
  env: NodeJS.ProcessEnv
): Promise<Search> {
  if (candidates.setting) {
    const file = locator.expand(candidates.setting);
    const found = await locator.locate(file, env);
    if (found.kind === 'run') return { kind: 'found', ...located(found), source: 'setting' };
    return found.kind === 'refused'
      ? { kind: 'setting', file, refused: found.reason }
      : { kind: 'setting', file };
  }

  const installed = await locator.locate(candidates.installed, env);
  if (installed.kind === 'run') return { kind: 'found', ...located(installed), source: 'home' };
  let refused = installed.kind === 'refused' ? installed.reason : undefined;

  // Last, not first: the well-known path is where the CLI installs itself, and
  // a `PATH` entry is whatever else on the machine answers to the name.
  for (const dir of locator.searchPath(env)) {
    const found = await locator.locate(locator.join(dir, candidates.name), env);
    if (found.kind === 'run') return { kind: 'found', ...located(found), source: 'path' };
    if (found.kind === 'refused') refused ??= found.reason;
  }
  return refused === undefined ? { kind: 'missing' } : { kind: 'missing', refused };
}

function located(found: Extract<Located, { kind: 'run' }>): { program: Program; path: string } {
  return { program: named(found.path, found.runner), path: found.path };
}
