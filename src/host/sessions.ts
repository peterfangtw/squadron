import * as usageCoordination from '../core/coordination/usage';
import { CLOSE_ALL_MS, within, type Consumer } from '../core/shutdown';
import { reserveStartup, type Reservation } from '../core/coordination/startup_records';
import { StartupAttempt, type AttemptResult, type StartOutcome } from '../core/startup';
import { SessionLifetime } from '../core/session_lifetime';
/**
 * The sessions this window started and drives, as opposed to the ones it merely
 * watches.
 *
 * Module-scoped rather than owned by the panel, deliberately: closing the panel
 * must not kill a session, and the request watcher starts sessions with no panel
 * open at all. The lifetime is the extension host's — which is the same lifetime
 * the `hideFromUser` terminals had, since neither is restored on a window
 * reload.
 *
 * **What actually ends a child is stdin EOF, not `deactivate`.** The CLI
 * requires a readable stdin for the lifetime of a stream-json session, so when
 * the host goes the pipe closes and the session ends with it — including on the
 * paths where `deactivate` never runs at all (a crash, a `SIGKILL`, a host the
 * IDE tears down without asking). `closeAll` is the tidy path, not the
 * guarantee.
 */
import * as ownedIncoming from '../core/owned_incoming';
import type {
  IncomingEvidenceQuery,
  IncomingEvidence,
  IncomingAccess,
  IncomingDelivery
} from '../core/bridge/model';
import type { RemoteFilesStart } from '../core/coordination/serve_owned';
import type { Reply } from '../core/coordination/requests';
import * as warmChoice from '../core/warm_choice';
import { DEFAULT_BRAND, mapBrands, sessionBrand } from '../core/brands';
import * as paths from '../core/paths';
import { WARM_SETTINGS, WARM_TTL_KEYS, warmPolicy, type WarmPolicy } from '../core/warm_policy';
import { randomUUID } from 'crypto';
import * as path from 'node:path';
import * as checkpoint from '../core/checkpoint';
import * as execution from '../core/execution';
import * as vscode from 'vscode';
import {
  CANNOT_START_CLI,
  adapter,
  advancesActivityClock,
  advancesCacheClock,
  brandForStart,
  conversationKey,
  refusal
} from '../core/adapter';
import { windowOf, windowTokens } from '../core/catalog';
import type { ChangeOrigin, SessionHandle } from '../core/adapter';
import { configuredPath } from './cli_path';
import { ReapOwner, SignalEnd, endBySignal } from '../core/control';
import { writeLineage } from '../core/coordination/lineage';
import { LiveState, OwnedFacts, shownStatus, toSession, withStated } from '../core/live';
import { EndingSessions } from '../core/ending';
import { BrandId, LaunchTarget, Session } from '../core/model';
import { writeStatedName } from '../core/names';
import { forgetProgress, workflowFirstTurn } from '../core/workflows/progress';
import {
  publishLive,
  removePublished,
  readPublishedEvidence,
  conversationOwner
} from '../core/published';
import { scanProcesses } from '../core/scan';
import { routeTo, isRefused, UNROUTED, type Act } from '../core/coordination/route';
import { BRIEFING } from '../core/briefing';
import { childTransport, writeLaunchFiles, closeUnprompted } from '../core/session';
import { type Recipient, recipient, wrapMessage } from '../core/coordination/send';
import {
  checkSpawnIdentity,
  promptLabel,
  sessionName,
  type SpawnParent
} from '../core/coordination/spawn';
import { ReadWorkflow } from '../core/workflows/workflows';
import { recordedActivityAt } from '../core/record';

/** One live child, and the few things about it that no frame states. */
type Entry = {
  ready?: true;
  lifetime: SessionLifetime;
  usageGeneration: string;
  responseTimer?: NodeJS.Timeout;
  responseObserved?: true;
  incoming?: ownedIncoming.OwnedIncoming;
  launchCwd: string;
  execution?: execution.ExecutionRuntime;
  session: SessionHandle;
  pid: number;
  startedAt: number;
  /** Which CLI this is, from the adapter that started it. Held rather than
   *  re-derived: it is what `toSession` marks the card with, and nothing on
   *  the pipe restates it. */
  brand: BrandId;
  /** The name this session was started under, when somebody gave it one.
   *  Held here rather than read back: `--name` lands in the session file and
   *  the transcript, and neither is on the pipe this session is known through. */
  name?: string;
  /** Card placeholder, never a command-line name. See OwnedFacts.placeholder. */
  placeholder?: string;
  /**
   * Hold the stated name outside LiveState: it is not a frame, and every publish
   * folds it into the reducer's answer.
   */
  stated?: string;
  /** The session id that statement has been written to the store under, so a
   *  rename taken before the CLI named the session can be written the moment an
   *  id lands. The key rather than a boolean, so an id that *moves* — a `/clear`
   *  mints a new one — is written again rather than left on the old key. */
  statedKey?: string;
  warm?: warmChoice.WarmChoice;
  warmKey?: string;
  warmFailureAt?: number;
  /** Activity clock: prompts and turned-session frames, never panel bookkeeping. Seed resumes from the transcript, not the spawn. */
  updatedAt: number;
  cacheAt?: number;
  wasRunning: boolean;
  /** Spawn parent, when the start named one. */
  parentSessionId?: string;
  /** Fan-out origin resolved at the start. Discovery may not have a file yet. */
  originSessionId?: string;
  /** The first-turn latch; see startOwned's listener. */
  turned?: true;
  /** Cancel the trailing publish at removal, or its write puts the file back. */
  publishTimer?: NodeJS.Timeout;
  /** Hold last published status so changes jump the debounce without a stat per delta. */
  lastStatus?: Session['status'];
  /** The child's own exit, seen. `state.exit` is not that: it latches on the
   *  first of exit, spawn error and a stdin write error, and the last one
   *  arrives after `close()` while the process still runs. */
  gone?: true;
};

export type StartResult = StartOutcome;

/** The pick itself was refused. A missing pid is not this: the child never chose a model. */
function pickRefused(reason: string): AttemptResult {
  return { ok: false, reason, cause: 'pick' };
}

let incomingHost: ownedIncoming.IncomingHost | undefined;
export function activateIncomingOwner(): void {
  incomingHost = new ownedIncoming.IncomingHost(vscode.env.sessionId);
}
export function ownedHostIdentity(): Promise<IncomingAccess | undefined> {
  return incomingHost?.capability() ?? Promise.resolve(undefined);
}
export async function ownedIncomingEvidence(
  challenge: string,
  query: IncomingEvidenceQuery
): Promise<IncomingEvidence | undefined> {
  const owners = [...entries.values()].flatMap((entry) => (entry.incoming ? [entry.incoming] : []));
  return incomingHost?.evidence(owners, challenge, query, async (owner) => {
    const entry = entries.get(owner.receiverIdentity.pid);
    return entry?.incoming === owner ? publish(entry, true) : false;
  });
}
export async function deliverIncoming(
  pid: number,
  delivery: IncomingDelivery,
  outcome: 'send' | 'person-answer',
  send: () => Promise<Reply>
): Promise<Reply> {
  const entry = entries.get(pid);
  if (!entry?.incoming)
    return {
      ok: false,
      reason: 'Incoming file evidence is unavailable.',
      incomingRefusal: 'evidence-unavailable'
    };
  return entry.incoming.deliver(delivery, outcome, send, () => publish(entry, true));
}
export function ownedIncomingSnapshot(
  pid: number
): ReturnType<ownedIncoming.OwnedIncoming['snapshot']> | undefined {
  return entries.get(pid)?.incoming?.snapshot();
}
const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();

/**
 * Sessions an end was sent to, from the send until their child is seen to
 * exit. Out of `entries`, so every verb and every publisher already treats them
 * as gone; only the board reads them, as the card they wore when the pipe
 * closed. Nothing replies to an end, so the exit is the only proof it worked.
 */
const ending = new EndingSessions();
const threadListeners = new Set<(pid: number) => void>();
const endListeners = new Set<(ended: { pid: number; startedAt: number }) => void>();

