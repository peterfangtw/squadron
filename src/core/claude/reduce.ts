/**
 * Claude frames in, `LiveState` out.
 *
 * Product types and the outbox stay in `core/live.ts`. Grok reduces through
 * `core/grok/reduce.ts`.
 */

import { learnWindow, windowFor } from './context';
import { parseQuestions } from './asks';
import { ControlRequestFrame, Frame } from './frames';
import {
  LiveState,
  PendingRequest,
  answered,
  applyEvent,
  endTurn,
  inTurn,
  statusOf
} from '../live';
import { catalogFor, contextPercent, windowOf } from '../catalog';
import { base, resolveModel } from '../model_names';
import { transcriptPath } from './transcript';

/**
 * The state after one frame. Returns the state it was given when the frame
 * changes nothing, so a listener can skip a repaint on identity alone — which
 * matters, because a turn is a hundred delta frames.
 */
export function reduce(state: LiveState, frame: Frame): LiveState {
  // An echo, not a turn. A `set_model` is answered with a replayed `user` frame
  // restating what it did, and it arrives with the session idle and no `result`
  // behind it — so counting it as a turn beginning left the card reading busy
  // for as long as the session went on doing nothing. Before the switch, since
  // the flag means the same thing on either message kind.
  if ((frame.type === 'assistant' || frame.type === 'user') && frame.isReplay) {
    return state;
  }
  switch (frame.type) {
    case 'conversation_reset':
      return cleared(state);
    case 'system':
      return reduceSystem(state, frame.subtype, frame);
    case 'stream_event':
      return reduceStream(state, frame);
    case 'assistant':
    case 'user':
      return inTurn(state, {});
    case 'result': {
      const stated = frame.contextWindows ?? {};
      // Windows are learnt for the whole panel, not just this card: an owned
      // session's result is the only thing Squadron reads that states a window,
      // and `SEED` covers four ids (`claude/context.ts`). Stop feeding this and
      // most discovered twins fall back to a bare token count.
      //
      // **Unless this launch *pinned* its window** — which is `launchReach`, not
      // "a window is set". The gear writes a window for every pick, so keying
      // this on `windowAsked` turned the guard always-on and stopped the store
      // learning from owned sessions at all, ten lines under a comment saying
      // why that is bad.
      //
      // A `plain` window is the model's own answer and safe to learn. A
      // `suffix` or `flag` one is the *session's*: a start held to 200k by
      // `CLAUDE_CODE_DISABLE_1M_CONTEXT` would write `claude-opus-5: 200000`
      // into the machine's `models.json`, and every discovered Opus 5 card on
      // the board would draw against a window it is not in. The store holds one
      // size per id and has no way to say "except that one".
      //
      // **Two facts, because they come from different places.** The flag is the
      // *line*'s and cannot change — `launchReach`, written once at `initial`.
      // The suffix is this *pick*'s, and a switch can add one to a line that
      // launched plain, so it is read off what the session currently asks for.
      // It used to be one field that a switch rewrote, which meant a flagged
      // line stopped looking flagged the moment the reader picked a model whose
      // window is reached plain: start Opus 5 at 200k, move to Sonnet 5, and
      // this wrote `claude-sonnet-5: 200000` for the whole machine — the exact
      // failure the paragraph above describes, reached by the field going stale
      // (`TASK_done_window_fixed.md`).
      //
      // The derivation is what `setModel` computed before its write was
      // deleted, off the same pair it stores.
      const spelled = windowOf('claude', state.modelPick, state.windowAsked)?.reach === 'suffix';
      if (state.launchReach !== 'flag' && !spelled) {
        for (const [model, size] of Object.entries(stated)) {
          learnWindow(model, size);
        }
      }
      // What *this* session is in, keyed by its own model. `base()` because a
      // `[1m]` launch reports `modelUsage` under the unsuffixed spelling on some
      // models and the suffixed one on others (probed 2026-08-27); other keys
      // are subagents' and are not this card's window (#83355).
      //
      // The catalog's spellings last, and for a key neither of those reaches: a
      // reading of `claude-opus-4-5-20251101` is billed under `claude-opus-4-5`,
      // and `base()` strips only a `[…]` suffix. Still this session's own
      // figure — the row is used to *name* the key, never to supply the number
      // (`context.catalogWindow` is where a catalog figure may stand in).
      const mine = state.model;
      const row =
        mine === undefined ? undefined : resolveModel(catalogFor('claude'), mine, undefined);
      const size =
        mine === undefined
          ? undefined
          : (stated[mine] ??
            stated[base(mine)] ??
            (row === undefined ? undefined : (stated[row.id] ?? stated[row.value])));
      const next =
        typeof size === 'number' && size > 0 && size !== state.windowStated
          ? { ...state, windowStated: size }
          : state;
      return withContext(endTurn(next, frame.outcome, frame.local));
    }
    case 'rate_limit_event':
      return frame.resetsAt === undefined || frame.resetsAt === state.limitResetsAt
        ? state
        : { ...state, limitResetsAt: frame.resetsAt };
    case 'control_request':
      return reduceRequest(state, frame);
    case 'control_cancel_request':
      return answered(state, frame.requestId);
    case 'control_response':
      // Ours to correlate, not to derive state from: the client resolves the
      // round trip and decodes usage before handing it to `withUsage`.
      return state;
  }
}

