import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { BRANDS } from '../../core/brands';
import * as cache from '../../core/cache_ttl';
import * as policy from '../../core/warm_policy';
import { repoRoot } from '../helpers';

const MIN = 60_000;

describe('warm policy normaliser', () => {
  it('defaults every field when nothing is set', () => {
    const expected = {
      ttlMs: { claude: 60 * MIN, codex: 35 * MIN, grok: 10 * MIN },
      marginMs: 5 * MIN,
      windowMs: 120 * MIN
    };
    assert.deepEqual(policy.DEFAULT_WARM_POLICY, expected);
    for (const raw of [undefined, null, {}, 'x', 42, []])
      assert.deepEqual(policy.warmPolicy(raw), expected, JSON.stringify(raw));
  });

  it('reads a full set of minutes', () => {
    assert.deepEqual(
      policy.warmPolicy({
        ttlMinutes: { claude: 5, codex: 45, grok: 10 },
        bufferMinutes: 2,
        windowMinutes: 90
      }),
      {
        ttlMs: { claude: 5 * MIN, codex: 45 * MIN, grok: 10 * MIN },
        marginMs: 2 * MIN,
        windowMs: 90 * MIN
      }
    );
  });

  it('rounds before it clamps', () => {
    const read = policy.warmPolicy({
      ttlMinutes: { claude: 29.5, codex: 179.6, grok: 1.6 },
      bufferMinutes: 4.4,
      windowMinutes: 480.4
    });
    assert.equal(read.ttlMs.claude, 30 * MIN);
    assert.equal(read.ttlMs.codex, 180 * MIN);
    assert.equal(read.ttlMs.grok, 2 * MIN);
    assert.equal(read.marginMs, 4 * MIN);
    assert.equal(read.windowMs, 480 * MIN);
  });

  it('clamps each field at both ends of its limits', () => {
    const { ttlMinutes, bufferMinutes, windowMinutes } = policy.WARM_LIMITS;
    const low = policy.warmPolicy({
      ttlMinutes: { claude: 1, codex: 0, grok: -50 },
      bufferMinutes: 0,
      windowMinutes: 9
    });
    assert.deepEqual(low.ttlMs, {
      claude: ttlMinutes.min * MIN,
      codex: ttlMinutes.min * MIN,
      grok: ttlMinutes.min * MIN
    });
    assert.equal(low.marginMs, bufferMinutes.min * MIN);
    assert.equal(low.windowMs, windowMinutes.min * MIN);
    const high = policy.warmPolicy({
      ttlMinutes: { claude: 181, codex: 1e9, grok: 999.6 },
      bufferMinutes: 31,
      windowMinutes: 10_000
    });
    assert.deepEqual(high.ttlMs, {
      claude: ttlMinutes.max * MIN,
      codex: ttlMinutes.max * MIN,
      grok: ttlMinutes.max * MIN
    });
    assert.equal(high.marginMs, bufferMinutes.max * MIN);
    assert.equal(high.windowMs, windowMinutes.max * MIN);
  });

  it('holds the limits the settings were agreed at', () => {
    assert.deepEqual(policy.WARM_LIMITS, {
      ttlMinutes: { min: 2, max: 180 },
      bufferMinutes: { min: 1, max: 30 },
      windowMinutes: { min: 10, max: 480 }
    });
  });

  it('falls back per field on anything but a finite number', () => {
    for (const bad of ['30', NaN, Infinity, -Infinity, true, null, {}, [30]]) {
      const read = policy.warmPolicy({
        ttlMinutes: { claude: bad, codex: bad, grok: bad },
        bufferMinutes: bad,
        windowMinutes: bad
      });
      assert.deepEqual(read, policy.DEFAULT_WARM_POLICY, JSON.stringify(bad));
    }
    assert.deepEqual(
      policy.warmPolicy({ ttlMinutes: 'all', bufferMinutes: 3 }).ttlMs,
      policy.DEFAULT_WARM_POLICY.ttlMs
    );
  });

  it('keeps the set fields of a partial object and defaults the rest', () => {
    assert.deepEqual(policy.warmPolicy({ ttlMinutes: { grok: 12 }, windowMinutes: 30 }), {
      ttlMs: { ...policy.DEFAULT_WARM_POLICY.ttlMs, grok: 12 * MIN },
      marginMs: policy.DEFAULT_WARM_POLICY.marginMs,
      windowMs: 30 * MIN
    });
  });

  it('defaults sit inside their own limits', () => {
    const read = policy.warmPolicy({
      ttlMinutes: {
        claude: policy.DEFAULT_WARM_POLICY.ttlMs.claude / MIN,
        codex: policy.DEFAULT_WARM_POLICY.ttlMs.codex / MIN,
        grok: policy.DEFAULT_WARM_POLICY.ttlMs.grok / MIN
      },
      bufferMinutes: policy.DEFAULT_WARM_POLICY.marginMs / MIN,
      windowMinutes: policy.DEFAULT_WARM_POLICY.windowMs / MIN
    });
    assert.deepEqual(read, policy.DEFAULT_WARM_POLICY);
  });
});