/**
 * The most often one session's live half is written to disk.
 *
 * `--include-partial-messages` makes a turn tens of delta frames, and a file
 * write each would be one per frame per session — and, because the panel
 * watches every `.json` under the status directory, a repaint each in every
 * window on the machine. Trailing, so the state that lands is the one after the
 * burst rather than the one that opened it.
 *
 * Nothing jumps it, not even a dialog opening or the session ending. Half a
 * second is under the delay of the click that answers such a dialog, and well
 * under the poll that would have shown it before any of this existed — where an
 * exemption costs a copy of "what did the last publish say" per session.
 *
 * **This is now the faster of the two, and the envelope argument that picked it
 * has inverted.** It was chosen as two writes a second against the five repaints
 * a *local* owned turn then cost through `OWNED_MS`; that constant is 1000 ms
 * since it was measured, so a local turn repaints once a second and this writes
 * twice. Harmless — the reading window's own `LIVE_MS` rate-limits at 1000 ms
 * anyway, so the extra write is coalesced at the far end rather than paid there.
 * Worth knowing before this number is defended as a ceiling again.
 */
const PUBLISH_MS = 500;

const lifetimes = new Set<SessionLifetime>();
const stoppingEntries = new Set<Entry>();
let shuttingDown = false;
type StartRecord = {
  attempt: StartupAttempt;
  fingerprint: string;
  result: Promise<StartResult>;
  outcome?: StartResult;
  lifetime?: SessionLifetime;
  entry?: Entry;
  reservation?: Reservation;
  promptReleased?: boolean;
};
const starts = new Map<string, StartRecord>();

export function startupStatus(id: string): {
  pending: boolean;
  stage?: string;
  result?: StartResult;
} {
  const record = starts.get(id);
  return record
    ? {
        pending: !(record.outcome ?? record.attempt.outcome),
        stage: record.attempt.stage,
        result: record.outcome ?? record.attempt.outcome
      }
    : { pending: false };
}

export function aliasStartup(id: string, original: string): void {
  const record = starts.get(original);
  if (record && !starts.has(id)) starts.set(id, record);
}

export async function reconcileStart(id: string): Promise<void> {
  const record = starts.get(id);
  if (!record) return;
  const result = await record.attempt.reconcile();
  if (result?.ok === false && result.outcome === 'stopped' && record.lifetime) {
    await record.reservation?.release();
    lifetimes.delete(record.lifetime);
    if (record.entry && entries.get(record.entry.pid) === record.entry)
      entries.delete(record.entry.pid);
  }
}

export async function cancelStartup(id: string): Promise<void> {
  const record = starts.get(id);
  if (!record) return;
  record.attempt.stop();
  await record.result;
  const entry = record.entry;
  const result = record.outcome ?? record.attempt.outcome;
  if (!result?.ok || !entry) return;
  if (
    entry.session.state.firstPrompt ||
    entry.session.state.running ||
    entry.session.state.queued.length
  ) {
    record.outcome = {
      ok: false,
      outcome: 'unknown',
      reason: 'The session is already active. Inspect it before sending again.'
    };
    return;
  }
  entry.ready = undefined;
  stoppingEntries.add(entry);
  entries.delete(entry.pid);
  void publishStopping(entry);
  const cancelling = record.attempt.cancelHandoff();
  const cancelled = await cancelling;
  if (cancelled?.ok === false && cancelled.outcome === 'stopped') {
    await record.reservation?.release();
    lifetimes.delete(entry.lifetime);
  }
  if (cancelled) record.result = Promise.resolve(cancelled);
}

function retainLifetime(lifetime: SessionLifetime): void {
  lifetimes.add(lifetime);
}

function stopLifetime(
  lifetime: SessionLifetime
): Promise<import('../core/session_lifetime').CleanupResult> {
  return lifetime.reconcile().then((result) => {
    if (lifetime.descendantCoverage === 'limited')
      log(`cleanup ${result}; descendant coverage limited`);
    if (result === 'gone') lifetimes.delete(lifetime);
    return result;
  });
}

/** Somewhere to say what happened, since a spawn from here reveals nothing. */
let log: (line: string) => void = () => {};

export async function setExecutionEnabled(enabled: boolean): Promise<void> {
  await Promise.all(
    [...entries.values()].map(async (entry) => {
      const runtime = entry.execution;
      if (!runtime?.contextFile) return;
      await execution.setExecutionEnabled(runtime, enabled);
    })
  );
}

export function setOwnedLog(sink: (line: string) => void): void {
  log = (line) => {
    try {
      sink(line);
    } catch {
      /* The output channel can close before native cleanup finishes. */
    }
  };
}

/** Notify changes before the poll; listeners re-read ownedSessions. */
export function onOwnedChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A session's thread may have moved (`Thread.onChange`): the pid whose, said
 *  synchronously and not deduplicated — a listener asks for a read later. */
export function onOwnedThreadChange(listener: (pid: number) => void): () => void {
  threadListeners.add(listener);
  return () => threadListeners.delete(listener);
}

/** An owned end was accepted: the pipe closed and the entry left the registry.
 *  Carries the incarnation, so a listener can match a recycled pid. */
export function onOwnedEnd(
  listener: (ended: { pid: number; startedAt: number }) => void
): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

function announceEnd(ended: { pid: number; startedAt: number }): void {
  for (const listener of endListeners) listener(ended);
}

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Build with toSession because the reading window folds exactly this onto its
 * discovered twin. Pending requests, outbox and live text ride beside it because
 * another window needs them to draw the card and Session has no fields for them.
 */
function publish(entry: Entry, required = false): Promise<boolean> {
  if (entries.get(entry.pid) !== entry || (!entry.ready && !required))
    return Promise.resolve(false);
  clearTimeout(entry.publishTimer);
  entry.publishTimer = undefined;
  const state = liveOf(entry);
  const session = toSession(state, factsOf(entry), vscode.env.sessionId);
  if (entry.incoming && session.cwd === entry.launchCwd)
    session.cwd = entry.incoming.receiverIdentity.cwd;
  entry.lastStatus = session.status;
  return publishLive(
    {
      ...entry.incoming?.snapshot(),
      schema: 1,
      session,
      pending: state.pending,
      ...(state.messageFacts === undefined ? {} : { messageFacts: state.messageFacts }),
      // Keep image bytes here and publish their count so image-only rows are visible.
      // Remote dismiss and send-now route here by id or whole-outbox flush.
      queued: state.queued.map(({ id, text, queuedAt, images }) => ({
        id,
        text,
        queuedAt,
        images: images?.length
      })),
      exit: state.exit
    },
    required
  );
}

function publishStopping(entry: Entry): Promise<boolean> {
  clearTimeout(entry.publishTimer);
  clearTimeout(entry.responseTimer);
  entry.publishTimer = undefined;
  const session = toSession(liveOf(entry), factsOf(entry), vscode.env.sessionId);
  return publishLive(
    {
      ...entry.incoming?.snapshot(),
      schema: 1,
      session,
      pending: [],
      queued: [],
      stopping: {
        members: entry.lifetime.knownMembers.map(({ pid, startedAt }) => ({ pid, startedAt }))
      }
    },
    true
  );
}

/**
 * The state a card is built from: the frames' own answer, plus the one thing no
 * frame carries.
 *
 * A rename is nobody's frame, so the reducer never hears about it and the
 * statement lives on the entry. Folded in at every read rather than written into
 * the handle's state, so `core/live.ts` stays the frames' reducer and the
 * statement survives whatever the pipe does next — including the `/clear` that
 * drops the CLI's own generated title.
 */
function liveOf(entry: Entry): LiveState {
  return entry.stated === undefined
    ? entry.session.state
    : withStated(entry.session.state, entry.stated);
}

function factsOf(entry: Entry): OwnedFacts {
  return {
    ...entry,
    warm: warmChoice.effectiveWarm(
      entry.warm,
      vscode.workspace.getConfiguration('squadron').get<boolean>('warmCache.enabled', false)
    ),
    warmArmedAt: Math.max(entry.warm?.statedAt ?? 0, entry.startedAt, defaultChangedAt),
    warmSupported: entry.session.warm !== undefined,
    warmPolicy: readWarmPolicy()
  };
}

