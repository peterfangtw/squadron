import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import { statusMenu } from './board_helpers';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panelDocument } from '../../ui/document';
import { cardView, groupView, openPanel, stateMessage } from '../harness';

/**
 * The dot: one circle, three meanings. A card's status, the tally's status and
 * a ticket's priority are all `.dot`, and the shared rule stops at the box —
 * each caller paints its own, because sharing a circle is not sharing what it
 * stands for.
 *
 * These tests exist to catch the drift the sharing was meant to end: a fourth
 * dot that restates the geometry instead of wearing the class, or a caller
 * that half-declares it.
 */

const ticket = (over: Partial<TicketView> = {}): TicketView => ({
  scopeId: 'team-a',
  key: 'i1',
  identifier: 'ENG-1',
  title: 'a bug',
  priority: ticketPriority(1),
  state: ticketState('In Progress'),
  url: 'https://linear.app/x/ENG-1',
  ...over
});

describe('the dot', () => {
  it('gives a card its status dot, with nothing but the shared class', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'busy' })] })]));

    const d = p.window.document.querySelector('.card .head .dot');
    // Bare `.dot`: the colour reaches it through --st on the card, so the dot
    // itself says nothing about which status it is showing.
    assert.equal(d?.className, 'dot');
  });

  it('gives the tally the same dot, named by the status it selects', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'waiting' })] })]));

    const d = statusMenu(p).querySelector('.mitem .dot');
    // The variant is what --st keys off here, since there is no card above it.
    assert.equal(d?.className, 'dot waiting');
  });

  it('gives a ticket the same dot for something else entirely', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket({ priority: ticketPriority(1) })]
      })
    );
    // The tab has to be open for the list to exist at all.
    p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();

    const d = p.window.document.querySelector('#tk-list .tk .dot');
    assert.equal(d?.className, 'dot tone-urgent');
  });

  it('declares the circle once, and sizes it off a property callers can set', () => {
    const css = panelDocument();
    assert.match(css, /\.dot \{ flex: none; width: var\(--dot, 7px\); height: var\(--dot, 7px\)/);

    // The point of the shared rule: no other selector restates a dot's box. A
    // caller wanting a different size sets --dot, so a second `width: 7px` on
    // anything named a dot means someone has gone around it.
    const restated = [...css.matchAll(/^\s*[^\n{]*\.(?:dot|d)\b[^\n{]*\{[^}]*\}/gm)]
      .map((m) => m[0])
      .filter((rule) => /\bwidth:/.test(rule) && !/^\s*\.dot \{/.test(rule));
    assert.deepEqual(restated, [], 'a dot rule restates its own geometry');
  });
});
