/**
 * The session-lane canvas: the workflow v2 authoring surface, UI only.
 *
 * **Row is the grid row (`graph.layout`), column is session.** A workflow
 * whose steps declare what they need is a graph, and the board-mode rail can
 * only draw a list. Here a peer session is a column, named in a header row
 * over it, with a divider between two.
 *
 * **The canvas replaces, it does not morph.** `renderCanvas` returns a fresh
 * tree and the caller swaps it in. Typing in an open node writes the draft and
 * does not rebuild, so no caret is lost. `kit.ts`'s keyed morph is for
 * containers that repaint on a poll. This one repaints on a gesture. The open
 * prompt is the exception: it is an editor the caller keeps (`boxes.ts`), and
 * the swap is `rebuild`, which grafts the fresh tree around it rather than
 * taking it out of the document.
 *
 * Design reference: `docs/mockups/workflow-v2-lane-authoring.html`, over
 * `docs/mockups/workflow-v2-directions.html` §3d.
 */

import { rebuild } from './boxes';
import { $, el, typingIn } from './dom';
import { opensMenu } from './kit';
import { icon } from '../ui/icons';
import { route } from '../ui/wfroute';
import type { RouteEdge, RouteRect } from '../ui/wfroute';
import type { CanvasGraph, CanvasNode } from './wfgraph';
import type { DropRow, LinkRefusal } from '../core/workflows/authoring';

/** What the canvas can ask of whoever mounted it. */
export type CanvasHandlers = {
  /** A node was clicked, or the open one dismissed. `null` closes. */
  onOpen(id: string | null): void;
  /** The open node's name changed. Writes the draft; never rebuilds. */
  onEdit(id: string, value: string): void;
  /** Fill the menu the model chip on a lane-opening node opens. */
  fillModel(id: string, menu: HTMLElement): void;
  /** Fill the menu the effort chip beside it opens. */
  fillEffort(id: string, menu: HTMLElement): void;
  /** Remove, in an open node's foot. */
  onRemove(id: string): void;
  /** `+ New session` in the ghost column. */
  onAddRoot(): void;
  /** A column's Add step, with the file's lane (`''` is the starting session). */
  onAddStep(lane: string): void;
  /** A selected wire was deleted, or its trash pressed. */
  onUnlink(from: string, to: string): void;
  /** A wire dropped from `from` onto `to`. */
  onLink(from: string, to: string): void;
  /** The steps a wire from `from` cannot reach, and why, asked once as the drag starts. */
  refusalsFrom(from: string): ReadonlyMap<string, LinkRefusal>;
  /** A lane's name was edited and committed. `file` is the name it had. */
  onRenameLane(file: string, name: string): void;
  /**
   * A step carried by its grip was released into `row` of its own lane, or,
   * with `null`, anywhere else — where it goes back and nothing moved.
   */
  onDrop(id: string, row: DropRow | null): void;
  /**
   * The open node's prompt: the node to put where the field goes, asked for as
   * the node is drawn and before the wires are measured. The caller keeps the
   * editor across renders, so this is its host, or `boxes.ts`' stand-in for it
   * while it is still on screen. Its class is `wcbody`.
   */
  prompt(id: string, field: { label: string; locked: boolean }): HTMLElement;
};

/** The graph on screen, kept so a resize can re-measure. Null when nothing is mounted. */
let mounted: { graph: CanvasGraph; root: HTMLElement; handlers: CanvasHandlers } | null = null;

/**
 * The wire a click selected, so the trash knows which edge it drops,
 * and where on the canvas it was clicked, which is where the trash is drawn.
 */
let selectedWire: { from: string; to: string; x: number; y: number } | null = null;

/** Ends the wire drag in flight, whichever way it ends. Null when none is. */
let endWire: (() => void) | null = null;

/** The step being carried by its grip, and the lane it may be dropped back into. */
let flight: { id: string; lane: string } | null = null;

let keysBound = false;

/** Bound once, not per mount — a resize moves every rect below a reflow. */
let resizeBound = false;

/**
 * Draw the whole canvas from the graph alone. The caller owns where it goes.
 * The wires are measured, so they are painted after the tree is in the document.
 */
