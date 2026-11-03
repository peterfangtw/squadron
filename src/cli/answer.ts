/**
 * Squadron: answer another session's open question, from inside one.
 *
 * `send --interrupt` with a question's address on it: one JSON entry per
 * question, delivered as prose that arrives as the asker's next prompt,
 * attributed like any peer's message. `core/coordination/answer.ts` has how
 * the interrupt withdraws the question, and why a message.
 *
 * What the address adds over a plain send: the request must be an open
 * question standing alone — never a permission, `--force` or not
 * (`openQuestion`) — checked here against the record the asker's window
 * published, and again in the window, whose check is the one that counts.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-answer.js`, which the extension
 * copies to `~/.squadron/bin/squadron-answer`.
 *
 * Exit codes, send's table:
 *   0  the window took the answer, and interrupts to withdraw the question
 *   1  bad usage — arguments or answer-file input
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
import type { PublishedLive } from '../core/published';
import { readActions, type CountedAction } from '../core/coordination/actions';
import { answerProse, openQuestion } from '../core/coordination/answer';
import { ask, askExit } from '../core/coordination/ask';
import { requestIdOf } from '../core/coordination/requests';
import { checkSend, recipient, wrapMessage } from '../core/coordination/send';
import * as sessionTarget from '../core/session_target';
import { Flags, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard, openRequests, targetRefusal } from './board';
import * as inputFile from './input_file';

const USAGE =
  'usage: squadron-answer --pid <n> --request-id <requestId> (--answers <json> | --answers-file <path>) [--caller-session-id <sessionId>] [--force]\n--answers-file: regular UTF-8 JSON file, optional initial BOM, at most 98304 bytes (96 KiB)';

export const FLAGS = [
  'pid',
  'request-id',
  'answers',
  'answers-file',
  'caller-session-id',
  'force'
] as const;
const BARE = ['force'] as const;

/** `--request-id`, the `requestId` an `asking` row carries. */
const RENAMED: Renamed<typeof FLAGS> = {
  request: 'request-id',
  caller: 'caller-session-id'
};

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS, BARE);
}

/** File IO ends here; the plan receives the same JSON text as inline input. */
export async function readAnswerInput(
  opts: Options
): Promise<{ ok: true; answers: string } | { ok: false; reason: string }> {
  const file = opts['answers-file'];
  if (file === undefined && opts.answers !== undefined) return { ok: true, answers: opts.answers };
  if (file === undefined || opts.answers !== undefined) {
    return { ok: false, reason: `pass exactly one of --answers or --answers-file\n${USAGE}` };
  }

  try {
    const answers = await inputFile.readInputText(file);
    JSON.parse(answers);
    return { ok: true, answers };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `--answers-file: ${why}\n${USAGE}` };
  }
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-answer: ${message}\n`);
  process.exit(code);
}

export type AnswerPlan =
  | {
      ok: true;
      target: Session;
      address: sessionTarget.SessionAddress;
      askId: string;
      /** The prose, wrapped with the caller's attribution. */
      text: string;
      from: string;
    }
  | { ok: false; code: 1 | 2; reason: string };

/**
 * The whole decision, pure, in `sendPlan`'s order: arguments, then identity,
 * then whether `resolveTarget` can address the selected session, then whether
 * the request is an open question and the answer covers it, then send's guards.
 * An exited asker keeps the closed-question sentence.
 */
export function answerPlan(
  opts: Omit<Options, 'answers-file'>,
  sessions: readonly Session[],
  published: ReadonlyMap<number, PublishedLive>,
  callerId: string | undefined,
  actions: readonly CountedAction[],
  now: number,
  context: sessionTarget.TargetContext = {}
): AnswerPlan {
  const pid = Number(opts.pid);
  if (opts.pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 1, reason: `--pid takes a process id\n${USAGE}` };
  }
  if (!opts['request-id']) {
    return { ok: false, code: 1, reason: `--request-id is required\n${USAGE}` };
  }
  if (opts.answers === undefined) {
    return { ok: false, code: 1, reason: `--answers is required\n${USAGE}` };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(opts.answers);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 1, reason: `--answers is not JSON (${why})\n${USAGE}` };
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
  const resolved = sessionTarget.resolveTarget(target, { claims: context.claims, published });
  if (!resolved.ok && resolved.reason !== 'exited') {
    return {
      ok: false,
      code: 2,
      reason: targetRefusal(resolved.reason, `pid ${pid}`, 'answer on')
    };
  }

  const open = openQuestion(openRequests(target, published), opts['request-id']);
  if (!open.ok) {
    return { ok: false, code: 2, reason: open.reason };
  }
  if (!resolved.ok) {
    return { ok: false, code: 2, reason: 'That question is no longer open.' };
  }
  const prose = answerProse(open.request, entries);
  if (!prose.ok) {
    return { ok: false, code: 2, reason: prose.reason };
  }
  const verdict = checkSend({
    windowId: resolved.address.windowId,
    target: recipient(resolved.session),
    text: prose.text,
    now,
    actions,
    force: opts.force !== undefined
  });
  if (!verdict.ok) {
    return { ok: false, code: 2, reason: verdict.reason };
  }
  return {
    ok: true,
    target: resolved.session,
    address: resolved.address,
    askId: opts['request-id'],
    text: wrapMessage(prose.text, callerId),
    from: callerId
  };
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-answer');
  if (help.show('answer', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  // The answer source is an argument too, so a bad one is exit 1 first.
  const input = await readAnswerInput(opts);
  if (!input.ok) die(1, input.reason);
  await gate.refuseUnlessOn('answer');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  const plan = answerPlan(
    { ...opts, answers: input.answers },
    board.sessions,
    board.published,
    opts['caller-session-id'] ?? ownSessionId(process.env),
    await readActions(),
    Date.now(),
    board
  );
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }

  const result = await ask({
    kind: 'answer',
    origin: 'agent',
    ...plan.address,
    askId: plan.askId,
    text: plan.text,
    from: plan.from,
    ...(opts.force !== undefined ? { force: true } : {})
  });
  if (!result.ok) {
    if (result.kind === 'silent' || (result.kind === 'refused' && result.reply.unsure)) {
      // Silence is not refusal: the window may have answered and died before
      // replying. An `answer` record naming the request id says it did.
      die(
        askExit(result),
        `the outcome is unknown. Request ${requestIdOf(result.file)} — a record naming it under ` +
          `${ACTIONS_DIR} means the answer was given, and none means it was not. ` +
          'Look before answering again.'
      );
    }
    die(
      askExit(result),
      result.kind === 'refused' ? (result.reply.reason ?? 'the window refused') : result.reason
    );
  }
  // Not "withdrawn": as with `send --interrupt`, nothing reports whether the
  // interrupt landed. The asker's transcript does.
  process.stdout.write(`answer sent to ${plan.target.pid}; the interrupt withdraws the question\n`);
}

// Only when run, so the tests can import the decisions above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
