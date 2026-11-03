/**
 * A registered wait, and whether it has converged.
 *
 * The rule half of the sixth verb: given the board and the waits pending on
 * this machine, which of them are over, how each member finished, and the one
 * message that says so. Pure and `vscode`-free, the split `core/awake.ts` and
 * `host/keepawake.ts` already use — every edge below is a test rather than
 * something reproduced against a live four-way fan-out.
 *
 * `host/waits.ts` owns the triggers, the delivery and the timer. Nothing here
 * knows a window exists.
 *
 * What this deliberately does not judge is whether the requester is still
 * there: `host/waits.ts` keeps only the waits whose requester this window
 * owns, and owning a session is holding its pipe. A record whose requester
 * died is ended by its own deadline, which is the same thing that ends one
 * whose members went quiet.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from '../files';
import { MAX_TEXT } from './guards';
import type { BrandId, SessionStatus } from '../model';
import type * as commands from '../platform/commands';
import { WAITS_DIR, stepCommand, toolShell } from '../paths';
import { DAY_MS, pruneOlderThan } from '../prune';

/**
 * One registration: who asked, which sessions, and when it stops being worth
 * waiting for.
 *
 * **It names no window.** Registration is a direct write rather than an
 * addressed request (`PRD_shipped_wait.md` §5.3), and ownership picks the
 * resolver on every pass — so there is no `windowId` here to be stranded by a
 * reload.
 *
 * `requesterSessionId` is carried but not resolved against: the pid is the
 * address every verb takes, and the sessionId is what a refusal can be read
 * back against by a human on the board.
 */
export type WaitRecord = {
  schema: 1;
  /** The record's own name on disk, so a resolution can delete what it read. */
  id: string;
  requesterPid: number;
  requesterSessionId?: string;
  /** The sessions being waited on. Pids, like every other verb's address. */
  members: number[];
  createdAt: number;
  expiresAt: number;
  /** A dependency wait follows this arming, rather than a member's idle frame. */
  workflow?: { workflowId: string; armedAt?: number };
  /**
   * Why the one message this wait exists to send could not be delivered.
   *
   * **Present means the record stays on disk rather than being deleted**, which
   * is the point: the requester is the one party that cannot be told, so a
   * refused resolution would otherwise vanish and leave exactly the hang this
   * feature exists to prevent, wearing the feature's clothes. Marked here, it
   * is a row a human reading the board can see, and `squadron-list` surfaces
   * it — see `PRD_shipped_wait.md` §5.7 and S6.
   *
   * A marked record is not evaluated again. The next pass would meet the same
   * board and make the same refusal, once per frame for the life of the wait;
   * it is swept by age like every other record here.
   */
  failed?: { reason: string; at: number };
};

/**
 * How one member finished, in the three words the resolution can honestly use.
 *
 * `unread` is the fold, and it is deliberate: a member still working at the
 * deadline and a member whose published record stopped landing are different
 * stories, and neither of them reported. The sentence beside the pid says
 * which; the word says what the requester can act on, which is the same either
 * way.
 */
export type MemberState = 'reported' | 'stopped' | 'unread';

/** One member of a wait, and how it ended. */
export type WaitOutcome = {
  pid: number;
  /** The board's own name for it, when the member was still there to have one. */
  name?: string;
  state: MemberState;
  /** This line describes dependency readiness rather than a session ending. */
  workflow?: true;
  /**
   * What this member said while the wait was open, oldest first — the reports
   * held back so they could arrive with the convergence instead of ahead of it,
   * each a billed wake of its own.
   *
   * Absent, not empty, when it said nothing: every existing convergence is then
   * composed byte-for-byte as it was before this existed.
   */
  reports?: string[];
};

/**
 * What the fold needs of one held report.
 *
 * Structural, and deliberately not `ParkedReport` imported: `core/coordination/reports.ts`
 * reads `WaitRecord` from here, so taking its type back would circle the two
 * modules. It says what is actually read, the way `WaitMember` does for the
 * board.
 */
export type WaitReport = {
  /** The store's own name for it, carried through untouched so the caller can
   *  tell what rode from what did not and act on each — the one is deleted, the
   *  other released, and confusing them loses somebody's words. */
  id: string;
  waitId: string;
  senderPid: number;
  /** Carried through untouched, like `id`: the fold never reads it, and the
   *  host needs it to put the attribution wrapper back on a report it has to
   *  release rather than attach. */
  senderSessionId?: string;
  payload: string;
  at: number;
};