describe('default TTL table', () => {
  it('times every brand off the default policy, with a tip each', () => {
    for (const brand of BRANDS) {
      const row = cache.CACHE_TTL[brand];
      assert.ok(row, brand);
      assert.equal(row.ttlMs, policy.DEFAULT_WARM_POLICY.ttlMs[brand]);
      assert.ok(row.tip.length > 0, brand);
    }
    assert.match(cache.CACHE_TTL.grok?.tip ?? '', /held at 11 min, gone by 13/);
  });
});

describe('cache basis', () => {
  it('keeps every observed default at or below the longest idle that held', () => {
    for (const [brand, row] of Object.entries(policy.CACHE_BASIS)) {
      if (row.basis !== 'observed') continue;
      assert.ok(row.minutes <= row.heldMin, brand);
      assert.ok(row.heldMin < row.missedMin, brand);
    }
  });
});

describe('warm settings in package.json', () => {
  it('declare the default policy and its limits, application-wide', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot(), 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    const defaults = cache.warmConfig(policy.DEFAULT_WARM_POLICY);
    const figures = [...defaults.ttl, defaults.buffer, defaults.window];
    for (const [key, descriptor] of Object.entries(policy.WARM_SETTINGS)) {
      const figure = figures.find((row) => row.key === key);
      assert.ok(figure, key);
      const defaultMs = figure.defaultMinutes * MIN;
      const { limits } = descriptor;
      const setting = properties[`squadron.warmCache.${descriptor.setting}`];
      assert.ok(setting, key);
      assert.equal(setting.type, 'integer', key);
      assert.equal(setting.scope, 'application', key);
      assert.equal(setting.default, defaultMs / MIN, key);
      assert.equal(setting.minimum, limits.min, key);
      assert.equal(setting.maximum, limits.max, key);
    }
  });
});

describe('a warm setting typed in the column', () => {
  it('writes the setting its key lists, rounded and clamped to that setting', () => {
    assert.deepEqual(policy.warmSettingWrite('ttl:claude', 5), {
      setting: 'ttlMinutes.claude',
      minutes: 5
    });
    assert.deepEqual(policy.warmSettingWrite('ttl:codex', 999.6), {
      setting: 'ttlMinutes.codex',
      minutes: policy.WARM_LIMITS.ttlMinutes.max
    });
    assert.deepEqual(policy.warmSettingWrite('ttl:grok', 1.4), {
      setting: 'ttlMinutes.grok',
      minutes: policy.WARM_LIMITS.ttlMinutes.min
    });
    assert.deepEqual(policy.warmSettingWrite('buffer', 2.5), {
      setting: 'bufferMinutes',
      minutes: 3
    });
    assert.deepEqual(policy.warmSettingWrite('window', 0), {
      setting: 'windowMinutes',
      minutes: policy.WARM_LIMITS.windowMinutes.min
    });
  });

  it('writes nothing for a key it does not list', () => {
    for (const key of [
      'ttl:CLAUDE',
      'ttl:',
      'ttlMinutes.claude',
      'bufferMinutes',
      'enabled',
      '__proto__',
      'constructor',
      'toString',
      'buffer ',
      ''
    ])
      assert.equal(policy.warmSettingWrite(key, 10), undefined, key);
  });

  it('writes nothing for a key that is not a string, and does not throw on one', () => {
    // Structured-clone data from the webview: `Object.hasOwn` would coerce these.
    for (const key of [['buffer'], { toString: null, valueOf: null }, 7, null, undefined])
      assert.equal(policy.warmSettingWrite(key, 10), undefined, String(typeof key));
  });

  it('writes nothing for a value that is not a finite number', () => {
    for (const value of [NaN, Infinity, -Infinity, '30', null, undefined])
      assert.equal(policy.warmSettingWrite('buffer', value), undefined, String(value));
  });

  it('writes only settings package.json declares', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot(), 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    for (const key of Object.keys(policy.WARM_SETTINGS)) {
      const write = policy.warmSettingWrite(key, 10);
      assert.ok(write, key);
      assert.ok(properties[`squadron.warmCache.${write.setting}`], key);
    }
  });
});
