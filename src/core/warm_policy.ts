import { mapBrands } from './brands';
import type { BrandId, WarmTurn } from './model';

/** What the warmer times against: each brand's cache lifetime, how long before
 *  it ends a ping goes, and how long after the last real turn pings go on. */
export type WarmPolicy = {
  ttlMs: Readonly<Record<BrandId, number>>;
  marginMs: number;
  windowMs: number;
};

/** The settings' bounds, in the whole minutes they are typed in. */
export const WARM_LIMITS = {
  // Not 1: `cli/wait_plan.ts` budgets TTL − TTL/12 − 60 s, negative below 2.
  ttlMinutes: { min: 2, max: 180 },
  bufferMinutes: { min: 1, max: 30 },
  windowMinutes: { min: 10, max: 480 }
} as const;

const MINUTE_MS = 60_000;

/** Where a brand's default cache lifetime comes from: its vendor's docs, or
 *  our own timed probes, which bracket it between the longest idle that still
 *  read the cache and the shortest that did not. */
export type CacheBasis =
  | { minutes: number; basis: 'documented' }
  | { minutes: number; basis: 'observed'; heldMin: number; missedMin: number };

// Provenance: docs/reference/cli_state/{claude,grok,codex}/cache.md.
export const CACHE_BASIS: Readonly<Record<BrandId, CacheBasis>> = {
  claude: { minutes: 60, basis: 'documented' },
  // Held at 35 (2026-10-08) and 32 (2026-10-14); missed from 41.5. Nothing
  // between 36 and 41 has been timed, 40 included.
  codex: { minutes: 35, basis: 'observed', heldMin: 35, missedMin: 41.5 },
  // Held at 11 and missed at 13, 15 and 17 (2026-10-14, gaps on time).
  grok: { minutes: 10, basis: 'observed', heldMin: 11, missedMin: 13 }
};

export const DEFAULT_WARM_POLICY: WarmPolicy = {
  ttlMs: mapBrands((brand) => CACHE_BASIS[brand].minutes * MINUTE_MS),
  marginMs: 5 * MINUTE_MS,
  windowMs: 120 * MINUTE_MS
};

export const WARM_HIT_SHARE = 0.9;
export const WARM_MISS_SHARE = 0.5;

/** Settings as stored — `{ ttlMinutes: { claude, codex, grok }, bufferMinutes,
 *  windowMinutes }` — or whatever a hand-edited `settings.json` holds instead.
 *  Each field rounds then clamps; one that is not a finite number is its
 *  default, without disturbing the others. */
export function warmPolicy(raw: unknown): WarmPolicy {
  const fields = record(raw);
  const ttl = record(fields.ttlMinutes);
  const ttlMs = (brand: BrandId): number =>
    minutes(ttl[brand], WARM_LIMITS.ttlMinutes, DEFAULT_WARM_POLICY.ttlMs[brand]);
  return {
    ttlMs: mapBrands(ttlMs),
    marginMs: minutes(
      fields.bufferMinutes,
      WARM_LIMITS.bufferMinutes,
      DEFAULT_WARM_POLICY.marginMs
    ),
    windowMs: minutes(fields.windowMinutes, WARM_LIMITS.windowMinutes, DEFAULT_WARM_POLICY.windowMs)
  };
}

/** Each figure Warm's column edits, by the key the wire carries for it: the
 *  setting under `squadron.warmCache` it writes, and that setting's bounds. */
export type WarmSettingKey = `ttl:${BrandId}` | 'buffer' | 'window';

type WarmSettings = {
  readonly [B in BrandId as `ttl:${B}`]: {
    readonly setting: `ttlMinutes.${B}`;
    readonly limits: typeof WARM_LIMITS.ttlMinutes;
  };
} & {
  readonly buffer: {
    readonly setting: 'bufferMinutes';
    readonly limits: typeof WARM_LIMITS.bufferMinutes;
  };
  readonly window: {
    readonly setting: 'windowMinutes';
    readonly limits: typeof WARM_LIMITS.windowMinutes;
  };
};

export const WARM_SETTINGS: WarmSettings = {
  'ttl:claude': { setting: 'ttlMinutes.claude', limits: WARM_LIMITS.ttlMinutes },
  'ttl:codex': { setting: 'ttlMinutes.codex', limits: WARM_LIMITS.ttlMinutes },
  'ttl:grok': { setting: 'ttlMinutes.grok', limits: WARM_LIMITS.ttlMinutes },
  buffer: { setting: 'bufferMinutes', limits: WARM_LIMITS.bufferMinutes },
  window: { setting: 'windowMinutes', limits: WARM_LIMITS.windowMinutes }
};

export const WARM_TTL_KEYS: { readonly [B in BrandId]: `ttl:${B}` } = {
  claude: 'ttl:claude',
  codex: 'ttl:codex',
  grok: 'ttl:grok'
};

/** A figure the webview sent back, as the setting to write. The key is looked
 *  up, never spliced into a path; the value rounds and clamps as `warmPolicy`
 *  reads it. Nothing to write for an unlisted key or a non-number. */
export function warmSettingWrite(
  key: unknown,
  value: unknown
): { setting: string; minutes: number } | undefined {
  // `Object.hasOwn` coerces: `['buffer']` would match, and an object with no
  // `toString` would throw.
  if (typeof key !== 'string' || !Object.hasOwn(WARM_SETTINGS, key)) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const { setting, limits } = WARM_SETTINGS[key as WarmSettingKey];
  return { setting, minutes: clamped(value, limits) };
}

function minutes(value: unknown, limits: { min: number; max: number }, fallbackMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackMs;
  return clamped(value, limits) * MINUTE_MS;
}

function clamped(value: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Tiny shared-prefix reads do not prove the conversation survived. Missing
 *  counts remain unknown; Phase C's evidence thresholds are centralized here. */
export function warmVerdict(warm: WarmTurn): 'hit' | 'partial' | 'miss' | 'unknown' {
  if (warm.cached === undefined || warm.prefix === undefined || warm.prefix <= 0) return 'unknown';
  if (warm.cached >= warm.prefix * WARM_HIT_SHARE) return 'hit';
  return warm.cached < warm.prefix * WARM_MISS_SHARE ? 'miss' : 'partial';
}
