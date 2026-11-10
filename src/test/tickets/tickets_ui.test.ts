import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modelView, groupView, openPanel, openThread, stateMessage, threadView } from '../harness';

/** Existing ticket source, filters, sorting and keyed rows in the board. */

const ticket = (over: Partial<TicketView> = {}): TicketView => ({
  scopeId: 'team-a',
  key: 'i1',
  identifier: 'ENG-1',
  title: 'a bug',
  priority: ticketPriority(2),
  state: ticketState('In Progress'),
  url: 'https://linear.app/x/ENG-1',
  ...over
});

const $ = (p: ReturnType<typeof openPanel>, sel: string) =>
  p.window.document.querySelector<HTMLElement>(sel);

/**
 * A linked source with filter options fetched, ready for the filter bar. The
 * selection is a partial: a scenario states the facet it is about, and the other
 * two stay unnarrowed rather than being restated at every call.
 */
const filterLinear = (filter: Partial<TicketFilterView> = { states: ['name:In Progress'] }) => ({
  ...ticketSourceView(),
  linked: true,
  filter: { assignee: 'me', states: [], priorities: [], ...filter },
  options: {
    scopeId: 'team-a',
    viewerId: 'u_2',
    assignees: [
      { id: 'anyone', label: 'Anyone' },
      { id: 'u_2', label: 'sam' },
      { id: 'u_1', label: 'alex' }
    ],
    states: [ticketState('To Do'), ticketState('In Progress')],
    // Urgency-ordered, the way `toOptions` hands them over, and labelled the way
    // Linear labels them — "No priority", not "None".
    priorities: [
      { ...ticketPriority(1), label: 'Urgent' },
      { ...ticketPriority(2), label: 'High' },
      { ...ticketPriority(3), label: 'Medium' },
      { ...ticketPriority(4), label: 'Low' },
      { ...ticketPriority(0), label: 'No priority' }
    ]
  }
});

/** The rows of whichever filter menu is open; empty when none is. */
const items = (p: ReturnType<typeof openPanel>) => [
  ...p.window.document.querySelectorAll<HTMLElement>('.fmenu.pmenu:not([hidden]) .mitem')
];

function detailRequestId(p: ReturnType<typeof openPanel>): string {
  const message = p.posted.filter((m) => m.type === 'readTicket').at(-1);
  assert.ok(message);
  assert.equal(typeof message.requestId, 'string');
  return message.requestId;
}

const key = (p: ReturnType<typeof openPanel>, name: string) =>
  p.window.document.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: name, bubbles: true })
  );
const esc = (p: ReturnType<typeof openPanel>) => key(p, 'Escape');

