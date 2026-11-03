/**
 * Squadron: say something to another session, from inside one.
 *
 * With `list`, the half that kills the relay. A fan-out could be started and
 * ended from a session and not *talked to*, so every hand-off was a human
 * reading one card and retyping it into another.
 *
 * **This posts a request; it never writes to a pipe.** The pipe belongs to the
 * window that started the session, and only that window can put a frame on it —
 * the same reason `end` posts a `close` rather than signalling.
 *
 * **Both halves check.** `checkSend` runs here, where the whole board is in
 * hand, and again in the window, which is what a raw request file reaches.
 * The wrapper is written here for the same reason and once more there if it is
 * missing: an older window delivering bare text would put a turn on a card
 * wearing a person's face, and attribution that can be dropped is attribution
 * nobody can rely on.
 *
 * Authority is machine-wide, unlike `end`'s descent. Every session here
 * belongs to one person, the risk is a runaway loop rather than a privilege,
 * and descent-only would refuse every sibling hand-off a fan-out is made of.
 * The bound is arithmetic instead — `core/coordination/send.ts`.
 *
 * Cache admission uses the folded session's published lifetime. A session with
 * no cache stamp falls back to its own activity clock.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-send.js`, which the extension
 * copies to `~/.squadron/bin/squadron-send`.
 *
 * Exit codes, spawn's table:
 *   0  the window took it — `queued` says whether it is on the pipe or held
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused — by this command, or by the window that answered no
 *   3  no live IDE window to ask
 *   4  the window went silent; one that answered no is a 2
 *   5  this command could not ask: a request that would not write, or an error
 *      nothing here expected
 */

import * as gate from './gate';
import * as help from './help';
import { Session } from '../core/model';
import { ACTIONS_DIR } from '../core/paths';
import { ask, askExit } from '../core/coordination/ask';
import { requestIdOf, type Reply } from '../core/coordination/requests';
import { readActions } from '../core/coordination/actions';
import { checkSend, recipient, wrapMessage } from '../core/coordination/send';
import * as sessionTarget from '../core/session_target';
import { Flags, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard, targetRefusal } from './board';
import * as inputFile from './input_file';

const USAGE =
  'usage: squadron-send --pid <n> --text <message> [--caller-session-id <sessionId>] [--force] [--interrupt]';

export const FLAGS = ['pid', 'text', 'caller-session-id', 'force', 'interrupt'] as const;
const BARE = ['force', 'interrupt'] as const;

