/**
 * Board-mode workflow editor: create and edit JSON under WORKFLOWS_DIR
 * (`~/.squadron/workflows/<id>.json`).
 *
 * The draft is webview-local (like composer text and mentions). Save and Delete
 * are the wire crossings. Placement: board mode — cards yield, dock stays live.
 *
 * Layout: the lane canvas. A one-session file is one column; otherwise each
 * step sits on its lane, and the chip on the step that opens a lane
 * writes that step's model and effort. A newly added step gets a one-shot
 * `.enter` class so only that node settles in.
 *
 * Insert is each column's Add step, under that lane's last step. Reorder is the
 * grip left of the badge (R1), dropped into a row of its own lane. Structure is
 * pointer-only: no chord inserts or moves a step. All of it draft-local, all of it committed once, and Save is
 * still the only wire.
 */

import { $, el, typingIn } from './dom';
import { renderBoard } from './board';
import { findCard } from './board_card';
import { syncBoardView } from './board_nav';
import { ui, vscode } from './state';
import * as authoring from '../core/workflows/authoring';
import * as graph from '../core/workflows/graph';
import { sameDoc, type ComposeDoc } from '../ui/compose_doc';
import { catalogMenu, effortPick } from './board_settings';
import { keptBox, sweepHeld } from './boxes';
import { closeMenu, menuItem } from './kit';
import { attachMentions, closeMentionMenu } from './mentions';
import { createProse, markdownDoc, type Prose } from './prose';
import { attachFormatbar } from './formatbar';
import { toCanvas } from './wfgraph';
import type { CanvasSource } from './wfgraph';
import {
  clearNotes,
  focusNode,
  mountCanvas,
  revealNode,
  scrollOffset,
  scrollToOffset,
  unmountCanvas
} from './wfcanvas';

/** `blankStep` gives every editor row an id; the saved shape leaves it optional. */
type EditorStep = DraftStep & { id: string };

type Draft = {
  /** Present when editing an existing file. */
  id?: string;
  /**
   * Every step id the file held when it was opened. `saveWorkflow` matches steps
   * by id and keeps the file's fields the draft does not carry (`check`,
   * `retries`), so a new step minted with a deleted step's id would inherit them.
   */
  taken: readonly string[];
  label: string;
  steps: EditorStep[];
  /** Named lanes in column order (`columnOrder`), saved as the file's `lanes`. */
  lanes: string[];
  /** The node open for editing, by id. Null is every node closed. */
  open: string | null;
  reasons: string[];
  saving: boolean;
  deleting: boolean;
  /** First Delete click arms; second posts. Avoids a host modal the smoke host
   *  cannot drive, and keeps the confirm next to the control that unlinks. */
  confirmDelete: boolean;
  /** The draft's `shape` when an Escape armed Back over unsaved edits. Any edit
   *  after it changes the shape, which disarms it with no reset to remember. */
  leaveArmed: string | null;
  /** A gesture the draft refused, drawn on the card or the lane it names. */
  refusal: { id: string; text: string } | null;
};

let draft: Draft | null = null;
/** The draft's `shape` as it opened: what an Escape compares to before leaving. */
let opened = '';

/** Step id that should play the enter animation on the next paint, then clear. */
let enterId: string | null = null;

/** After paint, put the caret here so authoring never leaves you hunting. */
type FocusTarget =
  { kind: 'workflow' } | { kind: 'step'; id: string } | { kind: 'node'; id: string } | null;
let focusAfter: FocusTarget = null;

/** The canvas scroller's sideways place across rebuilds. */
let canvasScrollLeft = 0;
/** Bumps each time a workflow is opened. */
let editorOpening = 0;
/**
 * Which open `canvasScrollLeft` belongs to. A new form starts at the left,
 * including two creates, which share no id. -1 while the editor is closed.
 */
let canvasScrollOpening = -1;
/** Measures the overlay thumb again, while the editor is open (`shell`). */
let remeasure: (() => void) | null = null;
/** Clears the is-scrolling class after the last scroll tick. */
let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;

export function editing(): boolean {
  return draft !== null;
}

function machineSkills(): readonly string[] | undefined {
  return ui.state.skills;
}