describe('the tickets tab', () => {
  it('keeps an unrelated composer menu open when an unlinked Tickets view receives a push', (t) => {
    const p = openThread(t, threadView({ owned: true }), { models: [modelView()] });
    const state = () =>
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: false },
        models: [modelView()]
      });
    p.push(state());
    $(p, '#board-tickets')?.click();
    const trigger = $(p, '#ctools .fpill.model');
    assert.ok(trigger);
    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    p.push(state());
    assert.equal(
      trigger.getAttribute('aria-expanded'),
      'true',
      'ticket repaint closed a chat menu'
    );
  });

  it('opens details from the whole tile without a handoff or draggable ticket', (t) => {
    const p = openThread(t, threadView());
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket()]
      })
    );
    $(p, '#nav [data-act="tickets"]')?.click();
    const row = $(p, '#tk-list .tk');
    assert.ok(row);
    assert.equal(row.draggable, false);
    assert.equal(row.querySelector('.handoff'), null);
    p.posted.length = 0;
    row.click();
    assert.deepEqual(p.posted, [
      {
        type: 'readTicket',
        requestId: detailRequestId(p),
        generation: 1,
        selectionSeq: 0,
        scopeId: 'team-a',
        key: ticket().key
      }
    ]);
  });

  it('offers one connect prompt with a row per source when none is linked', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: false } }));

    const open = $(p, '#board-tickets');
    assert.match(open?.textContent ?? '', /Tickets/);
    open?.click();
    assert.match(
      $(p, '#tk-list .tkpick .tkstate-title')?.textContent ?? '',
      /Connect a ticket source/
    );
    assert.equal($(p, '#tk-list .tkconnect'), null, 'a second CTA beside the rows');
    assert.equal($(p, '#tk-list [data-act="connectChoose"]'), null, 'the IDE chooser is back');
    const rows = [...p.window.document.querySelectorAll<HTMLButtonElement>('#tk-list .tksrc')];
    assert.deepEqual(
      rows.map((row) => [
        row.querySelector('.nm')?.textContent,
        row.querySelector('.what')?.textContent,
        row.querySelector('.mk svg') !== null
      ]),
      [
        ['Linear', 'Personal API key', true],
        ['GitHub Projects', 'Classic token with read:project', true]
      ]
    );
    rows[1]?.click();
    assert.deepEqual(p.posted, [
      { type: 'ticketsOpen', open: true },
      {
        type: 'connectTicketSource',
        generation: 1,
        selectionSeq: 0,
        scopeId: 'team-a',
        provider: 'github'
      }
    ]);
  });

  it('holds the row whose connect prompt is open', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: false, connecting: 'linear' }
      })
    );
    $(p, '#board-tickets')?.click();
    const [linear, github] = [
      ...p.window.document.querySelectorAll<HTMLButtonElement>('#tk-list .tksrc')
    ];
    assert.equal(linear?.disabled, true);
    assert.equal(linear?.querySelector('.what')?.textContent, 'Waiting for the key…');
    assert.equal(github?.disabled, false);
    assert.equal(github?.querySelector('.what')?.textContent, 'Classic token with read:project');

    // The prompt returned: the row is offered again, the same element.
    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: false } }));
    const again = $(p, '#tk-list .tksrc');
    assert.equal(again, linear);
    assert.equal((again as HTMLButtonElement | null)?.disabled, false);
    assert.equal(again?.querySelector('.what')?.textContent, 'Personal API key');
  });

  it('keeps the Tickets label beside its count', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket(), ticket({ key: 'i2', identifier: 'ENG-2' })]
      })
    );
    const open = $(p, '#board-tickets');
    assert.equal(open?.textContent, 'Tickets2');
    assert.equal(open?.querySelector('.tb')?.textContent, '2');
  });

  it('waits on the count, not the word, while the backlog is fetched', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: true } }));
    const open = $(p, '#board-tickets');
    assert.equal(open?.textContent, 'Tickets');
    assert.ok(open?.querySelector('.bone'), 'no placeholder where the count lands');
  });

  it('reads "-" for a fetch that failed with nothing to fall back on', (t) => {
    // Not a wait: the same rule webview/tickets.ts follows for "Could not load".
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true, stale: true, error: 'x' }
      })
    );
    const open = $(p, '#board-tickets');
    assert.equal(open?.textContent, 'Tickets-');
    assert.equal(open?.querySelector('.bone'), null);
  });

  it('draws the count and no placeholder once the list is in', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket()]
      })
    );
    assert.equal($(p, '#board-tickets')?.querySelector('.bone'), null);
    assert.equal($(p, '#board-tickets')?.textContent, 'Tickets1');
  });

  it('counts tickets on the tab and renders them when opened', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket(), ticket({ key: 'i2', identifier: 'ENG-2', priority: ticketPriority(1) })]
      })
    );

    assert.equal($(p, '#board-tickets .tb')?.textContent, '2');

    $(p, '#board-tickets')?.click();
    assert.equal(p.window.document.getElementById('tk-list')?.hidden, false);
    assert.equal(p.window.document.querySelectorAll('#tk-list .tk').length, 2);
    assert.equal($(p, '#tk-list .tk .tkkey')?.textContent, 'ENG-1');
    assert.ok($(p, '#tk-head .scope-button .tmark svg.bm.ln'), 'no Linear mark on the dock head');
    assert.equal($(p, '#tk-head .scope-button .nm')?.textContent, 'Engineering');
  });

  /**
   * The tab is a button, and its label and badge are the only things inside it
   * — so replacing them on every push replaces whatever a press landed on. A
   * mousedown on the word *Tickets* followed by a poll and then the mouseup
   * dispatches no click at all, which is the tab reading as dead about one
   * press in a handful. Written in place instead; identity is the assertion.
   */
  it('keeps the tab’s label and badge across a poll', (t) => {
    const p = openPanel(t);
    const state = () =>
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket()]
      });
    p.push(state());
    const label = $(p, '#board-tickets .nm');
    const badge = $(p, '#board-tickets .tb');
    assert.ok(label && badge);

    p.push(state());

    assert.equal($(p, '#board-tickets .nm'), label, 'the label was rebuilt under the pointer');
    assert.equal($(p, '#board-tickets .tb'), badge, 'the badge was rebuilt under the pointer');

    // And the count still follows the state.
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket(), ticket({ key: 'i2', identifier: 'ENG-2' })]
      })
    );
    assert.equal($(p, '#board-tickets .tb')?.textContent, '2');

    // A source that goes away takes the badge with it, label untouched.
    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: false } }));
    assert.equal($(p, '#board-tickets .tb'), null);
    assert.equal($(p, '#board-tickets .nm'), label);
  });

  it('opens a ticket and asks for a refresh', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();

    $(p, '#tk-list .tk .tkkey')?.click();
    $(p, '#tk-head .refresh')?.click();
    assert.ok(p.posted.some((m) => m.type === 'readTicket' && m.key === ticket().key));
    assert.ok(p.posted.some((m) => m.type === 'refreshTickets'));
  });

  it('marks the last good list stale when a refetch fails, and names the error', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: {
          ...ticketSourceView(),
          linked: true,
          stale: true,
          error: 'Linear responded 500'
        },
        tickets: [ticket()]
      })
    );
    assert.ok($(p, '#board-tickets .tb.warn'));
    $(p, '#board-tickets')?.click();
    assert.match($(p, '.tkstale')?.textContent ?? '', /last good list/);
    assert.match($(p, '.tkstale')?.textContent ?? '', /Linear responded 500/);
  });

  it('renders the filter bar from the space options and current selection', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();

    // Two pills, each naming its own current selection.
    const pills = p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill');
    assert.equal(pills.length, 3);
    assert.match(pills[0]?.textContent ?? '', /Me/, 'the assignee pill names the assignee');
    assert.match(pills[1]?.textContent ?? '', /In Progress/, 'the status pill names the status');
    // A filter narrower than everything is marked on, so it is visible at a glance.
    assert.ok(pills[1]?.classList.contains('on'));

    // Menus are built on demand; nothing is in the document until a pill is clicked.
    assert.equal(p.window.document.querySelectorAll('.fmenu.pmenu:not([hidden]) .mitem').length, 0);
    pills[0]?.click();
    assert.equal(items(p).length, 3, 'every assignee option is offered');
  });

  it('offers All then named people, with one selected viewer row for legacy me', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear() }));
    $(p, '#board-tickets')?.click();
    assert.match($(p, '#tk-filter .fpill')?.textContent ?? '', /sam \(Me\)/);
    $(p, '#tk-filter .fpill')?.click();
    assert.deepEqual(
      items(p).map((i) => i.querySelector('.nm')?.textContent ?? i.textContent),
      ['Anyone (All)', 'alex', 'sam (Me)']
    );
    assert.equal(items(p).filter((i) => i.getAttribute('aria-checked') === 'true').length, 1);
    items(p)
      .find((i) => i.textContent?.includes('alex'))
      ?.click();
    assert.equal(p.posted.at(-1)?.type, 'setTicketFilter');
    assert.ok(p.posted.some((m) => m.type === 'setTicketFilter' && m.filter.assignee === 'u_1'));
    $(p, '#tk-filter .fpill')?.click();
    items(p)
      .find((i) => i.textContent?.includes('sam (Me)'))
      ?.click();
    assert.ok(p.posted.some((m) => m.type === 'setTicketFilter' && m.filter.assignee === 'u_2'));
  });

  for (const assignee of ['u_1', 'me']) {
    it(`preserves ${assignee} without viewer identity and never marks an assumed Me`, (t) => {
      const p = openPanel(t);
      const source: TicketSourceStatus = filterLinear({ assignee });
      delete source.options!.viewerId;
      source.sourceId = 'another-provider';
      p.push(stateMessage([groupView()], { ticketSource: source }));
      $(p, '#board-tickets')?.click();
      assert.match(
        $(p, '#tk-filter .fpill')?.textContent ?? '',
        assignee === 'me' ? /Current user unavailable/ : /alex/
      );
      $(p, '#tk-filter .fpill')?.click();
      assert.deepEqual(
        items(p).map((i) => i.querySelector('.nm')?.textContent ?? i.textContent),
        ['Anyone (All)', 'alex', 'sam']
      );
      assert.equal(
        p.posted.some((m) => m.type === 'setTicketFilter'),
        false
      );
      items(p)[0]?.click();
      assert.ok(
        p.posted.some((m) => m.type === 'setTicketFilter' && m.filter.assignee === 'anyone')
      );
    });
  }

  it('summarises several chosen statuses on the one pill', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: ['name:To Do', 'name:In Progress'] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();

    const pills = p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill');
    assert.match(pills[1]?.textContent ?? '', /2 statuses/, 'the pill counts rather than grows');
  });

  it('says "Any status" when no state narrows the list', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], { ticketSource: filterLinear({ assignee: 'me', states: [] }) })
    );
    $(p, '#board-tickets')?.click();

    const pills = p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill');
    assert.match(pills[1]?.textContent ?? '', /Any status/);
    assert.ok(!pills[1]?.classList.contains('on'), 'an unnarrowed filter is not marked on');
  });

  it('posts a new filter when an assignee is picked, and closes the menu', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();

    $(p, '#tk-filter .fpill')?.click();
    items(p)
      .find((i) => i.textContent?.includes('Anyone'))
      ?.click();

    assert.ok(p.posted.some((m) => m.type === 'setTicketFilter' && m.filter.assignee === 'anyone'));
    assert.equal(items(p).length, 0, 'picking one closes the menu');
  });

  it('narrows the assignee menu as the user types', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-filter .fpill')?.click();

    const search = p.window.document.querySelector<HTMLInputElement>(
      '.fmenu.pmenu:not([hidden]) .fsearch'
    );
    assert.ok(search, 'the assignee menu offers a search box');
    if (search) {
      search.value = 'ale';
      search.dispatchEvent(new p.window.Event('input'));
    }
    const shown = items(p).map((i) => i.textContent);
    assert.equal(shown.length, 1);
    assert.match(shown[0] ?? '', /alex/);
  });

  it('toggles a status from the status menu and keeps it open for the next one', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: [] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();

    const status = p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1];
    status?.click();
    items(p)
      .find((i) => i.textContent?.includes('To Do'))
      ?.click();
    assert.deepEqual(p.posted.filter((m) => m.type === 'setTicketFilter').at(-1), {
      type: 'setTicketFilter',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      filter: { assignee: 'me', states: ['name:To Do'], priorities: [] }
    });

    // Multi-select: the menu is still open, and the second pick composes with the first.
    const second = items(p).find((i) => i.textContent?.includes('In Progress'));
    assert.ok(second, 'the status menu stays open after a toggle');
    second?.click();
    assert.deepEqual(p.posted.filter((m) => m.type === 'setTicketFilter').at(-1), {
      type: 'setTicketFilter',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      filter: { assignee: 'me', states: ['name:To Do', 'name:In Progress'], priorities: [] }
    });
  });

  it('does not rebuild the filter bar while a menu is open', (t) => {
    const p = openPanel(t);
    const linear = filterLinear();
    p.push(stateMessage([groupView()], { ticketSource: linear, tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();

    const pill = $(p, '#tk-filter .fpill');
    pill?.click();
    assert.ok(items(p).length);

    // A routine 3s state push arrives while the menu is open.
    p.push(stateMessage([groupView()], { ticketSource: linear, tickets: [ticket()] }));

    // The very same nodes survive — replaceChildren would have snapped the menu shut.
    assert.equal(p.window.document.querySelector('#tk-filter .fpill'), pill);
    assert.ok(items(p).length, 'the open menu is held still, not rebuilt');
  });

  // The hold is per bar, not global. It used to be `openMenu !== null`, so the
  // nav bar's theme picker — a control with nothing to do with tickets — froze
  // this bar for as long as it was open.
  it('goes on rebuilding the filter bar while settings is open', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();

    $(p, '#nav-actions .gear')?.click();
    assert.ok(
      p.window.document.querySelectorAll('#settings[open] .mrow').length,
      'the settings menu is open'
    );

    const moved = filterLinear({ assignee: 'u_1', states: [] });
    p.push(stateMessage([groupView()], { ticketSource: moved, tickets: [ticket()] }));

    assert.match(
      $(p, '#tk-filter .fpill')?.textContent ?? '',
      /alex/,
      'a menu in another bar must not hold this one'
    );
    assert.ok(
      p.window.document.querySelectorAll('#settings[open] .mrow').length,
      'and the menu that was open is still open'
    );
  });

  it('catches the held filter bar up once the menu closes', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-filter .fpill')?.click();

    // The filter changes elsewhere while the menu is open, and is held back.
    const moved = filterLinear({ assignee: 'u_1', states: [] });
    p.push(stateMessage([groupView()], { ticketSource: moved, tickets: [ticket()] }));
    assert.match($(p, '#tk-filter .fpill')?.textContent ?? '', /Me/);

    esc(p);
    p.push(stateMessage([groupView()], { ticketSource: moved, tickets: [ticket()] }));
    assert.match(
      $(p, '#tk-filter .fpill')?.textContent ?? '',
      /alex/,
      'the hold is released, not permanent'
    );
  });

  it('opens the other pill while one menu is open, and stays usable', (t) => {
    const p = openPanel(t);
    const linear = filterLinear();
    p.push(stateMessage([groupView()], { ticketSource: linear, tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();

    // Tab and Enter reach the other pill without a mousedown, so the
    // click-outside close never runs and the switch is handled by the pill.
    const pills = () => [...p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')];
    pills()[0]?.click();
    pills()[1]?.click();

    const rows = items(p).map((i) => i.textContent);
    assert.ok(
      rows.some((r) => r?.includes('To Do')),
      'the second pill opens its own menu'
    );
    assert.ok(
      !rows.some((r) => r?.includes('Anyone')),
      'the first menu is gone, not merely hidden'
    );

    // The bar is still live: a later push repaints it, and pills still open.
    p.push(
      stateMessage([groupView()], { ticketSource: filterLinear({ assignee: 'u_1', states: [] }) })
    );
    esc(p);
    p.push(
      stateMessage([groupView()], { ticketSource: filterLinear({ assignee: 'u_1', states: [] }) })
    );
    assert.match($(p, '#tk-filter .fpill')?.textContent ?? '', /alex/);
    pills()[0]?.click();
    assert.ok(items(p).length, 'the bar did not wedge on a detached menu');
  });

  it('keeps the assignee just picked when a status is toggled before the echo', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: [] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();

    const pills = () => [...p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')];
    pills()[0]?.click();
    items(p)
      .find((i) => i.textContent?.includes('alex'))
      ?.click();

    // The host has not answered yet: the refetch takes a poll or two.
    pills()[1]?.click();
    items(p)
      .find((i) => i.textContent?.includes('To Do'))
      ?.click();

    assert.deepEqual(p.posted.filter((m) => m.type === 'setTicketFilter').at(-1), {
      type: 'setTicketFilter',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      filter: { assignee: 'u_1', states: ['name:To Do'], priorities: [] }
    });
  });

  it('closes an open menu on Escape and gives focus back to the pill', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    const pill = $(p, '#tk-filter .fpill');
    pill?.click();
    assert.ok(items(p).length);

    esc(p);
    assert.equal(items(p).length, 0);
    assert.equal(p.window.document.activeElement, pill, 'focus lands back on the pill');
  });

  it('walks the menu rows with the arrow keys, wrapping at the end', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: [] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();

    const rows = items(p);
    key(p, 'ArrowDown');
    assert.equal(p.window.document.activeElement, rows[1]);
    key(p, 'ArrowUp');
    assert.equal(p.window.document.activeElement, rows[0]);
    key(p, 'ArrowUp');
    assert.equal(p.window.document.activeElement, rows.at(-1), 'it wraps to the last row');
  });

  // The other end of that walk, and the one thing `MENU_ROWS` has ever got
  // wrong: a footer button is a row too, and a *hidden* one is not. Clear hides
  // itself rather than its band when there is nothing to clear, so the walk has
  // to read the button's own attribute.
  it('walks onto a visible Clear, and past a hidden one', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: ['name:In Progress'] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();
    const clear = $(p, '.fmenu.pmenu:not([hidden]) .ffoot .fclear');
    assert.ok(clear && !(clear as HTMLElement & { hidden: boolean }).hidden, 'Clear is offered');

    items(p).at(-1)?.focus();
    key(p, 'ArrowDown');
    assert.equal(p.window.document.activeElement, clear, 'the walk stopped before Clear');

    // Nothing selected, so Clear hides itself — and the walk from the last row
    // wraps to the first instead of stalling on a button that is not there.
    esc(p);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({ assignee: 'me', states: [] }),
        tickets: [ticket()]
      })
    );
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();
    const rows = items(p);
    rows.at(-1)?.focus();
    key(p, 'ArrowDown');
    assert.equal(p.window.document.activeElement, rows[0], 'it stalled on the hidden Clear');
  });

  it('closes a ticket filter menu when switching to Sessions', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-filter .fpill')?.click();
    assert.ok(items(p).length);

    $(p, '#board-sessions')?.click();
    assert.equal(items(p).length, 0, 'no menu is left open behind a hidden tab');

    // And the bar is not still held open when the tab comes back.
    p.push(
      stateMessage([groupView()], { ticketSource: filterLinear({ assignee: 'u_1', states: [] }) })
    );
    $(p, '#board-tickets')?.click();
    assert.match($(p, '#tk-filter .fpill')?.textContent ?? '', /alex/);
  });

  it('drops an open menu when the source goes away', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-filter .fpill')?.click();

    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: false } }));
    assert.equal(items(p).length, 0);

    // Relinked, the bar builds again rather than staying held by a dead menu.
    p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: [ticket()] }));
    assert.equal(p.window.document.querySelectorAll('#tk-filter .fpill').length, 3);
  });

  it('lets a linked source be reconfigured with a new key', (t) => {
    const p = openPanel(t);
    // A bad key: linked, but the first fetch failed so there is no cached list.
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true, stale: true, error: '401' }
      })
    );
    $(p, '#board-tickets')?.click();

    // Nothing cached and the fetch failed: saying "Loading…" forever would lie.
    assert.match($(p, '.tkempty')?.textContent ?? '', /Could not load tickets/);

    const reconfigure = $(p, '#tk-head .reconfigure');
    assert.ok(reconfigure, 'a reconfigure button is offered so the user is not stuck');
    reconfigure?.click();
    assert.ok(p.posted.some((m) => m.type === 'connectTicketSource'));
  });

  /**
   * The priority pill is the one control that both narrows and orders, and the
   * two halves take different routes: the filter round-trips to Linear, the sort
   * never leaves the webview. Every test below asserts which of the two happened.
   */
  describe('the priority pill', () => {
    const prio = (p: ReturnType<typeof openPanel>) =>
      p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[2];

    /** A backlog spanning the scale, deliberately not in priority order. */
    const backlog = [
      ticket({ key: 'a', identifier: 'ENG-A', priority: ticketPriority(3) }),
      ticket({ key: 'b', identifier: 'ENG-B', priority: ticketPriority(0) }),
      ticket({ key: 'c', identifier: 'ENG-C', priority: ticketPriority(1) })
    ];
    const shown = (p: ReturnType<typeof openPanel>) =>
      [...p.window.document.querySelectorAll<HTMLElement>('#tk-list .tk .tkkey')].map(
        (n) => n.textContent
      );
    const open = (t: Parameters<typeof openPanel>[0]) => {
      const p = openPanel(t);
      p.push(stateMessage([groupView()], { ticketSource: filterLinear(), tickets: backlog }));
      $(p, '#board-tickets')?.click();
      return p;
    };
    const filters = (p: ReturnType<typeof openPanel>) =>
      p.posted.filter((m) => m.type === 'setTicketFilter');

    it('offers every priority the space named, in the order it was given them', (t) => {
      const p = open(t);
      prio(p)?.click();
      const rows = items(p).map((i) => i.textContent);
      assert.deepEqual(rows.slice(0, 5), ['Urgent', 'High', 'Medium', 'Low', 'No priority']);
    });

    it('posts the priorities picked, leaving the other facets alone', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent === 'Urgent')
        ?.click();
      items(p)
        .find((i) => i.textContent === 'High')
        ?.click();

      assert.deepEqual(filters(p).at(-1), {
        type: 'setTicketFilter',
        generation: 1,
        selectionSeq: 0,
        scopeId: 'team-a',
        filter: { assignee: 'me', states: ['name:In Progress'], priorities: ['1', '2'] }
      });
    });

    // The falsy-zero trap: "No priority" is value 0, and an `if (value)` anywhere
    // on the path turns picking it into picking nothing.
    it('treats No priority as a pick, not as an empty filter', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent === 'No priority')
        ?.click();

      assert.deepEqual(filters(p).at(-1)?.filter.priorities, ['0']);
      assert.ok(prio(p)?.classList.contains('on'), 'and the pill reads as narrowed');
    });

    it('reorders the list on a sort without asking the host for anything', (t) => {
      const p = open(t);
      assert.deepEqual(shown(p), ['ENG-A', 'ENG-B', 'ENG-C'], 'the fetched order');

      prio(p)?.click();
      items(p)
        .find((i) => i.textContent?.includes('Most urgent'))
        ?.click();

      assert.deepEqual(shown(p), ['ENG-C', 'ENG-A', 'ENG-B'], 'No priority sinks below Medium');
      assert.equal(filters(p).length, 0, 'a sort reorders what is already here');
    });

    it('reverses the order on the other direction, No priority still last', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent?.includes('Least urgent'))
        ?.click();

      assert.deepEqual(shown(p), ['ENG-B', 'ENG-A', 'ENG-C']);
    });

    it('gives the fetched order back when the same direction is picked again', (t) => {
      const p = open(t);
      prio(p)?.click();
      const asc = () => items(p).find((i) => i.textContent?.includes('Most urgent'));
      asc()?.click();
      assert.deepEqual(shown(p), ['ENG-C', 'ENG-A', 'ENG-B']);

      asc()?.click();
      assert.deepEqual(shown(p), ['ENG-A', 'ENG-B', 'ENG-C'], 'a re-pick clears the sort');
    });

    it('keeps the menu open across direction clicks', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent?.includes('Most urgent'))
        ?.click();
      assert.ok(
        items(p).some((i) => i.textContent?.includes('Least urgent')),
        'picking a direction is not the end of the interaction'
      );
    });

    // The only thing a closed pill can say about a sort, and the reason it is
    // said at all: a sort nobody can see is a sort nobody remembers turning on.
    it('wears the direction on the pill, and drops it when cleared', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent?.includes('Most urgent'))
        ?.click();
      assert.match(prio(p)?.textContent ?? '', /↑/);
      assert.ok(prio(p)?.classList.contains('on'));

      $(p, '.fmenu.pmenu:not([hidden]) .fclear')?.click();
      assert.doesNotMatch(prio(p)?.textContent ?? '', /↑|↓/);
      assert.deepEqual(shown(p), ['ENG-A', 'ENG-B', 'ENG-C'], 'and the order goes back');
    });

    // A menu whose whole body scrolled put Clear below the last row, so a long
    // list — every port in a block, every workflow on the machine — pushed the
    // one way out of a pick off the bottom of the popover.
    it('keeps Clear out of the block that scrolls', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent?.includes('Most urgent'))
        ?.click();

      assert.ok($(p, '.fmenu.pmenu:not([hidden]) .fscroll .mitem'), 'the rows are what scrolls');
      assert.ok($(p, '.fmenu.pmenu:not([hidden]) .ffoot .fclear'), 'Clear is in the footer');
      assert.equal(
        $(p, '.fmenu.pmenu:not([hidden]) .fscroll .fclear'),
        null,
        'and not in the scroller'
      );
    });

    it('clears the picks and the sort together', (t) => {
      const p = open(t);
      prio(p)?.click();
      items(p)
        .find((i) => i.textContent === 'Urgent')
        ?.click();
      items(p)
        .find((i) => i.textContent?.includes('Most urgent'))
        ?.click();

      $(p, '.fmenu.pmenu:not([hidden]) .fclear')?.click();
      assert.deepEqual(filters(p).at(-1)?.filter.priorities, []);
      assert.ok(!prio(p)?.classList.contains('on'));
    });

    it('offers no search box for a scale this short', (t) => {
      const p = open(t);
      prio(p)?.click();
      assert.equal(
        p.window.document.querySelectorAll('.fmenu.pmenu:not([hidden]) .fsearch').length,
        0,
        'five rows do not need finding'
      );
    });
  });

  it('offers connect from inside the empty tab too', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: false } }));
    $(p, '#board-tickets')?.click();

    const connect = $(p, '#tk-list .tksrc');
    assert.ok(connect);
    connect?.click();
    assert.ok(p.posted.some((m) => m.type === 'connectTicketSource'));
  });
});

