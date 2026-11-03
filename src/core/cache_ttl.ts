import { BRANDS, mapBrands } from './brands';
import { brandName } from './accounts';
import type { BrandId, Session } from './model';
import {
  CACHE_BASIS,
  DEFAULT_WARM_POLICY,
  WARM_SETTINGS,
  WARM_TTL_KEYS,
  type WarmPolicy,
  type WarmSettingKey
} from './warm_policy';

/** A default is `measured`; a figure moved off it is `configured`. */
export type TtlSource = 'measured' | 'configured';
export type CacheTtlRow = {
  ttlMs: number;
  source: 'measured';
  /** One line on how far the default can be trusted, for the Warm column. */
  tip: string;
};

// Figures and their provenance: `CACHE_BASIS`.
export const CACHE_TTL: Readonly<Record<BrandId, CacheTtlRow>> = mapBrands(ttlRow);

function ttlRow(brand: BrandId): CacheTtlRow {
  const basis = CACHE_BASIS[brand];
  const tip =
    basis.basis === 'observed'
      ? `Based on observation testing: reuse held at ${basis.heldMin} min, gone by ${basis.missedMin}. Fluctuations may occur.`
      : `Based on Anthropic's docs: a ${basis.minutes}-minute cache. On 5-minute caches, set 5 and lower the buffer.`;
  return { ttlMs: DEFAULT_WARM_POLICY.ttlMs[brand], source: 'measured', tip };
}

export function validTtl(ttlMs: unknown): ttlMs is number {
  return typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0;
}

/** The one lifetime a session's cache is timed against. What the CLI reports
 *  on the wire is not read: the policy is the reader's to set. */
export function ttlFor(brand: BrandId, policy: WarmPolicy): { ttlMs: number; source: TtlSource } {
  const ttlMs = policy.ttlMs[brand];
  const row = CACHE_TTL[brand];
  return { ttlMs, source: ttlMs === row.ttlMs ? row.source : 'configured' };
}

export type CachePolicyRow = {
  brand: BrandId;
  name: string;
  minutes: number;
  defaultMinutes: number;
  source: TtlSource;
  tip: string;
};

export type CachePolicy = { bufferMin: number; windowMin: number; rows: CachePolicyRow[] };

const POLICY_RANK: Readonly<Record<BrandId, number>> = { claude: 0, codex: 1, grok: 2 };
const POLICY_ORDER = [...BRANDS].sort((a, b) => POLICY_RANK[a] - POLICY_RANK[b]);

/** The policy in minutes, each lifetime beside its default and the word for
 *  which it is. The column reads it through `warmConfig`. */
export function cachePolicy(policy: WarmPolicy): CachePolicy {
  return {
    bufferMin: policy.marginMs / 60_000,
    windowMin: policy.windowMs / 60_000,
    rows: POLICY_ORDER.map((brand) => {
      const row = CACHE_TTL[brand];
      const ttl = ttlFor(brand, policy);
      return {
        brand,
        name: brandName(brand),
        minutes: ttl.ttlMs / 60_000,
        defaultMinutes: row.ttlMs / 60_000,
        source: ttl.source,
        tip: row.tip
      };
    })
  };
}

/** One figure of the column, as the wire's `WarmFigureView` carries it. */
export type WarmFigure = {
  key: WarmSettingKey;
  minutes: number;
  defaultMinutes: number;
  min: number;
  max: number;
};
export type WarmConfig = {
  ttl: (CachePolicyRow & WarmFigure)[];
  buffer: WarmFigure;
  window: WarmFigure;
};

/** `cachePolicy` as the state push carries it: each figure with the key that
 *  writes it back and the bounds it is clamped to. */
export function warmConfig(policy: WarmPolicy): WarmConfig {
  const read = cachePolicy(policy);
  const bounds = (key: WarmSettingKey) => ({ key, ...WARM_SETTINGS[key].limits });
  return {
    ttl: read.rows.map((row) => ({ ...row, ...bounds(WARM_TTL_KEYS[row.brand]) })),
    buffer: {
      minutes: read.bufferMin,
      defaultMinutes: DEFAULT_WARM_POLICY.marginMs / 60_000,
      ...bounds('buffer')
    },
    window: {
      minutes: read.windowMin,
      defaultMinutes: DEFAULT_WARM_POLICY.windowMs / 60_000,
      ...bounds('window')
    }
  };
}

export function cacheUntil(session: Pick<Session, 'cache'>): number | undefined {
  const cache = session.cache;
  if (
    !cache ||
    !validTtl(cache.ttlMs) ||
    typeof cache.at !== 'number' ||
    !Number.isFinite(cache.at)
  )
    return undefined;
  const until = cache.at + cache.ttlMs;
  return Number.isFinite(until) ? until : undefined;
}
