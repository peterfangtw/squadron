import * as threadSync from './thread_sync';
import * as echoCandidates from './echo_candidates';
import { DEFAULT_BRAND } from '../core/brands';
import { sameSessionStart, type LaunchTarget } from '../core/model';
import { defaultPick, effortFor, resolveModel, rowPick } from '../core/model_names';
import {
  appendBlocks,
  attachmentIds,
  blank,
  sameDoc,
  type Attachment,
  type AttachmentPool,
  type ComposeDoc
} from './compose_doc';

export type SessionIdentity = { kind: 'session'; pid: number; startedAt: number };
export type DraftIdentity = { kind: 'draft'; cwd: string };
export type ChatIdentity = SessionIdentity | DraftIdentity;

export type ComposeState = {
  workflowId?: string;
  /** The editor's snapshot: what the reader wrote, and the one record of what
   *  is attached and whether the box is empty. None is an empty box. Its
   *  delivery text is the editor's to derive (`deliveryOf`), not `ui/`'s. */
  doc?: ComposeDoc;
  /** Never read by a predicate or sent: `AttachmentPool`. */
  pool?: AttachmentPool;
};

/** What `edit` may write. The pool grows through `attach` alone. */
export type ComposePatch = Partial<Omit<ComposeState, 'pool'>>;

export type SentEcho = Omit<ComposeState, 'pool'> & {
  operationId: string;
  pid: number;
  /** As captured, then as the host says it delivered it (`settleSend`). */
  delivered: string;
  /** What the document named when it was captured, so a refusal restores it. */
  attachments?: AttachmentPool;
  at: number;
};

export type FailedSend = SentEcho & { reason: string };

/** A send as begun: its echo, and the pick it carries to the session. */
export type BegunSend = SentEcho & { target?: SendTarget };

export type DialogControl = 'allow' | 'always' | 'deny' | 'cta' | 'reply';

export type DialogState = {
  picks: ReadonlyMap<number, ReadonlySet<number>>;
  texts: ReadonlyMap<number, string>;
  others: ReadonlySet<number>;
  notes: ReadonlyMap<number, string>;
  noting: ReadonlySet<number>;
  reply: string;
  bail: boolean;
  shown: number;
  cur: number;
  sending?: DialogControl;
  failure?: string;
};

export type DialogEdit = {
  picks: Map<number, Set<number>>;
  texts: Map<number, string>;
  others: Set<number>;
  notes: Map<number, string>;
  noting: Set<number>;
  reply: string;
  bail: boolean;
  shown: number;
  cur: number;
  sending?: DialogControl;
  failure?: string;
};

export type Draft = ComposeState & {
  /** One launch attempt, not the draft's storage identity. */
  id: string;
  cwd: string;
  pick?: LaunchTarget;
  sending: boolean;
  reason?: string;
  startupNote?: string;
  cancelling?: boolean;
};

export type SessionState = {
  identity: SessionIdentity;
  compose: Readonly<ComposeState>;
  thread?: ThreadView;
  pending: readonly Readonly<SentEcho>[];
  failed: readonly Readonly<FailedSend>[];
  target?: Readonly<SendTarget>;
  recache: boolean;
  sendNowConfirm: boolean;
  refusal?: string;
};

/**
 * One local chat through startup. Unbound records live in `drafts` (cwd);
 * binding attaches `identity` and rekeys onto `sessions` (pid) without copying
 * compose fields. `filePicks` is on the record because the host's file dialog
 * is asked for by a **box**: a New opens one too, and the operation id it
 * registers is what brings the paths home.
 */
type ChatRecord = ComposeState & {
  cwd: string;
  /** Launch-attempt id while unbound; reminted on each start. Not a send id. */
  id: string;
  pick?: LaunchTarget;
  unresolvedPick?: boolean;
  sending: boolean;
  reason?: string;
  startupNote?: string;
  cancelling?: boolean;
  /** Frozen first message; live compose after submit is the next message. */
  held?: SendInput;
  identity?: SessionIdentity;
  thread?: ThreadView;
  pending: Map<string, SentEcho>;
  echoClaims: Map<string, number>;
  echoBaselines: Map<string, ReadonlyMap<string, number>>;
  failed: Map<string, FailedSend>;
  dialogs: Map<string, DialogEdit>;
  /** The reader's pick: the pill shows it until the chat is left. */
  target?: SendTarget;
  /** The send that carried `target`. One pick is one act on the session, so
   *  later sends go without it until the reader picks again. */
  targetSent?: string;
  recache: boolean;
  sendNowConfirm: boolean;
  refusal?: string;
  anchors?: readonly Anchor[];
  unfolded: Set<string>;
  revealed: Set<string>;
  workflowFolds: Set<string>;
  filePicks: Set<string>;
};

type BoundRecord = ChatRecord & { identity: SessionIdentity };

type ComposerState = Pick<
  StateMessage,
  'groups' | 'models' | 'model' | 'contextWindow' | 'efforts'
>;

type PendingOpen = {
  at: number;
  landed?: boolean;
};

export type Anchor = { key: string; index: number; delta: number };

