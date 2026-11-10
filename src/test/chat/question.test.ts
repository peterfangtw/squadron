import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerRespond,
  assertedMessageBody,
  answeredAsk,
  askRequest,
  cardView,
  enter,
  escape,
  groupView,
  newDraft,
  openPanel,
  openThread,
  permissionRequest,
  proseKey,
  proseOf,
  proseRoot,
  questionView,
  stateMessage,
  unreachableThread,
  threadView,
  typeProse,
  Panel,
  composerTarget,
  importComposer
} from '../harness';
import { panelStylesheet } from '../../ui/document';

describe('a pending question', () => {
  const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
    question: 'Which way?',
    multiSelect: false,
    options: [{ label: 'Left', description: 'the scenic route' }, { label: 'Right' }],
    ...over
  });

  /** The visible options, freshly queried: every stage rebuilds the block. */
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const answers = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);

  it('renders header, question and described options', (t) => {
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ questions: [question({ header: 'Route' })] })] })
    );
    const block = p.window.document.querySelector('#question .qblock');
    assert.equal(block?.querySelector('.qhdr')?.textContent?.includes('Route'), true);
    assert.equal(block?.querySelector('.qtext')?.textContent, 'Which way?');
    // The ask's own two, and the `Other` row every ask on the pipe carries.
    assert.equal(opts(p).length, 3);
    assert.equal(opts(p)[0]?.querySelector('.qopt-label')?.textContent, 'Left');
    assert.equal(opts(p)[0]?.querySelector('.qopt-desc')?.textContent, 'the scenic route');
    assert.equal(opts(p)[1]?.querySelector('.qopt-desc'), null);
  });

  it('omits own words when the request accepts only its stated options', (t) => {
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ questions: [question({ canOther: false })] })] })
    );
    assert.equal(opts(p).length, 2);
    assert.equal(p.window.document.querySelector('#question .qopt.other'), null);
  });

  it('stages a click and sends nothing until the CTA', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    opts(p)[1]?.click();
    assert.deepEqual(answers(p), []);
    assert.ok(opts(p)[1]?.classList.contains('on'));
    cta(p)?.click();
    assert.deepEqual(answers(p), [
      { type: 'respond', pid: 101, requestId: 'req-1', decision: { allow: true, picks: [[1]] } }
    ]);
  });

  it('moves a single-select pick rather than adding to it', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    opts(p)[0]?.click();
    opts(p)[1]?.click();
    assert.ok(!opts(p)[0]?.classList.contains('on'));
    assert.ok(opts(p)[1]?.classList.contains('on'));
    cta(p)?.click();
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[1]] }
    });
  });

  it('toggles a multi-select and sends the whole set', (t) => {
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ questions: [question({ multiSelect: true })] })] })
    );
    opts(p)[0]?.click();
    opts(p)[1]?.click();
    opts(p)[0]?.click(); // toggled back off
    assert.ok(!opts(p)[0]?.classList.contains('on'));
    assert.ok(opts(p)[1]?.classList.contains('on'));
    cta(p)?.click();
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[1]] }
    });
  });

  it('disables the CTA until the visible question is answered', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    assert.equal(cta(p)?.disabled, true);
    opts(p)[0]?.click();
    assert.equal(cta(p)?.disabled, false);
  });

  it('steps through a multi-question ask and answers every question at once', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [
          askRequest({
            questions: [
              question({ header: 'Route' }),
              question({ header: 'Pace', question: 'How fast?', multiSelect: true })
            ]
          })
        ]
      })
    );
    // One question shown, a chip per question.
    assert.equal(p.window.document.querySelectorAll('#question .step').length, 2);
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'Which way?');

    opts(p)[1]?.click();
    // Mid-run the CTA advances; nothing has been posted.
    assert.match(cta(p)?.textContent ?? '', /^Next/);
    cta(p)?.click();
    assert.deepEqual(answers(p), []);
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'How fast?');
    // The answered question's chip says so.
    assert.ok(p.window.document.querySelectorAll('#question .step')[0]?.classList.contains('done'));

    opts(p)[0]?.click();
    cta(p)?.click();
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[1], [0]] }
    });
  });

  it('holds the CTA sent until the host says what became of it', (t) => {
    const thread = threadView({ pending: [askRequest({ questions: [question()] })] });
    const p = openThread(t, thread);
    opts(p)[1]?.click();
    cta(p)?.click();
    assert.equal(answers(p).length, 1);
    assert.equal(cta(p)?.textContent, 'Sending…');
    assert.equal(cta(p)?.disabled, true, 'the button the click just spent');

    // Nothing else answers either: the dialog is spoken for until the report.
    cta(p)?.click();
    opts(p)[0]?.click();
    assert.equal(answers(p).length, 1, 'one decision, one response');
    assert.ok(opts(p)[1]?.classList.contains('on'), 'and the pick it was sent with');

    // A push is not that report. The window that owns a session republishes on
    // a debounce, so a poll landing inside it still carries the request that
    // was just answered — and unfreezing on that put a live CTA over an
    // answered request, which is a second response waiting to be posted.
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: thread.pid })] })], { thread }));
    assert.equal(cta(p)?.textContent, 'Sending…', 'a push is evidence, not the answer');
    assert.equal(cta(p)?.disabled, true);

    // The report is. A refusal — a request withdrawn first, a window that said
    // no, a session that ended — hands the CTA back and says why, on the dialog
    // rather than in a host notification nobody has switched on.
    answerRespond(p, {
      ok: false,
      reason: 'That request was withdrawn before you answered it.'
    });
    assert.equal(cta(p)?.textContent, 'Confirm “Right”');
    assert.equal(cta(p)?.disabled, false);
    assert.equal(
      p.window.document.querySelector('#question .qfail')?.textContent,
      'That request was withdrawn before you answered it.'
    );

    // And pressing again is a new answer, so the last one's reason goes.
    cta(p)?.click();
    assert.equal(answers(p).length, 2);
    assert.equal(p.window.document.querySelector('#question .qfail'), null);
  });

  it('keeps the dialog frozen on an answer that landed', (t) => {
    // `ok` says the host got it onto the pipe. There is no further ack to wait
    // for — a `control_response` is itself the reply to the CLI's request — so
    // what ends the dialog is the request leaving `pending`, and until then the
    // frozen controls are the truth.
    const thread = threadView({ pending: [askRequest({ questions: [question()] })] });
    const p = openThread(t, thread);
    opts(p)[1]?.click();
    cta(p)?.click();
    answerRespond(p, { ok: true });
    assert.equal(cta(p)?.textContent, 'Sending…');
    assert.equal(cta(p)?.disabled, true);
    assert.equal(p.window.document.querySelector('#question .qfail'), null);

    // The push that drops the request takes the dialog with it, and the freeze
    // goes with the dialog rather than outliving it.
    const answered = threadView({ pid: thread.pid, pending: [] });
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: thread.pid })] })], { thread: answered })
    );
    assert.equal(cta(p), null);
  });

  it('holds the last question until every question has a pick', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [askRequest({ questions: [question(), question({ question: 'How fast?' })] })]
      })
    );
    // Jump straight to the last question, leaving the first unanswered.
    p.window.document.querySelectorAll<HTMLElement>('#question .step')[1]?.click();
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'How fast?');
    opts(p)[0]?.click();
    assert.equal(cta(p)?.disabled, true);
    p.window.document.querySelectorAll<HTMLElement>('#question .step')[0]?.click();
    opts(p)[0]?.click();
    p.window.document.querySelectorAll<HTMLElement>('#question .step')[1]?.click();
    assert.equal(cta(p)?.disabled, false);
  });

  it('keeps a staged pick across a re-push and drops it when the ask changes', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    opts(p)[1]?.click();
    const staged = opts(p)[1];

    p.push(
      stateMessage(groups, {
        thread: threadView({ pending: [askRequest({ questions: [question()] })] })
      })
    );
    assert.ok(opts(p)[1]?.classList.contains('on'), 'the poll must not wipe a staged pick');
    // The same node, not an equivalent one: a rebuild would drop hover, focus
    // and whichever preview was being read.
    assert.equal(opts(p)[1], staged, 'an unchanged push must not rebuild the block');

    p.push(
      stateMessage(groups, {
        thread: threadView({
          pending: [askRequest({ requestId: 'req-2', questions: [question()] })]
        })
      })
    );
    assert.ok(!opts(p)[1]?.classList.contains('on'));
    assert.equal(cta(p)?.disabled, true);
  });

  it('previews an option, and peeking at another leaves the pick alone', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [
          askRequest({
            questions: [
              question({
                options: [
                  { label: 'Left', preview: '```\nl e f t\n```' },
                  { label: 'Right', preview: 'r i g h t' }
                ]
              })
            ]
          })
        ]
      })
    );
    opts(p)[0]?.click();
    const pre = p.window.document.querySelector('#question pre.qprev');
    assert.equal(pre?.textContent, 'l e f t', 'an outer fence is not part of the preview');

    opts(p)[1]?.dispatchEvent(new p.window.MouseEvent('mouseenter'));
    assert.equal(p.window.document.querySelector('#question pre.qprev')?.textContent, 'r i g h t');
    assert.ok(opts(p)[0]?.classList.contains('on'), 'a peek does not move the pick');
    opts(p)[1]?.dispatchEvent(new p.window.MouseEvent('mouseleave'));
    assert.equal(p.window.document.querySelector('#question pre.qprev')?.textContent, 'l e f t');
  });

  /**
   * The preview pane's two rules about the `Other` row, uncovered until now and
   * written down before the paint they belong to was extracted — an extraction
   * is only provably inert against the cases that already existed.
   */
  it('says the own-words row has no sample, rather than showing another’s', (t) => {
    const withPreviews = question({
      options: [
        { label: 'Left', preview: 'l e f t' },
        { label: 'Right', preview: 'r i g h t' }
      ]
    });
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [withPreviews] })] }));
    const other = p.window.document.querySelector<HTMLElement>('#question .qopt.other button');
    other?.click();
    assert.equal(
      p.window.document.querySelector('#question .qprev-cap .of')?.textContent,
      '— none for your own words'
    );
    // And an empty box is a real state — it must not fall back to option 0's
    // sample, which is what folding the row's two fields into one would do.
    assert.equal(
      p.window.document.querySelector('#question pre.qprev')?.textContent?.includes('l e f t'),
      false
    );
  });

  it('confirms on Enter in the question, and still sends on Enter in the box', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    opts(p)[0]?.click();
    p.window.document
      .getElementById('question')
      ?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[0]] }
    });

    importComposer(p, 'still typing');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still typing'
    });
  });

  it('offers no way to answer a session this window cannot reach', (t) => {
    // The card says `waiting` — that much is read off disk and stays true — and
    // the dock offers nothing that would answer it: a question reaches the
    // panel on a pipe, and this window holds none for that session.
    const p = openThread(t, unreachableThread({ status: 'waiting' }));
    assert.equal(layer(p).hidden, true);
    assert.equal(opts(p).length, 0);
    assert.equal((p.window.document.getElementById('qlaunch') as HTMLElement).hidden, true);
  });

  it('shows no such note when dialogs are on and there is simply no ask', (t) => {
    const p = openThread(t, threadView({ status: 'waiting', canSend: false }));
    assert.equal((p.window.document.getElementById('qlaunch') as HTMLElement).hidden, true);
  });

  // ---- the layer the question is answered in --------------------------------
  //
  // The block used to sit in the composer, at the bottom of a dock capped at
  // half the panel, sharing its height with the thread. A tall ask overflowed
  // it and `body { overflow: hidden }` cut the CTA off with no scrollbar. It
  // now lives in a layer over the card column, which is never the narrower of
  // the two, and the composer keeps a launcher.

  const layer = (p: Panel): HTMLElement => p.window.document.getElementById('ask') as HTMLElement;
  const scrim = (p: Panel): HTMLElement => p.window.document.getElementById('scrim') as HTMLElement;
  const launcher = (p: Panel): HTMLButtonElement =>
    p.window.document.getElementById('qlaunch') as HTMLButtonElement;
  /** A key press where a reader's would land: on whatever has focus. */
  const press = (p: Panel, name: string, mods: KeyboardEventInit = {}): void => {
    p.window.document.activeElement?.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: name, bubbles: true, ...mods })
    );
  };

  /**
   * The launcher is a button with two spans in it and nothing else, so a press
   * lands on one of them — and both were rebuilt on every push. Down on the
   * headline, a poll, up: the node the press landed on is gone and no click is
   * dispatched, which reads as the one control between a blocked session and
   * its dialog ignoring you. The words are written in place instead.
   */
  it('keeps the launcher’s own words across a poll', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const pending = [askRequest({ questions: [question({ header: 'Route' })] })];
    const p = openThread(t, threadView({ pending }));
    const headline = launcher(p).querySelector('.q');
    const at = launcher(p).querySelector('.at');
    assert.ok(headline && at);

    p.push(stateMessage(groups, { thread: threadView({ pending }) }));

    assert.equal(launcher(p).querySelector('.q'), headline, 'rebuilt under the pointer');
    assert.equal(launcher(p).querySelector('.at'), at, 'rebuilt under the pointer');

    // The words still follow the state: a second request waiting says so.
    p.push(
      stateMessage(groups, {
        thread: threadView({
          pending: [...pending, permissionRequest({ requestId: 'req-2' })]
        })
      })
    );
    assert.match(launcher(p).textContent ?? '', /2 waiting/);
  });

  it('offers the launcher and opens nothing by itself', (t) => {
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ questions: [question({ header: 'Route' })] })] })
    );
    assert.equal(launcher(p).hidden, false, 'the composer says an ask is waiting');
    assert.match(launcher(p).textContent ?? '', /Route/);
    assert.equal(layer(p).hidden, true, 'an arriving ask must not take the screen');
    assert.equal(scrim(p).hidden, true);
  });

  it('opens on the launcher and closes on a second click', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    assert.equal(layer(p).hidden, false);
    assert.equal(scrim(p).hidden, false);
    launcher(p).click();
    assert.equal(layer(p).hidden, true);
    assert.equal(scrim(p).hidden, true);
  });

  it('puts focus in the block on open and back on the launcher on Escape', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    // The container, not an option row: every stage rebuilds the rows, and a
    // keyboard parked on one of them would go dead on the first digit.
    assert.equal(
      p.window.document.activeElement,
      p.window.document.getElementById('question'),
      'digits need focus in here'
    );
    press(p, 'Escape');
    assert.equal(layer(p).hidden, true);
    assert.equal(p.window.document.activeElement, launcher(p), 'no way back in otherwise');
  });

  it('closes on the scrim, but not on a click inside the block', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    opts(p)[0]?.click();
    assert.equal(layer(p).hidden, false, 'picking an option is not clicking away');
    scrim(p).click();
    assert.equal(layer(p).hidden, true);
  });

  it('keeps staged picks across a close and reopen', (t) => {
    // Dismissing to read the thread behind it is a normal move, not an
    // abandonment — which is the whole reason this is a layer over the cards
    // rather than one over the transcript.
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    opts(p)[1]?.click();
    press(p, 'Escape');
    assert.equal(layer(p).hidden, true, 'Escape did not close it');
    launcher(p).click();
    assert.equal(layer(p).hidden, false, 'the launcher did not reopen it');
    assert.ok(opts(p)[1]?.classList.contains('on'), 'the pick did not survive');
    assert.equal(cta(p)?.disabled, false);
  });

  it('stays open when the ask changes, and shuts when it goes away', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    opts(p)[0]?.click();

    p.push(
      stateMessage(groups, {
        thread: threadView({
          pending: [askRequest({ requestId: 'req-2', questions: [question()] })]
        })
      })
    );
    assert.equal(layer(p).hidden, false, 'a new ask is still an ask to answer');
    assert.equal(cta(p)?.disabled, true, 'but not with the last one’s pick');

    p.push(stateMessage(groups, { thread: threadView({ pending: undefined }) }));
    assert.equal(layer(p).hidden, true);
    assert.equal(launcher(p).hidden, true);
  });

  it('answers digits and Enter while the layer has focus', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, '2');
    assert.ok(opts(p)[1]?.classList.contains('on'));
    press(p, 'Enter');
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[1]] }
    });
  });

  // ---- the arrows -----------------------------------------------------------
  //
  // The terminal's own gesture: arrow to a row, Enter to take it. A digit says
  // which row without reading it; the arrows are for a list being read. The CTA
  // is the last stop on the walk, which leaves Enter one meaning — press what
  // the cursor is on — and makes going on cost a move onto a labelled button.

  /** The row the keyboard is on, by index into the visible rows. */
  const cursor = (p: Panel): number => opts(p).findIndex((o) => o.classList.contains('cur'));
  /** Whether the walk has reached the button at the end of it. */
  const onCta = (p: Panel): boolean => cta(p)?.classList.contains('cur') ?? false;

  it('moves a cursor with the arrows and stages nothing on the way', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    assert.equal(cursor(p), -1, 'an arriving ask highlights nothing');
    press(p, 'ArrowDown');
    assert.equal(cursor(p), 0);
    press(p, 'ArrowDown');
    assert.equal(cursor(p), 1);
    assert.ok(!opts(p).some((o) => o.classList.contains('on')), 'moving is not picking');
    assert.equal(cta(p)?.disabled, true);
    // Past the `Other` row, onto the button, and round to the top: every stop
    // is reachable from either end.
    press(p, 'ArrowDown');
    assert.equal(cursor(p), 2, 'the Other row is a row the cursor walks');
    press(p, 'ArrowDown');
    assert.ok(onCta(p), 'and the button is the stop after it');
    press(p, 'ArrowDown');
    assert.equal(cursor(p), 0);
    press(p, 'ArrowUp');
    assert.ok(onCta(p));
  });

  it('stages on Enter, and sends only from the button', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, 'ArrowDown');
    press(p, 'ArrowDown');
    press(p, 'Enter');
    assert.ok(opts(p)[1]?.classList.contains('on'), 'Enter on a row is the pick');
    assert.deepEqual(answers(p), [], 'and only the pick');
    press(p, 'Enter');
    assert.deepEqual(answers(p), [], 'a second press on the same row is not a send');
    // A radio row does not come back off — the pick moves, as it does for a
    // click. Only a pick-any row toggles, and there Enter is what toggles it.
    assert.ok(opts(p)[1]?.classList.contains('on'));

    press(p, 'ArrowDown');
    press(p, 'ArrowDown');
    assert.ok(onCta(p));
    press(p, 'Enter');
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[1]] }
    });
  });

  it('presses the button on the modifier from wherever the cursor is', (t) => {
    // The walk is the discoverable way on; this is the way that skips it, on a
    // four-question ask where the trip to the button is made four times.
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, 'ArrowDown');
    press(p, 'Enter');
    assert.ok(opts(p)[0]?.classList.contains('on'));
    assert.equal(cursor(p), 0, 'still on the row, nowhere near the button');
    press(p, 'Enter', { metaKey: true });
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[0]] }
    });
  });

  it('leaves Enter alone where no arrow has been pressed', (t) => {
    // The reason the cursor starts unset: a fresh ask that highlighted its own
    // first option would answer to a stray Enter.
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, 'Enter');
    assert.ok(!opts(p).some((o) => o.classList.contains('on')));
    assert.deepEqual(answers(p), []);
  });

  it('builds a pick-any set a row at a time, with nothing extra to know', (t) => {
    // The same key on every stop, so a pick-any question needs no rule of its
    // own — which is what the button being on the walk bought.
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ questions: [question({ multiSelect: true })] })] })
    );
    launcher(p).click();
    press(p, 'ArrowDown');
    press(p, 'Enter');
    press(p, 'ArrowDown');
    press(p, 'Enter');
    assert.ok(opts(p)[0]?.classList.contains('on'));
    assert.ok(opts(p)[1]?.classList.contains('on'));
    press(p, 'Enter');
    assert.ok(!opts(p)[1]?.classList.contains('on'), 'the same press takes one back out');
    assert.deepEqual(answers(p), [], 'none of which sent anything');
    press(p, 'ArrowDown');
    press(p, 'ArrowDown');
    press(p, 'Enter');
    assert.deepEqual(answers(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, picks: [[0]] }
    });
  });

  it('moves a pick-one pick with the cursor rather than sending the old one', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, 'ArrowDown');
    press(p, 'Enter'); // row 0 staged
    press(p, 'ArrowDown');
    press(p, 'Enter'); // a change of mind, not a send
    assert.deepEqual(answers(p), []);
    assert.ok(!opts(p)[0]?.classList.contains('on'));
    assert.ok(opts(p)[1]?.classList.contains('on'));
  });

  it('walks the questions sideways and drops the cursor on the way', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [
          askRequest({
            questions: [question({ header: 'Route' }), question({ header: 'Pace' })]
          })
        ]
      })
    );
    launcher(p).click();
    press(p, 'ArrowDown');
    assert.equal(cursor(p), 0);
    // Looking at the next question is not answering this one, so the CTA's gate
    // does not apply — the same rule a click on a stepper chip follows.
    press(p, 'ArrowRight');
    assert.equal(p.window.document.querySelector('#question .qhdr span')?.textContent, 'Pace');
    assert.equal(cursor(p), -1, 'the cursor belonged to the question it was on');
    press(p, 'ArrowLeft');
    assert.equal(p.window.document.querySelector('#question .qhdr span')?.textContent, 'Route');
    // The ends are real: nothing to the left of the first question.
    press(p, 'ArrowLeft');
    assert.equal(p.window.document.querySelector('#question .qhdr span')?.textContent, 'Route');
  });

  it('answers in its own words from the cursor too', (t) => {
    const p = openThread(t, threadView({ pending: [askRequest({ questions: [question()] })] }));
    launcher(p).click();
    press(p, 'ArrowUp'); // round to the button at the end of the walk
    press(p, 'ArrowUp'); // and the row before it, which is Other
    press(p, 'Enter');
    const box = p.window.document.querySelector<HTMLElement>('#question .qother-in');
    assert.ok(box, 'staging the Other row opens its field');
    assert.equal(p.window.document.activeElement, proseRoot(box), 'and hands it the caret');
  });

  // Both ways in are one behaviour: a press can only record an intent, because
  // select() posts and returns and the card it was made on carries no ask —
  // only the thread does, a push later. Opening on the click would show the
  // outgoing session's block.
  for (const [where, sel] of [
    ['the waiting stack', '#bottomhub-waiting .waiting-session'],
    ['the blocked card itself', '.card[data-pid="7"]']
  ] as const) {
    it(`opens from ${where}, on the push that carries the ask`, (t) => {
      const p = openPanel(t);
      const groups = [
        groupView({ sessions: [cardView({ pid: 7, status: 'waiting', name: 'blocked one' })] })
      ];
      p.push(stateMessage(groups));
      p.window.document.querySelector<HTMLElement>(sel)?.click();
      assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'select', pid: 7 });
      assert.equal(layer(p).hidden, true, 'nothing to show until the ask arrives');

      p.push(
        stateMessage(groups, {
          thread: threadView({ pid: 7, pending: [askRequest({ questions: [question()] })] })
        })
      );
      assert.equal(layer(p).hidden, false, 'the intent is honoured when it can be');
    });
  }

  // The other half of the same press, and the one the reader meets most: the
  // session pressed is already the open one, so `select` posts nothing and no
  // push is coming to honour an intent with. Held over for one, the layer waits
  // out the host's unchanged-state floor — a blocked board changes nothing, so
  // the dialog opened seconds after the press that asked for it.
  it('opens at once when the ask is already on screen', (t) => {
    const p = openPanel(t);
    const groups = [
      groupView({ sessions: [cardView({ pid: 7, status: 'waiting', name: 'blocked one' })] })
    ];
    p.push(stateMessage(groups));
    const card = (): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>('.card[data-pid="7"]');
    card()?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 7, pending: [askRequest({ questions: [question()] })] })
      })
    );
    assert.equal(layer(p).hidden, false);
    scrim(p).click();
    assert.equal(layer(p).hidden, true, 'the reader put it away');

    const posted = p.posted.length;
    card()?.click();
    assert.equal(layer(p).hidden, false, 'the ask is already here — nothing to wait for');
    assert.equal(p.posted.length, posted, 'and nothing was asked of the host to show it');
  });

  it('leaves the layer shut when the card pressed owes nothing', (t) => {
    const p = openPanel(t);
    const groups = [groupView({ sessions: [cardView({ pid: 7, status: 'idle' })] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="7"]')?.click();
    // A question arriving later is the launcher's to open, not this press's:
    // an intent recorded off an idle card would spring open a dialog the
    // reader never asked to see.
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 7, pending: [askRequest({ questions: [question()] })] })
      })
    );
    assert.equal(layer(p).hidden, true);
  });

  it('leaves the composer with a launcher and nothing else', (t) => {
    const p = openThread(
      t,
      threadView({
        status: 'waiting',
        canSend: false,
        blockedReason:
          'Waiting on a dialog — typing here would answer it. Open the terminal instead.',
        pending: [askRequest({ questions: [question()] })]
      })
    );
    const composer = p.window.document.getElementById('composer') as HTMLElement;
    assert.equal(composer.querySelector('.qblock'), null, 'one renderer, one home');
    assert.ok(composer.contains(launcher(p)));
    // Otherwise this sits right under the launcher telling the reader to go and
    // use the terminal — the advice this whole surface exists to retire.
    assert.equal(p.window.document.getElementById('blocked')?.textContent, '');
  });
});

