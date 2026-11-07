import { ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { css as navCss } from '../../ui/css/nav';
import { cardView, groupView, openPanel, stateMessage } from '../harness';
import { statusMenu, statusOption } from './board_helpers';

/**
 * The nav bar's responsive steps, read out of the stylesheet that ships them:
 * each `@container (max-width: Npx)` block, and every selector inside it.
 *
 * A brace walk rather than one regex, because the bodies nest. Comments come
 * out first — this stylesheet keeps its reasoning in them, and a `{` in a
 * sentence would end a block that has not ended.
 */
const containerSteps = (css: string): { at: number; selectors: string[] }[] => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const steps: { at: number; selectors: string[] }[] = [];
  const heads = /@container \(max-width: (\d+)px\) \{/g;
  for (let head = heads.exec(clean); head; head = heads.exec(clean)) {
    let depth = 1;
    let i = heads.lastIndex;
    while (depth > 0 && i < clean.length) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
      i++;
    }
    const body = clean.slice(heads.lastIndex, i - 1);
    steps.push({
      at: Number(head[1]),
      selectors: [...body.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)].flatMap((rule) =>
        (rule[1] ?? '').split(',').map((one) => one.trim())
      )
    });
  }
  return steps;
};

describe('the list nav bar', () => {
  /** A group of one session per status, so a tally has something to count. */
  const mixed = () =>
    groupView({
      sessions: [
        cardView({ pid: 1, name: 'b1', status: 'busy' }),
        cardView({ pid: 2, name: 'b2', status: 'busy' }),
        cardView({ pid: 3, name: 'w1', status: 'waiting' }),
        cardView({ pid: 4, name: 'i1', status: 'idle' })
      ]
    });

  const tally = (p: ReturnType<typeof openPanel>): string[] => {
    const result = [...statusMenu(p).querySelectorAll('.mitem')].map((row) => {
      const label = row.querySelector('.nm')?.textContent?.toLowerCase();
      const n = row.querySelector('.sub')?.textContent?.split(' ')[0];
      return label === 'all sessions' ? 'All' + n : `${n} ${label}`;
    });
    p.window.document.getElementById('status-filter')?.click();
    return result;
  };

  const names = (p: ReturnType<typeof openPanel>): string[] =>
    [...p.window.document.querySelectorAll('.card:not(.add) .name')].map(
      (n) => n.textContent ?? ''
    );

  const count = (p: ReturnType<typeof openPanel>, status: string) => statusOption(p, status);

  it('puts Sessions status in its content heading and keeps global navigation available on an empty board', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    const d = p.window.document;
    assert.ok(d.querySelector('#sessions-head #status-filter.fpill'));
    assert.equal(d.querySelector('#nav #status-filter'), null);
    d.querySelector<HTMLElement>('#nav [data-act="tickets"]')?.click();
    assert.equal(d.getElementById('sessions-head')?.hidden, true);
    p.push(stateMessage([]));
    assert.equal(d.getElementById('nav')?.hidden, false);
    assert.ok(d.querySelector('#nav [data-act="sessions"]'));
    assert.ok(d.querySelector('#nav .gear'));
  });

  it('heads the column as its own box, outside the scrolling list', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'waiting' })] })]));
    const board = p.window.document.getElementById('board');
    // The ask layer is a sibling of #cards, not a child of it, for the same
    // reason the nav bar is: renderBoard replaces #cards' children wholesale,
    // and neither the bar nor an open question may be rebuilt out from under
    // the reader. The resume picker is a layer over the board on the same
    // terms, and its own backdrop rather than the ask's — that one is
    // `question.ts`'s, down to the click that dismisses it. The run picker is a
    // third layer on the same terms, with a third backdrop for the same reason.
    // The bottom hub is always present now: empty machine is + New for first create;
    // with workflows it is the arming capsule. Inserted before #scrim.
    assert.deepEqual(
      [...(board?.children ?? [])].map((n) => n.id),
      [
        'nav',
        'board-head',
        'board-body',
        'wfeditor',
        // The lane canvas, beside the editor whose surface it will replace.
        // Debug-only for now, and hidden until that command asks for it.
        'wfcanvas',
        'bottomhub',
        'scrim',
        'ask',
        'pscrim',
        'picker',
        'rscrim',
        'runsheet',
        // The bottom drawer, then the lightbox and their own backdrops: static
        // board surfaces whose document order agrees with their ladder.
        'bottomdrawer-scrim',
        'bottomdrawer',
        'lscrim',
        'lightbox'
      ]
    );
    // The waiting bar is a box of the board and not a row of the list: it floats
    // over the cards, so it neither moves them when it appears nor leaves with
    // them when the reader scrolls.
    assert.equal(p.window.document.querySelector('#cards #alert'), null);
    assert.equal(p.window.document.getElementById('footer'), null, 'foot pills still there');
  });

  it('keeps global navigation available when nothing is running', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    assert.equal(p.window.document.getElementById('nav')?.hidden, false);
    p.push(stateMessage([]));
    assert.equal(p.window.document.getElementById('nav')?.hidden, false);
  });

  it('tallies the sessions by status, and only the statuses present', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    assert.deepEqual(tally(p), ['All4', '2 busy', '1 waiting', '1 idle']);
  });

  it('counts the running commands across the states, and not as one of them', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'b1', status: 'busy', hasCommand: true }),
            cardView({ pid: 2, name: 'b2', status: 'busy' }),
            cardView({ pid: 3, name: 'w1', status: 'waiting', hasCommand: true }),
            cardView({ pid: 4, name: 'i1', status: 'idle', hasCommand: true })
          ]
        })
      ])
    );
    // The counts no longer partition the list, and should not be read as if
    // they did: three of these four are running something as well.
    assert.deepEqual(tally(p), ['All4', '2 busy', '1 waiting', '1 idle', '3 command']);
  });

  it('narrows to the sessions running a command, whatever their state', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'b1', status: 'busy', hasCommand: true }),
            cardView({ pid: 2, name: 'b2', status: 'busy' }),
            cardView({ pid: 3, name: 'i1', status: 'idle', hasCommand: true })
          ]
        })
      ])
    );
    count(p, 'command')?.click();
    assert.deepEqual(names(p), ['b1', 'i1']);
    count(p, 'command')?.click();
    assert.deepEqual(names(p), ['b1', 'b2', 'i1'], 'a second click should unfilter');
  });

  it('offers no command count when nothing is running one', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    assert.equal(count(p, 'command'), null);
  });

  // What the bar keeps at its right-hand end is what is read rather than set:
  // the ticket count and the plan usage. Everything that is set — every
  // switch, the theme — is behind the gear, and the labels they used to spend on the
  // bar are the tally's now.
  it('keeps the readings in the bar and the settings behind the gear', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([mixed()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: []
      })
    );
    const nav = p.window.document.getElementById('nav');
    assert.ok(nav?.querySelector('#board-tickets'), 'no tickets opener');
    assert.ok(nav?.querySelector('#nav-actions .gear'), 'no settings gear');
    assert.equal(
      nav?.querySelector('.rtoggle'),
      null,
      'the rich-status toggle is still in the bar'
    );
    assert.equal(nav?.querySelector('.dtoggle'), null, 'the dialogs toggle is still in the bar');
  });

  describe('the plan usage readout', () => {
    const lim = (p: ReturnType<typeof openPanel>) =>
      p.window.document.querySelector<HTMLElement>('#nav .lim');

    /**
     * Long enough for the tip's own open delay (`OPEN_MS` in `webview/tip.ts`)
     * plus slack. Stated here rather than imported: what a scenario asserts is
     * that a tip waits before it opens, not that it waits exactly 450ms.
     */
    const TIP_MS = 560;

    /**
     * The moment a countdown is measured from, with slack under the floor.
     *
     * The readout floors to the minute, so a reset exactly 2h 14m away reads as
     * 2h 13m the instant the clock has moved at all — and the number here is
     * chosen before the push, the render and, in the hover case, a `TIP_MS`
     * wait. Thirty seconds rather than the one this used to carry: one is the
     * whole budget on a slow box, and CI spent it on `v2026.32.20` and read
     * `1h 59m` for `2h 0m`. Anything under sixty is free — the minute displayed
     * is the same across the whole of it — so this buys thirty times the room
     * for nothing.
     */
    const from = () => Math.floor(Date.now() / 1000) + 30;

    /** Both windows, at percentages the caller cares about. */
    const usage = (session: number, weekly: number): UsageView => ({
      windows: [
        { id: 'session', short: '5h', pct: session, resetsAt: 4000 },
        { id: 'weekly', short: 'wk', pct: weekly, resetsAt: 400000 }
      ]
    });

    it('states both windows in the nav bar', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { usage: usage(10, 22) }));
      assert.equal(lim(p)?.textContent, '5h 10% · wk 22%');
    });

    it('rounds a fractional reading, because a nav bar is not a report', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { usage: usage(10.4, 21.6) }));
      assert.equal(lim(p)?.textContent, '5h 10% · wk 22%');
    });

    it('draws nothing until something states which windows there are', (t) => {
      // The windows belong to the reading, not to the renderer, so before any
      // reading or account row arrives there is no slot to dash. The signed-in
      // row supplies the list on the first auth poll, which is what puts
      // `5h - · wk -` up a moment later.
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      assert.equal(lim(p)?.textContent, '');
    });

    it('holds the labels and waits on the values before any account is known', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usageWindows: [
            { id: 'session', short: '5h' },
            { id: 'weekly', short: 'wk' }
          ]
        })
      );
      assert.ok(lim(p)?.classList.contains('wait'), 'the chip is not waiting');
      // The labels are the host's, and never wait; only the figures do.
      assert.equal(lim(p)?.textContent, '5h  · wk ');
      assert.equal(lim(p)?.querySelectorAll('.v .bone').length, 2);
      assert.ok(lim(p)?.querySelector('.bmwrap .bone'), 'no placeholder for the brand mark');
      // The 600px step hides .w5, so the first window has to be inside it.
      assert.ok(lim(p)?.querySelector('.w5 .v .bone'), 'the first window left .w5');
    });

    it('trades the waiting chip for the accounts control when accounts land', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { usageWindows: [{ id: 'session', short: '5h' }] }));
      p.push(stateMessage([mixed()], { usage: usage(10, 22) }));
      assert.ok(!lim(p)?.classList.contains('wait'), 'the chip is still waiting');
      assert.equal(lim(p)?.querySelector('.bone'), null);
      assert.equal(lim(p)?.textContent, '5h 10% · wk 22%');
    });

    it('dashes a window the brand has but has no figure for', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h' },
              { id: 'weekly', short: 'wk', pct: 22 }
            ]
          }
        })
      );
      assert.equal(lim(p)?.textContent, '5h - · wk 22%');
    });

    it('draws one slot for a brand that states one window, with no bare dot', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], { usage: { windows: [{ id: 'weekly', short: 'wk', pct: 22 }] } })
      );
      assert.equal(lim(p)?.textContent, 'wk 22%');
    });

    it('colours a reading the way the context bar colours one', (t) => {
      const p = openPanel(t);
      const marks = () => [...(lim(p)?.querySelectorAll('.v') ?? [])].map((n) => n.className);
      // Each threshold is exclusive: 70 is not yet high, 90 not yet full.
      p.push(stateMessage([mixed()], { usage: usage(70, 90) }));
      assert.deepEqual(marks(), ['v', 'v high']);
      p.push(stateMessage([mixed()], { usage: usage(71, 91) }));
      assert.deepEqual(marks(), ['v high', 'v full']);
    });

    it('counts down to both resets as tip rows', (t) => {
      const p = openPanel(t);
      const now = from();
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 10, resetsAt: now + 2 * 3600 + 14 * 60 },
              { id: 'weekly', short: 'wk', pct: 91, resetsAt: now + 5 * 86400 + 2 * 3600 }
            ]
          }
        })
      );
      assert.equal(lim(p)?.dataset.tipHead, 'resets in');
      // The rank rides along, so the row for a window at 91% is the same red as
      // the reading it explains.
      assert.equal(
        lim(p)?.dataset.tipRows,
        JSON.stringify([
          ['session', '2h 14m', ''],
          ['weekly', '5d 2h', 'full']
        ])
      );
      // And the tooltip the host used to draw is gone with it.
      assert.equal(lim(p)?.title, '');
    });

    /**
     * Every reading carries the moment it was taken, and none of them is drawn
     * differently for its age — the host has already taken the newest there is
     * and cleared any window that rolled over. The tip is where the age goes.
     */
    it('dates a reading in the tip, and spends no bar on it', (t) => {
      const p = openPanel(t);
      const now = from();
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 10, resetsAt: now + 2 * 3600 },
              { id: 'weekly', short: 'wk' }
            ],
            at: Date.now() - 22 * 60 * 1000
          }
        })
      );
      assert.equal(lim(p)?.textContent, '5h 10% · wk -');
      assert.equal(
        lim(p)?.dataset.tipRows,
        JSON.stringify([
          ['session', '2h 0m', ''],
          ['updated', '22m ago', '']
        ])
      );
    });

    // The case with nothing else to date it: a CLI that states the percentage
    // and no reset draws no countdown at all, so without this the tip is empty
    // and the age of the number is unsayable.
    it('dates one whose window states no reset, which has no other row', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [{ id: 'session', short: '5h', pct: 10 }],
            at: Date.now() - 3 * 3600 * 1000
          }
        })
      );
      assert.equal(lim(p)?.dataset.tipHead, 'resets in');
      assert.equal(lim(p)?.dataset.tipRows, JSON.stringify([['updated', '3h ago', '']]));
    });

    // `at` is optional on the wire and the renderer may not invent one: a record
    // written before the host stamped every reading has an age nothing can
    // establish, and "now" is the one answer that would be a lie.
    it('says nothing about age for a reading that carries no stamp', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { usage: usage(10, 22) }));
      assert.ok(!lim(p)?.dataset.tipRows?.includes('updated'));
    });

    it('drops a reset it has no time for, and keeps the reading', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 10 },
              { id: 'weekly', short: 'wk' }
            ]
          }
        })
      );
      assert.equal(lim(p)?.textContent, '5h 10% · wk -');
      assert.equal(lim(p)?.dataset.tipRows, undefined);
    });

    it('says a window the brand does not have is none, not a countdown', (t) => {
      const p = openPanel(t);
      const now = from();
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: null },
              { id: 'weekly', short: 'wk', pct: 32, resetsAt: now + 86400 + 9 * 3600 }
            ]
          }
        })
      );
      assert.equal(lim(p)?.textContent, '5h none · wk 32%');
      assert.equal(
        lim(p)?.dataset.tipRows,
        JSON.stringify([
          ['session', 'no 5h limit', ''],
          ['weekly', '1d 9h', '']
        ])
      );
    });

    it('says a window whose reset has passed is resetting, not overdue', (t) => {
      const p = openPanel(t);
      const now = Math.floor(Date.now() / 1000);
      p.push(
        stateMessage([mixed()], {
          usage: { windows: [{ id: 'session', short: '5h', pct: 96, resetsAt: now - 60 }] }
        })
      );
      assert.equal(lim(p)?.dataset.tipRows, JSON.stringify([['session', '0h 0m', 'full']]));
    });

    it('opens the readout as keyed rows on hover, and takes them away on leave', async (t) => {
      const p = openPanel(t);
      const doc = p.window.document;
      const now = from();
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 10, resetsAt: now + 66 * 60 },
              { id: 'weekly', short: 'wk', pct: 91, resetsAt: now + 4 * 86400 + 15 * 3600 }
            ]
          }
        })
      );
      const anchor = lim(p);
      assert.ok(anchor);

      anchor.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
      assert.equal(doc.querySelector('.tip'), null, 'a tip appeared before its delay');
      await new Promise((done) => setTimeout(done, TIP_MS));

      const tip = doc.querySelector<HTMLElement>('.tip');
      assert.equal(tip?.querySelector('.hd')?.textContent, 'resets in');
      assert.deepEqual(
        [...(tip?.querySelectorAll('.rows span') ?? [])].map((n) => n.textContent),
        ['session', '1h 6m', 'weekly', '4d 15h']
      );
      assert.equal(tip?.querySelector<HTMLElement>('.rows .v.full')?.textContent, '4d 15h');

      anchor.dispatchEvent(new p.window.MouseEvent('mouseout', { bubbles: true }));
      assert.equal(doc.querySelector('.tip'), null);
    });

    it('re-renders an open tip on the tick, so the countdown does not freeze', async (t) => {
      const p = openPanel(t);
      const doc = p.window.document;
      const now = Math.floor(Date.now() / 1000);
      p.push(
        stateMessage([mixed()], {
          usage: { windows: [{ id: 'session', short: '5h', pct: 10, resetsAt: now + 125 }] }
        })
      );
      lim(p)?.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, TIP_MS));
      assert.equal(doc.querySelector('.tip .rows .v')?.textContent, '0h 2m');

      // The same push the 1s tick makes, with the clock moved past the minute.
      p.push(
        stateMessage([mixed()], {
          usage: { windows: [{ id: 'session', short: '5h', pct: 10, resetsAt: now + 59 }] }
        })
      );
      assert.equal(doc.querySelector('.tip .rows .v')?.textContent, '0h 0m');
    });

    it('closes an open tip on Escape', async (t) => {
      const p = openPanel(t);
      const doc = p.window.document;
      p.push(stateMessage([mixed()], { usage: usage(10, 22) }));
      lim(p)?.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, TIP_MS));
      assert.ok(doc.querySelector('.tip'));
      doc.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.equal(doc.querySelector('.tip'), null);
    });

    /**
     * A press is not a rest. The cup that shows keep-awake drags under
     * `setPointerCapture`, which retargets the compat mouse events at the thing
     * being dragged — so one `mouseover` fires the moment the press takes a tip
     * down, and inside the warm period it reopens with no delay to sit through.
     * Taking the tip down once was the first fix and was not enough.
     *
     * The `buttons: 1` here is the whole scenario, and it is Chromium's own:
     * that retargeted `mouseover` really does carry the held button, which is
     * what lets the layer read the browser's state instead of latching a flag
     * of its own that a `dragend` or a blur could stick shut forever.
     */
    it('opens nothing while a button is held', async (t) => {
      const p = openPanel(t);
      const doc = p.window.document;
      p.push(stateMessage([mixed()], { usage: usage(10, 22) }));
      const anchor = lim(p);
      assert.ok(anchor);

      anchor.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, TIP_MS));
      assert.ok(doc.querySelector('.tip'), 'no tip to drag');

      anchor.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, buttons: 1 }));
      assert.equal(doc.querySelector('.tip'), null, 'the press left the tip up');

      anchor.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true, buttons: 1 }));
      assert.equal(doc.querySelector('.tip'), null, 'a warm tip reopened under the press');
      await new Promise((done) => setTimeout(done, TIP_MS));
      assert.equal(doc.querySelector('.tip'), null, 'a tip opened mid-drag on its delay');
    });

    /**
     * The layer's other rendering, which the usage readout does not use: a
     * phrase draws as one line. Driven by writing the attribute directly,
     * because no control speaks it yet — the two dozen `title=` sites move over
     * in taskhub H23, and this is what they will move on to.
     */
    it('draws a phrase as a one-line chip, whatever wears it', async (t) => {
      const p = openPanel(t);
      const doc = p.window.document;
      p.push(stateMessage([mixed()]));
      const gear = doc.querySelector<HTMLElement>('#nav .gear');
      assert.ok(gear);
      gear.dataset.tip = 'Squadron settings';
      gear.dispatchEvent(new p.window.MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, TIP_MS));

      // No placement assertion: jsdom lays nothing out, so every tip in these
      // scenarios flips above its anchor for want of room it cannot measure.
      const tip = doc.querySelector<HTMLElement>('.tip');
      // `phrase`, not `chip` — the composer owns that selector, see tip.ts.
      assert.ok(tip?.classList.contains('phrase'));
      assert.equal(tip?.classList.contains('chip'), false);
      assert.equal(tip?.textContent, 'Squadron settings');
      assert.equal(tip?.querySelector('.rows'), null, 'a phrase drew as a grid');
    });
  });

  describe('plan usage across brands', () => {
    const lim = (p: ReturnType<typeof openPanel>) =>
      p.window.document.querySelector<HTMLElement>('#nav .lim');
    const soon: AccountView = {
      brand: 'codex',
      name: 'Codex',
      mark: 'codex',
      state: 'coming_soon',
      detail: 'Coming soon'
    };
    const claudeIn = (usage?: UsageView): AccountView => ({
      brand: 'claude',
      name: 'Claude',
      mark: 'claude',
      state: 'signed_in',
      label: 'a@b.c',
      detail: 'Claude',
      usage
    });
    const grokIn = (usage?: UsageView): AccountView => ({
      brand: 'grok',
      name: 'Grok',
      mark: 'grok',
      state: 'signed_in',
      label: 'g@x.ai',
      detail: 'Grok',
      usage
    });
    const claudeOut: AccountView = {
      brand: 'claude',
      name: 'Claude',
      mark: 'claude',
      state: 'signed_out',
      label: 'Not signed in',
      detail: 'Claude'
    };
    const grokOut: AccountView = {
      brand: 'grok',
      name: 'Grok',
      mark: 'grok',
      state: 'signed_out',
      label: 'Not signed in',
      detail: 'Grok'
    };

    it('keeps Claude-in / Grok-out as 5h N% · wk N% with Claude’s mark', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          accounts: [
            claudeIn({
              windows: [
                { id: 'session', short: '5h', pct: 12 },
                { id: 'weekly', short: 'wk', pct: 78 }
              ]
            }),
            grokOut,
            soon
          ]
        })
      );
      assert.match(lim(p)?.textContent ?? '', /5h 12% · wk 78%/);
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      assert.equal(lim(p)?.querySelector('svg.bm.gr'), null);
    });

    it('shows Grok usage, not Log in, when only Grok is signed in', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          accounts: [
            claudeOut,
            grokIn({
              windows: [
                { id: 'session', short: '5h', pct: null },
                { id: 'weekly', short: 'wk', pct: 32 }
              ]
            }),
            soon
          ]
        })
      );
      assert.equal(lim(p)?.classList.contains('login'), false);
      assert.match(lim(p)?.textContent ?? '', /^5h none · wk 32%$/);
      assert.ok(lim(p)?.querySelector('svg.bm.gr'));
    });

    it('shows one brand at a time when both are signed in', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          accounts: [
            claudeIn({
              windows: [
                { id: 'session', short: '5h', pct: 10 },
                { id: 'weekly', short: 'wk', pct: 20 }
              ]
            }),
            grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
            soon
          ]
        })
      );
      const text = lim(p)?.textContent ?? '';
      assert.match(text, /5h 10% · wk 20%/);
      assert.ok(!text.includes('40%'));
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      assert.equal(lim(p)?.querySelectorAll('svg.bm').length, 1);
    });

    it('says none for the window Grok does not have, and dashes the one it does', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          accounts: [
            claudeOut,
            grokIn({
              windows: [
                { id: 'session', short: '5h', pct: null },
                { id: 'weekly', short: 'wk' }
              ]
            }),
            soon
          ]
        })
      );
      assert.match(lim(p)?.textContent ?? '', /^5h none · wk -$/);
    });

    it('does not swap the chip brand while the accounts menu is open', (t) => {
      const p = openPanel(t);
      const accounts: AccountView[] = [
        claudeIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        }),
        grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
        soon
      ];
      p.push(stateMessage([mixed()], { accounts }));
      lim(p)?.click();
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      p.push(stateMessage([mixed()], { accounts }));
      assert.ok(lim(p)?.querySelector('svg.bm.cl'), 'menu open must freeze the brand');
      assert.ok(!lim(p)?.textContent?.includes('40%'));
    });

    it('stays on the first signed-in brand until a turn ends', (t) => {
      const p = openPanel(t);
      const accounts: AccountView[] = [
        claudeIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        }),
        grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
        soon
      ];
      const claudeS = cardView({ pid: 1, name: 'c', brand: 'claude', status: 'busy' });
      const grokS = cardView({ pid: 2, name: 'g', brand: 'grok', status: 'busy' });
      p.push(stateMessage([groupView({ sessions: [claudeS, grokS] })], { accounts }));
      assert.match(lim(p)?.textContent ?? '', /5h 10% · wk 20%/);
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      p.push(stateMessage([groupView({ sessions: [claudeS, grokS] })], { accounts }));
      assert.match(lim(p)?.textContent ?? '', /5h 10% · wk 20%/);
      assert.ok(lim(p)?.querySelector('svg.bm.cl'), 'a re-push with no turn-end must not rotate');
    });

    it('flips the chip to the brand whose session just went idle', (t) => {
      const p = openPanel(t);
      const accounts: AccountView[] = [
        claudeIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        }),
        grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
        soon
      ];
      const claudeS = cardView({ pid: 1, name: 'c', brand: 'claude', status: 'busy' });
      const grokS = cardView({ pid: 2, name: 'g', brand: 'grok', status: 'busy' });
      p.push(stateMessage([groupView({ sessions: [claudeS, grokS] })], { accounts }));
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));

      p.push(
        stateMessage([groupView({ sessions: [claudeS, { ...grokS, status: 'idle' }] })], {
          accounts
        })
      );
      assert.match(lim(p)?.textContent ?? '', /wk 40%/);
      assert.ok(lim(p)?.querySelector('svg.bm.gr'));
      assert.ok(!(lim(p)?.textContent ?? '').includes('10%'));

      p.push(
        stateMessage(
          [
            groupView({
              sessions: [
                { ...claudeS, status: 'idle' },
                { ...grokS, status: 'idle' }
              ]
            })
          ],
          { accounts }
        )
      );
      assert.match(lim(p)?.textContent ?? '', /5h 10% · wk 20%/);
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
    });

    it('does not flip when a session goes waiting, which is still mid-turn', (t) => {
      const p = openPanel(t);
      const accounts: AccountView[] = [
        claudeIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        }),
        grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
        soon
      ];
      const claudeS = cardView({ pid: 1, name: 'c', brand: 'claude', status: 'busy' });
      const grokS = cardView({ pid: 2, name: 'g', brand: 'grok', status: 'busy' });
      p.push(stateMessage([groupView({ sessions: [claudeS, grokS] })], { accounts }));
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      p.push(
        stateMessage([groupView({ sessions: [claudeS, { ...grokS, status: 'waiting' }] })], {
          accounts
        })
      );
      assert.match(lim(p)?.textContent ?? '', /5h 10% · wk 20%/);
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      assert.ok(!(lim(p)?.textContent ?? '').includes('40%'));
    });

    it('flips the chip when a turn ends after a permission prompt', (t) => {
      const p = openPanel(t);
      const accounts: AccountView[] = [
        claudeIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        }),
        grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }),
        soon
      ];
      const claudeS = cardView({ pid: 1, name: 'c', brand: 'claude', status: 'busy' });
      const grokS = cardView({ pid: 2, name: 'g', brand: 'grok', status: 'busy' });
      const at = (status: CardView['status']): void =>
        p.push(
          stateMessage([groupView({ sessions: [claudeS, { ...grokS, status }] })], { accounts })
        );
      at('busy');
      at('waiting');
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      at('idle');
      assert.match(lim(p)?.textContent ?? '', /wk 40%/);
      assert.ok(lim(p)?.querySelector('svg.bm.gr'));
    });

    it('flips the chip when the signed-in brand changes', (t) => {
      const p = openPanel(t);
      p.window.matchMedia = (query: string): MediaQueryList =>
        ({
          matches: query.includes('no-preference'),
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          }
        }) as MediaQueryList;
      p.push(
        stateMessage([mixed()], {
          accounts: [
            claudeIn({
              windows: [
                { id: 'session', short: '5h', pct: 10 },
                { id: 'weekly', short: 'wk', pct: 20 }
              ]
            }),
            grokOut,
            soon
          ]
        })
      );
      assert.ok(lim(p)?.querySelector('svg.bm.cl'));
      p.push(
        stateMessage([mixed()], {
          accounts: [claudeOut, grokIn({ windows: [{ id: 'weekly', short: 'wk', pct: 40 }] }), soon]
        })
      );
      const stage = lim(p)?.querySelector('.limstage');
      assert.ok(stage, 'brand change must stage both faces');
      assert.ok(stage?.querySelector('.limface.out svg.bm.cl'));
      assert.ok(stage?.querySelector('.limface.in svg.bm.gr'));
    });
  });

  /**
   * The machine reading, beside the plan one. A needle rather than a number
   * alone: what a dial buys is an angle, read at a glance and without being
   * parsed. It replaced twelve lit ticks, which quantised that angle away —
   * 6% and 12% lit the same one tick.
   */
  describe('the machine gauge', () => {
    const mach = (p: ReturnType<typeof openPanel>) =>
      p.window.document.querySelector<HTMLElement>('#nav .mach');
    /** Where the needle points, in degrees: -90 at nothing, +90 at full. */
    const at = (face: Element | null | undefined): number | undefined => {
      const rotate = face?.querySelector('.needle')?.getAttribute('transform');
      const deg = rotate?.match(/rotate\((-?[\d.]+)/)?.[1];
      return deg === undefined ? undefined : Number(deg);
    };

    it('states the machine load in the nav bar', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
      assert.equal(mach(p)?.querySelector('.v')?.textContent, '34%');
    });

    it('rounds a fractional reading, like every other figure in this bar', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 33.6 } }));
      assert.equal(mach(p)?.querySelector('.v')?.textContent, '34%');
    });

    it('waits on a poll with nothing to diff: a scan on the arc, a placeholder for the figure', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      // Not "-", which is an answer of nothing. A reading still being taken
      // is a wait, and draws as one (docs/mockups/nav-loading-states.html).
      assert.ok(mach(p)?.classList.contains('wait'), 'an unread machine is not waiting');
      assert.ok(mach(p)?.querySelector('.dial .scan'), 'no scan on the waiting dial');
      assert.ok(mach(p)?.querySelector('.v .bone'), 'no placeholder where the figure lands');
      assert.equal(mach(p)?.querySelector('.v')?.textContent, '');
      // A face with no needle, which is a dial that has not been read. A needle
      // resting at zero would be a claim about an idle machine.
      assert.equal(at(mach(p)), undefined, 'an unread machine drew a needle');
      assert.ok(mach(p)?.querySelector('.arc'), 'the face went away with the needle');
    });

    it('stops waiting once a reading lands', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
      assert.ok(!mach(p)?.classList.contains('wait'), 'a read machine is still waiting');
      assert.equal(mach(p)?.querySelector('.scan'), null);
      assert.equal(mach(p)?.querySelector('.bone'), null);
    });

    it('keeps the same scan and placeholder through a repaint, so the motion never restarts', (t) => {
      // A node the morph replaced would restart its animation on each push.
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      const scan = mach(p)?.querySelector('.scan');
      const bone = mach(p)?.querySelector('.bone');
      p.push(stateMessage([mixed()]));
      assert.ok(scan && mach(p)?.querySelector('.scan') === scan, 'the scan was rebuilt');
      assert.ok(bone && mach(p)?.querySelector('.bone') === bone, 'the placeholder was rebuilt');
    });

    it('points the needle at the reading, across the whole scale', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 0 } }));
      assert.equal(at(mach(p)), -90);
      p.push(stateMessage([mixed()], { machine: { cpu: 50 } }));
      assert.equal(at(mach(p)), 0);
      p.push(stateMessage([mixed()], { machine: { cpu: 100 } }));
      assert.equal(at(mach(p)), 90);
    });

    it('separates a machine that is barely busy from an idle one', (t) => {
      const p = openPanel(t);
      // The twelve ticks this replaced could not: 1% and 6% both rounded to the
      // one tick that was the floor, and 0% drew none. An angle has no floor.
      p.push(stateMessage([mixed()], { machine: { cpu: 1 } }));
      assert.equal(at(mach(p)), -88.2);
      p.push(stateMessage([mixed()], { machine: { cpu: 6 } }));
      assert.equal(at(mach(p)), -79.2);
    });

    it('prints the redline whatever the reading is, so the scale is there to read', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 4 } }));
      assert.ok(mach(p)?.querySelector('.red'), 'an idle machine printed no redline');
    });

    it('says which face is which in a word, not in its units', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
      const marks = [...p.window.document.querySelectorAll('#nav .mach .k')].map(
        (n) => n.textContent
      );
      assert.deepEqual(marks, ['CPU', 'MEM']);
    });

    it('colours it on the same two thresholds the plan readout uses', (t) => {
      const p = openPanel(t);
      const rank = () => mach(p)?.querySelector('.v')?.className;
      p.push(stateMessage([mixed()], { machine: { cpu: 70 } }));
      assert.equal(rank(), 'v');
      p.push(stateMessage([mixed()], { machine: { cpu: 71 } }));
      assert.equal(rank(), 'v high');
      p.push(stateMessage([mixed()], { machine: { cpu: 91 } }));
      assert.equal(rank(), 'v full');
    });

    it('sits before the plan readout, so the gear cannot slide under a press', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          machine: { cpu: 34 },
          usage: { windows: [{ id: 'session', short: '5h', pct: 10 }] }
        })
      );
      const marks = [...p.window.document.querySelectorAll('#nav-actions [data-key]')].map(
        (n) => (n as HTMLElement).dataset.key
      );
      assert.deepEqual(marks.slice(0, 3), ['machine', 'machine-mem', 'machine-vr']);
    });

    /**
     * The tip states the figure as well as what it is a figure of, because a
     * narrow board takes the printed figure away and leaves the needle (the
     * 800px step in css/nav.ts). A reading that is nowhere but on the face is
     * a reading nobody can get back.
     */
    it('says what the reading is on hover, since a dial states no units', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
      assert.equal(mach(p)?.dataset.tip, '34% of this machine, across every core');
    });

    it('keeps the phrase alone when there is no reading to put in it', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      assert.equal(mach(p)?.dataset.tip, 'This machine, across every core');
    });

    /**
     * The memory face, beside the CPU one. A second `.mach` rather than a second
     * reading inside the first: the CPU gauge's own scenarios count `.tick.on`
     * within `.mach`, and folding two dials into one element would have them
     * counting both faces without ever failing.
     *
     * The figure is absolute where the CPU one is a percentage — two adjacent
     * percentages meaning different things is what `resource-usage-placement.html`
     * avoided by drawing this one as `21.4G`.
     */
    describe('the memory face', () => {
      const GIB = 1024 ** 3;
      // The machine `docs/reference/machine_memory.md` was measured on.
      const TOTAL = 24 * GIB;
      const faces = (p: ReturnType<typeof openPanel>) => [
        ...p.window.document.querySelectorAll<HTMLElement>('#nav .mach')
      ];
      const memory = (p: ReturnType<typeof openPanel>) => faces(p)[1];

      it('paints a second face when the platform had something to say', (t) => {
        const p = openPanel(t);
        p.push(
          stateMessage([mixed()], {
            machine: { cpu: 34, memory: { used: 15.1 * GIB, total: TOTAL } }
          })
        );
        assert.equal(faces(p).length, 2, 'the memory face is missing');
      });

      it('states it in gigabytes, not as a second percentage', (t) => {
        const p = openPanel(t);
        p.push(
          stateMessage([mixed()], {
            machine: { cpu: 34, memory: { used: 16220913664, total: TOTAL } }
          })
        );
        assert.equal(memory(p)?.querySelector('.v')?.textContent, '15.1G');
      });

      it('reads "-" on a platform with nothing honest to say', (t) => {
        const p = openPanel(t);
        p.push(stateMessage([mixed()], { machine: { cpu: 34, memory: null } }));
        assert.equal(faces(p).length, 2, 'the face went away instead of dashing');
        assert.equal(memory(p)?.querySelector('.v')?.textContent, '-');
        assert.equal(memory(p)?.dataset.tip, 'Memory in use');
      });

      it('draws no placeholder for an answer of nothing', (t) => {
        const p = openPanel(t);
        p.push(stateMessage([mixed()], { machine: { cpu: 34, memory: null } }));
        assert.ok(!memory(p)?.classList.contains('wait'), 'an answer of nothing is waiting');
        assert.equal(memory(p)?.querySelector('.bone'), null);
      });

      it('waits while the first read is still out', (t) => {
        const p = openPanel(t);
        p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
        assert.ok(memory(p)?.classList.contains('wait'), 'an unread memory face is not waiting');
        assert.ok(memory(p)?.querySelector('.dial .scan'), 'no scan on the waiting face');
        assert.ok(memory(p)?.querySelector('.v .bone'), 'no placeholder where the figure lands');
      });

      it('draws memory before the second CPU sample, and waits only on the load', (t) => {
        const p = openPanel(t);
        p.push(
          stateMessage([mixed()], { machine: { memory: { used: 15.1 * GIB, total: TOTAL } } })
        );
        assert.ok(faces(p)[0]?.classList.contains('wait'), 'the load is not waiting');
        assert.equal(memory(p)?.querySelector('.v')?.textContent, '15.1G');
        assert.ok(!memory(p)?.classList.contains('wait'), 'a read memory face is waiting');
      });

      it('dashes a share of nothing, rather than dividing by it', (t) => {
        const p = openPanel(t);
        // `readMemory` refuses this, so it can only arrive from a host that
        // built the message some other way — and the cost of not checking is a
        // NaN through `dial()`, which paints a face with no ticks at all.
        p.push(stateMessage([mixed()], { machine: { cpu: 34, memory: { used: 0, total: 0 } } }));
        assert.equal(memory(p)?.querySelector('.v')?.textContent, '-');
        assert.equal(memory(p)?.querySelector('.needle'), null, 'a share of nothing drew a needle');
      });

      it('points the needle from used against installed', (t) => {
        const p = openPanel(t);
        p.push(
          stateMessage([mixed()], {
            machine: { cpu: 0, memory: { used: TOTAL / 2, total: TOTAL } }
          })
        );
        assert.equal(at(memory(p)), 0);
        p.push(
          stateMessage([mixed()], { machine: { cpu: 0, memory: { used: TOTAL, total: TOTAL } } })
        );
        assert.equal(at(memory(p)), 90);
      });

      it('ranks itself, and is not told what the processor is doing', (t) => {
        const p = openPanel(t);
        // A machine can be swapping while its cores idle, and the reverse. Two
        // faces that shared a rank would say the same thing twice.
        p.push(
          stateMessage([mixed()], {
            machine: { cpu: 10, memory: { used: TOTAL * 0.92, total: TOTAL } }
          })
        );
        assert.equal(faces(p)[0]?.querySelector('.v')?.className, 'v');
        assert.equal(memory(p)?.querySelector('.v')?.className, 'v full');
      });

      it('names what it is a share of, since the figure is not a percentage', (t) => {
        const p = openPanel(t);
        p.push(
          stateMessage([mixed()], {
            machine: { cpu: 34, memory: { used: 15.1 * GIB, total: TOTAL } }
          })
        );
        // The used figure rides in the phrase for the reason the load's does:
        // the step at 800px prints the face and nothing beside it.
        assert.equal(memory(p)?.dataset.tip, '15.1G in use, of 24.0G installed');
      });
    });
  });

  /**
   * What a narrow board takes away, as far as jsdom can see it.
   *
   * The steps themselves are container queries in `css/nav.ts` and jsdom lays
   * nothing out, so what is tested here is the seam they hang off: every part
   * a step hides is its own element, and what is left when it goes still reads
   * as a sentence. A step that has nothing to select is a step that silently
   * does nothing, and a bar that reads `· 42` beside the mark at 420px is one nobody would
   * have caught until they dragged the divider.
   *
   * The bar as a whole is `docs/mockups/nav-bar-breakpoints.html`.
   */
  describe('what a narrow board gives up', () => {
    /**
     * The one failure the scenarios below cannot reach: a step that parses,
     * applies, and selects nothing. Rename `.lbl` and every one of them stays
     * green while the 600px step quietly stops hiding anything — the bar goes
     * back to spilling and only a divider drag says so.
     *
     * So the steps are read out of the shipped stylesheet and each selector is
     * put to the bar as it is drawn. jsdom cannot evaluate a container query;
     * it can say that what the query names exists.
     */
    it('leaves no step selecting a class the bar no longer draws', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          machine: { cpu: 34 },
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 48 },
              { id: 'weekly', short: 'wk', pct: 36 }
            ]
          },
          ticketSource: { ...ticketSourceView(), linked: true }
        })
      );
      const steps = containerSteps(navCss);
      assert.ok(steps.length >= 5, `only ${steps.length} steps in css/nav.ts`);
      // Widest first. A step out of order is one a narrowing board reaches
      // after the step that was meant to follow it, which is a different bar
      // from the one the table in nav.ts describes.
      assert.deepEqual(
        steps.map((s) => s.at),
        [...steps.map((s) => s.at)].sort((a, b) => b - a)
      );
      const nav = p.window.document.getElementById('nav');
      for (const step of steps) {
        for (const sel of step.selectors) {
          assert.ok(
            nav?.querySelector(sel),
            `the ${step.at}px step hides ${sel}, which this bar does not draw`
          );
        }
      }
    });

    it('leaves no step selecting a class a waiting bar does not draw', (t) => {
      // The bar a cold open paints: every reading still out. The steps have to
      // find their parts in this one as well as in the bar that has landed.
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usageWindows: [
            { id: 'session', short: '5h' },
            { id: 'weekly', short: 'wk' }
          ],
          ticketSource: { ...ticketSourceView(), linked: true }
        })
      );
      const nav = p.window.document.getElementById('nav');
      for (const step of containerSteps(navCss)) {
        for (const sel of step.selectors) {
          assert.ok(
            nav?.querySelector(sel),
            `the ${step.at}px step hides ${sel}, which a waiting bar does not draw`
          );
        }
      }
    });

    it('keeps one labelled status control in the content heading and its options on demand', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      const nav = p.window.document.getElementById('sessions-head');
      assert.ok(nav?.querySelector('#nav-tally'));
      const trigger = p.window.document.getElementById('status-filter');
      assert.ok(trigger);
      assert.match(trigger.textContent ?? '', /All sessions4/);
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(nav?.querySelectorAll('[data-status]').length, 0);
      assert.equal(statusMenu(p).getAttribute('role'), 'menu');
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.deepEqual(tally(p), ['All4', '2 busy', '1 waiting', '1 idle']);
    });

    it('keeps the selected pill and offers Clear in its menu', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      count(p, 'waiting')?.click();
      const trigger = p.window.document.getElementById('status-filter');
      assert.match(trigger?.textContent ?? '', /Waiting1/);
      assert.equal(trigger?.getAttribute('aria-expanded'), 'false');
      const clear = statusMenu(p).querySelector<HTMLElement>('.fclear');
      assert.ok(clear && !clear.hidden);
      clear.click();
      assert.deepEqual(names(p), ['b1', 'b2', 'w1', 'i1']);
      assert.match(
        p.window.document.getElementById('status-filter')?.textContent ?? '',
        /All sessions4/
      );
      assert.equal(statusMenu(p).querySelector<HTMLElement>('.fclear')?.hidden, true);
    });

    it('moves between options by keyboard and returns focus on Escape', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()]));
      const menu = statusMenu(p);
      const all = statusOption(p, 'all');
      assert.equal(p.window.document.activeElement, all);
      all?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
      assert.equal(p.window.document.activeElement?.querySelector('.nm')?.textContent, 'Busy');
      p.window.document.activeElement?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      assert.equal(menu.hidden, true);
      assert.equal(p.window.document.activeElement?.id, 'status-filter');
    });

    it('drops the 5h window with its separator, never leaving a bare dot', (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([mixed()], {
          usage: {
            windows: [
              { id: 'session', short: '5h', pct: 48 },
              { id: 'weekly', short: 'wk', pct: 36 }
            ]
          }
        })
      );
      const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
      assert.equal(lim?.textContent, '5h 48% · wk 36%');
      lim?.querySelector('.w5')?.remove();
      assert.equal(lim?.textContent, 'wk 36%');
    });

    it('names each rule after what it separates, so it can go with it', (t) => {
      const p = openPanel(t);
      p.push(stateMessage([mixed()], { machine: { cpu: 34 } }));
      const rules = [...p.window.document.querySelectorAll('#nav-actions .vr')].map(
        (n) => n.className
      );
      assert.deepEqual(rules, ['vr machv', 'vr usagev']);
    });
  });

  it('shows only the picked status when a count is clicked', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'busy')?.click();
    assert.deepEqual(names(p), ['b1', 'b2']);
    assert.ok(count(p, 'busy')?.classList.contains('on'), 'picked count not marked');
    assert.ok(!count(p, 'all')?.classList.contains('on'), 'All still marked');
  });

  it('goes on tallying every session while a filter narrows the cards', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'waiting')?.click();
    assert.deepEqual(tally(p), ['All4', '2 busy', '1 waiting', '1 idle']);
  });

  it('clears the filter from All, and from a second click on the picked count', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'busy')?.click();
    count(p, 'all')?.click();
    assert.deepEqual(names(p), ['b1', 'b2', 'w1', 'i1']);

    count(p, 'waiting')?.click();
    assert.deepEqual(names(p), ['w1']);
    count(p, 'waiting')?.click();
    assert.deepEqual(names(p), ['b1', 'b2', 'w1', 'i1']);
  });

  it('drops a group with nothing matching, and the add slot with it', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [cardView({ pid: 1, name: 'b1', status: 'busy' })] }),
        groupView({
          cwd: '/e',
          label: '~/e',
          sessions: [cardView({ pid: 2, name: 'i1', status: 'idle' })]
        })
      ])
    );
    assert.equal(p.window.document.querySelectorAll('h2').length, 2);
    assert.equal(p.window.document.querySelectorAll('.card.add').length, 2);

    count(p, 'busy')?.click();
    const heads = p.window.document.querySelectorAll('h2');
    assert.equal(heads.length, 1);
    assert.equal(heads[0]?.textContent?.startsWith('~/proj'), true);
    assert.equal(p.window.document.querySelector('.card.add'), null, 'add slot survived a filter');
  });

  it('keeps a filter whose sessions have all ended, and says so', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'waiting')?.click();
    // The session it caught is gone from the board — the one way a snapshot
    // empties. The active option stays available with a zero count.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 1, name: 'b1', status: 'busy' })] })])
    );
    assert.deepEqual(names(p), []);
    assert.deepEqual(tally(p), ['All1', '1 busy', '0 waiting']);
    assert.equal(
      p.window.document.querySelector('#filtered-empty')?.textContent,
      'No waiting sessions left.'
    );
    statusMenu(p).querySelector<HTMLElement>('.fclear')?.click();
    assert.deepEqual(names(p), ['b1']);
  });

  /**
   * The other half of that: a session the pick caught stays on the board when
   * it changes state, rather than vanishing out from under a reader who is
   * part-way through reading it.
   */
  it('holds a card that leaves its bucket while the pick stands', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'busy')?.click();
    assert.deepEqual(names(p), ['b1', 'b2']);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'b1', status: 'idle' }),
            cardView({ pid: 2, name: 'b2', status: 'busy' })
          ]
        })
      ])
    );
    assert.deepEqual(names(p), ['b1', 'b2'], 'a card was dropped by a paint, not by a click');
    assert.deepEqual(tally(p), ['All2', '1 busy', '1 idle'], 'the tally stopped reading the board');
    const refresh = statusMenu(p).querySelector<HTMLElement>('.faction');
    assert.ok(refresh);
    refresh.click();
    assert.deepEqual(names(p), ['b2'], 'refresh must capture the current matches');
    assert.match(p.window.document.getElementById('status-filter')?.textContent ?? '', /Busy1/);
  });

  /**
   * The tally counts what the cards say, not the status underneath them: an
   * unseen reply and a half-run step list both read `idle` on the wire and
   * neither reads `idle` on the board. A count that said "3 idle" over three
   * cards saying DONE, STALLED and IDLE was naming nothing a reader could
   * point at, and the pick behind it showed all three.
   */
  const facets = () =>
    groupView({
      sessions: [
        cardView({ pid: 1, name: 'd1', status: 'idle', unseen: true }),
        cardView({
          pid: 2,
          name: 's1',
          status: 'idle',
          completion: { total: 5, completed: 2 }
        }),
        cardView({ pid: 3, name: 'i1', status: 'idle' })
      ]
    });

  it("counts a card's own word, so done and stalled leave the idle count", (t) => {
    const p = openPanel(t);
    p.push(stateMessage([facets()]));
    assert.deepEqual(tally(p), ['All3', '1 stalled', '1 done', '1 idle']);
  });

  it('narrows to the done cards, and to the stalled ones', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([facets()]));
    count(p, 'done')?.click();
    assert.deepEqual(names(p), ['d1']);
    count(p, 'stalled')?.click();
    assert.deepEqual(names(p), ['s1']);
    count(p, 'idle')?.click();
    assert.deepEqual(names(p), ['i1'], 'idle still spoke for the other two');
  });

  /**
   * Selection does not acknowledge output locally: the count follows the
   * shipped reading until the host pushes the mark written by the click.
   */
  it('keeps a done count while its card is open until the host acknowledges', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([facets()]));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="1"]')?.click();
    assert.deepEqual(tally(p), ['All3', '1 stalled', '1 done', '1 idle']);
  });

  /**
   * The pick is a snapshot, so the card a reader opens is still there when the
   * dock opens on it. The host acknowledgement can later retire done; the
   * snapshot keeps the chosen card on the board.
   */
  it('keeps the opened card on a done board it has just left', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([facets()]));
    count(p, 'done')?.click();
    assert.deepEqual(names(p), ['d1']);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="1"]')?.click();
    assert.deepEqual(names(p), ['d1'], 'the board emptied under the click that filled it');
    // Both surfaces keep the shipped reading until acknowledgement returns.
    assert.deepEqual(tally(p), ['All3', '1 stalled', '1 done', '1 idle']);
  });

  /** A bucket a session enters after the click is a bucket it enters unseen. */
  it('does not take in a session that joins the bucket after the pick', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([facets()]));
    count(p, 'done')?.click();
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 1, name: 'd1', status: 'idle', unseen: true }),
            cardView({ pid: 2, name: 's1', status: 'idle', unseen: true }),
            cardView({ pid: 3, name: 'i1', status: 'idle' })
          ]
        })
      ])
    );
    assert.deepEqual(names(p), ['d1'], 's1 joined a set that was already taken');
    // The bar counts what is true now, so the same click again takes both.
    assert.deepEqual(tally(p), ['All3', '2 done', '1 idle']);
    count(p, 'done')?.click();
    count(p, 'done')?.click();
    assert.deepEqual(names(p), ['d1', 's1']);
  });

  /** A turn that could not run is its own count, out of idle like done and stalled. */
  const outcomes = (
    f2: Parameters<typeof cardView>[0] = { status: 'idle', turnOutcome: 'error' }
  ) =>
    groupView({
      sessions: [
        cardView({ pid: 1, name: 'f1', status: 'idle', turnOutcome: 'error' }),
        cardView({
          pid: 2,
          name: 's1',
          status: 'idle',
          completion: { total: 5, completed: 2 }
        }),
        cardView({ pid: 3, name: 'i1', status: 'idle' }),
        cardView({ pid: 4, name: 'f2', ...f2 })
      ]
    });

  it('counts failed cards in their own bucket', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([outcomes()]));
    assert.deepEqual(tally(p), ['All4', '2 failed', '1 stalled', '1 idle']);
  });

  it('counts an unread failed card as failed, not done', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([outcomes({ status: 'idle', turnOutcome: 'error', unseen: true })]));
    assert.deepEqual(tally(p), ['All4', '2 failed', '1 stalled', '1 idle']);
  });

  it('narrows to the failed cards, and keeps them when one turns busy', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([outcomes()]));
    count(p, 'failed')?.click();
    assert.deepEqual(names(p), ['f1', 'f2']);
    // A new turn began: the outcome is gone with it (`core/live.ts`).
    p.push(stateMessage([outcomes({ status: 'busy' })]));
    assert.deepEqual(names(p), ['f1', 'f2'], 'the pick followed the live board');
    assert.deepEqual(tally(p), ['All4', '1 busy', '1 failed', '1 stalled', '1 idle']);
  });

  it("posts nothing when a count is clicked — the filter is the webview's own", (t) => {
    const p = openPanel(t);
    p.push(stateMessage([mixed()]));
    count(p, 'busy')?.click();
    count(p, 'all')?.click();
    assert.deepEqual(p.posted, []);
  });
});

