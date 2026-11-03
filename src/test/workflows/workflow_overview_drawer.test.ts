import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openPanel, stateMessage, threadView, type Panel } from '../harness';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

/**
 * Observational workflow overview drawer — live chip opens a snapshot rail over the board.
 * Wire shape comes from `followingWorkflow`; this file is paint + open state.
 */
describe('workflow observe drawer', () => {
  const STEPS = [
    { id: 'plan', label: 'Plan', status: 'pending' as const },
    { id: 'build', label: 'Build', status: 'pending' as const },
    { id: 'review', label: 'Review', status: 'pending' as const }
  ];

  const GROUPS = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];

  const following = (over: Partial<NonNullable<ReturnType<typeof threadView>['workflow']>> = {}) =>
    threadView({
      pid: 101,
      startedAt: 5_000,
      status: 'busy',
      workflow: {
        label: 'plan→build→review',
        steps: STEPS,
        ...over
      }
    });

  const openFollowing = (t: Parameters<typeof openPanel>[0], thread = following()): Panel => {
    const p = openPanel(t);
    p.push(stateMessage(GROUPS));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(GROUPS, { thread }));
    return p;
  };

  const drawer = (p: Panel): HTMLElement | null =>
    p.window.document.getElementById('workflowoverviewdrawer');
  const chip = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#wattach .wflow.live');

  it('is closed by default while FOLLOWING, with a live chip that can open it', (t) => {
    const p = openFollowing(t);
    assert.ok(chip(p), 'live chip is the open affordance');
    assert.ok(chip(p)?.classList.contains('live'));
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'false');
    assert.ok(drawer(p)?.hidden, 'drawer starts closed');
    assert.equal(drawer(p)?.childElementCount, 0);
  });

  /**
   * Which rule wins, not what paints: jsdom has no stacking. The ranks compared
   * are the ones `docs/reference/z_index.md` measured as sharing the root context.
   */
  it('ranks over the ticket sheet only while that sheet is up', (t) => {
    const p = openFollowing(t);
    const doc = p.window.document;
    const rank = (node: Element | null): number => {
      assert.ok(node);
      return Number(p.window.getComputedStyle(node).zIndex);
    };
    const ticket: TicketView = {
      scopeId: 'team-a',
      key: '["linear","issue-a"]',
      identifier: 'ENG-42',
      title: 'Read this ticket',
      url: 'https://example.test/ENG-42',
      priority: ticketPriority(),
      state: ticketState('Ready')
    };
    p.push(
      stateMessage(GROUPS, {
        thread: following(),
        ticketSource: ticketSourceView(),
        tickets: [ticket]
      })
    );
    doc.querySelector<HTMLElement>('#board-tickets')?.click();
    doc.querySelector<HTMLElement>('.tk')?.click();
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);
    const sheet = doc.getElementById('ticket-detail');
    assert.ok(rank(drawer(p)) > rank(sheet), 'the rail is what the reader just opened');

    doc.querySelector<HTMLElement>('#ticket-detail .ax')?.click();
    assert.equal(drawer(p)?.hidden, false);
    assert.ok(rank(drawer(p)) < rank(doc.getElementById('scrim')), 'a question still covers it');
  });

  it('leaves focus on the live chip when opening it closes the drawer', (t) => {
    const p = openFollowing(t);
    const live = chip(p);
    assert.ok(live);
    p.window.document.querySelector<HTMLElement>('#bottomhub .warm-tab')?.click();
    assert.equal(p.window.document.getElementById('bottomdrawer')?.hidden, false);
    live.focus();
    live.click();
    assert.equal(drawer(p)?.hidden, false);
    assert.equal(p.window.document.getElementById('bottomdrawer')?.hidden, true);
    assert.equal(p.window.document.activeElement, live);
  });

  it('opens from the live chip and lists snapshot steps with no current when all pending', (t) => {
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'true');
    assert.match(drawer(p)?.querySelector('.rdhead .lbl')?.textContent ?? '', /plan→build→review/);

    const rows = [...(drawer(p)?.querySelectorAll('.strow') ?? [])];
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.querySelector('.slabel')?.textContent),
      ['Plan', 'Build', 'Review']
    );
    assert.ok(rows.every((r) => r.classList.contains('todo')));
    assert.equal(drawer(p)?.querySelector('.strow.now'), null, 'all-pending invents no current');
    // Observe only — no Model A chrome.
    assert.equal(drawer(p)?.querySelector('.sbtn, .scta, .sacts'), null);
  });

  it('closes when another chat becomes the dock owner', (t) => {
    // Both sessions follow a workflow, and the dock has met the other one
    // before, so its thread is already in hand when the reveal lands — the
    // case where nothing but the change of owner can shut the rail. A host
    // reveal rather than a card press, which shuts it on its own.
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 5_000 }),
          cardView({ pid: 202, startedAt: 6_000 })
        ]
      })
    ];
    const other = { ...following(), pid: 202, startedAt: 6_000 };
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.push({ type: 'reveal', pid: 202, startedAt: 6_000 });
    p.push(stateMessage(groups, { thread: other }));
    p.push({ type: 'reveal', pid: 101, startedAt: 5_000 });
    p.push(stateMessage(groups, { thread: following() }));
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);

    p.push({ type: 'reveal', pid: 202, startedAt: 6_000 });
    assert.equal(drawer(p)?.hidden, true);
  });

  it('toggles shut on a second chip click and on close', (t) => {
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);
    assert.equal(chip(p)?.dataset.tip, 'Hide workflow steps');
    chip(p)?.click();
    assert.ok(drawer(p)?.hidden);
    assert.equal(chip(p)?.dataset.tip, 'Show workflow steps');

    chip(p)?.click();
    drawer(p)?.querySelector<HTMLElement>('.rdhead .x')?.click();
    assert.ok(drawer(p)?.hidden);
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'false');
    assert.equal(chip(p)?.dataset.tip, 'Show workflow steps');
  });

  it('closes on a click out on the board, and stays open for one in the dock', (t) => {
    // The drawer paints over the board but lives in the dock, so a press on a
    // card is a press outside it — dismissed like a modal (taskhub H37).
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);

    p.window.document.querySelector<HTMLElement>('#thread')?.click();
    assert.equal(drawer(p)?.hidden, false, 'the dock it belongs to is not outside');
    drawer(p)?.querySelector<HTMLElement>('.strow')?.click();
    assert.equal(drawer(p)?.hidden, false, 'nor is the rail itself');

    p.window.document.querySelector<HTMLElement>('.card')?.click();
    assert.ok(drawer(p)?.hidden, 'a card is');
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'false');
    assert.equal(chip(p)?.dataset.tip, 'Show workflow steps');

    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false, 'the chip still reopens it');
    p.window.document.getElementById('cards')?.click();
    assert.ok(drawer(p)?.hidden, 'and so is the empty board around the cards');
  });

  it('keeps the rail in the node while it slides shut', (t) => {
    // The exit is a transition off the same `hidden` attribute, so a shut that
    // emptied the node would animate a blank box for its whole length.
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.querySelectorAll('.strow').length, 3);
    chip(p)?.click();
    assert.ok(drawer(p)?.hidden);
    assert.equal(
      drawer(p)?.querySelectorAll('.strow').length,
      3,
      'the steps are still there to slide out'
    );
  });

  it('closes on Escape when open', (t) => {
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.ok(drawer(p)?.hidden);
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'false');
    assert.equal(chip(p)?.dataset.tip, 'Show workflow steps');
  });

  it('highlights the current working step and shows a note', (t) => {
    const p = openFollowing(
      t,
      following({
        step: { label: 'Build', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'completed' },
          {
            id: 'build',
            label: 'Build',
            status: 'in_progress',
            current: true,
            note: 'still compiling'
          },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    const now = drawer(p)?.querySelector('.strow.now');
    assert.equal(now?.querySelector('.slabel')?.textContent, 'Build');
    assert.equal(now?.querySelector('.sstate')?.textContent, 'working');
    assert.equal(now?.querySelector('.snote')?.textContent, 'still compiling');
    assert.ok(drawer(p)?.querySelector('.strow.done .slabel')?.textContent === 'Plan');
    // Chip lean marker still matches current.
    assert.equal(chip(p)?.querySelector('.sname')?.textContent, 'Build');
  });

  it('does not paint non-current in_progress as .now', (t) => {
    // Freehand can mark several steps working; only the joined cursor is blue.
    const p = openFollowing(
      t,
      following({
        step: { label: 'Build', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'in_progress' },
          { id: 'build', label: 'Build', status: 'in_progress', current: true },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    const nows = [...(drawer(p)?.querySelectorAll('.strow.now') ?? [])];
    assert.equal(nows.length, 1);
    assert.equal(nows[0]?.querySelector('.slabel')?.textContent, 'Build');
    const plan = drawer(p)?.querySelectorAll('.strow')[0];
    assert.ok(plan && !plan.classList.contains('now'));
    assert.equal(plan?.querySelector('.sstate')?.textContent, 'working');
  });

  it('paints a failed current row and failed head tone', (t) => {
    const p = openFollowing(
      t,
      following({
        step: { label: 'Build', tone: 'failed' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'completed' },
          { id: 'build', label: 'Build', status: 'failed', current: true, note: 'tests red' },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    const row = drawer(p)?.querySelector('.strow.failed.now');
    assert.equal(row?.querySelector('.slabel')?.textContent, 'Build');
    assert.equal(row?.querySelector('.sstate')?.textContent, 'failed');
    assert.equal(row?.querySelector('.snote')?.textContent, 'tests red');
    assert.ok(drawer(p)?.querySelector('.rdhead')?.classList.contains('failed'));
    assert.equal(chip(p)?.querySelector('.sname')?.textContent, 'Build');
  });

  it('paints the head from phase, not from the rail', (t) => {
    const p = openFollowing(t, following({ phase: 'done' }));
    chip(p)?.click();
    assert.ok(drawer(p)?.querySelector('.rdhead')?.classList.contains('done'));
    assert.equal(drawer(p)?.querySelector('.rdhead')?.classList.contains('running'), false);
  });

  it('paints a failed head from phase even when no row is current', (t) => {
    const p = openFollowing(
      t,
      following({
        phase: 'failed',
        steps: [
          { id: 'plan', label: 'Plan', status: 'failed' },
          { id: 'build', label: 'Build', status: 'pending' },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    assert.ok(drawer(p)?.querySelector('.rdhead')?.classList.contains('failed'));
  });

  it('does not reconstruct done from an all-completed rail', (t) => {
    const p = openFollowing(
      t,
      following({
        phase: 'running',
        steps: STEPS.map((s) => ({ ...s, status: 'completed' as const }))
      })
    );
    chip(p)?.click();
    assert.ok(drawer(p)?.querySelector('.rdhead')?.classList.contains('running'));
    assert.equal(drawer(p)?.querySelector('.rdhead')?.classList.contains('done'), false);
  });

  it('keeps rail and chip aligned when progress advances while open', (t) => {
    const p = openFollowing(
      t,
      following({
        step: { label: 'Plan', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'in_progress', current: true },
          { id: 'build', label: 'Build', status: 'pending' },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    assert.equal(drawer(p)?.querySelector('.strow.now .slabel')?.textContent, 'Plan');
    assert.equal(chip(p)?.querySelector('.sname')?.textContent, 'Plan');
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'true');

    p.push(
      stateMessage(GROUPS, {
        thread: following({
          step: { label: 'Build', tone: 'working' },
          steps: [
            { id: 'plan', label: 'Plan', status: 'completed' },
            { id: 'build', label: 'Build', status: 'in_progress', current: true },
            { id: 'review', label: 'Review', status: 'pending' }
          ]
        })
      })
    );
    assert.equal(drawer(p)?.hidden, false, 'open flag survives a state push');
    assert.equal(drawer(p)?.querySelector('.strow.now .slabel')?.textContent, 'Build');
    assert.equal(chip(p)?.querySelector('.sname')?.textContent, 'Build');
    assert.equal(chip(p)?.getAttribute('aria-expanded'), 'true');
    assert.equal(chip(p)?.dataset.tip, 'Hide workflow steps');
  });

  it('keeps the reader where they scrolled to when a push repaints the rail', (t) => {
    // The rail is the scroll container, so a repaint that replaces the <ol>
    // throws a reader on step 6 back to step 1 — every frame, on a live run.
    const p = openFollowing(
      t,
      following({
        step: { label: 'Plan', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'in_progress', current: true },
          { id: 'build', label: 'Build', status: 'pending' },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    chip(p)?.click();
    const list = drawer(p)?.querySelector<HTMLElement>('.rdsteps');
    const row = drawer(p)?.querySelectorAll('.strow')[2];
    assert.ok(list && row);
    list.scrollTop = 120;

    // Same cursor, only a note moves — nothing here asks to be scrolled to.
    p.push(
      stateMessage(GROUPS, {
        thread: following({
          step: { label: 'Plan', tone: 'working' },
          steps: [
            {
              id: 'plan',
              label: 'Plan',
              status: 'in_progress',
              current: true,
              note: 'still on it'
            },
            { id: 'build', label: 'Build', status: 'pending' },
            { id: 'review', label: 'Review', status: 'pending' }
          ]
        })
      })
    );

    assert.equal(drawer(p)?.querySelector('.rdsteps'), list, 'the rail is morphed, not replaced');
    assert.equal(drawer(p)?.querySelectorAll('.strow')[2], row, 'rows survive by key');
    assert.equal(list.scrollTop, 120, 'the reader keeps their place');
    assert.equal(drawer(p)?.querySelector('.strow.now .snote')?.textContent, 'still on it');
  });

  it('still scrolls to the cursor when it moves under an open drawer', (t) => {
    // The other half of the same rule: holding position must not cost the
    // follow. `scrollIntoView` is stubbed in the harness, so count the calls.
    const p = openFollowing(
      t,
      following({
        step: { label: 'Plan', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'in_progress', current: true },
          { id: 'build', label: 'Build', status: 'pending' },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      })
    );
    const scrolled: string[] = [];
    p.window.Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
      scrolled.push(this.querySelector('.slabel')?.textContent ?? '');
    };
    chip(p)?.click();
    assert.deepEqual(scrolled, ['Plan'], 'first open lands on the cursor');

    const advanced = (id: string) =>
      stateMessage(GROUPS, {
        thread: following({
          step: { label: 'Build', tone: 'working' },
          steps: STEPS.map((s) => ({ ...s, ...(s.id === id ? { current: true } : {}) }))
        })
      });
    p.push(advanced('build'));
    assert.deepEqual(scrolled, ['Plan', 'Build'], 'a moved cursor is followed');
    p.push(advanced('build'));
    assert.deepEqual(scrolled, ['Plan', 'Build'], 'a poll that moves nothing scrolls nothing');
  });

  it('closes when provenance ends and does not reopen on Attach', (t) => {
    const p = openFollowing(t);
    chip(p)?.click();
    assert.equal(drawer(p)?.hidden, false);

    p.push(
      stateMessage(GROUPS, {
        thread: threadView({ pid: 101, startedAt: 5_000, status: 'idle' })
      })
    );
    assert.ok(drawer(p)?.hidden);
    assert.equal(p.window.document.querySelector('#wattach .wflow.live'), null);
    assert.ok(p.window.document.querySelector('#wattach .fpill'), 'Attach returns');
  });

  it('does not exist as a control without a FOLLOWING run', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(GROUPS));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(GROUPS, {
        thread: threadView({ pid: 101, startedAt: 5_000, status: 'idle' })
      })
    );
    assert.equal(chip(p), null);
    assert.ok(drawer(p)?.hidden);
  });
});