/**
 * The shapes an ask can take, now that every one of them is answerable.
 *
 * A response is addressed by the CLI's own request id and carries every
 * question's answer at once, so nothing about an ask's shape puts it out of
 * reach — where a burst of keystrokes addressed by position had to refuse a
 * multi-select that was not last, and anything past nine options.
 */
describe('an ask an owned session is blocked on', () => {
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);

  /** Three questions with the multi-select in the middle — the exact shape no
   *  keystroke burst could carry, and an ordinary response here. */
  const midMulti = (): PendingQuestion[] => [
    questionView({ header: 'Route' }),
    questionView({
      header: 'Pace',
      question: 'How fast?',
      multiSelect: true,
      options: [{ label: 'Slow' }, { label: 'Steady' }, { label: 'Fast' }]
    }),
    questionView({ header: 'Stops', question: 'Where do we stop?' })
  ];

  it('answers a multi-select in slot 2, which no keystroke burst could', (t) => {
    const p = openThread(
      t,
      threadView({ pending: [askRequest({ requestId: 'r7', questions: midMulti() })] })
    );
    assert.equal(p.window.document.querySelectorAll('#question .step').length, 3);
    assert.equal(p.window.document.querySelector('#question .qtext')?.textContent, 'Which way?');
    assert.doesNotMatch(
      p.window.document.getElementById('qlaunch')?.textContent ?? '',
      /terminal/,
      'nothing about an owned ask is out of reach'
    );

    opts(p)[0]?.click();
    cta(p)?.click();
    // The multi-select, mid-ask: two of its three, and still nothing posted.
    opts(p)[0]?.click();
    opts(p)[2]?.click();
    assert.deepEqual(responses(p), []);
    cta(p)?.click();
    opts(p)[1]?.click();
    cta(p)?.click();

    assert.deepEqual(responses(p), [
      {
        type: 'respond',
        pid: 101,
        requestId: 'r7',
        decision: { allow: true, picks: [[0], [0, 2], [1]] }
      }
    ]);
  });

  it('discards a staged pick when the CLI retracts the request', (t) => {
    // An interrupt cancels an open request about a millisecond after it is
    // asked for. A pick staged on that dialog has nothing left to answer, so it
    // goes — posting it would address a request the CLI has already withdrawn.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, threadView({ pending: [askRequest({ requestId: 'r7' })] }));
    opts(p)[1]?.click();
    assert.ok(opts(p)[1]?.classList.contains('on'));

    p.push(stateMessage(groups, { thread: threadView({ pending: [] }) }));
    assert.equal(opts(p).length, 0, 'the dialog went with the request');
    assert.deepEqual(responses(p), [], 'and took the staged pick with it, unposted');

    p.push(
      stateMessage(groups, { thread: threadView({ pending: [askRequest({ requestId: 'r7' })] }) })
    );
    assert.equal(cta(p)?.disabled, true, 'a request that comes back starts blank');
  });

  it('keeps a staged pick across a poll that changes nothing', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, threadView({ pending: [askRequest({ requestId: 'r7' })] }));
    opts(p)[1]?.click();
    p.push(
      stateMessage(groups, { thread: threadView({ pending: [askRequest({ requestId: 'r7' })] }) })
    );
    assert.ok(opts(p)[1]?.classList.contains('on'), 'the poll must not wipe a staged pick');
  });
});