/**
 * A `/clear`: the conversation ends and the process carries on.
 *
 * Everything dropped here is scoped to the conversation rather than to the
 * session — the prompt a title would be generated
 * from, the title that was generated, how the last turn ended, and any request
 * still open. Carried, each
 * of them speaks for a conversation the model no longer holds: a card kept a
 * name derived from a prompt nobody could scroll to.
 *
 * `sessionId`, `transcript` and `originCwd` are deliberately **not** reset:
 * they are re-derived from the `init` that follows, which is the frame that
 * names the new conversation — see `ResetFrame`.
 *
 * `pending` is deliberately **not** emptied. A `/clear` cannot be written while
 * a request is open — `canDrain` requires an empty `pending` — so there is
 * nothing to clear on the only path that produces this frame, and clearing it
 * without recomputing `status` through `statusOf` would leave a card reading
 * `waiting` with nothing to answer, which is the ordering trap `withExit`'s doc
 * warns about.
 *
 * The title is dropped here and re-asked in `OwnedSession.handle`, which owns
 * the latch that decides when to ask.
 *
 * **`stated` is not dropped**, and the spread is what keeps it. That one is a
 * statement rather than a guess about a conversation that has gone, and the CLI
 * keeps its own across a `/clear` too — `sessions/<pid>.json` holds the name
 * under the new id and the fresh transcript opens with `custom-title` restamped
 * (2.1.258, protocol.md, "`/clear` under a stated name"). The spread is the
 * whole of what happens here. Re-keying the store is the host's and needs no
 * second rename: `Entry.statedKey` holds the id the name was last written
 * under, so the `init` that follows this frame finds a new one and writes the
 * name again beneath it (`host/sessions.ts`). What is left on the old id is
 * kept rather than swept — that conversation is still in the resume picker, and
 * its name is the thing that makes the row findable (`core/names.ts`).
 *
 * The context readout was already handled at the `init`, on the same reasoning
 * (`contextTokens` / `contextPct` below).
 */
function cleared(state: LiveState): LiveState {
  return {
    ...state,
    firstPrompt: undefined,
    title: undefined,
    lastOutcome: undefined,
    warmTurn: undefined
  };
}

