/**
 * A centred sheet over the board or full panel: scrim, frame, head, body, foot.
 *
 * Graduated from `accounts.ts` `sheetShell` — that was the third
 * scrim-plus-sheet pair (`#ascrim`), built only because login needed one, and
 * MCP is the fourth caller of the same chrome. Resume / server / workflow
 * pickers stay on their own markup: different geometry, static HTML, search.
 *
 * Not the glossary's dialog: `#ask` / `#scrim` is the ask layer. These sit on
 * the same rung as `#pscrim` (`css/auth.ts`). To assistive tech each is an
 * ARIA dialog named by its title.
 */

import { el, imeKey } from './dom';
import * as layers from './layers';

export type SheetSpec = {
  /** Scrim id. Auth keeps `ascrim` so its tests stay pointed at one node. */
  id: string;
  title: string;
  position: 'board' | 'panel';
  interactionScope?: 'board' | 'panel';
  mark?: HTMLElement;
  /** MCP's brand × server matrix. Auth stays the default 360. */
  wide?: boolean;
  modal?: boolean;
  /** X, backdrop, Escape. `close()` does not fire this. */
  onClose: () => void;
  /**
   * In-flight work. X, backdrop and Escape are off — those are how a login
   * waiting on a browser tab gets cancelled by a click on the dimmed board.
   * `close()` still hides; a Cancel in the foot is the reader's way out.
   */
  locked?: boolean;
};

export type Sheet = {
  element: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  close: () => void;
};

type Live = {
  id: string;
  root: HTMLElement;
  onClose: () => void;
  locked: boolean;
  modal: boolean;
  restoreFocus?: HTMLElement;
  scope?: 'board' | 'panel';
  unblock?: () => void;
};

/** One of these sheets at a time — login and MCP must not stack. */
let live: Live | undefined;
/** The live sheet's place on the stack. A same-id repaint keeps it. */
let layer: layers.Handle | undefined;

/**
 * Show a sheet. Same id again replaces its children (auth repaints progress
 * this way). A different id dismisses whatever is already up.
 */
export function openSheet(spec: SheetSpec): Sheet {
  if (live && live.id !== spec.id) dismiss(live);

  const root = ensureScrim(spec.id);
  root.classList.add('sheet-scrim');
  root.dataset.position = spec.position;
  if (spec.interactionScope) root.dataset.scope = spec.interactionScope;
  else delete root.dataset.scope;
  root.replaceChildren();
  root.hidden = false;

  const sheet = el('div', spec.wide ? 'asheet wide' : 'asheet');
  const title = el('b', null, spec.title);
  title.id = `${spec.id}-title`;
  sheet.setAttribute('role', 'dialog');
  const modal = spec.interactionScope === 'panel' || (!spec.interactionScope && !!spec.modal);
  if (modal) sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', title.id);
  const head = el('div', 'ashead');
  if (spec.mark) head.append(spec.mark);
  head.append(title);
  const rec: Live = {
    id: spec.id,
    root,
    onClose: spec.onClose,
    locked: !!spec.locked,
    modal,
    scope: spec.interactionScope,
    restoreFocus:
      (modal || spec.interactionScope) && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined
  };
  const close = () => hide(spec.id);
  if (!spec.locked) {
    const x = document.createElement('button');
    x.className = 'ax';
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Close');
    x.onclick = () => dismiss(rec);
    head.append(x);
  }

  const body = el('div', 'asbody');
  const foot = el('div', 'asfoot');
  sheet.append(head, body, foot);
  root.append(sheet);

  live?.unblock?.();
  live = rec;
  if (spec.interactionScope) rec.unblock = blockBackground(root, spec.interactionScope);
  armKeys();
  if (!layer?.open) {
    layer = layers.push({
      kind: 'sheet',
      close: () => {
        if (live) dismiss(live);
      },
      escape: onSheetEscape,
      root: () => [live?.root]
    });
  }
  return { element: sheet, head, title, body, foot, close };
}

export function closeSheet(id: string): void {
  hide(id);
}

function ensureScrim(id: string): HTMLElement {
  let root = document.getElementById(id);
  if (!root) {
    root = el('div');
    root.id = id;
    root.hidden = true;
    document.getElementById('board')?.append(root);
    root.addEventListener('click', (e) => {
      // The target can hide this sheet before the event reaches its backdrop.
      // Keep that click from dismissing a surface underneath it.
      e.stopPropagation();
      if (e.target !== root) return;
      if (live && live.id === id && !live.locked) dismiss(live);
    });
  }
  return root;
}

function hide(id: string, explicit = false): void {
  if (!live || live.id !== id) return;
  const restoreFocus = live.restoreFocus;
  const restore = live.scope ? explicit || live.root.contains(document.activeElement) : true;
  live.unblock?.();
  live.root.hidden = true;
  live.root.replaceChildren();
  live = undefined;
  layer?.pop();
  layer = undefined;
  disarmKeys();
  if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
}

function dismiss(rec: Live): void {
  // Hide first so onClose can call close() without looping.
  hide(rec.id, true);
  rec.onClose();
}

function blockBackground(root: HTMLElement, scope: 'board' | 'panel'): () => void {
  const changed = new Map<HTMLElement, boolean>();
  const container = scope === 'panel' ? document.body : document.getElementById('board');
  const block = (): void => {
    let child: HTMLElement = root;
    while (child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === child) continue;
        if (!changed.has(sibling)) changed.set(sibling, sibling.inert);
        sibling.inert = true;
      }
      if (child.parentElement === container) break;
      child = child.parentElement;
    }
  };
  block();
  const observer = new MutationObserver(block);
  if (container) observer.observe(container, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const [node, inert] of changed) node.inert = inert;
  };
}

let keysOn = false;

function onSheetKey(e: KeyboardEvent): void {
  if (!live || imeKey(e)) return;
  if (e.key === 'Tab' && live.modal) {
    const controls = [
      ...live.root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ].filter((control) => !control.closest('[hidden]'));
    const first = controls[0];
    const last = controls.at(-1);
    e.stopImmediatePropagation();
    if (
      e.shiftKey &&
      (document.activeElement === first || !live.root.contains(document.activeElement))
    ) {
      e.preventDefault();
      last?.focus();
    } else if (
      !e.shiftKey &&
      (document.activeElement === last || !live.root.contains(document.activeElement))
    ) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
}

function onSheetEscape(): boolean {
  if (!live) return false;
  if (live.scope === 'board' && !live.root.contains(document.activeElement)) return false;
  // A locked sheet refuses the key and still owns it: one modal over the board
  // passing it on would end the turn of the session behind it.
  if (!live.locked) dismiss(live);
  return true;
}

function onFocus(e: FocusEvent): void {
  if (!live?.modal || (e.target instanceof Node && live.root.contains(e.target))) return;
  live.root.querySelector<HTMLElement>('[autofocus]')?.focus({ preventScroll: true });
}

function armKeys(): void {
  if (keysOn) return;
  // Tab containment only; Escape is the layer stack's.
  window.addEventListener('keydown', onSheetKey, true);
  document.addEventListener('focusin', onFocus, true);
  keysOn = true;
}

function disarmKeys(): void {
  if (!keysOn) return;
  window.removeEventListener('keydown', onSheetKey, true);
  document.removeEventListener('focusin', onFocus, true);
  keysOn = false;
}
