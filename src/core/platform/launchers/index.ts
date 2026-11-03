import type { Shell } from '../commands';

/**
 * Filesystem effects for putting one verb on disk. Production passes Node's
 * `fs`; a test passes a fake that throws.
 */
export interface Effects {
  /** Ensure `dir` exists, including missing parents. */
  mkdir(dir: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
}

/**
 * How a shell starts one of our JavaScript files: a program with its quoting
 * policy and the environment it needs, the file as its one argument.
 */
export interface ScriptCommand {
  readonly program: string;
  readonly quoting: 'literal' | 'quoted';
  readonly env?: Readonly<Record<string, string>>;
}

export interface Launchers {
  /** Publish location data for copied CLIs; its contents grant no execution authority. */
  installHelperLocator(this: void, binDir: string, extensionRoot: string): Promise<void>;
  /** Installed JavaScript entry for a caller supplying its own runtime. Pure raw IO path. */
  scriptPath(this: void, binDir: string, name: string): string;
  /** The installed launcher a command written for `shell` names. Pure raw IO path. */
  verbPath(this: void, binDir: string, name: string, shell: Shell): string;
  /**
   * The runtime a hook starts an owned script on. Pure: no file is written,
   * so a digest-named script shared by every host stays bound to none.
   */
  scriptCommand(this: void): ScriptCommand;
  /**
   * Install one owned bundle, best effort per command. POSIX copies its bytes
   * extensionless and chmods 0755. Windows publishes a `.scripts/` payload, then
   * a Git Bash wrapper and a `name.cmd` for PowerShell and cmd, both on the
   * captured IDE runtime. Never throws; a failed publication keeps that file's
   * earlier bytes.
   * Unbound, so activation can hold it.
   */
  install(this: void, binDir: string, name: string, bundle: string): Promise<void>;
}
