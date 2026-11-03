import type { Manifest } from './windows-helper-artifacts.mjs';
export type { Manifest } from './windows-helper-artifacts.mjs';
export function sources(root: string): Record<string, string>;
export function stagingBuild(root: string): boolean;
export function verifyBuild(root: string, directory?: string): Manifest | undefined;
export function prepare(root?: string): Manifest;
export function prepare(
  root: string | undefined,
  options: { required: boolean }
): Manifest | undefined;
export function buildEnvironment(root: string, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function verify(root: string, directory?: string): Manifest;