/** An id the canvas can open by, free of the draft's and of the file's. */
function mintId(steps: readonly { id?: string }[], taken: readonly string[]): string {
  const used = new Set([...steps.map((s) => s.id), ...taken]);
  let n = 1;
  while (used.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

function blankStep(steps: readonly { id?: string }[], taken: readonly string[]): EditorStep {
  return { id: mintId(steps, taken), label: '', prompt: '' };
}

export function openCreate(): void {
  editorOpening += 1;
  const step = blankStep([], []);
  draft = {
    taken: [],
    label: '',
    steps: [step],
    lanes: [],
    open: step.id,
    reasons: [],
    saving: false,
    deleting: false,
    confirmDelete: false,
    leaveArmed: null,
    refusal: null
  };
  opened = shape(draft);
  enterId = step.id;
  focusAfter = { kind: 'workflow' };
  paintShell();
  renderEditor();
  renderBoard();
}

export function openEdit(workflow: WorkflowView): void {
  editorOpening += 1;
  const steps = workflow.steps.map((s) => ({
    id: s.id,
    label: s.label,
    prompt: s.prompt,
    ...(s.lane ? { lane: s.lane } : {}),
    ...(s.needs && s.needs.length > 0 ? { needs: [...s.needs] } : {}),
    ...(s.brand ? { brand: s.brand } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {})
  }));
  draft = {
    id: workflow.id,
    taken: workflow.steps.map((s) => s.id),
    label: workflow.label,
    steps,
    // A file with no `lanes` is pinned to the order it draws in now, so the
    // first session added to it still lands last.
    lanes: columnOrder(steps, workflow.lanes ?? []),
    open: null,
    reasons: [],
    saving: false,
    deleting: false,
    confirmDelete: false,
    leaveArmed: null,
    refusal: null
  };
  opened = shape(draft);
  enterId = null;
  focusAfter = null;
  paintShell();
  renderEditor();
  renderBoard();
}

export function closeEditor(): void {
  draft = null;
  enterId = null;
  focusAfter = null;
  paintShell();
  renderEditor();
  renderBoard();
}

export function takeSaveResult(msg: SaveWorkflowResultMessage): void {
  // Only the draft that posted save may consume the result. After Back, or
  // after opening another form while a write was in flight, ignore — no
  // request id on the wire, so `saving` is the correlation.
  if (!draft || !draft.saving) return;
  if (msg.ok) {
    closeEditor();
    return;
  }
  draft = { ...draft, saving: false, reasons: msg.reasons };
  renderEditor();
}

export function takeDeleteResult(msg: DeleteWorkflowResultMessage): void {
  if (!draft || !draft.deleting) return;
  if (msg.ok) {
    closeEditor();
    return;
  }
  draft = { ...draft, deleting: false, confirmDelete: false, reasons: msg.reasons };
  renderEditor();
}

function paintShell(): void {
  closeMenu();
  const board = $('board');
  const root = $('wfeditor');
  if (draft) {
    board.classList.add('editing');
    root.hidden = false;
  } else {
    board.classList.remove('editing');
    root.hidden = true;
    // The canvas node is moved into the editor while it is open. Put the empty
    // mount back on the board, or the next open mints a second one.
    const host = document.getElementById('wfcanvas');
    if (host && root.contains(host)) {
      unmountCanvas();
      board.append(host);
    }
    root.replaceChildren();
  }
  syncBoardView();
}

/** Local gates before post — empty name / empty prompts. */
function localReasons(d: Draft): string[] {
  const reasons: string[] = [];
  if (!d.label.trim()) reasons.push('needs a label');
  if (d.steps.length === 0) reasons.push('needs at least one step');
  d.steps.forEach((s, i) => {
    const where = s.label.trim() || `step ${i + 1}`;
    if (!s.label.trim()) reasons.push(`${where} needs a label`);
    if (!s.prompt.trim()) reasons.push(`${where} needs a prompt`);
  });
  return reasons;
}

function busy(d: Draft): boolean {
  return d.saving || d.deleting;
}

/** What Save would write, as one string, so an edit is a comparison. */
function shape(d: Draft): string {
  return JSON.stringify([d.label, d.steps, d.lanes]);
}

/**
 * Escape is Back. Over unsaved edits it takes two presses — Delete's rule, the
 * first arms and the second does it — so a key pressed by reflex cannot drop a
 * draft. A box keeps its Escape: one there is about the text, not the editor.
 * On the window, after every document owner has had the key: a wire, a menu
 * and the `@` menu take theirs first and say so with `preventDefault`.
 */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !draft || busy(draft)) return;
  if (typingIn(e.target)) return;
  e.preventDefault();
  const now = shape(draft);
  if (now === opened || draft.leaveArmed === now) {
    closeEditor();
    return;
  }
  draft = { ...draft, leaveArmed: now };
  renderEditor();
});

