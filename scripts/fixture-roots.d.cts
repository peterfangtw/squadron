export function create(prefix?: string): string;
export function environment(
  home: string
): Record<'HOME' | 'USERPROFILE' | 'TMP' | 'TEMP' | 'TMPDIR', string>;
export function withoutCliRoots(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function validate(home: string, target: string): void;
export function remove(home: string): void;
