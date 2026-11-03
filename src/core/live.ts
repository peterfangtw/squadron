/**
 * The product card of an owned session: `LiveState`, the outbox, `toSession`.
 *
 * Claude frames reduce through `core/claude/reduce.ts`; Grok maps through
 * `core/grok/reduce.ts` then `applyEvent` here. Both land on this shape. The whole of the last month's bugs were about state inferred
 * from files that lag. Frames in, state out, no clock and no disk — so every
 * rule below is a test rather than a thing to watch happen in the IDE.
 *
 * **It starts before any frame exists.** A session spawned with no prompt is
 * the normal case, and the CLI says nothing at all until its first turn — even
 * `init` follows the first user message rather than the spawn. So the initial
 * state is built out of the spawn arguments, and every consumer must be able to
 * render a session with no `sessionId`, no model and no transcript.
 */

import * as cacheTtl from './cache_ttl';
import * as warm from './warm';
import * as messageFacts from './message_facts';
import * as path from 'path';
import type { ConnectOptions, SessionHandle } from './adapter';
import type { ExitSource, SessionEvent, TurnOutcome } from './events';
import { contextPercent } from './catalog';
import { mergeReadings, stampWindows } from './limits';
import { bestName, sourceOf } from './naming';
import {
  BrandId,
  ImageBlock,
  PermissionSuggestion,
  RateLimits,
  SendTarget,
  Session,
  SessionStatus,
  WindowReach,
  WarmTurn
} from './model';
import { shiftImageMarkers, withoutImageMarkers } from './markers';
import { delivered } from './coordination/send';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from './warm_policy';

/** One message inside a merged row, as it was held. */
export type QueuedPart = { id: string; text: string; images?: ImageBlock[]; correlation?: string };

/** What a row says, as the wire and the record read it. */
export type QueuedContent = Pick<QueuedMessage, 'text' | 'images' | 'parts'>;

/**
 * One message the panel is holding for an owned session, not yet written to the
 * pipe. The outbox is ours: nothing on the wire announces a queue, and under a
 * held drain the CLI never sees a message until we write it.
 */
export type QueuedMessage = {
  id: string;
  correlation?: string;
  text: string;
  /**
   * Keep each merged message's original id, words and images. segments sends
   * separate blocks so authors remain legible; unwrapMessage refuses text with two wrappers.
   */
  parts?: QueuedPart[];
  /** Inline image blocks, same shape `userMessage` takes. Absent when plain. */
  images?: ImageBlock[];
  /** Epoch ms when the reader submitted it. */
  queuedAt: number;
  /** Keep the send-time pick with a held message; do not re-read it at drain time. */
  target?: SendTarget;
  /**
   * What to name the session after, when that is not the text being sent. Only
   * `firstPrompt` reads it — the CLI is written the `text` either way.
   *
   * The one case is a mentioned workflow: what goes on the wire opens with a
   * path and an instruction to read it, and a title generated from that names
   * the machinery instead of the work ("Execute workflow"). The description is
   * the titler's only input (`docs/reference/cli_state/claude/transcript.md`), so the fix
   * is to hand it a different one, not to send something else.
   */
  describe?: string;
  /**
   * A message the CLI must read as a *command*, not as prose.
   *
   * Two rules follow from it, both below: it never merges with a neighbour —
   * the CLI expands one command at the start of a message, so a merged one is
   * text the session reads rather than a verb it runs — and it never names the
   * session, since `/effort high` is a thing done to the turn and not the
   * first thing anybody asked it.
   *
   * The one writer is `OwnedSession.send`, ahead of a targeted send. It is
   * here rather than sniffed from a leading `/` because a reader may
   * legitimately type one: a session told `/clear the table` means the table.
   */
  command?: true;
  /**
   * A cache-warming ping, written by `warmDrain` and never held. The mark is
   * what keeps the dock from drawing the row as the reader's own echo.
   */
  warm?: true;
};

export type { WarmTurn } from './model';

/** A question or permission request; the adapter decides which RPC produced it. */
export type PendingRequest = {
  requestId: string;
  toolName: string;
  /** The call this request is about, as the CLI's own `tool_use.id`. Absent for
   *  a request that named none. It is what an answered ask is filed under in our
   *  record, since nothing on the pipe carries `toolUseResult`. */
  toolUseId?: string;
  /** A question for the reader, not a permission prompt. */
  ask: boolean;
  /** The ask's questions, parsed. Empty for a permission prompt. */
  questions?: PendingQuestion[];
  /** The CLI's own short label for the call: `notes.txt`, `Write hi to out.txt`. */
  label?: string;
  /** The tool's input, verbatim — shown to the reader, and echoed back on an
   *  allow, which is why the raw record is kept rather than a rendering of it. */
  input?: Record<string, unknown>;
  suggestions?: PermissionSuggestion[];
  /** Absent = offered. `false` hides Add a note / Reply instead. */
  canNote?: boolean;
  canReply?: boolean;
  /** Absent = offered. `false` means this CLI's permission response cannot
   *  carry the optional denial reason the product otherwise collects. */
  canDenyReason?: boolean;
};

/**
 * Unparsed asks become permission prompts so the reader can still answer.
 * No session may answer an unparsed ask in the reader's place.
 */
export function isQuestion<T extends Pick<PendingRequest, 'ask' | 'questions'>>(
  request: T
): request is T & { questions: PendingQuestion[] } {
  return request.ask && !!request.questions?.length;
}

