/**
 * An owned thread: opaque brand row ids, ordered by enqueue ordinal. Memory
 * and disk use RecordFold over the same sequence; ck/ex remain positional.
 * Brand ids are opaque here; # prefixes identify this module's note rows.
 * Based on t3code's upsertEntity/upsertVisibleTurnItem at 9bd1d8009.
 *
 * Capture the Conversation before asynchronous work. A /clear starts another;
 * the old conversation survives until its queue drains into its own record.
 * History trims above twice MAX_TURNS, preserving the live user-turn window
 * and retaining partial=true. Recovery evicts record.ts's read cache.
 * Brand tee bookkeeping (callFor, completion sets) is not bounded here.
 */

import { setTimeout as sleep } from 'timers/promises';
import { isDeepStrictEqual } from 'util';
import type { BrandId, WarmTurn } from './model';
import {
  RecordFold,
  appendLine,
  capFrom,
  drawable,
  evict,
  missingTail,
  readRecordLines,
  type RecordLine,
  type Recorded,
  type Witness
} from './record';
import { MAX_TURNS, isMarker, type Authored, type Exchange, type Recent } from './transcript';

/** Where a new record's header says it was born; `appendLine`'s third argument. */
export type Birth = { cwd?: string; brand?: BrandId };

/** Lines an entry resolves to, made once its content is known. */
export type Build = (
  conversation: string
) => readonly RecordLine[] | Promise<readonly RecordLine[]>;

/** The brand's own history of a conversation and every witness key the read saw
 *  — `CliAdapter.readWitnessed`'s answer, from whichever reader the session has. */
export type Witnessed = { recent: Recent; witnessed: ReadonlySet<string> };

/** `Witnessed` as a resume reads it: its keys in order too, so what our record
 *  missed can be told apart as a tail (`missingTail`). */
export type History = Witnessed & { readonly order: readonly Witness[] };

/**
 * What came before the pipe: the lines a conversation recovers, in record
 * order. `partial` says older turns were not read; `ours` says they are our
 * record's rather than the brand's history, which a reader is told is a
 * reconstruction (`reconstructed` in `core/adapter.ts`).
 */
export type Baseline = {
  readonly lines: readonly RecordLine[];
  readonly partial: boolean;
  readonly ours: boolean;
  readonly recordFloor?: number;
  /** Ours, and the brand's turns it missed, all after its last shared one
   *  (`missingTail`): drawn after `lines` and appended to the record ahead of
   *  anything of this pipe's. */
  readonly missing?: readonly RecordLine[];
};

/** A message still being written: drawn where `position` says, never recorded. */
export type TailRow = {
  readonly id: string;
  /** Index into `recent.exchanges` the row is drawn before. */
  readonly position: number;
  readonly exchange: Authored;
};

/**
 * One instant of the thread. Immutable: a change makes a new snapshot and
 * leaves every one already handed out as it was.
 *
 * `history` is a new object exactly when completed history changed — a line,
 * a `ret`, a checkpoint, a resolved send, a trim — and the same object across
 * tail-only deltas, so a renderer caching on it rebuilds only when it must.
 */
export type ThreadSnapshot = {
  readonly conversation: string;
  readonly generation: number;
  readonly history: Recorded;
  /** Retained echo/recovery context, as `drawable` selects it from a record. */
  readonly recent: Recent;
  readonly tail: readonly TailRow[];
  /** History opens with the brand's own history rather than our record. */
  readonly reconstructed?: true;
  readonly recordFloor?: number;
};

/**
 * A row the writer stops at, because what it will write may still change.
 * Each kind is named for what settles it:
 *
 * - `build` — this process is making its lines (`pending`, a recovery's read).
 * - `echo` — a frame still to come decides them (`awaiting`).
 * - `stream` — a message being written, drawn from `draft` (`stream`), until
 *   its completing frame or a cut.
 * - `late` — cut, and still taking text its CLI delivered after the close
 *   (`cut`'s `late`), until `seal` or `LATE_MS`.
 * - `restate` — complete, and its brand may still say it again (`hold`), until
 *   `seal` or `LATE_MS`.
 *
 * `build`, `echo` and `stream` have no lines of their own yet — a placeholder,
 * or a draft — so the settled fold stops at them (`advance`); `late` and
 * `restate` are drawn as the history they will be written as.
 *
 * **`idle` waits out `build` alone**: work this process will finish. The rest
 * wait on the CLI or on a deadline, so `idle` answers false at them rather
 * than wait. `end` finalizes them all at stdout close, /clear, or the
 * host's last flush (`Thread.finish`).
 */
type Open = 'build' | 'echo' | 'stream' | 'late' | 'restate';

