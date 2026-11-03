import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progress, reading, resolve, type CardFacts } from '../../ui/reading';

const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  status: 'idle',
  unseen: false,
  neverSeen: false,
  ...over
});

const card = (over: Partial<CardView> = {}): CardView => ({
  pid: 1,
  name: 'x',
  fullCwd: '/x',
  status: 'idle',
  reading: { word: 'idle', tally: 'idle' },
  canControl: true,
  startedAt: 0,
  updatedAt: 0,
  cacheTtlMs: 60 * 60_000,
  ...over
});

describe('progress', () => {
  it('says nothing when there is no list', () => {
    assert.equal(progress(undefined), undefined);
  });

  it('reads done once every step has completed', () => {
    assert.deepEqual(progress({ total: 5, completed: 5 }), { kind: 'done', word: 'done' });
  });

  it('reads done when the count has run past the list', () => {
    assert.deepEqual(progress({ total: 3, completed: 4 }), { kind: 'done', word: 'done' });
  });

  it('reads stalled without a step count', () => {
    assert.deepEqual(progress({ total: 7, completed: 3 }), {
      kind: 'stalled',
      word: 'stalled'
    });
  });
});

describe('resolve', () => {
  it('wears the coarse status when nothing else spoke', () => {
    assert.deepEqual(resolve(facts({ status: 'busy' })), {
      reading: { word: 'busy', tally: 'busy' }
    });
    assert.deepEqual(resolve(facts()), { reading: { word: 'idle', tally: 'idle' } });
  });

  it('reads done, unread, for an idle card that replied after it was opened', () => {
    assert.deepEqual(resolve(facts({ unseen: true })), {
      reading: { word: 'idle', tally: 'idle' },
      unread: { word: 'done', tally: 'done' }
    });
  });

  it('says nothing about delivery while a session is not idle', () => {
    for (const status of ['busy', 'waiting', 'unknown'] as const) {
      assert.equal(resolve(facts({ status, unseen: true })).unread, undefined, status);
    }
  });

  it('reads a step list only at idle', () => {
    const steps = { total: 7, completed: 3 };
    assert.deepEqual(resolve(facts({ completion: steps })).reading, {
      word: 'stalled',
      tally: 'stalled'
    });
    assert.deepEqual(resolve(facts({ status: 'busy', completion: steps })).reading, {
      word: 'busy',
      tally: 'busy'
    });
  });

  it('keeps stalled over unseen, and waitingFor over both', () => {
    const steps = { total: 7, completed: 3 };
    assert.deepEqual(resolve(facts({ completion: steps, unseen: true })), {
      reading: { word: 'stalled', tally: 'stalled' },
      attention: true
    });
    assert.deepEqual(
      resolve(
        facts({ status: 'waiting', waitingFor: 'permission', completion: steps, unseen: true })
      ),
      { reading: { word: 'permission', tally: 'waiting' }, attention: true }
    );
  });

  it('keeps a waiting word over unread even when its status is idle', () => {
    assert.deepEqual(resolve(facts({ waitingFor: 'permission', unseen: true })), {
      reading: { word: 'permission', tally: 'idle' }
    });
  });

  it('buckets waitingFor on status, never on the CLI free text', () => {
    // The word is not safe to read back: a session that wrote "done" into
    // waitingFor would otherwise leave the waiting count.
    assert.deepEqual(resolve(facts({ status: 'waiting', waitingFor: 'done' })).reading, {
      word: 'done',
      tally: 'waiting'
    });
  });
});

describe('resolve: a turn that could not run', () => {
  const failed = { word: 'failed', tally: 'failed' };

  it('reads failed on an idle card whose last turn ended in an error', () => {
    assert.deepEqual(resolve(facts({ turnOutcome: 'error' })), { reading: failed });
  });

  it('ranks failed over a step list and over output unread', () => {
    for (const completion of [
      { total: 7, completed: 3 },
      { total: 5, completed: 5 }
    ]) {
      assert.deepEqual(resolve(facts({ turnOutcome: 'error', completion, unseen: true })), {
        reading: failed,
        attention: true
      });
    }
  });

  it('leaves the waiting word over a failed turn', () => {
    assert.deepEqual(
      resolve(facts({ status: 'waiting', waitingFor: 'permission', turnOutcome: 'error' })),
      { reading: { word: 'permission', tally: 'waiting' } }
    );
  });

  it('reads busy while a new turn runs over the failed one', () => {
    assert.deepEqual(resolve(facts({ status: 'busy', turnOutcome: 'error' })), {
      reading: { word: 'busy', tally: 'busy' }
    });
  });

  it('reads a finished or interrupted turn as it always has', () => {
    for (const turnOutcome of ['done', 'interrupted'] as const) {
      assert.deepEqual(resolve(facts({ turnOutcome, unseen: true })), {
        reading: { word: 'idle', tally: 'idle' },
        unread: { word: 'done', tally: 'done' }
      });
    }
  });
});

describe('reading', () => {
  const unread = card({ pid: 5, unread: { word: 'done', tally: 'done' } });

  it('keeps unread done until a deliberate acknowledgement, even while open', () => {
    assert.deepEqual(reading(unread), { word: 'done', tally: 'done' });
  });

  it('shows the base reading when nothing is unread', () => {
    assert.deepEqual(reading(card({ status: 'busy', reading: { word: 'busy', tally: 'busy' } })), {
      word: 'busy',
      tally: 'busy'
    });
  });
});

describe('attention', () => {
  it('pulses waiting, stalled and failed when unseen or never opened, and clears on a mark', () => {
    for (const over of [
      { status: 'waiting' as const },
      { completion: { total: 3, completed: 1 } },
      { turnOutcome: 'error' as const }
    ]) {
      assert.equal(resolve(facts({ ...over, unseen: true })).attention, true);
      assert.equal(resolve(facts({ ...over, neverSeen: true })).attention, true);
      assert.equal(resolve(facts(over)).attention, undefined);
    }
  });
  it('never pulses idle, busy or done, and never-opened idle does not read done', () => {
    for (const over of [
      {},
      { status: 'busy' as const },
      { completion: { total: 3, completed: 3 } }
    ]) {
      assert.equal(resolve(facts({ ...over, unseen: true, neverSeen: true })).attention, undefined);
    }
    assert.equal(resolve(facts({ neverSeen: true })).unread, undefined);
  });
});