export type LiveState = {
  /** Known from the spawn, and restated by every `init`. */
  cwd: string;
  /**
   * Where this conversation *began* — pinned at the first `init` for a session
   * id and never moved after, exactly as `transcript` is.
   *
   * It is the card's group, and `cwd` above is only the live reading the branch
   * is taken from. The two differ the moment a session `cd`s or enters a
   * worktree, and the difference is load-bearing: what tells a monorepo package
   * apart from a directory a session merely walked into is not the path shape,
   * which is identical, but which of them the conversation started in.
   *
   * **The point is that nothing on disk is consulted for it.** This used to be
   * recovered by finding the transcript and reading its head
   * (`locateTranscript`'s `home`), a lookup keyed on a cwd that moves — four
   * fixes were paid for it, and the CLI files the transcript one way for a `cd`
   * and the opposite way for an `EnterWorktree`. The first `init` states the
   * answer on the wire, for free, before anything can move.
   */
  originCwd?: string;
  startedAt: number;
  status: SessionStatus;
  sessionId?: string;
  /**
   * The caller supplies a known transcript; otherwise the brand sets its path
   * when the CLI names the session. Do not slug a cwd here.
   */
  transcript?: string;
  /**
   * The session's name, once the CLI has written one for it.
   *
   * Nothing pushes this either: a print-mode session is never titled of its own
   * accord — the titler runs off the interactive UI, like the status writer —
   * so the only way one gets a name is a client asking for it. That is
   * `generate_session_title`, and this is what came back.
   */
  title?: string;
  /**
   * What a person or an agent said this session is **called** — a statement,
   * where `title` above is a reading.
   *
   * The same distinction `modelPick` draws against `model`, and it is here for
   * the same reason: the statement is true the moment it is made, and whether
   * the CLI ever agrees is that CLI's business. Grok has no rename door at all
   * and Codex has one whose echo has been observed not to arrive, so a card that
   * waited for a reading would wait forever on two brands out of three.
   *
   * Set at the moment the rename is taken (`host/sessions.ts`, `stateName`), so
   * the owning window repaints on the next publish without a round trip. What
   * survives the window is the store — `core/names.ts` — and the two carry the
   * same statement rather than two sources of truth.
   *
   * **Kept across `conversation_reset`.** `cleared` drops `title` because the
   * guess was about a conversation that is gone; this is not a guess, and the
   * CLI keeps its own name across a `/clear` too (2.1.258, protocol.md).
   */
  stated?: string;
  /** Keep the first prompt for title generation after its turn has left the pipe. */
  firstPrompt?: string;
  /** What the CLI last said this session runs on, in whichever of its
   *  spellings — `init` resolves an alias and keeps a context suffix, the
   *  `message_start` behind it drops that suffix. A reading, never a row. */
  model?: string;
  /** The reasoning effort the live protocol last stated, or the launch line's
   *  until it does — Claude's pipe never states one, so without the seed a
   *  fresh card read no effort until its transcript's first assistant entry. */
  effort?: string;
  /**
   * The alias *this panel* put the session on: what `--model` was given at the
   * spawn, and what the last `set_model` sent. Never a reading — nothing on the
   * wire restates it, and the CLI answers in its own spelling either way.
   *
   * Two reasons it is kept rather than derived. A promptless session says
   * nothing at all until somebody types (`init` follows the first message), so
   * this is the only statement of what it will run on for as long as that
   * takes. And a reading with its suffix dropped belongs to two rows at once —
   * `claude-opus-5` is Opus and the 1M Opus both — which only the alias tells
   * apart. `model_names.resolveModel` is where the two meet.
   */
  modelPick?: string;
  /**
   * The context window this launch **asked for**, in tokens.
   *
   * Set once, at `initial`, from what went on the launch line — and it is the
   * only statement of it that exists, because the CLI never reports what was
   * requested. A session that asked for nothing has none, which is every
   * session started before this shipped.
   */
  windowAsked?: number;
  /**
   * The context window the wire has **stated**, in tokens — from
   * `result.modelUsage[…].contextWindow`, keyed by this session's own model.
   *
   * Two fields rather than one `{ tokens, source }` object, deliberately: with
   * one field plus a tag, `source: 'stated'` with nothing to have stated it, or
   * a `tokens` agreeing with neither half, are states the type permits and
   * nothing rejects. Two optional numbers cannot disagree with themselves — the
   * effective window is `windowStated ?? windowAsked`, and the mismatch worth
   * telling a reader about is simply the two being present and different.
   *
   * Why they can disagree at all: `CatalogWindow.reach`.
   */
  windowStated?: number;
  /**
   * Launch reach stays fixed at initial; see core/model.ts WindowReach.
   * reachableFrom and the learn guard read it, not the current pick's reach (see setModel).
   * Absent means an unseen launch line. Our starts use plain when no window was named
   * for the reason in host/sessions.ts.
   */
  launchReach?: WindowReach;
  /** The brand's own word for what this session may do unasked, and for Codex
   *  two of them joined (`core/codex/permissions.ts`). Nothing above the seam
   *  reads it apart from `CliAdapter.permissionView`, which is what turns it
   *  into the strip's one word. */
  permissionMode?: string;
  /** The account's plan usage, window by window as last observed: a
   *  `get_usage` round trip, or a quota push where the CLI sends one. */
  usage?: RateLimits;
  /** Epoch seconds, from `rate_limit_event`'s own `resetsAt` — the five-hour
   *  window's reset. The event's quota, when it has one, lands in `usage`. */
  limitResetsAt?: number;
  contextPct?: number;
  contextTokens?: number;
  /** The tool a `content_block_start` opened, until the turn ends. */
  activeTool?: string;
  /**
   * Our outbox, oldest first. Write only while idle with no open request, and
   * retire on our write, not init; see PRD_shipped_message_queue.md.
   */
  queued: QueuedMessage[];
  messageFacts?: readonly messageFacts.MessageFact[];
  /** Internal finality survives eviction from the published fact history. */
  messageFinality?: readonly messageFacts.MessageTerminalFact[];
  /** Retained across an unclassified close, superseded by the next written prompt. */
  messageTurn?: readonly string[];
  /**
   * The head we last wrote to the pipe, kept until the turn it started ends.
   * A held message leaves `queued` the instant we write it and the CLI's own
   * copy is a poll away, so for that beat this is the only record the dock can
   * draw it from.
   *
   * `endTurn` is the bound, rather than the words arriving — that is
   * `ui/views.ts`'s question, and a transcript read as a tail can lose them
   * entirely, leaving an echo with no deadline standing for the whole session.
   */
  inFlight?: QueuedMessage;
  /** Every open request, oldest first. Plural because `initialize` carries
   *  `pending_permission_requests` as a list; a client that renders only the
   *  first would leave a session blocked on one nobody can see. */
  pending: PendingRequest[];
  /** A turn is running: set by the first frame of one, cleared by its `result`
   *  or by the CLI saying so on `session_state_changed`. The reducer's own
   *  memory, and the reason `status` can tell a session waiting mid-turn from
   *  one idle at its prompt. */
  running: boolean;
  /**
   * How the last turn ended, when the CLI said so. Off the turn-end frame at
   * the moment `running` drops, never off disk ("Status is live, never disk",
   * `src/AGENTS.md`).
   *
   * Written only by `endTurn` with a stated outcome, and kept through every
   * close that states none — Claude's `idle` behind its `result`, an exit, a
   * status to `unknown`. Cleared by `inTurn` outside a warm turn, by `dequeueHead` (a written
   * prompt), by a `/clear`, and never seeded: a resumed session starts without
   * one. Pending requests, echoes and a mid-turn retry leave it alone.
   */
  lastOutcome?: TurnOutcome;
  /**
   * Turns that ended as finishes: a running turn, not a warm ping, closed by
   * the CLI. Counted once each, so two observations of a session that ended a
   * turn and drained a held reply at once — busy on both — still differ.
   *
   * An exit and a status to `unknown` close a turn without counting it: an End
   * or a crash mid-turn is not a finish, nor a local command's answer
   * (`counted`). Codex's `systemError` is the one `unknown` that a stated
   * outcome follows, so `uncounted` holds that turn open to the count until
   * the next one begins.
   */
  turnsEnded: number;
  /**
   * How the turn `turnsEnded` last counted ended, if a close said so; absent is
   * "ended, nobody said how". Written only by `endTurn`, by a count and by a
   * later close of the same turn that states one — never cleared by a turn
   * beginning, a written prompt or a `/clear`, as `lastOutcome` is, because a
   * reader comparing counts reads it after the next turn may have begun.
   */
  endedOutcome?: TurnOutcome;
  /** A running turn an `unknown` closed, still to be counted if a stated
   *  outcome for it arrives before the next turn begins. */
  uncounted?: true;
  /** The child is gone. A card says so rather than disappearing. */
  exit?: { code: number | null; signal: string | null };
  /**
   * Why this session was last put on `unknown`, for the log and nothing else.
   *
   * Two unrelated things spell that word and the board draws one card for both:
   * a latched exit, which names the transport ending that latched it, and a
   * brand stating `unknown` on the wire with no exit at all. Measured
   * 2026-09-09 while chasing a card found unknown beside a live process and an
   * intact pipe: nothing on disk recorded either, so it could not be
   * attributed.
   *
   * **The last reason, never cleared** — a session that comes back reads
   * `busy` with this still set. Read it on the edge into `unknown` or not at
   * all; nothing draws it and nothing branches on it.
   */
  unknownFrom?: string;
  /** A cache-warming ping and its outcome, until real work supersedes it. */
  warmTurn?: WarmTurn;
};

