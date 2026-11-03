import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  stateMessage,
  threadView,
  importComposer,
  composerKey,
  askRequest
} from '../harness';

const turn = (text: string): ExchangeView => ({
  role: 'assistant',
  text,
  blocks: [{ prose: text }]
});

it('applies revisioned splices, requests one recovery per gap, and re-arms after full recovery', (t) => {
  const p = openPanel(t);
  p.push(stateMessage([groupView({ sessions: [cardView()] })]));
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  const selected = [...p.posted].reverse().find((msg) => msg.type === 'select');
  assert.ok(selected?.type === 'select');
  const thread = threadView({ exchanges: [turn('old'), turn('tail')] });
  p.push({
    type: 'thread',
    selection: selected.selection,
    generation: 0,
    sequence: 1,
    revision: 10,
    thread
  });
  const patch: ThreadPatchMessage = {
    type: 'threadPatch',
    selection: selected.selection,
    generation: 0,
    sequence: 2,
    pid: thread.pid,
    startedAt: thread.startedAt,
    base: 10,
    revision: 11,
    changes: {},
    unset: [],
    splice: { at: 1, remove: 1, exchanges: [turn('new')] }
  };
  const first = p.window.document.querySelector('#thread .turn');
  p.push(patch);
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /new/);
  assert.equal(p.window.document.querySelector('#thread .turn'), first);
  p.push({ ...patch, sequence: 3, base: 12, revision: 13 });
  p.push({ ...patch, sequence: 4, base: 13, revision: 14 });
  assert.equal(p.posted.filter((msg) => msg.type === 'threadSync').length, 1);
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /new/);
  p.push({
    type: 'thread',
    selection: selected.selection,
    generation: 0,
    sequence: 5,
    revision: 20,
    thread: { ...thread, exchanges: [turn('recovered')] }
  });
  p.push({
    ...patch,
    sequence: 6,
    base: 20,
    revision: 21,
    splice: { at: 1, remove: 0, exchanges: [turn('after recovery')] }
  });
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /after recovery/);
  p.push({ ...patch, selection: 'obsolete', sequence: 7, base: 99 });
  assert.equal(p.posted.filter((msg) => msg.type === 'threadSync').length, 1);
  p.push({ ...patch, sequence: 8, base: 30, revision: 31 });
  assert.equal(p.posted.filter((msg) => msg.type === 'threadSync').length, 2);
});

it('offers one full-history action only when older messages are hidden', (t) => {
  const p = openPanel(t);
  p.push(stateMessage([groupView({ sessions: [cardView()] })]));
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  const selected = [...p.posted].reverse().find((msg) => msg.type === 'select');
  assert.ok(selected?.type === 'select');
  const thread = threadView({ exchanges: [turn('latest')] });
  const push = (value: ThreadView, sequence: number): void =>
    p.push({
      type: 'thread',
      selection: selected.selection,
      generation: 2,
      sequence,
      revision: sequence,
      thread: value
    });
  push(thread, 1);
  assert.equal(p.window.document.querySelector('.history-nav'), null);
  push({ ...thread, historyAvailable: true }, 2);
  const buttons = p.window.document.querySelectorAll<HTMLButtonElement>('.history-nav button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]?.textContent, 'Browse full chat history');
  buttons[0]?.click();
  assert.deepEqual(p.posted.at(-1), {
    type: 'threadHistory',
    pid: thread.pid,
    startedAt: thread.startedAt,
    selection: selected.selection,
    generation: 2,
    full: true
  });
  push(
    {
      ...thread,
      historyAvailable: true,
      fullHistory: { exchanges: [turn('oldest'), turn('latest')] }
    },
    3
  );
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /oldest/);
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /latest/);
  assert.equal(p.window.document.querySelectorAll('.history-nav button').length, 1);
  const back = p.window.document.querySelector<HTMLButtonElement>('.history-nav button');
  assert.equal(back?.textContent, 'Back to recent chat');
  back?.click();
  assert.deepEqual(p.posted.at(-1), {
    type: 'threadHistory',
    pid: thread.pid,
    startedAt: thread.startedAt,
    selection: selected.selection,
    generation: 2,
    full: false
  });
  push(thread, 4);
  assert.equal(p.window.document.querySelector('.history-nav'), null);
  assert.doesNotMatch(p.window.document.querySelector('#thread')?.textContent ?? '', /oldest/);
});

it('keeps echo multiplicity and new questions current while older recorded turns are displayed', (t) => {
  const p = openPanel(t);
  p.push(stateMessage([groupView({ sessions: [cardView()] })]));
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  const selected = [...p.posted].reverse().find((msg) => msg.type === 'select');
  assert.ok(selected?.type === 'select');
  const thread = threadView({
    status: 'busy',
    exchanges: [turn('current tail')],
    echoEvidence: [{ text: 'again' }],
    fullHistory: { exchanges: [turn('old recorded turn')] }
  });
  p.push({
    type: 'thread',
    selection: selected.selection,
    generation: 0,
    sequence: 1,
    revision: 1,
    thread
  });
  importComposer(p, 'again');
  composerKey(p, 'Enter');
  assert.ok(p.window.document.querySelector('#thread .turn.sending'));
  p.push({
    type: 'thread',
    selection: selected.selection,
    generation: 0,
    sequence: 2,
    revision: 2,
    thread: {
      ...thread,
      echoEvidence: [{ text: 'again' }, { text: 'again' }],
      pending: [askRequest()]
    }
  });
  assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
  assert.match(p.window.document.querySelector('#thread')?.textContent ?? '', /old recorded turn/);
  assert.ok(p.window.document.querySelector('#ask')?.textContent?.trim());
});