/**
 * Saying something the option list does not offer.
 *
 * The CLI's own widget has three ways past the labels — `Other`, `Chat about
 * this` and `escape` — and the panel had none of them, so anything else to say
 * meant going to the terminal for the whole ask. Owned sessions only: a
 * terminal one's answer is a burst of keystrokes addressed by row, and typed
 * words have no row.
 *
 * `Other` is a row of the same list, at the position the CLI puts it — which is
 * the whole of the design: it is picked, cleared and counted like any other row,
 * so "which of a pick and a typed answer wins" is not a question that can be
 * asked, and the rule that used to answer it invisibly is gone.
 */
describe('answering an owned ask in your own words', () => {
  const box = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qother-in');
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  /** The `Other` row's own button — the part of it that is a pick. */
  const other = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qopt.other .qother-pick');
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  /** Typing, through the editor's own text-input path. */
  const type = typeProse;
  const owned = (over: Partial<ThreadView> = {}): ThreadView =>
    threadView({
      owned: true,
      status: 'waiting',
      pending: [askRequest({ requestId: 'r7' })],
      ...over
    });

  it('lists the reader’s own words as the row after the options', (t) => {
    const p = openThread(t, owned());
    assert.equal(opts(p).length, 3, 'two options, then the row for anything else');
    const row = opts(p)[2] as HTMLElement;
    assert.ok(row.classList.contains('other'));
    assert.equal(row.querySelector('.kbd')?.textContent, '3', 'the digit after the last option');
    assert.ok(row.querySelector('.mark.one'), 'the same mark the question’s shape gives every row');
    assert.equal(box(p), null, 'and no field until the row is picked');
    assert.equal(cta(p)?.disabled, true);
  });

  it('opens a field when the row is picked, and sends what is typed', (t) => {
    const p = openThread(t, owned());
    other(p)?.click();
    assert.ok(opts(p)[2]?.classList.contains('on'), 'staged like any other row');
    assert.ok(box(p), 'the field belongs to the row');
    assert.equal(cta(p)?.disabled, true, 'a picked row with nothing in it is not an answer');
    assert.match(
      cta(p)?.textContent ?? '',
      /Send answer/,
      'the shape is settled, the words are not'
    );

    type(p, box(p), 'Neither — take the coast road');
    assert.equal(cta(p)?.disabled, false);
    cta(p)?.click();
    assert.deepEqual(responses(p), [
      {
        type: 'respond',
        pid: 101,
        requestId: 'r7',
        decision: { allow: true, picks: [[]], texts: ['Neither — take the coast road'] }
      }
    ]);
  });

  it('clears a pick and is cleared by one, single-select', (t) => {
    // A radio row cannot share, and this is a radio row. What was typed stays
    // staged behind it — a misclick costs nothing — but nothing on screen says
    // it is being sent.
    const p = openThread(t, owned());
    other(p)?.click();
    type(p, box(p), 'the coast road');
    opts(p)[0]?.click();
    assert.ok(!opts(p)[2]?.classList.contains('on'), 'the pick took the row with it');
    assert.equal(box(p), null, 'the field closes with the row');
    assert.match(opts(p)[2]?.textContent ?? '', /the coast road/, 'still there to come back to');

    other(p)?.click();
    assert.ok(!opts(p)[0]?.classList.contains('on'), 'and it clears the pick right back');
    assert.equal(proseOf(box(p)).value(), 'the coast road');

    // The send comes last, because it is the end of the dialog: past it nothing
    // stages, and the row swapping above would have nothing to swap.
    opts(p)[0]?.click();
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[0]] }
    });
  });

  it('ticks beside the picks on a multi-select, and rides the same array', (t) => {
    const p = openThread(
      t,
      owned({
        pending: [
          askRequest({
            requestId: 'r7',
            questions: [
              questionView({
                multiSelect: true,
                options: [{ label: 'Slow' }, { label: 'Steady' }, { label: 'Fast' }]
              })
            ]
          })
        ]
      })
    );
    opts(p)[0]?.click();
    opts(p)[2]?.click();
    other(p)?.click();
    assert.ok(opts(p)[0]?.classList.contains('on'), 'a checkbox row keeps its neighbours');
    assert.equal(cta(p)?.disabled, true, 'a ticked box with nothing in it is not an answer');

    type(p, box(p), 'and stop at the lighthouse');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[0, 2]], texts: ['and stop at the lighthouse'] }
    });
  });

  it('stages the row from the digit after the last option', (t) => {
    const p = openThread(t, owned());
    const layer = p.window.document.getElementById('question') as HTMLElement;
    layer.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: '3', bubbles: true }));
    assert.ok(opts(p)[2]?.classList.contains('on'), 'row N+1, as in the terminal');
    assert.ok(box(p), 'and the caret is put where the answer goes');
    assert.equal(p.window.document.activeElement, proseRoot(box(p)));
  });

  it('mixes typed and picked answers across one ask', (t) => {
    const p = openThread(
      t,
      owned({
        pending: [
          askRequest({
            requestId: 'r7',
            questions: [
              questionView({ header: 'Route' }),
              questionView({ header: 'Pace', question: 'How fast?', multiSelect: true })
            ]
          })
        ]
      })
    );
    opts(p)[1]?.click();
    cta(p)?.click();
    assert.deepEqual(responses(p), [], 'still mid-ask');
    other(p)?.click();
    type(p, box(p), 'as slowly as you like');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      // Blank holds the picked question's place: the array is indexed like
      // `picks`, and `answerPayload` reads an empty box as nothing said.
      decision: { allow: true, picks: [[1], []], texts: ['', 'as slowly as you like'] }
    });
  });

  it('keeps typed text across a poll and drops it with the request', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, owned());
    other(p)?.click();
    type(p, box(p), 'the coast road');
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(
      proseOf(box(p)).value(),
      'the coast road',
      'the poll must not wipe what was typed'
    );
    assert.equal(cta(p)?.disabled, false);

    p.push(stateMessage(groups, { thread: owned({ pending: [] }) }));
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(box(p), null, 'a request that comes back starts blank');
    assert.equal(cta(p)?.disabled, true);
  });

  it('gives the list back on the first Escape and the layer on the second', (t) => {
    // The field is a row's own, so leaving it is not leaving the dialog. The
    // second Escape means what Escape has always meant here.
    const p = openThread(t, owned());
    p.window.document.getElementById('qlaunch')?.click();
    const layer = p.window.document.getElementById('question') as HTMLElement;
    other(p)?.click();
    proseKey(p, box(p), 'Escape');
    assert.equal(p.window.document.getElementById('ask')?.hidden, false, 'the layer stays open');
    assert.equal(p.window.document.activeElement, layer, 'the keys go back to the list');
    assert.ok(opts(p)[2]?.classList.contains('on'), 'and the row keeps what was picked');

    layer.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(p.window.document.getElementById('ask')?.hidden, true);
  });
});

