import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel, captureVT, cardView, groupView, openPanel, stateMessage } from '../harness';
import { filterTo, fire, statusMenu } from './board_helpers';

describe('an arranged board', () => {
  /** Three loose sessions, in the order the derived rule already puts them. */
  const three = (over: Partial<GroupView> = {}) =>
    groupView({
      sessions: [
        cardView({ pid: 1, name: 'alpha' }),
        cardView({ pid: 2, name: 'beta' }),
        cardView({ pid: 3, name: 'gamma' })
      ],
      ...over
    });

  /** The top-level slots of the first group's grid, as the pids they name. */
  const slotted = (p: Panel): number[] =>
    [...p.window.document.querySelectorAll<HTMLElement>('#cards .grid[data-cwd] > [data-slot]')]
      .map((n) => Number(n.dataset.slot))
      .filter((n) => Number.isInteger(n));

  const names = (p: Panel): string[] =>
    [...p.window.document.querySelectorAll('.card:not(.add) .name')].map(
      (n) => n.textContent ?? ''
    );

  it('draws the derived order when nothing has been arranged', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three()]));
    assert.deepEqual(names(p), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(slotted(p), [1, 2, 3]);
  });

  it('draws a group in the order its slots name', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three({ slots: [3, 1, 2] })]));
    assert.deepEqual(names(p), ['gamma', 'alpha', 'beta']);
  });

  it('leaves the nav tally alone whatever the arrangement is', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three({ slots: [3, 1, 2] })]));
    // Layout, exactly as a family box is: the tally counts `sessions`.
    assert.equal(statusMenu(p).querySelector('.mitem')?.textContent, 'All sessions3');
  });

  it('draws a card the arrangement does not name, rather than dropping it', (t) => {
    const p = openPanel(t);
    // A hand-edited file, or a session that started after the drag: the stored
    // run is the head, and everything else keeps the derived tail.
    p.push(stateMessage([three({ slots: [3] })]));
    assert.deepEqual(names(p), ['gamma', 'alpha', 'beta']);
  });

  it('places nothing for a slot naming no card on the board', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three({ slots: [99, 2] })]));
    assert.deepEqual(names(p), ['beta', 'alpha', 'gamma']);
  });

  it('makes a family box one slot, named by its parent', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'alpha' }),
            cardView({ pid: 3, name: 'boss', children: [7] }),
            cardView({ pid: 7, name: 'peer7', parent: 3 })
          ],
          families: [{ parent: 3, members: [3, 7] }],
          slots: [3, 1]
        })
      ])
    );
    // The box moves whole, and no member pid is a slot of its own.
    assert.deepEqual(slotted(p), [3, 1]);
    const box = p.window.document.querySelector<HTMLElement>('.fam');
    assert.ok(box, 'no family box');
    assert.equal(box.dataset.slot, '3');
    assert.deepEqual(names(p), ['boss', 'peer7', 'alpha']);
  });

  it('offers every top-level slot as a drag source, and no member card', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'alpha' }),
            cardView({ pid: 3, name: 'boss', children: [7] }),
            cardView({ pid: 7, name: 'peer7', parent: 3 })
          ],
          families: [{ parent: 3, members: [3, 7] }]
        })
      ])
    );
    const doc = p.window.document;
    assert.ok(doc.querySelector<HTMLElement>('.card[data-pid="1"]')?.draggable, 'a loose card');
    assert.ok(doc.querySelector<HTMLElement>('.fam')?.draggable, 'a family box');
    assert.ok(
      !doc.querySelector<HTMLElement>('.fam .card[data-pid="7"]')?.draggable,
      'a member inside a box is not its own slot'
    );
    // The add slot is not a session, so it is not a slot either.
    assert.ok(!doc.querySelector<HTMLElement>('.card.add')?.draggable, 'the add slot');
  });

  it('ignores the arrangement and offers no drag while a filter is on', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        three({
          sessions: [
            cardView({ pid: 1, name: 'alpha', status: 'busy' }),
            cardView({ pid: 2, name: 'beta', status: 'busy' }),
            cardView({ pid: 3, name: 'gamma', status: 'idle' })
          ],
          slots: [2, 1, 3]
        })
      ])
    );
    filterTo(p, 'busy');
    // An insertion between two visible cards says nothing about the hidden
    // ones, so the gesture is withdrawn rather than made ambiguous.
    assert.deepEqual(names(p), ['alpha', 'beta']);
    assert.ok(
      [...p.window.document.querySelectorAll<HTMLElement>('.card')].every((c) => !c.draggable),
      'a card was draggable under a filter'
    );
  });

  it('carries the cwd on the grid, and parks an insertion bar in it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three()]));
    const grid = p.window.document.querySelector<HTMLElement>('#cards .grid[data-cwd]');
    assert.equal(grid?.dataset.cwd, '/Users/someone/proj');
    // One bar per group, a child of the grid it aims into — moved rather than
    // rebuilt, so it needs somewhere to live before the first dragover.
    assert.ok(grid?.querySelector(':scope > .ins'), 'no insertion bar');
  });

  it('posts the whole slot list on a drop, in the order then on screen', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three()]));
    const doc = p.window.document;
    const card = doc.querySelector<HTMLElement>('.card[data-pid="3"]');
    assert.ok(card, 'no card to drag');
    fire(p, card, 'dragstart', 'card:3');
    assert.ok(doc.body.classList.contains('dragging-card'), 'the flight was not marked');
    const grid = doc.querySelector<HTMLElement>('#cards .grid[data-cwd]');
    assert.ok(grid, 'no group grid');
    fire(p, grid, 'drop', 'card:3');
    // jsdom lays nothing out, so every rect is zero and `insertionIndex` falls
    // through to the end — which is still the whole list, which is the contract.
    const sent = p.posted.find((m) => m.type === 'arrange');
    assert.deepEqual(sent, { type: 'arrange', cwd: '/Users/someone/proj', slots: [1, 2, 3] });
    assert.ok(!doc.body.classList.contains('dragging-card'), 'the flight outlived its drop');
  });

  it('refuses a drag begun on a control', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three()]));
    const stop = p.window.document.querySelector<HTMLElement>('.card [data-act]');
    assert.ok(stop, 'no control on a card');
    const ev = fire(p, stop, 'dragstart', 'card:1');
    assert.ok(ev.defaultPrevented, 'a press on a control began a drag');
    assert.ok(
      !p.window.document.body.classList.contains('dragging-card'),
      'a control started a flight'
    );
  });

  it('keeps the two flights from painting each other’s affordance', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([three()]));
    const doc = p.window.document;
    const card = doc.querySelector<HTMLElement>('.card[data-pid="1"]');
    const other = doc.querySelector<HTMLElement>('.card[data-pid="2"]');
    assert.ok(card && other, 'no cards');
    fire(p, card, 'dragstart', 'card:1');
    fire(p, other, 'dragover', 'card:1');
    // A card dragged across the board would otherwise outline every card it
    // crossed as a ticket target.
    assert.ok(!other.classList.contains('drop'), 'a card flight painted a ticket target');
    fire(p, card, 'dragend');
  });
});

