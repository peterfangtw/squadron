import { OPEN_REQUEST_MS } from '../startup';
import * as usage from './usage';
/** One owned Codex thread on a private app-server child. */

import { randomUUID } from 'crypto';
import * as messageFacts from '../message_facts';
import * as recovery from '../recovery';
import * as checkpoint from '../checkpoint';
import * as executionRuntime from '../execution';
import * as identity from '../identity';
import * as execution from './execution';
import * as activity from '../activity';
import type { ChangeOrigin, ConnectOptions, SessionHandle, WarmAttempt } from '../adapter';
import type { SessionEvent } from '../events';
import type { LiveState, QueuedMessage } from '../live';
import {
  WARM_MESSAGE_WAITING,
  WARM_NO_CONVERSATION,
  WARM_NOT_IDLE,
  WARM_SESSION_ENDED,
  answered,
  applyEvent,
  applyEvents,
  canDrain,
  closeWarm,
  closesTurn,
  dequeueHead,
  dismissQueued,
  enqueue,
  enqueueAhead,
  failWarm,
  initial,
  pingFailed,
  mergeQueued,
  openWritten,
  segments,
  pickModel,
  reachesForTool,
  type WarmTurn,
  warmDrain,
  warming,
  withExit,
  withUsage
} from '../live';
import type { Decision, ImageBlock, SendTarget } from '../model';
import { attachmentFile, recordFile, type RecordLine, writeAttachment } from '../record';
import { askRecord } from '../answers';
import { localReply } from '../transcript';
import type { SessionTransport } from '../session';
import { CODEX_REQUEST_MS, CodexClient, CodexExited, CodexFailure } from './client';
import { WARM_PROMPT, sentTurns, wrapWarm } from '../coordination/send';
import {
  codexRequestKey,
  isCodexRequestMethod,
  parseCodexRequest,
  resolvedCodexRequest,
  type ParsedCodexRequest
} from './asks';
import { codexAcceptsImages, codexEffort } from './models';
import { eventsFrom, threadStatus } from './reduce';
import { permissionWord, sandboxType, startMode } from './permissions';
import { CodexTee } from './tee';
import * as projection from './projection';
import { Thread, readBaseline, recoverBaseline, type History } from '../thread';
import { TurnCapture } from '../turn_capture';
import {
  activeTranscriptReader,
  askLine,
  readPaginated,
  registerTranscriptReader
} from './transcript';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function words(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown protocol error';
}

function approvalPolicy(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  return isRecord(value) && isRecord(value.granular) ? 'granular' : undefined;
}

export type OpenedThread = {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  title?: string;
  permissionMode?: string;
  status?: LiveState['status'];
};

/** Narrow a `thread/start` or `thread/resume` result before it reaches state. */
export function openedThread(value: unknown): OpenedThread | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined;
  const thread = value.thread;
  if (
    typeof thread.id !== 'string' ||
    !thread.id ||
    typeof thread.cwd !== 'string' ||
    !thread.cwd ||
    thread.canAcceptDirectInput !== true
  ) {
    return undefined;
  }
  const state = threadStatus(thread.status);
  // `thread.parentThreadId` is read by nothing here, deliberately: it is Codex's
  // own sub-agent relation over threads that never reach `session_index.jsonl`
  // and so can never be cards, while our lineage answers which *session* asked
  // for a spawn. Measured 2026-09-02 — `cli_state/codex/sessions.md`, "Spawn
  // edges". Two fields both called parent, two different questions.
  return {
    id: thread.id,
    cwd: thread.cwd,
    model: typeof value.model === 'string' && value.model ? value.model : undefined,
    effort:
      typeof value.reasoningEffort === 'string' && value.reasoningEffort
        ? value.reasoningEffort
        : undefined,
    title: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : undefined,
    // Both halves or the card cannot tell an unattended thread from an
    // unsandboxed one (`permissions.ts`). `sandbox` is what the open result
    // calls it; the settings notification calls the same thing `sandboxPolicy`.
    permissionMode: permissionWord(
      approvalPolicy(value.approvalPolicy),
      sandboxType(value.sandbox)
    ),
    status: state
  };
}

export function openParams(start: ConnectOptions): Record<string, unknown> {
  const skip = start.skipPermissions === true;
  const effort = codexEffort(start.model, start.effort);
  return {
    cwd: start.cwd,
    approvalPolicy: skip ? 'never' : 'on-request',
    sandbox: skip ? 'danger-full-access' : 'workspace-write',
    ephemeral: false,
    ...(start.model ? { model: start.model } : {}),
    ...(effort ? { config: { model_reasoning_effort: effort } } : {})
  };
}

type PendingFrame =
  | { kind: 'notification'; method: string; params: Record<string, unknown>; at: number }
  | { kind: 'request'; request: ParsedCodexRequest; at: number };

type CompletionAdmission = 'take' | 'drop' | 'strip';

type LiveNotification = {
  kind: 'live';
  events: readonly SessionEvent[];
  nativeWarm: boolean;
  completion: CompletionAdmission | undefined;
};

type NotificationAdmission =
  | { kind: 'historical-warm'; turnId: string; warm: WarmTurn }
  | { kind: 'cache-only'; events: readonly SessionEvent[] }
  | { kind: 'drop' }
  | LiveNotification;

