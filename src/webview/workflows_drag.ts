/**
 * The flight, in pointer events rather than the HTML5 drag the editor and the
 * board both spend.
 *
 * Not a style choice, and not the PRD's own reason either (it wanted a hook for
 * auto-scrolling a scroller, which DnD gives none of). The load-bearing one is
 * the hold: `dragstart` fires on the platform's threshold, not on a timer we
 * own, so a hold-to-lift **cannot be expressed in the DnD API at all**. Both
 * existing drags here are grip-only, which is exactly why they could stay.
 *
 * Nothing crosses the wire until release, which is what makes S6 true: a
 * permission prompt paints over the sheet mid-flight and the order is
 * unchanged.
 */

import { $, el, q } from './dom';
import * as bottomDrawer from './bottom_drawer';
import * as layers from './layers';
import * as workflows from './workflows_mode';

/** How long a press anywhere on a row must rest before it becomes a lift. */
const HOLD_MS = 350;
/** A press that travels this far before the hold lands was a scroll, not a lift. */
const SLOP = 5;
/** How near the list's edge a flight has to be to scroll it, and by how much a frame. */
const EDGE = 26;
const EDGE_STEP = 12;

type Flight = {
  id: string;
  /** The row's index in the whole list, which is the list the order is stated in. */
  from: number;
  pointerId: number;
  row: HTMLElement;
  ghost: HTMLElement;
  line: HTMLElement;
  /** The pointer's offset into the row when it was lifted, so the ghost stays
   *  under the hand rather than snapping its corner to it. */
  dx: number;
  dy: number;
  y: number;
  /** The boundary a release would insert at, counting the carried row. */
  at: number;
  /** The auto-scroll frame, or 0 when the pointer is not near an edge. */
  scroll: number;
  /** A transient layer above the drawer for the flight's life: Escape cancels
   *  the flight and nothing else, wherever the caret is. */
  layer: layers.Handle;
};

let flight: Flight | undefined;
/** A press resting on a row, with the timer that would turn it into a lift. */
let hold: { row: HTMLElement; pointerId: number; x: number; y: number; timer: number } | undefined;
/**
 * Set on release, read by the row's own `onclick`.
 *
 * A drag ends in a `click` on the row it started on, and a click on a row
 * selects it — so without this every reorder would also move the detail
 * column to the row just carried. Cleared on the next press.
 */
let dragged = false;

export function inFlight(): boolean {
  return flight !== undefined;
}

export function justDragged(): boolean {
  return dragged;
}

const listEl = (): HTMLElement => q($('bottomdrawer-body'), '.bdlist');

const drawnRows = (): HTMLElement[] => [
  ...listEl().querySelectorAll<HTMLElement>(':scope > .wsrow')
];

/** Measure .wsrow alone; see newRow for why its gutter cannot receive a drop. */
function insertionIndexY(y: number): number {
  const nodes = drawnRows();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const r = node.getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return nodes.length;
}

const landing = (at: number, from: number): number => (at > from ? at - 1 : at);

function showLine(): void {
  if (!flight) return;
  // The two boundaries either side of the carried row put it back where it
  // already is, and a line there promises a move the release then refuses.
  if (landing(flight.at, flight.from) === flight.from) {
    flight.line.classList.remove('on');
    return;
  }
  const nodes = drawnRows();
  const before = nodes[flight.at];
  const last = nodes[nodes.length - 1];
  // Positioned in the list's own coordinates — `.bdlist` is the offset parent
  // and the scroller both, so the line rides the scroll rather than needing to
  // be repainted on it.
  const top = before ? before.offsetTop : last ? last.offsetTop + last.offsetHeight : 0;
  flight.line.style.top = `${top - 1}px`;
  flight.line.classList.add('on');
}

function edgeStep(): number {
  if (!flight) return 0;
  const box = listEl().getBoundingClientRect();
  if (box.height === 0) return 0;
  if (flight.y - box.top < EDGE) return -EDGE_STEP;
  if (box.bottom - flight.y < EDGE) return EDGE_STEP;
  return 0;
}

/**
 * Scroll the list while a flight rests near its edge.
 *
 * The genuinely new piece (C3): a pointer drag gets none of this for free, and
 * a list past the sheet's cap cannot otherwise be crossed. Hand-driven, one
 * frame at a time, and it stops itself the moment the pointer leaves the band.
 * In jsdom every rect is zero, so the band never opens and no frame is ever
 * asked for.
 */
function autoscroll(): void {
  if (!flight || flight.scroll !== 0 || edgeStep() === 0) return;
  const tick = (): void => {
    if (!flight) return;
    const by = edgeStep();
    if (by === 0) {
      flight.scroll = 0;
      return;
    }
    listEl().scrollTop += by;
    flight.at = insertionIndexY(flight.y);
    showLine();
    flight.scroll = requestAnimationFrame(tick);
  };
  flight.scroll = requestAnimationFrame(tick);
}

function cancelHold(): void {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold = undefined;
}

