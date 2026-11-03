import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EndPlan, endPlan, endRefusal, endTarget, parseArgs } from '../../cli/end';
import { Session, SessionStatus } from '../../core/model';

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'card',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  source: 'owned',
  windowId: 'w1',
  ...over
});

/** Caller, one child, one grandchild — the shape every authority rule is about. */
const family = () => [
  session({ pid: 1, sessionId: 'me', name: 'caller' }),
  session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me' }),
  session({ pid: 3, sessionId: 'grand', name: 'grandchild', parentSessionId: 'kid' })
];

function refusal(plan: EndPlan): Extract<EndPlan, { ok: false }> {
  assert.ok(!plan.ok, 'expected a refusal');
  return plan;
}

/** The pids a plan would post to, with the refusal reason on failure instead of
 *  a bare `false` — which is what a `plan.ok && …` expression fails with. */
function ending(plan: EndPlan): number[] {
  assert.ok(plan.ok, plan.ok ? '' : `expected a plan, got: ${plan.reason}`);
  return plan.members.map((s) => s.pid);
}

describe('parseArgs', () => {
  it('reads a value flag and a bare one together', () => {
    assert.deepEqual(parseArgs(['--pid', '42', '--only']), { pid: '42', only: '' });
  });

  it('takes bare flags in any position', () => {
    assert.deepEqual(parseArgs(['--self', '--session-id', 'sid']), {
      self: '',
      'session-id': 'sid'
    });
  });

  it('is malformed on an unknown flag, rather than reporting a missing one', () => {
    assert.equal(parseArgs(['--pdi', '42']), undefined);
  });

  it('is malformed when a value flag has no value', () => {
    assert.equal(parseArgs(['--pid']), undefined);
  });
});

describe('endPlan: naming the target', () => {
  it('is usage when neither flag is given', () => {
    const parsed = endTarget({});
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 1);
    assert.match(parsed.reason, /name one target\nusage: squadron-end/);
  });

  it('is usage when both are given — the two could disagree', () => {
    const parsed = endTarget({ pid: '2', 'session-id': 'kid' });
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 1);
    assert.match(parsed.reason, /name one target\nusage: squadron-end/);
  });

  it('is usage when --pid is not a process id', () => {
    const parsed = endTarget({ pid: 'kid' });
    assert.ok(!parsed.ok);
    assert.equal(parsed.code, 1);
    assert.match(parsed.reason, /--pid takes a process id\nusage: squadron-end/);
  });

  it('refuses a pid no card has', () => {
    const { code, reason } = refusal(endPlan({ pid: 99 }, family(), 'me'));
    assert.equal(code, 2);
    assert.match(reason, /99/);
  });

  it('refuses a sessionId no card has', () => {
    assert.equal(refusal(endPlan({ session: 'ghost' }, family(), 'me')).code, 2);
  });

  it('refuses a sessionId two live cards share, naming both pids', () => {
    // `claude --resume` against a running conversation: one id, two processes.
    const board = [...family(), session({ pid: 4, sessionId: 'kid', parentSessionId: 'me' })];
    const { code, reason } = refusal(endPlan({ session: 'kid' }, board, 'me'));
    assert.equal(code, 2);
    assert.match(reason, /2, 4/);
  });
});