/** Coalesce waits resolving in one pass so each requester receives one wake. */
export type WaitResolution = {
  requesterPid: number;
  /** The records this message covers. All of them are deleted once it is sent. */
  waits: WaitRecord[];
  /** Every member across those records, deduplicated by pid, in the order the
   *  requester named them. */
  members: WaitOutcome[];
  /** True when any of the folded waits reached its deadline rather than
   *  converging — what makes the difference to the first line. */
  expired: boolean;
  /** The body to deliver, composed here so the sentence is a test too. */
  text: string;
  /**
   * The held reports this message could not carry, for the host to release as
   * ordinary sends.
   *
   * **The convergence has a byte ceiling and it is not ours.** `host/waits.ts`
   * puts `text` through `checkSend` like any other message, and `checkSend`
   * refuses over `MAX_TEXT` — while a single report is allowed to be `MAX_TEXT`
   * long on its own, so the per-member count cap bounds nothing that matters
   * here. Composed past the limit, the resolution is refused, the record is
   * marked `failed`, and the feature's success path lands in its most broken
   * one. So the fitting happens here, where the text is, and what did not fit
   * comes back out rather than being dropped.
   */
  unattached: WaitReport[];
  /**
   * The held reports this message did carry, so the host knows exactly which
   * files it may remove.
   *
   * Stated rather than inferred from `members[].reports`, which holds payloads
   * and not ids: two members can send identical words, and a partition that
   * matched on text would delete one session's undelivered report because
   * another session happened to say the same thing.
   */
  attached: WaitReport[];
};

/** `ended` is required so a dead process cannot silently arrive as unreadable. */
export type WaitMember = {
  pid: number;
  /** Absent is Claude. Which shell a requester's wake-up command is written for. */
  brand?: BrandId;
  sessionId?: string;
  startedAt?: number;
  name?: string;
  status: SessionStatus;
  hasCommand?: boolean;
  /**
   * Its process is gone, and the window that drove it watched it go.
   *
   * **`status` cannot carry this.** An owned session that exits is kept on the
   * board deliberately — it still has a transcript worth reading — and
   * `core/live.ts` folds it to `unknown`, which is also what a twin whose
   * published record never landed reads as. One of those must resolve a wait
   * and the other must not, so the fact travels beside the word rather than
   * inside it. Passed rather than derived, the seam `ui/views.ts`'s `exited`
   * already uses for the same fact.
   */
  ended: boolean;
};

export type WorkflowWaitState = {
  state: 'pending' | 'ready' | 'stopped';
  /** Re-check when a freshly opened lane's startup grace ends. */
  checkAt?: number;
};

/**
 * Idle with a running command is unfinished. `unknown` has no evidence of
 * completion, and `waiting` is blocked mid-turn until a dialog is answered.
 */
function finished(member: WaitMember): boolean {
  return member.status === 'idle' && !member.hasCommand;
}

/**
 * How one member ended, or nothing while it is still going.
 *
 * **A member that is gone resolves the wait.** A session that was stopped,
 * crashed, or went with its window is never going to be idle, so treating its
 * absence as unresolved would hang the wait forever — worse than the problem
 * this feature exists to fix. It ends the wait and is named as gone, so the
 * requester can tell a child that reported from one that stopped existing.
 *
 * **Gone is not the same as off the board**, and reading it as the same made a
 * killed member's wait take 339 seconds instead of one
 * (`src/test/live_session/wait_convergence.md`, 2026-08-22). `ended` is what
 * distinguishes them, and its own doc says why the status word cannot. Checked
 * before that word rather than after: a session that died between its last
 * frame and this pass is over whatever the frame said.
 */
function stateOf(
  pid: number,
  board: readonly WaitMember[],
  running: ReadonlySet<number> | undefined,
  retired: ReadonlySet<number> | undefined
): WaitOutcome | undefined {
  const member = board.find((session) => session.pid === pid);
  if (!member) {
    // Off the board but still in the complete table: its record or pid file
    // went unread, which is not its death. Unless its brand read it and knows
    // its session finished while the process runs on (a pooled worker).
    return running?.has(pid) && !retired?.has(pid) ? undefined : { pid, state: 'stopped' };
  }
  if (member.ended) {
    return { pid, state: 'stopped', ...(member.name !== undefined ? { name: member.name } : {}) };
  }
  return finished(member)
    ? { pid, state: 'reported', ...(member.name !== undefined ? { name: member.name } : {}) }
    : undefined;
}

