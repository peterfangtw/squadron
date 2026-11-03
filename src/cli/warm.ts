/**
 * Squadron: turn one card's Warm switch on or off, as the Warm sheet does.
 *
 * The choice lives in the registry of the window holding that session's pipe
 * (`host/sessions.ts` `setWarm`), so this posts a `warm` request to that window,
 * on `rename`'s route. `--pid` is required: a session warms itself by its own
 * pid, and there is no `--caller-session-id` for `rename`'s reason. Only the
 * switch moves; Warm's window and lifetime (`squadron.warmCache.*`) apply as
 * they do to a flip on the sheet.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-warm.js`. It imports no other
 * verb's file: in a bundle every verb's `require.main === module` is true.
 *
 * Exit codes, as `rename.ts`:
 *   0  the window took it
 *   1  bad usage
 *   2  refused: by this command, by the gate, or by the window that answered
 *   3  no live IDE window to ask
 *   4  the window was asked and never answered; it may have acted
 *   5  this command could not ask
 */

import * as gate from './gate';
import * as help from './help';
import { Session } from '../core/model';
import { ask, askExit } from '../core/coordination/ask';
import * as sessionTarget from '../core/session_target';
import { displayName } from '../ui/views';
import { Flags, parseFlags } from './args';
import { loadBoard, targetRefusal } from './board';
import * as inputFile from './input_file';

const USAGE = 'usage: squadron-warm --pid <n> [--off]';

/** Every flag this takes. `--off` is bare. */
export const FLAGS = ['pid', 'off'] as const;

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS, ['off']);
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-warm: ${message}\n`);
  process.exit(code);
}

/** 1 is "you typed it wrong", 2 is "well formed, and the answer is no" — `RenamePlan`'s split. */
export type WarmPlan =
  | { ok: true; target: Session; address: sessionTarget.SessionAddress; on: boolean }
  | { ok: false; code: 1 | 2; reason: string };

/** The whole decision, pure: the pid, the card it names, and whether it can be addressed. */
export function warmPlan(
  opts: Options,
  sessions: readonly Session[],
  context: sessionTarget.TargetContext = {}
): WarmPlan {
  if (opts.pid === undefined) {
    return { ok: false, code: 1, reason: `warm needs a --pid\n${USAGE}` };
  }
  const pid = Number(opts.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 1, reason: `--pid takes a process id\n${USAGE}` };
  }
  const target = sessions.find((s) => s.pid === pid);
  if (target === undefined) {
    return { ok: false, code: 2, reason: `no session on the board has pid ${pid}` };
  }
  const resolved = sessionTarget.resolveTarget(target, context);
  if (!resolved.ok) {
    return {
      ok: false,
      code: 2,
      reason: targetRefusal(resolved.reason, displayName(target), 'warm')
    };
  }
  return {
    ok: true,
    target: resolved.session,
    address: resolved.address,
    on: opts.off === undefined
  };
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-warm');
  if (help.show('warm', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, USAGE);
  }
  await gate.refuseUnlessOn('warm');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  const plan = warmPlan(opts, board.sessions, board);
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }

  const result = await ask({ kind: 'warm', ...plan.address, on: plan.on });
  if (!result.ok) {
    die(
      askExit(result),
      result.kind === 'silent'
        ? 'its window did not answer'
        : result.kind === 'refused'
          ? (result.reply.reason ?? 'refused')
          : result.reason
    );
  }
  process.stdout.write(`${plan.on ? 'warming' : 'stopped warming'} ${plan.target.pid}\n`);
}

// Only when run, so the tests can import the decision above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