/**
 * A word about the pick, rather than instead of it — "Option B, but only for
 * staging". The CLI takes one as `annotations` beside the answers, keyed the
 * same way, and appends it to the line the model reads with the label intact
 * (probed 2026-08-05, `docs/reference/cli_state/claude/protocol.md`).
 *
 * It is not the `Other` row and not a second one: that row is an *answer* in the
 * reader's own words, and a question answered that way has nothing left to
 * annotate. So the note is offered where a real option is picked, is off the
 * arrow walk — it is about a row, not one of them — and never gates the CTA. A
 * pick alone is still a whole answer.
 */
describe('noting why an owned ask was answered that way', () => {
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const add = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qnote-add');
  const note = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qnote-in');
  const other = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qopt.other .qother-pick');
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  const type = typeProse;
  const owned = (over: Partial<ThreadView> = {}): ThreadView =>
    threadView({
      owned: true,
      status: 'waiting',
      pending: [askRequest({ requestId: 'r7' })],
      ...over
    });

  it('offers nothing to annotate until a pick exists', (t) => {
    const p = openThread(t, owned());
    assert.equal(add(p), null, 'a note is about an answer, and there is none yet');
    opts(p)[0]?.click();
    assert.ok(add(p), 'the pick is what the note would be about');
    assert.equal(note(p), null, 'and the field waits to be asked for');
  });

  it('sends the note beside the pick, not instead of it', (t) => {
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    add(p)?.click();
    type(p, note(p), '  but only for staging\n');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[0]], notes: ['but only for staging'] }
    });
  });

  it('never gates the CTA on a note', (t) => {
    // A pick is a whole answer. An opened box nobody typed in must not hold the
    // dialog the way an empty `Other` row does — that row *is* the answer.
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    assert.equal(cta(p)?.disabled, false);
    add(p)?.click();
    assert.equal(cta(p)?.disabled, false, 'an empty note is no answer of its own');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[0]] }
    });
  });

  it('keeps a note when the pick moves inside the same question', (t) => {
    // The note is about the question, which is how the CLI keys it: swapping
    // one row for another is changing your mind about which one means it, not
    // withdrawing what was said.
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    add(p)?.click();
    type(p, note(p), 'but only for staging');
    opts(p)[1]?.click();
    assert.equal(proseOf(note(p)).value(), 'but only for staging');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[1]], notes: ['but only for staging'] }
    });
  });

  it('drops a note when the last tick of a multi-select goes', (t) => {
    // Nothing picked is nothing to annotate, whichever shape the question is.
    const p = openThread(
      t,
      owned({
        pending: [
          askRequest({
            requestId: 'r7',
            questions: [questionView({ multiSelect: true })]
          })
        ]
      })
    );
    opts(p)[0]?.click();
    opts(p)[1]?.click();
    add(p)?.click();
    type(p, note(p), 'skip the third');
    opts(p)[0]?.click();
    assert.equal(proseOf(note(p)).value(), 'skip the third', 'one tick left, so the note stands');
    opts(p)[1]?.click();
    assert.equal(add(p), null, 'and goes with the last of them');
  });

  it('offers no note on the row that is the reader’s own words', (t) => {
    // That row's words are the answer. A note on them would be a second answer
    // wearing a different name.
    const p = openThread(t, owned());
    other(p)?.click();
    assert.equal(add(p), null);
  });

  it('drops the note with the pick it was about', (t) => {
    // Single-select: the pick moves, and a note about the option that is no
    // longer chosen would be sent about one the reader never took.
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    add(p)?.click();
    type(p, note(p), 'but only for staging');
    other(p)?.click();
    assert.equal(add(p), null, 'nothing left to annotate');
    opts(p)[1]?.click();
    assert.equal(note(p), null, 'and the box comes back closed and empty');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[1]] }
    });
  });

  it('notes one question of several, indexed like the picks', (t) => {
    const p = openThread(
      t,
      owned({
        pending: [
          askRequest({
            requestId: 'r7',
            questions: [
              questionView({ question: 'Which fruit?' }),
              questionView({ question: 'Which speed?' })
            ]
          })
        ]
      })
    );
    opts(p)[0]?.click();
    cta(p)?.click();
    opts(p)[1]?.click();
    add(p)?.click();
    type(p, note(p), 'the road is closed past the bridge');
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: {
        allow: true,
        picks: [[0], [1]],
        notes: ['', 'the road is closed past the bridge']
      }
    });
  });

  it('sends from the note on the modifier, as every box here does', (t) => {
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    add(p)?.click();
    type(p, note(p), 'but only for staging');
    proseKey(p, note(p), 'Enter', { ctrlKey: true });
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[0]], notes: ['but only for staging'] }
    });
  });

  it('goes dead on screen while an answer is on its way', (t) => {
    // Every other control in a frozen dialog says so. A trigger that still
    // looks live and swallows the press is the button-that-did-nothing the
    // freeze exists to prevent.
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    cta(p)?.click();
    assert.equal(add(p)?.disabled, true);
    assert.ok(add(p)?.classList.contains('away'));
    add(p)?.click();
    assert.equal(note(p), null, 'and it opens nothing');
  });

  it('says which keys work once the caret is in the note', (t) => {
    // The strip is the only thing on screen that explains why the digits
    // stopped staging rows — same reason the `Other` row has its own line.
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    const keys = (): string =>
      p.window.document.querySelector('#question .qkeys')?.textContent ?? '';
    assert.match(keys(), /1–9/);
    add(p)?.click();
    assert.doesNotMatch(keys(), /1–9/, 'a digit in a box is a character');
    assert.match(keys(), /to send/);
    assert.match(keys(), /esc to go back to the list/);
  });

  it('keys the note to its own dialog, so two asks cannot share a box', (t) => {
    // `retype` finds a box by `data-say` with querySelector, first match wins.
    // Two asks on one session draw two question 0s, and an unqualified key
    // hands the caret — and the keystrokes after it — to the other dialog.
    const p = openThread(
      t,
      owned({
        pending: [
          askRequest({ requestId: 'r7' }),
          askRequest({ requestId: 'r8', questions: [questionView({ question: 'Which speed?' })] })
        ]
      })
    );
    // Re-queried between presses: every stage replaces the block, so a node
    // held across a click is a node no longer in the document.
    const dlg = (i: number): HTMLElement =>
      p.window.document.querySelectorAll<HTMLElement>('#question .pdlg')[i] as HTMLElement;
    assert.equal(p.window.document.querySelectorAll('#question .pdlg').length, 2);
    for (const i of [0, 1]) {
      dlg(i).querySelector<HTMLElement>('.qopt')?.click();
      dlg(i).querySelector<HTMLButtonElement>('.qnote-add')?.click();
    }
    const keys = [...p.window.document.querySelectorAll<HTMLElement>('#question .qnote-in')].map(
      (box) => box.dataset.say
    );
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2, 'one key each, or the caret lands on the wrong dialog');
    assert.ok(keys.every((key) => key?.includes('r7') || key?.includes('r8')));
  });

  it('keeps a note across a poll and drops it with the request', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    add(p)?.click();
    type(p, note(p), 'but only for staging');
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(proseOf(note(p)).value(), 'but only for staging', 'the poll must not wipe it');

    p.push(stateMessage(groups, { thread: owned({ pending: [] }) }));
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(add(p), null, 'a request that comes back starts blank');
  });
});

