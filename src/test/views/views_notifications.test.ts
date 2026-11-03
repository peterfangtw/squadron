import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newlyWaiting, soundCue } from '../../ui/views';
import { session } from '../views_helpers';

describe('newlyWaiting', () => {
  it('flags a session that just went from idle to waiting', () => {
    const prev = [session({ pid: 1, status: 'idle' })];
    const next = [session({ pid: 1, status: 'waiting' })];
    assert.deepEqual(
      newlyWaiting(prev, next).map((s) => s.pid),
      [1]
    );
  });

  it('ignores a session that was already waiting', () => {
    const prev = [session({ pid: 1, status: 'waiting' })];
    const next = [session({ pid: 1, status: 'waiting' })];
    assert.deepEqual(newlyWaiting(prev, next), []);
  });

  it('ignores sessions that are not waiting', () => {
    const prev = [session({ pid: 1, status: 'busy' })];
    const next = [session({ pid: 1, status: 'busy' })];
    assert.deepEqual(newlyWaiting(prev, next), []);
  });

  it('flags a brand-new session that appears already waiting', () => {
    const next = [session({ pid: 2, status: 'waiting' })];
    assert.deepEqual(
      newlyWaiting([], next).map((s) => s.pid),
      [2]
    );
  });
});

describe('soundCue', () => {
  it('says nothing when nothing crossed', () => {
    const same = [session({ pid: 1, status: 'busy' })];
    assert.equal(soundCue(same, same), undefined);
  });

  it('is done when a session finished', () => {
    assert.equal(
      soundCue([session({ pid: 1, status: 'busy' })], [session({ pid: 1, status: 'idle' })]),
      'done'
    );
  });

  it('is blocked when a session went waiting', () => {
    assert.equal(
      soundCue([session({ pid: 1, status: 'busy' })], [session({ pid: 1, status: 'waiting' })]),
      'blocked'
    );
  });

  it('says nothing for a session that was idle already', () => {
    const same = [session({ pid: 1, status: 'idle' })];
    assert.equal(soundCue(same, same), undefined);
  });

  // The opposite of `newlyWaiting`'s rule, and deliberately: a session first
  // seen idle finished before anyone was watching.
  it('says nothing for a brand-new session that appears already idle', () => {
    assert.equal(soundCue([], [session({ pid: 2, status: 'idle' })]), undefined);
  });

  it('prefers blocked when both happened on the same poll', () => {
    const prev = [session({ pid: 1, status: 'busy' }), session({ pid: 2, status: 'busy' })];
    const next = [session({ pid: 1, status: 'idle' }), session({ pid: 2, status: 'waiting' })];
    assert.equal(soundCue(prev, next), 'blocked');
  });

  it('is one cue however many sessions crossed together', () => {
    const prev = [1, 2, 3].map((pid) => session({ pid, status: 'busy' }));
    const next = [1, 2, 3].map((pid) => session({ pid, status: 'idle' }));
    assert.equal(soundCue(prev, next), 'done');
  });
});
