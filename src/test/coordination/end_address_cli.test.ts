import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import { session } from '../views_helpers';
import type { Session } from '../../core/model';

let closeOne: typeof import('../../cli/end_plan').closeOne;
before(async () => {
  await tempHome();
  ({ closeOne } = await import('../../cli/end_plan'));
});

describe('End member address failures', () => {
  for (const over of [
    { source: 'owned', windowId: 'w1', control: { canControl: false, reason: 'invalid' } },
    { windowId: 'w1' },
    { background: true }
  ] satisfies Partial<Session>[]) {
    it(`keeps an unaddressable member unwritable: ${JSON.stringify(over)}`, async () => {
      const result = await closeOne(session(over));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'unwritable');
    });
  }
  it('recovers an unclaimed member through the shared observation', async (t) => {
    const execution = await import('../../core/session_end');
    t.mock.method(execution, 'observeEnds', () => Promise.resolve([{ kind: 'gone' as const }]));
    const result = await closeOne(
      session({ source: 'owned', windowId: undefined, startedAt: 10000 })
    );
    assert.deepEqual(result, { ok: true });
  });

  it('accepts a matching exited member without asking its window', async () => {
    const selected = session({
      pid: 42,
      name: 'member',
      source: 'owned',
      windowId: 'w1',
      startedAt: 1000
    });
    const result = await closeOne(selected, {
      published: new Map([[42, { session: selected, exit: { code: 0, signal: null } }]])
    });
    assert.deepEqual(result, { ok: true });
  });
});