/**
 * The state a session has the moment its child exists, and until it speaks.
 *
 * `sessionId` is whatever the caller already knows — a resume the reader
 * chose, or a mint. It is not "a resume": `startOwned` passes
 * `sessionId: start.resume ?? fresh` to every brand, and a Grok mint is
 * not a load. Claude's `--session-id` takes the mint; Grok's does not.
 *
 * `transcript` is a separate fact. The caller hands it when it knows the
 * file (a Claude id, a Grok resume); a sessionId with no path leaves the
 * field unset, which is how a Grok new sits until `session/new` names the
 * CLI's id. Nothing in this function slugs a cwd.
 *
 * Stating the id (and the path, when there is one) is what puts the old
 * turns in the dock at once. A promptless session says nothing until
 * somebody types — `init` follows the first user message, not the spawn —
 * so a resumed card would otherwise sit over its own history reading
 * "No conversation found" until it was messaged. The `init` that
 * eventually arrives restates the same id, which `reduce` reads as the
 * id it already had and leaves the transcript alone.
 *
 * `model` is the same shape of fact for the same reason: the flag was passed,
 * the session is on it, and nothing on the pipe will say so until somebody
 * types. It lands in `modelPick`, never in `model`. Effort and window are the
 * rest of that start, seeded here for the same reason.
 * Take ConnectOptions whole so every brand seeds the same fields.
 */
export function initial(
  start: ConnectOptions & {
    /** The conversation's file, when the caller already knows it. */
    transcript?: string;
  }
): LiveState {
  return {
    cwd: start.cwd,
    // Left unset so the first `init` pins the CLI's spelling. Seeding the
    // spawn cwd made a `/var/folders` start and a `/private/var/folders`
    // `init` look like a move for the life of the session (ee23278). Until
    // that frame, `toSession` groups on `cwd`. A resume is not special-cased:
    // `init` states the process cwd, which is where the reader resumed.
    startedAt: start.startedAt,
    sessionId: start.sessionId,
    modelPick: start.model,
    effort: start.effort,
    windowAsked: start.window,
    launchReach: start.windowReach,
    transcript: start.transcript,
    status: 'idle',
    pending: [],
    queued: [],
    running: false,
    turnsEnded: 0
  };
}

/** `waiting` beats `busy`: a turn with an open request is blocked on a person,
 *  which is the thing worth seeing on a card.
 *
 *  **Never off disk.** An owned card's status, and every facet painted over
 *  it, is authored off frames. A file read is an exception only once it is
 *  listed under "Status is live, never disk" in `src/AGENTS.md`, with why no
 *  frame carries the fact. */
export function statusOf(running: boolean, pending: readonly PendingRequest[]): SessionStatus {
  if (pending.length) {
    return 'waiting';
  }
  return running ? 'busy' : 'idle';
}

/**
 * The turn is over: nothing is running, nothing is being written, no tool is
 * open. `pending` survives — a request outlives the turn that raised it, and
 * `waiting` still beats `idle`.
 *
 * Extracted because two frames now end a turn — `result`, and the CLI's own
 * `session_state_changed:idle` — and the point of the second is that it says the
 * same thing as the first. Two copies of "the same thing" is how they drift.
 *
 * `outcome` is recorded whether or not the turn was still running: Codex's
 * `systemError` ends the turn before `turn/completed failed` says why, and a
 * Grok prompt reply can be the first close that states one. A close that
 * states none never replaces one — guarding on `running` instead would drop
 * Codex's, and writing `undefined` would let Claude's `idle` erase the error
 * its `result` just stated.
 */
export function endTurn(state: LiveState, outcome?: TurnOutcome, local?: boolean): LiveState {
  const attributed =
    !state.warmTurn &&
    !local &&
    !state.inFlight?.command &&
    (state.running || (outcome !== undefined && !state.inFlight))
      ? messageFacts.update(state, state.messageTurn ?? [], messageFacts.phaseOf(outcome))
      : state;
  return {
    ...closeTurn(attributed, outcome),
    ...counted(state, outcome, local),
    ...appliedEffort(state, outcome)
  };
}

/**
 * The effort a `/effort` we wrote set, once its turn has run. Claude's pipe
 * never restates an effort (`cli_state/claude/commands.md`), so without this the
 * card keeps the launch line's. `running` keeps the stale `idle` that lands
 * between our write and the command's own turn from taking it early.
 */
