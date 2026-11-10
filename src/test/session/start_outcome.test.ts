import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { outcomeOfReply, startOutcome, startReply, startupState } from '../../core/start_outcome';

describe('a start outcome', () => {
  it('says started for a handoff', () => {
    assert.deepEqual(startOutcome({ ok: true }), {
      outcome: 'started',
      notice: 'Session started.'
    });
  });

  it('says stopped, in the host reason, for a stopped failure', () => {
    assert.deepEqual(startOutcome({ ok: false, outcome: 'stopped', reason: 'No grok binary.' }), {
      outcome: 'stopped',
      notice: 'No grok binary.'
    });
    assert.deepEqual(startOutcome({ ok: false, outcome: 'stopped' }), {
      outcome: 'stopped',
      notice: 'That session did not start.'
    });
  });

  it('says unknown for an unknown failure and for no outcome at all', () => {
    assert.deepEqual(startOutcome({ ok: false, outcome: 'unknown', reason: 'Handshake lost.' }), {
      outcome: 'unknown',
      notice: 'Handshake lost.'
    });
    assert.deepEqual(startOutcome(undefined), {
      outcome: 'unknown',
      notice: 'The start could not be confirmed. Check its status before trying again.'
    });
  });

  it('reports a pending start as waiting, never final', () => {
    assert.deepEqual(startupState(true, undefined), {
      state: 'waiting',
      notice: 'Starting session…'
    });
    assert.deepEqual(startupState(false, { ok: false, outcome: 'stopped', reason: 'Cancelled.' }), {
      state: 'stopped',
      notice: 'Cancelled.'
    });
  });
});

describe('an open request-file reply', () => {
  it('carries the word and no start flag', () => {
    assert.deepEqual(startReply({ ok: false, reason: 'Fleet full.' }), {
      ok: false,
      reason: 'Fleet full.',
      outcome: 'stopped'
    });
    assert.deepEqual(startReply({ ok: false, reason: 'Lost.', outcome: 'unknown' }), {
      ok: false,
      reason: 'Lost.',
      outcome: 'unknown'
    });
    assert.deepEqual(startReply({ ok: true, pid: 4 }), { ok: true, pid: 4, outcome: 'started' });
  });

  it('is read by its word alone, and a reply with none is unknown', () => {
    assert.equal(outcomeOfReply({ ok: false, outcome: 'stopped' }), 'stopped');
    assert.equal(outcomeOfReply({ ok: false, outcome: 'unknown' }), 'unknown');
    assert.equal(outcomeOfReply({ ok: false }), 'unknown');
    assert.equal(outcomeOfReply({ ok: true }), 'started');
  });
});