export function renderCanvas(graph: CanvasGraph, handlers: CanvasHandlers): HTMLElement {
  const stage = el('div', 'wcstage');
  const scroll = el('div', 'wcscroll');
  const pipe = el('div', 'wcpipe');
  pipe.style.setProperty('--wc-lanes', String(graph.lanes.length));
  // The new-session tile's column is one more lane: same width, one more gap.
  pipe.style.setProperty('--wc-cols', String(graph.lanes.length + 1));

  // One grid in every state: a workflow should not change surface on its
  // second step, nor on its second session.
  pipe.append(el('div', 'wclattice'));

  const grid = el('div', 'wcgrid');
  // The column is the track's place. A lane name is authored text, so `s0` or
  // a space is not what places the card.
  for (const [i, track] of graph.tracks.entries()) {
    const column = String(i + 1);
    const head = el('div', track.armed ? 'wchd armed' : 'wchd');
    head.style.gridColumn = column;
    head.style.gridRow = '1';
    head.dataset.lane = track.file;
    head.append(laneName(head, track.file, track.name, track.armed, handlers));
    head.append(el('span', null, track.note));
    if (track.why) head.append(el('span', 'wcwhy', track.why));
    grid.append(head);
  }
  // One full-height line per gap. Nothing else is drawn for a column.
  for (let i = 1; i < graph.lanes.length + 1; i++) {
    const divider = el('i', 'wcdiv');
    divider.style.setProperty('--wc-after', String(i));
    pipe.append(divider);
  }

  for (const [i, node] of graph.nodes.entries()) {
    grid.append(renderNode(node, i + 1, graph, handlers));
  }
  // A cell of the lane's own, on the row after its deepest step, so a card
  // that grows pushes it down rather than drawing over it. That cell is empty
  // by construction: nothing of this lane sits deeper.
  const last = Math.max(...graph.nodes.map((n) => n.depth)) + 1;
  for (const [i, track] of graph.tracks.entries()) {
    const column = String(i + 1);
    const own = graph.nodes.filter((n) => n.lane === track.lane).map((n) => n.depth);
    const deepest = Math.max(...own);
    const slot = addStepButton(track.file, `Add step to ${track.name}`, handlers);
    slot.disabled = graph.locked;
    slot.style.gridColumn = column;
    slot.style.gridRow = String(deepest + 3);
    slot.dataset.row = String(deepest + 2);
    grid.append(slot);
    // Every other empty row down to one past the deepest step anywhere: where
    // a carried card can be dropped. A session's first step is row 2 at the
    // earliest, so a named column has no row 1.
    for (let depth = track.armed ? 0 : 1; depth <= last; depth++) {
      if (own.includes(depth) || depth === deepest + 1) continue;
      const cell = el('div', 'wccell');
      cell.dataset.lane = track.file;
      cell.dataset.row = String(depth + 1);
      cell.style.gridColumn = column;
      cell.style.gridRow = String(depth + 2);
      grid.append(cell);
    }
  }
  // A step-sized tile where a new session's first step would sit.
  const tile = el('div', 'wcghost');
  tile.style.gridColumn = String(graph.lanes.length + 1);
  tile.style.gridRow = '2';
  const add = el('button', 'wcadd', '+ New session') as HTMLButtonElement;
  add.type = 'button';
  add.onclick = () => handlers.onAddRoot();
  tile.append(add);
  grid.append(tile);
  pipe.append(grid);

  // Inside the scrolled content, not beside it: at four lanes the stage is
  // wider than the board, and an SVG outside the scroller clips at the fold.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wcwires');
  pipe.append(svg);

  scroll.append(pipe);
  stage.append(scroll);
  return stage;
}

/** A peer's name is a button that becomes a field. The starting session's is text. */
function laneName(
  head: HTMLElement,
  file: string,
  name: string,
  armed: boolean,
  handlers: CanvasHandlers
): HTMLElement {
  if (armed) return el('b', null, name);
  const button = el('button', 'name', name) as HTMLButtonElement;
  button.type = 'button';
  button.onclick = () => beginRename(head, file, name, handlers);
  return button;
}

/**
 * Enter commits, Escape puts the name back, and blur commits only a changed
 * name. A commit is the caller's, which repaints. A cancel is the canvas's.
 */
function beginRename(
  head: HTMLElement,
  file: string,
  current: string,
  handlers: CanvasHandlers
): void {
  const button = head.querySelector('button.name');
  const input = el('input', 'name') as HTMLInputElement;
  input.type = 'text';
  input.value = current;
  button?.replaceWith(input);
  input.focus();
  input.select();
  const finish = (commitIt: boolean): void => {
    input.onblur = null;
    if (commitIt) handlers.onRenameLane(file, input.value);
    else input.replaceWith(laneName(head, file, current, false, handlers));
  };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    }
  };
  input.onblur = () => finish(input.value.trim() !== current);
}

