/**
 * Warm on the bottom drawer: the bar's count, and the two columns behind it.
 * One switch per session in this window, the default for sessions not started
 * yet pinned under that list, and the cache table read beside them.
 *
 * Paint only. Whether a ping is due or held arrives decided on `CardView.warm`.
 * A session row's status is `ui/warm_rows.ts`; the empty line and the
 * configuration labels are written here. The frame's open and close stay in
 * `bottom_drawer.ts`.
 */

import * as warmRows from '../ui/warm_rows';
import * as accounts from './accounts';
import { $, el, q } from './dom';
import * as holds from './holds';
import { morph, switchRow } from './kit';
import { numInput } from './num_input';
import { ui, vscode } from './state';
import { why } from './tip';
import * as sheetParts from './sheet_parts';
import type { HubWord } from './bottom_drawer_modes';
import * as bottomDrawer from './bottom_drawer';
import * as warmChoice from './warm_choice';
import { repaintBoard } from './board_repaint';

/** Figures committed and not yet pushed back, by wire key: a push composed
 *  before the settings write landed would put the old figure back in the
 *  field the reader just left. */
const figureHolds = holds.add<string, number>(
  (key) => figures().find((figure) => figure.key === key)?.minutes
);
/** What the open columns last painted, so the 1s beat writes only when a
 *  countdown has moved. A press or a commit clears it: the control moved
 *  under the paint, and a flip dropped back to the pushed value would
 *  otherwise match it. */
let warmSig = '';
/** The configuration morph skipped a focused field's row, so `warmSig` names
 *  a paint that row never took. The next paint after focus leaves writes it. */
let configDeferred = false;

/** The host's answer to `setWarm`: one without `on` is a refusal and drops
 *  the flip; one with it leaves the flip until a push agrees. */
export function settleWarm(msg: { pid: number; startedAt: number; on?: boolean }): void {
  warmChoice.settle(msg);
  bottomDrawer.repaintMode('warm');
  repaintBoard();
}

/** The host's answer to `setWarmSetting`, as `settleWarm` reads its own. */
export function settleFigure(msg: { key: string; minutes: number; landed: boolean }): void {
  if (!msg.landed) figureHolds.drop(msg.key, msg.minutes);
  bottomDrawer.repaintMode('warm');
}

export function warmBar(): HubWord {
  const tally = warmRows.warmTally(optimisticCards(), Date.now());
  return { count: tally.count, rows: tally.rows };
}

export function warmNote(): string {
  return warmRows.warmNote(ui.state.warmConfig.window.minutes * 60_000);
}

type RowPlan = {
  key: string;
  pid: number;
  startedAt: number;
  name: string;
  on: boolean;
  row: warmRows.WarmRow;
};
type GroupPlan = { key: string; label: string; rows: RowPlan[] };

export function paintWarmSheet(): void {
  const now = Date.now();
  const groups = plan(now);
  const defaultOn = holds.flags.shown('warmCache', ui.state.warmCache);
  const config = ui.state.warmConfig;
  const sig = JSON.stringify([groups, defaultOn, config, [...figureHolds.held()]]);
  const list = q($('bottomdrawer-body'), '.bdlist');
  if (sig === warmSig && !configDeferred && list.querySelector('.sessions')) {
    paintTally();
    return;
  }
  warmSig = sig;

  const head = sheetParts.columnHead('warm-sessions-title', 'Sessions in this window');
  head.append(el('span', 'summary'));
  const scroller = el('div', 'sessions');
  scroller.dataset.key = 'warm-sessions';
  const listed = groups.filter((group) => group.rows.length);
  if (!listed.length) {
    const none = el('div', 'fnone', 'No sessions in this window yet.');
    none.dataset.key = 'warm-none';
    scroller.append(none);
  }
  for (const group of listed) {
    // The board's own grouping, said only where there is more than one.
    if (listed.length > 1) {
      const dir = el('div', 'mhead dir', group.label);
      dir.dataset.key = group.key;
      scroller.append(dir);
    }
    scroller.append(...group.rows.map(sessionRow));
  }
  morph(list, [head, scroller, defaultRow(defaultOn)]);
  // A field being typed in keeps its draft: the morph would copy the pushed
  // value over it.
  configDeferred = false;
  morph(q($('bottomdrawer-body'), '.bddetail'), configuration(config), (from) => {
    if (!from.contains(document.activeElement)) return true;
    configDeferred = true;
    return false;
  });
  paintTally();
}

function paintTally(): void {
  const summary = $('bottomdrawer-body').querySelector<HTMLElement>(
    '.bdlist .column-head .summary'
  );
  if (!summary) return;
  const cards = optimisticCards();
  const tally = warmRows.warmTally(cards, Date.now());
  const listed = cards.filter((card) => card.warm).length;
  const text = listed === 0 ? '' : `${tally.count} of ${listed} kept warm`;
  if (summary.textContent !== text) summary.textContent = text;
}

