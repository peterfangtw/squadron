/**
 * The Windows process table and its guarded ending, selected together (W3/W4):
 * a table never exists here without the start-checked kill that acts on it.
 * Reads are one bounded PowerShell each (`win32_reader.ts`), or, while an
 * owner holds a lease, one reusable PowerShell (`win32_owned_reader.ts`).
 */

import { unsupported } from '../unsupported';
import type {
  Effects,
  Evidence,
  Disposal,
  Invocation,
  Lease,
  Member,
  Outcome,
  Processes,
  Row,
  Snapshot,
  StartSource
} from './index';
import * as ownedReader from './win32_owned_reader';
import type { OwnedEffects, OwnedReader, Timing } from './win32_owned_reader';
import * as win32Children from './win32_children';
import * as oneShot from './win32_reader';
import type { NativeRead, NativeRow, ReaderEffects } from './win32_reader';

const SOURCE: StartSource = 'win32-filetime-ms-v1';

export type Win32Effects = ReaderEffects &
  OwnedEffects &
  Pick<Effects, 'kill'> & {
    /** One table read's wall time, for the panel's counters. */
    record(ms: number): void;
  };

/**
 * Nothing starts here or at `own()`: a lease only says where the next read
 * goes. The reader lives from the first leased read until the last lease is
 * disposed (or its own 30 s idle exit), and a read after that is one-shot
 * again, so no late caller is answered by a disposed reader.
 *
 * Every child either kind of read starts is in one `children` for the life
 * of this backend, not of a lease: a child still ending, or one that never
 * closed, holds every later start, one-shot or leased, until it closes, and
 * each disposal reports every child still unresolved.
 */
export function processes(effects: Win32Effects, timing: Timing = ownedReader.TIMING): Processes {
  const children = win32Children.children();
  const once = oneShot.reader(effects, children);
  let owned: OwnedReader | undefined;
  let leases = 0;
  return {
    async snapshot() {
      const began = performance.now();
      try {
        return snapshotOf(await (owned ?? once).read());
      } finally {
        effects.record(performance.now() - began);
      }
    },
    own(): Lease {
      leases += 1;
      owned ??= ownedReader.ownedReader(effects, timing, children);
      const reader = owned;
      let disposed: Promise<Disposal> | undefined;
      return {
        dispose() {
          disposed ??= release(reader);
          return disposed;
        }
      };
    },
    ...signalling(effects)
  };

  async function release(reader: OwnedReader): Promise<Disposal> {
    leases -= 1;
    if (leases === 0 && owned === reader) {
      owned = undefined;
      await reader.dispose();
    }
    return { unresolved: children.unresolved() };
  }
}

/**
 * `stop` asks a process to finish, and Windows has no such request for a pid:
 * Node's `process.kill` sends `TerminateProcess` for SIGTERM as for SIGKILL
 * (`docs/reference/process_signals.md`), which flushes nothing.
 */
const NO_STOP = unsupported(
  'processes.signal stop',
  'win32',
  "TerminateProcess is not a flush request; end through the owner's protocol or stdin EOF"
);

/** The kernel's own: System Idle Process (0) and System (4). */
const KERNEL_PIDS = 4;

/**
 * The guarded ending selected with the reader (human decision 1(a), 2026-10-26).
 *
 * `kill` is `TerminateProcess` on one member, by pid, when the supplied row has
 * its exact start on this clock, complete table or not. There is no group, so
 * `pgid` and `alone` change nothing and no pid is negative. A pid recycled
 * between the read and the call is not caught: the call takes a number, not a
 * handle from the read.
 */
export function signalling(effects: Pick<Effects, 'kill'>): Pick<Processes, 'signals' | 'signal'> {
  return {
    signals: { supported: true },
    signal: (members, intent, evidence) =>
      members.map((member) => (intent === 'stop' ? NO_STOP : terminate(effects, member, evidence)))
  };
}

function terminate(effects: Pick<Effects, 'kill'>, member: Member, evidence: Evidence): Outcome {
  if (
    !Number.isSafeInteger(member.pid) ||
    member.pid <= KERNEL_PIDS ||
    evidence.startSource !== SOURCE ||
    evidence.starts.get(member.pid) !== member.startedAt
  )
    return 'absent';
  try {
    effects.kill(member.pid, 'SIGKILL');
    return 'sent';
  } catch (error) {
    // Node reads an exited process's denied handle as ESRCH: gone, as wanted.
    return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH' ? 'absent' : 'refused';
  }
}

/**
 * A reader's result as the shared snapshot. Rows keep WMI's nulls: no command
 * and no image stay absent, never text.
 */
export function snapshotOf(read: NativeRead): Snapshot {
  if (read.status === 'failed') return read;
  const value = { source: read.value.source, rows: read.value.rows.map(rowOf) };
  return read.status === 'ok'
    ? { supported: true, status: 'ok', value }
    : { supported: true, status: 'incomplete', value, reason: read.reason };
}

function rowOf({ pid, ppid, startedAt, image, command }: NativeRow): Row {
  const invocation = command === null ? undefined : invocationOf(command);
  return {
    pid,
    ppid,
    startedAt,
    command,
    ...(image === null ? {} : { image }),
    ...(invocation === undefined ? {} : { invocation })
  };
}

/**
 * The program token of a Windows command line, as `CreateProcess` finds it
 * when it has no application name: everything inside a leading double quote
 * (to the next quote, or the end), else everything up to the first space or
 * tab. No escape applies to this token. The arguments stay text, because each
 * program parses its own. For example, `"C:/Windows/System32/PING.EXE" -n 1`
 * names `C:/Windows/System32/PING.EXE`. A line
 * that opens with whitespace or an empty quote names no program.
 */
export function invocationOf(command: string): Invocation | undefined {
  const match = command.startsWith('"')
    ? /^"([^"]*)"?([\s\S]*)$/.exec(command)
    : /^([^ \t]*)([\s\S]*)$/.exec(command);
  const program = match?.[1] ?? '';
  if (program === '') return undefined;
  return { program, args: (match?.[2] ?? '').replace(/^[ \t]+/, '') };
}
