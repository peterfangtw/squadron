import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  remoteStateView,
  stateMessage,
  threadView,
  workflowView
} from '../harness';
import type { Panel } from '../harness';

/** The board-wide hub reports waiting sessions and opens its service modes.
 * Workflow application remains the composer's responsibility. */

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

const $$ = (p: Panel, sel: string): HTMLElement[] => [
  ...p.window.document.querySelectorAll<HTMLElement>(sel)
];

/** A board with one card, which every scenario here needs and none is about. */
const board = () => [groupView({ sessions: [cardView({ pid: 5 })] })];
/** One this panel drives, so a press would have somewhere to land. */
const owned = () => [groupView({ sessions: [cardView({ pid: 5, owned: true })] })];

/** N steps, named for nothing in particular: the bar draws none of them. */
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Step ${i + 1}`,
    prompt: `do step ${i + 1}`
  }));

const WORKFLOWS = [
  workflowView({ id: 'ship', label: 'plan→build→review', steps: steps(4) }),
  workflowView({ id: 'spike', label: 'spike→report', steps: steps(2) }),
  workflowView({ id: 'fix', label: 'fix→check', steps: steps(2) })
];

function panelWith(t: Parameters<typeof openPanel>[0], workflows = WORKFLOWS): Panel {
  const p = openPanel(t);
  p.push(stateMessage(board(), { workflows }));
  return p;
}

describe('the bottom hub', () => {
  for (const driver of ['push', 'beat'] as const) {
    it(`writes no unchanged bar values on a ${driver}`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const p = openPanel(t);
      const now = Date.now();
      p.window.Date.now = () => now;
      const message = stateMessage(
        [
          groupView({
            sessions: [
              cardView({
                pid: 5,
                status: 'waiting',
                warm: { on: true, ttlMs: 3_600_000, source: 'measured' }
              })
            ]
          })
        ],
        { workflows: WORKFLOWS, remote: remoteStateView({ tone: 'live', status: 'Connected' }) }
      );
      p.push(message);
      const bar = $(p, '#bottomhub');
      assert.ok(bar);
      const observer = new p.window.MutationObserver(() => {});
      observer.observe(bar, { attributes: true, childList: true, subtree: true });
      t.after(() => observer.disconnect());
      if (driver === 'push') p.push(message);
      else t.mock.timers.tick(1000);
      assert.equal(observer.takeRecords().length, 0, 'unchanged bar values mutated');
      p.push(
        stateMessage(
          [
            groupView({
              sessions: [
                cardView({
                  pid: 5,
                  status: 'waiting',
                  warm: { on: false, ttlMs: 3_600_000, source: 'measured' }
                })
              ]
            })
          ],
          {
            workflows: WORKFLOWS,
            remote: remoteStateView({ tone: 'fault', status: 'Not connected' })
          }
        )
      );
      assert.equal(
        $(p, '#bottomhub .warm-tab .num')?.textContent,
        '0',
        'changed tally was skipped'
      );
      assert.ok($(p, '#bottomhub .remote-tab .dot.fault'), 'changed Remote tone was skipped');
      assert.equal($(p, '#bottomhub .remote-tab')?.dataset.tip, 'Not connected');
      assert.ok(observer.takeRecords().length > 0, 'changed bar values did not mutate');
    });
  }

  // Empty machine still shows chrome for first create (author-entry mock). The
  // handle arrives only when there is a list for the sheet to draw.
  it('shows + New when there are no workflows; the handle once there are', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    assert.ok($(p, '#bottomhub'), 'empty machine still has a bar for first create');
    assert.match($(p, '#bottomhub')?.textContent ?? '', /\+ New workflow/);
    assert.equal($(p, '#bottomhub .wmore'), null, 'nothing for a sheet to list yet');

    p.push(stateMessage(board(), { workflows: WORKFLOWS }));
    assert.match($(p, '#bottomhub')?.textContent ?? '', /Workflow/);
    assert.ok($(p, '#bottomhub .wmore'), 'the handle once workflows exist');

    p.push(stateMessage(board()));
    assert.match($(p, '#bottomhub')?.textContent ?? '', /\+ New workflow/);
  });

  // Applying is the composer's, so the bar offers nothing to apply, whatever
  // session is selected: one door per surface, each a word.
  it('draws Workflows, Warm, Remote, Agents and Keep-awake, and nothing to apply', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(owned(), { workflows: WORKFLOWS }));
    $(p, '.card')?.click();
    p.push(stateMessage(owned(), { workflows: WORKFLOWS, thread: threadView({ pid: 5 }) }));
    assert.deepEqual(
      $$(p, '#bottomhub button:not([hidden])').map((b) => b.textContent),
      ['Agents', 'Workflows', 'Remote', 'Warm 0', 'Keep-awake']
    );
  });

  // Every word is a live door onto its mode of the drawer; none is drawn dead.
  it('offers Warm, Remote, Agents and Keep-awake live, and no dead word', (t) => {
    const p = panelWith(t);
    assert.deepEqual($$(p, '#bottomhub .hpill[aria-disabled="true"]'), []);
    for (const tab of ['.warm-tab', '.remote-tab', '.agents-tab', '.awake-tab']) {
      assert.ok($(p, `#bottomhub ${tab}`), `no ${tab} word`);
      assert.equal($(p, `#bottomhub ${tab}`)?.getAttribute('aria-disabled'), null);
    }
    assert.ok($(p, '#bottomdrawer')?.hidden);
  });

  it('keeps Warm, Remote, Agents and Keep-awake beside + New on an empty machine', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    assert.deepEqual(
      $$(p, '#bottomhub button:not([hidden])').map((b) => b.textContent),
      ['Agents', '+ New workflow', 'Remote', 'Warm 0', 'Keep-awake']
    );
  });

  it('opens the sheet from the handle', (t) => {
    const p = panelWith(t);
    assert.ok($(p, '#bottomdrawer')?.hidden);
    $(p, '#bottomhub .wmore')?.click();
    assert.equal($(p, '#bottomdrawer')?.hidden, false);
  });

  it('empty bar New opens the board editor', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board()));
    $(p, '#bottomhub .fpill')?.click();
    assert.ok(p.window.document.getElementById('board')?.classList.contains('editing'));
  });

  /**
   * A press is two events with up to a poll between them: a repaint that
   * replaces the button after the mousedown and before the mouseup drops the
   * click entirely — the node it landed on is detached, so no click is ever
   * dispatched at it. Measured in a real browser before this was written: every
   * control on this bar lost the press.
   *
   * Node identity is the whole assertion, and it is what jsdom can carry: a bar
   * that rebuilds itself is a bar whose presses are lost, and the two are the
   * same fact.
   */
  it('keeps the nodes a press is resting on across a poll', (t) => {
    const p = panelWith(t);
    const more = $(p, '#bottomhub .wmore');
    assert.ok(more, 'the bar must offer the handle before this can mean anything');

    p.push(stateMessage(board(), { workflows: WORKFLOWS }));

    assert.equal($(p, '#bottomhub .wmore'), more, 'the handle was rebuilt under the pointer');
  });

  /** What the sheet took: the bar states no list of its own any more. */
  it('offers no picker, no arm switch and no Edit', (t) => {
    const p = panelWith(t);
    assert.equal($(p, '#bottomhub .rsw'), null, 'the arm switch is a fact on a row now');
    assert.equal($(p, '#bottomhub .bedit'), null, 'Edit is on every row, not on the bar');
    assert.equal($(p, '#bottomhub .fpill'), null, 'the pick-one pill is the sheet');
  });

  /**
   * The line the mockup took three passes to reach, held here so a later
   * revision has to delete a test to cross it.
   *
   * Read as accessible text rather than as a count of elements: a bar may
   * legitimately earn a third kind of control one day, and it may never earn one
   * that acts on a run.
   */
  it('reports no run, and offers nothing that acts on one', (t) => {
    const p = panelWith(t);
    const text = $(p, '#bottomhub')?.textContent ?? '';

    for (const forbidden of [/\d+\s*of\s*\d+/, /exit(ed)?\s*\d/i, /blocked/i]) {
      assert.doesNotMatch(text, forbidden);
    }
    for (const button of $$(p, '#bottomhub button')) {
      assert.doesNotMatch(button.textContent ?? '', /advance|retry|cancel|skip|answer/i);
    }
  });
});

