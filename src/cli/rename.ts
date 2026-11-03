/**
 * Squadron: name your own card, from inside the session it draws.
 *
 * The third door onto `host/sessions.ts`'s `stateName`, and the first one an
 * agent can reach. The name is **ours** to state: `stateName` writes it to
 * `core/names.ts`, republishes the card and only then asks the CLI, so what
 * this verb needs from the machine is the window holding that session's pipe
 * and nothing from the session's own brand — a CLI with no `/rename` renames
 * here too. The dock's name field reaches the same entry through
 * `renameSession`, another window reaches it through the `rename` request, and
 * a session had no road at all: the `agentsview` skill told one to "run
 * `/rename <title>`", so the model
 * printed that string as its answer and nothing consumed it — no synthetic
 * confirmation, no session file write, a card still wearing its spawn name
 * (observed 2026-08-18, session `09155ce5`). Text an agent emits is not a
 * command; this is the command.
 *
 * **Your own card by default, any owned card by `--pid`.** Without a pid the
 * target is read from the environment the CLI planted, which is the use this
 * was built for: a session correcting the title its own work has outgrown. With
 * one it is whichever card the board shows under that pid — the reach `send`
 * has, and cheaper than a send: the name is stated in this window and no
 * message is written, where `end` pays for its `--pid` with a descent check
 * because a `close` lands as an interrupt. There is no `--caller-session-id`, because
 * identity decides something only on the self path, and there the environment
 * is the answer; beside `--pid` it would be a second spelling of the same
 * flag. Self-only was the first shape, and the wire never enforced it
 * (2026-08-18).
 *
 * **A busy target is the shape the self path always has**, and it is fine.
 * The session is running a tool when it calls this. `stateName` states the
 * name and republishes before it returns, so exit 0 means the card is already
 * wearing it. The CLI is told only where its brand has a door that is not a
 * message (Codex, `thread/name/set`). A brand that never echoes the rename
 * back (Codex, measured 2026-09-05) changes nothing about the card.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-rename.js`, which the extension
 * copies to `~/.squadron/bin/squadron-rename` — one self-contained file, for
 * the reason `spawn.ts` says.
 *
 * Exit codes, the same table as its two siblings, and every row is one `main`
 * can emit:
 *   0  the window took it; the card follows one poll later
 *   1  bad usage — including a title with nothing in it
 *   2  refused: by this command, or by the window that answered
 *   3  no live IDE window to ask
 *   4  the window was asked and never answered
 *   5  this command could not ask: a request that would not write, or an error
 *      nothing here expected
 *
 * A request that would not write used to be a 2 here and a 3 in `spawn.ts` —
 * one condition, two codes, under one documented table (2026-08-18). It is
 * neither: nobody refused it and a window was found.
 */

import * as gate from './gate';
import * as help from './help';
import { Session } from '../core/model';
import { ask, askExit } from '../core/coordination/ask';
import { sessionName } from '../core/coordination/spawn';
import * as sessionTarget from '../core/session_target';
import { displayName } from '../ui/views';
import { Flags, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard, targetRefusal } from './board';
import * as inputFile from './input_file';

const USAGE = 'usage: squadron-rename --name <text> [--pid <n>]';

/** Every flag this takes. Neither is bare. */
export const FLAGS = ['name', 'pid'] as const;

