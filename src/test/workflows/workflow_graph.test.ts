/**
 * The graph a lane canvas is laid out from, and nothing about how it is drawn.
 *
 * Every number here is arithmetic on a step list, which is the whole reason
 * this module exists apart from the webview: jsdom reports a zero rectangle for
 * everything, so a layout derived in the DOM cannot be checked at all. What can
 * be checked is that tier 3 is tier 3, that a session which stops working at
 * depth 2 and starts again at depth 5 is idle in between, and that the node
 * offering a model is the node that opens a session.
 *
 * The expected values are lifted from `docs/mockups/workflow-v2-directions.html`
 * §3d, where they are hand-authored literals. That is deliberate: the mock is
 * the drawing that was agreed, so a disagreement here is this module being
 * wrong about the picture rather than the picture being restated.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layout, needsOf, opener } from '../../core/workflows/graph';
import type { GraphStep } from '../../core/workflows/graph';

/** §3d: implement, split into wiring and UI, review each half in a session that
 *  did not write it, apply, integrate, review the integration in those *same*
 *  two sessions, then test and commit. Eleven steps, four sessions. */
const REAL: GraphStep[] = [
  { id: 'impl', kind: 'fanout' },
  { id: 'wire', needs: ['impl'] },
  { id: 'ui', lane: 's1', needs: ['impl'] },
  { id: 'rw', lane: 's2', needs: ['wire'] },
  { id: 'ru', lane: 's3', needs: ['ui'] },
  { id: 'aw', needs: ['rw'] },
  { id: 'au', lane: 's1', needs: ['ru'] },
  { id: 'int', kind: 'converge', needs: ['aw', 'au'] },
  { id: 'riw', lane: 's2', needs: ['int'] },
  { id: 'riu', lane: 's3', needs: ['int'] },
  { id: 'ship', kind: 'converge', needs: ['riw', 'riu'] }
];

/** One session, each step waiting on the one above. */
const chain = (...ids: string[]): GraphStep[] =>
  ids.map((id, i) => (i > 0 ? { id, needs: [ids[i - 1] ?? ''] } : { id }));

const badges = (steps: GraphStep[]): (string | undefined)[] => {
  const { at } = layout(steps);
  return steps.map((s) => at.get(s.id)?.badge);
};

const opens = (steps: GraphStep[]): string[] => {
  const { at } = layout(steps);
  return steps.filter((s) => at.get(s.id)?.opens).map((s) => s.id);
};

/** The tiers each lane holds a step in, in file order. */
const tiersByLane = (steps: GraphStep[]): Record<string, number[]> => {
  const { at } = layout(steps);
  const out: Record<string, number[]> = {};
  for (const s of steps) (out[s.lane ?? ''] ??= []).push(at.get(s.id)?.tier ?? -1);
  return out;
};