/** A row the writer may take: `cut` stopped short, `complete` did not. */
type Settled = 'complete' | 'cut';

type State = Open | Settled;

/** Completed history as last folded, and the `partial` it was capped under. */
type Memo = {
  folded: Recorded;
  recent: Recent;
  offset: number;
  partial: boolean;
};

type Entry = {
  readonly id: string;
  readonly ordinal: number;
  /** Order among entries one recovery expanded into, which share an ordinal. */
  readonly sub: number;
  readonly state: State;
  /** What memory folds: the durable lines, or a `build` or `echo` row's
   *  placeholder. */
  readonly lines: readonly RecordLine[];
  /** A `stream` row's message so far. */
  readonly draft?: Authored;
  /** Memory only — a recovered baseline is already on disk. */
  readonly local?: true;
  readonly maintenance?: boolean;
  readonly warmId?: string;
};

/** One conversation's entries and the queue writing them behind. */
export class Conversation {
  private entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  /** Durable entries not yet handed to the writer, in ordinal order. */
  private readonly queue: string[] = [];
  /** The ids in `queue`. A row outside it is on disk, or memory only, and no
   *  longer changes. */
  private readonly queued = new Set<string>();
  private readonly builds = new Set<Promise<void>>();
  /** The deadline each `late` or `restate` row is sealed at, if its brand has
   *  not sealed it. */
  private readonly sealing = new Map<string, NodeJS.Timeout>();
  private writing: Promise<void> | undefined;
  private failed = false;
  private ended = false;
  /** A recovery has started and none has landed: the queue appends nothing. */
  private recovering = false;
  /** Memory holds less than the conversation: trimmed, or recovered from capped history. */
  private partial = false;
  private reconstructed = false;
  private recordFloor = 0;
  private next = 0;
  private maintenance: boolean | undefined;
  private warmId: string | undefined;
  private warmEvidence: WarmTurn | undefined;

  // The history memo: `fold` holds `entries[0, folded)`, every one settled.
  private fold = new RecordFold();
  private folded = 0;
  private foldedTurns = 0;
  private memo: Memo | undefined;
  /** A history change since `memo` was made, which may yet fold to the same. */
  private stale = true;
  private shot: ThreadSnapshot | undefined;

  constructor(
    private name: string,
    readonly generation: number,
    private readonly birth: Birth,
    private readonly lateMs = LATE_MS,
    /** Told of every change to what `snapshot` answers, synchronously and
     *  possibly more than once for one frame (`Thread.onChange`). */
    private readonly notify: () => void = () => {}
  ) {}

  get conversation(): string {
    return this.name;
  }

  /** Queued and future lines use this id; lines already written stay put.
   *  An unnamed conversation cannot write until the CLI supplies its id. */
  adopt(conversation: string): void {
    if (!conversation || conversation === this.name) return;
    this.name = conversation;
    this.shot = undefined;
    this.notify();
    this.pump();
  }

  /** Ownership is captured when a row opens, before an asynchronous echo or
   * restatement can arrive. Completion evidence is keyed to the admitted input. */
  observeWarm(turn: WarmTurn | undefined): void {
    this.warmId = turn && turn.phase !== 'closed' ? turn.id : undefined;
    if (turn) this.maintenance = turn.phase !== 'closed';
    else if (this.maintenance !== undefined) this.maintenance = false;
    if (!turn?.id || isDeepStrictEqual(turn, this.warmEvidence)) return;
    this.warmEvidence = turn;
    this.note([{ wm: turn }]);
  }

  recordWarmUsage(
    tokens: number,
    input?: number,
    turn: WarmTurn | undefined = this.warmEvidence
  ): WarmTurn | undefined {
    if (!turn || turn.cached !== undefined) return turn;
    const next = {
      ...turn,
      cached: tokens,
      ...(turn.prefix === undefined && input !== undefined ? { prefix: input } : {})
    };
    if (turn.id === this.warmEvidence?.id) this.warmEvidence = next;
    this.note([{ wm: next }]);
    return next;
  }

  /** Late text must name an existing late row. This module alone enforces
   *  its deadline; a second brand clock could disagree at the boundary. */
  stream(
    row: string,
    delta: string,
    at?: number,
    options: { late?: boolean; owner?: Pick<Authored, 'maintenance' | 'warmId'> } = {}
  ): boolean {
    const entry = this.byId.get(row);
    if (!entry) {
      if (this.ended || options.late) return false;
      this.insert(row, 'stream', [], {
        draft: this.owned(
          [{ role: 'assistant', text: delta, blocks: [{ text: delta }], ...stamp(at) }],
          options.owner
        )[0] as Authored
      });
      return true;
    }
    if (!delta || !this.queued.has(row)) return false;
    if (entry.state === 'stream' && entry.draft && !options.late) {
      const text = entry.draft.text + delta;
      this.replace({ ...entry, draft: { ...entry.draft, text, blocks: [{ text }] } }, false);
      return true;
    }
    const [line] = entry.lines;
    if (entry.state !== 'late' || !line || !('role' in line)) return false;
    this.replace({ ...entry, lines: [extend(line, delta)] }, true);
    return true;
  }

