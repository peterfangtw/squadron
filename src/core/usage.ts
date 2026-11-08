import * as crypto from 'node:crypto';
/**
 * The account's plan usage: the most recent reading of it, and where that
 * reading is kept so it outlives the window that took it.
 *
 * **Newest wins, window by window.** Every figure is stamped when it is taken —
 * the pipe's round trip with the clock, a port's read with whatever moment it
 * names — and the later stamp is the answer. Nothing here compares percentages.
 *
 * The stamp is on the window and not on the reading, which is what lets the two
 * halves of that sentence both hold. One answer can carry a figure for one
 * window and none for the other, and a window nobody restated was not observed:
 * keeping the figure already held for it is not preferring an older reading, it
 * is declining to invent a newer one. Observed 2026-09-10, which is when this
 * stopped taking a reading whole — `mergeReadings` has the case.
 *
 * Ranking by figure is what this used to do, on the premise that usage only
 * accrues inside a window and so the higher of two readings of one window was
 * the later one. The premise is false: on 2026-09-02 Claude's `seven_day` went
 * 27% → 1% with `resets_at` unchanged (2026-09-07T10:00Z on both sides), the
 * server having re-based the figure mid-window. The panel then held 27% for
 * five days, because every fresh 1% lost the comparison. A reading is a
 * timestamped fact about the account; the newest one is the truth.
 *
 * Windows are data, not two named fields. A brand states the windows it has —
 * Claude two, Grok one — and everything above this file maps over the list, so
 * a brand that later reports a different window is a new `id` at the seam and
 * no change here or in the renderer.
 */

import * as fs from 'node:fs/promises';
import type { UsageSource } from './adapter';
import { fileStamp, readJson, writeAtomicJson } from './files';
import { mergeReadings, stampWindows } from './limits';
import { sessionBrand } from './brands';
import type { BrandId, RateLimits, RateWindow, Session } from './model';
import * as coordination from './coordination/usage';
import { LIVE_TIMEOUT_MS, USAGE_REFRESH_MS, liveDue, type LiveHint } from './usage_policy';
import { usageFile } from './paths';

/** Re-exported: the merge is a pure rule over normalized readings, shared
 *  with a session's held usage (`live.withUsage`). */
export { mergeReadings };

/**
 * A reading as the store weighs it: every window dated, and the reading's own
 * `at` its newest figure's stamp, or none. A declaration-only answer (Grok
 * just after a rollover) is still dated window by window so it can retire a
 * figure, but it observed no quota.
 */
function observed(reading: RateLimits): RateLimits {
  const dated = reading.at === undefined ? reading : stampWindows(reading, reading.at);
  const at = dated.windows.reduce<number | undefined>(
    (newest, window) =>
      typeof window.pct === 'number' && window.at !== undefined
        ? Math.max(newest ?? 0, window.at)
        : newest,
    undefined
  );
  return at === undefined ? { windows: dated.windows } : { at, windows: dated.windows };
}

/**
 * Expired figures become declarations, so the chip draws a dash for a window
 * the brand still has. Unstamped readings age out because their age is unknown.
 * `null` is no figure: the signed-in account row already declares those windows.
 * Read-out only: writing this result would delete figures from the lasting store.
 */
function currentUsage(
  view: RateLimits | undefined,
  noResetMs: number,
  now: number = Date.now()
): RateLimits | undefined {
  if (!view?.windows.length) return undefined;
  const windows = view.windows.map((window) => {
    const at = window.at ?? view.at;
    const aged = at === undefined || now - at >= noResetMs;
    return (window.resetsAt === undefined ? aged : window.resetsAt * 1000 <= now)
      ? { id: window.id, short: window.short }
      : window;
  });
  return windows.some((window) => typeof window.pct === 'number')
    ? { ...view, windows }
    : undefined;
}

export async function readStoredUsage(
  brand: BrandId,
  home?: string
): Promise<RateLimits | undefined> {
  return narrow(await readJson<unknown>(usageFile(brand, home)));
}