function addStepButton(lane: string, label: string, handlers: CanvasHandlers): HTMLButtonElement {
  const button = el('button', 'wcaddstep') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.lane = lane;
  button.setAttribute('aria-label', label);
  const cap = el('span', 'cap', '+');
  cap.setAttribute('aria-hidden', 'true');
  button.append(cap, el('b', null, 'Add step'));
  button.onclick = () => handlers.onAddStep(lane);
  return button;
}

/**
 * One node, closed or open. One builder for both faces, so they cannot drift:
 * an opened node keeps its label and description in the same places, as fields.
 */
function renderNode(
  node: CanvasNode,
  ordinal: number,
  graph: CanvasGraph,
  handlers: CanvasHandlers
): HTMLElement {
  const open = graph.open === node.id;
  const locked = graph.locked;
  const box = el(
    'div',
    [
      'wcnode',
      open ? 'editing' : '',
      node.waiting ? 'waiting' : '',
      graph.enter === node.id ? 'enter' : ''
    ]
      .filter(Boolean)
      .join(' ')
  );
  box.dataset.node = node.id;
  // The file's lane, so a card of its lane dropped on this one takes its row.
  box.dataset.lane = node.lane;
  box.style.gridColumn = String(graph.lanes.indexOf(node.lane) + 1);
  // Row 1 is the header. Depth 0 is the first step row.
  box.style.gridRow = String(node.depth + 2);
  box.dataset.row = String(node.depth + 1);
  box.append(grip(locked));

  const head = el('div', 'wchead');
  head.append(glyph(node.badge));
  if (open) {
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'wctitle';
    name.value = node.label;
    name.placeholder = 'Name this step';
    name.setAttribute('aria-label', `Step ${ordinal} name`);
    name.disabled = locked;
    // Input, not change: the draft is what the reader is looking at, and a
    // value that only lands on blur is a value that can be lost by a click.
    name.oninput = () => handlers.onEdit(node.id, name.value);
    head.append(name);
  } else if (node.label.trim()) {
    head.append(el('span', 'wcname', node.label));
  } else {
    head.append(el('span', 'wcname empty', 'Untitled step'));
  }
  box.append(head);
  if (node.waiting) box.append(el('div', 'wcwait', 'needs a wire'));

  if (open) {
    box.append(handlers.prompt(node.id, { label: `Step ${ordinal} prompt`, locked }));
  } else if (node.description) {
    box.append(el('div', 'wcdesc', node.description));
  }

  for (const why of node.why ?? []) box.append(el('div', 'wcwhy', why));

  // Model, then effort, on a lane-opening node and nowhere else. Two chips
  // rather than one control: an effort can be absent on its own (Haiku), and
  // each borrows from a different place when the file says nothing.
  if (node.model !== undefined) {
    const row = el('div', 'wcmodel');
    row.append(
      chip('model', node.model, node.stated?.model !== false, locked, (menu) =>
        handlers.fillModel(node.id, menu)
      )
    );
    if (node.effort !== undefined) {
      row.append(
        chip('effort', node.effort, node.stated?.effort !== false, locked, (menu) =>
          handlers.fillEffort(node.id, menu)
        )
      );
    }
    box.append(row);
  }

  if (open) {
    const done = el('button', 'wcdone', 'Done') as HTMLButtonElement;
    done.type = 'button';
    done.disabled = locked;
    done.onclick = (e) => {
      e.stopPropagation();
      handlers.onOpen(null);
    };
    const foot = el('div', 'wcfoot');
    if (node.removable) {
      const rm = el('button', 'werm', 'Remove') as HTMLButtonElement;
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove step ${ordinal}`);
      rm.disabled = locked;
      rm.onclick = (e) => {
        e.stopPropagation();
        handlers.onRemove(node.id);
      };
      foot.append(rm);
    }
    foot.append(done);
    box.append(foot);
  } else {
    // A button to the keyboard as well as the mouse: without it a closed node
    // is out of Tab order.
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', `Open ${node.label || `step ${node.badge}`}`);
    box.onclick = () => handlers.onOpen(node.id);
    box.onkeydown = (e) => {
      if (e.target !== box || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      handlers.onOpen(node.id);
    };
  }
  box.append(wirePort(node.id, handlers));
  return box;
}

/**
 * The reorder handle. The drag itself is `wireArrange`, keyed off this class.
 * Announced as nothing: a button role would name a drag a keyboard cannot
 * take.
 */
function grip(locked: boolean): HTMLElement {
  const handle = el('span', 'wegrip');
  handle.setAttribute('draggable', locked ? 'false' : 'true');
  handle.setAttribute('aria-hidden', 'true');
  handle.dataset.tip = 'Drag to reorder';
  handle.append(el('i'), el('i'), el('i'));
  return handle;
}

/**
 * Our own MIME type, and not `text/plain`: a drag needs data to start at all,
 * but anything advertised as text is something every editable on the page will
 * accept. `#dock` stays live under the editor and the workflow name field is
 * outside the node, so a `text/plain` payload released on either would be typed
 * into it — a reorder that silently edits a message the reader was composing.
 */
const STEP_MIME = 'application/x-squadron-step';

/**
 * The grip drag, in `board_arrange.ts`'s shape and verbs: native HTML5 drag,
 * one report on `drop`, never live on `dragover`. A step lands in a row of its
 * own column — an empty cell, its Add step, or the row of another of its cards
 * (`authoring.dropInRow`, which the caller runs). Released anywhere else it goes
 * back (`snapBack`): a step keeps the lane it was written in. Wired per mount,
 * because the canvas replaces rather than morphs. Wired as `on*` properties,
 * because `rebuild` hands those from the fresh grid to a live one it keeps
 * around an open prompt. An `addEventListener` listener would stay the first mount's.
 */
function wireArrange(grid: HTMLElement, graph: CanvasGraph, handlers: CanvasHandlers): void {
  // The grid on screen, which is this one or the live one `rebuild` kept and
  // handed these to.
  const live = (e: Event): HTMLElement => e.currentTarget as HTMLElement;
  grid.ondragstart = (e) => {
    // A selection's drag starts on a text node, which has no `closest`: its
    // parent is where it was.
    const target = e.target as Node | null;
    const hit = target?.nodeType === Node.TEXT_NODE ? target.parentElement : (target as Element);
    const node = hit?.closest?.('.wegrip')?.closest<HTMLElement>('.wcnode');
    const step = graph.nodes.find((n) => n.id === node?.dataset.node);
    if (graph.locked || !node || !step) {
      // A selection dragged inside a field is the platform's own text move (the
      // editor's, in a prompt), and refusing it here would take that away to
      // prevent nothing: the handlers below all bail while `flight` is null.
      if (!hit?.closest?.('input, .wcbody')) e.preventDefault();
      return;
    }
    flight = { id: step.id, lane: step.lane };
    e.dataTransfer?.setData(STEP_MIME, step.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    // Carry the step, not the handle. Left to itself the platform snapshots the
    // element the gesture started on — three 10px bars at 55% opacity, which is
    // a drag with nothing visibly in flight. Taken from the pointer's own offset
    // into the row, so the ghost stays where the hand already is.
    //
    // Before .lifted, deliberately: the snapshot is taken when this handler
    // returns, and dimming the row first would dim the ghost with it.
    const box = node.getBoundingClientRect();
    e.dataTransfer?.setDragImage?.(node, e.clientX - box.left, e.clientY - box.top);
    document.body.classList.add('dragging-step');
    node.classList.add('lifted');
  };

  grid.ondragover = (e) => {
    if (!flight) return;
    const at = insertionRow(live(e), e.clientX, e.clientY);
    // No `preventDefault` off its own rows, which is what leaves the browser
    // drawing its own `no-drop` cursor — the refusal explains itself.
    if (!at) {
      hideTargets();
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    showTarget(at.node);
  };

  grid.ondragleave = (e) => {
    const to = e.relatedTarget as Node | null;
    if (flight && (!to || !live(e).contains(to))) hideTargets();
  };

  grid.ondrop = (e) => {
    if (!flight) return;
    // Read the row while the cards are still where the reader aimed, end the
    // flight, and only then report, since the caller's repaint replaces every
    // node the row was measured against.
    const { id } = flight;
    const at = insertionRow(live(e), e.clientX, e.clientY);
    if (!at) return;
    endDrag();
    e.preventDefault();
    handlers.onDrop(id, at.row);
  };
}

/**
 * The end of a flight, wherever it ends. On `document` and wired once, not on
 * the grid and not per mount: a release outside the webview raises neither of
 * the grid's own terminal events, and a mount comes only from a gesture. So a
 * `dragging-step` left set stays set, and every field on the canvas stays
 * `pointer-events: none` until a later gesture clears it. The one-second beat
 * calls `tickStamps`, not `renderBoard`, and `renderBoard` does not clear
 * `dragging-step`. `dragging-card` is a different class.
 *
 * A flight still up here moved nothing — off its own rows `dragover` takes no
 * drop, so the browser raises `dragend` alone — and the card goes back.
 * `onDrop(id, null)` says so, so the caller can take down a note an earlier
 * drop left, which would read as the reason.
 */
function snapBack(): void {
  if (!flight) return;
  const { id } = flight;
  endDrag();
  mounted?.handlers.onDrop(id, null);
}
document.addEventListener('dragend', snapBack);
document.addEventListener('drop', snapBack);

function endDrag(): void {
  flight = null;
  document.body.classList.remove('dragging-step');
  hideTargets();
  for (const n of document.querySelectorAll('#wfcanvas .wcnode.lifted')) {
    n.classList.remove('lifted');
  }
}

/**
 * The row a drop at (x, y) would land the carried step in: the board's
 * `insertionIndex`, in a column of rows rather than a wrapping grid.
 *
 * The column is read by x alone (`dropColumn`), and must be the step's own. The
 * row is the own-column cell, card or Add step whose box holds y, else the
 * nearest: a row gap, or a wire's band over one, belongs to a row too, and a
 * release there that moved nothing read as a broken drag. The carried card's
 * own row is no move at all.
 */
function insertionRow(
  grid: HTMLElement,
  x: number,
  y: number
): { node: HTMLElement; row: DropRow } | undefined {
  if (!flight || dropColumn(grid, x, y)?.dataset.lane !== flight.lane) return undefined;
  let near: HTMLElement | undefined;
  let nearest = Infinity;
  for (const node of grid.querySelectorAll<HTMLElement>('.wcnode, .wccell, .wcaddstep')) {
    if (node.dataset.lane !== flight.lane) continue;
    const r = node.getBoundingClientRect();
    const off = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (off < nearest) {
      near = node;
      nearest = off;
    }
  }
  const row = Number(near?.dataset.row);
  if (!near || near.dataset.node === flight.id || !Number.isInteger(row)) return undefined;
  return { node: near, row: { row, last: near.classList.contains('wcaddstep') } };
}

/**
 * The column a drop is in, by x alone: what is under the pointer was a
 * wire's hit band, a row gap or the empty foot of a short cell often enough
 * that the drop moved nothing. Its header stands for it. None outside the
 * scroller's visible box — the grid runs on unclipped under the dock — nor
 * past the outer columns, where the new-session tile stands and, on a wide
 * board, the grid runs on empty.
 */
function dropColumn(grid: HTMLElement, x: number, y: number): HTMLElement | undefined {
  const box = grid.getBoundingClientRect();
  if (!document.elementFromPoint?.(x, y)?.closest('.wcscroll')) return undefined;
  if (y < box.top || y > box.bottom) return undefined;
  let near: HTMLElement | undefined;
  let nearest = Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const column of grid.querySelectorAll<HTMLElement>('.wchd')) {
    const r = column.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    const off = Math.abs(x - (r.left + r.right) / 2);
    if (off < nearest) {
      near = column;
      nearest = off;
    }
  }
  return x >= left && x <= right ? near : undefined;
}

/**
 * Light the row the drop would land in. The whole row, unlike the board's bar
 * between two slots: a step is dropped *into* a row (`dropInRow`), never
 * between two. Nothing is written when the answer has not changed — `dragover`
 * fires on every mouse move.
 */
function showTarget(node: HTMLElement): void {
  if (node.classList.contains('target')) return;
  hideTargets();
  node.classList.add('target');
}

function hideTargets(): void {
  for (const lit of document.querySelectorAll('#wfcanvas .wcgrid .target')) {
    lit.classList.remove('target');
  }
}

/** The handle a wire is drawn from. 24px, on the card's bottom edge. */
function wirePort(id: string, handlers: CanvasHandlers): HTMLElement {
  const port = el('span', 'wcport');
  port.append(el('i'));
  port.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    endWire?.();
    const refusals = handlers.refusalsFrom(id);
    // On the document, not the 24px port: a listener on the port stops
    // hearing the pointer the moment it leaves the handle, and the drop never
    // lands. One cleanup for every way the gesture can end.
    const move = (ev: PointerEvent): void => {
      markWireTarget(ev.clientX, ev.clientY, id, refusals);
      drawRubber(port, ev.clientX, ev.clientY);
      // 24px is the handle. A drag that close to the edge is how a lane off the
      // 460px board stays reachable (PRD A6).
      const scroller = mounted?.root.querySelector<HTMLElement>('.wcscroll');
      if (!scroller) return;
      const edge = scroller.getBoundingClientRect();
      const band = 24;
      if (ev.clientX < edge.left + band) scroller.scrollLeft -= band;
      else if (ev.clientX > edge.right - band) scroller.scrollLeft += band;
    };
    const up = (ev: PointerEvent): void => {
      endWire?.();
      const hit = document.elementFromPoint?.(ev.clientX, ev.clientY) as HTMLElement | null;
      const to = hit?.closest?.('[data-node]')?.getAttribute('data-node');
      if (to && to !== id) handlers.onLink(id, to);
    };
    const end = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', end);
      mounted?.root.querySelector('.wcrubber')?.remove();
      clearWireMarks();
      endWire = null;
    };
    endWire = end;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', end);
  });
  return port;
}

/** The line a drag is drawing, from the port to the pointer. */
function drawRubber(port: HTMLElement, x: number, y: number): void {
  const svg = mounted?.root.querySelector<SVGSVGElement>('svg.wcwires');
  const pipe = svg?.parentElement;
  if (!svg || !pipe) return;
  const box = pipe.getBoundingClientRect();
  const from = port.getBoundingClientRect();
  let line = svg.querySelector<SVGPathElement>('.wcrubber');
  if (!line) {
    line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'wcrubber');
    line.setAttribute('marker-end', 'url(#wcarrow)');
    svg.append(line);
  }
  const sx = from.left + from.width / 2 - box.left;
  const sy = from.top + from.height / 2 - box.top;
  line.setAttribute('d', `M${sx},${sy} L${x - box.left},${y - box.top}`);
}

