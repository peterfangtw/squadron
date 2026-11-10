import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerFilePick,
  answerOpen,
  answerSend,
  attachWorkflow,
  assertedMessageBody,
  askRequest,
  captureVT,
  cardView,
  groupView,
  importComposer,
  newDraft,
  openPanel,
  openThread,
  permissionRequest,
  sendDraft,
  stateMessage,
  threadView,
  typeIn,
  workflowView,
  Panel,
  composerValue,
  proseOf,
  composerDisabled,
  enter
} from '../harness';
import { panelDocument } from '../../ui/document';

const drag = (p: Panel, clientX: number): void => {
  const w = p.window;
  w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
  w.dispatchEvent(new w.MouseEvent('mousemove', { clientX }));
  w.dispatchEvent(new w.MouseEvent('mouseup'));
};

describe('the dock', () => {
  it('closes a chat into a new task without ending it or losing its unfinished reply', (t) => {
    const thread = threadView({ status: 'busy' });
    const cwd = '/workspace/acme-web';
    const p = openThread(t, thread, { defaultCwd: cwd });
    const d = p.window.document;
    typeIn(p, 'unfinished reply');
    p.posted.length = 0;
    const close = d.querySelector<HTMLButtonElement>('button[aria-label="Close chat"]');
    assert.ok(close, 'the chat offers a close button');
    close.click();
    assert.ok(d.getElementById('chat')?.classList.contains('start'));
    assert.equal(composerValue(p), '');
    assert.equal(composerDisabled(p), false);
    assert.equal(d.querySelector('.card.selected'), null);
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 0 }]);

    typeIn(p, 'new task');
    p.push(stateMessage([groupView({ sessions: [thread] })], { defaultCwd: cwd, thread }));
    assert.equal(composerValue(p), 'new task');
    assert.ok(d.getElementById('chat')?.classList.contains('start'));
    d.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(stateMessage([groupView({ sessions: [thread] })], { defaultCwd: cwd, thread }));
    assert.equal(composerValue(p), 'unfinished reply');
  });

  it('browses Tickets in the board while the selected chat keeps its draft and live turns', (t) => {
    const p = openThread(t, threadView({ name: 'alpha' }));
    const d = p.window.document;
    typeIn(p, 'unfinished reply');
    const owner = proseOf(d.getElementById('input'));
    const thread = d.getElementById('thread');
    const width = d.getElementById('dock')?.style.width;
    const tickets = d.querySelector<HTMLElement>('#nav [data-act="tickets"]');
    assert.ok(tickets, 'Tickets is a board destination even without a source');
    tickets.click();
    assert.equal(d.getElementById('tk-list')?.parentElement?.id, 'board-body');
    assert.equal(d.getElementById('chat')?.hidden, false);
    assert.equal(d.getElementById('cards')?.hidden, true);
    assert.equal(d.getElementById('dock-tabs'), null);
    assert.equal(composerValue(p), 'unfinished reply');
    assert.equal(proseOf(d.getElementById('input')), owner);
    assert.equal(d.getElementById('thread'), thread);
    assert.equal(d.getElementById('dock')?.style.width, width);
    p.push(
      stateMessage([groupView()], {
        thread: threadView({
          exchanges: [
            {
              role: 'assistant',
              text: 'still working',
              blocks: [{ prose: '<p>still working</p>' }],
              streaming: true
            }
          ],
          status: 'busy'
        })
      })
    );
    assert.match(thread?.textContent ?? '', /still working/);
    assert.equal(composerValue(p), 'unfinished reply');
    assert.equal(d.getElementById('tk-list')?.hidden, false);
    d.querySelector<HTMLElement>('#nav [data-act="sessions"]')?.click();
    assert.equal(d.getElementById('cards')?.hidden, false);
    assert.equal(proseOf(d.getElementById('input')), owner);
  });

  it('opens the default workspace draft without starting a session, then starts there on send', (t) => {
    const p = openPanel(t);
    const cwd = '/workspace/acme-web/worktree';
    p.push(stateMessage([groupView({ cwd: '/workspace/other' })], { defaultCwd: cwd }));
    const d = p.window.document;
    assert.ok(d.getElementById('chat')?.classList.contains('start'));
    assert.match(d.querySelector('#thread .vacant h3')?.textContent ?? '', /acme-web\/worktree/);
    // The launch draft is the window default. This group's paired halves stay
    // on the group: Resume and New are not retargeted at that default.
    assert.equal(
      d.querySelector<HTMLElement>('.half[data-act="resume"]')?.dataset.cwd,
      '/workspace/other'
    );
    assert.equal(
      d.querySelector<HTMLElement>('.half[data-act="open"]')?.dataset.cwd,
      '/workspace/other'
    );
    assert.ok(d.querySelector('#ctools .fpill.model'));
    assert.equal(p.posted.length, 0);
    typeIn(p, 'inspect the parser');
    enter(p);
    assert.equal(p.posted.find((m) => m.type === 'open')?.cwd, cwd);
  });

  it('waits for a default cwd without borrowing another session folder', (t) => {
    const p = openPanel(t);
    const groups = [groupView({ cwd: '/workspace/other' })];
    p.push(stateMessage(groups));
    const d = p.window.document;
    assert.ok(d.getElementById('chat')?.classList.contains('empty'));
    assert.match(d.querySelector('#thread .vacant p')?.textContent ?? '', /open a folder/i);
    assert.deepEqual(p.posted, []);
    p.push(stateMessage(groups, { defaultCwd: '/workspace/acme-web' }));
    assert.ok(d.getElementById('chat')?.classList.contains('start'));
    typeIn(p, 'keep this task');
    p.push(stateMessage(groups, { defaultCwd: '/workspace/another' }));
    assert.equal(composerValue(p), 'keep this task');
    assert.match(d.querySelector('#thread .vacant h3')?.textContent ?? '', /acme-web/);
  });

  it('does not replace an existing session or folder draft when the default arrives', (t) => {
    for (const draft of [false, true]) {
      const p = openThread(t, threadView());
      if (draft) newDraft(p);
      typeIn(p, 'keep this owner');
      p.push(stateMessage([groupView()], { defaultCwd: '/workspace/acme-web' }));
      assert.equal(composerValue(p), 'keep this owner');
      assert.equal(p.window.document.getElementById('chat')?.classList.contains('start'), draft);
    }
  });

  it('keeps the shell visible with no collapse controls on either tab or a draft', (t) => {
    const p = openThread(t, threadView());
    const d = p.window.document;
    assert.equal(d.getElementById('chat-close'), null);
    d.getElementById('board-tickets')?.click();
    assert.equal(d.querySelector('#tk-head button[aria-label="Close"]'), null);
    d.getElementById('board-sessions')?.click();
    newDraft(p);
    assert.equal(d.querySelector('.dshut'), null);
    assert.notEqual(p.window.getComputedStyle(d.getElementById('dock')!).display, 'none');
    assert.notEqual(p.window.getComputedStyle(d.getElementById('divider')!).display, 'none');
  });

  it('opens on card click and fills the head', (t) => {
    const p = openThread(t, threadView({ name: 'alpha', status: 'waiting', waitingFor: 'input' }));
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 101 }]);
    assert.ok(!p.window.document.body.classList.contains('closed'));
    const head = p.window.document.getElementById('chat-head');
    assert.equal(head?.querySelector('.name')?.textContent, 'alpha');
    assert.equal(head?.querySelector('.pill')?.textContent, 'input');
  });

  it('keeps chat separate from the board navigation', (t) => {
    const p = openThread(t, threadView({ name: 'alpha' }));
    assert.equal(p.window.document.querySelector('#board-sessions .nm')?.textContent, 'Sessions');
    assert.equal(p.window.document.querySelector('#dock .dtab'), null);
  });

  it('does not carry turns across a switch to another session', (t) => {
    // Selecting drops the thread to a notice. Repainting the next session
    // must not mistake the turns of the last one for a prefix of its own.
    const groups = [
      groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202, name: 'beta' })] })
    ];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    // Re-read on each click: the card is selected the way a pointer selects
    // one, through whatever node is on the board now. A handle kept across the
    // push in between would be clicking at a node no reader could reach.
    const card = (at: number) => p.window.document.querySelectorAll<HTMLElement>('.card')[at];
    card(0)?.click();
    const mine: ExchangeView = { role: 'user', text: 'mine', blocks: [{ prose: 'mine' }] };
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [mine, mine] }) }));
    assert.equal(p.window.document.querySelectorAll('#thread .turn').length, 2);

    card(1)?.click();
    assert.equal(p.window.document.querySelector('#thread .empty')?.textContent, 'Loading…');
    const theirs: ExchangeView = {
      role: 'user',
      text: 'theirs',
      blocks: [{ prose: 'theirs' }]
    };
    p.push(stateMessage(groups, { thread: threadView({ pid: 202, exchanges: [theirs] }) }));
    const turns = p.window.document.querySelectorAll('#thread .turn');
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.querySelector('.body')?.textContent, 'theirs');
    assert.equal(p.window.document.querySelector('#thread .empty'), null);
  });

  it('describes no session when it has none, however the tab is reached', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const d = p.window.document;
    d.getElementById('board-tickets')?.click();
    d.getElementById('board-sessions')?.click();

    const chat = d.getElementById('chat');
    assert.ok(chat?.classList.contains('empty'), 'the whole tab is in the empty state');
    assert.equal(d.querySelector('#thread .vacant h3')?.textContent, 'No session selected');
    assert.equal(d.querySelector('#thread .turn'), null);
  });

  /** The empty dock wears the same watermark a session sits over, so a first
   *  send has no mark to hand over. */
  it('keeps the watermark behind the empty dock, with no mark over the words', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const d = p.window.document;
    d.getElementById('board-tickets')?.click();
    d.getElementById('board-sessions')?.click();

    assert.equal(
      d.querySelector('#thread .vacant')?.firstElementChild?.tagName,
      'H3',
      'something is drawn over the words'
    );
    const chat = d.getElementById('chat');
    assert.ok(chat);
    assert.match(
      p.window.getComputedStyle(chat).backgroundImage,
      /^url\("data:image\/svg\+xml/,
      'the empty dock hides the watermark'
    );
  });

  describe('telling the host the backlog is on screen', () => {
    it('says so on the way in, and on the way back out', (t) => {
      const p = openThread(t, threadView({ name: 'alpha' }));
      const d = p.window.document;
      p.posted.length = 0;

      d.getElementById('board-tickets')?.click();
      assert.deepEqual(p.posted, [{ type: 'ticketsOpen', open: true }]);

      d.getElementById('board-sessions')?.click();
      assert.deepEqual(p.posted, [
        { type: 'ticketsOpen', open: true },
        { type: 'ticketsOpen', open: false }
      ]);
    });

    it('says nothing when the flip would repeat itself', (t) => {
      const p = openThread(t, threadView({ name: 'alpha' }));
      const d = p.window.document;
      d.getElementById('board-tickets')?.click();
      p.posted.length = 0;

      d.getElementById('board-tickets')?.click();
      d.getElementById('board-tickets')?.click();
      assert.deepEqual(p.posted, [], 'a re-click is not a Refresh');
    });
  });

  /**
   * The reported harm, and the half jsdom cannot see: a box that takes typing
   * `send()` then drops on `!ui.selected`. Nothing is laid out here, so the
   * stylesheet is read instead — `containment.test.ts` makes the same trade for
   * the same reason, and a rule is what the empty state is made of.
   */
  it('takes the composer out of the flow rather than leaving it disabled', () => {
    const sheet = panelDocument().replace(/\s+/g, ' ');
    assert.match(sheet, /#chat\.empty > #composer[^{]*{[^}]*display: none/);
  });

  /**
   * A late `sendResult` for the session just closed must leave `empty` on.
   * `renderThread` returns before painting when that thread is not the active
   * session.
   */
  it('does not let a late push for the closed session undo the state', (t) => {
    const p = openThread(t, threadView({ name: 'alpha' }));
    const d = p.window.document;
    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt: threadView().startedAt }] });
    d.getElementById('board-sessions')?.click();

    p.push({ type: 'sendResult', pid: 101, ok: false, reason: 'session is gone' });
    assert.ok(d.getElementById('chat')?.classList.contains('empty'));
    assert.equal(d.querySelector('#thread .vacant h3')?.textContent, 'No session selected');
  });

  it('leaves the empty state the moment a session arrives', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const d = p.window.document;
    assert.ok(d.getElementById('chat')?.classList.contains('empty'));
    d.querySelector<HTMLElement>('.card')?.click();
    assert.ok(!d.getElementById('chat')?.classList.contains('empty'));
    assert.equal(d.querySelector('#thread .empty')?.textContent, 'Loading…');
  });

  it('resizes the dock by dragging the divider', (t) => {
    const p = openThread(t, threadView());
    const dock = p.window.document.getElementById('dock');
    drag(p, p.window.innerWidth - 500);
    assert.equal(dock?.style.width, '500px');
    assert.equal(p.saved()?.dockWidth, 500);
    assert.ok(!p.window.document.getElementById('divider')?.classList.contains('dragging'));
  });

  it('keeps the dock and the list both usable at the extremes', (t) => {
    const p = openThread(t, threadView());
    const dock = p.window.document.getElementById('dock');
    drag(p, p.window.innerWidth - 10);
    assert.equal(dock?.style.width, '280px', 'a dock too narrow to read is not a dock');
    drag(p, 0);
    assert.equal(
      dock?.style.width,
      Math.round(p.window.innerWidth * 0.5) + 'px',
      'the dock stops at half, so the list is never the narrower column'
    );
  });

  it('restores the width it was left at', (t) => {
    const p = openPanel(t, { dockWidth: 480 });
    assert.equal(p.window.document.getElementById('dock')?.style.width, '480px');
  });

  it('tells the host the width once, at the end of the drag', (t) => {
    const p = openPanel(t, { dockWidth: 480 });
    const w = p.window;
    w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
    w.dispatchEvent(new w.MouseEvent('mousemove', { clientX: w.innerWidth - 400 }));
    w.dispatchEvent(new w.MouseEvent('mousemove', { clientX: w.innerWidth - 420 }));
    assert.equal(w.document.getElementById('dock')?.style.width, '420px', 'the box lagged');
    assert.equal(p.saved()?.dockWidth, 480, 'a frame of the drag was persisted');
    w.dispatchEvent(new w.MouseEvent('mouseup'));
    assert.equal(p.saved()?.dockWidth, 420);
  });

  /**
   * The thread's own cost, which is the length-dependent half: a width change
   * repins the thread, the scroll off that write walks every turn in it, and a
   * drag does that every frame. See `dockDrag` in `chat.ts` for the reading.
   */
  it('leaves the thread unread until the drag ends', (t) => {
    const turn = (text: string): ExchangeView => ({
      role: 'user',
      text,
      blocks: [{ prose: text }]
    });
    const p = openThread(t, threadView({ exchanges: [turn('one'), turn('two')] }));
    const w = p.window;
    const count = w.document.querySelector('#prompt-bar .count');
    assert.ok(count);
    assert.equal(count.textContent, '2/2');
    // The bar holds no state of its own, so a sentinel written into it lasts
    // exactly as long as nothing recomputes it.
    count.textContent = 'sentinel';
    w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
    w.document.getElementById('thread')?.dispatchEvent(new w.Event('scroll'));
    assert.equal(count.textContent, 'sentinel', 'a drag frame walked the thread');
    w.dispatchEvent(new w.MouseEvent('mouseup'));
    assert.equal(count.textContent, '2/2', 'the end of the drag never caught up');
  });

  /**
   * The other half of the same cost, and the length-dependent one: the browser
   * re-wrapping every turn at every width the drag passes through. The rule
   * that takes the off-screen ones out of it is in `css/chat.ts`; what is held
   * here is that it is on for exactly the length of the drag, because while it
   * is on `scrollHeight` is a guess and the thread's own measurements are not
   * to be trusted. jsdom lays nothing out, so the class is the whole of what
   * this can pose — the layout reading is in the comment on the rule.
   */
  it('takes the thread out of the reflow for the length of the drag', (t) => {
    const p = openThread(t, threadView());
    const w = p.window;
    const thread = w.document.getElementById('thread');
    assert.ok(thread);
    assert.ok(!thread.classList.contains('resizing'), 'a thread nobody is dragging');
    w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
    assert.ok(thread.classList.contains('resizing'));
    w.dispatchEvent(new w.MouseEvent('mousemove', { clientX: w.innerWidth - 500 }));
    assert.ok(thread.classList.contains('resizing'), 'a frame of the drag paid full layout');
    w.dispatchEvent(new w.MouseEvent('mouseup'));
    assert.ok(!thread.classList.contains('resizing'), 'the thread stayed on guessed heights');
  });

  it('guesses a turn height only while the drag is on', () => {
    assert.match(panelDocument(), /#thread\.resizing \.turn \{[^}]*content-visibility: auto/);
    // Every rule that guesses, whatever selector carries it — the scoping is the
    // whole safety of this, and `#thread .turn` slips past a check written
    // against one spelling of the unscoped form. Comments come out first, or a
    // rule is credited with the word `resizing` from the prose above it.
    const rules = panelDocument().replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector] of rules.matchAll(/([^{}]*)\{[^}]*content-visibility[^}]*\}/g)) {
      assert.match(selector ?? '', /\.resizing/, 'a turn height guessed outside a drag');
    }
  });

  /**
   * `paint` leaves the head of the thread standing and rebuilds the tail, so a
   * push landing inside a 5s drag can remove the very turn the drag is holding
   * the reader against. What jsdom can pose is that the drag survives it — the
   * grip is taken again rather than dropped, and the end of the drag is still
   * the end. That the reader lands on the right pixel is layout, and layout is
   * zero here: the measurement is on the rule in `css/chat.ts`.
   */
  it('takes hold again when a push rebuilds the turn it was holding', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const turn = (text: string): ExchangeView => ({
      role: 'user',
      text,
      blocks: [{ prose: text }]
    });
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [turn('one')] }) }));
    const w = p.window;
    const thread = w.document.getElementById('thread');
    w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
    // The turn the grip took hold of leaves the document on this push.
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [turn('two')] }) }));
    w.dispatchEvent(new w.MouseEvent('mousemove', { clientX: w.innerWidth - 500 }));
    w.dispatchEvent(new w.MouseEvent('mouseup'));
    assert.ok(!thread?.classList.contains('resizing'), 'the drag never let go');
    assert.equal(thread?.querySelector('.turn .body')?.textContent, 'two');
    assert.equal(w.document.getElementById('dock')?.style.width, '500px');
  });

  it('selects a session the host asks to reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 8, startedAt: 8_000 })] })]));
    p.push({ type: 'reveal', pid: 8, startedAt: 8_000 });
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 8 }]);
    assert.ok(!p.window.document.body.classList.contains('closed'));
  });
});