export async function writeStoredUsage(
  brand: BrandId,
  view: RateLimits,
  home?: string
): Promise<boolean> {
  const record =
    view.at === undefined ? { windows: view.windows } : { at: view.at, windows: view.windows };
  return writeAtomicJson(usageFile(brand, home), record);
}

/** File only. `forgetUsageFor` also clears memory. Tests use the store alone. */
export async function forgetStoredUsage(brand: BrandId, home?: string): Promise<void> {
  await fs.rm(usageFile(brand, home), { force: true });
}

/**
 * What this process holds for each brand, mirroring the file it came out of.
 *
 * **Disk is canonical and memory mirrors it**, which is the opposite of a cache:
 * the file is what survives a restart, a signed-out hour and a credential that
 * expired hours ago. The poll checks its fingerprint and reads only changes;
 * file watchers can miss a write (stock VS Code smoke, 2026-10-16).
 *
 * The port arrives as an argument. Importing `core/adapter.ts` here would close
 * a cycle — `adapter` → `grok/adapter` → `grok/auth` → `grok/usage` → this file
 * — and the host already holds `BRANDS` and `adapter(id)` for `discoverAll`.
 */
const held = new Map<
  BrandId,
  { stamp: string; generation?: string; view: RateLimits | undefined }
>();
/**
 * Somewhere to say that a figure went backwards, since nothing else here would.
 *
 * A window only rises inside its period, so an accepted reading that lowers one
 * or drops it altogether is either the server re-basing the figure — which it
 * does, `seven_day` 27% → 1% on 2026-09-02 — or an answer that should not have
 * been believed. The store cannot tell those apart and does not try: it takes
 * the newest, and says so here, so the next occurrence is a line in the log
 * rather than an evening of forensics. Written after a `wk 73% → 52%` drop on
 * 2026-09-10 whose source could not be established after the fact.
 *
 * The `sessions.ts` idiom, for the same reason: this is `core/`, and the output
 * channel is the host's.
 */
let log: (line: string) => void = () => {};

export function setUsageLog(sink: (line: string) => void): void {
  log = sink;
}

/**
 * Log losses with their source and both stamps: an older replacement is a
 * different bug from a newer reading that lowers the figure.
 */
function noteLoss(
  brand: BrandId,
  from: string,
  next: RateLimits,
  before: RateLimits | undefined
): void {
  for (const was of before?.windows ?? []) {
    if (typeof was.pct !== 'number') continue;
    const now = next.windows.find((window) => window.id === was.id);
    const said = `usage: ${brand}/${from} ${was.id} ${was.pct}%@${was.at ?? '?'}`;
    if (!now) {
      log(`${said} -> gone from the reading`);
      continue;
    }
    // Same period only. A window that reset is *expected* to read lower, and
    // saying so on every rollover would bury the reading that is not.
    if (now.resetsAt !== was.resetsAt) continue;
    if (typeof now.pct === 'number' && now.pct >= was.pct) continue;
    const drawn = typeof now.pct === 'number' ? `${now.pct}%` : 'no figure';
    log(`${said} -> ${drawn}@${now.at ?? '?'} within one period (resets ${was.resetsAt ?? '?'})`);
  }
}

async function hydrate(brand: BrandId, home?: string): Promise<RateLimits | undefined> {
  let generation = held.get(brand)?.generation;
  try {
    generation = (await coordination.readState(brand, home))?.generation;
  } catch {
    /* A transient state read cannot establish an account change. */
  }
  if (held.get(brand)?.generation !== generation) held.delete(brand);
  const stamp = await fileStamp(usageFile(brand, home));
  if (held.get(brand)?.stamp !== stamp) {
    const stored = await readStoredUsage(brand, home);
    held.set(brand, { stamp, generation, view: stored ?? held.get(brand)?.view });
  }
  return held.get(brand)?.view;
}

