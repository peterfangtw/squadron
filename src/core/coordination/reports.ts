/**
 * A member's report, held while its wait is open so it arrives with the
 * convergence rather than before it. Without the hold, the children still
 * report and the convergence is an extra message: measured 2026-08-26, two
 * children, four wakes.
 *
 * The store and the rule, pure and `vscode`-free. `host/waits.ts` delivers,
 * releases, and gives up.
 *
 * Nothing here drops a report, because a shim cannot tell a redundant "done"
 * ping from a correction. One observed "redundant" second report carried
 * *"src/core/frames.ts does not exist; used src/core/claude/frames.ts"*, a
 * correction to the parent's own brief. Every verdict is deliver-now or
 * deliver-later. `PRD_shipped_wait_report_attachment.md` A5 and D1.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from '../files';
import { REPORTS_PER_MEMBER } from './guards';
import { REPORTS_DIR } from '../paths';
import { DAY_MS, pruneOlderThan } from '../prune';
import type { WaitRecord } from './wait';

/**
 * One accepted report, waiting for its wait.
 *
 * `payload` is the raw message, never the wrapped text, because `checkSend`
 * refuses any message containing `WRAPPER_OPEN` or `WAIT_OPEN`. A convergence
 * that embedded a wrapped text would be refused as it went out. The same guard
 * at accept time keeps a payload free of a wrapper of its own, so embedding it
 * is safe. `host/waits.ts` puts the wrapper back when it releases.
 *
 * `senderPid` is resolved once, on the way in, from the pid the sending shim
 * read off its own board, so no pass turns a sessionId into a pid. A
 * `sessionId -> pid` map fails: a resumed conversation puts two cards on one
 * sessionId (`cli/list.ts`), so it could file one child's words under another
 * child's name.
 */
export type ParkedReport = {
  schema: 1;
  /** The record's own name on disk, so a delivery can remove what it read. */
  id: string;
  /** The wait this rides. Gone from `waits/` means this has no ride left. */
  waitId: string;
  requesterPid: number;
  senderPid: number;
  /** Carried for the reason `WaitRecord.requesterSessionId` is: not resolved
   *  against, and what a human reading the board matches a row by. */
  senderSessionId?: string;
  payload: string;
  at: number;
};

/**
 * Author a release wraps under. A stored session id is used as written,
 * including an empty one. When the field is absent, the author is this
 * report's sender pid as digits. The session that triggered the release
 * is not an author.
 */
export function releaseAuthor(report: {
  readonly senderSessionId?: string;
  readonly senderPid: number;
}): string {
  return report.senderSessionId ?? String(report.senderPid);
}

/**
 * What to do with a verb send that has passed every guard. `undefined` (S6: no
 * wait open, a non-member, a sibling, an early arrival) means the send goes out
 * as an ordinary send.
 */
export type ParkVerdict =
  | { kind: 'park'; wait: WaitRecord }
  /** The member has reached `REPORTS_PER_MEMBER`. Everything it has parked
   *  against this wait, oldest first, goes out now with the send that hit the
   *  cap. Releasing empties the count this reads, so a chatty member alternates
   *  between holding and flushing rather than being cut off. */
  | { kind: 'release'; wait: WaitRecord; reports: ParkedReport[] };

/**
 * Whether this send is a member's report to the requester of an open wait.
 *
 * `fromPid` absent matches nothing. Three cases arrive that way: an older shim
 * that does not send it, a caller whose sessionId names more than one session
 * on the board, and a sender nobody could place. All three are safest as an
 * ordinary send, because telling them apart is not worth a wrong attribution.
 *
 * A `failed` or expired record is skipped (A7). Nothing evaluates a refused
 * wait again, so parking behind one would hang silently.
 */
export function parkFor(input: {
  waits: readonly WaitRecord[];
  reports: readonly ParkedReport[];
  toPid: number;
  fromPid: number | undefined;
  now: number;
}): ParkVerdict | undefined {
  const { waits, reports, toPid, fromPid, now } = input;
  if (fromPid === undefined) {
    return undefined;
  }
  const wait = waits.find(
    (record) =>
      record.requesterPid === toPid &&
      record.members.includes(fromPid) &&
      !record.failed &&
      now < record.expiresAt
  );
  if (!wait) {
    return undefined;
  }
  // Per member and per wait, both. One chatty member must not spend its
  // sibling's allowance, and a member is not punished for a second fan-out it
  // is also part of.
  const held = reports
    .filter((report) => report.waitId === wait.id && report.senderPid === fromPid)
    .sort((a, b) => a.at - b.at);
  if (held.length >= REPORTS_PER_MEMBER) {
    return { kind: 'release', wait, reports: held };
  }
  return { kind: 'park', wait };
}

