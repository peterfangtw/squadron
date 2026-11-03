/**
 * Opening a session through a window: what `squadron-spawn` asks, shared with
 * `squadron-step`, which opens a lane with the same ask so the two cannot grow
 * different exit codes.
 *
 * **No entry point, on purpose** — the reason `windows.ts` has none. esbuild
 * puts every imported module in one bundle, where each verb's
 * `require.main === module` is true at once: `step.ts` importing these from
 * `spawn.ts` ran spawn's own `main` first, and every `squadron-step` call died
 * on spawn's usage line (smoke, 2026-09-30).
 */

import * as windows from './windows';
import { ownSessionId } from './args';
import { readClaims } from '../core/coordination/claims';
import { LINEAGE_DIR, STARTUPS_DIR } from '../core/paths';
import { readPublished } from '../core/published';
import { ask, askExit } from '../core/coordination/ask';
import { OPEN_REPLY_MS, requestIdOf } from '../core/coordination/requests';
import type { BrandId } from '../core/model';

/**
 * Which fan-out the new session belongs to, from what this process was given.
 *
 * `--parent-session-id` first, and that ordering is what keeps the flag meaning something:
 * naming a parent explicitly opens a fan-out at that parent, while the normal
 * spawn passes no `--parent-session-id` and inherits. Without it, an agent relocating a
 * card would get a lineage chip and a family box that disagree and no way to
 * say so. There is deliberately no `--origin` — nothing has asked for one, and
 * omitting `--parent-session-id` already makes a root.
 *
 * Then `SQUADRON_LINEAGE_ORIGIN`, planted on this session by whoever started
 * it. Then this session's own id, because a spawn with no inherited fan-out is
 * opening one and this session is where it opens.
 *
 * Empty is absent, not a value: `parseArgs` takes `--parent-session-id ""` and `??` would
 * carry it the whole way — planted on the child, inherited by everything below
 * it, and never falling past, since the empty string is not `undefined`. It
 * would then join a session whose own `sessionId` failed to parse, and box two
 * strangers under a third. One hop of that is bad; a whole fan-out of it is why
 * the check is here.
 *
 * A parameter rather than a read of `process.env`, so the three-way fallback is
 * testable without a process.
 */
export function resolveOrigin(
  opts: { 'parent-session-id'?: string },
  env: NodeJS.ProcessEnv
): string | undefined {
  return [opts['parent-session-id'], env.SQUADRON_LINEAGE_ORIGIN, ownSessionId(env)].find(
    (id) => id !== undefined && id !== ''
  );
}

/**
 * What to tell a caller whose window never answered.
 *
 * Not "it did not happen". The window removes the request file *before* running
 * the handler and writes the reply after it returns — and swallows a failure to
 * write that reply — so silence is "asked, outcome unknown" and nothing here can
 * narrow it. The only instruction that cannot double-spawn is to go and look.
 * `startups/<requestId>.json` exists from admission. The lineage entry, named
 * by the same request id, is written after the handshake. That id is the only
 * name this side holds for a session it never heard the pid of.
 */
export function unanswered(label: string, file: string): string {
  return `${label} did not answer. ${unknownOutcome(file)}`;
}

function unknownOutcome(file: string): string {
  const id = requestIdOf(file);
  return (
    `A session may still have started: before spawning ` +
    `again, look for ${id}.json under ${STARTUPS_DIR} (written at admission) ` +
    `and under ${LINEAGE_DIR} for an entry whose requestId is ${id} (written once the session is up).`
  );
}

/**
 * One open, as `squadron-spawn` posts it. `squadron-step` opens a lane through
 * this rather than a second ask, so the two cannot grow different exit codes.
 */
export type OpenSessionRequest = {
  cwd: string;
  prompt: string;
  name?: string;
  parentSessionId?: string;
  originSessionId?: string;
  /** Who wrote the prompt; the child's dock names it as a peer. */
  from?: string;
  ticketRef?: string;
  workflowId?: string;
  brand?: BrandId;
  model?: string;
  /** Context window, in tokens. Not which IDE window is asked. */
  window?: number;
  effort?: string;
};

