import * as assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { Session } from '../../core/model';
import { tempHome } from '../helpers';

type Acks = typeof import('../../core/acks');

let acks: Acks;

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves the CLI's
  // directories once, at load.
  await tempHome();
  acks = await import('../../core/acks');
});

const session = (over: Partial<Session>): Session => ({
  pid: 100,
  sessionId: 'sid',
  cwd: '/work/app',
  name: '',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  ...over
});

describe('markSeen', () => {
  it('dates an idle session against its mark', async () => {
    const before = Date.now();
    await acks.writeAck('opened');
    const one = session({ sessionId: 'opened' });
    await acks.markSeen([one]);
    assert.ok(one.lastSeenAt !== undefined, 'no mark read for a session that was opened');
    assert.ok(one.lastSeenAt >= before, 'the mark predates the write that made it');
  });

  it('dates a waiting session against its mark', async () => {
    await acks.writeAck('waiting-opened');
    const one = session({ sessionId: 'waiting-opened', status: 'waiting' });
    await acks.markSeen([one]);
    assert.ok(one.lastSeenAt !== undefined);
  });

  it('leaves a session nobody has opened undated', async () => {
    // The install case: without this every idle card on the machine would go
    // green at once on the first poll.
    const one = session({ sessionId: 'never-opened' });
    await acks.markSeen([one]);
    assert.equal(one.lastSeenAt, undefined);
  });

  it('does not stat busy or unknown sessions', async () => {
    // The gate `toCard` applies anyway, applied here too so the read is not
    // paid for an answer that is thrown away.
    await acks.writeAck('working');
    for (const status of ['busy', 'unknown'] as const) {
      const one = session({ sessionId: 'working', status });
      await acks.markSeen([one]);
      assert.equal(one.lastSeenAt, undefined, `a ${status} session was dated`);
    }
  });

  it('skips a session the CLI has not named yet', async () => {
    // An owned session before its first turn has no id to key a mark by, and
    // an empty one would resolve to the acks directory itself.
    const one = session({ sessionId: '' });
    await acks.markSeen([one]);
    assert.equal(one.lastSeenAt, undefined);
  });

  it('dates a whole board in one pass', async () => {
    await acks.writeAck('a');
    await acks.writeAck('c');
    const board = [
      session({ pid: 1, sessionId: 'a' }),
      session({ pid: 2, sessionId: 'b' }),
      session({ pid: 3, sessionId: 'c' })
    ];
    await acks.markSeen(board);
    assert.ok(board[0]?.lastSeenAt !== undefined);
    assert.equal(board[1]?.lastSeenAt, undefined, 'an unopened session picked up a mark');
    assert.ok(board[2]?.lastSeenAt !== undefined);
  });
});

describe('HeldAcks', () => {
  it('marks a session at the time it was opened, once its id is known', async () => {
    // A draft's select reaches the host before the poll that carries its pid,
    // and a Codex or Grok session has no id until its handshake. The mark
    // still dates the act, so a turn that ended before the id did reads unseen.
    const held = new acks.HeldAcks();
    const openedAt = Date.now() - 5_000;
    held.hold(7, openedAt);
    await held.settle([session({ pid: 7, sessionId: '' })], openedAt + 1_000);
    const one = session({ pid: 7, sessionId: 'held-late' });
    await acks.markSeen([one]);
    assert.equal(one.lastSeenAt, undefined, 'marked before the session had an id');

    await held.settle([one], openedAt + 2_000);
    await acks.markSeen([one]);
    assert.equal(Math.round(one.lastSeenAt ?? 0), openedAt);
  });

  it('never moves a later mark back', async () => {
    await acks.writeAck('held-newer');
    const held = new acks.HeldAcks();
    held.hold(8, Date.now() - 60_000);
    const one = session({ pid: 8, sessionId: 'held-newer' });
    await acks.markSeen([one]);
    const newer = one.lastSeenAt;
    await held.settle([one], Date.now());
    await acks.markSeen([one]);
    assert.equal(one.lastSeenAt, newer);
  });

  it('writes a held mark once', async () => {
    const held = new acks.HeldAcks();
    const openedAt = Date.now() - 5_000;
    held.hold(9, openedAt);
    const one = session({ pid: 9, sessionId: 'held-once' });
    await held.settle([one], openedAt + 1_000);
    await acks.writeAck('held-once');
    await held.settle([one], openedAt + 2_000);
    await acks.markSeen([one]);
    assert.ok((one.lastSeenAt ?? 0) > openedAt, 'a second settle rewound the mark');
  });

  it('drops a pid whose session never arrives', async () => {
    const held = new acks.HeldAcks();
    const openedAt = Date.now() - 5_000;
    held.hold(10, openedAt);
    await held.settle([], openedAt + acks.HOLD_MS + 1);
    const one = session({ pid: 10, sessionId: 'held-gone' });
    await held.settle([one], openedAt + acks.HOLD_MS + 2);
    await acks.markSeen([one]);
    assert.equal(one.lastSeenAt, undefined, 'a reused pid inherited an expired hold');
  });
});
