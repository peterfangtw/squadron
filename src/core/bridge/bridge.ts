/**
 * The engine: one messenger, the conversation store, and the sessions it
 * reaches through `SessionVerbs`. It owns the sequence — post, record the ref,
 * act, settle with the outcome — and each step's failure rule, so the host
 * fills ports and decides nothing (`src/AGENTS.md`: a decision worth a test
 * belongs in `core/`).
 *
 * Routing and notices share one chain. Message admission and reaction effects
 * run independently; store writes snapshot records and keep their call order.
 */

import { MessageState } from './message_state';
import { IncomingDelivery } from './incoming_delivery';
import { PickerFlow } from './picker_flow';
import {
  sameAddr,
  rootOfWatched,
  type SessionVerbs,
  type Started,
  type Stopped,
  type Ended
} from './session';
export type { SessionVerbs, Started, Stopped, Ended } from './session';
import * as status from './message_status';
import * as access from './access';
import type { CheckRegistration } from '../reconcile';
import * as picker from './picker';
import { HELD_MS } from './jobs';
import * as path from 'path';
import type { Act } from '../coordination/route';
import { checkoutRoots } from '../git';
import type { WindowClaim } from '../model';
import { recordFile } from '../record';
import { allowed } from './allow';
import { freshPrompt, freshWindow, threadPrompt } from './jobs';
import { lapses, type Lapse } from './lifetime';
import {
  MaybePosted,
  type ActionNotice,
  type Attached,
  type Attachment,
  type Inbound,
  type MessageRef,
  type Notice,
  type Place,
  type Posted,
  type Routed,
  type SenderId,
  type SessionAddr,
  type ThreadRead,
  type Watched
} from './model';
import { closedWhileAway, conversationFor, noticeEdges, whoOf } from './notify';
import type { Destination, NoticeEdge } from './notify';
import type { Connection, LinkState, Messenger } from './port';
import { CatchUp } from './catch_up';
import { addrOf, onBoard, placeOf, route, routeAdmitted } from './route';
import type { RouteContext } from './route';
import { decodePayload, conversationOfRoot, encodePayload } from './store';
import type {
  ButtonAction,
  ConversationRecord,
  ConversationRoot,
  NoticeRecord,
  MessageRecord
} from './store';
import { renderThread, writeThread } from './thread_file';
import * as words from './words';

export type BridgeOptions = {
  messenger: Messenger;
  /** The messenger's name as a reader knows it (`MessengerEntry.label`), for
   *  "larger than <messenger> takes". */
  label?: string;
  verbs: SessionVerbs;
  /** Normalized; the first entry is home (U3). */
  allowlist: readonly SenderId[];
  clock: () => number;
  claims?: () => Promise<readonly WindowClaim[]>;
  /** Each folder's repository root, for the cwd tiers (D26). */
  resolve?: (folders: Iterable<string>) => Promise<Map<string, string>>;
  log?: (line: string) => void;
  /** The engine this one replaces, as it last observed: the first pass is
   *  compared with that rather than taken as a baseline. */
  observed?: Observed;
  /** A person turned Remote on: the kept watermark is dropped, so nothing
   *  sent while it was off is caught up (forward-only). */
  fresh?: boolean;
  /** Registers the engine's own retries (reactions and incoming writes) with
   *  the Reconciler, apart from the routing pass. */
  register?: Register;
  holder?: import('../remote/holder').Holder;
};

/** A Reconciler registration factory: the engine names its tenant. */
export type Register = (
  name: string,
  check: () => Promise<void>
) => Pick<CheckRegistration, 'schedule' | 'dispose'>;

/**
 * What an engine has observed, handed to one built in its place under the
 * same holder: the board its next edges compare against, the windows, and the
 * roots it started that no board has shown yet. A new engine with none of it
 * takes its first pass as a baseline, so a finish since the last pass never
 * posts, and a reply to a root not yet on the board starts a second one.
 */
export type Observed = {
  board: readonly Watched[];
  claims: readonly WindowClaim[];
  starting: readonly { addr: SessionAddr; since: number }[];
  /** Sessions an End or a lifetime from the old engine is taking down. */
  ending?: readonly SessionAddr[];
  /** What the next pass compares against, where it differs from `board`: a
   *  session whose notice failed to post keeps its earlier entry, so the
   *  edge is derived again. */
  baseline?: readonly Watched[];
};

type Failed = { ok: false; reason: string };

/** One replayed batch's late refusals: the places answered, and each place's
 *  reply, owed until the batch's other late messages there are finished. */
type LateReplies = { places: Set<string>; owed: (() => Promise<void>)[] };

/**
 * How long a root the engine started counts as live with no board showing it.
 * A reply before the next observation would otherwise find it absent and start
 * a second root; another window's session reaches the board only once that
 * window publishes it. One that died before any board showed it is ended after
 * this long.
 */
export const STARTING_MS = 120_000;

/** How long after a failed post the engine asks for the pass that tries it
 *  again (a duration). A link coming back asks sooner. */
export const OWED_RETRY_MS = 30_000;

/** How long a joined thread's read may take, all of it (a duration). It runs
 *  on the chain, so every later event waits on it: one page of replies and a
 *  name per member is a couple of seconds, and past this the job goes on
 *  without the thread rather than holding the rest. */
export const THREAD_READ_MS = 15_000;

export class Bridge {
  private board: readonly Watched[] = [];
  /** `board`, but for each session whose notice failed to post, the entry
   *  that pass compared against: the next pass derives that edge again. */
  private compared: readonly Watched[] = [];
  /** When a notice last failed to post, while one is owed. */
  private owedAt: number | undefined;
  /** The link's kind as last reported, so a catch-up runs on a return and
   *  not on a warning. */
  private linkKind: LinkState['kind'] | undefined;
  /** Thread reads in flight, which `stop` abandons. */
  private readonly reading = new Set<AbortController>();
  private readonly catchUp: CatchUp;
  private claims: readonly WindowClaim[] = [];
  /** Roots started here that no board has shown yet, with when. */
  private starting: { addr: SessionAddr; since: number }[] = [];
  /** Sessions an End or a lifetime from here is taking down, until a board
   *  shows them gone. One entry per end, so two ends of one session count
   *  apart. */
  private ending: SessionAddr[] = [];
  /** Remote-spawned roots whose lifetime end was refused, with when to try
   *  again. Memory only: a rebuilt engine tries once more. */
  private retries = new Map<string, number>();
  /** When a reply last reached each root. The pass that ends a cold root
   *  read its board before a reply queued ahead of it was delivered, so the
   *  board's clock cannot show that traffic yet. */
  private delivered = new Map<string, number>();
  private connection: Connection | undefined;
  private readonly listeners = new Set<(state: LinkState) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Whether a pass has run since `start`: the first compares against nothing. */
  private observed = false;
  /** Set while a pass tries its edges, to what that pass began from (nothing
   *  before a first). A pass `stop` cut short leaves it set. */
  private passing: { from: Observed | undefined } | undefined;
  private stopped = false;
  private readonly retryTenant: ReturnType<Register> | undefined;
  private stopping: Promise<void> | undefined;

