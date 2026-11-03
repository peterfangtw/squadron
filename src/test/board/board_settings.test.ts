import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  groupView,
  openAgents,
  openPanel,
  openSettings,
  stateMessage,
  switchLabel,
  switchRow,
  switchedOn
} from '../harness';

describe('the Orchestration toggle', () => {
  it('reflects the current state and posts setFlag on click', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { orchestrators: false }));
    const row = switchRow(openAgents(p), 'Orchestration');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'orchestrators', on: true }]);

    p.push(stateMessage([groupView()], { orchestrators: true }));
    assert.equal(switchedOn(switchRow(openAgents(p), 'Orchestration')), true);
  });

  // The host's echo lands a refresh later. A switch that only moved on the
  // next repaint would sit there looking broken.
  it('flips the switch on the click, before the host has answered', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { orchestrators: false }));
    const row = switchRow(openAgents(p), 'Orchestration');
    row.click();
    assert.equal(switchedOn(row), true);
  });

  it('separates general controls from the agent controls the Agents drawer holds', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const dialog = openSettings(p);
    const labels = (id: string): (string | null | undefined)[] =>
      [...dialog.querySelectorAll(`#settings-${id} .mrow`)].map(switchLabel);
    assert.deepEqual(labels('general'), ['Sound', 'Dev servers', 'Mascot']);
    assert.equal(dialog.querySelector('#settings-agents'), null);
    assert.deepEqual(labels('model'), ['Default model']);
    assert.deepEqual([...openAgents(p).querySelectorAll('.bdlist .mrow')].map(switchLabel), [
      'Orchestration',
      'Skip permissions',
      'Execution capture'
    ]);
  });
});

describe('the skip permissions toggle', () => {
  it('reflects the current state and posts setFlag on click', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { skipPermissions: false }));
    const row = switchRow(openAgents(p), 'Skip permissions');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'skipPermissions', on: true }]);

    p.push(stateMessage([groupView()], { skipPermissions: true }));
    assert.equal(switchedOn(switchRow(openAgents(p), 'Skip permissions')), true);
  });

  // The one thing a reader could get wrong: that turning this on disarms the
  // sessions already on the board. It is a launch argument, so it cannot.
  it('says the flag applies to new sessions, not the ones running', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const row = switchRow(openAgents(p), 'Skip permissions');
    assert.match(row.textContent ?? '', /New sessions/);
  });
});

describe('the execution capture toggle', () => {
  it('reflects the current state and posts setFlag on click', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { executionCapture: false }));
    const row = switchRow(openAgents(p), 'Execution capture');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'executionCapture', on: true }]);

    p.push(stateMessage([groupView()], { executionCapture: true }));
    assert.equal(switchedOn(switchRow(openAgents(p), 'Execution capture')), true);
  });

  it('says on applies to new sessions and off stops sessions already running', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const row = switchRow(openAgents(p), 'Execution capture');
    assert.match(row.textContent ?? '', /New sessions/);
    assert.match(row.textContent ?? '', /already running/);
  });

  it('carries its own beta tag, beside the label', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const row = switchRow(openAgents(p), 'Execution capture');
    assert.equal(row.querySelector('.t .tag')?.textContent, 'beta');
  });
});

describe('the dev servers toggle', () => {
  it('reflects the current state and posts setFlag on click', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { devServers: false }));
    const row = switchRow(openSettings(p), 'Dev servers');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'devServers', on: true }]);

    p.push(stateMessage([groupView()], { devServers: true }));
    assert.equal(switchedOn(switchRow(openSettings(p), 'Dev servers')), true);
  });

  // The whole reason it moved behind the gear: it is not finished, and the row
  // has to say so where the switch is rather than in a release note nobody
  // reads.
  it('carries its own beta tag, beside the label', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const row = switchRow(openSettings(p), 'Dev servers');
    assert.equal(row.querySelector('.t .tag')?.textContent, 'beta');
  });
});

describe('the mascot toggle', () => {
  it('reflects the current state and posts setFlag on click', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { mascot: false }));
    const row = switchRow(openSettings(p), 'Mascot');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'mascot', on: true }]);

    p.push(stateMessage([groupView()], { mascot: true }));
    assert.equal(switchedOn(switchRow(openSettings(p), 'Mascot')), true);
  });

  it('carries its own beta tag, beside the label', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const row = switchRow(openSettings(p), 'Mascot');
    assert.equal(row.querySelector('.t .tag')?.textContent, 'beta');
  });
});