/**
 * The list is repainted by every 3 s push while the tab is up, and a row
 * replaced between a mousedown and a mouseup takes the click with it: the press
 * dispatches on `#tk-list`, where the delegated listener finds no `[data-act]`
 * and returns. Keyed by ticket id and morphed, the row under the pointer is the
 * same element after the paint — and it is still the same *ticket*, which is
 * the half a positional morph would get wrong.
 */
describe('a ticket row under a press keeps its ticket', () => {
  const one = ticket();
  const two = ticket({
    key: 'i2',
    identifier: 'ENG-2',
    title: 'another bug',
    priority: ticketPriority(1),

    url: 'https://linear.app/x/ENG-2'
  });
  /** The backlog, in the order the host last sent it. */
  const backlog = (tickets: TicketView[]) =>
    stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: true }, tickets });

  it('keeps the identifier through a repaint that reorders the list', (t) => {
    const p = openPanel(t);
    p.push(backlog([one, two]));
    $(p, '#board-tickets')?.click();
    const aimed = $(p, '#tk-list .tk .tkkey');
    assert.equal(aimed?.textContent, 'ENG-1', 'nothing to aim at');

    // The other ticket is raised to the top under the press.
    p.push(backlog([two, one]));
    assert.ok(
      aimed && p.window.document.contains(aimed),
      'the repaint swept the row from under the press'
    );
    assert.equal(aimed.textContent, 'ENG-1', 'the identifier changed under the pointer');

    aimed.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'readTicket',
      requestId: detailRequestId(p),
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      key: one.key
    });
  });
});