/** `invalidate` admits another window's write. See `currentUsage` for read-out retirement. */
export async function usageFor(
  brand: BrandId,
  source: UsageSource,
  opts: { home?: string; now?: number } = {}
): Promise<RateLimits | undefined> {
  // A real clock expires recorded fixtures: grok_usage.test.ts failed when
  // its weekly fixture period ended on 2026-08-30. Use the caller's clock.
  const now = opts.now ?? Date.now();
  const current = currentUsage(await hydrate(brand, opts.home), source.noResetMs, now);
  return current ? inPaintOrder(current, source.windows) : undefined;
}

/**
 * The labels the nav's usage chip holds while no account is known yet: the
 * first brand's declared windows, in the order given. Labels only — a
 * declaration's `pct: null` says a brand lacks a window, which is a reading of
 * that brand and not of whichever one the chip ends up showing.
 */
export function pendingUsageWindows(
  sources: readonly (Pick<UsageSource, 'windows'> | undefined)[]
): { id: string; short: string }[] | undefined {
  const first = sources.find((source) => source !== undefined);
  return first?.windows.map(({ id, short }) => ({ id, short }));
}

/**
 * Put a held reading back into the order its adapter declares for paint.
 *
 * The store survives adapter changes. A Codex file written when only `wk` was
 * declared therefore has `weekly` first; that order is history, not
 * presentation. `UsageSource.windows` is explicitly the paint order, so order
 * the windows a reading carries by those declarations and inject only an
 * authoritative `pct: null` declaration ("this brand has no such window"). An
 * ordinary declaration with no reading remains absent from a partial held
 * record, which preserves the store contract; the no-reading fallback still
 * paints all declarations. Append protocol windows a newer source knows that
 * this build does not. One shared normalization keeps every account row and the
 * nav chip in agreement without teaching either renderer a brand.
 */
function inPaintOrder(view: RateLimits, declarations: readonly RateWindow[]): RateLimits {
  const byId = new Map(view.windows.map((window) => [window.id, window]));
  const declared = new Set(declarations.map((window) => window.id));
  const windows = declarations.flatMap((declaration) => {
    const reading = byId.get(declaration.id);
    return reading
      ? [{ ...declaration, ...reading }]
      : declaration.pct === null
        ? [{ ...declaration }]
        : [];
  });
  windows.push(...view.windows.filter((window) => !declared.has(window.id)));
  return { ...view, windows };
}

/** Cached snapshots keep their timestamps; fresh observations suppress other hosts' fetches. */
export async function noteReading(
  brand: BrandId,
  reading: RateLimits | undefined,
  opts: { home?: string; refreshMs?: number; from?: string; generation?: string } = {}
): Promise<void> {
  if (
    !reading ||
    (reading.at ?? 0) > Date.now() ||
    reading.windows.some((window) => (window.at ?? 0) > Date.now())
  )
    return;
  const seen = observed(reading);
  const prior = await hydrate(brand, opts.home);
  if (JSON.stringify(mergeReadings([prior, seen])) === JSON.stringify(prior)) return;
  await coordination.mutate(brand, opts.home, async (state) => {
    if (opts.generation !== undefined && opts.generation !== state.generation) return;
    const before = await hydrate(brand, opts.home);
    const next = mergeReadings([before, seen]);
    if (!next) return;
    noteLoss(brand, opts.from ?? 'store', next, before);
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      if (!(await writeStoredUsage(brand, next, opts.home)))
        throw new Error('Could not persist usage reading.');
    }
    held.set(brand, {
      stamp: held.get(brand)?.stamp ?? 'absent',
      generation: state.generation,
      view: next
    });
    const at = seen.at ?? 0;
    if (at > 0 && at <= Date.now()) {
      state.notBefore = Math.max(state.notBefore, at + (opts.refreshMs ?? USAGE_REFRESH_MS));
    }
  });
}

/** One brand's plan usage as this pass finds it: the port that reads it, and
 *  whether there is an account to read it for. */
export type BrandUsage = {
  brand: BrandId;
  source: UsageSource;
  signedIn: boolean;
  generation?: string;
};