/** `stateOf` with only this window's watched exits as evidence. */
function endedOf(pid: number, board: readonly WaitMember[]): WaitOutcome | undefined {
  const member = board.find((session) => session.pid === pid);
  return member?.ended
    ? { pid, state: 'stopped', ...(member.name !== undefined ? { name: member.name } : {}) }
    : undefined;
}

function unread(pid: number, board: readonly WaitMember[]): WaitOutcome {
  const member = board.find((session) => session.pid === pid);
  return {
    pid,
    state: 'unread',
    ...(member?.name !== undefined ? { name: member.name } : {})
  };
}

/**
 * The waits that are over, as one resolution per requester.
 *
 * Two ways a wait ends and they are not the same fact. **Convergence** is every
 * member accounted for — finished, or gone. **Expiry** is the deadline
 * arriving with some member still unaccounted for, and it is not optional:
 * every trigger this feature has fires on activity, and a wait whose members
 * went `unknown` needs to end with a sentence rather than with silence.
 *
 * A record whose deadline has passed resolves whatever else is true of it, so
 * expiry is tested first: a member that finished in the same pass is still
 * reported as finished, and only the first line of the message changes.
 */
export function resolveWaits(input: {
  waits: readonly WaitRecord[];
  board: readonly WaitMember[];
  /** What the members said while their waits were open. Optional, because a
   *  machine that has parked nothing composes exactly the message it always
   *  did. */
  reports?: readonly WaitReport[];
  workflowStates?: ReadonlyMap<string, WorkflowWaitState>;
  /**
   * Whether this pass's process table was complete on a recognized clock.
   * `unknown` when it was not: the board then cannot prove a command
   * finished or a member gone. Absent means complete.
   */
  processes?: 'complete' | 'unknown';
  /**
   * Every pid that complete table runs. A member off the board is `stopped`
   * only when its pid is not here; one that still runs was dropped by a
   * record that could not be read, and holds. Absent means off the board is
   * gone, for callers that judge no table.
   */
  running?: ReadonlySet<number>;
  /**
   * Pids that still run but whose session a brand read as finished (a Claude
   * pooled worker whose job is done or failed): off the board, they are
   * stopped, as before `running`.
   */
  retired?: ReadonlySet<number>;
  /**
   * Whether every session file and published record a running pid has was
   * read. `unknown` holds workflow readiness, which judges lanes by who is on
   * the board. Absent means complete.
   */
  records?: 'complete' | 'unknown';
  now: number;
}): WaitResolution[] {
  const { waits, board, reports = [], now } = input;
  // Without a complete table nothing proves a command finished or a member
  // gone: `hasCommand` has no table to come off, and another window's member
  // falls off the board. Only a native exit this window watched (`ended`)
  // still counts, and the deadline still delivers.
  const certain = input.processes !== 'unknown';
  const lanesCertain = certain && input.records !== 'unknown';
  const outcome = (pid: number): WaitOutcome | undefined =>
    certain ? stateOf(pid, board, input.running, input.retired) : endedOf(pid, board);
  const byRequester = new Map<number, { waits: WaitRecord[]; expired: boolean }>();

  for (const wait of waits) {
    if (wait.failed) {
      continue;
    }
    const expired = now >= wait.expiresAt;
    const workflowState = input.workflowStates?.get(wait.id)?.state;
    const ready = wait.workflow
      ? lanesCertain && (workflowState === 'ready' || workflowState === 'stopped')
      : wait.members.every((pid) => outcome(pid));
    if (!expired && !ready) {
      continue;
    }
    const group = byRequester.get(wait.requesterPid) ?? { waits: [], expired: false };
    group.waits.push(wait);
    group.expired ||= expired;
    byRequester.set(wait.requesterPid, group);
  }

  const out: WaitResolution[] = [];
  for (const [requesterPid, group] of byRequester) {
    const members: WaitOutcome[] = [];
    const seen = new Set<number>();
    const ordinary = new Set(
      group.waits.filter((wait) => !wait.workflow).flatMap((wait) => wait.members)
    );
    for (const wait of group.waits) {
      for (const pid of wait.members) {
        if (seen.has(pid)) {
          continue;
        }
        seen.add(pid);
        const workflowState = lanesCertain ? input.workflowStates?.get(wait.id)?.state : undefined;
        members.push(
          wait.workflow && !ordinary.has(pid)
            ? {
                ...unread(pid, board),
                workflow: true,
                state:
                  workflowState === 'ready'
                    ? 'reported'
                    : workflowState === 'stopped'
                      ? 'stopped'
                      : 'unread'
              }
            : (outcome(pid) ?? unread(pid, board))
        );
      }
    }
    // Oldest first: a correction must not arrive before what it corrects.
    const covers = new Set(group.waits.map((wait) => wait.id));
    const held = reports.filter((report) => covers.has(report.waitId)).sort((a, b) => a.at - b.at);
    const { text, attached, unattached } = compose(
      members,
      group.expired,
      held,
      group.waits.some((wait) => wait.workflow),
      toolShell(board.find((member) => member.pid === requesterPid)?.brand)
    );
    out.push({
      requesterPid,
      waits: group.waits,
      members,
      expired: group.expired,
      text,
      attached,
      unattached
    });
  }
  return out;
}