function appliedEffort(state: LiveState, outcome: TurnOutcome | undefined): Partial<LiveState> {
  const effort = state.inFlight?.command ? state.inFlight.target?.effort?.trim() : undefined;
  return state.running && effort && outcome !== 'error' && outcome !== 'interrupted'
    ? { effort }
    : {};
}

/**
 * What a close adds to the count of finished turns, and their outcome. A
 * prompt the CLI answered itself, never calling the model, is no finish: a
 * slash command typed at the desk (`/clear`, `/model x`, `/usage`), which the
 * brand's reducer says by `local`, or the composer's own `/effort` ahead of a
 * targeted send (`QueuedMessage.command`), answered with a synthetic turn and a
 * `result` of its own (`docs/reference/cli_state/claude/commands.md`).
 */
function counted(
  state: LiveState,
  outcome: TurnOutcome | undefined,
  local: boolean | undefined
): Partial<LiveState> {
  if (state.warmTurn || local || state.inFlight?.command) {
    return {};
  }
  if (state.running || (state.uncounted && outcome !== undefined)) {
    return { turnsEnded: state.turnsEnded + 1, endedOutcome: outcome, uncounted: undefined };
  }
  return outcome === undefined ? {} : { endedOutcome: outcome };
}

/** The turn is over, counted or not — `endTurn` less the count, for the closes
 *  that are not a finish. */
function closeTurn(state: LiveState, outcome?: TurnOutcome): LiveState {
  const warm = state.warmTurn;
  return {
    ...state,
    // A warm turn's outcome is the ping's, never the card's last real turn.
    ...(outcome === undefined || warm ? {} : { lastOutcome: outcome }),
    ...(warm ? { warmTurn: ended(warm, outcome) } : {}),
    running: false,
    activeTool: undefined,
    // Only a turn that was actually running ends this message's life. The CLI
    // sends `session_state_changed: idle` behind its own `result`, and the
    // drain fires on the first of those two — so an unconditional clear here
    // wipes the message the drain has just written, a frame before the turn it
    // started even opens. Measured: `result`, drain, `idle`, `init`.
    //
    // That measurement is Claude's. A brand's close of our write before its
    // turn opened goes through `turnPending` first, so it is never this guard.
    // Reads as "the turn that consumed it has ended", and `canDrain` is what
    // makes that true rather than approximate: it refuses to drain unless
    // `running` is false, so a message is only ever taken while idle and
    // `state.running` here can only mean a turn opened after it went out.
    inFlight: state.running ? undefined : state.inFlight,
    status: statusOf(false, state.pending)
  };
}

/** `written` is never closed here: Claude's stale `idle` can land between the
 *  write and the turn opening. A brand that ends a turn it never opened calls
 *  `closeWarm`. */
function ended(warm: WarmTurn, outcome: TurnOutcome | undefined): WarmTurn {
  const failed = pingFailed(outcome);
  const phase = warm.phase === 'open' ? 'closed' : warm.phase;
  return phase === warm.phase && (!failed || warm.failed)
    ? warm
    : marked({ ...warm, phase }, failed);
}

function marked(warm: WarmTurn, failed: boolean): WarmTurn {
  return failed ? { ...warm, failed: true } : warm;
}

/**
 * Share with claude/reduce.ts so both turn beginnings supersede the last outcome.
 *
 * A warm turn opens here and keeps the last real outcome through every frame
 * of it. A turn opening over a closed latch is one the CLI started itself, and
 * that is real activity.
 */
export function inTurn(state: LiveState, over: Partial<LiveState>): LiveState {
  const pending = over.pending ?? state.pending;
  const warm = state.warmTurn;
  const warmTurn =
    warm?.phase === 'written'
      ? { ...warm, phase: 'open' as const }
      : warm?.phase === 'open'
        ? warm
        : undefined;
  return {
    ...state,
    ...over,
    messageTurn: !state.running && !state.inFlight ? undefined : state.messageTurn,
    lastOutcome: warmTurn ? state.lastOutcome : undefined,
    warmTurn,
    uncounted: undefined,
    running: true,
    status: statusOf(true, pending)
  };
}

/** A ping is in flight: written and not yet admitted ended. */
export function warming(state: LiveState): boolean {
  return state.warmTurn !== undefined && state.warmTurn.phase !== 'closed';
}

/** A ping's turn touching a tool, at any point of the call. */
export function reachesForTool(event: SessionEvent): boolean {
  return event.kind === 'tool-start' || event.kind === 'tool-update' || event.kind === 'tool-end';
}

/**
 * The ping put on the pipe. Never through the outbox: it is not merged, not
 * published in `queued`, and names nothing. `lastOutcome` is left alone, since
 * the ping is not a prompt that supersedes the last real turn.
 */
export function warmDrain(state: LiveState, entry: QueuedMessage): LiveState {
  return {
    ...state,
    inFlight: { ...entry, warm: true },
    warmTurn: {
      id: entry.id,
      phase: 'written',
      ...(state.contextTokens === undefined ? {} : { prefix: state.contextTokens })
    }
  };
}

/**
 * A warm ping failed on this outcome. Absent is not a failure: a close that
 * states none still ended. Exhaustive on `TurnOutcome`, so a new value has to
 * say which before it compiles.
 */
export function pingFailed(outcome: TurnOutcome | undefined): boolean {
  switch (outcome) {
    case undefined:
    case 'done':
      return false;
    case 'interrupted':
    case 'error':
      return true;
    default: {
      const uncovered: never = outcome;
      return uncovered;
    }
  }
}

/** What a refused ping says. Which condition returns which stays in the brand. */
export const WARM_SESSION_ENDED = 'The session has ended.';
export const WARM_NO_CONVERSATION = 'The session has no conversation to keep warm.';
export const WARM_MESSAGE_WAITING = 'A message is waiting to be sent.';
export const WARM_NOT_IDLE = 'The session is not idle.';

/**
 * The brand admits the ping ended without `endTurn` closing it: a write that
 * definitely failed, a termination before any opening frame, a close.
 */
export function closeWarm(state: LiveState, failed: boolean): LiveState {
  const warm = state.warmTurn;
  if (!warm || (warm.phase === 'closed' && (!failed || warm.failed))) {
    return state;
  }
  return {
    ...state,
    warmTurn: marked({ ...warm, phase: 'closed' }, failed),
    inFlight: state.inFlight?.warm ? undefined : state.inFlight
  };
}

/** The ping asked or reached for a tool and is being cut. It stays open until
 *  the brand admits the turn ended: an interrupt sent is not one confirmed. */
