import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as harness from '../harness';

it('keeps overflow chip actions and status current across pushes, and returns focus to More', (t) => {
  const p = harness.openPanel(t);
  const doc = p.window.document;
  let boardWidth = 360;
  let boardHeight = 600;
  p.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const width =
      this.id === 'board'
        ? boardWidth
        : this.closest('#bottomhub') && this.tagName === 'BUTTON'
          ? 90
          : 0;
    return {
      x: 0,
      y: 0,
      width,
      height: this.id === 'board' ? boardHeight : 0,
      left: 0,
      right: width,
      top: 0,
      bottom: 0,
      toJSON: () => ({})
    };
  };
  const state = harness.stateMessage([]);
  state.workflows = [harness.workflowView()];
  p.push(state);
  const more = doc.querySelector<HTMLButtonElement>('#bottomhub-more');
  assert.ok(more, 'narrow board offers More');
  const stack = doc.getElementById('bottomhub-overflow');
  assert.ok(stack);
  const remote = doc.querySelector<HTMLButtonElement>('#bottomhub .remote-tab');
  assert.ok(remote);
  more.click();
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(stack.hidden, false);
  state.remote = harness.remoteStateView({ tone: 'fault' });
  state.groups = [
    harness.groupView({
      sessions: [harness.cardView({ warm: { on: true, ttlMs: 3_600_000, source: 'measured' } })]
    })
  ];
  p.push(state);
  assert.equal(more.getAttribute('aria-expanded'), 'true', 'status updates do not close the stack');
  assert.ok(more.querySelector('.dot.fault'), 'More reports a hidden service fault');
  assert.equal(doc.querySelector('#bottomhub .warm-tab .num')?.textContent, '1');
  assert.equal(doc.querySelector('#bottomhub .remote-tab'), remote, 'keeps the original action');
  remote.click();
  assert.equal(doc.querySelector('#bottomdrawer-head .ttl')?.textContent, 'Remote');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.activeElement, more, 'closed overflow cannot receive return focus');
  more.click();
  doc.body.click();
  assert.equal(stack.hidden, true);
  more.click();
  doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(stack.hidden, true);
  assert.equal(doc.activeElement, more);
  boardWidth = 400;
  p.push(state);
  assert.equal(doc.activeElement, more, 'resize preserves focus on More');
  more.click();
  boardHeight = 300;
  p.push(state);
  assert.equal(stack.hidden, true, 'height-only resize closes the stack');
  more.focus();
  boardWidth = 900;
  p.push(state);
  assert.equal(more.hidden, true);
  assert.equal(
    doc.activeElement,
    doc.querySelector('#bottomhub .wmore'),
    'wide row receives focus when More disappears'
  );
});
