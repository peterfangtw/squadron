import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  answerOpen,
  answerFilePick,
  answerSend,
  lastOpen,
  selectComposer,
  sendDraft,
  assertedMessageBody,
  attachWorkflow,
  cardView,
  enter,
  groupView,
  newDraft,
  openPanel,
  openThread,
  stateMessage,
  typeIn,
  unreachableThread,
  threadView,
  workflowView,
  Panel,
  composerKey,
  composerPills,
  composerValue,
  importComposer,
  pasteComposer,
  proseOf,
  type ProseBox,
  composerDisabled,
  composerPlaceholder,
  composerProse,
  formatButton,
  FOUR_LINES
} from '../harness';
import { panelStylesheet } from '../../ui/document';

describe('the composer', () => {
  it('keeps the hint outside the formatted document', (t) => {
    const p = openThread(t, threadView());
    const doc = p.window.document;
    const hint = doc.querySelector('.hintghost');
    assert.equal(hint?.querySelector('.hintlabel')?.textContent, 'Message this session…');
    assert.match(hint?.querySelector('.hintkeys')?.textContent ?? '', /send · ⇧↵ newline/);
    formatButton(p, 'codeBlock').click();
    assert.equal(
      doc.querySelectorAll('#input [data-placeholder]:not([data-placeholder=""])').length,
      0
    );
    assert.equal(hint?.querySelector('.hintlabel')?.textContent, 'Message this session…');
    assert.equal(doc.querySelector('#input')?.classList.contains('empty'), true);
    assert.doesNotMatch(composerValue(p), /Message this session|newline/);
    typeIn(p, 'const n = 1;');
    assert.equal(doc.querySelector('#input pre code')?.textContent, 'const n = 1;');
    assert.equal(doc.querySelector('#input')?.classList.contains('empty'), false);
  });

  for (const format of ['bulletList', 'orderedList', 'blockquote'] as const) {
    it(`hides the hint for an empty ${format} and restores it when unformatted`, (t) => {
      const p = openThread(t, threadView());
      const input = p.window.document.querySelector('#input');
      assert.equal(input?.classList.contains('empty'), true);
      formatButton(p, format).click();
      assert.equal(input?.classList.contains('empty'), false);
      assert.equal(p.window.document.querySelector<HTMLButtonElement>('#send')?.disabled, true);
      formatButton(p, format).click();
      assert.equal(input?.classList.contains('empty'), true);
    });
  }

  it('sends on Enter and echoes the message until the transcript has it', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'hello there');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'hello there'
    });
    assert.equal(composerValue(p), '');
    const echo = p.window.document.querySelector('#thread .turn.sending');
    assert.equal(echo?.querySelector('.body')?.textContent, 'hello there');

    // The transcript catches up: the echo yields to the real turn.
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({
          exchanges: [{ role: 'user', text: 'hello there', blocks: [{ prose: 'hello there' }] }]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
  });

  it('gates on the cache deadline even when real activity is recent', (t) => {
    const p = openThread(
      t,
      threadView({
        updatedAt: Date.now() - 60_000,
        cacheFrom: Date.now() - 31 * 60_000,
        cacheUntil: Date.now() - 60_000
      })
    );
    importComposer(p, 'carry on');
    enter(p);
    assert.notEqual(p.posted.at(-1)?.type, 'send');
    assert.match(p.window.document.getElementById('blocked')?.textContent ?? '', /full price/);
    enter(p);
    assert.equal(p.posted.at(-1)?.type, 'send');
  });

  it('sends after seventy minutes idle when the cache was refreshed', (t) => {
    const p = openThread(
      t,
      threadView({
        updatedAt: Date.now() - 70 * 60_000,
        cacheFrom: Date.now() - 10 * 60_000,
        cacheUntil: Date.now() + 50 * 60_000
      })
    );
    importComposer(p, 'carry on');
    enter(p);
    assert.equal(p.posted.at(-1)?.type, 'send');
  });

  it('makes the first Enter a warning when the prompt cache has expired', (t) => {
    const p = openThread(t, threadView({ updatedAt: Date.now() - 70 * 60_000 }));
    importComposer(p, 'carry on');
    enter(p);
    assert.notEqual(p.posted.at(-1)?.type, 'send', 'a cold-cache send went unconfirmed');
    assert.match(
      p.window.document.getElementById('blocked')?.textContent ?? '',
      /full price/,
      'nothing said why the send was held'
    );
    // The draft is the reader's: held, not eaten, so the confirmation is free.
    assert.equal(composerValue(p), 'carry on');

    // The 3s repaint must not wipe the warning out from under the reader.
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({ updatedAt: Date.now() - 70 * 60_000 })
      })
    );
    assert.match(p.window.document.getElementById('blocked')?.textContent ?? '', /full price/);

    // The second Enter is the confirmation, and sends.
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'carry on'
    });
    assert.equal(composerValue(p), '');
  });

  it('asks for no confirmation while the cache is still warm', (t) => {
    const p = openThread(t, threadView({ updatedAt: Date.now() - 52 * 60_000 }));
    importComposer(p, 'still cheap');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still cheap'
    });
  });

  it('lets an IME keep the Enter that commits a candidate', (t) => {
    // Typing 你好 ends with Enter to accept the candidate. That keystroke is the
    // composition's, not the composer's, and sending on it cuts the message in
    // half — the box still holds only the raw pinyin.
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'nihao');
    composerKey(p, 'Enter', { isComposing: true, cancelable: false });
    assert.equal(p.posted.at(-1)?.type, 'select', 'the composition’s Enter was sent');
    assert.equal(composerValue(p), 'nihao');

    // Some hosts report the composing keystroke as 229 and leave `isComposing`
    // false; the same key must still belong to the IME.
    composerKey(p, 'Enter', { keyCode: 229, cancelable: false });
    assert.equal(p.posted.at(-1)?.type, 'select', 'a 229 keystroke was sent');

    // Enter after the candidate landed is the reader's own, and sends.
    importComposer(p, '你好');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '你好'
    });
  });

  it('clears the echo when the CLI logged an attached image path with it', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'look at this');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'));

    // The host appends each image's path on a line of its own, so the turn the
    // CLI writes down is the message plus the path — never the text alone.
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({
          status: 'busy',
          exchanges: [
            {
              role: 'user',
              text: 'look at this\n/tmp/shot.png',
              blocks: [{ prose: 'look at this /tmp/shot.png' }]
            }
          ]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
  });

  it('clears the echo of a message Send now renumbered', (t) => {
    // Send now merges the outbox into one turn whose images are a single list,
    // so a marker in anything but the head comes back a number higher. Matched
    // on the number, the echo never settles and doubles the message on screen
    // until the grace runs out.
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'this one [Image #1]');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'));

    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({
          status: 'busy',
          queued: [{ id: 'a+b', text: 'this one [Image #2]', images: 2 }]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
  });

  it('gives up the echo once the session is idle again', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'still there?');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'));

    // A long reply pushes the message out of the transcript window the host
    // reads, so no poll will ever echo it back. Idle plus time says it ran.
    const clock = p.window.Date.now;
    p.window.Date.now = () => clock() + 60_000;
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({ status: 'idle' })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('keeps the echo while the session is still working', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    importComposer(p, 'take your time');
    enter(p);

    const clock = p.window.Date.now;
    p.window.Date.now = () => clock() + 60_000;
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        thread: threadView({ status: 'busy' })
      })
    );
    assert.ok(p.window.document.querySelector('#thread .turn.sending'));
  });

  it('hands a refused message back', (t) => {
    const p = openThread(t, threadView());
    importComposer(p, 'nope?');
    enter(p);
    answerSend(p, { ok: false, reason: 'session is gone' });
    assert.equal(composerValue(p), 'nope?');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');
  });

  it('recovers each session’s refused send after another session sends', (t) => {
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 1_000 }),
          cardView({ pid: 202, startedAt: 2_000 })
        ]
      })
    ];
    const p = openPanel(t);
    const pick = (pid: number): void =>
      p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`)?.click();

    p.push(stateMessage(groups));
    pick(101);
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 1_000 }) }));
    importComposer(p, 'message from A');
    enter(p);

    pick(202);
    p.push(stateMessage(groups, { thread: threadView({ pid: 202, startedAt: 2_000 }) }));
    importComposer(p, 'message from B');
    enter(p);

    const request = p.posted.find(
      (message): message is Extract<WebviewMessage, { type: 'send' }> =>
        message.type === 'send' && message.pid === 101
    );
    assert.ok(request);
    p.push({
      type: 'sendResult',
      pid: request.pid,
      startedAt: request.startedAt,
      operationId: request.operationId,
      ok: false,
      reason: 'A refused'
    });
    pick(101);
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 1_000 }) }));

    assert.equal(composerValue(p), 'message from A');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'A refused');
  });

  it('does not let an inactive send refusal repaint the active loading view', (t) => {
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 1_000 }),
          cardView({ pid: 202, startedAt: 2_000 })
        ]
      })
    ];
    const p = openPanel(t);

    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 1_000 }) }));
    importComposer(p, 'message from A');
    enter(p);

    p.window.document.querySelector<HTMLElement>('.card[data-pid="202"]')?.click();
    assert.equal(p.window.document.querySelector('#thread .empty')?.textContent, 'Loading…');

    const request = p.posted.find(
      (message): message is Extract<WebviewMessage, { type: 'send' }> =>
        message.type === 'send' && message.pid === 101
    );
    assert.ok(request);
    p.push({
      type: 'sendResult',
      pid: request.pid,
      startedAt: request.startedAt,
      operationId: request.operationId,
      ok: false,
      reason: 'A refused'
    });

    assert.equal(p.window.document.querySelector('#thread .empty')?.textContent, 'Loading…');
    assert.equal(composerValue(p), '');
  });

  it('keeps reordered failures independently recoverable', (t) => {
    const p = openThread(t, threadView({ pid: 101, startedAt: 1_000 }));
    importComposer(p, 'first');
    enter(p);
    importComposer(p, 'second');
    enter(p);
    const sends = p.posted.filter(
      (message): message is Extract<WebviewMessage, { type: 'send' }> => message.type === 'send'
    );
    const first = sends[0];
    const second = sends[1];
    assert.ok(first && second);

    p.push({
      type: 'sendResult',
      pid: second.pid,
      startedAt: second.startedAt,
      operationId: second.operationId,
      ok: false,
      reason: 'second refused'
    });
    p.push({
      type: 'sendResult',
      pid: first.pid,
      startedAt: first.startedAt,
      operationId: first.operationId,
      ok: false,
      reason: 'first refused'
    });

    assert.equal(composerValue(p), 'second');
    const failed = p.window.document.querySelector<HTMLElement>('#thread .send-failed');
    assert.match(failed?.textContent ?? '', /first/);
    failed?.querySelector<HTMLButtonElement>('button')?.click();
    assert.match(p.window.document.getElementById('blocked')?.textContent ?? '', /Clear/);

    typeIn(p, '');
    failed?.querySelector<HTMLButtonElement>('button')?.click();
    assert.equal(composerValue(p), 'first');
    assert.equal(p.window.document.querySelector('#thread .send-failed'), null);
  });

  it('settles only one of two identical sends from one transcript turn', (t) => {
    const p = openThread(t, threadView({ status: 'busy', startedAt: 1_000 }));
    importComposer(p, 'same words');
    enter(p);
    importComposer(p, 'same words');
    enter(p);
    const sends = p.posted.filter(
      (message): message is Extract<WebviewMessage, { type: 'send' }> => message.type === 'send'
    );
    assert.equal(sends.length, 2);

    const settled = stateMessage([groupView({ sessions: [cardView({ startedAt: 1_000 })] })], {
      thread: threadView({
        status: 'busy',
        startedAt: 1_000,
        exchanges: [{ role: 'user', text: 'same words', blocks: [{ prose: 'same words' }] }]
      })
    });
    p.push(settled);
    assert.equal(p.window.document.querySelectorAll('#thread .turn.sending').length, 1);
    p.push(settled);
    assert.equal(
      p.window.document.querySelectorAll('#thread .turn.sending').length,
      1,
      'an unchanged poll claimed the same transcript turn twice'
    );

    const second = sends[1];
    assert.ok(second);
    p.push({
      type: 'sendResult',
      pid: second.pid,
      startedAt: second.startedAt,
      operationId: second.operationId,
      ok: false,
      reason: 'second refused'
    });
    assert.equal(composerValue(p), 'same words');
  });

  it('does not settle a fresh send against an identical historical turn', (t) => {
    const historical = {
      role: 'user' as const,
      text: 'same words',
      blocks: [{ prose: 'same words' }]
    };
    const p = openThread(
      t,
      threadView({ status: 'busy', startedAt: 1_000, exchanges: [historical] })
    );
    importComposer(p, 'same words');
    enter(p);

    const groups = [groupView({ sessions: [cardView({ startedAt: 1_000 })] })];
    p.push(
      stateMessage(groups, {
        thread: threadView({
          status: 'busy',
          startedAt: 1_000,
          exchanges: [historical]
        })
      })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn.sending').length, 1);

    p.push(
      stateMessage(groups, {
        thread: threadView({
          status: 'busy',
          startedAt: 1_000,
          exchanges: [historical, historical]
        })
      })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn.sending').length, 0);
  });

  it('restores a refused send after its historical twin was observed while inactive', (t) => {
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 1_000 }),
          cardView({ pid: 202, startedAt: 2_000 })
        ]
      })
    ];
    const historical = {
      role: 'user' as const,
      text: 'same words',
      blocks: [{ prose: 'same words' }]
    };
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 202, startedAt: 2_000, exchanges: [historical] })
      })
    );

    p.window.document.querySelector<HTMLElement>('.card[data-pid="202"]')?.click();
    importComposer(p, 'same words');
    enter(p);
    const request = p.posted.at(-1);
    assert.ok(request?.type === 'send');
    p.push({
      type: 'sendResult',
      pid: request.pid,
      startedAt: request.startedAt,
      operationId: request.operationId,
      ok: false,
      reason: 'refused'
    });

    assert.equal(composerValue(p), 'same words');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'refused');
  });

  /**
   * A refused send, and a card whose start is pinned.
   *
   * Pinned because `sweepRecycled` reads `startedAt` and `cardView` defaults it
   * to `Date.now()`: a fixture that rebuilds the card between two pushes is a
   * recycled pid as far as the panel is concerned, and these scenarios would
   * then pass or fail on the sweep rather than on what they are named for. The
   * one below that *wants* the sweep says so by moving the number.
   */
  const REFUSED = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];

  const refusedSend = (t: TestContext): Panel => {
    const p = openPanel(t);
    p.push(stateMessage(REFUSED));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(REFUSED, { thread: threadView({ startedAt: 5_000 }) }));
    importComposer(p, 'nope?');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'nope?'
    });
    answerSend(p, { ok: false, reason: 'session is gone' });
    assert.equal(composerValue(p), 'nope?', 'the refusal should have handed the text back');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');
    return p;
  };

  /**
   * The refusal has to outlive the push behind it, and on the path that raised
   * this bug the push is not a poll away — a promoted draft's first turn is
   * refused while `revealSession`'s own `refresh` is still in flight, so the
   * state message lands a beat later and `renderThread` rewrites the line from
   * `canSend`. Held on the session so a later push does not wipe it, and
   * cleared on the same acts.
   */
  it('keeps a refusal on screen through the push that follows it', (t) => {
    const p = refusedSend(t);
    // The thread has to *move*, or the push is a repaint that never happens and
    // the line survives for the wrong reason. In production it always does: the
    // push behind this refusal is the one carrying the session that just
    // started.
    p.push(stateMessage(REFUSED, { thread: threadView({ startedAt: 5_000, status: 'busy' }) }));
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');
  });

  it('clears the refusal when the reader has another go', (t) => {
    const p = refusedSend(t);
    enter(p);
    assert.equal(p.window.document.getElementById('blocked')?.textContent, '');
  });

  it('forgets a recycled pid’s refusal, so the next session does not wear it', (t) => {
    // The same reading `sweepRecycled` already takes for drafts and mentions: a
    // different `startedAt` under one number is the process table handing the
    // pid on, not a session that went quiet.
    const p = refusedSend(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 20_000 })] })], {
        thread: threadView({ startedAt: 20_000 })
      })
    );
    assert.equal(p.window.document.getElementById('blocked')?.textContent, '');
  });

  it('does not carry typed text into a recycled pid', (t) => {
    const p = openThread(t, threadView({ pid: 101, startedAt: 1_000 }));
    typeIn(p, 'for the old process');

    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 20_000 })] })], {
        thread: threadView({ pid: 101, startedAt: 20_000 })
      })
    );
    assert.equal(composerValue(p), '');
    enter(p);
    assert.equal(p.posted.filter((message) => message.type === 'send').length, 0);
  });

  it('keeps a refusal raised for a card the reader had not yet picked', (t) => {
    // A promoted draft's first turn is sent whether or not the reader stayed on
    // it, so the refusal can be held for a pid nothing is selected on. The click
    // that finally brings that card up is the one that has to *show* the
    // sentence, not the one that throws it away.
    const p = openPanel(t);
    p.push(stateMessage(REFUSED));
    p.push({ type: 'sendResult', pid: 101, ok: false, reason: 'session is gone' });
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(REFUSED, { thread: threadView({ startedAt: 5_000 }) }));
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');
  });

  it('lets the cold-cache warning replace a held refusal, not the other way round', (t) => {
    // The confirming press is the one that spends real money, so the note it
    // asks for may not be repainted over by the sentence from the send before
    // it. The refusal is pushed rather than provoked: on a thread this cold the
    // first Enter would be the warning itself, and never reach a send to refuse.
    const cold = threadView({ startedAt: 5_000, updatedAt: Date.now() - 70 * 60_000 });
    const p = openPanel(t);
    p.push(stateMessage(REFUSED));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(REFUSED, { thread: cold }));
    p.push({ type: 'sendResult', pid: 101, ok: false, reason: 'session is gone' });
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');

    importComposer(p, 'another go');
    enter(p);
    assert.notEqual(p.posted.at(-1)?.type, 'send', 'a cold-cache send went unconfirmed');
    assert.match(p.window.document.getElementById('blocked')?.textContent ?? '', /full price/);
    p.push(stateMessage(REFUSED, { thread: cold }));
    assert.match(
      p.window.document.getElementById('blocked')?.textContent ?? '',
      /full price/,
      'the stale refusal was repainted over the warning'
    );
  });

  it('yields a held refusal to the session’s own reason once it has ended', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(REFUSED));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(REFUSED, { thread: threadView({ startedAt: 5_000 }) }));
    p.push({ type: 'sendResult', pid: 101, ok: false, reason: 'session is gone' });
    p.push(
      stateMessage(REFUSED, {
        thread: threadView({
          startedAt: 5_000,
          canSend: false,
          ended: true,
          blockedReason: 'Ended — nothing to send to'
        })
      })
    );
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'Ended — nothing to send to'
    );
  });

  /**
   * The other unsendable session, and it goes the other way.
   *
   * A session no window here can reach is `canSend: false` from the moment it
   * is drawn, so its `blockedReason` was already on the line before the reader
   * clicked anything — which makes it the one sentence that cannot report a
   * click. Refusing on it is the whole signal that Interrupt landed, and
   * `abd05438` is the fix that put it there. Yielding on `canSend` alone took
   * it back out: unroutable is exactly the case that flag cannot separate from
   * ended.
   */
  it('holds a refusal on a session that cannot be reached, which has not ended', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(REFUSED));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    const unreachable = unreachableThread({
      pid: 101,
      startedAt: 5_000,
      blockedReason: 'No window is publishing a way in, so nothing here can reach it.'
    });
    p.push(stateMessage(REFUSED, { thread: unreachable }));
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'No window is publishing a way in, so nothing here can reach it.',
      'the fixture should start on the session’s own reason'
    );
    p.push({
      type: 'sendResult',
      pid: 101,
      ok: false,
      reason: 'That session is not one this window can write to.'
    });
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'That session is not one this window can write to.'
    );
    // And it survives the push behind it, as every other held refusal does.
    p.push(stateMessage(REFUSED, { thread: unreachable }));
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'That session is not one this window can write to.'
    );
  });

  /**
   * Interrupt, rename and dismiss have no draft to restore, so the channel
   * they share with `send` is just `#blocked`.
   */
  it('shows an unrouted refusal in the composer with no draft to restore', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'busy' }));
    p.push({
      type: 'sendResult',
      pid: 101,
      ok: false,
      reason: 'That session is not one this window can write to.'
    });
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'That session is not one this window can write to.'
    );
    assert.equal(composerValue(p), '');
  });

  it('disables input when sending is unavailable', (t) => {
    const p = openThread(t, threadView({ canSend: false, blockedReason: 'not interactive' }));
    assert.equal(composerDisabled(p), true);
    assert.equal(composerPlaceholder(p), 'Sending is unavailable');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'not interactive');
  });

  /**
   * The send button beside the hint. Enter is still the way most messages go,
   * so every scenario here is really asking whether the pointer reaches the
   * same place the keystroke does.
   */
  const send = (p: Panel): HTMLButtonElement =>
    p.window.document.getElementById('send') as HTMLButtonElement;
  const keys = (p: Panel): string =>
    p.window.document.querySelector('.hintkeys')?.textContent ?? '';
  /** Lucide arrow-up, the only thing the button holds. */
  const ARROW = ['m5 12 7-7 7 7', 'M12 19V5'];

  it('sends what the box holds when the button is pressed', (t) => {
    const p = openThread(t, threadView());
    typeIn(p, 'ship it');
    send(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'ship it'
    });
    assert.equal(composerValue(p), '');
    // The box it emptied has nothing left to send, so the button says so
    // without waiting for the push that answers.
    assert.equal(send(p).disabled, true);
  });

  it('makes the first press a warning when the prompt cache has expired', (t) => {
    // The same confirmation Enter asks for, through the other way in — and the
    // one press here that deliberately posts nothing, so the button has to
    // stay pressable for the press that follows it.
    const p = openThread(t, threadView({ updatedAt: Date.now() - 70 * 60_000 }));
    typeIn(p, 'carry on');
    send(p).click();
    assert.notEqual(p.posted.at(-1)?.type, 'send', 'a cold-cache send went unconfirmed');
    assert.match(p.window.document.getElementById('blocked')?.textContent ?? '', /full price/);
    assert.equal(send(p).disabled, false, 'nothing left to confirm with');

    send(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'carry on'
    });
  });

  it('has nothing to press until there is something to send', (t) => {
    const p = openThread(t, threadView());
    assert.equal(send(p).disabled, true);
    typeIn(p, 'ship it');
    assert.equal(send(p).disabled, false);
    typeIn(p, '   ');
    assert.equal(send(p).disabled, true);
  });

  it('refuses a press that got through an empty box', (t) => {
    const p = openThread(t, threadView());
    const before = p.posted.length;
    send(p).click();
    assert.equal(p.posted.length, before);
  });

  it('says Queue while Enter would queue', (t) => {
    // No protocol field changed. The verb is the accessible name; the button
    // holds the arrow and no word, and the hint is that same name.
    const p = openThread(t, threadView({ status: 'busy' }));
    assert.equal(send(p).getAttribute('aria-label'), 'Queue');
    assert.equal(send(p).textContent, '');
    assert.deepEqual(
      [...send(p).querySelectorAll('path')].map((path) => path.getAttribute('d')),
      ARROW
    );
    assert.match(keys(p), /queue · ⇧↵ newline/);
    assert.equal(send(p).classList.contains('queues'), true);
    const glyph = send(p).querySelector('svg');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({ status: 'idle' })
      })
    );
    assert.equal(send(p).getAttribute('aria-label'), 'Send');
    assert.equal(send(p).textContent, '');
    assert.match(keys(p), /send · ⇧↵ newline/);
    assert.equal(send(p).classList.contains('queues'), false);
    // A press that straddles a repaint must land on the node it started on.
    assert.equal(send(p).querySelector('svg'), glyph, 'the repaint replaced the arrow');
  });

  it('says Send while the only thing held is our own drain', (t) => {
    // An idle session with a full outbox is one we are mid-write to, not one
    // sitting on the reader's message: `statusOf` and `canDrain` agree. Enter
    // would not queue behind an agent, so the button must not say it does.
    const p = openThread(
      t,
      threadView({ status: 'idle', queued: [{ id: 'q1', text: 'ship it' }] })
    );
    assert.equal(send(p).getAttribute('aria-label'), 'Send');
    assert.equal(send(p).textContent, '');
    assert.match(keys(p), /send · ⇧↵ newline/);
    assert.equal(send(p).classList.contains('queues'), false);
    assert.equal(
      (p.window.document.querySelector('.shell') as HTMLElement).classList.contains('queues'),
      false,
      'and the box does not go amber either'
    );
  });

  it('amber runs to the box the message is being typed into', (t) => {
    const p = openThread(t, threadView({ status: 'busy' }));
    const shell = () => p.window.document.querySelector('.shell') as HTMLElement;
    assert.equal(shell().classList.contains('queues'), true);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({ status: 'idle' })
      })
    );
    assert.equal(shell().classList.contains('queues'), false);
  });

  it('cannot be pressed when sending is unavailable', (t) => {
    const p = openThread(t, threadView({ canSend: false, blockedReason: 'not interactive' }));
    typeIn(p, 'hello?');
    assert.equal(send(p).disabled, true);
  });

  it('does not carry a blocked session’s refusal onto the next one picked', (t) => {
    // A card click repaints the composer a round trip before the push that
    // answers it, so for that beat the only `canSend` in hand is the session
    // just left. Read as this one's, a blocked session left behind it a box
    // that could not be typed into and a button that could not be pressed —
    // for no reason the reader could see, since the notice went with it.
    const groups = [groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    const card = (pid: number): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);

    card(202)?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 202, canSend: false, blockedReason: 'not interactive' })
      })
    );
    assert.equal(composerDisabled(p), true, 'the blocked session was not blocked');

    card(101)?.click();
    assert.equal(composerDisabled(p), false, 'the refusal followed the pick');
    typeIn(p, 'ship it');
    assert.equal(send(p).disabled, false, 'the button read the other session’s canSend');
    send(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'ship it'
    });
  });

  it('keeps a draft per session', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1 }), cardView({ pid: 2 })] })]));
    const cards = p.window.document.querySelectorAll<HTMLElement>('.card');
    cards[0]?.click();
    importComposer(p, 'draft for one');
    p.window.document.querySelectorAll<HTMLElement>('.card')[1]?.click();
    assert.equal(composerValue(p), '');
    p.window.document.querySelectorAll<HTMLElement>('.card')[0]?.click();
    assert.equal(composerValue(p), 'draft for one');
  });
});