function reduceSystem(state: LiveState, subtype: string, frame: Frame & { type: 'system' }) {
  // The CLI's own answer, when the child was started with
  // `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`. Authoritative over inference:
  // `idle` arrives after `result` and repairs a `result` that never came.
  //
  // `running` opens a turn as `init` does, and is not the duplicate it looks
  // like. For a turn it is one — it lands ~4 ms ahead of the `init` that would
  // have opened it anyway. `/compact` is where that stops holding: the CLI
  // sends `init` beside `compact_boundary` when the summarising call has
  // already *returned*, so `init` closes that turn rather than opening it and
  // `running` leads it by the whole compaction — 5s on a 27k probe, 143s on a
  // real 315k session, both silent (2026-08-18, 2.1.233,
  // `docs/reference/cli_state/claude/protocol.md`).
  //
  // Safe against the stuck-BUSY class below because it only adds an opener:
  // `result` and `idle` both still end a turn, and the CLI emitted `idle`
  // behind every one of the seven turns probed.
  //
  // `requires_action` stays ignored — it is not `waiting`, `pending` is the
  // sole author of that word, and the CLI raises this state for dialogs that
  // never reach our pipe.
  if (subtype === 'session_state_changed') {
    if (frame.state === 'idle') {
      // States no outcome, so the `result` just ahead of it keeps its own.
      return endTurn(state);
    }
    return frame.state === 'running' ? inTurn(state, {}) : state;
  }
  // The compaction has already returned by the time this lands and left a
  // fraction of what the last `message_start` counted — the trace and the
  // figures are on the block above. So the held reading is dropped for the
  // reason the `/clear` below drops it: it measures a context that is gone.
  // Not a turn; the boundary opens none.
  //
  // The count it left is *stated* on disk (`transcript.md`,
  // `compactMetadata.postTokens`) and the wire spelling of that field is
  // unmeasured, so it is not read here — the next `message_start` says it
  // anyway, in the spelling this file already trusts.
  if (subtype === 'compact_boundary') {
    return state.contextTokens === undefined && state.contextPct === undefined
      ? state
      : { ...state, contextTokens: undefined, contextPct: undefined };
  }
  // Closed world, deliberately. There are ~30 system subtypes and half of them
  // can arrive **outside** a turn — `api_retry`, `notification`,
  // `post_turn_summary`, `worker_shutting_down`. Reading any of those as proof
  // of a running turn is what pinned five cards on BUSY for 35 minutes
  // (2026-07-28), since only `result` and the child's exit ever cleared it. So
  // `init` opens a turn and nothing else does — which subsumes the `hook_`
  // guard this used to need, hooks having been only the loudest of the frames
  // that arrive before a session has done anything.
  if (subtype !== 'init') {
    return state;
  }
  const sessionId = frame.sessionId ?? state.sessionId;
  const cwd = frame.cwd ?? state.cwd;
  // A `/clear`: the CLI mints a new id and this `init` states it. The reset
  // frame that named the event carries no usable id (`ResetFrame`), so the two
  // halves are deliberately separate and the identity is re-derived here.
  const cleared = sessionId !== undefined && sessionId !== state.sessionId;
  return inTurn(state, {
    // The outbox is retired on our write, not on `init`: holding means the CLI
    // never sees a message until we drain it, so there is nothing here to pop.
    sessionId,
    cwd,
    model: frame.model ?? state.model,
    // Restated per turn, so a mode changed mid-session is right on the next one.
    permissionMode: frame.permissionMode ?? state.permissionMode,
    // Pinned on the same rule as `transcript` below, and for the same reason
    // stated the other way round: the cwd `init` restates every turn is where
    // the session *stands*, and the card's group is where its conversation
    // *began*. A `/clear` is a new conversation and begins where it is minted.
    originCwd:
      sessionId && (sessionId !== state.sessionId || !state.originCwd) ? cwd : state.originCwd,
    // Derived once per session id rather than per turn: `init` restates the cwd
    // every turn and states the new one once the session has moved, where the
    // transcript stays in the directory it was filed under. A `/clear` hands
    // over a new id, and that one is filed where the session stands now.
    transcript:
      sessionId && (sessionId !== state.sessionId || !state.transcript)
        ? transcriptPath(cwd, sessionId)
        : state.transcript,
    // Dropped with the conversation it measured. Carried, a card read 23% over a
    // transcript five lines long for as long as nobody typed — `message_start`
    // is the only frame that writes the count and a cleared session sends none
    // until somebody does (observed 2026-08-19, 2.1.234). Nothing states the new
    // reading in the meantime, and a cleared session is not an empty one —
    // system prompt, `CLAUDE.md`, the tool list — so zero would be as wrong as
    // the figure it replaced. A card says nothing rather than guessing
    // (`core/claude/context.ts`).
    contextTokens: cleared ? undefined : state.contextTokens,
    contextPct: cleared ? undefined : state.contextPct
  });
}