/** `--name`, as spawn spells the same card field and `squadron-list` reports it. */
const RENAMED: Renamed<typeof FLAGS> = { title: 'name' };

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS);
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-rename: ${message}\n`);
  process.exit(code);
}

/**
 * What one invocation would rename, or why it would not. Same two failure codes
 * as `EndPlan`, meaning the same two things: 1 is "you typed it wrong", 2 is
 * "the request was well formed and the answer is no".
 */
export type RenamePlan =
  | {
      ok: true;
      target: Session;
      address: sessionTarget.SessionAddress;
      title: string;
    }
  | { ok: false; code: 1 | 2; reason: string };

/** A refusal on its own, for the two resolvers below — `end.ts`'s reason. */
type Refusal = Extract<RenamePlan, { ok: false }>;

/**
 * The whole decision, pure, so every refusal is a test rather than something to
 * reproduce against a live fleet.
 *
 * Title first, because it is the only thing the caller typed and the only
 * mistake it can fix by typing again — and the only rung that needs no board
 * read. Then the target: by pid when one was given, by identity otherwise. Then
 * whether `resolveTarget` can address that selected session.
 *
 * `sessionName` rather than a fold written here: `--name` here and at spawn
 * are the same field on the same card, and two cleaners would eventually
 * disagree about what a name is. What that buys beyond one answer is the
 * newline — a title carrying one would put whatever followed it on the wire as a
 * second command.
 */
export function renamePlan(
  opts: Options,
  sessions: readonly Session[],
  callerId: string | undefined,
  context: sessionTarget.TargetContext = {}
): RenamePlan {
  if (opts.name === undefined) {
    return { ok: false, code: 1, reason: `a rename needs a --name\n${USAGE}` };
  }
  const title = sessionName(opts.name);
  if (title === undefined) {
    return { ok: false, code: 1, reason: `--name has nothing in it\n${USAGE}` };
  }

  const target = opts.pid === undefined ? ownCard(sessions, callerId) : byPid(opts.pid, sessions);
  if ('ok' in target) {
    return target;
  }
  const resolved = sessionTarget.resolveTarget(target, context);
  if (!resolved.ok) {
    return {
      ok: false,
      code: 2,
      reason: targetRefusal(resolved.reason, displayName(target), 'rename')
    };
  }
  return { ok: true, target: resolved.session, address: resolved.address, title };
}

/** `--pid` given: any card on the board, the way `send` addresses one. */
function byPid(raw: string, sessions: readonly Session[]): Session | Refusal {
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 1, reason: `--pid takes a process id\n${USAGE}` };
  }
  const target = sessions.find((s) => s.pid === pid);
  if (target === undefined) {
    return { ok: false, code: 2, reason: `no session on the board has pid ${pid}` };
  }
  return target;
}

/** No `--pid`: the caller's own card, found by the id the CLI planted. */
function ownCard(sessions: readonly Session[], callerId: string | undefined): Session | Refusal {
  if (!callerId) {
    return {
      ok: false,
      code: 2,
      reason: 'cannot tell which session is asking; nothing here names one — pass --pid'
    };
  }
  // Two live sessions on one id are refused rather than guessed at, for
  // `selectTarget`'s reason in `end_plan.ts`; `--pid` is the disambiguator.
  const matches = sessions.filter((s) => s.sessionId === callerId);
  const target = matches[0];
  if (target === undefined) {
    return {
      ok: false,
      code: 2,
      reason: `${callerId} is not a session on the board, so it has no card to name`
    };
  }
  if (matches.length > 1) {
    const pids = matches.map((s) => s.pid).join(', ');
    return {
      ok: false,
      code: 2,
      reason:
        `${matches.length} live sessions share ${callerId}, so which card is yours ` +
        `cannot be told from here — name one by --pid (${pids})`
    };
  }
  return target;
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-rename');
  if (help.show('rename', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('rename');

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  const plan = renamePlan(opts, board.sessions, ownSessionId(process.env), board);
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }

  const result = await ask({
    kind: 'rename',
    ...plan.address,
    title: plan.title
  });
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
  // Said as a rename that has been *taken*, not one that is done: the frame
  // is queued behind whatever turn is running — this one, on the self path —
  // and the card follows the session file one poll after that. It is also
  // where the caller sees what the title was cut to.
  const who =
    opts.pid === undefined
      ? 'this session'
      : `${displayName(plan.target)} (pid ${plan.target.pid})`;
  process.stdout.write(`renaming ${who} to ${plan.title}\n`);
}

// Only when run, so the tests can import the decision above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