describe('the tickets tab, laned by status', () => {
  const todo = ticket({ key: 'i2', identifier: 'ENG-2', state: ticketState('To Do') });
  /** A backlog with the options the lanes take their order from. */
  // `filterLinear({})` on purpose: its default narrows to one status, and a
  // narrowed bar is the one case where the other lanes are meant to be gone.
  const laned = (tickets: TicketView[], filter = filterLinear({})) =>
    stateMessage([groupView()], { ticketSource: filter, tickets });
  const lanes = (p: ReturnType<typeof openPanel>) => [
    ...p.window.document.querySelectorAll<HTMLElement>('#tk-list .lane')
  ];
  const laneOf = (p: ReturnType<typeof openPanel>, name: string) =>
    lanes(p).find((l) => l.querySelector('.lname')?.textContent === name);

  it('splits the list into one lane per state, in the order options give', (t) => {
    const p = openPanel(t);
    p.push(laned([ticket(), todo]));
    $(p, '#board-tickets')?.click();

    assert.deepEqual(
      lanes(p).map((l) => l.querySelector('.lname')?.textContent),
      ['To Do', 'In Progress'],
      'lanes are not in options.states order'
    );
    assert.equal(laneOf(p, 'To Do')?.querySelectorAll('.tk').length, 1);
    assert.equal(
      laneOf(p, 'In Progress')?.querySelector('.tk .tkkey')?.textContent,
      'ENG-1',
      'the row landed in the wrong lane'
    );
  });

  it('keeps an emptied lane on screen, counted zero', (t) => {
    const p = openPanel(t);
    p.push(laned([ticket()]));
    $(p, '#board-tickets')?.click();

    const empty = laneOf(p, 'To Do');
    assert.ok(empty, 'the lane with nothing in it vanished, so the tab changes shape');
    assert.equal(empty.querySelector('.ln')?.textContent, '0');
    assert.equal(laneOf(p, 'In Progress')?.querySelector('.ln')?.textContent, '1');
  });

  it('drops the lanes the status filter narrowed away', (t) => {
    // The one thing that removes a lane. Asking for `In Progress` alone and
    // still being shown a `To Do` lane at zero is the filter looking broken.
    const p = openPanel(t);
    p.push(laned([ticket()], filterLinear({ states: ['name:In Progress'] })));
    $(p, '#board-tickets')?.click();

    assert.deepEqual(
      lanes(p).map((l) => l.querySelector('.lname')?.textContent),
      ['In Progress']
    );
  });

  it('shuts a lane on a click and keeps it shut through a repaint', (t) => {
    const p = openPanel(t);
    p.push(laned([ticket(), todo]));
    $(p, '#board-tickets')?.click();

    const head = laneOf(p, 'In Progress')?.querySelector<HTMLElement>('.lhead');
    head?.click();
    assert.ok(laneOf(p, 'In Progress')?.classList.contains('shut'));
    assert.ok(!laneOf(p, 'To Do')?.classList.contains('shut'), 'the click shut every lane');

    // The 3 s push rebuilds every row; a lane that reopened here would spring
    // back open on its own every three seconds.
    p.push(laned([todo, ticket()]));
    assert.ok(laneOf(p, 'In Progress')?.classList.contains('shut'), 'the repaint reopened it');
    assert.equal(laneOf(p, 'In Progress')?.querySelector('.ln')?.textContent, '1');

    laneOf(p, 'In Progress')?.querySelector<HTMLElement>('.lhead')?.click();
    assert.ok(!laneOf(p, 'In Progress')?.classList.contains('shut'), 'it would not reopen');
  });

  it('sorts inside a lane rather than across the list', (t) => {
    const p = openPanel(t);
    p.push(
      laned([
        ticket({ key: 'a', identifier: 'A-4', priority: ticketPriority(4) }),
        ticket({ key: 'b', identifier: 'B-1', priority: ticketPriority(1) }),
        ticket({
          key: 'c',
          identifier: 'C-2',
          priority: ticketPriority(2),
          state: ticketState('To Do')
        })
      ])
    );
    $(p, '#board-tickets')?.click();
    // The priority pill owns the sort. Its menu stays open across a direction
    // click, so the lanes are read while it is.
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[2]?.click();
    items(p)
      .find((i) => i.textContent?.includes('Most urgent'))
      ?.click();

    assert.deepEqual(
      [...(laneOf(p, 'In Progress')?.querySelectorAll('.tkkey') ?? [])].map((n) => n.textContent),
      ['B-1', 'A-4'],
      'the lane is not ordered by urgency'
    );
    assert.equal(
      laneOf(p, 'To Do')?.querySelectorAll('.tk').length,
      1,
      'the sort pulled a row out of its lane'
    );
  });

  it('gives a state the options never mentioned a lane of its own', (t) => {
    // `options` is fetched once per key and cached, so a state added to the
    // workspace since arrives on a ticket with nothing to match. Dropping the
    // row would be losing a ticket; it goes in a trailing lane instead.
    const p = openPanel(t);
    p.push(
      laned([ticket(), ticket({ key: 'i9', identifier: 'ENG-9', state: ticketState('Blocked') })])
    );
    $(p, '#board-tickets')?.click();

    assert.deepEqual(
      lanes(p).map((l) => l.querySelector('.lname')?.textContent),
      ['To Do', 'In Progress', 'Blocked'],
      'the unknown state was dropped, or jumped the known ones'
    );
    assert.equal(laneOf(p, 'Blocked')?.querySelector('.tk .tkkey')?.textContent, 'ENG-9');
  });

  it('keeps tickets without a status name in a reachable recovery column', (t) => {
    const p = openPanel(t);
    p.push(laned([ticket(), ticket({ key: 'i9', identifier: 'ENG-9', state: ticketState('') })]));
    $(p, '#board-tickets')?.click();

    const unknown = laneOf(p, 'Unknown status');
    assert.ok(unknown, 'a ticket without a status name disappeared');
    assert.equal(unknown.querySelector('.ln')?.textContent, '1');
    unknown.querySelector<HTMLElement>('.tkkey')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'readTicket',
      requestId: detailRequestId(p),
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      key: 'i9'
    });
  });

  it('keeps custom states separate in a keyboard reachable column region across pushes', (t) => {
    const p = openPanel(t);
    const linear = filterLinear({});
    linear.options.states = [
      ticketState('Building'),
      ticketState('In Review'),
      ticketState('Ready to Ship')
    ];
    const push = () =>
      p.push(
        stateMessage([groupView()], {
          ticketSource: linear,
          tickets: [ticket({ state: ticketState('In Review') })]
        })
      );
    push();
    $(p, '#board-tickets')?.click();
    const region = $(p, '#tk-list [role="region"]');
    assert.equal(region?.getAttribute('aria-label'), 'Ticket status columns');
    assert.equal(region?.tabIndex, 0);
    assert.deepEqual(
      lanes(p).map((l) => l.querySelector('.lname')?.textContent),
      ['Building', 'In Review', 'Ready to Ship']
    );
    const row = laneOf(p, 'In Review')?.querySelector('.tk');
    push();
    assert.equal($(p, '#tk-list [role="region"]'), region);
    assert.equal(laneOf(p, 'In Review')?.querySelector('.tk'), row);
    assert.equal(laneOf(p, 'Building')?.querySelector('.ln')?.textContent, '0');
  });

  it('stays a flat list until the options that order the lanes arrive', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket(), todo]
      })
    );
    $(p, '#board-tickets')?.click();

    assert.equal(lanes(p).length, 0, 'lanes were drawn in an order nothing supplied');
    assert.equal(p.window.document.querySelectorAll('#tk-list .tk').length, 2);
  });
});

