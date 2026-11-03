import type { Inbound, MessageRef } from './model';
import type { Backlog, Messenger } from './port';
import { readHeard, writeHeard, type Heard } from './store';

/** How long a catch-up's read may take, all of it (a duration). Live events
 *  queue behind it, so it is one call's own bound (`CALL_MS`) and no more. */
export const CATCH_UP_MS = 30_000;

/** What CatchUp needs of the engine: never the engine itself. */
export type CatchUpPort = {
  backlog: Messenger['backlog'];
  /** The live conversations a read covers. */
  anchors(): readonly MessageRef[];
  /** Admits one event read back; true when it is new and may be routed. */
  admit(event: Inbound): boolean;
  /** Queues `step` on the routing chain, in its turn. */
  serial(step: () => Promise<void>): void;
  /** Routes admitted events in order as one batch: one late reply per
   *  place. */
  replay(events: readonly Inbound[]): Promise<void>;
  /** The ids to keep beside the watermark. */
  seen(): Heard['seen'];
  log(line: string): void;
};

type Read = { ok: true; found: Backlog; admitted: Set<string> } | { ok: false; error: unknown };

/**
 * What was sent while the link was down: the watermark a read starts from,
 * the read itself, and its replay onto the routing chain.
 */
export class CatchUp {
  /** The newest `at` of a message the engine began routing: what a
   *  catch-up reads after. */
  private heard: number | undefined;
  /** Where a catch-up began that has not finished reading every
   *  conversation. The next one reads from here, and the watermark on disk
   *  stays here, though live messages move `heard` on. */
  private unread: number | undefined;
  /** Catch-ups started, so only the newest may let go of `unread`: two can
   *  start from the same watermark. */
  private reads = 0;
  private readonly reading = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly port: CatchUpPort) {}

  /**
   * The kept watermark, or now when none is kept or a person turned Remote
   * on (forward-only), written back. Answers the ids kept beside it, for the
   * engine's deduper.
   */
  async load(fresh: boolean, now: number): Promise<Heard['seen'] | undefined> {
    const kept = fresh ? undefined : await readHeard();
    if (kept === undefined) {
      this.heard = now;
      await this.keep();
      return undefined;
    }
    this.heard = kept.at;
    return kept.seen;
  }

  /**
   * The link came back: read what was sent while it was down. The read
   * starts now, off the chain, and its routing joins the chain now too, so a
   * live event that arrives during the read routes after what came before
   * it; the deduper drops a live copy of a message the read already routed.
   */
  returned(): void {
    const backlog = this.port.backlog;
    if (!backlog || this.heard === undefined || this.stopped) return;
    const after = this.unread ?? this.heard;
    this.unread = after;
    const n = ++this.reads;
    const read = this.read(backlog, after);
    this.port.serial(async () => {
      const result = await read;
      if (!result.ok) {
        this.unread = Math.min(this.unread ?? after, after);
        if (!this.stopped) {
          this.port.log(
            `Remote: could not read what the link missed, read again on its return: ${message(result.error)}`
          );
        }
        return;
      }
      const { found, admitted } = result;
      if (found.missed > 0) {
        this.unread = Math.min(this.unread ?? after, after);
        this.port.log(
          `Remote: could not read ${found.missed} conversation(s) the link missed, read again on its return`
        );
      }
      await this.port.replay(found.events.filter((e) => admitted.delete(e.id)));
      if (found.missed === 0 && !this.stopped && n === this.reads) {
        this.unread = undefined;
        await this.keep();
      }
    });
  }

  /** A message at `at` began routing: the watermark moves to it. */
  routed(at: number): void {
    if (this.heard === undefined || at > this.heard) this.heard = at;
  }

  /** Writes the watermark, only as far as an unfinished catch-up allows, and
   *  the ids seen. Callers await it on the chain, so a stop waits for it. */
  async keep(): Promise<void> {
    if (this.stopped || this.heard === undefined) return;
    await writeHeard({ at: this.unread ?? this.heard, seen: this.port.seen() });
  }

  /** Abandons every read in flight. What one answers later is dropped. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.reading) controller.abort();
  }

  /**
   * One read, bounded here rather than by the messenger: a messenger that
   * ignores the abort still lets the chain go at `CATCH_UP_MS` or a stop.
   * Admission happens as the read lands, ahead of its turn on the chain, so
   * receipts need not wait behind earlier work; an abandoned read admits
   * nothing.
   */
  private async read(backlog: NonNullable<Messenger['backlog']>, after: number): Promise<Read> {
    const controller = new AbortController();
    this.reading.add(controller);
    const timer = setTimeout(() => controller.abort(), CATCH_UP_MS);
    let onAbort!: () => void;
    const abandoned = new Promise<Read>((resolve) => {
      onAbort = () => resolve({ ok: false, error: new Error('the read was abandoned') });
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let settled: Promise<Read>;
    try {
      settled = backlog.since(this.port.anchors(), after, controller.signal).then(
        (found): Read => ({ ok: true, found, admitted: new Set() }),
        (error: unknown): Read => ({ ok: false, error })
      );
    } catch (error) {
      settled = Promise.resolve({ ok: false, error });
    }
    const result = await Promise.race([settled, abandoned]);
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    this.reading.delete(controller);
    if (!result.ok) return result;
    if (controller.signal.aborted || this.stopped) {
      return { ok: false, error: new Error('the read was abandoned') };
    }
    for (const event of result.found.events) {
      if (this.port.admit(event)) result.admitted.add(event.id);
    }
    return result;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
