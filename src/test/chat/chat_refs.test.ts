/**
 * Session references in the composer: `@squadron[pid][path]` written into the
 * box becomes a chip named like the dock's pill, and the send carries the
 * reference whole. The box shows the chip's name (`composerShown`); its
 * delivery is the reference (`composerValue`).
 */

import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  answerSend,
  cardView,
  composerKey,
  composerPills,
  composerSelection,
  composerShown,
  composerValue,
  enter,
  groupView,
  openThread,
  stateMessage,
  threadView,
  typeIn,
  Panel
} from '../harness';

const ref = '@squadron[6085][/t/d6913539.jsonl]';

/** A thread whose board also carries the cards named in `peers`. */
function withCards(t: TestContext, peers: { pid: number; name: string }[]): Panel {
  const thread = threadView();
  const p = openThread(t, thread);
  const sessions = [
    cardView({ pid: thread.pid, startedAt: thread.startedAt }),
    ...peers.map((peer) => cardView(peer))
  ];
  p.push(stateMessage([groupView({ sessions })], { thread }));
  return p;
}

/** Write into the box with the caret at `caret`, as one edit. */
function write(p: Panel, value: string, caret = value.length): void {
  typeIn(p, value, caret);
}

const pills = (p: Panel): string[] => composerPills(p, 'ref').map((s) => s.textContent ?? '');

const sent = (p: Panel): string => (p.posted.at(-1) as { text: string }).text;

describe('a session reference in the composer', () => {
  it('becomes a pill named after its card', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    write(p, ref);
    assert.equal(composerShown(p), '@Lane rules');
    assert.deepEqual(pills(p), ['@Lane rules']);
  });

  it('says its pid when no card on this board has it', (t) => {
    const p = withCards(t, []);
    write(p, ref);
    assert.equal(composerShown(p), '@session 6085');
    assert.deepEqual(pills(p), ['@session 6085']);
  });

  it('sends the reference whole', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    write(p, `read ${ref} first`);
    enter(p);
    assert.equal(sent(p), `read ${ref} first`);
  });

  it('keeps two references to same-named cards apart', (t) => {
    const p = withCards(t, [
      { pid: 6085, name: 'Lane rules' },
      { pid: 6086, name: 'Lane rules' }
    ]);
    write(p, `${ref} and @squadron[6086][/t/b.jsonl]`);
    assert.equal(composerShown(p), '@Lane rules and @Lane rules');
    enter(p);
    assert.equal(sent(p), `${ref} and @squadron[6086][/t/b.jsonl]`);
  });

  it('waits for the closing bracket before it converts', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    const open = ref.slice(0, -1);
    write(p, open);
    assert.equal(composerValue(p), open, 'a half-typed reference was rewritten');
    write(p, ref);
    assert.equal(composerShown(p), '@Lane rules');
  });

  it('keeps the caret where the reader left it', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    const text = `ab ${ref} cd`;
    write(p, text, text.length);
    assert.equal(
      composerSelection(p).start,
      composerValue(p).length,
      'caret after the reference moved'
    );
    write(p, `ab ${ref} cd`, 1);
    assert.equal(composerSelection(p).start, 1, 'caret before the reference moved');
  });

  it('leaves the prose either side of it alone', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    write(p, `ask ${ref}, then report`);
    assert.equal(composerShown(p), 'ask @Lane rules, then report');
  });

  it('takes the whole pill on one Backspace just after it', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    write(p, ref);
    composerKey(p, 'Backspace', { cancelable: false });
    assert.equal(composerValue(p), '', 'backspace left part of the pill behind');
    assert.deepEqual(pills(p), []);
  });

  it('comes back working when a send is refused', (t) => {
    const p = withCards(t, [{ pid: 6085, name: 'Lane rules' }]);
    write(p, `ask ${ref}`);
    enter(p);
    answerSend(p, { ok: false, reason: 'nope' });
    assert.equal(composerShown(p), 'ask @Lane rules');
    enter(p);
    assert.equal(sent(p), `ask ${ref}`);
  });
});
