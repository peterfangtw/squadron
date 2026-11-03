/**
 * What a CLI just said, in the panel's own words.
 *
 * The shared live-event vocabulary. Grok's reducer turns ACP notifications
 * into these, and Codex's turns app-server notifications into these.
 * `applyEvent` in `core/live.ts` turns them into `LiveState` and knows no
 * brand's spelling. Claude's reducer writes `LiveState` directly and uses
 * one of these, a cache read.
 *
 * **Not a wire format.** Nothing serialises this, nothing writes it to disk and
 * no window sends it to another. It exists so more than one producer can be
 * reduced by one consumer; the moment it is also a protocol, the kinds start being chosen
 * for whoever is parsing them rather than for what a card shows.
 *
 * The kinds are exactly what `core/live.ts` already thinks in, taken off the
 * reducer as it stands rather than invented for a CLI we have not read. So a
 * kind here earns its place by something on a card depending on it — which is
 * also why there is no `init` and no `system`: those are one brand's envelopes,
 * and what they carry (`model`, `skills`, the turn opening) is what is listed.
 */

import { BrandId, PermissionSuggestion, RateLimits, SessionStatus } from './model';

/**
 * The event as its CLI actually said it, kept beside the reading we made of it.
 *
 * For the log line and the drift check, never for a rule: everything a card
 * shows must come off the fields above, or the seam is decoration. `payload` is
 * whatever was parsed off the wire, unnarrowed — this is the one place a
 * brand's own shape survives, and it survives as `unknown`.
 */
export type RawEvent = {
  source: BrandId;
  /** The brand's own name for this: `result`, `session/update`. */
  nativeType: string;
  payload: unknown;
};

/** Every event may say where it came from. Absent is not "made up" — an adapter
 *  that would only repeat itself is free to leave it off. */
type Sourced = { raw?: RawEvent };

/** How a turn ended, in the three ways a card distinguishes. `interrupted` is
 *  its own outcome rather than an error: it is what the reader asked for. */
export type TurnOutcome = 'done' | 'interrupted' | 'error';

/**
 * Which of a transport's endings latched the exit.
 *
 * Diagnostic only — nothing branches on it — and it is here because two of the
 * three are not a death. `spawn` is a binary that never ran; `stdin` is a write
 * that failed, on a pipe whose process may still be there. A card reading
 * `unknown` says the exit was latched and nothing more, and until this there
 * was no way to ask which callback latched it (`core/session.ts`).
 */
export type ExitSource = 'exit' | 'spawn' | 'stdin';

/**
 * One thing a session did.
 *
 * `status` is the CLI's own word for the coarse state, and it is a statement
 * rather than a derivation — a reducer may still outrank it (an open request
 * beats a `busy` roster line), but nothing here infers it from the presence of
 * other events.
 */
export type SessionEvent = Sourced &
  (
    | {
        kind: 'status';
        status: SessionStatus;
        /** The CLI's own word for this status, where an adapter has one.
         *  Diagnostic: only the `unknown` arm reads it, and that is what it is
         *  for — `notLoaded` and `systemError` are the same card for very
         *  different reasons, and Codex alone states either on the wire. */
        native?: string;
      }
    /** A piece of the message being written, as it is written. */
    | { kind: 'text'; text: string; id?: string }
    /** The same, for reasoning the CLI shows separately from its answer. Its
     *  own kind because a card may draw it differently or not at all, and a
     *  brand that folds the two into one stream must not decide that here. */
    | { kind: 'thought'; text: string }
    | { kind: 'tool-start'; id?: string; name: string; input?: Record<string, unknown> }
    /** Progress within a call that has not finished — output so far, a changed
     *  title. `name` repeats so a consumer that missed the start still has one. */
    | { kind: 'tool-update'; id?: string; name?: string; text?: string }
    | { kind: 'tool-end'; id?: string; name?: string; failed?: boolean }
    /** A turn ended. `turnId` is which one, when the CLI names it — an
     *  adapter that sent the turn recognises its own id and can tell a turn
     *  it started from one the agent started itself. Undefined when the CLI
     *  names none; nothing here reads its spelling.
     *
     *  `outcome` only where the CLI stated how. Absent is "ended, nobody said
     *  how" — a local timeout, a malformed reply, a word we do not know — and
     *  ends activity without recording anything (`endTurn`). */
    | { kind: 'turn-end'; outcome?: TurnOutcome; turnId?: string }
    /**
     * Input tokens one request of the running turn read from the prompt cache,
     * as the CLI counted them. Emitted only where the count was stated, and only
     * for the turn it belongs to: an adapter that hears usage late correlates it
     * first, so a stale reading is never charged to the turn after.
     */
    | { kind: 'cache-read'; tokens: number; input?: number }
    /**
     * The session is blocked on a person, or has stopped being.
     *
     * One kind for both edges, because they are one list: a request is added
     * and later removed, and a consumer holding the open ones needs the same
     * key on the way out. `open: false` carries only `requestId`.
     */
    | {
        kind: 'waiting';
        requestId: string;
        open: boolean;
        /** A question for the reader rather than a permission prompt. */
        ask?: boolean;
        /** Tool name when this is a permission. Absent on an ask. */
        toolName?: string;
        label?: string;
        input?: Record<string, unknown>;
        questions?: PendingQuestion[];
        suggestions?: PermissionSuggestion[];
        canNote?: boolean;
        canReply?: boolean;
        canDenyReason?: boolean;
      }
    /** How much the CLI's own queue is holding. Ours is the panel's outbox and
     *  is never this — see `LiveState.queued`.
     *
     *  `runningId` is which entry the CLI says it is running, when it names
     *  one — the id we sent with the prompt, echoed back. Undefined means the
     *  frame named none, not that nothing is running. An adapter compares it
     *  against the ids it sent to tell a turn it started from one the agent
     *  started itself; nothing here reads its spelling. */
    | { kind: 'queue'; depth: number; runningId?: string }
    | {
        kind: 'usage';
        limits?: RateLimits;
        contextTokens?: number;
        /** The window the same runtime reading explicitly stated. */
        contextWindow?: number;
      }
    | { kind: 'model'; model: string }
    | { kind: 'effort'; effort: string }
    | { kind: 'permission'; mode: string }
    | { kind: 'title'; title: string }
    | { kind: 'exit'; code: number | null; signal: string | null; source?: ExitSource }
  );

/*
 * Two mappings, sketched. Neither adapter exists yet; these are here so the
 * kinds above were chosen against two real wires rather than one.
 *
 * Claude `result` (`core/frames.ts`) → the turn is over:
 *
 *   { kind: 'turn-end',
 *     outcome: frame.subtype === 'error_during_execution' ? 'interrupted' : 'done',
 *     raw: { source: 'claude', nativeType: 'result', payload: value } }
 *
 * `error_during_execution` is the CLI's word for interrupted rather than for a
 * failure to report as one (`core/live.ts`), which is the whole reason
 * `TurnOutcome` separates the two.
 *
 * Grok `_x.ai/sessions/changed` (`docs/reference/cli_state/grok/protocol.md`, 1.0.4) →
 * the roster's activity word for this session:
 *
 *   { kind: 'status',
 *     status: row.activity === 'working' ? 'busy' : 'idle',
 *     raw: { source: 'grok', nativeType: '_x.ai/sessions/changed', payload: value } }
 *
 * The roster carries every session the agent holds, so an adapter picks its own
 * row out first. `pending_interaction.kind: "permission"` on that row is a
 * `waiting` event and not a third status word — `waiting` is the reducer's to
 * derive from the open list, exactly as it is for Claude.
 */
