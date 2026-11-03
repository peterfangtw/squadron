import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandName } from '../../core/accounts';
import * as cache from '../../core/cache_ttl';
import {
  DEFAULT_WARM_POLICY,
  warmSettingWrite as writeOf,
  type WarmPolicy
} from '../../core/warm_policy';

const MIN = 60_000;

describe('cache TTL metadata', () => {
  it('reads every default as measured', () => {
    assert.deepEqual(cache.ttlFor('claude', DEFAULT_WARM_POLICY), {
      ttlMs: 60 * MIN,
      source: 'measured'
    });
    assert.deepEqual(cache.ttlFor('grok', DEFAULT_WARM_POLICY), {
      ttlMs: 10 * MIN,
      source: 'measured'
    });
    assert.deepEqual(cache.ttlFor('codex', DEFAULT_WARM_POLICY), {
      ttlMs: 35 * MIN,
      source: 'measured'
    });
  });
  it('reads a figure moved off its default as configured, and only that brand', () => {
    const policy: WarmPolicy = {
      ...DEFAULT_WARM_POLICY,
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, claude: 5 * MIN }
    };
    assert.deepEqual(cache.ttlFor('claude', policy), { ttlMs: 5 * MIN, source: 'configured' });
    assert.deepEqual(cache.ttlFor('codex', policy), { ttlMs: 35 * MIN, source: 'measured' });
  });
  it('has no deadline without an idle cache stamp', () => {
    assert.equal(cache.cacheUntil({}), undefined);
    assert.equal(cache.cacheUntil({ cache: { ttlMs: 30 * MIN, source: 'measured' } }), undefined);
    assert.equal(
      cache.cacheUntil({ cache: { ttlMs: 30 * MIN, source: 'measured', at: 1000 } }),
      1801000
    );
  });
  it('reads Warm configuration in Claude, Codex, Grok order, off the policy given', () => {
    const policy: WarmPolicy = {
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, grok: 12 * MIN },
      marginMs: 3 * MIN,
      windowMs: 90 * MIN
    };
    // Expected figures come from the defaults and the policy, not from cachePolicy.
    const expected = (['claude', 'codex', 'grok'] as const).map((brand) => ({
      brand,
      name: brandName(brand),
      minutes: policy.ttlMs[brand] / MIN,
      defaultMinutes: DEFAULT_WARM_POLICY.ttlMs[brand] / MIN,
      source: brand === 'grok' ? 'configured' : 'measured',
      tip: cache.CACHE_TTL[brand].tip
    }));
    const read = cache.cachePolicy(policy);
    assert.equal(read.bufferMin, 3);
    assert.equal(read.windowMin, 90);
    assert.deepEqual(read.rows, expected);
  });
  it('pushes each Warm figure with a key the host takes back, and its bounds', () => {
    const policy: WarmPolicy = {
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, codex: 20 * MIN },
      marginMs: 4 * MIN,
      windowMs: 45 * MIN
    };
    const config = cache.warmConfig(policy);
    assert.deepEqual(
      config.ttl.map((row) => [row.brand, row.minutes, row.defaultMinutes, row.source]),
      [
        ['claude', 60, 60, 'measured'],
        ['codex', 20, 35, 'configured'],
        ['grok', 10, 10, 'measured']
      ]
    );
    assert.deepEqual(
      [config.buffer.minutes, config.buffer.defaultMinutes],
      [4, DEFAULT_WARM_POLICY.marginMs / MIN]
    );
    assert.deepEqual(
      [config.window.minutes, config.window.defaultMinutes],
      [45, DEFAULT_WARM_POLICY.windowMs / MIN]
    );
    // Each figure's key writes that figure, and its bounds are the ones the host clamps to.
    for (const figure of [...config.ttl, config.buffer, config.window]) {
      assert.equal(writeOf(figure.key, figure.max + 1)?.minutes, figure.max, figure.key);
      assert.equal(writeOf(figure.key, figure.min - 1)?.minutes, figure.min, figure.key);
    }
    const settings = [...config.ttl, config.buffer, config.window].map(
      (figure) => writeOf(figure.key, figure.minutes)?.setting
    );
    assert.deepEqual(settings, [
      'ttlMinutes.claude',
      'ttlMinutes.codex',
      'ttlMinutes.grok',
      'bufferMinutes',
      'windowMinutes'
    ]);
  });
  it('does not use malformed published cache evidence', () => {
    for (const ttlMs of [0, -1, NaN, Infinity])
      assert.equal(cache.cacheUntil({ cache: { ttlMs, source: 'measured', at: 1000 } }), undefined);
    assert.equal(
      cache.cacheUntil({ cache: { ttlMs: 1000, source: 'measured', at: NaN } }),
      undefined
    );
  });
});