/**
 * Stop at the first report that exceeds `MAX_TEXT`: skipping it would let
 * a shorter, later report overtake it. Mutate outcomes with the fitted reports
 * so they agree with the composed text.
 */
function compose(
  members: WaitOutcome[],
  expired: boolean,
  held: readonly WaitReport[],
  workflow: boolean,
  shell: commands.Shell
): { text: string; attached: WaitReport[]; unattached: WaitReport[] } {
  let text = resolutionText(members, expired, workflow, shell);
  const attached: WaitReport[] = [];
  for (let i = 0; i < held.length; i += 1) {
    const report = held[i];
    const member = report && members.find((one) => one.pid === report.senderPid);
    if (!report || !member) {
      // Release an unrenderable report. Deleting it would lose the sender's words.
      return { text, attached, unattached: held.slice(i) };
    }
    const before = member.reports;
    member.reports = [...(before ?? []), report.payload];
    const grown = resolutionText(members, expired, workflow, shell);
    if (grown.length > MAX_TEXT) {
      // Restore absence as well as content so an unfitted report changes no outcome.
      if (before === undefined) {
        delete member.reports;
      } else {
        member.reports = before;
      }
      return { text, attached, unattached: held.slice(i) };
    }
    attached.push(report);
    text = grown;
  }
  return { text, attached, unattached: [] };
}

/**
 * Activity triggers cannot expire a wait on a quiet machine. The 6-hour
 * prune poll is garbage collection. Arm nothing when no wait is pending.
 */
export function nextDeadline(waits: readonly WaitRecord[], now: number): number | undefined {
  let earliest: number | undefined;
  for (const wait of waits) {
    // Refused waits are not evaluated again, so arming them would wake for nothing.
    if (wait.failed) {
      continue;
    }
    if (earliest === undefined || wait.expiresAt < earliest) {
      earliest = wait.expiresAt;
    }
  }
  // Return `now` for an overdue wait so the timer fires once without a past-clock loop.
  return earliest === undefined ? undefined : Math.max(earliest, now);
}

/**
 * The one message, in the requester's own vocabulary.
 *
 * **It carries no findings**, by decision: naming N transcripts' worth of
 * prose in one turn would move the context cost this feature exists to avoid
 * rather than remove it. It names the members, says how each ended, and points
 * at the verb that can read them.
 *
 * The pids are what a reader matches against `squadron-list`, which is why
 * they lead each line — the message's recorded author is this window, and a
 * window id matches no row there (§5.5).
 */
export function resolutionText(
  members: readonly WaitOutcome[],
  expired: boolean,
  workflow: boolean,
  shell: commands.Shell
): string {
  const count = `${members.length} session${members.length === 1 ? '' : 's'}`;
  // Convergence is not the same as everyone finishing: a member that stopped
  // existing ends the wait without reporting, and a first line claiming they
  // all finished contradicts the very next one, which says it did not.
  const head = workflow
    ? `Your workflow wait ${expired ? 'reached its deadline' : 'is over'}. Run \`${stepCommand(shell, 'next')}\` to continue or read why it cannot proceed.`
    : expired
      ? `Your wait over ${count} reached its deadline. Not all of them finished.`
      : members.every((member) => member.state === 'reported')
        ? `All ${count} you were waiting on ${members.length === 1 ? 'has' : 'have'} finished.`
        : `Your wait over ${count} is over. Not all of them finished.`;
  const lines = members.flatMap((member) => {
    const named = member.name ? `${member.pid} ${member.name}` : `${member.pid}`;
    const state = member.workflow
      ? member.state === 'reported'
        ? 'ready to check the next step'
        : member.state === 'stopped'
          ? 'workflow stopped or stalled'
          : 'dependencies not ready'
      : said(member);
    const line = `- ${named}: ${state}`;
    // Every line of a report is indented, not just its first: a member's own
    // paragraph must read as that member's, and an unindented continuation
    // would draw level with the next member's row.
    const under = (member.reports ?? []).flatMap((report) =>
      report.split('\n').map((line) => `    ${line}`)
    );
    return [line, ...under];
  });
  return [
    head,
    '',
    ...lines,
    '',
    'Their transcripts are available through squadron-list if needed.'
  ].join('\n');
}