describe('tiers', () => {
  it('numbers a chain by its needs', () => {
    assert.deepEqual(badges(chain('a', 'b', 'c', 'd', 'e')), ['1', '2', '3', '4', '5']);
  });

  // File order is not an edge. The fill in `workflows.ts` writes an old file's
  // implied chain in before anything here is asked.
  it('draws a list with no needs as one tier of roots', () => {
    const flat: GraphStep[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(badges(flat), ['1a', '1b', '1c']);
  });

  // The defect PRD §5.3 exists to refuse. Degrading *per step* rather than per
  // list gives a root written third the depth 2, and its children 3 — a number
  // stating an order the file does not.
  it('gives a root written third the first tier, not the third', () => {
    const outOfOrder: GraphStep[] = [
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a'] },
      { id: 'a' }
    ];
    assert.equal(layout(outOfOrder).at.get('a')?.badge, '1');
  });

  // A session beside this one is started by a wire someone drew, never by
  // file order. It cannot open with the run, so the earliest it runs is row 2.
  it('draws a session step with no needs in row 2, not beside step 1', () => {
    const twoSessions: GraphStep[] = [{ id: 'plan' }, { id: 'notes', lane: 'session 1' }];
    assert.deepEqual(badges(twoSessions), ['1', '2']);
  });

  it('draws what waits on that step a row further down', () => {
    const steps: GraphStep[] = [
      { id: 'plan' },
      { id: 'notes', lane: 'session 1' },
      { id: 'more', lane: 'session 1', needs: ['notes'] }
    ];
    assert.deepEqual(badges(steps), ['1', '2', '3']);
  });

  it('reproduces the badges §3d draws', () => {
    assert.deepEqual(badges(REAL), ['1', '2a', '2b', '3a', '3b', '4a', '4b', '5', '6a', '6b', '7']);
  });

  it('gives a tier of one no letter', () => {
    const { at } = layout(REAL);
    assert.deepEqual(
      REAL.map((s) => at.get(s.id)?.tier),
      [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6]
    );
    assert.equal(at.get('impl')?.badge, '1');
    assert.equal(at.get('int')?.badge, '5');
  });
});

describe('lanes', () => {
  it('puts the armed session first and the rest in first-appearance order', () => {
    assert.deepEqual(layout(REAL).lanes, ['', 's1', 's2', 's3']);
  });

  it('puts a list that names no lane entirely in the armed one', () => {
    assert.deepEqual(layout([{ id: 'a' }, { id: 'b', needs: ['a'] }]).lanes, ['']);
  });

  // An unwired session sits on row 2, so by tier alone it took the column of a
  // session that opens on row 4.
  it('draws the stated order over run order, and what it leaves out after it', () => {
    const steps: GraphStep[] = [
      { id: 'a' },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['b'] },
      { id: 'late', lane: 's1', needs: ['c'] },
      { id: 'early', lane: 's2' },
      { id: 'unlisted', lane: 's3' }
    ];
    assert.deepEqual(layout(steps).lanes, ['', 's2', 's3', 's1']);
    assert.deepEqual(layout(steps, ['s1', 's2']).lanes, ['', 's1', 's2', 's3']);
  });

  it('skips a stated lane no step is in, and never puts one ahead of the armed', () => {
    const steps: GraphStep[] = [{ id: 'a' }, { id: 'b', lane: 's1', needs: ['a'] }];
    assert.deepEqual(layout(steps, ['gone', 's1', '']).lanes, ['', 's1']);
  });
});

describe('a lane over the tiers', () => {
  // A session that stops working at depth 2 and starts again at depth 5 is idle
  // in between: its column runs on with nothing in it.
  it('holds each session from its first tier to its last', () => {
    assert.deepEqual(tiersByLane(REAL), {
      '': [0, 1, 3, 4, 6],
      s1: [1, 3],
      s2: [2, 5],
      s3: [2, 5]
    });
  });

  it('gives a single-lane list one full-height lane', () => {
    const steps = chain('a', 'b', 'c');
    assert.deepEqual(layout(steps).lanes, ['']);
    assert.deepEqual(tiersByLane(steps), { '': [0, 1, 2] });
  });
});

describe('opener', () => {
  // The assertion a `kind === 'fanout'` implementation fails. In §3d the two
  // rules select disjoint sets: `impl` is the only fan-out and it runs in the
  // session the workflow was armed in, which already has a model.
  it('is the first node of a session that is not the armed one', () => {
    assert.deepEqual(opens(REAL), ['ui', 'rw', 'ru']);
    assert.deepEqual(
      ['s1', 's2', 's3'].map((lane) => opener(REAL, lane)?.id),
      ['ui', 'rw', 'ru']
    );
  });

  it('is nothing for the armed session, or a lane no step names', () => {
    assert.equal(opener(REAL, ''), undefined);
    assert.equal(opener(REAL, 'gone'), undefined);
  });

  it('is false for the only fan-out in the graph', () => {
    assert.equal(REAL[0]?.kind, 'fanout');
    assert.equal(layout(REAL).at.get('impl')?.opens, false);
  });

  it('is false for every step of a single-lane list', () => {
    assert.deepEqual(opens([{ id: 'a' }, { id: 'b' }]), []);
  });

  // A draft whose lane chain is broken: `B` is a named root, so depth 1, and
  // `A` is listed first at depth 2. Save writes the opener fields onto `A`,
  // the scheduler opens the lane on `A`, so the chip is on `A` too.
  it('is the first step the file lists, where depth would say another', () => {
    const steps: GraphStep[] = [
      { id: 'root' },
      { id: 'mid', needs: ['root'] },
      { id: 'A', lane: 's1', needs: ['mid'] },
      { id: 'B', lane: 's1' }
    ];
    const { at } = layout(steps);
    assert.ok((at.get('A')?.tier ?? 0) > (at.get('B')?.tier ?? 0));
    assert.equal(opener(steps, 's1')?.id, 'A');
    assert.deepEqual(opens(steps), ['A']);
  });
});