/**
 * One chip, and the menu it opens. `stated` false is the dashed inherit face —
 * the value is true and the file does not hold it. The model's tip and the
 * effort's say different borrowings, which is the whole reason they are not
 * one control.
 *
 * A wrap per chip, not the `.wcmodel` row: `openMenus` keys by wrap, so two
 * chips in one wrap make the second click close the first menu. A locked chip
 * is disabled and opens nothing, so it has none.
 */
function chip(
  kind: 'model' | 'effort',
  text: string,
  stated: boolean,
  locked: boolean,
  fill: (menu: HTMLElement) => void
): HTMLElement {
  const button = el(
    'button',
    ['wcchip', kind === 'effort' ? 'effort' : '', stated ? '' : 'inherit'].filter(Boolean).join(' ')
  ) as HTMLButtonElement;
  button.type = 'button';
  button.disabled = locked;
  button.append(el('span', null, text));
  button.dataset.tip =
    kind === 'model'
      ? stated
        ? 'The model this step’s session runs on. If it can’t start, this lane runs on the starting session’s model'
        : 'No model in the file — pick a model/effort'
      : stated
        ? 'The effort this step’s session starts at'
        : 'Not in the file — the model’s own default';
  // The node's own click-to-open is the other target on this box, and it is
  // the larger one — without this the chip opens the node and the repaint
  // throws the menu away. A listener, since `opensMenu` takes the onclick.
  button.addEventListener('click', (e) => e.stopPropagation());
  if (locked) return button;
  const wrap = el('span', 'fwrap');
  wrap.append(button, opensMenu(wrap, button, 'start', fill, true));
  return wrap;
}