export class CodexSession implements SessionHandle {
  private live: LiveState;
  private readonly listeners = new Set<
    (state: LiveState, origin: ChangeOrigin, cacheTraffic?: boolean, observedAt?: number) => void
  >();
  private readonly activity = new Set<(observedAt?: number) => void>();
  private readonly client: CodexClient;
  private readonly tee: CodexTee;
  private threadId: string | undefined;
  private currentTurnId: string | undefined;
  /**
   * Our `turn/start` is on the wire and has not named its turn yet.
   * `currentTurnId` is unset for that whole wait, so a `turn/completed`
   * cannot be matched against it. Cleared when the request settles.
   */
  private startingTurn = false;
  private pendingFrames: PendingFrame[] = [];
  private readonly completedTurns = new Set<string>();
  private latestTurnId: string | undefined;
  private readonly requests = new Map<string, ParsedCodexRequest>();
  private turnRequest: Promise<string | undefined> | undefined;
  /** The turn the newest ping opened, so the usage it reports is its own. */
  private warmTurnId: string | undefined;
  /** Native ids can still complete items while later turns run. Retained for this pipe's lifetime. */
  private readonly warmTurns = new Map<string, WarmTurn>();
  private opened = false;
  private writePending = false;
  private sending = false;
  private nextModel: string | undefined;
  private unregisterReader: (() => void) | undefined;
  private closed = false;
  private readonly messageTurns = new messageFacts.MessageTurns();
  private readonly checkpoints: checkpoint.TurnCheckpoints;
  private readonly executionRuntime: executionRuntime.ExecutionRuntime;
  private readonly capture: TurnCapture<execution.ExecutionObserver>;
  /** Native children proven by a spawn, so a later turn's follow-up can admit them. */
  private readonly nativeChildren = new Set<string>();
  private capturing = false;
  readonly opening: Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The conversation in memory, named once the thread has opened, and
   *  whether a resume is still reading what came before it. */
  private readonly memory: Thread;
  private readonly recoveryPending: () => boolean = () => false;
  private readonly projection: projection.CodexProjection;
  /** Records the message in flight without its echo (`recordSend`). */
  private unechoed: ((lines?: readonly RecordLine[]) => void) | undefined;
  readonly thread: SessionHandle['thread'];
  readonly usage: SessionHandle['usage'] = {
    read: async (signal) => {
      if (!(await this.opening).ok || this.closed || signal?.aborted) return undefined;
      const reading = usage.codexRateLimits(
        await this.client.request('account/rateLimits/read', undefined, undefined, signal)
      );
      if (signal?.aborted) return undefined;
      this.apply(withUsage(this.live, reading, Date.now()));
      return reading ? this.live.usage : undefined;
    }
  };

  get messages(): NonNullable<SessionHandle['messages']> {
    return {
      // `live.model` is the CLI's reading and can land on `thread/settings/updated`
      // before `turn/start` resolves and writes `nextModel`. Preferring the launch
      // leftover hid a targeted vision switch as still text-only.
      images: codexAcceptsImages(this.live.model ?? this.nextModel),
      pending: () => !this.drainable() || this.live.queued.length > 0,
      send: (text, images, describe, ahead, target, correlation) =>
        this.send(text, images, describe, ahead, target, correlation),
      dismiss: (id) => this.dismiss(id),
      sendNow: () => this.sendNow()
    };
  }
  readonly turn: NonNullable<SessionHandle['turn']> = { interrupt: () => this.interrupt() };
  readonly model: NonNullable<SessionHandle['model']> = {
    set: (model) => this.setModel(model)
  };
  readonly naming: NonNullable<SessionHandle['naming']> = {
    rename: (title) => this.rename(title)
  };
  readonly asks: NonNullable<SessionHandle['asks']> = {
    respond: (requestId, decision) => this.respond(requestId, decision)
  };
  readonly warm: SessionHandle['warm'] = { ping: () => this.ping() };

  constructor(
    private readonly transport: SessionTransport,
    private readonly start: ConnectOptions,
    requestMs = CODEX_REQUEST_MS
  ) {
    start.registerCleanup?.(() => this.close());
    this.live = {
      ...initial(start),
      permissionMode: startMode(start.skipPermissions === true)
    };
    this.nextModel = start.model;
    this.executionRuntime = start.execution ?? { runtime: randomUUID(), enabled: false };
    this.checkpoints = new checkpoint.TurnCheckpoints(
      JSON.stringify([
        identity.conversationKey('codex', start.sessionId ?? randomUUID()),
        this.executionRuntime.runtime
      ]),
      this.executionRuntime.contextFile
    );
    this.tee = new CodexTee(start.cwd);
    this.projection = new projection.CodexProjection(this.tee);
    this.memory = new Thread({ cwd: start.cwd, brand: 'codex' });
    this.capture = new TurnCapture(
      this.checkpoints,
      this.executionRuntime.runtime,
      () => this.memory.current,
      (observer) => () => observer.finish()
    );
    this.client = new CodexClient(transport, requestMs);
    this.client.onNotification((method, params) => this.receive(method, params, Date.now()));
    this.client.onRequest((id, method, params) => {
      const key = codexRequestKey(id);
      // A repeated id would answer the original request as well.
      if (
        this.requests.has(key) ||
        this.pendingFrames.some((frame) => frame.kind === 'request' && frame.request.key === key)
      )
        return;
      const parsed = this.threadId
        ? parseCodexRequest(id, method, params, this.threadId, this.currentTurnId)
        : undefined;
      if (!parsed) {
        const known = isCodexRequestMethod(method);
        this.client.fail(id, {
          code: known ? -32602 : -32601,
          message: known ? 'Invalid params' : `Unsupported Codex request ${method}`
        });
        return;
      }
      if (this.unconfirmedTurn(parsed.turnId)) {
        this.pendingFrames.push({ kind: 'request', request: parsed, at: Date.now() });
        return;
      }
      this.admitRequest(parsed, Date.now());
    });
    const ended = () => {
      this.resolveFrames();
      this.memory.current.end();
      this.projection.end();
      this.unechoed?.();
    };
    if (transport.onEnd) transport.onEnd(ended);
    else transport.onExit(ended);
    transport.onExit((info) => {
      this.unregisterReader?.();
      this.unregisterReader = undefined;
      this.retireAllRequests();
      this.apply(
        withExit(this.live, { code: info.code, signal: info.signal, source: info.source }),
        'agent'
      );
      if (this.capturing) this.checkpoints.discard();
      else
        this.capture.ended(this.live.cwd, {
          warm: this.live.warmTurn !== undefined,
          baselining: false
        });
      void this.checkpoints.endExecution(
        this.executionRuntime.runtime,
        this.executionRuntime.contextFile
      );
    });
    this.opening = this.open();
    const recovered = this.opening.then(async (result) => {
      const resumed = this.threadId;
      if (!result.ok || !resumed) return true;
      return recoverBaseline(
        this.memory.current,
        start.resume
          ? () => readBaseline(resumed, () => this.history(resumed), start.log)
          : undefined,
        { stopped: () => this.closed || this.live.exit !== undefined, log: start.log }
      );
    });
    this.thread = recovery.threadPort(this.memory, Boolean(start.resume), recovered);
    this.recoveryPending = recovery.recoveryGate(Boolean(start.resume), recovered, () => {
      void this.tryDrain();
    });
    void this.opening.then((result) => {
      if (result.ok) void this.tryDrain();
    });
  }

