import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { folds } from '../../ui/fold';

/** A turn somebody produced. `at` is the stamp a duration is measured between. */
const turn = (
  role: AuthoredView['role'],
  text: string,
  at?: number,
  blocks: BlockView[] = []
): AuthoredView => ({ role, text, blocks, ...(at === undefined ? {} : { at }) });

/** A tool-only turn: the shape a run of calls merges into. */
const ran = (at: number, ...names: string[]): AuthoredView =>
  turn(
    'assistant',
    '',
    at,
    names.map((summary) => ({ summary }))
  );

const t0 = Date.parse('2026-07-29T10:00:00.000Z');
const secs = (n: number) => t0 + n * 1000;

describe('folds', () => {
  it('hides a settled turn’s work and keeps everything it said', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      turn('assistant', 'let me look', secs(2)),
      ran(secs(40), 'Ran command', 'Read file'),
      turn('assistant', 'found it', secs(72))
    ];
    // Only the tool-only turn goes behind the row, and the row's duration is the
    // gap it sits in: from the paragraph above it to the one below.
    assert.deepEqual(folds(exchanges, false), [
      { at: 2, hides: [2], ms: 70_000, key: `f|${secs(40)}` }
    ]);
  });

  it('keeps prose the model wrote on its way, not only its last word', () => {
    // The rule is what a turn is, not where it sits: a paragraph before a run
    // of calls is as much the reader's as the one after it.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      turn('assistant', 'here is the whole argument, at length', secs(2)),
      ran(secs(10), 'Read file'),
      turn('assistant', 'and a second paragraph', secs(20)),
      ran(secs(30), 'Ran command'),
      turn('assistant', 'done', secs(40))
    ];
    // One row per run of work, each measuring the gap it stands in. One row for
    // the group would have to stand in two places, and the run it could not
    // stand at would vanish with nothing on screen to say it happened.
    assert.deepEqual(folds(exchanges, false), [
      { at: 2, hides: [2], ms: 18_000, key: `f|${secs(10)}` },
      { at: 4, hides: [4], ms: 20_000, key: `f|${secs(30)}` }
    ]);
  });

  it('keeps a turn the CLI wrote where the model’s would be', () => {
    // An API error is prose the CLI authored, and the retry that followed it is
    // not an answer that supersedes it: the reader wants to see it went wrong.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Ran command'),
      turn('cli', 'API Error: 500', secs(4)),
      ran(secs(6), 'Ran command'),
      turn('assistant', 'done, second attempt', secs(9))
    ];
    assert.deepEqual(
      folds(exchanges, false).map((f) => f.hides),
      [[1], [3]]
    );
  });

  it('hides no turn that carried a picture, however wordless', () => {
    const shot: ExchangeView = {
      role: 'assistant',
      text: '',
      blocks: [],
      at: secs(2),
      images: [{ id: 'i1' }]
    };
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      shot,
      ran(secs(4), 'Ran command'),
      turn('assistant', 'done', secs(6))
    ];
    assert.deepEqual(folds(exchanges, false)[0]?.hides, [2]);
  });

  it('hides no turn that asked a question somebody answered', () => {
    // The same exemption a picture gets. The turn that makes an ask writes no
    // prose, so without this every ask but the newest sits behind "Worked for
    // 2m" — and an old ask is exactly the one a reader reopens.
    const asked: ExchangeView = {
      role: 'assistant',
      text: '',
      at: secs(2),
      blocks: [
        {
          summary: 'Asked',
          ask: {
            questions: [
              { question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }
            ],
            picks: [[0]],
            texts: [''],
            notes: ['']
          }
        }
      ]
    };
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      asked,
      ran(secs(4), 'Ran command'),
      turn('assistant', 'done', secs(6))
    ];
    assert.deepEqual(folds(exchanges, false)[0]?.hides, [2], 'the run starts after it');
  });

  it('measures from the asking, not from the first reply', () => {
    // The first reply only exists once the model has started producing, which
    // is exactly the wait the row is about.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(30), 'Ran command'),
      turn('assistant', 'done', secs(50))
    ];
    assert.equal(folds(exchanges, false)[0]?.ms, 50_000);
  });

  it('says nothing about a turn that answered and did nothing else', () => {
    const exchanges: ExchangeView[] = [turn('user', 'go', t0), turn('assistant', 'sure', secs(1))];
    assert.deepEqual(folds(exchanges, false), []);
  });

  it('never folds the turn still being written', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'first', t0),
      ran(secs(5), 'Ran command'),
      turn('assistant', 'done', secs(9)),
      turn('user', 'again', secs(20)),
      ran(secs(25), 'Ran command'),
      turn('assistant', 'partly', secs(30))
    ];
    // Only the older turn folds; the newest is somebody's live answer.
    assert.deepEqual(
      folds(exchanges, true).map((f) => f.at),
      [1]
    );
    // Once it settles, both do.
    assert.deepEqual(
      folds(exchanges, false).map((f) => f.at),
      [1, 4]
    );
  });

  it('reads a turn the reader cut short as stopped', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(4), 'Ran command'),
      turn('assistant', 'as far as I got', secs(12)),
      { mark: 'break' }
    ];
    const fold = folds(exchanges, false)[0];
    assert.equal(fold?.stopped, true);
    assert.equal(fold?.ms, 12_000);
  });

  it('leaves every marker standing', () => {
    // A skill chip and an interrupt are what a reader most wants out of a long
    // run, so the hidden set has holes in it rather than being a span.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Ran command'),
      { mark: 'skill', skill: 'ponytail', by: 'agent' },
      ran(secs(6), 'Read file'),
      turn('assistant', 'done', secs(8))
    ];
    assert.deepEqual(folds(exchanges, false)[0], {
      at: 1,
      hides: [1, 3],
      ms: 8000,
      key: `f|${secs(2)}`
    });
  });

  it('folds a turn that never said anything, whole', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(3), 'Ran command'),
      turn('user', 'stop', secs(9))
    ];
    assert.deepEqual(folds(exchanges, false)[0]?.hides, [1]);
  });

  it('gives a trailing call a row of its own, below the answer', () => {
    // 10 groups in 182 on this machine end on something other than prose. The
    // answer stays put, and the work each side of it gets its own row: nothing
    // standing below the trailing run means it is measured to the group's end.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Read file'),
      turn('assistant', 'done', secs(5)),
      ran(secs(7), 'Ran command')
    ];
    assert.deepEqual(
      folds(exchanges, false).map((f) => [f.hides, f.ms]),
      [
        [[1], 5000],
        [[3], 2000]
      ]
    );
  });

  it('says nothing about a stop with nothing to hide', () => {
    // A fold is a row over hidden work, so a group that only talked has none to
    // put one on — the duration and "You stopped" go with it. What is left is
    // the interrupt marker, which the dock draws in its own right.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      turn('assistant', 'thinking out loud', secs(2)),
      turn('assistant', 'more', secs(5)),
      { mark: 'break' }
    ];
    assert.deepEqual(folds(exchanges, false), []);
  });

  it('gives each run only the files it hid', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      { ...ran(secs(2), 'Changed file'), files: ['/p/a.ts'] },
      { ...turn('assistant', 'mid-turn note', secs(5)), files: ['/p/b.md'] },
      { ...ran(secs(8), 'Changed file'), files: ['/p/a.ts'] },
      turn('assistant', 'done', secs(9))
    ];
    // The same file behind both rows is two writes at two times, and the note
    // stands and draws its own.
    assert.deepEqual(
      folds(exchanges, false).map((f) => f.files),
      [['/p/a.ts'], ['/p/a.ts']]
    );
  });

  it('measures a thread that opens mid-turn from its own first turn', () => {
    const exchanges: ExchangeView[] = [
      ran(secs(10), 'Ran command'),
      turn('assistant', 'done', secs(30))
    ];
    assert.equal(folds(exchanges, false)[0]?.ms, 20_000);
  });

  it('gives no duration when nothing was stamped', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go'),
      turn('assistant', '', undefined, [{ summary: 'Ran command' }]),
      turn('assistant', 'done')
    ];
    const fold = folds(exchanges, false)[0];
    assert.equal(fold?.ms, undefined);
    // Still a fold, and still keyed — by position, since there is no stamp.
    assert.equal(fold?.key, 'f|at1');
  });

  it('refuses a duration that runs backwards', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', secs(100)),
      ran(secs(5), 'Ran command'),
      turn('assistant', 'done', secs(9))
    ];
    assert.equal(folds(exchanges, false)[0]?.ms, undefined);
  });

  it('gathers what its hidden turns wrote, in first-write order', () => {
    // The write turn is the one a fold always hides: a tool-only turn carries
    // no prose, so it can never be the answer the row keeps.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      { ...ran(secs(2), 'Changed file'), files: ['/p/a.ts', '/p/b.md'] },
      { ...ran(secs(6), 'Changed file'), files: ['/p/b.md', '/p/c.html'] },
      turn('assistant', 'done', secs(9))
    ];
    assert.deepEqual(folds(exchanges, false)[0]?.files, ['/p/a.ts', '/p/b.md', '/p/c.html']);
  });

  it('adds up how much each of them wrote, where the paths are deduped', () => {
    // The two rules that make the sidecar worth its keep and worth watching:
    // `/p/b.md` is one pill, and the lines of both writes to it.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      {
        ...ran(secs(2), 'Changed file'),
        files: ['/p/a.ts', '/p/b.md'],
        sizes: { '/p/a.ts': { add: 12, del: 3 }, '/p/b.md': { add: 4, del: 0 } }
      },
      {
        ...ran(secs(6), 'Changed file'),
        files: ['/p/b.md'],
        sizes: { '/p/b.md': { add: 7, del: 2 } }
      },
      turn('assistant', 'done', secs(9))
    ];
    const fold = folds(exchanges, false)[0];
    assert.deepEqual(fold?.files, ['/p/a.ts', '/p/b.md']);
    assert.deepEqual(fold?.sizes, {
      '/p/a.ts': { add: 12, del: 3 },
      '/p/b.md': { add: 11, del: 2 }
    });
  });

  for (const scenario of [
    { name: 'a common defined baseline', bases: ['a', 'a'], expected: 'a' },
    { name: 'a defined baseline beside an absent one', bases: [undefined, 'a'], expected: 'a' },
    { name: 'conflicting defined baselines', bases: ['a', 'b'], expected: undefined },
    { name: 'no defined baseline', bases: [undefined, undefined], expected: undefined }
  ]) {
    it(`carries only a defensible baseline from hidden exchanges: ${scenario.name}`, () => {
      const exchanges: ExchangeView[] = [
        turn('user', 'go', t0),
        {
          ...ran(secs(2), 'Changed file'),
          files: ['/p/a.ts'],
          base: scenario.bases[0]?.repeat(40)
        },
        { mark: 'break' },
        {
          ...ran(secs(4), 'Changed file'),
          files: ['/p/b.ts'],
          base: scenario.bases[1]?.repeat(40)
        },
        { ...turn('assistant', 'done', secs(5)), base: 'c'.repeat(40) }
      ];
      const result = folds(exchanges, false);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0]?.hides, [1, 3]);
      assert.equal(result[0]?.base, scenario.expected?.repeat(40));
      if (scenario.expected === undefined) assert.equal('base' in (result[0] ?? {}), false);
    });
  }

  it('keeps baselines scoped to their prompt-bounded turns and split work runs', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const exchanges: ExchangeView[] = [
      turn('user', 'first', t0),
      { ...ran(secs(2), 'Changed file'), base: first },
      { ...turn('assistant', 'commentary', secs(3)), base: first },
      { ...ran(secs(4), 'Changed file'), base: first },
      turn('user', 'second', secs(5)),
      { ...ran(secs(6), 'Changed file'), base: second },
      turn('user', 'without checkpoint', secs(7)),
      ran(secs(8), 'Changed file'),
      turn('assistant', 'done', secs(9))
    ];
    const result = folds(exchanges, false);
    assert.deepEqual(
      result.map((fold) => fold.base),
      [first, first, second, undefined]
    );
    assert.equal('base' in (result[3] ?? {}), false);
  });

  it('never keys a size under a path the row has no pill for', () => {
    // `files` and `sizes` are merged by different rules at different sites, so
    // the subset relation is the one thing that can silently rot. A size with
    // no pill is invisible; a pill with no size reads as `±?` for a write that
    // was measured perfectly well.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      {
        ...ran(secs(2), 'Changed file'),
        files: ['/p/a.ts', '/p/unmeasured.ts'],
        sizes: { '/p/a.ts': { add: 1, del: 1 } }
      },
      {
        ...ran(secs(6), 'Changed file'),
        files: ['/p/b.md'],
        sizes: { '/p/b.md': { add: 3, del: 0 } }
      },
      turn('assistant', 'done', secs(9))
    ];
    for (const fold of folds(exchanges, false)) {
      for (const key of Object.keys(fold.sizes ?? {})) {
        assert.ok(fold.files?.includes(key), `${key} has a size and no pill`);
      }
    }
  });

  /**
   * A short list must never be given the reading of a complete one, and a fold
   * hiding the turn that was short is exactly where that would happen.
   */
  it('carries a hidden turn’s short-list marker up to the row', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      {
        ...ran(secs(2), 'Changed file'),
        files: ['/p/a.ts'],
        sizes: { '/p/a.ts': { add: 1, del: 1 } },
        concurrent: true
      },
      turn('assistant', 'done', secs(9))
    ];
    const fold = folds(exchanges, false)[0];
    assert.equal(fold?.concurrent, true);
    assert.deepEqual(fold?.files, ['/p/a.ts']);
  });

  it('marks nothing when no hidden turn was short', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      { ...ran(secs(2), 'Changed file'), files: ['/p/a.ts'] },
      turn('assistant', 'done', secs(9))
    ];
    assert.equal('concurrent' in (folds(exchanges, false)[0] ?? {}), false);
  });

  it('says nothing about sizes when nothing hidden could be measured', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      { ...ran(secs(2), 'Changed file'), files: ['/p/a.ts'] },
      turn('assistant', 'done', secs(5))
    ];
    const fold = folds(exchanges, false)[0];
    assert.deepEqual(fold?.files, ['/p/a.ts']);
    assert.equal('sizes' in (fold ?? {}), false);
  });

  it('says nothing about files when the hidden turns wrote none', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Read file'),
      turn('assistant', 'done', secs(5))
    ];
    assert.equal('files' in (folds(exchanges, false)[0] ?? {}), false);
  });

  it('leaves the answer’s own files off the row', () => {
    // The answer stands, so it draws its own pills. Naming them twice would
    // read as two writes of the same file.
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Read file'),
      { ...turn('assistant', 'done', secs(5)), files: ['/p/answer.md'] }
    ];
    assert.equal(folds(exchanges, false)[0]?.files, undefined);
  });

  it('keys a fold by the turn it stands on, so the thread may grow', () => {
    const older: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(2), 'Ran command'),
      turn('assistant', 'done', secs(5))
    ];
    // Two prompts back to back open one group, not two: what moved is every
    // index, which is exactly what a key must not be made of.
    const grown: ExchangeView[] = [turn('user', 'earlier', secs(-60)), ...older];
    assert.equal(folds(grown, false)[0]?.at, 2);
    assert.equal(folds(older, false)[0]?.key, folds(grown, false)[0]?.key);
  });
});

