import { OPEN_REQUEST_MS } from '../startup';
/**
 * An owned Grok session on ACP stdio.
 *
 * Handshake (1.0.4): `initialize` → `authenticate` (first non-interactive
 * method) → `session/new`, or `session/load` when `start.resume` is set.
 * Then one `session/prompt` per drain, and `session/cancel` as a
 * notification. The panel outbox stays ours; Grok's `_x.ai/queue/changed`
 * is observed, not written.
 */

import { randomUUID } from 'crypto';
import * as messageFacts from '../message_facts';
import * as checkpointRecord from '../checkpoint_record';
import * as recovery from '../recovery';
import { WARM_PROMPT, delivered, sentTurns, wrapWarm } from '../coordination/send';
import { AcpClient, AcpExited, JsonRpcFailure, REQUEST_CANCELLED, type JsonRpcId } from '../acp';
import * as activity from '../activity';
import type { ChangeOrigin, ConnectOptions, SessionHandle, WarmAttempt } from '../adapter';
import { askRecord } from '../answers';
import { catalogFor } from '../catalog';
import { TurnCheckpoints, endPendingExecution } from '../checkpoint';
import * as executionRuntime from '../execution';
import * as identity from '../identity';
import * as execution from './execution';
import type { SessionEvent, TurnOutcome } from '../events';
import {
  LiveState,
  type QueuedContent,
  type QueuedMessage,
  type WarmTurn,
  WARM_MESSAGE_WAITING,
  WARM_NO_CONVERSATION,
  WARM_NOT_IDLE,
  WARM_SESSION_ENDED,
  applyEvent,
  applyEvents,
  answered,
  canDrain,
  closeWarm,
  closesTurn,
  dequeueHead,
  dismissQueued,
  enqueue,
  failWarm,
  initial,
  pingFailed,
  mergeQueued,
  openWritten,
  segments,
  reachesForTool,
  warmDrain,
  warming,
  withExit
} from '../live';
import type { Decision, ImageBlock, SendTarget } from '../model';
import { type RecordLine, writeAttachment } from '../record';
import { localReply } from '../transcript';
import type { SessionTransport } from '../session';
import { acceptedPayload, parseAsk } from './asks';
import {
  autoAllow,
  parsePermission,
  permissionPayload,
  type PermissionChoices
} from './permissions';
import { effortOption, eventsFrom, outcomeOf, updatePayload, metaOf } from './reduce';
import { type Close, GrokTee, type Teed } from './tee';
import * as projection from './projection';
import { type Conversation, Thread, readBaseline, recoverBaseline } from '../thread';
import {
  grokTranscriptPath,
  readGrokChrome,
  readSentUserUpdate,
  sentEchoWindow,
  recoverWitnessed,
  type Answered
} from './transcript';

/** The catalog default for a model, sent after a switch that names no effort. */
function modelEffortDefault(model: string): string | undefined {
  return catalogFor('grok').find((row) => row.value === model)?.defaultEffort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativePromptId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const update = updatePayload(value);
  const id =
    update?.prompt_id ?? value.promptId ?? metaOf(value)?.promptId ?? value.runningPromptId;
  return typeof id === 'string' ? id : undefined;
}

export type AcpPromptBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Handshake `image: false` is a lie on 1.0.4; CLI size drops are notices, not RPC errors. */
export function promptBlocks(text: string, images: readonly ImageBlock[] = []): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [];
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const image of images) {
    blocks.push({ type: 'image', data: image.data, mimeType: image.mediaType });
  }
  return blocks;
}

/** The row a drain sent, the copies of its pictures, and the thread slot it
 *  took when it went, until its echo lands. */
type Unechoed = {
  row: QueuedContent;
  refs: Promise<readonly (ImageRef | undefined)[]>;
  /** The echo the pipe carried for it (`GrokTee.sent`), once it has. */
  echo?: RecordLine;
  /** Wakes the echo worker when its live witness lands. */
  heard: () => void;
};

/**
 * A prompt we sent, recorded as what we sent: one turn per message a merge
 * folded in (`sentTurns`). Grok writes a prompt of several blocks as one chunk
 * each under one ordinal (1.0.46, `updates.jsonl`), and the tee keeps only the
 * first — so the echo is the witness, its ordinal and its time, and the row is
 * the content. The ordinal rides the first turn's own line.
 *
 * **No echo still records it**, unwitnessed and at the time it was sent: an
 * interrupted, failed or killed turn is the one whose question the reader
 * most needs, and the CLI writes no echo for some of them.
 */
async function sentInPlaceOf(
  echo: RecordLine | undefined,
  unechoed: Unechoed,
  sentAt: number
): Promise<RecordLine[]> {
  const line = echo && projection.isPrompt(echo) ? echo : undefined;
  const turns = sentTurns(unechoed.row, await unechoed.refs, line?.at ?? sentAt);
  if (!turns.length) return line ? [line] : [];
  const m = line && 'm' in line && typeof line.m === 'string' ? line.m : undefined;
  return m ? turns.map((turn, index) => (index ? turn : { ...turn, m })) : turns;
}

/**
 * Model output, or a turn the CLI says finished: the evidence a request reached
 * the API. A refused turn is `retry_state`, the prompt's echo and an `error`
 * close, none of them output (transcript.md, "Immediate-fail order").
 */
function reachedModel(event: SessionEvent): boolean {
  return (
    event.kind === 'text' ||
    event.kind === 'thought' ||
    event.kind === 'tool-start' ||
    (event.kind === 'turn-end' && event.outcome === 'done')
  );
}

/** Roster `working`: on this brand only `_x.ai/sessions/changed` maps to a status. */
function rosterBusy(event: SessionEvent): boolean {
  return event.kind === 'status' && event.status === 'busy';
}

/**
 * Whether a recorded user turn is the echo of the held row: it reads as one of
 * the row's messages does. The tee hands over whatever user chunk arrives next,
 * and under Send now that can be the echo of the prompt before — a turn of its
 * own, which a row taken on arrival would have overwritten. Any message rather
 * than the first, because Grok drops a picture under 512 pixels (1.0.46), and
 * then the first chunk it echoes is the next message's words.
 */
function echoes(line: RecordLine, unechoed: Unechoed): boolean {
  if (!projection.isPrompt(line)) return false;
  return (unechoed.row.parts ?? [unechoed.row]).some((part) => {
    const said = delivered(part.text);
    return line.role === said.role && line.text === said.text.trim() && line.from === said.from;
  });
}

/** `grok.com` is the interactive OAuth method (1.0.4). Anything else in
 *  `authMethods` is treated as headless. Do not hardcode `cached_token`. */
export function pickAuth(hello: unknown): string | undefined {
  if (!isRecord(hello)) {
    return undefined;
  }
  const methods = Array.isArray(hello.authMethods) ? hello.authMethods : [];
  const ids = methods.flatMap((row) =>
    isRecord(row) && typeof row.id === 'string' ? [row.id] : []
  );
  const meta = isRecord(hello._meta) ? hello._meta : {};
  const preferred =
    typeof meta.defaultAuthMethodId === 'string' ? meta.defaultAuthMethodId : undefined;
  const interactive = (id: string) => id === 'grok.com';
  if (preferred && !interactive(preferred) && ids.includes(preferred)) {
    return preferred;
  }
  return ids.find((id) => !interactive(id));
}

/** How long a trigger holds for `init_progress` before firing anyway. Measured
 *  2026-08-17: three servers settled well inside 10s. A CLI that stops sending
 *  the frame gets the old racy behaviour rather than a login that never starts. */
export const GROK_MCP_INIT_MS = 15_000;

/**
 * Has Grok finished attempting every MCP server on this session?
 *
 * `_x.ai/mcp/init_progress` is `{ total, connected, sessionId }`. `connected`
 * counts servers it has finished *attempting* — a handshake that failed for
 * want of auth still counts, measured with slack among the three — so this is
 * the gate for "init is over", not a health check.
 */
export function initSettled(params: unknown): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const { total, connected } = params as { total?: unknown; connected?: unknown };
  if (typeof total !== 'number' || typeof connected !== 'number') return false;
  return total > 0 && connected >= total;
}

class ModelRejected extends Error {}

