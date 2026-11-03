import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from '../../core/model';
import { stepCommand } from '../../core/paths';
import { decideNext, type NextSnapshot } from '../../core/workflows/next';
import type { Progress, StepStatus } from '../../core/workflows/progress';
import type { Workflow } from '../../core/workflows/workflows';

// The program alone, as every prompt that hands `squadron-step` opens it.
const STEP_COMMAND = stepCommand('posix');

const NOW_MS = 1_700_000_000_000;
/** When the anchor opened its lanes — old enough not to be fresh. */
const OPENED = NOW_MS - 10_000;

const lanesWf: Workflow = {
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'note', label: 'Note', prompt: 'note it', needs: ['plan'] },
    { id: 'a', label: 'A', prompt: 'do a', lane: 's1', needs: ['plan'], model: 'opus' },
    { id: 'b', label: 'B', prompt: 'do b', lane: 's2', needs: ['plan'] },
    { id: 'join', label: 'Join', prompt: 'join them', needs: ['a', 'b', 'note'] }
  ]
};

const record = (
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): Progress => ({
  schema: 1,
  sessionId: 'anchor',
  workflowId: 'ship',
  label: 'Ship it',
  updatedAt: NOW_MS - 5_000,
  kind: 'pipeline',
  steps: steps.map(([id, status]) => ({ id, label: id, status })),
  ...over
});

const laneRun = (lane: string, steps: readonly [string, StepStatus][]) =>
  record(steps, { sessionId: `sess-${lane}`, lane, anchor: 'anchor', opened: OPENED });

const session = (over: Partial<Session> = {}): Session => ({
  pid: 10,
  sessionId: 'anchor',
  cwd: '/repo',
  name: 'card',
  status: 'busy',
  hasCommand: true,
  startedAt: 0,
  updatedAt: 0,
  transcript: '/tmp/t.jsonl',
  source: 'owned',
  windowId: 'w1',
  ...over
});

const IDLE = { status: 'idle', hasCommand: false } as const;

/** A file that names no lane. The laned fixture above is a different run. */
const buildWf: Workflow = {
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'build', label: 'Build', prompt: 'build it' }
  ]
};

const anchorBoard = [
  session({ pid: 10, sessionId: 'anchor', name: 'anchor' }),
  session({ pid: 21, sessionId: 'sess-s1', name: 's1', parentSessionId: 'anchor' }),
  session({ pid: 22, sessionId: 'sess-s2', name: 's2', parentSessionId: 'anchor' })
];

const snapshot = (progress: Progress, over: Partial<NextSnapshot> = {}): NextSnapshot => ({
  progress,
  shell: 'posix',
  workflow: lanesWf,
  cwd: '/repo',
  now: NOW_MS,
  others: [],
  sessions: [session()],
  ...over
});

