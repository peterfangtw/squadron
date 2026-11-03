import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as threadSync from '../../ui/thread_sync';

const turn = (text: string): ExchangeView => ({
  role: 'assistant',
  text,
  blocks: [{ prose: text }]
});

const ask: PendingRequestView = {
  requestId: 'req-1',
  kind: 'ask',
  questions: [{ question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }]
};

/** No key is set to `undefined`: apply deletes an unset key, and strict
 * deepEqual tells a missing key from an undefined one. */
const thread = (exchanges: ExchangeView[], over: Partial<ThreadView> = {}): ThreadView => ({
  pid: 7,
  name: 'session 7',
  fullCwd: '/proj',
  status: 'busy',
  reading: { word: 'busy', tally: 'busy' },
  canControl: true,
  startedAt: 1000,
  updatedAt: 1000,
  cacheTtlMs: 60 * 60_000,
  owned: true,
  canSend: true,
  canAttach: true,
  who: 'claude',
  exchanges,
  ...over
});

const publication: ThreadPublication = { selection: 'select-1', generation: 0, sequence: 2 };

const [x, y, z, a] = [turn('x'), turn('y'), turn('z'), turn('a')];

describe('thread_sync', () => {
  const rows: {
    name: string;
    before: ThreadView;
    after: ThreadView;
    changes?: ThreadPatchMessage['changes'];
    unset?: ThreadPatchMessage['unset'];
    splice: ThreadPatchMessage['splice'];
  }[] = [
    {
      name: 'carries a metadata change alone when no turn moved',
      before: thread([x, y]),
      after: thread([x, y], { status: 'idle' }),
      changes: { status: 'idle' },
      splice: { at: 2, remove: 0, exchanges: [] }
    },
    {
      name: 'sends only the appended turn of a growing stream',
      before: thread([x, y]),
      after: thread([x, y, z]),
      splice: { at: 2, remove: 0, exchanges: [z] }
    },
    {
      name: 'replaces only the last turn as it grows',
      before: thread([x, y]),
      after: thread([x, turn('y and more')]),
      splice: { at: 1, remove: 1, exchanges: [turn('y and more')] }
    },
    {
      name: 'replaces only an edited middle turn',
      before: thread([x, y, z]),
      after: thread([x, turn('y edited'), z]),
      splice: { at: 1, remove: 1, exchanges: [turn('y edited')] }
    },
    {
      name: 'appends once to a run of identical turns',
      before: thread([a, a]),
      after: thread([a, a, a]),
      splice: { at: 2, remove: 0, exchanges: [a] }
    },
    {
      name: 'drops the tail of a run of identical turns',
      before: thread([a, a, a]),
      after: thread([a]),
      splice: { at: 1, remove: 2, exchanges: [] }
    },
    {
      name: 'raises a question and clears hidden history',
      before: thread([x], { historyAvailable: true }),
      after: thread([x], { pending: [ask] }),
      changes: { pending: [ask] },
      unset: ['historyAvailable'],
      splice: { at: 1, remove: 0, exchanges: [] }
    },
    {
      name: 'removes an answered question',
      before: thread([x], { pending: [ask] }),
      after: thread([x]),
      unset: ['pending'],
      splice: { at: 1, remove: 0, exchanges: [] }
    }
  ];

  for (const row of rows)
    it(row.name, () => {
      const message = threadSync.patch(row.before, row.after, publication, 10, 11);
      assert.deepEqual(message, {
        type: 'threadPatch',
        ...publication,
        pid: 7,
        startedAt: 1000,
        base: 10,
        revision: 11,
        changes: row.changes ?? {},
        unset: row.unset ?? [],
        splice: row.splice
      });
      assert.deepEqual(threadSync.apply(row.before, message), row.after);
    });

  it('refuses a splice past the end of the thread it is applied to', () => {
    const message = threadSync.patch(thread([x, y]), thread([x, z]), publication, 10, 11);
    assert.equal(threadSync.apply(thread([x]), message), undefined);
  });
});