function configuration(config: WarmConfigView): HTMLElement[] {
  const title = sheetParts.columnHead('warm-config-title', 'Configuration');
  const fields = config.ttl.map((row) => {
    const label = el('span', 'label');
    label.append(
      accounts.brandMark(row.brand),
      document.createTextNode(`${row.name} TTL`),
      why(row.tip)
    );
    return figureRow('warm-ttl:' + row.name, label, `${row.name} TTL`, row);
  });
  const explanation = `Before cache expiry. Each ping runs ${config.buffer.minutes} minutes before the TTL ends.`;
  const bufferLabel = el('span', 'label', 'Ping buffer');
  bufferLabel.append(why(explanation));
  const buffer = figureRow('warm-buffer', bufferLabel, 'Ping buffer', config.buffer, '\u2212');
  buffer.classList.add('buffer');
  const windowLabel = el('span', 'label', 'Keep warm for');
  windowLabel.append(why('Pings stop this long after the last real turn.'));
  const window = figureRow('warm-window', windowLabel, 'Keep warm for', config.window);
  window.classList.add('window');
  return [title, ...fields, buffer, window];
}

/** One figure: its name, and the field that edits it in minutes. */
function figureRow(
  key: string,
  label: HTMLElement,
  name: string,
  figure: WarmFigureView,
  sign = ''
): HTMLElement {
  const row = el('div', 'ttl-field');
  row.dataset.key = key;
  const input = numInput({
    value: figureHolds.shown(figure.key, figure.minutes),
    min: figure.min,
    max: figure.max,
    label: name,
    onCommit: (minutes) => {
      figureHolds.hold(figure.key, minutes);
      warmSig = '';
      vscode.postMessage({ type: 'setWarmSetting', key: figure.key, minutes });
    }
  });
  // After numInput's own blur, which commits or reverts the draft first.
  input.addEventListener('blur', () => {
    if (configDeferred) bottomDrawer.repaintMode('warm');
  });
  const minutes = el('span', 'minutes', sign);
  minutes.append(input, el('span', 'unit', 'min'));
  row.append(label, minutes);
  return row;
}

function plan(now: number): GroupPlan[] {
  return ui.state.groups.map((group) => ({
    key: 'warm-dir:' + group.cwd,
    label: group.label,
    rows: group.sessions.flatMap((card) => {
      if (!card.warm) return [];
      const key = warmChoice.key(card);
      return [
        {
          key,
          pid: card.pid,
          startedAt: card.startedAt,
          name: card.name,
          on: warmChoice.shown(card),
          // The clause is the host's. The switch alone moves ahead of the echo.
          row: warmRows.warmRow(card, card.warm, now)
        }
      ];
    })
  }));
}

function sessionRow(r: RowPlan): HTMLElement {
  const detail = el('span', 'd');
  if (r.row.ttl !== undefined) {
    detail.append(el('span', 'ttl', r.row.ttl), ` · ${r.row.source} · `);
  }
  detail.append(el('span', 'st ' + r.row.clause.tone, r.row.clause.text));
  const row = switchRow(
    r.name,
    detail,
    r.on,
    (on) => {
      warmChoice.set(r, on);
      warmSig = '';
      bottomDrawer.repaintMode('warm');
      repaintBoard();
    },
    undefined,
    'switch'
  );
  if (r.row.refused) row.setAttribute('aria-disabled', 'true');
  row.dataset.key = r.key;
  return row;
}

function defaultRow(on: boolean): HTMLElement {
  const row = switchRow(
    'New sessions',
    'Start each new session kept warm. A choice made above stays.',
    on,
    (next) => {
      holds.flags.hold('warmCache', next);
      warmSig = '';
      vscode.postMessage({ type: 'setFlag', key: 'warmCache', on: next });
    },
    'beta',
    'switch'
  );
  row.dataset.key = 'warm:default';
  return row;
}

function figures(): WarmFigureView[] {
  const { ttl, buffer, window } = ui.state.warmConfig;
  return [...ttl, buffer, window];
}

/** Board cards with a flip the host has not echoed yet, so the count matches
 *  the switches. `warmTally` still counts the ons it is given. */
function optimisticCards(): CardView[] {
  return listedCards().map((card) => {
    if (!card.warm) return card;
    const on = warmChoice.shown(card);
    return on === card.warm.on ? card : { ...card, warm: { ...card.warm, on } };
  });
}

function listedCards(): CardView[] {
  return ui.state.groups.flatMap((group) => group.sessions);
}
