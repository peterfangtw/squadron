/**
 * Card drag-reorder on the board. Extracted from board.ts (H56).
 */

import { cards, ui, vscode } from './state';
import { hitOf } from './board_actions';
import { repaintBoard } from './board_repaint';

// ---- arranging the cards ----------------------------------------------------

/**
 * The reader's own order, as a drag. Native HTML5 drag-and-drop, the idiom the
 * tickets list already uses, delegated to `#cards` like everything else here —
 * so the listeners survive the paint and the handlers read the DOM rather than
 * closing over a view.
 *
 * One commit, on `drop`, never live on `dragover`: the board repaints every
 * second, and a half-applied order is something the next poll would reconcile
 * against. What is written is every slot then on screen in the order then on
 * screen, which is also the compaction that drops entries for sessions that
 * have ended.
 */
/** The slot being carried, and the group it may be dropped back into. */
export let flight: { cwd: string; id: number } | null = null;
/** Did the press that began this drag land on a family's header? */
let onHandle = false;
/** The last `cwd:index` the bar was drawn for — see `showBar`. */
let lastOver: string | null = null;

/** A group's top-level slots, in the order they are on screen. */
export const slotNodes = (grid: HTMLElement): HTMLElement[] => [
  ...grid.querySelectorAll<HTMLElement>(':scope > [data-slot]')
];

/** The grid a pointer event is over, when it is over one of ours. */
export const gridOf = (target: EventTarget | null): HTMLElement | null =>
  hitOf(target)?.closest<HTMLElement>('.grid[data-cwd]') ?? null;

cards.addEventListener('mousedown', (e) => {
  onHandle = !!hitOf(e.target)?.closest('.fam-head');
});

cards.addEventListener('dragstart', (e) => {
  const hit = hitOf(e.target);
  const slot = hit?.closest<HTMLElement>('[data-slot]');
  // A press on a control is a press, never a drag.
  if (!slot || hit?.closest('[data-act], button, a')) {
    e.preventDefault();
    return;
  }
  // A family box is picked up by its header only: a press inside a member card
  // is that card's press, and a member is not a slot of its own at all.
  if (slot.classList.contains('fam') && !onHandle) {
    e.preventDefault();
    return;
  }
  const grid = slot.closest<HTMLElement>('.grid[data-cwd]');
  const cwd = grid?.dataset.cwd;
  const id = Number(slot.dataset.slot);
  if (!grid || cwd === undefined || !Number.isInteger(id)) {
    e.preventDefault();
    return;
  }
  flight = { cwd, id };
  e.dataTransfer?.setData('text/plain', 'card:' + id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('dragging-card');
  slot.classList.add('lifted');
  // Only the source group takes the drop: a group is a directory, and no drag
  // can change a running process's cwd.
  for (const other of cards.querySelectorAll<HTMLElement>('.grid[data-cwd]')) {
    if (other !== grid) other.dataset.inert = '';
  }
});

cards.addEventListener('dragover', (e) => {
  if (!flight) return;
  const grid = gridOf(e.target);
  // No `preventDefault` for another group, which is what leaves the browser
  // drawing its own `no-drop` cursor — the refusal explains itself.
  if (!grid || grid.dataset.cwd !== flight.cwd) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  showBar(grid, e.clientX, e.clientY);
});

cards.addEventListener('dragleave', (e) => {
  if (flight && !gridOf(e.target)) hideBars();
});

cards.addEventListener('drop', (e) => {
  if (!flight) return;
  const grid = gridOf(e.target);
  if (!grid || grid.dataset.cwd !== flight.cwd) {
    endDrag();
    return;
  }
  e.preventDefault();
  // Three statements in this order, and the order is the point. The index is
  // read while the slots are still where the reader aimed at them; `endDrag`
  // then ends the flight, because a release *is* the end of it; and only then
  // does `commit` repaint. That is what lets the reorder animate: `renderBoard`
  // holds still for a card in flight, and the one repaint a reorder exists to
  // show would otherwise be the one still counted as part of the gesture.
  //
  // Safe to end the drag before measuring nothing further: `.lifted` and
  // `[data-inert]` are opacity and filter (`document.ts:1078,1084`), so
  // dropping them moves no rect the index was taken against.
  const { cwd, id } = flight;
  const at = insertionIndex(grid, e.clientX, e.clientY);
  endDrag();
  commit(grid, cwd, id, at);
});

cards.addEventListener('dragend', endDrag);

export function endDrag(): void {
  flight = null;
  onHandle = false;
  lastOver = null;
  document.body.classList.remove('dragging-card');
  hideBars();
  for (const n of cards.querySelectorAll('.lifted')) n.classList.remove('lifted');
  for (const n of cards.querySelectorAll<HTMLElement>('[data-inert]')) delete n.dataset.inert;
}

/**
 * Where a drop at (x, y) would insert, as an index into the group's slots.
 *
 * Row-aware rather than a flat midpoint list: the cards are a wrapping grid, so
 * a pointer above a card's row belongs before it whatever the column, and only
 * within a row does the horizontal midpoint decide. Falling off the end is the
 * tail, which is also what jsdom's zero rects produce.
 */
export function insertionIndex(grid: HTMLElement, x: number, y: number): number {
  const nodes = slotNodes(grid);
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i]?.getBoundingClientRect();
    if (!r) continue;
    if (y < r.top) return i; // a row above
    if (y <= r.bottom && x < r.left + r.width / 2) return i; // this row, left half
  }
  return nodes.length;
}