  get state(): LiveState {
    return this.live;
  }

  onChange(
    listener: (
      state: LiveState,
      origin: ChangeOrigin,
      cacheTraffic?: boolean,
      observedAt?: number
    ) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onActivity(listener: (observedAt?: number) => void): () => void {
    this.activity.add(listener);
    return () => this.activity.delete(listener);
  }

  async flush(): Promise<void> {
    await executionRuntime.flushAdmission(this.executionRuntime);
    await this.checkpoints.flush();
    await this.thread.recovered;
    await (this.closed ? this.memory.finish() : this.memory.idle());
  }

  close(): void {
    if (this.closed) return;
    this.apply(messageFacts.abandon(this.live));
    this.closed = true;
    if (this.capturing) this.checkpoints.discard();
    else
      this.capture.ended(this.live.cwd, {
        warm: this.live.warmTurn !== undefined,
        baselining: false
      });
    void this.checkpoints.endExecution(
      this.executionRuntime.runtime,
      this.executionRuntime.contextFile
    );
    this.retireAllRequests();
    this.unechoed?.();
    this.unregisterReader?.();
    this.unregisterReader = undefined;
    this.transport.close();
  }

  send(
    text: string,
    images: readonly ImageBlock[] = [],
    describe?: string,
    ahead = false,
    target?: SendTarget,
    correlation?: string
  ): void {
    const entry = {
      id: randomUUID(),
      ...(messageFacts.isCorrelation(correlation) ? { correlation } : {}),
      text,
      images: images.length ? [...images] : undefined,
      queuedAt: Date.now(),
      ...(describe === undefined ? {} : { describe }),
      ...(target === undefined ? {} : { target })
    };
    this.apply(ahead ? enqueueAhead(this.live, entry) : enqueue(this.live, entry));
    void this.tryDrain();
  }

  dismiss(id: string): boolean {
    const next = dismissQueued(this.live, id);
    if (next === this.live) return false;
    this.apply(next);
    return true;
  }

  async sendNow(): Promise<void> {
    this.sending = true;
    try {
      if (this.live.running || this.currentTurnId || this.turnRequest || warming(this.live))
        await this.interrupt();
      // A ping whose start never named a turn has nothing left to end it.
      // One that did ends on that turn's completion, which still holds the drain.
      if (warming(this.live) && !this.currentTurnId && !this.writePending)
        this.apply(closeWarm(this.live, true));
    } finally {
      this.sending = false;
    }
    await this.tryDrain();
  }

  async interrupt(): Promise<void> {
    await this.opening.catch(() => undefined);
    const threadId = this.threadId;
    const turnId = this.currentTurnId ?? (await this.turnRequest?.catch(() => undefined));
    if (!threadId || !turnId || this.completedTurns.has(turnId)) return;
    // Codex 0.151 retracts each open callback through serverRequest/resolved.
    // A client error is not cancellation: app-server turns it into empty
    // answers and can resume the turn before this interrupt lands.
    await this.client.request('turn/interrupt', { threadId, turnId });
    this.retireTurnRequests(turnId);
  }

  respond(requestId: string, decision: Decision): boolean {
    const request = this.requests.get(requestId);
    const pending = this.live.pending.find((open) => open.requestId === requestId);
    if (!request || !pending) {
      return false;
    }
    const response = request.response(decision);
    if (!response) return false;
    this.client.reply(request.protocolId, response);
    // **The record's only sight of an answered ask**, as for the other two
    // brands — and here the call it files under is ours to write, since
    // app-server completes no item for a question (`askLine`).
    const ask = askRecord(pending, decision);
    if (ask?.questions.length) this.recordLines([askLine(request.itemId, ask, Date.now())]);
    this.requests.delete(requestId);
    this.apply(answered(this.live, requestId));
    void this.tryDrain();
    return true;
  }

  setModel(model: string): Promise<void> {
    const picked = model.trim();
    if (!picked) return Promise.resolve();
    this.nextModel = picked;
    this.apply(pickModel(this.live, picked));
    return Promise.resolve();
  }

  rename(title: string): void {
    const name = title.trim();
    if (!name) return;
    void this.opening.then(async (ready) => {
      if (!ready.ok || this.closed || !this.threadId) return;
      try {
        await this.client.request('thread/name/set', { threadId: this.threadId, name });
      } catch {
        // The notification is the title reading. A refused request states none.
      }
    });
  }

  private receive(method: string, params: unknown, at: number): void {
    if (method === 'account/rateLimits/updated') {
      this.apply(withUsage(this.live, usage.codexUsageNotification(params), at));
      return;
    }
    if (!this.threadId || !isRecord(params) || params.threadId !== this.threadId) {
      this.capture.observer?.take(method, params);
      return;
    }
    const turnId = notificationTurnId(params);
    if (
      (turnId && this.unconfirmedTurn(turnId)) ||
      (this.startingTurn &&
        method === 'thread/status/changed' &&
        threadStatus(params.status) !== 'unknown')
    ) {
      // turn/start names the owner. Thread active/idle has no turn id and
      // must keep its wire order with the named lifecycle (0.151, protocol.md).
      this.pendingFrames.push({ kind: 'notification', method, params, at });
      return;
    }
    const events = eventsFrom(method, params, this.threadId);
    const completion = this.recordNotification(method, params, turnId, events, at);
    const admission = this.admitNotification(method, turnId, events, completion);
    switch (admission.kind) {
      case 'historical-warm':
        this.recordWarmUsage(admission.turnId, admission.warm, events);
        return;
      case 'cache-only':
        this.apply(applyEvents(this.live, admission.events), 'local');
        return;
      case 'drop':
        return;
      case 'live':
        break;
    }
    // Observing before admission attributes a completed turn's command to the next turn.
    this.capture.observer?.take(method, params);
    const maintenance = admission.nativeWarm || warming(this.live);
    const cut = maintenance && admission.events.some(reachesForTool);
    if (method === 'turn/started' && turnId) {
      this.openNotificationTurn(this.threadId, turnId, params, maintenance);
    } else if (method === 'turn/completed' && turnId) {
      this.completeNotificationTurn(turnId, admission.completion);
    }
    if (method !== 'turn/completed' && admission.events.some((event) => event.kind === 'turn-end'))
      this.capture.ended(this.live.cwd, {
        warm: this.live.warmTurn !== undefined,
        baselining: this.capturing
      });
    this.applyNotification(method, turnId, admission, maintenance, at);
    if (cut) this.cutWarm(at);
    if (admission.events.some((event) => event.kind === 'text')) {
      for (const listener of this.activity) listener(at);
    }
    void this.tryDrain();
  }

  private recordNotification(
    method: string,
    params: Record<string, unknown>,
    turnId: string | undefined,
    events: readonly SessionEvent[],
    at: number
  ): CompletionAdmission | undefined {
    for (const event of events) {
      if (event.kind === 'turn-end' && event.turnId)
        this.apply(
          this.messageTurns.settle(this.live, event.turnId, event.outcome),
          'local',
          false
        );
    }
    const completion =
      method === 'turn/completed' && turnId ? this.admitCompletion(turnId) : undefined;
    this.record(method, params, events, at);
    if (method === 'serverRequest/resolved' && this.threadId) {
      const requestId = resolvedCodexRequest(params, this.threadId);
      if (requestId) this.retireRequest(requestId);
    }
    return completion;
  }

  private admitNotification(
    method: string,
    turnId: string | undefined,
    events: readonly SessionEvent[],
    completion: CompletionAdmission | undefined
  ): NotificationAdmission {
    const historical = turnId ? this.warmTurns.get(turnId) : undefined;
    if (turnId && historical && historical.id !== this.live.warmTurn?.id)
      return { kind: 'historical-warm', turnId, warm: historical };
    const nativeWarm = this.ownsWarmTurn(turnId);
    if (historical?.phase === 'closed' && !nativeWarm)
      return { kind: 'cache-only', events: events.filter((event) => event.kind === 'cache-read') };
    if (turnId && this.historicalTurn(turnId)) return { kind: 'drop' };
    if (turnId && this.currentTurnId && turnId !== this.currentTurnId) return { kind: 'drop' };
    if (
      turnId &&
      this.live.warmTurn &&
      !this.warmTurns.has(turnId) &&
      (warming(this.live) || method !== 'turn/started')
    )
      return { kind: 'drop' };
    if (turnId && this.completedTurns.has(turnId) && ofTurn(method)) return { kind: 'drop' };
    return { kind: 'live', events: completionEvents(events, completion), nativeWarm, completion };
  }

  private recordWarmUsage(turnId: string, warm: WarmTurn, events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.kind !== 'cache-read') continue;
      const updated = this.memory.current.recordWarmUsage(event.tokens, event.input, warm);
      if (updated) this.warmTurns.set(turnId, updated);
    }
  }

  private openNotificationTurn(
    threadId: string,
    turnId: string,
    params: Record<string, unknown>,
    maintenance: boolean
  ): void {
    // A ping is maintenance: no capture opens on it, not even the
    // fallback a self-started turn takes.
    if (maintenance) this.rememberWarm(turnId);
    else
      this.capture.opened(
        {
          cwd: this.live.cwd,
          owner: identity.conversationKey('codex', threadId),
          id: turnId,
          inFlight: this.live.inFlight !== undefined,
          baselining: this.capturing
        },
        () => {
          const observer = new execution.ExecutionObserver(threadId, this.nativeChildren);
          observer.take('turn/started', params);
          return observer;
        }
      );
    this.currentTurnId = turnId;
    this.latestTurnId = turnId;
  }

  private completeNotificationTurn(
    turnId: string,
    admission: CompletionAdmission | undefined
  ): void {
    // A completed turn should have resolved its own callbacks first. If it
    // did not, drop them rather than retaining ids nothing can safely
    // answer after completion — an error here is not a cancellation either,
    // it is an empty answer app-server would still submit.
    this.retireTurnRequests(turnId);
    if (admission === 'take') this.latestTurnId = turnId;
    if (admission === 'take' && warming(this.live)) this.rememberWarm(turnId);
    this.completedTurns.add(turnId);
    if (admission === 'drop') return;
    this.currentTurnId = undefined;
    this.unechoed?.();
    this.capture.releaseWake();
    this.capture.ended(this.live.cwd, {
      warm: this.live.warmTurn !== undefined,
      baselining: this.capturing
    });
  }

  private applyNotification(
    method: string,
    turnId: string | undefined,
    admission: LiveNotification,
    maintenance: boolean,
    at: number
  ): void {
    const { events, nativeWarm } = admission;
    // Usage names its turn, so a ping's cached input is taken however late
    // it lands, and nobody else's is.
    const pinged = this.warmTurnId !== undefined && turnId === this.warmTurnId;
    const ending = maintenance ? pingEnd(events) : undefined;
    if (!maintenance && events.some(closesTurn)) this.openWritten();
    // Codex idle precedes turn/completed (0.151, protocol.md). A later
    // frame of that still-owned turn cannot become a self-started real turn.
    const state =
      nativeWarm && this.live.warmTurn?.phase === 'closed' && opensTurn(events)
        ? { ...this.live, warmTurn: { ...this.live.warmTurn, phase: 'open' as const } }
        : this.live;
    let next = applyEvents(
      state,
      events.filter((event) => event.kind !== 'cache-read' || pinged)
    );
    if (ending) next = closeWarm(next, ending === 'failed');
    this.apply(
      next,
      method === 'thread/name/updated' ? 'local' : 'agent',
      ending && events.some((event) => event.kind === 'turn-end' && event.outcome === 'done')
        ? true
        : undefined,
      at
    );
  }

  private openingRequest(
    method: string,
    params?: unknown,
    cap = OPEN_REQUEST_MS
  ): Promise<unknown> {
    this.start.opening?.check();
    if (this.closed) return Promise.reject(new Error('Session closed while opening.'));
    return this.client
      .request(
        method,
        params,
        this.start.opening?.remaining(cap) ?? cap,
        this.start.opening?.signal
      )
      .then((value) => {
        this.start.opening?.check();
        if (this.closed) throw new Error('Session closed while opening.');
        return value;
      });
  }

  private failOpening(): void {
    if (this.start.failOpening) this.start.failOpening();
    else this.close();
  }

  private async open(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      let initialized: unknown;
      try {
        initialized = await this.initialize(true);
      } catch (error) {
        if (!(error instanceof CodexFailure) || (error.code !== -32601 && error.code !== -32602)) {
          throw error;
        }
        // Older app-servers can still run owned command/file approvals. Retry
        // their stable surface and lose only the experimental question path.
        initialized = await this.initialize(false);
      }
      if (
        !isRecord(initialized) ||
        typeof initialized.userAgent !== 'string' ||
        typeof initialized.codexHome !== 'string'
      ) {
        throw new Error('Codex returned a malformed initialize response');
      }
      this.client.notify('initialized');

      const params = openParams(this.start);
      if (this.start.briefing) {
        try {
          const response = await this.openingRequest(
            'config/read',
            { cwd: this.start.cwd, includeLayers: false },
            // Optional configuration consumes the same opening deadline.
            4_000
          );
          if (!isRecord(response) || !isRecord(response.config))
            throw new Error('Malformed configuration');
          const configured = response.config.developer_instructions;
          if (configured !== undefined && configured !== null && typeof configured !== 'string') {
            throw new Error('Malformed instructions');
          }
          params.developerInstructions = configured
            ? `${configured}\n\n${this.start.briefing}`
            : this.start.briefing;
        } catch {
          this.start.log?.(
            'Codex startup configuration unavailable; keeping existing instructions'
          );
        }
      }
      const result = this.start.resume
        ? await this.openingRequest('thread/resume', {
            threadId: this.start.resume,
            ...params,
            excludeTurns: true
          })
        : await this.openingRequest('thread/start', params);
      const opened = openedThread(result);
      if (!opened || (this.start.resume && opened.id !== this.start.resume)) {
        throw new Error('Codex did not open an input-capable thread');
      }
      this.threadId = opened.id;
      this.memory.begin(opened.id);
      this.apply({
        ...this.live,
        sessionId: opened.id,
        // Our own record — Codex publishes no stable transcript file
        // (`cli_state/codex/README.md`), and `CodexTee` writes every completed
        // item here. Left unset, `copyRef` copied the `''` that `toSession`
        // folds it to and `squadron-list` reported `transcript: null` — both
        // quiet rather than wrong, which is why it survived C2–C5 (2026-09-02).
        //
        // Not free: `host/panel.ts`'s `readCompletion` is guarded on this field
        // being truthy, so a Codex card that short-circuited now takes that
        // per-poll read. `workflowDates` no longer reads this field at all —
        // it asks `CliAdapter.lastPromptAt`, and this brand's answer is the
        // same record by session id rather than by path. Nor is the file there
        // yet — `appendLine` runs at the first completed item, so
        // `cli/list.ts` still stats it away until this session speaks.
        transcript: recordFile(opened.id),
        cwd: opened.cwd,
        originCwd: opened.cwd,
        model: opened.model,
        effort: opened.effort ?? this.live.effort,
        title: opened.title,
        permissionMode: opened.permissionMode ?? this.live.permissionMode,
        status: opened.status ?? 'idle',
        running: opened.status === 'busy'
      });
      this.opened = true;
      if (this.executionRuntime.enabled)
        void execution.diagnose(
          this.client,
          opened.cwd,
          this.start.log,
          this.executionRuntime.contextFile
        );
      this.unregisterReader = registerTranscriptReader(opened.id, () =>
        readPaginated(this.client, { sessionId: opened.id, cwd: opened.cwd })
      );
      return { ok: true };
    } catch (error) {
      this.failOpening();
      return {
        ok: false,
        reason: this.start.resume
          ? `That Codex conversation could not be opened: ${words(error)}`
          : `Codex app-server could not open a thread: ${words(error)}`
      };
    }
  }

  private async inputFor(
    head: NonNullable<LiveState['queued'][number]>
  ): Promise<{ input: Record<string, unknown>[]; refs: (ImageRef | undefined)[] }> {
    const input: Record<string, unknown>[] = [];
    // Positional: a copy that failed keeps its slot, so the images after it are
    // still read against the message that carried them.
    const refs: (ImageRef | undefined)[] = [];
    const sessionId = this.threadId;
    for (const segment of segments(head)) {
      if (segment.text) input.push({ type: 'text', text: segment.text, text_elements: [] });
      for (const image of segment.images) {
        const ref = sessionId ? await writeAttachment(sessionId, image) : undefined;
        const file = ref && attachmentFile(ref.id);
        refs.push(ref);
        input.push(
          file
            ? { type: 'localImage', path: file }
            : { type: 'image', url: `data:${image.mediaType};base64,${image.data}` }
        );
      }
    }
    return { input, refs };
  }

  /**
   * The thread's history, through the reader `open` registered on this
   * session's own client — joined with a poll asking at the same moment, and
   * never a second app-server: once the reader is gone, so is the client.
   */
  private history(threadId: string): Promise<History> {
    const read = activeTranscriptReader(threadId);
    return read ? read() : Promise.reject(new Error('the app-server has gone'));
  }

  private initialize(experimentalApi: boolean): Promise<unknown> {
    return this.openingRequest('initialize', {
      clientInfo: { name: 'squadron', title: 'Squadron', version: '0' },
      capabilities: {
        experimentalApi,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
  }

  private async tryDrain(): Promise<void> {
    await this.opening.catch(() => undefined);
    if (!this.drainable() || !this.threadId) return;
    this.apply(mergeQueued(this.live));
    const [head] = this.live.queued;
    if (!head) return;
    this.writePending = true;
    try {
      this.capturing = true;
      const under = this.threadId;
      const turn = randomUUID();
      const enabled = await executionRuntime.admitExecution(
        this.executionRuntime,
        'codex',
        under,
        turn
      );
      if (this.closed) return;
      await this.checkpoints.open(this.live.cwd, {
        owner: identity.conversationKey('codex', under),
        runtime: this.executionRuntime.runtime,
        turn,
        enabled
      });
      this.capturing = false;
      if (
        this.closed ||
        this.sending ||
        this.currentTurnId ||
        !canDrain(this.live) ||
        this.live.queued[0]?.id !== head.id
      ) {
        this.checkpoints.discard();
        return;
      }
      const observer = new execution.ExecutionObserver(under, this.nativeChildren);
      this.capture.install(observer);
      const { input, refs } = await this.inputFor(head);
      if (
        this.closed ||
        this.sending ||
        this.currentTurnId ||
        !canDrain(this.live) ||
        this.capture.observer !== observer ||
        this.live.queued[0]?.id !== head.id
      ) {
        this.capture.discard();
        return;
      }
      this.recordSend(head, refs);
      this.apply(dequeueHead(this.live), 'prompt');
      await this.startTurn(head, input);
    } catch (error) {
      this.startFailed(head, error);
    } finally {
      this.capturing = false;
      this.writePending = false;
      await this.tryDrain();
    }
  }

  private drainable(): boolean {
    return (
      !this.closed &&
      !this.recoveryPending() &&
      !this.capturing &&
      this.opened &&
      Boolean(this.threadId) &&
      !this.writePending &&
      !this.sending &&
      !this.currentTurnId &&
      canDrain(this.live)
    );
  }

  /**
   * One cache-warming ping, written now or refused now. The drain's own
   * latches, strictly: a ping never rides a turn Codex started itself, and
   * never jumps a held message, which is real work.
   */
  ping(): WarmAttempt {
    const refused = this.warmRefusal();
    if (refused) return { ok: false, reason: refused };
    const entry: QueuedMessage = {
      id: `warm:${randomUUID()}`,
      text: wrapWarm(WARM_PROMPT),
      queuedAt: Date.now(),
      warm: true
    };
    this.writePending = true;
    this.warmTurnId = undefined;
    this.recordSend(entry, []);
    this.apply(warmDrain(this.live, entry), 'prompt');
    // `startTurn` reaches the wire before its first await.
    void this.startTurn(entry, [{ type: 'text', text: entry.text, text_elements: [] }]).finally(
      () => {
        this.writePending = false;
        void this.tryDrain();
      }
    );
    return { ok: true };
  }

  private warmRefusal(): string | undefined {
    if (this.closed || this.live.exit) return WARM_SESSION_ENDED;
    if (!this.opened || !this.threadId) return WARM_NO_CONVERSATION;
    if (this.live.queued.length) return WARM_MESSAGE_WAITING;
    if (
      this.recoveryPending() ||
      this.writePending ||
      this.capturing ||
      this.sending ||
      this.currentTurnId ||
      this.turnRequest ||
      this.live.status !== 'idle' ||
      !canDrain(this.live)
    ) {
      return WARM_NOT_IDLE;
    }
    return undefined;
  }

  private admitRequest(parsed: ParsedCodexRequest, at: number): void {
    const warm = this.warmTurns.get(parsed.turnId);
    if (
      this.completedTurns.has(parsed.turnId) ||
      (this.currentTurnId !== undefined && parsed.turnId !== this.currentTurnId) ||
      (warm && warm.id !== this.live.warmTurn?.id) ||
      (warming(this.live) && !this.ownsWarmTurn(parsed.turnId))
    ) {
      this.rejectRequest(parsed);
      return;
    }
    if (this.ownsWarmTurn(parsed.turnId)) {
      this.refuseWarm(parsed, at);
      return;
    }
    if (this.start.skipPermissions === true && !parsed.ask) {
      const response = parsed.response({ allow: true });
      if (response) this.client.reply(parsed.protocolId, response);
      else this.rejectRequest(parsed);
      return;
    }
    this.requests.set(parsed.key, parsed);
    this.apply(applyEvent(this.live, parsed.waiting), 'agent', undefined, at);
  }

  private rejectRequest(parsed: ParsedCodexRequest): void {
    this.client.fail(parsed.protocolId, { code: -32602, message: 'Invalid params' });
  }

  /**
   * A ping's request, refused before it reaches the card or the auto-allow.
   * A permission is declined. A question is left to the interrupt, which
   * retracts it: an error reply is submitted as empty answers and the turn
   * goes on (0.151, `interrupt`).
   */
  private refuseWarm(parsed: ParsedCodexRequest, at: number): void {
    if (parsed.ask) {
      this.requests.set(parsed.key, parsed);
    } else {
      const response = parsed.response({ allow: false });
      if (response) this.client.reply(parsed.protocolId, response);
      else this.client.fail(parsed.protocolId, { code: -32602, message: 'Invalid params' });
    }
    this.cutWarm(at);
  }

  /**
   * A ping reached for a tool: mark it failed and interrupt the turn. The
   * latch stays until the turn's own completion says it closed.
   */
  private cutWarm(observedAt?: number): void {
    const warm = this.live.warmTurn;
    if (!warm || warm.failed) return;
    this.apply(failWarm(this.live), 'agent', false, observedAt);
    if (warming(this.live) || this.ownsWarmTurn()) void this.interrupt().catch(() => undefined);
  }

  /** `turn/start` for a message already drawn as sent, settled into state. */
  private async startTurn(head: QueuedMessage, input: Record<string, unknown>[]): Promise<void> {
    try {
      const sentModel = head.target?.model ?? this.live.model;
      const sentEffort = codexEffort(sentModel, head.target?.effort ?? this.live.effort);
      // Before the write, so a completion delivered inside it is judged
      // against this window and not against an id we do not have yet.
      this.startingTurn = true;
      const request = this.client
        .request('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: head.id,
          input,
          cwd: this.live.cwd,
          approvalPolicy: this.start.skipPermissions === true ? 'never' : 'on-request',
          sandboxPolicy:
            this.start.skipPermissions === true
              ? { type: 'dangerFullAccess' }
              : {
                  type: 'workspaceWrite',
                  writableRoots: [],
                  networkAccess: false,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false
                },
          ...(sentModel ? { model: sentModel } : {}),
          ...(sentEffort ? { effort: sentEffort } : {})
        })
        .then((result) => startedTurnId(result));
      this.turnRequest = request;
      const turnId = await request;
      if (!turnId) throw new Error('Codex returned a malformed turn/start response');
      this.latestTurnId = turnId;
      this.currentTurnId = turnId;
      if (head.warm) this.rememberWarm(turnId);
      this.messageTurns.remember(turnId, head);
      this.startingTurn = false;
      this.resolveFrames(turnId);
      if (this.completedTurns.has(turnId)) {
        // A frame naming no turn after the completion re-busies the card,
        // and this response is not the catch.
        if (this.live.running) {
          // Our own turn, after its drain's baseline: neither latch can hold here.
          if (!head.warm) this.capture.ended(this.live.cwd, { warm: false, baselining: false });
          this.apply(applyEvent(this.live, { kind: 'turn-end' }), 'agent');
        }
        if (head.warm) this.apply(closeWarm(this.live, false), 'agent');
        this.currentTurnId = undefined;
      } else {
        this.currentTurnId = turnId;
      }
      if (sentModel) {
        this.nextModel = sentModel;
        this.apply({ ...this.live, model: sentModel });
      }
      // The stable surface never pushes `thread/settings/updated`, so a turn's
      // effort is only on record because this sent it.
      if (sentEffort && sentEffort !== this.live.effort) {
        this.apply({ ...this.live, effort: sentEffort });
      }
    } catch (error) {
      this.startingTurn = false;
      this.resolveFrames();
      this.startFailed(head, error);
    } finally {
      this.turnRequest = undefined;
      this.startingTurn = false;
    }
  }

  /**
   * Our write's turn, opened before a close of it that no frame opened, as a
   * change of its own so the running edge is seen both ways. `local`: the
   * write moved the activity clock already, and the close moves the cache's.
   */
  private openWritten(): void {
    this.apply(openWritten(this.live), 'local');
  }

  /** A start that threw, before the write or on it. */
  private startFailed(head: QueuedMessage, error: unknown): void {
    // The exit rejects a pending start at once, ahead of frames still on
    // stdout; its close ends the conversation (`ended`), and they land first.
    if (!(error instanceof CodexExited)) {
      this.memory.current.cutOpen();
      this.projection.end();
      // Refused by Codex, the turn never began and the message was never said.
      this.unechoed?.(error instanceof CodexFailure ? [] : undefined);
    }
    if (head.warm) {
      // Refused, the ping definitely never ran. A timeout or a reply with
      // no turn id leaves it unconfirmed, so the latch holds the drain
      // until a completion or Send now; the exit closes it by itself.
      if (error instanceof CodexFailure) this.apply(closeWarm(this.live, true));
      return;
    }
    // Unguarded on purpose: a start that threw ends the turn it opened, even one
    // that threw while its drain still held the baseline latch.
    this.capture.ended(this.live.cwd, { warm: false, baselining: false });
    this.currentTurnId = undefined;
    // An error object the app-server returned is the turn failing. A
    // timeout or a response with no turn id is ours, and states nothing
    // (PRD A11). Either way the turn ends, opened first if no frame did.
    this.openWritten();
    this.apply(
      applyEvent(
        this.live,
        error instanceof CodexFailure
          ? { kind: 'turn-end', outcome: 'error' }
          : { kind: 'turn-end' }
      )
    );
  }

  /**
   * A drained message, drawn the moment it is sent and recorded as what we
   * sent (`sentTurns`). Its echo, the user item naming our client id, only
   * witnesses it: its item id and time. A turn that ends with none —
   * interrupted, failed, the child gone — keeps it unwitnessed, at the time
   * it was sent, since that is the question the reader most needs.
   */
  private recordSend(
    head: NonNullable<LiveState['queued'][number]>,
    refs: readonly (ImageRef | undefined)[]
  ): void {
    // One turn at a time: a send still unechoed here had its turn end unseen.
    this.unechoed?.();
    const sentAt = Date.now();
    const said = this.memory.current.awaiting(
      `send:${randomUUID()}`,
      sentTurns(head, refs, sentAt)
    );
    const unechoed = (kept: readonly RecordLine[] = sentTurns(head, refs, sentAt)): void => {
      if (this.unechoed === unechoed) this.unechoed = undefined;
      this.tee.settle(head.id);
      said(kept);
    };
    this.unechoed = unechoed;
    this.tee.attach(head.id, refs, head, (echoed) => {
      if (this.unechoed === unechoed) this.unechoed = undefined;
      said(echoed);
    });
  }

  private resolveFrames(turnId?: string): void {
    const pending = this.pendingFrames;
    this.pendingFrames = [];
    const ended = new Set(
      pending.flatMap((frame) =>
        frame.kind === 'notification' && frame.method === 'turn/completed'
          ? [notificationTurnId(frame.params)]
          : []
      )
    );
    for (const frame of pending) {
      if (frame.kind === 'request') {
        // Native completion has already retired the callback, even when its
        // ownership was waiting for turn/start (protocol.md, Interrupt).
        if (ended.has(frame.request.turnId)) continue;
        if (turnId === frame.request.turnId) this.admitRequest(frame.request, frame.at);
        else this.rejectRequest(frame.request);
        continue;
      }
      const native = notificationTurnId(frame.params);
      if (turnId && (native === turnId || frame.method === 'thread/status/changed'))
        this.receive(frame.method, frame.params, frame.at);
      else {
        this.record(
          frame.method,
          frame.params,
          eventsFrom(frame.method, frame.params, this.threadId),
          frame.at,
          true
        );
        if (frame.method === 'turn/completed' && native) this.completedTurns.add(native);
      }
    }
  }

  private unconfirmedTurn(turnId: string): boolean {
    return (
      this.startingTurn &&
      turnId !== this.currentTurnId &&
      !this.warmTurns.has(turnId) &&
      !this.completedTurns.has(turnId)
    );
  }

  private ownsWarmTurn(turnId = this.currentTurnId): boolean {
    return (
      turnId !== undefined &&
      turnId === this.currentTurnId &&
      !this.completedTurns.has(turnId) &&
      this.live.warmTurn !== undefined &&
      this.warmTurns.get(turnId)?.id === this.live.warmTurn.id
    );
  }

  private historicalTurn(turnId: string): boolean {
    const warm = this.warmTurns.get(turnId);
    if (warm) return this.completedTurns.has(turnId) || warm.id !== this.live.warmTurn?.id;
    const current = this.currentTurnId ?? (this.startingTurn ? undefined : this.latestTurnId);
    return this.completedTurns.has(turnId) && turnId !== current;
  }

  private record(
    method: string,
    params: Record<string, unknown>,
    events: readonly SessionEvent[],
    at: number,
    isolated = false
  ): void {
    try {
      const turnId = notificationTurnId(params);
      const warm = turnId ? this.warmTurns.get(turnId) : undefined;
      const historical =
        isolated ||
        (turnId !== undefined &&
          (this.historicalTurn(turnId) ||
            (this.currentTurnId !== undefined && turnId !== this.currentTurnId) ||
            (warming(this.live) && !warm)));
      this.projection.take(this.memory.current, method, params, events, {
        at,
        turnId,
        historical,
        isolated,
        completed: turnId !== undefined && this.completedTurns.has(turnId),
        owner:
          turnId === undefined
            ? undefined
            : { maintenance: warm !== undefined, ...(warm ? { warmId: warm.id } : {}) }
      });
    } catch {
      // The transcript is best-effort and must never stop the protocol reader.
    }
  }

  readout(text: string): void {
    this.recordLines([localReply(text, Date.now())]);
  }

  private recordLines(lines: readonly RecordLine[]): void {
    if (lines.length) this.memory.current.note(lines);
  }

  /**
   * Dropping an unseen completion, or a repeat of the id this window already
   * took, leaves the card busy: the response does not end an id already
   * completed.
   */
  private admitCompletion(turnId: string): CompletionAdmission {
    if (this.currentTurnId !== undefined && this.currentTurnId !== turnId) return 'drop';
    if (!this.completedTurns.has(turnId)) return 'take';
    if (this.startingTurn) return 'drop';
    return 'strip';
  }

  private retireRequest(requestId: string): void {
    this.pendingFrames = this.pendingFrames.filter(
      (frame) => frame.kind !== 'request' || frame.request.key !== requestId
    );
    if (!this.requests.delete(requestId)) return;
    this.apply(answered(this.live, requestId));
  }

  private retireTurnRequests(turnId: string): void {
    let next = this.live;
    for (const [requestId, request] of this.requests) {
      if (request.turnId !== turnId) continue;
      this.requests.delete(requestId);
      next = answered(next, requestId);
    }
    this.apply(next);
  }

  private retireAllRequests(): void {
    this.pendingFrames = this.pendingFrames.filter((frame) => frame.kind !== 'request');
    let next = this.live;
    for (const requestId of this.requests.keys()) next = answered(next, requestId);
    this.requests.clear();
    this.apply(next);
  }

  private apply(
    next: LiveState,
    origin: ChangeOrigin = 'local',
    cacheTraffic?: boolean,
    observedAt?: number
  ): void {
    next = this.messageTurns.apply(this.live, next);
    if (next === this.live) return;
    if (
      next.warmTurn &&
      activity.advancesCacheClock({
        origin,
        running: next.running,
        wasRunning: this.live.running,
        cacheTraffic
      })
    ) {
      const at = observedAt ?? Date.now();
      next = {
        ...next,
        warmTurn: { ...next.warmTurn, trafficAt: Math.max(next.warmTurn.trafficAt ?? at, at) }
      };
    }
    this.memory.current.observeWarm(next.warmTurn);
    if (
      this.warmTurnId &&
      next.warmTurn &&
      next.warmTurn.id === this.warmTurns.get(this.warmTurnId)?.id
    )
      this.warmTurns.set(this.warmTurnId, next.warmTurn);
    this.live = next;
    for (const listener of this.listeners) listener(next, origin, cacheTraffic, observedAt);
  }

  private rememberWarm(turnId: string): void {
    if (!this.live.warmTurn) return;
    this.warmTurnId = turnId;
    this.warmTurns.set(turnId, this.live.warmTurn);
  }
}

function notificationTurnId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.turnId === 'string' && value.turnId) return value.turnId;
  return isRecord(value.turn) && typeof value.turn.id === 'string' && value.turn.id
    ? value.turn.id
    : undefined;
}

