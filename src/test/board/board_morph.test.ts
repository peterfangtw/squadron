import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import { statusOption } from './board_helpers';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  Panel,
  TEST_VERSION,
  cardView,
  groupView,
  openPanel,
  openSettings,
  stateMessage,
  switchRow
} from '../harness';
import { COPY } from './board_helpers';

describe('a press in flight', () => {
  // The status, not the name: a renamed card decodes through the scramble, so
  // its text is glyphs for half a second and says nothing about the rebuild.
  const status = (p: Panel): string | undefined =>
    p.window.document.querySelector('.card')?.className;

  it('repaints under the press rather than holding the news back', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'idle' })] })]));
    const win = p.window;
    const before = win.document.querySelector<HTMLElement>('.card');
    before?.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'busy' })] })]));
    // The session went busy while the button was down, and the card says so.
    assert.match(status(p) ?? '', /busy/, 'the press held the push back');
    assert.equal(win.document.querySelector('.card'), before, 'the paint cost the node');
    before?.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    before?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 101 }]);
  });
});

/**
 * What a keyed morph buys that a positional one would not: the node for a pid
 * is that session's for as long as it is on the board, wherever the board puts
 * it. Cards arrive, leave and move into family boxes between paints, and a
 * pointer resting on one has to still be resting on the same session after.
 */

describe('a card node belongs to its session', () => {
  const at = (p: Panel, pid: number): HTMLElement | null =>
    p.window.document.querySelector(`.card[data-pid="${pid}"]`);

  it('keeps the same node for a session that stays', (t) => {
    const p = openPanel(t);
    const two = [cardView({ pid: 1, name: 'p1' }), cardView({ pid: 2, name: 'p2' })];
    p.push(stateMessage([groupView({ sessions: two })]));
    const first = at(p, 1);
    assert.ok(first, 'no card for the session');
    // Reordered, and one of them gone: the survivor is the same element.
    p.push(stateMessage([groupView({ sessions: [two[1] as CardView, two[0] as CardView] })]));
    assert.equal(at(p, 1), first, 'a reorder rebuilt the card');
  });

  it('adds a node for a session that arrives and drops one that leaves', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1, name: 'p1' })] })]));
    const first = at(p, 1);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 1, name: 'p1' }), cardView({ pid: 2, name: 'p2' })]
        })
      ])
    );
    assert.equal(at(p, 1), first, 'an arrival cost the sitting card its node');
    assert.ok(at(p, 2), 'the arriving session got no card');

    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 2, name: 'p2' })] })]));
    assert.equal(at(p, 1), null, 'the departed session kept a card');
  });

  it('moves a card into a family box without rebuilding it', (t) => {
    const p = openPanel(t);
    const boss = cardView({ pid: 3, name: 'boss', children: [7] });
    const kid = cardView({ pid: 7, name: 'kid', parent: 3 });
    p.push(stateMessage([groupView({ sessions: [boss, kid] })]));
    const before = at(p, 7);
    assert.ok(before, 'no card for the child');
    assert.equal(before.closest('.fam'), null, 'boxed before there was a family');

    // The lineage arrives a poll later than the sessions do, and the child's
    // card is carried into the box rather than rebuilt inside it.
    p.push(
      stateMessage([
        groupView({ sessions: [boss, kid], families: [{ parent: 3, members: [3, 7] }] })
      ])
    );
    assert.equal(at(p, 7), before, 'the move rebuilt the card');
    assert.ok(before.closest('.fam'), 'the card never reached the box');
  });
});

/**
 * The other half of the same guarantee, and the one a morph makes newly
 * dangerous: a control the pointer is resting on must not become a *different*
 * control under it.
 *
 * A rebuild could only ever lose the click — the node went, and the press
 * dispatched on `#cards` with nothing to resolve. A morph keeps the node and
 * rewrites its attributes, so an unkeyed control hands the click to whatever
 * slid into its place, and the delegated listener carries it out. Keying every
 * acting node is what makes the press land on what it was aimed at.
 */

