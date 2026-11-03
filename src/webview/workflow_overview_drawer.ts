/**
 * Observational workflow overview drawer: full step rail for the selected session's FOLLOWING
 * attach. Opens from the live composer chip; never advances steps (runtime §15).
 */

import { $, el } from './dom';
import { morph } from './kit';
import { chats, ui } from './state';
import * as bottomDrawer from './bottom_drawer';

/** Webview-local only — not on StateMessage; dies with reload / deselect. */
let open = false;
/** Last joined current id we scrolled to while open — repaints must not fight the reader. */
let scrolledTo: string | undefined;

export function isOpen(): boolean {
  return open;
}

export function setOpen(next: boolean): void {
  // Both cover the board, and neither has anything to say about the other (C9).
  // Stated at both doors rather than one: the drawer's chip lives in the dock,
  // so opening it trips no dismissal listener of the sheet's, and a drawer
  // opened under `#bottomdrawer-scrim` would be greyed out and unclickable at z-index 8.
  if (next) bottomDrawer.close('taken');
  open = next;
  if (!open) scrolledTo = undefined;
  render();
}

/** Through `setOpen`, so the exclusivity above is stated once. The chip
 *  toggles, and a toggle that opened by another route would open under the
 *  sheet's own backdrop. */
export function toggleDrawer(): void {
  setOpen(!open);
}

/**
 * Paint `#workflowoverviewdrawer` from the selected thread's `workflow.steps`.
 *
 * Closed when: local flag off, no selection, or no FOLLOWING workflow. Header
 * only when the rail is empty (should not happen for a valid snapshot).
 */
export function render(): void {
  const root = $('workflowoverviewdrawer');
  const thread = chats.thread();
  const live =
    ui.selected !== null && thread && thread.pid === ui.selected ? thread.workflow : undefined;

  // FOLLOWING gone or deselect: drop open so a later attach does not pop open.
  if (!live) {
    open = false;
    scrolledTo = undefined;
    shut(root);
    return;
  }

  if (!open) {
    scrolledTo = undefined;
    shut(root);
    return;
  }

  const steps = live.steps ?? [];
  const head = el('div', `rdhead ${live.phase}`);
  head.dataset.key = 'rd:head';
  head.append(el('span', 'dot'), el('span', 'lbl', live.label));
  const close = el('button', 'x', '◂ close') as HTMLButtonElement;
  close.type = 'button';
  close.dataset.key = 'rd:close';
  close.dataset.tip = 'Close workflow steps';
  close.onclick = () => setOpen(false);
  head.append(close);

  const list = el('ol', 'rdsteps');
  list.dataset.key = 'rd:steps';
  list.setAttribute('aria-label', `${live.label} steps`);
  for (const step of steps) {
    list.append(stepRow(step));
  }

  // Morph, never replace: `.rdsteps` is the scroll container, so a fresh <ol>
  // on every state push resets `scrollTop` to 0 — a reader scrolled down a long
  // rail gets thrown back to the top each time a frame lands. The keys are what
  // keep the *same* <ol> (and the same rows) across paints; `rd:close` is here
  // because a replaced button drops the click that is already on its way down.
  morph(root, [head, list]);
  root.hidden = false;
  syncChipCaret();

  // Scroll only on first open or when the joined cursor moves — not every poll.
  const currentId = steps.find((s) => s.current)?.id;
  if (currentId !== undefined && currentId !== scrolledTo) {
    root.querySelector<HTMLElement>('.strow.now')?.scrollIntoView({ block: 'nearest' });
    scrolledTo = currentId;
  }
}

/**
 * Set the attribute the CSS shuts on, and leave the rail where it is.
 *
 * The rail is what slides out (css/workflow_overview_drawer.ts): emptying the node here would
 * animate a blank box for the 160ms, the steps having vanished on the frame the
 * press landed. Nothing reads a shut drawer's children — it is `display: none`
 * the moment the motion ends — and the next open morphs them to whatever run it
 * is opening for before it is shown again.
 */
function shut(root: HTMLElement): void {
  root.hidden = true;
  syncChipCaret();
}

type RailStep = NonNullable<NonNullable<ThreadView['workflow']>['steps']>[number];

function stepRow(step: RailStep): HTMLElement {
  const rowCls = classes(step);
  const r = el('li', rowCls ? `strow ${rowCls}` : 'strow');
  r.dataset.key = `st:${step.id}`;
  const mark = el('span', 'smark', markGlyph(step));
  mark.setAttribute('aria-hidden', 'true');
  const line = el('div', 'sline');
  line.append(el('span', 'slabel', step.label), el('span', 'sstate', stateWord(step)));
  r.append(mark, line);
  if (step.note) r.append(el('div', 'snote', step.note));
  return r;
}

/** Blue rail only on the joined cursor (`current`) — freehand multi-active is not multiple "now". */
function classes(step: RailStep): string {
  if (step.current) {
    return step.status === 'failed' ? 'failed now' : 'now';
  }
  if (step.status === 'completed') return 'done';
  if (step.status === 'failed') return 'failed';
  if (step.status === 'in_progress') return ''; // working, but not the strip cursor
  if (step.status === 'unknown') return 'unknown';
  return 'todo';
}

function markGlyph(step: RailStep): string {
  if (step.status === 'completed') return '✓';
  if (step.status === 'failed') return '!';
  return '';
}

function stateWord(step: RailStep): string {
  if (step.status === 'completed') return 'done';
  if (step.status === 'failed') return 'failed';
  if (step.status === 'in_progress' || (step.current && step.status === 'pending')) {
    return 'working';
  }
  if (step.status === 'unknown') return 'unknown';
  return 'pending';
}

function syncChipCaret(): void {
  const chip = document.querySelector<HTMLElement>('#wattach .wflow.live');
  if (!chip) return;
  chip.classList.toggle('open', open);
  chip.setAttribute('aria-expanded', String(open));
  chip.dataset.tip = open ? 'Hide workflow steps' : 'Show workflow steps';
}

/**
 * A press on the board shuts the drawer, the way a click off a modal does.
 *
 * The board is the only "outside" worth naming: the drawer is drawn over it but
 * lives in the dock's DOM, so a press that lands on a card really is a press
 * past the rail. Everything in the dock — the thread it abuts, the composer
 * below, the chip that opens it — is deliberately not, or typing a message
 * while watching a run would close what the reader opened to watch.
 *
 * Delegated to the document and not to #board, because the board's own handlers
 * are delegated too and this must not depend on landing before or after them:
 * it only reads the press, and lets it through to select the card it hit.
 */
document.addEventListener('click', (e) => {
  if (!open) return;
  const t = e.target;
  if (t instanceof Element && t.closest('#board')) setOpen(false);
});

/** Esc closes the drawer when open; input and ask keep their own Escape. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !open) return;
  const t = e.target;
  if (t instanceof HTMLElement && t.closest('#input, #ask')) return;
  e.preventDefault();
  setOpen(false);
});