/**
 * `requestId` is the name the window files the spawn's lineage under, where a
 * request was written at all — what `squadron-step` keeps for a lane whose pid
 * it never heard.
 */
export type OpenSessionResult =
  | { ok: true; pid?: number; windowLabel: string; requestId?: string }
  | {
      ok: false;
      code: 2 | 3 | 4 | 5;
      reason: string;
      requestId?: string;
      /** Set only when the window refused the brand, model or effort. */
      cause?: 'pick';
    };

/**
 * A refusal the window marked as the pick. Absent is not one: an older window
 * sends no `cause`, and neither does a fleet, burst, prompt or cwd refusal.
 */
export function pickCause(
  reply: { cause?: string; startupVersion?: 1; notStarted?: true } | undefined
): { cause: 'pick' } | undefined {
  return reply?.cause === 'pick' && reply.startupVersion === 1 && reply.notStarted === true
    ? { cause: 'pick' }
    : undefined;
}

/**
 * Pick a window and ask it to start the session.
 *
 * Usage failures stay in `main`: this is only the part that talks to a window,
 * and its codes are that conversation's (2 refused, 3 no window, 4 silence,
 * 5 could not ask).
 */
export async function openSession(request: OpenSessionRequest): Promise<OpenSessionResult> {
  const claims = await readClaims();
  // The environment, never `resolveOrigin`: that one answers "which fan-out is
  // this", and `--parent-session-id` re-points it at a session in some other window
  // entirely. What a window is picked from is where the command is running.
  const origin = windows.originWindow(process.env, await readPublished());
  const window = await windows.pickWindow(claims, request.cwd, origin);
  if (!window) {
    return { ok: false, code: 3, reason: 'no IDE window is running with Squadron installed' };
  }

  const result = await ask(
    {
      kind: 'open',
      origin: 'agent',
      windowId: window.id,
      cwd: request.cwd,
      prompt: request.prompt,
      // What the card calls the session. Passed through rather than derived here:
      // the window is where the flag is finally written, and one derivation there
      // covers this shim, an older one, and the panel's own spawns alike.
      name: request.name,
      parentSessionId: request.parentSessionId,
      // The fan-out, which is not the parent: a chain of spawns all name the
      // session it opened at, so the board boxes the four of them together even
      // after a generation in the middle has gone.
      originSessionId: request.originSessionId,
      from: request.from,
      // The ticket this work came from, when the spawn is a hand-off. Recorded
      // beside the parent because the spawn is the only moment both are in hand.
      ticketRef: request.ticketRef,
      // The workflow the child is to run. Checked by the window, against the
      // child's cwd — a refusal comes back as exit 2.
      workflowId: request.workflowId,
      // Which CLI to start. Absent, with no model either, means inherit at
      // the window — this shim does not know the parent's model. Sending
      // `claude` would hide the inherit case from a new window and be a
      // spelling only new windows read.
      brand: request.brand,
      // Same bargain as brand: absent, not defaulted. An older window
      // ignores the field and falls back to the gear — same as `brand`.
      model: request.model,
      ...(request.window === undefined ? {} : { window: request.window }),
      // Checked at the window, not here: only it knows an inherited model and
      // a live Codex row, and it answers a value the model lacks with exit 2.
      effort: request.effort
    },
    OPEN_REPLY_MS
  );
  if (!result.ok) {
    if (
      result.kind === 'silent' ||
      (result.kind === 'refused' &&
        (result.reply.unsure || result.reply.startupVersion !== 1 || !result.reply.notStarted))
    ) {
      return {
        ok: false,
        code: 4,
        reason:
          result.kind === 'silent'
            ? unanswered(window.label, result.file)
            : `${result.reason}. ${unknownOutcome(result.file)}`,
        requestId: requestIdOf(result.file)
      };
    }
    return {
      ok: false,
      code: askExit(result),
      reason: result.kind === 'refused' ? (result.reply.reason ?? 'refused') : result.reason,
      ...pickCause(result.kind === 'refused' ? result.reply : undefined)
    };
  }
  return {
    ok: true,
    pid: result.reply.pid,
    windowLabel: window.label,
    requestId: requestIdOf(result.file)
  };
}