  private readonly messages: MessageState;
  private readonly incoming: IncomingDelivery;
  private readonly picking: PickerFlow;

  constructor(private readonly options: BridgeOptions) {
    this.messages = new MessageState({
      messenger: options.messenger,
      allowlist: options.allowlist,
      clock: options.clock,
      holder: options.holder,
      stopped: () => this.stopped,
      changed: () => this.armRetries(),
      log: (line) => this.log(line)
    });
    this.incoming = new IncomingDelivery({
      messages: this.messages,
      verbs: options.verbs,
      board: () => this.board,
      stopped: () => this.stopped,
      clock: options.clock
    });
    this.picking = new PickerFlow({
      messages: this.messages,
      incoming: this.incoming,
      messenger: options.messenger,
      claims: async () => (options.claims ? await options.claims() : this.claims),
      verbs: options.verbs,
      clock: options.clock,
      settle: (record, word) => this.settlePickers(record, word),
      put: (record, notice) => this.put(record, notice),
      putActionNotice: (record, notice, over, place) =>
        this.putActionNotice(record, notice, over, place),
      start: (record, message, input) =>
        this.startAttempt(() => this.incoming.start(record, message, input)),
      begun: (started, windowId, cwd, label) => this.begun(started, windowId, cwd, label),
      stopped: () => this.stopped
    });
    this.catchUp = new CatchUp({
      backlog: options.messenger.backlog,
      anchors: () => this.messages.records.filter((r) => r.state === 'live').map((r) => r.anchor),
      admit: (event) => this.messages.admit(event),
      serial: (step) => void this.serial(step),
      replay: (events) => this.replay(events),
      seen: () => this.messages.keptIds(),
      log: (line) => this.log(line)
    });
    this.retryTenant = options.register?.('remote retries', () => {
      this.retryDue(this.now());
      this.armRetries();
      return Promise.resolve();
    });
    const carried = options.observed;
    if (carried) {
      this.board = carried.board;
      this.compared = carried.baseline ?? carried.board;
      this.claims = carried.claims;
      this.starting = [...carried.starting];
      this.ending = [...(carried.ending ?? [])];
      this.observed = true;
    }
  }

  /**
   * What this engine has observed, for `BridgeOptions.observed`, as of the
   * last pass whose every edge was posted or tried: a pass a stop cut short
   * hands over what it began from, so the engine after it derives those
   * notices again. Nothing before a first pass.
   */
  observation(): Observed | undefined {
    if (this.passing) return this.passing.from;
    return this.observed ? this.seen() : undefined;
  }

  incomingHolder(): import('./model').IncomingHolder | undefined {
    return this.messages.access.incomingHolder();
  }

  accessSnapshot(conversation: string, correlation: string): access.AccessProjection | undefined {
    return this.messages.access.snapshot(conversation, correlation);
  }

  onIncomingChanged(listener: () => void): () => void {
    return this.messages.access.onChanged(listener);
  }

  resolveIncomingReceiver(
    expected: access.AccessExpectation,
    evidence: import('./model').IncomingEvidence
  ): Promise<access.ReceiverResolution> {
    return this.messages.access.resolve(expected, evidence);
  }

  closeIncoming(
    conversation: string,
    correlation: string,
    reason: import('./model').IncomingRefusal = 'closed'
  ): Promise<boolean> {
    return this.messages.access.close(conversation, correlation, reason);
  }

  observeIncomingPolicy(
    current: access.IncomingPolicy,
    holder: import('./model').IncomingHolder
  ): Promise<boolean> {
    return this.messages.access.observe(current, holder);
  }

  recoverIncoming(conversation?: string, correlation?: string): Promise<void> {
    return this.incoming.recover(conversation, correlation);
  }

  retryIncomingWrites(): Promise<boolean> {
    if (!this.messages.access.needsRetry()) return Promise.resolve(true);
    return this.messages.access.retry();
  }

  housekeep(
    table: Pick<import('../scan').ProcessTable, 'starts' | 'complete' | 'startSource'>
  ): Promise<void> {
    return this.messages.housekeep(table);
  }

  private seen(): Observed {
    return {
      board: this.board,
      claims: this.claims,
      starting: [...this.starting],
      ending: [...this.ending],
      ...(this.compared === this.board ? {} : { baseline: this.compared })
    };
  }

  /** Reads this messenger's conversations from the store, and arms the
   *  retries a reload carries: their deadlines are on the records. */
  async load(): Promise<void> {
    await this.serial(async () => {
      await this.messages.load((record) => this.picking.recover(record));
      const seen = await this.catchUp.load(this.options.fresh === true, this.now());
      if (seen) {
        this.messages.restoreSeen(seen);
      }
    });
    this.armRetries();
  }

  /** Opens the connection: from here inbound events are routed, each against
   *  the board the last `observe` saw. */
  connect(): void {
    if (this.stopped) return;
    const connection = this.options.messenger.connect((event) => this.queue(event));
    this.connection = connection;
    connection.onState((state) => {
      for (const listener of [...this.listeners]) listener(state);
      this.linked(state);
    });
    this.linked(connection.state);
    const admitted = this.messages.admittedEvents();
    if (admitted.length > 0) void this.serial(() => this.replay(admitted));
  }

  /** A link coming back retries reactions at once and reads what was sent
   *  while it was down. */
  private linked(state: LinkState): void {
    const was = this.linkKind;
    this.linkKind = state.kind;
    if (state.kind !== 'connected' || was === 'connected' || this.stopped) return;
    this.messages.reactions.tick(this.now(), true);
    this.catchUp.returned();
  }

  /**
   * Admitted events routed in order as one batch: a catch-up's find, or what
   * a stopped engine left admitted. Late messages get one reply per place.
   * A batch cut short leaves its unreached messages admitted, and the next
   * engine replays them as a batch of their own.
   */
  private async replay(events: readonly Inbound[]): Promise<void> {
    const late: LateReplies = { places: new Set(), owed: [] };
    for (const event of events) {
      if (this.stopped) return;
      await this.routeOne(event, late);
    }
    await this.answerLate(late);
  }

  /** Posts the late replies a batch owes, in order, unless a stop came first:
   *  then each stays admitted for the next engine. */
  private async answerLate(late: LateReplies): Promise<void> {
    for (const reply of late.owed.splice(0)) {
      if (this.stopped) return;
      await reply();
    }
  }