export class GrokSession implements SessionHandle {
  private live: LiveState;
  private readonly listeners = new Set<
    (state: LiveState, origin: ChangeOrigin, cacheTraffic?: boolean) => void
  >();
  private readonly activity = new Set<() => void>();
  private readonly client: AcpClient;
  private readonly log: ConnectOptions['log'];
  private grokId: string | undefined;
  private opened = false;
  readonly opening: Promise<{ ok: true } | { ok: false; reason: string; cause?: 'pick' }>;
  private writePending = false;
  /** The outbox row whose effort/prompt is on the wire, so dismiss and ahead cannot split it. */
  private drainingId: string | undefined;
  /** Targeted acts the CLI refused; parked at the end of the outbox, not retried. */
  private readonly refusedTargets = new Set<string>();
  private sending = false;
  /**
   * `sendNow` bumps this so a late or missing prompt RPC cannot end another
   * drain's turn. Late `turn_completed` notifications use the `promptId` gate.
   */
  private drainGen = 0;
  /**
   * The `_meta.promptId`s we most recently sent, newest last.
   *
   * The queue echoes ours back on `runningPromptId` (1.0.5 probe,
   * 2026-08-25), so this is what tells our own turn from one Grok started
   * itself. Bounded because only the running turn is ever asked about and
   * this CLI runs one at a time — a session's whole history would be a leak
   * for no extra answer.
   */
  private readonly sentPrompts: string[] = [];
  /** The held prompt's id: only its named close may end our turn.
   *  Cleared wherever `writePending` is. */
  private ownedTurn: string | undefined;
  /**
   * The running turn's id when the queue named one we did not send, else
   * undefined.
   *
   * Cleared by a matching `turn_completed` on the notification stream, or
   * overwritten by the next queue frame. **The drain's own turn-ends do not
   * touch it** — the RPC result and `sendNow` apply `turn-end` directly and
   * never reach `noteRunningTurn` — so it can hold a dead id after a
   * `sendNow` on a latched wake until the next queue frame arrives. Benign,
   * because `canWrite` also requires `running`, and the next thing to run is
   * a prompt of ours, which the queue names.
   */
  private foreignTurn: string | undefined;
  /** The running turn was opened by roster `working` alone, while idle with
   *  nothing on the wire. Reset on the first frame after the card idles. */
  private rosterOpened = false;
  private closed = false;
  private readonly messageTurns = new messageFacts.MessageTurns();
  private chromeGen = 0;
  /** `capturing` holds the baseline await. `wasRunning` folds four closers into
   *  one idle edge. See `tryDrain` for why the other latches cannot substitute. */
  private readonly checkpoints: TurnCheckpoints;
  private readonly executionRuntime: executionRuntime.ExecutionRuntime;
  private executionObserver?: execution.ExecutionObserver;
  private captureWake?: () => void;
  private capturing = false;
  private wasRunning = false;
  /**
   * A turn we did not release began while `capturing` was held.
   *
   * Latched rather than re-checked on the far side of the baseline, because a
   * wake that both starts *and* ends inside those 43ms leaves `canDrain` true
   * again and no trace of itself on the state — and the snapshot is still of
   * the span before it.
   */
  private baselineDirty = false;
  /**
   * Sticky until a drain writes. Read by every drain because the turn-end
   * `sendNow` applies frees `canDrain`: a `send` already awaiting `ready` can
   * resume before the drain `sendNow` starts. Whichever wins must write.
   */
  private urgentDrain = false;
  /**
   * The newest ping's `promptId`, kept past its reply: `turn_completed` carries
   * the ping's usage, and it can land after the reply has closed the latch.
   */
  private warmPrompt: string | undefined;
  /** A named receipt can outlive subsequent pings. Released with this owned conversation. */
  private readonly warmPrompts = new Map<string, WarmTurn>();
  private readonly realPrompts = new Set<string>();

  readonly messages: NonNullable<SessionHandle['messages']> = {
    // Handshake says false; the wire takes them. See `promptBlocks`.
    images: true,
    pending: () => !this.drainable() || this.live.queued.length > 0,
    send: (text, images, describe, ahead, target, correlation) =>
      this.send(text, images, describe, ahead, target, correlation),
    dismiss: (id) => this.dismiss(id),
    sendNow: () => this.sendNow()
  };
  readonly turn: NonNullable<SessionHandle['turn']> = { interrupt: () => this.interrupt() };
  readonly asks: NonNullable<SessionHandle['asks']> = {
    respond: (requestId, decision) => this.respond(requestId, decision)
  };
  readonly warm: SessionHandle['warm'] = { ping: () => this.ping() };
  private readonly askIds = new Map<string, JsonRpcId>();
  private readonly permChoices = new Map<string, PermissionChoices>();
  /**
   * The call an open ask rode in on, by request id.
   *
   * Held here rather than on `PendingRequest.toolUseId` the way Claude's is:
   * that field is filled by the reducer, and this phase does not change
   * `reduce.ts`. `_x.ai/ask_user_question` carries `toolCallId`
   * (`cli_state/grok/protocol.md`) and both `parseAsk` and the `waiting` event
   * drop it, so the record's only way back to the call is this map.
   */
  private readonly askCalls = new Map<string, string>();
  private effortValues = new Set<string>();
  private readonly tee: GrokTee;
  /** The conversation in memory, named once `session/new` or `session/load` has,
   *  and whether a resume is still reading what came before it. */
  private readonly memory: Thread;
  /** The echo poll's waits in flight, which the reader stopping cuts short. */
  private readonly pauses = new Set<() => void>();
  private readonly echoWork = new Set<Promise<void>>();
  private readonly recoveryPending: () => boolean = () => false;
  private readonly projection: projection.GrokProjection;
  readonly thread: SessionHandle['thread'];

