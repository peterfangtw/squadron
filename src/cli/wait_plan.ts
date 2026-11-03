/**
 * Registering a wait, decided: what `squadron-wait` does, shared with
 * `squadron-step`, which registers the same record when a step is blocked.
 *
 * No entry point, for `open.ts`'s reason: a bundle that imported this from
 * `wait.ts` would run wait's `main` too.
 */

import * as cacheTtl from '../core/cache_ttl';
import * as sessionTarget from '../core/session_target';
import { randomUUID } from 'crypto';
import { WAIT_TTL_MS, staleBound } from '../core/coordination/guards';
import { recipient, staleAt } from '../core/coordination/send';
import type { Session } from '../core/model';
import type { WaitRecord } from '../core/coordination/wait';

/** Code 2 only. A 1 is `memberPids` in `wait.ts`: the flag was not a list of pids. */
export type WaitPlan = { ok: true; record: WaitRecord } | { ok: false; code: 2; reason: string };

/**
 * The whole decision, pure.
 *
 * The members are already process ids. A missing or malformed `--pids` is
 * `memberPids` in `wait.ts`, and it runs first — that is where a refusal
 * names the flag or prints the usage line. An empty list is refused here:
 * readiness withholds one when it names nobody, and this is the answer if a
 * list still arrives empty. The sentence names no flag, because
 * `squadron-step` prints it. Then identity, because a wait with no requester
 * has nobody to wake and nothing to be resolved by — ownership of the
 * requester's pipe is what picks the resolving window, so a caller that
 * cannot be placed on the board is a record no window would ever claim.
 *
 * **A member that is not on the board is accepted** (OQ9). The predicate
 * already resolves a dead member and names it as gone, so a check here would
 * only move the same answer earlier — and it would be advisory anyway, since a
 * member can die in the microseconds between this check and the write. The
 * requester learns which of its children stopped existing either way, and
 * learns it in the one message rather than from a refusal it has to interpret.
 */
export function waitPlan(
  pids: readonly number[],
  sessions: readonly Session[],
  callerId: string | undefined,
  now: number,
  context: sessionTarget.TargetContext = {}
): WaitPlan {
  const members: number[] = [];
  for (const pid of pids) {
    // Named twice is one member. The resolution names each member once, so a
    // duplicate here would only be a second chance to get the count wrong.
    if (!members.includes(pid)) {
      members.push(pid);
    }
  }
  if (members.length === 0) {
    return { ok: false, code: 2, reason: 'a wait needs a session, and none was named' };
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
    return { ok: false, code: 2, reason: `no session on the board is ${callerId}` };
  }
  const resolved = sessionTarget.resolveTarget(caller, context);
  if (!resolved.ok) {
    const reason =
      resolved.reason === 'background'
        ? "you are a background session the CLI's own daemon runs; no window holds a pipe to wake you on"
        : resolved.reason === 'owner-missing'
          ? 'you have a pipe, but no window claims it — nothing here could deliver the wake'
          : resolved.reason === 'unpublished'
            ? 'no window publishes a pipe for you — nothing here could deliver the wake'
            : resolved.reason === 'exited'
              ? 'your session has exited — nothing here could deliver the wake'
              : 'your session has invalid control facts — nothing here could deliver the wake';
    return { ok: false, code: 2, reason };
  }
  // A wait over yourself converges the instant your turn ends, which is a
  // billed wake that says nothing — the exact cost this feature exists to
  // remove, reproduced inside it.
  if (members.includes(caller.pid)) {
    return {
      ok: false,
      code: 2,
      reason: `pid ${caller.pid} is you; a wait over yourself resolves the moment your turn ends`
    };
  }

  const ttl = caller.cache?.ttlMs;
  const lifetime = cacheTtl.validTtl(ttl)
    ? Math.min(WAIT_TTL_MS, staleBound(ttl) - 60_000)
    : WAIT_TTL_MS;
  // A busy requester's stale clock restarts when its turn ends; an idle one's
  // is already running, so its resolution must land before the guard's own
  // deadline for it, not a full lifetime from now.
  const budget =
    caller.status === 'idle'
      ? Math.min(lifetime, staleAt(recipient(caller)).at - 60_000 - now)
      : lifetime;
  if (budget <= 0)
    return {
      ok: false,
      code: 2,
      reason: 'The requester prompt-cache lifetime leaves no time to deliver a wait resolution.'
    };

  return {
    ok: true,
    record: {
      schema: 1,
      id: randomUUID(),
      requesterPid: caller.pid,
      requesterSessionId: callerId,
      members,
      createdAt: now,
      // Derived rather than chosen: a resolution obeys the stale guard, so it
      // must land before its requester is too cold to be sent to (`guards.ts`).
      expiresAt: now + budget
    }
  };
}

export function registered(record: WaitRecord): string {
  const count = `${record.members.length} session${record.members.length === 1 ? '' : 's'}`;
  return (
    `registered a wait over ${count}: ${record.members.join(', ')}\n` +
    'End your turn now. You will be messaged once, ' +
    (record.workflow
      ? 'when the workflow can advance or stops'
      : 'when every one of them has finished') +
    ' — do not poll, and do not run this again.\n'
  );
}
