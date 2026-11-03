/**
 * The board: one card per session, plus the nav bar above it — the status
 * tally, the filter, and the bars that appear when sessions are waiting or
 * dead. Layout and paint live here. Paint and interaction families live in
 * board_*.ts.
 */

import { el } from './dom';
import { cards, chats, nav, setCols, ui } from './state';
import { morph, slide } from './kit';
import { record } from './perf';
import { setBoardRepaint } from './board_repaint';
import { CACHE_NOTE, cacheGone, since, tickStamps } from './board_stamps';
import { blocked, card, family, findCard } from './board_card';
import { refuseTheme, settleTheme, modelMenuBody } from './board_settings';
import { serverDoor, serverSection } from './board_servers';
import * as warm from './board_warm';
import { pendingResumeCards } from './resume';
import { editing } from './editor';
import {
  addCard,
  carryDrag,
  filter,
  prunePending,
  renderAlert,
  renderNav,
  shown,
  startingCard
} from './board_nav';
// Side-effect: register delegated + arrange listeners.
import './board_actions';
import './board_arrange';

export {
  CACHE_NOTE,
  cacheGone,
  since,
  tickStamps,
  refuseTheme,
  settleTheme,
  modelMenuBody,
  findCard,
  blocked
};

/**
 * The board's one measurement: how many columns `auto-fill` settled on, which
 * caps a family box's width. Read off the ruler `renderBoard` emits, never off
 * a group's own grid (see the comment there).
 *
 * Called from a `ResizeObserver`, never from a paint: the count follows the
 * board's width alone, so a paint that re-reads it is a forced reflow for
 * nothing. It repaints on a change, since the boxes are sized from it.
 */
export function measureColumns(): void {
  if (readColumns() !== ui.cols) relayout();
}

/**
 * What a push would have to change for the board to move: the groups, the
 * sessions in each, their order, and which are boxed together. Anything else a
 * push carries repaints a card in the slot it is already in.
 */
export function boardShape(groups: GroupView[]): string {
  return JSON.stringify(
    groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid), g.slots ?? [], g.families ?? []])
  );
}

/**
 * The count the ruler shows now, or `ui.cols` where there is none. Read off the
 * browser, not recomputed from the 290px rule, so the two cannot drift:
 * `gridTemplateColumns` computes to the used track list, one length per
 * column, and `auto-fill` keeps its empty tracks. Anything else (jsdom lays
 * nothing out and returns the `repeat(...)` as written) falls back to 2, which
 * the grid's `min(290px, 50% - 5px)` makes a floor: a board too narrow for
 * 290px columns still fits two. Reading low only makes a box narrower. Reading
 * high would have the grid invent implicit columns and resize every loose card
 * in the group.
 */
function readColumns(): number {
  const grid = cards.querySelector('.grid.ruler');
  if (!grid) return ui.cols;
  const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ');
  return tracks.every((t) => t.endsWith('px')) ? tracks.length : 2;
}

export function relayout(): void {
  setCols(readColumns());
  renderBoard();
}

/**
 * One top-level thing on a group's grid: a loose card, or a family box named by
 * its head card. One card is in exactly one place, so a slot is a pid.
 */
type BoardSlot =
  | { id: number; card: CardView; fam?: undefined }
  | { id: number; card?: undefined; fam: FamilyView };

/**
 * The group's slots in render order: the stored ones first, then everything the
 * arrangement does not name, in derived order. No merge rule, because the
 * derived rule already puts the newest last.
 *
 * `g.slots` is the host's fold (`ui/views.ts`). This walk handles where the two
 * disagree: a family whose head is not on the board dissolves here and not
 * there, so an arrangement can name a gone box and leave its members unnamed.
 * The tail keeps those cards on screen. A head that closes hands the box to the
 * next member, which changes the slot id, so that box falls into the tail.
 *
 * Ignored under a filter (§5.7): an insertion between two visible cards says
 * nothing about the hidden ones, and writing the visible order back would lose
 * data.
 */
function slots(g: GroupView, sessions: CardView[], families: FamilyView[]): BoardSlot[] {
  const boxed = new Set(families.flatMap((f) => f.members));
  const derived: BoardSlot[] = [
    ...sessions.filter((s) => !boxed.has(s.pid)).map((s) => ({ id: s.pid, card: s })),
    ...families.map((f) => ({ id: f.parent, fam: f }))
  ];
  const order = filter === 'all' ? g.slots : undefined;
  if (!order) return derived;
  const by = new Map(derived.map((s) => [s.id, s]));
  const head = order.map((id) => by.get(id)).filter((s) => s !== undefined);
  const placed = new Set(head.map((s) => s.id));
  return [...head, ...derived.filter((s) => !placed.has(s.id))];
}

/** The slot order the last paint drew, or `undefined` before the first one. */
let slotted: string | undefined;

/**
 * The board, repainted, and travelling there when the paint moves a card. A
 * paint whose slot order differs from the last one animates. That is the
 * condition the animation was admitted on (`PRD_card_arrangement.md`,
 * 2026-07-29): the objection was an animation cut mid-flight by the 1s
 * repaint, and a repaint that changes nothing cannot start one. The gate lives
 * here so no call site has to ask for motion. `boardShape()` defines
 * "differs", narrower than "anything that moves a card". A filter pick stays a
 * cut because most cards leave rather than travel, which wants its own design.
 * The alert bar's expand grows without re-ordering. The starting card appears
 * in the slot it will keep.
 *
 * Nothing animates while a card is in flight: the ticker fires under a drag, a
 * session can start under one, and moving cards slide out from under the hand.
 * Nothing animates on the first paint. A slide landing on a running one
 * continues from where the cards visually are, because `slide` measures the
 * transform it interrupts. **The motion is FLIP, in the page**, so a card
 * stays in the normal stacking order for the whole 320ms.
 * `startViewTransition` fails: its snapshots paint above every overlay.
 * `kit.ts`'s `slide` carries the argument and the measurements. Synchronous:
 * `slide` runs `paint` inline, so a caller may read a rect or a class off the
 * board straight afterwards.
 */
