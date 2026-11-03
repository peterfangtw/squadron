export interface Manifest {
  readonly schema: 1;
  readonly protocol: 1;
  readonly target: 'win32-x64';
  readonly framework: '4.8.1';
  readonly policy: 'development-unsigned';
  readonly referenceEvidence: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly sha256: string;
}
export interface Helper {
  readonly id: 'private-files' | 'console-login';
  readonly source: string;
  readonly name: string;
  readonly recipe: string;
  readonly prefix: string;
  readonly references: readonly string[];
  readonly define: string;
}
export const HELPERS: readonly [Helper, Helper];
export const RECIPE: string;
export function sources(helper: Helper, root: string): Record<string, string>;
export function stagingBuild(root: string): boolean;
export function verifyBuild(helper: Helper, root: string, directory?: string): Manifest | undefined;
export function prepare(helper: Helper, root?: string): Manifest;
export function prepare(
  helper: Helper,
  root: string | undefined,
  options: { required: boolean }
): Manifest | undefined;
export function buildEnvironment(
  helper: Helper,
  root: string,
  environment?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;
export function verify(helper: Helper, root: string, directory?: string): Manifest;