describe('the persistent shell', () => {
  it('keeps its width without a dock transition across selection, New and tabs', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { defaultCwd: '/Users/someone/proj' }));
    drag(p, p.window.innerWidth - 450);
    const d = p.window.document;
    const started = captureVT(p);
    d.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    d.getElementById('board-tickets')?.click();
    d.getElementById('board-sessions')?.click();
    newDraft(p);
    assert.equal(started.length, 0);
    assert.equal(d.getElementById('dock')?.style.width, '450px');
    assert.equal(p.saved()?.dockWidth, 450);
    assert.notEqual(p.window.getComputedStyle(d.getElementById('dock')!).display, 'none');
  });

  it('does not close the dock on one state push that omits its session', (t) => {
    // Discovery can transiently return no sessions. Absence in one push is not
    // proof that the selected process ended, so its chat remains the owner.
    // A busy thread stays busy across those omissions, and a later idle thread
    // for the same incarnation resumes it.
    const p = openThread(t, threadView({ status: 'busy' }));
    assert.ok(p.window.document.querySelector('#thread .working'));
    const started = captureVT(p);
    for (let n = 0; n < 5; n++) p.push(stateMessage([groupView({ sessions: [] })]));
    assert.equal(started.length, 0);
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.ok(p.window.document.querySelector('#thread .working'));

    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, status: 'idle' })] })], {
        thread: threadView({ status: 'idle' })
      })
    );
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('returns to the main workspace draft on exact accepted End and rejects late publications', (t) => {
    const startedAt = 101_000;
    const p = openThread(t, threadView({ startedAt, status: 'busy' }), {
      defaultCwd: '/workspace/acme-web'
    });
    assert.ok(p.window.document.querySelector('#thread .working'));
    drag(p, p.window.innerWidth - 450);
    typeIn(p, 'this reply belongs to the ended session');
    p.posted.length = 0;
    p.window.document.querySelector<HTMLElement>('.card button[data-tip="End session"]')?.click();
    assert.deepEqual(p.posted, [{ type: 'close', pid: 101, startedAt }]);

    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt }] });
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.ok(p.window.document.getElementById('chat')?.classList.contains('start'));
    assert.equal(composerValue(p), '');
    assert.equal(p.window.document.getElementById('dock')?.style.width, '450px');
    assert.equal(p.saved()?.dockWidth, 450);
    assert.equal(p.window.document.querySelector('.card.selected'), null);
    assert.deepEqual(p.posted, [{ type: 'close', pid: 101, startedAt }]);

    // Late publications cannot restore the accepted-End owner.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, status: 'busy', startedAt })] })], {
        thread: threadView({ startedAt, status: 'busy' })
      })
    );
    for (let n = 0; n < 3; n++)
      p.push(stateMessage([groupView({ sessions: [] })], { defaultCwd: '/workspace/acme-web' }));
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.ok(p.window.document.getElementById('chat')?.classList.contains('start'));
    assert.equal(p.window.document.querySelector('.card.selected'), null);
    typeIn(p, 'a new task');
    enter(p);
    assert.equal(p.posted.find((m) => m.type === 'open')?.cwd, '/workspace/acme-web');

    const other = cardView({ pid: 202, name: 'beta', startedAt: 202_000 });
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt }), other] })]));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="202"]')?.click();
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt }), other] })], {
        thread: threadView({ pid: 202, name: 'beta', startedAt: 202_000, status: 'idle' })
      })
    );
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.equal(p.window.document.querySelector('#chat-head .name')?.textContent, 'beta');
  });

  it('keeps a recycled session open when an older End result arrives', (t) => {
    const startedAt = 101_001;
    const p = openThread(t, threadView({ startedAt }));
    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt: 101_000 }] });
    assert.equal(
      p.window.document.querySelector('#chat-head .name')?.textContent,
      threadView().name
    );
    p.push({ type: 'closeResult', sessions: [{ pid: 202, startedAt }] });
    assert.ok(!p.window.document.body.classList.contains('closed'));
    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt }] });
    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.ok(p.window.document.getElementById('chat')?.classList.contains('empty'));
    assert.equal(p.window.document.querySelector('.card.selected'), null);
    assert.match(
      p.window.document.querySelector('#thread .vacant p')?.textContent ?? '',
      /open a folder/i
    );
  });

  it('keeps Tickets open when the selected session ends behind it', (t) => {
    const startedAt = 101_000;
    const p = openThread(t, threadView({ startedAt }), { defaultCwd: '/workspace/acme-web' });
    p.window.document.getElementById('board-tickets')?.click();
    p.posted.length = 0;

    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt }] });

    assert.ok(!p.window.document.body.classList.contains('closed'));
    assert.equal(p.window.document.getElementById('tk-list')?.hidden, false);
    assert.deepEqual(p.posted, []);
    p.window.document.getElementById('board-sessions')?.click();
    assert.ok(p.window.document.getElementById('chat')?.classList.contains('start'));
  });

  it('restores a pre-existing rich task draft instead of the ended session reply', (t) => {
    const cwd = '/workspace/acme-web';
    const startedAt = 101_000;
    const groups = [groupView({ cwd: '/workspace/other', sessions: [cardView({ startedAt })] })];
    const extra = {
      defaultCwd: cwd,
      workflows: [workflowView({ id: 'ship', label: 'Ship' })],
      models: [
        {
          value: 'haiku',
          name: 'Haiku',
          id: 'haiku',
          brand: 'claude' as const,
          window: 200_000,
          efforts: [{ value: 'low' }, { value: 'high' }]
        }
      ]
    };
    const p = openPanel(t);
    p.push(stateMessage(groups, extra));
    importComposer(p, '**saved task**\n\n- keep the list');
    p.window.document.getElementById('fattach')?.click();
    answerFilePick(p, ['/workspace/acme-web/notes.md']);
    attachWorkflow(p, 'Ship');
    p.window.document.querySelector<HTMLElement>('#ctools .fpill.model')?.click();
    const model = p.window.document.querySelector<HTMLElement>('#ctools .fmenu .wp');
    assert.ok(model);
    model.click();
    p.window.document.querySelector<HTMLElement>('#ctools .fpill.effort')?.click();
    const high = [...p.window.document.querySelectorAll<HTMLElement>('#ctools .fmenu .mitem')].find(
      (row) => row.querySelector('.nm')?.textContent === 'high'
    );
    assert.ok(high);
    high.click();
    const before = p.window.document.querySelector('#input .ProseMirror')?.innerHTML;
    assert.ok(before);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(stateMessage(groups, { ...extra, thread: threadView({ startedAt, status: 'idle' }) }));
    typeIn(p, 'pending session send');
    enter(p);
    typeIn(p, 'unsent session reply');

    p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt }] });
    answerSend(p, { ok: false, reason: 'session already ended' });

    assert.equal(p.window.document.querySelector('#input .ProseMirror')?.innerHTML, before);
    assert.match(p.window.document.querySelector('#wattach .wflow')?.textContent ?? '', /Ship/);
    enter(p);
    const open = p.posted.find((m) => m.type === 'open');
    assert.equal(open?.cwd, cwd);
    assert.equal(open?.target?.model, 'haiku');
    assert.equal(open?.target?.window, 200_000);
    assert.equal(open?.target?.effort, 'high');
    answerOpen(p, 303, 303_000);
    const sent = p.posted.find((m) => m.type === 'send' && m.pid === 303);
    assert.ok(sent?.type === 'send');
    assert.equal(sent?.workflowId, 'ship');
    assert.match(sent?.text ?? '', /saved task/);
    assert.match(sent?.text ?? '', /\/workspace\/acme-web\/notes.md/);
    assert.doesNotMatch(sent?.text ?? '', /unsent session reply/);
    assert.doesNotMatch(sent?.text ?? '', /pending session send/);
  });

  for (const outcome of ['refused', 'promoted'] as const) {
    it(`returns to an in-flight default draft and keeps its ${outcome} startup result`, (t) => {
      const cwd = '/workspace/acme-web';
      const startedAt = 101_000;
      const groups = [groupView({ cwd: '/workspace/other', sessions: [cardView({ startedAt })] })];
      const p = openPanel(t);
      p.push(stateMessage(groups, { defaultCwd: cwd }));
      typeIn(p, 'the original first task');
      enter(p);
      const open = p.posted.find((m) => m.type === 'open');
      assert.ok(open?.draftId);
      p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
      p.push(stateMessage(groups, { defaultCwd: cwd, thread: threadView({ startedAt }) }));
      assert.equal(p.window.document.getElementById('chat-startup')?.hidden, true);

      p.push({ type: 'closeResult', sessions: [{ pid: 101, startedAt }] });

      assert.ok(p.window.document.getElementById('chat')?.classList.contains('starting'));
      assert.equal(p.window.document.getElementById('chat-startup')?.hidden, false);
      assert.equal(
        p.window.document.querySelector('#thread .turn.user .body')?.textContent,
        'the original first task'
      );
      assert.equal(p.posted.filter((m) => m.type === 'open').length, 1);
      if (outcome === 'refused') {
        p.push({
          type: 'openResult',
          draftId: open.draftId,
          outcome: 'stopped',
          notice: 'Start refused'
        });
        assert.ok(p.window.document.getElementById('chat')?.classList.contains('start'));
        assert.equal(p.window.document.getElementById('chat-startup')?.hidden, true);
        assert.match(
          p.window.document.querySelector('#thread .why')?.textContent ?? '',
          /Start refused/
        );
        assert.equal(p.posted.filter((m) => m.type === 'send').length, 0);
      } else {
        answerOpen(p, 303, 303_000);
        const sent = p.posted.find((m) => m.type === 'send');
        assert.ok(sent?.type === 'send');
        assert.equal(sent.pid, 303);
        assert.equal(sent.text, 'the original first task');
        assert.equal(p.window.document.querySelector('.card[data-pid="101"].selected'), null);
      }
    });
  }
});

