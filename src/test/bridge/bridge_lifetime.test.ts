import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PendingRequest } from '../../core/live';
import type { Session } from '../../core/model';
import type { SessionAddr, Watched } from '../../core/bridge/model';
import * as lifetime from '../../core/bridge/lifetime';
import type { ConversationRecord } from '../../core/bridge/store';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function session(pid: number, over: Partial<Session> = {}): Session {
  return {
    pid,
    sessionId: `s${pid}`,
    cwd: '/repo/app',
    repoRoot: '/repo/app',
    name: `n${pid}`,
    status: 'idle',
    hasCommand: false,
    startedAt: T0 + pid,
    updatedAt: T0 + pid,
    transcript: `/t/${pid}.jsonl`,
    source: 'owned',
    windowId: 'w1',
    brand: 'claude',
    cache: { ttlMs: HOUR, source: 'measured', at: T0 },
    ...over
  };
}

function watched(pid: number, over: Partial<Session> = {}, pending: PendingRequest[] = []) {
  return { session: session(pid, over), pending, label: `n${pid}` } satisfies Watched;
}

const addr = (w: Watched): SessionAddr => ({
  pid: w.session.pid,
  startedAt: w.session.startedAt,
  windowId: 'w1'
});

function conversation(root: Watched, remoteSpawned = true): ConversationRecord {
  return {
    schema: 1,
    id: `conv${root.session.pid}`,
    messenger: 'fake',
    anchor: 'A',
    refs: ['A'],
    latest: 'A',
    owner: 'U1',
    state: 'live',
    root: {
      pid: root.session.pid,
      startedAt: root.session.startedAt,
      sessionId: root.session.sessionId,
      brand: 'claude',
      cwd: root.session.cwd,
      label: root.label,
      ...(remoteSpawned ? { remoteSpawned: true as const } : {})
    },
    past: [],
    notices: [],
    createdAt: T0,
    updatedAt: T0
  };
}

const deadlines = (records: ConversationRecord[], board: Watched[], ending: SessionAddr[] = []) =>
  lifetime.lapses(records, board, ending).map((lapse) => lapse.at);

describe('the lifetime of a remote-spawned session (U6, amended)', () => {
  it('ends an idle root one cache lifetime after its last cache traffic', () => {
    const root = watched(10);
    const [lapse] = lifetime.lapses([conversation(root)], [root], []);
    assert.equal(lapse?.at, T0 + HOUR);
    assert.deepEqual(lapse?.members, []);
    assert.equal(lapse?.retryMs, HOUR);
  });

  it('moves with a Warm ping, which is cache traffic', () => {
    const root = watched(10, { cache: { ttlMs: HOUR, source: 'measured', at: T0 + 55 * 60_000 } });
    assert.deepEqual(deadlines([conversation(root)], [root]), [T0 + 55 * 60_000 + HOUR]);
  });

  it('never touches a root it did not start', () => {
    const root = watched(10);
    assert.deepEqual(deadlines([conversation(root, false)], [root]), []);
  });

  it('holds a root that is not idle', () => {
    const cases: Watched[] = [
      watched(10, { status: 'busy' }),
      watched(10, { status: 'waiting' }),
      watched(10, { status: 'unknown' }),
      watched(10, {}, [{ requestId: 'r1', toolName: 'Bash', ask: false, input: {} }]),
      watched(10, { warming: true }),
      watched(10, {
        warmPort: {
          status: 'idle',
          running: true,
          queued: 0,
          pending: 0,
          exited: false,
          inFlight: false
        }
      }),
      watched(10, {
        warmPort: {
          status: 'idle',
          running: false,
          queued: 0,
          pending: 0,
          exited: false,
          inFlight: true
        }
      }),
      watched(10, { waitingFor: 'input needed' }),
      { ...watched(10), exit: { code: 0, signal: null } }
    ];
    for (const root of cases) {
      assert.deepEqual(deadlines([conversation(root)], [root]), [], JSON.stringify(root));
    }
  });

  it('gives no deadline without a stated cache, and the activity clock without traffic', () => {
    const { cache: _cache, ...bare } = session(10);
    const none: Watched = { session: bare, pending: [], label: 'n10' };
    assert.deepEqual(deadlines([conversation(none)], [none]), []);
    const quiet = watched(10, { updatedAt: T0 + 5, cache: { ttlMs: HOUR, source: 'measured' } });
    assert.deepEqual(deadlines([conversation(quiet)], [quiet]), [T0 + 5 + HOUR]);
  });

  it('skips a root an End is already taking down', () => {
    const root = watched(10);
    assert.deepEqual(deadlines([conversation(root)], [root], [addr(root)]), []);
  });

  it('skips a root that is not on the board', () => {
    const root = watched(10);
    assert.deepEqual(deadlines([conversation(root)], []), []);
  });

  it('holds a root while a descendant works, and ends the idle descent with it', () => {
    const root = watched(10);
    const busy = watched(11, { parentSessionId: 's10', status: 'busy' });
    assert.deepEqual(deadlines([conversation(root)], [root, busy]), []);

    const child = watched(11, { parentSessionId: 's10' });
    const grandchild = watched(12, { parentSessionId: 's11' });
    const [lapse] = lifetime.lapses([conversation(root)], [root, child, grandchild], []);
    assert.deepEqual(lapse?.members, [addr(child), addr(grandchild)]);
  });

  it('gives the family until its latest member has gone cold', () => {
    // The root went cold waiting on its child; the child just finished.
    const root = watched(10);
    const child = watched(11, {
      parentSessionId: 's10',
      cache: { ttlMs: HOUR, source: 'measured', at: T0 + 2 * HOUR }
    });
    assert.deepEqual(deadlines([conversation(root)], [root, child]), [T0 + 3 * HOUR]);
  });

  it('leaves an exited descendant out of the family', () => {
    const root = watched(10);
    const gone = { ...watched(11, { parentSessionId: 's10' }), exit: { code: 0, signal: null } };
    const [lapse] = lifetime.lapses([conversation(root)], [root, gone], []);
    assert.deepEqual(lapse?.members, []);
  });
});
