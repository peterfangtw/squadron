import { el } from './dom';
import { heldOpen, paintIfChanged } from './kit';
import * as bottomDrawerModes from './bottom_drawer_modes';
import * as overflow from './bottom_hub_overflow';
import * as bottomDrawer from './bottom_drawer';
import { ui } from './state';

export function render(): void {
  const board = document.getElementById('board');
  const bar = document.getElementById('bottomhub');
  if (!board || (bar && heldOpen(bar))) return;
  const next = bar ?? el('div');
  if (!bar) next.id = 'bottomhub';
  // Replacing a button between mousedown and mouseup drops its click.
  const sig = bottomDrawerModes
    .modes()
    .flatMap((mode) => (ui.ready && mode.available && mode.empty?.() ? [mode.id] : []))
    .join('\n');
  paintIfChanged(next, `${ui.ready}:${sig}`, () => {
    next.replaceChildren(
      ...bottomDrawerModes.modes().map((mode) => {
        if (!mode.available) return word(mode);
        if (ui.ready && mode.empty?.()) {
          const instead = mode.emptyWord?.();
          if (instead) return instead;
        }
        return word(mode);
      })
    );
  });
  // The ask layer must cover the bar as well as the rest of the board.
  if (!bar) board.insertBefore(next, document.getElementById('scrim'));
  board.classList.add('hasbar');
}

function word(mode: bottomDrawerModes.DrawerMode): HTMLElement {
  const button = el('button', mode.barClass, mode.title);
  button.dataset.drawerMode = mode.id;
  if (!mode.available) {
    button.setAttribute('aria-disabled', 'true');
    button.dataset.tip = 'Not available yet';
    return button;
  }
  button.setAttribute('aria-controls', 'bottomdrawer');
  button.setAttribute('aria-expanded', 'false');
  button.onclick = () => bottomDrawer.open(mode.id);
  if (mode.badge === 'count') button.append(' ', el('span', 'num', '0'));
  if (mode.badge === 'dot') {
    const dot = el('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot);
  }
  return button;
}

export function syncBarWords(): void {
  for (const mode of bottomDrawerModes.modes()) syncBarWord(mode);
  const bar = document.getElementById('bottomhub');
  const board = document.getElementById('board');
  if (bar && board) overflow.sync(bar, board);
}

export function syncBarWord(mode: bottomDrawerModes.DrawerMode): void {
  if (!mode.available) return;
  const button = document.querySelector<HTMLElement>(`#bottomhub [data-drawer-mode="${mode.id}"]`);
  if (!button) return;
  const state = ui.ready ? mode.bar() : { tip: `Loading ${mode.title.toLowerCase()}…` };
  attribute(button, 'aria-busy', String(!ui.ready));
  const count = button.querySelector('.num');
  const value = ui.ready ? String(state.count ?? 0) : '…';
  if (count && count.textContent !== value) {
    count.textContent = value;
  }
  const dot = button.querySelector('.dot');
  const dotClass = state.tone ? `dot ${state.tone}` : 'dot';
  if (dot && dot.className !== dotClass) dot.className = dotClass;
  attribute(button, 'data-tip', state.tip);
  attribute(button, 'aria-label', state.label);
  const rows = state.rows?.length ? JSON.stringify(state.rows) : undefined;
  attribute(button, 'data-tip-head', rows ? mode.title : undefined);
  attribute(button, 'data-tip-rows', rows);
  attribute(button, 'aria-expanded', String(bottomDrawer.isModeOpen(mode.id)));
}

function attribute(node: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}
