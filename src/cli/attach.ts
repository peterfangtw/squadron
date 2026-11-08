/**
 * Squadron: send the user a file — an image, an HTML page, a log — into the
 * conversation they have with this session on their phone (its root's, for a
 * child), from inside the session (M3, D12).
 *
 * **Your own conversation, always.** No `--pid`: a flag naming another session
 * would let one session post into another's conversation. No `--caller-session-id`
 * either, for `rename.ts`'s reason — on the self path the environment is the
 * answer, and a flag beside it is a second spelling of the same fact.
 *
 * **This posts a request to the Remote holder, and never touches a token.**
 * The holder is the one window that holds the messenger's credentials (D37),
 * so it is the window asked, whichever window drives this session; the
 * session's own window and pipe are not involved. The holder reads the file,
 * checks it again and uploads it (`core/remote/serve_attach.ts`). Both halves
 * check, as with `send`: here so an agent gets a precise refusal before a
 * request is written, there because a raw request file reaches the holder
 * without this and its answer is the one that counts.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-attach.js`, which the extension
 * copies to `~/.squadron/bin/squadron-attach`.
 *
 * Exit codes, spawn's table, every row reachable:
 *   0  posted
 *   1  bad usage — the arguments, and only the arguments: an unknown flag, no
 *      `--file-path`, a caption over the limit or with control characters
 *   2  refused — Orchestration off (`gate.ts`), by this command (a missing
 *      file is a 2: a fact about the machine, not a typo) or by the holder,
 *      its reason passed through
 *   3  no live IDE window
 *   4  the outcome is unknown: the holder took the request and never answered,
 *      or answered that the upload failed after the messenger may have taken it
 *   5  this command could not ask: a request that would not write, or an error
 *      nothing here expected
 */

import * as gate from './gate';
import * as help from './help';
import * as path from 'path';
import * as sessionTarget from '../core/session_target';
import { readHolder, type Holder } from '../core/remote/holder';
import { ask, askExit, type AskResult } from '../core/coordination/ask';
import { REPLY_MS, requestIdOf, type RequestBody } from '../core/coordination/requests';
import type { Session } from '../core/model';
import { NEVER_SENT_DIRS } from '../core/paths';
import * as rules from '../core/remote/attach';
import { scanProcesses } from '../core/scan';
import { displayName } from '../ui/views';
import { Flags, ownPid, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard } from './board';
import * as inputFile from './input_file';

const USAGE = 'usage: squadron-attach --file-path <path> [--caption <text>]';

/** Every flag this takes. Neither is bare. */
export const FLAGS = ['file-path', 'caption'] as const;

/** `--file-path`, so a path is never mistaken for `squadron-fetch-file`'s `--file-id`. */
const RENAMED: Renamed<typeof FLAGS> = { file: 'file-path' };

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS);
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-attach: ${message}\n`);
  process.exit(code);
}

type AttachBody = Extract<RequestBody, { kind: 'attach' }>;

/** What one invocation would post, or why it would not. */
export type AttachPlan =
  | { ok: true; body: AttachBody; name: string; size: number }
  | { ok: false; code: 1 | 2; reason: string };

type Refusal = Extract<AttachPlan, { ok: false }>;

/** What the caller's CLI planted for its shell tools, every brand's way. */
export type CallerIds = { sessionId?: string; pid?: number };

export function callerIds(env: NodeJS.ProcessEnv): CallerIds {
  const sessionId = ownSessionId(env);
  const pid = ownPid(env);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(pid === undefined ? {} : { pid })
  };
}

/**
 * The whole decision, pure; `readPlan` does every read beforehand. Arguments, then
 * identity, then whether Remote can see the caller at all, then whether Remote
 * is on, then the file — `endPlan`'s order: what the caller typed, who it is,
 * what it names.
 */
export function attachPlan(
  opts: Options,
  sessions: readonly Session[],
  ids: CallerIds,
  holder: Holder | undefined,
  file: rules.Inspected | rules.Refused | undefined,
  area: rules.Area,
  context: sessionTarget.TargetContext = {}
): AttachPlan {
  if (opts['file-path'] === undefined || file === undefined) {
    return { ok: false, code: 1, reason: `an attach needs a --file-path\n${USAGE}` };
  }
  const caption = rules.checkCaption(opts.caption);
  if (!caption.ok) return { ok: false, code: 1, reason: `${caption.reason}\n${USAGE}` };

  const caller = callerOf(sessions, ids);
  if ('ok' in caller) return caller;
  const resolved = sessionTarget.resolveTarget(caller, context);
  if (!resolved.ok) {
    const name = displayName(caller);
    const reason =
      resolved.reason === 'background'
        ? `${name} is a background session the CLI's own daemon runs; Remote cannot see it`
        : resolved.reason === 'unpublished'
          ? `no window publishes a pipe for ${name}, so Remote cannot see it`
          : resolved.reason === 'owner-missing'
            ? `no window claims ${name}`
            : resolved.reason === 'exited'
              ? `${name} has exited, so Remote cannot see it`
              : `${name} has invalid control facts, so Remote cannot see it`;
    return { ok: false, code: 2, reason };
  }
  if (holder === undefined) {
    return {
      ok: false,
      code: 2,
      reason: 'Remote is off, so there is no conversation to send to.'
    };
  }

  if (!file.ok) return { ok: false, code: 2, reason: file.reason };
  const allowed = rules.checkPath(file, area.roots, area.deny);
  if (!allowed.ok) return { ok: false, code: 2, reason: allowed.reason };

  return {
    ok: true,
    body: {
      kind: 'attach',
      windowId: holder.windowId,
      pid: resolved.address.pid,
      startedAt: resolved.address.startedAt,
      sessionWindowId: resolved.address.windowId,
      path: file.given,
      ...(caption.caption === undefined ? {} : { caption: caption.caption }),
      from: caller.sessionId
    },
    name: path.basename(file.given),
    size: file.size
  };
}

