import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openThread, stateMessage, threadView, Panel } from '../harness';

describe('time in the thread', () => {
  /**
   * Noon today, so every offset below lands on a day this test can name: an
   * hour either side of midnight would make "Today" a fact about when the
   * suite ran.
   */
  const noon = new Date().setHours(12, 0, 0, 0);

  const said = (at: number, text = 'hi'): ExchangeView => ({
    role: 'user',
    text,
    blocks: [{ prose: text }],
    at
  });

  const gaps = (p: Panel): string[] =>
    [...p.window.document.querySelectorAll('#thread .gap')].map((g) => g.textContent ?? '');

  it('breaks the thread where the conversation stopped, and nowhere else', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [said(noon - 3 * 3_600_000), said(noon - 3 * 3_600_000 + 60_000), said(noon)]
      })
    );
    assert.deepEqual(gaps(p), [
      `Today ${new Date(noon).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    ]);
  });

  /** The threshold itself, which the cases either side of it left free to move:
   *  a minute under is the same conversation, the quarter hour exactly is not. */
  it('breaks at a quarter of an hour and not a minute before', (t) => {
    const apart = (ms: number): string[] =>
      gaps(openThread(t, threadView({ exchanges: [said(noon - ms), said(noon)] })));
    assert.deepEqual(apart(14 * 60_000), []);
    assert.equal(apart(15 * 60_000).length, 1);
  });

  it('breaks on a new day however short the gap was', (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [said(noon - 13 * 3_600_000), said(noon - 12 * 3_600_000)] })
    );
    // 23:00 to midnight-plus-an-hour: an hour apart, and not the same work.
    assert.equal(gaps(p).length, 1);
    assert.match(gaps(p)[0] ?? '', /^(Today|Yesterday) /);
  });

  /** The stamp is the key, so the 3s repaint has to leave the divider alone —
   *  a key read off the clock would rebuild it under the reader every push. */
  it('keeps the same divider across a repaint', (t) => {
    const thread = threadView({ exchanges: [said(noon - 3_600_000), said(noon)] });
    const p = openThread(t, thread);
    const first = p.window.document.querySelector('#thread .gap');
    p.push(stateMessage([groupView({ sessions: [cardView()] })], { thread }));
    assert.equal(p.window.document.querySelector('#thread .gap'), first);
  });

  /** A skill chip and an interrupt are things that happened to the
   *  conversation, not turns, and carry no stamp of their own. Measuring to one
   *  would lose the gap they sit in. */
  it('measures across a marker, which has no time of its own', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [said(noon - 3_600_000), { mark: 'break' }, said(noon)]
      })
    );
    assert.equal(gaps(p).length, 1);
  });

  it('stands the divider ahead of a fold at the same turn', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [said(noon - 3_600_000), said(noon), said(noon + 60_000)],
        folds: [{ at: 1, hides: [1], key: 'f|1' }]
      })
    );
    const rows = [...p.window.document.querySelectorAll('#thread > *')].map((r) => r.className);
    assert.deepEqual(rows.slice(1, 3), ['gap', 'fold']);
  });

  it('never opens the thread with a divider', (t) => {
    const p = openThread(t, threadView({ exchanges: [said(noon)] }));
    assert.deepEqual(gaps(p), []);
  });

  /** The other half of the divider: the divider says where the conversation
   *  stopped, and this says when one particular turn was. Hidden at rest by
   *  CSS, which is why the assertion is on the text and not on what is seen. */
  const clocks = (p: Panel): string[] =>
    [...p.window.document.querySelectorAll('#thread .turn .who .at')].map(
      (a) => a.textContent ?? ''
    );

  const clockOf = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  it('stamps every turn with its own clock reading', (t) => {
    const p = openThread(t, threadView({ exchanges: [said(noon - 3_600_000), said(noon)] }));
    assert.deepEqual(clocks(p), [clockOf(noon - 3_600_000), clockOf(noon)]);
  });

  /** H23's rule, applied to the one site added after it: an explanation the
   *  panel writes draws as the panel's tip, never as the host's `title`. */
  it('hangs the full date off our own tip rather than a title', (t) => {
    const p = openThread(t, threadView({ exchanges: [said(noon)] }));
    const stamp = p.window.document.querySelector<HTMLElement>('#thread .turn .who .at');
    assert.equal(stamp?.getAttribute('title'), null);
    assert.equal(stamp?.dataset.tip, new Date(noon).toLocaleString());
  });

  /** A marker is not a turn and carries no `at` — the same fact the divider
   *  measures across. A stamp on one would be a reading of nothing. */
  it('gives a marker no stamp of its own', (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [said(noon), { mark: 'break' }, { mark: 'skill', skill: 'x' }] })
    );
    assert.deepEqual(clocks(p), [clockOf(noon)]);
  });
});