describe('the tickets tab, reachable without a pointer', () => {
  it('keeps the whole ticket action reachable by keyboard', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: { ...ticketSourceView(), linked: true },
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();

    assert.equal($(p, '#tk-list .tk')?.tagName, 'BUTTON');
    assert.equal($(p, '#tk-list .tk .handoff'), null);
  });

  it('makes the lane header a button that says whether its lane is open', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        ticketSource: filterLinear({}),
        tickets: [ticket(), ticket({ key: 'i2', identifier: 'ENG-2', state: ticketState('To Do') })]
      })
    );
    $(p, '#board-tickets')?.click();

    const head = () =>
      [...p.window.document.querySelectorAll<HTMLElement>('#tk-list .lane')]
        .find((l) => l.querySelector('.lname')?.textContent === 'In Progress')
        ?.querySelector<HTMLElement>('.lhead');
    assert.equal(head()?.tagName, 'BUTTON');
    assert.equal(head()?.getAttribute('aria-expanded'), 'true');
    assert.equal(head()?.getAttribute('aria-label'), 'Collapse In Progress');

    head()?.click();
    assert.equal(head()?.getAttribute('aria-expanded'), 'false');
    assert.equal(head()?.getAttribute('aria-label'), 'Expand In Progress');

    head()?.click();
    assert.equal(head()?.getAttribute('aria-expanded'), 'true');
    assert.equal(head()?.getAttribute('aria-label'), 'Collapse In Progress');
  });
});

