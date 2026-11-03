/**
 * What an End click means, before anything is signalled or confirmed — and
 * which cards say so while it is happening.
 *
 * "Close" survives throughout in the identifiers and on the wire — `closePlan`,
 * `closeDescendants`, `{ type: 'close' }` — where it is the name of a message,
 * not of the act. The act is ending, and the prose says so.
 *
 * Decisions only: dismiss vs confirm vs end-without-ask, who would cascade,
 * the modal copy, and which descendants an End includes. The host runs
 * the plan against a confirm port and the kill routes (`endHeld` /
 * SIGTERM) — those stay untested host-side on purpose; route is thin and the
 * broker will shrink it further.
 */

import { Session } from '../core/model';
import { cascadeList, endDetail } from './text';
import { buildLineage, displayName } from './views';

/** Gathered by the host before the plan is asked for. */
export type CloseInputs = {
  /**
   * This window's owned registry already has an exit for this pid — the End
   * button is a dismiss, not a kill. Host measures via `dropSession`'s predicate
   * (or equivalent) without side effects until it executes.
   */
  alreadyDead: boolean;
  /** Transcript has at least one exchange the dock would show. */
  hasExchanges: boolean;
  /**
   * How many processes `snapshotTree` named for the dialog detail — copy only,
   * so absent when the host has not scanned. It scans only for a plan that says
   * `countsProcesses`, then asks again; both end routes rescan before signalling.
   */
  processCount?: number;
};

/**
 * Pure answer to "what should this End click do?".
 *
 * - `noop` — pid not on the board
 * - `dismiss` — already-dead owned session; drop the card only
 * - `confirm` — show a modal; `cascadeFor[buttonLabel]` is who else to end
 *   (missing choice / cancel → do nothing)
 * - `stop` — no modal; end with the given cascade (usually empty). The kind
 *   keeps the old word; see the note above
 */
export type ClosePlan =
  | { kind: 'noop' }
  | { kind: 'dismiss' }
  | {
      kind: 'confirm';
      message: string;
      detail: string;
      buttons: string[];
      /** Button label → cascade list. Undefined choice means cancel. */
      cascadeFor: Record<string, Session[]>;
      /** The detail counts processes, so `processCount` changes the copy. */
      countsProcesses?: true;
    }
  | { kind: 'stop'; cascade: Session[] };

export function selectionEnded(
  pid: number | undefined,
  startedAt: number | undefined,
  ended: readonly Pick<Session, 'pid' | 'startedAt'>[]
): boolean {
  return (
    pid !== undefined &&
    ended.some((session) => session.pid === pid && session.startedAt === startedAt)
  );
}

/**
 * Everything below this session on the board, as `Session`s. Idle ones count —
 * an idle session has finished a turn and is waiting for its next instruction,
 * which is exactly the one silently orphaned.
 *
 * The whole descent, not one hop: a cascade that reached one generation is what
 * used to make a third generation unsafe to allow, since a grandchild outlived
 * the end that took everything between it and the card someone clicked.
 *
 * Bounded by the board, not by a depth cap. `buildLineage` resolves
 * `parentSessionId` against the sessions it is given, so a session whose parent
 * has already gone belongs to nobody by the walk alone — the stamp is what then
 * says which fan-out it came out of, and only the origin of that fan-out is
 * offered it. A session with neither is a loose card, visible and recoverable,
 * which is the answer this repo prefers to a silent kill.
 * `seen` starts holding the clicked pid: an edge cycling back to the root
 * would otherwise list it as its own descendant, counted twice in the button
 * and signalled twice by the host. Cycles are not a shape the panel can draw —
 * only one a recycled pid inside `discover`'s join window could write down.
 */
