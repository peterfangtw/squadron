/**
 * The process table from `/bin/ps`, and POSIX signals to its members. Linux
 * and the other non-win32 hosts select it too, unverified and unchanged,
 * missing-tool failure included.
 */

import type {
  Effects,
  Evidence,
  Intent,
  Member,
  Outcome,
  Processes,
  Row,
  Snapshot,
  StartSource
} from './index';

const SOURCE: StartSource = 'ps-lstart-v1';

/** Past this a `ps` is refused as failed rather than read short. */
const MAX_OUTPUT = 8 * 1024 * 1024;

const NATIVE: Record<Intent, NodeJS.Signals> = { stop: 'SIGTERM', kill: 'SIGKILL' };

export function processes(effects: Effects): Processes {
  return {
    snapshot: () => snapshot(effects),
    // Every read is its own `ps`, which exits with its answer: nothing to keep.
    own: () => ({ dispose: () => Promise.resolve({ unresolved: [] }) }),
    signals: { supported: true },
    signal: (members, intent, evidence, options) =>
      members.map((member) => signal(effects, member, intent, evidence, options?.alone === true))
  };
}

/**
 * One member, if the table still agrees it is the process that was read.
 *
 * A start time that has moved means the pid was recycled, which is a different
 * program wearing the same number — the one case where signalling is worse than
 * doing nothing. A pid the table has forgotten fails the same test, and so does
 * a table read on another clock, so the default is to send nothing.
 *
 * **Group signalling requires remembered and current observed leadership.**
 * The CLI starts every tool call as a group leader, and a group outlives the
 * parent link: `-pid` therefore reaches children spawned after the member was
 * read, and children already reparented away from it. Anything else is
 * signalled alone, because its group belongs to something that was never ours
 * to stop: an owned session sits in the IDE's own group, and `-pgid` there
 * would take the IDE down with it.
 *
 * One consequence worth knowing: a group whose *leader* has already exited is
 * never signalled by group, even though POSIX keeps the group alive while any
 * member lives. The members listed individually still get theirs; what is lost
 * is anything spawned into that group after the snapshot was taken.
 */
function signal(
  effects: Effects,
  member: Member,
  intent: Intent,
  evidence: Evidence,
  alone: boolean
): Outcome {
  if (
    !Number.isSafeInteger(member.pid) ||
    member.pid <= 1 ||
    evidence.startSource !== SOURCE ||
    evidence.starts.get(member.pid) !== member.startedAt
  )
    return 'absent';
  try {
    const leader =
      !alone && member.pgid === member.pid && evidence.groups.get(member.pid) === member.pid;
    effects.kill(leader ? -member.pid : member.pid, NATIVE[intent]);
    return 'sent';
  } catch (error) {
    // Already gone is the outcome a signal wanted anyway.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'refused';
  }
}

/**
 * `lstart` is printed in local time and parses directly; the CLI's session
 * files record the same instant in UTC, which is reconciled where they meet.
 */
async function snapshot(effects: Effects): Promise<Snapshot> {
  let stdout: string;
  try {
    stdout = await effects.run('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,lstart=,command='], {
      maxBuffer: MAX_OUTPUT
    });
  } catch (error) {
    return {
      supported: true,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const rows: Row[] = [];
  let malformed = 0;
  for (const text of stdout.split('\n')) {
    const row = parseRow(text);
    if (row) rows.push(row);
    else if (text.trim()) malformed++;
  }
  const value = { source: SOURCE, rows };
  return malformed
    ? {
        supported: true,
        status: 'incomplete',
        value,
        reason: `ps printed ${malformed} unreadable rows`
      }
    : { supported: true, status: 'ok', value };
}

/**
 * One `ps -Ao pid=,ppid=,pgid=,lstart=,command=` row, or `undefined` for
 * anything that is not one.
 *
 * `lstart` is *not* fixed width: the day of the month is space-padded, so
 * "Wed Jun 24" and "Sat Aug  1" differ by a column. The gap before the day is
 * therefore ` +` rather than one optional space. With the optional space,
 * every process started on a single-digit day went unparsed — invisible to
 * liveness, ancestry and start times alike — and on the 1st of a month that
 * is every process the panel would ever watch start. `Date.parse` takes the
 * padded form as it stands, so only the match had to change.
 *
 * Exported for smoke's own process oracle, which reads `ps` beside the host.
 */
export function parseRow(text: string): (Row & { pgid: number; command: string }) | undefined {
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(text);
  if (!match) {
    return undefined;
  }
  // Defaults only to satisfy the compiler: a match has every group.
  const [, rawPid = '', rawPpid = '', rawPgid = '', lstart = '', command = ''] = match;
  return {
    pid: Number(rawPid),
    ppid: Number(rawPpid),
    pgid: Number(rawPgid),
    startedAt: Date.parse(lstart),
    command
  };
}