/**
 * Every brand's reading for one pass: what its sessions report, plus a read when
 * one is due.
 *
 * **Nothing is written for a brand nobody is signed in to.** Signing out is not
 * a state the sessions know about — `claude /logout` leaves them running and
 * answering on their pipes — so a walk that folded those in would put the old
 * account's figure back on disk within one poll of the forget.
 *
 * A brand that throws keeps what it holds and does not take the pass down with
 * it — this is a figure on a chip, and the board is the rest of the message.
 */
export async function noteSessionUsage(
  entry: BrandUsage,
  sessions: readonly Session[],
  home?: string
): Promise<void> {
  if (!entry.signedIn) return;
  const epoch = entry.generation ?? (await coordination.generation(entry.brand, home));
  const mine = sessions.filter(
    (session) =>
      sessionBrand(session.brand) === entry.brand &&
      (session.usageGeneration === undefined || session.usageGeneration === epoch)
  );
  await noteReading(entry.brand, mergeReadings(mine.map((session) => session.rateLimits)), {
    home,
    refreshMs: entry.source.everyMs,
    generation: epoch,
    from: 'sessions'
  });
}

export async function walkUsage(
  entry: BrandUsage,
  opts: {
    sessions: readonly Session[];
    now: number;
    home?: string;
    signal?: AbortSignal;
    clock?: () => number;
  }
): Promise<void> {
  const { brand, source, signedIn, generation } = entry;
  if (!signedIn) return;
  await coordination.settle(brand, opts.home);
  const epoch = generation ?? (await coordination.generation(brand, opts.home));
  const store = { home: opts.home, refreshMs: source.everyMs, generation: epoch };
  await noteSessionUsage({ brand, source, signedIn, generation: epoch }, opts.sessions, opts.home);
  const raw = await hydrate(brand, opts.home);
  const state = await coordination.readState(brand, opts.home);
  if (state?.generation !== epoch || opts.signal?.aborted) return;
  if (Math.max(state.notBefore, state.attempt?.checkAfter ?? 0) > opts.now + source.everyMs) {
    state.notBefore = await coordination.mutate(brand, opts.home, (current) => {
      current.notBefore = Math.min(current.notBefore, opts.now + source.everyMs);
      if (current.attempt?.checkAfter !== undefined) {
        current.attempt.checkAfter = Math.min(
          current.attempt.checkAfter,
          opts.now + source.everyMs
        );
        state.attempt = current.attempt;
      }
      return current.notBefore;
    });
  }
  const freshUntil = (raw?.at ?? 0) + source.everyMs;
  if (Math.max(freshUntil, state.notBefore, state.attempt?.checkAfter ?? 0) <= opts.now) {
    const attempt = await coordination.admit(brand, opts.home, opts.now, source.everyMs, epoch);
    if (attempt) {
      try {
        const read = await source.read(undefined, {
          signal: opts.signal,
          starting: () => coordination.starting(brand, opts.home, attempt),
          remember: (members) => coordination.remember(brand, opts.home, attempt, members)
        });
        if (read && !opts.signal?.aborted) {
          await noteReading(brand, stampWindows(read, read.at ?? opts.clock?.() ?? opts.now), {
            ...store,
            generation: attempt.generation,
            from: 'read'
          });
        }
      } catch {
        /* Preserve the last reading; the durable attempt bounds the next try. */
      } finally {
        await coordination.complete(
          brand,
          opts.home,
          attempt,
          opts.clock?.() ?? opts.now,
          source.everyMs
        );
      }
    }
  }
}

/** The newest observation of a brand's quota this host can see: the stored
 *  reading's `at`, which only a figure moves. */
export async function observedAt(brand: BrandId, home?: string): Promise<number | undefined> {
  return (await hydrate(brand, home))?.at;
}

/** A supported reader that answers over a pipe or a request already open. */
export type LiveRead = (signal?: AbortSignal) => Promise<RateLimits | undefined>;

/**
 * One activity-driven read, if one is due machine-wide; answers when the next
 * is due. Only an answer with a figure counts as an observation, and only it
 * stamps. A failure keeps the last reading and backs off live reads alone.
 */
