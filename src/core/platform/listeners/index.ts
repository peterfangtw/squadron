import type { Result } from '../unsupported';

/** One socket owner reported by the OS, before directory attribution. */
export type Socket = { port: number; pid: number; command?: string };

export interface Effects {
  run(file: string, args: string[], options: { timeout: number }): Promise<string>;
}

export interface Listeners {
  read(): Promise<Result<Socket[]>>;
  cwds(pids: readonly number[]): Promise<Result<Map<number, string>>>;
}
