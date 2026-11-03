import { ticketPriority, ticketState } from '../ticket_fixtures';
import { fire } from './board_helpers';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  Panel,
  answerOpen,
  cardView,
  enter,
  groupView,
  lastOpen,
  newDraft,
  openPanel,
  sendDraft,
  stateMessage,
  threadView,
  typeIn,
  composerPills,
  composerValue,
  pasteComposer,
  composerDisabled
} from '../harness';

describe('a card acts on the session it currently shows', () => {
  it('ignores obsolete ticket drops on a session or the Resume/New slot', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })], {
        tickets: [
          {
            scopeId: 'team-a',
            key: 'i1',
            identifier: 'ENG-1',
            title: 'a bug',
            priority: ticketPriority(2),
            state: ticketState('In Progress'),
            url: 'https://linear.app/x/ENG-1'
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    typeIn(p, 'keep this reply');
    p.posted.length = 0;
    for (const selector of ['.card[data-pid="202"]', '.card.add']) {
      const target = p.window.document.querySelector<HTMLElement>(selector);
      assert.ok(target);
      assert.equal(fire(p, target, 'dragover').defaultPrevented, false);
      assert.equal(target.classList.contains('drop'), false);
      fire(p, target, 'drop', 'i1');
    }
    assert.deepEqual(p.posted, []);
    assert.equal(composerValue(p), 'keep this reply');
  });

  it('starts Ending on acceptance before a full board refresh arrives', (t) => {
    const p = openPanel(t);
    const ended = cardView({ pid: 101, startedAt: 101_000, status: 'busy' });
    const replacement = cardView({ pid: 202, startedAt: 202_000 });
    p.push(stateMessage([groupView({ sessions: [ended, replacement] })]));
    p.push({ type: 'closeResult', sessions: [ended, { pid: 202, startedAt: 200_000 }] });
    const node = p.window.document.querySelector('.card[data-pid="101"]');
    assert.equal(node?.querySelector('.pill')?.textContent, 'Ending…');
    assert.ok(node?.classList.contains('closing'));
    assert.equal(node?.querySelector('[data-act="interrupt"]'), null);
    assert.equal(
      p.window.document.querySelector('.card[data-pid="202"]')?.classList.contains('closing'),
      false,
      'an old acknowledgement ended a replacement'
    );
    assert.deepEqual(p.posted, []);
  });

  const two = (first: number, second: number) =>
    stateMessage([
      groupView({
        sessions: [
          cardView({ pid: first, name: 'p' + first }),
          cardView({ pid: second, name: 'p' + second })
        ]
      })
    ]);
  /** The End button on the card at `at` in document order. */
  const end = (p: Panel, at: number): HTMLElement | undefined => {
    // By its tip rather than its place: the buttons a card draws are
    // conditional, and an index here would follow whichever one went.
    const card = p.window.document.querySelectorAll<HTMLElement>('.card')[at];
    return card?.querySelector<HTMLElement>('button.icon[data-tip="End session"]') ?? undefined;
  };
  const named = (p: Panel, at: number): string | null | undefined =>
    p.window.document.querySelectorAll('.card')[at]?.querySelector('.name')?.textContent;

  it('stops the session its own card names, across a reorder', (t) => {
    const p = openPanel(t);
    p.push(two(1, 2));
    assert.equal(named(p, 1), 'p2');
    end(p, 1)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'close', pid: 2 });

    // The same place on the screen, a different session in it.
    p.push(two(2, 1));
    assert.equal(named(p, 1), 'p1');
    end(p, 1)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'close', pid: 1 });
  });

  /**
   * Where a real press actually lands. An icon button is an inline `<svg>`
   * filling its whole visible area, so the pointer never touches the `<button>`
   * — the event target is the `<path>` under the cursor, which is an
   * `SVGElement` and not an `HTMLElement`. A delegated listener that tests its
   * target for `HTMLElement` therefore drops every icon-button click on the
   * board while the ones in the dock, which still close over what to do, keep
   * working. `.click()` on the button itself cannot see this: it makes the
   * button the target, which is the one case that was never broken.
   */
  const pressIcon = (button: HTMLElement | undefined, p: Panel): void => {
    const path = button?.querySelector('path');
    assert.ok(path, 'the icon button drew no <svg> to press');
    path.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
  };

  it('acts when the press lands on the icon inside the button', (t) => {
    const p = openPanel(t);
    p.push(two(1, 2));
    pressIcon(end(p, 1), p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'close', pid: 2 });
  });

  it('interrupts a busy session pressed on its icon', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 3, status: 'busy', name: 'p3', owned: true })]
        })
      ])
    );
    // Busy and piped draws three: Interrupt, End, Copy.
    const card = p.window.document.querySelector<HTMLElement>('.card');
    pressIcon(card?.querySelectorAll<HTMLElement>('button.icon')[0], p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 3 });
  });
});

