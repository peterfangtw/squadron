import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownedDiscoveryKey } from '../../ui/state';
import { session } from '../views_helpers';
import {
  newDraft,
  askRequest,
  cardView,
  groupView,
  openPanel,
  stateMessage,
  threadView
} from '../harness';

// These exercise the wire/DOM boundary: a thread push must not repaint board
// surfaces or acknowledge a different selection, even across A → B → A.
it('activity alone does not invalidate discovery; structural owned facts and generation do', () => {
  const base = session({ status: 'busy', updatedAt: 10 });
  const key = ownedDiscoveryKey([base], [1]);
  assert.equal(ownedDiscoveryKey([{ ...base, updatedAt: 20 }], [1]), key);
  for (const change of [
    { status: 'waiting' as const },
    { name: 'Renamed' },
    { model: 'new model' },
    { activeTool: 'Write' },
    { contextPct: 12 },
    { sessionId: 'new conversation' },
    { warm: true },
    { pid: 200 }
  ]) {
    assert.notEqual(ownedDiscoveryKey([{ ...base, ...change }], [1]), key);
  }
  assert.notEqual(ownedDiscoveryKey([base], [2]), key);
  assert.notEqual(ownedDiscoveryKey([], []), key);
});

describe('independent selected transcript publication', () => {
  it('grows the selected thread without repainting the board and keeps it across board-only pushes', (t) => {
    const p = openPanel(t);
    const thread = threadView();
    const groups = [groupView({ sessions: [cardView()] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    const select = [...p.posted].reverse().find((msg) => msg.type === 'select');
    assert.ok(select?.type === 'select');
    const board = p.window.document.querySelector('#cards')!;
    const before = board.innerHTML;
    const updates: MutationRecord[] = [];
    const watcher = new p.window.MutationObserver((rows) => updates.push(...rows));
    watcher.observe(board, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
    p.push({
      type: 'thread',
      selection: select.selection,
      generation: 1,
      sequence: 1,
      thread: {
        ...thread,
        exchanges: [{ role: 'assistant', text: 'First', blocks: [{ html: '<p>First</p>' }] }]
      }
    });
    assert.equal(p.window.document.querySelector('#thread .body')?.textContent, 'First');
    assert.equal(board.innerHTML, before);
    assert.equal(watcher.takeRecords().length, 0, 'no board DOM work from a transcript push');
    watcher.disconnect();
    p.push(stateMessage(groups));
    assert.equal(p.window.document.querySelector('#thread .body')?.textContent, 'First');
  });

  it('rejects stale selection, incarnation, generation and publication order', (t) => {
    const p = openPanel(t);
    const thread = threadView();
    p.push(stateMessage([groupView({ sessions: [cardView(), cardView({ pid: 202 })] })]));
    const choose = (pid: number): string => {
      p.window.document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`)?.click();
      const select = [...p.posted].reverse().find((msg) => msg.type === 'select');
      assert.ok(select?.type === 'select');
      return select.selection;
    };
    const old = choose(thread.pid);
    choose(202);
    const selection = choose(thread.pid);
    const push = (
      text: string,
      generation: number,
      sequence: number,
      picked = selection,
      startedAt = thread.startedAt
    ): void => {
      p.push({
        type: 'thread',
        selection: picked,
        generation,
        sequence,
        thread: {
          ...thread,
          startedAt,
          exchanges: [{ role: 'assistant', text, blocks: [{ html: `<p>${text}</p>` }] }]
        }
      });
    };
    push('Current', 2, 4);
    for (const send of [
      () => push('Old selection', 2, 5, old),
      () => push('Old generation', 1, 6),
      () => push('Old read', 2, 3),
      () => push('Old process', 2, 7, selection, thread.startedAt - 60_000)
    ]) {
      send();
      assert.equal(p.window.document.querySelector('#thread .body')?.textContent, 'Current');
    }
    push('Newest', 3, 8);
    assert.equal(p.window.document.querySelector('#thread .body')?.textContent, 'Newest');
  });
  it('retains outbox and question behavior, rejecting stale control snapshots before rendering', (t) => {
    const p = openPanel(t);
    const thread = threadView({ status: 'busy' });
    const groups = [groupView({ sessions: [cardView()] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    const select = [...p.posted].reverse().find((msg) => msg.type === 'select');
    assert.ok(select?.type === 'select');
    const publish = (sequence: number, over: Partial<ThreadView>): void =>
      p.push({
        type: 'thread',
        selection: select.selection,
        generation: 1,
        sequence,
        thread: { ...thread, ...over }
      });
    const row = { id: 'q', text: 'Next message' };
    publish(1, { queued: [row], pending: [askRequest()] });
    assert.ok(p.window.document.querySelector('#question .qblock'));
    assert.equal(p.window.document.querySelectorAll('#thread .turn.queued').length, 1);
    publish(2, { sending: [row] });
    assert.equal(p.window.document.querySelector('#thread .turn.queued'), null);
    assert.equal(p.window.document.querySelector('#question .qblock'), null);
    publish(3, { exchanges: [{ role: 'user', text: row.text, blocks: [{ prose: row.text }] }] });
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 1);
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    publish(1, { queued: [row], pending: [askRequest()] });
    p.push(
      stateMessage(groups, {
        thread: { ...thread, pending: [askRequest()] },
        threadPublication: { selection: select.selection, generation: 1, sequence: 2 }
      })
    );
    p.push(stateMessage(groups, { thread: { ...thread, pending: [askRequest()] } }));
    assert.equal(p.window.document.querySelector('#question .qblock'), null);
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 1);
    newDraft(p);
    publish(4, { pending: [askRequest()] });
    assert.equal(p.window.document.querySelector('#question .qblock'), null);
  });
});
