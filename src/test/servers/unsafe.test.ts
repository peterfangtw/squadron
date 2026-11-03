import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unsafePort } from '../../core/devservers/unsafe';

describe('unsafePort', () => {
  it('refuses ports a browser will not open', () => {
    assert.equal(unsafePort(6000), 'browsers refuse it');
    assert.equal(unsafePort(6666), 'browsers refuse it');
  });

  it('refuses ports below 1024, which need root', () => {
    assert.equal(unsafePort(80), 'needs root');
    assert.equal(unsafePort(1023), 'needs root');
    assert.equal(unsafePort(1024), undefined);
  });

  it('refuses the ephemeral range', () => {
    assert.equal(unsafePort(49151), undefined);
    assert.equal(unsafePort(49152), 'the OS hands these out');
  });

  it('passes the toolchain defaults', () => {
    for (const port of [3000, 4321, 5173, 8787]) assert.equal(unsafePort(port), undefined);
  });
});