/** The warm figures as the IDE's settings hold them, normalised. Read where
 *  they are used rather than cached, so no reader is left on a stale copy. */
export function readWarmPolicy(): WarmPolicy {
  const cfg = vscode.workspace.getConfiguration('squadron.warmCache');
  return warmPolicy({
    ttlMinutes: mapBrands((brand) => cfg.get<unknown>(WARM_SETTINGS[WARM_TTL_KEYS[brand]].setting)),
    bufferMinutes: cfg.get<unknown>('bufferMinutes'),
    windowMinutes: cfg.get<unknown>('windowMinutes')
  });
}

/** When the new-session default last changed in this window: it arms every
 *  session it governs, so a window that ended before it lapses nothing. */
let defaultChangedAt = 0;

/** A warm setting changed. Every entry is republished, since the figures move
 *  each one's published TTL (what `cli/wait_plan.ts` budgets from), not only
 *  the unstated choices the default governs. */
export function republishAllWarm(defaultChanged: boolean): void {
  if (defaultChanged) defaultChangedAt = Date.now();
  for (const entry of entries.values()) void publish(entry);
  announce();
}

/** Transient refusal/miss state belongs to the live pipe, never the choice store. */
export function setWarmFailure(pid: number, at: number | undefined): void {
  const entry = entries.get(pid);
  if (!entry || entry.warmFailureAt === at) return;
  entry.warmFailureAt = at;
  void publish(entry);
  announce();
}

/** Returns whether either clock moved, so cache-only traffic is published too. */
function moveClock(
  entry: Entry,
  origin: ChangeOrigin,
  state: LiveState,
  cacheTraffic?: boolean,
  observedAt?: number
): boolean {
  const activity = advancesActivityClock({
    origin,
    status: state.status,
    turned: entry.turned === true,
    warm: state.warmTurn !== undefined
  });
  const traffic = advancesCacheClock({
    origin,
    running: state.running,
    wasRunning: entry.wasRunning,
    cacheTraffic
  });
  entry.wasRunning = state.running;
  if (!activity && !traffic) return false;
  const now = observedAt ?? Date.now();
  if (activity) {
    entry.turned = true;
    entry.updatedAt = Math.max(entry.updatedAt, now);
  }
  if (traffic) entry.cacheAt = Math.max(entry.cacheAt ?? now, now);
  return true;
}

/** Trailing publish: keep the state at the end of the PUBLISH_MS window. */
function schedulePublish(entry: Entry): void {
  entry.publishTimer ??= setTimeout(() => {
    void publish(entry);
  }, PUBLISH_MS);
}

/**
 * toSession remains the authority; this per-frame check only detects a status
 * change cheaply. Drift can cause a redundant or debounced write, never a wrong record.
 */
function publishedStatus(state: LiveState): Session['status'] {
  return shownStatus(state);
}

/**
 * Whether that pid still exists, asked only to log the answer.
 *
 * `kill(pid, 0)` throws `ESRCH` when the process is gone and `EPERM` when it is
 * there and is not ours — so only `ESRCH` is gone. The same reading
 * `core/skill_install.ts` makes of the same call; it is three lines either
 * way, and the two do not share a caller.
 */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Cancel the timer first so it cannot recreate the record. published.ts orders
 * removal after writes already in flight. Return the removal for closeAll to
 * await; other callers outlive it.
 */
function stopPublishing(entry: Entry, why: string): Promise<void> {
  clearTimeout(entry.publishTimer);
  clearTimeout(entry.responseTimer);
  entry.publishTimer = undefined;
  // Log which removal caller made the remote card lose its only status source.
  log(`record removed: pid ${entry.pid} (${why})`);
  return removePublished(entry.pid);
}

/**
 * Starts a session as a child of this process, speaking stream-json.
 *
 * A **promptless start is the normal case**, the panel's own New still among
 * them — a draft's `open` carries its first line as `name` and nothing else,
 * and the prompt follows as an ordinary `send` once the reveal names a pid, so
 * the CLI says nothing at all until that send: `init` follows the first user
 * message, not the spawn. The card therefore exists from the moment the child
 * does, named after its cwd, idle, with no model and no transcript, and nothing
 * downstream may wait for a `sessionId` before drawing it.
 *
 * A **resume** is the exception, and the reason `initial` takes an id at all: it
 * is promptless like the rest, but its transcript exists already and its id was
 * chosen by the reader. Waiting for `init` there would leave the dock saying
 * "No conversation found" over the very conversation the reader picked, until
 * they typed something.
 *
 * The permission mode is read here rather than passed in, so the panel's own
 * button and the request watcher's spawn cannot disagree about it: both start
 * a session, and one that asks before acting in one window and not in the other
 * would be the worst kind of surprise.
 */
export type StartOptions = {
  cwd: string;
  incoming?: { files: RemoteFilesStart; admitted: () => Promise<boolean> };
  prompt?: string;
  correlation?: string;
  name?: string;
  /**
   * A label for a promptless draft, ranked like promptLabel and never put on
   * the command line.
   */
  placeholder?: string;
  parentSessionId?: string;
  /** Absent origin opens a fan-out; see origin's parent fallback below. */
  originSessionId?: string;
  /** The session that wrote `prompt`. Its first turn goes over as that peer's message. */
  from?: string;
  requestId?: string;
  ticketRef?: string;
  /** Already armed for cwd by host/request_host.ts serve. Requires a prompt because the briefing rides that turn. */
  workflow?: ReadWorkflow;
  /** A conversation to carry on rather than begin: the session id of a
   *  transcript in this cwd. Observed on 2.1.220 — the CLI keeps the id and
   *  keeps appending to the same file, so this is the same session coming back
   *  on a new pid, not a fork. An id no transcript answers to is not an error
   *  here: the child exits at once and its stderr reaches the card, which is
   *  where a reader can act on it. */
  resume?: string;
  /**
   * One caller selection: brand, model, window and effort. Do not read settings
   * again here or combine picks made at different times. Each absence is intentional.
   * No target means Claude, the account default, no window or effort override.
   */
  target?: LaunchTarget;
  attemptId?: string;
};

export async function startOwned(start: StartOptions): Promise<StartResult> {
  const id =
    start.attemptId ?? start.requestId ?? start.incoming?.files.attempt.attemptId ?? randomUUID();
  const fingerprint = JSON.stringify([
    start.cwd,
    start.target,
    start.resume,
    start.prompt,
    start.placeholder,
    start.name,
    start.correlation,
    start.parentSessionId,
    start.originSessionId,
    start.workflow?.id,
    start.incoming?.files.attempt
  ]);
  const prior = starts.get(id);
  if (prior)
    return prior.fingerprint === fingerprint
      ? prior.result
      : Promise.resolve({
          ok: false,
          outcome: 'unknown',
          reason: 'Conflicting session start identity.'
        });
  if (shuttingDown)
    return Promise.resolve({ ok: false, outcome: 'stopped', reason: 'This window is closing.' });
  // Only terminal receipts are evicted; active starts always retain their owner.
  if (starts.size >= 256)
    for (const [key, value] of starts) {
      const outcome = value.outcome ?? value.attempt.outcome;
      if (outcome?.ok || outcome?.outcome === 'stopped') starts.delete(key);
      if (starts.size < 192) break;
    }
  const attempt = new StartupAttempt(id, undefined, log);
  const record: StartRecord = {
    attempt,
    fingerprint,
    result: Promise.resolve({ ok: false, outcome: 'unknown', reason: 'Starting.' })
  };
  starts.set(id, record);
  record.result = attempt
    .run(() => performStart(start, record))
    .then((result) => {
      if (!result.ok && record.entry) {
        if (record.promptReleased) {
          record.entry.ready = true;
          void publish(record.entry);
        } else {
          record.entry.ready = undefined;
          if (result.outcome === 'stopped') void stopPublishing(record.entry, 'startup stopped');
          else {
            stoppingEntries.add(record.entry);
            void publishStopping(record.entry);
          }
        }
      }
      const cleanup = attempt.cleanup;
      if (cleanup)
        void cleanup.then(async (state) => {
          if (state !== 'gone') return;
          await record.reservation
            ?.release()
            .catch((error) => log(`startup ${id} capacity retained: ${String(error)}`));
          if (
            record.entry &&
            !record.promptReleased &&
            entries.get(record.entry.pid) === record.entry
          )
            entries.delete(record.entry.pid);
          if (record.lifetime) lifetimes.delete(record.lifetime);
          if (record.entry && stoppingEntries.delete(record.entry))
            await stopPublishing(record.entry, 'startup cleanup confirmed');
        });
      else if (!result.ok && !record.lifetime)
        void record.reservation
          ?.release()
          .catch((error) => log(`startup ${id} capacity retained: ${String(error)}`));
      return result;
    })
    .catch((error: unknown): StartResult => {
      attempt.finish('unknown');
      const result: StartResult = {
        ok: false,
        outcome: 'unknown',
        attemptId: id,
        reason: error instanceof Error ? error.message : String(error)
      };
      record.outcome = result;
      return result;
    });
  return record.result;
}