function glyph(badge: string): HTMLElement {
  const box = el('span', 'wcg');
  box.append(el('i'));
  box.append(el('b', null, badge));
  return box;
}

/**
 * Measure what was drawn and paint the wires.
 *
 * The only place in this surface that may call `getBoundingClientRect` —
 * everything it measures goes into `route()` and comes back as strings. Must
 * run after the tree is in the document; before that every rect is zero.
 */
export function paintWires(root: HTMLElement, graph: CanvasGraph): void {
  const svg = root.querySelector<SVGSVGElement>('svg.wcwires');
  const pipe = svg?.parentElement;
  if (!svg || !pipe) return;

  const box = pipe.getBoundingClientRect();
  const rects = new Map<string, RouteRect>();
  for (const node of pipe.querySelectorAll<HTMLElement>('[data-node]')) {
    const id = node.dataset.node;
    if (id === undefined) continue;
    const r = node.getBoundingClientRect();
    rects.set(id, {
      left: r.left - box.left,
      right: r.right - box.left,
      top: r.top - box.top,
      bottom: r.bottom - box.top,
      cx: r.left - box.left + r.width / 2
    });
  }

  const edges: RouteEdge[] = graph.edges.map(([from, to]) => ({ from, to }));

  const routed = route(rects, edges, { width: box.width, height: box.height });
  svg.setAttribute('viewBox', routed.viewBox);
  svg.replaceChildren(arrowDefs());
  for (const old of pipe.querySelectorAll('.wirex')) old.remove();
  // `route` drops an edge whose node is missing and keeps the rest in order.
  const drawn = edges.filter((edge) => rects.has(edge.from) && rects.has(edge.to));
  routed.paths.forEach((path, i) => {
    const edge = drawn[i];
    if (!edge) return;
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('d', path.d);
    const on = selectedWire?.from === edge.from && selectedWire?.to === edge.to;
    if (on) visible.setAttribute('class', 'sel');
    // At the step that waits, so a wire reads which way it runs.
    visible.setAttribute('marker-end', 'url(#wcarrow)');
    svg.append(visible);

    // A 24px hit on the same `d`. The SVG itself ignores the pointer; this stroke does not.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', path.d);
    hit.setAttribute('class', 'wchit');
    hit.setAttribute('stroke-width', '24');
    hit.dataset.from = edge.from;
    hit.dataset.to = edge.to;
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Measured now, not at paint: a scroll since then moved the pipe.
      const at = pipe.getBoundingClientRect();
      selectedWire = {
        from: edge.from,
        to: edge.to,
        x: ev.clientX - at.left,
        y: ev.clientY - at.top
      };
      if (mounted) paintWires(mounted.root, mounted.graph);
    });
    svg.append(hit);

    if (!on || !selectedWire) return;
    // Not `kit.ts`'s iconButton: `.icon`'s half opacity and ::before halo fight the round chip.
    const x = el('button', 'wirex') as HTMLButtonElement;
    x.type = 'button';
    x.innerHTML = icon('trash', 13);
    x.setAttribute('aria-label', 'Delete wire');
    x.dataset.tip = 'Delete wire';
    x.style.left = `${selectedWire.x}px`;
    x.style.top = `${selectedWire.y}px`;
    x.dataset.from = edge.from;
    x.dataset.to = edge.to;
    x.onclick = (ev) => {
      ev.stopPropagation();
      const wire = { from: edge.from, to: edge.to };
      selectedWire = null;
      mounted?.handlers.onUnlink(wire.from, wire.to);
    };
    pipe.append(x);
  });
}