export type SendInput = {
  /** The wire document serialized: each chip its expansion, each image chip
   *  numbered (`capture`). */
  delivered: string;
  /** The wire images, in the order their `[Image #n]` numbers say. */
  images: ComposerImage[];
  workflowId?: string;
  /** The box's document as the reader left it; `capture` derives the rest. */
  doc: ComposeDoc;
  attachments?: AttachmentPool;
  at: number;
};

export type SendSettlement = {
  owner?: SessionIdentity;
  matched: boolean;
  restored: boolean;
};

export type FilePick = { owner: ChatIdentity; operationId: string };

export type ComposerContext = {
  identity: ChatIdentity;
  cwd?: string;
  skills?: string[];
  models: readonly ModelView[];
  bound: boolean;
  starting: boolean;
  canSend: boolean;
  canAttach: boolean;
  canModel: boolean;
  owned: boolean;
  pick?: LaunchTarget;
  target?: SendTarget;
  thread?: ThreadView;
  compose: Readonly<ComposeState>;
  held?: Readonly<SendInput>;
  reason?: string;
  startupNote?: string;
  cancelling?: boolean;
  model?: string;
  window?: number;
  effort?: string;
};

/** Button and Enter share this: `empty()`, plus a live run excluding workflow. */
export function eligibleCompose(compose: ComposeState, liveRun: boolean): boolean {
  return liveRun ? !empty({ ...compose, workflowId: undefined }) : !empty(compose);
}

/** One decision for the button and Enter. Held retry is its own control. */
export function canSubmit(
  compose: ComposeState,
  opts: {
    held?: SendInput;
    bound: boolean;
    liveRun: boolean;
    starting: boolean;
    canSend: boolean;
  }
): boolean {
  if (opts.starting || !opts.canSend) return false;
  if (opts.held && !opts.bound) return false;
  return eligibleCompose(compose, opts.liveRun);
}

export type BindResult = {
  active: boolean;
  owner: SessionIdentity;
  snapshot?: Readonly<SendInput>;
};

export type PendingPrune = {
  changed: boolean;
  updatedDraft: boolean;
  reconcile: string[];
};

const sessionFields = (): Pick<
  ChatRecord,
  | 'pending'
  | 'echoClaims'
  | 'echoBaselines'
  | 'failed'
  | 'dialogs'
  | 'recache'
  | 'sendNowConfirm'
  | 'unfolded'
  | 'revealed'
  | 'workflowFolds'
  | 'filePicks'
> => ({
  pending: new Map(),
  echoClaims: new Map(),
  echoBaselines: new Map(),
  failed: new Map(),
  dialogs: new Map(),
  recache: false,
  sendNowConfirm: false,
  unfolded: new Set(),
  revealed: new Set(),
  workflowFolds: new Set(),
  filePicks: new Set()
});

/** Protocol and compose payloads are plain data; freeze a private copy at the seam. */
const snapshot = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return Object.freeze(items.map((item) => snapshot(item))) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = snapshot(item);
  return Object.freeze(copy) as T;
};

const empty = (state: ComposeState): boolean =>
  state.workflowId === undefined && (!state.doc || blank(state.doc));

/**
 * A draft nobody would miss: nothing typed, nothing attached, no start in
 * flight — and no file dialog still standing, host-side, that was opened from
 * it. That last clause is why this is not just `empty()`: a reader who presses
 * New and reaches straight for the clip has an empty box by definition, and
 * dropping the record while the dialog is up is dropping the answer to it.
 *
 * `empty()` alone stays the rule for a session's box, where the question is
 * whether a failed send can be restored into it and an open dialog is beside
 * the point.
 *
 * **An explicit dismiss is held by this too, and that is the decision rather
 * than a side effect.** Dismissing a New between opening the dialog and
 * choosing in it keeps the record, so the paths land and the folder's slot
 * comes back carrying the token — the same rule as anything else typed into a
 * draft, and a file the reader picked is something they did. The alternative
 * throws that selection away with nothing said, which is the failure this whole
 * path exists to remove. It cannot strand the slot: a cancelled dialog answers
 * too (`host/session_io.ts`), so the id is released either way.
 */
const disposable = (draft: ChatRecord): boolean =>
  empty(draft) && !draft.held && !draft.sending && draft.filePicks.size === 0;

const sendingLive = (record: ComposeState, input: SendInput): boolean =>
  record.workflowId === input.workflowId && sameDoc(record.doc, input.doc);

/** A send or a hold empties the box, and its history goes with it. */
const clear = (record: ComposeState): void => {
  record.workflowId = undefined;
  record.doc = undefined;
  record.pool = undefined;
};

/**
 * The composer leaving an owner installs a fresh history when it comes back,
 * so no Undo can bring back a chip the document no longer names.
 */
const prune = (record: ComposeState): void => {
  if (!record.pool) return;
  const named = record.doc ? attachmentIds(record.doc) : new Set<string>();
  const kept = Object.entries(record.pool).filter(([id]) => named.has(id));
  record.pool = kept.length ? snapshot(Object.fromEntries(kept)) : undefined;
};

