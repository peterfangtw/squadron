import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Session } from '../../core/model';
import { closeDescendants, closePlan, CloseInputs, selectionEnded } from '../../ui/closing';

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'parent',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  ...over
});

const inputs = (over: Partial<CloseInputs> = {}): CloseInputs => ({
  alreadyDead: false,
  hasExchanges: false,
  processCount: 0,
  ...over
});

describe('selectionEnded', () => {
  const ended = [{ pid: 7, startedAt: 1_000 }];

  it('matches the selected session incarnation', () => {
    assert.equal(selectionEnded(7, 1_000, ended), true);
  });

  it('does not clear a replacement that reused the pid', () => {
    assert.equal(selectionEnded(7, 2_000, ended), false);
  });
});

describe('closeDescendants', () => {
  /**
   * An end already sent is not offered again: the dialog would list a session
   * that is going as one still running, and End all would signal it twice.
   */
  it('leaves out a session that is already ending', () => {
    const board = [
      session({ pid: 1, sessionId: 'p' }),
      session({ pid: 2, sessionId: 'c', parentSessionId: 'p', closing: true }),
      session({ pid: 3, sessionId: 'g', parentSessionId: 'c' })
    ];
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [3]
    );
  });

  const chain = () => [
    session({ pid: 1, sessionId: 'p' }),
    session({ pid: 2, sessionId: 'c', name: 'child', parentSessionId: 'p' }),
    session({ pid: 3, sessionId: 'g', name: 'grand', parentSessionId: 'c' }),
    // A fourth generation, because three is what a doubled one-hop fold would
    // also get right — depth being unbounded is the whole point of the walk.
    session({ pid: 4, sessionId: 'gg', name: 'great', parentSessionId: 'g' })
  ];

  it('walks the whole descent, generation by generation', () => {
    const board = chain();
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [2, 3, 4]
    );
    assert.deepEqual(
      closeDescendants(2, board).map((s) => s.pid),
      [3, 4]
    );
    assert.deepEqual(closeDescendants(4, board), []);
  });

  it('takes every branch of a fork', () => {
    const board = [
      session({ pid: 1, sessionId: 'p' }),
      session({ pid: 2, sessionId: 'a', parentSessionId: 'p' }),
      session({ pid: 3, sessionId: 'b', parentSessionId: 'p' }),
      session({ pid: 4, sessionId: 'a1', parentSessionId: 'a' }),
      session({ pid: 5, sessionId: 'b1', parentSessionId: 'b' })
    ];
    // Breadth first, so a family reads in generation order.
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [2, 3, 4, 5]
    );
  });

  it('stops at a dead middle — the grandchild is a loose card, not a descendant', () => {
    // The middle session is gone from the board, so nothing resolves the
    // grandchild's edge and it belongs to no one — and neither does anything
    // below it.
    const board = [chain()[0]!, chain()[2]!, chain()[3]!];
    assert.deepEqual(closeDescendants(1, board), []);
  });

  // The stamp is what the walk cannot supply: a fan-out's origin is responsible
  // for everything it started, whether or not the generation between is still
  // on the board.
  it('reaches past a dead middle when the fan-out is stamped', () => {
    const board = [
      session({ pid: 1, sessionId: 'p' }),
      session({
        pid: 3,
        sessionId: 'g',
        name: 'grand',
        parentSessionId: 'c',
        originSessionId: 'p'
      }),
      session({
        pid: 4,
        sessionId: 'gg',
        name: 'great',
        parentSessionId: 'g',
        originSessionId: 'p'
      })
    ];
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [3, 4]
    );
  });

  // A stamp can name a live member rather than a root (`squadron-spawn
  // --parent-session-id`), so the union and the walk have to feed each other: the stamp
  // jumps the dead middle, and the walk picks the chain back up below it.
  it('walks on from a session the stamp jumped it to', () => {
    const board = [
      session({ pid: 1, sessionId: 'p' }),
      // Its parent is gone; the stamp is what says whose fan-out it is.
      session({
        pid: 3,
        sessionId: 'g',
        name: 'grand',
        parentSessionId: 'c',
        originSessionId: 'p'
      }),
      // Opened at gen3 explicitly, so it carries gen3's id and not the root's.
      session({
        pid: 4,
        sessionId: 'gg',
        name: 'great',
        parentSessionId: 'g',
        originSessionId: 'g'
      })
    ];
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [3, 4]
    );
  });

  // The stamp names an ancestor, so reading it as "my fan-out" anywhere but at
  // that ancestor would offer to stop a session's own siblings.
  it('offers a middle card its own descent and never its siblings', () => {
    const board = [
      session({ pid: 1, sessionId: 'p' }),
      session({
        pid: 2,
        sessionId: 'c',
        name: 'child',
        parentSessionId: 'p',
        originSessionId: 'p'
      }),
      session({ pid: 3, sessionId: 'd', name: 'peer', parentSessionId: 'p', originSessionId: 'p' }),
      session({ pid: 4, sessionId: 'g', name: 'grand', parentSessionId: 'c', originSessionId: 'p' })
    ];
    assert.deepEqual(
      closeDescendants(2, board).map((s) => s.pid),
      [4]
    );
  });

  it('terminates on a cycle in the data', () => {
    const board = [
      session({ pid: 1, sessionId: 'a', parentSessionId: 'b' }),
      session({ pid: 2, sessionId: 'b', parentSessionId: 'a' })
    ];
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [2]
    );
  });

  it('never lists the clicked session as its own descendant', () => {
    // A cycle back to the root would otherwise count it twice in `End all n`
    // and signal it twice.
    const board = [
      session({ pid: 1, sessionId: 'a', parentSessionId: 'c' }),
      session({ pid: 2, sessionId: 'b', parentSessionId: 'a' }),
      session({ pid: 3, sessionId: 'c', parentSessionId: 'b' })
    ];
    assert.deepEqual(
      closeDescendants(1, board).map((s) => s.pid),
      [2, 3]
    );
  });

  it('counts an idle descendant — it is still orphanable', () => {
    const parent = session({ pid: 1, sessionId: 'p', status: 'busy' });
    const child = session({
      pid: 2,
      sessionId: 'c',
      name: 'idle-peer',
      status: 'idle',
      parentSessionId: 'p'
    });
    assert.equal(closeDescendants(1, [parent, child]).length, 1);
  });
});

