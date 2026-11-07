import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  answeredAsk,
  askRequest,
  cardView,
  groupView,
  newDraft,
  openPanel,
  openThread,
  questionView,
  stateMessage,
  threadView,
  Panel
} from '../harness';

/**
 * A question already answered, drawn in the layer that asked it.
 *
 * A record is not a request: there is nothing to stage, nothing to send, and
 * every rule below is about that difference holding — above all while a *live*
 * ask is pending behind it, where the keyboard drives `pending` and not what is
 * on screen.
 */
describe('a replayed question', () => {
  const record = (ask: AnsweredAskView, over: Partial<ThreadView> = {}): ThreadView =>
    threadView({
      exchanges: [{ role: 'assistant', text: '', blocks: [{ summary: 'Asked', ask }] }],
      ...over
    });
  const pill = (p: Panel, at = 0): HTMLElement | undefined =>
    [...p.window.document.querySelectorAll<HTMLElement>('#thread .tool .askpill')][at];
  const layer = (p: Panel): HTMLElement => p.window.document.getElementById('ask') as HTMLElement;
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const answers = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  const press = (p: Panel, name: string, mods: KeyboardEventInit = {}): void => {
    p.window.document.activeElement?.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: name, bubbles: true, ...mods })
    );
  };
  /** The same push the 3s poll makes, carrying whatever the thread is now. */
  const poll = (p: Panel, thread: ThreadView): void => {
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], { thread }));
  };

  it('marks what was picked and offers nothing to press', (t) => {
    const p = openThread(t, record(answeredAsk()));
    pill(p)?.click();
    assert.equal(layer(p).hidden, false);
    assert.equal(opts(p)[0]?.classList.contains('on'), true);
    assert.equal(opts(p)[1]?.classList.contains('on'), false);
    assert.equal(p.window.document.querySelector('#question .cta'), null, 'nothing to send');
    assert.equal(p.window.document.querySelector('#question .prose'), null, 'nothing to type');
  });

  it('draws the reader’s own words where they were typed', (t) => {
    // 19% of answers measured match no label. The `Other` row is where they
    // were written and where the record shows them.
    const p = openThread(t, record(answeredAsk({ picks: [[]], texts: ['a quince, actually'] })));
    pill(p)?.click();
    const other = p.window.document.querySelector('#question .qopt.other');
    assert.equal(other?.classList.contains('on'), true);
    assert.equal(other?.textContent?.includes('a quince, actually'), true);
  });

  it('keeps the own-words gutter on the label’s line', (t) => {
    // The record used to redraw this row by hand, and the redrawing dropped
    // `.qother-pick` — the only thing holding the digit and the mark beside
    // the label. `.qopt.other` is a column, so without it each part took a
    // line of its own and the badge floated under the answer.
    const p = openThread(t, record(answeredAsk({ picks: [[]], texts: ['a quince, actually'] })));
    pill(p)?.click();
    const other = p.window.document.querySelector('#question .qopt.other') as HTMLElement;
    const gutter = other.querySelector('.qother-pick');
    assert.ok(gutter, 'the row keeps the gutter the live row has');
    assert.equal(gutter?.tagName, 'DIV', 'and it is not a button — nothing here is pressable');
    assert.equal(gutter?.querySelector('.kbd')?.textContent, '3', 'wearing the digit it wore live');
    assert.ok(gutter?.querySelector('.mark'), 'and its mark');
    assert.ok(gutter?.querySelector('.answered'), 'the badge rides that line, not one of its own');
  });

  it('counts the own-words row among the marked ones', (t) => {
    // Two green rows and a chip reading `picked`: the chip counted `picks`,
    // which is one short wherever the reader both picked and typed.
    const p = openThread(
      t,
      record(answeredAsk({ picks: [[0]], texts: ['though mostly the second one'] }))
    );
    pill(p)?.click();
    assert.equal(
      p.window.document.querySelector('#question .qhdr .cnt')?.textContent,
      'picked several'
    );
  });

  it('speaks of the reader’s words in the past, beside a preview', (t) => {
    // The pane is shared with the live dialog, and its one line about the
    // `Other` row is written to somebody deciding. A record is read by
    // somebody who decided, so the present tense claims an answer still on
    // its way.
    const withPreview = questionView({
      options: [
        { label: 'Left', preview: 'l e f t' },
        { label: 'Right', preview: 'r i g h t' }
      ]
    });
    const p = openThread(
      t,
      record(answeredAsk({ questions: [withPreview], picks: [[]], texts: ['neither, really'] }))
    );
    pill(p)?.click();
    const pre = p.window.document.querySelector('#question pre.qprev')?.textContent ?? '';
    assert.equal(pre.startsWith('These words were sent'), true, pre);
  });

  it('says an answer in words is not a pick', (t) => {
    // `recorded()` counts words as answered, and the count chip used to fall
    // through to `picked` — announcing a pick the record does not have.
    const p = openThread(t, record(answeredAsk({ picks: [[]], texts: ['a quince, actually'] })));
    pill(p)?.click();
    const cnt = p.window.document.querySelector('#question .qhdr .cnt');
    assert.equal(cnt?.textContent, 'answered in words');
  });

  it('shows a note read-only', (t) => {
    const p = openThread(t, record(answeredAsk({ notes: ['while it stays flat'] })));
    pill(p)?.click();
    const said = p.window.document.querySelector('#question .qnote');
    assert.equal(said?.textContent?.includes('while it stays flat'), true);
    // The blanket rule, on the one record that draws prose the live dialog took
    // in a box: nothing anywhere in a replay can be typed into. `.qnote-in` is
    // the box this path would have left behind, and is what `.prose` covers.
    assert.equal(p.window.document.querySelector('#question .prose'), null, 'a box to type in');
  });

  it('survives the poll, with nothing pending at all', (t) => {
    // The regression the memo has to know about: with no request the paint's
    // signature is the constant `'empty'`, so a replay drawn under it would be
    // swallowed on the first repaint and never come back.
    const p = openThread(t, record(answeredAsk()));
    pill(p)?.click();
    poll(p, record(answeredAsk()));
    assert.equal(layer(p).hidden, false);
    assert.equal(opts(p).length > 0, true, 'the record is still drawn');
  });

  it('draws the second record when a second pill is pressed', (t) => {
    // Both paints have the same `pending` and the same `staged`, so a signature
    // that ignored the replay would show the first record forever.
    const p = openThread(
      t,
      record(
        answeredAsk({
          questions: [
            questionView({ header: 'One', question: 'The first?' }),
            questionView({ header: 'Two', question: 'The second?' })
          ]
        })
      )
    );
    pill(p, 0)?.click();
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'The first?');
    pill(p, 1)?.click();
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'The second?');
  });

  it('gives way to a live ask, and comes back on close', (t) => {
    const p = openThread(t, record(answeredAsk()));
    pill(p)?.click();
    // A blocked session outranks a record.
    poll(p, record(answeredAsk(), { pending: [askRequest({ questions: [questionView()] })] }));
    assert.equal(p.window.document.querySelector('#question .cta') !== null, true, 'the live one');
    // And opening a record over a pending ask is allowed: nothing is answered
    // by looking, and closing gives the live dialog back.
    pill(p)?.click();
    assert.equal(p.window.document.querySelector('#question .cta'), null, 'the record');
    p.window.document.getElementById('scrim')?.click();
    poll(p, record(answeredAsk(), { pending: [askRequest({ questions: [questionView()] })] }));
    assert.equal(p.window.document.querySelector('#question .cta') !== null, true);
  });

  it('stages nothing and sends nothing from the keyboard', (t) => {
    // The severe one. `#question`'s keydown drives `ui.state.thread.pending`,
    // not what is drawn, and `confirmAsk` guards only on `ctaReady` and
    // `sending` — so a reader looking at a record, with picks staged on the ask
    // behind it, could send that answer by pressing Enter.
    const live = askRequest({ questions: [questionView()] });
    const p = openThread(t, record(answeredAsk(), { pending: [live] }));
    // Stage a pick on the live ask, then open a record over it.
    opts(p)[0]?.click();
    pill(p)?.click();
    press(p, '2');
    press(p, 'ArrowDown');
    press(p, 'Enter');
    press(p, 'Enter', { metaKey: true });
    assert.deepEqual(answers(p), [], 'nothing was posted from behind a record');
  });

  it('tells two records of the same question apart', (t) => {
    // A session that asks "Continue?" twice writes two records with the same
    // text, the same shown index and the same pid. With only the questions in
    // the paint's key the second pill is swallowed and the reader is shown the
    // *first* ask's answers under the second one — silent, and the whole point
    // of the feature.
    const twice = (): AnsweredAskView[] => [
      answeredAsk({ questions: [questionView({ question: 'Continue?' })], picks: [[0]] }),
      answeredAsk({ questions: [questionView({ question: 'Continue?' })], picks: [[1]] })
    ];
    const [one, two] = twice();
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Asked', ask: one as AnsweredAskView }]
          },
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Asked', ask: two as AnsweredAskView }]
          }
        ]
      })
    );
    pill(p, 0)?.click();
    assert.equal(opts(p)[0]?.classList.contains('on'), true, 'the first record');
    pill(p, 1)?.click();
    assert.equal(opts(p)[1]?.classList.contains('on'), true, 'the second record’s own answer');
    assert.equal(opts(p)[0]?.classList.contains('on'), false);
  });

  it('tells two records apart that were answered the same way', (t) => {
    // The case the picks cannot carry, and the one a generic `header` makes
    // ordinary: two asks under one twelve-character header, both answered row
    // 0, with different rows to be row 0 of. Everything the key held before —
    // header, picks, texts, notes — is identical across these two, so the memo
    // swallowed the second pill and drew the first ask's options under it.
    const ask = (a: string, b: string): AnsweredAskView =>
      answeredAsk({
        questions: [
          questionView({
            header: 'Merge',
            question: 'How should this land?',
            options: [{ label: a }, { label: b }]
          })
        ],
        picks: [[0]]
      });
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Asked', ask: ask('Rebase', 'Merge') }]
          },
          {
            role: 'assistant',
            text: '',
            blocks: [{ summary: 'Asked', ask: ask('Squash', 'Keep') }]
          }
        ]
      })
    );
    pill(p, 0)?.click();
    assert.equal(opts(p)[0]?.textContent?.includes('Rebase'), true, 'the first record');
    pill(p, 1)?.click();
    assert.equal(opts(p)[0]?.textContent?.includes('Squash'), true, 'the second record’s own rows');
  });

  it('stays open when a request goes away under it', (t) => {
    // The rule is arrival, not change. A request answered from another window —
    // or a turn simply ending — must not take a record off the screen of
    // somebody reading it.
    const live = askRequest({ questions: [questionView()] });
    const p = openThread(t, record(answeredAsk(), { pending: [live] }));
    pill(p)?.click();
    assert.equal(p.window.document.querySelector('#question .cta'), null, 'the record is up');
    poll(p, record(answeredAsk()));
    assert.equal(layer(p).hidden, false, 'the layer stayed');
    assert.equal(opts(p).length > 0, true, 'and the record is still drawn');
  });

  it('hands the layer back to the live dialog rather than shutting it', (t) => {
    // Both ways out that have somewhere to go back to. The launcher names the
    // live question, so a press on it must land there — reading `ask.hidden`
    // shut the layer over the dialog just painted back, which reads as a press
    // that did nothing.
    const live = askRequest({ questions: [questionView()] });
    const p = openThread(t, record(answeredAsk(), { pending: [live] }));
    pill(p)?.click();
    p.window.document.querySelector<HTMLButtonElement>('#question .qclose')?.click();
    assert.equal(layer(p).hidden, false, 'Close went back to the live dialog');
    assert.equal(p.window.document.querySelector('#question .cta') !== null, true);

    pill(p)?.click();
    assert.equal(p.window.document.querySelector('#question .cta'), null, 'the record again');
    p.window.document.getElementById('qlaunch')?.click();
    assert.equal(layer(p).hidden, false, 'the launcher opened what it names');
    assert.equal(p.window.document.querySelector('#question .cta') !== null, true);
  });

  it('shuts the layer on Close when nothing is pending', (t) => {
    const p = openThread(t, record(answeredAsk()));
    pill(p)?.click();
    p.window.document.querySelector<HTMLButtonElement>('#question .qclose')?.click();
    assert.equal(layer(p).hidden, true);
  });

  it('says so for a question nobody answered, and borrows no sample', (t) => {
    // 3 of the 863 records measured are answered in part. `restore()` falls back
    // to option 0 when nothing is picked, which would put the first option's
    // preview and its label where the answer goes, beside a list with no row
    // marked at all.
    const withPreview = questionView({
      options: [
        { label: 'Left', preview: 'l e f t' },
        { label: 'Right', preview: 'r i g h t' }
      ]
    });
    const p = openThread(
      t,
      record(answeredAsk({ questions: [withPreview], picks: [[]], texts: [''] }))
    );
    pill(p)?.click();
    assert.equal(
      p.window.document.querySelector('#question .qhdr .cnt')?.textContent,
      'not answered'
    );
    assert.equal(p.window.document.querySelector('#question .qprev-col'), null);
    assert.deepEqual(
      opts(p).map((o) => o.classList.contains('on')),
      [false, false]
    );
  });

  it('gives way when the reader asks for the live question', (t) => {
    // The alert strip names a blocked session and sets `wantAsk`. The paint that
    // honours it is below the record's own early return, so without this the
    // press does nothing and the flag fires on some later repaint instead.
    const live = askRequest({ questions: [questionView()] });
    const blocked = record(answeredAsk(), { status: 'waiting', pending: [live] });
    const groups = [
      groupView({ sessions: [cardView({ pid: 101, status: 'waiting', name: 'blocked one' })] })
    ];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: blocked }));
    pill(p)?.click();
    assert.equal(p.window.document.querySelector('#question .cta'), null, 'the record is up');
    p.window.document.querySelector<HTMLElement>('#bottomhub-waiting .waiting-session')?.click();
    p.push(stateMessage(groups, { thread: blocked }));
    assert.equal(p.window.document.querySelector('#question .cta') !== null, true);
  });

  it('clears when another session is selected', (t) => {
    // The other half of the same rule, and the one with no paint of its own to
    // catch it: `select()` posts and waits, so the push that would run the
    // record's own pid check is up to a poll away. Left standing, the record
    // sits over the board answering for the session the reader has just left.
    const p = openPanel(t);
    const groups = [
      groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202, name: 'beta' })] })
    ];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('#cards .card[data-pid="101"]')?.click();
    p.push(stateMessage(groups, { thread: record(answeredAsk()) }));
    pill(p)?.click();
    assert.equal(layer(p).hidden, false);
    p.window.document.querySelector<HTMLElement>('#cards .card[data-pid="202"]')?.click();
    assert.equal(layer(p).hidden, true);
  });

  it('clears when New leaves the session', (t) => {
    // A record is one session's, like the dialog it borrows: opening New
    // leaves the session it belongs to.
    const p = openThread(t, record(answeredAsk()));
    pill(p)?.click();
    assert.equal(layer(p).hidden, false);
    newDraft(p);
    assert.equal(layer(p).hidden, true);
  });
});
