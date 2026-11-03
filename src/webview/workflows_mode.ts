/**
 * Manage the collection and read what each workflow does. Nothing here
 * applies one: that is the composer's workflow menu, and only that.
 * Runnable rows follow the stated order, repair files follow them.
 * Duplicate, Delete and Edit work on every row.
 * The session sequences its run, so no step controls belong here.
 */

import { icon } from '../ui/icons';
import { $, el, q } from './dom';
import { openCreate, openEdit } from './editor';
import { morph } from './kit';
import { SEARCH_ABOVE } from './picker';
import { ui, vscode } from './state';
import * as bottomDrawer from './bottom_drawer';
import * as drag from './workflows_drag';

/** Keep detail selection across paints. A press on the row, or Enter or Space on it, sets it. */
let selected: string | undefined;
/** What the filter box holds, kept across paints for the same reason. */
let filter = '';
/** The delete confirmation, on its row. */
let say: { kind: 'delete'; id: string } | undefined;
/** Show moves immediately until the 3s push confirms the order. */
let draft: string[] | undefined;

/** A runnable row, or a file the editor can open. The second is not a
 *  `WorkflowView`, which is what the composer offers to apply. */
type SheetRow = WorkflowView | WorkflowEditView;

/** Files open for repair that are not also runnable. They stay a tail, so a
 *  move of the runnable list cannot land one in the order. */
function edits(): WorkflowEditView[] {
  const runs = new Set((ui.state.workflows ?? []).map((w) => w.id));
  return (ui.state.workflowEdits ?? []).filter((edit) => !runs.has(edit.id));
}

export function hasWorkflowRows(): boolean {
  return (ui.state.workflows?.length ?? 0) > 0 || (ui.state.workflowEdits?.length ?? 0) > 0;
}

/** Spaces alone do not narrow the list. */
export function isFiltered(): boolean {
  return filter.trim() !== '';
}

/** Runnable rows in the order this sheet is drawing them, then the repair tail.
 *  A draft reorders only ids that can run. */
export function ordered(): SheetRow[] {
  const runs = ui.state.workflows ?? [];
  const tail = edits();
  if (!draft) return [...runs, ...tail];
  const by = new Map(runs.map((w) => [w.id, w]));
  const placed = draft.flatMap((id) => {
    const found = by.get(id);
    if (!found) return [];
    by.delete(id);
    return [found];
  });
  return [...placed, ...by.values(), ...tail];
}

/**
 * Clear confirmed drafts so later workflows do not stay behind an obsolete order.
 * Keep this effect outside ordered, which is a read.
 */
export function settleDraft(): void {
  if (!draft) return;
  // The tail is not an order, so it cannot be what the push is agreeing with.
  const drawn = ordered()
    .filter((w) => w.repair !== true)
    .map((w) => w.id)
    .join();
  const pushed = (ui.state.workflows ?? []).map((w) => w.id).join();
  if (drawn === pushed) draft = undefined;
}

