import { CONTROL_REPLY_MS } from '../startup';
/**
 * Claude's owned handle: stream-json frames on a shared byte pipe.
 *
 * `childTransport` stays in `core/session.ts`. Grok's handle is
 * `core/grok/session.ts`.
 */

import { randomUUID } from 'crypto';
import * as messageFacts from '../message_facts';
import * as recovery from '../recovery';
import * as activity from '../activity';
import type { ChangeOrigin, ConnectOptions, SessionHandle, WarmAttempt } from '../adapter';
import { askRecord } from '../answers';
import { WARM_PROMPT, wrapWarm } from '../coordination/send';
import { defaultsWide, reachableFrom, windowOf } from '../catalog';
import { TurnCheckpoints, endPendingExecution } from '../checkpoint';
import * as executionRuntime from '../execution';
import * as identity from '../identity';
import * as execution from './execution';
import { type AnsweredAsk, localReply } from '../transcript';
import { writeAttachment } from '../record';
import { exchangeForSend } from './tee';
import * as projection from './projection';
import * as usage from './usage';
import {
  Frame,
  ImageBlock,
  controlError,
  controlRequest,
  controlResponse,
  readFrame,
  userMessage
} from './frames';
import {
  LiveState,
  PendingRequest,
  QueuedMessage,
  WARM_MESSAGE_WAITING,
  WARM_NO_CONVERSATION,
  WARM_NOT_IDLE,
  WARM_SESSION_ENDED,
  answered,
  canDrain,
  closeWarm,
  dequeueHead,
  dismissQueued,
  enqueue,
  failWarm,
  initial,
  mergeQueued,
  pingFailed,
  segments,
  pickModel,
  warmDrain,
  warming,
  withExit,
  withTitle,
  withUsage
} from '../live';
import { reduce } from './reduce';
import { type Conversation, Thread, readBaseline, recoverBaseline } from '../thread';
import { TurnCapture } from '../turn_capture';
import { launchTranscriptPath, locateTranscript, recoverWitnessed } from './transcript';
import type { Decision, RateLimits, SendTarget } from '../model';
import type { SessionTransport } from '../session';

/**
 * The launch line, and why each half of it is not optional.
 *
 * `--input-format stream-json` is what makes stdin a protocol rather than a
 * keyboard; `--include-partial-messages` is the live tail; and
 * `--permission-prompt-tool stdio` is the flag without which
 * `AskUserQuestion.isEnabled()` returns false in print mode — no flag, no ask
 * tool at all, and `stdio` is the sentinel that routes permission asks onto
 * this channel rather than to an MCP server.
 *
 * `--session-id` is deliberately **not** here. Every start shares this list,
 * and a resume supplies its own id via `--resume`; a start handed both is a
 * start with two. Claude `launch()` is where the two are exclusive.
 */
export const PROTOCOL_ARGS = [
  '--print',
  '--verbose',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--include-partial-messages',
  '--permission-prompt-tool',
  'stdio'
];

/**
 * The environment a `claude` child is started in, as an overlay: `undefined`
 * deletes a key rather than passing it on.
 *
 * `CLAUDE_CODE_SSE_PORT` is dropped because the `anthropic.claude-code`
 * extension injects it, a CLI that sees it auto-connects to the IDE, and a
 * connected session opens a diff
 * tab on every edit approval — each of which ends in that extension revealing
 * the active terminal and stealing focus nobody asked to move. An owned session
 * has no terminal to reveal, and should not acquire the habit.
 *
 * `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is what buys the reducer a turn's
 * *end* from the CLI rather than from inference: with it set, a
 * `system/session_state_changed` frame states `running` / `idle` /
 * `requires_action`, and the `idle` lands just after the `result`. So a turn
 * whose `result` never arrives still ends, which is the difference between a
 * card that says BUSY for 35 minutes and one that does not. Harmless when
 * unrecognised — a CLI that has never heard of it emits nothing, and `live.ts`
 * falls back to inferring the turn from `init` and the stream
 * (`docs/reference/cli_state/claude/protocol.md`).
 *
 * Beside `PROTOCOL_ARGS` and not inside `childTransport`, which spawns a child
 * for whichever CLI asked: a second brand handed these gets two variables it
 * has never heard of and none of the ones it needs.
 *
 * **`CLAUDE_CODE_DISABLE_1M_CONTEXT` is deliberately not here**, though it is
 * the one variable a launch may now want to set. Everything in this record is
 * true of *every* session we start; the window is true of one. Worse, this
 * record is inherited — a session that spawns its own `claude` passes it down —
 * so a window pinned for one session would silently pin every descendant. It
 * rides `--settings` on the launch line instead (`claude/adapter.ts`), which
 * merges with the reader's own `env` and inherits into nothing.
 */
export const PROTOCOL_ENV: Readonly<Record<string, string | undefined>> = {
  CLAUDE_CODE_SSE_PORT: undefined,
  // Kept by the CLI when inherited (2.1.281 rewrites only `cli` to `sdk-cli`
  // under print mode), and discovery keeps a twin only when it reads `sdk-cli`
  // (`claude/discover.ts`) — so a host started with `claude-vscode` in its
  // environment would strip every owned card of its twin. Unset, the child
  // derives `sdk-cli` from `-p` itself.
  CLAUDE_CODE_ENTRYPOINT: undefined,
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'
};

/**
 * One owned session.
 *
 * The handshake is inverted, which is the one thing to know before reading
 * `send`: streaming input initialises on the **first message**, not on spawn,
 * so there is nothing to wait for here. A client that waited for `system/init`
 * before sending a turn would wait forever — observed as a 180s hang with only
 * `SessionStart` hook frames on the pipe.
 */
