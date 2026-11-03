/**
 * Squadron: what is running, from inside a session.
 *
 * The half `spawn` and `end` assumed. A session could start a peer and end
 * one, and could not see one — so a fan-out was addressable only by a human
 * reading the board and retyping a pid, which is the relay these verbs exist to
 * kill.
 *
 * **It reads the panel's own derived state rather than the disk.** `toCard` is
 * `vscode`-free and tested, and a shim imports it exactly as the panel does.
 * Deriving session state a second time inside a CLI is how a board comes to
 * say `waiting` while a command says `idle`, and an orchestrator then sends
 * into a blocked dialog.
 *
 * **It asks no window.** Everything here is on disk — the claims, the CLIs' own
 * session files, the published records — so there is no request, no reply, and
 * no exit 4. A window that has gone silent cannot make this wrong; it can only
 * make it old, which the sessions it published say for themselves.
 *
 * Brand-neutral output on purpose: no row names a CLI. A caller choosing what
 * to do with a session should be choosing on what the session *is* — idle,
 * deep in its context, in this directory — and a brand word invites a branch
 * this whole seam exists to prevent.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-list.js`, which the extension
 * copies to `~/.squadron/bin/squadron-list`.
 *
 * Exit codes, spawn's table less the two nothing here can reach:
 *   0  printed — including the empty board, which is an answer
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused: `--mine` with no caller to descend from
 *   3  no live IDE window to read claims from
 *   5  an error nothing here expected
 */

import * as help from './help';
import * as fs from 'fs/promises';
import { isQuestion, type PendingRequest } from '../core/live';
import { Session, WindowClaim } from '../core/model';
import { WaitRecord, readWaits } from '../core/coordination/wait';
import type { PublishedLive } from '../core/published';
import { closeDescendants } from '../ui/closing';
import { toCard } from '../ui/views';
import { Flags, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard, openRequests } from './board';
import * as inputFile from './input_file';

const USAGE = 'usage: squadron-list [--mine] [--caller-session-id <sessionId>]';

export const FLAGS = ['caller-session-id', 'mine'] as const;
const BARE = ['mine'] as const;

/** `--caller-session-id`: the flag says which of a session's ids it takes. */
const RENAMED: Renamed<typeof FLAGS> = { caller: 'caller-session-id' };

export type Options = Flags<typeof FLAGS>;

