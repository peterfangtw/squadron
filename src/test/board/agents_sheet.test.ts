import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openAgents,
  openPanel,
  openSettings,
  stateMessage,
  switchLabel,
  switchRow,
  switchedOn
} from '../harness';
import type { Panel } from '../harness';

/**
 * Agents: its word on the bottom hub, and the mode of the drawer that word
 * opens. The three switches arrive as the pushed flags `orchestrators`,
 * `skipPermissions` and `executionCapture`; the verb list is `core/verbs.ts`.
 * These scenarios hold what the word and the drawer draw from them and what a
 * press posts. Onboarding's own row is `onboarding.test.ts`.
 */

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

const word = (p: Panel): HTMLElement => {
  const node = $(p, '#bottomhub .agents-tab');
  assert.ok(node, 'no Agents word on the bottom hub');
  return node;
};
const dot = (p: Panel): HTMLElement => {
  const node = word(p).querySelector<HTMLElement>('.dot');
  assert.ok(node, 'the Agents word carries no dot');
  return node;
};

const board = () => [groupView({ sessions: [cardView({ pid: 1 })] })];
function push(p: Panel, orchestrators: boolean): void {
  p.push(stateMessage(board(), { orchestrators }));
}

const count = (drawer: HTMLElement): string | null | undefined =>
  drawer.querySelector('.bddetail .column-head .summary')?.textContent;
const gated = (drawer: HTMLElement): HTMLElement => {
  const node = drawer.querySelector<HTMLElement>('.bddetail .group.gated');
  assert.ok(node, 'no With Orchestration group');
  return node;
};
const verbs = (group: Element): string[] =>
  [...group.querySelectorAll('.verb code')].map((c) => c.textContent ?? '');
const REFUSAL = 'Session verbs are off. Turn on Orchestration in Agents on the hub.';

describe('Agents on the bottom hub', () => {
  it('is the live first word on the hub', (t) => {
    const p = openPanel(t);
    push(p, false);
    assert.equal(word(p).getAttribute('aria-disabled'), null);
    assert.equal(word(p).textContent, 'Agents');
    assert.equal($(p, '#bottomhub .interactions-tab'), null);
    const words = [...p.window.document.querySelectorAll('#bottomhub [data-drawer-mode]')].map(
      (b) => b.getAttribute('data-drawer-mode')
    );
    assert.deepEqual(words, ['agents', 'remote', 'warm', 'awake']);
  });

  it('lights its dot and says so while Orchestration is on', (t) => {
    const p = openPanel(t);
    push(p, false);
    assert.equal(dot(p).className, 'dot');
    assert.equal(word(p).dataset.tip, 'Orchestration off');
    push(p, true);
    assert.equal(dot(p).className, 'dot on');
    assert.equal(word(p).dataset.tip, 'Orchestration on');
    push(p, false);
    assert.equal(dot(p).className, 'dot');
  });

  it('opens its own mode of the drawer, titled and noted', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    assert.ok(drawer.classList.contains('agents'));
    assert.ok(drawer.classList.contains('columns'));
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Agents');
    assert.equal(
      $(p, '#bottomdrawer-note')?.textContent,
      'What sessions may do to each other, and how new ones start.'
    );
    assert.equal(word(p).getAttribute('aria-expanded'), 'true');
  });

  it('returns the focus to the word when the drawer shuts', (t) => {
    const p = openPanel(t);
    push(p, false);
    openAgents(p);
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.ok($(p, '#bottomdrawer')?.hidden);
    assert.equal(p.window.document.activeElement, word(p));
  });
});

describe('the Agents drawer’s settings', () => {
  it('draws the three switches under a Settings head', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    assert.equal(
      drawer.querySelector('.bdlist .column-head .column-title')?.textContent,
      'Settings'
    );
    assert.deepEqual([...drawer.querySelectorAll('.bdlist [role="switch"]')].map(switchLabel), [
      'Orchestration',
      'Skip permissions',
      'Execution capture'
    ]);
  });

  it('carries the master’s state beside its name, and its new words', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    const row = switchRow(drawer, 'Orchestration');
    assert.ok(row.classList.contains('master'));
    assert.equal(row.querySelector('.t .state')?.textContent, 'Off');
    assert.equal(
      row.querySelector('.d')?.textContent,
      'Let sessions act on each other: message, start, end, rename and warm them. Machine-wide.'
    );
    push(p, true);
    assert.equal(switchRow(drawer, 'Orchestration').querySelector('.t .state')?.textContent, 'On');
    assert.equal(switchedOn(switchRow(drawer, 'Orchestration')), true);
  });
});

describe('the Agents drawer’s commands', () => {
  it('lists every verb under Always or With Orchestration', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    assert.equal(
      drawer.querySelector('.bddetail .column-head .column-title')?.textContent,
      'Commands'
    );
    const always = drawer.querySelector('.bddetail .group:not(.gated)');
    assert.ok(always, 'no Always group');
    assert.match(always.querySelector('.ghead')?.textContent ?? '', /^Always/);
    assert.deepEqual(verbs(always), ['list', 'models']);
    assert.match(gated(drawer).querySelector('.ghead')?.textContent ?? '', /^With Orchestration/);
    assert.deepEqual(verbs(gated(drawer)), [
      'send',
      'answer',
      'spawn',
      'end',
      'rename',
      'warm',
      'wait',
      'step',
      'attach',
      'fetch-file'
    ]);
    assert.equal(
      always.querySelector('.verb .what')?.textContent,
      'See every session on this machine, its status and transcript.'
    );
  });

  it('dims the gated group and shows the refusal while Orchestration is off', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    assert.equal(count(drawer), '2 of 12 available');
    assert.ok(gated(drawer).classList.contains('off'));
    const refusal = gated(drawer).querySelector('.refusal');
    assert.ok(refusal, 'no refusal line while off');
    assert.match(refusal.textContent ?? '', new RegExp(REFUSAL.replace(/\./g, '\\.')));
  });

  it('lifts the dimming and the refusal once a push says it is on', (t) => {
    const p = openPanel(t);
    push(p, false);
    const drawer = openAgents(p);
    push(p, true);
    assert.equal(count(drawer), '12 of 12 available');
    assert.ok(!gated(drawer).classList.contains('off'));
    assert.equal(gated(drawer).querySelector('.refusal'), null);
    push(p, false);
    assert.equal(count(drawer), '2 of 12 available');
  });
});

describe('the settings dialog after Agents moved out', () => {
  it('has no Agents tab and no agent switch', (t) => {
    const p = openPanel(t);
    push(p, false);
    const dialog = openSettings(p);
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
    assert.ok(!tabs.includes('Agents'), `tabs: ${tabs.join(', ')}`);
    assert.equal(dialog.querySelector('#settings-agents'), null);
    const labels = [...dialog.querySelectorAll('.mrow')].map(switchLabel);
    for (const gone of ['Orchestration', 'Skip permissions', 'Execution capture'])
      assert.ok(!labels.includes(gone), `${gone} is still in the settings dialog`);
  });
});