export class OwnedSession implements SessionHandle {
  readonly opening: SessionHandle['opening'] = Promise.resolve({ ok: true });
  private live: LiveState;
  private readonly listeners = new Set<
    (state: LiveState, origin: ChangeOrigin, cacheTraffic?: boolean) => void
  >();
  private readonly activity = new Set<() => void>();
  /** Requests of ours awaiting their response, keyed by the id we gave them. */
  private readonly waiting = new Map<
    string,
    {
      resolve: (payload: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextId = 1;
  /**
   * Keep a drain latched until the turn starts or the child exits, so a second
   * idle edge cannot write while the first write remains unacknowledged.
   */
  private writePending = false;
  private readonly messageTurns = new messageFacts.MessageTurns();
  /**
   * Held shut for the length of send-now's interrupt, so the `result` that ends
   * the turn — an idle edge, and one that lands before the `await` resumes when
   * it shares a stdout chunk with the interrupt's own response — cannot drain
   * the outbox before it has been merged. `writePending` cannot stand in: it is
   * cleared by any frame applied while a turn is running (`apply`), and the turn
   * being interrupted is running.
   */
  private sending = false;
  /** The head applying its control target, before its user frame can leave. */
  private targetingId: string | undefined;
  /** Targeted acts whose first frame left, so their remaining prompt cannot be dismissed. */
  private readonly committedTargets = new Set<string>();
  /** Targeted acts the CLI refused; parked at the end of the outbox, not retried. */
  private readonly refusedTargets = new Set<string>();

  /** Every `system` subtype this session has shown us, so each is logged once. */
  private readonly said = new Set<string>();
  /** The title has been asked for. Not `state.title`: the answer lands a second
   *  or so later and every frame in between would otherwise re-ask. */
  private titleAsked = false;
  /** The reader has ended this session, so nothing more is asked of the pipe. */
  private closed = false;
  /**
   * Keep checkpoints on the handle because tryDrain is the only place a turn
   * is released, and drive sees running fall. Scope the index to the conversation
   * so a poisoned one costs one session, not a checkout. Mint an id only for tests
   * omitting one; production always supplies it.
   */
  private readonly checkpoints: TurnCheckpoints;
  private readonly executionRuntime: executionRuntime.ExecutionRuntime;
  private readonly capture: TurnCapture<execution.ExecutionObserver>;
  /**
   * Use a separate capture latch: sendNow clears writePending across awaits,
   * and borrowing sending would let send-now's finally drop this hold or this
   * release drop send-now's. An interrupted result is an idle edge, so that
   * would drain the head before the outbox is merged.
   */
  private capturing = false;
  /** The conversation in memory, and whether what came before it is still
   *  being read — only ever for a resume, so a fresh start drains as it did. */
  private readonly memory: Thread;
  private readonly recoveryPending: () => boolean = () => false;
  private readonly projection = new projection.ClaudeProjection();

  /**
   * Keep methods directly callable by tests; SessionHandle exposes them through
   * capability objects for the support/callability reason in core/adapter.ts.
   */
  readonly messages: SessionHandle['messages'] = {
    images: true,
    pending: () => !this.drainable() || this.live.queued.length > 0,
    send: (text, images, describe, ahead, target, correlation) =>
      this.send(text, images, describe, ahead, target, correlation),
    dismiss: (id) => this.dismiss(id),
    sendNow: () => this.sendNow()
  };
  readonly turn: SessionHandle['turn'] = { interrupt: () => this.interrupt() };
  readonly model: SessionHandle['model'] = {
    set: (model, window) => this.setModel(model, window)
  };
  readonly asks: SessionHandle['asks'] = {
    respond: (requestId, decision) => this.respond(requestId, decision)
  };
  /** This CLI answers for the account on its own pipe, turn running or not
   *  (measured — see the port). So the panel's clock decides when to ask, and
   *  nothing here keeps one. */
  readonly usage: SessionHandle['usage'] = { read: (signal) => this.refreshUsage(signal) };
  readonly warm: SessionHandle['warm'] = { ping: () => this.ping() };
  readonly thread: SessionHandle['thread'];

  constructor(
    private readonly transport: SessionTransport,
    private readonly start: ConnectOptions
  ) {
    start.registerCleanup?.(() => this.close());
    this.live = initial({
      ...start,
      // `sessionId`, not `resume`: `startOwned` passes `resume ?? fresh`, and
      // this CLI files the mint. Grok's constructor keys the other field.
      transcript: start.sessionId ? launchTranscriptPath(start.cwd, start.sessionId) : undefined
    });
    this.executionRuntime = start.execution ?? { runtime: randomUUID(), enabled: false };
    this.checkpoints = new TurnCheckpoints(
      JSON.stringify([
        identity.conversationKey('claude', start.sessionId ?? randomUUID()),
        this.executionRuntime.runtime
      ]),
      this.executionRuntime.contextFile
    );
    this.memory = new Thread({ cwd: start.cwd, brand: 'claude' }, start.sessionId ?? '', {
      log: start.log
    });
    this.capture = new TurnCapture(
      this.checkpoints,
      this.executionRuntime.runtime,
      () => this.memory.current,
      (observer) => (store, turn) => observer.finish(store, turn)
    );
    // At construction, because this CLI has no handshake to wait for: the id is
    // the one `--resume` names, and the first message is what starts the child
    // talking. The CLI's file is found rather than derived — a conversation
    // resumed in another directory, or moved by `EnterWorktree`, is filed
    // elsewhere (`locateTranscript`).
    const resumed = start.resume;
    const recovered = recoverBaseline(
      this.memory.current,
      resumed
        ? () =>
            readBaseline(
              resumed,
              async () => recoverWitnessed((await locateTranscript(start.cwd, resumed)).file),
              start.log
            )
        : undefined,
      { stopped: () => this.closed || this.live.exit !== undefined, log: start.log }
    );
    this.thread = recovery.threadPort(this.memory, Boolean(resumed), recovered);
    this.recoveryPending = recovery.recoveryGate(Boolean(resumed), recovered, () =>
      this.tryDrain()
    );
    // Parse frames in the handle because the shared transport carries only JSON.
    // This is the only line-to-Frame conversion besides models.ts's round trip.
    transport.onLine((value) => {
      const task = this.live.sessionId && execution.completedTask(value, this.live.sessionId);
      if (task && this.live.sessionId)
        void endPendingExecution(
          this.live.cwd,
          identity.conversationKey('claude', this.live.sessionId),
          this.executionRuntime.runtime,
          task,
          this.executionRuntime.contextFile
            ? { contextFile: this.executionRuntime.contextFile, actor: this.live.sessionId }
            : undefined
        );
      this.capture.observer?.take(value);
      // The thread is fed **here, before `handle`**, and not from a second
      // `onLine` listener. Listeners are called in registration order and
      // `handle` ends by draining, so a tee registered after it would take the
      // ordinal of the user turn that drain wrote before the frame it was
      // itself called for.
      //
      // A drain no longer writes inside that call: it waits on its turn
      // checkpoint's baseline first (`tryDrain`), so the prompt takes its slot
      // after any frame that arrived while it ran. Which is the true order —
      // the frame arrived first.
      const frame = readFrame(value);
      this.record(value, frame);
      if (frame) {
        this.handle(frame);
      }
    });
    // No more text once the output has closed; an exit alone is not that.
    const ended = () => this.memory.current.end();
    if (transport.onEnd) transport.onEnd(ended);
    else transport.onExit(ended);
    transport.onExit((info) => {
      const gone = new Error(
        info.stderr ?? `The session ended (${info.signal ?? info.code ?? 'no code'}).`
      );
      for (const [, pending] of this.waiting) {
        clearTimeout(pending.timer);
        pending.reject(gone);
      }
      this.waiting.clear();
      this.writePending = false;
      this.apply(
        withExit(this.live, { code: info.code, signal: info.signal, source: info.source }),
        'agent',
        false
      );
      // After `apply`, so the idle edge above still gets its end capture: a
      // child that died mid-turn wrote whatever it wrote. `close` does this too
      // and the two are idempotent — a card whose child exited stays on the
      // board and may never be stopped by hand.
      void this.checkpoints.endExecution(
        this.executionRuntime.runtime,
        this.executionRuntime.contextFile
      );
    });
  }

  get state(): LiveState {
    return this.live;
  }

  /** Every change, until the returned function is called. */
  onChange(
    listener: (state: LiveState, origin: ChangeOrigin, cacheTraffic?: boolean) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onActivity(listener: () => void): () => void {
    this.activity.add(listener);
    return () => this.activity.delete(listener);
  }

  /**
   * Write only when the session is idle for the drain (canDrain); otherwise
   * the entry waits in state.queued. One write path for every send, without
   * mid-turn injection.
   * Images ride inline as content blocks: no file or prose path.
   * describe names the session instead of text when they differ;
   * see QueuedMessage.describe. Nothing else reads it.
   */
  send(
    text: string,
    images: readonly ImageBlock[] = [],
    describe?: string,
    ahead = false,
    target?: SendTarget,
    correlation?: string
  ): void {
    if (!text && !images.length) {
      return;
    }
    const id = randomUUID();
    const entry: QueuedMessage = {
      id,
      ...(messageFacts.isCorrelation(correlation) ? { correlation } : {}),
      text,
      images: images.length ? [...images] : undefined,
      queuedAt: Date.now(),
      ...(describe !== undefined ? { describe } : {}),
      ...(target !== undefined ? { target } : {})
    };
    const effort = target?.effort?.trim();
    const command: QueuedMessage | undefined = effort
      ? {
          id,
          text: `/effort ${effort}`,
          queuedAt: entry.queuedAt,
          command: true,
          ...(target !== undefined ? { target } : {})
        }
      : undefined;
    const entries = command ? [command, entry] : [entry];
    let next = this.live;
    for (const queued of entries) next = enqueue(next, queued);
    if (ahead) {
      const rest = next.queued.slice(0, -entries.length);
      let at = 0;
      // `targetingId` only covers `setModel`. After `/effort` is written the
      // prompt is still the rest of that act (`committedTargets`) and an ahead
      // send must not slip between them.
      for (let index = 0; index < rest.length; index++) {
        const id = rest[index]?.id;
        if (id !== undefined && (id === this.targetingId || this.committedTargets.has(id))) {
          at = index + 1;
        }
      }
      next = {
        ...next,
        queued: [...rest.slice(0, at), ...entries, ...rest.slice(at)]
      };
    }
    this.apply(next);
    this.tryDrain();
  }

  /**
   * Drop one held message. Report whether its id was still in the outbox, as
   * respond does: another window's reader sees a record up to a publish and
   * poll old. The row may have drained; reporting success would say a running
   * message was cancelled.
   */
  dismiss(id: string): boolean {
    if (this.committedTargets.has(id)) {
      return false;
    }
    const next = dismissQueued(this.live, id);
    if (next === this.live) {
      return false;
    }
    this.refusedTargets.delete(id);
    this.apply(next);
    return true;
  }

  /**
   * Stop the running turn (if any) and send the whole outbox as one message.
   * Confirm lives in the UI — this is the act after Confirm.
   *
   * Sending all N as one message is `tryDrain`'s rule now and not this verb's,
   * so what is left here is the interrupt: the bar offers to send held rows
   * *now*, and now means ending the turn they are waiting on.
   *
   * The drain is still held shut across the interrupt (`sending`). The turn's
   * `result` is an idle edge, so an unguarded drain writes whatever is held the
   * moment the interrupt lands — before the reader's last row, if they typed it
   * while the turn was ending, and whether it beats the `await` here depends on
   * the two frames sharing a stdout chunk. Shut, there is one write, after the
   * interrupt, carrying everything.
   *
   * The outbox is ours, so interrupt does not reconcile against the CLI's
   * `still_queued` (which has never carried anything useful). An interrupt that
   * fails throws before the drain, leaving the rows — and their per-message
   * Dismiss — as they were.
   */
  async sendNow(): Promise<void> {
    this.sending = true;
    try {
      if (this.live.running || this.live.pending.length) {
        await this.interrupt();
      }
    } finally {
      this.sending = false;
    }
    // `writePending`'s escape, for a ping the CLI never acknowledged: should it
    // open after all, `inTurn` reads it as a turn the CLI started itself.
    if (this.live.warmTurn?.phase === 'written') {
      this.apply(closeWarm(this.live, true));
    }
    // The latch's only other exit is the CLI acknowledging a write by starting
    // a turn, opening a request or dying — all three of which also stop the
    // drain. A write it never acknowledges would therefore hold the outbox shut
    // for the life of the session, and this button, which is the reader saying
    // *send it now*, would hit that guard and do nothing at all. Dropping it
    // here costs a duplicate in the case where the write did land and is only
    // slow, and buys an escape from a queue that is otherwise wedged forever.
    this.writePending = false;
    this.tryDrain();
  }

  /**
   * One cache-warming ping, written now or refused now. The same latches the
   * drain reads, plus an empty outbox: a held message is real work, and a ping
   * ahead of it would make the reader wait out a maintenance turn.
   */
  ping(): WarmAttempt {
    const refused = this.warmRefusal();
    if (refused) {
      return { ok: false, reason: refused };
    }
    const entry: QueuedMessage = {
      id: `warm:${randomUUID()}`,
      text: wrapWarm(WARM_PROMPT),
      queuedAt: Date.now()
    };
    this.writePending = true;
    this.transport.write(userMessage(segments(entry)));
    this.recordSend(entry, this.memory.current);
    this.apply(warmDrain(this.live, entry), 'prompt');
    return { ok: true };
  }

  private warmRefusal(): string | undefined {
    if (this.closed || this.live.exit) return WARM_SESSION_ENDED;
    if (!this.live.sessionId) return WARM_NO_CONVERSATION;
    if (this.live.queued.length) return WARM_MESSAGE_WAITING;
    if (
      this.recoveryPending() ||
      this.capturing ||
      this.targetingId !== undefined ||
      this.sending ||
      this.writePending ||
      this.live.status !== 'idle' ||
      !canDrain(this.live)
    ) {
      return WARM_NOT_IDLE;
    }
    return undefined;
  }

  /**
   * A ping reached for a tool: refuse the request if it asked, and cut the
   * turn. Nothing opens on the card, and the latch stays until the turn's own
   * end says it closed.
   */
  private cutWarm(frame: Frame): void {
    if (frame.type === 'control_request') {
      this.transport.write(
        controlResponse(frame.requestId, {
          behavior: 'deny',
          message: 'A keep-alive turn uses no tools.',
          decisionClassification: 'user_reject'
        })
      );
    }
    if (this.live.warmTurn?.failed) {
      return;
    }
    this.apply(failWarm(this.live), 'agent', false);
    void this.interrupt().catch(() => {
      // The turn runs on denied; its own end still closes the latch.
    });
  }

  /**
   * End the running turn. The CLI's `still_queued` is ignored: under a held
   * outbox nothing we care about is in the CLI's queue.
   *
   * The turn ends as `result.subtype = "error_during_execution"`, which is the
   * CLI's word for interrupted rather than a failure to report as one.
   */
  async interrupt(): Promise<void> {
    await this.request('interrupt');
  }

  /**
   * Move this session onto another model, from the next turn.
   *
   * The control request rather than `/model <name>` in a `user` frame. Both are
   * obeyed (observed 2.1.220), and both write the same three entries to the
   * transcript — the slash door is not the dirty one it was assumed to be. What
   * separates them is the pipe: a `user` frame occupies the outbox like a
   * message and queues behind a running turn, and this is a verb the reader did
   * not type.
   *
   * **The blank is refused, and that is the whole reason this method exists**
   * rather than a bare `request('set_model', …)` at the call site. A `set_model`
   * frame with no `model` field answers `success` and silently resets the
   * session to the account's configured default — so the one shape that must
   * never be composed by accident is the one an empty string composes. Throwing
   * beats defaulting: a caller with nothing to say has a bug, and picking a
   * model on its behalf is how a reader loses the model they were on.
   *
   * **The window follows the model, and nothing is refused for it.** Decided
   * with the user 2026-08-28, replacing a rule that fixed the window at spawn.
   *
   * That rule was correct about the mechanics and wrong about the cost. Only
   * the `--settings` flag genuinely holds a session, and it holds a *ceiling*
   * — 200k on any model — not an exact figure; `[1m]` is simply ours to spell
   * again. Refusing everything else meant a session started at 1M could never
   * reach Haiku 4.5 or Opus 4.5, which have no 1M window, and with the gear
   * defaulting to the widest row that was the ordinary case. A menu that
   * quietly stops offering the cheap model is worse than a window that moves.
   *
   * So: ask for the window the reader pressed, spell it where the line leaves
   * room, and record what was asked rather than what we hope.
   *
   * - reachable by `suffix` — spell `[1m]`; the window is ours to promise.
   * - anything else — send the bare id. `plain` lands there; a `flag` window
   *   cannot be spelled at all, because `--settings` was composed at spawn and
   *   no env var can join a running process. The account decides, the next
   *   `result` states it, and where it disagrees with what was asked the card
   *   marks it. **That mark is the warning**: it is the same one a downgraded
   *   start gets, and it needs no new surface.
   *
   * **How the switch reached its window is not recorded, deliberately.** A
   * field named for the launch line that a switch rewrites means neither thing
   * (`TASK_done_window_fixed.md`). The line's own reach is `launchReach`;
   * the pick's is `windowOf(brand, modelPick, windowAsked)`, derived by the one
   * caller that wants it.
   */
  async setModel(model: string, window?: number): Promise<void> {
    const want = model.trim();
    if (!want) {
      throw new Error('A model change needs a model.');
    }
    // Use the pressed window or retain the previous request: older menus send no
    // window, and a session that asked for none should not start claiming a figure.
    const asked = window ?? this.live.windowAsked;
    const target = windowOf('claude', want, asked);
    // The suffix only where this session's own line can still get there.
    // `--settings` was composed at spawn, so a flagged line holds the narrow end
    // whatever the id spells — `claude-opus-5[1m]` on one comes back stating
    // 200k (probed 2026-08-29, 2.1.241). The wire outcome is the same either
    // way; what this buys is that the composer's menu and this send answer
    // through one function and cannot drift apart.
    const reachable = reachableFrom(
      'claude',
      want,
      asked,
      this.live.launchReach,
      defaultsWide(
        'claude',
        this.live.modelPick,
        this.live.windowStated ?? this.live.windowAsked,
        this.live.launchReach
      )
    );
    const send = target?.reach === 'suffix' && reachable ? `${want}[1m]` : want;
    await this.request('set_model', { model: send });
    // Store the raw id because windowOf needs it to find the row, as on a start.
    // Keep asked even when it cannot be spelled: the card marks the gap between
    // the reader's request and the next result.
    this.apply({
      ...pickModel(this.live, want),
      windowAsked: asked,
      windowStated: undefined
    });
  }

  /** Ask for the account's plan usage and hold what comes back; what restamps
   *  an unchanged reading, since `RateLimitFrame` pushes do not. */
  async refreshUsage(signal?: AbortSignal): Promise<RateLimits | undefined> {
    // Await before reading this.live: an earlier snapshot would restore changes
    // made during the wait, including a drained message that would be sent again.
    if (signal?.aborted) return undefined;
    const payload = await this.request('get_usage', undefined, signal);
    if (signal?.aborted) return undefined;
    const reading = usage.readUsage(payload);
    // Stamp on arrival because core/usage.ts ranks readings by when they were taken.
    const next = withUsage(this.live, reading, Date.now());
    this.apply(next);
    // Returning the held reading on a bad answer would suppress the host's fallback.
    return reading ? next.usage : undefined;
  }

  /**
   * Have the CLI name this session, from the first thing it was asked.
   *
   * The one road to a name a session like this has. Nothing titles it
   * otherwise: `ai-title` is written off the interactive UI's own loop, so a
   * print-mode session runs to a thousand turns still called after its
   * directory (observed 2026-07-27 — see `docs/reference/cli_state/claude/transcript.md`).
   *
   * `persist` is what makes this more than a string for our card: the CLI
   * writes the answer to the transcript as its own `ai-title`, so the `/resume`
   * picker and any other window reading that file agree with the panel without
   * being told. Costs one short model call, once, after the first turn.
   *
   * A session nobody has spoken to yet is left alone — there is nothing to name
   * it after, and the CLI would be titling silence.
   */
  async refreshTitle(): Promise<void> {
    const description = this.live.firstPrompt;
    if (description === undefined) {
      return;
    }
    // Same order as `refreshUsage`: await, *then* read the state to build on.
    const titled = await this.request('generate_session_title', {
      description,
      persist: true
    });
    this.apply(withTitle(this.live, titled));
  }

  /**
   * Answer one open request — an ask's picks, or a permission decision.
   *
   * A request that is no longer open is dropped rather than answered. The gap
   * is real and reachable: an interrupt retracts an open permission request
   * about a millisecond after it is asked for, so a pick staged on a card that
   * has just been cancelled would otherwise be posted into nothing.
   *
   * Says which of the two happened, because one caller is a window away and
   * cannot see: a decision posted from another window's panel is answered over
   * `requests.ts`, and reporting a drop as a success is how a reader comes to
   * believe they allowed a call that nothing ever allowed.
   */
  respond(requestId: string, decision: Decision): boolean {
    const request = this.live.pending.find((p) => p.requestId === requestId);
    if (!request) {
      return false;
    }
    // **The record's only sight of an answered ask.** Step 4 measured that
    // `toolUseResult` is nowhere on this pipe, so the picks exist in this
    // process and nowhere else: the CLI writes them into its own transcript,
    // and the `tool_result` that comes back is the tool echoing `answers` — not
    // the record of what was offered. Teed here, beside the request, and filed
    // against the `tool_use` the ask rode in on.
    const record = askRecord(request, decision);
    // An ask whose questions all failed to narrow has nothing to draw, which is
    // the reading `parseAnswered` makes of the same record off disk. It still
    // goes back to the CLI below, as an `answers: {}` — an ask nobody answered
    // is what that already was.
    if (record?.questions.length && request.toolUseId) {
      this.memory.current.note([{ ret: [{ id: request.toolUseId, ask: record }] }]);
    }
    this.transport.write(controlResponse(requestId, body(request, decision, record)));
    this.apply(answered(this.live, requestId));
    this.tryDrain();
    return true;
  }

  async flush(): Promise<void> {
    await executionRuntime.flushAdmission(this.executionRuntime);
    await this.checkpoints.flush();
    await this.thread.recovered;
    await (this.closed ? this.memory.finish() : this.memory.idle());
  }

  /** End the session. The child dies with its stdin. */
  close(): void {
    // Before the latch, because `drive` returns on it: a turn running when the
    // reader stopped the session still wrote whatever it wrote, and rule 1's
    // point is that an ending which is not a completion keeps its diff. The
    // capture is started here and its note takes its slot in the thread now;
    // `endExecution` below runs beside it.
    if (this.capture.running && !this.live.warmTurn)
      this.capture.ended(this.live.cwd, { warm: false, baselining: this.capturing });
    this.apply(messageFacts.abandon(this.live));
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Session closed; control outcome unknown.'));
    }
    this.waiting.clear();
    void this.checkpoints.endExecution(
      this.executionRuntime.runtime,
      this.executionRuntime.contextFile
    );
    this.transport.close();
  }

  /**
   * The two round trips this session owes itself, on the edges that earn them.
   *
   * Here rather than on a listener in `host/sessions.ts`, where they were: both
   * are `control_request`s in this CLI's own vocabulary, and a host loop that
   * fires `get_usage` at every session would fire it at brands that have never
   * heard of it. Failures are swallowed on purpose — neither is anything a card
   * stops working without.
   */
  private drive(state: LiveState): void {
    // A session the reader stopped still emits the last of its frames, and
    // acting on them means asking a closed pipe for a figure no card is left to
    // show.
    if (this.closed) {
      return;
    }
    // Usage is **not** asked for here. A turn ending is when the numbers moved,
    // but a fleet of sessions ending turns is not the account moving any faster,
    // so one machine-wide read per brand follows them (`core/usage_refresh.ts`,
    // `SessionHandle.usage`) rather than a round trip per session.
    // The CLI ends an interrupted turn with a `result` too
    // (`error_during_execution`), so an interrupt reaches capture's falling edge
    // like a completion. A ping is maintenance: nothing is titled off it.
    const warm = state.warmTurn !== undefined;
    const sessionId = state.sessionId;
    this.capture.follow(
      { running: state.running, warm, inFlight: state.inFlight !== undefined, cwd: state.cwd },
      sessionId
        ? {
            owner: identity.conversationKey('claude', sessionId),
            create: () =>
              new execution.ExecutionObserver(sessionId, this.executionRuntime.contextFile)
          }
        : undefined,
      this.capturing
    );
    // Once, on the first running turn: the CLI never titles a session like this
    // by itself. Not at spawn, because the title is generated from what the
    // session was asked — but not at the first idle edge either, which is where
    // this used to sit. A workflow run is one long turn by design, so waiting
    // for a turn to end left those cards on `agent-3f` for the whole run.
    //
    // `state.running` is what keeps this in probed territory rather than one
    // clause earlier. `send` applies the enqueue before it drains, so a latch on
    // `firstPrompt` alone writes the control request *before* the first `user`
    // frame — and `init` does not arrive until that frame does (§The handshake
    // is inverted). Mid-turn is the case that was measured: answered in 1.2s,
    // still hours before any idle edge (probed 2026-08-03,
    // `docs/reference/cli_state/claude/protocol.md`).
    //
    // Not asked at all for a session somebody **named** — a decision, which a
    // generated title landing on top of would be the card renaming itself out
    // from under them. A prompt crop is not one and no longer counts as one:
    // it used to go out as `--name`, which held this latch shut for every card
    // the panel made (sessions.md, "`--name` is a decision").
    if (
      !warm &&
      !this.titleAsked &&
      !this.start.named &&
      state.running &&
      !state.exit &&
      state.firstPrompt !== undefined
    ) {
      this.titleAsked = true;
      void this.refreshTitle().catch(() => {
        // A name is the most droppable thing on a card. The placeholder holds,
        // and the next running turn may ask again.
        this.titleAsked = false;
      });
    }
  }

  private request(
    subtype: string,
    fields?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const requestId = `squadron-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        signal?.removeEventListener('abort', cancel);
        reject(
          new Error(`No response to ${subtype}; outcome unknown. The request was not repeated.`)
        );
      }, CONTROL_REPLY_MS);
      // A late answer to a cancelled request finds no waiter and is dropped.
      const cancel = (): void => {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        reject(new Error(`${subtype} cancelled; outcome unknown.`));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.waiting.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', cancel);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', cancel);
          reject(error);
        },
        timer
      });
      try {
        this.transport.write(controlRequest(requestId, subtype, fields));
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handle(frame: Frame): void {
    if (frame.type === 'system') {
      // Keyed by state too, so `session_state_changed` says whether its `idle`
      // ever arrived.
      const said = frame.state ? `${frame.subtype} ${frame.state}` : frame.subtype;
      if (!this.said.has(said)) {
        this.said.add(said);
        this.start.log?.(`frame: pid ${this.transport.pid ?? '?'} system/${said}`);
      }
    }
    if (frame.type === 'control_response') {
      const pending = this.waiting.get(frame.requestId);
      if (pending) {
        this.waiting.delete(frame.requestId);
        clearTimeout(pending.timer);
        if (frame.ok) {
          pending.resolve(frame.payload ?? {});
        } else {
          pending.reject(new Error(frame.error ?? 'The session refused the request.'));
        }
      }
    } else if (frame.type === 'control_request' && frame.subtype !== 'can_use_tool') {
      // Silence would leave the CLI waiting on a reply that is never coming.
      // `request_user_dialog` is the one this is known to hit; the error
      // envelope is from the bundle's schema and has not been seen on the wire.
      this.transport.write(
        controlError(frame.requestId, `${frame.subtype} is not supported here.`)
      );
    }
    const cut = warming(this.live) && reachesForTool(frame);
    if (cut && frame.type === 'control_request') {
      this.cutWarm(frame);
      this.tryDrain();
      return;
    }
    if (frame.type === 'conversation_reset') {
      // The reducer drops the title with the conversation it was generated from,
      // and the next one has to be asked for again. This latch is what asks, and
      // it is cleared nowhere else on the success path — so without this line a
      // `/clear` costs the card its name for the life of the process, falling
      // back to `<basename>-<pid>` and publishing `nameSource: 'derived'`.
      this.titleAsked = false;
    }
    const completedWarm = warming(this.live) && frame.type === 'result' && frame.outcome === 'done';
    const reduced = reduce(this.live, frame);
    this.apply(
      frame.type === 'rate_limit_event' ? withUsage(reduced, frame.usage, Date.now()) : reduced,
      'agent',
      completedWarm || reachedModel(frame)
    );
    if (cut) {
      this.cutWarm(frame);
    }
    // A ping refused before its turn opened ends on a `result` and no `init`.
    if (frame.type === 'result' && this.live.warmTurn?.phase === 'written') {
      this.writePending = false;
      this.apply(closeWarm(this.live, pingFailed(frame.outcome)), 'agent');
    }
    if (frame.type === 'stream_event' && frame.text !== undefined && !frame.parentToolUseId) {
      for (const listener of this.activity) listener();
    }
    // A result / idle / retract may free the next held message.
    this.tryDrain();
  }

  /**
   * One frame into the thread: root text streams under its message and block,
   * the block's `assistant` frame closes that row — cut off when the frame says
   * `aborted` — and every other line takes a slot of its own. A subagent's
   * frames and the CLI's replayed echoes stay out (`lineForFrame`).
   *
   * Never await into the pipe reader: the thread writes behind, and a stalled
   * store must not stop the session reading its pipe.
   */
  private record(value: unknown, frame: Frame | undefined): void {
    try {
      if (frame?.type === 'system' && frame.subtype === 'init' && frame.sessionId) {
        this.memory.begin(frame.sessionId);
      } else if (frame?.type === 'conversation_reset') {
        this.memory.reset();
      }
      this.projection.take(this.memory.current, value, frame, this.live.cwd, this.live.running);
    } catch {
      // Recording is best-effort; a failed projection must not stop frame reduction.
    }
  }

  readout(text: string): void {
    this.memory.current.note([localReply(text, Date.now())]);
  }

  /**
   * A drained message, drawn the moment it is sent and recorded under the
   * conversation it was drained from — a /clear can land during the baseline
   * wait. Its images are copied for writeAttachment's reason, and arrive with
   * the build; a failed copy costs the picture, not the turn.
   */
  private recordSend(head: QueuedMessage, conversation: Conversation): void {
    if (head.command) return;
    const at = Date.now();
    conversation.pending(
      `send:${randomUUID()}`,
      async (sessionId) => {
        // Positional, so a copy that failed costs its own picture and moves no
        // other one onto a neighbouring message's turn.
        const refs = await Promise.all(
          (head.images ?? []).map((image) => writeAttachment(sessionId, image))
        );
        return exchangeForSend(head, at, refs);
      },
      exchangeForSend(head, at)
    );
  }

  private apply(next: LiveState, origin: ChangeOrigin = 'local', cacheTraffic?: boolean): void {
    next = this.messageTurns.apply(this.live, next);
    if (next === this.live) {
      return;
    }
    // Latch clears once a turn is running, a request is open, or the child is
    // gone — any of which means the write was taken or will never be.
    if (this.writePending && (next.running || next.pending.length > 0 || next.exit)) {
      this.writePending = false;
    }
    if (
      next.warmTurn &&
      activity.advancesCacheClock({
        origin,
        running: next.running,
        wasRunning: this.live.running,
        cacheTraffic
      })
    ) {
      next = { ...next, warmTurn: { ...next.warmTurn, trafficAt: Date.now() } };
    }
    this.memory.current.observeWarm(next.warmTurn);
    this.live = next;
    for (const listener of this.listeners) {
      listener(next, origin, cacheTraffic);
    }
    // Drive after listeners so the card shows the edge before its round trip.
    this.drive(next);
  }

  /**
   * Write the outbox when idle, as one message. Everything held goes together:
   * a reader who queued three while a turn ran wants the session to read all
   * three before it moves, and N turns has it act on the first having seen
   * none of the rest. Same rule the CLI's own TUI applies to its queue
   * (`docs/reference/cli_state/claude/protocol.md`), and the reason send-now
   * merges — that button is now only the interrupt.
   *
   * Still one write per call, so the latch and the retire rule are unchanged;
   * there is simply nothing left behind it. Anything typed after this write
   * lands in an empty outbox and goes on the next idle.
   */
  private tryDrain(): void {
    if (!this.drainable()) return;

    const leading = this.live.queued[0];
    this.apply(
      leading && this.committedTargets.has(leading.id)
        ? this.live
        : mergeQueued(this.live, this.refusedTargets)
    );
    const head = this.live.queued[0];
    if (!head || this.refusedTargets.has(head.id)) {
      return;
    }
    // Rule 1: the baseline is taken **before the turn is released**, not after
    // it starts, or the writes of its own first seconds land in the gap and are
    // charged to the turn before. So the write waits on it — 43ms warm, 566ms
    // cold, capped at `SPAWN_MS`, and a capture that fails costs one turn's
    // pills and nothing else.
    //
    // The outbox is held shut across the await by two latches, not one.
    // `writePending` cannot be held here at all — `sendNow` clears it
    // unconditionally, which is the escape hatch its comment describes — and
    // `sending` alone has the same hole: the turn has not been released yet, so
    // `live.running` is false, `sendNow` skips the interrupt, its `finally`
    // drops the latch and a second drain takes the same head. That writes the
    // prompt twice and `dequeueHead` eats the next queued message unsent.
    // Send-now is the button people press while a turn is starting.
    this.capturing = true;
    // Read here and not at the write: a `/clear` inside the baseline's window
    // rolls `live.sessionId` and the thread's conversation, and this turn
    // belongs to the conversation it was drained from.
    const under = this.live.sessionId;
    const conversation = this.memory.current;
    const turn = randomUUID();
    void (async () => {
      const enabled = under
        ? await executionRuntime.admitExecution(this.executionRuntime, 'claude', under, turn)
        : false;
      if (this.closed) return;
      await this.checkpoints.open(
        this.live.cwd,
        under
          ? {
              owner: identity.conversationKey('claude', under),
              runtime: this.executionRuntime.runtime,
              turn,
              enabled
            }
          : undefined
      );
      this.capture.install(
        under
          ? new execution.ExecutionObserver(under, this.executionRuntime.contextFile)
          : undefined
      );
    })().then(() => {
      this.capturing = false;
      void this.release(conversation);
    });
  }

  private drainable(): boolean {
    return (
      !this.closed &&
      !this.recoveryPending() &&
      !this.capturing &&
      this.targetingId === undefined &&
      !this.sending &&
      !this.writePending &&
      canDrain(this.live)
    );
  }

  /**
   * Re-read after the baseline await because the outbox may have gained a
   * message or the reader may have stopped the session. mergeQueued must use
   * the current outbox to choose the head.
   */
  private async release(conversation: Conversation): Promise<void> {
    // Re-check because a frame during the baseline may reopen a turn or request;
    // writing then would inject mid-turn. Keep the rows for the next idle edge.
    if (
      this.closed ||
      this.targetingId !== undefined ||
      this.sending ||
      this.writePending ||
      !canDrain(this.live)
    ) {
      this.capture.discard();
      return;
    }
    const before = this.live.queued[0];
    this.apply(
      before && this.committedTargets.has(before.id)
        ? this.live
        : mergeQueued(this.live, this.refusedTargets)
    );
    let head = this.live.queued[0];
    if (!head || this.refusedTargets.has(head.id)) {
      this.capture.discard();
      return;
    }
    if (!this.committedTargets.has(head.id) && head.target !== undefined) {
      this.committedTargets.add(head.id);
      if (head.target.model !== undefined) {
        this.targetingId = head.id;
        const observer = this.capture.observer;
        let failed = false;
        try {
          await this.setModel(head.target.model, head.target.window);
        } catch {
          this.committedTargets.delete(head.id);
          this.refusedTargets.add(head.id);
          failed = true;
        } finally {
          this.targetingId = undefined;
        }
        if (failed) {
          this.capture.discard();
          this.tryDrain();
          return;
        }
        if (
          this.closed ||
          this.sending ||
          this.writePending ||
          !canDrain(this.live) ||
          this.capture.observer !== observer
        ) {
          this.capture.discard();
          this.tryDrain();
          return;
        }
        head = this.live.queued[0];
        if (!head || !this.committedTargets.has(head.id)) {
          this.capture.discard();
          return;
        }
      }
    }
    this.writePending = true;
    this.transport.write(userMessage(segments(head)));
    // The CLI never echoes a prompt, so this is the only place a user turn can
    // reach the thread.
    this.recordSend(head, conversation);
    this.apply(dequeueHead(this.live), head.command ? 'local' : 'prompt');
    if (!head.command) this.committedTargets.delete(head.id);
  }
}

/**
 * The session's own model began answering: the only frame that proves the
 * request reached the API. A 529 or a signed-out turn runs from `init` to an
 * `api_error` result with no `message_start` (protocol.md, the outcome table),
 * and a subagent's message reads its own prefix, not the session's.
 */
function reachedModel(frame: Frame): boolean {
  return frame.type === 'stream_event' && frame.event === 'message_start' && !frame.parentToolUseId;
}

/** A ping asking for a tool, or starting one under an allow rule. */
function reachesForTool(frame: Frame): boolean {
  return (
    (frame.type === 'control_request' && frame.subtype === 'can_use_tool') ||
    (frame.type === 'stream_event' && frame.toolName !== undefined)
  );
}

/**
 * The response body for one decision.
 *
 * `decisionClassification` is told the truth, because it is the CLI's own
 * telemetry and a host that leaves it out has the CLI guess conservatively on
 * its behalf.
 *
 * An allow echoes the tool's input back with the answers *added* rather than a
 * rebuilt input in its place: the ask's questions may carry fields this repo
 * does not parse, and they have to survive the round trip.
 */
function body(
  request: PendingRequest,
  decision: Decision,
  record: AnsweredAsk | undefined
): Record<string, unknown> {
  if (!decision.allow) {
    return {
      behavior: 'deny',
      message: decision.message ?? 'Denied from Squadron.',
      decisionClassification: 'user_reject'
    };
  }
  const input = request.input ?? {};
  // Decide by request kind because asks can be picked, typed or both.
  // An allow carrying neither writes answers: {}, which is what an ask nobody
  // answered already was.
  // Omit empty annotations: the CLI has no reason to read them, nor the panel to write them.
  // Build notes from answers so they cannot name an omitted question.
  // Use one derivation for CLI and record to avoid disagreement between their picks.
  const answers = record?.answers ?? {};
  const annotations = record?.annotations ?? {};
  const updatedInput = record
    ? {
        ...input,
        answers,
        ...(Object.keys(annotations).length ? { annotations } : {})
      }
    : input;
  const permissions = decision.always ? (request.suggestions ?? []).map((s) => s.raw) : [];
  return {
    behavior: 'allow',
    updatedInput,
    ...(permissions.length ? { updatedPermissions: permissions } : {}),
    decisionClassification: permissions.length ? 'user_permanent' : 'user_temporary'
  };
}