export function failWarm(state: LiveState): LiveState {
  const warm = state.warmTurn;
  return !warm || warm.failed ? state : { ...state, warmTurn: { ...warm, failed: true } };
}

export { warmVerdict } from './warm';

/**
 * The status a card and every other reader is shown: `idle` while a ping is in
 * flight on a live pipe, since maintenance is not work, and `busy` from our
 * write of a real message until its turn ends. Every brand opens that turn
 * only once its CLI speaks, and the write has already moved the activity clock
 * past the reader's mark, so `idle` in that gap reads as unread `done`. Exit
 * and a native `unknown` outrank both. This is product work status, not
 * permission to write: drains read raw `running` and the brand's own latches.
 */
export function shownStatus(state: LiveState): SessionStatus {
  if (state.exit) {
    return 'unknown';
  }
  if (state.status === 'unknown') {
    return 'unknown';
  }
  if (warming(state)) {
    return 'idle';
  }
  return turnPending(state) ? 'busy' : state.status;
}

/**
 * Our write of a real message is out and the CLI has not opened its turn: busy
 * to read, with no turn yet for an interrupt to end.
 *
 * A brand that closes our write while this holds — its CLI's close, a failed
 * start, a cancel — opens the turn first, as an apply of its own: `endTurn`
 * retires `inFlight`, counts and attributes only a running turn, and must not
 * do so unconditionally, or Claude's stale `idle` after its `result` would
 * retire the message the drain has just written.
 */
export function turnPending(state: LiveState): boolean {
  return !state.exit && state.status === 'idle' && !!state.inFlight && !state.inFlight.warm;
}

/** That turn opened, for the brand to apply before its close; else unchanged. */
export function openWritten(state: LiveState): LiveState {
  return turnPending(state) ? inTurn(state, {}) : state;
}

/** An event that ends a running turn: a turn-end, or a native `unknown`, which
 *  Codex's `systemError` lands as ahead of the completion that says why. */
export function closesTurn(event: SessionEvent): boolean {
  return event.kind === 'turn-end' || (event.kind === 'status' && event.status === 'unknown');
}

export function applyEvent(state: LiveState, event: SessionEvent): LiveState {
  switch (event.kind) {
    case 'status': {
      if (event.status === 'unknown') {
        // Not a finish, but Codex names the failure on the next frame.
        const ended = state.running
          ? {
              ...closeTurn(messageFacts.update(state, state.messageTurn ?? [], 'unknown')),
              ...(state.warmTurn ? {} : { uncounted: true as const })
            }
          : { ...state, running: false };
        const status = state.pending.length ? 'waiting' : 'unknown';
        // Record a new native unknown reason even when the status word did not move.
        return { ...ended, status, unknownFrom: `status:${event.native ?? 'unknown'}` };
      }
      const running = event.status === 'busy';
      const status = statusOf(running, state.pending);
      if (status === state.status && state.running === running) {
        return state;
      }
      // Grok and Codex open a turn here, on their CLI's busy word, and on our
      // own before a close of a write their CLI never opened (`turnPending`).
      if (running) {
        return inTurn(state, {});
      }
      // Use endTurn so roster idle shares the same closing rule.
      return state.running ? endTurn(state) : { ...state, status, running };
    }
    case 'text':
      // Accepted deltas use SessionHandle.onActivity; card state keeps its identity.
      return state.running ? state : inTurn(state, {});
    case 'thought':
      return inTurn(state, {});
    case 'tool-start':
      return inTurn(
        state,
        state.pending.some((p) => p.ask === false) ? {} : { activeTool: event.name }
      );
    case 'tool-update':
      return inTurn(state, {});
    case 'tool-end':
      return inTurn(state, { activeTool: undefined });
    case 'turn-end':
      return endTurn(state, event.outcome);
    case 'cache-read': {
      // The first request of a ping is what tests the cache; later ones read
      // what it wrote.
      const warm = state.warmTurn;
      return !warm || warm.cached !== undefined
        ? state
        : {
            ...state,
            warmTurn: {
              ...warm,
              cached: event.tokens,
              ...(warm.prefix === undefined && event.input !== undefined
                ? { prefix: event.input }
                : {})
            }
          };
    }
    case 'waiting': {
      if (event.open) {
        if (state.pending.some((p) => p.requestId === event.requestId)) {
          return state;
        }
        const pending = [
          ...state.pending,
          {
            requestId: event.requestId,
            toolName: event.toolName ?? event.label ?? 'a tool',
            ask: event.ask === true,
            label: event.label,
            input: event.input,
            questions: event.questions,
            suggestions: event.suggestions,
            canNote: event.canNote,
            canReply: event.canReply,
            canDenyReason: event.canDenyReason
          }
        ];
        return {
          ...state,
          pending,
          status: statusOf(state.running, pending),
          ...(event.ask === false ? { activeTool: undefined } : {})
        };
      }
      const pending = state.pending.filter((p) => p.requestId !== event.requestId);
      return pending.length === state.pending.length
        ? state
        : { ...state, pending, status: statusOf(state.running, pending) };
    }
    case 'queue':
      return state;
    case 'usage': {
      if (
        (event.contextTokens === undefined || event.contextTokens === state.contextTokens) &&
        (event.contextWindow === undefined || event.contextWindow === state.windowStated)
      ) {
        return state;
      }
      const next = {
        ...state,
        ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
        ...(event.contextWindow === undefined ? {} : { windowStated: event.contextWindow })
      };
      // Derive pct as core/claude/reduce.ts does so the card shows a bar instead of
      // leaving the division to the reader. Use windowStated alone, where Claude
      // falls back twice (TASK_done_codex_account_models.md § Outcome): dividing by
      // windowAsked would state an occupancy Codex never supplied. contextSize may use it.
      return next.windowStated === undefined || next.contextTokens === undefined
        ? next
        : { ...next, contextPct: contextPercent(next.contextTokens, next.windowStated) };
    }
    case 'model':
      return event.model === state.model ? state : { ...state, model: event.model };
    case 'effort':
      return event.effort === state.effort ? state : { ...state, effort: event.effort };
    case 'permission':
      return event.mode === state.permissionMode ? state : { ...state, permissionMode: event.mode };
    case 'title':
      return event.title === state.title ? state : { ...state, title: event.title };
    case 'exit':
      // Clear requests before endTurn, or statusOf leaves a dead session waiting
      // on a question nothing can answer.
      return {
        ...closeWarm(closeTurn({ ...messageFacts.abandon(state), pending: [] }), warming(state)),
        exit: { code: event.code, signal: event.signal },
        uncounted: undefined,
        // Log the callback, not process liveness; host/sessions.ts asks that on the edge.
        unknownFrom: `exit:${event.source ?? 'unstated'}`,
        // Clear the outbox explicitly even for an idle exit; endTurn only retires
        // an in-flight message from a running turn, and none of these will be answered.
        queued: [],
        inFlight: undefined
      };
  }
}