/**
 * Two requests stacked, and the height they are given between them.
 *
 * **jsdom cannot see this one, so it reads the stylesheet** — the same posture
 * and the same reason as `containment.test.ts`. There is no layout here, so a
 * scenario that pushed two requests and measured them would pass under every
 * version of the bug; what is asserted instead is the declaration the layout
 * depends on.
 *
 * The bug it holds shut: `.pdlg` sets `min-height: 0`, which opts a dialog out
 * of flex's automatic minimum size, and `flex-shrink` defaults to 1 — so both
 * dialogs compressed under their own content and `#question` never scrolled at
 * all. Measured in Chromium against the shipped sheet, a permission dialog
 * beside a question: 56px of box for 84px of rows at a 694px board, and the
 * permission row drawn 17px into the question's stepper (34px at 579px).
 */
describe('the ask layer with more than one request in it', () => {
  /** One selector's declarations, comments stripped, whitespace flattened. */
  const declared = (selector: string): string => {
    const sheet = panelStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = sheet
      .split('}')
      .map((block) => block.split('{'))
      .find(([sel]) => (sel ?? '').trim() === selector);
    return (rule?.[1] ?? '').replace(/\s+/g, ' ').trim();
  };

  it('sizes a stacked dialog by its content rather than by the room left', () => {
    assert.match(
      declared('#question > .pdlg'),
      /flex: none/,
      'without it both dialogs shrink under their rows and the text overlaps'
    );
  });

  it('still lets a lone dialog fill the layer and scroll inside itself', () => {
    assert.match(declared('#question > .pdlg:only-child'), /flex: 1/);
  });

  /**
   * The other axis. Two columns need more width than a narrow board has, and
   * what happened below their floors was a sideways pan of the whole layer —
   * the CTA travelling horizontally with the content. Stacking is the answer a
   * reader can use; this asserts the query exists and drops the floors with it,
   * since a floor is what forced the pan in the first place.
   */
  it('stacks the preview under the options rather than panning sideways', () => {
    const sheet = panelStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
    const query = /@container \(max-width: (\d+)px\) \{([^{]*\{[^}]*\}\s*)+\}/g;
    const stacking = [...sheet.matchAll(query)].find(
      (m) => m[0].includes('.qblock') && /flex-direction: column/.test(m[0])
    );
    assert.ok(stacking, 'no container query stacks .qblock');
    assert.match(stacking[0], /\.qcol[^{]*\{[^}]*min-width: 0/, 'the floors outlive the columns');
    // Stacked on a short board something has to give, and it must not be the
    // options: a preview that cannot shrink squeezed them to nothing and then
    // drew over the row below. Shrinkable, and bounded by a share of the box.
    assert.match(
      stacking[0],
      /\.qprev-col[^{]*\{[^}]*flex: 0 1 auto[^}]*max-height: \d+%/,
      'the preview must yield before the options do'
    );
  });
});

describe('an ask that cannot note or reply', () => {
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const add = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qnote-add');
  const trigger = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qbail-t');
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const gated = (): ThreadView =>
    threadView({
      owned: true,
      status: 'waiting',
      pending: [askRequest({ requestId: 'r-g', canNote: false, canReply: false })]
    });

  it('still offers a note and talk-back when the flags are absent', (t) => {
    const p = openThread(
      t,
      threadView({ owned: true, status: 'waiting', pending: [askRequest({ requestId: 'r7' })] })
    );
    opts(p)[0]?.click();
    assert.ok(add(p), 'Claude-shaped asks keep Add a note');
    assert.ok(trigger(p), 'and the bail trigger');
  });

  it('hides both arms when the flags are off, and confirm still posts picks', (t) => {
    const p = openThread(t, gated());
    opts(p)[0]?.click();
    assert.equal(add(p), null);
    assert.equal(trigger(p), null);
    cta(p)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'respond',
      pid: 101,
      requestId: 'r-g',
      decision: { allow: true, picks: [[0]] }
    });
  });
});

/**
 * Talking back instead of answering: the CLI's `Chat about this`, which is a
 * tool denial carrying feedback rather than a cancel. The turn survives, the
 * model reads the words, and it gets to ask again.
 *
 * Disclosed rather than open, because an open box beside the box that answers
 * the question is the whole reason nobody could tell them apart.
 */
describe('replying to an owned ask instead of answering it', () => {
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  const trigger = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qbail-t');
  const say = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .say-in');
  const send = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qreply');
  const owned = (): ThreadView =>
    threadView({ owned: true, status: 'waiting', pending: [askRequest({ requestId: 'r7' })] });

  it('stays shut while the question is being answered', (t) => {
    const p = openThread(t, owned());
    assert.equal(say(p), null, 'one box on screen, and it is the one that answers');
    assert.match(trigger(p)?.textContent ?? '', /Don’t answer/);
  });

  it('says what it does before it is used, and denies with the words', (t) => {
    const p = openThread(t, owned());
    trigger(p)?.click();
    assert.match(
      p.window.document.querySelector('#question .qbail-cap')?.textContent ?? '',
      /Answers nothing/,
      'the consequence leads, not the box'
    );
    assert.match(
      p.window.document.querySelector('#question .qbail-why')?.textContent ?? '',
      /ask you again/,
      'and says the turn survives it'
    );
    assert.equal(send(p)?.disabled, true, 'a denial with nothing in it says nothing');

    typeProse(p, say(p), 'Neither of these — I meant the other repo');
    assert.equal(send(p)?.disabled, false);
    send(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: false, message: 'Neither of these — I meant the other repo' }
    });
  });

  it('holds the reply sent until a push speaks for it', (t) => {
    // The same second the CTA waits out: the reply is on the pipe, the refresh
    // behind it is not instant, and a live Send over an answered request reads
    // as a button that did nothing — and posts a second response if pressed.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, owned());
    // A pick first, so the CTA beside the reply is live and its freeze is worth
    // asserting — an unstaged CTA is disabled before anything is sent at all.
    p.window.document.querySelectorAll<HTMLButtonElement>('#question .qopt')[1]?.click();
    const cta = (): HTMLButtonElement | null =>
      p.window.document.querySelector<HTMLButtonElement>('#question .cta');
    assert.equal(cta()?.disabled, false, 'live before the reply goes');

    trigger(p)?.click();
    typeProse(p, say(p), 'the other repo');
    send(p)?.click();
    assert.equal(responses(p).length, 1);
    assert.equal(send(p)?.textContent, 'Sending…', 'the button the click just spent');
    assert.equal(send(p)?.disabled, true);

    // Its neighbours go dead with it, saying nothing of their own: the decision
    // was made here, and the CTA has not been pressed.
    assert.equal(cta()?.disabled, true);
    assert.notEqual(cta()?.textContent, 'Sending…');
    assert.equal(
      p.window.document.querySelector<HTMLButtonElement>('#question .qbail-back')?.disabled,
      true,
      'and there is no going back to the options from a decision already sent'
    );
    // The box with them: words typed after the send are words that were not
    // sent, and a repaint carrying the request back must not show them as the
    // answer. Read off the live box — the send's own repaint replaced the one
    // that was typed into.
    assert.equal(proseRoot(say(p)).getAttribute('contenteditable'), 'false');
    typeProse(p, say(p), 'the other repo, and one more thing');
    assert.equal(send(p)?.disabled, true, 'and typing cannot hand the button back');

    // Nothing else answers either. The keyboard is the reachable second press —
    // the layer's own Enter is not disabled the way the buttons are, so this is
    // the guard in `confirmAsk` and not the DOM refusing a dead button.
    p.window.document.querySelector<HTMLElement>('#question')?.focus();
    p.window.document.activeElement?.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, metaKey: true })
    );
    p.window.document.querySelectorAll<HTMLButtonElement>('#question .qopt')[0]?.click();
    assert.equal(responses(p).length, 1, 'one decision, one response');

    // A push still carrying the request is not the host speaking for it.
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(send(p)?.textContent, 'Sending…');

    // The refusal is, and the box comes back with the words that were actually
    // sent — not the ones typed at it while it was frozen.
    answerRespond(p, { ok: false, reason: 'That session is no longer there to answer.' });
    assert.equal(send(p)?.disabled, false);
    assert.match(send(p)?.textContent ?? '', /^Send/);
    assert.equal(proseOf(say(p)).value(), 'the other repo');
    assert.equal(proseRoot(say(p)).getAttribute('contenteditable'), 'true');
    assert.match(
      p.window.document.querySelector('#question .qfail')?.textContent ?? '',
      /no longer there/
    );
  });

  it('closes again, keeping what was typed, and survives a poll open', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, owned());
    trigger(p)?.click();
    typeProse(p, say(p), 'the other repo');
    p.push(stateMessage(groups, { thread: owned() }));
    assert.equal(proseOf(say(p)).value(), 'the other repo', 'the poll must not shut it or wipe it');

    p.window.document.querySelector<HTMLButtonElement>('#question .qbail-back')?.click();
    assert.equal(say(p), null);
    trigger(p)?.click();
    assert.equal(proseOf(say(p)).value(), 'the other repo');
  });
});