describe('the filter that matched nothing', () => {
  const narrowed = filterLinear({ states: ['name:To Do'], priorities: ['1'] });

  it('offers a way back, and clears both facets without touching the assignee', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: narrowed, tickets: [] }));
    $(p, '#board-tickets')?.click();

    const clear = $(p, '#tk-list .tkempty .tkclear');
    assert.ok(clear, 'an empty list narrowed by the bar offers no way out of it');
    clear.click();

    assert.deepEqual(p.posted.filter((m) => m.type === 'setTicketFilter').at(-1), {
      type: 'setTicketFilter',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      filter: { assignee: 'me', states: [], priorities: [] }
    });
  });

  it('shows stale option selections as active narrowing with an explicit way to clear', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([], {
        ticketSource: filterLinear({ states: ['name:Removed'], priorities: ['retired'] }),
        tickets: []
      })
    );
    $(p, '#board-tickets')?.click();
    const pills = p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill');
    assert.match(pills[1]?.textContent ?? '', /1 status/);
    assert.match(pills[2]?.textContent ?? '', /1 priority/);
    $(p, '#tk-list .tkclear')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'setTicketFilter',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      filter: { assignee: 'me', states: [], priorities: [] }
    });
  });

  it('says nothing to clear when the bar narrowed nothing', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { ticketSource: filterLinear({}), tickets: [] }));
    $(p, '#board-tickets')?.click();

    assert.ok($(p, '#tk-list .tkempty'), 'the empty line went missing');
    assert.equal($(p, '#tk-list .tkempty .tkclear'), null);
  });
});