  /** A written row cannot change; later facts use ret/ck/ex notes. */
  complete(row: string, lines: readonly RecordLine[]): void {
    const entry = this.byId.get(row);
    const durable = this.owned(lines, entry);
    if (!entry) {
      this.insert(row, 'complete', durable);
      return;
    }
    if (!this.queued.has(row)) return;
    if (entry.state === 'complete' && isDeepStrictEqual(entry.lines, durable)) return;
    this.replace(
      {
        id: entry.id,
        ordinal: entry.ordinal,
        sub: entry.sub,
        state: 'complete',
        lines: durable,
        maintenance: entry.maintenance,
        warmId: entry.warmId
      },
      true
    );
  }

  /** Grok's later closer can replace fallback alarm words with CLI diagnostics. */
  hold(row: string, lines: readonly RecordLine[]): void {
    const entry = this.byId.get(row);
    const durable = this.owned(lines, entry);
    if (!entry) {
      this.insert(row, 'restate', durable);
      this.sealAfter(row);
      return;
    }
    if (entry.state !== 'restate' || !this.queued.has(row)) return;
    if (isDeepStrictEqual(entry.lines, durable)) return;
    this.replace({ ...entry, lines: durable }, true);
  }

  /** A line about turns already queued, in its own slot. */
  note(lines: readonly RecordLine[]): void {
    this.complete(`#${this.next}`, lines);
  }

  /** Reserve now, build asynchronously, and draw shown until resolution.
   *  A failed build resolves to no lines. */
  pending(row: string, build: Build, shown: readonly RecordLine[] = []): void {
    if (this.byId.has(row)) return;
    this.insert(row, 'build', shown.map(asWritten));
    this.track(
      Promise.resolve()
        .then(() => build(this.name))
        .then(
          (lines) => this.resolve(row, lines),
          () => this.resolve(row, [])
        )
    );
  }

  /** Draw shown until an external echo resolves this slot once. */
  awaiting(row: string, shown: readonly RecordLine[]): (lines: readonly RecordLine[]) => void {
    if (this.byId.has(row)) return () => undefined;
    this.insert(row, 'echo', shown.map(asWritten));
    return (lines) => this.resolve(row, lines);
  }

  /** Preserve partial text as cut. Prefer a supplied completing frame
   *  (Claude aborted=true) to synthesized deltas. Repeated closes are no-ops. */
  cut(row: string, line?: Authored, options: { late?: boolean } = {}): void {
    const entry = this.byId.get(row);
    if (!entry) {
      if (!line) return;
      this.insert(row, options.late ? 'late' : 'cut', [cutOff(line)]);
      if (options.late) this.sealAfter(row);
      return;
    }
    if (entry.state !== 'stream' || !this.queued.has(row)) return;
    const closed = line
      ? (this.owned([line], entry)[0] as Authored)
      : entry.draft?.text
        ? entry.draft
        : undefined;
    this.replace(
      {
        id: entry.id,
        ordinal: entry.ordinal,
        sub: entry.sub,
        state: options.late && closed ? 'late' : 'cut',
        lines: closed ? [cutOff(closed)] : [],
        maintenance: entry.maintenance,
        warmId: entry.warmId
      },
      true
    );
    if (options.late && closed) this.sealAfter(row);
  }

  /** Every row still streaming, cut. What an error, Send now or an interrupt's
   *  closing frame does; an interrupt acknowledgement alone does not. */
  cutOpen(options: { late?: boolean } = {}): void {
    for (const entry of this.entries.filter((one) => one.state === 'stream')) {
      this.cut(entry.id, undefined, options);
    }
  }

  /** A `late` or `restate` row may be written now; text or a restatement
   *  after this is dropped. */
  seal(row: string): void {
    clearTimeout(this.sealing.get(row));
    this.sealing.delete(row);
    const entry = this.byId.get(row);
    if (entry?.state !== 'late' && entry?.state !== 'restate') return;
    const { id, ordinal, sub, lines } = entry;
    this.replace(
      { id, ordinal, sub, state: entry.state === 'late' ? 'cut' : 'complete', lines },
      false
    );
  }

  /** Buffered stdout can follow process exit (observed with Claude after
   *  a kill signal). End at stdout close, /clear, or the host's final flush.
   *  Pending checkpoint builds can still resolve after end. */
  end(): void {
    this.cutOpen();
    for (const id of [...this.queue]) this.seal(id);
    this.ended = true;
  }