/** The arrowhead every wire and the rubber band end in. */
function arrowDefs(): SVGDefsElement {
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  const marker = document.createElementNS(ns, 'marker');
  marker.id = 'wcarrow';
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('orient', 'auto');
  const head = document.createElementNS(ns, 'path');
  head.setAttribute('d', 'M0,0 L8,4 L0,8 z');
  head.setAttribute('class', 'wcarrowhead');
  marker.append(head);
  defs.append(marker);
  return defs;
}

function markWireTarget(
  x: number,
  y: number,
  from: string,
  refusals: ReadonlyMap<string, LinkRefusal>
): void {
  const root = mounted?.root;
  if (!root) return;
  // jsdom has no hit-testing. A missing function is a miss, and the refusals
  // are still marked.
  const hit = document.elementFromPoint?.(x, y) as HTMLElement | null;
  const over = hit?.closest?.('[data-node]')?.getAttribute('data-node');
  let fromNode: HTMLElement | undefined;
  let lit: HTMLElement | undefined;
  for (const node of root.querySelectorAll<HTMLElement>('[data-node]')) {
    const id = node.dataset.node ?? '';
    const refused = refusals.get(id);
    node.classList.toggle('refuse', refused !== undefined);
    node.classList.toggle('starts', refused?.why === 'starts');
    node.classList.toggle('skip', refused?.why === 'skip');
    if (refused?.why === 'skip') node.dataset.skips = refused.skips ?? '';
    else delete node.dataset.skips;
    const accept = id === over && id !== from && !refused;
    node.classList.toggle('target', accept);
    if (id === from) fromNode = node;
    if (accept) lit = node;
  }
  const sentence = lit && fromNode ? `${cardName(lit)} waits for ${cardName(fromNode)}` : '';
  paintDropTip(root, sentence, x, y);
}

