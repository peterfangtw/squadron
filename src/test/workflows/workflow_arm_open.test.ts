import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  newDraft,
  openPanel,
  stateMessage,
  threadView,
  workflowView,
  type Panel
} from '../harness';

/**
 * A New opens with nothing armed. A workflow reaches the draft when the reader
 * picks one. The non-owned case is the other half of the same slot: Attach is
 * hidden on a session this window does not drive.
 */

const WORKFLOWS = [
  workflowView({ id: 'ship', label: 'plan→build→review' }),
  workflowView({ id: 'spike', label: 'spike→report' })
];

const CWD = '/Users/someone/proj';

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

describe('opening a draft', () => {
  it('arms no workflow, however many the machine has', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: CWD, sessions: [] })], { workflows: WORKFLOWS }));
    newDraft(p, CWD);
    assert.equal($(p, '#wattach .wflow'), null);
    assert.ok($(p, '#wattach .fpill'), 'Attach door still empty-slot');
  });

  it('hides Attach on a session this window does not drive', (t) => {
    const p = openPanel(t);
    // Peer pipe: driven by another window — previously still drew Attach.
    const peer = cardView({ pid: 40, owned: undefined, startedAt: 2_000 });
    const thread = threadView({ pid: 40, owned: undefined, canSend: false });
    const board = [groupView({ cwd: CWD, sessions: [peer] })];
    p.push(stateMessage(board, { workflows: WORKFLOWS, thread }));
    $(p, '.card[data-pid="40"]')?.click();
    p.push(stateMessage(board, { workflows: WORKFLOWS, thread }));
    assert.equal($(p, '#wattach .wflow'), null);
    assert.equal($(p, '#wattach .fpill'), null, 'Attach door hidden for non-owned');
  });
});