  /** Place the baseline before pipe rows. Hold writes until recovery lands,
   *  so the read cannot include this pipe's new appends. Failed reads leave
   *  the queue held for recoverBaseline's retry or explicit empty fallback. */
  async recover(read: () => Promise<Baseline>): Promise<void> {
    const ordinal = Math.min(0, ...this.entries.map((one) => one.ordinal)) - 1;
    const id = `#recover${ordinal}`;
    this.place({ id, ordinal, sub: 0, state: 'build', lines: [], local: true });
    this.recovering = true;
    let baseline: Baseline;
    try {
      baseline = await read();
    } catch (error) {
      this.remove(id);
      throw error;
    }
    this.remove(id);
    if (baseline.partial) this.partial = true;
    this.recordFloor = baseline.recordFloor ?? 0;
    if (!baseline.ours && baseline.lines.length) this.reconstructed = true;
    if (
      [...baseline.lines, ...(baseline.missing ?? [])].some(
        (line) => 'role' in line && line.role === 'warm'
      )
    ) {
      this.maintenance ??= false;
      for (const entry of [...this.entries]) {
        if (entry.local || entry.maintenance === undefined) continue;
        this.replace(
          {
            ...entry,
            lines: this.owned(entry.lines, entry),
            ...(entry.draft
              ? { draft: { ...entry.draft, maintenance: entry.maintenance, warmId: entry.warmId } }
              : {})
          },
          true
        );
      }
    }
    baseline.lines.forEach((line, sub) => {
      this.place({
        id: `${id}.${sub}`,
        ordinal,
        sub,
        state: 'complete',
        lines: [asWritten(line)],
        local: true
      });
    });
    // Ahead of every row already queued: those are this pipe's, and later.
    const appended = (baseline.missing ?? []).map((line, at) => {
      const sub = baseline.lines.length + at;
      this.place({ id: `${id}.${sub}`, ordinal, sub, state: 'complete', lines: [asWritten(line)] });
      return `${id}.${sub}`;
    });
    this.queue.unshift(...appended);
    for (const one of appended) this.queued.add(one);
    if (this.name) evict(this.name);
    this.recovering = false;
    this.pump();
  }

  snapshot(): ThreadSnapshot {
    if (this.shot) return this.shot;
    const { folded, recent, offset } = this.history();
    this.shot = {
      conversation: this.name,
      generation: this.generation,
      history: folded,
      recent,
      tail: this.tail(offset),
      recordFloor: this.recordFloor,
      ...(this.reconstructed ? { reconstructed: true as const } : {})
    };
    return this.shot;
  }

  /** True means every queued line reached disk. Open rows and failed writes
   *  return false; see Open for which work this call waits for. */
  async idle(): Promise<boolean> {
    for (;;) {
      const work = [...this.builds, ...(this.writing ? [this.writing] : [])];
      if (!work.length) break;
      await Promise.allSettled(work);
    }
    return !this.queue.length && !this.failed;
  }

  // --- entries ---------------------------------------------------------------

  private owned(
    lines: readonly RecordLine[],
    owner: Pick<Authored, 'maintenance' | 'warmId'> = {
      maintenance: this.maintenance,
      warmId: this.warmId
    }
  ): RecordLine[] {
    return lines.map((line) => {
      if (!('role' in line) || (line.role !== 'assistant' && line.role !== 'cli'))
        return asWritten(line);
      const maintenance = line.maintenance ?? owner.maintenance;
      if (
        maintenance === undefined ||
        (maintenance === false && this.maintenance === undefined && line.maintenance === undefined)
      )
        return asWritten(line);
      return asWritten({
        ...line,
        maintenance,
        ...(maintenance ? { warmId: line.warmId ?? owner.warmId } : {})
      });
    });
  }

  private insert(
    id: string,
    state: State,
    lines: readonly RecordLine[],
    extra: Pick<Entry, 'draft'> = {}
  ): void {
    const durable = this.owned(lines);
    const authored = extra.draft ?? durable.find((line): line is Authored => 'role' in line);
    this.place({
      id,
      ordinal: this.next++,
      sub: 0,
      state,
      lines: durable,
      maintenance: authored?.maintenance ?? this.maintenance ?? false,
      warmId: authored?.warmId ?? (authored?.maintenance === false ? undefined : this.warmId),
      ...extra
    });
    this.queue.push(id);
    this.queued.add(id);
    this.pump();
  }

  /** `upsertVisibleTurnItem`'s insertion: before the first entry ordered after it. */
  private place(entry: Entry): void {
    let at = this.entries.length;
    while (at > 0 && after(this.entries[at - 1], entry)) at--;
    this.entries.splice(at, 0, entry);
    this.byId.set(entry.id, entry);
    this.changed(at, entry.state !== 'stream');
  }