/**
 * The draft surface: the chat tab offering to begin a session rather than
 * describing one.
 *
 * One class over the shipped empty state (`#chat.empty.start`), and the whole
 * difference is that the composer comes back. What hides — head, needs, prompt
 * bar — is the stylesheet's, unchanged since `chat-empty` landed.
 */
describe('the dock on a draft', () => {
  const CWD = '/Users/someone/proj';
  const chat = (p: Panel): HTMLElement => p.window.document.getElementById('chat') as HTMLElement;
  const board = (sessions: CardView[] = []) => [groupView({ cwd: CWD, sessions })];

  for (const [brand, model, window] of [
    ['claude', 'claude-sonnet-5-5', 1_000_000],
    ['grok', 'grok-4.7', 500_000],
    ['codex', 'gpt-6.1-sol', 475_000]
  ] as const) {
    for (const saved of [undefined, 'low', 'retired']) {
      it(`launches ${brand} at the displayed effort after a late catalog (${saved ?? 'unset'})`, (t) => {
        const p = openPanel(t);
        const config = {
          defaultCwd: CWD,
          model,
          contextWindow: saved === undefined ? 123_000 : saved === 'low' ? window : undefined,
          efforts: saved === undefined ? {} : { [model]: saved }
        };
        p.push(stateMessage(board(), config));
        typeIn(p, 'inspect the parser');
        const models: ModelView[] = [
          {
            brand,
            value: model,
            id: model,
            name: model,
            window,
            efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
            defaultEffort: 'medium'
          }
        ];
        p.push(stateMessage(board(), { ...config, models }));
        const expected = saved === 'low' ? 'low' : 'medium';
        assert.equal(
          p.window.document.querySelector('#ctools .fpill.effort .nm')?.textContent,
          expected
        );
        // A resolved draft is a choice of its own, even if settings change later.
        p.push(
          stateMessage(board(), {
            ...config,
            models,
            model: 'another-model',
            efforts: { [model]: 'high' }
          })
        );
        enter(p);
        const opened = p.posted.find((message) => message.type === 'open');
        assert.ok(opened);
        assert.equal(opened.target?.brand ?? 'claude', brand);
        assert.equal(opened.target?.model, model);
        assert.equal(opened.target?.window, window);
        assert.equal(opened.target?.effort, expected);
      });
    }
  }

  for (const source of ['saved', 'explicit', 'unavailable']) {
    it(`reconciles ${source} effort with newly advertised capabilities`, (t) => {
      const p = openPanel(t);
      const model: ModelView = {
        brand: 'codex',
        value: 'gpt-6.1-sol',
        id: 'gpt-6.1-sol',
        name: 'Sol 6.1',
        window: 475_000,
        efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
        defaultEffort: 'medium'
      };
      const config = {
        defaultCwd: CWD,
        model: model.value,
        efforts: { [model.value]: source === 'explicit' ? 'high' : 'low' }
      };
      p.push(
        stateMessage(board(), {
          ...config,
          models: source === 'unavailable' ? [{ ...model, efforts: undefined }] : [model]
        })
      );
      typeIn(p, 'inspect the parser');
      if (source === 'explicit') {
        p.window.document.querySelector<HTMLElement>('#ctools .fpill.effort')?.click();
        const low = [
          ...p.window.document.querySelectorAll<HTMLElement>('#ctools .fmenu .mitem')
        ].find((row) => row.querySelector('.nm')?.textContent === 'low');
        assert.ok(low);
        low.click();
      }
      p.push(
        stateMessage(board(), {
          ...config,
          efforts: { [model.value]: 'medium' },
          models: [
            { ...model, efforts: [{ value: 'high' }, { value: 'medium' }], defaultEffort: 'high' }
          ]
        })
      );
      assert.equal(
        p.window.document.querySelector('#ctools .fpill.effort .nm')?.textContent,
        'medium'
      );
      enter(p);
      const opened = p.posted.find((message) => message.type === 'open');
      assert.ok(opened);
      assert.equal(opened.target?.effort, 'medium');
    });
  }

  it('keeps an explicit effort through missing and incomplete catalogs', (t) => {
    const p = openPanel(t);
    const model: ModelView = {
      brand: 'codex',
      value: 'gpt-6.1-sol',
      id: 'gpt-6.1-sol',
      name: 'Sol 6.1',
      window: 475_000,
      efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
      defaultEffort: 'medium'
    };
    const config = { defaultCwd: CWD, model: model.value, efforts: { [model.value]: 'high' } };
    p.push(stateMessage(board(), { ...config, models: [model] }));
    typeIn(p, 'inspect the parser');
    p.window.document.querySelector<HTMLElement>('#ctools .fpill.effort')?.click();
    const low = [...p.window.document.querySelectorAll<HTMLElement>('#ctools .fmenu .mitem')].find(
      (row) => row.querySelector('.nm')?.textContent === 'low'
    );
    assert.ok(low);
    low.click();
    p.push(stateMessage(board(), config));
    p.push(
      stateMessage(board(), {
        ...config,
        models: [{ ...model, efforts: undefined, defaultEffort: undefined }]
      })
    );
    p.push(stateMessage(board(), { ...config, models: [model] }));
    assert.equal(p.window.document.querySelector('#ctools .fpill.effort .nm')?.textContent, 'low');
    enter(p);
    const opened = p.posted.find((message) => message.type === 'open');
    assert.ok(opened);
    assert.equal(opened.target?.effort, 'low');
  });

  it('paints a composer rather than the vacant plate', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    assert.ok(chat(p).classList.contains('empty'), 'the tab still describes a session');
    assert.ok(chat(p).classList.contains('start'), 'the composer is still out of the flow');
    assert.match(
      p.window.document.querySelector('#thread .vacant h3')?.textContent ?? '',
      /New session in/,
      'the block does not name the folder the session will run in'
    );
    // The one control a draft decides with, and the send it will make.
    // No protocol field changed. The verb is the accessible name.
    assert.ok(p.window.document.querySelector('#ctools .fpill.model'), 'no model pill');
    const send = p.window.document.getElementById('send');
    assert.equal(send?.getAttribute('aria-label'), 'Start');
    assert.equal(send?.textContent, '');
    assert.deepEqual(
      [...(send?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d')),
      ['m5 12 7-7 7 7', 'M12 19V5']
    );
    assert.match(
      p.window.document.querySelector('.hintkeys')?.textContent ?? '',
      /start · ⇧↵ newline/
    );
  });

  it('keeps the watermark behind the draft, with no mark over the words', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    const d = p.window.document;
    assert.equal(
      d.querySelector('#thread .vacant')?.firstElementChild?.tagName,
      'H3',
      'something is drawn over the draft'
    );
    const chat = d.getElementById('chat');
    assert.ok(chat);
    assert.match(
      p.window.getComputedStyle(chat).backgroundImage,
      /^url\("data:image\/svg\+xml/,
      'the draft hides the watermark'
    );
  });

  it('seats the prompt and holds the box while the start is in flight', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    sendDraft(p, 'a first turn', CWD);
    const d = p.window.document;
    const shown = (id: string): string =>
      p.window.getComputedStyle(d.getElementById(id) as HTMLElement).display;

    assert.ok(chat(p).classList.contains('starting'), 'no starting state');
    assert.equal(chat(p).classList.contains('start'), false, 'still offering to start');
    assert.equal(shown('chat-head'), 'none', 'startup feedback still occupies the header');
    assert.match(d.querySelector('#chat-startup .start-note')?.textContent ?? '', /^Starting in /);
    assert.ok(d.querySelector('#chat-startup .spinner'), 'no startup spinner');
    assert.ok(d.querySelector('#chat-startup [data-startup="status"]'));
    assert.ok(d.querySelector('#chat-startup [data-startup="cancel"]'));

    const first = d.querySelector('#thread')?.firstElementChild;
    assert.ok(first?.matches('.turn.user'), 'the prompt is not the first turn');
    assert.equal(first?.querySelector('.body')?.textContent, 'a first turn');
    assert.equal(d.querySelector('#thread .vacant'), null, 'the vacant block is still up');

    assert.notEqual(shown('composer'), 'none', 'the box was taken away');
    assert.ok(composerDisabled(p), 'the box would take a second prompt');
    assert.equal(d.getElementById('send')?.getAttribute('aria-label'), 'Starting');
    assert.equal(d.getElementById('send')?.textContent, '');
    assert.ok(d.querySelector('#send .spinner'), 'no spinner in the button');
    assert.equal(d.querySelector('#send svg'), null, 'the arrow stays beside the spinner');
    assert.match(d.querySelector('.hintkeys')?.textContent ?? '', /starting · ⇧↵ newline/);
  });

  /** A stray repaint for the session the reader left — a `sendResult` landing
   *  after a close is the one that bites — must not wipe a draft mid-sentence. */
  it('survives a repaint for the session that was there before', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board([cardView({ pid: 4, owned: true })])));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    newDraft(p, CWD);
    typeIn(p, 'half a thought');
    p.push({ type: 'sendResult', pid: 4, ok: true });
    assert.ok(chat(p).classList.contains('start'), 'the repaint took the draft down');
    assert.equal(composerValue(p), 'half a thought');
  });

  /** Leaving for the backlog and coming back is not leaving the draft. */
  it('comes back to the draft off the tickets tab', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    typeIn(p, 'still here');
    p.window.document.getElementById('board-tickets')?.click();
    p.window.document.getElementById('board-sessions')?.click();
    assert.ok(chat(p).classList.contains('start'), 'the backlog lost the draft');
    assert.equal(composerValue(p), 'still here');
  });

  /** Selecting a card leaves the draft; New brings it back with its text. */
  it('keeps the draft when a card is selected, and gives it back', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board([cardView({ pid: 4, owned: true })])));
    newDraft(p, CWD);
    typeIn(p, 'kept');
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    assert.equal(chat(p).classList.contains('start'), false, 'the draft stayed up over a card');
    newDraft(p, CWD);
    assert.equal(composerValue(p), 'kept');
  });

  it('takes the mark off the slot when nothing was typed into the draft', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board([cardView({ pid: 4, owned: true })])));
    newDraft(p, CWD);
    assert.ok(
      p.window.document.querySelector('.card.add.drafting'),
      'the slot did not mark the draft being written'
    );
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    assert.equal(
      p.window.document.querySelector('.card.add.drafting'),
      null,
      'selecting a card left the slot lit over an empty draft'
    );
  });

  /** Opening a draft tells the host nothing is selected — the same message a
   *  close already posts, which `panel.ts` maps to no selection. */
  it('deselects at the host when it takes the dock off a session', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board([cardView({ pid: 4, owned: true })])));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    newDraft(p, CWD);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'select', pid: 0 });
  });

  /**
   * The launcher is the composer's, and a draft's composer writes to no
   * session — so the question another session is blocked on must not be left
   * standing over it, offering an answer from a surface that cannot give one.
   */
  it('takes the launcher down with the session the draft replaced', (t) => {
    const p = openPanel(t);
    const groups = board([cardView({ pid: 4, owned: true })]);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 4, pending: [askRequest()] }) }));
    const launcher = (): HTMLElement => p.window.document.getElementById('qlaunch') as HTMLElement;
    assert.equal(launcher().hidden, false, 'the blocked session had no launcher to leave');
    newDraft(p, CWD);
    assert.equal(launcher().hidden, true, 'the draft kept the other session\u2019s launcher');
  });

  /**
   * And it stays down. `settleSent` is the one door to the layer that does not
   * come through `renderThread` — which turns a repaint for a session the
   * reader left into the empty state they are on — so a refusal landing after
   * the New drew that session's launcher back over the draft's composer. The
   * press it answers is not what repaints, so this needs none.
   */
  it('keeps it down when a refused answer lands after the New', (t) => {
    const p = openPanel(t);
    const groups = board([cardView({ pid: 4, owned: true })]);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    p.push(
      stateMessage(groups, { thread: threadView({ pid: 4, pending: [permissionRequest()] }) })
    );
    newDraft(p, CWD);
    typeIn(p, 'half a thought');
    p.push({
      type: 'respondResult',
      pid: 4,
      startedAt: 4_000,
      requestId: 'req-1',
      ok: false,
      reason: 'session ended'
    });
    assert.equal(
      (p.window.document.getElementById('qlaunch') as HTMLElement).hidden,
      true,
      'the refusal put the other session\u2019s launcher back over the draft'
    );
    assert.ok(chat(p).classList.contains('start'), 'the refusal took the draft down');
    assert.equal(composerValue(p), 'half a thought');
  });

  /**
   * The permission mode lives in the tool row, and the branch is not painted
   * in the dock. On a draft there is no session, so the mode the last session
   * showed must not stay. No protocol field changed.
   */
  it('leaves no branch or permission mode from the session it replaced', (t) => {
    const branch = 'feature/kettle-9f3';
    const p = openPanel(t);
    const groups = board([cardView({ pid: 4, owned: true })]);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="4"]')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({
          pid: 4,
          branch,
          mode: { label: 'acceptEdits', holds: false, bypass: false }
        })
      })
    );
    const dock = (): string => p.window.document.getElementById('dock')?.textContent ?? '';
    const mode = (): Element | null => p.window.document.querySelector('#ctools .mode');
    assert.equal(p.window.document.getElementById('cstatus'), null);
    assert.equal(dock().includes(branch), false);
    assert.match(mode()?.textContent ?? '', /acceptEdits/, 'the session had no mode to leave');
    newDraft(p, CWD);
    assert.equal(mode(), null, 'the draft kept the permission mode of the session it replaced');
    assert.equal(dock().includes(branch), false);
  });

  // The draft's paint clears the mode the session left, which is what the
  // scenario above pins. `renderDraft` replaces the thread, so a queue block
  // cannot survive into a draft either.

  /** And nothing to deselect posts nothing: a second New while a draft is
   *  already up must not tell the host something it has already been told. */
  it('posts nothing when there was no session to leave', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    newDraft(p, CWD);
    newDraft(p, CWD);
    assert.deepEqual(p.posted, []);
  });
});

