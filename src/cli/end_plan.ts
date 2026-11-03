/**
 * Whether one `squadron-end` would end a session, and the close it posts.
 *
 * **No entry point, on purpose.** `squadron-step` ends a lane whose picked
 * model never started, and it imports this rather than `end.ts`: esbuild puts
 * every imported module in one bundle, where each verb's
 * `require.main === module` is true at once, so importing `end.ts` ran that
 * verb's `main` inside `squadron-step` (`cli_bundles.test.ts`).
 */

import { Session } from '../core/model';
import * as sessionTarget from '../core/session_target';
import { ask, type AskFailure } from '../core/coordination/ask';
import * as sessionEnd from '../core/session_end';
import type { Reply } from '../core/coordination/requests';
import { closeDescendants } from '../ui/closing';
import { displayName } from '../ui/views';
import { Flags, parseFlags, Renamed } from './args';

/** Every flag this takes. `only`, `self` and `any` carry no value. */
export const FLAGS = ['pid', 'session-id', 'caller-session-id', 'only', 'self', 'any'] as const;
const BARE = ['only', 'self', 'any'] as const;

/** `--session-id`, the `sessionId` `squadron-list` reports. */
export const RENAMED: Renamed<typeof FLAGS> = {
  session: 'session-id',
  caller: 'caller-session-id'
};

export type Options = Flags<typeof FLAGS>;

/**
 * One target, already a pid or a session id. Exactly one of the two.
 * `only`, `self` and `any` are present when those flags were passed.
 */
export type EndTarget = (
  { pid: number; session?: undefined } | { session: string; pid?: undefined }
) & { only?: string; self?: string; any?: string };

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS, BARE);
}

/**
 * What one invocation would end, or why it would not.
 *
 * The refusal is code 2: the request was well formed and the answer is no.
 * A 1 — "you typed it wrong, look at the usage line" — is `endTarget`'s, in
 * `end.ts`. Once the flags are a pid or a session id, retrying unchanged is
 * not the remedy; ending something else may be.
 *
 * `about` marks the two refusals a flag lifts: `'self'` the caller's own
 * session, `'descent'` one outside its descent. The reason names no flag:
 * `squadron-step` prints it and has neither `--self` nor `--any`. `end.ts`
 * adds the hint.
 */
export type EndPlan =
  | { ok: true; members: Session[]; self?: Session }
  | { ok: false; code: 2; reason: string; about?: 'self' | 'descent' };

/**
 * A refusal on its own, which is all the resolver below can answer with.
 *
 * Extracted rather than written out again: the resolver returning `EndPlan`
 * would have admitted the `ok: true` shape, and a later edit answering with one
 * would have become an authorised plan that skipped identity, self, descent and
 * kind — every check that makes this safe. Unrepresentable beats remembered.
 */
type Refusal = Extract<EndPlan, { ok: false }>;

/**
 * The session this invocation is about, from whichever way it was named.
 *
 * `--pid` and `--session-id` are both offered because the two identifiers are not
 * interchangeable and the caller may only hold one. A pid is what the board,
 * lineage and every request are keyed on, and it never moves. A sessionId
 * exists from birth (the CLI is handed one at spawn) but is neither immutable —
 * `/clear` moves a card to a new one — nor unique, since `claude --resume`
 * against a running conversation puts two live sessions on one id. So a
 * sessionId matching more than one card is refused rather than guessed at: the
 * one thing worse than not ending a session is ending its twin.
 *
 * The `Session` is returned rather than its pid, because the caller's next act
 * is to look the same card up again — and a lookup that cannot fail is one
 * fewer `!` standing where a future edit could make it lie.
 */