describe('cancelling the turn a dialog is blocking', () => {
  const cancel = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qcancel');

  it('interrupts the turn from an owned session’s ask', (t) => {
    // There is no "withdraw this request" control subtype: interrupting the
    // turn is what makes the CLI retract it, and the dialog goes with the push
    // that follows.
    const p = openThread(
      t,
      threadView({ owned: true, status: 'waiting', pending: [askRequest({ requestId: 'r7' })] })
    );
    cancel(p)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 101 });
  });

  it('interrupts from a permission dialog too', (t) => {
    const p = openThread(
      t,
      threadView({ owned: true, status: 'waiting', pending: [permissionRequest()] })
    );
    cancel(p)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 101 });
  });

  it('offers nothing to cancel on a session this window cannot reach', (t) => {
    // `endable` is the one rule, and a session nothing here holds a pipe to is
    // `unknown` forever — never `busy`, so never endable.
    const p = openThread(t, unreachableThread({ status: 'waiting' }));
    assert.equal(cancel(p), null);
  });

  for (const ending of [{ closing: true }, { endStuck: true }] as const) {
    it(`offers no interrupt anywhere in the dock while ${Object.keys(ending)[0]}`, (t) => {
      // An end closes the pipe an interrupt would ride on — the card already
      // takes its Interrupt away. The head button, Escape and the dialog's
      // Cancel are the dock's three doors to the same verb.
      const p = openThread(
        t,
        threadView({ owned: true, status: 'waiting', pending: [permissionRequest()], ...ending })
      );
      const head = p.window.document.getElementById('chat-interrupt') as HTMLElement;
      assert.equal(head.style.display, 'none', 'head Interrupt');
      assert.equal(cancel(p), null, 'dialog Cancel');
      escape(p);
      assert.equal(
        p.posted.some((m) => m.type === 'interrupt'),
        false,
        'Escape'
      );
    });
  }
});

/**
 * Typing 注音 — or pinyin, or kana — into a dialog.
 *
 * A composition is browser state held on **one element**: until it is committed
 * the keystrokes are in no `value`, so a repaint that rebuilds the dialog does
 * not carry them across, it cancels them. The ask layer rebuilds itself whole
 * (`question.replaceChildren`) on every keystroke in the `Other` row and on
 * every push that changes the reply, which is why those two boxes took no 注音
 * at all while the note box beside them — the one box that repaints nothing —
 * always did.
 *
 * The guard is one rule in `kit.ts`: while a composition is live inside a
 * container, `paintIfChanged` holds the paint and runs it on `compositionend`.
 * These assert node *identity*, since jsdom has no IME to lose — the box being
 * composed in must be the same element after the paint that would have replaced
 * it, and that is exactly what a real composition needs.
 */
describe('composing in a dialog with an IME', () => {
  const box = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qother-in');
  const other = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .qopt.other .qother-pick');
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const say = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .say-in');
  const owned = (): ThreadView =>
    threadView({ owned: true, status: 'waiting', pending: [askRequest({ requestId: 'r7' })] });
  const groups = (): GroupView[] => [groupView({ sessions: [cardView({ pid: 101 })] })];

  /** A composition, as the DOM reports one: the events around the keystrokes,
   *  and the partial text the IME leaves in the box while it runs. */
  const compose = (p: Panel, field: HTMLElement, text: string): void => {
    proseRoot(field).dispatchEvent(
      new p.window.CompositionEvent('compositionstart', { bubbles: true })
    );
    typeProse(p, field, text);
  };
  /** The commit, in Blink's own order: the composed text lands in the box and
   *  raises `input`, and `compositionend` follows it. That order is why the flush
   *  paints what was committed rather than the draft behind it. */
  const commit = (p: Panel, field: HTMLElement, text: string): void => {
    typeProse(p, field, text);
    proseRoot(field).dispatchEvent(
      new p.window.CompositionEvent('compositionend', { bubbles: true })
    );
  };

  it('keeps the Other row’s box while 注音 is being composed in it', (t) => {
    const p = openThread(t, owned());
    other(p)?.click();
    const field = box(p) as HTMLElement;
    assert.ok(field, 'no field to compose in');

    compose(p, field, 'ㄓㄨˋ');
    assert.equal(box(p), field, 'the composing box was replaced mid-composition');
    assert.equal(proseOf(field).value(), 'ㄓㄨˋ');
    // The cost of holding it, stated: the CTA is drawn by the paint that is
    // being held, so it catches up when the composition ends and not before.
    assert.equal(cta(p)?.disabled, true);

    // This is the assertion that pins the *other* half of the guard: a hold
    // leaves the signature unrecorded, and had it been recorded the flush would
    // early-return on it and leave the CTA dead with the words already typed.
    commit(p, field, '注音');
    assert.equal(cta(p)?.disabled, false, 'the held paint never ran');
    cta(p)?.click();
    assert.deepEqual(p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody), [
      {
        type: 'respond',
        pid: 101,
        requestId: 'r7',
        decision: { allow: true, picks: [[]], texts: ['注音'] }
      }
    ]);
  });

  it('keeps the reply box across the poll that lands mid-composition', (t) => {
    const p = openThread(t, owned());
    p.window.document.querySelector<HTMLButtonElement>('#question .qbail-t')?.click();
    const field = say(p) as HTMLElement;
    assert.ok(field, 'no reply box to compose in');

    compose(p, field, 'ㄅㄨˊ');
    // The 3s push: the reply is in the layer's signature, so this is the repaint
    // that used to eat the composition.
    p.push(stateMessage(groups(), { thread: owned() }));
    assert.equal(say(p), field, 'the poll replaced the composing box');
    assert.equal(proseOf(field).value(), 'ㄅㄨˊ');

    commit(p, field, '不對');
    p.window.document.querySelector<HTMLButtonElement>('#question .qreply')?.click();
    assert.deepEqual(assertedMessageBody(p.posted.filter((m) => m.type === 'respond').at(-1)), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: false, message: '不對' }
    });
  });

  it('holds nothing on account of a composition in another surface', (t) => {
    // Scoped to the container being painted: the dock's composer is a box like
    // any other, and a composition in it must not freeze the dialog.
    const p = openThread(t, owned());
    composerTarget(p).dispatchEvent(
      new p.window.CompositionEvent('compositionstart', { bubbles: true })
    );
    p.window.document.querySelectorAll<HTMLButtonElement>('#question .qopt')[1]?.click();
    assert.equal(cta(p)?.disabled, false, 'the dialog was held by a composition elsewhere');
  });
  it('lets go of the hold when the box loses the caret mid-composition', (t) => {
    // The hold is released by an event, so a composition abandoned rather than
    // committed — the layer hidden from under it, focus moved by a push — would
    // freeze this container for the life of the webview if the focused element
    // were not part of the question. No `compositionend` is fired here on
    // purpose: that is the case being covered.
    const p = openThread(t, owned());
    other(p)?.click();
    const field = box(p) as HTMLElement;
    compose(p, field, 'ㄓㄨˋ');
    assert.equal(cta(p)?.disabled, true, 'the paint is held while the caret is in the box');

    p.window.document.getElementById('question')?.focus();
    p.push(stateMessage(groups(), { thread: owned() }));
    assert.equal(cta(p)?.disabled, false, 'the layer never painted again');
  });

  it('takes requests withdrawn mid-composition away, and answers nothing for them', (t) => {
    // The interrupt case, in the shape that decides it: an ask being typed into
    // and a permission dialog beside it, both dropped by the same interrupt.
    //
    // Two rules meet here. The records are cleared *inside* the paint that empties
    // the layer, because the paint is holdable and a dialog on screen whose
    // `sending` was wiped underneath it is a frozen control handed back live. And
    // every handler repaints from `ui.state.thread` rather than from the thread it
    // was built with, because the launcher is drawn *outside* the layer and so
    // outside its hold — painting from a snapshot re-advertises a dropped request
    // on it, and a permission dialog opened from there consults `sending` alone,
    // so its Allow would post against a request the session no longer has.
    const p = openThread(
      t,
      threadView({
        owned: true,
        status: 'waiting',
        pending: [askRequest({ requestId: 'r7' }), permissionRequest({ requestId: 'r8' })]
      })
    );
    other(p)?.click();
    const field = box(p) as HTMLElement;
    compose(p, field, 'ㄓㄨˋ');

    p.push(stateMessage(groups(), { thread: threadView({ owned: true, pending: [] }) }));
    assert.equal(box(p), field, 'the retraction replaced the composing box');
    // Nothing is advertised any more, layer or launcher — the launcher is never
    // held, so this is immediate.
    assert.equal(p.window.document.getElementById('ask')?.hidden, true);
    assert.equal(p.window.document.getElementById('qlaunch')?.hidden, true);

    // The committed words paint the layer the session actually has, which is none.
    commit(p, field, '注音');
    assert.equal(p.window.document.querySelector('#question .qblock'), null);
    assert.equal(p.window.document.querySelector('#question .pdlg'), null);
    assert.equal(p.window.document.getElementById('qlaunch')?.hidden, true);
    assert.deepEqual(p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody), []);
  });
});

/**
 * A request id is the CLI's own and is scoped to nothing. Grok spells one
 * `String(<jsonrpc id>)` and Codex the same, so two sessions blocked on their
 * first request both call it `1` — which makes the id alone the wrong key for
 * anything the panel remembers about a dialog.
 */
