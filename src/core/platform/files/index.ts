export interface DirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface Effects {
  open(directory: string, flags: 'r'): Promise<DirectoryHandle>;
  rename(source: string, destination: string): Promise<void>;
}

export interface Files {
  syncDirectory(directory: string): Promise<void>;
  /** One native replacement attempt. Recovery and publication policy belong to the caller. */
  replace(source: string, destination: string): Promise<void>;
  /** A lock file's error meant another process was using it, so waiting can clear it. */
  contended(error: unknown): boolean;
}
