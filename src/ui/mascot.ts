/**
 * The mascot's rules, headless: what its frames are made of, which board facts
 * it reacts to, and which of them it acts on. `webview/mascot.ts` paints and
 * moves it; nothing here touches the DOM.
 */

import { SIZE, TONES } from './mascot_frames';
import type { FrameName } from './mascot_frames';
import { isMidTurn } from '../core/model';

/** The part of a push the chick reads: the cards and the keep-awake hold. */
export type Board = Pick<StateMessage, 'groups' | 'awake'>;

/**
 * Something on the board worth a reaction. `waiting` is a dialog open on a
 * card, `done` a turn it finished that nobody has read, `start` a card that
 * was not there last push, `idle` the last busy card going quiet, and `sleep`
 * the keep-awake hold ending.
 */
export type FactKind = 'waiting' | 'done' | 'start' | 'idle' | 'sleep';

export interface Fact {
  kind: FactKind;
  /** The card it concerns. Absent for `idle` and `sleep`, which are about the
   *  whole board. */
  pid?: number;
}

/** Which fact wins a batch (PRD §4.4). `sleep` ranks under everything and
 *  never flies: it is a pose where the chick already is. */
export const RANK: Readonly<Record<FactKind, number>> = {
  waiting: 4,
  done: 3,
  start: 2,
  idle: 1,
  sleep: 0
};

/** One frame of a reaction; `ms` absent holds it until the next one. */
export interface PoseStep {
  frame: FrameName;
  ms?: number;
}

/** What the chick shows for each fact once it is there (PRD §4.2). */
export const POSE: Readonly<Record<FactKind, readonly PoseStep[]>> = {
  waiting: [{ frame: 'alert' }],
  done: [{ frame: 'happy', ms: 1400 }, { frame: 'stand' }],
  start: [{ frame: 'happy', ms: 900 }, { frame: 'stand' }],
  idle: [{ frame: 'stand' }],
  sleep: [{ frame: 'crouch', ms: 160 }, { frame: 'sleep' }]
};

/** Facts closer together than this are one decision. */
export const COALESCE_MS = 1200;
/** After a flight the chick stays put this long, unless a higher-ranked fact
 *  arrives. */
export const COOLDOWN_MS = 8000;
/** Flights allowed in any trailing minute. With the cooldown, this caps motion
 *  at about 10 s a minute, which is what bounds the cost (PRD D9). */
export const FLIGHTS_PER_MINUTE = 4;
const MINUTE_MS = 60_000;

/**
 * What changed between two pushes that the chick reacts to. The first push
 * has no `prev` and says nothing: a reload, or the switch turning on, must not
 * fly it, and a card already waiting says so itself.
 */
export function facts(prev: Board | undefined, next: Board): Fact[] {
  if (!prev) return [];
  const before = new Map(cardsOf(prev).map((c) => [c.pid, c]));
  const now = cardsOf(next);
  const out: Fact[] = [];
  for (const card of now) {
    const was = before.get(card.pid);
    if (!was) out.push({ kind: 'start', pid: card.pid });
    if (card.status === 'waiting' && was?.status !== 'waiting') {
      out.push({ kind: 'waiting', pid: card.pid });
    }
    if (card.unread && !was?.unread) out.push({ kind: 'done', pid: card.pid });
  }
  if (now.every(quiet) && !cardsOf(prev).every(quiet)) out.push({ kind: 'idle' });
  if (prev.awake?.reason === 'drinking' && next.awake?.reason !== 'drinking') {
    out.push({ kind: 'sleep' });
  }
  return out;
}

/** Every card on the board, whichever group draws it. */
export function cardsOf(board: Board): CardView[] {
  return board.groups.flatMap((g) => g.sessions);
}

/** Nothing running and nothing asked. `unknown` counts as quiet: a card
 *  nobody can read must not hold the chick off its home forever. */
export function quiet(card: CardView): boolean {
  return !isMidTurn(card.status);
}

/** What the director settled on: the fact, and whether to fly to it or pose
 *  where the chick already is. */
export interface Act {
  fact: Fact;
  fly: boolean;
}

/**
 * Which fact the chick acts on, and whether it may fly there (PRD §4.4).
 * Facts are batched for `COALESCE_MS` from the first; the batch's best fact
 * still true wins. A flight starts a cooldown only a higher rank cuts short,
 * and the trailing minute holds at most `FLIGHTS_PER_MINUTE`. A fact it may
 * not fly to is a pose in place, so the board always gets a reaction.
 *
 * Holds no timer: `offer` says when `decide` is due, and the caller keeps the
 * one timeout. The clock is injected so every rule is a test.
 */
export class Director {
  private batch: Fact[] = [];
  private open = false;
  private flights: number[] = [];
  private lastRank = -1;

  constructor(private readonly now: () => number) {}

  /** Adds facts to the batch. Returns when `decide` is due if this opened
   *  one, and `undefined` while one is already open or nothing was offered. */
  offer(facts: readonly Fact[]): number | undefined {
    if (facts.length === 0) return undefined;
    this.batch.push(...facts);
    if (this.open) return undefined;
    this.open = true;
    return this.now() + COALESCE_MS;
  }

  /**
   * Settles the batch. `still` re-checks a fact against the board as it is now;
   * `canFly` is the caller's say on the target (no sheet open, not where the
   * chick already sits, on screen). Only a flight is counted.
   */
  decide(still: (fact: Fact) => boolean, canFly: (fact: Fact) => boolean): Act | undefined {
    // Newest first among equals, then by rank: a sort is stable, so reversing
    // first makes the latest card win a tie.
    const ranked = this.batch.reverse().sort((a, b) => RANK[b.kind] - RANK[a.kind]);
    this.batch = [];
    this.open = false;
    const fact = ranked.find(still);
    if (!fact) return undefined;
    const now = this.now();
    this.flights = this.flights.filter((t) => now - t < MINUTE_MS);
    const last = this.flights.at(-1);
    const cooling =
      last !== undefined && now - last < COOLDOWN_MS && RANK[fact.kind] <= this.lastRank;
    const fly =
      fact.kind !== 'sleep' && !cooling && this.flights.length < FLIGHTS_PER_MINUTE && canFly(fact);
    if (fly) {
      this.flights.push(now);
      this.lastRank = RANK[fact.kind];
    }
    return { fact, fly };
  }

  /** Drops an open batch: the panel went out of sight, or the chick left. */
  reset(): void {
    this.batch = [];
    this.open = false;
  }
}

/** One horizontal span of a frame in one tone: one `fillRect`. */
export interface Run {
  x: number;
  y: number;
  w: number;
  tone: string;
}

/** A baked frame (`mascot_frames.ts`) back into the spans to paint. Empty
 *  cells are skipped; a malformed string throws, since the data is generated
 *  and a bad bake is a build error, not a runtime state. */
export function runs(frame: string): Run[] {
  const out: Run[] = [];
  let cell = 0;
  for (const [, tone = '', count = ''] of frame.matchAll(/([^\d])(\d+)/g)) {
    const w = Number(count);
    if (tone !== '.' && !TONES.includes(tone)) throw new Error(`unknown tone ${tone}`);
    if (tone !== '.') out.push({ x: cell % SIZE, y: Math.floor(cell / SIZE), w, tone });
    cell += w;
  }
  if (cell !== SIZE * SIZE) throw new Error(`a frame covers ${cell} cells, not ${SIZE * SIZE}`);
  return out;
}
