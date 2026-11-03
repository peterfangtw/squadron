import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { PendingRequest } from '../../core/live';
import type { Session } from '../../core/model';
import type { Watched } from '../../core/bridge/model';
import * as notify from '../../core/bridge/notify';
import type { ConversationRecord, NoticeRecord } from '../../core/bridge/store';
import * as words from '../../core/bridge/words';
import { triggersIn } from './bridge_helpers';
import { repoRoot } from '../helpers';

const T0 = 1_700_000_000_000;

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
    ...over
  };
}

function watched(
  pid: number,
  over: Partial<Session> = {},
  pending: PendingRequest[] = [],
  extra: Partial<Watched> = {}
): Watched {
  return { session: session(pid, over), pending, label: `n${pid}`, ...extra };
}

const permission = (requestId: string): PendingRequest => ({
  requestId,
  toolName: 'Bash',
  ask: false,
  input: { command: 'rm -rf build' }
});

const question = (requestId: string): PendingRequest => ({
  requestId,
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [
    {
      question: 'Which database?',
      multiSelect: false,
      options: [{ label: 'Postgres', description: 'the usual' }, { label: 'SQLite' }]
    }
  ]
});

let minted = 0;

function conversation(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schema: 1,
    id: `conv${minted++}`,
    messenger: 'fake',
    anchor: 'A',
    refs: ['A'],
    latest: 'A',
    owner: 'U1',
    state: 'live',
    past: [],
    notices: [],
    createdAt: T0,
    updatedAt: T0,
    ...over
  };
}

function rootOf(w: Watched): ConversationRecord['root'] {
  return {
    pid: w.session.pid,
    startedAt: w.session.startedAt,
    sessionId: w.session.sessionId,
    brand: 'claude',
    cwd: w.session.cwd,
    label: w.label
  };
}

function waitingRecord(w: Watched, requestId: string, over: Partial<NoticeRecord> = {}) {
  return {
    id: 'n1',
    kind: 'permission' as const,
    message: 'M1',
    target: { pid: w.session.pid, startedAt: w.session.startedAt, windowId: 'w1' },
    requestId,
    postedAt: T0,
    actions: [],
    ...over
  };
}

const kinds = (edges: notify.NoticeEdge[]) => edges.map((e) => e.kind);

describe('conversationFor (D16)', () => {
  it('opens one for a root with none', () => {
    const root = watched(10);
    const to = notify.conversationFor(root, [root], []);
    assert.equal(to.role, 'root');
    assert.ok('open' in to.conversation);
    assert.equal(to.conversation.open.session.pid, 10);
  });

  it('puts a grandchild in its root’s conversation', () => {
    const root = watched(10);
    const child = watched(11, { parentSessionId: 's10' });
    const grand = watched(12, { parentSessionId: 's11' });
    const stored = conversation({ root: rootOf(root) });
    const to = notify.conversationFor(grand, [root, child, grand], [stored]);
    assert.equal(to.role, 'child');
    assert.equal(to.root, 'n10');
    assert.ok('existing' in to.conversation);
    assert.equal(to.conversation.existing.id, stored.id);
  });

  it('opens the root’s conversation, not the child’s, when the family has none', () => {
    const root = watched(10);
    const child = watched(11, { parentSessionId: 's10' });
    const to = notify.conversationFor(child, [root, child], []);
    assert.equal(to.role, 'child');
    assert.ok('open' in to.conversation);
    assert.equal(to.conversation.open.session.pid, 10);
  });

  it('lands a child of a dead root in that root’s conversation (U1)', () => {
    const child = watched(11, { parentSessionId: 's10' });
    const gone = conversation({ root: { ...rootOf(watched(10))! } });
    const to = notify.conversationFor(child, [child], [gone]);
    assert.equal(to.role, 'child');
    assert.ok('existing' in to.conversation);
    assert.equal(to.conversation.existing.id, gone.id);
    assert.equal(to.root, 'n10');
  });

  it('finds the family by a past root and by the origin stamp', () => {
    const child = watched(11, { parentSessionId: 'old', originSessionId: 'old' });
    const past = conversation({ root: rootOf(watched(20)), past: ['old'] });
    const to = notify.conversationFor(child, [child], [past]);
    assert.ok('existing' in to.conversation);
    assert.equal(to.conversation.existing.id, past.id);
  });

  it('follows the origin stamp past a middle that has gone', () => {
    const root = watched(10);
    const grand = watched(12, { parentSessionId: 's11', originSessionId: 's10' });
    const stored = conversation({ root: rootOf(root) });
    const to = notify.conversationFor(grand, [root, grand], [stored]);
    assert.equal(to.role, 'child');
    assert.ok('existing' in to.conversation);
    assert.equal(to.conversation.existing.id, stored.id);
  });

  it('says a child’s root has ended, off the board or exited on it, and not a live one', () => {
    const child = watched(11, { parentSessionId: 's10' });
    const offBoard = notify.conversationFor(
      child,
      [child],
      [conversation({ root: rootOf(watched(10)) })]
    );
    assert.equal(offBoard.rootEnded, true);

    const exited = watched(10, {}, [], { exit: { code: 1, signal: null } });
    const drawn = notify.conversationFor(
      child,
      [exited, child],
      [conversation({ root: rootOf(exited) })]
    );
    assert.equal(drawn.role, 'child');
    assert.equal(drawn.rootEnded, true);

    const live = watched(10);
    const running = notify.conversationFor(
      child,
      [live, child],
      [conversation({ root: rootOf(live) })]
    );
    assert.equal(running.rootEnded, undefined);
  });

  it('stops at a cycle instead of walking forever (R9e)', () => {
    const a = watched(10, { parentSessionId: 's11' });
    const b = watched(11, { parentSessionId: 's10' });
    const to = notify.conversationFor(a, [a, b], []);
    assert.ok('open' in to.conversation);
  });
});

