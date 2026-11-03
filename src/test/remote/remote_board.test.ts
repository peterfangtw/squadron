import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Watched } from '../../core/bridge/model';
import * as words from '../../core/bridge/words';
import type { LineageEntry } from '../../core/coordination/lineage';
import type { PendingRequest } from '../../core/live';
import type { Session } from '../../core/model';
import type { PublishedLive } from '../../core/published';
import * as board from '../../core/remote/board';

const T0 = 1_700_000_000_000;
const HERE = 'w-here';
const THERE = 'w-there';

function session(pid: number, over: Partial<Session> = {}): Session {
  return {
    pid,
    sessionId: `s${pid}`,
    cwd: '/repo/app',
    name: `n${pid}`,
    status: 'idle',
    hasCommand: false,
    startedAt: T0 + pid * 1000,
    updatedAt: T0,
    transcript: `/t/${pid}.jsonl`,
    source: 'owned',
    windowId: THERE,
    ...over
  };
}

function record(
  pid: number,
  over: Partial<Session> = {},
  extra: Partial<PublishedLive> = {}
): PublishedLive {
  return { schema: 1, session: session(pid, over), pending: [], queued: [], ...extra };
}

const published = (...records: PublishedLive[]) =>
  new Map(records.map((one) => [one.session.pid, one]));

/** Every published session's process, alive at the start it states. */
const startsOf = (...sessions: Session[]) =>
  new Map(sessions.map((one) => [one.pid, one.startedAt]));

const spawn = (parent: string, child: Session): [number, LineageEntry] => [
  child.pid,
  {
    schema: 1,
    kind: 'spawn',
    parentSessionId: parent,
    originSessionId: parent,
    spawnedAt: child.startedAt,
    cwd: child.cwd,
    requestId: `r${child.pid}`
  }
];

const permission: PendingRequest = { requestId: 'p1', toolName: 'Write', ask: false };

describe('remoteBoard', () => {
  it('shadows its own record with what memory holds', () => {
    const mine = session(1, { windowId: HERE, status: 'busy' });
    const stale = record(1, { windowId: HERE, status: 'idle' });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [{ session: mine, pending: [permission] }],
      published: published(stale),
      starts: startsOf(mine),
      lineage: new Map()
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.session.status, 'busy');
    assert.deepEqual(seen[0]?.pending, [permission]);
  });

  it('projects message facts from local memory and foreign publication without inventing evidence for older records', () => {
    const mine = session(10, { windowId: HERE });
    const localFacts = [{ correlation: 'local', phase: 'processing' as const }];
    const foreignFacts = [{ correlation: 'foreign', phase: 'done' as const }];
    const foreign = record(11, {}, { messageFacts: foreignFacts });
    const older = record(12);
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [{ session: mine, pending: [], messageFacts: localFacts }],
      published: published(record(10, {}, { messageFacts: foreignFacts }), foreign, older),
      starts: startsOf(mine, foreign.session, older.session),
      lineage: new Map()
    });
    assert.deepEqual(seen.find((one) => one.session.pid === 10)?.messageFacts, localFacts);
    assert.deepEqual(seen.find((one) => one.session.pid === 11)?.messageFacts, foreignFacts);
    assert.equal(seen.find((one) => one.session.pid === 12)?.messageFacts, undefined);
  });

  it("leaves out a dead window's record, whose start no longer matches", () => {
    const alive = record(2);
    const dead = record(3);
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [],
      published: published(alive, dead),
      starts: new Map([
        [2, alive.session.startedAt],
        [3, dead.session.startedAt + 60_000]
      ]),
      lineage: new Map()
    });
    assert.deepEqual(
      seen.map((one) => one.session.pid),
      [2]
    );
  });

  it('keeps a record that says its session exited, as exited: its window still draws the card', () => {
    const exit = { code: 1, signal: null };
    const crashed = record(4, { status: 'busy' }, { exit });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [],
      published: published(crashed),
      starts: new Map(),
      lineage: new Map()
    });
    assert.deepEqual(
      seen.map((one) => [one.session.pid, one.exit]),
      [[4, exit]]
    );
  });

  it("joins a spawned child to its parent off lineage, in either window's half", () => {
    const root = session(5, { windowId: HERE });
    const child = record(6);
    const ownChild = session(7, { windowId: HERE });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [
        { session: root, pending: [] },
        { session: ownChild, pending: [] }
      ],
      published: published(child),
      starts: startsOf(root, child.session, ownChild),
      lineage: new Map([spawn('s5', child.session), spawn('s5', ownChild)])
    });
    const byPid = new Map(seen.map((one) => [one.session.pid, one.session]));
    assert.equal(byPid.get(6)?.parentSessionId, 's5');
    assert.equal(byPid.get(6)?.originSessionId, 's5');
    assert.equal(byPid.get(7)?.parentSessionId, 's5');
  });

  it('gives a panel + session no parent', () => {
    const plus = session(8, { windowId: HERE });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [{ session: plus, pending: [] }],
      published: published(),
      starts: startsOf(plus),
      lineage: new Map()
    });
    assert.equal(seen[0]?.session.parentSessionId, undefined);
    assert.equal(seen[0]?.session.originSessionId, undefined);
  });

  it("carries a foreign record's pending and labels every session by its display name", () => {
    const asking = record(9, { name: 'fix the login' }, { pending: [permission] });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [],
      published: published(asking),
      starts: startsOf(asking.session),
      lineage: new Map()
    });
    assert.deepEqual(seen[0]?.pending, [permission]);
    assert.equal(seen[0]?.label, 'fix the login');
  });

  it('keeps an own exit, so the policy sees the session end', () => {
    const ended = session(10, { windowId: HERE });
    const exit = { code: 1, signal: null };
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [{ session: ended, pending: [], exit }],
      published: published(),
      starts: new Map(),
      lineage: new Map()
    });
    assert.deepEqual(seen[0]?.exit, exit);
  });

  it('leaves out a session that names no window', () => {
    const loose = record(11, { windowId: undefined });
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [],
      published: published(loose),
      starts: startsOf(loose.session),
      lineage: new Map()
    });
    assert.deepEqual(seen, []);
  });

  it("puts the step a session's run names on it", () => {
    const child = record(12);
    const seen = board.remoteBoard({
      windowId: HERE,
      own: [],
      published: published(child),
      starts: startsOf(child.session),
      lineage: new Map(),
      steps: new Map([['s12', 3]])
    });
    assert.equal(seen[0]?.step, 3);
  });
});