  constructor(
    private readonly transport: SessionTransport,
    start: ConnectOptions
  ) {
    // Same split as `launch()`: skip off is `--permission-mode default` (ask);
    // on or unset is `--always-approve`. Probe 2026-08-17: no live mode string.
    start.registerCleanup?.(() => this.close());
    this.live = {
      ...initial({
        ...start,
        transcript: start.resume ? grokTranscriptPath(start.cwd, start.resume) : undefined
      }),
      permissionMode: start.skipPermissions === false ? 'ask' : 'always-approve'
    };
    this.tee = new GrokTee(start.cwd, start.sessionId ?? '');
    this.log = start.log;
    this.memory = new Thread({ cwd: start.cwd, brand: 'grok' });
    this.projection = new projection.GrokProjection(
      (conversation, line) => this.heard(conversation, line),
      start.log
    );
    // Keyed on the id the caller stated, minting one where it did not — the
    // same fallback `ClaudeSession` uses, which is tests only. `owner` scopes
    // the git index a capture warms, so a poisoned one costs a session rather
    // than the checkout.
    this.executionRuntime = start.execution ?? { runtime: randomUUID(), enabled: false };
    this.checkpoints = new TurnCheckpoints(
      JSON.stringify([
        identity.conversationKey('grok', start.sessionId ?? randomUUID()),
        this.executionRuntime.runtime
      ]),
      this.executionRuntime.contextFile
    );
    this.client = new AcpClient(transport);
    this.client.onNotification((method, params) => this.receive(method, params));
    this.client.onRequest((id, method, params) => {
      const promptId = nativePromptId(params);
      if (
        promptId &&
        this.historicalPrompt(promptId) &&
        (method === 'session/request_permission' || method === '_x.ai/ask_user_question')
      ) {
        this.refuseWarm(id, method, params, false);
        return;
      }
      // Ahead of the auto-allow and of the card: a ping asks nothing, and
      // nothing it asked is published.
      if (
        warming(this.live) &&
        (method === 'session/request_permission' || method === '_x.ai/ask_user_question')
      ) {
        this.refuseWarm(id, method, params);
        return;
      }
      if (method === 'session/request_permission') {
        const parsed = parsePermission(params);
        if (!parsed) {
          this.client.fail(id, { code: -32602, message: 'Invalid params' });
          return;
        }
        // 2026-08-17: `--always-approve` still emits leftover bash as this
        // RPC. Skip-on answers it; skip-off is the dialog. Asks stay below.
        // Spawn snapshot only — a later live mode switch would leave this stale.
        if (start.skipPermissions !== false) {
          const body = permissionPayload(parsed.choices, autoAllow(parsed.choices));
          if (!body) {
            this.client.fail(id, { code: -32602, message: 'Invalid params' });
            return;
          }
          this.client.reply(id, body);
          return;
        }
        const requestId = String(id);
        this.askIds.set(requestId, id);
        this.permChoices.set(requestId, parsed.choices);
        this.apply(
          applyEvent(this.live, {
            kind: 'waiting',
            requestId,
            open: true,
            ask: false,
            toolName: parsed.toolName,
            label: parsed.label,
            input: parsed.input,
            suggestions: parsed.suggestions
          }),
          'agent'
        );
        return;
      }
      if (method !== '_x.ai/ask_user_question') {
        return;
      }
      const questions = parseAsk(params);
      if (!questions.length) {
        // JSON-RPC error (2026-08-16): tool `failed`, turn `end_turn`. A
        // permission-shaped fallback cannot be accepted on this wire.
        this.client.fail(id, { code: -32602, message: 'Invalid params' });
        return;
      }
      const requestId = String(id);
      this.askIds.set(requestId, id);
      if (isRecord(params) && typeof params.toolCallId === 'string' && params.toolCallId) {
        this.askCalls.set(requestId, params.toolCallId);
      }
      this.apply(
        applyEvent(this.live, {
          kind: 'waiting',
          requestId,
          open: true,
          ask: true,
          questions,
          canNote: false,
          canReply: false,
          label: 'Ask User',
          input: isRecord(params) ? params : undefined
        }),
        'agent'
      );
    });
    // No more text once the output has closed; an exit alone is not that
    // (`SessionTransport.onEnd`). Cut first: `end` closes a row from its
    // streamed prose, and the tee's line also carries the calls.
    const ended = () => {
      this.closeLine({ cut: true });
      this.memory.current.end();
    };
    if (transport.onEnd) transport.onEnd(ended);
    else transport.onExit(ended);
    transport.onExit((info) => {
      // The echo poll has nothing left to wait for.
      for (const wake of this.pauses) wake();
      this.closeLine({ cut: true });
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
    this.opening = this.open(start);
    // After the handshake, which is what names the conversation. The baseline
    // is read off disk; a load's own replay is not one (the tee drops it,
    // `replayed`).
    const recovered = this.opening.then(async (result) => {
      const resumed = this.grokId;
      if (!result.ok || !resumed) return true;
      return recoverBaseline(
        this.memory.current,
        start.resume
          ? async () => {
              let theirs: ReadonlyMap<string, Answered> = new Map();
              const baseline = await readBaseline(
                resumed,
                async () => {
                  const read = await recoverWitnessed(grokTranscriptPath(start.cwd, resumed));
                  theirs = read.answered;
                  return read;
                },
                start.log
              );
              if (!baseline.ours || baseline.missing) this.projection.installHistory(theirs);
              return baseline;
            }
          : undefined,
        { stopped: () => this.stopped(), log: start.log }
      );
    });
    const historyState = recovery.historyState(Boolean(start.resume), recovered);
    this.thread = {
      get historyState() {
        return historyState();
      },
      generation: () => this.memory.current.generation,
      snapshot: () => this.memory.snapshot(),
      recovered,
      onChange: (listener) => this.memory.onChange(listener)
    };
    this.recoveryPending = recovery.recoveryGate(Boolean(start.resume), recovered, () => {
      this.projection.release(this.memory.current);
      void this.tryDrain();
    });
    void this.opening.then((result) => {
      if (result.ok) {
        void this.tryDrain();
      }
    });
  }

  private receive(method: string, params: unknown): void {
    const promptId = nativePromptId(params);
    if (this.observeExecution(method, params, promptId)) {
      return;
    }
    const events = this.recordNotification(method, params);
    const historical = promptId ? this.warmPrompts.get(promptId) : undefined;
    if (
      promptId &&
      this.historicalPrompt(promptId) &&
      (!historical || historical.id !== this.live.warmTurn?.id)
    ) {
      this.admitHistorical(promptId, historical, events);
      return;
    }
    if (historical?.phase === 'closed') {
      this.apply(
        applyEvents(
          this.live,
          events.filter((event) => event.kind === 'cache-read')
        ),
        'local'
      );
      return;
    }
    this.applyLive(events);
  }

  /** Answers whether the frame is a child session's, which goes no further. */
  private observeExecution(method: string, params: unknown, promptId: string | undefined): boolean {
    const ended = this.grokId ? execution.completedTask(method, params) : undefined;
    if (ended && this.grokId)
      void endPendingExecution(
        this.live.cwd,
        identity.conversationKey('grok', this.grokId),
        this.executionRuntime.runtime,
        ended.task,
        this.executionRuntime.contextFile
          ? { contextFile: this.executionRuntime.contextFile, actor: ended.actor }
          : undefined
      );
    const childSession =
      this.grokId &&
      isRecord(params) &&
      typeof params.sessionId === 'string' &&
      params.sessionId !== this.grokId;
    if (!this.live.warmTurn && (childSession || !promptId || !this.historicalPrompt(promptId)))
      this.executionObserver?.take(method, params);
    return Boolean(childSession);
  }

  /** The frame, recorded into the thread, as events with its named turn-ends settled. */
  private recordNotification(method: string, params: unknown): readonly SessionEvent[] {
    // **Before `eventsFrom`, and from the raw notification.** A tee fed the
    // events would never see a load replay — `eventsFrom` has already
    // narrowed those to `[]` — and could not tell a dropped kind from a
    // dropped turn. Claude's tee sits in the same place for the same reason.
    const late = this.record(method, params);
    // **Text a close already ended opens no turn.** It is the cut message's,
    // and it landed there; read as live prose it would re-busy a card whose
    // closers have all spoken, with nothing left to idle it.
    const events = eventsFrom(method, params, this.grokId).filter(
      (event) => !(late && event.kind === 'text')
    );
    for (const event of events) {
      if (event.kind === 'turn-end' && event.turnId)
        this.apply(
          this.messageTurns.settle(this.live, event.turnId, event.outcome),
          'local',
          false
        );
    }
    return events;
  }

  /** A frame of a prompt no longer live: its ping's cache usage, and a close no live turn owns. */
  private admitHistorical(
    promptId: string,
    historical: WarmTurn | undefined,
    events: readonly SessionEvent[]
  ): void {
    for (const event of events) {
      if (event.kind !== 'cache-read' || !historical) continue;
      const updated = this.memory.current.recordWarmUsage(event.tokens, event.input, historical);
      if (updated) this.warmPrompts.set(promptId, updated);
    }
    if (
      !historical &&
      !this.live.warmTurn &&
      this.live.running &&
      this.ownedTurn === undefined &&
      this.foreignTurn === undefined
    ) {
      const closes = events.flatMap((event) => {
        if (event.kind !== 'turn-end') return [];
        const taken = this.admitClose(event, this.foreignTurn);
        return taken ? [taken] : [];
      });
      this.apply(applyEvents(this.live, closes), 'local', false);
      void this.tryDrain();
    }
  }

  private applyLive(events: readonly SessionEvent[]): void {
    // Roster idle is not a turn boundary: Grok repeats it for this id
    // while `session/prompt` is still on the wire, and after a monitor
    // wake (2026-08-17, 01a00dcb) it never flips to working at all.
    // `turn-end` (prompt result or `turn_completed`) is what idles us —
    // except on a turn roster `working` opened, which names no turn and so
    // has no other closer; `canWrite` cannot free it either. Wakes emit no
    // roster frame (protocol.md § Everything that cannot close a wake).
    if (!this.live.running) this.rosterOpened = false;
    if (!this.live.running && !this.writePending && events.some(rosterBusy)) {
      this.rosterOpened = true;
    }
    const foreign = this.foreignTurn;
    this.noteRunningTurn(events);
    const swallowed = events.some((event) => this.closesSomeoneElsesTurn(event, foreign));
    const holding = this.writePending || (this.live.running && !this.rosterOpened);
    const cut = warming(this.live) && events.some(reachesForTool);
    const pinged = this.closesPing(events);
    const admitted = events.flatMap((event) => {
      if (holding && event.kind === 'status' && event.status === 'idle') return [];
      if (event.kind === 'cache-read') return pinged ? [event] : [];
      const taken = this.admitClose(event, foreign);
      return taken ? [taken] : [];
    });
    const completion = warming(this.live)
      ? admitted.find((event) => event.kind === 'turn-end')
      : undefined;
    if (admitted.some(closesTurn)) this.openWritten();
    let next = applyEvents(this.live, admitted);
    if (completion?.kind === 'turn-end') next = closeWarm(next, pingFailed(completion.outcome));
    this.apply(next, 'agent', admitted.some(reachedModel));
    if (cut) {
      this.cutWarm();
    }
    // A foreign close still retires its active tool, while our prompt keeps running.
    if (swallowed) {
      this.apply({ ...this.live, activeTool: undefined }, 'agent', false);
    }
    if (events.some((event) => event.kind === 'text')) {
      for (const listener of this.activity) listener();
    }
    // A frame may free the outbox with no other caller to notice.
    // tryDrain no-ops when nothing is held.
    void this.tryDrain();
  }

  get state(): LiveState {
    return this.live;
  }

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

  async flush(): Promise<void> {
    await executionRuntime.flushAdmission(this.executionRuntime);
    await this.checkpoints.flush();
    await this.thread.recovered;
    do {
      while (this.echoWork.size) await Promise.allSettled(this.echoWork);
      await (this.closed ? this.memory.finish() : this.memory.idle());
    } while (this.echoWork.size);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    // See drive's closed guard: a later onExit must not capture behind end.
    this.apply(messageFacts.abandon(this.live));
    this.closed = true;
    for (const wake of this.pauses) wake();
    // A turn that ended on tools has its line still open; the child is going.
    this.closeLine({ cut: true });
    if (this.wasRunning && !this.live.warmTurn) {
      this.endCheckpoint(this.live.cwd);
    }
    void this.checkpoints.endExecution(
      this.executionRuntime.runtime,
      this.executionRuntime.contextFile
    );
    this.transport.close();
  }

  send(
    text: string,
    images: readonly ImageBlock[] = [],
    describe?: string,
    ahead = false,
    target?: SendTarget,
    correlation?: string
  ): void | Promise<void> {
    const effort = target?.effort?.trim();
    const hold = () => {
      const entry = {
        id: randomUUID(),
        ...(messageFacts.isCorrelation(correlation) ? { correlation } : {}),
        text,
        images: images.length ? [...images] : undefined,
        queuedAt: Date.now(),
        ...(describe !== undefined ? { describe } : {}),
        ...(target !== undefined ? { target } : {})
      };
      let next = enqueue(this.live, entry);
      if (ahead) {
        const rest = next.queued.slice(0, -1);
        let at = 0;
        if (this.drainingId !== undefined) {
          for (let index = 0; index < rest.length; index++) {
            if (rest[index]?.id === this.drainingId) at = index + 1;
          }
        }
        next = { ...next, queued: [...rest.slice(0, at), entry, ...rest.slice(at)] };
      }
      this.apply(next);
      void this.tryDrain();
    };
    // `effortValues` is the model in force. A named model is checked after
    // `set_model`, in the drain: `xhigh` is legal on 4.7 and refused on 4.5.
    if (effort && !target?.model?.trim() && !this.effortValues.has(effort)) {
      return this.setEffort(effort).then(hold);
    }
    hold();
  }

  /**
   * `session/set_model`. The check is `_meta.model.Ok`.
   * `_meta.reasoningEffort` on this request swallows a bad value (protocol.md).
   */
  private async setModel(model: string, opening?: ConnectOptions): Promise<void> {
    let changed: unknown;
    try {
      const params = { sessionId: this.grokId, modelId: model };
      changed = opening
        ? await this.openingRequest(opening, 'session/set_model', params)
        : await this.client.request('session/set_model', params);
    } catch (err) {
      // Grok 1.0.62 rejects this model field with -32602 / unknown model id.
      if (err instanceof JsonRpcFailure && err.code === -32602 && err.data === 'unknown model id')
        throw new ModelRejected(err.data);
      if (err instanceof JsonRpcFailure && typeof err.data === 'string' && err.data) {
        throw new Error(err.data);
      }
      throw err;
    }
    const meta = isRecord(changed) && isRecord(changed._meta) ? changed._meta : undefined;
    const modelResult = meta && isRecord(meta.model) ? meta.model : undefined;
    const applied = modelResult?.Ok;
    if (applied !== model) {
      throw new Error(`Grok did not apply model ${model}.`);
    }
  }

  private async setEffort(effort: string): Promise<void> {
    let changed: unknown;
    try {
      changed = await this.client.request('session/set_config_option', {
        sessionId: this.grokId,
        configId: 'reasoning_effort',
        value: effort
      });
    } catch (err) {
      if (err instanceof JsonRpcFailure && typeof err.data === 'string' && err.data) {
        throw new Error(err.data);
      }
      throw err;
    }
    const applied = isRecord(changed) ? effortOption(changed.configOptions) : undefined;
    if (applied?.current !== effort) {
      throw new Error(`Grok did not apply reasoning_effort ${effort}.`);
    }
    this.effortValues = new Set(applied.values);
  }

  dismiss(id: string): boolean {
    if (id === this.drainingId) {
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

  async sendNow(): Promise<void> {
    this.sending = true;
    try {
      // `ownedTurn`: our prompt is on the wire before its turn opens, and a
      // second one written over it uncancelled would leave the first unsettled.
      if (
        this.live.running ||
        this.ownedTurn !== undefined ||
        this.live.pending.length ||
        warming(this.live)
      ) {
        await this.interrupt();
      }
    } finally {
      this.sending = false;
    }
    // Cancel is a notify. It cannot idle us: a turn the CLI has already
    // finished leaves `running` true and `tryDrain` no-ops forever
    // (01a02d08 — disk `turn_ended`, card still busy, queued text never
    // reached `chat_history.jsonl`). The reader asked to send now.
    this.drainGen += 1;
    this.writePending = false;
    // Cut before turn-end for the checkpoint ordering in tryDrain's finally.
    this.closeLine({
      cut: true,
      interrupted: [this.ownedTurn, ...(this.live.running ? [this.foreignTurn] : [])].filter(
        (turn): turn is string => turn !== undefined
      )
    });
    this.ownedTurn = undefined;
    this.drainingId = undefined;
    this.openWritten();
    if (this.live.running) {
      this.apply(applyEvent(this.live, { kind: 'turn-end', outcome: 'interrupted' }));
    }
    // A ping the CLI never opened has no turn to end; cancelled all the same.
    if (warming(this.live)) {
      this.apply(closeWarm(this.live, true));
    }
    this.urgentDrain = true;
    void this.tryDrain();
  }

  interrupt(): Promise<void> {
    if (this.grokId) {
      // Notification, not a request — a mid-turn cancel is `session/cancel`
      // without an id (1.0.4). The in-flight `session/prompt` then returns
      // `stopReason: "cancelled"`.
      this.client.notify('session/cancel', { sessionId: this.grokId });
    }
    // Claude retracts an open ask via `control_cancel_request` on the same
    // interrupt. Grok has no equivalent notification (1.0.4 / 1.0.5): the
    // prompt result idles `running` and leaves `pending`, so the card stays
    // `waiting` and the dialog never drops. Fail the RPCs rather than
    // `reject-once` — a deny is a decision the reader did not make.
    for (const req of [...this.live.pending]) {
      const rawId = this.askIds.get(req.requestId);
      if (rawId !== undefined) {
        this.client.fail(rawId, { code: REQUEST_CANCELLED, message: 'Cancelled' });
      }
      this.askIds.delete(req.requestId);
      this.permChoices.delete(req.requestId);
      this.askCalls.delete(req.requestId);
      this.apply(answered(this.live, req.requestId));
    }
    return Promise.resolve();
  }

  /**
   * One cache-warming ping, written now or refused now. The drain's own
   * latches, strictly: a ping never rides a turn Grok started itself, and
   * never jumps a held message, which is real work.
   */
  ping(): WarmAttempt {
    const target = this.warmTarget();
    if ('reason' in target) {
      return { ok: false, reason: target.reason };
    }
    const entry: QueuedMessage = {
      id: `warm:${randomUUID()}`,
      text: wrapWarm(WARM_PROMPT),
      queuedAt: Date.now(),
      warm: true
    };
    this.writePending = true;
    // `prompt` reaches the wire before its first await.
    void this.prompt(entry, target.grokId).then((sent) => (sent ? this.tryDrain() : undefined));
    return { ok: true };
  }

  /** The conversation a ping may be written to now, or why not. */
  private warmTarget(): { grokId: string } | { reason: string } {
    if (this.closed || this.live.exit) return { reason: WARM_SESSION_ENDED };
    const grokId = this.opened ? this.grokId : undefined;
    if (!grokId) return { reason: WARM_NO_CONVERSATION };
    if (this.live.queued.length) return { reason: WARM_MESSAGE_WAITING };
    if (
      this.recoveryPending() ||
      this.writePending ||
      this.capturing ||
      this.sending ||
      this.live.status !== 'idle' ||
      !canDrain(this.live)
    ) {
      return { reason: WARM_NOT_IDLE };
    }
    return { grokId };
  }

  /** A ping's request, refused before it reaches the card or the auto-allow. */
  private refuseWarm(id: JsonRpcId, method: string, params: unknown, cutCurrent = true): void {
    const choices = method === 'session/request_permission' ? parsePermission(params) : undefined;
    const body = choices && permissionPayload(choices.choices, { allow: false });
    if (body) {
      this.client.reply(id, body);
    } else {
      this.client.fail(id, {
        code: REQUEST_CANCELLED,
        message: 'A keep-alive turn uses no tools.'
      });
    }
    if (cutCurrent) this.cutWarm();
  }

  /**
   * A ping reached for a tool: mark it failed and cancel the turn. The latch
   * stays until the turn's own end says it closed.
   */
  private cutWarm(): void {
    const warm = this.live.warmTurn;
    if (!warm || warm.failed) {
      return;
    }
    this.apply(failWarm(this.live), 'agent', false);
    if (warming(this.live)) {
      void this.interrupt();
    }
  }

  /** The frame closes the newest ping by its id, so the usage it carries is
   *  the ping's, however late it arrives. */
  private closesPing(events: readonly SessionEvent[]): boolean {
    return (
      this.warmPrompt !== undefined &&
      events.some((event) => event.kind === 'turn-end' && event.turnId === this.warmPrompt)
    );
  }

  respond(requestId: string, decision: Decision): boolean {
    const request = this.live.pending.find((p) => p.requestId === requestId);
    const rawId = this.askIds.get(requestId);
    if (!request || rawId === undefined) {
      return false;
    }
    const choices = this.permChoices.get(requestId);
    const body = request.ask
      ? acceptedPayload(request.questions ?? [], decision)
      : choices
        ? permissionPayload(choices, decision)
        : undefined;
    if (!body) {
      return false;
    }
    this.client.reply(rawId, body);
    // **The record's only sight of an answered ask.** `chat_history.jsonl`
    // keeps the questions as the tool's `arguments` and the answer as a
    // *sentence* (`cli_state/grok/protocol.md`), so the picks exist in this
    // process and nowhere else. Teed beside the request, and **through the
    // tee** so it lands on the call rather than ahead of it — `GrokTee.answered`
    // is where that rule lives.
    const call = this.askCalls.get(requestId);
    const answeredAsk = askRecord(request, decision);
    if (call && answeredAsk?.questions.length) {
      this.note(this.memory.current, this.tee.answered(call, answeredAsk));
    }
    this.askIds.delete(requestId);
    this.permChoices.delete(requestId);
    this.askCalls.delete(requestId);
    this.apply(answered(this.live, requestId));
    void this.tryDrain();
    return true;
  }

  private async openingRequest(
    start: ConnectOptions,
    method: string,
    params?: unknown,
    cap = OPEN_REQUEST_MS
  ): Promise<unknown> {
    start.opening?.check();
    if (this.closed) throw new Error('Session closed while opening.');
    const value = await this.client.request(
      method,
      params,
      start.opening?.remaining(cap) ?? cap,
      start.opening?.signal
    );
    start.opening?.check();
    if (this.closed) throw new Error('Session closed while opening.');
    return value;
  }

  private failOpening(start: ConnectOptions): void {
    if (start.failOpening) start.failOpening();
    else this.transport.close();
  }

  private async open(
    start: ConnectOptions
  ): Promise<{ ok: true } | { ok: false; reason: string; cause?: 'pick' }> {
    try {
      const hello = await this.openingRequest(start, 'initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'squadron', version: '0' },
        // False, not omitted: advertising read/write without answering
        // `fs/*` requests is how a turn hangs on a permission we never see.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      });
      const methodId = pickAuth(hello);
      if (!methodId) {
        this.failOpening(start);
        return { ok: false, reason: 'Grok has no non-interactive sign-in available.' };
      }
      await this.openingRequest(start, 'authenticate', { methodId });
      // `sessionId` on a fresh start is a mint, not a load — 1.0.4
      // `session/load` of an unknown id is `FS_NOT_FOUND`, not a new session.
      const created = start.resume
        ? await this.openingRequest(start, 'session/load', {
            sessionId: start.resume,
            cwd: start.cwd,
            mcpServers: []
          })
        : await this.openingRequest(start, 'session/new', {
            cwd: start.cwd,
            mcpServers: []
          });
      const sessionId =
        isRecord(created) && typeof created.sessionId === 'string'
          ? created.sessionId
          : start.resume;
      if (!sessionId) {
        this.failOpening(start);
        return { ok: false, reason: 'Grok did not open a session.' };
      }
      this.grokId = sessionId;
      this.memory.begin(sessionId);
      const effort = isRecord(created) ? effortOption(created.configOptions) : undefined;
      this.effortValues = new Set(effort?.values ?? []);
      this.tee.bindSession(sessionId);
      this.apply({
        ...this.live,
        sessionId,
        // The CLI's id is minted here, or restated on load. The dock reads
        // `chat_history.jsonl` (1.0.4).
        transcript: grokTranscriptPath(start.cwd, sessionId),
        model: this.live.model ?? start.model,
        effort: effort?.current ?? this.live.effort
      });
      // `-m` changes Grok's handshake but `session/new` still opens on the
      // account default (observed on 1.0.4 and 1.0.41). Pin the new session
      // before its first prompt; a load keeps the conversation's own model.
      if (!start.resume && start.model?.startsWith('grok')) {
        try {
          await this.setModel(start.model, start);
        } catch (error) {
          this.failOpening(start);
          return {
            ok: false,
            reason:
              error instanceof ModelRejected
                ? `Grok could not select model ${start.model}.`
                : error instanceof Error
                  ? error.message
                  : 'Grok model selection failed.',
            ...(error instanceof ModelRejected ? { cause: 'pick' as const } : {})
          };
        }
      }
      start.opening?.check();
      if (this.closed) throw new Error('Session closed while opening.');
      this.opened = true;
      void this.refreshChrome();
      return { ok: true };
    } catch (error) {
      this.failOpening(start);
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'Grok could not open the conversation.'
      };
    }
  }

  /**
   * Which turn the CLI says is running, kept off `_x.ai/queue/changed`.
   *
   * The test is **an id we did not send**, never the `task-completed-` prefix
   * a background-task wake happens to use — that is one wake kind's spelling
   * and not a contract (`cli_state/grok/protocol.md` § Closing a self-started
   * turn). Runs from the notification handler only; the field's own doc says
   * what that means for the two turn-ends that never reach here.
   */
  private noteRunningTurn(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.kind === 'turn-end') {
        // Only when the turn that ended **is** the foreign one, so a late or
        // duplicate `turn_completed` for an earlier turn cannot clear a wake
        // that is still running. Hardening: reverting it alone fails nothing,
        // because a stray `turn-end` also clears `running` and `canDrain`
        // then lets the drain through anyway. It is here so the invariant
        // this gate rests on is the one the code actually has. An unnamed
        // close still clears — a CLI that names no turn gives us nothing
        // better to go on.
        if (event.turnId === undefined || event.turnId === this.foreignTurn) {
          this.foreignTurn = undefined;
        }
      } else if (event.kind === 'queue') {
        if (event.runningId && !this.warmPrompts.has(event.runningId))
          this.realPrompts.add(event.runningId);
        this.foreignTurn =
          event.runningId !== undefined && !this.sentPrompts.includes(event.runningId)
            ? event.runningId
            : undefined;
      }
    }
  }

  /**
   * A wake's close, arriving while our own drained prompt is still on the wire.
   *
   * `endTurn` clears `inFlight` whenever a turn was running (`core/live.ts`),
   * and it is allowed to because `canDrain` only ever took a message while
   * idle. `canWrite` breaks that premise deliberately — it takes one *during*
   * a turn we did not start — so without this the wake's `turn_completed`
   * wipes the `inFlight` of a message we drained behind it and idles the card
   * while `writePending` still holds the drain shut. That is the outbox
   * regression the predecessor traced: `sending` goes falsy, `draining` goes
   * true, and the next held message paints as *sent* with no outbox block and
   * no Send-now button. Live the window is our whole prompt, not a millisecond
   * — Grok runs ours only after the wake finishes.
   *
   * So the wake's close is dropped and our own RPC result is left to end the
   * turn, which is the second closer this whole fix exists to provide. Only
   * while we hold that RPC: with no drain in flight the wake's close is the
   * only closer there is, and swallowing it would recreate the latch.
   */
  private closesSomeoneElsesTurn(event: SessionEvent, foreign: string | undefined): boolean {
    return (
      event.kind === 'turn-end' &&
      // Not `writePending`: that also holds while only the effort change is on
      // the wire, and a wake's close swallowed then, with the change refused,
      // leaves nothing to close the wake.
      this.ownedTurn !== undefined &&
      event.turnId !== undefined &&
      event.turnId === foreign
    );
  }

  /**
   * A frame, as this session lets it through: a named close that is not the
   * active owned turn's ends nothing, or ends activity and states nothing.
   *
   * R3 of `REVIEW_session_failed_status_plan.md`: `prompt_id` is exact, so a
   * close for turn A arriving during B — a late duplicate, or the cancel Send
   * now provoked — would otherwise end B, and with an outcome paint B failed
   * while it runs. While a prompt is held, any other id is dropped. With none
   * held, a retained historical real id is stale for its outcome but may still
   * be the only close a re-busied card gets — A's frames re-busy it after Send
   * now, or after its reply — so it passes without one, unless a wake has a
   * closer of its own. A currently named self-started turn or an unknown id,
   * with no prompt held, passes whole, as does an unnamed close: a CLI that
   * names no turn gives us nothing better to go on.
   */
  private admitClose(event: SessionEvent, foreign: string | undefined): SessionEvent | undefined {
    if (event.kind !== 'turn-end' || event.turnId === undefined) return event;
    if (this.closesSomeoneElsesTurn(event, foreign)) return undefined;
    if (event.turnId === this.ownedTurn || event.turnId === foreign) return event;
    if (this.ownedTurn !== undefined) return undefined;
    if (!this.historicalPrompt(event.turnId)) return event;
    return foreign === undefined ? { ...event, outcome: undefined } : undefined;
  }

  /**
   * Whether the drain may write, which is `canDrain` plus one exception.
   *
   * **A turn nobody asked for may not hold the outbox shut.** A turn Grok
   * starts itself has exactly one closer — `turn_completed` — where one we
   * sent has two, and roster `idle` is filtered while it runs, so a single
   * frame that never arrives leaves `running` true forever and every queued
   * message refused. Step 0 (2026-08-25) probed every other candidate closer
   * and found none: `response_completed` is per model call, `prompt_complete`
   * never fires for a wake, the roster emits nothing at either edge, the
   * queue opens the turn but never closes it, `session/cancel` on an idle
   * agent returns silence, and `session/list` carries no activity field.
   *
   * What is left is to write. A `session/prompt` sent during a wake is queued
   * behind it and resolves with its own id — probed both ways, because the
   * client cannot tell a wake still running from one whose close was lost.
   * That result is then the second closer the card was missing.
   *
   * Narrow on purpose: a turn **we** started keeps the drain shut, since we
   * hold its RPC and `writePending` is the lock that makes `sendNow` the
   * escape hatch. `exit` and an open ask still refuse, exactly as before.
   */
  private canWrite(): boolean {
    return (
      canDrain(this.live) ||
      (this.foreignTurn !== undefined &&
        this.live.running &&
        !this.live.exit &&
        this.live.pending.length === 0)
    );
  }

  /** Newest last, oldest dropped. 16 is far more than the one turn the CLI
   *  runs at a time, and bounds a session that sends all day. */
  private mintPromptId(): string {
    const id = randomUUID();
    this.sentPrompts.push(id);
    if (this.sentPrompts.length > 16) {
      this.sentPrompts.shift();
    }
    return id;
  }

  private drainable(): boolean {
    return (
      !this.closed &&
      !this.recoveryPending() &&
      this.opened &&
      Boolean(this.grokId) &&
      !this.writePending &&
      !this.capturing &&
      !this.sending &&
      this.canWrite()
    );
  }

  private async tryDrain(): Promise<void> {
    // Must not be called from `open`: this wait is how a send that raced
    // the handshake holds until `session/new` lands.
    await this.opening.catch(() => undefined);
    if (!this.drainable() || !this.grokId) return;
    // Check queued before capture: mergeQueued mutates, and every notification
    // calls tryDrain. An empty outbox would waste a 43ms round trip and leave
    // a baseline for an idle edge whose turn never began in that window.
    // mergeQueued still re-reads after the capture.
    if (!this.live.queued.some((row) => !this.refusedTargets.has(row.id))) {
      return;
    }
    // Rule 1: the baseline is taken **before the turn is released**, not after
    // it starts, or the writes of its own first seconds land in the gap and are
    // charged to the turn before. 43ms warm, 566ms cold, capped at `SPAWN_MS`,
    // and a capture that fails costs one turn's pills and nothing else.
    //
    // Held shut across that await by `capturing`, which is a latch of its own
    // and not one of the three above. `writePending` cannot do it — `sendNow`
    // clears that one unconditionally, which is the escape hatch its comment
    // describes — and neither can `drainGen`: `sendNow` is the only place that
    // bumps it, so `send`, `respond`, `ready`, this method's own tail and the
    // end of every notification all share one generation and would pass the
    // same gate, snapshot the same number, and send a second `session/prompt`.
    //
    // Ahead of `mergeQueued` and `dequeueHead`, so a drain that bails on the
    // far side of the await leaves the outbox exactly as it found it.
    //
    // Skipped outright on a turn Grok started itself: `canWrite` lets a drain
    // run *during* a wake, and a baseline taken there would span the wake's
    // tail plus our own turn and charge one to the other. That turn then draws
    // no checkpoint pills, which is the silence the wake already gets.
    //
    // **Never once Send now has been pressed**, and that exception was paid
    // for. Before this task `sendNow` cleared the latch and reached the write
    // with no await in between, so nothing could arrive to shut the gate again.
    // The baseline opens a 43ms window, and a stray frame re-busying our own
    // already-ended turn inside it makes `canWrite` false at the re-check below
    // — the drain returns, the message stays queued, and the card is latched
    // busy with no way out. That is precisely the state Send now exists to
    // escape, and `grok_session.test.ts`'s latched-`sendNow` case caught it:
    // intermittently at the real 43ms, every time with the window widened to
    // 200ms. One turn's pills is the documented cost of a capture that does not
    // happen; a wedged outbox is not.
    if (canDrain(this.live) && !this.urgentDrain) {
      this.baselineDirty = false;
      this.capturing = true;
      try {
        const under = this.grokId;
        const turn = randomUUID();
        const enabled = under
          ? await executionRuntime.admitExecution(this.executionRuntime, 'grok', under, turn)
          : false;
        if (this.closed) return;
        await this.checkpoints.open(
          this.live.cwd,
          under
            ? {
                owner: identity.conversationKey('grok', under),
                runtime: this.executionRuntime.runtime,
                turn,
                enabled
              }
            : undefined
        );
        this.executionObserver = under
          ? new execution.ExecutionObserver(under, this.executionRuntime.contextFile)
          : undefined;
      } finally {
        this.capturing = false;
      }
      // A frame that arrived while the baseline ran may have re-opened the turn
      // or opened a request, and a write then would be the mid-turn injection
      // this one road exists to prevent. The outbox keeps its rows and the next
      // idle edge drains them.
      //
      // Discard the baseline: the next idle edge (a wake, Send now or exit)
      // would otherwise diff a window that turn never started in.
      if (this.closed || this.writePending || this.sending || !this.canWrite()) {
        this.checkpoints.discard();
        this.executionObserver = undefined;
        return;
      }
      // **A wake ran inside the baseline's window.** `canWrite` still lets us
      // write — that exception exists to rescue a turn nobody can close — but
      // the snapshot above is of the idle span *before* the wake, so keeping it
      // would charge the wake's writes to our turn. The same reasoning that
      // skips `open` for a drain riding a wake, applied to one that arrives
      // after `open` has already been paid for.
      //
      // A latch is needed: a wake that starts and finishes
      // inside the window — `self-started` closes itself 60ms in — leaves
      // `canDrain` true again, so the state reads as the quiet session it was
      // when the baseline was taken. `|| !canDrain(this.live)` is unreachable:
      // this block is entered only from `canDrain`, `canWrite` above already
      // refuses `exit` and an open ask, so the one way back to `!canDrain` is
      // `running` turning on during the await — which is the latch.
      if (this.baselineDirty) {
        this.checkpoints.discard();
        this.executionObserver = undefined;
      }
    }
    // See mergeQueued for why the outbox goes as one prompt.
    this.apply(mergeQueued(this.live, this.refusedTargets));
    const [head] = this.live.queued;
    if (!head || this.refusedTargets.has(head.id)) {
      // Dismissed inside the baseline's window: the row this drain took a
      // baseline for is gone, so the baseline is too. `mergeQueued` cannot
      // empty a non-empty outbox, so this is only reachable after the await.
      this.checkpoints.discard();
      this.executionObserver = undefined;
      return;
    }
    this.writePending = true;
    this.drainingId = head.id;
    const named = head.target?.model?.trim();
    const switching = Boolean(named) && named !== this.live.model;
    if (switching && named) {
      try {
        await this.setModel(named);
      } catch {
        this.writePending = false;
        this.drainingId = undefined;
        this.checkpoints.discard();
        this.executionObserver = undefined;
        this.refusedTargets.add(head.id);
        this.apply(mergeQueued(this.live, this.refusedTargets));
        await this.tryDrain();
        return;
      }
      if (this.closed || this.live.queued[0]?.id !== head.id) {
        this.writePending = false;
        this.drainingId = undefined;
        this.checkpoints.discard();
        this.executionObserver = undefined;
        await this.tryDrain();
        return;
      }
      // `model_changed` for set_model arrives on the next call (1.0.50).
      if (this.live.model !== named) this.apply({ ...this.live, model: named });
    }
    // set_model keeps the effort, including one the new model does not offer
    // (protocol.md, 1.0.50). Send the target's, or that model's default.
    const effort = switching
      ? head.target?.effort?.trim() || modelEffortDefault(named ?? '')
      : head.target?.effort?.trim();
    if (effort) {
      try {
        await this.setEffort(effort);
      } catch {
        this.writePending = false;
        this.drainingId = undefined;
        this.checkpoints.discard();
        this.executionObserver = undefined;
        this.refusedTargets.add(head.id);
        this.apply(mergeQueued(this.live, this.refusedTargets));
        await this.tryDrain();
        return;
      }
      if (this.closed || this.live.queued[0]?.id !== head.id) {
        this.writePending = false;
        this.drainingId = undefined;
        this.checkpoints.discard();
        this.executionObserver = undefined;
        await this.tryDrain();
        return;
      }
    }
    // Cleared on the write and not in `sendNow`, so the flag outlives whichever
    // drain bailed and is spent by whichever one actually reaches the wire.
    this.urgentDrain = false;
    if (await this.prompt(head, this.grokId)) {
      await this.tryDrain();
    }
  }

  /**
   * One prompt on the wire, held until its reply ends the turn. Written before
   * the first await, so a caller that needs the write to have happened (a
   * ping's admission) has it on return. Resolves false when Send now moved
   * past the reply.
   *
   * `writePending` is the caller's to set: the drain holds it across an effort
   * change before this.
   */
  private async prompt(head: QueuedMessage, grokId: string): Promise<boolean> {
    const gen = this.drainGen;
    // The prompt is on the wire. Its turn opens on the CLI's first frame and
    // reads busy until then (`shownStatus`); roster activity can arrive later,
    // or never for this id. Every close of it opens it first (`openWritten`).
    this.apply(head.warm ? warmDrain(this.live, head) : dequeueHead(this.live), 'prompt');
    // Started here and awaited by the echo worker — never between the
    // dequeue above and the write below. An `await` there leaves the card
    // saying busy with nothing on the wire, and an interrupt arriving in that window
    // cancels a prompt the CLI has not been sent (measured: the `slow` case
    // deadlocked, the fake waiting for a cancel that had already gone by).
    const conversation = this.memory.current;
    let heard: () => void = () => undefined;
    const echoed = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const unechoed: Unechoed = {
      row: head,
      refs: this.copyImages(head.images),
      heard
    };
    this.attaching = unechoed;
    this.tee.sent((line) => echoes(line, unechoed));
    // Our prompt is the next turn: a wake before it has said what it will.
    this.projection.beginPrompt();
    // The first message with words: a picture first in line may be one Grok
    // dropped, and every chunk of the prompt shares its ordinal and time.
    const firstWords = segments(head).find((segment) => segment.text.trim())?.text ?? '';
    const sentAt = Date.now();
    let settledAt: number | undefined;
    let promptSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      promptSettled = resolve;
    });
    // The write threw: the prompt never reached the CLI, so it was never said.
    let unsent = false;
    const transcript = this.live.transcript ?? grokTranscriptPath(this.live.cwd, grokId);
    // The user turn's slot, taken before any assistant frame can take one, and
    // drawn at once as what was sent. It is the prompt's one entry: its echo,
    // off the pipe (`echo`) or off disk, only witnesses it, and no echo still
    // records it. Waiting for one holds later record lines back by roughly 32
    // seconds at most — the disk only, memory draws past it — so poll for an
    // echo written during a long turn, and stop once the session has.
    const said = conversation.awaiting(`send:${randomUUID()}`, sentTurns(head, [], sentAt));
    const work = Promise.resolve()
      .then(async () => {
        await Promise.race([settled, echoed, this.pause(2_000)]);
        if (unsent) return [];
        if (unechoed.echo) return sentInPlaceOf(unechoed.echo, unechoed, sentAt);
        let echo = await readSentUserUpdate(transcript, sentAt, firstWords, settledAt);
        const deadlineAt = Date.now() + 30_000;
        while (
          !echo &&
          settledAt === undefined &&
          !unechoed.echo &&
          !this.stopped() &&
          Date.now() < deadlineAt
        ) {
          await Promise.race([
            settled,
            echoed,
            this.pause(Math.min(1_000, deadlineAt - Date.now()))
          ]);
          if (!unechoed.echo) {
            echo = await readSentUserUpdate(transcript, sentAt, firstWords, settledAt);
          }
        }
        if (unsent) return [];
        if (unechoed.echo) return sentInPlaceOf(unechoed.echo, unechoed, sentAt);
        if (echo && echo.at > sentEchoWindow(sentAt, settledAt).latest) echo = undefined;
        if (!echo) echo = await readSentUserUpdate(transcript, sentAt, firstWords, settledAt);
        const line = echo ? this.tee.recoveredUser(echo.method, echo.params, echo.at) : undefined;
        if (line && projection.isPrompt(line)) this.release(unechoed);
        return sentInPlaceOf(line, unechoed, sentAt);
      })
      .then(said, () => said([]))
      .finally(() => this.echoWork.delete(work));
    this.echoWork.add(work);
    // The finalizer applies this after the closing line.
    let end: { outcome?: TurnOutcome } | undefined;
    const promptId = this.mintPromptId();
    if (head.warm && this.live.warmTurn) {
      this.warmPrompt = promptId;
      this.warmPrompts.set(promptId, this.live.warmTurn);
    } else {
      this.realPrompts.add(promptId);
    }
    // How the reply closes the turn's line, beside how it ends the card's turn.
    let closer: Close = { turn: promptId, last: true };
    this.messageTurns.remember(promptId, head);
    this.ownedTurn = promptId;
    const tag = `${head.warm ? 'ping' : 'prompt'}: pid ${this.transport.pid ?? '?'} ${promptId.slice(0, 8)}`;
    this.log?.(`${tag} sent`);
    try {
      const result = await this.client.request('session/prompt', {
        sessionId: this.grokId,
        prompt: segments(head).flatMap((part) => promptBlocks(part.text, part.images)),
        // Ours, so `runningPromptId` comes back as something we can recognise.
        // Without it the CLI mints its own and every turn of ours reads as
        // foreign. **Defence in depth, not the load-bearing half** — measured
        // by reverting it alone, which fails nothing: `writePending` already
        // shuts the gate for the whole of a turn we sent, and the CLI clears
        // the queue's running id before any late frame can re-busy the card.
        // Kept because it is what makes correlation exact (protocol.md
        // § `promptId` echoes ours) and costs one field.
        _meta: { promptId }
      });
      if (gen !== this.drainGen) {
        return false;
      }
      const stop = isRecord(result) ? result.stopReason : undefined;
      const outcome = outcomeOf(stop);
      end = outcome ? { outcome } : {};
      closer = { ...closer, stop };
    } catch (err) {
      unsent = !(err instanceof JsonRpcFailure) && !(err instanceof AcpExited);
      if (gen !== this.drainGen) {
        return false;
      }
      // An error the CLI returned states the turn failed. A write that threw
      // states nothing: the turn still ends, unclassified (PRD A11).
      end =
        err instanceof JsonRpcFailure
          ? { outcome: 'error' }
          : err instanceof AcpExited
            ? undefined
            : {};
      closer =
        err instanceof JsonRpcFailure
          ? {
              ...closer,
              stop: 'error',
              said: typeof err.data === 'string' && err.data ? err.data : err.message
            }
          : { ...closer, cut: true };
    } finally {
      const how =
        gen !== this.drainGen
          ? 'superseded'
          : closer.cut
            ? 'cut'
            : typeof closer.stop === 'string'
              ? closer.stop
              : 'no stop';
      this.log?.(`${tag} settled (${how})`);
      settledAt = Date.now();
      promptSettled();
      if (end)
        this.apply(this.messageTurns.settle(this.live, promptId, end.outcome), 'local', false);
      if (gen === this.drainGen) {
        this.writePending = false;
        this.ownedTurn = undefined;
        this.drainingId = undefined;
        // Grok 1.0.5 can omit `turn_completed` for our prompt; a wake has no
        // prompt reply. Both paths must close the line, idempotently.
        this.projection.feed(conversation, this.tee.closeTurn(closer, Date.now()));
        // A turn whose echo never came (interrupted, or refused) does not hand
        // its pictures, or its echo, to the prompt after it.
        this.release(unechoed);
        // The idle edge queues a positional checkpoint: closing the line
        // first keeps that note on this turn rather than the preceding one.
        if (end) {
          // The turn's own end, which this CLI states in the reply to
          // `session/prompt` and not in a frame. A request of ours, carrying
          // what the agent did — which is why the tag is named for its
          // subject. **The throw is tagged the same as the two the reply
          // carried**: `advancesActivityClock` moves on `agent` and not on
          // `local`, so leaving the error path to default would stop the clock
          // on exactly the turns that ran longest. An unsent write is opened
          // and counted too: it ends a turn, unclassified, as it always has.
          this.openWritten();
          const ended = applyEvent(this.live, { kind: 'turn-end', ...end });
          // A ping the reply ends may never have opened; this is its close either way.
          this.apply(
            head.warm ? closeWarm(ended, unsent || pingFailed(end.outcome)) : ended,
            'agent',
            unsent || end.outcome !== 'done'
              ? false
              : head.warm && warming(this.live)
                ? true
                : undefined
          );
        }
      } else {
        // A reply Send now moved past. Its line was cut then; this is its last
        // closer.
        this.projection.feed(conversation, this.tee.sealTurn(promptId));
      }
    }
    if (gen !== this.drainGen) {
      return false;
    }
    // A ping changes nothing the chrome states; the next real turn reads it.
    if (!head.warm) void this.refreshChrome();
    return true;
  }