const counts = (keys: readonly string[]): Map<string, number> => {
  const found = new Map<string, number>();
  for (const key of keys) found.set(key, (found.get(key) ?? 0) + 1);
  return found;
};

/**
 * All mutable state owned by a running chat or an unsent New.
 *
 * Callers see read views and operations, never the backing maps. The active
 * identity is the only selector, and a host push may update any record without
 * making it active.
 */
export class ChatState {
  private sessions = new Map<number, BoundRecord>();
  private drafts = new Map<string, ChatRecord>();
  private pendingOpen = new Map<string, PendingOpen>();
  private activeIdentity: ChatIdentity | null = null;
  private selectionRequest: string | undefined;
  private publication?: ThreadPublication;
  private recoveryRequested = false;
  private recoveryPending = false;
  private readonly nonce = globalThis.crypto.randomUUID();
  private sequence = 0;

  active(): ChatIdentity | null {
    return this.activeIdentity ? { ...this.activeIdentity } : null;
  }

  selected(): number | null {
    return this.activeIdentity?.kind === 'session' ? this.activeIdentity.pid : null;
  }

  activeDraft(): Readonly<Draft> | null {
    if (this.activeIdentity?.kind !== 'draft') return null;
    const draft = this.drafts.get(this.activeIdentity.cwd);
    return draft ? this.draftSnapshot(draft) : null;
  }

  draftFor(cwd: string): Readonly<Draft> | undefined {
    const draft = this.drafts.get(cwd);
    return draft ? this.draftSnapshot(draft) : undefined;
  }

  draftById(id: string): Readonly<Draft> | undefined {
    for (const draft of this.drafts.values()) if (draft.id === id) return this.draftSnapshot(draft);
    return undefined;
  }

  session(pid: number): SessionState | undefined {
    const record = this.sessions.get(pid);
    if (!record) return undefined;
    return {
      identity: { ...record.identity },
      compose: this.composeOf(record),
      thread: record.thread,
      pending: [...record.pending.values()].map((echo) => this.echoSnapshot(echo)),
      failed: [...record.failed.values()].map((echo) => this.echoSnapshot(echo)),
      target: record.target ? { ...record.target } : undefined,
      recache: record.recache,
      sendNowConfirm: record.sendNowConfirm,
      refusal: record.refusal
    };
  }

  thread(): ThreadView | undefined {
    const pid = this.selected();
    return pid === null ? undefined : this.sessions.get(pid)?.thread;
  }

  compose(): Readonly<ComposeState> | undefined {
    return this.activeIdentity ? this.composeFor(this.activeIdentity) : undefined;
  }

  /** What a named box holds, whichever kind it is — `compose()` for a box that
   *  is not the active one, which is where a late file pick lands. */
  composeFor(identity: ChatIdentity): Readonly<ComposeState> | undefined {
    const record = this.record(identity);
    return record && this.composeOf(record);
  }

  context(state: ComposerState): ComposerContext | undefined {
    return this.activeIdentity ? this.contextFor(this.activeIdentity, state) : undefined;
  }

  contextFor(identity: ChatIdentity, state: ComposerState): ComposerContext | undefined {
    const record = this.record(identity);
    if (!record) return undefined;
    if (identity.kind === 'draft') {
      const group = state.groups.find((candidate) => candidate.cwd === identity.cwd);
      if (!record.sending) resolveDraftPick(record, state);
      const pick = record.pick;
      return {
        identity,
        cwd: identity.cwd,
        skills: group?.skillsByBrand?.[pick?.brand ?? DEFAULT_BRAND],
        models: state.models,
        bound: false,
        starting: record.sending,
        canSend: !record.sending,
        canAttach: true,
        canModel: true,
        owned: false,
        pick,
        compose: this.composeOf(record),
        ...(record.held === undefined ? {} : { held: snapshot(record.held) }),
        reason: record.reason,
        model: pick?.model,
        window: pick?.window,
        effort: pick?.effort
      };
    }
    const thread = record.thread;
    const mine =
      thread &&
      thread.pid === identity.pid &&
      sameSessionStart(thread.startedAt, identity.startedAt)
        ? thread
        : undefined;
    const card = state.groups
      .flatMap((group) => group.sessions)
      .find((session) => session.pid === identity.pid);
    const models = mine?.models?.length ? mine.models : state.models;
    const held = record.target;
    const model =
      held?.model ??
      (mine
        ? (resolveModel(models, mine.model, mine.modelPick)?.value ?? mine.model ?? mine.modelPick)
        : undefined);
    const window = held?.window ?? mine?.contextSize;
    return {
      identity,
      cwd: card ? (card.liveCwd ?? card.fullCwd) : undefined,
      skills: mine?.skills,
      models,
      bound: true,
      starting: false,
      canSend: !mine || mine.canSend,
      canAttach: !mine || mine.canAttach !== false,
      canModel: !!mine?.owned && mine.canModel !== false,
      owned: !!mine?.owned,
      target: held,
      thread: mine,
      compose: this.composeOf(record),
      ...(record.held === undefined ? {} : { held: snapshot(record.held) }),
      reason: record.refusal,
      model,
      window,
      effort: held ? held.effort : mine?.effort
    };
  }