function postSave(): void {
  if (!draft || busy(draft)) return;
  const reasons = localReasons(draft);
  if (reasons.length) {
    // The reason names a step whose fields are on the open face only. Leave
    // that node open, or the strip is about a box the reader cannot see.
    const broken = draft.steps.find((s) => !s.label.trim() || !s.prompt.trim());
    draft = { ...draft, reasons, open: broken?.id ?? draft.open };
    renderEditor();
    return;
  }
  // A graph reason is drawn on its card. Save stays blocked until a gesture
  // fixes it — opening the file does not rewrite it.
  if (authoring.structuralReasons(draft.steps).length > 0) return;
  draft = { ...draft, saving: true, reasons: [] };
  renderEditor();
  vscode.postMessage({
    type: 'saveWorkflow',
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    label: draft.label.trim(),
    ...(draft.lanes.length > 0 ? { lanes: draft.lanes } : {}),
    steps: draft.steps.map((s) => ({
      id: s.id,
      label: s.label.trim(),
      prompt: s.prompt,
      ...(s.lane ? { lane: s.lane } : {}),
      ...(s.needs?.length ? { needs: s.needs } : {}),
      ...(s.brand ? { brand: s.brand } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {})
    }))
  });
}

function postDelete(): void {
  if (!draft || busy(draft) || draft.id === undefined) return;
  // Two-step: first click only arms the button (label → Confirm delete).
  if (!draft.confirmDelete) {
    draft = { ...draft, confirmDelete: true, reasons: [] };
    renderEditor();
    return;
  }
  const id = draft.id;
  draft = { ...draft, deleting: true, reasons: [] };
  renderEditor();
  vscode.postMessage({ type: 'deleteWorkflow', id });
}

function stepWord(n: number): string {
  return n === 1 ? '1 step' : `${n} steps`;
}

function commit(
  result: authoring.EditResult<EditorStep>,
  about: string,
  extra?: { open?: string; lanes?: string[] }
): boolean {
  if (!draft) return false;
  if ('refused' in result) {
    draft = { ...draft, refusal: { id: about, text: result.refused } };
    renderEditor();
    return false;
  }
  const steps = result.steps;
  if (steps.length === 0) steps.push(blankStep([], draft.taken));
  draft = {
    ...draft,
    steps,
    lanes: columnOrder(steps, extra?.lanes ?? draft.lanes),
    refusal: null,
    open: extra?.open ?? draft.open
  };
  renderEditor();
  return true;
}

/** A column's Add step: after that lane's last step, which is its last in file order. */
function addStepInLane(lane: string): void {
  if (!draft || busy(draft)) return;
  const last = [...draft.steps].reverse().find((s) => graph.laneOf(s) === lane);
  if (!last) return;
  const step = blankStep(draft.steps, draft.taken);
  landNew(authoring.insertInLane(draft.steps, last.id, step), step);
}

/** Open the step an insert made, caret in its name. Focus + enter settle match append. */
function landNew(result: authoring.EditResult<EditorStep>, step: EditorStep): void {
  if (!draft) return;
  if ('refused' in result) {
    commit(result, step.id);
    return;
  }
  const steps = result.steps;
  enterId = step.id;
  focusAfter = { kind: 'step', id: step.id };
  draft = { ...draft, steps, lanes: columnOrder(steps, draft.lanes), refusal: null, open: step.id };
  renderEditor();
  revealNode(step.id);
}

/**
 * The draft's named lanes in column order: `lanes` where they still have a
 * step, then any lane an edit just made. A lane emptied drops out here, so a
 * new session reusing its name is still added last.
 */
function columnOrder(steps: readonly EditorStep[], lanes: readonly string[]): string[] {
  return graph.layout(steps, lanes).lanes.filter((lane) => lane !== graph.ARMED);
}

/** `+ New session`: an unwired step in `session N` (`authoring.addLane`). */
function addSession(): void {
  if (!draft || busy(draft)) return;
  const step = blankStep(draft.steps, draft.taken);
  landNew(authoring.addLane(draft.steps, undefined, step), step);
}

