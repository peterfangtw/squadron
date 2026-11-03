import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as authoring from '../../core/workflows/authoring';
import type { EditStep } from '../../core/workflows/authoring';

/** A step the edits can copy. Prompts are irrelevant to structure. */
const step = (id: string, extra: Partial<EditStep> = {}): EditStep => ({ id, label: id, ...extra });

const ok = <T extends EditStep>(result: authoring.EditResult<T>): T[] => {
  if ('refused' in result) assert.fail(result.refused);
  return result.steps;
};

/** One session, each step waiting on the one above — how every chain reads now. */
const chain = (...ids: string[]): EditStep[] =>
  ids.map((id, i) => step(id, i > 0 ? { needs: [ids[i - 1] ?? ''] } : {}));

const shape = (steps: readonly EditStep[]) =>
  steps.map((s) => ({ id: s.id, lane: s.lane, needs: s.needs }));

describe('structural rules', () => {
  it('says nothing about a chain', () => {
    assert.deepEqual(authoring.structuralReasons([step('a'), step('b', { needs: ['a'] })]), []);
  });

  it('names the step a needs lie is about', () => {
    assert.deepEqual(
      authoring.structuralReasons([step('a'), step('b', { needs: ['a', 'gone'] })]),
      ['b needs gone, which is not an earlier step']
    );
  });
});

describe('sessions a run can open', () => {
  it('asks nothing of a one-session chain', () => {
    assert.deepEqual(authoring.unopenedLanes([step('a'), step('b', { needs: ['a'] })]), []);
  });

  it('names a session step with no needs, even when no wire exists', () => {
    const reasons = authoring.unopenedLanes([step('a'), step('b', { lane: 's1' })]);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? '', /^b opens s1 with no step wired before it/);
  });

  it('names a session step that waits on nothing once any wire exists', () => {
    const reasons = authoring.unopenedLanes([
      step('a'),
      step('b', { needs: ['a'] }),
      step('c', { lane: 's1' })
    ]);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? '', /^c opens s1 with no step wired before it/);
  });

  it('lets this session hold as many roots as it likes', () => {
    assert.deepEqual(
      authoring.unopenedLanes([step('a'), step('b'), step('c', { needs: ['a'] })]),
      []
    );
  });
});