  /** Whether that box is the one the dock is on. Public because the composer
   *  asks it of a box it resolved rather than of the one it is painting. */
  isActive(identity: ChatIdentity): boolean {
    return this.sameIdentity(this.activeIdentity, identity);
  }

  takeThread(msg: ThreadMessage | ThreadPatchMessage): boolean {
    const active = this.active();
    const previous = this.publication;
    const pid = msg.type === 'thread' ? msg.thread.pid : msg.pid;
    const startedAt = msg.type === 'thread' ? msg.thread.startedAt : msg.startedAt;
    if (
      msg.selection !== this.selectionRequest ||
      active?.kind !== 'session' ||
      active.pid !== pid ||
      !sameSessionStart(active.startedAt, startedAt) ||
      (previous?.selection === msg.selection &&
        (msg.sequence <= previous.sequence || msg.generation < previous.generation))
    )
      return false;
    let thread: ThreadView | undefined;
    if (msg.type === 'thread') thread = msg.thread;
    else {
      const before = this.thread();
      if (
        before &&
        previous?.selection === msg.selection &&
        previous.generation === msg.generation &&
        previous.revision !== undefined &&
        previous.revision === msg.base &&
        msg.revision > msg.base
      )
        thread = threadSync.apply(before, msg);
      if (!thread) {
        if (!this.recoveryRequested) this.recoveryPending = true;
        return false;
      }
    }
    this.publication = {
      selection: msg.selection,
      generation: msg.generation,
      sequence: msg.sequence,
      revision: msg.revision
    };
    this.recoveryRequested = false;
    this.recoveryPending = false;
    this.observeThread(thread);
    return true;
  }

  threadRecovery(): Extract<WebviewMessage, { type: 'threadSync' }> | undefined {
    const active = this.active();
    if (!this.recoveryPending || active?.kind !== 'session' || !this.selectionRequest)
      return undefined;
    this.recoveryPending = false;
    this.recoveryRequested = true;
    return {
      type: 'threadSync',
      pid: active.pid,
      startedAt: active.startedAt,
      selection: this.selectionRequest
    };
  }

  historyRequest(full: boolean): Extract<WebviewMessage, { type: 'threadHistory' }> | undefined {
    const active = this.active();
    if (active?.kind !== 'session' || !this.selectionRequest || !this.publication) return undefined;
    return {
      type: 'threadHistory',
      pid: active.pid,
      startedAt: active.startedAt,
      selection: this.selectionRequest,
      generation: this.publication.generation,
      full
    };
  }

  requestSelection(): string {
    this.selectionRequest = this.next('select');
    this.recoveryRequested = false;
    this.recoveryPending = false;
    return this.selectionRequest;
  }

  observe(msg: StateMessage): SessionIdentity[] {
    const replaced: SessionIdentity[] = [];
    for (const group of msg.groups) {
      for (const card of group.sessions) {
        const record = this.sessions.get(card.pid);
        if (!record) {
          this.sessions.set(card.pid, this.newSession(card.pid, card.startedAt));
          continue;
        }
        if (sameSessionStart(record.identity.startedAt, card.startedAt)) continue;
        if (card.startedAt < record.identity.startedAt) continue;
        this.sessions.set(card.pid, this.newSession(card.pid, card.startedAt));
        replaced.push({ kind: 'session', pid: card.pid, startedAt: card.startedAt });
      }
    }
    if (msg.thread) {
      if (msg.threadPublication)
        this.takeThread({ type: 'thread', ...msg.threadPublication, thread: msg.thread });
      else if (!this.publication) this.observeThread(msg.thread);
    }
    return replaced;
  }

  private observeThread(thread: ThreadView): void {
    let record = this.sessions.get(thread.pid);
    if (!record) {
      record = this.newSession(thread.pid, thread.startedAt);
      this.sessions.set(thread.pid, record);
    }
    if (sameSessionStart(record.identity.startedAt, thread.startedAt)) {
      record.thread = snapshot(thread);
      this.syncEchoCandidates(thread.pid, thread.startedAt, this.echoCandidateKeys(thread));
    }
  }

  activateSession(pid: number, startedAt?: number): boolean | undefined {
    let record = this.sessions.get(pid);
    if (
      startedAt !== undefined &&
      (!record || !sameSessionStart(record.identity.startedAt, startedAt))
    ) {
      if (record && startedAt < record.identity.startedAt) return undefined;
      record = this.newSession(pid, startedAt);
      this.sessions.set(pid, record);
    }
    if (!record) return undefined;
    const next = record.identity;
    const changed = !this.sameIdentity(this.activeIdentity, next);
    if (changed) this.leaveActive();
    this.activeIdentity = next;
    return changed;
  }

  openDraft(cwd: string): Readonly<Draft> {
    if (this.activeIdentity?.kind === 'draft') this.closeDraft();
    let draft = this.drafts.get(cwd);
    if (!draft) {
      draft = {
        id: this.next('draft'),
        cwd,
        sending: false,
        ...sessionFields()
      };
      this.drafts.set(cwd, draft);
    }
    this.leaveActive();
    this.activeIdentity = { kind: 'draft', cwd };
    return this.draftSnapshot(draft);
  }

