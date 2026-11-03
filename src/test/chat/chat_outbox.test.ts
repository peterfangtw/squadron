import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  newDraft,
  assertedMessageBody,
  cardView,
  groupView,
  openPanel,
  openThread,
  stateMessage,
  threadView
} from '../harness';

describe('the outbox', () => {
  it('shows held messages in a pinned queue block with dismiss', (t) => {
    const thr = threadView({ status: 'busy', queued: [{ id: 'q1', text: 'later' }] });
    const p = openThread(t, thr);
    const block = p.window.document.querySelector('#thread .outbox');
    assert.ok(block, 'held outbox is a .outbox');
    // Not .qblock: that name belongs to the ask layer, and sharing it let a
    // later rule take the outbox's flex and margin away.
    assert.equal(p.window.document.querySelector('#thread .qblock'), null);
    const turn = block?.querySelector('.turn.queued');
    assert.ok(turn?.textContent?.includes('queued'));
    assert.equal(turn?.querySelector('.body')?.textContent, 'later');
    assert.ok(block?.querySelector('.qbar'), 'subheader with count / send now');
    const dismiss = [...(block?.querySelectorAll<HTMLButtonElement>('.qact') ?? [])].find(
      (b) => b.textContent === 'Dismiss'
    );
    dismiss?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'dismissQueued',
      pid: thr.pid,
      id: 'q1'
    });
  });

  it('confirms send-now on the queue bar before posting', (t) => {
    const thr = threadView({
      status: 'busy',
      queued: [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' }
      ]
    });
    const p = openThread(t, thr);
    const send = [...p.window.document.querySelectorAll<HTMLButtonElement>('.qbar .qact')].find(
      (b) => b.textContent === 'Send now'
    );
    assert.ok(send);
    const before = p.posted.length;
    send?.click();
    assert.equal(p.posted.length, before, 'confirm is local — no post yet');
    const go = [...p.window.document.querySelectorAll<HTMLButtonElement>('.qbar .qact')].find(
      (b) => b.textContent === 'Confirm'
    );
    go?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'sendNow', pid: thr.pid });
  });

  it('disarms send-now when the reader leaves for New, so returning is not one click from a stop', (t) => {
    // The confirm belonged to a module `let` that only `renderThread` cleared,
    // and opening a draft does not go through it. Re-selecting the session
    // then drew the bar already confirming, with Confirm under the cursor.
    const thr = threadView({ status: 'busy', queued: [{ id: 'a', text: 'one' }] });
    const p = openThread(t, thr);
    const armed = (): boolean => !!p.window.document.querySelector('#thread .qbar.conf');
    [...p.window.document.querySelectorAll<HTMLButtonElement>('.qbar .qact')]
      .find((b) => b.textContent === 'Send now')
      ?.click();
    assert.equal(armed(), true, 'armed');

    newDraft(p);
    const groups = [groupView({ sessions: [cardView({ pid: thr.pid })] })];
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: thr }));
    assert.equal(armed(), false, 'reopened unarmed');
    assert.ok(
      [...p.window.document.querySelectorAll('.qbar .qact')].some(
        (b) => b.textContent === 'Send now'
      ),
      'and back to offering it'
    );
  });

  it('says what an image-only held message is carrying, rather than drawing blank', (t) => {
    // A paste with no prose is a legal send: `panel.send` takes it as long as
    // there are blocks. The row has no text to quote, and the count is all this
    // side has — the bytes stay in the window that holds the pipe.
    const p = openThread(
      t,
      threadView({ status: 'busy', queued: [{ id: 'q1', text: '', images: 2 }] })
    );
    const turn = p.window.document.querySelector('#thread .outbox .turn.queued');
    assert.ok(turn);
    assert.equal(turn?.querySelector('.body p, .body ul, .body pre'), null, 'nothing to quote');
    assert.equal(turn?.querySelector('.qshots')?.textContent, '2 images');
  });

  /**
   * The outbox says the agent has your message and has not taken it. On an idle
   * session that is false: `statusOf` and `canDrain` agree, and a child that
   * exits empties `queued` outright, so an idle thread holding anything is
   * holding it behind one of *our* latches for the length of one git spawn.
   * Drawn amber, a message already on its way reads as one the agent is
   * sitting on. Every scenario above this one is `busy`, which is how the
   * block's premise could quietly stop being true.
   */
  it('draws an idle session’s held message as sent rather than queued', (t) => {
    const p = openThread(
      t,
      threadView({ status: 'idle', queued: [{ id: 'q1', text: 'ship it' }] })
    );
    assert.equal(p.window.document.querySelector('#thread .outbox'), null, 'no amber block');
    const turn = p.window.document.querySelector('#thread .turn.user.sending');
    assert.equal(turn?.querySelector('.body')?.textContent, 'ship it');
    // The whole point of the rail: no `queued` class, so nothing paints amber
    // over it and no row offers a Dismiss for a message already being written.
    assert.equal(p.window.document.querySelector('#thread .turn.queued'), null);
    assert.equal(p.window.document.querySelector('#thread .qbar'), null);
    // A turn has been asked for and nothing has come back, which is what the
    // dots say. The block used to carry that reading in its own words.
    assert.ok(p.window.document.querySelector('#thread .turn .working'), 'no dots');
  });

  it('keeps the block for a busy session, so the gate is not “never draw”', (t) => {
    const p = openThread(
      t,
      threadView({ status: 'busy', queued: [{ id: 'q1', text: 'ship it' }] })
    );
    assert.ok(p.window.document.querySelector('#thread .outbox .turn.queued'));
    assert.match(
      p.window.document.querySelector('#thread .qbar .lbl')?.textContent ?? '',
      /^1 held/
    );
  });

  it('keeps the block for a second idle-held row, which is one behind a wall', (t) => {
    // Idle does not mean "all of this is going out". `mergeQueued` stops at a
    // walled entry and releases only the run in front of it, so a second row on
    // an idle thread is never one the drain is writing — and telling the reader
    // it was sent is the same lie the amber block used to tell about the first
    // one. The rule here is the count and nothing else: `QueuedView` carries no
    // `command`, so the view cannot see a wall and does not need to. The
    // `/effort` text is what the host's own walled row holds, not what makes
    // this one count as two.
    const p = openThread(
      t,
      threadView({
        status: 'idle',
        queued: [
          { id: 'a', text: 'mine' },
          { id: 'b', text: '/effort high' }
        ]
      })
    );
    assert.ok(p.window.document.querySelector('#thread .outbox'), 'the block still stands');
    assert.equal(p.window.document.querySelectorAll('#thread .outbox .turn.queued').length, 2);
    assert.equal(p.window.document.querySelector('#thread .turn.user.sending'), null);
  });

  it('drops a send-now confirm when the block it was armed in goes', (t) => {
    // The confirm used to die with an empty queue, which stopped being the same
    // thing as dying with its block. Left standing it comes back armed the
    // moment the next turn opens — "Stop turn & send?" about a turn nobody had
    // in front of them when they pressed. `composer.ts` states the same rule
    // for the arming slot next door.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const one = [{ id: 'a', text: 'one' }];
    const p = openThread(t, threadView({ status: 'busy', queued: one }));
    const armed = (): boolean => !!p.window.document.querySelector('#thread .qbar.conf');
    [...p.window.document.querySelectorAll<HTMLButtonElement>('.qbar .qact')]
      .find((b) => b.textContent === 'Send now')
      ?.click();
    assert.equal(armed(), true, 'armed');

    // The turn ends and the drain takes that row: the block goes with it.
    p.push(stateMessage(groups, { thread: threadView({ status: 'idle', queued: one }) }));
    assert.equal(p.window.document.querySelector('#thread .outbox'), null);

    // A turn opens with the row still held, and the block comes back unarmed.
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', queued: one }) }));
    assert.ok(p.window.document.querySelector('#thread .outbox'), 'the block is back');
    assert.equal(armed(), false, 'a confirm outlived its block');
  });

  it('keeps the block for a row waiting behind a turn already released', (t) => {
    // `dequeueHead` moves the head into `sending` and does **not** set
    // `running`, so between our write and the CLI's first frame the thread is
    // idle with the next turn's message still queued. One row, and still not
    // one the drain is writing: `sending` is what says so.
    const p = openThread(
      t,
      threadView({
        status: 'idle',
        sending: [{ id: 'a', text: 'mine' }],
        queued: [{ id: 'b', text: 'behind it' }]
      })
    );
    assert.ok(p.window.document.querySelector('#thread .outbox .turn.queued'));
    assert.equal(
      p.window.document.querySelector('#thread .turn.user.sending .body')?.textContent,
      'mine',
      'the released turn is the only one drawn as sent'
    );
  });

  it('still says what an idle-held image-only message is carrying', (t) => {
    const p = openThread(
      t,
      threadView({ status: 'idle', queued: [{ id: 'q1', text: '', images: 2 }] })
    );
    const turn = p.window.document.querySelector('#thread .turn.user.sending');
    assert.ok(turn);
    assert.equal(turn?.querySelector('.body p, .body ul, .body pre'), null, 'nothing to quote');
    assert.equal(turn?.querySelector('.qshots')?.textContent, '2 images');
  });

  it('names the author of an idle-held row nobody at this keyboard wrote', (t) => {
    // The rail and the crumb are what the busy block already draws for a peer's
    // row, and they are the reader's only account of who wrote it. Losing them
    // to the new rendering would be the same bug the outbox already fixed once.
    const p = openThread(
      t,
      threadView({
        status: 'idle',
        queued: [{ id: 'b', text: 'take this one', from: 'sess-abcdef01' }]
      })
    );
    const turn = p.window.document.querySelector('#thread .turn.user.peer.sending');
    assert.equal(turn?.querySelector('.body')?.textContent, 'take this one');
    assert.equal(turn?.querySelector('.who .attr')?.textContent, 'sess-abc');
  });

  it('draws each message of a merged delivery as its own sending row, under its author', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();

    const sending = [
      { id: 'p', text: 'from a peer', from: 'sess-abcdef12' },
      { id: 'w', text: 'All 1 finished.', role: 'wait' as const },
      { id: 'a', text: 'and mine' }
    ];
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', sending }) }));
    const rows = [...p.window.document.querySelectorAll('#thread .turn.sending')];
    assert.deepEqual(
      rows.map((row) => [
        row.querySelector('.who')?.childNodes[0]?.textContent,
        row.querySelector('.body')?.textContent
      ]),
      [
        ['peer', 'from a peer'],
        ['wait', 'All 1 finished.'],
        ['you', 'and mine']
      ]
    );
    assert.ok(!p.window.document.querySelector('#thread')?.textContent?.includes('<squadron'));

    // Every row retired: the host sends no list at all, and nothing is left
    // waiting on a reply that has already come.
    const turns: ExchangeView[] = [
      {
        role: 'user',
        text: 'from a peer',
        from: 'sess-abcdef12',
        blocks: [{ prose: 'from a peer' }]
      },
      { role: 'wait', text: 'All 1 finished.', blocks: [{ html: '<p>All 1 finished.</p>' }] },
      { role: 'user', text: 'and mine', blocks: [{ prose: 'and mine' }] },
      { role: 'assistant', text: 'read all three', blocks: [{ html: '<p>read all three</p>' }] }
    ];
    p.push(stateMessage(groups, { thread: threadView({ status: 'idle', exchanges: turns }) }));
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('names the author of an outbox row nobody at this keyboard wrote', (t) => {
    // A resolution and a peer's message are held and drained like any other
    // send, and neither is the reader's. Drawn as theirs, the label is wrong
    // and the message sits in the row with it. Both were, until this.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({
          status: 'busy',
          queued: [{ id: 'b', text: 'take this one', from: 'sess-abcdef01' }],
          sending: [{ id: 'a', text: 'All 2 of them finished.', role: 'wait' }]
        })
      })
    );

    const woke = p.window.document.querySelector('#thread .turn.sending');
    assert.equal(woke?.querySelector('.who')?.textContent, 'wait');
    assert.equal(woke?.querySelector('.body')?.textContent, 'All 2 of them finished.');

    const peer = p.window.document.querySelector('#thread .turn.queued');
    assert.match(peer?.querySelector('.who')?.textContent ?? '', /^peer/);
    assert.equal(peer?.querySelector('.attr')?.textContent, 'sess-abc');
    assert.equal(peer?.querySelector('.body')?.textContent, 'take this one');
  });
});