/** The name the card is showing. An open card's field, otherwise its title. */
function cardName(node: HTMLElement): string {
  const field = node.querySelector<HTMLInputElement>('input.wctitle');
  const text = (field ? field.value : (node.querySelector('.wcname')?.textContent ?? '')).trim();
  return text || node.dataset.node || '';
}

function paintDropTip(root: HTMLElement, text: string, x: number, y: number): void {
  const existing = root.querySelector<HTMLElement>('.wctip');
  if (!text) {
    existing?.remove();
    return;
  }
  const tip = existing ?? el('div', 'wctip');
  tip.textContent = text;
  tip.style.left = `${x + 16}px`;
  tip.style.top = `${y + 20}px`;
  if (!existing) root.append(tip);
}

function clearWireMarks(): void {
  const root = mounted?.root;
  document.querySelector('.wctip')?.remove();
  if (!root) return;
  for (const node of root.querySelectorAll<HTMLElement>('[data-node]')) {
    node.classList.remove('refuse', 'target', 'skip', 'starts');
    delete node.dataset.skips;
  }
}

function onWireKey(e: KeyboardEvent): void {
  if (!mounted) return;
  // A drag in flight takes Escape before any field does: the port takes no
  // focus, so the caret stays wherever it was when the drag began.
  if (e.key === 'Escape' && endWire) {
    e.preventDefault();
    endWire();
    return;
  }
  // A field's Escape is the field's, the prompt's editor included.
  if (typingIn(e.target)) return;
  if (e.key !== 'Escape' || !selectedWire) return;
  e.preventDefault();
  selectedWire = null;
  paintWires(mounted.root, mounted.graph);
}