async function performStart(start: StartOptions, record: StartRecord): Promise<AttemptResult> {
  const attempt = record.attempt;

  const config = vscode.workspace.getConfiguration('squadron');
  const target = start.target ?? {};
  const asked = brandForStart(target.brand);
  if (!asked.ok) {
    log(`spawn refused: ${start.cwd} — no adapter for ${String(target.brand)}`);
    return pickRefused(asked.reason);
  }
  const brand = asked.brand ?? DEFAULT_BRAND;
  const cli = adapter(brand);
  if (!cli) {
    log(`spawn refused: ${start.cwd} — no adapter for ${brand}`);
    return pickRefused(CANNOT_START_CLI);
  }
  attempt.check();
  if (start.resume) {
    attempt.stage = 'resume ownership';
    const key = conversationKey(brand, start.resume);
    const local = [...entries.values(), ...stoppingEntries].find(
      (entry) =>
        entry.brand === brand &&
        entry.session.state.sessionId === start.resume &&
        (stoppingEntries.has(entry) || !entry.ready || entry.session.state.exit === undefined)
    );
    if (local)
      return {
        ok: false,
        reason:
          'That conversation is still starting, running or stopping in this window. Check its original start or session.'
      };
    const [published, table] = await Promise.all([readPublishedEvidence(), scanProcesses(true)]);
    attempt.check();
    const owner = conversationOwner(
      published,
      table,
      (session) => conversationKey(sessionBrand(session.brand), session.sessionId ?? '') === key
    );
    if (owner === 'held')
      return {
        ok: false,
        reason: 'That conversation is running in another window. Switch to that window to continue.'
      };
    // Missing evidence is not absence: a second child on a live transcript
    // cannot be taken back, so this waits for a table and records that prove it.
    if (owner === 'unknown')
      return {
        ok: false,
        reason:
          'Could not confirm that conversation is not running in another window. Try again in a moment.'
      };
  }
  const bin = await cli.resolveBinary(configuredPath(cli));
  attempt.check();
  if (!bin.ok) {
    log(`spawn refused: ${start.cwd} — ${bin.reason}`);
    return { ok: false, cause: 'startup', reason: bin.reason };
  }
  log(
    `startup ${attempt.id} brand ${brand} binary ${bin.path} (${bin.source}); version unavailable`
  );
  if (cli.preflight) {
    const ready = await cli.preflight();
    attempt.check();
    if (!ready.ok) {
      log(`spawn refused: ${start.cwd} — ${ready.reason}`);
      return { ok: false, cause: 'startup', reason: ready.reason };
    }
  }

  // Which model this start runs on, as the start itself states it. Pushed
  // rather than negotiated after `init`: the flag is accepted alongside
  // `--print` + stream-json (verified 2.1.220, 2026-08-04), so a start needs no
  // `set_model` frame.
  //
  // Do not read pick settings again: the caller has already settled the selection.
  // Nothing checks the string against the menu. An id the CLI does not know
  // is refused on the first turn — in a `<synthetic>` turn naming it, so the
  // reader meets the sentence in the dock rather than an exit code — and the
  // child then exits. The same bargain `--resume` makes for an id no
  // transcript answers to.
  const model = (target.model ?? '').trim();
  // Folded to `undefined` here rather than at each producer, for the reason
  // `model` is trimmed here: this is the one place every start passes through.
  // The setting used to be read and folded on this line, so `''` could never
  // reach an adapter; a request file is now a producer too, and an older one
  // stating `"effort": ""` would otherwise put an empty string on the card's
  // live state — a reading no CLI ever gave.
  const effort = target.effort?.trim() || undefined;
  // Refuse cross-brand ids so a Grok id cannot become --model grok-4.6 on Claude.
  // Grok launch already drops the reverse mismatch.
  const identity = checkSpawnIdentity({ brand, model });
  if (!identity.ok) return pickRefused(identity.reason);

  // Validate model/window pairs against the catalog. An unmatched pair degrades
  // like an unrecognised model id: a start that cannot pin its window is still a start.
  const rawWindow = windowTokens(target.window);
  const reached = windowOf(brand, model || undefined, rawWindow);
  const window = reached ? rawWindow : undefined;

  // Two kinds, and they were one string until they had to stop being: `given`
  // is a decision somebody made and the only thing `--name` may ever carry,
  // `placeholder` is a line of text to label a card with. Ranked, never
  // collapsed — `core/naming.ts`, and sessions.md for what collapsing them cost.
  //
  // Both are absent for a draft whose first turn is an image and no text: there
  // is no first line to cut, and the CLI derives its usual `<dir>-<suffix>`.
  const given = sessionName(start.name);
  const placeholder = start.placeholder ?? promptLabel(start.prompt);

  // Who the session will be, said before it exists.
  //
  // Without this a promptless owned session has no id until the CLI names it on
  // the first turn (`core/live.ts`), and anything keyed by session id — the
  // progress file above all — has nowhere to land until somebody types. Verified
  // against CLI 2.1.220 on 2026-08-04: the flag is accepted alongside `--print`
  // + stream-json, our id rides the very first frame, `init` restates it
  // exactly, and the transcript is filed at `<our-uuid>.jsonl`.
  //
  // The flag itself is Claude `launch()`'s: a resume and a fresh id must not
  // both go on the line. This is only the mint.
  //
  // **Minted inside the retry boundary, and there is no retry boundary today.**
  // A pre-assigned id is one-shot: re-spawning with an id that already has a
  // transcript fails with `Session ID <uuid> is already in use.` and a non-zero
  // exit (observed 2026-08-04), permanently. A v4 uuid never collides by chance,
  // so this only binds whoever adds a retry — mint a fresh id per attempt, or
  // every retry fails on the id and masks the fault that caused the first one.
  const fresh = randomUUID();

  // A resume's age is the conversation's, not the child's. The pid is seconds
  // old and the context it is about to re-send may be a day cold, so the card
  // dates from the transcript's last entry and moves to this window's clock only
  // when the session takes a turn of its own — which is also when the prompt
  // cache it warns about is genuinely warm again.
  //
  // Read before the child exists, because the child appends to that same file
  // the moment it resumes: today a `{"type":"mode"}` line, which states no time
  // and so cannot be mistaken for activity (observed 2.1.220), but a later CLI
  // stamping that write would be this reading overwritten by its own subject.
  // `undefined` — a transcript that is missing, unreadable or states no time —
  // falls back to the start, which is what the card said before any of this.
  const resumedAt = start.resume ? await recordedActivityAt(start.resume) : undefined;
  const resumedCacheAt = start.resume
    ? await recordedActivityAt(start.resume, { includeWarm: true })
    : undefined;

  // Clear old workflow progress when knowingly reusing a resumed id; retain it
  // at exit, when the workflow is still worth reading.
  attempt.check();
  if (start.resume) {
    await forgetProgress(start.resume);
  }

  // Resolve origin once for the entry and child environment. Without an origin,
  // use the parent so the session that opened the fan-out can describe it too.
  // Without either, the child is a root.
  const origin = start.originSessionId ?? start.parentSessionId;

  // The adapter spells launch flags. Permission mode, briefing and capture are
  // window-wide so panel and watcher starts agree; target is the caller's pick.
  const skipPermissions = config.get<boolean>('skipPermissions.enabled', false);
  const capture = await execution.prepareExecution(
    cli.execution,
    path.join(__dirname, 'execution.js'),
    config.get<boolean>('checkpoints.execution.enabled', false)
  );
  attempt.check();
  let briefing = config.get<boolean>('orchestrators.enabled', false) ? BRIEFING : undefined;
  const launchOptions = {
    execution: capture.configuration,
    briefing,
    bin: bin.program,
    cwd: start.cwd,
    sessionId: fresh,
    resume: start.resume,
    model: model || undefined,
    window,
    effort,
    // Only given — see the two consts above.
    name: given,
    skipPermissions
  };
  let line = cli.launch(launchOptions);
  attempt.check();
  const failures = await writeLaunchFiles(line.files);
  for (const failure of failures) {
    log(`launch file failed: ${failure.path} — ${failure.reason}`);
  }
  if (failures.length) {
    briefing = undefined;
    line = cli.launch({ ...launchOptions, briefing });
  }
  // Re-read after briefing preparation so an off transition is not lost.
  const executionEnabled = vscode.workspace
    .getConfiguration('squadron')
    .get<boolean>('checkpoints.execution.enabled', false);
  capture.runtime.enabled &&= executionEnabled;
  if (executionEnabled && !capture.runtime.enabled)
    log('Execution capture unavailable; retaining turn captures.');
  const recalledWarm = start.resume
    ? (await warmChoice.readWarmChoices()).get(conversationKey(brand, start.resume))
    : undefined;
  attempt.check();
  if (start.requestId !== undefined) {
    attempt.stage = 'admission';
    const reservation = await reserveStartup(start.requestId);
    record.reservation = reservation;
    if (attempt.signal.aborted) {
      await reservation.release();
      attempt.check();
    }
    await reservation.spawning();
    attempt.check();
  }
  const usageGeneration = await usageCoordination.generation(brand).catch((error: unknown) => {
    log(`Usage provenance unavailable: ${error instanceof Error ? error.message : String(error)}`);
    // An empty generation cannot attribute this session to a later account.
    return '';
  });
  attempt.check();
  attempt.stage = 'spawning';
  const transport = childTransport({
    bin: line.bin,
    cwd: start.cwd,
    args: line.args,
    env: { ...line.env, ...capture.env },
    terminateOnClose: line.terminateOnClose || start.incoming !== undefined,
    origin,
    windowId: vscode.env.sessionId
  });
  const lifetime = new SessionLifetime(transport, {
    remember: async (members) => {
      await record.reservation?.remember(members);
      if (
        record.entry &&
        stoppingEntries.has(record.entry) &&
        !(await publishStopping(record.entry))
      )
        throw new Error('Stopping conversation ownership could not be saved.');
    },
    gone: async () => {
      await record.reservation?.release();
      lifetimes.delete(lifetime);
      const owned = record.entry;
      if (owned) owned.gone = true;
      if (owned && !record.promptReleased && !owned.ready && entries.get(owned.pid) === owned)
        entries.delete(owned.pid);
      if (owned && stoppingEntries.has(owned)) {
        await stopPublishing(owned, 'native cleanup confirmed');
        stoppingEntries.delete(owned);
        unpark(owned);
      }
    },
    observed: (result) => {
      if (result === 'failed' && record.entry && ending.fail(record.entry)) announce();
    }
  });
  record.lifetime = lifetime;
  attempt.own(lifetime);
  retainLifetime(lifetime);
  const pid = transport.pid;
  if (pid === undefined) {
    transport.onExit((info) =>
      log(`spawn failed: ${start.cwd} — ${info.stderr ?? 'no reason given'}`)
    );
    transport.close();
    return { ok: false, reason: 'The session could not be started.' };
  }

  const startedAt = Date.now();
  // Every owned session knows its id before the child speaks, and says so: the
  // transcript is what the dock reads, and `init` will not arrive to state it
  // until somebody types. A resume brings the id back; a fresh start was handed
  // one above. `init` restates whichever it is and `core/live.ts` prefers what
  // the CLI says, so a `/clear` still moves the card to its new id.
  const session = cli.connect(transport, {
    opening: attempt,
    registerCleanup: (cleanup) => lifetime.register(cleanup),
    failOpening: () => {
      void lifetime.close();
    },
    execution: capture.runtime,
    briefing,
    cwd: start.cwd,
    startedAt,
    sessionId: start.resume ?? fresh,
    resume: start.resume,
    // Match the launch model: empty means the account default, not a named pick.
    model: model || undefined,
    effort,
    // Hold the requested window because the pipe cannot report it. Hold reach too:
    // the launch line is its only witness and is gone before anything asks.
    window,
    // `plain` and not `undefined` when the catalog states no window for the
    // pair, because **we composed this line and know what is on it**: the
    // adapters add their window flag only where the reached window asks for one
    // (`claude/adapter.ts` emits `--settings` on `reach === 'flag'` alone), so a
    // start that named no window said nothing to get the one it is in — which
    // is what `plain` means. `undefined` is reserved for a line nobody here
    // saw, and a start is never that.
    //
    // Not cosmetic: **the commonest start of all names no window** — a draft
    // whose model has one window states it, and every other start states
    // nothing — and leaving this `undefined`
    // let `reachableFrom` answer `true` for every pill on it. On a plan whose
    // default Opus 5 is 1M, that is the dead `200k` control this whole task
    // exists to remove, alive on the ordinary session (review, 2026-08-29).
    windowReach: reached?.reach ?? 'plain',
    // A stated name outranks a generated title; a placeholder does not.
    named: given !== undefined,
    skipPermissions,
    log
  });
  const entry: Entry = {
    lifetime,
    usageGeneration,
    execution: capture.runtime,
    launchCwd: start.cwd,
    session,
    pid,
    startedAt,
    name: given,
    placeholder,
    brand,
    warm: recalledWarm,
    warmKey: recalledWarm?.sessionId,
    updatedAt: resumedAt ?? startedAt,
    cacheAt: resumedCacheAt,
    wasRunning: session.state.running,
    ...(start.parentSessionId ? { parentSessionId: start.parentSessionId } : {}),
    ...(origin ? { originSessionId: origin } : {})
  };
  record.entry = entry;
  entries.set(pid, entry);
  if (ending.retireReplaced(entry)) announce();
  // `false` is an `error` with the pid still there, after which the real exit
  // can no longer resolve this; the backstop's scans answer for that case.
  void transport.exited?.then((native) => {
    if (!native) return;
    entry.gone = true;
    unpark(entry);
    void stopLifetime(lifetime);
  });
  if (record.reservation) {
    attempt.stage = 'child identity';
    await record.reservation.bind(pid);
    attempt.check();
  }
  // The dock's own signal, apart from `onChange`'s: the thread moves on things
  // the live half does not — a resolved send, a checkpoint, a cut row sealed —
  // and nothing else here (the publish, the clock, keep-awake, the waits) is
  // about a thread.
  const threadChanged = (): void => {
    if (entries.get(pid) !== entry) {
      return;
    }
    for (const listener of threadListeners) {
      listener(pid);
    }
  };
  session.thread.onChange(threadChanged);
  void session.thread.recovered.then(threadChanged);

  // Received text moves no card state — its words are the thread's — and is
  // the session at work all the same: the clock, the published record and
  // everything `announce` wakes (keep-awake, waits, the board) hear of it as
  // of any agent frame.
  session.onActivity((observedAt) => {
    if (!entries.has(pid)) {
      return;
    }
    if (moveClock(entry, 'agent', session.state, undefined, observedAt)) {
      schedulePublish(entry);
      announce();
    }
  });

  session.onChange((state, origin, cacheTraffic, observedAt) => {
    if (!entry.responseObserved && state.firstPrompt && !entry.responseTimer) {
      entry.responseTimer = setTimeout(
        () =>
          log(
            `startup ${attempt.id} first-response unconfirmed after 30000ms; no retry or termination authorized`
          ),
        30_000
      );
    }
    if (state.exit || (state.firstPrompt && origin === 'agent' && cacheTraffic !== false)) {
      clearTimeout(entry.responseTimer);
      entry.responseObserved = true;
    }
    // Ignore late frames after removal, or their publish would recreate the record.
    if (!entries.has(pid)) {
      return;
    }
    // **Only the session's own doing moves the clock.** A change is not by
    // itself the session doing something, and for a year the two were the same
    // road: `refreshChrome` applies a resumed session's title, model and context
    // as soon as `session/load` returns, and a conversation last spoken to at
    // 18:38 read "1m ago" the moment it resumed (observed 2026-08-20, Grok
    // 1.0.4).
    //
    // The latch below was that fix, and it only ever covered the window before
    // a first turn — after one, `entry.turned` is true and the test admits
    // everything. What that let through was this window's own `get_usage` round
    // trip: asked of `ownedReporter`, which is the oldest owned session of a
    // brand and so always the same card, on a clock that comes forward to a
    // minute whenever any session on the machine ends a turn. Measured
    // 2026-09-03 across two windows — each one's oldest card restamped at
    // 18:20:38, 18:23:36, 18:26:19 and 18:29:16 while its transcript had not
    // moved since 17:18, and the cards either side of it held honest hours-old
    // stamps throughout.
    //
    // Real activity dates idle time, unread state and the warm window. Cache
    // traffic dates heat and send admission; board order uses startedAt.
    // Local bookkeeping must not move either clock.
    //
    // **The latch stays, and it is not redundant beside `origin`.** It covers
    // the other half of the resume bug, which is agent-origin: a Grok roster
    // notify (`_x.ai/sessions/changed`) carries `activity: 'idle'` and a title,
    // and `grok/reduce.ts`'s `replayed` does not reach it — that guard is on
    // `isUpdateMethod` payloads alone. So a resumed conversation is told it is
    // idle by the CLI itself, before it has taken a turn here, and only this
    // test keeps that off the clock. `origin` covers the `refreshChrome` road
    // to the same bug; neither guard subsumes the other.
    moveClock(entry, origin, state, cacheTraffic, observedAt);
    // A rename taken before the CLI named the session has nowhere durable to
    // go — the store is keyed by conversation, and a promptless session has no
    // id until somebody types. `init` is where one lands, so this is where the
    // statement catches up with it. Comparing the *written key* rather than a
    // flag also carries the id that moves: a `/clear` mints a new one and the
    // name is written again under it, the entry on the old id going quietly
    // stale exactly as the CLI's own transcript entry for it does.
    //
    // Set before the write and cleared after a failed one, which is `stateName`'s
    // shape and for its reason: held over the write it is the guard that keeps a
    // burst of frames to one file, and dropped again it leaves the next frame to
    // retry rather than leaving the store on a name this session has stopped
    // wearing.
    const named = state.sessionId;
    const want = entry.stated;
    if (want !== undefined && named && entry.statedKey !== named) {
      entry.statedKey = named;
      void writeStatedName(entry.brand, named, want, Date.now()).then((wrote) => {
        if (!wrote && entry.statedKey === named) {
          entry.statedKey = undefined;
        }
      });
    }
    if (entry.warm && named && entry.warmKey !== named) {
      entry.warmKey = named;
      const choice = entry.warm;
      void warmChoice
        .writeWarmChoice(entry.brand, named, choice.on, choice.statedAt)
        .then((wrote) => {
          if (!wrote && entry.warmKey === named) entry.warmKey = undefined;
        });
    }
    if (state.exit) {
      // Keep exited sessions so their next refresh can say what happened.
      log(`ended: pid ${pid} (${state.exit.signal ?? state.exit.code ?? 'no code'})`);
    }
    // The other windows' copy of `announce`: they hold no listener on this
    // session, so a file is how they hear about it.
    //
    // **A change to the status word jumps the debounce, and it is the only
    // exemption.** `PUBLISH_MS` is right for what it was built for — a turn is
    // tens of delta frames and the reader cannot follow live text at that rate
    // anyway. But this file stopped being only a repaint when `cli/end.ts`
    // began reading it from another process to decide whether a session is
    // mid-turn, and for a decision a stale record is a wrong answer rather than
    // a late paint. Measured 2026-08-18 against the smoke's own child: the turn
    // opened at t, `agentsview-stop` read `idle` off this file at t+217ms, and
    // the refusal did not fire. Two extra writes a turn, against the ~2/s the
    // debounce already allows while one is streaming.
    //
    // `agentsview-stop` is the name the verb had that day; it is `squadron-end`
    // now. A dated measurement keeps the spelling it was taken against.
    const next = publishedStatus(state);
    // **The edge into `unknown`, and the one fact no reader can recover after
    // it.** A card in that state is either a latched exit or a brand saying so
    // on the wire, the board draws one word for both, and nothing recorded
    // which — a session found unknown beside a live process and connected fds
    // could not be attributed at all (2026-09-09). `unknownFrom` names the
    // cause; the liveness check is what separates an exit that happened from
    // one that was merely latched, and it has to be asked *here*, while the pid
    // is still worth asking about.
    if (next === 'unknown' && entry.lastStatus !== 'unknown') {
      log(
        `unknown: pid ${pid} from ${state.unknownFrom ?? 'unstated'}, process ${
          stillRunning(pid) ? 'alive' : 'gone'
        }`
      );
    }
    if (next === entry.lastStatus) {
      schedulePublish(entry);
    } else {
      void publish(entry);
    }
    announce();
  });

  attempt.check();
  attempt.stage = 'incoming evidence';
  entry.incoming = await incomingHost?.capture(
    transport,
    session,
    brand,
    () => (!attempt.signal.aborted || record.promptReleased === true) && entries.get(pid) === entry
  );
  attempt.check();
  if (capture.runtime.contextFile)
    await execution.admitExecution(capture.runtime, cli.brand, start.resume ?? fresh, 'launch');
  if (entries.get(pid) !== entry) return { ok: false, reason: 'The session ended while starting.' };
  attempt.check();
  attempt.stage = 'opening';
  const handshake = await session.opening;
  attempt.check();
  if (!handshake.ok)
    return { ok: false, cause: handshake.cause ?? 'startup', reason: handshake.reason };
  if (entries.get(pid) !== entry || session.state.exit || transport.processAlive?.() === false)
    return { ok: false, cause: 'startup', reason: 'The session ended while starting.' };
  log(`spawn: ${start.cwd} as pid ${pid} (${bin.source})`);
  // Once at the spawn, before any frame: a promptless session says nothing at
  // all until somebody types, and without this its card would be an unfolded
  // twin in every other window for as long as that took.
  void publish(entry);

  // Write the child pid so the fleet cap counts across windows and reloads;
  // a local tally could be evaded through another window.
  if (start.requestId !== undefined) {
    attempt.check();
    await writeLineage(pid, {
      schema: 1,
      spawnedAt: entry.startedAt,
      cwd: start.cwd,
      requestId: start.requestId,
      parentSessionId: start.parentSessionId,
      originSessionId: origin,
      ticketRef: start.ticketRef
    });
  }

  attempt.check();
  if (start.incoming) {
    const preparation = start.incoming;
    const proof = entry.incoming;
    if (!proof) {
      const exited = await closeUnprompted(transport);
      session.close();
      if (exited) {
        entries.delete(pid);
        await stopPublishing(entry, 'incoming identity unavailable');
      }
      return {
        ok: false,
        reason: 'Incoming owner evidence is unavailable.',
        outcome: exited ? 'stopped' : 'unknown'
      };
    }
    const result = await proof.start(
      preparation.files.attempt,
      () => {
        attempt.check();
        attempt.admitPrompt();
        record.promptReleased = true;
        const routed = routeTo({ owned: session });
        return !isRefused(routed) && routed.messages
          ? routed.messages.send(
              preparation.files.prompt,
              undefined,
              undefined,
              undefined,
              undefined,
              preparation.files.attempt.correlation
            )
          : Promise.resolve({ ok: false, reason: refusal('messages') });
      },
      () => {
        attempt.check();
        return publish(entry, true);
      },
      async () => {
        attempt.check();
        const admitted = await preparation.admitted();
        attempt.check();
        return admitted;
      }
    );
    if (!result.ok) {
      if (result.outcome === 'stopped') {
        entries.delete(pid);
        await stopPublishing(entry, 'incoming start refused');
      }
      return { ...result, ok: false, reason: 'Incoming startup evidence could not be committed.' };
    }
    if (!record.promptReleased) attempt.check();
    entry.ready = true;
    void publish(entry);
    announce();
    return {
      ok: true,
      pid,
      startedAt,
      brand,
      sessionId: session.state.sessionId,
      remoteLaunchEvidence: proof.snapshot().remoteLaunchEvidence
    };
  }
  if (start.prompt !== undefined) {
    // A workflow here fires without a gesture, where the panel's own mention
    // waits for Enter (PRD §13 "never auto-send on session create"). That rule
    // is about a reader being handed a composer; this caller wrote the prompt
    // and the flag in one command, and there is nobody here to press it.
    // A brand that takes no messages cannot be handed a first turn either. The
    // start still succeeds — the card exists and says what it can do — rather
    // than failing over a prompt that was never this CLI's to take.
    //
    // `state.sessionId`, not `fresh`: the mint is only what `--session-id` takes,
    // and a brand that has no such flag never adopts it. Grok mints its own at
    // ACP `session/new` (`core/grok/session.ts`), so seeding the run under
    // `fresh` filed it under a string nothing would ever claim — the briefing
    // named a real path, Grok drove the steps into it, and the board, reading
    // `readProgress(session.sessionId)`, looked elsewhere for the rest of the
    // run's life. Measured 2026-08-18: child `01a014fd-…`, run
    // `e1b81c36-….progress.json`, three steps `completed` in a file no card
    // could find. Claude is unchanged — it adopts `fresh` and `init` restates
    // it exactly, so the two strings are equal here. Safe by this line because
    // `await session.opening` above is the handshake, and Grok's holds until
    // `session/new` lands.
    // No `?? fresh` fallback: an id this cannot supply is one no reader could
    // resolve either, and `workflowFirstTurn` sends the workflow unseeded
    // rather than inventing a key — the same refusal `armMention` makes.
    attempt.check();
    const turn = await workflowFirstTurn(
      start.prompt,
      start.workflow,
      session.state.sessionId ?? '',
      paths.toolShell(brand),
      attempt.signal
    );
    attempt.check();
    attempt.admitPrompt();
    record.promptReleased = true;
    await session.messages?.send(
      // Around the briefing too: the envelope is anchored at both ends
      // (`unwrapMessage`), so only a whole turn inside it reads as the peer's.
      start.from ? wrapMessage(turn, start.from) : turn,
      undefined,
      undefined,
      undefined,
      undefined,
      start.correlation
    );
  }
  if (!record.promptReleased) attempt.check();
  entry.ready = true;
  void publish(entry);
  announce();
  return { ok: true, pid, startedAt, brand };
}

