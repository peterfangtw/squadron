import type * as cp from 'node:child_process';

export const SOURCE_EXCLUDES: string[];
export function gateRoot(env?: NodeJS.ProcessEnv): string;
export type Reference = { version: 1; gate: string; token: string; generation: number };
export function reference(value: { gate: string; token: string; generation: number }): Reference;
export function validReference(value: unknown): value is Reference;
export function sameJob(record: unknown, value: unknown): boolean;
export function processIdentity(pid: number): {
  version: number;
  pid: number;
  started: string | number | null;
  source: string;
};
export function program(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): {
  command: string;
  args: string[];
};
export function locked<T>(root: string, action: () => T): T;
export function workBusy(workspace: string | undefined, directory: string): boolean;
export function runOwned(options: {
  runner: string;
  file: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  detached?: boolean;
  consoleSignals?: boolean;
  stdio?: 'inherit' | ['ignore' | 'inherit', 'pipe', 'pipe'];
  authority?: { file: string; token: string; generation: number };
  onSpawn?: (child: cp.ChildProcess) => void;
  onReserved?: (job: {
    file: string;
    version: number;
    gate: string;
    token: string;
    generation: number;
  }) => void;
  onBound?: (job: {
    file: string;
    version: number;
    gate: string;
    token: string;
    generation: number;
    wrapper: { pid: number; started: string | number; source: string };
  }) => void;
}): Promise<{ code: number; signal: string | undefined }>;
export type Receipt = { attempt: string; ms: number };
export const CANDIDATE_MAX_AGE_MS: number;
export type VerificationContext = {
  attempt: string;
  manifest: { id: string };
  reuse(key: string, inputs: unknown): Receipt | undefined;
  checkpoint(key: string, inputs: unknown, ms: number): Receipt;
  event(value: Record<string, unknown>): void;
};
export function context(stage?: string): VerificationContext | undefined;
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export class Candidate {
  dir: string;
  workspace: string;
  runs: string;
  token: string | null;
  attempt: string;
  static create(store: string, metadata: Record<string, unknown>): Candidate;
  take(): this;
  release(outcome: string): void;
  context(stage: string): NodeJS.ProcessEnv;
  checkpoint(key: string, inputs: unknown, ms: number): Receipt;
  reuse(key: string, inputs: unknown): Receipt | undefined;
}
