export type Kind = 'beat' | 'state' | 'owned';

/** Only these pre-seam replaceFile callers had the Windows retry bound. */
export type LegacyRetryCaller =
  | 'execution-admission'
  | 'checkpoint-index'
  | 'claude-settings'
  | 'grok-mcp-credentials'
  | 'grok-auth-credentials';

export type Budget =
  | { kind: 'beat'; legacyRetry?: never }
  | { kind: 'state' | 'owned'; legacyRetry?: LegacyRetryCaller };

export interface DirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ReplacementStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

export interface Effects {
  stat(file: string): Promise<ReplacementStat>;
  open(directory: string, flags: 'r'): Promise<DirectoryHandle>;
  rename(source: string, destination: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface Files {
  syncDirectory(directory: string): Promise<void>;
  replace(source: string, destination: string, budget: Budget): Promise<void>;
  /** A lock file's error meant another process was using it, so waiting can clear it. */
  contended(error: unknown): boolean;
}