  /**
   * One inbound event, routed and acted on. A message moves the watermark to
   * its `at`, and the watermark is kept with the ids now seen before it acts,
   * so a crash mid-act loses it rather than acting twice. In a batch, a place's
   * first late message is answered once the batch's other late messages there
   * are finished, so a cut between the two leaves the reply's own message
   * admitted rather than a sibling, which would be answered again.
   */
  private async routeOne(event: Inbound, late?: LateReplies): Promise<void> {
    const tracked = event.kind === 'message' ? this.messages.tracked(event.id) : undefined;
    if (tracked && (tracked.message.delivery !== 'admitted' || !(await tracked.saved))) return;
    if (tracked?.message.event) event = tracked.message.event;
    if (tracked && event.kind === 'message' && !allowed(event.sender, this.options.allowlist)) {
      await this.closeIncoming(tracked.record.id, tracked.message.correlation, 'admission-denied');
      await this.messages.finish(tracked.record, tracked.message);
      return;
    }
    if (event.kind === 'message') this.catchUp.routed(event.at);
    const routed = tracked
      ? await routeAdmitted(event, this.context())
      : await route(event, this.context());
    if (event.kind !== 'message') this.messages.routed(event.id);
    if (event.kind === 'message') await this.catchUp.keep();
    if (late && routed.kind === 'refuse' && routed.reason === 'late') {
      const place = routed.place.under;
      if (!late.places.has(place)) {
        late.places.add(place);
        late.owed.push(() => this.actOn(event, routed, tracked));
        return;
      }
      await this.closeRouted(routed, tracked);
      this.cutShort(event);
      return;
    }
    if (late) await this.answerLate(late);
    await this.actOn(event, routed, tracked);
  }

  private async actOn(
    event: Inbound,
    routed: Routed,
    tracked: ReturnType<MessageState['tracked']>
  ): Promise<void> {
    await this.act(routed, tracked?.message);
    await this.closeRouted(routed, tracked);
    this.cutShort(event);
  }

  /** Finishes a tracked message whose route ends here; a reply, fresh or job
   *  is finished by its delivery. */
  private async closeRouted(
    routed: Routed,
    tracked: ReturnType<MessageState['tracked']>
  ): Promise<void> {
    if (!tracked || ['reply', 'fresh', 'job'].includes(routed.kind)) return;
    await this.closeIncoming(tracked.record.id, tracked.message.correlation, 'closed');
    await this.messages.finish(tracked.record, tracked.message);
  }

  /** A stop that landed while `event` was routed may have kept it from
   *  acting, and the watermark is past it: said, since it is not read again. */
  private cutShort(event: Inbound): void {
    if (this.stopped) this.log(`Remote: a stop may have cut short a ${event.kind} (${event.id})`);
  }

  /**
   * Closes the messenger and stops posts, starts and routing actions. Every
   * routing port call checks first, so a pass in flight
   * that resumes now finishes having done nothing more, and a messenger call
   * it waits on is abandoned, connected or not yet. Resolves once that pass
   * has drained; the holder is released after it, or a second window could
   * load the store while this one still writes. Permission closures and pending
   * writes drain before release. The store stays.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.retryTenant?.dispose();
    const closures = this.messages.haltAccess();
    for (const controller of this.reading) controller.abort();
    this.catchUp.stop();
    this.connection?.close();
    this.options.messenger.close();
    const effects = this.messages.reactions.stop();
    this.stopping = Promise.all([this.chain, effects, closures]).then(async () => {
      await this.messages.drain();
    });
    return this.stopping;
  }

  link(): LinkState {
    return this.connection?.state ?? { kind: 'connecting' };
  }

  onLink(listener: (state: LinkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One pass over the board: the notice policy's edges between the last
   * observation and this one, posted. The first pass compares against nothing,
   * so a request already open posts and no finish does (U2), and a stored
   * notice whose request closed while Remote was off settles.
   *
   * A root this engine started is the exception to "a first observation is a
   * baseline": it is compared with the session as it began, busy on its first
   * turn, so a turn that ended inside the host's coalescing window still posts
   * its finish — a short answer to a phone's job otherwise never would.
   */
  observe(board: readonly Watched[], windows: readonly WindowClaim[]): Promise<void> {
    void this.retryIncomingWrites();
    void this.recoverIncoming();
    this.messages.reconcile(board);
    this.messages.reactions.tick(this.now());
    return this.serial(async () => {
      if (this.stopped) return;
      const first = !this.observed;
      this.passing = { from: first ? undefined : this.seen() };
      this.observed = true;
      try {
        const begun = this.starting.flatMap((s) => {
          const now = onBoard(board, s.addr);
          return now === undefined ? [] : [asBegun(now)];
        });
        const previous = [...this.compared, ...begun];
        this.board = board;
        this.compared = board;
        this.claims = windows;
        this.starting = this.starting.filter((s) => onBoard(board, s.addr) === undefined);
        await this.followRoots(board);
        const away = first ? closedWhileAway(board, this.messages.records) : [];
        const edges = noticeEdges(previous, board, this.messages.records, { ending: this.ending });
        this.ending = this.ending.filter((a) => onBoard(board, a) !== undefined);
        const owed: Watched[] = [];
        for (const edge of [...away, ...edges]) {
          if (!(await this.edge(edge)) && edge.kind !== 'settle') owed.push(edge.target);
        }
        this.owe(owed, previous);
      } finally {
        if (!this.stopped) this.passing = undefined;
      }
    });
  }

  /** Settles the held prompts whose ten minutes are up (D39), and ends the
   *  remote-spawned sessions whose cache has gone cold (U6, amended). */
  tick(now: number): Promise<void> {
    void this.retryIncomingWrites();
    this.messages.reactions.tick(now);
    return this.serial(async () => {
      if (this.stopped) return;
      await this.picking.tick(now);
      const due = this.lapses();
      for (const memo of [this.retries, this.delivered]) {
        for (const key of memo.keys()) {
          if (!this.board.some((w) => keyOf(w.session) === key)) memo.delete(key);
        }
      }
      for (const lapse of due) {
        if (this.lapseAt(lapse) <= now) await this.lapse(lapse, now);
      }
    });
  }

  private retryDue(now: number): void {
    void this.retryIncomingWrites();
    this.messages.reactions.tick(now);
  }

  private armRetries(): void {
    if (!this.stopped) this.retryTenant?.schedule(this.retryDeadline());
  }

