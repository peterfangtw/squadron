import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { codexRateLimits, codexUsageNotification } from '../../core/codex/usage';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(`src/test/fixtures/codex-app-server-0.151.0/${name}`, 'utf8')
  ) as unknown;
}

describe('Codex usage', () => {
  it('maps only the canonical snapshot and ignores named extra buckets', () => {
    const raw = fixture('c5_usage.json') as {
      current: { rateLimits: { result: unknown } };
    };
    assert.deepEqual(codexRateLimits(raw.current.rateLimits.result), {
      windows: [
        { id: 'session', short: '5h', pct: null },
        { id: 'weekly', short: 'wk', pct: 0, resetsAt: 0 }
      ]
    });
    assert.equal(codexRateLimits({ rateLimits: { primary: { usedPercent: '0' } } }), undefined);
  });

  it('keeps a canonical 5-hour reading when the account supplies one', () => {
    assert.deepEqual(
      codexRateLimits({
        rateLimits: {
          primary: { usedPercent: 45, windowDurationMins: 10_080 },
          secondary: { usedPercent: 23, windowDurationMins: 300 }
        }
      }),
      {
        windows: [
          { id: 'session', short: '5h', pct: 23 },
          { id: 'weekly', short: 'wk', pct: 45 }
        ]
      }
    );
  });
  it('takes canonical quota notifications and ignores a named model bucket', () => {
    const rateLimits = { limitId: 'codex', primary: { usedPercent: 23, windowDurationMins: 300 } };
    assert.equal(codexUsageNotification({ rateLimits })?.windows[0]?.pct, 23);
    assert.equal(
      codexUsageNotification({ rateLimits: { ...rateLimits, limitId: 'model-bucket' } }),
      undefined
    );
  });
});