export function applyEvents(state: LiveState, events: readonly SessionEvent[]): LiveState {
  return events.reduce(applyEvent, state);
}

/**
 * One request off the list — answered by the reader, or retracted by the CLI.
 *
 * Both endings are the same removal, deliberately. An interrupt cancels an open
 * permission request before it answers the interrupt itself, so a card that
 * only cleared on an answer would sit there offering to allow something nothing
 * is waiting for.
 */
export function answered(state: LiveState, requestId: string): LiveState {
  const pending = state.pending.filter((p) => p.requestId !== requestId);
  return pending.length === state.pending.length
    ? state
    : { ...state, pending, status: statusOf(state.running, pending) };
}

/**
 * Drain only with no running turn or open request. A waiting message stays
 * until the reader answers or send-now interrupts and retracts the request.
 */
export function canDrain(state: LiveState): boolean {
  // A ping in flight holds the pipe until its brand admits it ended, so an
  // ambiguous write never has a real turn written onto it.
  return !state.exit && !state.running && state.pending.length === 0 && !warming(state);
}

/**
 * The panel just moved this session onto a model — the alias it sent, kept.
 *
 * Written on the *answer* to `set_model` and not on the send, so a pipe that
 * refused the switch leaves the pick where it was.
 */
export function pickModel(state: LiveState, value: string): LiveState {
  return value === state.modelPick ? state : { ...state, modelPick: value };
}

/**
 * Append one held message. Pure: the write is `OwnedSession`'s job.
 *
 * Empty text with no images is a no-op. `firstPrompt` is set from the first
 * text that has prose in it, which is what a later title generation reads —
 * markers stripped, and skipped entirely when they were all there was. A
 * screenshot sent without a word is still nothing to name a session after, and
 * the title is persisted into the transcript, so `[Image #1]` would be the name
 * every other window and every `/resume` saw from then on.
 *
 * `describe` wins over the prose when the caller supplied one, for the reason
 * on the field: the text a mentioned workflow puts on the wire is not what the
 * session should be called. It is still only a *first* prompt — a later send
 * with a describe on it does not rename anything.
 */
export function enqueue(state: LiveState, entry: QueuedMessage): LiveState {
  return hold(state, entry, false);
}

/**
 * The same, at the head of the outbox.
 *
 * What `--interrupt` needs and what a plain `send` cannot give it: the drain
 * that follows must find *this* message first. Grok sends the head, so ahead is
 * the whole of it there; Claude merges the outbox into one turn, where ahead
 * decides the order the text reads in.
 *
 * Not an interrupt of its own — that is `sendNow`, which holds the latch. This
 * only decides where in the queue the entry lands.
 */
export function enqueueAhead(state: LiveState, entry: QueuedMessage): LiveState {
  return hold(state, entry, true);
}

function hold(state: LiveState, entry: QueuedMessage, ahead: boolean): LiveState {
  if (!entry.text && !entry.images?.length) {
    return state;
  }
  // Through the seam, not off the wire text. Both senders of a wrapped message
  // pass a `describe` and so never reached this — but a name is not a repaint:
  // `firstPrompt` feeds the CLI's titler and the title is persisted, so an
  // envelope that got this far would be the session's name in every window and
  // every resume from then on. The invariant should not rest on two callers
  // remembering.
  const prose = withoutImageMarkers(delivered(entry.text).text);
  const naming = entry.command ? '' : entry.describe?.trim() || prose;
  return {
    ...messageFacts.update(state, messageFacts.correlations(entry), 'queued'),
    queued: ahead ? [entry, ...state.queued] : [...state.queued, entry],
    firstPrompt: state.firstPrompt ?? (naming || undefined)
  };
}

/**
 * An entry the merge stops at rather than folds in.
 *
 * One kind: a slash command, which the CLI reads as a command only when it
 * starts the message. `/effort` ahead of a targeted send is the writer, and
 * `mergeQueued` is where the wall governs.
 *
 * The two attribution wrappers used to wall here too. They merge now and keep
 * their authors anyway: each merged message goes on the wire as a block of its
 * own (`segments`) and is recorded as a turn of its own (`sentTurns`).
 */
function walls(entry: QueuedMessage): boolean {
  return Boolean(entry.command);
}

export function dismissQueued(state: LiveState, id: string): LiveState {
  const queued = state.queued.filter((q) => q.id !== id);
  return queued.length === state.queued.length
    ? state
    : {
        ...messageFacts.update(
          state,
          state.queued.filter((q) => q.id === id).flatMap((q) => messageFacts.correlations(q)),
          'unsuccessful',
          true
        ),
        queued
      };
}

/**
 * Collapse the whole outbox into one held message, so the write that follows
 * is a single turn instead of one per idle edge.
 *
 * What every drain does, and what Send now says it does. Sent one at a time,
 * the second message lands on the turn the first one started — the reader who
 * held three of them wanted the session to read all three before it moved, and
 * N turns is not that. The CLI's own TUI flushes its queue the same way
 * (`docs/reference/cli_state/claude/protocol.md`).
 *
 * Texts join in order, blank line between, skipping the entries carrying only
 * images; the images follow in the same order. The joined `text` is what the
 * outbox, the titler and other windows read; the wire and the record read
 * `parts`, the messages as they were held.
 *
 * The merged entry gets its own id — every id it was made of, so nothing else
 * can collide with it — rather than inheriting the head's. Another window is
 * looking at a published record a poll old and still showing N rows, and under
 * the head's id their Dismiss of row one would drop all N and be told it worked.
 * A dismiss of any stale row now misses and says so, which is the truth: the
 * message it named is inside something already on its way out.
 *
 * `queuedAt` stays the head's — the outbox is ordered by when the reader
 * submitted, and that is the oldest thing in the merge.
 *
 * **A `command` entry is a wall.** The merge stops before one and never takes
 * it in, so a queued `/effort high` drains as its own turn and reaches the CLI
 * as the whole message — which is the only shape it is read as a command in.
 * The writer is the `/effort` row `OwnedSession.send` puts ahead of a targeted
 * send.
 *
 * A target change is the other boundary. Rows at one target may still become
 * one turn; a row carrying another cannot, because the adapter has only one
 * model and effort to put on that turn.
 *
 * Markers are renumbered across the merge: on the wire each message's images
 * follow its own words, but the CLI numbers a prompt's images as one list, so
 * each message past the first has its `#1` shifted to wherever its own image now
 * sits. Without the shift a merge points every later marker at the head's
 * images. `parts` keep the words as typed; `segments` applies the same shift.
 */
