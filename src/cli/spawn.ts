/**
 * Squadron: start another session from inside one, and give it a task.
 *
 * A CLI agent cannot do this itself. `Task` makes a subagent, which owns no
 * session and no terminal; `claude --bg` makes a job that cannot be answered;
 * and running `claude` from a Bash tool gets no tty, so the session it starts is
 * one nothing can talk to. Creating a terminal is something only an IDE window
 * can do, so this asks one to, through the same request files the panel uses for
 * every other cross-window action.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-spawn.js`, which the extension
 * copies to `~/.squadron/bin/squadron-spawn` — one self-contained
 * file, because a shim that resolves the extension's modules at runtime breaks
 * the moment the build's layout changes, and did.
 *
 * Exit codes are the point of this script, not decoration: an agent that cannot
 * tell "refused" from "no window" cannot decide what to do next.
 *   0  the window accepted it
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused, with the window's reason on stderr
 *   3  no live window to ask
 *   4  a window was asked and never answered — see `unanswered`, which is not
 *      the same as "it did not happen"
 *   5  this command could not ask: a request that would not write, or an error
 *      nothing here expected. Distinct from 1 because it is the one case where
 *      the arguments were fine, and a model told "fix the arguments" retries a
 *      correct command against a machine that is still broken (2026-08-18).
 */

import * as gate from './gate';
import * as help from './help';
import * as path from 'path';
import {
  BRAND_CHOICES,
  BRAND_WORDS,
  Flags,
  Renamed,
  asBrand,
  ownSessionId,
  parseFlags,
  usageFor
} from './args';
import { openSession, resolveOrigin } from './open';
import { checkSpawnIdentity } from '../core/coordination/spawn';
import * as inputFile from './input_file';

const USAGE = `usage: squadron-spawn [--cwd-path <dir>] --prompt <text> [--name <text>] [--brand ${BRAND_CHOICES}] [--model-id <id>] [--context <tokens|200k|1m>] [--effort <level>] [--parent-session-id <sessionId>] [--ticket <ref>] [--workflow-id <id>]`;

function die(code: number, message: string): never {
  process.stderr.write(`squadron-spawn: ${message}\n`);
  process.exit(code);
}

/** Every flag this takes, which is what makes an unknown one an error rather
 *  than a key nobody reads. */
export const FLAGS = [
  'cwd-path',
  'prompt',
  'name',
  'brand',
  'model-id',
  'context',
  'effort',
  'parent-session-id',
  'ticket',
  'workflow-id'
] as const;

/** `--workflow-id`: the workflow's `id`, never its filename. */
const RENAMED: Renamed<typeof FLAGS> = {
  cwd: 'cwd-path',
  model: 'model-id',
  parent: 'parent-session-id',
  workflow: 'workflow-id'
};

/** What the command line said, once. */
export type Options = Flags<typeof FLAGS>;

/**
 * `--context` as tokens.
 *
 * Three spellings because a person types one and a script writes another:
 * `1m` / `1M`, `200k` / `200K`, and a bare count. **None of them is a CLI
 * spelling** — the Claude CLI has no `[200k]` and no window flag, and `[1m]` is
 * composed at the launch seam. These are ours, and they stop here.
 *
 * `undefined` for anything else, including `0` and a negative: the caller
 * reports it rather than starting a session in a window nobody named.
 */
export function parseContext(raw: string | undefined): number | undefined {
  const said = /^(\d+)(k|m)?$/.exec(raw?.trim().toLowerCase() ?? '');
  if (!said) return undefined;
  const scale = said[2] === 'm' ? 1_000_000 : said[2] === 'k' ? 1_000 : 1;
  const tokens = Number(said[1]) * scale;
  return tokens > 0 ? tokens : undefined;
}

/**
 * This command line, in the shared grammar (`cli/args.ts`). Every flag here
 * takes a value, so nothing is declared bare.
 */
export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-spawn');
  if (help.show('spawn', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('spawn');
  const cwd = path.resolve(opts['cwd-path'] ?? process.cwd());
  const prompt = opts.prompt;
  const parentSessionId = opts['parent-session-id'] ?? ownSessionId(process.env);
  const originSessionId = resolveOrigin(opts, process.env);
  if (opts.brand !== undefined && opts.brand !== '' && asBrand(opts.brand) === undefined) {
    die(1, `--brand must be ${BRAND_WORDS}\n${USAGE}`);
  }
  const brand = asBrand(opts.brand);
  // Parsed to tokens once, here, so nothing below this line has to know that
  // `1m` and `1000000` are the same thing. `core/coordination/spawn.ts` sees a number.
  const context = parseContext(opts.context);
  if (opts.context !== undefined && opts.context !== '' && context === undefined) {
    die(1, `--context must be a token count, or 200k, or 1m\n${USAGE}`);
  }
  if (context !== undefined && !opts['model-id']?.trim()) {
    // The same rule `--model` has against `--brand`, one level down: a window
    // names nothing on its own, and a child cannot be started in "200k" of
    // whatever model it happened to inherit.
    die(1, `--context needs --model-id\n${USAGE}`);
  }
  const identity = checkSpawnIdentity({ brand, model: opts['model-id'], window: context });
  if (!identity.ok) {
    die(1, `${identity.reason}\n${USAGE}`);
  }
  if (prompt === undefined) {
    die(1, `a --prompt is required; without one this is just the panel’s + button\n${USAGE}`);
  }

  const opened = await openSession({
    cwd,
    prompt,
    name: opts.name,
    parentSessionId,
    originSessionId,
    from: ownSessionId(process.env),
    ticketRef: opts.ticket,
    workflowId: opts['workflow-id'],
    brand,
    model: opts['model-id']?.trim() || undefined,
    ...(context === undefined ? {} : { window: context }),
    effort: opts.effort?.trim() || undefined
  });
  if (!opened.ok) {
    die(opened.code, opened.reason);
  }
  // The pid, because it is the handle `squadron-end` takes and this is the
  // only moment the caller could learn it — `startOwned` already returns it and
  // this line used to drop it, leaving a parent able to start a session it had
  // no way to name afterwards. Omitted when the answering window is old enough
  // not to say, rather than printed as `undefined`.
  const where = `in ${cwd}${opened.pid === undefined ? '' : ` as pid ${opened.pid}`}`;
  process.stdout.write(`started a session ${where} (window: ${opened.windowLabel})\n`);
}

// Only when run, so the tests can import the decisions above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