describe('two sessions blocked on the same request id', () => {
  const layer = (p: Panel): HTMLElement => p.window.document.getElementById('ask') as HTMLElement;
  const allow = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .pallow');
  const fail = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qfail');
  const CWD = '/Users/someone/proj';
  const groups = [
    groupView({
      cwd: CWD,
      sessions: [
        cardView({ pid: 4, owned: true, startedAt: 4_000 }),
        cardView({ pid: 5, owned: true, startedAt: 5_000 })
      ]
    })
  ];
  const blocked = (pid: number) =>
    threadView({ pid, startedAt: pid * 1000, pending: [permissionRequest({ requestId: '1' })] });
  const pick = (p: Panel, pid: number): void => {
    p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`)?.click();
  };

  /**
   * A report is settled against the session that made it, so a refusal for the
   * session the reader has left must not be waiting under the one they are on.
   * The push after it is what makes the claim observable: the report itself
   * paints nothing when it names a session nobody is looking at.
   */
  it('does not hand the second session the first one\u2019s refusal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    p.window.document.querySelector<HTMLElement>('#question .pallow')?.click();

    pick(p, 5);
    p.push({
      type: 'respondResult',
      pid: 4,
      startedAt: 4_000,
      requestId: '1',
      ok: false,
      reason: 'session ended'
    });
    p.push(stateMessage(groups, { thread: blocked(5) }));
    assert.ok(allow(p), 'the second session had no dialog to read');
    assert.equal(fail(p), null, 'the second session inherited the first one\u2019s refusal');
  });

  /**
   * And the freeze with it. This is the dangerous half: a dialog held at
   * "Sending…" is a control the reader cannot press twice, and one handed back
   * live on a request already answered is a second response on the pipe.
   */
  it('does not thaw the session on screen with a report for the one left', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    p.window.document.querySelector<HTMLElement>('#question .pallow')?.click();

    pick(p, 5);
    p.push(stateMessage(groups, { thread: blocked(5) }));
    p.window.document.querySelector<HTMLElement>('#question .pallow')?.click();
    assert.equal(allow(p)?.disabled, true, 'the second session\u2019s answer did not hold it');

    p.push({
      type: 'respondResult',
      pid: 4,
      startedAt: 4_000,
      requestId: '1',
      ok: false,
      reason: 'session ended'
    });
    p.push(stateMessage(groups, { thread: blocked(5) }));
    assert.equal(
      allow(p)?.disabled,
      true,
      'a report for the session left handed back the controls of the one on screen'
    );
  });

  /**
   * The three maps are cleared by the paint that empties the layer, and that
   * paint rides inside `paintIfChanged` — so a second empty paint on the same
   * signature runs no callback and clears nothing. A refusal landing in that
   * gap is what the session in the key is for: the clears cannot be relied on
   * to be the only thing between two sessions.
   */
  it('inherits no refusal through a paint the memo skipped', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    p.window.document.querySelector<HTMLElement>('#question .pallow')?.click();

    // New empties the layer once, which is the paint the memo records.
    newDraft(p, CWD);
    // The report lands with nothing selected, so it writes and does not paint.
    p.push({
      type: 'respondResult',
      pid: 4,
      startedAt: 4_000,
      requestId: '1',
      ok: false,
      reason: 'session ended'
    });
    // This empty paint has the signature the last one recorded, so its clears
    // do not run — which is exactly the state the next session arrives into.
    pick(p, 5);
    p.push(stateMessage(groups, { thread: blocked(5) }));
    assert.ok(allow(p), 'the second session had no dialog to read');
    assert.equal(fail(p), null, 'the second session inherited a refusal through the memo');
  });

  /**
   * The push is a poll behind the selection, so the one that lands just after a
   * card click still names the session before it. The layer is the *selected*
   * session's, and `renderThread` does not compare the two — so without a rule
   * of its own the layer paints the dialog of a session the reader has left,
   * over the board of the one they are on.
   */
  it('paints no dialog from a push that names the session just left', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    pick(p, 5);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    assert.equal(
      (p.window.document.getElementById('qlaunch') as HTMLElement).hidden,
      true,
      'the launcher offered an answer for the session the reader left'
    );
    assert.equal(
      p.window.document.getElementById('question')?.childElementCount,
      0,
      'the dialog of the session the reader left was painted over the new one'
    );
  });

  /**
   * And a report for the session on screen must survive that same lag. The
   * refusal is the one place a reader learns their answer bounced, and the paint
   * it asks for has to be skipped — not sent through the layer with a thread
   * that names somebody else, which empties it and takes the reason with it.
   */
  it('keeps the reason when the report outruns the push behind the select', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 5);
    p.push(stateMessage(groups, { thread: blocked(5) }));
    p.window.document.querySelector<HTMLElement>('#question .pallow')?.click();
    // Away and back: the last push now names 4 while 5 is the selection, which
    // is the state every card click passes through.
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    pick(p, 5);
    p.push({
      type: 'respondResult',
      pid: 5,
      startedAt: 5_000,
      requestId: '1',
      ok: false,
      reason: 'window refused'
    });
    p.push(stateMessage(groups, { thread: blocked(5) }));
    assert.match(
      fail(p)?.textContent ?? '',
      /window refused/,
      'the reader was never told why their answer bounced'
    );
  });

  /**
   * The leave a reader makes most. Nothing repaints the layer on a select — the
   * push that answers it is up to a poll away — so the dialog of the session
   * being left stood over the new one's board until then, offering an answer
   * from a dock that had already moved on.
   */
  it('takes the layer down with the session a select leaves', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    p.window.document.getElementById('qlaunch')?.click();
    assert.equal(layer(p).hidden, false, 'the blocked session had no layer to leave');

    // No push after the select: the window this is about is the one before it.
    pick(p, 5);
    assert.equal(layer(p).hidden, true, 'the select left the dialog over the new board');
    assert.equal(
      (p.window.document.getElementById('qlaunch') as HTMLElement).hidden,
      true,
      'the select left the launcher offering the other session\u2019s answer'
    );
  });

  /** The layer is drawn over the board, and belongs to the selected session. */
  it('takes the layer down when New leaves a blocked session', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(groups));
    pick(p, 4);
    p.push(stateMessage(groups, { thread: blocked(4) }));
    // The layer opens off the launcher; a reader with the dialog up is the case
    // this is about.
    p.window.document.getElementById('qlaunch')?.click();
    assert.equal(layer(p).hidden, false, 'the blocked session had no layer to leave');
    newDraft(p);
    assert.equal(layer(p).hidden, true, 'opening New left the dialog over the board');
    assert.equal(
      (p.window.document.getElementById('qlaunch') as HTMLElement).hidden,
      true,
      'opening New left the launcher offering an answer'
    );
  });
});

/**
 * A dialog's boxes are editors (`webview/prose.ts`), and an editor is state a
 * rebuild cannot copy across: its focus, its selection and its Undo history live
 * on the one node. The layer rebuilds on every stage, every push that changes it,
 * and every keystroke in the `Other` row, so each box is kept by its request and
 * placed again by every paint rather than made again
 * (`TASK_done_prose_input.md`, Steps 7–8).
 *
 * Undo is the probe that tells the two apart: a box made again from the staged
 * words holds the same text and has no history, so Ctrl+Z changes nothing.
 */
describe('a dialog box is one editor for as long as its request', () => {
  const box = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qother-in');
  const note = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .qnote-in');
  const say = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#question .say-in');
  const other = (p: Panel): void =>
    p.window.document.querySelector<HTMLElement>('#question .qopt.other .qother-pick')?.click();
  const opts = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .qopt')
  ];
  const cta = (p: Panel): HTMLButtonElement | null =>
    p.window.document.querySelector<HTMLButtonElement>('#question .cta');
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  const focused = (p: Panel): Element | null => p.window.document.activeElement;
  const undo = (p: Panel, host: HTMLElement | null): void => {
    proseKey(p, host, 'z', { ctrlKey: true });
  };
  const groups = (): GroupView[] => [groupView({ sessions: [cardView({ pid: 101 })] })];
  const twoQuestions = askRequest({
    requestId: 'r7',
    questions: [questionView({ header: 'Route' }), questionView({ header: 'Pace' })]
  });
  const owned = (pending: PendingRequestView[] = [askRequest({ requestId: 'r7' })]): ThreadView =>
    threadView({ owned: true, status: 'waiting', pending });
  /** Every key in a word, through the editor, one paint each. */
  const keystrokes = (host: HTMLElement | null, text: string): void => {
    for (const ch of text) proseOf(host).type(ch);
  };
  const chip = (p: Panel, header: string): void =>
    [...p.window.document.querySelectorAll<HTMLElement>('#question .step')]
      .find((s) => s.textContent?.includes(header))
      ?.click();

  it('keeps one node, its caret and its history through the Other row’s own repaints', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    const root = proseRoot(host);
    assert.equal(focused(p), root, 'picking the row hands the caret to its box');
    keystrokes(host, 'the coast road');
    // Each keystroke staged the words and repainted, which is what put the CTA
    // live; the box under the caret is the one it was.
    assert.equal(cta(p)?.disabled, false);
    assert.equal(box(p), host, 'a keystroke rebuilt the box');
    assert.equal(proseRoot(box(p)), root);
    assert.equal(focused(p), root, 'the caret left the box');
    // The selection survives too: typing over a range replaces that range.
    proseOf(host).select(5, 10);
    proseOf(host).type('C');
    assert.equal(proseOf(host).value(), 'the C road');
    undo(p, host);
    assert.equal(proseOf(host).value(), 'the coast road', 'no history: the box was made again');
  });

  it('keeps the box through a poll, caret, selection and history included', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    proseOf(host).select(5, 10);
    p.push(stateMessage(groups(), { thread: owned() }));
    assert.equal(box(p), host);
    assert.equal(focused(p), proseRoot(host));
    proseOf(host).type('C');
    assert.equal(proseOf(host).value(), 'the C road', 'the selection did not survive');
    undo(p, host);
    assert.equal(proseOf(host).value(), 'the coast road');
  });

  it('never takes the box out of the document to repaint around it', (t) => {
    // jsdom cannot tell a box kept in place from one moved and given the caret
    // back; a real IME can, since a detach cancels its composition. So this
    // reads the mutations: the paints ran, and none of them removed the box.
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    const layer = p.window.document.getElementById('question') as HTMLElement;
    const watch = new p.window.MutationObserver(() => {});
    watch.observe(layer, { childList: true, subtree: true });
    keystrokes(host, 'the coast road');
    p.push(
      stateMessage(groups(), {
        thread: owned([askRequest({ requestId: 'r7' }), permissionRequest({ requestId: 'r8' })])
      })
    );
    const removed = watch.takeRecords().flatMap((record) => [...record.removedNodes]);
    watch.disconnect();
    assert.ok(removed.length > 0, 'nothing was repainted at all');
    assert.ok(
      !removed.some((node) => node === host || node.contains(host)),
      'a repaint took the box out of the document'
    );
  });

  it('keeps the box when a second request arrives beside it', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    p.push(
      stateMessage(groups(), {
        thread: owned([askRequest({ requestId: 'r7' }), permissionRequest({ requestId: 'r8' })])
      })
    );
    assert.equal(p.window.document.querySelectorAll('#question .pdlg').length, 2);
    assert.equal(box(p), host, 'the arrival rebuilt the box');
    assert.equal(focused(p), proseRoot(host));
    undo(p, host);
    assert.equal(proseOf(host).value(), '');
  });

  it('parks the box while another question is shown and brings the same one back', (t) => {
    const p = openThread(t, owned([twoQuestions]));
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    chip(p, 'Pace');
    assert.equal(box(p), null, 'the second question has no box open');
    chip(p, 'Route');
    assert.equal(box(p), host, 'the first question’s box was made again');
    assert.equal(proseOf(host).value(), 'the coast road');
    undo(p, host);
    assert.equal(proseOf(host).value(), '', 'its history went with the paint that hid it');
  });

  it('keeps one Other box per question', (t) => {
    const p = openThread(t, owned([twoQuestions]));
    other(p);
    const first = box(p);
    keystrokes(first, 'by the coast');
    chip(p, 'Pace');
    other(p);
    const second = box(p);
    assert.ok(second);
    assert.notEqual(second, first, 'two questions shared one box');
    assert.equal(proseOf(second).value(), '');
    keystrokes(second, 'slowly');
    chip(p, 'Route');
    assert.equal(box(p), first);
    assert.equal(proseOf(first).value(), 'by the coast');
    cta(p)?.click();
    cta(p)?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'r7',
      decision: { allow: true, picks: [[], []], texts: ['by the coast', 'slowly'] }
    });
  });

  it('parks the box under a record and brings it back on Close', (t) => {
    const p = openThread(
      t,
      threadView({
        owned: true,
        status: 'waiting',
        pending: [askRequest({ requestId: 'r7' })],
        exchanges: [
          { role: 'assistant', text: '', blocks: [{ summary: 'Asked', ask: answeredAsk() }] }
        ]
      })
    );
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    p.window.document.querySelector<HTMLElement>('#thread .tool .askpill')?.click();
    assert.equal(box(p), null, 'the record draws no box');
    assert.equal(p.window.document.querySelector('#question .prose'), null);
    p.window.document.querySelector<HTMLButtonElement>('#question .qclose')?.click();
    assert.equal(box(p), host, 'the live box was made again behind the record');
    undo(p, host);
    assert.equal(proseOf(host).value(), '');
  });

  it('freezes the box on submit and hands the same one back on a refusal', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    cta(p)?.click();
    assert.equal(box(p), host);
    assert.equal(
      proseRoot(host).getAttribute('contenteditable'),
      'false',
      'words already sent stay as sent'
    );
    proseOf(host).type('!');
    assert.equal(proseOf(host).value(), 'the coast road');
    answerRespond(p, { ok: false, reason: 'That session is no longer there to answer.' });
    assert.equal(box(p), host);
    assert.equal(proseRoot(host).getAttribute('contenteditable'), 'true');
    proseOf(host).type('!');
    assert.equal(proseOf(host).value(), 'the coast road!');
  });

  it('freezes the reply box on send and thaws the same one on a refusal', (t) => {
    const p = openThread(t, owned());
    p.window.document.querySelector<HTMLButtonElement>('#question .qbail-t')?.click();
    const host = say(p);
    keystrokes(host, 'the other repo');
    assert.equal(focused(p), proseRoot(host));
    p.window.document.querySelector<HTMLButtonElement>('#question .qreply')?.click();
    assert.equal(say(p), host);
    assert.equal(proseRoot(host).getAttribute('contenteditable'), 'false');
    answerRespond(p, { ok: false, reason: 'That session is no longer there to answer.' });
    assert.equal(say(p), host);
    assert.equal(proseRoot(host).getAttribute('contenteditable'), 'true');
    undo(p, host);
    assert.equal(proseOf(host).value(), '', 'the thaw made the box again');
  });

  it('keeps the note box through the stage that moves its pick', (t) => {
    const p = openThread(t, owned());
    opts(p)[0]?.click();
    p.window.document.querySelector<HTMLButtonElement>('#question .qnote-add')?.click();
    const host = note(p);
    assert.equal(focused(p), proseRoot(host));
    keystrokes(host, 'only for staging');
    opts(p)[1]?.click();
    assert.equal(note(p), host);
    undo(p, host);
    assert.equal(proseOf(host).value(), '');
  });

  it('starts a request that comes back with a new box, and ends the old one', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    p.push(stateMessage(groups(), { thread: owned([]) }));
    p.push(stateMessage(groups(), { thread: owned() }));
    other(p);
    assert.ok(box(p));
    assert.notEqual(box(p), host);
    assert.equal(proseOf(box(p)).value(), '');
    assert.equal(
      (host as unknown as { prose?: unknown }).prose,
      undefined,
      'the editor of a request that went away was never destroyed'
    );
  });

  it('types digits and arrows into the box, never at the ask', (t) => {
    const p = openThread(t, owned([twoQuestions]));
    other(p);
    const host = box(p);
    for (const key of ['1', '2', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
      proseKey(p, host, key);
    }
    assert.ok(!opts(p)[0]?.classList.contains('on'), 'a digit staged a row');
    assert.ok(!opts(p)[1]?.classList.contains('on'), 'a digit staged a row');
    assert.equal(p.window.document.querySelector('#question .qopt.cur'), null, 'an arrow walked');
    assert.equal(
      p.window.document.querySelector('#question .qhdr span')?.textContent,
      'Route',
      'an arrow went to another question'
    );
  });

  it('sends the dialog the box is in, and only that one, on the modifier', (t) => {
    // The modifier is claimed in the editor and still bubbles to the layer,
    // whose own Enter sends the first ask pending. With a pick staged there, a
    // listener that let it through would answer both.
    const p = openThread(
      t,
      owned([
        askRequest({ requestId: 'r7' }),
        askRequest({ requestId: 'r9', questions: [questionView({ question: 'Which speed?' })] })
      ])
    );
    const dlg = (i: number): HTMLElement =>
      p.window.document.querySelectorAll<HTMLElement>('#question .pdlg')[i] as HTMLElement;
    dlg(0).querySelector<HTMLElement>('.qopt')?.click();
    dlg(1).querySelector<HTMLElement>('.qopt.other .qother-pick')?.click();
    const host = dlg(1).querySelector<HTMLElement>('.qother-in');
    keystrokes(host, 'slowly');
    proseKey(p, host, 'Enter', { ctrlKey: true });
    assert.deepEqual(
      responses(p).map((r) => (r as { requestId: string }).requestId),
      ['r9']
    );
  });

  it('hands the keys back to the list once a send freezes the box', (t) => {
    const p = openThread(t, owned());
    p.window.document.getElementById('qlaunch')?.click();
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    proseKey(p, host, 'Enter', { ctrlKey: true });
    assert.equal(proseRoot(host).getAttribute('contenteditable'), 'false');
    assert.equal(focused(p), p.window.document.getElementById('question'));
  });

  it('leaves an Escape that cancels a conversion to the IME', (t) => {
    const p = openThread(t, owned());
    p.window.document.getElementById('qlaunch')?.click();
    other(p);
    const host = box(p);
    proseKey(p, host, 'Escape', { isComposing: true });
    assert.equal(p.window.document.getElementById('ask')?.hidden, false);
    assert.equal(focused(p), proseRoot(host), 'the box lost the caret to an IME key');
  });

  it('leaves an IME Escape reported only as keyCode 229', (t) => {
    // Hosts that leave `isComposing` false still report the composing key as 229.
    const p = openThread(t, owned());
    p.window.document.getElementById('qlaunch')?.click();
    other(p);
    const host = box(p);
    proseKey(p, host, 'Escape', { keyCode: 229 });
    assert.equal(p.window.document.getElementById('ask')?.hidden, false);
    assert.equal(focused(p), proseRoot(host), 'the box lost the caret to an IME key');
  });

  it('holds the paint for a composition reported from inside the editing root', (t) => {
    // Blink can fire composition events at a node inside the root that has the
    // focus; the hold must still see the box.
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    const line = proseRoot(host).querySelector('p') as HTMLElement;
    line.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    keystrokes(host, '注音');
    assert.equal(cta(p)?.disabled, true, 'the paint ran mid-composition');
    proseRoot(host).dispatchEvent(
      new p.window.CompositionEvent('compositionend', { bubbles: true })
    );
    assert.equal(cta(p)?.disabled, false);
  });

  it('ends a parked box whose request goes while a record is up', (t) => {
    const thread = (pending: PendingRequestView[]): ThreadView =>
      threadView({
        owned: true,
        status: 'waiting',
        pending,
        exchanges: [
          { role: 'assistant', text: '', blocks: [{ summary: 'Asked', ask: answeredAsk() }] }
        ]
      });
    const p = openThread(t, thread([askRequest({ requestId: 'r7' })]));
    other(p);
    const host = box(p);
    keystrokes(host, 'the coast road');
    p.window.document.querySelector<HTMLElement>('#thread .tool .askpill')?.click();
    p.push(stateMessage(groups(), { thread: thread([]) }));
    assert.equal(
      (host as unknown as { prose?: unknown }).prose,
      undefined,
      'the editor outlived its request behind the record'
    );
  });

  it('sends once on the modifier, and Enter alone is a newline', (t) => {
    const p = openThread(t, owned());
    other(p);
    const host = box(p);
    keystrokes(host, 'one');
    proseKey(p, host, 'Enter');
    keystrokes(host, 'two');
    assert.equal(proseOf(host).value(), 'one\ntwo');
    assert.deepEqual(responses(p), []);
    proseKey(p, host, 'Enter', { ctrlKey: true });
    assert.deepEqual(responses(p), [
      {
        type: 'respond',
        pid: 101,
        requestId: 'r7',
        decision: { allow: true, picks: [[]], texts: ['one\ntwo'] }
      }
    ]);
  });
});