describe('draft edits', () => {
  it('adds a session beside the only step as a root the run refuses', () => {
    const steps = ok(authoring.addLane([step('plan')], undefined, step('build')));
    assert.deepEqual(shape(steps), [
      { id: 'plan', lane: undefined, needs: undefined },
      { id: 'build', lane: 'session 1', needs: undefined }
    ]);
    assert.equal(authoring.unopenedLanes(steps).length, 1);
  });

  it('leaves a one-session chain a chain when a middle step is deleted', () => {
    const steps = ok(authoring.removeStep(chain('a', 'b', 'c', 'd'), 'b'));
    assert.deepEqual(
      steps.map((s) => [s.id, s.needs]),
      [
        ['a', undefined],
        ['c', ['a']],
        ['d', ['c']]
      ]
    );
  });

  it('keeps another session in order when a delete cuts the path through it', () => {
    const steps = ok(
      authoring.removeStep(
        [
          step('p'),
          step('y', { lane: 'side', needs: ['p'] }),
          step('r', { needs: ['p', 'y'] }),
          step('x', { lane: 'side', needs: ['r'] })
        ],
        'r'
      )
    );
    assert.deepEqual(steps.find((s) => s.id === 'x')?.needs, ['y']);
    assert.deepEqual(authoring.structuralReasons(steps), []);
  });

  it('leaves a lane the author broke as it was written', () => {
    const steps = ok(
      authoring.removeStep(
        [
          step('a'),
          step('q', { lane: 'side', needs: ['a'] }),
          step('s', { lane: 'side', needs: ['a'] }),
          step('z', { needs: ['a'] })
        ],
        'z'
      )
    );
    assert.deepEqual(steps.find((s) => s.id === 's')?.needs, ['a']);
  });

  it('puts a step after a lane mate further up, or further down', () => {
    const lane = [step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['b'] })];
    const up = ok(authoring.placeInLane(lane, 'c', 'a'));
    assert.deepEqual(
      up.map((s) => s.id),
      ['a', 'c', 'b']
    );
    assert.deepEqual(authoring.structuralReasons(up), []);
    const down = ok(authoring.placeInLane(lane, 'a', 'c'));
    assert.deepEqual(
      down.map((s) => s.id),
      ['b', 'c', 'a']
    );
    assert.deepEqual(authoring.structuralReasons(down), []);
  });

  it('puts a step first in its lane, and leaves one already there alone', () => {
    const lane = [step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['b'] })];
    assert.deepEqual(
      ok(authoring.placeInLane(lane, 'c', null)).map((s) => s.id),
      ['c', 'a', 'b']
    );
    assert.deepEqual(ok(authoring.placeInLane(lane, 'b', 'a')), lane);
  });

  it('hands a lane’s model to the step it puts first', () => {
    const steps = [
      step('a'),
      step('x1', { lane: 'X', needs: ['a'], brand: 'claude', model: 'opus' }),
      step('x2', { lane: 'X', needs: ['x1'] })
    ];
    const placed = ok(authoring.placeInLane(steps, 'x2', null));
    assert.equal(placed.find((s) => s.id === 'x2')?.model, 'opus');
    assert.equal(placed.find((s) => s.id === 'x1')?.model, undefined);
    assert.deepEqual(authoring.structuralReasons(placed), []);
  });

  it('reorders a chain by rewriting its needs', () => {
    const placed = ok(authoring.placeInLane(chain('a', 'b', 'c'), 'a', 'c'));
    assert.deepEqual(
      placed.map((s) => [s.id, s.needs]),
      [
        ['b', undefined],
        ['c', ['b']],
        ['a', ['c']]
      ]
    );
  });

  it('refuses a place that would wait on its own downstream', () => {
    const steps = [
      step('a'),
      step('b', { needs: ['a'] }),
      step('x', { lane: 'side', needs: ['b'] }),
      step('c', { needs: ['b', 'x'] })
    ];
    // b after c: b would wait on c, which waits on b through x.
    assert.deepEqual(authoring.placeInLane(steps, 'b', 'c'), { refused: 'would loop' });
  });

  it('keeps a wire from another lane on the step it places', () => {
    const steps = [
      step('a'),
      step('x', { lane: 'side' }),
      step('b', { needs: ['a'] }),
      step('c', { needs: ['b', 'x'] })
    ];
    const placed = ok(authoring.placeInLane(steps, 'c', 'a'));
    assert.equal(placed.find((s) => s.id === 'c')?.needs?.includes('x'), true);
    assert.deepEqual(authoring.structuralReasons(placed), []);
  });

  it('rejoins only its own session when a step is deleted', () => {
    const steps = ok(
      authoring.removeStep(
        [
          step('p'),
          step('q', { lane: 'side' }),
          step('r', { needs: ['p', 'q'] }),
          step('x', { lane: 'other', needs: ['r'] }),
          step('f', { needs: ['r'] })
        ],
        'r'
      )
    );
    assert.equal(steps.find((s) => s.id === 'x')?.needs, undefined);
    assert.deepEqual(steps.find((s) => s.id === 'f')?.needs, ['p']);
  });

  it('adds an unwired session to a wired draft as a root the run refuses', () => {
    const steps = ok(
      authoring.addLane([step('plan'), step('build', { needs: ['plan'] })], undefined, step('docs'))
    );
    assert.equal(steps.find((s) => s.id === 'docs')?.needs, undefined);
    assert.equal(authoring.unopenedLanes(steps).length, 1);
  });

  it('writes a chain out before a tier-1 peer, and leaves the peer with no needs', () => {
    const chain = ok(authoring.insertInLane([step('plan')], 'plan', step('reconcile')));
    const added = ok(authoring.addLane(chain, undefined, step('build')));
    assert.deepEqual(shape(added), [
      { id: 'plan', lane: undefined, needs: undefined },
      { id: 'reconcile', lane: undefined, needs: ['plan'] },
      { id: 'build', lane: 'session 1', needs: undefined }
    ]);
    assert.deepEqual(authoring.structuralReasons(added), []);
  });

  it('picks one past the highest session number, not a gap', () => {
    const steps = [
      step('plan'),
      step('a', { lane: 'session 1', needs: ['plan'] }),
      step('b', { lane: 'session 3', needs: ['plan'] })
    ];
    const added = ok(authoring.addLane(steps, 'plan', step('c')));
    assert.equal(added.find((s) => s.id === 'c')?.lane, 'session 4');
  });

  it('builds scenario 1: plan, two lanes, reconcile, model on build alone', () => {
    let steps = [step('plan', { label: 'Write the plan' })];
    steps = ok(authoring.addLane(steps, 'plan', step('build', { label: 'Build it' })));
    steps = ok(authoring.addLane(steps, 'plan', step('docs', { label: 'Write the notes' })));
    steps = ok(authoring.renameLane(steps, 'session 1', 'builder'));
    steps = ok(authoring.renameLane(steps, 'session 2', 'docs writer'));
    steps = ok(authoring.insertInLane(steps, 'plan', step('reconcile', { label: 'Reconcile' })));
    steps = ok(authoring.link(steps, 'build', 'reconcile'));
    steps = ok(authoring.link(steps, 'docs', 'reconcile'));
    steps = ok(authoring.unlink(steps, 'plan', 'reconcile'));
    const build = steps.find((s) => s.id === 'build');
    if (build) {
      build.brand = 'claude';
      build.model = 'sonnet-5.5';
    }
    assert.deepEqual(shape(steps), [
      { id: 'plan', lane: undefined, needs: undefined },
      { id: 'build', lane: 'builder', needs: ['plan'] },
      { id: 'docs', lane: 'docs writer', needs: ['plan'] },
      { id: 'reconcile', lane: undefined, needs: ['build', 'docs'] }
    ]);
    assert.equal(steps.find((s) => s.id === 'docs')?.brand, undefined);
    assert.equal(steps.find((s) => s.id === 'build')?.model, 'sonnet-5.5');
    assert.deepEqual(authoring.structuralReasons(steps), []);
  });

  it('keeps the wire that holds a lane in order, in the card’s words', () => {
    // builder: build → test. build is test's lane order, not a wire anyone drew.
    const steps: EditStep[] = [
      step('plan', { label: 'Write the plan' }),
      step('build', { label: 'Build it', lane: 'builder', needs: ['plan'] }),
      step('test', { label: 'Test it', lane: 'builder', needs: ['build'] })
    ];
    assert.deepEqual(authoring.unlink(steps, 'build', 'test'), {
      refused: 'Kept. builder is one session: it runs Build it, then this'
    });
  });

  it('refuses the previous of a chain in the same words', () => {
    const steps = [
      step('plan', { label: 'Write the plan' }),
      step('build', { label: 'Build it', needs: ['plan'] })
    ];
    const kept = authoring.unlink(steps, 'plan', 'build');
    assert.equal(
      'refused' in kept ? kept.refused : '',
      'Kept. this session is one session: it runs Write the plan, then this'
    );
  });

  it('a new edge moves only the step it blocks', () => {
    const steps = [
      step('plan'),
      step('docs', { lane: 'docs writer', needs: ['plan'] }),
      step('outline', { needs: ['plan'] })
    ];
    // outline was written after docs. docs starts waiting for it, so outline
    // moves up and plan stays put.
    const linked = ok(authoring.link(steps, 'outline', 'docs'));
    assert.deepEqual(
      linked.map((s) => s.id),
      ['plan', 'outline', 'docs']
    );
    assert.deepEqual(linked.find((s) => s.id === 'docs')?.needs, ['plan', 'outline']);
  });

  it('refuses a wire that would loop', () => {
    const steps = [step('plan'), step('build', { needs: ['plan'] })];
    assert.deepEqual(authoring.link(steps, 'build', 'plan'), {
      refused: 'would loop',
      why: 'loop'
    });
  });

  it('refuses a wire that skips a step of its own lane', () => {
    const steps = [
      step('plan', { label: 'Write the plan' }),
      step('build', { label: 'Build it' }),
      step('ship', { label: 'Ship it' }),
      step('review', { lane: 'reviewer', needs: ['plan'] }),
      step('fix', { lane: 'reviewer', needs: ['review'] }),
      step('recheck', { lane: 'reviewer', needs: ['fix'] })
    ];
    assert.deepEqual(authoring.link(steps, 'plan', 'ship'), {
      refused:
        'Skips Build it. this session is one session: this already waits for the step above it',
      why: 'skip',
      skips: 'Build it'
    });
    assert.ok('refused' in authoring.link(steps, 'review', 'recheck'));
    assert.ok('steps' in authoring.link(steps, 'build', 'ship'), 'the step right above is fine');
    assert.ok('steps' in authoring.link(steps, 'plan', 'recheck'), 'another lane is fine');
  });

  it('refuses a wire into the step that starts the run', () => {
    // An unwired session step is upstream of nothing, so no loop catches it.
    // Linked, step 1 waited on a session only it could open: no step drew in
    // row 1 and the run could never start.
    const steps = [step('plan'), step('build', { needs: ['plan'] }), step('notes', { lane: 'n' })];
    assert.deepEqual(authoring.link(steps, 'notes', 'plan'), {
      refused: 'plan would start the run, so it can wait for no step',
      why: 'starts'
    });
    assert.deepEqual(authoring.link(steps, 'build', 'plan'), {
      refused: 'would loop',
      why: 'loop'
    });
    assert.ok('steps' in authoring.link(steps, 'notes', 'build'), 'a later step can wait on it');
  });

  it('lists every wire a step cannot draw, and why, from link itself', () => {
    const steps = [
      step('plan'),
      step('build', { label: 'Build it', needs: ['plan'] }),
      step('ship', { needs: ['build'] }),
      step('notes', { lane: 'n' })
    ];
    const why = (from: string) =>
      Object.fromEntries(
        [...authoring.linkRefusals(steps, from)].map(([id, r]) => [id, [r.why, r.skips]])
      );
    assert.deepEqual(why('ship'), {
      plan: ['loop', undefined],
      build: ['loop', undefined]
    });
    assert.deepEqual(why('plan'), { ship: ['skip', 'Build it'] });
    // notes is another lane: build and ship are no skip, plan starts the run.
    assert.deepEqual(why('notes'), { plan: ['starts', undefined] });
  });

  it('refuses no wire into step 1 of a draft that already starts on a wait', () => {
    // `blocksStart` leaves a draft that began so as the author wrote it.
    const steps = [
      step('notes', { lane: 'n' }),
      step('plan', { needs: ['notes'] }),
      step('ship', { needs: ['plan'] }),
      step('extra', { lane: 'm' })
    ];
    assert.equal(authoring.linkRefusals(steps, 'extra').has('plan'), false);
    assert.ok('steps' in authoring.link(steps, 'extra', 'plan'));
  });

  describe('a card dropped into a row', () => {
    // Rows are 1-based, as the canvas numbers its cells.
    const into = (row: number) => ({ row, last: false });
    const ids = (result: authoring.EditResult<EditStep> | undefined) =>
      result && 'steps' in result ? result.steps.map((s) => s.id) : result;

    it('takes the row of a step above it in its column, and goes first there', () => {
      assert.deepEqual(ids(authoring.dropInRow(chain('plan', 'build'), 'build', into(1))), [
        'build',
        'plan'
      ]);
    });

    it('puts a card first in a named column from its row 2, the first it has', () => {
      const steps = [
        step('plan'),
        step('a', { lane: 's1', needs: ['plan'] }),
        step('b', { lane: 's1', needs: ['a'] })
      ];
      const dropped = authoring.dropInRow(steps, 'b', into(2));
      assert.ok(dropped && 'steps' in dropped);
      assert.deepEqual(
        dropped.steps.filter((s) => s.lane === 's1').map((s) => s.id),
        ['b', 'a']
      );
    });

    it('reads a lower row as though the card were lifted out', () => {
      assert.deepEqual(ids(authoring.dropInRow(chain('plan', 'build'), 'plan', into(2))), [
        'build',
        'plan'
      ]);
    });

    it('refuses a row with no step of its column above it', () => {
      const steps = [step('plan'), step('build', { lane: 'session 1' })];
      assert.deepEqual(authoring.dropInRow(steps, 'plan', into(3)), {
        refused: 'Draw a wire from a row-2 step to put it here.'
      });
    });

    it('says nothing when the last step is dropped on its own Add step', () => {
      assert.equal(
        authoring.dropInRow(chain('plan', 'build'), 'build', { row: 3, last: true }),
        undefined
      );
    });

    it('says which wire keeps a card below the row it was dropped in', () => {
      const steps = [
        step('plan', { label: 'Plan' }),
        step('n', { label: 'Note', lane: 's1', needs: ['plan'] }),
        step('n2', { label: 'Note again', lane: 's1', needs: ['n'] }),
        step('build', { label: 'Build', needs: ['plan', 'n2'] })
      ];
      assert.deepEqual(authoring.dropInRow(steps, 'build', into(2)), {
        refused: 'Kept in row 4: it waits on Note again. Delete that wire to move it up.'
      });
    });

    it('anchors on the step drawn above it, below a tier two rows tall', () => {
      // b and c share tier 2, so d is drawn in row 4 while its tier is 3.
      const steps = [
        step('a'),
        step('b', { needs: ['a'] }),
        step('c', { needs: ['a'] }),
        step('d', { needs: ['b'] }),
        step('e', { needs: ['d'] })
      ];
      const dropped = authoring.dropInRow(steps, 'e', into(4));
      assert.ok(dropped && 'steps' in dropped);
      assert.deepEqual(dropped.steps.find((s) => s.id === 'e')?.needs, ['c']);
    });
  });

  it('refuses a move or a delete that leaves the run starting on a wait', () => {
    // build waits on notes, a session nothing opens. Put first, it starts the run.
    const steps = [
      step('plan'),
      step('build', { label: 'Build it', needs: ['plan', 'notes'] }),
      step('notes', { lane: 'n' })
    ];
    const refused = { refused: 'Build it would start the run, so it can wait for no step' };
    assert.deepEqual(authoring.placeInLane(steps, 'build', null), refused);
    assert.deepEqual(authoring.removeStep(steps, 'plan'), refused);
    assert.ok('steps' in authoring.removeStep(steps, 'build'), 'the waiting step itself can go');
    // A draft that already starts waiting is the author's to repair.
    const broken = [step('notes', { lane: 'n' }), step('plan', { needs: ['notes'] }), step('ship')];
    assert.ok('steps' in authoring.removeStep(broken, 'ship'));
  });

  it('refuses a skip down a one-lane chain', () => {
    const steps = [step('plan'), step('build'), step('ship')];
    assert.ok('refused' in authoring.link(steps, 'plan', 'ship'));
  });

  it('a swap up a chain writes the chain', () => {
    const steps = [step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['b'] })];
    const swapped = ok(authoring.placeInLane(steps, 'b', null));
    assert.deepEqual(shape(swapped), [
      { id: 'b', lane: undefined, needs: undefined },
      { id: 'a', lane: undefined, needs: ['b'] },
      { id: 'c', lane: undefined, needs: ['a'] }
    ]);
    assert.deepEqual(authoring.structuralReasons(swapped), []);
  });

  it('a swap at the end of a chain hands the moved step the wire above', () => {
    const steps = [step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['b'] })];
    const swapped = ok(authoring.placeInLane(steps, 'c', 'a'));
    assert.deepEqual(shape(swapped), [
      { id: 'a', lane: undefined, needs: undefined },
      { id: 'c', lane: undefined, needs: ['a'] },
      { id: 'b', lane: undefined, needs: ['c'] }
    ]);
    assert.deepEqual(authoring.structuralReasons(swapped), []);
  });

  it('a wire into a lane stays on the step when the lane swaps', () => {
    const steps = [
      step('plan'),
      step('build', { lane: 'builder', needs: ['plan'] }),
      step('test', { lane: 'builder', needs: ['build', 'plan'] })
    ];
    const swapped = ok(authoring.placeInLane(steps, 'test', null));
    const test = swapped.find((s) => s.id === 'test');
    const build = swapped.find((s) => s.id === 'build');
    assert.equal(test?.needs?.includes('plan'), true);
    assert.equal(build?.needs?.includes('test'), true);
    assert.equal(build?.needs?.includes('plan'), true);
  });

  it('refuses a blank or taken lane name', () => {
    const steps = [step('a', { lane: 'builder' }), step('b', { lane: 'docs', needs: ['a'] })];
    assert.deepEqual(authoring.renameLane(steps, 'builder', '  '), {
      refused: 'a lane needs a name'
    });
    assert.deepEqual(authoring.renameLane(steps, 'docs', 'builder'), {
      refused: "builder is taken — two lanes can't share a name"
    });
    assert.deepEqual(authoring.renameLane(steps, '', 'elsewhere'), {
      refused: 'this session is not a name in the file'
    });
  });

  it('opener fields follow the lane when its first step changes', () => {
    const steps = [
      step('plan'),
      step('build', { lane: 'builder', needs: ['plan'], brand: 'claude', model: 'sonnet' }),
      step('test', { lane: 'builder', needs: ['build'] })
    ];
    const swapped = ok(authoring.placeInLane(steps, 'test', null));
    assert.equal(swapped.find((s) => s.id === 'test')?.model, 'sonnet');
    assert.equal(swapped.find((s) => s.id === 'build')?.model, undefined);
  });

  it('builds the eleven-step fixture in lane, needs and order', () => {
    // `wfgraph.ts` REAL, from one step.
    let steps = [step('impl')];
    steps = ok(authoring.insertInLane(steps, 'impl', step('wire')));
    const open = (id: string, after: string, name: string) => {
      steps = ok(authoring.addLane(steps, after, step(id)));
      const lane = steps.find((s) => s.id === id)?.lane;
      if (lane === undefined) assert.fail(`${id} opened no lane`);
      steps = ok(authoring.renameLane(steps, lane, name));
    };
    open('ui', 'impl', 's1');
    open('rw', 'wire', 's2');
    open('ru', 'ui', 's3');
    const splice = (id: string, after: string, laneNeeds: string) => {
      steps = ok(authoring.insertInLane(steps, after, step(id)));
      steps = ok(authoring.link(steps, laneNeeds, id));
      const dropped = authoring.unlink(steps, after, id);
      if (!('refused' in dropped)) steps = dropped.steps;
    };
    splice('aw', 'wire', 'rw');
    splice('au', 'ui', 'ru');
    steps = ok(authoring.insertInLane(steps, 'aw', step('int')));
    steps = ok(authoring.link(steps, 'au', 'int'));
    splice('riw', 'rw', 'int');
    splice('riu', 'ru', 'int');
    splice('ship', 'int', 'riw');
    steps = ok(authoring.link(steps, 'riu', 'ship'));
    assert.deepEqual(shape(steps), [
      { id: 'impl', lane: undefined, needs: undefined },
      { id: 'wire', lane: undefined, needs: ['impl'] },
      { id: 'ui', lane: 's1', needs: ['impl'] },
      { id: 'rw', lane: 's2', needs: ['wire'] },
      { id: 'ru', lane: 's3', needs: ['ui'] },
      { id: 'aw', lane: undefined, needs: ['rw'] },
      { id: 'au', lane: 's1', needs: ['ru'] },
      { id: 'int', lane: undefined, needs: ['aw', 'au'] },
      { id: 'riw', lane: 's2', needs: ['int'] },
      { id: 'riu', lane: 's3', needs: ['int'] },
      { id: 'ship', lane: undefined, needs: ['riw', 'riu'] }
    ]);
    assert.deepEqual(authoring.structuralReasons(steps), []);
  });
});