describe('a non-Linear ticket source', () => {
  it('uses opaque state values, explicit priority order and source presentation', (t) => {
    const p = openPanel(t);
    const source: TicketSourceStatus = ticketSourceView({
      sourceId: 'markdown:acme/tasks/work',
      token: { generation: 7, selectionSeq: 0, scopeId: 'team-a' },
      scopeId: 'team-a',
      presentation: { label: 'Markdown tracker' },
      filter: { assignee: 'anyone', states: [], priorities: [] },
      options: {
        scopeId: 'team-a',
        assignees: [],
        states: [
          { value: 'left', label: 'Done', order: 2 },
          { value: 'right', label: 'Done', order: 1 }
        ],
        priorities: [
          { value: 'important', label: 'Important', order: 20, tone: 'high' },
          { value: 'routine', label: 'Routine', order: 90, tone: 'low' }
        ]
      }
    });
    const rows: TicketView[] = [
      {
        scopeId: 'team-a',
        key: '["repo-a","1"]',
        identifier: 'ENG-1',
        title: 'Routine task',
        url: 'https://example.test/1',
        state: { value: 'right', label: 'Done' },
        priority: { value: 'routine', label: 'Routine', order: 90, tone: 'low' }
      },
      {
        scopeId: 'team-a',
        key: '["repo-b","1"]',
        identifier: 'ENG-1',
        title: 'Important task',
        url: 'https://example.test/2',
        state: { value: 'right', label: 'Done' },
        priority: { value: 'important', label: 'Important', order: 20, tone: 'high' }
      },
      {
        scopeId: 'team-a',
        key: '["repo-a","2"]',
        identifier: 'ENG-2',
        title: 'Other state',
        url: 'https://example.test/3',
        state: { value: 'left', label: 'Done' },
        priority: { value: 'routine', label: 'Routine', order: 90, tone: 'low' }
      }
    ];
    p.push(stateMessage([], { ticketSource: source, tickets: rows }));
    $(p, '#board-tickets')?.click();
    assert.equal($(p, '#tk-head .scope-button .nm')?.textContent, 'Engineering');
    assert.equal($(p, '#tk-head .reconfigure'), null);
    assert.equal(p.window.document.querySelectorAll('#tk-filter .fpill').length, 2);
    const lanes = [...p.window.document.querySelectorAll<HTMLElement>('#tk-list .lane')];
    assert.deepEqual(
      lanes.map((l) => l.querySelector('.ln')?.textContent),
      ['2', '1']
    );
    lanes[0]?.querySelector<HTMLElement>('.lhead')?.click();
    assert.equal(lanes[0]?.classList.contains('shut'), true);
    assert.equal(lanes[1]?.classList.contains('shut'), false);
    lanes[0]?.querySelector<HTMLElement>('.lhead')?.click();
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();
    items(p)
      .find((i) => i.textContent?.includes('Most urgent'))
      ?.click();
    const first = $(p, '#tk-list .tk');
    assert.equal(first?.querySelector('.tktitle')?.textContent, 'Important task');
    assert.ok(first?.querySelector('.dot.tone-high'));
    assert.equal(first?.getAttribute('aria-label'), 'View ENG-1 details');
    first?.querySelector<HTMLElement>('.tkkey')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'readTicket',
      requestId: detailRequestId(p),
      generation: 7,
      selectionSeq: 0,
      scopeId: 'team-a',
      key: rows[1]!.key
    });
  });

  it('drops pending picks and open menus when the connection generation changes', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([], { ticketSource: filterLinear({}), tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();
    items(p)
      .find((i) => i.textContent === 'To Do')
      ?.click();
    p.push(
      stateMessage([], {
        ticketSource: {
          ...filterLinear({}),
          token: { generation: 2, selectionSeq: 0, scopeId: 'team-a' }
        },
        tickets: [ticket()]
      })
    );
    assert.equal($(p, '#tk-filter .fpill[aria-expanded="true"]'), null);
    p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[2]?.click();
    items(p)
      .find((i) => i.textContent === 'Urgent')
      ?.click();
    const posted = p.posted.filter((m) => m.type === 'setTicketFilter').at(-1);
    assert.equal(posted?.generation, 2);
    assert.deepEqual(posted?.filter.states, []);
  });
});