export async function readLive(
  entry: { brand: BrandId; source: UsageSource; generation?: string },
  hint: LiveHint,
  read: LiveRead,
  opts: { now: number; home?: string; signal?: AbortSignal; clock?: () => number }
): Promise<number | undefined> {
  const { brand, source } = entry;
  const clock = opts.clock ?? Date.now;
  await coordination.settle(brand, opts.home);
  const generation = entry.generation ?? (await coordination.generation(brand, opts.home));
  const admitted = await coordination.admitLive(brand, opts.home, opts.now, {
    generation,
    hint,
    observedAt: () => observedAt(brand, opts.home)
  });
  if (!('attempt' in admitted)) return admitted.after;
  let observed = false;
  try {
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(LIVE_TIMEOUT_MS)])
      : AbortSignal.timeout(LIVE_TIMEOUT_MS);
    const reading = await read(signal).catch(() => undefined);
    if (reading && !opts.signal?.aborted) {
      // A figureless answer still carries its rollover; it backs off as a failure.
      const stamped = stampWindows(reading, reading.at ?? clock());
      await noteReading(brand, stamped, {
        home: opts.home,
        refreshMs: source.everyMs,
        generation: admitted.attempt.generation,
        from: 'live'
      });
      observed = stamped.windows.some((window) => typeof window.pct === 'number');
    }
  } finally {
    await coordination.completeLive(brand, opts.home, admitted.attempt, clock(), observed);
  }
  return liveDue({
    ...hint,
    observedAt: await observedAt(brand, opts.home),
    activeAfter: (await coordination.readState(brand, opts.home))?.activeAfter
  });
}

/** Another window's file event invalidates memory. The disk reading stands. */
export function invalidate(brand?: BrandId): void {
  if (brand) held.delete(brand);
  else held.clear();
}

/**
 * Sign-out, and tests. **The only path that deletes a figure**, so that a poll
 * reading a credential mid-rewrite cannot: `auth.json` is rewritten whole on
 * every token refresh, and a status read landing inside that window used to look
 * exactly like a sign-out.
 */
export async function forgetUsageFor(brand: BrandId, home?: string): Promise<void> {
  held.delete(brand);
  await coordination.mutate(brand, home, async (state) => {
    state.generation = crypto.randomUUID();
    state.notBefore = 0;
    delete state.activeAfter;
    await forgetStoredUsage(brand, home);
  });
}

/**
 * Narrowed the way every other file read here is: it was written by a build of
 * this that may not be this one, so every field is checked rather than trusted.
 * `Number.isFinite` rather than `typeof === 'number'` because
 * `JSON.parse('{"pct":1e999}')` is `Infinity`, and a bar cannot be drawn to it.
 */
function narrow(record: unknown): RateLimits | undefined {
  const value = record as { windows?: unknown; at?: unknown } | undefined;
  if (!Array.isArray(value?.windows)) return undefined;
  const windows: RateWindow[] = [];
  for (const raw of value.windows) {
    const read = raw as {
      id?: unknown;
      short?: unknown;
      pct?: unknown;
      resetsAt?: unknown;
      at?: unknown;
    };
    if (typeof read?.id !== 'string' || typeof read?.short !== 'string') continue;
    const window: RateWindow = { id: read.id, short: read.short };
    if (read.pct === null) window.pct = null;
    else if (Number.isFinite(read.pct)) window.pct = read.pct as number;
    if (Number.isFinite(read.resetsAt)) window.resetsAt = read.resetsAt as number;
    // Refused for the same reason the reading's own stamp is: a window dated
    // ahead of every reading to come would hold the store against all of them.
    if (Number.isFinite(read.at) && (read.at as number) <= Date.now()) {
      window.at = read.at as number;
    }
    windows.push(window);
  }
  if (!windows.length) return undefined;
  // Not in the future. Age is the only thing that retires a window with no reset
  // time of its own, and a clock stepped forward once would write an age that
  // never arrives — and a stamp ahead of every reading to come would hold the
  // store against all of them.
  const at = value?.at;
  return Number.isFinite(at) && (at as number) <= Date.now()
    ? { at: at as number, windows }
    : { windows };
}
