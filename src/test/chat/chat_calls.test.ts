import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answeredAsk,
  cardView,
  groupView,
  openThread,
  questionView,
  stateMessage,
  threadView,
  Panel
} from '../harness';

describe('a call in a turn', () => {
  it('keeps the calls where the turn made them, between what it said', (t) => {
    // The whole reason a turn is a list of blocks rather than one blob of
    // markup with a footer: the transcript holds the interleaving, and a turn
    // that spoke, ran something and spoke again reads as three things.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'let me check\nfound it',
            blocks: [
              { html: '<p>let me check</p>' },
              { summary: 'Ran command', detail: 'ls' },
              { html: '<p>found it</p>' }
            ]
          }
        ]
      })
    );
    const turn = p.window.document.querySelector('#thread .turn');
    assert.deepEqual(
      [...(turn?.children ?? [])].map((x) => x.className),
      ['who', 'body', 'tool', 'body']
    );
  });

  it('shows what a call returned, and marks one that failed', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [
              { summary: 'Ran command', detail: 'nope', output: 'Exit code 1', failed: true },
              { summary: 'Read file', detail: 'a.ts', output: 'the file' },
              { summary: 'Ran command', detail: 'sleep 30' }
            ]
          }
        ]
      })
    );
    const rows = p.window.document.querySelectorAll('#thread .tool');
    assert.equal(rows[0]?.className, 'tool failed');
    assert.equal(rows[0]?.querySelector('.out')?.textContent, 'Exit code 1');
    assert.equal(rows[1]?.className, 'tool');
    assert.equal(rows[1]?.querySelector('.out')?.textContent, 'the file');
    // Still running: no output at all, as against an empty one.
    assert.equal(rows[2]?.querySelector('.out'), null);
  });

  it('keeps a call’s output shut until the reader opens it', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [
              { summary: 'Ran command', detail: 'npm run check', output: 'all green' },
              { summary: 'Ran command', detail: 'sleep 30' }
            ]
          }
        ]
      })
    );
    const rows = (): NodeListOf<HTMLElement> =>
      p.window.document.querySelectorAll<HTMLElement>('#thread .tool');
    assert.equal(rows()[0]?.className, 'tool');
    assert.equal(
      p.window.getComputedStyle(rows()[0]?.querySelector('.out') as Element).display,
      'none'
    );
    // A call still running has nothing to open, so it wears no handle either.
    assert.equal(rows()[1]?.querySelector('.caret'), null);
    rows()[0]?.querySelector<HTMLElement>('.thead')?.click();
    assert.equal(rows()[0]?.className, 'tool open');
    assert.equal(rows()[0]?.querySelector('.out')?.textContent, 'all green');
    rows()[0]?.querySelector<HTMLElement>('.thead')?.click();
    assert.equal(rows()[0]?.className, 'tool');
  });

  it('leaves a call’s output exactly as the host cut it', (t) => {
    // The cut happens at ingest, so a row that did its own would be a second
    // opinion about the same number.
    const output = 'y'.repeat(180) + '…';
    const p = openThread(
      t,
      threadView({
        exchanges: [{ role: 'assistant', text: '', blocks: [{ summary: 'Ran command', output }] }]
      })
    );
    assert.equal(p.window.document.querySelector('#thread .tool .out')?.textContent, output);
  });

  it('hangs the unshortened form off the row as a tooltip', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [
              { summary: 'Ran command', detail: 'Fetch the tags', title: 'git fetch --tags' }
            ]
          }
        ]
      })
    );
    assert.equal(
      p.window.document.querySelector('#thread .thead')?.getAttribute('data-tip'),
      'git fetch --tags'
    );
  });

  /**
   * A question somebody answered, back on the row that asked it.
   *
   * The row is named after the tool and the CLI's echo behind its caret is
   * prose written for the model — so the pills are the only thing on screen
   * that says what was asked.
   */
  describe('an answered question', () => {
    const asked = (ask: AnsweredAskView, over: Partial<ToolView> = {}): ThreadView =>
      threadView({
        exchanges: [
          { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
          { role: 'assistant', text: '', blocks: [{ summary: 'Asked', ask, ...over }] }
        ]
      });
    const qpills = (p: Panel): HTMLElement[] => [
      ...p.window.document.querySelectorAll<HTMLElement>('#thread .tool .askpill')
    ];

    it('wears one pill per question, each named by its header', (t) => {
      const p = openThread(
        t,
        asked(
          answeredAsk({
            questions: [
              questionView({ header: 'Route' }),
              questionView({ question: 'Footer?', header: 'Footer' })
            ]
          })
        )
      );
      assert.deepEqual(
        qpills(p).map((x) => x.textContent),
        ['Route', 'Footer']
      );
    });

    it('draws no pill on a call that answered nothing', (t) => {
      const p = openThread(
        t,
        threadView({
          exchanges: [
            {
              role: 'assistant',
              text: '',
              blocks: [{ summary: 'Ran command', detail: 'ls', output: 'a.ts' }]
            }
          ]
        })
      );
      assert.deepEqual(qpills(p), []);
    });

    it('keeps the echo caret beside the pills', (t) => {
      // The CLI's sentence is the model's view of the answer and the record is
      // the reader's. Neither is the other, so the row offers both.
      const p = openThread(t, asked(answeredAsk(), { output: 'The user chose Left.' }));
      assert.equal(qpills(p).length, 1);
      assert.equal(
        p.window.document.querySelector('#thread .tool .out')?.textContent,
        'The user chose Left.'
      );
    });

    it('opens the record on the ask layer, over the board', (t) => {
      const p = openThread(t, asked(answeredAsk()));
      qpills(p)[0]?.click();
      const doc = p.window.document;
      assert.equal(doc.getElementById('ask')?.hidden, false);
      assert.equal(doc.querySelector('#question .qtext')?.textContent, 'Which way?');
    });

    it('repaints its pills when the record under them changes', (t) => {
      // `blockKey` decides whether a row is rebuilt. A summary and an output
      // that did not move would otherwise keep the pills closed over the old
      // record, and every pill would open the question it first drew.
      const p = openThread(t, asked(answeredAsk({ questions: [questionView({ header: 'One' })] })));
      p.push(
        stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
          thread: asked(answeredAsk({ questions: [questionView({ header: 'Two' })] }))
        })
      );
      assert.deepEqual(
        qpills(p).map((x) => x.textContent),
        ['Two']
      );
    });
  });
});