  /** `upsertEntity`: the entry with this id, replaced. A queued row the trim
   *  took out of memory still changes what the writer will append. */
  private replace(entry: Entry, history: boolean): void {
    const at = this.indexOf(entry.id);
    if (at < 0 && !this.queued.has(entry.id)) return;
    this.byId.set(entry.id, entry);
    if (at >= 0) {
      this.entries[at] = entry;
      this.changed(at, history);
    }
    this.pump();
  }

  private remove(id: string): void {
    const at = this.indexOf(id);
    if (at < 0) return;
    this.entries.splice(at, 1);
    this.byId.delete(id);
    this.changed(at, true);
  }

  private resolve(row: string, lines: readonly RecordLine[]): void {
    const entry = this.byId.get(row);
    // An explicit `complete` may have resolved it first.
    if (entry?.state !== 'build' && entry?.state !== 'echo') return;
    this.replace(
      {
        id: entry.id,
        ordinal: entry.ordinal,
        sub: entry.sub,
        state: 'complete',
        lines: this.owned(lines, entry),
        maintenance: entry.maintenance,
        warmId: entry.warmId
      },
      true
    );
  }

  /** From the end, where nearly every change lands. */
  private indexOf(id: string): number {
    for (let at = this.entries.length - 1; at >= 0; at--) {
      if (this.entries[at]?.id === id) return at;
    }
    return -1;
  }

  private changed(at: number, history: boolean): void {
    if (at < this.folded) this.refold();
    if (history) this.stale = true;
    this.shot = undefined;
    this.notify();
  }

  private refold(): void {
    this.fold = new RecordFold();
    this.folded = 0;
    this.foldedTurns = 0;
  }

  private sealAfter(row: string): void {
    const timer = setTimeout(() => this.seal(row), this.lateMs);
    // A deadline is not a reason to keep a process alive; `end` seals too.
    timer.unref();
    this.sealing.set(row, timer);
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.builds.delete(tracked));
    this.builds.add(tracked);
  }

  // --- the write queue -------------------------------------------------------

  /**
   * One append at a time, in ordinal order.
   *
   * **`appendFile` does not order itself.** Two calls issued in the same tick
   * are two independent chains on libuv's threadpool and land in whichever
   * order it finishes them — measured wrong for 169 of 300 pairs on this
   * machine. The pipe delivers every complete line of one chunk synchronously
   * in a loop (`core/session.ts`), so a chunk carrying two recordable frames
   * issues two appends with nothing between them. `O_APPEND` makes each line
   * atomic and says nothing about which line goes first. Enqueue ordinals
   * preserve pipe order through asynchronous builds and appends.
   *
   * The head waits until it is `Settled` (`Open` says what settles each kind).
   * Rows behind it are drawn meanwhile and written after it — the disk is
   * positional, so writing past an open row would put a later line in its
   * place.
   *
   * The file is the conversation's, captured with this object: a `/clear`
   * starts the next `Conversation`, and a slow image copy or checkpoint still
   * in flight here lands in the record it was made in. The `/clear` command
   * itself is drained before the reset frame exists and lands in the closing
   * record — a known divergence from the CLI, which files it under the new
   * one, and not this queue's to repair.
   */
  private pump(): void {
    if (this.writing || !this.ready()) return;
    this.writing = this.write().finally(() => {
      this.writing = undefined;
      this.pump();
    });
  }

  private async write(): Promise<void> {
    for (let entry = this.ready(); entry; entry = this.ready()) {
      this.queue.shift();
      this.queued.delete(entry.id);
      // Trimmed while it waited: memory let go of it already.
      if (this.indexOf(entry.id) < 0) this.byId.delete(entry.id);
      for (const line of entry.lines) {
        // Nothing throws out of `appendLine`; a lost line is latched as
        // `broken` there, and the queue carries on with the next.
        if (!(await appendLine(this.name, line, this.birth))) this.failed = true;
      }
    }
  }

  /** The head, if it may be written now. One test for `pump` and `write`, or a
   *  pump that starts a write which then declines re-pumps without end. */
  private ready(): Entry | undefined {
    if (this.recovering || !this.name) return undefined;
    const head = this.queue[0];
    const entry = head === undefined ? undefined : this.byId.get(head);
    return entry && writable(entry) ? entry : undefined;
  }

  // --- the view --------------------------------------------------------------

  /** Fold the settled prefix incrementally and refold drawable rows past
   *  open slots. Preserve identity when ignored/equal notes change nothing:
   *  claimed/render caches use completed-history references. */
  private history(): Memo {
    if (this.memo && !this.stale) return this.memo;
    this.advance();
    const rest = this.entries.slice(this.folded);
    const drawn = rest.some((one) => one.state !== 'stream' && one.lines.length > 0);
    const prior = this.memo?.folded;
    const fresh = drawn ? foldAll(this.entries) : this.fold.snapshot();
    const folded = prior && drawn && sameRecorded(fresh, prior) ? prior : fresh;
    if (this.trim(folded)) return this.history();
    this.stale = false;
    if (this.memo?.folded === folded && this.memo.partial === this.partial) return this.memo;
    const offset = capFrom(folded.exchanges);
    const recent =
      offset > 0 || this.partial
        ? {
            exchanges: offset ? folded.exchanges.slice(offset) : folded.exchanges,
            truncated: true
          }
        : { exchanges: folded.exchanges, truncated: false };
    this.memo = { folded, recent, offset, partial: this.partial };
    return this.memo;
  }

  private advance(): void {
    for (let entry = this.entries[this.folded]; entry; entry = this.entries[this.folded]) {
      if (!ownLines(entry.state)) return;
      for (const line of entry.lines) {
        this.fold.push(line);
        if (drawsTurn(line)) this.foldedTurns++;
      }
      this.folded++;
    }
  }

  /** Unwritten evicted entries remain queued. Open rows cannot be evicted:
   *  late text and sealing must still update their durable payload. */
  private trim(recorded: Recorded): boolean {
    if (recorded.exchanges.length <= 2 * MAX_TURNS) return false;
    const authored = recorded.exchanges.filter((one) => !isMarker(one)).length;
    if (authored <= 2 * MAX_TURNS) return false;
    const cap = capFrom(recorded.exchanges);
    let turns = 0;
    let drop = 0;
    for (const entry of this.entries) {
      if (isOpen(entry.state)) break;
      const more = entry.lines.filter(drawsTurn).length;
      if (turns + more > cap) break;
      turns += more;
      drop++;
    }
    if (!drop) return false;
    for (const entry of this.entries.splice(0, drop)) {
      if (!this.queued.has(entry.id)) this.byId.delete(entry.id);
    }
    this.partial = true;
    this.refold();
    this.memo = undefined;
    this.stale = true;
    return true;
  }

  private tail(offset: number): readonly TailRow[] {
    const rows: TailRow[] = [];
    let turns = this.foldedTurns;
    for (const entry of this.entries.slice(this.folded)) {
      if (entry.state === 'stream' && entry.draft) {
        rows.push({ id: entry.id, position: Math.max(0, turns - offset), exchange: entry.draft });
      } else {
        turns += entry.lines.filter(drawsTurn).length;
      }
    }
    return rows;
  }
}

