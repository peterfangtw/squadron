/**
 * The board a wait pass judges, and how far it can be trusted
 * (`host/waits.ts` `board`). `vscode`-free so its evidence is tested.
 *
 * One table and one read of each store feed both the board and its
 * confidence. The published records are read once and every brand joins
 * against them; each brand reads its own files once and says, on the same
 * pass, which it could not decode and which sessions it knows finished. So a
 * member that fell off the board because its record or pid file went unread
 * is told from one whose process ended, or whose job did, without a second
 * read that could disagree with the first.
 *
 * **A member's command is read off this table, not only off its twin.** The
 * live half writes `hasCommand: false` for every session it builds — the fact
 * is on no frame — and only discovery's twin carries it into the fold. A
 * member whose record or pid file went unread has no twin, so its folded
 * `false` says nothing. A table that is not complete cannot say a member has
 * no command, so every member then runs one (the keep-awake rule); a watched
 * exit still settles it.
 */

import { discoverAll } from '../adapter';
import { sessionBrand } from '../brands';
import type { Session } from '../model';
import { isStartSource } from '../platform/processes';
import { passEvidence, publicationsKnown, readPublishedEvidence } from '../published';
import { runsCommand, type ProcessTable } from '../scan';
import { foldTwins } from '../../ui/views';
import type { WaitMember } from './wait';

export type WaitBoard = {
  members: WaitMember[];
  /** Whether the table was complete on a recognized clock. */
  processes: 'complete' | 'unknown';
  /** Every pid of that complete table; absent when it was not complete. */
  running?: ReadonlySet<number>;
  /** Pids that still run but whose session is positively known finished. */
  retired: ReadonlySet<number>;
  /** Whether every record and brand file a running pid has was read. */
  records: 'complete' | 'unknown';
};

export async function waitBoard(
  owned: readonly Session[],
  table: ProcessTable,
  ended: (pid: number) => boolean
): Promise<WaitBoard> {
  const evidence = passEvidence(await readPublishedEvidence());
  const discovered = await discoverAll(undefined, table, evidence);
  const complete = table.complete === true && isStartSource(table.startSource);
  const unread = [...evidence.unread].some((pid) => table.starts.has(pid));
  return {
    members: foldTwins(owned, discovered, new Map(evidence.published.records)).map((session) => ({
      ...session,
      hasCommand:
        !complete ||
        session.hasCommand ||
        runsCommand(table, session.pid, sessionBrand(session.brand)),
      ended: ended(session.pid)
    })),
    processes: complete ? 'complete' : 'unknown',
    ...(complete ? { running: new Set(table.starts.keys()) } : {}),
    retired: evidence.retired,
    records:
      evidence.listed && publicationsKnown(evidence.published, table) && !unread
        ? 'complete'
        : 'unknown'
  };
}
