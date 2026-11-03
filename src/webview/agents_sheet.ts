/**
 * Agents on the drawer: the bar word's dot; on the left the agent switches
 * (`board_settings.ts` `agentSettings`), the master carrying its On/Off beside
 * its name; on the right every `squadron-*` verb off `core/verbs.ts`, read
 * only, the gated ones dimmed and the refusal shown while Orchestration is off.
 *
 * Paint only. The switches are the pushed flags; what the column says follows
 * `ui.state.orchestrators`, not a flip in flight. The frame's open and close
 * stay in `bottom_drawer.ts`.
 */

import * as verbs from '../core/verbs';
import { $, el, q } from './dom';
import { agentSettings } from './board_settings';
import { morph } from './kit';
import { ui } from './state';
import * as sheetParts from './sheet_parts';
import type { HubWord } from './bottom_drawer_modes';

export function agentsBar(): HubWord {
  return ui.state.orchestrators
    ? { tone: 'on', tip: 'Orchestration on' }
    : { tip: 'Orchestration off' };
}

export function paintAgentsSheet(): void {
  const on = ui.state.orchestrators;
  const body = $('bottomdrawer-body');
  morph(q(body, '.bdlist'), settings(on));
  morph(q(body, '.bddetail'), commands(on));
}

function settings(on: boolean): HTMLElement[] {
  const [master, ...rest] = agentSettings();
  if (!master) return [];
  master.classList.add('master');
  master.dataset.key = 'agents:orchestration';
  q(master, '.t').append(el('span', on ? 'state on' : 'state', on ? 'On' : 'Off'));
  return [sheetParts.columnHead('agents:settings-title', 'Settings'), master, ...rest];
}

function commands(on: boolean): HTMLElement[] {
  const always = verbs.VERBS.filter((v) => !v.write);
  const gated = verbs.VERBS.filter((v) => v.write);
  const head = sheetParts.columnHead('agents:commands-title', 'Commands');
  const available = on ? verbs.VERBS.length : always.length;
  head.append(el('span', 'summary', `${available} of ${verbs.VERBS.length} available`));
  const open = group('agents:always', 'Always', 'read only', always);
  const shut = group('agents:gated', 'With Orchestration', on ? 'on' : 'off', gated);
  shut.classList.add('gated');
  if (!on) {
    shut.classList.add('off');
    const refusal = el('p', 'refusal', 'An agent that runs one is refused: ');
    refusal.append(el('q', null, verbs.ORCHESTRATION_OFF));
    shut.append(refusal);
  }
  return [head, open, shut];
}

function group(key: string, title: string, when: string, rows: readonly verbs.Verb[]): HTMLElement {
  const box = el('div', 'group');
  box.dataset.key = key;
  const ghead = el('div', 'ghead', `${title} `);
  ghead.append(el('span', 'when', when));
  box.append(ghead);
  for (const verb of rows) {
    const row = el('div', 'verb');
    row.dataset.key = `${key}:${verb.name}`;
    row.append(el('code', null, verb.name), el('span', 'what', verb.what));
    box.append(row);
  }
  return box;
}