/**
 * Every conversation one owned session has held, and which is current.
 *
 * One per session handle. `begin` is the conversation id the CLI just named —
 * at launch, and again on the `init` after a `/clear` — and `reset` the
 * `/clear` itself, when the next id is not known yet.
 */
export class Thread {
  private conversations: Conversation[];
  private active: Conversation;
  private readonly lateMs: number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly birth: Birth,
    conversation = '',
    options: { lateMs?: number; log?: (line: string) => void } = {}
  ) {
    this.lateMs = options.lateMs ?? LATE_MS;
    this.log = options.log;
    this.active = this.make(conversation, 0);
    this.conversations = [this.active];
  }

  /**
   * Called whenever `snapshot` may answer something new: a delta, a line, a
   * resolved row, a recovery landing, a `/clear`. Synchronous, inside the
   * change, and not deduplicated — a frame can call it several times, and a
   * change can turn out to fold to the same history — so a listener only asks
   * for a read later, and reads the snapshot then. A retired conversation's
   * late writes call nothing: they change no snapshot this hands out.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get current(): Conversation {
    return this.active;
  }

  /**
   * The conversation the CLI just named, which is always the current one: a
   * new conversation starts only at `reset`, so the id a `/clear`'s `init`
   * names lands on the one the reset started. An id that changes with no
   * reset before it — a CLI that forked a resumed conversation, say — is
   * adopted and said on `log`; ending the conversation there would blank a
   * thread the reader is still in, recovered history and all.
   */
  begin(conversation: string): Conversation {
    const was = this.active.conversation;
    if (was && conversation && conversation !== was) {
      this.log?.(
        `conversation ${was} went on as ${conversation} with no reset; recording under it`
      );
    }
    this.active.adopt(conversation);
    return this.active;
  }

  /** The conversation ended here; the next has no id until the CLI says it. */
  reset(): Conversation {
    this.active.end();
    this.active = this.make('', this.active.generation + 1);
    this.conversations.push(this.active);
    this.announce();
    return this.active;
  }

  /**
   * The host's last flush, after the session was closed: the current
   * conversation ends as stdout's close would end it — rows still streaming
   * cut, rows held for late text or a restatement sealed — and the queue
   * drains. A host exiting does not wait for the child's stdout to close, and
   * an open row at the head would keep everything behind it, the stopped
   * turn's checkpoint included, off the record for good. Answers `idle`.
   */
  finish(): Promise<boolean> {
    this.active.end();
    return this.idle();
  }

  snapshot(): ThreadSnapshot {
    return this.active.snapshot();
  }

  /**
   * Every conversation's `idle`, retired ones included — and one begun while
   * this waited, which a `/clear` mid-wait makes; the answer covers every
   * conversation held when it returns.
   */
  async idle(): Promise<boolean> {
    for (;;) {
      const asked = this.conversations;
      const settled = new Map<Conversation, boolean>();
      await Promise.all(
        asked.map(async (one) => {
          settled.set(one, await one.idle());
        })
      );
      this.conversations = this.conversations.filter(
        (one) => one === this.active || settled.get(one) !== true
      );
      if (this.conversations.every((one) => settled.has(one))) {
        return [...settled.values()].every(Boolean);
      }
    }
  }

  private make(conversation: string, generation: number): Conversation {
    const made: Conversation = new Conversation(
      conversation,
      generation,
      this.birth,
      this.lateMs,
      () => {
        if (made === this.active) this.announce();
      }
    );
    return made;
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * What a resumed conversation recovers: **our record when `drawable` may draw
 * it, capped where `drawable` caps it; our record and the turns it missed when
 * those are a tail (`missingTail`); else the brand's history whole**, with our
 * record left as it is on disk and one line said on `log`.
 *
 * The cap keeps `drawable`'s bounded-history floor: a record is drawn no
 * further back than the brand's read is evidence for. It falls between lines,
 * after the one that made the last turn left out, so the lines kept fold to
 * exactly the turns `drawable` keeps — a `ret` or `ck` about a turn left out
 * finds nothing before it and is dropped, as the fold drops one about a turn
 * it never saw. A tail is appended whole, cap or not: it is all evidence.
 *
 * A record that is not there, that a failed write latched, or that this build
 * refuses is no record (`readRecordLines`), so the brand's history decides.
 * Either read failing throws, and the caller retries.
 */
export async function readBaseline(
  conversation: string,
  history: () => Promise<History>,
  log?: (line: string) => void
): Promise<Baseline> {
  const [mine, theirs] = await Promise.all([readRecordLines(conversation, true), history()]);
  const fold = new RecordFold();
  for (const line of mine?.lines ?? []) fold.push(line);
  const bounded = theirs.recent.truncated;
  const recorded = (): Recorded => ({
    ...fold.snapshot(),
    firstSeen: new Map([
      ...fold.snapshot().firstSeen,
      ...[...(mine?.firstSeen ?? [])].map(
        ([key, at]) => [key, Math.max(0, at - (mine?.from ?? 0))] as const
      )
    ])
  });
  let drawn = drawable(recorded(), theirs.witnessed, bounded);
  const missing = mine && !drawn ? missingTail(recorded(), theirs) : undefined;
  for (const line of missing ?? []) fold.push(line);
  if (missing) drawn = drawable(recorded(), theirs.witnessed, bounded);
  if (!mine || !drawn) {
    if (mine) log?.(`record ${conversation} missed turns among its own; drawing the CLI's history`);
    return { lines: theirs.recent.exchanges, partial: bounded, ours: false };
  }
  const from = fold.snapshot().exchanges.length - drawn.exchanges.length;
  let lines = mine.lines;
  if (from > 0) {
    // Raw slicing can retarget a warm receipt from an omitted input.
    const cut = await readRecordLines(conversation, true, (mine.from ?? 0) + from);
    if (!cut || cut.revision !== mine.revision) throw new Error('record changed during recovery');
    lines = cut.lines;
  }
  const recordFloor =
    bounded && theirs.witnessed.size
      ? [...theirs.witnessed].reduce(
          (floor, key) => Math.min(floor, mine.firstSeen?.get(key) ?? Infinity),
          Infinity
        )
      : 0;
  return {
    lines,
    partial: drawn.truncated || !!mine.partial,
    ours: true,
    ...(recordFloor > 0 ? { recordFloor } : {}),
    ...(missing ? { missing } : {})
  };
}

/** Maximum duration a late or restated row holds the write queue: 2 s from its
 *  first close. The late-stream observation is on `GrokTee.ended`. */
export const LATE_MS = 2_000;

/** The waits before each retry of a recovery that failed: ~4 s in all. */
const RECOVERY_RETRY_MS: readonly number[] = [250, 500, 1_000, 2_000];

/**
 * `recover`, retried until it lands. A conversation with nothing to recover —
 * a fresh start, `read` absent — has no read to wait for.
 *
 * **A transient failure is retried, not taken as empty**: an empty baseline is
 * kept for the life of the session. The first send waits on this, so a record
 * that will never read must shrink the thread rather than stop the session.
 * After the last wait, or once `stopped` (the session closed), it recovers an
 * empty baseline and says so on `log`. Never rejects; answers false when it
 * gave up, so a reader asking whether there was history knows memory cannot
 * say.
 */
export async function recoverBaseline(
  conversation: Conversation,
  read: (() => Promise<Baseline>) | undefined,
  options: {
    retryMs?: readonly number[];
    stopped?: () => boolean;
    log?: (line: string) => void;
  } = {}
): Promise<boolean> {
  if (!read) return true;
  const waits = options.retryMs ?? RECOVERY_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await conversation.recover(read);
      return true;
    } catch (error) {
      const wait = waits[attempt];
      if (wait !== undefined && !options.stopped?.()) await sleep(wait);
      if (wait === undefined || options.stopped?.()) {
        options.log?.(
          `history not recovered after ${attempt + 1} reads (${reason(error)}); drawing from the pipe on`
        );
        await conversation.recover(() => Promise.resolve(EMPTY));
        return false;
      }
    }
  }
}

