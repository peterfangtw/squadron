/** Dating normalized rate-limit readings; native decoding belongs to each brand. */

import type { RateLimits, RateWindow } from './model';

/**
 * A reading as one source has just stated it, dated window by window.
 *
 * **Every window, figure or not.** A window with no figure still says the brand
 * has one and may name the period, and `mergeReadings` weighs both by age — so
 * a window left undated has its age inferred from the reading it sits in, which
 * is the stamp inheritance `RateWindow.at` exists to end.
 *
 * Exported for the sources that state a reading of their own: the pipe's round
 * trip (`live.withUsage`), and whatever `walkUsage` gets back from a port that
 * names no clock at all.
 */
export function stampWindows(view: RateLimits, at: number): RateLimits {
  return {
    at,
    // Fills, never overwrites. A source that dated its windows itself knows
    // something this caller does not — one reading can carry windows of
    // different ages once they have been merged — and re-dating them here would
    // flatten exactly the distinction the stamp is for.
    windows: view.windows.map((window) => (window.at === undefined ? { ...window, at } : window))
  };
}

/**
 * The newest figure for each window, out of however many readings there are.
 *
 * One rule, one axis: **per window**, the figure with the later stamp wins.
 * Callers pass what they held first and what they just read second, so a tie
 * falls to the later arrival, and an unstamped figure ranks oldest — a record
 * left by a build that stamped nothing losing to any live reading is the right
 * end for it.
 *
 * `RateWindow.at` is per window, so a carried figure keeps its own age and
 * outranks nothing (why not by figure: `core/usage.ts`'s header).
 *
 * What made per-window merging worth it, observed 2026-09-10: a `get_usage` answer
 * came back stating `seven_day` alone. `foldRateLimits` always emits both
 * windows, so it arrived as a figureless `session` beside it — and taking the
 * reading whole threw away a five-hour figure read minutes earlier. The nav chip
 * drew `5h -` until the next poll. A window a reading has no figure for is not
 * an observation of that window; it is the brand stating it *has* one.
 *
 * **A stated reset time that differs retires the figure it would have carried.**
 * That is the rollover case (`grokUsageFrom`, Grok at a period boundary): the
 * figure held is last period's, which is not evidence about this one. Without
 * this clause the merge would carry it forward and `currentUsage` would have to
 * clear it again on a reset time that has passed; with it, the two agree.
 */
export function mergeReadings(views: readonly (RateLimits | undefined)[]): RateLimits | undefined {
  // Figures and declarations apart, because what they mean is not the same and
  // only one of them is a reading of a number. Both are decided by age alone, so
  // neither depends on the order `views` happens to arrive in — `noteReading`
  // passes held-then-read, but `walkUsage` maps a board of sessions in whatever
  // order discovery found them. Equal stamps fall to the last arrival, which is
  // deliberate for `noteReading`'s pair and arbitrary for `walkUsage`'s list.
  const figures = new Map<string, RateWindow>();
  const declarations = new Map<string, RateWindow>();
  for (const view of views) {
    if (!view?.windows.length) continue;
    for (const window of view.windows) {
      const at = window.at ?? view.at;
      const into = window.pct === undefined ? declarations : figures;
      const held = into.get(window.id);
      if (!held || (held.at ?? 0) <= (at ?? 0)) {
        into.set(window.id, at === undefined ? { ...window } : { ...window, at });
      }
    }
  }

  const merged = new Map<string, RateWindow>();
  // A window with no figure states that the brand *has* this window — which is
  // what draws a dash rather than nothing — and, when it names a reset time,
  // which period we are in now.
  for (const [id, declaration] of declarations) merged.set(id, declaration);
  for (const [id, figure] of figures) {
    const declaration = declarations.get(id);
    // The rollover: a newer reading naming a *later* period than the figure is
    // of. Last period's figure is not evidence about this one, so the window
    // keeps its name and loses its number. Later and not merely different —
    // without that a declaration restating an old period would retire a live
    // figure and leave its own spent reset time behind in place of it.
    const superseded =
      declaration !== undefined &&
      declaration.resetsAt !== undefined &&
      declaration.resetsAt > (figure.resetsAt ?? 0) &&
      (declaration.at ?? 0) > (figure.at ?? 0);
    if (!superseded) merged.set(id, figure);
  }
  if (!merged.size) return undefined;
  // **By id, so one record of one account is one string.** Without this the
  // order is `merged`'s insertion order, and `merged` is seeded from the
  // declarations — so whichever window a reading *declared* took the front slot
  // and kept it, whatever order the held record had. Comparing the resulting
  // list made a source alternating which window it drops rewrite the
  // file for no change in any figure: 5 writes in 6 passes, measured. A held
  // reading does not pin it, since its figures are set into a map those
  // declarations already seeded (review, 2026-09-10).
  //
  // Paint order is not lost by it: `inPaintOrder` imposes the adapter's on the
  // way out, which is the only order a reader ever sees.
  const windows = [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The reading's own stamp is what the accounts row draws as "updated 2m ago":
  // the last time a figure was observed. Each view's `at` counts, so a rollover
  // that retires the figure it came from keeps the account's age. A
  // declaration's stamp does not: no number was observed (`noteReading`).
  const at = [
    ...views.map((view) => view?.at),
    ...windows.filter((window) => typeof window.pct === 'number').map((window) => window.at)
  ].reduce<number | undefined>(
    (newest, stamp) => (stamp === undefined ? newest : Math.max(newest ?? 0, stamp)),
    undefined
  );
  return at === undefined ? { windows } : { at, windows };
}
