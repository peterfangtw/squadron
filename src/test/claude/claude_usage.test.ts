import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as usage from '../../core/claude/usage';
import { tempHome, win, writeJson } from '../helpers';
let home: string;
before(async () => {
  home = await tempHome();
});
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe("Claude's own port", () => {
  // The dumps a typed `claude` writes are the one reading it used to take, and
  // Squadron does not know those sessions. One on disk must change nothing.
  it('never substitutes statusline dumps for an unavailable CLI', async () => {
    await writeJson(path.join(home, '.claude', 'squadron', `${randomUUID()}.json`), {
      rate_limits: { five_hour: { used_percentage: 40, resets_at: soon() } }
    });
    const { adapter } = await import('../../core/adapter');
    assert.equal(
      await adapter('claude')?.usage?.read(path.join(home, 'missing-claude')),
      undefined
    );
  });
});

describe('readUsage', () => {
  const payload = {
    subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 3, resets_at: '2026-07-27T16:19:59.620242+00:00' },
      seven_day: { utilization: 47, resets_at: '2026-07-31T08:00:00.620264+00:00' },
      seven_day_opus: null,
      tangelo: null
    }
  };

  it('reads both windows, converting the reset time the panel’s way', () => {
    // `utilization` is what the statusline dump calls `pct`, and `resets_at` is
    // ISO 8601 where the dump writes epoch seconds — so `UsageView` keeps
    // meaning one thing whichever source filled it.
    const reading = usage.readUsage(payload);
    assert.deepEqual(win(reading, 'session'), {
      id: 'session',
      short: '5h',
      pct: 3,
      resetsAt: Math.floor(Date.parse(payload.rate_limits.five_hour.resets_at) / 1000)
    });
    assert.equal(win(reading, 'weekly')?.pct, 47);
  });

  it('ignores the bag of windows that are not these two', () => {
    const reading = usage.readUsage({ rate_limits: { tangelo: { utilization: 99 } } });
    assert.equal(reading, undefined);
  });

  it('says nothing at all on a plan with no limits', () => {
    assert.equal(usage.readUsage(undefined), undefined);
    assert.equal(usage.readUsage('nonsense'), undefined);
  });

  /**
   * The CLI says whether the record it is handing over means anything, and it is
   * not the same question as whether the record is populated. This assertion used
   * to sit in the case above with no `rate_limits` beside it, so it passed on the
   * empty bag and proved nothing about the flag.
   */
  it('refuses a populated record the CLI says is unavailable', () => {
    assert.equal(
      usage.readUsage({
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 3 }, seven_day: { utilization: 47 } }
      }),
      undefined
    );
  });
});

describe('readRateLimitEvent', () => {
  // 2.1.309's `unifiedWindows`: utilization is a fraction of `get_usage`'s
  // whole-number percentage (docs/reference/cli_state/usage_live_probe_2026-10-26.md).
  const info = {
    status: 'allowed',
    resetsAt: 1793008200,
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: 0.23, resetsAt: 1793008200 },
      seven_day: { utilization: 0.71, resetsAt: 1793008800 }
    }
  };

  it('reads both windows as percentages with epoch-second resets', () => {
    assert.deepEqual(usage.readRateLimitEvent(info), {
      windows: [
        { id: 'session', short: '5h', pct: 23, resetsAt: 1793008200 },
        { id: 'weekly', short: 'wk', pct: 71, resetsAt: 1793008800 }
      ]
    });
  });

  it('states only the windows the event carried', () => {
    const reading = usage.readRateLimitEvent({
      unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1793008800 } }
    });
    assert.deepEqual(reading, {
      windows: [{ id: 'weekly', short: 'wk', pct: 50, resetsAt: 1793008800 }]
    });
  });

  it('yields no reading for an event with only a reset hint, or a malformed body', () => {
    assert.equal(usage.readRateLimitEvent({ status: 'allowed', resetsAt: 1793008200 }), undefined);
    assert.equal(
      usage.readRateLimitEvent({ unifiedWindows: { five_hour: { utilization: 'x' } } }),
      undefined
    );
    assert.equal(usage.readRateLimitEvent({ unifiedWindows: null }), undefined);
    assert.equal(usage.readRateLimitEvent(undefined), undefined);
  });
});