const EMPTY: Baseline = { lines: [], partial: false, ours: true };

function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

/** Ordinal, then the order one recovery's lines arrived in. */
function after(a: Entry | undefined, b: Entry): boolean {
  return !!a && (a.ordinal > b.ordinal || (a.ordinal === b.ordinal && a.sub > b.sub));
}

function writable(entry: Entry): boolean {
  return !isOpen(entry.state);
}

function isOpen(state: State): state is Open {
  return state !== 'complete' && state !== 'cut';
}

/** Whether a row's lines are its own: not a placeholder or a draft (`Open`). */
function ownLines(state: State): boolean {
  return state !== 'build' && state !== 'echo' && state !== 'stream';
}

function foldAll(entries: readonly Entry[]): Recorded {
  const fold = new RecordFold();
  for (const entry of entries) {
    if (entry.state === 'stream') continue;
    for (const line of entry.lines) fold.push(line);
  }
  return fold.snapshot();
}

/** Two folds of one history, equal turn for turn and note for note. The note
 *  maps are keyed by exchange object, which no two folds share, so they are
 *  compared by the index of the turn each note is on. */
function sameRecorded(a: Recorded, b: Recorded): boolean {
  return (
    isDeepStrictEqual(a.exchanges, b.exchanges) &&
    isDeepStrictEqual(a.firstSeen, b.firstSeen) &&
    isDeepStrictEqual(byTurn(a, a.checkpoints), byTurn(b, b.checkpoints)) &&
    isDeepStrictEqual(byTurn(a, a.execution), byTurn(b, b.execution))
  );
}

