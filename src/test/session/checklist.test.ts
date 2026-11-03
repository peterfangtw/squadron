import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { speaks } from '../../core/checklist';

describe('speaks', () => {
  // The rules `readCompletion` runs on the CLI's own list, held apart so a
  // finished workflow run can be dated by the same two (`host/panel.ts`).
  const finished = { total: 3, completed: 3, newestAt: 1000 };

  it('lets an undated list speak', () => {
    assert.equal(speaks(finished), true);
  });

  it('silences a list older than the last prompt', () => {
    assert.equal(speaks(finished, { promptAt: 1001 }), false);
    assert.equal(speaks(finished, { promptAt: 1000 }), true);
  });

  it('retires a finished list no newer than the ack', () => {
    assert.equal(speaks(finished, { ackAt: 1000 }), false);
    assert.equal(speaks(finished, { ackAt: 999 }), true);
  });

  it('keeps an unfinished list however old the ack', () => {
    assert.equal(speaks({ total: 3, completed: 1, newestAt: 1000 }, { ackAt: 5000 }), true);
  });
});