/**
 * What this session is to be called, said once — the one writer every rename
 * door goes through.
 *
 * The three doors do not all pass `core/coordination/route.ts`: the dock's box and
 * `squadron-rename` reach `wrapOwned` when the pipe is local, while a rename
 * asked of *this* window by another arrives as a request and is served against
 * the raw handle in `host/extension.ts`. What all three share is this entry, so
 * the sequencing lives here and a fourth door added later cannot skip it.
 *
 * The order is the whole of it:
 *
 * 1. **Validate**, so nothing below runs for a name that is not one.
 *    `sessionName` is the cleaner spawn's and rename's `--name` share, so the
 *    card, the picker row and the CLI all end up carrying the same string.
 * 2. **The statement**, on the entry and in the store — ours, durable, and true
 *    from this moment whatever any CLI does about it. The entry always takes
 *    it; the store is best effort like every other one here, so `ok` says the
 *    window has taken the name rather than that a file exists to prove it.
 * 3. **The paint**, published at once rather than on the debounce: the reader
 *    just typed this and a card that waited half a second would look like it
 *    had not taken it. The chat gets a CLI-box line saying so, queued on the
 *    record behind whatever turn is being written.
 * 4. **The CLI**, last and best-effort, and only where the brand's door is
 *    not a message. Codex takes `thread/name/set`. Claude and Grok have no
 *    door: the stated name is already what the card wears. A missing echo is
 *    not a failed rename (Codex's own was measured not to arrive, 2026-09-05).
 */
