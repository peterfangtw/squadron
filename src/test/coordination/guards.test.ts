import * as guards from '../../core/coordination/guards';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BURST_MAX, FLEET_MAX, REPORTS_PER_MEMBER } from '../../core/coordination/guards';
import { DEFAULT_WARM_POLICY } from '../../core/warm_policy';

describe('spawn and held report bounds', () => {
  it('keeps a single spawn burst from filling the fleet', () => {
    assert.ok(BURST_MAX < FLEET_MAX);
  });

  it('releases held reports after four per member', () => {
    assert.equal(REPORTS_PER_MEMBER, 4);
  });
});

describe('send cost guards', () => {
  it("takes the stale bound from Claude's lifetime and holds the context ceiling at 80%", () => {
    const claude = DEFAULT_WARM_POLICY.ttlMs.claude;
    assert.equal(guards.TARGET_STALE_MS, claude - guards.staleMargin(claude));
    assert.equal(guards.CONTEXT_MAX, 80);
  });

  it('expires a wait at least a minute before its requester goes stale', () => {
    // A resolution obeys the stale guard and is delivered after the expiry
    // that produced it; set equal, every expiry-driven resolution is refused.
    assert.ok(guards.TARGET_STALE_MS - guards.WAIT_TTL_MS >= 60_000);
  });
});

describe('cache margin', () => {
  it('scales the guard for sixty, thirty and five-minute lifetimes', () => {
    assert.equal(guards.staleMargin(60 * 60_000), 5 * 60_000);
    assert.equal(guards.staleMargin(30 * 60_000), 2.5 * 60_000);
    assert.equal(guards.staleMargin(5 * 60_000), 25_000);
  });
});