describe('noticeEdges (D19)', () => {
  describe('waiting', () => {
    it('posts a root’s and a child’s new request', () => {
      const root = watched(10);
      const child = watched(11, { parentSessionId: 's10' });
      const next = [
        watched(10, { status: 'waiting' }, [question('q1')]),
        watched(11, { status: 'waiting', parentSessionId: 's10' }, [permission('p1')])
      ];
      const edges = notify.noticeEdges([root, child], next, []);
      assert.deepEqual(kinds(edges), ['waiting', 'waiting']);
      const [first, second] = edges;
      assert.ok(first?.kind === 'waiting' && second?.kind === 'waiting');
      assert.equal(first.to.role, 'root');
      assert.equal(second.to.role, 'child');
      assert.ok('open' in second.to.conversation);
      assert.equal(second.to.conversation.open.session.pid, 10);
    });

    it('posts a request already open at the first observation (U2)', () => {
      const edges = notify.noticeEdges(
        [],
        [watched(10, { status: 'waiting' }, [question('q1')])],
        []
      );
      assert.deepEqual(kinds(edges), ['waiting']);
    });

    it('does not post a request already in the store again', () => {
      const w = watched(10, { status: 'waiting' }, [permission('p1')]);
      const stored = conversation({ root: rootOf(w), notices: [waitingRecord(w, 'p1')] });
      assert.deepEqual(notify.noticeEdges([], [w], [stored]), []);
    });

    it('does not post a request still open from the last pass', () => {
      const w = watched(10, { status: 'waiting' }, [permission('p1')]);
      assert.deepEqual(notify.noticeEdges([w], [w], []), []);
    });
  });

  describe('settle', () => {
    it('settles the notice of a request that closed', () => {
      const before = watched(10, { status: 'waiting' }, [permission('p1')]);
      const stored = conversation({ root: rootOf(before), notices: [waitingRecord(before, 'p1')] });
      const edges = notify.noticeEdges([before], [watched(10, { status: 'busy' })], [stored]);
      assert.deepEqual(kinds(edges), ['settle']);
      const [edge] = edges;
      assert.ok(edge?.kind === 'settle');
      assert.equal(edge.notice.requestId, 'p1');
      assert.equal(edge.conversation.id, stored.id);
    });

    it('settles when the session itself has gone', () => {
      const before = watched(10, { status: 'waiting' }, [permission('p1')]);
      const stored = conversation({ root: rootOf(before), notices: [waitingRecord(before, 'p1')] });
      assert.deepEqual(kinds(notify.noticeEdges([before], [], [stored])), ['settle', 'closed']);
    });

    it('leaves a notice already settled alone', () => {
      const before = watched(10, { status: 'waiting' }, [permission('p1')]);
      const done = waitingRecord(before, 'p1', { settled: words.DENIED });
      const stored = conversation({ root: rootOf(before), notices: [done] });
      assert.deepEqual(notify.noticeEdges([before], [watched(10)], [stored]), []);
    });
  });

  describe('closedWhileAway, the first pass after a load', () => {
    it('settles each open notice whose request the board no longer holds', () => {
      const asked = watched(10, { status: 'waiting' }, [permission('p1')]);
      const gone = watched(11, { status: 'waiting' }, [permission('p2')]);
      const open = watched(12, { status: 'waiting' }, [permission('p3')]);
      const done = watched(13, { status: 'waiting' }, [permission('p4')]);
      const store = [
        conversation({ root: rootOf(asked), notices: [waitingRecord(asked, 'p1')] }),
        conversation({ root: rootOf(gone), notices: [waitingRecord(gone, 'p2')] }),
        conversation({ root: rootOf(open), notices: [waitingRecord(open, 'p3')] }),
        conversation({
          root: rootOf(done),
          notices: [waitingRecord(done, 'p4', { settled: words.DENIED })]
        })
      ];
      const board = [watched(10, { status: 'busy' }), open];
      const edges = notify.closedWhileAway(board, store);
      assert.deepEqual(
        edges.map((e) => (e.kind === 'settle' ? e.notice.requestId : e.kind)),
        ['p1', 'p2']
      );
    });

    it('reads a recycled pid as the request gone', () => {
      const asked = watched(10, { status: 'waiting' }, [permission('p1')]);
      const store = [conversation({ root: rootOf(asked), notices: [waitingRecord(asked, 'p1')] })];
      const recycled = watched(10, { startedAt: T0 + 99_999 }, [permission('p1')]);
      assert.deepEqual(kinds(notify.closedWhileAway([recycled], store)), ['settle']);
    });
  });

  describe('a turn’s end, off the count', () => {
    const at = (pid: number, over: Partial<Session>) => watched(pid, over);
    const child = (over: Partial<Session>) => at(11, { parentSessionId: 's10', ...over });

    it('a root busy on both observations whose count rose posts one finish', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy', turnsEnded: 3 })],
        [at(10, { status: 'busy', turnsEnded: 4, endedOutcome: 'done' })],
        []
      );
      assert.deepEqual(kinds(edges), ['finished']);
    });

    it('a rise of two posts one', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy', turnsEnded: 3 })],
        [at(10, { status: 'idle', turnsEnded: 5, endedOutcome: 'done' })],
        []
      );
      assert.deepEqual(kinds(edges), ['finished']);
    });

    it('a rise with no stated outcome is a finish (R2)', () => {
      const edges = notify.noticeEdges(
        [at(10, { turnsEnded: 0 })],
        [at(10, { turnsEnded: 1 })],
        []
      );
      assert.deepEqual(kinds(edges), ['finished']);
    });

    it('an error posts failed, for a child as for a root', () => {
      const root = at(10, { turnsEnded: 1 });
      const edges = notify.noticeEdges(
        [root, child({ turnsEnded: 1 })],
        [
          at(10, { turnsEnded: 2, endedOutcome: 'error' }),
          child({ turnsEnded: 2, endedOutcome: 'error' })
        ],
        []
      );
      assert.deepEqual(kinds(edges), ['failed', 'failed']);
      assert.deepEqual(
        edges.map((e) => (e.kind === 'failed' ? e.to.role : undefined)),
        ['root', 'child']
      );
    });

    it('a child’s finish is silent', () => {
      const edges = notify.noticeEdges(
        [at(10, {}), child({ turnsEnded: 1 })],
        [at(10, {}), child({ turnsEnded: 2, endedOutcome: 'done' })],
        []
      );
      assert.deepEqual(edges, []);
    });

    it('an interruption is silent', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy', turnsEnded: 1 })],
        [at(10, { turnsEnded: 2, endedOutcome: 'interrupted' })],
        []
      );
      assert.deepEqual(edges, []);
    });

    it('a warm ping moves no count and posts nothing', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy', warming: true, turnsEnded: 2 })],
        [at(10, { status: 'idle', turnOutcome: 'done', turnsEnded: 2 })],
        []
      );
      assert.deepEqual(edges, []);
    });

    it('a prose question ends as a finished notice (D20)', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy', turnsEnded: 0 })],
        [at(10, { status: 'idle', turnsEnded: 1, endedOutcome: 'done' })],
        []
      );
      assert.deepEqual(kinds(edges), ['finished']);
    });
  });

  describe('a turn’s end, off the status edge when a count is absent', () => {
    const at = (pid: number, over: Partial<Session>) => watched(pid, over);

    for (const [label, before, after] of [
      ['the earlier lacks it', {}, { turnsEnded: 4 }],
      ['the later lacks it', { turnsEnded: 3 }, {}],
      ['both lack it', {}, {}]
    ] as const) {
      it(`decides as before when ${label}`, () => {
        const finish = notify.noticeEdges(
          [at(10, { status: 'busy', ...before })],
          [at(10, { status: 'idle', turnOutcome: 'done', ...after })],
          []
        );
        assert.deepEqual(kinds(finish), ['finished']);
      });
    }

    it('a root going waiting to idle with done finishes', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'waiting' })],
        [at(10, { status: 'idle', turnOutcome: 'done' })],
        []
      );
      assert.deepEqual(kinds(edges), ['finished']);
    });

    it('a root busy on both observations posts nothing', () => {
      const edges = notify.noticeEdges(
        [at(10, { status: 'busy' })],
        [at(10, { status: 'busy', turnOutcome: 'done' })],
        []
      );
      assert.deepEqual(edges, []);
    });

    it('an error fails a child; an interruption and a warm ping stay silent', () => {
      const child = (over: Partial<Session>) => at(11, { parentSessionId: 's10', ...over });
      const failed = notify.noticeEdges(
        [at(10, {}), child({ status: 'busy' })],
        [at(10, {}), child({ status: 'idle', turnOutcome: 'error' })],
        []
      );
      assert.deepEqual(kinds(failed), ['failed']);
      const interrupted = notify.noticeEdges(
        [at(10, { status: 'busy' })],
        [at(10, { status: 'idle', turnOutcome: 'interrupted' })],
        []
      );
      assert.deepEqual(interrupted, []);
      const warm = notify.noticeEdges(
        [at(10, { status: 'busy', warming: true })],
        [at(10, { status: 'idle', turnOutcome: 'done' })],
        []
      );
      assert.deepEqual(warm, []);
    });
  });

  describe('a root that stops before finishing (D19, as ruled 2026-10-10)', () => {
    const at = (pid: number, over: Partial<Session> = {}, pending: PendingRequest[] = []) =>
      watched(pid, { turnsEnded: 1, ...over }, pending);
    const exited = (w: Watched): Watched => ({ ...w, exit: { code: 1, signal: null } });

    it('posts once when this window’s busy root exits with its turn open', () => {
      const busy = at(10, { status: 'busy' });
      const edges = notify.noticeEdges([busy], [exited(busy)], []);
      assert.deepEqual(kinds(edges), ['stopped']);
      const [edge] = edges;
      assert.ok(edge?.kind === 'stopped');
      assert.equal(edge.to.role, 'root');
      assert.deepEqual(
        notify.noticeEdges([exited(busy)], [exited(busy)], []),
        [],
        'and not again on the next pass'
      );
    });

    it('settles what a waiting root asked, and posts', () => {
      const waiting = at(10, { status: 'waiting' }, [permission('p1')]);
      const stored = conversation({
        root: rootOf(waiting),
        notices: [waitingRecord(waiting, 'p1')]
      });
      const edges = notify.noticeEdges([waiting], [exited(waiting)], [stored]);
      assert.deepEqual(kinds(edges), ['settle', 'stopped']);
    });

    it('posts when another window’s busy root exits: its record keeps the exit', () => {
      const busy = at(10, { status: 'busy', windowId: 'w2' });
      assert.deepEqual(kinds(notify.noticeEdges([busy], [exited(busy)], [])), ['stopped']);
    });

    it('is silent when a root with no conversation leaves the board, in any window', () => {
      assert.deepEqual(notify.noticeEdges([at(10, { status: 'busy' })], [], []), []);
      const there = at(11, { status: 'waiting', windowId: 'w2' });
      assert.deepEqual(notify.noticeEdges([there], [], []), []);
    });

    it('is silent for a session the bridge itself ended', () => {
      const busy = at(10, { status: 'busy', windowId: 'w2' });
      const ending = [{ pid: 10, startedAt: busy.session.startedAt, windowId: 'w2' }];
      assert.deepEqual(notify.noticeEdges([busy], [exited(busy)], [], { ending }), []);
    });

    it('is silent for an idle root, for a child, and for a turn that ended first', () => {
      const idle = at(10);
      assert.deepEqual(notify.noticeEdges([idle], [exited(idle)], []), []);
      const child = at(11, { status: 'busy', parentSessionId: 's10' });
      assert.deepEqual(notify.noticeEdges([idle, child], [idle, exited(child)], []), []);
      const busy = at(10, { status: 'busy' });
      const done = exited(at(10, { status: 'idle', turnsEnded: 2, endedOutcome: 'done' }));
      assert.deepEqual(kinds(notify.noticeEdges([busy], [done], [])), ['finished']);
    });

    it('is silent for a turn interrupted, then an exit, within one pass: its count rose', () => {
      const busy = at(10, { status: 'busy' });
      const stopped = exited(at(10, { turnsEnded: 2, endedOutcome: 'interrupted' }));
      assert.deepEqual(notify.noticeEdges([busy], [stopped], []), []);
    });
  });

  describe('a root that closes', () => {
    const at = (pid: number, over: Partial<Session> = {}) =>
      watched(pid, { turnsEnded: 1, ...over });
    const exited = (w: Watched): Watched => ({ ...w, exit: { code: 0, signal: null } });
    const talking = (w: Watched) => [conversation({ root: rootOf(w) })];

    it('posts once when a root with a conversation leaves the board: a desk End or a window close', () => {
      for (const root of [at(10, { status: 'busy' }), at(11, { windowId: 'w2' })]) {
        const edges = notify.noticeEdges([root], [], talking(root));
        assert.deepEqual(kinds(edges), ['closed']);
        assert.equal(edges[0]?.kind === 'closed' && edges[0].to.role, 'root');
      }
    });

    it('posts when an idle root exits, and not again when its card is dismissed', () => {
      const idle = at(10);
      const stored = talking(idle);
      assert.deepEqual(kinds(notify.noticeEdges([idle], [exited(idle)], stored)), ['closed']);
      assert.deepEqual(notify.noticeEdges([exited(idle)], [], stored), []);
    });

    it('posts after the finish the same pass read', () => {
      const busy = at(10, { status: 'busy' });
      const done = exited(at(10, { turnsEnded: 2, endedOutcome: 'done' }));
      assert.deepEqual(kinds(notify.noticeEdges([busy], [done], talking(busy))), [
        'finished',
        'closed'
      ]);
      const interrupted = exited(at(10, { turnsEnded: 2, endedOutcome: 'interrupted' }));
      assert.deepEqual(kinds(notify.noticeEdges([busy], [interrupted], talking(busy))), ['closed']);
    });

    it('says stopped, not closed, for a turn left open', () => {
      const busy = at(10, { status: 'busy' });
      assert.deepEqual(kinds(notify.noticeEdges([busy], [exited(busy)], talking(busy))), [
        'stopped'
      ]);
    });

    it('is silent with no conversation, for a child, and for an End from Remote', () => {
      const root = at(10);
      assert.deepEqual(notify.noticeEdges([root], [], []), []);
      const child = at(11, { parentSessionId: 's10' });
      assert.deepEqual(notify.noticeEdges([root, child], [root], talking(root)), []);
      const ending = [{ pid: 10, startedAt: root.session.startedAt, windowId: 'w1' }];
      assert.deepEqual(notify.noticeEdges([root], [], talking(root), { ending }), []);
    });

    it('is not posted again once the store holds its notice: a rebuild', () => {
      const root = at(10);
      const closed: NoticeRecord = {
        id: 'n1',
        kind: 'closed',
        message: 'M1',
        target: { pid: 10, startedAt: root.session.startedAt, windowId: 'w1' },
        postedAt: T0,
        actions: []
      };
      const said = conversation({ root: rootOf(root), notices: [closed] });
      assert.deepEqual(notify.noticeEdges([root], [], [said]), []);
    });
  });

  it('a session’s first observation produces no finish', () => {
    const edges = notify.noticeEdges(
      [],
      [watched(10, { status: 'idle', turnOutcome: 'done', turnsEnded: 7, endedOutcome: 'done' })],
      []
    );
    assert.deepEqual(edges, []);
  });

  it('a pid recycled under a new start is a new session', () => {
    const edges = notify.noticeEdges(
      [watched(10, { status: 'busy', turnsEnded: 1 })],
      [watched(10, { startedAt: T0 + 60_000, turnsEnded: 2, endedOutcome: 'done' })],
      []
    );
    assert.deepEqual(edges, []);
  });
});

