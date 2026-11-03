import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickUsageAccount, type UsageAccount } from '../../ui/usage_chip';

const claude: UsageAccount = { brand: 'claude', state: 'signed_in' };
const grok: UsageAccount = { brand: 'grok', state: 'signed_in' };
const out: UsageAccount = { brand: 'claude', state: 'signed_out' };
const soon: UsageAccount = { brand: 'codex', state: 'coming_soon' };

describe('pickUsageAccount', () => {
  it('is a no-op on a single signed-in row', () => {
    assert.equal(pickUsageAccount([claude, soon])?.brand, 'claude');
  });

  it('skips signed-out and coming-soon', () => {
    assert.equal(pickUsageAccount([out, grok, soon])?.brand, 'grok');
    assert.equal(pickUsageAccount([out, soon]), undefined);
  });

  it('holds the pin until a later one replaces it', () => {
    const rows = [claude, grok];
    assert.equal(pickUsageAccount(rows, { pin: 'grok' })?.brand, 'grok');
    assert.equal(pickUsageAccount(rows, { pin: 'claude' })?.brand, 'claude');
  });

  it('falls back when the pin is not signed in', () => {
    assert.equal(pickUsageAccount([claude, soon], { pin: 'grok' })?.brand, 'claude');
  });

  it('holds the current brand while frozen', () => {
    const rows = [claude, grok];
    assert.equal(
      pickUsageAccount(rows, {
        frozen: true,
        currentBrand: 'grok',
        pin: 'claude'
      })?.brand,
      'grok'
    );
  });

  it('starts on the first signed-in row when nothing is pinned', () => {
    assert.equal(pickUsageAccount([claude, grok])?.brand, 'claude');
  });
});