export function renderBoard(): void {
  // Editor owns the board column; do not fight it with card travel/morph.
  if (editing() || ui.boardView !== 'sessions') {
    paint();
    return;
  }
  const shape = boardShape(ui.state.groups);
  const moved = slotted !== undefined && slotted !== shape;
  slotted = shape;
  if (moved && !document.body.classList.contains('dragging-card')) slide(cards, paint);
  else paint();
}

function paint(): void {
  // The count `TASK_done_panel_repaint_cost.md` measures. The 1s beat reaches
  // this only through `prunePending` (`tickStamps`).
  record('paint');
  prunePending();
  cards.className = '';
  cards.setAttribute('aria-busy', String(!ui.ready));
  const inEditor = editing();
  // Ahead of every early return below: an empty board and an open editor both
  // have to put the bar away.
  renderAlert(inEditor || ui.boardView !== 'sessions');
  nav.hidden = false;
  renderNav();
  if (inEditor || ui.boardView !== 'sessions') {
    warm.sync();
    return;
  }
  if (!ui.ready || !ui.state.groups.length) {
    cards.className = 'empty';
    cards.textContent = ui.ready ? 'No sessions running.' : 'Loading sessions…';
    warm.sync();
    return;
  }
  const nodes: HTMLElement[] = [];
  let count = 0;
  for (const g of ui.state.groups) {
    const sessions = shown(g);
    // An unsent draft has no card, so this slot is all the board says about
    // one, and a filter may not take it. Every other add slot goes: it cannot
    // match a filter, and a group with no match is a heading over an empty grid.
    const drafting = chats.draftFor(g.cwd) !== undefined;
    const resuming = pendingResumeCards(g.cwd);
    if (filter !== 'all' && !sessions.length && !drafting && !resuming.length) continue;
    count += sessions.length;
    // The three things a group is, as one node. Structural only: the section is
    // not painted.
    const repo = el('section', 'repo');
    repo.dataset.key = 'repo:' + g.cwd;
    const title = el('h2', null, g.label);
    if (g.app) title.append(el('span', 'app', g.app));
    const door = serverDoor(g);
    if (door) title.append(door);
    repo.append(title);
    const servers = serverSection(g);
    if (servers) repo.append(servers);
    const grid = el('div', 'grid');
    // What a drag scopes itself to. The cwd sits on the grid, not the section,
    // because the slots are its children and every query and rect is measured
    // against it.
    grid.dataset.cwd = g.cwd;
    // A filter dissolves the boxes: a box showing one of three members says
    // something false about the family. A family whose parent is not on the
    // board dissolves too: nothing heads it, and its members are loose cards.
    const families = (filter === 'all' ? (g.families ?? []) : []).filter((f) => findCard(f.parent));
    for (const s of slots(g, sessions, families)) {
      const node = s.fam ? family(s.fam, sessions) : card(s.card);
      if (!node) continue;
      node.dataset.slot = String(s.id);
      // The box survives the morph as one node, so a family picked up by its
      // header is still under the pointer a paint later. A card keys itself.
      if (s.fam) node.dataset.key = 'fam:' + s.id;
      // Under a filter there is no gesture to explain away — see `slots`.
      node.draggable = filter === 'all';
      grid.append(node);
    }
    grid.append(...resuming);
    if (filter === 'all' || drafting) {
      if (chats.openInFlight(g.cwd)) grid.append(startingCard(g.cwd));
      grid.append(addCard(g));
    }
    // Where a drop would land, moved rather than rebuilt. Absolutely positioned,
    // so it joins no track. Keyed, so `carryDrag` can hold it still for a
    // flight. It is not a slot.
    const bar = el('div', 'ins');
    bar.dataset.key = 'ins:' + g.cwd;
    grid.append(bar);
    repo.append(grid);
    nodes.push(repo);
  }
  // A pick stands when the last session it caught ends. The bar still shows
  // the pick, so the board has to say why it is empty.
  if (filter !== 'all' && !count) {
    const none = el('div', null, 'No ' + filter + ' sessions left.');
    none.id = 'filtered-empty';
    nodes.push(none);
  }
  // The board's ruler, and the only grid `measureColumns` may read. A family
  // box still carrying the wider board's `--span` spans past a group grid's
  // explicit tracks, the grid invents an implicit column, and
  // `gridTemplateColumns` reports the *used* list. So the wrong count is a
  // stable fixed point, not one frame's mistake. Observed on the shipping
  // panel: opening the dock on a 1400px window drew a two-column board as
  // three tracks, every third card 199px against its neighbours' 318px, across
  // the ticker and further toggles.
  //
  // Nothing is placed in here, and `auto-fill` resolves its count from the
  // available width, not content, so an empty grid answers the same question.
  const ruler = el('div', 'grid ruler');
  ruler.dataset.key = 'ruler';
  nodes.push(ruler);
  // Morphed, not replaced. `renderBoard` runs every second and on every state
  // push, and a keyed card stays the same element, so a press, a hover, a drop
  // outline and the focus ring survive a paint under them.
  morph(cards, nodes, (from, to) => {
    warm.carry(from, to);
    return carryDrag(from, to);
  });
  warm.sync();
}

setBoardRepaint(renderBoard);