export function renderEditor(): void {
  const root = $('wfeditor');
  // Above the guard below, not inside the paint: every node under here is about
  // to be replaced, and the `@` menu is a fixed box on `<body>` holding a handle
  // to one of them. The chip menu is portalled the same way. **The no-draft
  // branch is the one that matters** — closing the editor detaches every field
  // and replaces them with nothing, so a menu left open floats over the restored
  // board bound to a dead node. A pointer press masks it, so only a keyboard-only
  // Back would have found it.
  closeMentionMenu();
  closeMenu();
  if (!draft) {
    if (scrollIdleTimer) {
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = null;
    }
    root.classList.remove('is-scrolling');
    canvasScrollLeft = 0;
    canvasScrollOpening = -1;
    const host = document.getElementById('wfcanvas');
    if (host && root.contains(host)) unmountCanvas();
    root.replaceChildren();
    remeasure = null;
    // Every prompt editor of the draft that just went.
    sweepHeld();
    return;
  }
  const d = draft;
  const locked = busy(d);
  const entering = enterId;
  enterId = null;
  const wantFocus = focusAfter;
  focusAfter = null;

  canvasScrollLeft = canvasScrollOpening === editorOpening ? scrollOffset() : 0;

  const body = shell(root);

  const head = el('div', 'wehead');
  const leaving = d.leaveArmed === shape(d);
  const back = el(
    'button',
    'weback' + (leaving ? ' armed' : ''),
    leaving ? 'Discard edits' : '← Board'
  ) as HTMLButtonElement;
  back.type = 'button';
  back.disabled = locked;
  if (leaving) back.dataset.tip = 'Escape again, or click, to leave without saving';
  back.onclick = () => {
    if (!draft || busy(draft)) return;
    closeEditor();
  };
  head.append(back);
  head.append(el('span', 'wecount', stepWord(d.steps.length)));
  // Delete only on an existing file — create has nothing on disk yet.
  // Two clicks: Delete → Confirm delete → post. Confirm is in the form so a
  // real host (and smoke) does not need a workbench modal.
  if (d.id !== undefined) {
    const delLabel = d.deleting ? 'Deleting…' : d.confirmDelete ? 'Confirm delete' : 'Delete';
    const del = el(
      'button',
      'wedelete' + (d.confirmDelete && !d.deleting ? ' armed' : ''),
      delLabel
    ) as HTMLButtonElement;
    del.type = 'button';
    del.disabled = locked;
    del.dataset.tip = d.confirmDelete
      ? 'Click again to permanently delete this workflow'
      : 'Delete this workflow file';
    del.onclick = () => postDelete();
    head.append(del);
  }
  const save = el('button', 'wesave', d.saving ? 'Saving…' : 'Save') as HTMLButtonElement;
  save.type = 'button';
  save.disabled = locked || authoring.structuralReasons(d.steps).length > 0;
  save.onclick = () => postSave();
  head.append(save);

  // Blocked-save reasons sit under the head so a long chain cannot hide them.
  const nodes: HTMLElement[] = [head];
  if (d.reasons.length) {
    const strip = el('div', 'westrip');
    const list = el('ul');
    for (const r of d.reasons) list.append(el('li', null, r));
    strip.append(list);
    nodes.push(strip);
  }

  const nameField = el('div', 'wefield');
  // The label names the screen, which is why there is no title span above it:
  // the two said the same thing twice in the densest part of the surface. Same
  // `d.id` that decides whether Delete is drawn at all. It stays a label in
  // appearance only — the field's accessible name is its own aria-label, since
  // "Edit workflow" names the screen and not the thing being typed into.
  nameField.append(el('span', 'welabel', d.id ? 'Edit workflow' : 'New workflow'));
  const name = el('input', 'wename') as HTMLInputElement;
  name.type = 'text';
  name.value = d.label;
  name.placeholder = 'plan→build→review';
  name.setAttribute('aria-label', 'Workflow name');
  name.disabled = locked;
  name.oninput = () => {
    if (!draft) return;
    draft.label = name.value;
  };
  nameField.append(name);
  nodes.push(nameField);

  // The canvas element is the board's #wfcanvas, moved into the body once per
  // opening and never again while it is open: an open prompt is an editor
  // inside it, and taking it out of the document drops the caret. So the
  // body keeps it, and only what is drawn above it is replaced.
  const host = $('wfcanvas');
  if (host.parentElement !== body) body.append(host);
  for (const child of [...body.children]) if (child !== host) child.remove();
  host.before(...nodes);

  const placed = toCanvas(draftSources(d.steps), d.open, d.lanes);
  const reasons = authoring.structuralReasons(d.steps);
  const refused = (id: string): string[] => (d.refusal?.id === id ? [d.refusal.text] : []);
  // Not the starting session's first step: the run starts there, so it cannot
  // be deleted (the user's call, 2026-10-05). Reordered, the new first loses it.
  const starts = d.steps.find((s) => graph.laneOf(s) === graph.ARMED)?.id;
  const canvas = {
    ...placed,
    locked,
    enter: entering,
    nodes: placed.nodes.map((node) => {
      const why = [...refused(node.id), ...reasons.filter((r) => r.startsWith(`${node.id} `))];
      return { ...node, removable: node.id !== starts, ...(why.length > 0 ? { why } : {}) };
    }),
    tracks: placed.tracks.map((track) => {
      const [why] = refused(`lane:${track.file}`);
      return why === undefined ? track : { ...track, why };
    })
  };
  mountCanvas(canvas, {
    onOpen(id) {
      if (!draft || busy(draft)) return;
      // Focus follows the node either way, so a keyboard open or close is not
      // left on a control the rebuild just replaced: into its name on open, and
      // back onto the node itself on close.
      const target = draft.steps.find((s) => s.id === (id ?? draft?.open))?.id;
      if (target) {
        focusAfter = id === null ? { kind: 'node', id: target } : { kind: 'step', id: target };
      }
      draft.open = id;
      renderEditor();
    },
    // Typing writes the draft and does not rebuild — a rebuild takes the caret.
    onEdit(id, value) {
      const step = draft?.steps.find((s) => s.id === id);
      if (!step) return;
      step.label = value;
      dropRefusal();
    },
    onAddRoot: () => addSession(),
    onAddStep: (lane) => addStepInLane(lane),
    onUnlink(from, to) {
      if (!draft || busy(draft)) return;
      commit(authoring.unlink(draft.steps, from, to), to);
    },
    onLink(from, to) {
      if (!draft || busy(draft)) return;
      const result = authoring.link(draft.steps, from, to);
      // The corner already named this while the wire was dragging.
      if ('refused' in result) return;
      commit(result, to);
    },
    refusalsFrom: (from) => authoring.linkRefusals(draft?.steps ?? [], from),
    onRenameLane(file, to) {
      if (!draft) return;
      const lanes = draft.lanes.map((lane) => (lane === file ? to.trim() : lane));
      commit(authoring.renameLane(draft.steps, file, to), `lane:${file}`, { lanes });
    },
    prompt: (id, field) => promptBox(id, field),
    fillModel,
    fillEffort,
    onRemove: (id) => removeStep(id),
    onDrop(id, row) {
      if (!draft) return;
      if (row === null) {
        // Nothing moved, and a note an earlier drop left would read as the reason.
        if (!draft.refusal) return;
        draft = { ...draft, refusal: null };
        renderEditor();
        return;
      }
      if (busy(draft)) return;
      const result = authoring.dropInRow(draft.steps, id, row);
      if (result) commit(result, id);
    }
  });
  // A box no paint shows whose step or opening is gone: a removed step's, or
  // the last workflow's.
  sweepHeld();
  scrollToOffset(canvasScrollLeft);
  canvasScrollOpening = editorOpening;
  // Layout may settle after paint (fonts, the prompt's floor): remeasure, and
  // once more after the enter animation window so tall chains stay honest.
  if (remeasure) {
    requestAnimationFrame(remeasure);
    setTimeout(remeasure, 240);
  }

  // Caret after structure is in the DOM — create opens on the workflow name;
  // + Add step lands on the new step's name.
  if (wantFocus?.kind === 'workflow') {
    name.focus();
    name.select();
  } else if (wantFocus?.kind === 'node') {
    focusNode(wantFocus.id, 'node');
  } else if (wantFocus?.kind === 'step') {
    focusNode(wantFocus.id, 'name');
  }
}

