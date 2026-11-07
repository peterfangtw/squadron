import { el } from './dom';
import { heldOpen, paintIfChanged, morph } from './kit';
import * as bottomDrawerModes from './bottom_drawer_modes';
import * as overflow from './bottom_hub_overflow';
import * as bottomDrawer from './bottom_drawer';
import { ui } from './state';
import { blocked } from './board_card';
import { reveal } from './board_actions';
import * as pillStack from './pill_stack';
import * as warningInk from './warning_ink';

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
  if (mode.id === 'agents') {
    const count = el('span', 'waiting-count');
    count.hidden = true;
    button.append(count);
  }
  return button;
}

export function syncBarWords(): void {
  for (const mode of bottomDrawerModes.modes()) syncBarWord(mode);
  const bar = document.getElementById('bottomhub');
  const board = document.getElementById('board');
  if (bar && board) {
    overflow.sync(bar, board);
    if (syncWaiting(bar, board)) overflow.sync(bar, board);
  }
}

export function syncBarWord(mode: bottomDrawerModes.DrawerMode): void {
  if (!mode.available) return;
  const button = document.querySelector<HTMLElement>(`#bottomhub [data-drawer-mode="${mode.id}"]`);
  if (!button) return;
  const state = ui.ready ? mode.bar() : { tip: `Loading ${mode.title.toLowerCase()}…` };
  const waiting =
    mode.id === 'agents'
      ? ui.state.groups.flatMap((group) => group.sessions).filter(blocked).length
      : 0;
  attribute(button, 'aria-busy', String(!ui.ready));
  const count = button.querySelector('.num');
  const value = ui.ready ? String(state.count ?? 0) : '…';
  if (count && count.textContent !== value) {
    count.textContent = value;
  }
  const dot = button.querySelector('.dot');
  const dotClass = state.tone ? `dot ${state.tone}` : 'dot';
  if (dot && dot.className !== dotClass) dot.className = dotClass;
  attribute(button, 'data-tip', waiting ? undefined : state.tip);
  attribute(
    button,
    'aria-label',
    waiting
      ? `Agents, ${waiting} sessions need input. Arrow Up to browse; click for settings.`
      : state.label
  );
  if (mode.id === 'agents') attribute(button, 'aria-keyshortcuts', waiting ? 'ArrowUp' : undefined);
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

type WaitingStack = {
  trigger: HTMLElement;
  stack: HTMLElement;
  controls: pillStack.PillStack;
  signature: string;
};
let waitingStack: WaitingStack | undefined;

function syncWaiting(bar: HTMLElement, board: HTMLElement): boolean {
  const trigger = bar.querySelector<HTMLElement>('.agents-tab');
  if (!trigger) return false;
  if (!waitingStack || waitingStack.trigger !== trigger || !bar.contains(waitingStack.stack)) {
    waitingStack?.controls.dispose();
    waitingStack?.stack.remove();
    const stack = el('div', 'pill-stack waiting-pills');
    stack.id = 'bottomhub-waiting';
    stack.hidden = true;
    stack.inert = true;
    stack.setAttribute('role', 'group');
    stack.setAttribute('aria-label', 'Sessions needing input');
    bar.append(stack);
    trigger.setAttribute('aria-controls', 'bottomdrawer bottomhub-waiting');
    const controls = pillStack.create(trigger, stack, board, false);
    stack.addEventListener('click', (event) => {
      const chip =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pid]') : null;
      const session = ui.state.groups
        .flatMap((group) => group.sessions)
        .find(
          (session) =>
            String(session.pid) === chip?.dataset.pid &&
            String(session.startedAt) === chip.dataset.startedAt &&
            blocked(session)
        );
      if (session) reveal(session.pid);
    });
    waitingStack = { trigger, stack, controls, signature: '' };
  }
  const { stack, controls } = waitingStack;
  const waiting = ui.state.groups.flatMap((group) => group.sessions).filter(blocked);
  const signature = JSON.stringify(
    waiting.map((session) => [
      session.pid,
      session.startedAt,
      session.name,
      session.waitingFor,
      session.needs
    ])
  );
  const changed = signature !== waitingStack.signature;
  if (changed) {
    const focused = document.activeElement;
    const count = trigger.querySelector<HTMLElement>('.waiting-count');
    if (count) {
      count.hidden = waiting.length === 0;
      count.textContent = waiting.length ? String(waiting.length) : '';
    }
    trigger.classList.toggle('needs-input', waiting.length > 0);
    morph(
      stack,
      waiting.map((session) => {
        const chip = el('button', 'hpill waiting-session', session.name);
        chip.dataset.key = `waiting:${session.pid}:${session.startedAt}`;
        chip.dataset.act = 'ask';
        chip.dataset.pid = String(session.pid);
        chip.dataset.startedAt = String(session.startedAt);
        chip.setAttribute(
          'aria-label',
          session.name +
            ((session.waitingFor ?? session.needs)
              ? ' · ' + (session.waitingFor ?? session.needs)
              : '')
        );
        return chip;
      })
    );
    if (
      focused instanceof HTMLElement &&
      !document.contains(focused) &&
      focused.classList.contains('waiting-session')
    )
      trigger.focus();
    waitingStack.signature = signature;
  }
  if (waiting.length) {
    const count = trigger.querySelector<HTMLElement>('.waiting-count');
    if (count) warningInk.sync(count);
  }
  controls.refresh();
  return changed;
}