describe('needsOf', () => {
  it('keeps the ids the list holds, once each, in the order written', () => {
    const steps: GraphStep[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c', needs: ['b', 'gone', 'a', 'b'] }
    ];
    assert.deepEqual(needsOf(steps).get('c'), ['b', 'a']);
    assert.deepEqual(needsOf(steps).get('a'), []);
  });

  it('keeps a self-need', () => {
    assert.deepEqual(needsOf([{ id: 'a', needs: ['a'] }]).get('a'), ['a']);
  });
});

/**
 * The structural lies this module can be handed today.
 *
 * `validate()` refuses none of these yet — and would not help if it did, since
 * the editor draws a draft somebody is still typing. Root `CLAUDE.md`: a
 * changed or missing file shrinks a card, never breaks the panel. Every case
 * here threw before the fix, out of `tiers()`'s hole-filling `map`, which
 * skips holes rather than filling them.
 */
describe('a graph that lies', () => {
  const placesAll = (steps: GraphStep[]): void => {
    const { at } = layout(steps);
    for (const s of steps) assert.ok(at.has(s.id), `${s.id} is placed`);
  };

  it('draws a cycle rather than throwing', () => {
    placesAll([
      { id: 'a', needs: ['b'] },
      { id: 'b', needs: ['a'] }
    ]);
  });

  it('draws a step that needs itself', () => {
    placesAll([{ id: 'a', needs: ['a'] }]);
  });

  it('draws a file with a duplicated id', () => {
    placesAll([{ id: 'a' }, { id: 'a' }]);
  });

  // One deleted parent used to take the DAG branch on the strength of a `needs`
  // key that resolved to nothing, making every step a root — one tier holding
  // the whole file, five nodes in one grid cell.
  it('keeps its tiers when a needs also names a step that is gone', () => {
    const steps: GraphStep[] = [
      { id: 'a' },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['b', 'gone'] },
      { id: 'd', needs: ['c'] },
      { id: 'e', needs: ['d'] }
    ];
    assert.deepEqual(badges(steps), ['1', '2', '3', '4', '5']);
  });

  it('has no lanes and places nothing for an empty list', () => {
    const empty = layout([]);
    assert.deepEqual(empty.lanes, []);
    assert.equal(empty.at.size, 0);
  });
});

describe('lanes nobody is in', () => {
  // The armed lane used to be seeded unconditionally, so a graph where every
  // step names a session drew a ghost first column: every node one column right
  // of where it belonged, and a track spanning Infinity / -Infinity.
  it('draws no armed column when no step is in the armed session', () => {
    const steps: GraphStep[] = [
      { id: 'a', lane: 's1' },
      { id: 'b', lane: 's2', needs: ['a'] }
    ];
    assert.deepEqual(layout(steps).lanes, ['s1', 's2']);
    // Row 2 and 3: a named session's first step never starts with the run.
    assert.deepEqual(tiersByLane(steps), { s1: [1], s2: [2] });
  });
});

describe('a tier taller than one row', () => {
  const SPLIT: GraphStep[] = [
    { id: 'root' },
    { id: 'p1', lane: 's1', needs: ['root'] },
    { id: 'p2', lane: 's1', needs: ['root'] },
    { id: 'after', needs: ['p1', 'p2'] }
  ];

  // Two steps of one lane in the tier that opens it. Only the first listed
  // opened the session, so only it may offer a model.
  it('offers the model on the first of two steps opening one lane', () => {
    assert.deepEqual(opens(SPLIT), ['p1']);
  });

  it('gives that tier a row per step of the busiest lane', () => {
    const { at } = layout(SPLIT);
    assert.deepEqual(
      SPLIT.map((s) => [at.get(s.id)?.tier, at.get(s.id)?.row]),
      [
        [0, 0],
        [1, 1],
        [1, 2],
        [2, 3]
      ]
    );
  });

  it('leaves an ordinary tier one row tall', () => {
    const { at } = layout(REAL);
    for (const s of REAL) assert.equal(at.get(s.id)?.row, at.get(s.id)?.tier);
  });
});

describe('the badge past the alphabet', () => {
  it('keeps producing letters in a tier wider than 26', () => {
    const wide: GraphStep[] = [
      { id: 'root' },
      ...Array.from({ length: 27 }, (_, i) => ({ id: 'p' + i, needs: ['root'] }))
    ];
    const { at } = layout(wide);
    // wide[0] is the root, so wide[1..27] are the 27 peers of tier 2.
    assert.equal(at.get('p25')?.badge, '2z');
    // `String.fromCharCode(97 + 26)` is '{', which is what this used to give.
    assert.equal(at.get('p26')?.badge, '2aa');
  });
});