describe('endPlan: who may end what', () => {
  it('refuses when nothing says which session is asking', () => {
    const { code, reason } = refusal(endPlan({ pid: 2 }, family(), undefined));
    assert.equal(code, 2);
    assert.match(reason, /--caller/);
  });

  it('refuses a caller that is not on the board', () => {
    assert.equal(refusal(endPlan({ pid: 2 }, family(), 'stranger')).code, 2);
  });

  it('ends a child', () => {
    assert.deepEqual(ending(endPlan({ pid: 2 }, family(), 'me')), [2, 3]);
  });

  it('ends a grandchild — authority is the whole descent, not one hop', () => {
    assert.deepEqual(ending(endPlan({ pid: 3 }, family(), 'me')), [3]);
  });

  it('refuses a session that is not below the caller', () => {
    const board = [...family(), session({ pid: 9, sessionId: 'other', name: 'stranger' })];
    const plan = refusal(endPlan({ pid: 9 }, board, 'me'));
    assert.equal(plan.code, 2);
    assert.match(plan.reason, /not below you/);
    assert.doesNotMatch(plan.reason, /--any/);
    assert.match(endRefusal(plan), /pass --any/);
  });

  it('takes --any from the command line through to the plan', () => {
    const board = [...family(), session({ pid: 9, sessionId: 'other', name: 'stranger' })];
    const opts = parseArgs(['--pid', '9', '--any']);
    assert.ok(opts);
    const parsed = endTarget(opts);
    assert.ok(parsed.ok);
    assert.deepEqual(ending(endPlan(parsed.target, board, 'me')), [9]);
  });

  it('ends a session outside the descent under --any, with its own descent', () => {
    const board = [
      ...family(),
      session({ pid: 9, sessionId: 'other', name: 'stranger' }),
      session({ pid: 10, sessionId: 'theirs', parentSessionId: 'other' })
    ];
    assert.deepEqual(ending(endPlan({ pid: 9, any: '' }, board, 'kid')), [9, 10]);
  });

  it('refuses an ancestor under --any without --self, since the cascade takes the caller', () => {
    const plan = refusal(endPlan({ pid: 1, any: '' }, family(), 'kid'));
    assert.equal(
      endRefusal(plan),
      'ending caller ends your own session too; pass --self to end it'
    );
  });

  it('asks for --self before --only on an ancestor, so one retry fixes it', () => {
    const plan = refusal(endPlan({ pid: 1, any: '', only: '' }, family(), 'kid'));
    assert.equal(plan.about, 'self');
  });

  it('still refuses a session no window publishes a pipe for under --any', () => {
    const board = [...family(), session({ pid: 9, sessionId: 'other', source: undefined })];
    assert.match(refusal(endPlan({ pid: 9, any: '' }, board, 'me')).reason, /nothing to close/);
  });

  it('ends an ancestor under --any and --self, the caller held back to be posted last', () => {
    const plan = endPlan({ pid: 1, any: '', self: '' }, family(), 'kid');
    assert.deepEqual(ending(plan), [1, 3]);
    assert.equal(plan.ok && plan.self?.pid, 2);
  });

  it('waives descent only — a busy session is still refused under --any', () => {
    const board = [...family(), session({ pid: 9, sessionId: 'other', status: 'busy' })];
    assert.match(refusal(endPlan({ pid: 9, any: '' }, board, 'me')).reason, /busy/);
  });

  it('refuses the caller its own pid without --self', () => {
    const { code, reason } = refusal(endPlan({ pid: 1 }, family(), 'me'));
    assert.equal(code, 2);
    assert.match(reason, /your own session/);
    assert.doesNotMatch(reason, /--self/);
  });

  it('still tells squadron-end to pass --self for that refusal', () => {
    const plan = endPlan({ pid: 1 }, family(), 'me');
    assert.ok(!plan.ok);
    assert.equal(endRefusal(plan), 'that is your own session; pass --self to end it');
  });

  it('ends only the caller under --self, with or without --only', () => {
    for (const flags of [{ self: '' }, { self: '', only: '' }]) {
      const plan = endPlan({ pid: 1, ...flags }, family(), 'me');
      assert.deepEqual(ending(plan), []);
      assert.equal(plan.ok && plan.self?.pid, 1);
    }
  });

  it('refuses an invalid root before planning its cascade, but keeps a missing owner as a member outcome', () => {
    const invalid = family().map((s) =>
      s.pid === 2
        ? { ...s, control: { canControl: false as const, reason: 'invalid' as const } }
        : s
    );
    assert.match(refusal(endPlan({ pid: 2 }, invalid, 'me')).reason, /invalid control facts/);
    const missing = family().map((s) => (s.pid === 2 ? { ...s, windowId: undefined } : s));
    assert.deepEqual(ending(endPlan({ pid: 2 }, missing, 'me')), [2, 3]);
  });

  it('refuses a session no window publishes a pipe for', () => {
    // Two sessions land here and the refusal is the same for both: a
    // background one, which the CLI's daemon runs, and one another window
    // drives whose record did not land, which its own window still can.
    const board = [
      session({ pid: 1, sessionId: 'me' }),
      session({ pid: 2, sessionId: 'kid', parentSessionId: 'me', source: undefined })
    ];
    const { code, reason } = refusal(endPlan({ pid: 2 }, board, 'me'));
    assert.equal(code, 2);
    assert.match(reason, /nothing to close/);
  });
});