describe('a control under a press keeps its meaning', () => {
  const icons = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('.card button.icon')
  ];
  const one = (s: CardView) => stateMessage([groupView({ sessions: [s] })]);

  /**
   * Interrupt is the only control a status change takes away, so it is the only
   * thing that can slide the row. Stated on an owned card because that is the
   * plain case; every other card's two are unconditional and cannot shuffle at
   * all, which is a narrower surface than before.
   */
  const piped = (over: Partial<CardView>) => cardView({ owned: true, ...over });

  /**
   * The other half of H23, and the one a swap could quietly lose: these buttons
   * are a glyph and nothing else, so `title` was their accessible name as well
   * as their tooltip. `data-tip` is not a name — a reader on a screen reader
   * would hear "button" for every one of them — so the label has to be on both.
   */
  it('names every icon button to the pointer and to a screen reader alike', (t) => {
    const p = openPanel(t);
    p.push(one(piped({ pid: 7, status: 'busy' })));
    // Every one in the document, not only the card's: the dock head draws five
    // of the same acts from `document.ts`'s static markup, and scoping this to
    // `.card` is exactly how they sat on `title=` through the sweep that was
    // supposed to take them. `button.nav` for the same reason one class lower —
    // the prompt bar's two arrows are glyph-only too, and a rule that named only
    // `.icon` would leave them the one pair nothing here watches.
    const buttons = [...p.window.document.querySelectorAll<HTMLElement>('button.icon, button.nav')];
    assert.ok(buttons.length >= 9, `only ${buttons.length} glyph buttons — did the query narrow?`);
    for (const b of buttons) {
      assert.ok(b.dataset.tip, `an icon button with no tip: ${b.outerHTML}`);
      assert.ok(b.getAttribute('aria-label'), `an icon button with no name: ${b.outerHTML}`);
      assert.equal(b.getAttribute('title'), null, 'the host tooltip is gone for good');
    }
  });

  it('does not turn the stop button into the copy when a turn ends', (t) => {
    const p = openPanel(t);
    p.push(one(piped({ pid: 7, status: 'busy' })));
    // Busy and piped draws three: Interrupt, Copy, End.
    assert.deepEqual(
      icons(p).map((b) => b.dataset.tip),
      ['Interrupt turn', COPY, 'End session']
    );
    const aimed = icons(p)[2];
    assert.ok(aimed, 'no End button to aim at');

    // The turn ends under the press: Interrupt goes, and the two that stay must
    // stay themselves rather than shuffle one place left.
    p.push(one(piped({ pid: 7, status: 'idle' })));
    assert.ok(p.window.document.contains(aimed), 'the End button was swept from under the press');
    assert.equal(aimed.dataset.tip, 'End session', 'the button changed under the pointer');
    aimed.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'close', pid: 7 });
  });

  it('never lets an alert chip take another session’s pid', (t) => {
    const p = openPanel(t);
    const waiting = (pid: number) => cardView({ pid, name: 'p' + pid, status: 'waiting' });
    const chips = (p: Panel): HTMLElement[] => [
      ...p.window.document.querySelectorAll<HTMLElement>('#alert .schip')
    ];
    p.push(stateMessage([groupView({ sessions: [waiting(11), waiting(22)] })]));
    const first = chips(p)[0];
    assert.equal(first?.dataset.pid, '11');

    // 11 stops waiting and leaves the bar. Its chip must go with it, not be
    // repainted into 22's — a press on it would otherwise reveal 22's question.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 11, status: 'idle' }), waiting(22)] })])
    );
    assert.ok(first && !p.window.document.contains(first), 'the chip outlived its session');
    assert.deepEqual(
      chips(p).map((c) => c.dataset.pid),
      ['22']
    );

    // And the survivor's own chip is the same node across the paint.
    const kept = chips(p)[0];
    p.push(stateMessage([groupView({ sessions: [waiting(22)] })]));
    assert.equal(chips(p)[0], kept, 'the sitting chip was rebuilt');
  });
});

/**
 * The nav bar is the other surface a paint lands on, and it was covered by the
 * press-hold rather than by anything of its own: `renderNav` ran on the 1 s
 * tick and every 3 s push, and it replaced the bar's children wholesale.
 *
 * Delegation alone does not save these clicks. A rebuilt node is *detached*, so
 * the click dispatches on `nav` itself and `nav.closest('.count')` resolves
 * nothing — the listener is there and finds no subject. The morph is what makes
 * the delegation enough: the node the press is on survives the paint, so the
 * click still has something to read a status or an act off.
 */