  deactivate(): void {
    this.leaveActive();
    this.activeIdentity = null;
  }

  closeDraft(): void {
    if (this.activeIdentity?.kind !== 'draft') return;
    const cwd = this.activeIdentity.cwd;
    const draft = this.drafts.get(cwd);
    if (draft && disposable(draft)) this.drafts.delete(cwd);
    else if (draft) prune(draft);
    this.activeIdentity = null;
  }

  /** Pools an attachment for a chip to name, under an id minted here. */
  attach(identity: ChatIdentity, attachment: Attachment): string | undefined {
    const record = this.record(identity);
    if (!record) return undefined;
    const id = this.next('attach');
    record.pool = snapshot({ ...record.pool, [id]: attachment });
    return id;
  }

  append(identity: ChatIdentity, blocks: ComposeDoc): void {
    const record = this.record(identity);
    if (record) record.doc = snapshot(appendBlocks(record.doc, blocks));
  }

  edit(identity: ChatIdentity, patch: ComposePatch): void {
    const record = this.record(identity);
    if (!record) return;
    if ('workflowId' in patch) record.workflowId = patch.workflowId;
    if ('doc' in patch) record.doc = patch.doc && snapshot(patch.doc);
  }

  chooseTarget(pid: number, target: SendTarget): void {
    const record = this.sessions.get(pid);
    if (!record) return;
    record.target = { ...target };
    record.targetSent = undefined;
    record.refusal = undefined;
  }

  setRecache(pid: number, on: boolean): void {
    const record = this.sessions.get(pid);
    if (!record) return;
    record.recache = on;
    if (on) record.refusal = undefined;
  }

  clearRefusal(pid: number): void {
    const record = this.sessions.get(pid);
    if (record) record.refusal = undefined;
  }

  setSendNowConfirm(pid: number, on: boolean): void {
    const record = this.sessions.get(pid);
    if (record) record.sendNowConfirm = on;
  }

  beginSend(pid: number, input: SendInput): BegunSend | undefined {
    const record = this.sessions.get(pid);
    if (!record) return undefined;
    const echo: SentEcho = {
      operationId: this.next('send'),
      pid,
      delivered: input.delivered,
      ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      doc: snapshot(input.doc),
      ...(input.attachments === undefined ? {} : { attachments: snapshot(input.attachments) }),
      at: input.at
    };
    record.pending.set(echo.operationId, echo);
    record.echoBaselines.set(echo.operationId, counts(this.echoCandidateKeys(record.thread)));
    const target = record.targetSent === undefined ? record.target : undefined;
    if (target) record.targetSent = echo.operationId;
    const sendingHeld = record.held !== undefined && record.held.at === input.at;
    if (sendingHeld) record.held = undefined;
    else if (sendingLive(record, input)) clear(record);
    record.refusal = undefined;
    return { ...this.echoSnapshot(echo), ...(target ? { target: { ...target } } : {}) };
  }

  settleSend(
    pid: number,
    startedAt: number | undefined,
    operationId: string | undefined,
    ok: boolean,
    reason?: string,
    delivered?: string
  ): SendSettlement {
    const record = this.sessions.get(pid);
    if (!record) return { matched: false, restored: false };
    if (startedAt !== undefined && !sameSessionStart(record.identity.startedAt, startedAt)) {
      return { matched: false, restored: false };
    }
    if (operationId === undefined) {
      if (!ok && reason) record.refusal = reason;
      return { owner: { ...record.identity }, matched: false, restored: false };
    }
    const echo = record.pending.get(operationId);
    if (!echo) return { owner: { ...record.identity }, matched: false, restored: false };
    if (ok) {
      if (delivered !== undefined) echo.delivered = delivered;
      return { owner: { ...record.identity }, matched: true, restored: false };
    }
    record.pending.delete(operationId);
    record.echoBaselines.delete(operationId);
    if (record.targetSent === operationId) record.targetSent = undefined;
    const failed: FailedSend = { ...echo, reason: reason ?? 'That message was not sent.' };
    let restored = false;
    if (empty(record)) {
      this.restore(record, failed);
      restored = true;
    } else {
      record.failed.set(operationId, failed);
    }
    record.refusal = failed.reason;
    return { owner: { ...record.identity }, matched: true, restored };
  }

  syncEchoCandidates(pid: number, startedAt: number, candidateKeys: readonly string[]): void {
    const record = this.sessionRecord(pid, startedAt);
    if (!record) return;
    const live = counts(candidateKeys);
    for (const [key, claimed] of record.echoClaims) {
      const available = live.get(key) ?? 0;
      if (available === 0) record.echoClaims.delete(key);
      else if (claimed > available) record.echoClaims.set(key, available);
    }
  }