describe('endPlan: cascade and --only', () => {
  it('refuses --only when the target has a descent, naming it', () => {
    const { code, reason } = refusal(endPlan({ pid: 2, only: '' }, family(), 'me'));
    assert.equal(code, 2);
    assert.match(reason, /grandchild/);
  });

  it('allows --only on a leaf', () => {
    assert.deepEqual(ending(endPlan({ pid: 3, only: '' }, family(), 'me')), [3]);
  });

  it('reaches a fan-out stamped on the target, as the button does', () => {
    // A middle generation is gone, so the walk alone cannot join these; the
    // origin stamp is what says who is responsible for them.
    const board = [
      session({ pid: 1, sessionId: 'me' }),
      session({ pid: 2, sessionId: 'kid', parentSessionId: 'me', originSessionId: 'me' }),
      session({ pid: 5, sessionId: 'orphan', name: 'stamped', originSessionId: 'kid' })
    ];
    assert.deepEqual(ending(endPlan({ pid: 2 }, board, 'me')), [2, 5]);
  });
});

describe('endPlan: busy', () => {
  /** The incident this rule is for: an authorised caller, a target it really
   *  did spawn, and a turn in flight. */
  const midTurn = () => [
    session({ pid: 1, sessionId: 'me', name: 'caller' }),
    session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me', status: 'busy' })
  ];

  it('refuses a busy child the caller is otherwise entitled to end', () => {
    const { code, reason } = refusal(endPlan({ pid: 2 }, midTurn(), 'me'));
    assert.equal(code, 2);
    assert.match(reason, /child is busy/);
  });

  it('refuses an idle target whose cascade would take a busy session with it', () => {
    const board = family();
    board[2] = session({
      pid: 3,
      sessionId: 'grand',
      name: 'grandchild',
      parentSessionId: 'kid',
      status: 'busy'
    });
    const { reason } = refusal(endPlan({ pid: 2 }, board, 'me'));
    assert.match(reason, /grandchild is busy/);
  });

  it('names every busy member, not just the first', () => {
    const board = [
      session({ pid: 1, sessionId: 'me' }),
      session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me', status: 'busy' }),
      session({
        pid: 3,
        sessionId: 'grand',
        name: 'grandchild',
        parentSessionId: 'kid',
        status: 'busy'
      })
    ];
    const { reason } = refusal(endPlan({ pid: 2 }, board, 'me'));
    assert.match(reason, /child, grandchild are busy/);
  });

  /** Caller and one leaf, so the plan turns on the leaf's status alone. */
  const leaf = (status: SessionStatus) => [
    session({ pid: 1, sessionId: 'me', name: 'caller' }),
    session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me', status })
  ];

  it('allows a waiting target — parked on an answer is not work in flight', () => {
    assert.deepEqual(ending(endPlan({ pid: 2 }, leaf('waiting'), 'me')), [2]);
  });

  it('allows a target whose status could not be read', () => {
    assert.deepEqual(ending(endPlan({ pid: 2 }, leaf('unknown'), 'me')), [2]);
  });

  it('exempts the caller under --self, which is busy whenever it asks', () => {
    const board = [session({ pid: 1, sessionId: 'me', name: 'caller', status: 'busy' })];
    const plan = endPlan({ pid: 1, self: '' }, board, 'me');
    assert.ok(plan.ok, plan.ok ? '' : plan.reason);
    assert.equal(plan.self?.pid, 1);
  });

  it('leaves a busy child running when the caller ends itself', () => {
    const board = [
      session({ pid: 1, sessionId: 'me', name: 'caller', status: 'busy' }),
      session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me', status: 'busy' })
    ];
    const plan = endPlan({ pid: 1, self: '' }, board, 'me');
    assert.deepEqual(ending(plan), []);
    assert.equal(plan.ok && plan.self?.pid, 1);
  });
});