export function mergeQueued(state: LiveState, skip?: ReadonlySet<string>): LiveState {
  if (skip?.size) {
    const rest = state.queued.filter((row) => !skip.has(row.id));
    const parked = state.queued.filter((row) => skip.has(row.id));
    if (rest.length === 0) {
      return state;
    }
    const merged = mergeQueued({ ...state, queued: rest });
    return parked.length === 0 ? merged : { ...merged, queued: [...merged.queued, ...parked] };
  }
  const [head] = state.queued;
  if (!head || state.queued.length < 2 || walls(head)) {
    return state;
  }
  // Do not merge around a boundary: keep the reader's submitted order.
  const wall = state.queued.findIndex(
    (entry, index) =>
      index > 0 &&
      (walls(entry) ||
        entry.target?.model !== head.target?.model ||
        entry.target?.window !== head.target?.window ||
        entry.target?.effort !== head.target?.effort)
  );
  const merging = wall === -1 ? state.queued : state.queued.slice(0, wall);
  const rest = wall === -1 ? [] : state.queued.slice(wall);
  if (merging.length < 2) {
    return state;
  }
  const images = merging.flatMap((q) => q.images ?? []);
  const texts: string[] = [];
  let sent = 0;
  for (const q of merging) {
    const carried = q.images?.length ?? 0;
    if (q.text) {
      texts.push(shiftImageMarkers(q.text, sent, carried));
    }
    sent += carried;
  }
  return {
    ...state,
    queued: [
      {
        id: merging.map((q) => q.id).join('+'),
        parts: merging.flatMap(
          (q) =>
            q.parts ?? [
              {
                id: q.id,
                text: q.text,
                ...(q.correlation ? { correlation: q.correlation } : {}),
                ...(q.images ? { images: q.images } : {})
              }
            ]
        ),
        text: texts.join('\n\n'),
        images: images.length ? images : undefined,
        queuedAt: head.queuedAt,
        ...(head.target !== undefined ? { target: head.target } : {})
      },
      ...rest
    ]
  };
}

/**
 * A row as the blocks of one prompt: one segment per merged message, its images
 * straight after its own words, and one for a row nothing merged into.
 *
 * Every brand writes this rather than the joined `text`, so each message reaches
 * the CLI as a content block of its own and is filed under its own author. All
 * three hand adjacent blocks to the model with nothing between them (probed
 * 2026-10-04, `TASK_*_peer_message_blocks.md`), so the blank line the join used
 * to put there rides on the words that another message's words follow — the
 * segments' texts concatenate to exactly the joined `text`.
 *
 * Markers are renumbered here for the reason `mergeQueued` gives: on the wire
 * the images are still one list.
 */
export function segments(row: QueuedContent): { text: string; images: ImageBlock[] }[] {
  if (!row.parts) {
    return [{ text: row.text, images: row.images ?? [] }];
  }
  let offset = 0;
  const laid = row.parts.map((part) => {
    const count = part.images?.length ?? 0;
    const text = shiftImageMarkers(part.text, offset, count);
    offset += count;
    return { text, images: part.images ?? [] };
  });
  return laid.map((segment, at) =>
    segment.text && laid.slice(at + 1).some((later) => later.text)
      ? { ...segment, text: `${segment.text}\n\n` }
      : segment
  );
}

/** Retire on a successful pipe write, not init: we own the queue. */
export function dequeueHead(state: LiveState): LiveState {
  const [head] = state.queued;
  if (!head) {
    return state;
  }
  // Held as `sent` on the way out, so the message is somewhere the dock can
  // draw it for the beat between our write and the transcript's own copy of it.
  // Only a drain does this — a dismissed row is a message that was never sent.
  //
  // The write supersedes the last outcome here rather than at the next frame:
  // every brand stays idle until its CLI speaks, and a card still red over a
  // prompt already sent reads as the failure of it. `running` is left alone,
  // on every brand: it is the CLI's turn, which `canDrain` and closeTurn's
  // guard on Claude's stale `idle` read; `shownStatus` reads busy from here.
  return {
    ...messageFacts.update(state, messageFacts.correlations(head), 'processing'),
    messageTurn: messageFacts.correlations(head),
    queued: state.queued.slice(1),
    inFlight: head,
    lastOutcome: undefined,
    warmTurn: undefined
  };
}

/**
 * The title a `generate_session_title` round trip produced.
 *
 * Empty or missing is left alone rather than written down: the CLI answers
 * `{"title": null}` when the model declines, and a card falls back to its cwd
 * rather than showing a blank where a name goes.
 */