  reconcileEcho(
    pid: number,
    startedAt: number,
    operationId: string,
    candidateKeys: readonly string[]
  ): boolean {
    const record = this.sessionRecord(pid, startedAt);
    if (!record?.pending.has(operationId)) return false;
    const baseline = record.echoBaselines.get(operationId);
    for (const key of new Set(candidateKeys)) {
      const available = candidateKeys.filter((candidate) => candidate === key).length;
      const claimed = Math.max(record.echoClaims.get(key) ?? 0, baseline?.get(key) ?? 0);
      if (claimed >= available) continue;
      record.echoClaims.set(key, claimed + 1);
      record.pending.delete(operationId);
      record.echoBaselines.delete(operationId);
      return true;
    }
    return false;
  }

  expireEcho(pid: number, startedAt: number, operationId: string): void {
    const record = this.sessionRecord(pid, startedAt);
    record?.pending.delete(operationId);
    record?.echoBaselines.delete(operationId);
  }

  beginFilePick(identity: ChatIdentity): FilePick | undefined {
    const record = this.record(identity);
    if (!record) return undefined;
    const operationId = this.next('files');
    record.filePicks.add(operationId);
    return { owner: { ...identity }, operationId };
  }

  /**
   * Whose pick this was, by the id alone.
   *
   * The host's answer names no box — it does not have to. The id was minted
   * here and registered on the record that asked, so the search *is* the
   * check, and it keeps for free the two guards the pid used to buy: a
   * recycled pid has a fresh record whose set never held this id, and a draft
   * that has been dismissed has no record to find.
   */
  settleFilePick(operationId: string): ChatIdentity | undefined {
    for (const record of this.sessions.values()) {
      if (record.filePicks.delete(operationId)) return { ...record.identity };
    }
    for (const [cwd, draft] of this.drafts) {
      if (draft.filePicks.delete(operationId)) return { kind: 'draft', cwd };
    }
    return undefined;
  }

  syncDialogs(pid: number, startedAt: number, requestIds: readonly string[]): void {
    const record = this.sessionRecord(pid, startedAt);
    if (!record) return;
    const live = new Set(requestIds);
    for (const id of record.dialogs.keys()) if (!live.has(id)) record.dialogs.delete(id);
    for (const id of requestIds) {
      if (record.dialogs.has(id)) continue;
      record.dialogs.set(id, {
        picks: new Map(),
        texts: new Map(),
        others: new Set(),
        notes: new Map(),
        noting: new Set(),
        reply: '',
        bail: false,
        shown: 0,
        cur: -1
      });
    }
  }

  dialog(pid: number, startedAt: number, requestId: string): DialogState | undefined {
    const dialog = this.sessionRecord(pid, startedAt)?.dialogs.get(requestId);
    return dialog && this.dialogSnapshot(dialog);
  }

  editDialog(
    pid: number,
    startedAt: number,
    requestId: string,
    edit: (dialog: DialogEdit) => void
  ): boolean {
    const record = this.sessionRecord(pid, startedAt);
    if (!record) return false;
    const dialog = record.dialogs.get(requestId);
    if (!dialog) return false;
    const copy = this.dialogSnapshot(dialog);
    edit(copy);
    record.dialogs.set(requestId, this.dialogSnapshot(copy));
    return true;
  }

  settleDialog(
    pid: number,
    startedAt: number,
    requestId: string,
    ok: boolean,
    reason?: string
  ): void {
    this.editDialog(pid, startedAt, requestId, (dialog) => {
      if (ok) {
        dialog.failure = undefined;
        return;
      }
      dialog.sending = undefined;
      dialog.failure = reason;
    });
  }

  recoverFailed(pid: number, operationId: string): boolean {
    const record = this.sessions.get(pid);
    const failed = record?.failed.get(operationId);
    if (!record || !failed || !empty(record)) return false;
    this.restore(record, failed);
    record.failed.delete(operationId);
    return true;
  }

  dismissFailed(pid: number, operationId: string): void {
    this.sessions.get(pid)?.failed.delete(operationId);
  }

  setDraftPick(cwd: string, pick: LaunchTarget): void {
    const draft = this.drafts.get(cwd);
    if (!draft) return;
    draft.pick = snapshot(pick);
    draft.unresolvedPick = false;
  }

  clearDraftReason(cwd: string): void {
    const draft = this.drafts.get(cwd);
    if (draft) draft.reason = undefined;
  }

  beginDraftStart(cwd: string, at: number): string | undefined {
    const draft = this.drafts.get(cwd);
    if (!draft || this.openInFlight(cwd)) return undefined;
    this.pendingOpen.set(cwd, { at });
    draft.id = this.next('draft');
    draft.sending = true;
    draft.reason = undefined;
    draft.startupNote = undefined;
    draft.cancelling = false;
    return draft.id;
  }

  refuseDraft(id: string, reason: string): void {
    for (const draft of this.drafts.values()) {
      if (draft.id !== id) continue;
      draft.sending = false;
      draft.reason = reason;
      draft.id = this.next('draft');
      return;
    }
  }

  failDraftStart(id: string, reason: string): void {
    const cwd = this.draftById(id)?.cwd;
    if (cwd !== undefined) this.pendingOpen.delete(cwd);
    this.refuseDraft(id, reason);
  }

  holdSubmit(identity: ChatIdentity, input: SendInput): Readonly<SendInput> | undefined {
    const record = this.record(identity);
    if (!record) return undefined;
    record.held = snapshot(input);
    clear(record);
    return record.held;
  }