  /** `ms`, or less once the session is closed or its child gone: nothing is
   *  left to wait for. */
  private pause(ms: number): Promise<void> {
    if (this.stopped()) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.pauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.pauses.add(wake);
    });
  }

  private stopped(): boolean {
    return this.closed || this.live.exit !== undefined;
  }

  /**
   * Our write's turn, opened before a close of it that no frame opened, as a
   * change of its own so `drive` sees the edge both ways. `local`: the write
   * moved the activity clock already, and the close moves the cache's.
   */
  private openWritten(): void {
    this.apply(openWritten(this.live), 'local');
  }

  private release(unechoed: Unechoed): void {
    if (this.attaching !== unechoed) return;
    this.attaching = undefined;
    this.tee.sent(undefined);
  }

  /** Disk chrome updates after a turn (signals.json, 1.0.4). Gaps stay gaps. */
  private async refreshChrome(): Promise<void> {
    if (!this.grokId || this.closed) {
      return;
    }
    const gen = ++this.chromeGen;
    const chrome = await readGrokChrome(this.live.cwd, this.grokId);
    if (this.closed || gen !== this.chromeGen) {
      return;
    }
    // Last write from disk wins. Grok has no naming cap, and current_model_id
    // is what the CLI is on — a first session_summary must not stick.
    const title = chrome.title ?? this.live.title;
    const model = chrome.model ?? this.live.model;
    const contextPct = chrome.contextPct ?? this.live.contextPct;
    if (
      title === this.live.title &&
      model === this.live.model &&
      contextPct === this.live.contextPct
    ) {
      return;
    }
    this.apply({ ...this.live, title, model, contextPct });
  }

  private historicalPrompt(promptId: string): boolean {
    const warm = this.warmPrompts.get(promptId);
    if (warm) return warm.phase === 'closed' || warm.id !== this.live.warmTurn?.id;
    if (promptId === this.ownedTurn || promptId === this.foreignTurn) return false;
    return this.realPrompts.has(promptId) || this.ownedTurn !== undefined;
  }

  /**
   * One notification, into the thread: a line's prose streams under its row,
   * the line lands on that row, and the rest take slots of their own
   * (`GrokTee.teed`). Answers whether it was text a close had already ended.
   *
   * Never awaits into the caller: this runs on every notification of every
   * owned session, and the thread writes behind — a store that stalled must
   * cost the reader a fallback to `chat_history.jsonl`, never a session that
   * stopped reading its own pipe.
   */
  private record(method: string, params: unknown): boolean {
    try {
      const promptId = nativePromptId(params);
      const warm = promptId ? this.warmPrompts.get(promptId) : undefined;
      const historical = promptId !== undefined && this.historicalPrompt(promptId);
      const owner =
        promptId !== undefined
          ? { maintenance: warm !== undefined, ...(warm ? { warmId: warm.id } : {}) }
          : undefined;
      const teed = this.tee.teed(method, params, Date.now(), historical, owner).map((op): Teed => {
        if (
          owner &&
          (op.kind === 'alarm' || op.kind === 'line') &&
          'role' in op.line &&
          (op.line.role === 'cli' || op.line.role === 'assistant')
        )
          return { ...op, line: { ...op.line, ...owner } };
        return op;
      });
      this.projection.take(this.memory.current, teed, this.recoveryPending());
      return teed.some((op) => op.kind === 'stream' && op.late);
    } catch {
      // Kept for the reason `claude/session.ts`'s twin is: this runs *before*
      // the notification is reduced, so anything thrown here is a card wedged
      // for good, and the record is best-effort by design.
      return false;
    }
  }

  /**
   * The row the drain just sent, and its pictures being copied into our own
   * store, waiting for the echo that stands in for them.
   *
   * Grok's prompt update is the witness that the prompt landed (`grok/tee.ts`),
   * from ACP or `updates.jsonl`, and the row replaces it with what was sent
   * (`sentInPlaceOf`). The copy is a file write started at the drain, the echo
   * a notification that can beat it back; the echo worker awaits both before
   * resolving the captured thread slot, without holding up the pipe reader.
   *
   * Copied rather than pointed at, for `writeAttachment`'s reason: the CLI
   * writes a prompt's pictures into its own store under names the panel cannot
   * predict, so a copy of our own is the only ref we can resolve later. (The
   * echo does carry the bytes back — probed 2026-08-20 — but reading them off
   * a notification would put a third of a megabyte of base64 through the
   * reducer on every image prompt.) A copy that fails costs the picture and not
   * the turn.
   */
  private attaching: Unechoed | undefined;

  /** Positional, so a copy that failed costs its own picture and no other. */
  private copyImages(
    images: readonly ImageBlock[] | undefined
  ): Promise<readonly (ImageRef | undefined)[]> {
    const sessionId = this.live.sessionId;
    if (!images?.length || !sessionId) {
      return Promise.resolve([]);
    }
    return Promise.all(images.map((image) => writeAttachment(sessionId, image))).catch(() => []);
  }

  readout(text: string): void {
    this.note(this.memory.current, [localReply(text, Date.now())]);
  }

  private heard(conversation: Conversation, line: RecordLine): void {
    const unechoed = this.attaching;
    if (!unechoed) {
      conversation.note([line]);
      return;
    }
    this.attaching = undefined;
    unechoed.echo = line;
    unechoed.heard();
  }

  /** A local close of the open output. Send now also names the turn identities
   *  it supersedes, independently of the output being flushed. */
  private closeLine(close: Close): void {
    this.projection.take(
      this.memory.current,
      this.tee.closeTurn(close, Date.now()),
      this.recoveryPending()
    );
  }

  private note(conversation: Conversation, lines: readonly RecordLine[]): void {
    if (lines.length) conversation.note(lines);
  }

  private apply(next: LiveState, origin: ChangeOrigin = 'local', cacheTraffic?: boolean): void {
    next = this.messageTurns.apply(this.live, next);
    if (next === this.live) {
      return;
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
    if (
      this.warmPrompt &&
      next.warmTurn &&
      next.warmTurn.id === this.warmPrompts.get(this.warmPrompt)?.id
    )
      this.warmPrompts.set(this.warmPrompt, next.warmTurn);
    this.live = next;
    // **Before the listeners and before `drive`**, and unconditional: `drive`
    // returns on `closed`, and this has to be seen whatever else is true.
    // `capturing` is only ever held by a drain that was idle when it started,
    // so anything turning `running` on here is a turn we did not release.
    if (this.capturing && next.running) {
      this.baselineDirty = true;
    }
    for (const listener of this.listeners) {
      listener(next, origin, cacheTraffic);
    }
    // After the listeners, so the card is already showing the edge this may
    // spend a capture on.
    this.drive(next);
  }

  /**
   * The one idle edge on this brand.
   *
   * A Grok turn ends at four places — the `session/prompt` result, a
   * `turn_completed` notification, `sendNow`, and the child's exit — and the
   * first two race each other by design (`tryDrain`'s `finally` says the record
   * needs whichever comes first). Four call sites would each have to be
   * idempotent against the other three; one edge computed off the funnel every
   * state change already passes through is the rule `ClaudeSession` proved.
   * `wasRunning` is what makes the second closer of a turn a no-op —
   * `applyEvent` never identity-returns on a turn-end, so object identity
   * cannot do that job.
   *
   * Claude's `drive` also spends a `get_usage` round trip here and asks for a
   * title. Neither is this brand's, and nothing was ported but the edge.
   */
  private drive(next: LiveState): void {
    // A session the reader stopped still emits the last of its frames, and its
    // transport's `onExit` applies once more behind `close`. Without this that
    // second capture races the `end` already on the chain.
    if (this.closed) {
      return;
    }
    // `next.exit` is deliberately *not* excluded: a child that died mid-turn
    // still wrote whatever it wrote, and reading that off the tree asks nothing
    // of a pipe that has gone. An interrupt needs no case of its own either —
    // `sendNow` and a cancelled prompt result both reach here as a turn-end, so
    // the turn keeps its writes instead of losing them into the next baseline.
    // A ping is maintenance: no capture opens or closes on it. Only a warm turn
    // runs while the latch is set.
    const warm = next.warmTurn !== undefined;
    if (this.wasRunning && !next.running && !warm) {
      this.captureWake?.();
      this.captureWake = undefined;
      this.endCheckpoint(next.cwd);
    }
    if (
      !warm &&
      !this.wasRunning &&
      next.running &&
      this.grokId &&
      (this.capturing || (this.executionObserver && !next.inFlight))
    ) {
      this.captureWake = this.checkpoints.uncertainExecution(next.cwd, {
        owner: identity.conversationKey('grok', this.grokId),
        runtime: this.executionRuntime.runtime,
        turn: randomUUID()
      });
    }
    if (
      !warm &&
      !this.wasRunning &&
      next.running &&
      !this.capturing &&
      !this.executionObserver &&
      this.grokId
    ) {
      const turn = randomUUID();
      void this.checkpoints.openUnknown(next.cwd, {
        owner: identity.conversationKey('grok', this.grokId),
        runtime: this.executionRuntime.runtime,
        turn
      });
      this.executionObserver = new execution.ExecutionObserver(
        this.grokId,
        this.executionRuntime.contextFile
      );
    }
    this.wasRunning = next.running;
  }

  /**
   * Rule 1's other end: what this turn did, filed on the turn it belongs to.
   *
   * The window goes to the per-tree store **first**. That is the evidence a
   * *neighbour* subtracts our paths from, and it is what makes rule 2 possible
   * at all — every owned session on the tree leaves an account of itself,
   * naming what it touched however it touched it. The `{ck}` note takes a slot
   * in the thread, after the assistant line the tee has already placed.
   *
   * The await is **inside** the build and not in front of it, which holds the
   * disk behind it for the length of the end capture; memory draws past it.
   * Moving it out would take the note's
   * slot only once the diff was in hand, and a drain releasing inside that
   * window would put the *next* turn's prompt ahead of it — the note folds onto
   * whatever was written last, so it would land on the wrong turn entirely.
   *
   * `this.live.cwd` would answer the same thing at either edge, since Grok
   * takes its cwd once at `session/new` and no frame moves it. Passed through
   * anyway, because `TurnCheckpoints.close` re-reads and compares `treeRoot`
   * against the baseline's, and that guard is what makes the pin honest.
   */
  private endCheckpoint(cwd: string): void {
    // **Not while a drain is baselining.** The baseline on the object then
    // belongs to a turn that has not been released yet, and `close` consumes
    // whatever it finds — so an edge landing inside that window would spend the
    // next turn's baseline on a span that wrote nothing, and the turn that did
    // the work would find none and skip. Both cannot be served; the one about
    // to be sent is the one worth serving.
    if (this.capturing) {
      return;
    }
    // Started here and awaited there. The capture has to consume the baseline
    // *now*, before a `close` or the child's exit can clear it in the same
    // tick; what the slot buys is the order the line is written in, which does
    // not need the diff in hand to be correct.
    const observer = this.executionObserver;
    this.executionObserver = undefined;
    const taken = this.checkpoints.closeExecution(
      cwd,
      observer ? (store, turn) => observer.finish(store, turn) : undefined
    );
    checkpointRecord.enqueue(this.memory.current, taken);
  }
}
