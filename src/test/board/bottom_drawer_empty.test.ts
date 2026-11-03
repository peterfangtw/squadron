/**
 * A drawer mode that has nothing to show. The frame asks the open mode; the
 * hub asks every mode. Workflows is the mode that answers, with no rows.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openPanel, stateMessage, workflowView } from '../harness';

const groups = [groupView({ sessions: [cardView({ pid: 5, owned: true, startedAt: 5_000 })] })];
const ship = workflowView({ id: 'ship', label: 'PR & CI' });

describe('an empty drawer mode', () => {
  it('closes an open drawer and replaces that mode’s hub word', (t) => {
    const p = openPanel(t);
    const doc = p.window.document;
    p.push(stateMessage(groups, { workflows: [ship] }));
    doc.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
    const drawer = doc.getElementById('bottomdrawer');
    assert.equal(drawer?.hidden, false);
    assert.equal(doc.querySelector('#bottomhub .fpill'), null, 'a filled mode keeps its own word');

    p.push(stateMessage(groups, { workflows: [] }));
    assert.equal(drawer?.hidden, true, 'the open mode has nothing to show, so the drawer shuts');
    assert.equal(doc.querySelector('#bottomhub .wmore'), null, 'its hub word is gone');
    assert.equal(doc.querySelector('#bottomhub .fpill')?.textContent, '+ New workflow');
    assert.ok(doc.querySelector('#bottomhub .warm-tab'), 'a mode that is not empty keeps its word');

    p.push(stateMessage(groups, { workflows: [ship] }));
    doc.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
    doc.querySelector<HTMLElement>('#bottomhub .warm-tab')?.click();
    assert.equal(drawer?.hidden, false);
    p.push(stateMessage(groups, { workflows: [] }));
    assert.equal(drawer?.hidden, false, 'Warm is open, and it is not the empty mode');
    assert.equal(doc.querySelector('#bottomhub .fpill')?.textContent, '+ New workflow');
    assert.ok(doc.querySelector('#bottomhub .warm-tab'));
  });
});
