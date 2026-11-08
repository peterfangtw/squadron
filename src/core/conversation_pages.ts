/**
 * The resume picker's pages: one frozen ranking per open, served in slices.
 *
 * A ranking is built once per open and never mutated, so activity that moves
 * while the reader scrolls can neither duplicate a row nor skip one. Page 1 is
 * `mergeConversations`'s cut with the asked-folder floor; every later page
 * continues in activity order without the rows page 1 already served. A query
 * filters the same snapshot in activity order alone: the floor exists to keep
 * the asked folder visible in an unfiltered list, and a query already narrows.
 */

import { mapRecords } from './conversation_catalog';
import { conversationKey } from './identity';
import { mergeConversations, type Conversation } from './conversations';
import * as names from './names';

export const PAGE_ROWS = 20;
/** The most rows one list loads. Search still reaches every row past it. */
export const LOADED_ROWS = 500;
/** How long an unused snapshot is held. Engineering default, 2026-10-30. */
export const SNAPSHOT_TTL_MS = 10 * 60_000;

export type Ranking = {
  /** Page 1 under the asked-folder floor, then every other row by activity. */
  readonly rows: readonly Conversation[];
  /** Every row by activity alone: what a query filters. */
  readonly byActivity: readonly Conversation[];
};

/** `next` is the offset of the following page, absent at the end of the list
 *  and at `LOADED_ROWS`. */
export type Page = { rows: Conversation[]; next?: number };

/** Freezes one open's rows: every row of the family in the window. */
export function rank(rows: readonly Conversation[], cwd: string): Ranking {
  const top = mergeConversations(rows, cwd, PAGE_ROWS);
  const served = new Set(top.map(key));
  const byActivity = [...rows].sort((a, b) => b.lastActivity - a.lastActivity);
  return { rows: [...top, ...byActivity.filter((row) => !served.has(key(row)))], byActivity };
}

/** One page at `offset`, of the ranking or of its view under `query`. The
 *  match is today's filter box: a case-folded substring of the row's title,
 *  which is its stated name when it has one. */
export function page(ranking: Ranking, offset: number, query = ''): Page {
  const needle = query.trim().toLowerCase();
  const list = needle
    ? ranking.byActivity.filter((row) => row.title.toLowerCase().includes(needle))
    : ranking.rows;
  const from = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const end = Math.min(from + PAGE_ROWS, LOADED_ROWS, list.length);
  const rows = list.slice(from, end);
  return end < list.length && end < LOADED_ROWS ? { rows, next: end } : { rows };
}

/**
 * Each row under the name somebody stated for it, read once per key from its
 * own file: display and search then use the same captured name, so a row a
 * query matched always shows the text that matched.
 */
export async function named(rows: readonly Conversation[]): Promise<Conversation[]> {
  return mapRecords(rows, async (row) => {
    const stated = await names.readStatedName(row.brand, row.sessionId);
    return stated ? { ...row, title: stated.name, titled: true } : row;
  });
}

type Held = {
  id: string;
  cwd: string;
  ranking: Ranking;
  used: number;
};

type Timer = { cancel(): void };

/**
 * The one snapshot a panel holds. A new open replaces it; it is dropped on
 * dispose, and once unused for `SNAPSHOT_TTL_MS`. Its size is one row per
 * family record in the window, measured 348–367 B of JSON per row.
 */
export class ConversationSnapshots {
  private held?: Held;
  private timer?: Timer;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly schedule: (run: () => void, ms: number) => Timer = unrefTimer
  ) {}

  hold(id: string, cwd: string, ranking: Ranking): void {
    this.held = { id, cwd, ranking, used: this.clock() };
    this.arm(SNAPSHOT_TTL_MS);
  }

  /** The ranking a cursor names, or nothing when it was replaced, dropped or
   *  belongs to another folder. A hit keeps it for another TTL. */
  ranking(id: string, cwd: string): Ranking | undefined {
    this.expire();
    const held = this.held;
    if (!held || held.id !== id || held.cwd !== cwd) return undefined;
    held.used = this.clock();
    return held.ranking;
  }

  dispose(): void {
    this.held = undefined;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private expire(): void {
    if (!this.held) return;
    const left = this.held.used + SNAPSHOT_TTL_MS - this.clock();
    if (left <= 0) this.dispose();
    else this.arm(left);
  }

  private arm(ms: number): void {
    this.timer?.cancel();
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.expire();
    }, ms);
  }
}

function key(row: Conversation): string {
  return conversationKey(row.brand, row.sessionId);
}

function unrefTimer(run: () => void, ms: number): Timer {
  const timer = setTimeout(run, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