export function closeDescendants(pid: number, sessions: readonly Session[]): Session[] {
  const lineage = buildLineage([...sessions]);
  const seen = new Set<number>([pid]);
  const found: Session[] = [];
  // Breadth first, so a family reads in generation order — the same order the
  // board's own boxes lay a chain out in.
  const queue = [...(lineage.get(pid)?.children ?? [])];
  // The stamp is the half the walk cannot reach: it names the session a fan-out
  // was opened at, so a descent whose middle has already gone still says who is
  // responsible for it. Asked of every session this walk reaches and never of a
  // session above it — a stamp names an ancestor, so matching one anywhere else
  // would offer to end a card's own siblings. Both directions feed the same
  // queue, which is what closes a chain that alternates between them:
  // `cli/spawn.ts` opens a fan-out at an explicit `--parent-session-id`, so a stamp is not
  // always the root and one union pass is not always enough.
  //
  // What neither reaches is a session stamped on an ancestor that is itself
  // gone: nothing on the board joins the two, and the board says the same thing
  // — that card sits outside every box. It is a loose card, which is the answer
  // this repo prefers to a silent kill.
  //
  // The reach is every session stamped with a *reached* session's id, which is
  // strictly below the click for as long as one id means one session. Two live
  // sessions can claim one — `claude --resume` against a running conversation —
  // and a twin of a reached session then donates its own fan-out to this
  // cascade. Named in the dialog like every other member, and the alternative is
  // trusting a pid where a stamp is what was written down.
  const idOf = new Map(sessions.map((s) => [s.pid, s.sessionId]));
  const stampedOn = (id: string | undefined): number[] =>
    id === undefined || id === ''
      ? []
      : sessions.filter((s) => s.originSessionId === id).map((s) => s.pid);
  queue.push(...stampedOn(idOf.get(pid)));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) {
      continue;
    }
    seen.add(next);
    // Walked through but not offered: its end is already sent, and its own
    // children may not have been.
    found.push(...sessions.filter((s) => s.pid === next && !s.closing));
    queue.push(...(lineage.get(next)?.children ?? []), ...stampedOn(idOf.get(next)));
  }
  return found;
}

// A session's name can run to a paragraph; the title stays one line and the
// body, which wraps, carries the name.
const END_TITLE = 'End this session?';

export function closePlan(
  session: Session | undefined,
  sessions: readonly Session[],
  inputs: CloseInputs
): ClosePlan {
  if (!session) {
    return { kind: 'noop' };
  }
  if (inputs.alreadyDead) {
    return { kind: 'dismiss' };
  }

  const below = closeDescendants(session.pid, sessions);
  if (below.length > 0) {
    const all = `End all ${below.length + 1}`;
    const one = below.length === 1;
    // The orphan clause is true of a direct child and of nothing deeper: ending
    // this card alone leaves a grandchild's own parent running, still on the
    // board, still saying where it came from.
    const deeper = below.some((s) => s.parentSessionId !== session.sessionId);
    return {
      kind: 'confirm',
      message: END_TITLE,
      detail:
        `${leadLine(session)}\n\n` +
        `${below.length} session${one ? '' : 's'} below it ${one ? 'is' : 'are'} still running:\n` +
        cascadeList(
          below.map((s) => ({
            name: displayName(s),
            status: s.status,
            waitingFor: s.waitingFor
          }))
        ) +
        '\n\nEnding just this one leaves them running' +
        (deeper ? '.' : ', with nothing left on the board to say what started them.'),
      buttons: [all, 'End just this one'],
      cascadeFor: {
        'End just this one': [],
        [all]: below
      }
    };
  }

  if (session.status !== 'idle' || inputs.hasExchanges) {
    return {
      kind: 'confirm',
      message: END_TITLE,
      detail: `${leadLine(session)}\n\n${endDetail(inputs.processCount ?? 0)}`,
      buttons: ['End session'],
      cascadeFor: { 'End session': [] },
      countsProcesses: true
    };
  }

  return { kind: 'stop', cascade: [] };
}

/**
 * The body's first line: the name, and its state when busy or waiting, in the
 * cascade rows' `name — state` form. `waitingFor` is a noun phrase — ours or
 * the CLI's free text — so no sentence fits every value.
 */
function leadLine(session: Session): string {
  const label = displayName(session);
  const named = session.waitingFor ?? (session.status === 'unknown' ? undefined : session.status);
  return named === undefined || session.status === 'idle' ? label : `${label} — ${named}`;
}