describe('folds, after a turn the CLI started itself', () => {
  /** The trigger marker a background command's end leaves (`core/task_end.ts`). */
  const trigger = (at: number): ExchangeView => ({
    mark: 'trigger',
    trigger: 'task',
    status: 'completed',
    at
  });
  const later = t0 + 75 * 60_000;
  const after = (s: number) => later + s * 1000;

  it('times the woken turn from its trigger, not from the turn before', () => {
    // `c3a92bdd`, 2026-10-13: a turn ended, the backgrounded gate hung, and 75
    // minutes later the CLI started a turn that took ~12 s.
    const exchanges: ExchangeView[] = [
      turn('user', 'run the gate', t0),
      ran(secs(5), 'Ran command'),
      turn('assistant', 'started; waiting for it', secs(10)),
      trigger(later),
      ran(after(5), 'Read file'),
      ran(after(9), 'Ran command'),
      turn('assistant', 'the gate failed', after(12))
    ];
    assert.deepEqual(folds(exchanges, false), [
      { at: 1, hides: [1], ms: 10_000, key: `f|${secs(5)}` },
      { at: 4, hides: [4, 5], ms: 12_000, key: `f|${after(5)}` }
    ]);
  });

  it('never folds work from both sides of a trigger behind one row', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(5), 'Ran command'),
      trigger(later),
      ran(after(5), 'Read file'),
      turn('assistant', 'done', after(12))
    ];
    assert.deepEqual(
      folds(exchanges, false).map((f) => f.hides),
      [[1], [3]]
    );
  });

  it('leaves only the woken turn open while it runs', () => {
    const exchanges: ExchangeView[] = [
      turn('user', 'go', t0),
      ran(secs(5), 'Ran command'),
      turn('assistant', 'started', secs(10)),
      trigger(later),
      ran(after(5), 'Read file')
    ];
    assert.deepEqual(
      folds(exchanges, true).map((f) => f.hides),
      [[1]]
    );
  });
});