function selectTarget(opts: EndTarget, sessions: readonly Session[]): Session | Refusal {
  if (opts.pid !== undefined) {
    const found = sessions.find((s) => s.pid === opts.pid);
    if (!found) {
      return { ok: false, code: 2, reason: `no session Squadron sees has pid ${opts.pid}` };
    }
    return found;
  }
  const matches = sessions.filter((s) => s.sessionId === opts.session);
  const only = matches[0];
  if (only === undefined) {
    return { ok: false, code: 2, reason: `no session Squadron sees is ${opts.session}` };
  }
  if (matches.length > 1) {
    // Two live cards on one id: a resumed conversation running twice. Which one
    // the caller meant is not in the argument, so it is asked for by pid.
    const pids = matches.map((s) => s.pid).join(', ');
    return {
      ok: false,
      code: 2,
      reason: `${matches.length} live sessions share ${opts.session} — name one by --pid (${pids})`
    };
  }
  return only;
}

/**
 * The whole decision, pure, so every refusal is a test rather than something to
 * reproduce against a live fleet.
 *
 * The order of the checks is the design. Identity first: a caller that cannot
 * say who it is has no descent, and every rule below is about a descent.
 * Then self, which is a different permission from ending a child and is asked
 * for separately — a pid typed one digit wrong should not be able to end the
 * session doing the typing. Then descent, which is the actual authority unless
 * `--any` waives it. Then the target's kind, which is about what `close` can
 * reach rather than about who may ask. Then the caller inside the cascade,
 * asked before `--only` so that ending an ancestor takes one refusal, not two.
 * Busy is last and stands apart from all of them: every check
 * above answers whether this caller may end this session, and that one answers
 * whether now is the moment.
 */
export function endPlan(
  opts: EndTarget,
  sessions: readonly Session[],
  callerId: string | undefined
): EndPlan {
  const target = selectTarget(opts, sessions);
  if ('ok' in target) {
    return target;
  }

  if (callerId === undefined || callerId === '') {
    return {
      ok: false,
      code: 2,
      reason: 'cannot tell which session is asking; pass --caller-session-id <sessionId>'
    };
  }
  const caller = sessions.find((s) => s.sessionId === callerId);
  if (!caller) {
    return {
      ok: false,
      code: 2,
      reason: `${callerId} is not a session Squadron sees, so it has nothing below it`
    };
  }

  const isSelf = caller.pid === target.pid;
  if (isSelf && opts.self === undefined) {
    return { ok: false, code: 2, about: 'self', reason: 'that is your own session' };
  }
  if (
    !isSelf &&
    opts.any === undefined &&
    !closeDescendants(caller.pid, sessions).some((s) => s.pid === target.pid)
  ) {
    return {
      ok: false,
      code: 2,
      about: 'descent',
      reason: `${displayName(target)} is not below you, so you did not start it`
    };
  }
  const control = sessionTarget.controlOf(target);
  if (
    !control.canControl ||
    (control.canControl &&
      control.owner.kind === 'unclaimed' &&
      control.owner.reason === 'unpublished')
  ) {
    return {
      ok: false,
      code: 2,
      reason:
        !control.canControl && control.reason === 'invalid'
          ? `${displayName(target)} has invalid control facts, so there is nothing to close`
          : `no window publishes a pipe for ${displayName(target)}, so there is nothing to close`
    };
  }
  // Missing owner addresses stay member-level unwritable outcomes, including self.

  const below = isSelf ? [] : closeDescendants(target.pid, sessions);
  // The caller below its own target: an ancestor reached under `--any`, or a
  // sessionId twin of the caller donating its fan-out to the cascade. Either
  // way the cascade ends the caller, which is `--self`'s permission.
  if (!isSelf && opts.self === undefined && below.some((s) => s.pid === caller.pid)) {
    return {
      ok: false,
      code: 2,
      about: 'self',
      reason: `ending ${displayName(target)} ends your own session too`
    };
  }
  if (opts.only !== undefined && below.length > 0) {
    const names = below.map((s) => displayName(s)).join(', ');
    return {
      ok: false,
      code: 2,
      reason:
        `${displayName(target)} has ${below.length} below it (${names}); ` +
        'ending it alone would leave them running — drop --only to take them too'
    };
  }
  const members = opts.only !== undefined ? [target] : [target, ...below];
  // Self is separated rather than filtered out: ending it kills the process
  // reading this reply, so it is posted last and unwaited, and the caller is
  // told that leg went unconfirmed.
  const self = members.find((s) => s.pid === caller.pid);

  // Not mid-turn, and not a cascade with a mid-turn session in it. A `close`
  // lands as an interrupt, so whatever the session was part-way through is lost
  // with nobody left to finish it. Every check above is about authority, and
  // authority turned out not to be the thing that goes wrong: the one end this
  // repo has seen in the wild was a peer that misread `git status` in a shared
  // worktree, blamed the wrong session and ended it mid-`Write` — descent said
  // yes to all of it (2026-08-18). Idle is the moment the same end costs
  // nothing, and a caller told to wait for it loses only time.
  //
  // `busy` alone. `waiting` is parked on an answer that may never come, which is
  // a card worth clearing rather than one doing work; `unknown` is every session
  // whose status could not be read, and refusing on it would refuse most of the
  // board for want of a file.
  //
  // Self is exempt, and has to be: the caller is the session running the command,
  // so it is `busy` whenever it asks, and the rule would refuse every `--self`
  // there is. Ending your own turn is a decision about your own work.
  const busy = members.filter((s) => s !== self && s.status === 'busy');
  if (busy.length > 0) {
    const names = busy.map((s) => displayName(s)).join(', ');
    return {
      ok: false,
      code: 2,
      reason:
        `${names} ${busy.length === 1 ? 'is' : 'are'} busy; ` +
        'a session may only be ended once it is idle'
    };
  }

  return { ok: true, members: members.filter((s) => s !== self), self };
}