/**
 * The same model, told apart by nothing but the context suffix.
 *
 * `init` states `claude-opus-5[1m]` and the `message_start` behind it states
 * `claude-opus-5`, for one session that never moved (probed 2026-08-14 on
 * 2.1.220). The suffix is the load-bearing half: `result.modelUsage` is keyed
 * *with* it and that is where the window a card's percentage is a share of is
 * learnt, and the model list carries the two as separate rows. So the shorter
 * spelling is dropped rather than written over the longer one — a turn that
 * moved the session really does state a different model, and that still lands,
 * because `init` leads every turn and writes whatever it says.
 */
function sameModel(held: string | undefined, stated: string | undefined): boolean {
  return held !== undefined && stated !== undefined && base(held) === base(stated);
}

function reduceStream(state: LiveState, frame: Frame & { type: 'stream_event' }): LiveState {
  if (frame.parentToolUseId !== undefined) {
    // A subagent's stream. It marks the turn as running and nothing else: its
    // text is not this session's message and its usage is not this session's
    // context.
    return inTurn(state, {});
  }
  if (frame.text !== undefined) {
    // Accepted deltas use SessionHandle.onActivity; card state keeps its identity.
    return state.running ? state : inTurn(state, {});
  }
  if (frame.toolName !== undefined) {
    return inTurn(state, { activeTool: frame.toolName });
  }
  if (frame.event === 'message_start') {
    const next = inTurn(state, {
      model: sameModel(state.model, frame.model) ? state.model : (frame.model ?? state.model),
      contextTokens: frame.contextTokens ?? state.contextTokens
    });
    const read =
      frame.cacheRead === undefined
        ? next
        : applyEvent(next, { kind: 'cache-read', tokens: frame.cacheRead });
    return withContext(read);
  }
  return inTurn(state, {});
}

/**
 * The share of its window this session's context is, when both halves are
 * known. The CLI's own arithmetic over the CLI's own numerator — the newest
 * message's input plus cache tokens, divided by the window that model answers
 * in — so an owned card reads the same as a terminal one.
 *
 * A model nobody has a size for leaves the token count standing alone, which is
 * the one thing that must not become a guess (`core/claude/context.ts`).
 */
function withContext(state: LiveState): LiveState {
  // The session's own figure first, the machine's store second. A start that
  // pinned its window knows it before any turn has run, and a start that did
  // not falls through to what the store learnt from dumps — which is where a
  // discovered card's percentage has always come from.
  const size = state.windowStated ?? state.windowAsked ?? windowFor(state.model);
  if (size === undefined || state.contextTokens === undefined) {
    return state;
  }
  const pct = contextPercent(state.contextTokens, size);
  return pct === state.contextPct ? state : { ...state, contextPct: pct };
}

function reduceRequest(state: LiveState, frame: ControlRequestFrame): LiveState {
  if (frame.subtype !== 'can_use_tool') {
    return state;
  }
  // The CLI re-asking something already open would otherwise draw two cards for
  // one request, and answering either would leave the other on screen.
  if (state.pending.some((p) => p.requestId === frame.requestId)) {
    return state;
  }
  const ask = frame.requiresUserInteraction === true;
  const request: PendingRequest = {
    requestId: frame.requestId,
    toolName: frame.toolName ?? 'a tool',
    toolUseId: frame.toolUseId,
    ask,
    label: frame.description,
    input: frame.input,
    suggestions: frame.suggestions
  };
  if (ask) {
    request.questions = parseQuestions(frame.input?.questions);
  }
  const pending = [...state.pending, request];
  return { ...state, pending, status: statusOf(state.running, pending) };
}