describe('findTarget', () => {
  const there = session(20);
  const onBoard: Watched[] = [{ session: there, pending: [], label: 'n20' }];
  const addr = { pid: 20, startedAt: there.startedAt, windowId: THERE };
  const files = { maxBytes: 1024 };

  it('finds the session at that pid, start and window, with the messenger limit', () => {
    const found = board.findTarget(onBoard, addr, startsOf(there), files);
    assert.deepEqual(found, { ok: true, session: there, maxBytes: 1024 });
  });

  it('says the session has ended when no process runs at that start', () => {
    const recycled = new Map([[20, there.startedAt + 60_000]]);
    assert.deepEqual(board.findTarget(onBoard, addr, recycled, files), {
      ok: false,
      reason: words.SESSION_ENDED
    });
    assert.deepEqual(board.findTarget(onBoard, addr, new Map(), files), {
      ok: false,
      reason: words.SESSION_ENDED
    });
  });

  it('says the session has ended when the board holds its exit', () => {
    const exited: Watched[] = [{ ...onBoard[0]!, exit: { code: 0, signal: null } }];
    assert.deepEqual(board.findTarget(exited, addr, startsOf(there), files), {
      ok: false,
      reason: words.SESSION_ENDED
    });
  });

  it('says the session is not on the board when it is alive and unseen', () => {
    const elsewhere = { ...addr, windowId: 'w-other' };
    assert.deepEqual(board.findTarget(onBoard, elsewhere, startsOf(there), files), {
      ok: false,
      reason: words.NOT_ON_BOARD
    });
    assert.deepEqual(board.findTarget([], addr, startsOf(there), files), {
      ok: false,
      reason: words.NOT_ON_BOARD
    });
  });

  it('says the messenger takes no files when it has none', () => {
    assert.deepEqual(board.findTarget(onBoard, addr, startsOf(there), undefined), {
      ok: false,
      reason: words.NO_FILES
    });
  });
});