describe('waiting sessions above Agents', () => {
  it('counts waiting sessions across groups and restores Orchestration when resolved', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage(
        [
          groupView({
            sessions: [
              cardView({ pid: 1, status: 'waiting', name: 'First request' }),
              cardView({ pid: 3 })
            ]
          }),
          groupView({
            cwd: '/other',
            sessions: [cardView({ pid: 2, status: 'waiting', name: 'Second request' })]
          })
        ],
        { orchestrators: true }
      )
    );
    assert.equal($(p, '#alert'), null);
    assert.equal($(p, '.agents-tab .waiting-count')?.textContent, '2');
    assert.ok($(p, '.agents-tab.needs-input'));
    assert.deepEqual(
      $$(p, '#bottomhub-waiting .waiting-session').map((n) => n.textContent),
      ['First request', 'Second request']
    );
    p.push(stateMessage(board(), { orchestrators: true }));
    assert.equal($(p, '.agents-tab .waiting-count')?.hidden, true);
    assert.equal($(p, '.agents-tab.needs-input'), null);
    assert.ok($(p, '.agents-tab .dot.on'));
    assert.equal($$(p, '#bottomhub-waiting .waiting-session').length, 0);
  });

  it('reveals all waiting pills by hover without opening Agents settings', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: Array.from({ length: 12 }, (_, i) =>
            cardView({ pid: i + 1, status: 'waiting' })
          )
        })
      ])
    );
    const trigger = $(p, '.agents-tab');
    assert.ok(trigger);
    assert.equal($(p, '#bottomhub-waiting')?.hidden, true);
    trigger.dispatchEvent(new p.window.MouseEvent('pointerenter'));
    assert.equal($(p, '#bottomhub-waiting')?.hidden, false);
    assert.equal($$(p, '#bottomhub-waiting .waiting-session').length, 12);
    assert.equal($(p, '#bottomdrawer')?.hidden, true);
    trigger.click();
    assert.equal($(p, '#bottomdrawer')?.hidden, false);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Agents');
    assert.equal($(p, '#bottomhub-waiting')?.hidden, true);
  });

  it('supports keyboard browsing, Escape and a session leaving while focused', (t) => {
    const p = openPanel(t);
    const push = (sessions: ReturnType<typeof cardView>[]) =>
      p.push(stateMessage([groupView({ sessions })]));
    const waiting = (pid: number) => cardView({ pid, status: 'waiting' });
    push([waiting(1), waiting(2)]);
    const trigger = $(p, '.agents-tab');
    assert.ok(trigger);
    trigger.focus();
    trigger.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const first = $(p, '#bottomhub-waiting .waiting-session:last-child');
    assert.equal(p.window.document.activeElement, first);
    push([waiting(1)]);
    assert.equal(p.window.document.activeElement, trigger);
    assert.ok(first && !p.window.document.contains(first));
    trigger.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    p.window.document.activeElement?.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal($(p, '#bottomhub-waiting')?.hidden, true);
    assert.equal(p.window.document.activeElement, trigger);
  });
});
