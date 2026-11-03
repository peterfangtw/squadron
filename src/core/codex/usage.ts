import { stampWindows } from '../limits';
import { USAGE_REFRESH_MS } from '../usage_policy';
/** Canonical Codex plan rate limits. Token activity is deliberately not quota. */

import type { RateLimits, RateWindow } from '../model';
import { connectCodex, type CodexConnector } from './runtime';

/** How often `account/rateLimits/read` is spent — and with it an app-server
 *  child, which is what makes this the expensive read of the three. */
export const CODEX_USAGE_MS = USAGE_REFRESH_MS;
export const CODEX_NO_RESET_MS = 7 * 24 * 60 * 60 * 1000;
export const CODEX_SESSION = { id: 'session', short: '5h', pct: null } as const;
export const CODEX_WEEKLY = { id: 'weekly', short: 'wk' } as const;
export const CODEX_WINDOWS = [CODEX_SESSION, CODEX_WEEKLY] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function windowName(minutes: number): Pick<RateWindow, 'id' | 'short'> {
  if (minutes === 300) return { id: 'session', short: '5h' };
  if (minutes === 10_080) return { id: 'weekly', short: 'wk' };
  if (minutes % 1_440 === 0) return { id: `${minutes}-minute`, short: `${minutes / 1_440}d` };
  return { id: `${minutes}-minute`, short: `${minutes}m` };
}

function rateWindow(value: unknown): RateWindow | undefined {
  if (!isRecord(value)) return undefined;
  const pct = finite(value.usedPercent);
  const minutes = finite(value.windowDurationMins);
  if (pct === undefined || minutes === undefined || minutes <= 0) return undefined;
  const resetsAt = finite(value.resetsAt);
  return {
    ...windowName(minutes),
    pct: Math.max(0, Math.min(100, pct)),
    ...(resetsAt !== undefined ? { resetsAt } : {})
  };
}

export function codexRateLimits(value: unknown): RateLimits | undefined {
  if (!isRecord(value) || !isRecord(value.rateLimits)) return undefined;
  const parsed = [
    rateWindow(value.rateLimits.primary),
    rateWindow(value.rateLimits.secondary)
  ].filter((window): window is RateWindow => window !== undefined);
  if (!parsed.length) return undefined;
  const unique = new Map<string, RateWindow>();
  for (const window of parsed) unique.set(window.id, window);

  // The account surface has a stable pair of slots. A canonical snapshot with
  // only a weekly window states that this account has no general 5-hour limit,
  // rather than leaving the reader to interpret a missing column. Preserve a
  // real 5-hour reading when one is present, then keep any future window types
  // after the familiar pair instead of dropping protocol data we understand.
  const session = unique.get(CODEX_SESSION.id) ?? CODEX_SESSION;
  const weekly = unique.get(CODEX_WEEKLY.id);
  const rest = [...unique.values()].filter(
    (window) => window.id !== CODEX_SESSION.id && window.id !== CODEX_WEEKLY.id
  );
  return { windows: [session, ...(weekly ? [weekly] : []), ...rest] };
}

export async function readCodexUsage(
  override?: string,
  connector: CodexConnector = () => connectCodex(override, undefined, options),
  options: import('../temporary_session').TemporaryRead = {}
): Promise<RateLimits | undefined> {
  const opened = await connector();
  if (!opened.ok) return undefined;
  try {
    const reading = codexRateLimits(
      await opened.connection.client.request(
        'account/rateLimits/read',
        undefined,
        undefined,
        options.signal
      )
    );
    return reading ? stampWindows(reading, Date.now()) : undefined;
  } catch {
    return undefined;
  } finally {
    opened.connection.close();
    await opened.connection.settled?.();
  }
}

export function codexUsageNotification(value: unknown): RateLimits | undefined {
  if (!isRecord(value) || !isRecord(value.rateLimits) || value.rateLimits.limitId !== 'codex')
    return undefined;
  return codexRateLimits(value);
}