/**
 * Draw the bar where the drop would land: between two slots, never on one — the
 * whole-target tint is already spent on the ticket drop.
 *
 * Nothing is written when the answer has not changed. `dragover` fires on every
 * mouse move, and rewriting three style properties each time is DOM thrash a
 * board that morphs every second cannot afford; the index still has to be
 * computed to know that, which is the read this cannot avoid.
 */
export function showBar(grid: HTMLElement, x: number, y: number): void {
  const nodes = slotNodes(grid);
  if (!nodes.length) return;
  const at = insertionIndex(grid, x, y);
  const key = grid.dataset.cwd + ':' + at;
  if (key === lastOver) return;
  lastOver = key;
  hideBars();
  const bar = grid.querySelector<HTMLElement>(':scope > .ins');
  const ref = nodes[Math.min(at, nodes.length - 1)];
  if (!bar || !ref) return;
  const r = ref.getBoundingClientRect();
  const w = grid.getBoundingClientRect();
  // Before the slot it names, except at the tail, where there is no slot after
  // the last one to sit in front of. 6px and 3px against the grid's 10px gap:
  // the bar is 3px wide, so both land it in the middle of the gutter.
  const before = at < nodes.length;
  bar.style.left = (before ? r.left - w.left - 6 : r.right - w.left + 3) + 'px';
  bar.style.top = r.top - w.top + 'px';
  bar.style.height = r.height + 'px';
  bar.classList.add('on');
}

export function hideBars(): void {
  for (const bar of cards.querySelectorAll('.ins')) bar.classList.remove('on');
}

/**
 * The whole group's order, written once, on the drop.
 *
 * Read off the screen rather than recomputed from the state: what the reader
 * arranged is what they were looking at, and the slot nodes are the only thing
 * that knows both what a filter left standing and what the last paint drew.
 *
 * Painted before the host answers. The next push overwrites it either way, so a
 * write that failed shows up as the card visibly returning to where it was
 * within a poll — which is the honest report of "that did not save".
 */
export function commit(grid: HTMLElement, cwd: string, id: number, at: number): void {
  const ids = slotNodes(grid)
    .map((n) => Number(n.dataset.slot))
    .filter((pid) => Number.isInteger(pid));
  const from = ids.indexOf(id);
  if (from === -1) return;
  ids.splice(from, 1);
  // The index was taken against the list with the slot still in it, so a move
  // to the right has counted its own vacated place.
  ids.splice(at > from ? at - 1 : at, 0, id);
  const group = ui.state.groups.find((g) => g.cwd === cwd);
  if (group) group.slots = ids;
  repaintBoard();
  vscode.postMessage({ type: 'arrange', cwd, slots: ids });
}