/** Completed commands outlive their turn in 0.160.1 (cli_state/codex/protocol.md). */
function ofTurn(method: string): boolean {
  return method === 'turn/started' || method.startsWith('item/');
}

/** How a frame ends a ping in flight: its admitted completion, or a thread
 *  that can no longer say. */
function pingEnd(events: readonly SessionEvent[]): 'ended' | 'failed' | undefined {
  for (const event of events) {
    if (event.kind === 'status' && event.status === 'unknown') return 'failed';
    if (event.kind === 'turn-end') return pingFailed(event.outcome) ? 'failed' : 'ended';
  }
  return undefined;
}

function opensTurn(events: readonly SessionEvent[]): boolean {
  return events.some(
    (event) =>
      (event.kind === 'status' && event.status === 'busy') ||
      event.kind === 'text' ||
      event.kind === 'thought' ||
      reachesForTool(event)
  );
}

function startedTurnId(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.turn) && typeof value.turn.id === 'string'
    ? value.turn.id
    : undefined;
}

function completionEvents(
  events: readonly SessionEvent[],
  admission: CompletionAdmission | undefined
): readonly SessionEvent[] {
  if (admission === 'drop') return events.filter((event) => event.kind !== 'turn-end');
  if (admission === 'strip')
    return events.map((event): SessionEvent =>
      event.kind === 'turn-end'
        ? { kind: 'turn-end', ...(event.turnId ? { turnId: event.turnId } : {}) }
        : event
    );
  return events;
}
