/**
 * What the warm list says about each session, and what the bar's count means.
 *
 * Words only. Whether a ping is due, held or impossible is the host's
 * (`CardView.warm`, decided by `core/warm.ts`); this turns that decision and
 * the clock into a line, so the webview paints and a test reads it headlessly.
 */

import { isMidTurn } from '../core/model';

/** What Warm is for, said once above both columns. The lead before expiry is
 *  the configuration column's buffer. */
export function warmNote(windowMs: number): string {
  return `Keep idle sessions' prompt caches warm for up to ${span(windowMs)} after the last real turn, then switch off.`;
}

/** How the clause at the end of a row is coloured: the next ping, a reason the
 *  scheduler is waiting, a cache that is gone, a switch that cannot move, or a
 *  plain fact. */
export type WarmTone = 'next' | 'held' | 'cold' | 'no' | 'quiet';
export type WarmClause = { tone: WarmTone; text: string };

/** One row: the lifetime and its provenance (absent where no ping will ever be
 *  timed against it), and the clause. */
export type WarmRow = { ttl?: string; source?: string; clause: WarmClause; refused: boolean };

const SOURCE_WORDS: Record<WarmView['source'], string> = {
  measured: 'measured',
  configured: 'configured'
};

type Warmable = WarmView & { held?: Exclude<WarmHeldView, 'unsupported'> };

const HELD_CLAUSES: Record<NonNullable<Warmable['held']>, WarmClause> = {
  busy: { tone: 'quiet', text: 'working' },
  ask: { tone: 'held', text: 'Warm blocked: waiting on you' },
  queued: { tone: 'held', text: 'Warm blocked: a message is queued' },
  warming: { tone: 'next', text: 'pinging now' },
  ended: { tone: 'quiet', text: 'ending' },
  'short-ttl': { tone: 'no', text: 'too short to keep warm' },
  'window-short': { tone: 'no', text: 'window too short to ping' },
  failed: { tone: 'held', text: 'Warm blocked: last ping failed' },
  'no-cache': { tone: 'held', text: 'Warm blocked: no cache yet' }
};

/** Something here can ping this session: what offers its switch on the card
 *  and the sheet, and what the bar may count. The one reading of `held`'s
 *  `unsupported`, which `core/warm.ts` decides. */
export function warmable(warm: WarmView | undefined): warm is Warmable {
  return warm !== undefined && warm.held !== 'unsupported';
}

export function warmRow(card: CardView, warm: WarmView, now: number): WarmRow {
  if (!warmable(warm)) {
    const text = card.canControl
      ? 'this session cannot be kept warm'
      : 'background session · nothing here can reach it';
    return { clause: { tone: 'no', text }, refused: true };
  }
  return {
    ttl: span(warm.ttlMs),
    source: SOURCE_WORDS[warm.source],
    clause: warm.on ? onClause(card, warm, now) : offClause(card, now),
    refused: false
  };
}

/** The bar's count, and the tip that says what it counts. */
export function warmTally(
  cards: readonly CardView[],
  now: number
): { count: number; rows: [string, string, string][] } {
  const listed = cards.filter((card) => card.warm);
  const kept = listed.filter((card) => keptWarm(card.warm));
  const held = kept.filter(
    (card) => card.warm && warmRow(card, card.warm, now).clause.tone === 'held'
  );
  const next = kept
    .map((card) => card.warm?.nextAt)
    .filter((at): at is number => at !== undefined && at > now)
    .sort((a, b) => a - b)[0];
  const rows: [string, string, string][] = [
    ['kept warm', `${kept.length} of ${listed.length}`, '']
  ];
  if (held.length) rows.push(['held', String(held.length), '']);
  if (next !== undefined) rows.push(['next ping', `in ${span(next - now)}`, '']);
  return { count: kept.length, rows };
}

/** What a card's stamp says in place of the last message's age: how long the
 *  warm window has left, and only while Warm can still refresh a live cache.
 *  A hold other than a ping in flight will not refresh it. `cacheUntil` is
 *  that cache's deadline, and at that instant it is already gone. Mid-turn
 *  the window restarts at the turn's end, so a working or asking card keeps
 *  its age. */
export function warmStamp(
  warm: WarmView | undefined,
  status: CardView['status'],
  now: number,
  cacheUntil: number | undefined
): string | undefined {
  if (!keptWarm(warm) || isMidTurn(status) || warm?.endsAt === undefined) return undefined;
  if (warm.held !== undefined && warm.held !== 'warming') return undefined;
  if (cacheUntil !== undefined && now >= cacheUntil) return undefined;
  return now < warm.endsAt ? `warm for ${span(warm.endsAt - now)}` : undefined;
}

/** A switch that is on and a session something here can ping: what the bar
 *  counts and what lights a card's footer. */
export function keptWarm(warm: WarmView | undefined): boolean {
  return warmable(warm) && warm.on;
}

function onClause(card: CardView, warm: Warmable, now: number): WarmClause {
  if (warm.held) return HELD_CLAUSES[warm.held];
  if (warm.nextAt !== undefined) {
    return now < warm.nextAt
      ? { tone: 'next', text: `ping in ${span(warm.nextAt - now)}` }
      : { tone: 'next', text: 'pinging now' };
  }
  // On past its window: switched on after it ended, since the warmer switches
  // a lapsed one off.
  if (warm.endsAt !== undefined && now >= warm.endsAt) {
    return { tone: 'quiet', text: 'warms from the next turn' };
  }
  return cacheClause(cacheLeft(card, now));
}

function offClause(card: CardView, now: number): WarmClause {
  if (card.status === 'busy') return { tone: 'quiet', text: 'working' };
  return cacheClause(cacheLeft(card, now));
}

function cacheClause(left: number | undefined): WarmClause {
  if (left === undefined) return { tone: 'quiet', text: 'no cache yet' };
  return left > 0
    ? { tone: 'quiet', text: `warm for ${span(left)}` }
    : { tone: 'cold', text: 'cold' };
}

function cacheLeft(card: CardView, now: number): number | undefined {
  return card.cacheUntil === undefined ? undefined : card.cacheUntil - now;
}

/** A length of time, to the minute: `45s`, `14m`, `1h`, `1h 20m`. Floored, so a
 *  countdown never promises more than is left. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