function lift(node: HTMLElement, pointerId: number, x: number, y: number): void {
  cancelHold();
  const id = node.dataset.id;
  // Refused while the list is narrowed: the drawn rows are the hits and the
  // order is stated over the whole list, so a row would trade places with
  // something off screen and nothing would appear to have happened.
  // A repair row stays in the tail. Lifting it would state a place it cannot keep.
  if (flight || id === undefined || workflows.isFiltered() || node.dataset.repair === 'true')
    return;
  const from = workflows.ordered().findIndex((w) => w.id === id);
  if (from === -1) return;

  const box = node.getBoundingClientRect();
  // A copy rather than the row itself: the row stays in the list, dimmed, so
  // the boundaries the index is measured against never move under the pointer.
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.classList.add('flying');
  ghost.classList.remove('sel');
  // Neither keyed nor identified: a morph must never pair this with the row it
  // was copied from, and nothing may find it by `data-id` either.
  delete ghost.dataset.key;
  delete ghost.dataset.id;
  ghost.removeAttribute('role');
  ghost.removeAttribute('tabindex');
  ghost.style.width = `${box.width}px`;
  ghost.style.left = `${box.left}px`;
  ghost.style.top = `${box.top}px`;
  // Inside `#bottomdrawer`, not beside it: the sheet is what a flying row must stay
  // under when a question arrives (S6), and its own stacking context is what
  // says so.
  $('bottomdrawer').append(ghost);

  const line = el('div', 'wsins');
  listEl().append(line);
  node.classList.add('lifted');
  document.body.classList.add('dragging-wf');
  // Capture, so a pointer that leaves the sheet — or the window — still reports
  // to the row that owns the flight, and still ends it on release.
  try {
    node.setPointerCapture(pointerId);
  } catch {
    // jsdom, and any host that does not know this pointer. The document
    // listeners below are what the flight actually runs on.
  }

  flight = {
    id,
    from,
    pointerId,
    row: node,
    ghost,
    line,
    dx: x - box.left,
    dy: y - box.top,
    y,
    at: from,
    scroll: 0,
    layer: layers.push({ kind: 'flight', close: cancelFlight, escape: 'consume' })
  };
  showLine();
}

function track(x: number, y: number): void {
  if (!flight) return;
  flight.y = y;
  flight.ghost.style.left = `${x - flight.dx}px`;
  flight.ghost.style.top = `${y - flight.dy}px`;
  flight.at = insertionIndexY(y);
  showLine();
  autoscroll();
}

function endFlight(): void {
  if (!flight) return;
  if (flight.scroll !== 0) cancelAnimationFrame(flight.scroll);
  try {
    flight.row.releasePointerCapture(flight.pointerId);
  } catch {
    // Never captured, or the pointer has already gone.
  }
  flight.ghost.remove();
  flight.line.remove();
  flight.row.classList.remove('lifted');
  document.body.classList.remove('dragging-wf');
  const { layer } = flight;
  flight = undefined;
  layer.pop();
}

function drop(): void {
  if (!flight) return;
  const { id, from, at } = flight;
  endFlight();
  dragged = true;
  const runs = workflows.ordered().filter((w) => w.repair !== true);
  const runFrom = runs.findIndex((w) => w.id === id);
  if (runFrom !== -1) {
    // `at` counts the repair tail too. A landing past the runnable rows is the
    // last place a workflow can sit.
    const to = Math.min(landing(at, from), runs.length - 1);
    if (to !== runFrom) {
      const ids = runs.map((w) => w.id);
      ids.splice(runFrom, 1);
      ids.splice(to, 0, id);
      // Drawn now, and stated only as far down as the move reached. The whole
      // drawn list would write every id on the machine down as *placed* (PRD
      // Q6) — freezing the label-ordered tail, so a later rename would no
      // longer re-sort it.
      workflows.commitOrder(ids, Math.max(runFrom, to) + 1);
    }
  }
  bottomDrawer.render();
}

/** Esc mid-flight, and a pointer the host takes away: nothing is stated. */
export function cancelFlight(): void {
  if (!flight) return;
  endFlight();
  dragged = true;
  bottomDrawer.render();
}

/** Keep hold-to-lift outside the grip path so removing its timer leaves grip dragging. */
document.addEventListener('pointerdown', (e) => {
  cancelHold();
  dragged = false;
  if (!bottomDrawer.isOpen() || flight) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  const on = t.closest<HTMLElement>('#bottomdrawer-body .bdlist .wsrow');
  if (!on || on.dataset.id === undefined) return;
  // The row's own controls. A press resting on a control is a press on that
  // control, however long it rests there.
  if (t.closest('.act')) return;
  if (t.closest('.wsgrip')) {
    // The platform would otherwise start a text selection under the flight.
    e.preventDefault();
    lift(on, e.pointerId, e.clientX, e.clientY);
    return;
  }
  const timer = window.setTimeout(() => {
    const at = hold;
    if (!at) return;
    lift(at.row, at.pointerId, at.x, at.y);
  }, HOLD_MS);
  hold = { row: on, pointerId: e.pointerId, x: e.clientX, y: e.clientY, timer };
});

document.addEventListener('pointermove', (e) => {
  if (hold) {
    // Travel before the hold lands is a scroll or a text selection, not a lift.
    if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > SLOP) cancelHold();
    return;
  }
  if (!flight || e.pointerId !== flight.pointerId) return;
  e.preventDefault();
  track(e.clientX, e.clientY);
});

document.addEventListener('pointerup', (e) => {
  cancelHold();
  if (flight && e.pointerId === flight.pointerId) drop();
});

/** A pointer the host takes away — a touch turned into a scroll, a window that
 *  lost the device. Nothing is stated, which is `cancelFlight`'s whole job. */
document.addEventListener('pointercancel', (e) => {
  cancelHold();
  if (flight && e.pointerId === flight.pointerId) cancelFlight();
});
