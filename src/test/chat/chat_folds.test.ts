import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openThread, stateMessage, threadView } from '../harness';

describe('a folded turn', () => {
  /** A turn that spoke, ran two things and answered — plus the fold the host
   *  computed over it. Indices match `folds`' own reading of the same list. */
  const workedThread = (over: Partial<ThreadView> = {}) =>
    threadView({
      exchanges: [
        { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
        { role: 'assistant', text: 'let me look', blocks: [{ html: '<p>let me look</p>' }] },
        {
          role: 'assistant',
          text: '',
          blocks: [{ summary: 'Ran command', detail: 'ls' }, { summary: 'Read file' }]
        },
        { role: 'assistant', text: 'found it', blocks: [{ html: '<p>found it</p>' }] }
      ],
      folds: [{ at: 1, hides: [1, 2], ms: 72_000, key: 'f|1' }],
      ...over
    });

  it('folds a settled turn behind one row, and keeps its answer', (t) => {
    const p = openThread(t, workedThread());
    const row = p.window.document.querySelector('#thread .fold');
    assert.equal(row?.querySelector('.what')?.textContent, 'Worked for 1m');
    assert.equal(row?.querySelector('.steps')?.textContent, '2 steps');
    // The prompt and the answer stand; the commentary and the calls do not.
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#thread .turn .body')].map((x) => x.textContent),
      ['go', 'found it']
    );
    assert.equal(p.window.document.querySelector('#thread .tool'), null);
  });

  it('opens a fold on a click, and shuts it again', (t) => {
    const p = openThread(t, workedThread());
    p.window.document.querySelector<HTMLElement>('#thread .foldbtn')?.click();
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#thread .tool .what')].map((x) => x.textContent),
      ['Ran command', 'Read file']
    );
    // The row stays, because it is also how the reader shuts it.
    assert.equal(p.window.document.querySelector('#thread .fold.open')?.tagName, 'DIV');
    p.window.document.querySelector<HTMLElement>('#thread .foldbtn')?.click();
    assert.equal(p.window.document.querySelector('#thread .tool'), null);
  });

  it('leaves an open fold open across a repaint', (t) => {
    const p = openThread(t, workedThread());
    p.window.document.querySelector<HTMLElement>('#thread .foldbtn')?.click();
    const groups = [groupView({ sessions: [cardView({ pid: 1 })] })];
    p.push(stateMessage(groups, { thread: workedThread() }));
    assert.equal(p.window.document.querySelectorAll('#thread .tool').length, 2);
  });

  it('names the files a fold hid, on the row that hides them', (t) => {
    // A write turn has no prose, so it is never the answer a fold keeps: the
    // row is the only place the pills of a settled turn can stand.
    const p = openThread(
      t,
      workedThread({
        folds: [{ at: 1, hides: [1, 2], ms: 72_000, files: ['/p/docs/plan.md'], key: 'f|1' }]
      })
    );
    const pill = p.window.document.querySelector('#thread .fold .wpill');
    assert.equal(pill?.textContent, 'plan.md');
    assert.equal(pill?.getAttribute('data-tip'), '/p/docs/plan.md');
    p.window.document.querySelector<HTMLElement>('#thread .fold .wpill')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openFile', path: '/p/docs/plan.md' });
  });

  it('keeps a hidden turn’s short-list marker on the row that hides it', (t) => {
    const p = openThread(
      t,
      workedThread({
        folds: [
          {
            at: 1,
            hides: [1, 2],
            ms: 72_000,
            files: ['/p/docs/plan.md'],
            concurrent: true,
            key: 'f|1'
          }
        ]
      })
    );
    assert.ok(p.window.document.querySelector('#thread .fold .wshort'));
  });

  it('hands the pills back to the turns when the fold opens', (t) => {
    const file = '/p/docs/plan.md';
    const base = 'a'.repeat(40);
    const thread = workedThread({
      exchanges: [
        { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
        { role: 'assistant', text: 'looking', blocks: [{ html: '<p>looking</p>' }] },
        {
          role: 'assistant',
          text: '',
          blocks: [{ summary: 'Changed file' }],
          files: [file],
          sizes: { [file]: { add: 4, del: 1 } },
          base
        },
        { role: 'assistant', text: 'found it', blocks: [{ html: '<p>found it</p>' }] }
      ],
      folds: [
        {
          at: 1,
          hides: [1, 2],
          ms: 72_000,
          files: [file],
          sizes: { [file]: { add: 4, del: 1 } },
          base,
          key: 'f|1'
        }
      ]
    });
    const p = openThread(t, thread);
    const diff = { type: 'openDiff' as const, path: file, base };
    const shut = p.window.document.querySelector<HTMLElement>('#thread .fold .wnum');
    assert.ok(shut);
    shut.click();
    assert.deepEqual(p.posted.at(-1), diff);
    p.window.document.querySelector<HTMLElement>('#thread .foldbtn')?.click();
    // Once, and on the turn that wrote it — not on the row standing over it.
    assert.equal(p.window.document.querySelectorAll('#thread .wpill').length, 1);
    assert.equal(p.window.document.querySelector('#thread .fold .wpill'), null);
    const opened = p.window.document.querySelector<HTMLElement>('#thread .turn .wnum');
    assert.ok(opened);
    opened.click();
    assert.deepEqual(p.posted.at(-1), diff);
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: thread.pid, startedAt: thread.startedAt })] })],
        { thread }
      )
    );
    assert.ok(p.window.document.querySelector('#thread .fold.open'));
    assert.equal(p.window.document.querySelector('#thread .fold .wpill'), null);
    const again = p.window.document.querySelector<HTMLElement>('#thread .turn .wnum');
    assert.ok(again);
    again.click();
    assert.deepEqual(p.posted.at(-1), diff);
  });

  it('posts a folded pill against a baseline that arrives after the row is drawn', (t) => {
    const file = '/proj/hid.ts';
    const base = 'e'.repeat(40);
    const hidden = {
      role: 'assistant' as const,
      text: '',
      blocks: [{ summary: 'Changed file' }],
      files: [file],
      sizes: { [file]: { add: 3, del: 1 } }
    };
    const fold = {
      at: 0,
      hides: [0],
      files: [file],
      sizes: { [file]: { add: 3, del: 1 } },
      key: 'f|0'
    };
    const before = threadView({
      exchanges: [hidden, { role: 'assistant', text: 'done', blocks: [{ html: '<p>done</p>' }] }],
      folds: [fold]
    });
    const p = openThread(t, before);
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: before.pid, startedAt: before.startedAt })] })],
        { thread: threadView({ exchanges: before.exchanges, folds: [{ ...fold, base }] }) }
      )
    );
    const num = p.window.document.querySelector<HTMLElement>('#thread .fold .wnum');
    assert.ok(num);
    num.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openDiff', path: file, base });
  });

  it('says who ended a turn that was cut short', (t) => {
    const p = openThread(
      t,
      workedThread({ folds: [{ at: 1, hides: [1, 2], ms: 12_000, stopped: true, key: 'f|1' }] })
    );
    assert.equal(
      p.window.document.querySelector('#thread .fold .what')?.textContent,
      'You stopped after 12s'
    );
  });

  it('says only that it worked when the turn was never stamped', (t) => {
    const p = openThread(t, workedThread({ folds: [{ at: 1, hides: [1], key: 'f|1' }] }));
    const row = p.window.document.querySelector('#thread .fold');
    assert.equal(row?.querySelector('.what')?.textContent, 'Worked');
    // One hidden turn is not a count worth printing.
    assert.equal(row?.querySelector('.steps'), null);
  });

  it('folds nothing when the host sent no folds', (t) => {
    const p = openThread(t, workedThread({ folds: undefined }));
    assert.equal(p.window.document.querySelector('#thread .fold'), null);
    assert.equal(p.window.document.querySelectorAll('#thread .tool').length, 2);
  });
});