describe('dock acknowledgement', () => {
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    it(`posts seen once per pid and update on ${type}, for unread and attention`, (t) => {
      const p = openPanel(t);
      const push = (pid: number, updatedAt: number, attention = false): void => {
        const card = cardView({
          pid,
          updatedAt,
          ...(attention ? { status: 'waiting', attention: true } : { unseen: true })
        });
        p.push(stateMessage([groupView({ sessions: [card] })], { thread: threadView(card) }));
      };
      push(5, 100);
      const doc = p.window.document;
      doc.querySelector<HTMLElement>('.card')?.click();
      assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 5 }]);
      const act = (): void => {
        doc.getElementById('dock')?.dispatchEvent(new p.window.Event(type, { bubbles: true }));
      };
      act();
      act();
      assert.deepEqual(
        p.posted.filter((m) => m.type === 'seen'),
        [{ type: 'seen', pid: 5 }]
      );
      push(5, 100);
      act();
      assert.equal(p.posted.filter((m) => m.type === 'seen').length, 1);
      push(5, 101, true);
      act();
      act();
      assert.equal(p.posted.filter((m) => m.type === 'seen').length, 2);
      push(6, 101, true);
      doc.querySelector<HTMLElement>('.card')?.click();
      act();
      assert.deepEqual(p.posted.at(-1), { type: 'seen', pid: 6 });
    });
    it(`posts nothing on ${type} when the open card has no unread or attention`, (t) => {
      const p = openThread(t, threadView());
      p.window.document
        .getElementById('dock')
        ?.dispatchEvent(new p.window.Event(type, { bubbles: true }));
      assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 101 }]);
    });
  }
});