export async function stateName(pid: number, title: string): Promise<Act> {
  const entry = entries.get(pid);
  if (!entry) {
    return { ok: false, reason: UNROUTED };
  }
  const want = sessionName(title);
  if (!want) {
    return { ok: false, reason: 'A rename needs a name.' };
  }
  entry.stated = want;
  const sessionId = entry.session.state.sessionId;
  if (sessionId) {
    // Await the name store so the caller's next squadron-list sees the new name.
    // An idless session catches up in startOwned.
    // Clear statedKey on failure so catch-up can retry; otherwise ui/views.ts named
    // lets the previous stored rename outrank the live one.
    entry.statedKey = sessionId;
    if (!(await writeStatedName(entry.brand, sessionId, want, Date.now()))) {
      entry.statedKey = undefined;
    }
  }
  entry.session.readout(`Session renamed to: ${want}`);
  void publish(entry);
  announce();
  try {
    entry.session.naming?.rename(want);
  } catch (err) {
    // Keep ok: the stated rename landed, and a failed courtesy call must not
    // refuse it in front of a card already wearing the new name.
    log(
      `rename not taken by the CLI: pid ${pid} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { ok: true };
}

export async function setWarm(pid: number, on: boolean): Promise<Act> {
  const entry = entries.get(pid);
  if (!entry) return { ok: false, reason: UNROUTED };
  if (!entry.session.warm) return { ok: false, reason: refusal('warm') };
  const sessionId = entry.session.state.sessionId;
  const choice: warmChoice.WarmChoice = {
    schema: 1,
    brand: entry.brand,
    sessionId: sessionId ?? '',
    on,
    statedAt: Date.now()
  };
  entry.warm = choice;
  if (sessionId) {
    entry.warmKey = sessionId;
    if (!(await warmChoice.writeWarmChoice(entry.brand, sessionId, on, choice.statedAt))) {
      entry.warmKey = undefined;
    }
  }
  if (entries.get(pid) === entry) {
    void publish(entry);
    announce();
  }
  return { ok: true };
}

/**
 * Capabilities on SessionHandle define the verbs; unsupported verbs are
 * absent properties rather than throwing methods (core/adapter.ts).
 */
export function ownedSession(pid: number): SessionHandle | undefined {
  const entry = entries.get(pid);
  return entry?.ready ? entry.session : undefined;
}

export function sessionExited(pid: number, startedAt?: number): boolean {
  const entry = entries.get(pid);
  return entry?.gone === true && (startedAt === undefined || entry.startedAt === startedAt);
}

/**
 * A session of this brand that can answer for the account, if this window drives
 * one.
 *
 * Any of them will do — plan usage is the account's, and every session of a
 * brand reports the same windows — so this is a first hit and not a choice. A
 * session whose child has exited is skipped: the entry outlives the process by
 * design (a session that died has something to say), and its pipe answers
 * nothing.
 *
 * The registry rather than the board: only a session this window holds the pipe
 * of can be asked, and `ownedSessions` builds cards.
 */
export function ownedReporter(
  brand: BrandId,
  generation?: string
): SessionHandle['usage'] | undefined {
  for (const entry of entries.values()) {
    if (
      entry.ready &&
      entry.brand === brand &&
      !entry.session.state.exit &&
      entry.session.usage &&
      (generation === undefined || entry.usageGeneration === generation)
    ) {
      return entry.session.usage;
    }
  }
  return undefined;
}

/**
 * What the send guards read about an owned session, off the same `toSession`
 * this window publishes, so the window judges a wake on its own handle rather
 * than on whatever a shim last read from disk.
 */
export function ownedTarget(pid: number): Recipient | undefined {
  const entry = entries.get(pid);
  return entry && recipient(toSession(liveOf(entry), factsOf(entry), vscode.env.sessionId));
}

/**
 * Every owned session as the board's own record type.
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
export function ownedSessions(windowId: string): Session[] {
  const out: Session[] = [];
  for (const entry of entries.values()) {
    if (!entry.ready) continue;
    out.push({
      ...toSession(liveOf(entry), factsOf(entry), windowId),
      usageGeneration: entry.usageGeneration
    });
  }
  return out;
}

/**
 * Use this window's registry and nothing else: origin is pickWindow's first tier,
 * so a live parent's child starts in the same window and its parent is in entries.
 * If that window dies before lookup, resolveSpawnIdentity falls back to Claude
 * with no model, as for an unbranded spawn or one with no parent record.
 */
export function parentIdentity(sessionId: string | undefined): SpawnParent | undefined {
  if (!sessionId) return undefined;
  for (const entry of entries.values()) {
    if (entry.session.state.sessionId === sessionId) {
      return {
        brand: entry.brand,
        model: entry.session.state.model,
        modelPick: entry.session.state.modelPick,
        // **What the parent *asked for*, never what the wire stated.** A parent
        // that pinned nothing has observed a window all the same — every session
        // states one off its first `result` — and inheriting that would launch
        // every child pinned off an observation: they would stop teaching
        // `models.json`, and a gated pair would 400 on a window nobody chose.
        window: entry.session.state.windowAsked
      };
    }
  }
  return undefined;
}

/**
 * Keep exited sessions readable until dismissal; keeping them forever fills
 * the board. Refuse live ones; endSession ends them.
 */
export function dropSession(pid: number, startedAt?: number): boolean {
  const entry = entries.get(pid);
  if (!entry || (startedAt !== undefined && entry.startedAt !== startedAt) || !entry.gone) {
    return false;
  }
  entries.delete(pid);
  if (lifetimes.has(entry.lifetime)) {
    stoppingEntries.add(entry);
    void publishStopping(entry);
  } else void stopPublishing(entry, 'dropped from the board');
  announce();
  return true;
}

export function isEnding(pid: number, startedAt: number): boolean {
  return ending.pending({ pid, startedAt });
}

/**
 * Ends an owned session, for every route that ends one: the close button, a
 * `squadron-end` from another session, Remote's End.
 *
 * Stdin EOF is what the CLI is watching for, and a session between turns takes
 * it almost at once. One in the middle of a tool call may not reach it at all,
 * hence the backstop. The entry leaves the registry here, so nothing can write
 * to the closed pipe, and its card stays on the board until the child is seen
 * to exit (`ending`).
 *
 * The exit is read when the timer fires, never when it is armed: `close()` is
 * `stdin.end()`, so at that point no child has had the chance to exit and the
 * check would pass for every session alive. The one at the schedule time is what
 * decides whether a signal is sent at all.
 */
export function endSession(pid: number, startedAt?: number): boolean {
  const entry = entries.get(pid);
  if (!entry || (startedAt !== undefined && entry.startedAt !== startedAt)) {
    return false;
  }
  if (entry.gone) {
    if (!dropSession(pid, startedAt)) return false;
    announceEnd({ pid, startedAt: entry.startedAt });
    return true;
  }
  // Started before the pipe closes, and deliberately not awaited: a dead
  // process's children reparent to pid 1 and the table forgets whose they were,
  // so this is the last moment the subtree is findable at all. `close()` is
  // `stdin.end()` and the CLI takes seconds to notice, so the `ps` behind this
  // runs against a session that is still very much alive.
  stoppingEntries.add(entry);
  void publishStopping(entry);
  void stopLifetime(entry.lifetime).then((result) => {
    if (result === 'gone') unpark(entry);
  });
  entries.delete(pid);
  // Stopping evidence remains published until native cleanup confirms termination.
  if (!entry.gone) park(entry);
  announceEnd({ pid, startedAt: entry.startedAt });
  announce();
  return true;
}

/**
 * Retries native shutdown for a retained card whose prior attempt failed.
 * A complete process observation can also prove it has already gone.
 */
export async function signalEnd(
  targets: readonly { pid: number; startedAt: number }[],
  owner: ReapOwner
): Promise<SignalEnd[]> {
  const held = targets.map((target) =>
    ending.has(target)
      ? [...stoppingEntries].find(
          (entry) => entry.pid === target.pid && entry.startedAt === target.startedAt
        )
      : undefined
  );
  const fallback = targets.filter((_, at) => !held[at]);
  const signalled = fallback.length ? endBySignal(fallback, owner) : Promise.resolve([]);
  let at = 0;
  return Promise.all(
    held.map((entry) => {
      if (entry) return retryEnding(entry);
      const index = at++;
      return signalled.then((outcomes) => outcomes[index] ?? 'failed');
    })
  );
}

async function retryEnding(entry: Entry): Promise<SignalEnd> {
  if (ending.pending(entry)) return 'ended';
  if (!ending.retry(entry)) return 'gone';
  announceEnd({ pid: entry.pid, startedAt: entry.startedAt });
  announce();
  const result = await stopLifetime(entry.lifetime);
  return result === 'gone' ? 'gone' : result === 'failed' ? 'failed' : 'ended';
}

/** The cards of sessions being ended, for the board alone. */
export function endingSessions(): Session[] {
  return ending.snapshot();
}

/**
 * The card is taken once, at the send: late frames on a closed pipe would
 * otherwise reopen an ask nobody can answer or ring a turn's end. Pending asks
 * are stripped for the same reason, and the warm facts, which would list the
 * card on Warm's sheet behind a switch the closed pipe refuses.
 */
function park(entry: Entry): void {
  const card = toSession({ ...liveOf(entry), pending: [] }, factsOf(entry), vscode.env.sessionId);
  delete card.warm;
  delete card.warming;
  delete card.warmPort;
  delete card.warmArmedAt;
  delete card.warmFailureAt;
  ending.retain(card);
}

/** Called only after native exit or cleanup has proved termination. */
function unpark(entry: Entry): void {
  if (ending.remove(entry)) announce();
}

/** Close every pipe before awaiting cleanup, including starts without entries. */
/**
 * `cleanups` receives each lifetime's reconciliation as it starts: they read
 * the process table until they settle, which can be after this returns, so
 * the caller keeps the reader for them (`core/shutdown.ts` `drain`).
 */
export async function closeAll(
  cleanups: (consumers: readonly Consumer[]) => void = () => {}
): Promise<void> {
  shuttingDown = true;
  for (const record of starts.values())
    if (!(record.outcome ?? record.attempt.outcome)) record.attempt.stop();
  const cleanup = [...lifetimes].map((lifetime) => {
    void lifetime.shutdown();
    return stopLifetime(lifetime);
  });
  cleanups(
    [...lifetimes].map((lifetime, at) => ({
      name: `session ${lifetime.pid ?? '?'} cleanup`,
      done: cleanup[at] ?? Promise.resolve()
    }))
  );
  const writes: Promise<unknown>[] = [];
  for (const entry of entries.values()) {
    if (entry.execution?.contextFile)
      writes.push(
        checkpoint.endExecutionRuntime(entry.execution.runtime, entry.execution.contextFile)
      );
    stoppingEntries.add(entry);
    writes.push(publishStopping(entry));
    if (entry.session.flush) writes.push(entry.session.flush());
  }
  entries.clear();
  ending.clear();
  // The host-facing bound: the cleanups go on past it, under the reader drain.
  await within(Promise.allSettled([...cleanup, ...writes]), CLOSE_ALL_MS);
}