  /** When a reaction or an incoming write is next due to be tried again. */
  private retryDeadline(): number | undefined {
    const reaction = this.messages.reactions.nextDeadline();
    const incoming = this.messages.access.needsRetry()
      ? this.now() + status.REACTION_RETRY_MS
      : undefined;
    return reaction === undefined
      ? incoming
      : incoming === undefined
        ? reaction
        : Math.min(reaction, incoming);
  }

  /** The earliest held prompt's expiry or lifetime's end, for the routing
   *  pass's Reconciler registration. Retries have their own (`register`). */
  nextDeadline(): number | undefined {
    const times = this.lapses().map((lapse) => this.lapseAt(lapse));
    const selection = this.picking.nextDeadline(OWED_RETRY_MS);
    if (selection !== undefined) times.push(selection);
    if (this.owedAt !== undefined) times.push(this.owedAt + OWED_RETRY_MS);
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /** Keeps each owed session's earlier entry for the next comparison. A
   *  session the earlier board did not hold is left out of it, so its open
   *  requests read as new again; one the board no longer holds keeps it, so
   *  its close reads as new again. */
  private owe(owed: readonly Watched[], previous: readonly Watched[]): void {
    this.owedAt = owed.length === 0 ? undefined : this.now();
    if (owed.length === 0) return;
    const key = (w: Watched) => addrOf(w);
    const isOwed = (w: Watched) => owed.some((o) => sameAddr(key(o), key(w)));
    const gone = owed.filter((o) => onBoard(this.board, key(o)) === undefined);
    this.compared = [
      ...this.board.flatMap((w) =>
        isOwed(w) ? previous.filter((p) => sameAddr(key(p), key(w))).slice(0, 1) : [w]
      ),
      ...gone
    ];
  }

  /**
   * An agent's file, into its root's conversation. A root with none has one
   * opened by a short notice first, as any first notice opens one (R3). The
   * file post is not a notice: nothing settles it. A failed send is the
   * refusal's reason and is not retried.
   */
  attach(addr: SessionAddr, attachment: Attachment): Promise<Attached> {
    return this.serial(() => this.attachNow(addr, attachment));
  }

  /** An event the engine stopped before reaching is acked already and never
   *  comes again, so its drop is logged — by kind and id, never its words. */
  private queue(event: Inbound): void {
    if (!this.messages.admit(event)) return;
    this.cancelIncomingPicker(event);
    void this.serial(async () => {
      if (this.stopped) {
        this.log(
          `Remote: dropped a ${event.kind} (${event.id}) that arrived as the engine stopped`
        );
        return;
      }
      await this.routeOne(event);
    });
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.chain.then(step);
    this.chain = next.catch((err: unknown) => this.log(`Remote: ${message(err)}`));
    return next;
  }

  private lapses(): Lapse[] {
    return lapses(this.messages.records, this.board, this.ending);
  }

  /** A lifetime's end, or later: the retry a refusal set, or a lifetime
   *  after a reply the board has not caught up with. */
  private lapseAt(lapse: Lapse): number {
    const key = keyOf(lapse.root.session);
    const replied = this.delivered.get(key);
    return Math.max(
      lapse.at,
      this.retries.get(key) ?? lapse.at,
      replied === undefined ? lapse.at : replied + lapse.retryMs
    );
  }

  /** Ends a cold family, and says so in its conversation; a refusal says
   *  why the first time and is tried again a lifetime later. */
  private async lapse(lapse: Lapse, now: number): Promise<void> {
    const to = addrOf(lapse.root);
    const key = keyOf(lapse.root.session);
    const ended: Ended = await this.attempt(() => this.endTogether(to, lapse.members));
    if (ended.ok || !(ended.left ?? [to]).some((a) => sameAddr(a, to))) {
      this.retries.delete(key);
      const here: Destination = {
        conversation: { existing: lapse.record },
        role: 'root',
        root: lapse.root.label
      };
      await this.put(lapse.record, words.lapsedNotice(whoOf(lapse.root, here)));
      return;
    }
    this.log(`Remote: pid ${to.pid} was not ended at its cache lifetime: ${ended.reason}`);
    const first = !this.retries.has(key);
    this.retries.set(key, now + lapse.retryMs);
    if (first) await this.put(lapse.record, words.refusalNotice(ended.reason));
  }

  private context(): RouteContext {
    const resolve = this.options.resolve ?? checkoutRoots;
    return {
      allowlist: this.options.allowlist,
      deduper: this.messages.deduper,
      now: this.now(),
      store: this.messages.records,
      board: this.board,
      starting: this.starting.filter((s) => this.now() - s.since < STARTING_MS).map((s) => s.addr),
      ending: this.ending,
      claims: this.claims,
      windowFor: (cwd) => freshWindow(this.claims, cwd, resolve)
    };
  }

  private async act(routed: Routed, message?: MessageRecord): Promise<void> {
    switch (routed.kind) {
      case 'drop':
        return;
      case 'reply':
        return this.reply(routed, message);
      case 'fresh':
        return this.fresh(routed, message);
      case 'job':
        return this.job(routed, message);
      case 'pick':
        return this.picking.pick(routed);
      case 'choose':
        return this.picking.choose(routed);
      case 'stop':
        return this.settleWith(
          routed,
          () => this.options.verbs.interrupt(routed.to),
          (stopped: Stopped) => (stopped.ok && stopped.idle ? words.NOTHING_TO_STOP : words.STOPPED)
        );
      case 'deny': {
        const reason = routed.reason ? words.DENY_REASON : undefined;
        const deny = () => this.options.verbs.deny(routed.to, routed.requestId, reason);
        return this.settleWith(routed, deny, words.DENIED);
      }
      case 'end':
        return this.confirmEnd(routed);
      case 'end-confirmed':
        return this.settleWith(
          routed,
          () => this.endTogether(routed.to, routed.members),
          words.ENDED
        );
      case 'cancel':
        return this.settleWith(routed, () => Promise.resolve({ ok: true }), words.CANCELLED);
      case 'stale':
        return this.settleWith(routed, () => Promise.resolve({ ok: true }), routed.word);
      case 'list':
        return this.list(routed.sender);
      case 'help':
        return this.postAt({ home: routed.sender }, words.helpNotice(routed.text));
      case 'orphan':
        return this.postAt(routed.place, words.orphanNotice);
      case 'refuse':
        return this.postAt(routed.place, routed.notice);
    }
  }

  /** Typed text to the root (D17, D20). A held one gets the receipt with
   *  Stop; a refused one says why. */
  private async reply(
    routed: Extract<Routed, { kind: 'reply' }>,
    message?: MessageRecord
  ): Promise<void> {
    const record = this.messages.find(routed.conversation);
    if (record === undefined) return;
    const thread = await this.rereadJoined(record, message);
    const delivery = await this.incoming.prepare(record, message, routed.to);
    if (delivery === false) return;
    if (!(await this.messages.attempt(record, message, routed.to))) return;
    await this.answered(record);
    const { verbs } = this.options;
    const text = this.incoming.withIncoming(
      thread ? withRefresh(routed.text, record, thread) : routed.text,
      record,
      message,
      record.root?.brand
    );
    const act = await this.deliveryAttempt(() =>
      routed.verb === 'answer' && routed.requestId !== undefined
        ? verbs.answer(routed.to, routed.requestId, text, message?.correlation, delivery)
        : verbs.send(routed.to, text, message?.correlation, delivery)
    );
    if (!act.ok) {
      if (!('unsure' in act && act.unsure)) {
        if (message) await this.closeIncoming(record.id, message.correlation, 'closed');
        await this.messages.finish(record, message);
      }
      await this.put(record, words.refusalNotice(act.reason));
      return;
    }
    if (delivery) await this.recoverIncoming(record.id, message?.correlation);
    if (thread) {
      record.threadRead = thread.total + 1;
      await this.messages.save(record);
    }
    if (message && act.messageFacts) this.messages.applyFacts(record, message, act.messageFacts);
    this.delivered.set(keyOf(routed.to), this.now());
    if ((act.queued ?? 0) === 0) return;
    const notice = words.heldReceipt(routed.label, routed.because);
    notice.body = this.incoming.withIncoming(notice.body, record, message, record.root?.brand);
    await this.putActionNotice(record, notice, { target: routed.to });
  }

  /** D23: the root has ended, so a fresh session takes the reply, pointed at
   *  the ended one's record. */
  private async fresh(
    routed: Extract<Routed, { kind: 'fresh' }>,
    message?: MessageRecord
  ): Promise<void> {
    const record = this.messages.find(routed.conversation);
    if (record === undefined) return;
    await this.answered(record);
    await this.put(record, words.endedNotice(routed.cwd, record.owner));
    const thread = await this.rereadJoined(record, message);
    if (!(await this.messages.attempt(record, message))) return;
    const pointer = routed.past === '' ? undefined : recordFile(routed.past);
    const prompt = freshPrompt(routed.text, pointer);
    const started = await this.startAttempt(() =>
      this.incoming.start(record, message, {
        windowId: routed.windowId,
        cwd: routed.cwd,
        // The whole thread, not what is new: this session has read none of it.
        prompt: thread ? threadPrompt(prompt, thread.file, thread.lines) : prompt,
        brand: routed.brand,
        ...(message ? { correlation: message.correlation } : {})
      })
    );
    if (!started.ok) {
      if (started.outcome === 'stopped') {
        if (message) await this.closeIncoming(record.id, message.correlation, 'closed');
        await this.messages.finish(record, message);
      }
      await this.put(record, words.refusalNotice(started.reason));
      return;
    }
    if (message?.access?.attempt) await this.recoverIncoming(record.id, message.correlation);
    if (
      this.stopped ||
      (message?.access?.attempt && record.rootCorrelation !== message.correlation)
    )
      return;
    const past = record.root?.sessionId;
    if (past && !record.past.includes(past)) record.past.push(past);
    const label = record.root?.label ?? path.basename(routed.cwd);
    record.root = this.begun(started, routed.windowId, routed.cwd, label);
    if (thread) record.threadRead = thread.total + 1;
    if (message)
      message.target = {
        pid: started.pid,
        startedAt: started.startedAt,
        windowId: routed.windowId
      };
    await this.messages.save(record);
  }

  /** A new job (D24): refused, started, or held for a pick. */
  private async job(
    routed: Extract<Routed, { kind: 'job' }>,
    message?: MessageRecord
  ): Promise<void> {
    const { job, place, sender } = routed;
    if (job.kind === 'refuse') {
      const admission = message && this.messages.tracked(message.id);
      if (admission && message) {
        await this.closeIncoming(admission.record.id, message.correlation, 'closed');
        await this.messages.finish(admission.record, message);
      }
      await this.postAt(place, words.noFolderNotice);
      return;
    }
    const folders = job.kind === 'start' ? [job.folder] : job.folders;
    const record =
      (message && this.messages.tracked(message.id)?.record) || this.messages.mint(sender, {});
    // Read and written before the held prompt is saved, so a reload never
    // finds a pointer at a file that is not there.
    const thread =
      routed.joined && message ? await this.readJoined(record, message.ref) : undefined;
    if (routed.joined) record.joined = true;
    if (thread?.ok) record.threadRead = thread.total + 1;
    record.state = 'held';
    record.held = {
      prompt: thread?.ok ? threadPrompt(routed.text, thread.file, thread.lines) : routed.text,
      folders: folders.map((f) => f.folder),
      expiresAt: job.kind === 'hold' ? job.expiresAt : this.now() + HELD_MS,
      picker: picker.initial(place, job.kind === 'start' ? job.folder : undefined),
      ...(thread && !thread.ok ? { threadUnread: thread.reason } : {})
    };
    if (message) {
      record.held.correlation = message.correlation;
      message.delivery = 'held';
      delete message.event;
      this.messages.reactions.desire(message, 'queued');
    }
    if (record.schema !== 3) record.schema = 2;
    if (!this.messages.records.includes(record)) this.messages.keep(record);
    if (!(await this.messages.save(record))) return;
    await this.picking.present(record, job.kind === 'start' ? job.folder : undefined);
  }

  /**
   * A joined thread up to `before`, read and written to its file: the path,
   * how many messages it holds and how many the read saw, or why not. Nothing
   * for a messenger that cannot read one. A failed write keeps the file a read
   * before it wrote.
   */
  private async readJoined(record: ConversationRecord, before: MessageRef): Promise<JoinedRead> {
    const read = await this.readThread(record.anchor, before);
    if (read === undefined || !read.ok) return read;
    const file = await writeThread(record.id, renderThread(read.lines, read.truncated));
    if (file === undefined) {
      this.log(`Remote: the thread of conversation ${record.id} was not written.`);
      return { ok: false, reason: 'unreachable' };
    }
    return { ok: true, file, lines: read.lines.length, total: read.total };
  }

  /** A later mention in a joined conversation: the thread read again up to
   *  it. Nothing when it is not joined or the read failed, which leaves the
   *  file as the last read wrote it. */
  private async rereadJoined(
    record: ConversationRecord,
    message: MessageRecord | undefined
  ): Promise<Extract<JoinedRead, { ok: true }> | undefined> {
    if (!record.joined || message === undefined) return undefined;
    const read = await this.readJoined(record, message.ref);
    return read?.ok ? read : undefined;
  }

  /**
   * The messenger's read, bounded by `THREAD_READ_MS` and abandoned by `stop`
   * whether or not the messenger heeds its signal: the chain waits on it.
   */
  private async readThread(
    anchor: MessageRef,
    before: MessageRef
  ): Promise<ThreadRead | undefined> {
    const thread = this.options.messenger.thread;
    if (thread === undefined || this.stopped) return undefined;
    const controller = new AbortController();
    this.reading.add(controller);
    const timer = setTimeout(() => controller.abort(), THREAD_READ_MS);
    const abandoned = new Promise<ThreadRead>((resolve) =>
      controller.signal.addEventListener(
        'abort',
        () => resolve({ ok: false, reason: 'unreachable' }),
        { once: true }
      )
    );
    try {
      return await Promise.race([thread.read(anchor, before, controller.signal), abandoned]);
    } catch {
      return { ok: false, reason: 'unreachable' };
    } finally {
      clearTimeout(timer);
      this.reading.delete(controller);
    }
  }

  /**
   * Ends `to` with exactly `members` — a confirmed End, or a lifetime's —
   * counted as ending only while it runs and after for those it took down,
   * so none of their exits posts a stop. A member it left running (all of
   * them, when it threw) is dropped again: its later exit is a crash, and said.
   */
  private async endTogether(to: SessionAddr, members: readonly SessionAddr[]): Promise<Ended> {
    const all = [to, ...members];
    this.ending.push(...all);
    let ended: Ended | undefined;
    try {
      ended = await this.options.verbs.end(to, members);
      return ended;
    } finally {
      const left = ended === undefined ? all : ended.ok ? [] : (ended.left ?? all);
      // One entry for each this end added: a lifetime end may hold the same
      // session, and a stale confirm refused must not clear its count.
      for (const one of left) {
        const at = this.ending.findIndex((a) => sameAddr(one, a));
        if (at !== -1) this.ending.splice(at, 1);
      }
    }
  }

  /** End asks once (D21). From a button the confirm goes in that button's
   *  conversation; from `end <pid>` it opens one at the sender's home. */
  private async confirmEnd(routed: Extract<Routed, { kind: 'end' }>): Promise<void> {
    const existing =
      routed.conversation === undefined ? undefined : this.messages.find(routed.conversation);
    if (existing) await this.answered(existing);
    const record = existing ?? this.messages.mint(routed.sender, {});
    await this.putActionNotice(record, words.confirmEnd(routed.label, routed.members), {
      target: routed.to,
      members: [...routed.members]
    });
  }

  /** A button's verb, and the notice settled with its word — or, for a verb
   *  whose success has two outcomes, the word its answer picks; with its
   *  reason when it refuses. */
  private async settleWith<T extends Act | Stopped | Ended>(
    at: { conversation: string; notice: string },
    verb: () => Promise<T>,
    word: string | ((done: T) => string)
  ): Promise<void> {
    const record = this.messages.find(at.conversation);
    const notice = record?.notices.find((n) => n.id === at.notice);
    if (record === undefined || notice === undefined) return;
    await this.answered(record);
    const act = await this.attempt(verb);
    if (!act.ok) return this.settle(record, notice, act.reason);
    await this.settle(record, notice, typeof word === 'string' ? word : word(act));
  }

  /** Running sessions only: an exited card stays drawn until dismissed, and
   *  `end` refuses its pid. Every value and the clock are read before the
   *  first link lookup, so the list is one moment however long those take. */
  private async list(sender: SenderId): Promise<void> {
    const at = this.now();
    const links = this.options.messenger.links;
    const taken = this.board
      .filter((w) => w.exit === undefined)
      .map((w) => {
        const to = conversationFor(w, this.board, this.messages.records);
        const where = w.session.repoRoot ?? w.session.cwd;
        const row: words.ListRow = {
          label: w.label,
          pid: w.session.pid,
          status: w.session.status,
          repo: path.basename(where) || where,
          updatedAt: w.session.updatedAt,
          ...(w.session.warm === undefined ? {} : { warm: w.session.warm })
        };
        return {
          row,
          anchor: 'existing' in to.conversation ? to.conversation.existing.anchor : undefined
        };
      });
    const rows = await Promise.all(
      taken.map(async ({ row, anchor }) => {
        const link =
          links && anchor !== undefined ? await links.to(anchor).catch(() => undefined) : undefined;
        return link === undefined ? row : { ...row, link };
      })
    );
    await this.postAt({ home: sender }, words.listNotice(rows, at, this.options.label));
  }

  /** One notice-policy edge, posted or settled. A root with no conversation
   *  has one opened by this post; the next edge for it in the same pass finds
   *  it kept. False when its notice failed to post, so the edge is owed. */
  private async edge(edge: NoticeEdge): Promise<boolean> {
    if (edge.kind === 'settle') {
      await this.settle(edge.conversation, edge.notice, words.NO_LONGER_WAITING);
      return true;
    }
    const record = this.destination(edge.to);
    const who = whoOf(edge.target, edge.to);
    const target = addrOf(edge.target);
    if (edge.kind === 'waiting') {
      const notice = words.waitingNotice(who, edge.request, record.owner);
      const sent = await this.putActionNotice(record, notice, {
        target,
        requestId: edge.request.requestId
      });
      return sent.ok;
    }
    if (edge.kind === 'stopped' || edge.kind === 'closed') {
      const [id = ''] = this.ids(record, 1);
      const notice =
        edge.kind === 'stopped' ? words.stoppedNotice(who, record.owner) : words.closedNotice(who);
      const answered = edge.kind === 'stopped' ? { answered: edge.answered } : {};
      const sent = await this.put(record, notice, {
        id,
        kind: notice.kind,
        target,
        ...answered,
        actions: []
      });
      // Its end emptied the outbox: a held reply's Stop has nothing to stop.
      const held = record.notices.filter(
        (n) =>
          n.kind === 'receipt' &&
          n.settled === undefined &&
          n.target !== undefined &&
          sameAddr(n.target, target)
      );
      for (const receipt of held) await this.settle(record, receipt, words.NOT_DELIVERED);
      return sent.ok;
    }
    const reply = await this.attempt(() => this.options.verbs.lastReply(target)).then((r) =>
      typeof r === 'string' ? r : undefined
    );
    const notice =
      edge.kind === 'finished'
        ? words.finishedNotice(who, reply ?? '', record.owner)
        : words.failedNotice(who, reply, record.owner);
    const [id = ''] = this.ids(record, 1);
    const answered = edge.answered === undefined ? {} : { answered: edge.answered };
    const sent = await this.put(record, notice, {
      id,
      kind: notice.kind,
      target,
      ...answered,
      actions: []
    });
    return sent.ok;
  }

  private async attachNow(addr: SessionAddr, attachment: Attachment): Promise<Attached> {
    if (this.stopped) return { ok: false, reason: words.REMOTE_OFF };
    const files = this.options.messenger.files;
    if (files === undefined) return { ok: false, reason: words.NO_FILES };
    if (attachment.bytes.length > files.maxBytes) {
      return {
        ok: false,
        reason: words.tooLarge(this.options.label ?? 'the messenger', files.maxBytes)
      };
    }
    const target = onBoard(this.board, addr);
    if (target === undefined) return { ok: false, reason: words.NOT_ON_BOARD };
    // An exited card stays on the board. Same refusal as findTarget, sampled
    // before either post: a send already started keeps the outcome it has.
    if (target.exit) return { ok: false, reason: words.SESSION_ENDED };
    const to = conversationFor(target, this.board, this.messages.records);
    const record = this.destination(to);
    if (!this.messages.records.includes(record)) {
      const [id = ''] = this.ids(record, 1);
      const opened = await this.put(record, words.attachedNotice(whoOf(target, to), record.owner), {
        id,
        kind: 'attached',
        target: addr,
        actions: []
      });
      if (!opened.ok) return opened;
    }
    const head = to.role === 'child' ? words.spawnedHead(target.label, to.root) : undefined;
    const caption = [head, attachment.caption].filter((part) => part !== undefined && part !== '');
    const sent: Attachment = {
      ...attachment,
      ...(head === undefined ? {} : { head }),
      ...(caption.length === 0 ? {} : { caption: caption.join('\n\n') })
    };
    try {
      if (this.stopped) return { ok: false, reason: words.REMOTE_OFF };
      const posted = await files.send(placeOf(record), sent);
      track(record, posted);
      await this.messages.save(record);
      return { ok: true };
    } catch (err) {
      return err instanceof MaybePosted
        ? { ok: false, reason: message(err), unsure: true }
        : { ok: false, reason: message(err) };
    }
  }

  private async putActionNotice(
    record: ConversationRecord,
    notice: ActionNotice,
    metadata: Pick<NoticeRecord, 'target' | 'requestId' | 'members'>,
    place?: Place
  ): Promise<{ ok: true; posted: Posted } | Failed> {
    const { buttons, ...content } = notice;
    const [id = '', ...ids] = this.ids(record, (buttons?.length ?? 0) + 1);
    const actions: ButtonAction[] = [];
    const encoded = buttons?.map(({ action, ...button }, index) => {
      const actionId = ids[index] ?? '';
      actions.push({ ...action, id: actionId });
      return { ...button, payload: this.payload(record, actionId) };
    });
    return this.put(
      record,
      { ...content, ...(encoded === undefined ? {} : { buttons: encoded }) },
      { ...metadata, id, kind: notice.kind, actions },
      place
    );
  }

  /**
   * Post a notice and record it. A record not kept yet is opened by this post
   * — at its owner's home unless a place is given — and kept only once the
   * post lands, so a failed post leaves the store as it was. `entry` makes the
   * post a notice the store answers for; a refusal or a word is just a post.
   */
  private async put(
    record: ConversationRecord,
    notice: Notice,
    entry?: Omit<NoticeRecord, 'message' | 'postedAt' | 'notice'>,
    place?: Place
  ): Promise<{ ok: true; posted: Posted } | Failed> {
    const kept = this.messages.records.includes(record);
    const where = place ?? (kept ? placeOf(record) : { home: record.owner });
    const sent = await this.attempt(() => this.options.messenger.post(where, notice));
    if ('ok' in sent) {
      if (!this.stopped) this.log(`Remote: a ${notice.kind} notice was not posted: ${sent.reason}`);
      return sent;
    }
    if (record.anchor === '') record.anchor = sent.anchor;
    if (!kept) {
      record.anchor = sent.anchor;
      this.messages.keep(record);
    }
    track(record, sent);
    if (entry) {
      record.notices.push({
        ...entry,
        message: sent.message,
        postedAt: this.now(),
        ...(settleable(notice) ? { notice } : {})
      });
    }
    if (!(await this.messages.save(record))) {
      if (entry?.actions.some((action) => action.verb === 'choose')) {
        record.notices.pop();
        return { ok: false, reason: 'The posted choice could not be saved.' };
      }
    }
    return { ok: true, posted: sent };
  }

  /** A post with no conversation to record it in, unless its place names one
   *  the store keeps, whose refs then take it. */
  private async postAt(place: Place, notice: Notice): Promise<void> {
    const record =
      'conversation' in place
        ? this.messages.records.find((r) => r.anchor === place.conversation.anchor)
        : undefined;
    if (record) {
      await this.put(record, notice);
      return;
    }
    const sent = await this.attempt(() => this.options.messenger.post(place, notice));
    if ('ok' in sent && !this.stopped) {
      this.log(`Remote: a ${notice.kind} notice was not posted: ${sent.reason}`);
    }
  }

  /**
   * Replace a notice's buttons with a word (D14: never its text). The store
   * marks it settled whether or not the messenger took the edit, so a second
   * press reads the word. Without `edit`, the word is a follow-up post.
   */
  private async settle(
    record: ConversationRecord,
    notice: NoticeRecord,
    word: string
  ): Promise<void> {
    notice.settled = word;
    const edit = this.options.messenger.edit;
    const shown = notice.notice;
    if (edit && shown) {
      if (this.stopped) return;
      const settled = { ...shown, buttons: [], settled: word };
      await edit.settle(notice.message, settled).then(
        () => {
          notice.notice = settled;
        },
        (err: unknown) => this.log(`Remote: a notice was not settled: ${message(err)}`)
      );
      await this.messages.save(record);
      return;
    }
    const followUp: Notice = {
      kind: notice.kind,
      ...(shown?.head === undefined ? {} : { head: shown.head }),
      body: word
    };
    const posted = await this.put(record, followUp);
    if (!posted.ok) await this.messages.save(record);
  }

  private async settlePickers(record: ConversationRecord, word: string): Promise<void> {
    const open = record.notices.filter((n) => n.kind === 'picker' && n.settled === undefined);
    for (const notice of open) await this.settle(record, notice, word);
    await this.messages.save(record);
  }

  /** The first reply or press after a notice answers it: the PRD's first-goal
   *  metric, notice to answer, comes out of these two stamps. */
  private async answered(record: ConversationRecord): Promise<void> {
    const now = this.now();
    const open = record.notices.filter((n) => n.answeredAt === undefined);
    for (const notice of open) notice.answeredAt = now;
    if (open.length > 0) await this.messages.save(record);
  }

  /** The record a notice goes in: the one the policy found, or one minted for
   *  a root with none — found again once kept, so one pass opens it once. */
  private destination(to: Destination): ConversationRecord {
    if ('existing' in to.conversation) return to.conversation.existing;
    const root = to.conversation.open;
    return (
      conversationOfRoot(this.messages.records, root.session) ??
      this.messages.mint(this.home(), { root: rootOfWatched(root) })
    );
  }

  /** A root just started, live until a board shows it (`STARTING_MS`). */
  private begun(
    started: Extract<Started, { ok: true }>,
    windowId: string,
    cwd: string,
    label: string
  ): ConversationRoot {
    const addr = { pid: started.pid, startedAt: started.startedAt, windowId };
    this.starting.push({ addr, since: this.now() });
    return rootOf(started, cwd, label);
  }

  /** Keeps each root's sessionId, label and brand current. A sessionId that
   *  moved (`/clear`) goes to `past`, where a child stamped with it still finds
   *  its family (D16). */
  private async followRoots(board: readonly Watched[]): Promise<void> {
    for (const record of this.messages.records) {
      const root = record.root;
      const live = root && onBoard(board, root);
      if (root === undefined || live === undefined) continue;
      const next = rootOfWatched(live, root.brand);
      if (next.sessionId === '') next.sessionId = root.sessionId;
      if (
        next.sessionId === root.sessionId &&
        next.label === root.label &&
        next.brand === root.brand
      ) {
        continue;
      }
      if (root.sessionId !== '' && root.sessionId !== next.sessionId) {
        if (!record.past.includes(root.sessionId)) record.past.push(root.sessionId);
      }
      record.root = { ...root, sessionId: next.sessionId, label: next.label, brand: next.brand };
      await this.messages.save(record);
    }
  }

  /** A port call whose throw becomes a refusal, as `routeTo` makes one a
   *  sentence. Once stopped, nothing is called. */
  private async attempt<T>(call: () => Promise<T>): Promise<T | Failed> {
    if (this.stopped) return { ok: false, reason: words.REMOTE_OFF };
    try {
      return await call();
    } catch (err) {
      return { ok: false, reason: message(err) };
    }
  }

  private async deliveryAttempt<T>(
    call: () => Promise<T>
  ): Promise<T | { ok: false; reason: string; unsure: true }> {
    if (this.stopped) return { ok: false, reason: words.REMOTE_OFF, unsure: true };
    try {
      return await call();
    } catch (error) {
      return { ok: false, reason: message(error), unsure: true };
    }
  }

  /** A start through `deliveryAttempt`: its doubt is an unknown outcome. */
  private async startAttempt(call: () => Promise<Started>): Promise<Started> {
    const started = await this.deliveryAttempt(call);
    return started.ok || 'outcome' in started
      ? started
      : { ok: false, reason: started.reason, outcome: 'unknown' };
  }

  /** Fresh ids for a record's notices and actions, base 36, above every id it
   *  holds, so a payload never names two buttons. */
  private ids(record: ConversationRecord, count: number): string[] {
    let top = 0;
    for (const notice of record.notices) {
      top = Math.max(top, parseInt(notice.id, 36) || 0);
      for (const action of notice.actions) top = Math.max(top, parseInt(action.id, 36) || 0);
    }
    return Array.from({ length: count }, (_, i) => (top + 1 + i).toString(36));
  }

  /** `<conversationId>.<actionId>`: eight characters, a dot and a short id,
   *  well inside the 16 bytes every payload is held to. */
  private payload(record: ConversationRecord, action: string): string {
    const payload = encodePayload(record.id, action);
    if (payload === undefined) throw new Error(`No payload fits ${record.id}.${action}.`);
    return payload;
  }

  /** The first allowlist entry receives every conversation the bridge opens
   *  (U3). */
  private home(): SenderId {
    return this.options.allowlist[0] ?? '';
  }

  private cancelIncomingPicker(event: Inbound): void {
    if (event.kind !== 'press' || !allowed(event.sender, this.options.allowlist)) return;
    const decoded = decodePayload(event.payload);
    const record = decoded && this.messages.find(decoded.conversation);
    const notice = record?.notices.find((one) =>
      one.actions.some((action) => action.id === decoded?.action)
    );
    const action = notice?.actions.find((one) => one.id === decoded?.action);
    if (
      !record ||
      !notice ||
      notice.settled !== undefined ||
      notice.message !== event.message ||
      !action ||
      !record.held?.picker ||
      picker.choose(record.held.picker, action).kind !== 'cancel'
    )
      return;
    const correlation = record.held?.correlation;
    if (correlation) void this.closeIncoming(record.id, correlation, 'closed');
  }

  private now(): number {
    return this.options.clock();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

/** A joined thread's read as written for the agent, or why it was not. */
type JoinedRead =
  | { ok: true; file: string; lines: number; total: number }
  | Extract<ThreadRead, { ok: false }>
  | undefined;

/**
 * A reply's text with what the thread said since the session last read it:
 * the whole file when it never got a pointer, the new messages when it did,
 * and nothing when there are none.
 */
function withRefresh(
  text: string,
  record: ConversationRecord,
  thread: Extract<JoinedRead, { ok: true }>
): string {
  if (record.threadRead === undefined) return threadPrompt(text, thread.file, thread.lines);
  const fresh = thread.total - record.threadRead;
  return fresh > 0 ? `${text}\n\n${words.threadRefreshLine(thread.file, fresh)}` : text;
}

/** A session as it was when this engine started it: running, busy on its
 *  first turn, with nothing ended and nothing asked yet. */
function asBegun(w: Watched): Watched {
  const { turnOutcome: _outcome, endedOutcome: _ended, ...session } = w.session;
  const { exit: _exit, ...running } = w;
  return {
    ...running,
    pending: [],
    session: {
      ...session,
      status: 'busy',
      ...(session.turnsEnded === undefined ? {} : { turnsEnded: 0 })
    }
  };
}

function keyOf(session: { pid: number; startedAt: number }): string {
  return `${session.pid}:${session.startedAt}`;
}

/** A post's refs join the conversation's, and a chain adapter answers it next. */
function track(record: ConversationRecord, posted: Posted): void {
  for (const ref of [record.anchor, posted.anchor, posted.message]) {
    if (ref !== '' && !record.refs.includes(ref)) record.refs.push(ref);
  }
  record.latest = posted.message;
}

/** Only a notice something may later settle keeps its text in the store. */
function settleable(notice: Notice): boolean {
  return (notice.buttons?.length ?? 0) > 0 || notice.kind === 'question';
}

function rootOf(
  started: Extract<Started, { ok: true }>,
  cwd: string,
  label: string
): ConversationRoot {
  return {
    pid: started.pid,
    startedAt: started.startedAt,
    sessionId: started.sessionId ?? '',
    brand: started.brand,
    cwd,
    label,
    remoteSpawned: true
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