/**
 * The input area: one line at rest, the permission mode in the tool row, and
 * no status line. No protocol field changed — `ThreadView.mode` and
 * `ThreadView.branch` already exist.
 */
describe('the composer input area', () => {
  const BRANCH = 'feature/kettle-9f3';
  const mode = { label: 'plan', holds: true, bypass: false };
  const plain = {
    value: 'opus',
    name: 'Opus 5',
    id: 'opus',
    brand: 'claude' as const,
    window: 200_000
  };
  const withEffort = { ...plain, efforts: [{ value: 'low' }, { value: 'medium' }] };

  const paint = (p: Panel, thread: ThreadView, models: ModelView[]): void => {
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ pid: thread.pid, startedAt: thread.startedAt })] })],
        { thread, models }
      )
    );
  };
  const tools = (p: Panel): HTMLElement =>
    p.window.document.getElementById('ctools') as HTMLElement;
  const modeEl = (p: Panel): HTMLElement | null => tools(p).querySelector('.mode');
  const wrap = (p: Panel, selector: string): Element | null =>
    tools(p).querySelector(selector)?.closest('.fwrap') ?? null;

  it('puts the permission mode after the model, then after effort once effort attaches', (t) => {
    const thread = threadView({ model: 'opus', mode, branch: BRANCH });
    const p = openThread(t, thread, { models: [plain] });
    assert.equal(p.window.document.getElementById('cstatus'), null);
    const shown = modeEl(p);
    assert.ok(shown);
    assert.equal(shown.tagName, 'SPAN');
    assert.equal(shown.querySelector('button'), null);
    assert.equal(shown.querySelector('.g')?.textContent, '⏸');
    assert.match(shown.textContent ?? '', /plan/);
    assert.equal(
      shown.getAttribute('data-tip'),
      'permission mode: plan · as its transcript last stated it.'
    );
    assert.equal(tools(p).querySelector('.fpill.effort'), null);
    assert.equal(wrap(p, '.fpill.model')?.nextElementSibling, shown);

    // The paint that first attaches the effort pill. The span is the same
    // node, so a tip hovering it survives the paint.
    paint(p, thread, [withEffort]);
    assert.equal(wrap(p, '.fpill.effort')?.nextElementSibling, modeEl(p));
    assert.equal(modeEl(p), shown, 'the repaint replaced the mode');

    // Effort leaves. The mode stays, and it does not move ahead of the model.
    paint(p, thread, [plain]);
    assert.ok(modeEl(p));
    assert.equal(tools(p).querySelector('.fpill.effort'), null);
    assert.equal(wrap(p, '.fpill.model')?.nextElementSibling, modeEl(p));
  });

  it('caps the box at ten lines, rows the empty hint, and does not stretch Send', () => {
    const sheet = panelStylesheet()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/:is\((#[\w-]+), \.[\w-]+\)/g, '$1');
    const input = sheet.match(/#input \{([^}]*)\}/)?.[1] ?? '';
    assert.match(input, /max-height:\s*calc\(10lh\)/);
    const root = sheet.match(/#input \.ProseMirror \{([^}]*)\}/)?.[1] ?? '';
    assert.match(root, /min-height:\s*1lh/);
    const ghost = sheet.match(/#input\.empty ~ \.hintghost \{([^}]*)\}/)?.[1] ?? '';
    assert.match(ghost, /flex-direction:\s*row/);
    assert.match(ghost, /align-items:\s*baseline/);
    assert.match(ghost, /justify-content:\s*space-between/);
    assert.match(ghost, /gap:\s*8px/);
    const narrow = sheet.match(/@container chat \(max-width: 279px\) \{([^]*?)\n {2}\}/)?.[1] ?? '';
    assert.match(narrow, /#hintrow/);
    assert.match(narrow, /#ctools/);
    assert.doesNotMatch(narrow, /#send/);
  });
});

/**
 * The dock's lineage block: the one place a family that spans two groups is
 * listed whole, since a container only ever covers one.
 */

/**
 * A `/rename` the reader types. The head's field above posts the same message;
 * this is the box, which used to send the slash through as a turn.
 */
describe('a typed /rename', () => {
  const renameBox = (p: Panel): HTMLInputElement =>
    p.window.document.getElementById('chat-rename') as HTMLInputElement;
  const posted = (p: Panel, type: string): boolean => p.posted.some((m) => m.type === type);

  it('posts rename for /rename Checkout modal, posts no send, and clears the box', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    importComposer(p, '/rename   Checkout   modal');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'rename',
      pid: 42,
      title: 'Checkout modal'
    });
    assert.equal(posted(p, 'send'), false);
    assert.equal(composerValue(p), '');
  });

  it('renames a busy session at once, and queues nothing', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39', status: 'busy' }));
    importComposer(p, '/rename Checkout modal');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'rename',
      pid: 42,
      title: 'Checkout modal'
    });
    assert.equal(posted(p, 'send'), false);
    assert.equal(p.window.document.querySelector('#thread .turn.queued'), null);
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    assert.equal(composerValue(p), '');
  });

  it('opens the name field for a bare /rename and posts nothing', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    importComposer(p, '/rename');
    enter(p);
    assert.equal(renameBox(p).hidden, false);
    assert.equal(renameBox(p).value, 'agent-39');
    assert.equal(posted(p, 'rename'), false);
    assert.equal(posted(p, 'send'), false);
    assert.equal(composerValue(p), '');
  });

  it('keeps the name field open when Send is clicked on a bare /rename', (t) => {
    // Enter leaves the field focused. Send used to focus the composer after
    // submit, and that blur closed the field the click had just opened.
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    typeIn(p, '/rename');
    (p.window.document.getElementById('send') as HTMLButtonElement).click();
    assert.equal(renameBox(p).hidden, false);
    assert.equal(renameBox(p).value, 'agent-39');
    assert.equal(posted(p, 'rename'), false);
    assert.equal(posted(p, 'send'), false);
    assert.equal(composerValue(p), '');
  });

  it('sends /rename x unchanged when an image or a workflow mention is attached', async (t) => {
    const withImage = openThread(t, threadView({ pid: 42 }));
    // Typed first: typing replaces the box, and the image is a chip in it.
    typeIn(withImage, '/rename x ');
    pasteComposer(withImage, { files: [{ name: 'shot.png', type: 'image/png' }] });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    enter(withImage);
    const sentImage = assertedMessageBody(withImage.posted.at(-1)) as {
      type: string;
      text: string;
    };
    assert.equal(sentImage.type, 'send');
    assert.match(sentImage.text, /\/rename x/);
    assert.equal(posted(withImage, 'rename'), false);

    const groups = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];
    const workflows = [workflowView({ id: 'ship', label: 'plan→build→review' })];
    const mentioned = openPanel(t);
    mentioned.push(stateMessage(groups, { workflows }));
    mentioned.window.document.querySelector<HTMLElement>('.card')?.click();
    mentioned.push(stateMessage(groups, { thread: threadView({ startedAt: 5_000 }), workflows }));
    attachWorkflow(mentioned, 'plan→build→review');
    typeIn(mentioned, '/rename x');
    enter(mentioned);
    assert.deepEqual(assertedMessageBody(mentioned.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '/rename x',
      workflowId: 'ship'
    });
    assert.equal(posted(mentioned, 'rename'), false);
  });

  it('sends /renamed x and /clear the table unchanged', (t) => {
    const p = openThread(t, threadView({ pid: 42 }));
    importComposer(p, '/renamed x');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 42,
      text: '/renamed x'
    });
    importComposer(p, '/clear the table');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 42,
      text: '/clear the table'
    });
  });

  it('posts nothing for a blank title or the name the session already has', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    importComposer(p, '/rename agent-39');
    enter(p);
    assert.equal(posted(p, 'rename'), false);
    assert.equal(posted(p, 'send'), false);
    assert.equal(composerValue(p), '');
    assert.equal(renameBox(p).hidden, true);

    importComposer(p, '/rename');
    enter(p);
    renameBox(p).value = '   ';
    renameBox(p).dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    assert.equal(posted(p, 'rename'), false);
    assert.equal(posted(p, 'send'), false);
  });

  it('refuses /rename on a draft, shows a note, and posts nothing', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [] })]));
    newDraft(p);
    typeIn(p, '/rename probe-first');
    enter(p);
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'Rename it after the session starts.'
    );
    assert.equal(posted(p, 'open'), false);
    assert.equal(posted(p, 'send'), false);
    assert.equal(posted(p, 'rename'), false);
    assert.equal(composerValue(p), '/rename probe-first');
  });
});

