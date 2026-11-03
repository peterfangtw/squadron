import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EndingSessions } from '../../core/ending';
import type { Session } from '../../core/model';

const card = (over: Partial<Session> = {}): Session => ({
  pid: 42,
  startedAt: 10_000,
  updatedAt: 10_000,
  cwd: '/work/app',
  sessionId: 'session',
  name: 'Work',
  status: 'busy',
  hasCommand: false,
  transcript: '',
  ...over
});

describe('ending sessions', () => {
  it('captures Ending with the retained card even if exit happens during a board read', () => {
    const endings = new EndingSessions();
    const original = card();
    endings.retain(original);
    const captured = endings.snapshot();
    endings.remove(original);
    assert.equal(captured[0]?.closing, true, 'exit stripped the captured ending state');
    assert.equal(captured[0]?.endStuck, undefined);
    assert.deepEqual(endings.snapshot(), []);
    assert.equal(original.closing, undefined, 'retention changed the live card');
  });

  it('keeps a captured card pending when a later End attempt fails', () => {
    const endings = new EndingSessions();
    const original = card();
    endings.retain(original);
    const captured = endings.snapshot();
    assert.equal(endings.fail(original), true);
    assert.equal(captured[0]?.closing, true);
    assert.equal(endings.pending(original), false);
    assert.equal(endings.snapshot()[0]?.closing, undefined);
    assert.equal(endings.snapshot()[0]?.endStuck, true);
    assert.equal(endings.retry(original), true);
    assert.equal(endings.pending(original), true);
    assert.equal(endings.snapshot()[0]?.closing, true);
    assert.equal(endings.snapshot()[0]?.endStuck, undefined);
    endings.fail(original);
    endings.remove(original);
    assert.deepEqual(endings.snapshot(), [], 'a late exit must also remove a failed card');
  });

  it('cannot apply a late failure or exit to a replacement with the same pid', () => {
    const endings = new EndingSessions();
    const old = card();
    const replacement = card({ startedAt: old.startedAt + 1_000, name: 'New work' });
    endings.retain(old);
    assert.equal(endings.retireReplaced(old), false);
    assert.equal(endings.retireReplaced(replacement), true);
    assert.deepEqual(endings.snapshot(), []);
    endings.retain(replacement);
    assert.equal(endings.fail(old), false);
    assert.equal(endings.retry(old), false);
    assert.equal(endings.remove(old), false);
    assert.equal(endings.pending(old), false);
    assert.equal(endings.pending(replacement), true);
    assert.equal(endings.snapshot()[0]?.name, 'New work');
  });
});
