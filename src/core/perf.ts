/**
 * What the panel spent, and how many times it spent it.
 *
 * Scaffolding for `TASK_done_panel_repaint_cost.md`, which is a task about
 * removing work rather than making work faster — so **the call count is the
 * measurement** and the milliseconds are the sanity check beside it. A phase
 * that halves the time but leaves the count alone has not done what it claimed.
 *
 * Always accumulating, never reporting. Two integer adds per recorded event is
 * far below anything either side of the wire can notice, and a counter that is
 * only live behind a setting is a counter nobody has running when they finally
 * want to know. `Squadron: Log Performance Counters` is what reads them, and
 * reading resets — so a reading is always "since the last reading", and the
 * before/after of a phase is two invocations a minute apart rather than
 * arithmetic on two cumulative totals.
 *
 * Deliberately free of `vscode` imports: the host records into it and the
 * command formats it, but neither fact belongs in here.
 */

/**
 * Every counter this side keeps, spelled once.
 *
 * `ps` is one process-table scan actually spawned (`core/scan.ts`), whoever
 * asked; `remote` is one Remote pass in the holder window (`host/remote.ts`).
 *
 * A union rather than a bare `string`: the call sites are in several files, a
 * mistyped name is a brand-new counter that reads zero, and a reading that
 * silently lost its subject is worse than no reading. It also makes the report's
 * contents discoverable from here.
 */
type CounterName =
  | 'discovery'
  | 'threadRead'
  | 'thread'
  | 'refresh'
  | `refresh:${RefreshVia}`
  | 'post'
  | 'state'
  | 'skipped'
  | 'ps'
  | 'remote'
  | 'startup';

/**
 * Which clock asked for a refresh.
 *
 * The count is the measurement, and `refresh` alone cannot carry it: 214/min
 * against a 3 s poll says only that ~190 of them came from somewhere else, and
 * each driver is rate-limited on a different constant. Named here rather than
 * at the call sites so the report's vocabulary stays in one file.
 */
export type RefreshVia = 'poll' | 'owned' | 'watch' | 'tickets' | 'remote' | 'ui';

type Counter = { calls: number; ms: number; bytes: number };

const counters = new Map<string, Counter>();

/** When the window being measured began — the last `reset`, or module load. */
let since = Date.now();

/**
 * One event. `ms` for anything worth timing, `bytes` for anything that crosses
 * the wire; both default to zero because most call sites only have a count to
 * give, and a count is the thing being watched.
 */
export function record(name: CounterName, ms = 0, bytes = 0): void {
  const counter = counters.get(name) ?? { calls: 0, ms: 0, bytes: 0 };
  counter.calls += 1;
  counter.ms += ms;
  counter.bytes += bytes;
  counters.set(name, counter);
}

/**
 * The window, as lines. Rates rather than totals — the reading is taken over
 * whatever interval the reader happened to leave between two invocations, and
 * "60 paints a minute" is comparable across two of those where "180 paints" is
 * not.
 *
 * Sorted by name so two readings line up when read side by side.
 */
export function report(): string {
  const seconds = Math.max(1, (Date.now() - since) / 1000);
  const lines = [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { calls, ms, bytes }]) => {
      const rate = ((calls / seconds) * 60).toFixed(1);
      const avg = calls ? (ms / calls).toFixed(1) : '0.0';
      const weight = bytes ? `  ${(((bytes / seconds) * 60) / 1024).toFixed(0)} KB/min` : '';
      return `  ${name.padEnd(14)} ${rate.padStart(7)}/min  ${calls
        .toString()
        .padStart(5)} calls  ${avg.padStart(6)}ms avg${weight}`;
    });
  const head = `perf — ${seconds.toFixed(0)}s window`;
  return lines.length ? [head, ...lines].join('\n') : `${head}\n  (nothing recorded)`;
}

/** Start a new window. Called by the reader, so a reading never overlaps one. */
export function reset(): void {
  counters.clear();
  since = Date.now();
}