describe('the words', () => {
  const root: words.Who = { label: 'fix login', repo: 'app' };
  const child: words.Who = { label: 'tests', repo: 'app', root: 'fix login', step: 3 };

  it('heads a child with its root and step', () => {
    assert.equal(words.head(root), '[app] fix login');
    assert.equal(words.head(child), '[app] tests · spawned by fix login · step 3');
    assert.equal(words.spawnedHead('tests', 'fix login'), 'tests · spawned by fix login');
  });

  it('adds the model and effort it is given, and leaves either out', () => {
    const ran = { model: 'Opus 5.5 (1M)', effort: 'high' };
    assert.equal(words.head({ ...root, ...ran }), '[app] fix login · Opus 5.5 (1M) · high');
    assert.equal(
      words.head({ ...child, ...ran }),
      '[app] tests · Opus 5.5 (1M) · high · spawned by fix login · step 3'
    );
    assert.equal(
      words.head({ ...root, model: 'Opus 5.5 (1M)' }),
      '[app] fix login · Opus 5.5 (1M)'
    );
    assert.equal(words.head({ ...root, effort: 'high' }), '[app] fix login · high');
    assert.equal(words.head({ ...root, model: '', effort: '' }), '[app] fix login');
  });

  it('names a child’s root and step from where its notice goes', () => {
    const r = watched(10);
    const c = watched(11, { parentSessionId: 's10' }, [], { step: 2 });
    const to = notify.conversationFor(c, [r, c], []);
    assert.deepEqual(notify.whoOf(c, to), { label: 'n11', repo: 'app', root: 'n10', step: 2 });
    assert.deepEqual(notify.whoOf(r, notify.conversationFor(r, [r, c], [])), {
      label: 'n10',
      repo: 'app'
    });
  });

  it('names the model and effort the card shows, and leaves out what the session did not state', () => {
    const to = (w: Watched) => notify.conversationFor(w, [w], []);
    const ran = watched(10, {
      brand: 'claude',
      model: 'claude-opus-5-5',
      contextSize: 1_000_000,
      effort: 'high'
    });
    const who = notify.whoOf(ran, to(ran));
    assert.equal(words.head(who), '[app] n10 · Opus 5.5 (1M) · high');

    // Two windows and nothing observed: the card names no window either.
    const bare = watched(10, { brand: 'claude', model: 'claude-opus-5-5' });
    assert.equal(notify.whoOf(bare, to(bare)).model, 'Opus 5.5');
    assert.equal(notify.whoOf(bare, to(bare)).effort, undefined);

    // The reading wins over the launch pick, dated id included.
    const dated = watched(10, {
      brand: 'claude',
      model: 'claude-opus-4-5-20251101',
      modelPick: 'claude-opus-5-5',
      contextSize: 200_000
    });
    assert.equal(notify.whoOf(dated, to(dated)).model, 'Opus 4.5 (200k)');

    // Before the CLI has named one, the launch pick is what the card shows.
    const picked = watched(10, {
      brand: 'claude',
      modelPick: 'claude-opus-5-5',
      contextSize: 1_000_000,
      effort: 'high'
    });
    assert.equal(words.head(notify.whoOf(picked, to(picked))), '[app] n10 · Opus 5.5 (1M) · high');

    const effortOnly = watched(10, { brand: 'claude', effort: 'high' });
    assert.deepEqual(notify.whoOf(effortOnly, to(effortOnly)), {
      label: 'n10',
      repo: 'app',
      effort: 'high'
    });

    // An id no row names is said as stated. Another brand's catalog does not answer it.
    const unknown = watched(10, { brand: 'claude', model: 'claude-sonnet-9', effort: 'low' });
    assert.equal(notify.whoOf(unknown, to(unknown)).model, 'claude-sonnet-9');
    const other = watched(10, {
      brand: 'grok',
      model: 'claude-opus-5-5',
      contextSize: 1_000_000
    });
    assert.equal(notify.whoOf(other, to(other)).model, 'claude-opus-5-5');
    const unbranded = watched(10, { model: 'claude-opus-5-5', contextSize: 1_000_000 });
    assert.equal(notify.whoOf(unbranded, to(unbranded)).model, 'claude-opus-5-5');
  });

  it('a permission says what it would run, with Deny and End and no Allow (D18)', () => {
    const notice = words.waitingNotice(root, permission('p1'), 'U1');
    assert.equal(notice.kind, 'permission');
    assert.equal(notice.mention, 'U1');
    assert.equal(notice.code, 'rm -rf build');
    assert.deepEqual(
      notice.buttons?.map((b) => [b.label, b.action, b.tone]),
      [
        ['Deny', { verb: 'deny' }, 'danger'],
        ['End', { verb: 'end' }, 'danger']
      ]
    );
  });

  it('a permission prefers the CLI’s own label', () => {
    const notice = words.waitingNotice(
      root,
      { ...permission('p1'), toolName: 'Write', label: 'Write hi to out.txt', input: {} },
      undefined
    );
    assert.match(notice.body, /Write hi to out\.txt/);
  });

  it('a question carries its text and options and no buttons', () => {
    const notice = words.waitingNotice(root, question('q1'), 'U1');
    assert.equal(notice.kind, 'question');
    assert.match(notice.body, /Which database\?/);
    assert.match(notice.body, /1\. Postgres — the usual/);
    assert.match(notice.body, /2\. SQLite/);
    assert.equal(notice.buttons, undefined);
  });

  it("a root's question asks for the answer here; a child's says its root answers it (Scenario 4)", () => {
    assert.match(
      words.waitingNotice(root, question('q1'), 'U1').body,
      /\n\nReply here with your answer\.$/
    );
    const child = { label: 'auth redirect', repo: 'agentsview', root: 'lead' };
    const body = words.waitingNotice(child, question('q1'), 'U1').body;
    assert.match(body, /\n\nYour reply here goes to lead, who answers auth redirect\.$/);
    assert.doesNotMatch(body, /with your answer/);
  });

  it("a child's question under a root that ended says a reply here reaches a new session, not the child", () => {
    const orphan: words.Who = {
      label: 'auth redirect',
      repo: 'agentsview',
      root: 'lead',
      rootEnded: true
    };
    const body = words.waitingNotice(orphan, question('q1'), 'U1').body;
    assert.match(
      body,
      /\n\nThe session it was started under has ended: a reply here goes to a new session, not to auth redirect, which keeps waiting\. Answer it in the IDE window it runs in\.$/
    );
    assert.doesNotMatch(body, /lead/);
  });

  it('caps a runaway body and says so', () => {
    const notice = words.finishedNotice(root, 'x'.repeat(words.BODY_MAX + 500), 'U1');
    assert.ok(notice.body.length < words.BODY_MAX + 200);
    assert.match(notice.body, /Cut at 20,000 characters/);
  });

  it('End’s confirm counts the members it is given', () => {
    const m = (pid: number) => ({ pid, startedAt: T0, windowId: 'w1' });
    assert.equal(words.confirmEnd('lead', []).body, 'End lead?');
    assert.equal(words.confirmEnd('lead', [m(1)]).body, 'End lead and the 1 session it started?');
    assert.equal(
      words.confirmEnd('lead', [m(1), m(2), m(3)]).body,
      'End lead and the 3 sessions it started?'
    );
    assert.deepEqual(
      words.confirmEnd('lead', []).buttons?.map((b) => [b.label, b.action, b.tone]),
      [
        ['End', { verb: 'end-confirm' }, 'danger'],
        ['Cancel', { verb: 'cancel' }, undefined]
      ]
    );
  });

  it('a held receipt says why and offers Stop', () => {
    const notice = words.heldReceipt('lead', 'permission');
    assert.match(notice.body, /waiting for permission/);
    assert.deepEqual(
      notice.buttons?.map((b) => [b.label, b.action, b.tone]),
      [['Stop', { verb: 'stop' }, 'danger']]
    );
  });

  it('names the directory a fresh session cannot start in (D26), by its folder name', () => {
    const body = words.notOpenNotice('/Users/me/repo/gone').body;
    assert.match(body, /^gone is not open in any IDE window/);
    assert.doesNotMatch(body, /\/Users/);
  });

  it('names a folder by its name in started and ended', () => {
    const at = '/Users/me/work/site';
    assert.equal(words.startedWord(at), 'Started in site');
    assert.equal(words.startedWord('/b/app', ['/a/app', '/b/app']), 'Started in b/app');
    assert.equal(words.startedNotice(at).body, 'Started in site');
    assert.equal(
      words.endedNotice(at).body,
      'The previous session ended. Starting a new one in site'
    );
  });

  it('help lists every command, and quotes what it did not know', () => {
    const notice = words.helpNotice('frobnicate');
    assert.match(notice.body, /Not a command: frobnicate/);
    for (const name of ['list', 'new', 'end']) assert.match(notice.body, new RegExp(`\`${name}`));
    assert.doesNotMatch(words.helpNotice('').body, /Not a command/);
  });

  describe('list', () => {
    const AT = Date.UTC(2026, 9, 13, 6, 5, 0);
    const MIN = 60_000;

    /** `Snapshot at` and the local wall clock at `at`, read off `Date` here
     *  rather than off the builder. */
    function stamp(at: number): RegExp {
      const d = new Date(at);
      const two = (n: number) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
      return new RegExp(
        `^Snapshot at ${day} ${two(d.getHours())}:${two(d.getMinutes())} UTC([+-]\\d{1,2}(:\\d{2})?)?$`
      );
    }

    it('lists every running session as seven columns under one snapshot time', () => {
      const notice = words.listNotice(
        [
          {
            label: 'lead',
            pid: 10,
            status: 'busy',
            repo: 'app',
            link: 'https://x/1',
            updatedAt: AT - 2 * MIN,
            warm: true
          },
          {
            label: 'solo',
            pid: 12,
            status: 'idle',
            repo: 'site',
            updatedAt: AT - 3 * 3_600_000,
            warm: false
          }
        ],
        AT,
        'Slack'
      );
      const table = notice.table;
      assert.ok(table);
      assert.deepEqual(
        table.columns.map((c) => c.title),
        ['Repo folder', 'Session title', 'Status', 'PID', 'Slack link', 'Time ago', 'Warm']
      );
      assert.deepEqual(
        table.columns.map((c) => c.wrap === true),
        [true, true, false, false, false, false, false]
      );
      assert.match(table.caption, stamp(AT));
      assert.deepEqual(table.rows, [
        ['app', 'lead', 'busy', '10', { link: 'https://x/1', text: 'open' }, '2m ago', 'true'],
        ['site', 'solo', 'idle', '12', '—', '3h ago', 'false']
      ]);
      assert.equal(
        notice.body.split('\n')[0],
        table.caption,
        'the fallback opens on the same time'
      );
    });

    it('says — for what a row does not state, and clamps activity ahead of the clock to now', () => {
      const notice = words.listNotice(
        [
          { label: 'old', pid: 1, status: 'idle' },
          { label: 'odd', pid: 2, status: 'idle', updatedAt: Number.NaN },
          { label: 'ahead', pid: 3, status: 'busy', updatedAt: AT + 5 * MIN, warm: true },
          { label: 'days', pid: 4, status: 'idle', updatedAt: AT - 2 * 86_400_000 - MIN },
          { label: 'fresh', pid: 5, status: 'busy', updatedAt: AT - 30_000 }
        ],
        AT
      );
      assert.deepEqual(
        notice.table?.rows.map((row) => [row[0], row[5], row[6]]),
        [
          ['—', '—', '—'],
          ['—', '—', '—'],
          ['—', '0s ago', 'true'],
          ['—', '2d ago', '—'],
          ['—', '30s ago', '—']
        ]
      );
    });

    it('keeps a label literal in its cell, and plain text in the fallback', () => {
      const label = '[bank](https://evil.example) *now* a<b | c';
      const notice = words.listNotice(
        [{ label, pid: 10, status: 'idle', link: 'https://x/1', updatedAt: AT }],
        AT
      );
      assert.equal(notice.table?.rows[0]?.[1], label);
      assert.ok(
        notice.body.includes('\\[bank\\](https://evil.example) \\*now\\* a<b \\| c'),
        notice.body
      );
      assert.ok(notice.body.includes('[open](https://x/1)'), notice.body);
    });

    it('says nobody is running, under the snapshot time, with no table', () => {
      const notice = words.listNotice([], AT);
      assert.equal(notice.table, undefined);
      const [caption, blank, said] = notice.body.split('\n');
      assert.match(caption ?? '', stamp(AT));
      assert.equal(blank, '');
      assert.equal(said, 'No sessions are running.');
    });
  });

  it('an attachment that opens a conversation mentions, with the usual head (R3)', () => {
    const notice = words.attachedNotice(child, 'U1');
    assert.equal(notice.kind, 'attached');
    assert.equal(notice.mention, 'U1');
    assert.equal(notice.body, 'tests sent a file');
    assert.equal(notice.head, words.head(child));
  });

  it('words the attach refusals', () => {
    assert.equal(words.NO_FILES, 'This messenger cannot take files');
    assert.equal(words.NOT_ON_BOARD, 'Remote does not see that session');
    assert.equal(words.SESSION_ENDED, 'That session has ended');
    assert.equal(words.tooLarge('Chat', 10_000_000), 'That file is larger than Chat takes (10 MB)');
  });

  it('says a root stopped before finishing, mentioning, with no fake CLI trigger', () => {
    const notice = words.stoppedNotice({ label: 'n10', repo: 'app' }, 'T1:U1');
    assert.equal(notice.kind, 'stopped');
    assert.equal(notice.mention, 'T1:U1');
    assert.equal(notice.head, '[app] n10');
    assert.match(notice.body, /^n10 stopped before finishing\./);
    assert.deepEqual(triggersIn(notice.body), []);
  });

  it('says a root closed, without a mention, its name as plain text', () => {
    const notice = words.closedNotice({ label: '*n10*', repo: 'app' });
    assert.equal(notice.kind, 'closed');
    assert.equal(notice.mention, undefined);
    assert.equal(notice.head, '[app] *n10*');
    assert.equal(notice.body, '\\*n10\\* closed. A reply here starts a new session where it ran.');
    assert.deepEqual(triggersIn(notice.body), []);
  });

  it('says a remote-spawned root ended once its cache went cold, without a mention', () => {
    const notice = words.lapsedNotice({ label: '*n10*', repo: 'app' });
    assert.equal(notice.kind, 'lapsed');
    assert.equal(notice.mention, undefined);
    assert.equal(notice.head, '[app] *n10*');
    assert.equal(
      notice.body,
      '\\*n10\\* sat idle past its cache lifetime and has ended. A reply here starts a new session where it ran.'
    );
  });

  it('draws a name an agent chose as plain text in every body that carries one', () => {
    const named = { label: '[Re-authenticate](https://evil.example)', root: '*lead*' };
    const label = '\\[Re-authenticate\\](https://evil.example)';
    assert.equal(
      words.stoppedNotice(named, undefined).body,
      `${label} stopped before finishing. A reply here starts a new session where it ran.`
    );
    const asked = words.waitingNotice(named, question('q1'), undefined);
    assert.ok(asked.body.endsWith(`goes to \\*lead\\*, who answers ${label}.`), asked.body);
    assert.equal(words.attachedNotice(named, undefined).body, `${label} sent a file`);
  });

  it('the Deny reason reaches a session, and carries no fake CLI trigger', () => {
    assert.deepEqual(triggersIn(words.DENY_REASON), []);
  });
});

/**
 * Read from source, as the seam is: a string a phone or an agent reads names
 * none of our boxes (root glossary), and a sentence built at runtime is
 * spelled in a literal here first. Comments and relative import paths are
 * not strings anyone reads.
 */
describe("Remote's strings", () => {
  const SOURCES = [
    'core/bridge/words.ts',
    'core/remote/attach.ts',
    'core/remote/serve_attach.ts',
    'core/remote/verbs.ts',
    'core/remote/link.ts',
    'core/remote/switch.ts',
    'core/bridge/port.ts',
    'cli/attach.ts',
    'cli/end_plan.ts',
    'ui/remote_view.ts'
  ];
  const BOXES =
    /\b(panel|board|card|dock|lightbox|sheet|section|servers line|bottom hub|café|cafe|dialog|modal)s?\b/i;

  it('name none of our boxes', () => {
    const named = SOURCES.flatMap((file) =>
      literals(fs.readFileSync(path.join(repoRoot(), 'src', file), 'utf8'))
        .filter((text) => BOXES.test(text))
        .map((text) => `${file}: ${text}`)
    );
    assert.deepEqual(named, []);
  });
});

function literals(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
  const found = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return found.filter((text) => !/^['"]\.\.?\//.test(text));
}