/**
 * The composer as the prose editor (`webview/prose.ts`), for what changes
 * meaning when it stops being a textarea: a mention is a chip where a short
 * token was, the delivery is the expansion, Enter and Shift+Enter differ inside
 * a list, and no Undo history crosses an owner, a send or a refused send's
 * restore (`TASK_done_prose_input.md`, Step 13).
 *
 * Each case asks for the editor first, so on a textarea build it fails on that
 * and not on an Undo that a textarea quietly ignores.
 */
describe('the composer is one editor', () => {
  const box = (p: Panel): ProseBox => proseOf(p.window.document.getElementById('input'));

  /** jsdom's navigator names no Mac, so ProseMirror's `Mod` is Control here. */
  const undo = (p: Panel): void => {
    composerKey(p, 'z', { ctrlKey: true });
  };

  const sentText = (p: Panel): string => {
    const send = [...p.posted].reverse().find((m) => m.type === 'send');
    assert.ok(send?.type === 'send', 'nothing posted a send');
    return send.text;
  };

  const drainPaste = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  };

  const ref = '@squadron[6085][/t/d6913539.jsonl]';

  it('sends on Enter inside a list, where Shift+Enter is the next item', (t) => {
    const p = openThread(t, threadView());
    box(p);
    typeIn(p, '- one');
    composerKey(p, 'Enter', { shiftKey: true });
    box(p).type('two');
    assert.equal(composerValue(p), '- one\n- two');
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 0, 'Shift+Enter sent');
    enter(p);
    assert.equal(sentText(p), '- one\n- two');
  });

  it('keeps each owner its own history: A, then B, then Undo reaches nothing of A', (t) => {
    const a = cardView({ pid: 101, startedAt: 1_000 });
    const b = cardView({ pid: 202, startedAt: 2_000 });
    const p = openPanel(t);
    const groups = [groupView({ sessions: [a, b] })];
    p.push(stateMessage(groups));
    const card = (pid: number): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);
    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 1_000 }) }));
    box(p);
    typeIn(p, 'alpha');
    card(202)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 202, startedAt: 2_000 }) }));
    assert.equal(composerValue(p), '');
    undo(p);
    assert.equal(composerValue(p), '', "Undo in B brought back A's words");
    typeIn(p, 'beta');
    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 1_000 }) }));
    assert.equal(composerValue(p), 'alpha');
    undo(p);
    assert.equal(composerValue(p), 'alpha', 'Undo reached back past the owner change');
  });

  it('starts a fresh history at a send: Undo does not bring an image back', async (t) => {
    const p = openThread(t, threadView());
    box(p);
    typeIn(p, 'look');
    pasteComposer(p, { files: [{ name: 'shot.png', type: 'image/png' }] });
    await drainPaste();
    assert.deepEqual(
      composerPills(p).map((chip) => chip.textContent),
      ['[Image #1]']
    );
    enter(p);
    assert.equal(sentText(p), 'look [Image #1]');
    assert.equal(composerValue(p), '');
    undo(p);
    assert.equal(composerValue(p), '', 'Undo after the send revived the box');
    assert.equal(composerPills(p).length, 0, 'Undo after the send revived the image');
  });

  it('takes a plain paste literally, and a rich list as a list', (t) => {
    const p = openThread(t, threadView());
    box(p);
    pasteComposer(p, { text: 'a\n\n\n**b**' });
    assert.equal(composerValue(p), 'a\n\n\n**b**');
    typeIn(p, '');
    pasteComposer(p, { text: 'one\ntwo', html: '<ul><li><p>one</p></li><li><p>two</p></li></ul>' });
    assert.equal(composerValue(p), '- one\n- two');
    enter(p);
    assert.equal(sentText(p), '- one\n- two');
  });

  it('starts a fresh history when the chat is left for New and opened again', async (t) => {
    // Leaving prunes the pool to what the document names: an Undo that could
    // still reach a deleted image chip would bring it back with no bytes.
    const p = openThread(t, threadView());
    box(p);
    typeIn(p, 'look');
    pasteComposer(p, { files: [{ name: 'shot.png', type: 'image/png' }] });
    await drainPaste();
    selectComposer(p, 'look [Image #1]'.length);
    composerKey(p, 'Backspace', { cancelable: false });
    assert.equal(composerPills(p).length, 0);
    newDraft(p);
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage([groupView({ sessions: [cardView()] })], { thread: threadView() }));
    undo(p);
    assert.equal(composerPills(p).length, 0, 'Undo brought back an image whose bytes are gone');
  });

  it('keeps a file picked while a push had locked the box', (t) => {
    const thread = threadView();
    const p = openThread(t, thread);
    const groups = [
      groupView({ sessions: [cardView({ pid: thread.pid, startedAt: thread.startedAt })] })
    ];
    box(p);
    typeIn(p, 'see');
    p.window.document.getElementById('fattach')?.click();
    p.push(stateMessage(groups, { thread: threadView({ canSend: false }) }));
    answerFilePick(p, ['/tmp/x.ts']);
    p.push(stateMessage(groups, { thread }));
    enter(p);
    assert.equal(sentText(p), 'see /tmp/x.ts');
  });

  it('leaves an IME’s Enter to the IME, though the editor saw no composition start', (t) => {
    const p = openThread(t, threadView());
    box(p);
    typeIn(p, 'hi');
    for (const mods of [{ isComposing: true }, { keyCode: 229 }]) {
      const e = composerKey(p, 'Enter', mods);
      assert.equal(e.defaultPrevented, false, 'the composing Enter was taken from the IME');
      assert.equal(box(p).snapshot().content?.length, 1, 'the composing Enter split the line');
    }
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 0);
  });

  it('keeps a draft its history when it becomes the session it started', (t) => {
    // Promotion is the same box taking its session's key, not another owner.
    const cwd = '/Users/someone/proj';
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd, sessions: [] })]));
    sendDraft(p, 'start me', cwd);
    const draftId = lastOpen(p).draftId;
    assert.ok(draftId);
    p.push({
      type: 'openResult',
      draftId,
      outcome: 'stopped',
      notice: 'That session did not start.'
    });
    typeIn(p, 'later');
    p.window.document.querySelector<HTMLElement>('[data-act="retry-held"]')?.click();
    answerOpen(p, 9, 9_000);
    assert.equal(composerValue(p), 'later');
    undo(p);
    assert.equal(composerValue(p), '', 'the promotion started a fresh history');
  });

  it('draws a session chip under its card’s new name after a rename', (t) => {
    const thread = threadView();
    const p = openThread(t, thread);
    const board = (name: string): GroupView[] => [
      groupView({
        sessions: [
          cardView({ pid: thread.pid, startedAt: thread.startedAt }),
          cardView({ pid: 6085, name })
        ]
      })
    ];
    p.push(stateMessage(board('Lane rules'), { thread }));
    typeIn(p, `ask ${ref}`);
    assert.deepEqual(
      composerPills(p).map((chip) => chip.textContent),
      ['@Lane rules']
    );
    p.push(stateMessage(board('Lane laws'), { thread }));
    assert.deepEqual(
      composerPills(p).map((chip) => chip.textContent),
      ['@Lane laws']
    );
  });

  it('restores a refused send with a fresh history, chip and all', (t) => {
    const p = openThread(t, threadView());
    box(p);
    typeIn(p, 'draft one');
    typeIn(p, `see ${ref}`);
    enter(p);
    assert.equal(composerValue(p), '');
    answerSend(p, { ok: false, reason: 'session is gone' });
    assert.equal(composerValue(p), `see ${ref}`);
    assert.equal(composerPills(p).length, 1, 'the restore lost the chip');
    undo(p);
    assert.equal(composerValue(p), `see ${ref}`, 'Undo reached back past the restore');
  });
});

