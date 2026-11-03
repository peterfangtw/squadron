import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRANDS, sessionBrand } from '../../core/brands';

describe('sessionBrand', () => {
  it('keeps a present brand and reads an absent one as Claude', () => {
    assert.equal(sessionBrand(undefined), 'claude');
    assert.equal(sessionBrand('grok'), 'grok');
    assert.equal(sessionBrand('codex'), 'codex');
    for (const brand of BRANDS) assert.equal(sessionBrand(brand), brand);
  });
});