describe('a nav control under a press keeps its meaning', () => {
  const count = (p: Panel, status: string): HTMLElement | null => statusOption(p, status);
  const pids = (p: Panel): string[] =>
    [...p.window.document.querySelectorAll<HTMLElement>('.card[data-pid]')].map(
      (n) => n.dataset.pid ?? ''
    );

  it('keeps a tally count through a paint, and filters to the status it named', (t) => {
    const p = openPanel(t);
    const busy = cardView({ pid: 1, name: 'b1', status: 'busy' });
    p.push(stateMessage([groupView({ sessions: [busy, cardView({ pid: 2, name: 'i1' })] })]));
    const aimed = count(p, 'busy');
    assert.ok(aimed, 'no busy count to aim at');

    // The press is down when the other session blocks: the `idle` row is
    // replaced by a `waiting` one, and the tally is repainted around the node
    // under the pointer.
    p.push(
      stateMessage([
        groupView({ sessions: [busy, cardView({ pid: 2, name: 'i1', status: 'waiting' })] })
      ])
    );
    assert.ok(p.window.document.contains(aimed), 'the paint swept the count from under the press');
    assert.equal(
      aimed.querySelector('.nm')?.textContent,
      'Busy',
      'the count now filters to something else'
    );

    aimed.click();
    assert.deepEqual(pids(p), ['1'], 'the click was lost, or narrowed to the wrong status');
  });

  it('keeps the Tickets opener through a paint, and still opens the dock on it', (t) => {
    const p = openPanel(t);
    const linear = { ...ticketSourceView(), linked: true };
    p.push(stateMessage([groupView()], { ticketSource: linear, tickets: [] }));
    const aimed = p.window.document.querySelector<HTMLElement>('#board-tickets');
    assert.ok(aimed, 'no Tickets opener to aim at');

    // The backlog arrives under the press. The label is rewritten; the button
    // it is written on is the same one.
    p.push(
      stateMessage([groupView()], {
        ticketSource: linear,
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
    assert.ok(p.window.document.contains(aimed), 'the paint swept the opener from under the press');
    assert.match(aimed.textContent ?? '', /Tickets1/, 'the count never reached the label');

    aimed.click();
    assert.equal(
      p.window.document.getElementById('tk-list')?.hidden,
      false,
      'the click never opened the tickets tab'
    );
  });

  // The gear is the one control in the bar that still owns a closure, so it is
  // the one the morph could break rather than fix: keep the node and it keeps a
  // handle on the menu beside it, lose the node and the survivor's handle
  // points at an orphan. Its own menu is guarded by `heldOpen(nav)` instead —
  // this is about the paints that land while it is closed.
  it('leaves the settings gear working across the paints it sits through', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { soundLevel: 'off' }));
    const gear = p.window.document.querySelector<HTMLElement>('#nav-actions .gear');
    p.push(stateMessage([groupView()], { soundLevel: 'loud' }));
    assert.equal(
      p.window.document.querySelector('#nav-actions .gear'),
      gear,
      'the paint rebuilt the gear'
    );

    const menu = openSettings(p);
    assert.equal(
      switchRow(menu, 'Sound').querySelector('.val')?.firstChild?.textContent,
      'Loud',
      'the menu opened on stale state'
    );
  });

  // The build, where someone filing a bug can find it. It rides the document
  // rather than the state push — it cannot change while the panel is open —
  // so this is really asserting that the document's stamp reaches the menu.
  it('names its version at the foot of the settings menu', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const foot = openSettings(p).querySelector('.settings-foot span:last-child');
    assert.ok(foot, 'no version line in the settings menu');
    assert.equal(foot.textContent, 'Squadron ' + TEST_VERSION);
  });

  it('walks category tabs without focusing the version stamp', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const dialog = openSettings(p);
    const tabs = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')];
    const last = tabs.at(-1);
    last?.focus();
    last?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(p.window.document.activeElement, tabs[0]);
  });
});

/**
 * Ending a card that started other sessions asks first, and can take them
 * with it — but the dialog is `showWarningMessage` in `panel.ts`, so this layer
 * can only say that the webview's half of it did not change. The dialog itself
 * is hand-checked.
 */