/**
 * The editor's scrolling body, and the overlay rail beside it, made once while
 * the editor is open and kept by every paint after: the canvas lives in the
 * body and an open prompt in the canvas, so a body replaced would take the
 * prompt out of the document and the caret with it. Their listeners are
 * wired here, once, for the same reason.
 */
function shell(root: HTMLElement): HTMLElement {
  const live = root.querySelector<HTMLElement>(':scope > .webody');
  if (live) return live;
  const body = el('div', 'webody');
  // Neutral overlay thumb — sibling of the scroller so it does not scroll away.
  const rail = el('div', 'wescroll');
  rail.setAttribute('aria-hidden', 'true');
  const thumb = el('div', 'wethumb');
  rail.append(thumb);
  root.replaceChildren(body, rail);
  // A fixed menu does not travel with the field it belongs to, and this column
  // scrolls. Closing is what the panel's other floating menus do.
  body.addEventListener('scroll', () => closeMentionMenu());
  // A field's own handler runs first, so the draft read here is the new one.
  body.addEventListener('input', () => disarmBack());
  remeasure = wireOverlayScroll(root, body, rail, thumb);
  return body;
}

/**
 * Typing writes the draft without a repaint, so an armed Back would go on
 * offering to discard a draft it has not seen. A step prompt's editor calls
 * this from its `onChange`, after its write: its `input` event can reach the
 * body before the editor has read the change into the draft.
 */
