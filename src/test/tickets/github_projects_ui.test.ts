import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import { openPanel, stateMessage } from '../harness';
import { ticketSourceView } from '../ticket_fixtures';

it('explains hidden content, preserves readable issues and offers credential recovery', (t) => {
  const p = openPanel(t);
  const source = ticketSourceView({
    sourceId: 'github',
    boards: [],
    presentation: {
      label: 'GitHub',
      connectLabel: 'Connect GitHub Projects',
      connectHint: 'Connect GitHub Projects',
      reconfigureLabel: 'Update GitHub Projects credentials'
    },
    options: {
      scopeId: 'team-a',
      assignees: [],
      states: [],
      priorities: [],
      accessWarning: 'Some project items are hidden. Check the classic token’s repo scope.'
    }
  });
  const row: TicketView = {
    scopeId: 'team-a',
    key: 'visible',
    identifier: 'acme/web#12',
    title: 'Readable issue',
    url: 'https://github.com/acme/web/issues/12',
    state: { value: '', label: 'No status' }
  };
  p.push(stateMessage([], { ticketSource: source, tickets: [row] }));
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  assert.equal(p.window.document.querySelector('.tkkey')?.textContent, 'acme/web#12');
  const warning = p.window.document.querySelector<HTMLElement>('#tk-list [role="status"]');
  assert.match(warning?.textContent ?? '', /repo/);
  warning?.querySelector('button')?.click();
  assert.deepEqual(p.posted.at(-1), {
    type: 'connectTicketSource',
    sourceId: 'github',
    generation: 1,
    selectionSeq: 0,
    scopeId: 'team-a'
  });
  p.push(stateMessage([], { ticketSource: source, tickets: [] }));
  assert.doesNotMatch(
    p.window.document.querySelector('#tk-list')?.textContent ?? '',
    /No tickets match/
  );
  p.push(
    stateMessage([], {
      ticketSource: { ...source, options: { ...source.options!, accessWarning: undefined } },
      tickets: []
    })
  );
  assert.equal(p.window.document.querySelector('#tk-list [data-key="access-warning"]'), null);
  assert.match(p.window.document.querySelector('#tk-list')?.textContent ?? '', /No tickets match/);
});

it('shows explained unavailable facets, a No status lane and no invented priority', (t) => {
  const p = openPanel(t);
  p.push(
    stateMessage([], {
      tickets: [
        {
          scopeId: 'p',
          key: 'item',
          identifier: 'acme/web#12',
          title: 'Fix',
          url: 'https://github.com/acme/web/issues/12',
          state: { value: '', label: 'No status' }
        }
      ],
      ticketSource: ticketSourceView({
        sourceId: 'github',
        scopeId: 'p',
        options: {
          scopeId: 'p',
          assignees: [],
          states: [],
          priorities: [],
          noStatusLane: true,
          unavailable: {
            states: 'No usable single-select field named "Status" was found in this project.',
            priorities: 'No usable single-select field named "Priority" was found in this project.'
          }
        }
      })
    })
  );
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  const wrappers = [
    ...p.window.document.querySelectorAll<HTMLElement>('#tk-filter [aria-disabled="true"]')
  ];
  assert.equal(wrappers.length, 2);
  for (const wrapper of wrappers) {
    assert.equal(wrapper.tabIndex, 0);
    assert.match(wrapper.getAttribute('aria-label') ?? '', /No usable single-select/);
    assert.ok(wrapper.dataset.tip);
    assert.ok(wrapper.querySelector('button:disabled'));
  }
  assert.equal(p.window.document.querySelector('.lname')?.textContent, 'No status');
  assert.equal(p.window.document.querySelector('.tkid')?.textContent, 'acme/web#12');
});

it('selects colliding board IDs by source and exposes another connection', (t) => {
  const p = openPanel(t);
  const linear = ticketSourceView().presentation;
  const github: TicketSourcePresentation = {
    label: 'GitHub',
    mark: 'github',
    connectLabel: 'Connect GitHub',
    connectHint: 'Connect GitHub'
  };
  p.push(
    stateMessage([], {
      tickets: [],
      ticketSource: ticketSourceView({
        boards: [
          {
            id: 'team-a',
            key: 'A',
            label: 'Engineering',
            sourceId: 'linear',
            presentation: linear
          },
          { id: 'team-a', key: 'A', label: 'Engineering', sourceId: 'github', presentation: github }
        ],
        connections: [
          { sourceId: 'linear', presentation: linear },
          { sourceId: 'github', presentation: github }
        ]
      })
    })
  );
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  p.window.document.querySelector<HTMLElement>('.scope-button')?.click();
  const choice = [...p.window.document.querySelectorAll<HTMLElement>('.mitem')].find((n) =>
    n.textContent?.includes('GitHub / Engineering')
  );
  assert.ok(choice);
  choice.click();
  const selection = p.posted.filter((m) => m.type === 'selectTicketScope').at(-1);
  assert.equal(selection?.sourceId, 'github');
  assert.equal(selection?.scopeId, 'team-a');
});