/**
 * The caller's own row, found by the id its CLI planted. Exported because
 * `main` needs the row's cwd for the roots before it can plan.
 *
 * Two live sessions on one id (a resumed conversation) are told apart by the
 * pid the CLI planted when it names one of them. That tie-break is this verb's:
 * `rename.ts` refuses every tie and points at `--pid`, which this verb does not
 * take. Only Claude plants a pid, so for Grok and Codex the tie is refused.
 */
export function callerOf(sessions: readonly Session[], ids: CallerIds): Session | Refusal {
  const id = ids.sessionId;
  if (id === undefined) {
    return {
      ok: false,
      code: 2,
      reason: 'cannot tell which session is asking; nothing in this environment names one'
    };
  }
  const matches = sessions.filter((s) => s.sessionId === id);
  const only = matches.length === 1 ? matches[0] : matches.find((s) => s.pid === ids.pid);
  if (only !== undefined) return only;
  if (matches.length === 0) {
    return {
      ok: false,
      code: 2,
      reason: `${id} is not a session any window drives, so it has no conversation to send to`
    };
  }
  const pids = matches.map((s) => s.pid).join(', ');
  return {
    ok: false,
    code: 2,
    reason:
      `${matches.length} live sessions share ${id} (${pids}), so which one is asking ` +
      'cannot be told from here'
  };
}

/** The line the caller reads on success; exported for `landed`'s reason in
 *  `send.ts`, so the sentence is a test. */
export function attached(name: string, size: number): string {
  return `sent ${name} (${rules.sizeOf(size)}) to this session's conversation\n`;
}

const MAY_HAVE_POSTED = 'The file may have been posted, and sending it again may post it twice.';

/** What a failed ask exits with, and the line it prints. */
export function failure(result: Extract<AskResult, { ok: false }>): {
  code: number;
  reason: string;
} {
  // No record is kept to check against, unlike `send`: a second copy in the
  // owner's own thread costs one message, and a store for that alone costs
  // more.
  if (result.kind === 'silent') {
    return {
      code: askExit(result),
      reason:
        `the window holding Remote did not answer request ${requestIdOf(result.file)} within ` +
        `${REPLY_MS.attach / 1000} s. ${MAY_HAVE_POSTED}`
    };
  }
  if (result.kind === 'refused' && result.reply.unsure) {
    return { code: askExit(result), reason: `${result.reason}. ${MAY_HAVE_POSTED}` };
  }
  return {
    code: askExit(result),
    reason: result.kind === 'refused' ? (result.reply.reason ?? 'refused') : result.reason
  };
}

/**
 * `attachPlan` over this machine as the shim reads it: the caller planted in
 * `env`, the holder, the file as given from `cwd`, and its area.
 */
export async function readPlan(
  opts: Options,
  sessions: readonly Session[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  context: sessionTarget.TargetContext = {}
): Promise<AttachPlan> {
  const ids = callerIds(env);
  const holder = await readHolder(await scanProcesses());
  const caller = callerOf(sessions, ids);
  const [file, roots] = await Promise.all([
    opts['file-path'] === undefined ? undefined : rules.inspectFile(opts['file-path'], cwd),
    'ok' in caller ? [] : rules.attachRoots(caller.cwd)
  ]);
  const deny = await rules.attachDeny(roots, NEVER_SENT_DIRS);
  return attachPlan(opts, sessions, ids, holder, file, { roots, deny }, context);
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-attach');
  if (help.show('attach', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) die(1, usageFor(argv, USAGE, RENAMED));
  await gate.refuseUnlessOn('attach');

  const board = await loadBoard();
  if (!board.ok) die(board.code, board.reason);

  const plan = await readPlan(opts, board.sessions, process.env, process.cwd(), board);
  if (!plan.ok) die(plan.code, plan.reason);

  const result = await ask(plan.body);
  if (!result.ok) {
    const failed = failure(result);
    die(failed.code, failed.reason);
  }
  process.stdout.write(attached(plan.name, plan.size));
}

// Only when run, so the tests can import the decision above.
if (require.main === module) {
  main().catch((error: unknown) => die(5, error instanceof Error ? error.message : String(error)));
}