const SAID: Record<MemberState, string> = {
  reported: 'finished',
  stopped: 'stopped without finishing',
  unread: 'never reported'
};

/** Reports prove speech, not completion: `unread` must not claim silence above one. */
function said(member: WaitOutcome): string {
  return member.state === 'unread' && member.reports?.length
    ? 'did not finish'
    : SAID[member.state];
}

/** Where one wait is written down. The filename **is** the id, so a resolution
 *  can delete exactly the record it read without trusting a field inside it. */
function waitFile(id: string): string {
  return path.join(WAITS_DIR, `${encodeURIComponent(id)}.json`);
}

/** Report write failure so the shim cannot promise a wake it never registered. */
export async function writeWait(record: WaitRecord): Promise<boolean> {
  return writeAtomicJson(waitFile(record.id), record, 'state');
}

export async function dropWait(id: string): Promise<void> {
  await fs.rm(waitFile(id), { force: true }).catch(() => {});
}

/**
 * Every pending wait on this machine, with the unreadable ones removed as they
 * are read — the shape `claims.ts` established.
 *
 * **An expired record is returned, not swept.** Expiry is a resolution here
 * rather than a deletion: the requester is owed the sentence saying which of
 * its members never reported, and nothing else on the machine would ever say
 * it. `pruneWaits` is what ends a record no window is left to resolve.
 *
 * **Malformed is removal, not a skip**, for the reason `claims.ts` spells out
 * at length: a record with no `expiresAt` compares false against every clock,
 * so it would be neither resolved nor swept and would sit there for good.
 */
export async function readWaits(): Promise<WaitRecord[]> {
  const gone: string[] = [];
  const waits = await readJsonDir(WAITS_DIR, (raw, name) => {
    if (isWait(raw)) {
      // The filename wins over the field. They are written equal, and a record
      // whose `id` had been edited to name another file would have a
      // resolution delete that one instead of this one.
      return { ...raw, id: decodeURIComponent(name.replace(/\.json$/, '')) };
    }
    gone.push(name);
    return undefined;
  });
  await Promise.all(
    gone.map((name) => fs.rm(path.join(WAITS_DIR, name), { force: true }).catch(() => {}))
  );
  return waits;
}

/**
 * Records nobody is left to resolve.
 *
 * The case is a host that died between a registration and its convergence: the
 * requester went with it (`PRD_shipped_wait.md` A5), so no window will ever own
 * that pid again and no pass will ever delete the file. Age rather than
 * liveness, like every other sweep here — a wait's whole life is
 * `WAIT_TTL_MS`, under an hour, so a day-old record is garbage by a wide
 * margin and a refused one has had a day of being visible on the board first.
 */
export async function pruneWaits(): Promise<void> {
  await pruneOlderThan(
    WAITS_DIR,
    DAY_MS,
    (name) => name.endsWith('.json') || name.endsWith('.tmp')
  );
}

/**
 * Whether a parsed file can be read as a wait, narrowed field by field like
 * every other reader of a file another process wrote.
 *
 * `schema` is checked rather than assumed, `actions.ts`'s rule: a later record
 * sharing this directory must not read as a wait. The two clocks are checked
 * for finiteness rather than cast, `claims.ts`'s: an absent number makes every
 * comparison against it false, which is the immortal file again.
 */
function isWait(value: unknown): value is WaitRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<WaitRecord>;
  return (
    record.schema === 1 &&
    typeof record.requesterPid === 'number' &&
    Number.isInteger(record.requesterPid) &&
    Array.isArray(record.members) &&
    record.members.length > 0 &&
    record.members.every((pid) => Number.isInteger(pid)) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    (record.workflow === undefined ||
      (record.workflow !== null &&
        typeof record.workflow === 'object' &&
        typeof record.workflow.workflowId === 'string' &&
        record.workflow.workflowId.length > 0 &&
        typeof record.requesterSessionId === 'string' &&
        record.requesterSessionId.length > 0 &&
        (record.workflow.armedAt === undefined ||
          (typeof record.workflow.armedAt === 'number' &&
            Number.isFinite(record.workflow.armedAt)))))
  );
}