/**
 * Reports with no convergence left to ride, split by what can still be done
 * about them.
 *
 * `release` is a delivery this window can still make. The wait is gone or
 * refused, but the requester is here and holds a pipe, so the words go out as
 * ordinary sends: N wakes, worse than one and better than silence.
 *
 * `strand` is everything this window cannot act on, and the caller does
 * nothing with it. `ownedSession` answers only for this window, so a requester
 * another window drives looks the same here as one that is gone. Releasing the
 * first is that window's job, and destroying it would lose words it was about
 * to deliver.
 *
 * Cost is why it is not resolved here. `board()` has the machine-wide answer
 * (`readClaims`, `discoverAll`, `readPublished`), but `rescue` runs before that
 * board is built to keep a process scan off the idle path, and a scan on every
 * pass would cost more than this case is worth. A report is classified only
 * once its wait is gone or `failed`, and `pruneWaits` sweeps those on this
 * store's day clock, so the two files age out together.
 *
 * An ordinary send would have left the words in the parent's transcript for
 * `/resume`. `deactivate` releases them on a reload, the common case. After a
 * hard crash the sender's own transcript still holds them, which the
 * convergence's closing line points at: a mitigation only.
 */
export function orphaned(input: {
  waits: readonly WaitRecord[];
  reports: readonly ParkedReport[];
  /** Whether this window drives that session — `ownedSession`, passed rather
   *  than imported, since answering it needs the host. */
  owned: (pid: number) => boolean;
}): { release: ParkedReport[]; strand: ParkedReport[] } {
  const { waits, reports, owned } = input;
  const rideable = new Set(waits.filter((wait) => !wait.failed).map((wait) => wait.id));
  const release: ParkedReport[] = [];
  const strand: ParkedReport[] = [];
  for (const report of reports) {
    if (rideable.has(report.waitId)) {
      continue;
    }
    (owned(report.requesterPid) ? release : strand).push(report);
  }
  return { release, strand };
}

/** The filename is the id (`core/coordination/wait.ts`'s rule), so a delivery
 *  removes exactly the file it read rather than trusting a field inside it. */
function reportFile(id: string): string {
  return path.join(REPORTS_DIR, `${encodeURIComponent(id)}.json`);
}

/**
 * Parks one. Best effort, and the caller is told: a window that cannot write
 * this must send the message the ordinary way rather than lose it.
 */
export async function writeReport(record: ParkedReport): Promise<boolean> {
  return writeAtomicJson(reportFile(record.id), record, 'state');
}

/** Forgets one. A file already gone is the outcome we wanted. */
export async function dropReport(id: string): Promise<void> {
  await fs.rm(reportFile(id), { force: true }).catch(() => {});
}

/**
 * Every parked report on this machine. A malformed one is removed, not
 * skipped: a record whose `senderPid` is not a number matches no member line,
 * so it would render under nobody and then be deleted with the reports that
 * did render.
 */
export async function readReports(): Promise<ParkedReport[]> {
  const gone: string[] = [];
  const kept = await readJsonDir(REPORTS_DIR, (raw, name) => {
    if (isReport(raw)) {
      return { ...raw, id: decodeURIComponent(name.replace(/\.json$/, '')) };
    }
    gone.push(name);
    return undefined;
  });
  await Promise.all(
    gone.map((name) => fs.rm(path.join(REPORTS_DIR, name), { force: true }).catch(() => {}))
  );
  return kept;
}

/**
 * Reports nobody is left to deliver or release. A day, as for `pruneWaits`,
 * because a report lives at most `WAIT_TTL_MS`, under an hour.
 */
export async function pruneReports(): Promise<void> {
  await pruneOlderThan(
    REPORTS_DIR,
    DAY_MS,
    (name) => name.endsWith('.json') || name.endsWith('.tmp')
  );
}

/**
 * Whether a parsed file can be read as a parked report. `schema` is checked
 * rather than assumed (`actions.ts`'s rule). Each field is narrowed rather than
 * cast because it decides where somebody's words end up: `senderPid` the line
 * they render under, `waitId` whether they ride at all, `at` the order.
 */
function isReport(value: unknown): value is ParkedReport {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ParkedReport>;
  return (
    record.schema === 1 &&
    typeof record.waitId === 'string' &&
    record.waitId !== '' &&
    typeof record.requesterPid === 'number' &&
    Number.isInteger(record.requesterPid) &&
    typeof record.senderPid === 'number' &&
    Number.isInteger(record.senderPid) &&
    // Narrowed though optional, because `wrapMessage` takes it verbatim as the
    // author: a stored `42` would sign a peer message `from="42"`, the one
    // field the dock cannot check.
    (record.senderSessionId === undefined || typeof record.senderSessionId === 'string') &&
    typeof record.payload === 'string' &&
    typeof record.at === 'number' &&
    Number.isFinite(record.at)
  );
}