function byTurn<T>(recorded: Recorded, notes: ReadonlyMap<Exchange, T> | undefined): unknown[] {
  return notes ? recorded.exchanges.map((turn) => notes.get(turn)) : [];
}

/** Whether `RecordFold` makes an exchange of this line — its own test, restated
 *  so a row's place can be counted without folding it. */
function drawsTurn(line: RecordLine): boolean {
  const parsed = line as {
    wm?: unknown;
    ck?: unknown;
    ex?: unknown;
    ret?: unknown;
    role?: unknown;
    mark?: unknown;
  };
  if (parsed.wm || parsed.ex || parsed.ck || Array.isArray(parsed.ret)) return false;
  return parsed.role !== undefined || parsed.mark !== undefined;
}

/**
 * The line as the record will read it back. JSON drops a field whose value is
 * `undefined` where `RecordFold`'s `structuredClone` keeps it, and memory must
 * fold what disk will hold, or the two disagree on a key nobody can see.
 */
function asWritten(line: RecordLine): RecordLine {
  return JSON.parse(JSON.stringify(line)) as RecordLine;
}

function cutOff(line: Authored): RecordLine {
  return asWritten({ ...line, cut: true });
}

/** Late text onto a cut row: the last prose block grows, or a new one starts. */
function extend(line: Authored, delta: string): Authored {
  const blocks = line.blocks?.slice() ?? [];
  const last = blocks[blocks.length - 1];
  if (last && 'text' in last) blocks[blocks.length - 1] = { ...last, text: last.text + delta };
  else blocks.push({ text: delta });
  return { ...line, text: line.text + delta, blocks };
}

function stamp(at: number | undefined): { at?: number } {
  return at === undefined ? {} : { at };
}