/**
 * The click a rebuild used to eat, and the freeze that used to buy it back. A
 * `click` fires on the nearest common ancestor of the mousedown and mouseup
 * targets, so a card replaced between the two takes its handler with it and the
 * press dispatches on `#cards`. The answer is no longer to stop painting: the
 * card node is keyed by pid and survives the paint, and the handler is on
 * `#cards` anyway. So the press lands *and* the board stays live under it.
 */

/**
 * Promotion: the draft becoming the card its own send started.
 *
 * It is the step that binds the two halves of the redesign — the prompt is held
 * here rather than on the `open`, so the reveal is what carries it onto a pid
 * and posts the ordinary `send`. Everything a first turn gets for free —
 * `sendResult`, the echo, image blocks, the staged workflow write — it gets
 * because that send is the same one an Enter makes.
 */
describe('a draft promoted by its own reveal', () => {
  const CWD = '/Users/someone/proj';
  const board = (sessions: CardView[] = []) => [groupView({ cwd: CWD, sessions })];

  it('sends the held prompt for the pid that came up, exactly once', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'look at the parser', CWD);
    assert.ok(!p.posted.some((m) => m.type === 'send'), 'the prompt rode the open');

    answerOpen(p, 8);
    const sent = p.posted.filter((m) => m.type === 'send');
    assert.deepEqual(sent.map(assertedMessageBody), [
      { type: 'send', pid: 8, text: 'look at the parser' }
    ]);
    // And the surface is gone: the draft died at promotion, which is the whole
    // of its life.
    assert.equal(p.window.document.querySelector('.card.add.drafting'), null);
    assert.ok(
      p.posted.some((m) => m.type === 'select' && m.pid === 8),
      'the dock did not follow the card its draft became'
    );
  });

  /**
   * An image pasted into a draft mirrors a pill, is a message on its own, and
   * rides the promotion with the prompt.
   *
   * The `pid` the bytes are filed under is the whole of what promotion has to
   * carry here: a draft has none, so `boxImages` keeps them on the record and
   * the reveal moves them into the pid-keyed map the send reads.
   *
   * jsdom has no `ClipboardEvent` carrying usable `clipboardData`, so the event
   * is built by hand — `chat_media.test.ts` does the same, for the same reason,
   * and the `FileReader` drain is why this one case is `async`.
   */
  it('carries a pasted image onto the card with the prompt', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    pasteComposer(p, { files: [{ name: 'shot.png', type: 'image/png' }] });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));

    assert.match(composerValue(p), /\[Image #1\]/, 'the paste wrote no marker into the draft');
    assert.ok(composerPills(p).length > 0, 'the marker did not mirror a pill');

    enter(p);
    answerOpen(p, 9);
    const sent = p.posted.filter((m) => m.type === 'send').at(-1);
    assert.equal(sent?.pid, 9);
    assert.match(String(sent?.text), /\[Image #1\]/);
    assert.equal(sent?.images?.length, 1, 'the bytes did not ride the promotion');
    assert.equal(sent?.images?.[0]?.name, 'shot.png');
  });

  /**
   * The reader moved on while the start was in flight. The send still goes —
   * it is what they asked for — and the selection stays where they put it.
   */
  it('sends without moving a reader who has gone elsewhere', (t) => {
    const p = openPanel(t);
    const other = cardView({ pid: 3, owned: true });
    p.push(stateMessage(board([other])));
    sendDraft(p, 'in flight', CWD);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();

    answerOpen(p, 8);
    assert.ok(
      p.posted.some((m) => m.type === 'send' && m.pid === 8),
      'the promoted draft did not send'
    );
    assert.ok(
      !p.posted.some((m) => m.type === 'select' && m.pid === 8),
      'the promotion moved a reader who had gone elsewhere'
    );
  });

  /**
   * Run the 25s pending clock out, the way the timeout scenario above does:
   * `prunePending` fires on the board's own beat rather than a timer of its
   * own, so what a test moves is the window's clock and what it waits for is a
   * beat. Put back straight after, so the retry that follows is stamped now.
   */
  const giveUp = async (p: Panel): Promise<void> => {
    const real = p.window.Date.now;
    p.window.Date.now = () => real() + 25_001;
    await new Promise((done) => setTimeout(done, 1200));
    p.window.Date.now = real;
  };

  it('keeps a slow start correlated after the local confirmation watchdog', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'in flight', CWD);
    const draftId = lastOpen(p).draftId;
    await giveUp(p);
    assert.equal(composerDisabled(p), true);
    assert.ok(
      p.posted.some((m) => m.type === 'startup' && m.attemptId === draftId && m.action === 'status')
    );
    answerOpen(p, 8);
    answerOpen(p, 8);
    assert.deepEqual(p.posted.filter((m) => m.type === 'send').map(assertedMessageBody), [
      { type: 'send', pid: 8, text: 'in flight' }
    ]);
  });

  it('retains unknown text and identity and reconciles before offering retry', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'held original', CWD);
    const draftId = lastOpen(p).draftId!;
    p.push({
      type: 'startupStatus',
      attemptId: draftId,
      state: 'unknown',
      reason: 'Confirmation unavailable.'
    });
    assert.equal(composerDisabled(p), true);
    assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /held original/);
    p.window.document.querySelector<HTMLButtonElement>('[data-startup="status"]')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'startup', attemptId: draftId, action: 'status' });
    assert.equal(p.window.document.querySelector('[data-act="retry-held"]'), null);
    answerOpen(p, 8);
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 1);
  });

  it('cancels the named attempt before allowing a replacement to send', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'in flight', CWD);
    const first = lastOpen(p).draftId!;
    const cancel = p.window.document.querySelector<HTMLButtonElement>('[data-startup="cancel"]');
    assert.ok(cancel);
    cancel.click();
    assert.deepEqual(p.posted.at(-1), { type: 'startup', attemptId: first, action: 'cancel' });
    assert.equal(composerDisabled(p), true);
    p.push({
      type: 'startupStatus',
      attemptId: first,
      state: 'stopped',
      reason: 'Session start cancelled.'
    });
    assert.equal(composerDisabled(p), false);
    p.window.document.querySelector<HTMLElement>('[data-act="dismiss-held"]')?.click();
    typeIn(p, 'trying again');
    enter(p);
    assert.notEqual(lastOpen(p).draftId, first);
    p.push({ type: 'reveal', pid: 8, startedAt: 8_000, draftId: first });
    assert.ok(!p.posted.some((m) => m.type === 'send'));
    answerOpen(p, 9);
    assert.deepEqual(p.posted.filter((m) => m.type === 'send').map(assertedMessageBody), [
      { type: 'send', pid: 9, text: 'trying again' }
    ]);
  });

  it('keeps its own attempt when another session lands in the folder', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'in flight', CWD);
    p.push(stateMessage(board([cardView({ pid: 4, owned: true, parent: 1 })])));
    await giveUp(p);
    assert.equal(composerDisabled(p), true);
    answerOpen(p, 8);
    assert.deepEqual(p.posted.filter((m) => m.type === 'send').map(assertedMessageBody), [
      { type: 'send', pid: 8, text: 'in flight' }
    ]);
  });

  /**
   * A refusal `startOwned` makes before any child exists: a missing binary, a
   * failed preflight, a brand and model that do not go together. The draft is
   * the only place a reader can learn it — host notifications are muted here.
   */
  it('puts the box back with its reason when the start is refused', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'start me', CWD);
    const draftId = lastOpen(p).draftId;
    assert.ok(draftId);
    // The box is away while the start is in flight.
    assert.equal(composerDisabled(p), true);

    p.push({
      type: 'openResult',
      draftId,
      ok: false,
      notStarted: true,
      reason: 'No grok binary on this machine.'
    });
    assert.equal(composerDisabled(p), false, 'the box stayed away after a refusal');
    assert.ok(
      p.window.document.querySelector('[data-act="retry-held"]'),
      'the refusal lost the held prompt'
    );
    assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /start me/);
    assert.match(
      p.window.document.querySelector('#thread .vacant')?.textContent ?? '',
      /No grok binary/,
      'the draft does not say why the start did not happen'
    );
    // And the slot is pressable again: nothing is in flight for this folder.
    assert.equal(
      p.window.document.querySelector('.card.add')?.classList.contains('busy'),
      false,
      'the slot is still waiting for a start that was refused'
    );
    assert.ok(!p.posted.some((m) => m.type === 'send'), 'a refused start sent something');
  });

  /**
   * Same class of wipe as a late `openResult`, on the path a 25s clock actually
   * takes. `prunePending` restores the *record* and then `repaintDraft()`; if
   * that falls through to the vacant plate, the selected session's thread is
   * replaced with "No session selected" until the next push.
   *
   * The bundle is an IIFE, so importing `pending` from `webview/state` is a
   * different map. The stamp is `Date.now()` at send, and the 1s beat is how a
   * timeout fires without a state push that would re-paint the thread and hide
   * the wipe. The clock is the window's — same reason `board_servers.test.ts`
   * moves it.
   */
  it('a pending timeout does not wipe a selected session’s thread', async (t) => {
    const p = openPanel(t);
    const other = cardView({ pid: 3, owned: true });
    const groups = board([other]);
    const turn: ExchangeView = {
      role: 'user',
      text: 'still here',
      blocks: [{ prose: 'still here' }]
    };
    const thread = threadView({ pid: 3, exchanges: [turn] });
    p.push(stateMessage(groups));
    sendDraft(p, 'in flight', CWD);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    p.push(stateMessage(groups, { thread }));
    assert.equal(
      p.window.document.querySelector('#thread .turn .body')?.textContent,
      'still here',
      'the fixture never painted the selected thread'
    );

    const real = p.window.Date.now;
    p.window.Date.now = () => real() + 25_001;
    t.after(() => {
      p.window.Date.now = real;
    });
    await new Promise((done) => setTimeout(done, 1200));

    assert.notEqual(
      p.window.document.querySelector('#thread .vacant h3')?.textContent,
      'No session selected',
      'the timeout replaced the thread with the vacant plate'
    );
    assert.equal(p.window.document.querySelector('#thread .turn .body')?.textContent, 'still here');

    newDraft(p, CWD);
    assert.equal(
      p.window.document.querySelector('#chat-startup .start-note span')?.textContent,
      'Still waiting for confirmation. Your message is held.'
    );
    assert.equal(composerDisabled(p), true, 'the pending draft allowed an unconfirmed retry');
  });

  /** Every other reveal keeps today's path — a resume, a `squadron-spawn`,
   *  another window's start. None of them names a draft. */
  it('leaves a reveal that names no draft on its old path', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    typeIn(p, 'still mine');
    p.push({ type: 'reveal', pid: 20, startedAt: 20_000 });
    assert.ok(
      p.posted.some((m) => m.type === 'select' && m.pid === 20),
      'a plain reveal stopped selecting'
    );
    assert.ok(!p.posted.some((m) => m.type === 'send'), 'a plain reveal sent a draft');
    // Nothing typed is discarded: the draft is still there to come back to.
    newDraft(p, CWD);
    assert.equal(composerValue(p), 'still mine');
  });
});