/**
 * How one member's `close` went, in the vocabulary the exit code is chosen from.
 *
 * `silent` is separate from `refused` because they are different instructions:
 * a window that never answered may be wedged and is worth reporting as such,
 * where a refusal is an answer. That distinction is the whole reason spawn's
 * table has both a 2 and a 4, and this is what earns the 4 here.
 */
export type Outcome = { ok: true } | { ok: false; kind: AskFailure; reason: string; reply?: Reply };

/** Single-member execution for workflow cleanup, using the same recovery as CLI cascades. */
export async function closeOne(
  session: Session,
  context: sessionTarget.TargetContext = {}
): Promise<Outcome> {
  const [result] = await closeMembers([session], context);
  return result ?? { ok: false, kind: 'unexpected', reason: 'no close result' };
}

/** One batch for the CLI cascade; workflow cleanup also uses the single-member entry. */
export async function closeMembers(
  sessions: readonly Session[],
  context: sessionTarget.TargetContext = {}
): Promise<Outcome[]> {
  const resolutions = sessions.map((session) => {
    const resolved = sessionTarget.resolveTarget(session, context);
    const target = resolved.ok
      ? resolved.address
      : resolved.reason === 'owner-missing'
        ? { pid: session.pid, startedAt: session.startedAt }
        : undefined;
    return { session, resolved, target };
  });
  const addressed = resolutions.flatMap(({ target }) => (target ? [target] : []));
  const ended = await sessionEnd.endSessions(addressed, { ask, observe: sessionEnd.observeEnds });
  let at = 0;
  return resolutions.map(({ session, resolved, target }) => {
    const name = displayName(session);
    if (target) {
      const result = ended[at++];
      if (!result) return { ok: false, kind: 'unexpected', reason: `${name}: no close result` };
      return result.outcome.ok
        ? { ok: true }
        : { ...result.outcome, reason: `${name}: ${result.outcome.reason}` };
    }
    if (resolved.ok) return { ok: false, kind: 'unexpected', reason: `${name}: no close address` };
    if (resolved.reason === 'exited') return { ok: true };
    const detail =
      resolved.reason === 'owner-missing'
        ? 'no window claims it'
        : resolved.reason === 'unpublished'
          ? 'no window publishes a pipe for it'
          : resolved.reason === 'background'
            ? 'it is a background session with no pipe'
            : 'invalid control facts';
    return { ok: false, kind: 'unwritable', reason: `${name}: ${detail}` };
  });
}
