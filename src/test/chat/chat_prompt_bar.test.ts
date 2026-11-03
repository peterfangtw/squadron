import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  openThread,
  stateMessage,
  threadView,
  Panel
} from '../harness';

describe('the prompt bar', () => {
  const asks = (): ExchangeView[] => [
    { role: 'user', text: 'first ask', blocks: [{ prose: 'first ask' }] },
    { role: 'assistant', text: 'a', blocks: [{ html: '<p>a</p>' }] },
    { role: 'user', text: 'second ask', blocks: [{ prose: 'second ask' }] },
    { role: 'assistant', text: 'b', blocks: [{ html: '<p>b</p>' }] },
    { role: 'user', text: 'third ask', blocks: [{ prose: 'third ask' }] }
  ];

  /** Five prompts, so the thread has a tail long enough to run past a ceiling
   *  — or, once the room is measured, long enough to need one. */
  const five = (): ExchangeView[] =>
    ['first', 'second', 'third', 'fourth', 'fifth'].flatMap((n): ExchangeView[] => [
      { role: 'user', text: `${n} ask`, blocks: [{ prose: `${n} ask` }] },
      { role: 'assistant', text: 'reply', blocks: [{ html: '<p>reply</p>' }] }
    ]);

  const bar = (p: Panel): HTMLElement => {
    const node = p.window.document.getElementById('prompt-bar');
    assert.ok(node, 'no prompt bar in the dock');
    return node;
  };

  const part = (p: Panel, selector: string): string =>
    bar(p).querySelector(selector)?.textContent ?? '';

  const arrow = (p: Panel, which: '.up' | '.dn'): HTMLButtonElement => {
    const node = bar(p).querySelector<HTMLButtonElement>(which);
    assert.ok(node, `no ${which} arrow on the prompt bar`);
    return node;
  };

  /**
   * Where the prompts sit inside the thread. jsdom lays nothing out, so every
   * `offsetTop` is 0 and scroll-derived behaviour has no ruler until one is
   * lent to it. Only the ruler is fake — the arithmetic under test is the real
   * one, and `scrollTop` and `scroll` events are jsdom's own.
   */
  function layout(p: Panel, tops: number[], heights = tops.map(() => 100)): void {
    const turns = p.window.document.querySelectorAll<HTMLElement>('#thread .turn.user');
    assert.equal(turns.length, tops.length, 'the layout does not match the prompts on screen');
    assert.equal(heights.length, tops.length, 'the layout does not match the prompt heights');
    turns.forEach((turn, i) => {
      Object.defineProperty(turn, 'offsetTop', { value: tops[i], configurable: true });
      Object.defineProperty(turn, 'offsetHeight', { value: heights[i], configurable: true });
    });
  }

  /** Scroll the thread the way a reader does, event and all. */
  function scrollTo(p: Panel, top: number): void {
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    thread.scrollTop = top;
    thread.dispatchEvent(new p.window.Event('scroll'));
  }

  /**
   * The ceiling a real scroller has and jsdom does not: `scrollTop` stops at
   * `scrollHeight - clientHeight`. `max` is what the conversation alone affords
   * — the content, and the 12px under it — so a prompt further down than that
   * cannot be lifted to the top of the thread, which is the whole of what this
   * bug was.
   *
   * The trailing room is *not* installed on top of it. `scrollHeight` reads the
   * `--room` the panel wrote for itself, so the ceiling a scenario runs against
   * is the one the panel's own arithmetic produced: lend the ruler, and what it
   * measures is the real thing. A scenario that wants the room real lets a
   * `poll` land after this, because the room is measured on a paint and a ruler
   * lent after the last one has never been read.
   */
  function ceiling(p: Panel, max: number): void {
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    // Where the reader is now, not 0: a scenario raises the ceiling a second
    // time to grow the conversation under them, and a ruler that forgot the
    // position would be posing a different case than it says.
    let top = thread.scrollTop;
    const view = 400;
    const room = (): number => parseFloat(thread.style.getPropertyValue('--room')) || 0;
    Object.defineProperty(thread, 'clientHeight', { value: view, configurable: true });
    Object.defineProperty(thread, 'scrollHeight', {
      configurable: true,
      get: () => max + view + room()
    });
    Object.defineProperty(thread, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (to: number) => {
        top = Math.max(0, Math.min(max + room(), to));
      }
    });
  }

  /** The 3s repaint, which is where the panel measures its own geometry. */
  function poll(p: Panel, thread: ThreadView): void {
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: thread.pid })] })], { thread }));
  }

  /** `thread` with one more assistant turn on the end. Assistant, so the
   *  prompts the layout was lent for are the same prompts. */
  const said = (thread: ThreadView, text: string): ThreadView => ({
    ...thread,
    exchanges: [
      ...thread.exchanges,
      { role: 'assistant', text, blocks: [{ html: `<p>${text}</p>` }] }
    ]
  });

  /** What a `fit` leaves on screen: the conversation, plus the reply the poll
   *  that measured the room brought with it. Polling these again is the repaint
   *  that moves nothing — thirty a minute, and what most of them are. */
  const settled = (thread: ThreadView): ThreadView => said(thread, 'more');

  /** And the repaint that does move something: one turn past a `settled` one. */
  const grown = (thread: ThreadView): ThreadView => said(settled(thread), 'later');

  /**
   * Lend the ruler and let it be read: layout, ceiling, and a poll that
   * measures the room against them.
   *
   * The poll brings a reply with it, because only a paint that moved a turn
   * re-measures — the one that brings the same turns back reads no layout at
   * all, which is thirty polls a minute that cost nothing.
   */
  function fit(p: Panel, thread: ThreadView, tops: number[], max: number): void {
    layout(p, tops);
    ceiling(p, max);
    poll(p, settled(thread));
  }

  /** What the panel asked the stylesheet for, in pixels. */
  const roomOf = (p: Panel): number =>
    parseFloat(
      p.window.document.getElementById('thread')?.style.getPropertyValue('--room') ?? ''
    ) || 0;

  const threadTop = (p: Panel): number =>
    p.window.document.getElementById('thread')?.scrollTop ?? -1;

  /** Both ends of a divider drag with nothing between them. The end of one is
   *  where the thread takes the readings the drag skipped — `dockDrag`. */
  function dividerDrag(p: Panel): void {
    const w = p.window;
    w.document.getElementById('divider')?.dispatchEvent(new w.MouseEvent('mousedown'));
    w.dispatchEvent(new w.MouseEvent('mouseup'));
  }

  /**
   * The scroll event a browser fires for a write the panel made itself. jsdom
   * fires none, so an arrow step is never echoed back unless a test says so —
   * and whether the bar survives its own echo is the thing worth asking.
   */
  function echoScroll(p: Panel): void {
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    thread.dispatchEvent(new p.window.Event('scroll'));
  }

  it('stays out of the way while no prompt has scrolled off', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 0);
    assert.equal(bar(p).hidden, true);
  });

  it('names the prompt the visible replies belong to', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 350);
    assert.equal(bar(p).hidden, false);
    assert.equal(part(p, '.txt'), 'second ask');
    assert.equal(part(p, '.count'), '2/3');
  });

  it('steps over a turn a peer sent, which nobody here asked', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'user', text: 'first ask', blocks: [{ prose: 'first ask' }] },
          {
            role: 'user',
            from: 'sess-a1b2c3d4-and-more',
            text: 'take the review',
            blocks: [{ prose: 'take the review' }]
          },
          { role: 'assistant', text: 'a', blocks: [{ html: '<p>a</p>' }] },
          { role: 'user', text: 'second ask', blocks: [{ prose: 'second ask' }] }
        ]
      })
    );
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 350);
    assert.equal(part(p, '.txt'), 'first ask');
    assert.equal(part(p, '.count'), '1/2');
  });

  it('marks a prompt that is not the newest, and leaves the newest unmarked', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 350);
    assert.ok(bar(p).classList.contains('past'), 'reading history goes unmarked');
    scrollTo(p, 520);
    assert.equal(part(p, '.count'), '3/3');
    assert.equal(bar(p).classList.contains('past'), false);
  });

  it('steps back when the current prompt is partially visible', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 550);
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 300);
    assert.equal(part(p, '.txt'), 'second ask');
    assert.equal(part(p, '.count'), '2/3');
  });

  it('reveals an off-screen newest prompt before stepping back', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500], [80, 80, 80]);
    ceiling(p, 900);
    scrollTo(p, 900);
    assert.equal(part(p, '.count'), '3/3');
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 500);
    assert.equal(part(p, '.count'), '3/3');
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 300);
    assert.equal(part(p, '.count'), '2/3');
  });

  it('restores a prompt scrolled out above before stepping back again', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900], [80, 80, 80, 80, 80]);
    ceiling(p, 900);
    scrollTo(p, 500);
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '4/5');
    scrollTo(p, 850);
    assert.equal(part(p, '.count'), '4/5');
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 700);
    assert.equal(part(p, '.count'), '4/5');
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 500);
    assert.equal(part(p, '.count'), '3/5');
  });

  it('steps forward again on the down arrow', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 350);
    arrow(p, '.dn').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 500);
    assert.equal(part(p, '.txt'), 'third ask');
  });

  /**
   * A thread whose room has not caught up with it, and the bug this suite
   * exists to keep out. With the ceiling at 500 and no room measured onto it,
   * prompts four and five are unreachable by scroll: both land at 500 and so
   * does anything past it. Deriving the arrows from the thread alone stopped at
   * the last addressable prompt and left the button alive but inert.
   *
   * This was the standing condition of every thread's tail until `fitRoom`;
   * what is left of it is the beat between content shrinking under the last
   * prompt — a fold collapsing, a turn withdrawn — and the paint that
   * re-measures. The arrows have to carry the reader across it either way,
   * which is why these run without the room and the suite below runs with it.
   */
  it('steps through prompts the thread cannot scroll to the top', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    assert.equal(part(p, '.count'), '2/5');
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '3/5');
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '4/5');
    assert.equal(part(p, '.txt'), 'fourth ask');
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '5/5');
    assert.equal(part(p, '.txt'), 'fifth ask');
  });

  it('runs out of down only at the newest prompt', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    for (const at of ['3/5', '4/5']) {
      arrow(p, '.dn').click();
      assert.equal(part(p, '.count'), at);
      assert.equal(arrow(p, '.dn').disabled, false, `the arrow died at ${at}`);
    }
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '5/5');
    assert.equal(arrow(p, '.dn').disabled, true);
  });

  /**
   * A reader resting at the end of the conversation has reached every prompt,
   * so the bar names the newest rather than whichever one is standing at the
   * fold. This is what the arrows fall back to whenever they have no place of
   * their own — and what used to leave the count several prompts behind the
   * thread.
   */
  it('names the newest prompt once the thread can go no further', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 500);
    assert.equal(part(p, '.count'), '5/5');
    assert.equal(part(p, '.txt'), 'fifth ask');
    assert.equal(arrow(p, '.dn').disabled, true);
  });

  it('keeps its place through the scroll its own step fires', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    arrow(p, '.dn').click();
    arrow(p, '.dn').click();
    echoScroll(p);
    assert.equal(part(p, '.count'), '4/5');
  });

  it('gives the place back to the thread when the reader scrolls', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    arrow(p, '.dn').click();
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '4/5');
    scrollTo(p, 350);
    assert.equal(part(p, '.count'), '2/5', 'the bar outlived the place it stood on');
  });

  it('walks back down the tail after walking up it', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    arrow(p, '.dn').click();
    arrow(p, '.dn').click();
    arrow(p, '.dn').click();
    arrow(p, '.up').click();
    assert.equal(part(p, '.count'), '4/5');
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '5/5');
  });

  /**
   * Off to the backlog and back. `takePlace` stands the same session back where
   * it was, so the arrows keep their place too. It stops short of the newest
   * prompt deliberately: at the newest the thread alone would give the same
   * answer, and the test would pass without the place ever being kept.
   */
  it('keeps its place across a trip to the backlog and back', (t) => {
    const p = openThread(t, threadView({ exchanges: five() }));
    layout(p, [100, 300, 500, 700, 900]);
    ceiling(p, 500);
    scrollTo(p, 300);
    arrow(p, '.dn').click();
    arrow(p, '.dn').click();
    assert.equal(part(p, '.count'), '4/5');
    // The anchor `place` restores from is written by the scroll handler, so a
    // step only gets written down once the browser echoes it back. Without this
    // the trip restores the position the *reader* last scrolled to, two prompts
    // back, and the test would be asking about a thread nobody was looking at.
    echoScroll(p);
    p.window.document.getElementById('board-tickets')?.click();
    p.window.document.getElementById('board-sessions')?.click();
    assert.equal(part(p, '.count'), '4/5');
  });

  /**
   * The other half of the `dn` guard, which the ceiling scenarios above cannot
   * reach: a newest prompt the thread can still lift to the top has replies
   * below it, and the arrow is what runs through them.
   */
  it('keeps down alive at the newest prompt while its replies run on', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 500);
    assert.equal(part(p, '.count'), '3/3');
    assert.equal(arrow(p, '.dn').disabled, false, 'the replies below went unreachable');
    arrow(p, '.dn').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 900);
    assert.equal(part(p, '.count'), '3/3');
    assert.equal(arrow(p, '.dn').disabled, true);
  });

  it('has nowhere older to go when the whole conversation is there', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 150);
    assert.equal(part(p, '.count'), '1/3');
    assert.equal(arrow(p, '.up').disabled, true);
  });

  it('keeps up available until an off-screen oldest prompt is revealed', (t) => {
    const p = openThread(t, threadView({ exchanges: asks() }));
    layout(p, [100, 300, 500], [80, 80, 80]);
    ceiling(p, 900);
    scrollTo(p, 250);
    assert.equal(part(p, '.count'), '1/3');
    assert.equal(arrow(p, '.up').disabled, false);
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 100);
    assert.equal(part(p, '.count'), '1/3');
    assert.equal(arrow(p, '.up').disabled, true);
  });

  it('offers the reason there is nothing older when the history was cut', (t) => {
    const p = openThread(t, threadView({ truncated: true, exchanges: asks() }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 150);
    assert.equal(arrow(p, '.up').disabled, false, 'the cut notice is somewhere to go');
    arrow(p, '.up').click();
    assert.equal(p.window.document.getElementById('thread')?.scrollTop, 0);
    // Not a prompt, so it does not pretend to be one: no counter, no way up.
    assert.equal(part(p, '.tag'), 'start');
    assert.match(part(p, '.txt'), /file on disk/i);
    assert.equal(part(p, '.count'), '');
    assert.equal(arrow(p, '.up').disabled, true);
    arrow(p, '.dn').click();
    assert.equal(part(p, '.txt'), 'first ask');
  });

  it('says nothing about a single prompt beyond what it says', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [{ role: 'user', text: 'only ask', blocks: [{ prose: 'only ask' }] }]
      })
    );
    layout(p, [100]);
    ceiling(p, 900);
    scrollTo(p, 150);
    assert.equal(part(p, '.txt'), 'only ask');
    assert.equal(part(p, '.count'), '', 'a counter of one counts nothing');
    assert.equal(arrow(p, '.up').disabled, true);
  });

  it('drops the bar when another session is selected', (t) => {
    const p = openPanel(t);
    const groups = [
      groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202, name: 'other' })] })
    ];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, exchanges: asks() }) }));
    layout(p, [100, 300, 500]);
    ceiling(p, 900);
    scrollTo(p, 350);
    assert.equal(bar(p).hidden, false);
    p.window.document.querySelectorAll<HTMLElement>('.card')[1]?.click();
    assert.equal(bar(p).hidden, true, 'the bar outlived the thread it described');
  });

  /**
   * The room under the last turn, which is what makes every prompt addressable.
   * A prompt is liftable to the top only while its `offsetTop` is inside
   * `scrollHeight - clientHeight`, and the newest ones are not: nothing follows
   * them but their own replies. So the thread carries trailing space sized to
   * exactly that shortfall, and the end of the *content* — not the end of the
   * scroller — stays where the thread rests.
   *
   * The tail here is five prompts, the last of them 900 down a conversation
   * whose own height affords 500 of scroll: a 400px shortfall, which is the
   * room.
   */
  describe('the room under the last turn', () => {
    it('lifts the newest prompt to the top of the thread', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 300);
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      assert.equal(part(p, '.count'), '5/5');
      assert.equal(threadTop(p), 900, 'the newest prompt could not reach the top');
    });

    /** The reported bug, in the arrow it was reported through: near the end, up
     *  scrolled far enough to make the prompt visible and no further. */
    it('puts the prompt the up arrow names at the top, not merely on screen', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 300);
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      arrow(p, '.up').click();
      assert.equal(part(p, '.count'), '4/5');
      assert.equal(threadTop(p), 700, 'the fourth prompt sat below the fold');
      arrow(p, '.up').click();
      assert.equal(threadTop(p), 500);
    });

    /** Exactly the shortfall. One pixel more is blank nobody asked for, one
     *  less and the newest prompt is still short of the top. */
    it('is the shortfall and nothing besides', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      assert.equal(roomOf(p), 400);
      const thread = p.window.document.getElementById('thread');
      assert.ok(thread);
      assert.equal(
        thread.scrollHeight - thread.clientHeight,
        900,
        'the last prompt is not the last addressable pixel'
      );
    });

    /** A newest reply that already fills the view lifts its own prompt, so
     *  there is nothing to make room for. Every long thread is this one. */
    it('adds none when the newest reply already fills the view', (t) => {
      const view = threadView({ exchanges: asks() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500], 900);
      assert.equal(roomOf(p), 0);
    });

    /** Nothing has scrolled off a thread that fits, the bar stays away, and
     *  room would invent a scroll where the reader has no fold. */
    it('adds none to a thread that does not scroll', (t) => {
      const view = threadView({ exchanges: asks() });
      const p = openThread(t, view);
      fit(p, view, [12, 120, 240], 0);
      assert.equal(roomOf(p), 0);
      scrollTo(p, 0);
      assert.equal(bar(p).hidden, true);
    });

    /**
     * A thread that came back with nothing in it is a notice, and a notice has
     * no prompt to make room for. Left standing, the room the conversation
     * needed is up to a viewport of padding under a single line.
     */
    it('gives the room back when the conversation goes', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      assert.equal(roomOf(p), 400);
      poll(p, { ...view, exchanges: [] });
      assert.equal(roomOf(p), 0, 'a notice kept a viewport of padding under one line');
    });

    /** Where a thread with nothing written down opens, and where one whose
     *  anchors have all gone lands: the last turn, not the blank under it. */
    it('stands a returning reader on the last turn, not in the room', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      p.window.document.getElementById('board-tickets')?.click();
      p.window.document.getElementById('board-sessions')?.click();
      assert.equal(threadTop(p), 500, 'the restore parked the reader in the blank');
    });

    /** The pin still means the tail, and the tail is the end of the content.
     *  A reader 20px above it is following, and the settle puts them on it. */
    it('follows the tail to the last turn when a drag settles', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 480);
      dividerDrag(p);
      assert.equal(threadTop(p), 500);
    });

    /**
     * The bug the room arrived with, and the reason `repin` had to be told
     * whether anything moved. A reader who scrolls into the room is standing
     * somewhere they chose; a repaint that brings back the turns it brought
     * last time has learned nothing that could argue with them. It used to
     * anyway — thirty times a minute — so the room could be scrolled into and
     * never stayed in.
     */
    it('leaves a reader in the room where a repaint that moved nothing finds them', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      poll(p, settled(view));
      assert.equal(threadTop(p), 900, 'a poll that brought nothing new moved the reader');
    });

    /**
     * The other half, and the one that keeps the guard above from being a
     * following session that stopped following: the same reader, the same
     * place, and a poll that does bring a turn to a session still working. Now
     * there is something below them, so the tail is worth catching them up to —
     * which is what makes standing in the room safe rather than a way to be
     * stranded in it.
     */
    it('follows the tail for a reader in the room once a working session speaks', (t) => {
      const view = threadView({ exchanges: five(), status: 'busy' });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      poll(p, grown(view));
      assert.equal(threadTop(p), 500, 'a new turn left the reader behind in the blank');
    });

    /**
     * And the same growth on a card that is not working, which is a different
     * thing wearing the same shape. The panel's record goes on catching up with
     * the sends above it for seconds after the status flips back — a reply's
     * body arrives, and the conversation is longer than it was — so growth
     * alone moved a parked reader on a session saying IDLE. Found in a host at
     * 422px, and it is the complaint this whole fix is about.
     */
    it('leaves a reader in the room when an idle record catches up', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      poll(p, grown(view));
      assert.equal(threadTop(p), 900, 'a settling record moved the reader to the end');
    });

    /**
     * A turn going away is not something to follow, and a host is where that
     * was learned: the panel reconciles its own record, an empty assistant
     * shell went away under a parked reader, and the repaint that took it
     * counted as a reason to put them back at the end. `repin` asks whether the
     * session has *said* more than it had, and a turn going away is the
     * conversation getting shorter.
     */
    it('leaves a reader in the room when a turn goes away under them', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      // The reply `fit`'s own poll brought, taken back off again.
      poll(p, view);
      assert.equal(threadTop(p), 900, 'a turn going away moved the reader to the end');
    });

    /**
     * Opening a fold is not the session speaking. It puts turns back — the ones
     * the row was hiding — so a reading taken off the *turn list* counted it as
     * the conversation growing and stood a parked reader at the end for a press
     * that was about something else entirely. `t.exchanges` does not move for
     * it, which is the whole reason the reading is taken there.
     *
     * The fold is the last thing in the thread so that the prompts above it
     * survive the repaint with the offsets this suite lent them: `paint` keeps
     * the unchanged head and rebuilds from the divergence down.
     */
    it('leaves a reader in the room when they open a fold', (t) => {
      const view = threadView({
        exchanges: five(),
        folds: [{ at: 10, hides: [10], ms: 72_000, key: 'f|10' }]
      });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      const row = p.window.document.querySelector<HTMLElement>('#thread .fold .foldbtn');
      assert.ok(row, 'the fold this case is about was not drawn');
      row.click();
      assert.equal(threadTop(p), 900, 'opening a fold stood the reader at the end');
    });

    /**
     * A drag moves no turn either. It re-wraps them — which is what `grab` is
     * for — and a reader in the room has no turn at their fold to be held by,
     * so the drag settles them where it found them rather than at the end.
     */
    it('leaves a reader in the room where a drag found them', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 900);
      dividerDrag(p);
      assert.equal(threadTop(p), 900, 'the settle pulled the reader out of the room');
    });

    /**
     * And the other half of it, which is the whole reason the room can be a
     * place to stand: a reader the arrows put inside it reads as pinned —
     * there is nothing below them — but they are not moved to the content
     * edge, or the fix would hand the thread back down a beat after lifting it.
     */
    it('leaves a reader the arrows parked in the room where they are', (t) => {
      const view = threadView({ exchanges: five() });
      const p = openThread(t, view);
      fit(p, view, [100, 300, 500, 700, 900], 500);
      scrollTo(p, 300);
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      arrow(p, '.dn').click();
      echoScroll(p);
      assert.equal(threadTop(p), 900);
      dividerDrag(p);
      assert.equal(threadTop(p), 900, 'the settle pulled the reader off the prompt');
      assert.equal(part(p, '.count'), '5/5');
    });

    /**
     * Down to the end is not a park. It is the one arrow press that means
     * "catch me up", so it hands the place back to the thread rather than
     * standing on the newest prompt — which reads the same on the bar, and
     * follows where standing on it would have stopped.
     */
    it('goes on following after the down arrow runs out', (t) => {
      const view = threadView({ exchanges: asks() });
      const p = openThread(t, view);
      // The state that press is reachable from: standing on the newest prompt
      // with its replies still running on below, and close enough to the end to
      // be following. At the end itself the arrow is dead, which is its own
      // case further up.
      fit(p, view, [100, 300, 500], 900);
      scrollTo(p, 880);
      arrow(p, '.dn').click();
      assert.equal(threadTop(p), 900, 'down did not run to the end of the replies');
      // And the reply goes on arriving under them, which is the whole of what
      // following is for. A press that had parked them leaves them at 900.
      ceiling(p, 1200);
      dividerDrag(p);
      assert.equal(threadTop(p), 1200, 'the down arrow parked a reader who asked to catch up');
    });
  });
});