export function withTitle(state: LiveState, payload: unknown): LiveState {
  const title = (payload as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.trim() ? { ...state, title: title.trim() } : state;
}

/**
 * Decline blank stated names so a card keeps the name it already had.
 * The caller already cleans with sessionName; host/sessions.ts persists the statement.
 */
export function withStated(state: LiveState, name: string): LiveState {
  const want = name.trim();
  return !want || want === state.stated ? state : { ...state, stated: want };
}

/** Share applyEvent's exit rule; sessions call this instead of emitting exit. */
export function withExit(
  state: LiveState,
  exit: { code: number | null; signal: string | null; source?: ExitSource }
): LiveState {
  return applyEvent(state, {
    kind: 'exit',
    code: exit.code,
    signal: exit.signal,
    source: exit.source
  });
}

/**
 * Require the caller's answer-arrival clock: this module has none, and an
 * unstamped usage reading loses to every dated one in the store.
 *
 * Merged the store's way, window by window, so a partial push or a figureless
 * window cannot drop a figure before the next ingestion pass has seen it.
 */
export function withUsage(state: LiveState, usage: RateLimits | undefined, at: number): LiveState {
  return usage ? { ...state, usage: mergeReadings([state.usage, stampWindows(usage, at)]) } : state;
}

/** Host facts no frame states: child pid, start, clocks and launch name. */
export type OwnedFacts = {
  pid: number;
  startedAt: number;
  updatedAt: number;
  cacheAt?: number;
  warm?: boolean;
  warmArmedAt?: number;
  warmSupported?: boolean;
  warmFailureAt?: number;
  /** What the cache lifetime is read from. Absent is the defaults. */
  warmPolicy?: WarmPolicy;
  /** The name this session was started under, when somebody gave it one. */
  name?: string;
  /**
   * A prompt or draft label, ranked below the CLI title by naming.ts.
   * Never put it on the command line; docs/reference/cli_state/claude/sessions.md measures why.
   */
  placeholder?: string;
  /**
   * Take the brand from the adapter caller, or another brand's cards could be
   * marked as this reducer's brand.
   */
  brand: BrandId;
  session?: Pick<SessionHandle, 'messages'>;
  /** Spawn parent, when the start named one. */
  parentSessionId?: string;
  /** Fan-out origin already resolved at the start. */
  originSessionId?: string;
};

/** Omit absent context keys; see toSession's promote note. */
function size(key: 'contextSize' | 'contextAsked', tokens: number | undefined) {
  return tokens === undefined ? {} : { [key]: tokens };
}

/**
 * Keep status in this testable reducer; host/sessions.ts cannot be tested.
 *
 * Synthesised rather than discovered, and **not** because discovery misses
 * these — it finds them. A print-mode session writes a
 * `~/.claude/sessions/<pid>.json` like any other; what it never writes is a
 * `status` field, so the twin discovery makes of it is `unknown` and belongs
 * to no window
 * (`docs/reference/cli_state/claude/protocol.md`). Everything here comes from the frames
 * instead, which is why it is right the moment it changes rather than a poll
 * later — and why `foldTwins` drops the twin rather than merging it.
 *
 * This is also exactly what `published.ts` writes down for the other windows,
 * which can only ever see the twin.
 */
export function toSession(state: LiveState, held: OwnedFacts, windowId: string): Session {
  const quiet = warming(state);
  const blocked = quiet ? undefined : state.pending[0];
  const status = shownStatus(state);
  // Rank the placeholder last so a CLI title can replace the prompt's first line.
  const wears = bestName([
    { name: state.stated, rung: 'stated' },
    { name: held.name, rung: 'given' },
    { name: state.title, rung: 'generated' },
    { name: held.placeholder, rung: 'prompt' }
  ]);
  return {
    pid: held.pid,
    // Empty until the CLI names the session, which it does on the first turn.
    // Nothing may key off this being present — a promptless session has no id
    // for as long as nobody types into it.
    sessionId: state.sessionId ?? '',
    // Group by origin so cd or worktree entry does not move the heading.
    // Use the pinned frame value rather than reading a transcript to recover it.
    cwd: state.originCwd ?? state.cwd,
    // Omit liveCwd until it differs, so published records distinguish a move.
    ...(state.originCwd && state.originCwd !== state.cwd ? { liveCwd: state.cwd } : {}),
    // Ranked in `core/naming.ts`, which is also what the fold outside this pipe
    // ranks with — the two halves answered this separately until they drifted.
    //
    // Until any of the four, the directory plus a suffix, which is the CLI's own
    // shape for an unnamed session and what `displayName` folds to `agent-3f` —
    // three sessions in one checkout are three cards, not one name printed three
    // times.
    name:
      wears?.name ??
      `${path.basename(state.originCwd ?? state.cwd) || state.cwd}-${held.pid.toString(36)}`,
    nameSource: wears ? sourceOf(wears.rung) : 'derived',
    status,
    hasCommand: false,
    waitingFor: blocked ? (blocked.ask ? 'input needed' : 'permission prompt') : undefined,
    // Spread for `promote`'s sake, as the sizes below are.
    ...(state.lastOutcome === undefined ? {} : { turnOutcome: state.lastOutcome }),
    turnsEnded: state.turnsEnded,
    ...(state.endedOutcome === undefined ? {} : { endedOutcome: state.endedOutcome }),
    startedAt: held.startedAt,
    updatedAt: held.updatedAt,
    warm: held.warm,
    ...(held.warmArmedAt !== undefined ? { warmArmedAt: held.warmArmedAt } : {}),
    ...(quiet ? { warming: true as const } : {}),
    ...(turnPending(state) ? { turnPending: true as const } : {}),
    ...(held.warmSupported ? { warmPort: warm.portFacts(state) } : {}),
    warmFailureAt: held.warmFailureAt,
    cache: {
      ...cacheTtl.ttlFor(held.brand, held.warmPolicy ?? DEFAULT_WARM_POLICY),
      ...(status === 'busy' || held.cacheAt === undefined ? {} : { at: held.cacheAt })
    },
    // Take the brand from the adapter that started the child; only it knows.
    brand: held.brand,
    images: held.session?.messages?.images,
    model: state.model,
    modelPick: state.modelPick,
    effort: state.effort,
    contextPct: state.contextPct,
    // An owned card states its own size, so a start that pinned its window
    // reads `n% of 200k` before the wire has stated anything.
    //
    // **Spread in, not set to `undefined`.** `ui/views.ts:promote` folds a
    // published record over a discovered twin with `{...twin, ...record}`, so a
    // key present-and-undefined erases what the twin knew — which for a Grok
    // card promoted off a record is its `of 500k`, read off `signals.json`.
    // That fold is the shims' path since row 71; the panel folds no records.
    ...size('contextSize', state.windowStated ?? state.windowAsked),
    // Keep every requested window, not only mismatches: the card marks a smaller
    // window, while spawned children inherit the request. Otherwise a child cannot
    // tell no request from one that was granted.
    ...size('contextAsked', state.windowAsked),
    // Carry launchReach on the board's own cards because host/session_io.ts reads
    // it there; nothing reads the published copy. Spread for promote's sake, as above.
    ...(state.launchReach === undefined ? {} : { launchReach: state.launchReach }),
    contextTokens: state.contextPct === undefined ? state.contextTokens : undefined,
    // Spread for promote's sake, as above.
    ...(held.parentSessionId ? { parentSessionId: held.parentSessionId } : {}),
    ...(held.originSessionId ? { originSessionId: held.originSessionId } : {}),
    permissionMode: state.permissionMode,
    activeTool: quiet ? undefined : state.activeTool,
    // Account usage, ranked by its reading stamp.
    rateLimits: state.usage,
    windowId,
    control: { canControl: true, owner: { kind: 'window', windowId } },
    transcript: state.transcript ?? '',
    source: 'owned'
  };
}