/**
 * Put a graph on screen in `#wfcanvas` and paint its wires. Opening or closing
 * a node grows it in place and every rect below moves, so a repaint is a
 * re-measure.
 *
 * Not repainted on scroll. The SVG is `inset: 0` inside the scrolled content,
 * so a scroll translates it and the nodes together and the path data is
 * unchanged.
 */
export function mountCanvas(graph: CanvasGraph, handlers: CanvasHandlers): void {
  const host = $('wfcanvas');
  // The drag held a port and a handler out of the tree this replaces, and a
  // carried card's dragend then reaches nobody.
  endWire?.();
  if (flight) endDrag();
  // Every mount is a gesture, and the trash stands at a pixel this one moves.
  selectedWire = null;
  const fresh = renderCanvas(graph, handlers);
  // Capture, since Done, the chips and Remove stop their click before it
  // bubbles. One function, so a stage `rebuild` keeps already has it.
  fresh.addEventListener('click', putTrashAway, true);
  const grid = fresh.querySelector<HTMLElement>('.wcgrid');
  if (grid) wireArrange(grid, graph, handlers);
  // An open prompt stays where it is, and so do the nodes around it.
  rebuild(host, [fresh]);
  host.hidden = false;
  const root = host.firstElementChild as HTMLElement;
  mounted = { graph, root, handlers };
  paintWires(root, graph);
  if (!resizeBound) {
    resizeBound = true;
    addEventListener('resize', () => {
      if (mounted) paintWires(mounted.root, mounted.graph);
    });
  }
  if (!keysBound) {
    keysBound = true;
    // The document, not the window: the editor's Back listens there, after
    // every document owner, and reads a consumed Escape off `defaultPrevented`.
    document.addEventListener('keydown', onWireKey);
  }
}

/** A click anywhere but a wire or its trash puts the trash away. */
function putTrashAway(e: MouseEvent): void {
  if (!selectedWire || !mounted) return;
  if ((e.target as Element | null)?.closest?.('.wchit, .wirex')) return;
  selectedWire = null;
  paintWires(mounted.root, mounted.graph);
}

/** Put the caret on a node, or in its open name field. */
export function focusNode(id: string, into: 'node' | 'name'): void {
  const node = mounted?.root.querySelector<HTMLElement>(`.wcnode[data-node="${id}"]`);
  if (into === 'node') node?.focus();
  else node?.querySelector<HTMLInputElement>('input.wctitle')?.focus();
}

export function revealNode(id: string): void {
  mounted?.root.querySelector(`.wcnode[data-node="${id}"]`)?.scrollIntoView();
}

/** How far the canvas is scrolled sideways. 0 with nothing mounted. */
export function scrollOffset(): number {
  return mounted?.root.querySelector<HTMLElement>('.wcscroll')?.scrollLeft ?? 0;
}

export function scrollToOffset(left: number): void {
  const scroller = mounted?.root.querySelector<HTMLElement>('.wcscroll');
  if (scroller) scroller.scrollLeft = left;
}

/** Take every note down without a repaint, which would take the caret. */
export function clearNotes(): void {
  for (const why of mounted?.root.querySelectorAll('.wcwhy') ?? []) why.remove();
}

/** Take it back down, leaving the board as it was. */
export function unmountCanvas(): void {
  const host = $('wfcanvas');
  host.replaceChildren();
  host.hidden = true;
  selectedWire = null;
  endWire?.();
  if (flight) endDrag();
  mounted = null;
}
