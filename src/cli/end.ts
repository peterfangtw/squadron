/**
 * Squadron: end a session from inside another.
 *
 * The other half of `squadron-spawn`. A session could create fleet members it
 * had no way to take down: `close` has been in the request protocol since the
 * cross-window work and the panel's End button was its only caller, so a
 * fan-out could only be undone by a human clicking.
 *
 * **This posts a request; it never signals.** A signal from here would reach the
 * process and nothing else — the window holding the pipe would keep a registry
 * entry for a session it reads as having died on its own, which is a card left
 * on the board saying `unknown` whose own End button has quietly become a
 * dismiss (`host/panel.ts:endHeld`, observed 2026-08-04). `endSession` on the
 * owning window is the only thing that ends the process *and* takes the card
 * off the board, and a `close` request is how another process asks for it.
 *
 * Authority is the caller's own descent, plus itself behind `--self`: a session
 * may undo what it started and end itself. `--any` waives the descent for a
 * session that must end one it did not start, and nothing else. Cascades use
 * `closeDescendants`, the same function behind the panel's `End all N`.
 * Targeting yourself leaves that descent running.
 *
 * Authority is not the whole answer, though, and this is the one place the two
 * halves differ on purpose. A busy session is refused here however impeccable
 * the descent, because the caller is an agent acting on a reading nobody has
 * checked. The panel's End button keeps no such rule: it says what the session
 * is doing and asks (`ui/closing.ts`), and a person who answers anyway is the
 * escape hatch this refusal is safe to have.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-end.js`, which the extension
 * copies to `~/.squadron/bin/squadron-end` — one self-contained
 * file, for the reason `spawn.ts` says. The decision and the close live in
 * `end_plan.ts`, which has no entry point: `squadron-step` imports them to end
 * a lane whose picked model never started, and importing this file would run
 * `main` inside the step bundle (`cli_bundles.test.ts`).
 *
 * Exit codes, same table as spawn — and every row here is one `main` can
 * actually emit, which the first draft's was not: it promised a 4 nothing
 * reached and a 3 for a request that failed to write, where both fell into 2.
 *   0  every session named was ended
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused — by this command, or by a window that answered no
 *   3  no live IDE window to ask
 *   4  outcome unknown; no refusal or submission failure
 *   5  this command could not ask: a request that would not write, or an error
 *      nothing here expected. Distinct from 1 because it is the one case where
 *      the arguments were fine, and a model told "fix the arguments" retries a
 *      correct command against a machine that is still broken (2026-08-18).
 */

import * as gate from './gate';
import * as help from './help';
import * as sessionTarget from '../core/session_target';
import { askExit } from '../core/coordination/ask';
import { postRequest } from '../core/coordination/requests';
import { displayName } from '../ui/views';
import { ownSessionId, usageFor } from './args';
import { loadBoard } from './board';
import * as inputFile from './input_file';
import {
  RENAMED,
  closeMembers,
  endPlan,
  parseArgs,
  type EndPlan,
  type EndTarget,
  type Options,
  type Outcome
} from './end_plan';

export { FLAGS, parseArgs, endPlan } from './end_plan';
export type { EndPlan, EndTarget, Options } from './end_plan';

const USAGE =
  'usage: squadron-end (--pid <n> | --session-id <sessionId>) [--only] [--self] [--any] [--caller-session-id <sessionId>]';

/**
 * The target `endPlan` takes, or why these flags are not one.
 *
 * A pid is a process id here, so the plan never reads a flag string and a
 * refusal it returns never carries this usage line. `--only` passes through
 * as presence, and the plan names it when the request parsed. `--self` and
 * `--any` do too, but the plan only marks which refusal a flag would lift: the
 * flag is named by {@link endRefusal}, because `squadron-step` reaches the
 * same refusals and has neither flag.
 */
