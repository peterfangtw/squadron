/**
 * Squadron: be told once, when these sessions are done.
 *
 * The sixth verb, and the counterpart to the fan-out the other five make
 * possible. Brief three children to report back and the parent wakes three
 * times, each wake re-sending its whole conversation; two of the three buy
 * nothing, because it cannot synthesise until all three are in. This registers
 * *"tell me when they are finished"* and returns at once, so the parent ends
 * its turn and is woken exactly once.
 *
 * **It does not wait.** The name says who acts next, not that anything blocks:
 * nothing here polls, sleeps or holds a tool call open, and the sentence it
 * prints says to end the turn. A shim that cannot block cannot invite the
 * failure a blocking one would — `PRD_shipped_wait.md` §5.2.
 *
 * **It asks no window, and writes no request** — it reads the window claims
 * only for Orchestration's switch (`gate.ts`). The record lands in `waits/`
 * addressed to nobody; whichever window owns the requester's pipe picks it up
 * on its next evaluation. Every check registration needs, it makes itself off
 * disk — which is `list`'s shape, and it buys the same thing: **there is no
 * exit 4 here.** The "asked, outcome unknown" class `spawn` and `send` both
 * carry does not exist for a verb that asks nothing.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-wait.js`, which the extension
 * copies to `~/.squadron/bin/squadron-wait`.
 *
 * Exit codes, spawn's table less the one nothing here can reach:
 *   0  registered — end the turn
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused, with a reason, or Orchestration off
 *   3  no live IDE window: the switch cannot be read, and nothing could ever
 *      resolve it
 *   5  a record that would not write, or an error nothing here expected
 */

import * as gate from './gate';
import * as help from './help';
import { writeWait } from '../core/coordination/wait';
import { Flags, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard } from './board';
import { registered, waitPlan } from './wait_plan';
import * as inputFile from './input_file';

const USAGE = 'usage: squadron-wait --pids <n,n,…> [--caller-session-id <sessionId>]';

export const FLAGS = ['pids', 'caller-session-id'] as const;

/** `--caller-session-id`: the flag says which of a session's ids it takes. */
const RENAMED: Renamed<typeof FLAGS> = { caller: 'caller-session-id' };

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS);
}

/**
 * The process ids `--pids` named, or why that flag is not a list of them.
 * A repeated id is kept; `waitPlan` counts it once.
 */
export function memberPids(
  raw: string | undefined
): { ok: true; pids: number[] } | { ok: false; code: 1; reason: string } {
  if (raw === undefined) {
    return { ok: false, code: 1, reason: `--pids is required\n${USAGE}` };
  }
  const asked = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (asked.length === 0) {
    return { ok: false, code: 1, reason: `--pids takes at least one process id\n${USAGE}` };
  }
  const pids: number[] = [];
  for (const part of asked) {
    const pid = Number(part);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, code: 1, reason: `--pids takes process ids; "${part}" is not one` };
    }
    pids.push(pid);
  }
  return { ok: true, pids };
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-wait: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-wait');
  if (help.show('wait', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('wait');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  // After the board, as this check was inside the plan: no window is exit 3
  // before a pid that is not one is exit 1.
  const members = memberPids(opts.pids);
  if (!members.ok) {
    die(members.code, members.reason);
  }

  const plan = waitPlan(
    members.pids,
    board.sessions,
    opts['caller-session-id'] ?? ownSessionId(process.env),
    Date.now(),
    board
  );
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }
  if (!(await writeWait(plan.record))) {
    die(5, 'could not write the wait');
  }
  process.stdout.write(registered(plan.record));
}

// Only when run, so the tests can import the decisions above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
