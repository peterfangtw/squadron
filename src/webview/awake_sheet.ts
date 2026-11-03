/**
 * Keep-awake on the sheet: the bar word's dot; on the left the Keep awake
 * switch carrying what the hold is doing now, over the Remote-hold and
 * Warm-hold switches; on the right the figures it runs by.
 *
 * Paint only. The hold arrives merged on `StateMessage.awake`, the switches on
 * `cafe`, `cafeRemote` and `cafeWarm`. The state lines and the figures are
 * `ui/awake_rows.ts`; the switch labels are written here. A flip is held until
 * a push agrees. The frame's open and close stay in `bottom_drawer.ts`.
 */

import * as awakeRows from '../ui/awake_rows';
import { $, el, q } from './dom';
import * as holds from './holds';
import { morph, switchRow } from './kit';
import { ui, vscode } from './state';
import * as bottomDrawer from './bottom_drawer';
import * as sheetParts from './sheet_parts';
import { why } from './tip';
import type { HubWord } from './bottom_drawer_modes';

/** The left column's shape as last painted: everything but the clock. The
 *  1s beat moves only the minutes and the bar, and writes those two in place;
 *  anything else rebuilds the column. */
let shape = '';

export function awakeBar(): HubWord {
  const now = current();
  return {
    tone: awakeRows.awakeBarTone(now.tone),
    tip: now.left ? `${now.head}, ${now.left}` : now.head
  };
}

export function paintAwakeSheet(): void {
  morph(q($('bottomdrawer-body'), '.bddetail'), configuration());
  repaintAwake();
}

/** Off the pushed switches, not a flip in flight: `awake` is absent while the
 *  setting is off, so an optimistic on would read as a machine that cannot
 *  hold until the host's push arrives. */
function current(): awakeRows.AwakeState {
  return awakeRows.awakeState(
    {
      view: ui.state.awake,
      enabled: ui.state.cafe,
      remoteHold: ui.state.cafeRemote,
      remoteOn: ui.state.remote?.onSomewhere === true,
      warmHold: ui.state.cafeWarm,
      warmOn: ui.state.warmOn
    },
    Date.now()
  );
}

export function repaintAwake(): void {
  const now = current();
  const enabled = holds.flags.shown('cafe', ui.state.cafe);
  const remoteHold = holds.flags.shown('cafeRemote', ui.state.cafeRemote);
  const warmHold = holds.flags.shown('cafeWarm', ui.state.cafeWarm);
  const list = q($('bottomdrawer-body'), '.bdlist');
  const sig = JSON.stringify([
    now.tone,
    now.head,
    now.reason,
    now.fill !== undefined,
    enabled,
    remoteHold,
    warmHold
  ]);
  const drawn = list.querySelector<HTMLElement>('.awake-now');
  if (sig !== shape || !drawn) {
    shape = sig;
    morph(list, [
      masterRow(now, enabled),
      remoteHead(),
      remoteRow(remoteHold, enabled),
      warmHead(),
      warmRow(warmHold, enabled)
    ]);
    return;
  }
  const left = drawn.querySelector('.left');
  if (left && now.left !== undefined && left.textContent !== now.left) left.textContent = now.left;
  const fill = drawn.querySelector<HTMLElement>('.bar i');
  if (fill && now.fill !== undefined) {
    const width = barWidth(now.fill);
    if (fill.style.width !== width) fill.style.width = width;
  }
}

function barWidth(fill: number): string {
  return `${(fill * 100).toFixed(1)}%`;
}

function masterRow(now: awakeRows.AwakeState, on: boolean): HTMLElement {
  const row = switchRow(
    'Keep awake',
    awakeRows.awakeDetail(now),
    on,
    (next) => {
      holds.flags.hold('cafe', next);
      vscode.postMessage({ type: 'setFlag', key: 'cafe', on: next });
      bottomDrawer.repaintMode('awake');
    },
    undefined,
    'switch'
  );
  row.classList.add('awake-now');
  row.dataset.key = 'awake:on';
  row.dataset.tone = now.tone;
  const state = el('span', 'state');
  state.append(el('i', 'dot'), el('span', 'head', now.head));
  if (now.left) state.append(el('span', 'left', now.left));
  // Named by its label alone, with the state and reason as its description:
  // otherwise a focused switch is renamed every minute the lease ticks.
  state.id = 'awake-state';
  q(row, '.d').id = 'awake-why';
  q(row, '.t').replaceChildren(el('span', 'name', 'Keep awake'), state);
  row.setAttribute('aria-label', 'Keep awake');
  row.setAttribute('aria-describedby', 'awake-state awake-why');
  if (now.fill !== undefined) {
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = barWidth(now.fill);
    bar.append(fill);
    row.append(bar);
  }
  return row;
}

function remoteHead(): HTMLElement {
  const head = el('div', 'mhead', 'Remote');
  head.dataset.key = 'awake:remote-head';
  return head;
}

/** Dead while keep-awake is off: there is nothing for Remote to hold. Read at
 *  the press by `switchRow`, so a repaint that frees it frees the press. */
function remoteRow(on: boolean, enabled: boolean): HTMLElement {
  const row = switchRow(
    'Stay awake while Remote is on',
    undefined,
    enabled && on,
    (next) => {
      holds.flags.hold('cafeRemote', next);
      vscode.postMessage({ type: 'setFlag', key: 'cafeRemote', on: next });
      bottomDrawer.repaintMode('awake');
    },
    undefined,
    'switch'
  );
  if (!enabled) row.setAttribute('aria-disabled', 'true');
  row.dataset.key = 'awake:remote';
  explain(
    row,
    'Keep the Mac awake with no session working, so messages from your phone arrive. This stops when Remote stops.'
  );
  return row;
}

function warmHead(): HTMLElement {
  const head = el('div', 'mhead', 'Warm');
  head.dataset.key = 'awake:warm-head';
  return head;
}

/** Dead while keep-awake is off, for `remoteRow`'s reason. */
function warmRow(on: boolean, enabled: boolean): HTMLElement {
  const row = switchRow(
    'Stay awake while Warm is on',
    undefined,
    enabled && on,
    (next) => {
      holds.flags.hold('cafeWarm', next);
      vscode.postMessage({ type: 'setFlag', key: 'cafeWarm', on: next });
      bottomDrawer.repaintMode('awake');
    },
    undefined,
    'switch'
  );
  if (!enabled) row.setAttribute('aria-disabled', 'true');
  row.dataset.key = 'awake:warm';
  explain(
    row,
    'Keep the Mac awake with no session working, so pings arrive before the cache expires. This stops when Warm goes off.'
  );
  return row;
}

function configuration(): HTMLElement[] {
  const head = sheetParts.columnHead('awake:config-title', 'Configuration');
  const rows = awakeRows.awakeConfig().map((figure) => {
    const row = el('div', 'awake-cfg');
    row.dataset.key = `awake:cfg:${figure.label}`;
    const label = el('span', 'label', figure.label);
    label.append(why(figure.detail));
    row.append(label, el('span', 'val', figure.value));
    return row;
  });
  const note = el(
    'p',
    'awake-cfg-note',
    'You cannot change these values. Each window keeps the Mac awake for its own sessions. The Mac sleeps when no window does.'
  );
  note.dataset.key = 'awake:cfg-note';
  return [head, ...rows, note];
}

/** A secondary switch's explanation, kept out of the column: the tip for the
 *  pointer and focus, the description for a screen reader, which reads no tip. */
function explain(row: HTMLElement, text: string): void {
  row.dataset.tip = text;
  row.setAttribute('aria-description', text);
}
