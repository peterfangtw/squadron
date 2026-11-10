/**
 * The bottom drawer: one frame, every mode. What a mode draws, and what it
 * remembers while it is shut, lives in that mode.
 */

import { $, el } from './dom';
import * as layers from './layers';
import { ui } from './state';
import { setOpen } from './workflow_overview_drawer';
import * as bottomHub from './bottom_hub';
import * as bottomDrawerModes from './bottom_drawer_modes';

/** Webview-local: dies on reload, and nothing writes it down. */
let raised = false;
/** Which filling is up. The bar is hidden while the drawer is, so this is
 *  whichever word was pressed while it was shut. */
let mode: bottomDrawerModes.DrawerModeId | undefined;
/** The paint `open` is about to ask for. A mode reads it once, so opening can
 *  clear state a later paint of the same filling must keep. */
let arrival = false;
/** Find and foot are concealed when the filling changes. The mode's paint
 *  shows them when it has any. */
let slotsFor: bottomDrawerModes.DrawerModeId | undefined;
/** On the layer stack exactly while the drawer is drawn raised, however it
 *  came down: `close`, or a paint that found its mode empty. */
let layer: layers.Handle | undefined;

function resting(): bottomDrawerModes.DrawerModeId {
  const first = bottomDrawerModes.modes()[0];
  if (!first) throw new Error('No drawer mode');
  return first.id;
}

export function open(id?: bottomDrawerModes.DrawerModeId): void {
  const next = bottomDrawerModes.modeFor(id ?? resting());
  if (!next.available) return;
  setOpen(false);
  raised = true;
  mode = next.id;
  arrival = true;
  render();
}

/** True once, for the paint `open` just asked for. */
export function takeArrival(): boolean {
  const opening = arrival;
  arrival = false;
  return opening;
}

export function isModeOpen(id: bottomDrawerModes.DrawerModeId): boolean {
  return raised && mode === id;
}

export function repaintModes(): void {
  for (const entry of bottomDrawerModes.modes()) repaintMode(entry.id);
}

export function repaintMode(id: bottomDrawerModes.DrawerModeId): void {
  if (!ui.ready) return;
  const entry = bottomDrawerModes.modeFor(id);
  if (!entry.available) return;
  entry.repaint(isModeOpen(id), false);
  bottomHub.syncBarWord(entry);
}

export function tickModes(): void {
  for (const entry of bottomDrawerModes.modes()) {
    if (entry.available && entry.beat) repaintMode(entry.id);
  }
}

/** Dismissal returns focus to the hub word. `taken` leaves it on the live
 *  workflow chip, which sits outside this drawer. */
export function close(why?: 'taken'): void {
  if (!raised) return;
  const closing = mode;
  raised = false;
  mode = resting();
  slotsFor = undefined;
  arrival = false;
  for (const entry of bottomDrawerModes.modes()) {
    if (entry.available) entry.closed?.();
  }
  render();
  if (why === 'taken' || closing === undefined) return;
  const word = bottomDrawerModes.modeFor(closing).focusWord;
  const button = word ? document.querySelector<HTMLElement>(`#bottomhub ${word}`) : null;
  const target = button?.closest('#bottomhub-overflow')
    ? document.getElementById('bottomhub-more')
    : button;
  target?.focus();
}

export function isOpen(): boolean {
  return raised;
}

/** A mode that reports itself empty has nothing to draw, so the drawer shuts.
 *  A mode that does not stays up. */
export function render(source: 'local' | 'push' = 'local'): void {
  const root = $('bottomdrawer');
  const entry = bottomDrawerModes.modeFor(mode ?? resting());
  const vacant = ui.ready && entry.available && entry.empty?.() === true;
  $('bottomdrawer-body').setAttribute('aria-busy', String(!ui.ready));
  if (!raised || vacant) {
    raised = false;
    mode = resting();
    slotsFor = undefined;
    arrival = false;
    // Keep the closing mode's chrome during the 180ms slide (css/bottom_drawer.ts).
    root.hidden = true;
    $('bottomdrawer-scrim').hidden = true;
    $('board').classList.remove('drawer-open');
    layer?.pop();
    layer = undefined;
  } else if (entry.available) {
    root.classList.toggle('columns', entry.columns);
    for (const candidate of bottomDrawerModes.modes()) {
      root.classList.toggle(candidate.id, candidate.id === mode);
    }
    const initial = slotsFor !== mode;
    if (initial) {
      concealSlots();
      if (ui.ready) slotsFor = mode;
    }
    const title = $('bottomdrawer-head').querySelector('.ttl');
    if (title && title.textContent !== entry.title) title.textContent = entry.title;
    const note = $('bottomdrawer-note');
    note.hidden = false;
    const text = ui.ready ? entry.note() : 'Loading…';
    if (note.textContent !== text) note.textContent = text;
    root.hidden = false;
    $('bottomdrawer-scrim').hidden = false;
    $('board').classList.add('drawer-open');
    if (!layer?.open) {
      layer = layers.push({
        kind: 'bottomDrawer',
        close: () => close(),
        // The composer's own Escape is the interrupt, and the ask layer keeps
        // its own. Without the yield, Escape with the caret in the box closed
        // the drawer and stopped the session.
        escape: 'consume',
        yieldsToComposer: true,
        ground: true,
        root: () => [root, $('bottomdrawer-scrim')]
      });
    }
    if (!ui.ready) {
      const body = $('bottomdrawer-body');
      body
        .querySelector('.bdlist')
        ?.replaceChildren(el('div', 'empty', `Loading ${entry.title.toLowerCase()}…`));
      body.querySelector('.bddetail')?.replaceChildren();
    } else if (source === 'local' || initial) entry.paint();
    arrival = false;
  }
  if (source === 'push' && ui.ready) {
    for (const candidate of bottomDrawerModes.modes()) {
      if (candidate.available) candidate.repaint(isModeOpen(candidate.id), true);
    }
  }
  bottomHub.syncBarWords();
}

/** Find and foot start hidden. The mode that uses them shows them from its paint. */
function concealSlots(): void {
  $('bottomdrawer-filter').hidden = true;
  $('bottomdrawer-find').hidden = true;
  $('bottomdrawer-foot').hidden = true;
}

/**
 * Dismissal, and why it is this drawer's own rather than the overview drawer's.
 *
 * `workflow_overview_drawer.ts` shuts on any press inside `#board`, and that is only correct
 * because `#workflowoverviewdrawer` lives in the *dock's* DOM — a press on the board really
 * is a press past it. `#bottomdrawer` is a child of `#board`, so the same rule would
 * shut this on its own row buttons and its own filter box. Hence the
 * first line: everything inside the drawer is inside, whatever else it is.
 * A press that landed in a layer above it — the lightbox, a dialog, a picker,
 * all children of `#board` — is that layer's, not a press past the drawer.
 */
document.addEventListener('click', (e) => {
  if (!raised || (layer && layers.above(layer, e))) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('#bottomdrawer') || t.closest('#bottomhub')) return;
  if (t.closest('#bottomdrawer-scrim') || t.closest('#board')) close();
});

$('bottomdrawer-close').onclick = () => close();