  heldFor(identity: ChatIdentity): Readonly<SendInput> | undefined {
    const held = this.record(identity)?.held;
    return held && snapshot(held);
  }

  dismissHeld(identity: ChatIdentity): void {
    const record = this.record(identity);
    if (record) record.held = undefined;
  }

  refuseHeld(pid: number, reason: string): void {
    const record = this.sessions.get(pid);
    if (record) record.refusal = reason;
  }

  noteStartup(id: string, note: string, cancelling = false): void {
    for (const draft of this.drafts.values())
      if (draft.id === id && draft.sending) {
        draft.startupNote = note;
        draft.cancelling ||= cancelling;
      }
  }

  bindSession(id: string, pid: number, startedAt: number): BindResult | undefined {
    const draft = [...this.drafts.values()].find((candidate) => candidate.id === id);
    if (!draft || draft.cancelling) return undefined;
    const active = this.activeIdentity?.kind === 'draft' && this.activeIdentity.cwd === draft.cwd;
    const owner: SessionIdentity = { kind: 'session', pid, startedAt };
    const existing = this.sessions.get(pid);
    if (existing && !sameSessionStart(existing.identity.startedAt, startedAt)) {
      if (startedAt < existing.identity.startedAt) return undefined;
    }
    const bound = this.takeBound(draft, owner, existing);
    this.sessions.set(pid, bound);
    this.drafts.delete(draft.cwd);
    if (active) this.activeIdentity = { ...owner };
    this.noteStarted(draft.cwd);
    return {
      active,
      owner,
      ...(bound.held === undefined ? {} : { snapshot: snapshot(bound.held) })
    };
  }

  openInFlight(cwd: string): boolean {
    const wait = this.pendingOpen.get(cwd);
    return wait !== undefined && !wait.landed;
  }

  noteStarted(cwd: string): void {
    // A reveal is stronger evidence than a poll: a session may start and end
    // between polls. Without this, that successful start leaves the New slot
    // blocked until the timeout. Observed in the stock-host smoke barrel when
    // consecutive cases opened three drafts inside that window.
    const wait = this.pendingOpen.get(cwd);
    if (wait) wait.landed = true;
  }

  prunePending(now: number, maxAge: number): PendingPrune {
    const reconcile: string[] = [];
    for (const [cwd, wait] of this.pendingOpen) {
      const draft = this.drafts.get(cwd);
      if (!draft?.sending) {
        this.pendingOpen.delete(cwd);
        continue;
      }
      if (now - wait.at > maxAge) {
        wait.at = now;
        draft.startupNote = 'Still waiting for confirmation. Your message is held.';
        reconcile.push(draft.id);
      }
    }
    return { changed: reconcile.length > 0, updatedDraft: reconcile.length > 0, reconcile };
  }

  saveAnchors(pid: number, anchors: readonly Anchor[]): void {
    const record = this.sessions.get(pid);
    if (record) record.anchors = anchors.length ? snapshot(anchors) : undefined;
  }

  anchorsFor(pid: number): readonly Anchor[] {
    return this.sessions.get(pid)?.anchors ?? [];
  }

  fold(pid: number, kind: 'fold' | 'row', key: string, open: boolean): void {
    const record = this.sessions.get(pid);
    if (!record) return;
    const set = kind === 'fold' ? record.unfolded : record.revealed;
    if (open) set.add(key);
    else set.delete(key);
  }

  isOpen(pid: number, kind: 'fold' | 'row', key: string): boolean {
    const record = this.sessions.get(pid);
    if (!record) return false;
    return (kind === 'fold' ? record.unfolded : record.revealed).has(key);
  }

  setWorkflowFold(identity: ChatIdentity, workflowId: string, open: boolean): void {
    const record = this.record(identity);
    if (!record) return;
    if (open) record.workflowFolds.add(workflowId);
    else record.workflowFolds.delete(workflowId);
  }

  workflowFolded(identity: ChatIdentity, workflowId: string): boolean {
    return this.record(identity)?.workflowFolds.has(workflowId) ?? false;
  }

  reset(): void {
    this.sessions.clear();
    this.drafts.clear();
    this.pendingOpen.clear();
    this.activeIdentity = null;
    this.selectionRequest = undefined;
    this.publication = undefined;
  }

  private newSession(pid: number, startedAt: number): BoundRecord {
    return {
      identity: { kind: 'session', pid, startedAt },
      cwd: '',
      id: '',
      sending: false,
      ...sessionFields()
    };
  }

  private takeBound(
    draft: ChatRecord,
    owner: SessionIdentity,
    existing: BoundRecord | undefined
  ): BoundRecord {
    if (existing && sameSessionStart(existing.identity.startedAt, owner.startedAt)) {
      draft.thread = existing.thread;
      draft.pending = existing.pending;
      draft.echoClaims = existing.echoClaims;
      draft.echoBaselines = existing.echoBaselines;
      draft.failed = existing.failed;
      draft.dialogs = existing.dialogs;
      draft.target = existing.target;
      draft.targetSent = existing.targetSent;
      draft.recache = existing.recache;
      draft.sendNowConfirm = existing.sendNowConfirm;
      draft.refusal = existing.refusal;
      draft.anchors = existing.anchors;
      draft.unfolded = existing.unfolded;
      draft.revealed = existing.revealed;
      this.mergeLiveCompose(draft, existing);
    }
    draft.identity = owner;
    return draft as BoundRecord;
  }

