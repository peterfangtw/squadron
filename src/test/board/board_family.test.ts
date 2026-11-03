import { filterTo } from './board_helpers';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  Panel,
  cardView,
  groupView,
  openPanel,
  stateMessage
} from '../harness';

describe('the family container', () => {
  const boss = (over: Partial<CardView> = {}) =>
    cardView({ pid: 3, name: 'orchestrator-split', status: 'busy', children: [7, 8], ...over });
  const peer = (pid: number, over: Partial<CardView> = {}) =>
    cardView({ pid, name: 'peer' + pid, parent: 3, ...over });
  const fam = (p: Panel): NodeListOf<HTMLElement> =>
    p.window.document.querySelectorAll<HTMLElement>('.fam');
  /** Every card's name in document order — the pid of each, said out loud. */
  const drawn = (p: Panel): (string | null)[] =>
    [...p.window.document.querySelectorAll('.card .name')].map((n) => n.textContent);

  it('renders a family as one box, its parent’s card first', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss(), peer(7), peer(8)],
          families: [{ parent: 3, members: [3, 7, 8] }]
        })
      ])
    );
    const boxes = fam(p);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0]?.querySelector('.fam-head .who')?.textContent, 'orchestrator-split');
    assert.deepEqual(
      [...(boxes[0]?.querySelectorAll('.card .name') ?? [])].map((n) => n.textContent),
      ['orchestrator-split', 'peer7', 'peer8']
    );
    // The head reads as the head, without a hue nobody has to learn.
    assert.ok(boxes[0]?.querySelector('.card.is-parent .name'), 'the parent card is not marked');
  });

  /**
   * What the box asked the grid for. `--span` is min(members, columns), and the
   * column count is the floor of 2 the grid's own `min(290px, 50% - 5px)`
   * guarantees — jsdom lays nothing out, so every scenario here runs at that
   * floor and the wider boards are hand-checked in the IDE.
   */
  const span = (box: HTMLElement | undefined): string | undefined =>
    box?.style.getPropertyValue('--span');

  it('spans one column for a family holding one card', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [boss()] }),
        groupView({
          cwd: '/e',
          label: '~/report',
          sessions: [peer(8)],
          families: [{ parent: 3, members: [8] }]
        })
      ])
    );
    assert.equal(span(fam(p)[0]), '1', 'a one-card family still encloses an empty column');
  });

  it('spans no wider than the board has columns', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss({ children: [7, 8, 9, 10] }), peer(7), peer(8), peer(9), peer(10)],
          families: [{ parent: 3, members: [3, 7, 8, 9, 10] }]
        })
      ])
    );
    // Five cards, two columns. A span past the explicit grid would have the
    // grid invent implicit `auto` columns, which resizes every loose card in
    // the group — the one way this can do harm beyond looking wrong.
    assert.equal(span(fam(p)[0]), '2');
  });

  it('stays a rectangle where the last row runs out of cards', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss(), peer(7), peer(8)],
          families: [{ parent: 3, members: [3, 7, 8] }]
        })
      ])
    );
    // Three cards over two columns: the fourth cell is empty, and the box
    // encloses it rather than cutting its own corner out to avoid it.
    const grid = fam(p)[0]?.querySelector<HTMLElement>('.grid');
    assert.equal(grid?.children.length, 3, 'the box holds something that is not a card');
    assert.equal(
      [...(grid?.children ?? [])].filter((n) => !n.classList.contains('card')).length,
      0
    );
  });

  it('keeps the cards it had when one fills the last row', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss(), peer(7), peer(8)],
          families: [{ parent: 3, members: [3, 7, 8] }]
        })
      ])
    );
    const before = p.window.document.querySelector<HTMLElement>('.fam .card[data-pid="8"]');
    p.push(
      stateMessage([
        groupView({
          sessions: [boss({ children: [7, 8, 9] }), peer(7), peer(8), peer(9)],
          families: [{ parent: 3, members: [3, 7, 8, 9] }]
        })
      ])
    );
    assert.equal(
      p.window.document.querySelector('.fam .card[data-pid="8"]'),
      before,
      'the morph replaced a card instead of appending the new one'
    );
  });

  it('tallies what the parent spawned, and calls out a blocked member', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss(), peer(7, { status: 'waiting' }), peer(8)],
          families: [{ parent: 3, members: [3, 7, 8] }]
        })
      ])
    );
    assert.equal(fam(p)[0]?.querySelector('.fam-head .n')?.textContent, '2 spawned · 1 waiting');
  });

  it('names the same parent in every group the family reaches', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [boss(), peer(7)], families: [{ parent: 3, members: [3, 7] }] }),
        groupView({
          cwd: '/e',
          label: '~/report',
          sessions: [peer(8)],
          families: [{ parent: 3, members: [8] }]
        })
      ])
    );
    const boxes = fam(p);
    assert.equal(boxes.length, 2);
    // The far group: the parent is elsewhere, so the header says where, and how
    // much of the family is under this heading.
    const head = boxes[1]?.querySelector('.fam-head');
    assert.equal(head?.querySelector('.who')?.textContent, 'orchestrator-split');
    assert.equal(head?.querySelector('.where')?.textContent, 'in ~/proj');
    assert.equal(head?.querySelector('.n')?.textContent, '1 here of 2');
  });

  it('selects the parent from a header that names one in another group', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [boss()] }),
        groupView({
          cwd: '/e',
          label: '~/report',
          sessions: [peer(8)],
          families: [{ parent: 3, members: [8] }]
        })
      ])
    );
    fam(p)[0]?.querySelector<HTMLElement>('.fam-head .who')?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 3 }]);
  });

  it('draws a chain as two sibling boxes, and no card twice', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            boss({ children: [7] }),
            peer(7, { children: [9] }),
            cardView({ pid: 9, name: 'grandchild', parent: 7 })
          ],
          families: [
            { parent: 3, members: [3, 7] },
            { parent: 7, members: [9] }
          ]
        })
      ])
    );
    assert.equal(fam(p).length, 2, 'a chain nested instead of laying flat');
    // The middle session is a member of its parent's box and the head of its
    // own — named twice, drawn once.
    assert.deepEqual(drawn(p), ['orchestrator-split', 'peer7', 'grandchild']);
  });

  it('keeps loose cards above the boxes, and the add slot below them', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [cardView({ pid: 1, name: 'unrelated' }), boss({ children: [7] }), peer(7)],
          families: [{ parent: 3, members: [3, 7] }]
        })
      ])
    );
    const grid = p.window.document.querySelector('#cards .grid[data-cwd]');
    // The insertion bar is parked last and is out of flow, so it is behind the
    // add slot in the markup and nowhere at all on the screen.
    assert.deepEqual(
      [...(grid?.children ?? [])].map((n) => n.className.split(' ')[0]),
      ['card', 'fam', 'card', 'ins']
    );
    assert.ok(
      grid?.querySelector('.card.add')?.nextElementSibling?.classList.contains('ins'),
      'the add slot moved'
    );
  });

  it('dissolves every box under a filter', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [boss({ children: [7] }), peer(7, { status: 'waiting' })],
          families: [{ parent: 3, members: [3, 7] }]
        })
      ])
    );
    assert.equal(fam(p).length, 1);
    filterTo(p, 'waiting');
    assert.equal(fam(p).length, 0, 'a box survived a filter showing one of its members');
    // And with the box goes the only thing that said whose fan-out this card is
    // in: the strip names neither a parent nor a count. A filtered view is a
    // view of one status, not of a family, and this is the honest cost of that.
  });

  it('renders no box for a group with no families', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView()] })]));
    assert.equal(fam(p).length, 0);
  });

  it('dissolves a family whose parent is not on the board', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [peer(7), peer(8)], families: [{ parent: 404, members: [7, 8] }] })
      ])
    );
    // Nothing to head the box with, and hiding the members would be worse than
    // any label: they fall back to loose cards.
    assert.equal(fam(p).length, 0);
    assert.deepEqual(drawn(p), ['peer7', 'peer8']);
  });
});