it('uses native priority sort labels and leaves unset priority last in either direction', (t) => {
  const p = openPanel(t);
  const state = { value: 'ready', label: 'Ready', order: 0 };
  const high: TicketPriority = { value: 'native-a', label: 'Custom A', order: 0, tone: 'none' };
  const low: TicketPriority = { value: 'native-b', label: 'Custom B', order: 1, tone: 'none' };
  const make = (key: string, priority?: TicketPriority): TicketView => ({
    scopeId: 'p',
    key,
    identifier: key,
    title: key,
    url: 'https://example.test/' + key,
    state,
    ...(priority ? { priority } : {})
  });
  p.push(
    stateMessage([], {
      tickets: [make('Unset'), make('B', low), make('A', high)],
      ticketSource: ticketSourceView({
        scopeId: 'p',
        options: {
          scopeId: 'p',
          assignees: [],
          states: [state],
          priorities: [high, low],
          prioritySort: { asc: 'Project order first', desc: 'Project order reversed' }
        }
      })
    })
  );
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  p.window.document.querySelectorAll<HTMLElement>('#tk-filter .fpill')[1]?.click();
  const item = (name: string) =>
    [...p.window.document.querySelectorAll<HTMLElement>('.fmenu.pmenu:not([hidden]) .mitem')].find(
      (n) => n.textContent?.includes(name)
    );
  const shown = () => [...p.window.document.querySelectorAll('.tkkey')].map((n) => n.textContent);
  const asc = item('Project order first');
  assert.ok(asc);
  asc.click();
  assert.deepEqual(shown(), ['A', 'B', 'Unset']);
  const desc = item('Project order reversed');
  assert.ok(desc);
  desc.click();
  assert.deepEqual(shown(), ['B', 'A', 'Unset']);
});

it('offers a source-addressed disconnect action for a connected provider', (t) => {
  const p = openPanel(t);
  const presentation = ticketSourceView().presentation;
  p.push(
    stateMessage([], {
      tickets: [],
      ticketSource: ticketSourceView({
        sourceId: 'github',
        connections: [
          {
            sourceId: 'github',
            presentation: { ...presentation, label: 'GitHub', disconnectLabel: 'Disconnect GitHub' }
          }
        ]
      })
    })
  );
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  p.window.document.querySelector<HTMLElement>('.scope-button')?.click();
  const action = [...p.window.document.querySelectorAll<HTMLElement>('.mitem')].find(
    (n) => n.textContent === 'Disconnect GitHub'
  );
  assert.ok(action);
  action.click();
  assert.deepEqual(p.posted.at(-1), {
    type: 'disconnectTicketSource',
    provider: 'github',
    generation: 1,
    selectionSeq: 0,
    scopeId: 'team-a'
  });
});

it('settles a pending assignee pick when a complete refreshed population removes that person', (t) => {
  const p = openPanel(t);
  const source = ticketSourceView({
    options: {
      scopeId: 'team-a',
      assigneesComplete: true,
      assignees: [
        { id: 'anyone', label: 'Anyone' },
        { id: 'person', label: 'Alex' }
      ],
      states: [],
      priorities: []
    },
    filter: { assignee: 'anyone', states: [], priorities: [] }
  });
  p.push(stateMessage([], { ticketSource: source, tickets: [] }));
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  p.window.document.querySelector<HTMLElement>('#tk-filter .fpill')?.click();
  [...p.window.document.querySelectorAll<HTMLElement>('.mitem')]
    .find((n) => n.textContent === 'Alex')
    ?.click();
  assert.equal(
    p.posted.filter((m) => m.type === 'setTicketFilter').at(-1)?.filter.assignee,
    'person'
  );
  p.push(
    stateMessage([], {
      tickets: [],
      ticketSource: {
        ...source,
        options: { ...source.options!, assignees: [{ id: 'anyone', label: 'Anyone' }] }
      }
    })
  );
  assert.match(
    p.window.document.querySelector('#tk-filter .fpill')?.textContent ?? '',
    /Anyone \(All\)/
  );
});

it('separates connection actions without adding a Linear disconnect row', (t) => {
  const p = openPanel(t);
  const source = ticketSourceView();
  p.push(
    stateMessage([], {
      tickets: [],
      ticketSource: {
        ...source,
        connections: [{ sourceId: 'linear', presentation: source.presentation }]
      }
    })
  );
  p.window.document.querySelector<HTMLElement>('#board-tickets')?.click();
  p.window.document.querySelector<HTMLElement>('.scope-button')?.click();
  assert.ok(p.window.document.querySelector('#tk-source [role="separator"]'));
  assert.equal(
    [...p.window.document.querySelectorAll('.mitem')].some((n) =>
      n.textContent?.startsWith('Disconnect ')
    ),
    false
  );
});
