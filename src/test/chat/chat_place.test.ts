import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  newDraft,
  cardView,
  groupView,
  openPanel,
  stateMessage,
  threadView,
  Panel
} from '../harness';

/**
 * There is one `#thread` and every session is painted into it, so anything the
 * reader did to it belongs to whoever was last in it — unless it is written
 * down against a pid. It was not: reading one session to its top opened the
 * next standing at its top, and the one after that wherever the second was
 * left.
 */
describe('the thread’s place', () => {
  /** The gap between one child of the thread and the next, in the ruler below. */
  const STEP = 300;

  /**
   * Where the first child starts. `#thread` is padded, so the top of the thread
   * is above every child in it — the real document's own arrangement, and the
   * case a ruler starting at zero cannot pose.
   */
  const PAD = 12;

  /** Where the end of the thread is, under that same ruler. */
  const END = 5000;

  /**
   * A ruler for `#thread` and its children — jsdom lays nothing out, so every
   * `offsetTop` is 0 and a position has nothing to be measured against.
   *
   * Live off the child's index rather than stamped onto the nodes: `paint`
   * rebuilds them on a switch and the place is taken inside that same push, so
   * there is no moment between the two for a test to stamp anything.
   */
  function ruler(p: Panel): void {
    Object.defineProperty(p.window.HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement): number {
        const parent = this.parentElement;
        return parent?.id === 'thread' ? [...parent.children].indexOf(this) * STEP + PAD : 0;
      }
    });
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    Object.defineProperty(thread, 'scrollHeight', { value: END, configurable: true });
  }

  const ask = (text: string): ExchangeView => ({
    role: 'user',
    text,
    blocks: [{ prose: text }]
  });

  /** A board of three sessions, none of them read yet. */
  function board(t: TestContext): Panel {
    const p = openPanel(t);
    const groups = [
      groupView({ sessions: [cardView({ pid: 1 }), cardView({ pid: 2 }), cardView({ pid: 3 })] })
    ];
    p.push(stateMessage(groups));
    ruler(p);
    return p;
  }

  /** Pick a card, without the push that answers it. */
  function pick(p: Panel, pid: number): void {
    const card = p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);
    assert.ok(card, `no card for ${pid}`);
    card.click();
  }

  /** Sequence per selection. A second publish on the same select is a later frame. */
  const threadSequence = new Map<string, number>();

  /** The thread the host sends back for a pick, on the ordered channel. */
  function land(
    p: Panel,
    pid: number,
    exchanges: ExchangeView[],
    over: Partial<ThreadView> = {}
  ): void {
    const select = [...p.posted].reverse().find((row) => row.type === 'select');
    if (select?.type !== 'select' || select.pid !== pid) {
      assert.fail('the host answers the select it was sent');
    }
    const sequence = (threadSequence.get(select.selection) ?? 0) + 1;
    threadSequence.set(select.selection, sequence);
    p.push({
      type: 'thread',
      selection: select.selection,
      generation: 0,
      sequence,
      thread: threadView({ pid, exchanges, ...over })
    });
  }

  /** Pick a card and let its thread land, the way a reader does. */
  function open(p: Panel, pid: number, exchanges: ExchangeView[]): void {
    pick(p, pid);
    land(p, pid, exchanges);
  }

  /** Scroll the thread the way a reader does, event and all. */
  function scrollTo(p: Panel, top: number): void {
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    thread.scrollTop = top;
    thread.dispatchEvent(new p.window.Event('scroll'));
  }

  const at = (p: Panel): number | undefined =>
    p.window.document.getElementById('thread')?.scrollTop;

  const three = [ask('first'), ask('second'), ask('third')];

  it('opens a session at its newest turn, whatever the last one was left at', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, 0);
    open(p, 2, three);
    assert.equal(at(p), END, 'the second session opened standing where the first was left');
  });

  it('gives a session back the place its own reader left it', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, 0);
    open(p, 2, three);
    scrollTo(p, END);
    open(p, 1, three);
    assert.equal(at(p), 0, 'the first session lost its own place to the second');
  });

  it('holds the turn the reader stopped at rather than the pixel it was at', (t) => {
    const p = board(t);
    open(p, 1, three);
    // Forty pixels into the second turn: mid-reply, which is where reading
    // actually stops.
    scrollTo(p, STEP + 40);
    open(p, 2, three);
    // Back with one more turn read off the head of the transcript, so every
    // turn below it has moved. A remembered pixel would land in the turn above.
    open(p, 1, [ask('older'), ...three]);
    assert.equal(at(p), 2 * STEP + 40, 'the place followed the pixel, not the turn');
  });

  it('falls back to the turn above when the one it stopped at is gone', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, 2 * STEP + PAD);
    open(p, 2, three);
    // The turn at the fold is gone and the one above it is not. Within a turn of
    // where they were beats the bottom of a conversation they had left.
    open(p, 1, [ask('first'), ask('second')]);
    assert.equal(at(p), 2 * STEP + PAD, 'a survivable turn above the fold went unused');
  });

  it('opens at the newest turn when none of the turns it remembered are left', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, 2 * STEP + PAD);
    open(p, 2, three);
    open(p, 1, [ask('nothing'), ask('it'), ask('read')]);
    assert.equal(at(p), END);
  });

  /**
   * `select` picks the new session before it empties the thread, and emptying a
   * thread the reader had scrolled down collapses it — the browser clamps
   * `scrollTop` to 0 and fires a real scroll for the clamp. Written down against
   * the *selected* session that arrives under the pid being opened, and threw
   * away its place: leaving any session below its top wiped the place of the
   * session being opened, which is the whole feature.
   */
  it('keeps the place of the session being opened when the last one is left mid-thread', (t) => {
    const p = board(t);
    open(p, 2, three);
    scrollTo(p, STEP + PAD);
    open(p, 1, three);
    // Reading down session 1, so leaving it collapses a scrolled thread.
    scrollTo(p, 2 * STEP + PAD);
    pick(p, 2);
    // The clamp, and the scroll the browser fires for it. jsdom does neither for
    // itself, so the case it caused has to be posed by hand.
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    thread.scrollTop = 0;
    thread.dispatchEvent(new p.window.Event('scroll'));
    land(p, 2, three);
    assert.equal(at(p), STEP + PAD, 'leaving one session threw away the place of the next');
  });

  it('puts the reader back at the turn they stopped at, not an identical one above', (t) => {
    const p = board(t);
    const twice = [ask('same'), ask('same'), ask('other')];
    open(p, 1, twice);
    // Forty pixels into the *second* of two turns that say the same thing, and
    // so carry the same key.
    scrollTo(p, STEP + PAD + 40);
    open(p, 2, three);
    open(p, 1, twice);
    assert.equal(at(p), STEP + PAD + 40, 'the first turn with that key won');
  });

  it('waits for turns before counting a session as arrived', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, STEP + PAD);
    open(p, 2, three);
    pick(p, 1);
    // A transcript the host has not read yet: the thread says so and holds no
    // turns. Counted as the arrival, this would spend it on an empty thread and
    // leave the real turns looking like an ordinary poll.
    land(p, 1, []);
    land(p, 1, three);
    assert.equal(at(p), STEP + PAD, 'the arrival was spent on a thread with nothing in it');
  });

  it('waits for turns even when the empty thread names its source', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, STEP + PAD);
    open(p, 2, three);
    pick(p, 1);
    // The same hostile wire, for the second symptom: a note is not a turn, and
    // counting it as one spends the arrival on a thread holding nothing.
    land(p, 1, [], { fallback: true });
    land(p, 1, three);
    assert.equal(at(p), STEP + PAD, 'a source note stood in for the turns and spent the arrival');
  });

  it('keeps its place across a look at the backlog', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, STEP + PAD);
    const doc = p.window.document;
    doc.getElementById('board-tickets')?.click();
    assert.equal(doc.getElementById('chat')?.hidden, false);
    doc.getElementById('board-sessions')?.click();
    assert.equal(at(p), STEP + PAD, 'the backlog cost the reader their place');
  });

  it('takes its place again after leaving for New', (t) => {
    const p = board(t);
    open(p, 1, three);
    scrollTo(p, STEP);
    newDraft(p);
    // What emptying the thread does to a real one, which jsdom lays out too
    // little to do for itself: nothing is left to scroll, so the position
    // collapses. Written rather than dispatched — a clamp is not the reader
    // scrolling, and an event here would rewrite the very place under test.
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread);
    thread.scrollTop = 0;
    open(p, 1, three);
    assert.equal(at(p), STEP, 'a re-open of the session last painted took no place at all');
  });
});