  private mergeLiveCompose(into: ChatRecord, from: ChatRecord): void {
    for (const id of from.filePicks) into.filePicks.add(id);
    for (const id of from.workflowFolds) into.workflowFolds.add(id);
    if (empty(from)) return;
    into.doc = snapshot(appendBlocks(into.doc, from.doc));
    if (from.pool) into.pool = snapshot({ ...into.pool, ...from.pool });
    if (from.workflowId !== undefined && into.workflowId === undefined) {
      into.workflowId = from.workflowId;
    }
  }

  private record(identity: ChatIdentity): ChatRecord | undefined {
    if (identity.kind === 'draft') return this.drafts.get(identity.cwd);
    const record = this.sessions.get(identity.pid);
    return record && sameSessionStart(record.identity.startedAt, identity.startedAt)
      ? record
      : undefined;
  }

  private composeOf(record: ComposeState): ComposeState {
    return snapshot({
      ...(record.workflowId === undefined ? {} : { workflowId: record.workflowId }),
      ...(record.doc === undefined ? {} : { doc: record.doc }),
      ...(record.pool === undefined ? {} : { pool: record.pool })
    });
  }

  private draftSnapshot(draft: ChatRecord): Readonly<Draft> {
    return snapshot({
      ...this.composeOf(draft),
      id: draft.id,
      cwd: draft.cwd,
      pick: draft.pick ? { ...draft.pick } : undefined,
      sending: draft.sending,
      reason: draft.reason,
      startupNote: draft.startupNote,
      cancelling: draft.cancelling
    });
  }

  private echoSnapshot<T extends SentEcho>(echo: T): T {
    return snapshot(echo);
  }

  private dialogSnapshot(dialog: DialogEdit): DialogEdit {
    return {
      ...dialog,
      picks: new Map([...dialog.picks].map(([index, picks]) => [index, new Set(picks)])),
      texts: new Map(dialog.texts),
      others: new Set(dialog.others),
      notes: new Map(dialog.notes),
      noting: new Set(dialog.noting)
    };
  }

  private sessionRecord(pid: number, startedAt: number): BoundRecord | undefined {
    const record = this.sessions.get(pid);
    return record && sameSessionStart(record.identity.startedAt, startedAt) ? record : undefined;
  }

  private echoCandidateKeys(thread: ThreadView | undefined): string[] {
    if (!thread) return [];
    return echoCandidates.candidates(thread).map((candidate) => candidate.key);
  }

  private restore(record: ChatRecord, failed: FailedSend): void {
    record.workflowId = failed.workflowId;
    record.doc = failed.doc;
    record.pool = failed.attachments;
  }

  private leaveActive(): void {
    if (this.activeIdentity?.kind === 'draft') {
      const draft = this.drafts.get(this.activeIdentity.cwd);
      if (draft && disposable(draft)) this.drafts.delete(draft.cwd);
      else if (draft) prune(draft);
      return;
    }
    if (this.activeIdentity?.kind !== 'session') return;
    const record = this.sessions.get(this.activeIdentity.pid);
    if (!record) return;
    prune(record);
    record.target = undefined;
    record.targetSent = undefined;
    record.recache = false;
    record.sendNowConfirm = false;
  }

  private sameIdentity(a: ChatIdentity | null, b: ChatIdentity): boolean {
    if (!a || a.kind !== b.kind) return false;
    return a.kind === 'draft'
      ? a.cwd === (b as DraftIdentity).cwd
      : a.pid === (b as SessionIdentity).pid &&
          sameSessionStart(a.startedAt, (b as SessionIdentity).startedAt);
  }

  private next(prefix: 'draft' | 'send' | 'files' | 'attach' | 'select'): string {
    return `${prefix}-${this.nonce}-${++this.sequence}`;
  }
}

/** A seed leaves refusals standing and settles once its model is offered.
 * With no model to seed, the composer keeps its account-default launch. */
function resolveDraftPick(record: ChatRecord, state: ComposerState): void {
  if (!record.pick) {
    const pick = defaultPick(state.models, state.model, state.contextWindow, state.efforts);
    if (!pick) return;
    record.pick = snapshot(pick);
    record.unresolvedPick = true;
  }
  const model = resolveModel(state.models, undefined, record.pick.model, record.pick.window);
  if (!model) return;
  if (record.unresolvedPick) {
    record.pick = snapshot(rowPick(state.models, model, state.efforts));
    record.unresolvedPick = false;
    return;
  }
  if (
    !model.efforts?.length ||
    model.efforts.some((entry) => entry.value === record.pick?.effort)
  ) {
    return;
  }
  const effort = effortFor(state.models, model.value, model.window, state.efforts[model.value]);
  record.pick = snapshot({ ...record.pick, effort });
}

export const chats: ChatState = new ChatState();
