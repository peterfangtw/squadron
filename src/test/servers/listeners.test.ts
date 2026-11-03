import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as platform from '../../core/platform';
import {
  aim,
  listeners,
  pinned,
  processCwds,
  sessionListeners,
  stoppable
} from '../../core/devservers/listeners';
import type { ProcessTable } from '../../core/scan';

describe('sessionListeners', () => {
  const NATIVE = 1_000_000;
  // Stamped by us after the spawn returned, so never the table's own figure.
  const session = {
    pid: 10,
    startedAt: NATIVE + 400,
    cwd: '/Users/me/src/squadron',
    name: 'Fix login',
    source: 'owned' as const
  };

  function table(over: Partial<ProcessTable> = {}): ProcessTable {
    return {
      complete: true,
      claude: new Map(),
      grok: new Map(),
      codex: new Map(),
      parents: new Map<number, number | undefined>([
        [10, 1],
        [20, 10],
        [30, 20],
        [40, 1]
      ]),
      starts: new Map([
        [10, NATIVE],
        [20, NATIVE + 1],
        [30, NATIVE + 2],
        [40, NATIVE + 3]
      ]),
      groups: new Map(),
      shellParents: new Set(),
      ...over
    };
  }

  const pinnedTo = (pid: number, port = 3000) => pinned([{ port, pid }], table());

  it('takes a child and a grandchild, placed in the session', () => {
    assert.deepEqual(sessionListeners(pinnedTo(20), [session], table()), [
      { port: 3000, pid: 20, startedAt: NATIVE + 1, cwd: session.cwd, session: 'Fix login' }
    ]);
    assert.equal(sessionListeners(pinnedTo(30), [session], table()).length, 1);
  });

  it('never takes the root, or a process below no session', () => {
    assert.deepEqual(sessionListeners(pinnedTo(10), [session], table()), []);
    assert.deepEqual(sessionListeners(pinnedTo(40), [session], table()), []);
  });

  it('refuses a root whose number another process took', () => {
    const recycled = table({ starts: new Map([...table().starts, [10, NATIVE + 60_000]]) });
    assert.deepEqual(sessionListeners(pinnedTo(20), [session], recycled), []);
  });

  it('drops a socket whose pid has since been reused below the session', () => {
    const reused = table({ starts: new Map([...table().starts, [20, NATIVE + 90_000]]) });
    assert.deepEqual(sessionListeners(pinnedTo(20), [session], reused), []);
  });

  it('leaves out a background session and a session of no known kind', () => {
    const sockets = pinnedTo(20);
    assert.deepEqual(sessionListeners(sockets, [{ ...session, background: true }], table()), []);
    assert.deepEqual(sessionListeners(sockets, [{ ...session, source: undefined }], table()), []);
  });

  it('claims nothing from an incomplete table', () => {
    assert.deepEqual(sessionListeners(pinnedTo(20), [session], table({ complete: false })), []);
  });

  it('pins nothing for a pid the table does not show', () => {
    assert.deepEqual(pinned([{ port: 3000, pid: 99 }], table()), []);
  });
});

describe('stoppable', () => {
  const NATIVE = 1_000_000;
  const session = {
    pid: 10,
    startedAt: NATIVE,
    cwd: '/repo',
    name: 'Fix',
    source: 'owned' as const
  };
  const table = {
    complete: true,
    claude: new Map(),
    grok: new Map(),
    codex: new Map(),
    parents: new Map<number, number | undefined>([
      [10, 1],
      [20, 10],
      [40, 1]
    ]),
    starts: new Map([
      [10, NATIVE],
      [20, NATIVE + 1],
      [40, NATIVE + 2]
    ]),
    groups: new Map(),
    shellParents: new Set<number>()
  } satisfies ProcessTable;

  it('passes a session server pressed with its true start', () => {
    const want = { pid: 20, startedAt: NATIVE + 1, command: '' };
    assert.equal(stoppable({ port: 3000, pid: 20 }, want, [session], table)?.pid, 20);
  });

  it('refuses a stranger, with its true start or with none at all', () => {
    const heard = { port: 3000, pid: 40 };
    assert.equal(
      stoppable(heard, { pid: 40, startedAt: NATIVE + 2, command: '' }, [session], table),
      undefined
    );
    // The webview's message is not trusted to carry every field.
    const noStart = { pid: 40, command: '' } as { pid: number; startedAt: number; command: string };
    assert.equal(stoppable(heard, noStart, [session], table), undefined);
  });

  it('refuses a session server pressed with another start, and an empty port', () => {
    const want = { pid: 20, startedAt: NATIVE + 500, command: '' };
    assert.equal(stoppable({ port: 3000, pid: 20 }, want, [session], table), undefined);
    assert.equal(
      stoppable(undefined, { ...want, startedAt: NATIVE + 1 }, [session], table),
      undefined
    );
  });
});

describe('aim', () => {
  const heard = { port: 3000, pid: 4242, command: 'node' };

  it('takes the reading that matches both halves', () => {
    assert.equal(aim(heard, { pid: 4242, command: 'node' }), 'same');
  });

  it('refuses a port that changed hands since it was drawn', () => {
    // The case this exists for: the chip was drawn from a reading up to a poll
    // old, the server died, and the next thing started took its pid back.
    assert.equal(aim({ ...heard, pid: 4243 }, { pid: 4242, command: 'node' }), 'changed');
  });

  it('refuses a pid whose command is not what was drawn', () => {
    assert.equal(aim({ ...heard, command: 'postgres' }, { pid: 4242, command: 'node' }), 'changed');
  });

  it('takes a reading with no command over refusing on one', () => {
    // `lsof` printed no `c` line. Thin, not contradictory — and refusing here
    // would make the ✕ do nothing rather than say why.
    assert.equal(aim({ port: 3000, pid: 4242 }, { pid: 4242, command: 'node' }), 'same');
    assert.equal(aim(heard, { pid: 4242, command: '' }), 'same');
  });

  it('says a free port is not a changed one', () => {
    assert.equal(aim(undefined, { pid: 4242, command: 'node' }), 'gone');
  });
});

describe('listener attribution projection', () => {
  it('keeps the first socket per port and batches distinct owners, retaining listeners without cwd evidence', async () => {
    const prior = platform.listeners;
    const batches: (readonly number[])[] = [];
    Object.assign(platform, {
      listeners: {
        read: () =>
          Promise.resolve({
            supported: true,
            status: 'ok',
            value: [
              { port: 3000, pid: 7, command: 'node' },
              { port: 3000, pid: 8, command: 'other' },
              { port: 3001, pid: 7 },
              { port: 3002, pid: 9 }
            ]
          }),
        cwds: (pids: readonly number[]) => {
          batches.push(pids);
          return Promise.resolve({ supported: true, status: 'ok', value: new Map([[7, '/repo']]) });
        }
      }
    });
    try {
      assert.deepEqual(
        [...(await listeners()).values()],
        [
          { port: 3000, pid: 7, command: 'node', cwd: '/repo' },
          { port: 3001, pid: 7, cwd: '/repo' },
          { port: 3002, pid: 9 }
        ]
      );
      assert.deepEqual(batches, [[7, 9]]);
      Object.assign(platform.listeners, {
        cwds: () => Promise.resolve({ supported: true, status: 'failed', reason: 'timeout' })
      });
      assert.equal((await listeners()).get(3000)?.cwd, undefined);
      assert.equal((await processCwds([7])).size, 0);
    } finally {
      Object.assign(platform, { listeners: prior });
    }
  });
});
