/**
 * How many times this half repainted, and of what.
 *
 * Scaffolding for `TASK_done_panel_repaint_cost.md`. Counts only — no
 * milliseconds and no formatting — because the task is about repaints that
 * should never have happened, and the browser's own devtools already time the
 * ones that should. An idle minute reading 60 paints instead of a handful is
 * the entire finding.
 *
 * Its own file rather than `core/perf.ts`, which is the host's: `src/AGENTS.md`
 * keeps `core/markers.ts` as the only `core/` module this bundle imports, and a
 * counter is not worth spending that. The two never need to agree — they are
 * different processes with different questions, and each is read where it runs.
 *
 * Read it from the webview's devtools console:
 *
 *     squadronPerf.reset()
 *     squadronPerf.report()   // { seconds: 62, push: 21, paint: 82, ... }
 *
 * `report()` and not `counts`, because a count with no window is two unknowns
 * and one equation. The first reading taken here was 121 paints and 56
 * renderThreads over a window nobody wrote down, and the two ways of solving
 * for it disagreed — `paint` is driven by both the 1s beat and the push, and
 * `holding()` drops some of the beat's before they reach it. So the window is
 * kept, `push` and `tick` are counted beside the repaints they cause, and the
 * report states rates per minute the way the host's does. `counts` is still
 * there, raw, for anything the arithmetic hides.
 *
 * Always counting. One property increment per repaint is far below anything a
 * frame can notice, and a counter that only runs behind a flag is one nobody
 * has running when they want to know.
 */

const counts: Record<string, number> = {};

/** When the window being read began — the last `reset`, or the bundle's load. */
let since = Date.now();

/** One repaint of `name`. */
export function record(name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

/**
 * The window, as rates per minute, with the window's own length beside them so
 * a reading can be checked rather than trusted. Rounded to one decimal for the
 * same reason the host's is: two readings are meant to be read side by side.
 */
function report(): Record<string, number> {
  const seconds = Math.max(1, (Date.now() - since) / 1000);
  const out: Record<string, number> = { seconds: Math.round(seconds) };
  for (const [name, calls] of Object.entries(counts)) {
    out[`${name}/min`] = Math.round((calls / seconds) * 600) / 10;
  }
  return out;
}

/** Start a new window, so a reading is always "since the last reset". */
function reset(): void {
  for (const key of Object.keys(counts)) delete counts[key];
  since = Date.now();
}

// Hung off the global on purpose: the host's `Squadron: Log Performance
// Counters` cannot reach into this process, so the console is the reader.
Object.assign(globalThis, { squadronPerf: { counts, report, reset } });