/** `--caller-session-id`: the flag says which of a session's ids it takes. */
const RENAMED: Renamed<typeof FLAGS> = { caller: 'caller-session-id' };

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS, BARE);
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-send: ${message}\n`);
  process.exit(code);
}

/**
 * What one invocation would send, or why it would not.
 *
 * The text is settled here rather than at the post: a plan that carried the raw
 * message would leave the wrapping to the caller, and a caller that forgot is a
 * message with no author on a card that cannot tell.
 */
export type SendPlan =
  | {
      ok: true;
      target: Session;
      address: sessionTarget.SessionAddress;
      text: string;
      from: string;
      /** The caller's own pid, when the board names exactly one session for its
       *  sessionId. `RequestBody`'s `send` variant says what the window does
       *  with it and why it is resolved here rather than there. */
      fromPid?: number;
    }
  | { ok: false; code: 1 | 2; reason: string };

/**
 * The whole decision, pure.
 *
 * The order is the design, and it is `endPlan`'s. Arguments first, since a
 * malformed one is not a refusal. Then identity: a caller that cannot say who
 * it is has nothing to attribute, nothing to rate-limit and nothing to record.
 * Then whether `resolveTarget` can address the selected session. An exited
 * publication is refused before the guardrails, which are about whether *now*
 * is the moment.
 */
export function sendPlan(
  opts: Options,
  sessions: readonly Session[],
  callerId: string | undefined,
  actions: Parameters<typeof checkSend>[0]['actions'],
  now: number,
  context: sessionTarget.TargetContext = {}
): SendPlan {
  const pid = Number(opts.pid);
  if (opts.pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 1, reason: `--pid takes a process id\n${USAGE}` };
  }
  if (opts.text === undefined) {
    return { ok: false, code: 1, reason: `--text is required\n${USAGE}` };
  }
  if (callerId === undefined || callerId === '') {
    return {
      ok: false,
      code: 2,
      reason: 'cannot tell which session is asking; pass --caller-session-id <sessionId>'
    };
  }

  const target = sessions.find((s) => s.pid === pid);
  if (!target) {
    return { ok: false, code: 2, reason: `no session on the board has pid ${pid}` };
  }
  const resolved = sessionTarget.resolveTarget(target, context);
  if (!resolved.ok) {
    return { ok: false, code: 2, reason: targetRefusal(resolved.reason, `pid ${pid}`, 'send on') };
  }

  const verdict = checkSend({
    windowId: resolved.address.windowId,
    target: recipient(resolved.session),
    text: opts.text,
    now,
    actions,
    force: opts.force !== undefined
  });
  if (!verdict.ok) {
    return { ok: false, code: 2, reason: verdict.reason };
  }

  // Exactly one, or none. Two sessions can share a sessionId — `cli/list.ts`:
  // a resumed conversation puts two cards on the same one — and which of them
  // is sending this is not decidable from here. Guessing would file one
  // session's words under another session's name in a convergence, which is
  // the failure the attribution wrapper exists to prevent, arrived at from the
  // other side. Omitted, the send is held against no wait and behaves as it
  // always has.
  const mine = sessions.filter((s) => s.sessionId === callerId);
  const only = mine.length === 1 ? mine[0] : undefined;

  return {
    ok: true,
    target: resolved.session,
    address: resolved.address,
    text: wrapMessage(opts.text, callerId),
    from: callerId,
    ...(only ? { fromPid: only.pid } : {})
  };
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-send');
  if (help.show('send', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('send');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  const plan = sendPlan(
    opts,
    board.sessions,
    opts['caller-session-id'] ?? ownSessionId(process.env),
    await readActions(),
    Date.now(),
    board
  );
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }

  const result = await ask({
    kind: 'send',
    origin: 'agent',
    ...plan.address,
    text: plan.text,
    from: plan.from,
    via: 'verb',
    ...(plan.fromPid !== undefined ? { fromPid: plan.fromPid } : {}),
    ...(opts.interrupt !== undefined ? { interrupt: true } : {}),
    ...(opts.force !== undefined ? { force: true } : {})
  });
  if (!result.ok) {
    if (result.kind === 'silent' || (result.kind === 'refused' && result.reply.unsure)) {
      // Silence is not refusal, and saying "refused" here would send a caller
      // looking for a reason nobody wrote. The request id is what makes the
      // difference findable: a record under `actions/` naming it means the window
      // accepted and died before answering, and no record means it never did.
      die(
        askExit(result),
        `the outcome is unknown. Request ${requestIdOf(result.file)} — a record naming it under ` +
          `${ACTIONS_DIR} means the message was accepted, and none means it was not.`
      );
    }
    die(
      askExit(result),
      result.kind === 'refused' ? (result.reply.reason ?? 'the window refused') : result.reason
    );
  }
  process.stdout.write(landed(plan.target.pid, result.reply));
}

/**
 * What became of the message, in one line for the sender.
 *
 * **A fact about what happened, never advice about what to do.** The wait line
 * is the notice this feature's PRD proposed and then rejected, reborn in the
 * only shape that survives: a prototype that *advised* a matching sender the
 * requester would be woken anyway was printed correctly on both of a child's
 * sends, and the child sent through it both times. Agents obey the brief in
 * their prompt over a line in tool output. This asks nothing of the reader, so
 * there is nothing for it to disobey.
 *
 * Checked before `queued` because the two describe different places: a parked
 * report is not in the outbox and is not waiting on an idle edge, so the depth
 * beside it — which is still reported, and still true — says nothing about
 * where *this* message went.
 *
 * Pure and exported for the reason `sendPlan` is: the sentence a caller reads
 * is worth a test, and `main` writing to stdout is not one.
 */
export function landed(pid: number, reply: Reply): string {
  if (typeof reply.heldForWait === 'number') {
    return (
      `sent to ${pid} — held for ${reply.heldForWait}'s wait, and delivered ` +
      'when every session it names has finished\n'
    );
  }
  // `queued` is the outbox depth the window was left with, and only that window
  // can see it: 0 means the message is on the pipe, and anything else means the
  // session is busy and it is held for the next idle edge.
  const held = typeof reply.queued === 'number' ? reply.queued : undefined;
  const where = held === undefined ? '' : held === 0 ? ' (sent)' : ` (held, ${held} in the outbox)`;
  return `sent to ${pid}${where}\n`;
}

// Only when run, so the tests can import the decisions above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