function disarmBack(): void {
  if (!draft || draft.leaveArmed === null || draft.leaveArmed === shape(draft)) return;
  const back = document.querySelector<HTMLElement>('#wfeditor .weback');
  if (!back) return;
  back.classList.remove('armed');
  back.textContent = '← Board';
  delete back.dataset.tip;
}

/**
 * Quiet scroll chrome: hide native bar, paint a dim neutral thumb on the right.
 * Visual-only (pointer-events: none) — wheel / trackpad still drive .webody.
 * Returns the measure, for whatever changes the height without a scroll.
 */
function wireOverlayScroll(
  root: HTMLElement,
  body: HTMLElement,
  rail: HTMLElement,
  thumb: HTMLElement
): () => void {
  const paint = (): void => {
    const { scrollTop, scrollHeight, clientHeight } = body;
    if (scrollHeight <= clientHeight + 1) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    const trackH = rail.clientHeight;
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(28, trackH * ratio);
    const maxTop = Math.max(0, trackH - thumbH);
    const top =
      scrollHeight > clientHeight ? maxTop * (scrollTop / (scrollHeight - clientHeight)) : 0;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${top}px)`;
  };

  body.addEventListener(
    'scroll',
    () => {
      root.classList.add('is-scrolling');
      paint();
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        root.classList.remove('is-scrolling');
        scrollIdleTimer = null;
      }, 700);
    },
    { passive: true }
  );
  return paint;
}

/** What `toCanvas` places. Depth, badge and track stay in `graph.ts`.
 *
 *  `effortDefault` is the catalog row's own default, so an unstated effort
 *  draws dashed. It is not a field of the file. */
function draftSources(steps: readonly EditorStep[]): CanvasSource[] {
  return steps.map((s) => {
    const model = s.model || undefined;
    const effortDefault = model
      ? ui.state.models.find((row) => row.value === model)?.defaultEffort
      : undefined;
    return {
      id: s.id,
      label: s.label,
      description: s.prompt,
      ...(s.lane ? { lane: s.lane } : {}),
      ...(s.needs && s.needs.length > 0 ? { needs: s.needs } : {}),
      ...(model ? { model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(effortDefault ? { effortDefault } : {})
    };
  });
}

function fillModel(id: string, menu: HTMLElement): void {
  const step = draft?.steps.find((s) => s.id === id);
  if (!step) return;
  menu.append(
    menuItem('Starting session’s default', !step.model, 'one', () => {
      delete step.brand;
      delete step.model;
      delete step.effort;
      closeMenu();
      renderEditor();
    })
  );
  catalogMenu(menu, ui.state.models, step.model || undefined, (model) => {
    step.brand = model.brand;
    step.model = model.value;
    const offered = model.efforts?.map((row) => row.value) ?? [];
    // An effort the new row does not offer cannot stay, so it is cleared. None
    // is ever filled in: the row's default is what an unstated effort runs at
    // anyway, and writing it would pin a value nobody chose.
    if (step.effort && !offered.includes(step.effort)) delete step.effort;
    renderEditor();
  });
}

function fillEffort(id: string, menu: HTMLElement): void {
  const step = draft?.steps.find((s) => s.id === id);
  if (!step) return;
  const row = ui.state.models.find((model) => model.value === step.model && model.efforts?.length);
  for (const effort of row?.efforts ?? []) {
    menu.append(
      effortPick(
        effort.value,
        effort.value === step.effort,
        () => {
          step.effort = effort.value;
          closeMenu();
          renderEditor();
        },
        effort.value === row?.defaultEffort
      )
    );
  }
}

function removeStep(id: string): void {
  if (!draft || busy(draft)) return;
  const index = draft.steps.findIndex((s) => s.id === id);
  const step = draft.steps[index];
  if (!step) return;
  const result = authoring.removeStep(draft.steps, step.id);
  if ('refused' in result) {
    commit(result, step.id);
    return;
  }
  const steps = result.steps;
  if (steps.length === 0) steps.push(blankStep([], draft.taken));
  const next = Math.min(index, steps.length - 1);
  const open = steps[next];
  if (open) focusAfter = { kind: 'step', id: open.id };
  draft = {
    ...draft,
    steps,
    lanes: columnOrder(steps, draft.lanes),
    refusal: null,
    open: open?.id ?? null
  };
  renderEditor();
}

/** Take down a refusal the reader is typing past, without a repaint. */
function dropRefusal(): void {
  if (!draft?.refusal) return;
  draft.refusal = null;
  clearNotes();
  // The notes were part of the body's height.
  remeasure?.();
}

/**
 * The open step's prompt: one rich editor per step per opening, kept by
 * `boxes.ts` across every paint that shows it and parked while its node is
 * shut, so a gesture's rebuild costs it neither the caret nor its Undo. It
 * goes once its step or its opening has (`sweepHeld`), which is also why
 * another workflow's step of the same id never finds it.
 */
function promptBox(id: string, field: { label: string; locked: boolean }): HTMLElement {
  const opening = editorOpening;
  const skills = machineSkills() ?? [];
  const box = keptBox({
    key: `wfprompt:${opening}:${id}`,
    alive: () => opening === editorOpening && !!draft?.steps.some((s) => s.id === id),
    make: () => openPrompt(id, skills)
  });
  box.prose.update({ label: field.label, readOnly: field.locked, skills });
  return box.node;
}

/**
 * Make a step's editor from the prose the draft holds for it, its mentions
 * formed into chips once, before any history holds them (`markdownDoc`).
 *
 * The draft's `prompt` stays what Save writes, kept current from here: the
 * text the step was opened with, byte for byte, while the document is still
 * the one it opened as, and the editor's delivery once it is not. Markdown
 * cannot say blank-line counts, a run of spaces or a `*` bullet back as they
 * were, so an untouched prompt is never read back out of it.
 */
function openPrompt(id: string, skills: readonly string[]): { host: HTMLElement; prose: Prose } {
  const original = draft?.steps.find((s) => s.id === id)?.prompt ?? '';
  const host = el('div', 'wcprompt');
  const bar = el('div', 'formatbar');
  const input = el('div', 'wcbody');
  host.append(bar, input);
  // `openedDoc` is read by edits only, and none can come before the restore.
  const prose = createProse(input, {
    mode: 'rich',
    placeholder: 'What this step should do',
    skills,
    sessionName: (pid) => findCard(pid)?.card.name,
    onChange: () => {
      const step = draft?.steps.find((s) => s.id === id);
      if (step) {
        step.prompt = sameDoc(openedDoc, prose.snapshot() as ComposeDoc) ? original : prose.value();
      }
      dropRefusal();
      disarmBack();
      // The prompt grows with its content, and the body's scroll height with it.
      remeasure?.();
    }
  });
  const formatbar = attachFormatbar(bar, prose, {
    formats: ['bulletList', 'orderedList', 'code', 'codeBlock']
  });
  prose.update({ onFormat: (formats) => formatbar.paint(formats) });
  prose.restore(markdownDoc(original, skills), { history: 'fresh' });
  const openedDoc = prose.snapshot() as ComposeDoc;
  attachMentions(prose.selection, {
    opened: () => vscode.postMessage({ type: 'refreshSkills' }),
    skillsChanged: (skills) => prose.update({ skills }),
    sources: () => ({ skills: machineSkills() ?? [], models: ui.state.models }),
    write: (mention) => {
      prose.insertChip(mention.kind, mention.expansion);
      return `${mention.expansion} `;
    }
  });
  return { host, prose };
}