describe('selected team toolbar', () => {
  it('keeps rows, filters and scroll when the current ready board is selected again', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([], {
        ticketSource: filterLinear({ priorities: ['2'] }),
        tickets: [ticket()]
      })
    );
    $(p, '#board-tickets')?.click();
    const row = $(p, '#tk-list .tk');
    const filter = $(p, '#tk-filter')?.textContent;
    const list = $(p, '#tk-list');
    assert.ok(list);
    list.scrollTop = 70;
    $(p, '#tk-source .scope-button')?.click();
    $(p, '#tk-source .mitem.on')?.click();
    assert.equal(p.posted.filter((m) => m.type === 'selectTicketScope').length, 0);
    assert.equal($(p, '#tk-list .tk'), row);
    assert.equal($(p, '#tk-filter')?.textContent, filter);
    assert.equal(list.scrollTop, 70);
    assert.equal($(p, '#tk-source .scope-button')?.getAttribute('aria-expanded'), 'false');
  });

  it('updates an open discovery picker when its catalog arrives without changing selection', (t) => {
    const p = openPanel(t);
    const pending = ticketSourceView({ scopes: undefined, scopeId: undefined, loading: true });
    p.push(stateMessage([], { ticketSource: pending }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-source .scope-button')?.click();
    const search = p.window.document.querySelector<HTMLInputElement>('#tk-source .fsearch');
    assert.ok(search);
    search.value = 'Operations';
    search.dispatchEvent(new p.window.Event('input'));
    p.push(
      stateMessage([], {
        ticketSource: { ...pending, loading: false, scopes: ticketSourceView().scopes }
      })
    );
    assert.equal(p.window.document.activeElement, search);
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#tk-source .mitem')].map((row) => row.textContent),
      ['Linear / Operations']
    );
    const choice = $(p, '#tk-source .mitem');
    choice?.focus();
    p.push(
      stateMessage([], {
        ticketSource: { ...pending, loading: false, scopes: ticketSourceView().scopes }
      })
    );
    assert.equal(p.window.document.activeElement, choice);
    $(p, '#tk-source .mitem')?.click();
    assert.equal(p.posted.at(-1)?.type, 'selectTicketScope');
  });

  it('shows pending refresh and Retry feedback while retaining the same board snapshot', (t) => {
    const p = openPanel(t);
    const source = filterLinear({});
    p.push(stateMessage([], { ticketSource: source, tickets: [ticket()] }));
    $(p, '#board-tickets')?.click();
    const row = $(p, '#tk-list .tk');
    const pending = {
      ...source,
      loading: true,
      stale: true,
      failure: 'service' as const,
      error: 'Offline'
    };
    p.push(stateMessage([], { ticketSource: pending, tickets: [ticket()] }));
    assert.match($(p, '#tk-actions')?.textContent ?? '', /Refreshing/);
    assert.equal($(p, '#tk-actions .refresh')?.hasAttribute('disabled'), true);
    assert.equal($(p, '[data-act="retryTickets"]')?.hasAttribute('disabled'), true);
    assert.equal($(p, '#tk-list .tk'), row);
    p.push(stateMessage([], { ticketSource: source, tickets: [ticket()] }));
    assert.doesNotMatch($(p, '#tk-actions')?.textContent ?? '', /Refreshing/);
    assert.equal($(p, '#tk-actions .refresh')?.hasAttribute('disabled'), false);
  });

  it('searches service/team rows and focuses its result for native button activation', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([], { ticketSource: filterLinear({}), tickets: [] }));
    $(p, '#board-tickets')?.click();
    $(p, '#tk-source .scope-button')?.click();
    const search = p.window.document.querySelector<HTMLInputElement>('#tk-source .fsearch');
    assert.ok(search);
    assert.equal(p.window.document.activeElement, search);
    search.value = '  OPERATIONS  ';
    search.dispatchEvent(new p.window.Event('input'));
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#tk-source .mitem')].map((row) => row.textContent),
      ['Linear / Operations']
    );
    key(p, 'ArrowDown');
    const focused = p.window.document.activeElement as HTMLElement;
    assert.equal(focused.textContent, 'Linear / Operations');
    focused.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'selectTicketScope',
      generation: 1,
      selectionSeq: 1,
      scopeId: 'team-b'
    });
  });
  it('retains workflow columns with zero counts for an empty selected team', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([], { ticketSource: filterLinear({}), tickets: [] }));
    $(p, '#board-tickets')?.click();
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#tk-list .lane .ln')].map((node) => node.textContent),
      ['0', '0']
    );
  });

  it('switches immediately, resets filters, and ignores old echoes through B to A before echo', (t) => {
    const p = openPanel(t);
    const state = () =>
      stateMessage([], { ticketSource: filterLinear({ priorities: ['1'] }), tickets: [ticket()] });
    p.push(state());
    $(p, '#board-tickets')?.click();
    const pick = (label: string) => {
      $(p, '#tk-source .fpill')?.click();
      const option = [...p.window.document.querySelectorAll<HTMLElement>('#tk-source .mitem')].find(
        (n) => n.textContent?.includes(label)
      );
      assert.ok(option);
      option.click();
    };
    pick('Operations');
    assert.equal($(p, '#tk-list .tk'), null);
    assert.equal($(p, '#tk-filter .fpill'), null);
    pick('Engineering');
    assert.deepEqual(
      p.posted.filter((m) => m.type === 'selectTicketScope'),
      [
        { type: 'selectTicketScope', generation: 1, selectionSeq: 1, scopeId: 'team-b' },
        { type: 'selectTicketScope', generation: 1, selectionSeq: 2, scopeId: 'team-a' }
      ]
    );
    p.push(state());
    assert.equal($(p, '#tk-list .tk'), null);
    assert.match($(p, '#tk-source')?.textContent ?? '', /Engineering/);
    p.push(
      stateMessage([], {
        ticketSource: {
          ...filterLinear(),
          token: { generation: 1, selectionSeq: 2, scopeId: 'team-a' },
          filter: { assignee: 'anyone', states: [], priorities: [] }
        },
        tickets: []
      })
    );
    assert.ok($(p, '#tk-filter .fpill'));
    assert.equal($(p, '#tk-list .tk'), null);
  });
  it('returns to the served board when the host refuses a pick, but not for an overtaken one', (t) => {
    const p = openPanel(t);
    const state = () => stateMessage([], { ticketSource: filterLinear({}), tickets: [ticket()] });
    p.push(state());
    $(p, '#board-tickets')?.click();
    const pick = (label: string) => {
      $(p, '#tk-source .fpill')?.click();
      const option = [...p.window.document.querySelectorAll<HTMLElement>('#tk-source .mitem')].find(
        (n) => n.textContent?.includes(label)
      );
      assert.ok(option);
      option.click();
    };
    const refused = (selectionSeq: number, scopeId: string) =>
      p.push({ type: 'ticketScopeChoice', landed: false, generation: 1, selectionSeq, scopeId });
    pick('Operations');
    pick('Engineering');
    refused(1, 'team-b');
    p.push(state());
    assert.equal($(p, '#tk-list .tk'), null);
    pick('Operations');
    p.push(state());
    refused(3, 'team-b');
    assert.ok($(p, '#tk-list .tk'));
    assert.match($(p, '#tk-source')?.textContent ?? '', /Engineering/);
    assert.doesNotMatch($(p, '#tk-list')?.textContent ?? '', /Loading/);
  });
  it('renders service errors literally and Retry keeps the selected identity', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([], {
        ticketSource: ticketSourceView({ stale: true, failure: 'service', error: '<b>Denied</b>' })
      })
    );
    $(p, '#board-tickets')?.click();
    assert.match($(p, '#tk-list')?.textContent ?? '', /<b>Denied<\/b>/);
    assert.equal($(p, '#tk-list b'), null);
    assert.equal(
      p.window.document.querySelectorAll('#tk-list > *').length,
      1,
      'a failed first load should have one error state, without a second empty message'
    );
    assert.equal($(p, '#tk-list .tkcolumns'), null);
    assert.equal($(p, '#tk-list [role="alert"]')?.textContent?.includes('<b>Denied</b>'), true);
    $(p, '[data-act="retryTickets"]')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'refreshTickets',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a'
    });
  });
  it('offers Update credentials only for an explicit credential rejection', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([], {
        ticketSource: ticketSourceView({
          failure: 'credentials',
          stale: true,
          error: 'Invalid API key'
        })
      })
    );
    $(p, '#board-tickets')?.click();
    const action = $(p, '#tk-list [data-act="connect"]');
    assert.equal(action?.textContent, 'Update credentials');
    action?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'connectTicketSource',
      generation: 1,
      selectionSeq: 0,
      scopeId: 'team-a',
      provider: 'linear'
    });
  });
});
