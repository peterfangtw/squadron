import { USAGE_REFRESH_MS } from '../usage_policy';
/**
 * Claude plan usage decoding, polling interval and reading lifetime.
 *
 * A reading comes off an owned session's pipe: `rate_limit_event` pushes one
 * with an API response, and `get_usage` answers when shared refresh policy asks
 * after activity or on the hourly fallback. `usage_reader.ts` supplies a
 * control-only temporary child for the fallback when no owned session can answer.
 *
 * **Nothing here keeps a reading.** What is held between polls, what is written
 * to disk and what is dropped is `core/usage.ts`'s, once, for every brand.
 */

import type { RateLimits, Reading } from '../model';

export const USAGE_MS = USAGE_REFRESH_MS;

/**
 * How long a dated reading whose window states no reset time is believed.
 *
 * Believed at all because such a reading exists: `readUsage` yields no `resetsAt`
 * whenever the pipe's `resets_at` is missing or will not parse, and that is a
 * reading that reaches disk.
 *
 * Five hours because that is the shorter of the two windows, so nothing outlives
 * a window it could have been a reading of.
 */
export const NO_RESET_MS = 5 * 60 * 60 * 1000;

/**
 * The windows this CLI states, named once. `id` is what the tip prints and what
 * a stored reading is matched on; `short` is what the chip prints. Exported
 * because a signed-in account with no reading yet still says which windows it
 * has, so the chip can draw a dash per window rather than nothing at all.
 */
export const CLAUDE_WINDOWS = [
  { id: 'session', short: '5h' },
  { id: 'weekly', short: 'wk' }
] as const;

/**
 * The plan's two windows out of a `get_usage` response.
 *
 * `utilization` is a whole-number percentage and `resets_at` is ISO 8601,
 * where `RateLimits` holds `pct` and epoch seconds — so this converts, and
 * `RateLimits` keeps meaning one thing.
 */
export function readUsage(payload: unknown): RateLimits | undefined {
  const answer = payload as
    { rate_limits?: Record<string, unknown>; rate_limits_available?: unknown } | null | undefined;
  // The CLI says whether the record it is handing over means anything, and that
  // is not the same question as whether the record is populated — a plan with no
  // limits answers `false` beside figures that are not the reader's.
  if (answer?.rate_limits_available === false) {
    return undefined;
  }
  return foldRateLimits(answer?.rate_limits);
}

/**
 * The quota a `rate_limit_event` carries, from 2.1.309's `unifiedWindows`.
 *
 * `utilization` here is a fraction of the whole-number percentage `get_usage`
 * answers in the same process, and `resetsAt` is already epoch seconds
 * (`reference/cli_state/usage_live_probe_2026-10-26.md`). Only the windows the
 * event carried are stated, since a window it omits was not observed. An event
 * with no `unifiedWindows` is a reset hint and no reading.
 */
export function readRateLimitEvent(info: unknown): RateLimits | undefined {
  const windows = (info as { unifiedWindows?: unknown } | null | undefined)?.unifiedWindows as
    { five_hour?: unknown; seven_day?: unknown } | null | undefined;
  const read = [
    [CLAUDE_WINDOWS[0], eventWindow(windows?.five_hour)],
    [CLAUDE_WINDOWS[1], eventWindow(windows?.seven_day)]
  ] as const;
  const stated = read.flatMap(([name, reading]) => (reading ? [{ ...name, ...reading }] : []));
  return stated.length ? { windows: stated } : undefined;
}

function eventWindow(value: unknown): Reading | undefined {
  const window = value as { utilization?: unknown; resetsAt?: unknown } | undefined;
  if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) {
    return undefined;
  }
  const pct = Math.round(window.utilization * 10_000) / 100;
  return typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
    ? { pct, resetsAt: window.resetsAt }
    : { pct };
}

/**
 * The panel's `session` and `weekly` out of the CLI's `five_hour` and
 * `seven_day`.
 *
 * The record carries a dozen more mostly-null windows (`seven_day_opus`,
 * `tangelo`, …); they are a bag that will grow, so the two that matter are read
 * by name and the rest ignored.
 *
 * Nothing rather than an empty pair when neither window read: the caller's
 * question is whether there is a reading to show, and `{}` answers it wrongly
 * every time.
 */
function foldRateLimits(
  limits: { five_hour?: unknown; seven_day?: unknown } | null | undefined
): RateLimits | undefined {
  const session = readWindow(limits?.five_hour);
  const weekly = readWindow(limits?.seven_day);
  if (!session && !weekly) return undefined;
  return {
    windows: [
      { ...CLAUDE_WINDOWS[0], ...session },
      { ...CLAUDE_WINDOWS[1], ...weekly }
    ]
  };
}

function readWindow(value: unknown): Reading | undefined {
  const window = value as { utilization?: unknown; resets_at?: unknown } | undefined;
  if (typeof window?.utilization !== 'number') {
    return undefined;
  }
  const at = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
  return {
    pct: window.utilization,
    resetsAt: Number.isNaN(at) ? undefined : Math.floor(at / 1000)
  };
}