/**
 * The board's motion: every re-slot that is not a dock toggle.
 *
 * `TASK_done_dock_motion.md` animated the toggle and left the rest a cut — a
 * session starting, a session ending, a drag-and-drop reorder. The rule is one
 * sentence: a paint whose slot order differs from the last one animates.
 * `PRD_card_arrangement.md`'s 2026-07-29 entry is the condition it was admitted
 * on, and every scenario here is a way of asking whether the gate holds.
 *
 * **The mechanism is FLIP, and that is what changed what this file can ask.**
 * The board used to travel inside a view transition, so every scenario here
 * counted transitions started and ran their callbacks by hand. `slide`
 * (`webview/kit.ts`) measures, repaints inline, and writes a transform — so the
 * repaint is observable straight away, and the motion itself is an inline style
 * on the cards that moved. jsdom still lays nothing out, but a layout is
 * exactly the sort of thing a stub can supply, and `stackLayout` below does.
 *
 * What no scenario here can see is the paint: whether 320ms of transform reads
 * as travel, and whether an overlay stays over it. That is hand-checked in a
 * real window, and `docs/reference/z_index.md` is the measurement.
 */

describe('the board’s motion', () => {
  const two = () =>
    groupView({
      sessions: [cardView({ pid: 1, name: 'alpha' }), cardView({ pid: 2, name: 'beta' })]
    });
  /** The same two sessions, in the other order — the smallest re-slot there is. */
  const swapped = () =>
    groupView({
      sessions: [cardView({ pid: 2, name: 'beta' }), cardView({ pid: 1, name: 'alpha' })],
      slots: [2, 1]
    });

  /** The pids on the board, in the order the slots put them. */
  const order = (p: Panel): number[] =>
    [...p.window.document.querySelectorAll<HTMLElement>('#cards .grid[data-cwd] > [data-slot]')]
      .map((n) => Number(n.dataset.slot))
      .filter((n) => Number.isInteger(n));

  /**
   * jsdom has no layout, so every box reads zero, every FLIP delta is zero and
   * `slide` writes nothing — which is safe but says nothing. This stacks the
   * cards in a column 100px apart, by their position in the document, so a
   * re-slot produces the deltas the real thing would. Restored after each test:
   * it is on the window's own `Element.prototype`, and the harness reuses one.
   */
  const stackLayout = (p: Panel): (() => void) => {
    const proto = p.window.Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    const at = (top: number): DOMRect =>
      ({ left: 0, top, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top }) as DOMRect;
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: function (this: Element): DOMRect {
        const host = this.ownerDocument.getElementById('cards');
        if (!host || this === host) return at(0);
        const stack = [...host.querySelectorAll('.card, .fam')];
        const i = stack.indexOf(this);
        return at(i === -1 ? 0 : i * 100);
      }
    });
    return () => {
      if (original) Object.defineProperty(proto, 'getBoundingClientRect', original);
    };
  };

  /**
   * Every read of a card's box lands 10px lower than the last, so any `slide`
   * at all writes a transform — `stackLayout` moves a card only when its index
   * changes, which leaves the gate in front of `slide` unobserved.
   */
  const driftLayout = (p: Panel): (() => void) => {
    const proto = p.window.Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    const at = (top: number): DOMRect =>
      ({ left: 0, top, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top }) as DOMRect;
    let reads = 0;
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: function (this: Element): DOMRect {
        // The board stays put, so a card's box relative to it is what drifts.
        return at(this.id === 'cards' ? 0 : ++reads * 10);
      }
    });
    return () => {
      if (original) Object.defineProperty(proto, 'getBoundingClientRect', original);
    };
  };

  /** The inline transform `slide` left on a card, or '' if it did not move it. */
  const shifted = (p: Panel, pid: number): string =>
    p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`)?.style.transform ?? '';

  it('slides the cards that changed slot, and repaints inline', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([two()]));
    t.after(stackLayout(p));
    p.push(stateMessage([swapped()]));
    // Inline: the old mechanism deferred this to a callback the browser ran
    // before the next rendering step, and every caller had to know it.
    assert.deepEqual(order(p), [2, 1], 'the re-slot was deferred to a callback');
    // Inverted where each card was, so the paint the reader sees first is the
    // board it already had. 100px apart, and they swapped.
    assert.equal(shifted(p, 1), 'translate(0px, -100px)');
    assert.equal(shifted(p, 2), 'translate(0px, 100px)');
  });

  it('starts no view transition for a re-slot', (t) => {
    // The whole of what changed. A snapshot paints above the entire document,
    // outside every stacking context, so a travelling board flew over every
    // overlay the panel draws over it — the dialogs (bda26ed), then the settings
    // popover. A transform is in the page and outranks nothing, so the rules
    // that used to withhold the cards' name are gone with the transitions.
    const p = openPanel(t);
    p.push(stateMessage([two()]));
    t.after(stackLayout(p));
    const started = captureVT(p);
    p.push(stateMessage([swapped()]));
    assert.equal(started.length, 0, 'the board lifted its cards out of the page');
    assert.deepEqual(order(p), [2, 1]);
  });

  it('leaves a push that only changes a status alone', (t) => {
    // The gate, and the whole condition the feature was admitted on: a status,
    // a branch, a token count all repaint a card in the slot it is already in.
    const p = openPanel(t);
    p.push(stateMessage([two()]));
    t.after(driftLayout(p));
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'alpha', status: 'busy' }),
            cardView({ pid: 2, name: 'beta' })
          ]
        })
      ])
    );
    assert.equal(shifted(p, 1), '', 'a status change animated');
    assert.equal(shifted(p, 2), '');
  });

  it('animates a drop, which is the result of the gesture and not part of it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([two()]));
    const doc = p.window.document;
    const card = doc.querySelector<HTMLElement>('.card[data-pid="1"]');
    const grid = doc.querySelector<HTMLElement>('#cards .grid[data-cwd]');
    assert.ok(card && grid, 'no card to drag');
    fire(p, card, 'dragstart', 'card:1');
    fire(p, grid, 'drop', 'card:1');
    // jsdom lays nothing out, so `insertionIndex` falls through to the end.
    assert.deepEqual(
      p.posted.find((m) => m.type === 'arrange'),
      { type: 'arrange', cwd: '/Users/someone/proj', slots: [2, 1] }
    );
    // The drop repaints inline like every other re-slot, and the arrangement it
    // posted is what the next push confirms.
    assert.deepEqual(order(p), [2, 1], 'the drop was deferred to a callback');
  });

  it('stays still while a drag is in flight', (t) => {
    // The 1s ticker fires under a drag, and a session can start under one. Cards
    // moving there slide out from under the hand that is aiming at them.
    const p = openPanel(t);
    p.push(stateMessage([two()]));
    const doc = p.window.document;
    const card = doc.querySelector<HTMLElement>('.card[data-pid="1"]');
    assert.ok(card, 'no card to drag');
    fire(p, card, 'dragstart', 'card:1');
    t.after(stackLayout(p));
    p.push(stateMessage([swapped()]));
    assert.equal(shifted(p, 1), '', 'the board moved under a drag');
    assert.deepEqual(order(p), [2, 1], 'the push was dropped rather than cut');
    fire(p, card, 'dragend');
  });

  it('is started by a change of order and by nothing else', (t) => {
    // Deliberately blind (see the task file): a filter pick is a disappearance
    // rather than a travel, and the alert bar grows without re-ordering
    // anything. Both keep the cut they have today.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'alpha', status: 'busy' }),
            cardView({ pid: 2, name: 'beta', status: 'waiting', waitingFor: 'input' })
          ]
        })
      ])
    );
    t.after(driftLayout(p));
    filterTo(p, 'busy');
    assert.equal(shifted(p, 1), '', 'a filter pick animated');
    filterTo(p, 'busy');
    assert.equal(shifted(p, 1), '', 'clearing the filter animated');
  });
});
