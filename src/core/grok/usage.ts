import { USAGE_REFRESH_MS } from '../usage_policy';
/**
 * Grok account weekly credit window.
 *
 * Source is HTTP, not a dump and not ACP. Observed 2026-08-16, CLI 1.0.4:
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with Bearer
 * from `auth.json` nested `key`. Missing `creditUsagePercent` is no reading,
 * not 0 (rollover). See `docs/reference/cli_state/grok/usage.md`.
 */

import type { RateLimits } from '../model';
import { grokAccessToken, refreshGrokBearer, unexpired, type GrokBearer } from './auth';

export const GROK_USAGE_MS = USAGE_REFRESH_MS;

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

/**
 * What Grok says about each window the panel can draw.
 *
 * `creditUsagePercent` against one `currentPeriod` is the whole of what the
 * billing body states, so the 5-hour window is not missing — Grok does not have
 * one, and `pct: null` is how a record says that. The chip draws `5h none`,
 * which is a different claim from `5h -`.
 */
export const GROK_SESSION = { id: 'session', short: '5h', pct: null } as const;
export const GROK_WINDOW = { id: 'weekly', short: 'wk' } as const;

/** Fold a billing body. Unusable → undefined. No percent → windows only. */
export function grokUsageFrom(body: unknown): RateLimits | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const config = (body as Record<string, unknown>).config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const rec = config as Record<string, unknown>;
  let resetsAt: number | undefined;
  const period = rec.currentPeriod;
  if (period && typeof period === 'object' && !Array.isArray(period)) {
    const end = (period as Record<string, unknown>).end;
    if (typeof end === 'string') {
      const ms = Date.parse(end);
      if (Number.isFinite(ms)) resetsAt = Math.floor(ms / 1000);
    }
  }
  const pct = rec.creditUsagePercent;
  // A missing percent is rollover, not 0: the window is still Grok's, we simply
  // have no figure for it, which is the same record with `pct` left off.
  const window = Number.isFinite(pct) ? { ...GROK_WINDOW, pct: pct as number } : { ...GROK_WINDOW };
  return {
    windows: [{ ...GROK_SESSION }, resetsAt === undefined ? window : { ...window, resetsAt }]
  };
}

/** Renewal, as a seam of its own. Separate from `GrokFetch` below because the
 *  token POST needs a method, a form body, a content type and a signal, none of
 *  which that type can express. */
export type GrokRefresh = (opts: { home?: string }) => Promise<GrokBearer | undefined>;

/** The GET this needs, narrowed to what it uses — so a test hands over a
 *  function rather than standing up a server. */
export type GrokFetch = (
  url: string,
  init?: { headers?: { Authorization?: string }; signal?: AbortSignal }
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * One reading, or nothing — the shape the seam asks for.
 *
 * **Touches no store.** Every failure this can have is the same answer: a
 * refusal to renew, a file rewritten mid-read, a body that will not fold. None
 * of them is news about the account, and none of them is grounds to drop a
 * figure that is already written down.
 *
 * The bearer lives ~6h. `refreshGrokBearer` renews it when its stated expiry
 * has passed, so an afternoon with no Grok on the machine is no longer an
 * afternoon of 401s — but renewal spends a rotating refresh token, so it is
 * attempted only on evidence of expiry, never on a guess. A bearer that states
 * no expiry is sent as it stands.
 */
export async function readGrokUsage(opts?: {
  home?: string;
  fetch?: GrokFetch;
  refresh?: GrokRefresh;
  signal?: AbortSignal;
}): Promise<RateLimits | undefined> {
  if (opts?.signal?.aborted) return undefined;
  const bearer = await grokAccessToken(opts?.home);
  if (!bearer) return undefined;
  if (unexpired(bearer)) return billing(bearer.key, opts?.fetch, opts?.signal);
  // Expired: only a renewed key is worth a request. Sending the old one buys a
  // 401 and drops the reading we already have.
  const renewed = await (opts?.refresh ?? refreshGrokBearer)({ home: opts?.home });
  return renewed ? billing(renewed.key, opts?.fetch, opts?.signal) : undefined;
}

async function billing(
  token: string,
  get: GrokFetch = fetch,
  signal?: AbortSignal
): Promise<RateLimits | undefined> {
  try {
    const res = await get(BILLING_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000)
    });
    return res.ok ? grokUsageFrom(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long a Grok reading that states no reset of its own is believed.
 *
 * The period, because that is the only window this brand has — the 5-hour slot
 * on the chip is `pct: null`, a window Grok does not have rather than one we
 * have no figure for. A reading gets here only when `currentPeriod` is missing
 * or will not parse, which has not been observed.
 */
export const GROK_NO_RESET_MS = 7 * 24 * 60 * 60 * 1000;
