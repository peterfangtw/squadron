import type { Failed, Success, Unsupported } from '../unsupported';

/**
 * The rule a path is held to. Three policies, not three strengths of one: an
 * attachment is any regular file of this user's an agent may send, and never
 * acquires the managed cache's private-mode or link-count rules.
 */
export type Purpose =
  /** The managed incoming directory: this user's, private, a real directory. */
  | 'managed-dir'
  /** A file in it: this user's, private, regular, never a link, one name. */
  | 'managed-file'
  /** A file an agent sends: this user's and regular, whatever its mode or
   *  link count. */
  | 'attachment';

/** Why a path or descriptor did not pass. Each caller words its own. */
export type Fault =
  /** The path breaks its purpose's rule. */
  | 'refused'
  /** Over the caller's byte bound before anything was opened. */
  | 'too-large'
  /** The open failed. */
  | 'unreadable'
  /** The descriptor is not a regular file. */
  | 'not-regular'
  /** The descriptor is another user's. */
  | 'foreign'
  /** The descriptor is not the inode the path showed before the open. */
  | 'moved'
  /** The file ended before the size it stated. */
  | 'incomplete'
  /** The path or the descriptor changed while it was read. */
  | 'changed';

export type Refusal = Failed & { fault: Fault };

/** A held attachment stopped satisfying its rule during a read. */
export class ReadRefusal extends Error {
  constructor(
    readonly fault: Fault,
    message: string
  ) {
    super(message);
  }
}

/** Lossless, backend-versioned object identity; paths never supply identity. */
export type Identity =
  `posix-file-id-v1:${string}:${string}` | `win32-file-id-v1:${string}:${string}`;
export type Checked = { size: number; identity: Identity };

/** What a backend reads off the machine besides the files themselves. */
export interface Effects {
  /** This user's id, read at each call; undefined where the OS has none. */
  uid(): number | undefined;
  tmpdir(): string;
}

/** A managed file this process created and is still writing. */
export interface Created {
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  /** The descriptor's size, if `file` still passes `managed-file` and names
   *  this descriptor's object. A missing path rejects or answers a binding Refusal. */
  bound(file: string): Promise<Success<number> | Refusal>;
  close(): Promise<void>;
}

/** An attachment's descriptor, already held to its rule. */
export interface Opened {
  /** The size the descriptor stated at the open. */
  readonly size: number;
  /** Whether `file` names this descriptor's object now; false when it is gone. */
  bound(file: string): Promise<boolean>;
  /** Bytes read into `buffer` at `offset` from `position`; 0 at the end.
   * A changed binding rejects with ReadRefusal; other IO errors reject as fs does. */
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Owner, mode, link and file-identity checks. Every answer is `Unsupported`
 * where the OS has no backend, before anything is opened or created. IO errors
 * reject as `fs` does; a lost created-file binding may also answer a Refusal. A rule the path breaks is a
 * `Refusal`. Admission, roots, deny lists, digests, quotas, names and expiry
 * are the callers'.
 * Windows retains at most two helpers, each for at most 120 s and at most
 * 30 s without a command; callers must close descriptors within those bounds.
 */
export interface PrivateFiles {
  /** Release backend resources; Windows cancels work and awaits its children. */
  dispose(this: void): Promise<void>;
  /** Where this user's managed directory is: named for the user under the
   *  real temp directory. Neither created nor checked. */
  dir(this: void): Promise<Success<string> | Refusal | Unsupported>;
  /** `dir()`, created privately when absent, answered by its real path when it is
   *  a private directory of this user's now. */
  ensure(this: void): Promise<Success<string> | Refusal | Unsupported>;
  /** Metadata held to `purpose`. */
  check(
    this: void,
    path: string,
    purpose: 'managed-dir' | 'managed-file'
  ): Promise<Success<Checked> | Refusal | Unsupported>;
  /**
   * The whole file through one descriptor: the path checked before the open,
   * the descriptor bound to that inode, the path and descriptor checked again
   * after the read. `max` is the caller's bound, checked before the open.
   */
  read(
    this: void,
    file: string,
    purpose: 'managed-file',
    max: number
  ): Promise<Success<Buffer> | Refusal | Unsupported>;
  /** A new file, exclusively and never through a link, private from its
   *  first byte. */
  create(
    this: void,
    file: string,
    purpose: 'managed-file',
    signal?: AbortSignal
  ): Promise<Success<Created> | Refusal | Unsupported>;
  /** An existing file for reading, never through a link and never waiting
   *  on a FIFO, held to `purpose` by its descriptor. */
  open(
    this: void,
    file: string,
    purpose: 'attachment'
  ): Promise<Success<Opened> | Refusal | Unsupported>;
}

export function refusal(fault: Fault, reason: string): Refusal {
  return { supported: true, status: 'failed', fault, reason };
}