/**
 * jsdom lays nothing out, so the row's place in the bar is the rule text.
 *
 * Measured 2026-10-06 on the running panel: a chip centered in the 40px sat
 * on that box's center, and about 4px of the box sat above the editor tab
 * seam, so the row read high in the navy left on screen. padding-top is that
 * cover, on #nav and on .dtab, or the two bars stop reading as one strip.
 * border-box puts the nav's 1px rule inside the 40.
 */
describe('the nav bar shares its outer edge with the dock', () => {
  const rule = (css: string, selector: string): string => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = clean.match(new RegExp(`${selector} \\{[^}]*\\}`));
    return found?.[0] ?? '';
  };

  it('drops the row by the covered strip', () => {
    const bar = rule(navCss, '#nav');
    assert.match(bar, /height:\s*40px/);
    assert.match(bar, /box-sizing:\s*border-box/);
    assert.match(bar, /padding:\s*4px var\(--board-gutter\) 0/);
  });
});

it('keeps the Sessions badge at the full window total through status filters, loading and zero', (t) => {
  const p = openPanel(t);
  const badge = () => p.window.document.querySelector('#board-sessions .tb');
  assert.equal(badge()?.getAttribute('aria-label'), 'Loading sessions');
  const groups = [
    groupView({
      sessions: [cardView({ pid: 1, status: 'waiting' }), cardView({ pid: 2, status: 'busy' })]
    })
  ];
  p.push(stateMessage(groups));
  assert.equal(badge()?.textContent, '2');
  statusOption(p, 'waiting')?.click();
  assert.equal(badge()?.textContent, '2');
  p.push(stateMessage([]));
  assert.equal(badge()?.textContent, '0');
});