export function parseArgs(argv: readonly string[]): Options | undefined {
  return parseFlags(argv, FLAGS, BARE);
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-list: ${message}\n`);
  process.exit(code);
}

/**
 * One session, as a caller deciding what to do with it needs it.
 *
 * `pid` is the address every other verb takes, and the only identifier that
 * neither moves nor repeats. `sessionId` is here beside it because it is what
 * `--caller-session-id` and `--parent-session-id` take, and it is *not* interchangeable: `/clear`
 * moves a card to a new one, and a resumed conversation puts two cards on the
 * same one.
 *
 * `transcript` is the one field that is not about addressing the session at
 * all. It is how a caller reads what a peer has been doing without waking it —
 * the cheap half of orchestration, and the one that costs the peer nothing.
 */
export type Row = {
  pid: number;
  name: string;
  cwd: string;
  status: string;
  /** How full the session's context is, when anything has said. Absent is
   *  common and does not mean empty — see `checkSend`. */
  contextPct?: number;
  /** A command is still running in it: `idle` wearing `done`'s face. */
  hasCommand?: true;
  /** It is being ended. Only the window doing it knows, so this is absent
   *  more often than it is false. */
  closing?: true;
  /** Its own step list, idle sessions only — a list is a statement about work
   *  that has stopped. */
  completion?: { total: number; completed: number };
  sessionId?: string;
  transcript?: string;
  /**
   * Which IDE window is running it.
   *
   * Here since row 71, and for the reader rather than for the caller. A panel
   * draws only its own window's sessions now, while this still lists the
   * machine — so an agent reporting "I messaged pid 4231" can be naming a card
   * the person reading has no board for. The window is the coordinate that
   * makes the two accounts line up.
   *
   * The window's own label, as it wrote it on its claim — the same string
   * `squadron-spawn` prints, so the two verbs name one window one way.
   *
   * Absent for a session no claim attributes: a `claude` typed in Terminal.app,
   * or one under a tmux server the ancestry walk cannot climb to a claimed
   * shell — and for one whose window has since gone, whose claim is no longer
   * there to be read. Absent is "nobody can say", never "this one".
   */
  window?: string;
  /**
   * A wait this session registered whose one message could not be delivered,
   * and why.
   *
   * The one thing on a row that is **not** about the session it names: it is
   * about something that was owed to it, and could not be handed over.
   * `WaitRecord.failed` has why one exists.
   */
  waitFailed?: string;
  /**
   * What the session is blocked on, oldest first — what `squadron-answer`
   * answers, in Squadron's own format whichever CLI asked. The options are
   * what the asker offered; an answer is prose and need not be one of them.
   * Absent when nothing is open. A `permission` is listed so the caller knows
   * to pass it to a person: no session may grant one.
   */
  asking?: Asking[];
};

/** One open request on a `Row`. `requestId` is what `--request-id` takes. */
export type Asking =
  | {
      requestId: string;
      kind: 'question';
      label?: string;
      questions: {
        question: string;
        header?: string;
        multiSelect: boolean;
        options: { label: string; description?: string }[];
      }[];
    }
  | { requestId: string; kind: 'permission'; label?: string };

/**
 * Every session on the machine, as rows.
 *
 * **This lists more than a board draws.** A board draws the sessions its own
 * window started plus background ones; this lists the machine, because that is
 * what the agent-facing
 * verbs reach — `-send`, `-end` and `-rename` can name any pid whose window
 * serves the request, and a list that could not see those pids would be a list
 * of things the caller cannot address. Scoping it to the caller's window would
 * need the same records it would be scoped by, so it deletes nothing and adds a
 * refusal (PRD D5).
 *
 * It filters nothing: discovery already dropped every session typed at a shell
 * (each brand's `discover.ts`), and `source === 'owned'` would be wrong here — a
 * Claude session another window drives whose published record failed to land
 * is still listed off its `sdk-cli` twin.
 *
 * `sessionId` and `transcript` come off the `Session` rather than the card:
 * they are addressing and reading, and a card is what a reader looks at.
 */
export function listRows(
  sessions: readonly Session[],
  waits: readonly WaitRecord[] = [],
  windows: ReadonlyMap<string, string> = new Map(),
  published: ReadonlyMap<number, PublishedLive> = new Map()
): Row[] {
  return sessions.map((s) => rowOf(s, waits, windows, published));
}

/** `windowId` -> the label that window put on its claim, for the `window` field.
 *  A claim with no label falls back to its id: the row is a coordinate either
 *  way, and an empty string would read as a window that does not exist. */
export function windowLabels(claims: readonly WindowClaim[]): Map<string, string> {
  return new Map(claims.map((claim) => [claim.id, claim.label || claim.id]));
}

/**
 * The refusal on this session's newest undeliverable wait, if it has one.
 *
 * Newest rather than first, because a requester whose context filled up may
 * have several and the last one is the one still true. Several reasons on one
 * row would be a list a caller has to reason about; one is a thing to act on.
 */
function waitFailure(pid: number, waits: readonly WaitRecord[]): string | undefined {
  let newest: { reason: string; at: number } | undefined;
  for (const wait of waits) {
    if (wait.requesterPid === pid && wait.failed && (!newest || wait.failed.at > newest.at)) {
      newest = wait.failed;
    }
  }
  return newest?.reason;
}

/**
 * Drops a `transcript` that is not there.
 *
 * An owned session's path is **derived** once, at launch, and the CLI can move
 * the file afterwards: `EnterWorktree` relocates it into the new cwd's slug,
 * and a conversation resumed in another directory is filed where it began
 * (`claude/transcript.ts`, `locateTranscript`). The derivation then names a
 * file that does not exist.
 *
 * Every other reader treats that field as a candidate and stats it —
 * `locateTranscript` misses, then sweeps `projects/` for the real one. This is
 * the first surface to hand it to an agent as an answer, and the skill says
 * *read it instead of asking*, so a path that 404s is instruction rather than a
 * stale field.
 *
 * Dropped rather than resolved: resolution is per-brand (`locateTranscript` is
 * Claude's, and slugs Claude's way), and a brand's spelling of anything stays
 * behind the adapter seam. Nothing is lost — the path was wrong, and no answer
 * beats a wrong one. Resolving it properly is a `locate` capability on the
 * adapter, which is more than this verb should carry.
 */
async function withReadableTranscript(rows: readonly Row[]): Promise<Row[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.transcript === undefined) {
        return row;
      }
      try {
        await fs.stat(row.transcript);
        return row;
      } catch {
        const rest: Row = { ...row };
        delete rest.transcript;
        return rest;
      }
    })
  );
}

/** A request as the answerer writes against it — `preview` and the raw input
 *  dropped, since nothing in an answer can name them. */
function asking(request: PendingRequest): Asking {
  const label = request.label === undefined ? {} : { label: request.label };
  if (!isQuestion(request)) {
    return { requestId: request.requestId, kind: 'permission', ...label };
  }
  return {
    requestId: request.requestId,
    kind: 'question',
    ...label,
    questions: request.questions.map((q) => ({
      question: q.question,
      ...(q.header === undefined ? {} : { header: q.header }),
      multiSelect: q.multiSelect,
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description === undefined ? {} : { description: o.description })
      }))
    }))
  };
}

function rowOf(
  session: Session,
  waits: readonly WaitRecord[],
  windows: ReadonlyMap<string, string>,
  published: ReadonlyMap<number, PublishedLive>
): Row {
  const card = toCard(session);
  const failed = waitFailure(session.pid, waits);
  const open = openRequests(session, published).map(asking);
  const label = session.windowId === undefined ? undefined : windows.get(session.windowId);
  return {
    pid: session.pid,
    name: card.name,
    cwd: session.cwd,
    // Four of these print as themselves rather than folding into a neighbour.
    // `unknown` is a real state — a twin whose record never landed — and
    // collapsing it into `idle` would offer a session nothing can drive.
    status: card.status,
    ...(card.contextPct !== undefined ? { contextPct: card.contextPct } : {}),
    ...(card.hasCommand ? { hasCommand: true as const } : {}),
    ...(card.closing ? { closing: true as const } : {}),
    ...(card.completion ? { completion: card.completion } : {}),
    ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    ...(session.transcript !== undefined ? { transcript: session.transcript } : {}),
    // The claim's **label**, not the raw `vscode.env.sessionId` behind it: this
    // field exists so an agent and its reader share a coordinate, and a GUID is
    // not one a person can see anywhere. Keyed off the `windowId` the fold
    // already spreads onto the session, so it costs no second read.
    ...(label !== undefined ? { window: label } : {}),
    ...(failed !== undefined ? { waitFailed: failed } : {}),
    ...(open.length ? { asking: open } : {})
  };
}

/**
 * The rows this invocation prints, or why it prints none.
 *
 * `--mine` is the caller's **descent**, not the caller: a session asking what
 * it has running wants its children, and `closeDescendants` is the same
 * function `end` and the panel's *End all* use, so the three can never
 * disagree about what is below a card.
 *
 * A caller that cannot be identified is refused rather than shown everything —
 * `--mine` that quietly means `--all` is the answer most likely to be acted on
 * wrongly.
 */
export function listPlan(
  opts: Options,
  sessions: readonly Session[],
  callerId: string | undefined,
  waits: readonly WaitRecord[] = [],
  windows: ReadonlyMap<string, string> = new Map(),
  published: ReadonlyMap<number, PublishedLive> = new Map()
): { ok: true; rows: Row[] } | { ok: false; code: 1 | 2; reason: string } {
  // `!== undefined`, never truthiness: a bare flag is stored as the empty
  // string (`cli/args.ts`), so `!opts.mine` is a `--mine` that never fires.
  if (opts.mine === undefined) {
    return { ok: true, rows: listRows(sessions, waits, windows, published) };
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
  return {
    ok: true,
    rows: listRows(closeDescendants(caller.pid, sessions), waits, windows, published)
  };
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-list');
  if (help.show('list', USAGE, argv)) return;
  const opts = parseArgs(argv);
  if (!opts) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }

  const board = await loadBoard();
  if (!board.ok) {
    die(board.code, board.reason);
  }

  const plan = listPlan(
    opts,
    board.sessions,
    opts['caller-session-id'] ?? ownSessionId(process.env),
    // One `readdir`, and on nearly every machine of an empty directory. What it
    // buys is the one failure the requester itself cannot be told about.
    await readWaits(),
    windowLabels(board.claims),
    board.published
  );
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }
  // One object per line: a caller reads it a row at a time, and a board with
  // nothing on it prints nothing at all rather than an empty array to unwrap.
  for (const row of await withReadableTranscript(plan.rows)) {
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    die(5, error instanceof Error ? error.message : String(error));
  });
}