export function paintWorkflows(): void {
  if (bottomDrawer.takeArrival()) say = undefined;
  settleDraft();
  const root = $('bottomdrawer');
  const list = ordered();
  // A reader holding a row in flight must not have it morphed away. A flight
  // measures its boundaries off the rows as drawn and hangs a line and a ghost
  // off them; a 3s push landing mid-drag would reorder what the pointer is
  // aiming at. The paint that follows the release is what catches the list up.
  if (drag.inFlight()) return;

  const box = root.querySelector<HTMLInputElement>('#bottomdrawer-filter');
  if (box) {
    // Share SEARCH_ABOVE so the sheet and pickers agree when to offer search.
    const offered = list.length > SEARCH_ABOVE;
    showSearch(offered);
    if (!offered) filter = '';
    if (box.value !== filter) box.value = filter;
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? list : list.filter((w) => w.label.toLowerCase().includes(needle));

  // Morph, never replace: `#bottomdrawer-body` is the scroll container, so a fresh set of
  // children on every 3s push throws a reader who has scrolled back to the top
  // — the rule `workflow_overview_drawer.ts` states at length for its own rail. Keyed by workflow
  // id, which is what keeps the same row (and the press already on its way down
  // to it) across a paint.
  const col = q($('bottomdrawer-body'), '.bdlist');
  // Authoring is the list's last row, not a button in the foot: an add reads
  // best in the geometry of the thing it adds to, which is the vocabulary the
  // editor's own `+ Add step` already speaks. It is in the morph rather than
  // appended after it — `morph` writes the children it is given, so a node
  // added beside the call would be swept on the next 3s push.
  morph(col, [...shown.map((w) => row(w)), newRow()]);
  // Off the whole list, not the filtered one: narrowing the list is not a
  // reason to stop drawing the steps the reader is reading.
  paintDetail(list.find((w) => w.id === selected));
  paintFoot();
  $('bottomdrawer-foot').hidden = false;
}

/** The search band and its field, together. The band's display beats the
 *  hidden attribute, so hiding the field alone would leave an empty row. */
function showSearch(on: boolean): void {
  $('bottomdrawer-filter').hidden = !on;
  $('bottomdrawer-find').hidden = !on;
}

/**
 * Keep New workflow outside .wsrow so it cannot be lifted or receive a drop.
 */
function newRow(): HTMLElement {
  const b = el('button', 'wsnew');
  b.dataset.key = 'ws:new';
  b.append(el('span', 'plus', '＋'), el('span', 'nm', 'New workflow'));
  b.onclick = () => {
    // Close the sheet because the editor takes the same board region.
    // The button is inside the drawer, so focus cannot stay on it.
    bottomDrawer.close();
    openCreate();
  };
  return b;
}

function row(w: SheetRow): HTMLElement {
  const r = el('div', 'wsrow' + (w.id === selected ? ' sel' : ''));
  r.dataset.key = `ws:${w.id}`;
  r.dataset.id = w.id;

  const grip = el('span', 'wsgrip');
  grip.setAttribute('aria-hidden', 'true');
  grip.append(el('i'), el('i'), el('i'));

  r.append(
    grip,
    el('span', 'nm', w.label),
    el('span', 'meta', `${w.steps.length} step${w.steps.length === 1 ? '' : 's'}`)
  );
  r.append(el('span', 'sp'));

  // Confirm on the row: the foot would force pointer travel and repeat its label.
  const asking = say?.kind === 'delete' && say.id === w.id;
  if (asking) {
    r.classList.add('confirming');
    const ask = el('span', 'ask', 'Delete?');
    ask.dataset.key = `ws:${w.id}:ask`;
    const yes = el('button', 'act fbtn danger', 'Delete');
    yes.dataset.key = `ws:${w.id}:yes`;
    yes.setAttribute('aria-label', `Delete ${w.label}`);
    // Read when pressed, not closed over: this button is keyed too, and survives
    // a repaint that moved the confirm to a different workflow.
    yes.onclick = (e) => {
      e.stopPropagation();
      if (say?.kind !== 'delete') return;
      vscode.postMessage({ type: 'deleteWorkflow', id: say.id });
      say = undefined;
      bottomDrawer.render();
    };
    const no = el('button', 'act fbtn', 'Cancel');
    no.dataset.key = `ws:${w.id}:no`;
    no.onclick = (e) => {
      e.stopPropagation();
      say = undefined;
      bottomDrawer.render();
    };
    r.append(ask, yes, no);
    // Deliberately falls through to the tail rather than returning: the row
    // node is keyed, so a morph keeps the node this paint's `onclick` is *not*
    // being set on — the one the paint before it set. A press on a confirming
    // row would still move the selection under the question. The guard
    // that stops it therefore has to live in that handler, which reads `say`
    // when the press lands like everything else here does.
  }

  if (!asking) r.append(...controls(w));

  // Never `role="button"` and never `aria-disabled`: the row is an ancestor of
  // its own controls, ARIA inherits that attribute to focusable descendants,
  // and a row marked disabled would tell a reader its buttons and a confirm's
  // Delete and Cancel are dead.
  //
  // `data-repair` is an attribute, so a later poll that makes the file
  // runnable drops it.
  if (w.repair === true) r.dataset.repair = 'true';

  // A press selects, and so do Enter and Space on the row: it is the only way
  // to select, so it is a tab stop. Never on focus — Chromium focuses a
  // focusable row on mousedown, ahead of every guard below. The row reads its
  // controls off the event rather than trusting them to stop it.
  r.tabIndex = 0;
  r.onclick = (e) => {
    // See justDragged: the release click must not select the reordered row.
    if (drag.justDragged()) return;
    if (e.target instanceof Element && e.target.closest('.act')) return;
    select(r, w.id);
  };
  r.onkeydown = (e) => {
    if (e.target !== r || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    select(r, w.id);
  };

  return r;
}

function select(r: HTMLElement, drawn: string): void {
  if (say?.kind === 'delete' && say.id === drawn) return;
  // Read when the press lands: rows are keyed and outlive the paint.
  const id = r.dataset.id;
  if (!id || selected === id) return;
  selected = id;
  bottomDrawer.render();
}

/**
 * The row's own three: Edit, Duplicate and Delete.
 *
 * All keyed, because the confirm swaps them out for its own buttons and an
 * unkeyed morph pairs what is left by tag, in order — so cancelling would
 * reuse the confirm's Delete button as Edit, and morphdom copies attributes,
 * not properties: the live node keeps the handler assigned to it, and a press
 * on Edit would post `deleteWorkflow`.
 *
 * Each reads the workflow when pressed, never closed over: the button is keyed,
 * so a morph keeps the node the first paint made and its handler with it, and a
 * workflow whose prompts were rewritten under the same name moves nothing this
 * paint watches.
 */
function controls(w: SheetRow): HTMLElement[] {
  const id = w.id;
  return [
    rowAction(w, 'edit', 'pencil', 'Edit', () => {
      const now = listed(id);
      if (!now) return;
      // Close the sheet for the same board-region reason as newRow.
      // The button is inside the drawer, so focus cannot stay on it.
      bottomDrawer.close();
      openEdit(editable(now));
    }),
    // No answer to wait for: the copy arrives on the next poll like any other
    // file, and only a failure is spoken (on `saveWorkflowResult`).
    rowAction(w, 'dup', 'copy', 'Duplicate', () =>
      vscode.postMessage({ type: 'duplicateWorkflow', id })
    ),
    rowAction(w, 'del', 'trash', 'Delete', () => {
      say = { kind: 'delete', id };
      bottomDrawer.render();
    })
  ];
}

function rowAction(
  w: SheetRow,
  kind: string,
  glyph: 'pencil' | 'copy' | 'trash',
  verb: string,
  run: () => void
): HTMLElement {
  const b = el('button', `act ${kind}`);
  b.dataset.key = `ws:${w.id}:${kind}`;
  b.innerHTML = icon(glyph, 13);
  b.setAttribute('aria-label', `${verb} ${w.label}`);
  b.dataset.tip = verb;
  b.onclick = (e) => {
    e.stopPropagation();
    run();
  };
  return b;
}

/** The row's workflow as of this moment: runnable first, then a file open for
 *  repair. Edit reads it when it runs, not when the row was drawn. */
function listed(id: string): SheetRow | undefined {
  return (ui.state.workflows ?? []).find((w) => w.id === id) ?? edits().find((w) => w.id === id);
}

/** What the editor loads. A repair row is not a `WorkflowView`, and `openEdit`
 *  takes one — the reasons are recomputed from the steps. */
function editable(w: SheetRow): WorkflowView {
  return {
    id: w.id,
    label: w.label,
    ...(w.lanes?.length ? { lanes: [...w.lanes] } : {}),
    steps: w.steps
  };
}

/** Always draw detail so the first selection cannot shift the list under a pointer. */
function paintDetail(w: SheetRow | undefined): void {
  const pane = q($('bottomdrawer-body'), '.bddetail');
  if (!w) {
    if (selected !== undefined) selected = undefined;
    const none = el('p', 'dnone', 'Select a workflow to see its steps');
    none.dataset.key = 'ws:none';
    morph(pane, [none]);
    return;
  }
  const head = el('p', 'dh', w.label);
  head.dataset.key = `wsd:${w.id}`;
  head.append(el('span', '', `${w.steps.length} step${w.steps.length === 1 ? '' : 's'}`));

  const list = el('ol', 'wsteps wssteps');
  list.dataset.key = `wss:${w.id}`;
  list.setAttribute('aria-label', `${w.label} steps`);
  for (const s of w.steps) list.append(el('li', 'wstep', s.label));
  morph(pane, [head, list]);
}

/**
 * The foot: the reorder legend.
 *
 * A legend and nothing else, since authoring left for the list. It carried
 * `+ New workflow` at `fbtn faction`, which declares `margin-left: auto` — and
 * so does `#bottomdrawer-foot .hint`. Two autos on one flex line split the free space
 * *between* them rather than stacking, so the sheet's only filled control
 * floated in the middle of the strip, anchored to neither edge. Nothing about
 * that was decided; it fell out of two rules that were each right on their own
 * surface. Measured in `docs/mockups/workflow-sheet-directions.html` §1a.
 */
function paintFoot(): void {
  const foot = $('bottomdrawer-foot');
  const hint = el('span', 'hint', 'Hold a row to reorder');
  hint.dataset.key = 'ws:hint';

  morph(foot, [hint]);
}

/* ------------------------------------------------------------------ writing */

/**
 * Only a move sends order, and only as far down as it reached: the tail stays
 * label-sorted rather than frozen into stated positions. No repaint — the drop
 * paints once, after this returns.
 */
export function commitOrder(ids: readonly string[], reach: number): void {
  draft = [...ids];
  vscode.postMessage({ type: 'writeWorkflowOrder', order: ids.slice(0, reach) });
}

/** The markup's filter input survives paints, so bind it once. */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.id !== 'bottomdrawer-filter') return;
  filter = t.value;
  bottomDrawer.render();
});

/** What the drawer drops when it shuts. Opening clears the confirm from the paint. */
export function closed(): void {
  say = undefined;
  filter = '';
  draft = undefined;
  selected = undefined;
}

/** Nothing to draw: no runnable row and no file open for repair. */
export function empty(): boolean {
  return !hasWorkflowRows();
}

export function emptyWord(): HTMLElement {
  const create = el('button', 'fpill on', '+ New workflow');
  create.onclick = () => openCreate();
  return create;
}

/** A flight consumes Escape. The frame has the one listener, and a second one
 *  would still close the drawer after this returns. */
export function escape(): boolean {
  if (!drag.inFlight()) return false;
  drag.cancelFlight();
  return true;
}
