import type { ChildProcess, SpawnOptions } from 'child_process';
import type { Readable } from 'stream';
import type { Program, Spawned } from '../executables';
import { unsupported, type Unsupported } from '../unsupported';

export type LoginCompletion =
  | { kind: 'exited'; code: number }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string };
export interface LoginChild {
  readonly ready: boolean;
  readonly stdout: Readable;
  readonly stderr: Readable;
  cancel(): void;
  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (completion: LoginCompletion) => void): this;
}
export interface LoginDisposal {
  readonly unresolved: readonly {
    pid: number | undefined;
    birth: string | undefined;
    kind?: 'job';
    monitor?: { pid: number | undefined; birth: string | undefined };
  }[];
}
export interface ConsoleLogin {
  support: { supported: true } | Unsupported;
  run(
    program: Program,
    args: readonly string[],
    options: { cwd: string; beforeLaunch?: (signal: AbortSignal) => Promise<void> }
  ): Spawned<LoginChild> | Unsupported;
  dispose(): Promise<LoginDisposal>;
}
export interface Effects {
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

export function refused(os: NodeJS.Platform): ConsoleLogin {
  const reason = unsupported(
    'consoleLogin',
    os,
    'W7.2: no supported console login runner. Run the login command in a terminal instead.'
  );
  return { support: reason, run: () => reason, dispose: () => Promise.resolve({ unresolved: [] }) };
}
