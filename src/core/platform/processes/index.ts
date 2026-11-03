/**
 * The machine's processes, as the OS reports them, and a guarded signal to
 * the ones a caller selected from that report.
 *
 * One native table per `snapshot`, with no cache and no classification:
 * `core/scan.ts` keeps the shared one-second cache, the fresh bypass for
 * callers that act, and which rows are a brand's CLI or a shell. `signal`
 * acts on the table its caller already holds, so it never scans, waits or
 * retries: tree selection and member order stay in `core/control.ts`, and
 * grace, escalation, confirmation and retry in `core/session_lifetime.ts`.
 */

import type { Failed, Incomplete, Success, Unsupported } from '../unsupported';

/**
 * Which native clock a start time was read on. Two starts compare only when
 * their sources match, so a persisted identity carries its source and a
 * reader refuses any source not named here.
 *
 * `ps-lstart-v1` is Darwin's `ps lstart`, the spelling persisted incoming
 * identities already carry; a durable record with no source predates the tag
 * and means this one, never the other. `win32-filetime-ms-v1` is the Windows
 * process creation FILETIME floored to the millisecond (`filetimeToUnixMs`).
 * A new OS reader adds its own source rather than reusing either.
 */
export type StartSource = 'ps-lstart-v1' | 'win32-filetime-ms-v1';

const START_SOURCES: ReadonlySet<unknown> = new Set<StartSource>([
  'ps-lstart-v1',
  'win32-filetime-ms-v1'
]);

export function isStartSource(value: unknown): value is StartSource {
  return START_SOURCES.has(value);
}

/** 100 ns units from 1601-01-01 to 1970-01-01 UTC. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

/** 9999-12-31T23:59:59.9999999Z, the last instant .NET's `DateTime` can carry. */
export const FILETIME_MAX = 2_650_467_743_999_999_999n;

/**
 * A canonical decimal FILETIME as `win32-filetime-ms-v1` milliseconds, in
 * integer arithmetic, floored and never rounded: a FILETIME exceeds 2^53, so a
 * float parse can carry a tick into the next millisecond. Before 1970 or past
 * .NET's range is unusable. 2026-10-25, two owned node processes: FILETIME
 * `134374051838139320` and WMI DMTF `20261025203303.813932+480` were both
 * `1792931583813` ms; `134374051838571739` and `…857173+480` were both
 * `1792931583857` ms.
 */
export function filetimeToUnixMs(text: string): number | undefined {
  if (!/^[1-9]\d{0,18}$/.test(text)) return undefined;
  const filetime = BigInt(text);
  if (filetime < FILETIME_UNIX_EPOCH || filetime > FILETIME_MAX) return undefined;
  return Number((filetime - FILETIME_UNIX_EPOCH) / 10_000n);
}

/**
 * One process as the OS reported it. `pgid` is absent where the OS has no
 * process groups, never fabricated from the pid. `command` is null where the
 * OS gave none, which is missing metadata, not a missing process.
 *
 * `image` and `invocation` are absent where the OS reports no such thing
 * (Darwin's `ps`). `image` is the executable file's name as the OS keeps it
 * (WMI `Name`). `invocation` is `command` split at its program token by
 * this OS's command-line grammar, the program unquoted and the arguments left
 * as text: which program a command line names is the OS's syntax, what that
 * program is is `scan`'s.
 */
export type Row = {
  pid: number;
  ppid: number;
  pgid?: number;
  startedAt: number;
  command: string | null;
  image?: string;
  invocation?: Invocation;
};

export type Invocation = { program: string; args: string };

export type Observation = { source: StartSource; rows: Row[] };

/**
 * A complete table, the rows that parsed from an incomplete one, a reader that
 * ran and failed, or no reader on this OS. Only `ok` is a complete table, and
 * neither failure carries rows: nothing here can establish that a process is
 * gone without one.
 */
export type Snapshot = Success<Observation> | Incomplete<Observation> | Failed | Unsupported;

/**
 * The native evidence a snapshot established, as its consumers keep it: a
 * table that came from `scan` satisfies this without this capability knowing
 * `scan`, so an action can hand over the fresh table it just read.
 */
export type Evidence = {
  /** True only for a complete successful native scan. */
  complete?: boolean;
  startSource?: StartSource;
  /** pid -> start time, on `startSource`'s clock. */
  starts: ReadonlyMap<number, number>;
  /** pid -> process group, where the OS reported one. */
  groups: ReadonlyMap<number, number>;
};

/**
 * One process a caller means to signal, as a snapshot saw it.
 *
 * `startedAt` is identity, not decoration: a pid is a number the machine
 * reuses, and a signal can be sent seconds after the member was read. `pgid`
 * is the group the snapshot saw, absent when unknown; `pgid === pid` is an
 * observed leader.
 */
export type Member = { pid: number; pgid?: number; startedAt: number };

/**
 * Ask a process to finish (`stop`), or end it without asking (`kill`). POSIX
 * asks with SIGTERM; Windows has no request a process can act on, so its
 * `stop` is Unsupported rather than a `TerminateProcess` under a gentler name.
 */
export type Intent = 'stop' | 'kill';

/**
 * What one member's signal came to: sent; absent, because it is gone or its
 * number now belongs to another start; refused by the OS; or no signal for
 * this intent on this OS. Only `sent` reached the process, and reaching it is
 * not its death: only a later table without its identity is.
 */
export type Outcome = 'sent' | 'absent' | 'refused' | Unsupported;

export type Effects = {
  /** One bounded run of a native tool, its standard output as text. Rejects on
   *  a failed run or an output past `maxBuffer`. */
  run(file: string, args: readonly string[], options: { maxBuffer: number }): Promise<string>;
  /** Throws as `process.kill` does, with the errno on `code`. */
  kill(pid: number, signal: NodeJS.Signals): void;
};

/**
 * What a disposal could not confirm: pids of reader children that were asked
 * to end (EOF, then a kill) and had not closed by the deadline. Empty is
 * every child closed. A non-empty answer is a leak to report, not a success.
 */
export type Disposal = { unresolved: readonly number[] };

/** One owner's hold on a reusable reader. Settles once its child has closed or
 *  its close deadline has passed, saying which. */
export type Lease = { dispose(): Promise<Disposal> };

export type Processes = {
  snapshot(): Promise<Snapshot>;
  /**
   * Later snapshots come from one reusable reader until every lease is
   * disposed, then from one-shot reads again. A long-lived owner (the
   * extension host) takes one; a standalone CLI never does, so it exits
   * without waiting out an idle child. Starts nothing by itself. A backend
   * whose every read is already cheap and one-shot (`ps`) keeps nothing.
   */
  own(): Lease;
  /** Whether `signal` can act on this OS, answered with no effect, so a
   *  caller can refuse before it spends a scan. */
  readonly signals: { supported: true } | Unsupported;
  /**
   * One outcome per member, in order, each judged by its own row in
   * `evidence`: sent only when that row has the member's exact start on this
   * backend's own clock, whether or not the table as a whole is complete.
   * Completeness is the caller's gate. Group signalling requires both remembered
   * and current observed leadership (pgid === pid), a safe integer > 1.
   * Otherwise the exact pid is signalled; `alone` requires pid even for a
   * corroborated leader, for a session's own root. An OS without groups
   * signals the exact positive pid always. Never throws.
   */
  signal(
    members: readonly Member[],
    intent: Intent,
    evidence: Evidence,
    options?: { alone?: boolean }
  ): Outcome[];
};