export function endTarget(
  opts: Options
): { ok: true; target: EndTarget } | { ok: false; code: 1; reason: string } {
  const flags = {
    ...(opts.only !== undefined ? { only: opts.only } : {}),
    ...(opts.self !== undefined ? { self: opts.self } : {}),
    ...(opts.any !== undefined ? { any: opts.any } : {})
  };
  if (opts.pid !== undefined) {
    if (opts['session-id'] !== undefined) {
      return { ok: false, code: 1, reason: `name one target\n${USAGE}` };
    }
    const pid = Number(opts.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, code: 1, reason: `--pid takes a process id\n${USAGE}` };
    }
    return { ok: true, target: { pid, ...flags } };
  }
  if (opts['session-id'] === undefined) {
    return { ok: false, code: 1, reason: `name one target\n${USAGE}` };
  }
  return { ok: true, target: { session: opts['session-id'], ...flags } };
}

/**
 * What `squadron-end` prints for a plan that refused.
 *
 * The plan's self and descent reasons name no flag. This verb has `--self`
 * and `--any`, so the hint is added here and nowhere else.
 */
export function endRefusal(plan: Extract<EndPlan, { ok: false }>): string {
  if (plan.about === 'self') return `${plan.reason}; pass --self to end it`;
  if (plan.about === 'descent') return `${plan.reason}; pass --any if it must end`;
  return plan.reason;
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-end: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-end');
  if (help.show('end', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('end');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  // After the board, as this check was inside the plan: no window is exit 3
  // before a pid that is not one is exit 1.
  const asked = endTarget(opts);
  if (!asked.ok) {
    die(asked.code, asked.reason);
  }

  const plan = endPlan(
    asked.target,
    board.sessions,
    opts['caller-session-id'] ?? ownSessionId(process.env)
  );
  if (!plan.ok) {
    die(plan.code, endRefusal(plan));
  }

  // Together, not one after another: a request is binned unread once it is ten
  // seconds old (`core/coordination/requests.ts`), and a descent posted serially against
  // windows that each take their time is one whose last member goes stale.
  const results = await closeMembers(plan.members, board);
  // The predicate rather than a bare `!r.ok`: `filter` does not narrow a union,
  // and without it every read of `kind` and `reason` below needs a guard that
  // proves something already known.
  const failed = results.filter((r): r is Extract<Outcome, { ok: false }> => !r.ok);
  // Taken here, before the self leg below can push into `failed`. That entry was
  // never in `results`, so subtracting it at the report site counted a member
  // that does not exist: one member closed plus a failed self printed
  // `ended 0 of 1` (2026-08-18).
  const ended = results.length - failed.length;

  if (plan.self) {
    // Last, and never awaited: this ends the process reading the reply. What is
    // said about it is said before it is asked for, since there is no after.
    //
    const resolved = sessionTarget.resolveTarget(plan.self, board);
    if (!resolved.ok) {
      failed.push({
        ok: false,
        kind: 'unwritable',
        reason:
          resolved.reason === 'owner-missing'
            ? 'this session: no window claims it'
            : `this session: ${resolved.reason}`
      });
    } else {
      // The write is checked, where it used to be discarded — every other member
      // checks it (`closeOne`) and so does the window above, and without it a
      // request that never reached disk exited 0 under `ending this session`,
      // which is the one outcome a caller cannot tell from success.
      //
      // Said after the write rather than before it, which the note above is not
      // in conflict with: "there is no after" is about the *reply*, and the
      // window cannot act until its next poll. A local file write is not that
      // long, so this still prints before anything can end the process — and it
      // no longer promises an end that was never asked for.
      const file = await postRequest({
        kind: 'close',
        ...resolved.address
      });
      if (file === undefined) {
        failed.push({
          ok: false,
          kind: 'unwritable',
          reason: 'this session: could not write the request'
        });
      } else {
        process.stdout.write(
          `ending this session (pid ${plan.self.pid}) — unconfirmed by design\n`
        );
      }
    }
  }

  if (failed.length > 0) {
    die(
      askExit(failed),
      `ended ${ended} of ${ended + failed.length}:\n` +
        failed.map((f) => `  ${f.reason}`).join('\n')
    );
  }
  if (results.length > 0) {
    const named = plan.members.map((s) => displayName(s)).join(', ');
    process.stdout.write(`ended ${results.length}: ${named}\n`);
  }
}

// Only when run, so the tests can import the decisions above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