describe('the composer for a session it cannot write to', () => {
  /**
   * The dock's half of a session this window cannot write to. The box stays and
   * is disabled — there is nowhere else to send the reader, unlike the shell
   * this used to swap the composer out for (row 53).
   */
  it('disables the box for a session it cannot write to, and says why', (t) => {
    const p = openThread(t, unreachableThread());
    const doc = p.window.document;
    const shown = (id: string) =>
      p.window.getComputedStyle(doc.getElementById(id) as Element).display !== 'none';
    assert.equal(shown('input'), true);
    assert.equal(composerDisabled(p), true);
    assert.ok(doc.getElementById('hintrow')?.contains(doc.getElementById('send')));
  });

  it('leaves the composer alone for a session the panel drives', (t) => {
    const p = openThread(t, threadView());
    const doc = p.window.document;
    assert.equal(
      p.window.getComputedStyle(doc.getElementById('input') as Element).display !== 'none',
      true
    );
    assert.equal(composerDisabled(p), false);
  });
});

/**
 * The formatting toolbar over the composer's editor
 * (`TASK_done_composer_formatting.md`, the approved mock). It edits the
 * box's document like typing does, and tells the host nothing by itself.
 */
describe('the composer formatting toolbar', () => {
  const LABELS = [
    'Bold',
    'Italic',
    'Strikethrough',
    'Bullet list',
    'Numbered list',
    'Blockquote',
    'Inline code',
    'Code block'
  ];
  const bar = (p: Panel): HTMLElement => {
    const node = p.window.document.getElementById('formatbar');
    assert.ok(node, 'no formatting toolbar');
    return node;
  };
  const buttons = (p: Panel): HTMLButtonElement[] => [...bar(p).querySelectorAll('button')];
  const off = (button: HTMLElement): boolean => button.getAttribute('aria-disabled') === 'true';
  const sent = (p: Panel): unknown => {
    const send = p.posted.filter((m) => m.type === 'send').at(-1);
    return send?.type === 'send' ? send.text : undefined;
  };

  it('offers eight controls in three groups, above the text, as one tab stop', (t) => {
    const p = openThread(t, threadView());
    assert.equal(bar(p).getAttribute('role'), 'toolbar');
    assert.equal(bar(p).getAttribute('aria-label'), 'Text formatting');
    assert.deepEqual(
      buttons(p).map((b) => b.getAttribute('aria-label')),
      LABELS
    );
    const groups = [...bar(p).querySelectorAll('.formatgroup')].map((group) =>
      [...group.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
    );
    assert.deepEqual(groups, [LABELS.slice(0, 3), LABELS.slice(3, 6), LABELS.slice(6)]);
    assert.deepEqual(
      buttons(p).map((b) => b.tabIndex),
      [0, -1, -1, -1, -1, -1, -1, -1]
    );
    const doc = p.window.document;
    assert.equal(bar(p).parentElement, doc.querySelector('.shell'));
    const input = doc.getElementById('input')!;
    assert.ok(bar(p).compareDocumentPosition(input) & p.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(doc.querySelector('#hintrow #ctools #fattach'), 'the attach control kept its row');
    assert.ok(doc.querySelector('#hintrow #send'), 'Send kept its row');
  });

  it('Bold applies to the selection, reads pressed, and is what the send carries', (t) => {
    const p = openThread(t, threadView());
    importComposer(p, 'alpha');
    composerProse(p).select(1, 6);
    const posted = p.posted.length;
    formatButton(p, 'bold').click();
    assert.equal(p.posted.length, posted, 'formatting posts nothing');
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'true');
    enter(p);
    assert.equal(sent(p), '**alpha**');
  });

  it('Code block over four lines, one empty, sends one fence of four lines', (t) => {
    const p = openThread(t, threadView());
    const box = composerProse(p);
    box.restore(FOUR_LINES, { history: 'fresh' });
    box.select(1, 21);
    formatButton(p, 'codeBlock').click();
    assert.equal(formatButton(p, 'codeBlock').getAttribute('aria-pressed'), 'true');
    enter(p);
    assert.equal(sent(p), '```\nalpha\nbeta\n\ngamma\n```');
  });

  it('follows the caret, and a move posts nothing', (t) => {
    const p = openThread(t, threadView());
    importComposer(p, '**bold** plain');
    const posted = p.posted.length;
    composerProse(p).select(2);
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'true');
    composerProse(p).select(8);
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'false');
    assert.equal(p.posted.length, posted);
  });

  it('an empty box can take a mark for what is typed next, though Send cannot', (t) => {
    const p = openThread(t, threadView());
    assert.equal((p.window.document.getElementById('send') as HTMLButtonElement).disabled, true);
    assert.equal(off(formatButton(p, 'bold')), false);
    formatButton(p, 'bold').click();
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'true');
    composerProse(p).type('x');
    assert.equal(composerValue(p), '**x**');
  });

  it('refuses a code block over a chip, says why, and leaves the rest on', (t) => {
    const p = openThread(t, threadView());
    const box = composerProse(p);
    box.type('Read ');
    box.insertChip('file', '/tmp/my_file.ts');
    box.select(1);
    const code = formatButton(p, 'codeBlock');
    assert.equal(off(code), true);
    assert.match(code.dataset.tip ?? '', /mention or attachment/);
    const before = box.snapshot();
    code.click();
    assert.deepEqual(box.snapshot(), before);
    assert.equal(off(formatButton(p, 'bold')), false);
  });

  it('a box that cannot send cannot be formatted', (t) => {
    const p = openThread(t, threadView({ canSend: false, blockedReason: 'not interactive' }));
    assert.deepEqual(
      buttons(p).map(off),
      LABELS.map(() => true)
    );
  });

  it("follows the selected session's box", (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    const card = (pid: number): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);
    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101 }) }));
    importComposer(p, 'alpha');
    composerProse(p).select(1, 6);
    formatButton(p, 'bold').click();
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'true');

    card(202)?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 202, canSend: false, blockedReason: 'not interactive' })
      })
    );
    assert.equal(formatButton(p, 'bold').getAttribute('aria-pressed'), 'false');
    assert.equal(off(formatButton(p, 'bold')), true);

    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101 }) }));
    assert.equal(off(formatButton(p, 'bold')), false);
    assert.equal(composerValue(p), '**alpha**', 'the styled text was kept as the edit it is');
  });

  it('arrows, Home and End move along the bar; a keyed press returns to the text', (t) => {
    const p = openThread(t, threadView());
    const doc = p.window.document;
    const press = (key: string): void => {
      doc.activeElement?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    };
    formatButton(p, 'bold').focus();
    press('ArrowRight');
    assert.equal(doc.activeElement, formatButton(p, 'italic'));
    assert.deepEqual(
      buttons(p).map((b) => b.tabIndex),
      [-1, 0, -1, -1, -1, -1, -1, -1]
    );
    press('End');
    assert.equal(doc.activeElement, formatButton(p, 'codeBlock'));
    press('ArrowRight');
    assert.equal(doc.activeElement, formatButton(p, 'bold'), 'wraps');
    press('ArrowLeft');
    assert.equal(doc.activeElement, formatButton(p, 'codeBlock'));
    press('Home');
    assert.equal(doc.activeElement, formatButton(p, 'bold'));

    // A keyboard's click has no pointer behind it: detail 0.
    formatButton(p, 'italic').dispatchEvent(
      new p.window.MouseEvent('click', { bubbles: true, detail: 0 })
    );
    assert.ok(doc.getElementById('input')?.contains(doc.activeElement), 'focus is back in the box');
  });

  it('a press keeps the selection in the text', (t) => {
    const p = openThread(t, threadView());
    const down = new p.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    formatButton(p, 'bold').dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
  });
});