describe('decideNext', () => {
  it('serves the cursor of a file with no lanes, and hands back the record unchanged on a reprint', () => {
    const plain: Workflow = { ...lanesWf, steps: lanesWf.steps.slice(0, 2) };
    const fresh = record([
      ['plan', 'pending'],
      ['note', 'pending']
    ]);
    const served = decideNext(snapshot(fresh, { workflow: plain }));
    assert.equal(served.kind, 'serve');
    if (served.kind !== 'serve') return;
    assert.match(served.out, /Plan/);
    assert.equal(served.write.steps[0]?.status, 'in_progress');

    const again = decideNext(snapshot(served.write, { workflow: plain }));
    assert.equal(again.kind === 'serve' ? again.write : undefined, served.write);
  });

  it('opens every ready lane before serving, ending nothing', () => {
    const anchor = record(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { pid: 10 }
    );
    const decided = decideNext(snapshot(anchor));
    assert.deepEqual(decided, {
      kind: 'open',
      ends: [],
      opens: [{ lane: 's1' }, { lane: 's2' }],
      write: anchor
    });
    assert.equal(decided.kind === 'open' ? decided.write : undefined, anchor, 'nothing moved');
  });

  it('waits on the lanes holding what the cursor needs', () => {
    const anchor = record(
      [
        ['plan', 'completed'],
        ['note', 'completed'],
        ['join', 'pending']
      ],
      {
        pid: 10,
        lanes: { s1: { pid: 21, openedAt: OPENED }, s2: { pid: 22, openedAt: OPENED } }
      }
    );
    const decided = decideNext(
      snapshot(anchor, {
        others: [laneRun('s1', [['a', 'in_progress']]), laneRun('s2', [['b', 'in_progress']])],
        sessions: [
          session(),
          session({ pid: 21, sessionId: 'sess-s1' }),
          session({ pid: 22, sessionId: 'sess-s2' })
        ]
      })
    );
    assert.equal(decided.kind, 'wait');
    assert.deepEqual(decided.kind === 'wait' ? decided.pids : [], [21, 22]);
    // A busy member resets the loop breaker's count, and nothing else moved.
    assert.equal(decided.kind === 'wait' ? decided.write : undefined, anchor);
  });

  it('refuses a cancelled run, and an open with no board, with the board’s code', () => {
    const anchor = record([
      ['plan', 'completed'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    assert.deepEqual(decideNext(snapshot({ ...anchor, cancelledAt: NOW_MS })), {
      kind: 'refuse',
      code: 2,
      reason: 'this run was cancelled from the panel'
    });
    const refused = { code: 3 as const, reason: 'no live IDE window' };
    assert.deepEqual(decideNext(snapshot(anchor, { sessions: undefined, boardRefused: refused })), {
      kind: 'refuse',
      ...refused
    });
  });

  it('ends an idle lane whose pick never started, and reopens it falling back (L4)', () => {
    const anchor = record(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { pid: 10, lanes: { s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' } } }
    );
    const decided = decideNext(
      snapshot(anchor, {
        sessions: [session(IDLE), session({ pid: 21, sessionId: 'sess-s1', ...IDLE })],
        lineage: new Map([[21, { requestId: 'req-s1', spawnedAt: 0 }]])
      })
    );
    assert.equal(decided.kind, 'open');
    if (decided.kind !== 'open') return;
    assert.deepEqual(decided.ends, [21]);
    assert.deepEqual(decided.opens, [{ lane: 's1', fellBack: true }]);
    assert.deepEqual(decided.write.lanes, {}, 'the failed claim is dropped for the reopen');
    assert.equal(decided.write.pid, 10);
  });
});

describe('decideNext for a file with no lanes', () => {
  const run = (steps: readonly [string, StepStatus][], over: Partial<Progress> = {}) =>
    record(steps, { sessionId: 'sess-1', ...over });

  it('refuses a blocked run and says which step stopped it', () => {
    const decided = decideNext(
      snapshot(
        run([
          ['plan', 'failed'],
          ['build', 'pending']
        ]),
        { workflow: buildWf }
      )
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /plan/);
  });

  it('refuses a cancelled run', () => {
    const decided = decideNext(
      snapshot(run([['plan', 'pending']], { cancelledAt: NOW_MS - 1 }), { workflow: buildWf })
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /cancel/i);
  });

  it('serves a step, and asks for the record to be written', () => {
    const decided = decideNext(
      snapshot(
        run([
          ['plan', 'pending'],
          ['build', 'pending']
        ]),
        { workflow: buildWf }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out, /Step 1 of 2 · "Plan"/);
    assert.match(decided.out, /plan it/);
    assert.equal(decided.write.steps[0]?.status, 'in_progress');
  });

  it('reprints without pretending it is new', () => {
    const decided = decideNext(
      snapshot(
        run([
          ['plan', 'in_progress'],
          ['build', 'pending']
        ]),
        { workflow: buildWf }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out, /already have this one/i);
  });

  it('says the run is complete on the FIRST line, since the code cannot', () => {
    // Both are exit 0. A looping agent has to tell them apart without a second
    // call, so the distinction is the first thing printed.
    const decided = decideNext(
      snapshot(
        run([
          ['plan', 'completed'],
          ['build', 'completed']
        ]),
        { workflow: buildWf }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out.split('\n')[0] ?? '', /^Run complete/);
  });

  it('hands back the untouched record on complete, so a repeat writes nothing', () => {
    // `complete` carries a record because a run can finish *by* an edit that
    // drops a trailing step. On an unedited run it is the same object, and
    // identity is what keeps a repeated `next` off the file's mtime.
    const current = run([
      ['plan', 'completed'],
      ['build', 'completed']
    ]);
    const decided = decideNext(snapshot(current, { workflow: buildWf }));
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.equal(decided.write, current, 'same object — nothing moved');
  });

  it('carries unresolved references out rather than emptying them', () => {
    const wf: Workflow = {
      ...buildWf,
      steps: [{ id: 'plan', label: 'Plan', prompt: 'ship ${identifier}' }]
    };
    const decided = decideNext(snapshot(run([['plan', 'pending']]), { workflow: wf }));
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.deepEqual(decided.unresolved, ['identifier']);
    assert.match(decided.out, /\$\{identifier\}/);
  });
});

describe('decideNext for a file with lanes', () => {
  const anchor = (steps: readonly [string, StepStatus][], over: Partial<Progress> = {}) =>
    record(steps, { pid: 10, ...over });

  it('serves the anchor’s own step once the lanes are recorded', () => {
    const decided = decideNext(
      snapshot(
        anchor(
          [
            ['plan', 'completed'],
            ['note', 'pending'],
            ['join', 'pending']
          ],
          {
            lanes: {
              s1: { pid: 21, openedAt: NOW_MS },
              s2: { pid: 22, openedAt: NOW_MS }
            }
          }
        ),
        { sessions: anchorBoard }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out, /Step 2 of 3/);
    assert.equal(decided.write.steps.find((step) => step.id === 'note')?.status, 'in_progress');
  });

  it('waits on the anchor when a lane’s step is not ready', () => {
    const lane = record([['a', 'pending']], {
      sessionId: 'sess-s1',
      armedAt: NOW_MS,
      lane: 's1',
      anchor: 'anchor',
      opened: OPENED
    });
    const decided = decideNext(
      snapshot(lane, {
        pid: undefined,
        sessions: anchorBoard,
        others: [
          anchor(
            [
              ['plan', 'in_progress'],
              ['note', 'pending'],
              ['join', 'pending']
            ],
            { lanes: { s1: { pid: 21, openedAt: OPENED } } }
          )
        ]
      })
    );
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [10]);
    assert.notEqual(decided.write.steps.find((step) => step.id === 'a')?.status, 'in_progress');
  });

  it('waits on the lane holding the step the anchor needs', () => {
    const decided = decideNext(
      snapshot(
        anchor(
          [
            ['plan', 'completed'],
            ['note', 'completed'],
            ['join', 'pending']
          ],
          {
            lanes: {
              s1: { pid: 21, openedAt: OPENED },
              s2: { pid: 22, openedAt: OPENED }
            }
          }
        ),
        {
          sessions: anchorBoard,
          others: [laneRun('s1', [['a', 'in_progress']]), laneRun('s2', [['b', 'completed']])]
        }
      )
    );
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [21]);
  });

  it('refuses an idle lane whose step is still in progress', () => {
    const decided = decideNext(
      snapshot(
        anchor(
          [
            ['plan', 'completed'],
            ['note', 'completed'],
            ['join', 'pending']
          ],
          {
            lanes: {
              s1: { pid: 21, openedAt: OPENED },
              s2: { pid: 22, openedAt: OPENED, requestId: 'req-s2' }
            }
          }
        ),
        {
          sessions: [
            session({ pid: 10, sessionId: 'anchor', name: 'anchor' }),
            session({ pid: 21, sessionId: 'sess-s1', name: 's1', ...IDLE }),
            session({ pid: 22, sessionId: 'sess-s2', name: 's2', parentSessionId: 'anchor' })
          ],
          others: [laneRun('s1', [['a', 'in_progress']])],
          lineage: new Map([[22, { requestId: 'req-s2', spawnedAt: 0 }]])
        }
      )
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /s1 is idle with a still in progress/);
    assert.ok(decided.reason.includes(STEP_COMMAND));
  });

  it('waits when the anchor’s steps are done but a later lane is not yet openable', () => {
    const late: Workflow = {
      id: 'ship',
      label: 'Ship it',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan it' },
        { id: 'a', label: 'A', prompt: 'do a', lane: 's1', needs: ['plan'] },
        { id: 'b', label: 'B', prompt: 'do b', lane: 's2', needs: ['a'] }
      ]
    };
    const decided = decideNext(
      snapshot(anchor([['plan', 'completed']], { lanes: { s1: { pid: 21, openedAt: OPENED } } }), {
        workflow: late,
        sessions: anchorBoard,
        others: [laneRun('s1', [['a', 'in_progress']])]
      })
    );
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [21]);
  });

  it('says the anchor is done only once every lane is open', () => {
    const decided = decideNext(
      snapshot(
        anchor(
          [
            ['plan', 'completed'],
            ['note', 'completed'],
            ['join', 'completed']
          ],
          { lanes: { s1: { pid: 21, openedAt: 1 }, s2: { pid: 22, openedAt: 1 } } }
        ),
        { sessions: anchorBoard }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.equal(decided.out, 'Run complete — your steps are done, and every lane is open.');
  });

  it('stamps the anchor pid onto the record it serves', () => {
    const fresh = record([
      ['plan', 'pending'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    const decided = decideNext(snapshot(fresh, { sessions: anchorBoard, pid: 10 }));
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out, /Step 1 of 3/);
    assert.equal(decided.write.pid, 10);
    assert.equal(decided.write.steps.find((step) => step.id === 'plan')?.status, 'in_progress');
  });

  it('is a 3 when a lane is ready and no window is up', () => {
    const decided = decideNext(
      snapshot(
        anchor([
          ['plan', 'completed'],
          ['note', 'pending'],
          ['join', 'pending']
        ]),
        {
          sessions: undefined,
          boardRefused: { code: 3, reason: 'no IDE window is running with Squadron installed' }
        }
      )
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 3);
    assert.match(decided.reason, /no IDE window/);
  });

  it('leaves a file that names no lane on the one-session path', () => {
    const decided = decideNext(
      snapshot(
        record(
          [
            ['plan', 'pending'],
            ['build', 'pending']
          ],
          { sessionId: 'sess-1' }
        ),
        {
          workflow: buildWf,
          others: [record([['a', 'in_progress']], { sessionId: 'sess-s1', lane: 's1' })],
          sessions: anchorBoard,
          pid: 99
        }
      )
    );
    assert.equal(decided.kind, 'serve');
    if (decided.kind !== 'serve') return;
    assert.match(decided.out, /^Step 1 of 2/);
    assert.equal(decided.write.pid, undefined);
  });
});

/**
 * The review of `ef6b3916`: a handoff that stalled, waits that looped, and a
 * lane that could belong to two armings.
 */
describe('decideNext lane handoffs and the loop breaker', () => {
  const handoff: Workflow = {
    id: 'ship',
    label: 'Ship it',
    steps: [
      { id: 's1', label: 'S1', prompt: 's1' },
      { id: 'a1', label: 'A1', prompt: 'a1', lane: 'A', needs: ['s1'] },
      { id: 's2', label: 'S2', prompt: 's2', needs: ['a1'] },
      { id: 'a2', label: 'A2', prompt: 'a2', lane: 'A', needs: ['s2'] }
    ]
  };
  const anchorAt = (s2: StepStatus) =>
    record(
      [
        ['s1', 'completed'],
        ['s2', s2]
      ],
      { pid: 10, lanes: { A: { pid: 21, openedAt: OPENED } } }
    );
  const laneAt = (a2: StepStatus) =>
    laneRun('A', [
      ['a1', 'completed'],
      ['a2', a2]
    ]);
  const board = (anchorIdle: boolean, laneIdle: boolean) => [
    session({ pid: 10, sessionId: 'anchor', ...(anchorIdle ? IDLE : {}) }),
    session({
      pid: 21,
      sessionId: 'sess-A',
      parentSessionId: 'anchor',
      ...(laneIdle ? IDLE : {})
    })
  ];
  const at = (self: Progress, others: readonly Progress[], sessions: Session[]) =>
    decideNext(snapshot(self, { workflow: handoff, others, sessions }));

  it('waits on the anchor holding a ready step, rather than refusing a stall', () => {
    const decided = at(laneAt('pending'), [anchorAt('pending')], board(true, false));
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [10]);
  });

  it('waits at the pid the board has now, not the one the record stored', () => {
    const decided = at(
      laneAt('pending'),
      [anchorAt('pending')],
      [session({ pid: 99, sessionId: 'anchor' }), session({ pid: 21, sessionId: 'sess-A' })]
    );
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [99]);
  });

  it('registers two all-idle waits over an unchanged run, then refuses, and goes on refusing', () => {
    let lane = laneAt('pending');
    const anchor = anchorAt('pending');
    const idle = board(true, false);
    for (const round of [1, 2]) {
      const plan = at(lane, [anchor], idle);
      assert.equal(plan.kind, 'wait', `wait ${round}`);
      if (plan.kind !== 'wait') return;
      assert.equal(plan.write.held?.count, round);
      lane = plan.write;
    }
    const third = at(lane, [anchor], idle);
    assert.equal(third.kind, 'refuse');
    if (third.kind !== 'refuse') return;
    assert.equal(third.code, 2);
    assert.match(third.reason, /woken 3 times with nothing in this run moving/);
    assert.match(third.reason, /the armed session \(pid 10\) holds s2/);
    assert.ok(third.reason.includes(`${STEP_COMMAND} next`));
    const fourth = at(lane, [anchor], idle);
    assert.equal(fourth.kind, 'refuse');
    if (fourth.kind !== 'refuse') return;
    assert.equal(fourth.code, 2);
  });

  it('never counts a wait with a busy member, however many times it is registered', () => {
    const lane = laneAt('pending');
    for (let round = 0; round < 5; round += 1) {
      const plan = at(lane, [anchorAt('pending')], board(false, false));
      assert.equal(plan.kind, 'wait');
      if (plan.kind !== 'wait') return;
      assert.equal(plan.write, lane, 'nothing to write');
    }
  });

  it('clears the count once the run moves — here, a lane writing its record', () => {
    const late: Workflow = { ...handoff, steps: handoff.steps.slice(0, 3) };
    let anchor = record(
      [
        ['s1', 'completed'],
        ['s2', 'pending']
      ],
      {
        pid: 10,
        lanes: { A: { pid: 21, openedAt: OPENED, requestId: 'req-A' } }
      }
    );
    const idle = board(false, true);
    const next = (others: readonly Progress[]) =>
      decideNext(
        snapshot(anchor, {
          workflow: late,
          sessions: idle,
          lineage: new Map([[21, { requestId: 'req-A', spawnedAt: 0 }]]),
          others
        })
      );
    for (const round of [1, 2]) {
      const plan = next([]);
      assert.equal(plan.kind, 'wait', `wait ${round} over a lane with no record`);
      if (plan.kind !== 'wait') return;
      anchor = plan.write;
    }
    const stalled = next([]);
    assert.equal(stalled.kind, 'refuse');
    if (stalled.kind !== 'refuse') return;
    assert.equal(stalled.code, 2);
    const started = next([laneRun('A', [['a1', 'pending']])]);
    assert.equal(started.kind, 'wait');
    if (started.kind !== 'wait') return;
    assert.equal(started.write.held?.count, 1);
  });

  for (const first of ['anchor', 'lane'] as const) {
    it(`completes a two-sided handoff with both woken, when the ${first} calls next first`, () => {
      // The anchor slept over A while A was busy; A then waited once over the
      // idle anchor. Both waits resolve in one pass and both sessions wake.
      let anchor = anchorAt('pending');
      const waited = at(laneAt('pending'), [anchor], board(true, false));
      assert.equal(waited.kind, 'wait');
      if (waited.kind !== 'wait') return;
      let lane = waited.write;
      assert.equal(lane.held?.count, 1);
      const woken = board(false, false);
      const order = first === 'anchor' ? ['anchor', 'lane'] : ['lane', 'anchor'];
      for (const who of order) {
        const plan = who === 'anchor' ? at(anchor, [lane], woken) : at(lane, [anchor], woken);
        assert.notEqual(
          plan.kind,
          'refuse',
          plan.kind === 'refuse' ? `${who}: ${plan.reason}` : who
        );
        if (plan.kind === 'refuse') return;
        if (who === 'anchor') anchor = plan.write;
        else lane = plan.write;
      }
      assert.equal(anchor.steps.find((step) => step.id === 's2')?.status, 'in_progress');
    });
  }
});

describe('decideNext arming and lineage', () => {
  const anchor = (over: Partial<Progress> = {}) =>
    record(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { pid: 10, ...over }
    );

  it('counts nothing an earlier arming’s lanes finished, once the lanes are open again', () => {
    const decided = decideNext(
      snapshot(
        anchor({
          steps: [
            { id: 'plan', label: 'plan', status: 'completed' },
            { id: 'note', label: 'note', status: 'completed' },
            { id: 'join', label: 'join', status: 'pending' }
          ],
          lanes: { s1: { pid: 21, openedAt: NOW_MS }, s2: { pid: 22, openedAt: NOW_MS } }
        }),
        {
          sessions: anchorBoard,
          others: [laneRun('s1', [['a', 'completed']]), laneRun('s2', [['b', 'completed']])]
        }
      )
    );
    assert.equal(decided.kind, 'wait');
    if (decided.kind !== 'wait') return;
    assert.deepEqual(decided.pids, [21, 22]);
  });

  it('finds a silent open in lineage rather than opening it again', () => {
    const after = anchor({ lanes: { s1: { openedAt: NOW_MS, requestId: 'req-1' } } });
    const missed = decideNext(snapshot(after, { sessions: anchorBoard, lineage: new Map() }));
    assert.equal(missed.kind, 'refuse');
    if (missed.kind !== 'refuse') return;
    assert.equal(missed.code, 2);
    assert.match(missed.reason, /requestId is req-1/);

    const found = decideNext(
      snapshot(after, {
        sessions: anchorBoard,
        lineage: new Map([[31, { requestId: 'req-1', spawnedAt: 0 }]])
      })
    );
    assert.equal(found.kind, 'open');
    if (found.kind !== 'open') return;
    assert.deepEqual(found.opens, [{ lane: 's2' }]);
    assert.deepEqual(found.write.lanes?.s1, {
      openedAt: NOW_MS,
      requestId: 'req-1',
      pid: 31
    });
  });

  it('refuses a run whose pick and whose fallback were both refused', () => {
    const said =
      "s2: grok-3 could not start (no such model), and neither could this session's model (no such model)";
    const decided = decideNext(
      snapshot(
        anchor({
          lanes: { s2: { openedAt: NOW_MS + 1, fellBack: true, refused: said } }
        }),
        { sessions: anchorBoard }
      )
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /^s2: grok-3 could not start \(no such model\), and neither/);
    assert.match(decided.reason, /Nothing was started for s2/);
    assert.doesNotMatch(decided.reason, /look for a session/);
  });

  it('refuses at once when a session holding a step is no longer on the board', () => {
    const decided = decideNext(
      snapshot(
        anchor({
          steps: [
            { id: 'plan', label: 'plan', status: 'completed' },
            { id: 'note', label: 'note', status: 'completed' },
            { id: 'join', label: 'join', status: 'pending' }
          ],
          lanes: { s1: { pid: 21, openedAt: OPENED }, s2: { pid: 22, openedAt: OPENED } }
        }),
        {
          others: [laneRun('s1', [['a', 'in_progress']]), laneRun('s2', [['b', 'completed']])],
          // A stranger now has s1's old pid; s1's own session is gone.
          sessions: [
            session({ pid: 10, sessionId: 'anchor' }),
            session({ pid: 21, sessionId: 'someone-else' })
          ]
        }
      )
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /s1 holds a and is no longer running/);
  });

  it('waits on a recordless lane’s pid only while lineage says it is that open’s child', () => {
    const lanes = {
      s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' },
      s2: { pid: 22, openedAt: OPENED, requestId: 'req-s2' }
    };
    const done: [string, StepStatus][] = [
      ['plan', 'completed'],
      ['note', 'completed'],
      ['join', 'pending']
    ];
    const spawned = NOW_MS - 60_000;
    const at = (edge: { requestId: string; spawnedAt: number }, startedAt: number) =>
      decideNext(
        snapshot(
          anchor({ steps: done.map(([id, status]) => ({ id, label: id, status })), lanes }),
          {
            others: [laneRun('s2', [['b', 'completed']])],
            sessions: [
              session({ pid: 10, sessionId: 'anchor' }),
              session({ pid: 21, sessionId: 'sess-21', startedAt }),
              session({ pid: 22, sessionId: 'sess-s2', name: 's2', parentSessionId: 'anchor' })
            ],
            lineage: new Map([[21, edge]])
          }
        )
      );
    const ours = at({ requestId: 'req-s1', spawnedAt: spawned }, spawned);
    assert.equal(ours.kind, 'wait');
    if (ours.kind !== 'wait') return;
    assert.deepEqual(ours.pids, [21]);

    const sibling = at({ requestId: 'req-other', spawnedAt: spawned }, spawned);
    assert.equal(sibling.kind, 'refuse');
    if (sibling.kind !== 'refuse') return;
    assert.equal(sibling.code, 2);
    assert.match(sibling.reason, /s1 was opened as pid 21, and that pid is no longer its session/);

    const reused = at({ requestId: 'req-s1', spawnedAt: spawned }, spawned + 30 * 60_000);
    assert.equal(reused.kind, 'refuse');
    if (reused.kind !== 'refuse') return;
    assert.equal(reused.code, 2);
  });

  it('refuses a lane whose anchor was re-armed, cancelled, or is gone', () => {
    const lane = laneRun('s1', [['a', 'pending']]);
    const over = (anchorRecord: Progress | undefined) =>
      decideNext(snapshot(lane, { others: anchorRecord ? [anchorRecord] : [] }));
    for (const plan of [
      over(anchor()),
      over(anchor({ lanes: { s1: { pid: 21, openedAt: OPENED } }, cancelledAt: NOW_MS })),
      over(undefined)
    ]) {
      assert.equal(plan.kind, 'refuse');
      if (plan.kind !== 'refuse') return;
      assert.equal(plan.code, 2);
      assert.match(plan.reason, /the run this lane was opened for is over/);
    }
  });

  it('opens nothing for a cancelled anchor with a lane ready', () => {
    const decided = decideNext(
      snapshot(anchor({ cancelledAt: NOW_MS - 1 }), { sessions: anchorBoard, pid: 10 })
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(decided.reason, /cancelled/);
  });
});

describe('decideNext when a picked model never starts', () => {
  const anchor = (over: Partial<Progress> = {}) =>
    record(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { pid: 10, ...over }
    );
  const recordless = (over: Partial<Progress> = {}) =>
    anchor({ lanes: { s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' } }, ...over });

  it('reopens a gone lane without ending anything', () => {
    const decided = decideNext(
      snapshot(recordless(), {
        sessions: [session({ pid: 10, sessionId: 'anchor', effort: 'xhigh', ...IDLE })],
        lineage: new Map([[21, { requestId: 'req-s1', spawnedAt: 0 }]])
      })
    );
    assert.equal(decided.kind, 'open');
    if (decided.kind !== 'open') return;
    assert.deepEqual(decided.ends, []);
    assert.deepEqual(decided.opens, [{ lane: 's1', fellBack: true }]);
  });

  it('refuses a fallen-back reopen the anchor’s model also refused', () => {
    const said =
      "s1: opus could not start (never started its lane), and neither could this session's model (no such effort)";
    const decided = decideNext(
      snapshot(anchor({ lanes: { s1: { openedAt: NOW_MS, fellBack: true, refused: said } } }), {
        sessions: [session({ pid: 10, sessionId: 'anchor', effort: 'xhigh', ...IDLE })]
      })
    );
    assert.equal(decided.kind, 'refuse');
    if (decided.kind !== 'refuse') return;
    assert.equal(decided.code, 2);
    assert.match(
      decided.reason,
      /^s1: opus could not start \(never started its lane\), and neither/
    );
    assert.doesNotMatch(decided.reason, /look for a session/);
  });

  const blocked = (pick: { brand?: 'claude'; model?: string } | undefined): Workflow => ({
    id: 'ship',
    label: 'Ship it',
    steps: [
      { id: 's1', label: 'S1', prompt: 's1' },
      { id: 'a1', label: 'A1', prompt: 'a1', lane: 'A', needs: ['s1'], ...pick },
      { id: 's2', label: 'S2', prompt: 's2', needs: ['a1'] }
    ]
  });
  const heldAnchor = (fellBack: true | undefined) =>
    record(
      [
        ['s1', 'completed'],
        ['s2', 'pending']
      ],
      {
        pid: 10,
        lanes: {
          A: {
            pid: 21,
            openedAt: OPENED,
            requestId: 'req-A',
            ...(fellBack ? { fellBack } : {})
          }
        }
      }
    );
  const heldBoard = [
    session({ pid: 10, sessionId: 'anchor' }),
    session({ pid: 21, sessionId: 'sess-A', name: 'A', parentSessionId: 'anchor', ...IDLE })
  ];
  const heldNext = (self: Progress, workflow: Workflow) =>
    decideNext(
      snapshot(self, {
        workflow,
        sessions: heldBoard,
        lineage: new Map([[21, { requestId: 'req-A', spawnedAt: 0 }]])
      })
    );

  it('refuses a fallen-back lane as today, once the wait has looped', () => {
    const workflow = blocked({ brand: 'claude', model: 'opus' });
    let self = heldAnchor(true);
    for (const round of [1, 2]) {
      const plan = heldNext(self, workflow);
      assert.equal(plan.kind, 'wait', `wait ${round}`);
      if (plan.kind !== 'wait') return;
      assert.deepEqual(plan.pids, [21]);
      self = plan.write;
    }
    const third = heldNext(self, workflow);
    assert.equal(third.kind, 'refuse');
    if (third.kind !== 'refuse') return;
    assert.equal(third.code, 2);
    assert.match(third.reason, /has not started its lane/);
    assert.match(third.reason, /woken 3 times/);
  });

  it('refuses a lane that stated no pick as today', () => {
    const workflow = blocked(undefined);
    let self = heldAnchor(undefined);
    for (const round of [1, 2]) {
      const plan = heldNext(self, workflow);
      assert.equal(plan.kind, 'wait', `wait ${round}`);
      if (plan.kind !== 'wait') return;
      self = plan.write;
    }
    const third = heldNext(self, workflow);
    assert.equal(third.kind, 'refuse');
    if (third.kind !== 'refuse') return;
    assert.equal(third.code, 2);
    assert.match(third.reason, /has not started its lane/);
  });
});