describe('closePlan', () => {
  it('is noop when the session is not on the board', () => {
    assert.deepEqual(closePlan(undefined, [], inputs()), { kind: 'noop' });
  });

  it('is dismiss when the owned session already exited', () => {
    const s = session({ status: 'idle' });
    assert.deepEqual(closePlan(s, [s], inputs({ alreadyDead: true })), {
      kind: 'dismiss'
    });
  });

  it('stops without a dialog when idle and the transcript is empty', () => {
    const s = session({ status: 'idle' });
    assert.deepEqual(closePlan(s, [s], inputs({ hasExchanges: false })), {
      kind: 'stop',
      cascade: []
    });
  });

  it('asks to stop a used idle session, with process-count detail', () => {
    const s = session({ status: 'idle', source: 'owned', name: 'worker' });
    const plan = closePlan(s, [s], inputs({ hasExchanges: true, processCount: 2 }));
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.equal(plan.message, 'End this session?');
    assert.match(plan.detail, /^worker\n\nIts card goes with it/);
    assert.match(plan.detail, /2 processes it started/);
    assert.deepEqual(plan.buttons, ['End session']);
    assert.deepEqual(plan.cascadeFor['End session'], []);
  });

  it('keeps the title generic and names a busy session in the body', () => {
    const s = session({ status: 'busy', name: 'agent', waitingFor: undefined });
    const plan = closePlan(s, [s], inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.equal(plan.message, 'End this session?');
    assert.match(plan.detail, /^agent — busy\n\n/);
    assert.deepEqual(plan.buttons, ['End session']);
  });

  it('prefers waitingFor over status when naming the block', () => {
    const s = session({
      status: 'waiting',
      name: 'agent',
      waitingFor: 'permission prompt'
    });
    const plan = closePlan(s, [s], inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /^agent — permission prompt\n\n/);
  });

  it('does not call an unknown status by that word', () => {
    const s = session({ status: 'unknown', name: 'agent-3f' });
    const plan = closePlan(s, [s], inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /^agent-3f\n\n/);
    assert.doesNotMatch(plan.detail, /unknown/i);
  });

  it('offers cascade choices when children are still running', () => {
    const parent = session({
      pid: 1,
      sessionId: 'p',
      name: 'orch',
      status: 'busy'
    });
    const child = session({
      pid: 2,
      sessionId: 'c',
      name: 'peer',
      status: 'idle',
      parentSessionId: 'p'
    });
    const board = [parent, child];
    const plan = closePlan(parent, board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.equal(plan.message, 'End this session?');
    assert.match(plan.detail, /^orch — busy\n\n1 session below it is still running/);
    assert.match(plan.detail, /peer — idle/);
    // Every member is a direct child, so the orphan clause is true and said.
    assert.match(plan.detail, /nothing left on the board to say what started them/);
    assert.deepEqual(plan.buttons, ['End all 2', 'End just this one']);
    assert.deepEqual(plan.cascadeFor['End just this one'], []);
    assert.deepEqual(
      plan.cascadeFor['End all 2']?.map((s) => s.pid),
      [2]
    );
  });

  it('cascades the whole descent, not one hop', () => {
    const board = [
      session({ pid: 1, sessionId: 'p', name: 'orch', status: 'busy' }),
      session({ pid: 2, sessionId: 'c', name: 'peer', parentSessionId: 'p' }),
      session({ pid: 3, sessionId: 'g', name: 'helper', parentSessionId: 'c' })
    ];
    const plan = closePlan(board[0], board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /2 sessions below it are still running/);
    assert.deepEqual(plan.buttons, ['End all 3', 'End just this one']);
    assert.deepEqual(
      plan.cascadeFor['End all 3']?.map((s) => s.pid),
      [2, 3]
    );
  });

  it('does not claim a grandchild is orphaned when its own parent survives', () => {
    // `End just this one` leaves the middle session running, so the deepest
    // card still has something on the board saying what started it.
    const board = [
      session({ pid: 1, sessionId: 'p', name: 'orch', status: 'busy' }),
      session({ pid: 2, sessionId: 'c', name: 'peer', parentSessionId: 'p' }),
      session({ pid: 3, sessionId: 'g', name: 'helper', parentSessionId: 'c' })
    ];
    const plan = closePlan(board[0], board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /Ending just this one leaves them running/);
    assert.doesNotMatch(plan.detail, /nothing left on the board to say what started them/);
  });

  it('counts past three instead of naming them, and the button still counts all', () => {
    const board = [
      session({ pid: 1, sessionId: 'p', name: 'orch', status: 'busy' }),
      session({ pid: 2, sessionId: 'a', name: 'one', status: 'busy', parentSessionId: 'p' }),
      session({ pid: 3, sessionId: 'b', name: 'two', status: 'busy', parentSessionId: 'p' }),
      session({ pid: 4, sessionId: 'c', name: 'three', status: 'idle', parentSessionId: 'a' }),
      session({
        pid: 5,
        sessionId: 'd',
        name: 'four',
        status: 'waiting',
        waitingFor: 'permission prompt',
        parentSessionId: 'a'
      })
    ];
    const plan = closePlan(board[0], board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /4 sessions below it are still running/);
    assert.match(plan.detail, /2 busy, 1 waiting, 1 idle/);
    // Past three nothing is named — that is the trade the counts buy.
    assert.doesNotMatch(plan.detail, /three/);
    assert.deepEqual(plan.buttons, ['End all 5', 'End just this one']);
    assert.equal(plan.cascadeFor['End all 5']?.length, 4);
  });

  it('accounts for every session the button promises to end', () => {
    // The one invariant the counted form rests on: what the buckets add up to is
    // what the cascade holds, and the button is that plus the card itself. A
    // detail built from a filtered list would pass both of the assertions above
    // and fail this one.
    const board = [
      session({ pid: 1, sessionId: 'p', name: 'orch', status: 'busy' }),
      ...['busy', 'idle', 'waiting', 'unknown', 'idle'].map((status, i) =>
        session({
          pid: i + 2,
          sessionId: `s${i}`,
          name: `s${i}`,
          status: status as Session['status'],
          parentSessionId: 'p'
        })
      )
    ];
    const plan = closePlan(board[0], board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    const counts = plan.detail.split('\n').find((line) => /^\d+ \w+(, \d+ \w+)*$/.test(line));
    const counted = (counts ?? '')
      .split(', ')
      .reduce((sum, part) => sum + Number(part.split(' ')[0]), 0);
    assert.equal(counted, 5);
    assert.deepEqual(plan.buttons[0], `End all ${counted + 1}`);
    assert.equal(plan.cascadeFor[`End all ${counted + 1}`]?.length, counted);
  });

  it('still says what is orphaned when four direct children are only counted', () => {
    // Counts and the orphan clause in the same modal: nothing deeper than one
    // hop here, so the clause is true and must survive the summarising.
    const board = [
      session({ pid: 1, sessionId: 'p', name: 'orch', status: 'busy' }),
      ...[2, 3, 4, 5].map((pid) =>
        session({ pid, sessionId: `s${pid}`, name: `s${pid}`, parentSessionId: 'p' })
      )
    ];
    const plan = closePlan(board[0], board, inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /4 sessions below it are still running/);
    assert.match(plan.detail, /4 idle/);
    assert.match(plan.detail, /nothing left on the board to say what started them/);
  });

  it('cascade confirm wins over the used-session confirm — one modal only', () => {
    const parent = session({
      pid: 1,
      sessionId: 'p',
      name: 'orch',
      status: 'idle'
    });
    const child = session({
      pid: 2,
      sessionId: 'c',
      name: 'peer',
      parentSessionId: 'p'
    });
    // Would also qualify as "used" if alone; with children the cascade dialog
    // is the only one offered.
    const plan = closePlan(parent, [parent, child], inputs({ hasExchanges: true }));
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.ok(plan.buttons.includes('End just this one'));
    assert.equal(plan.buttons.includes('End session'), false);
  });

  it('says the same of every session, because every card is a pipe', () => {
    // The detail used to fork on the source, and the other arm said the
    // terminal closes too — true of a session someone typed `claude` for, which
    // is no longer a card (row 53).
    const s = session({ status: 'busy', name: 'peer' });
    const plan = closePlan(s, [s], inputs({ processCount: 0 }));
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.match(plan.detail, /Its card goes with it/);
  });

  /**
   * The count is copy for the dialog and nothing else, so an end that asks
   * nothing is sent without the scan behind it.
   */
  it('decides without a process count, and says when the dialog wants one', () => {
    const s = session({ status: 'busy', name: 'agent' });
    const plan = closePlan(s, [s], { alreadyDead: false, hasExchanges: false });
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.equal(plan.countsProcesses, true);
    const idle = session({ status: 'idle' });
    assert.deepEqual(closePlan(idle, [idle], { alreadyDead: false, hasExchanges: false }), {
      kind: 'stop',
      cascade: []
    });
  });

  it('wants no count for a cascade, whose detail names sessions instead', () => {
    const parent = session({ pid: 1, sessionId: 'p' });
    const child = session({ pid: 2, sessionId: 'c', parentSessionId: 'p' });
    const plan = closePlan(parent, [parent, child], inputs());
    assert.equal(plan.kind, 'confirm');
    if (plan.kind !== 'confirm') return;
    assert.equal(plan.countsProcesses, undefined);
  });
});

/**
 * The other half of a stop, and the half that lasts: which cards say they are
 * stopping on the polls between the signal and the process actually going.
 *
 * Every case here is one `now` against one board, which is why this is a test
 * rather than something to watch happen — the deadline it pins is fifteen
 * seconds long and the poll that would exercise it is three.
 */
