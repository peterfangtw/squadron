import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  issueFilter,
  LinearSource,
  LINEAR_ENDPOINT,
  priorityName,
  toOptions,
  toTickets,
  trackerEndpoint,
  urgency
} from '../../core/tickets/linear';

/**
 * A Linear `issues` response, shaped exactly as the live API returned it during
 * the Step 1 probe (a real workspace, 2026-07-25): raw `priority` int, `state`
 * with `name`/`type`, `branchName`, nested `assignee.displayName`.
 */
const response = {
  issues: {
    nodes: [
      {
        id: 'iss_1',
        identifier: 'ENG-101',
        title: '[FE] saved addresses widget',
        priority: 2,
        url: 'https://linear.app/acme/issue/ENG-101',
        branchName: 'sam/eng-101-fe-saved-addresses',
        state: { id: 'state-ready', name: 'Ready to Ship', type: 'started' },
        assignee: { displayName: 'Sam' }
      },
      {
        id: 'iss_2',
        identifier: 'ENG-102',
        title: 'consume saved address data',
        priority: 0,
        url: 'https://linear.app/acme/issue/ENG-102',
        branchName: null,
        state: { id: 'state-todo', name: 'To Do', type: 'unstarted' },
        assignee: null
      }
    ]
  }
};

describe('priorityName', () => {
  it('maps the tracker scale, and falls back to None', () => {
    assert.equal(priorityName(0), 'None');
    assert.equal(priorityName(1), 'Urgent');
    assert.equal(priorityName(2), 'High');
    assert.equal(priorityName(3), 'Medium');
    assert.equal(priorityName(4), 'Low');
    assert.equal(priorityName(9), 'None');
  });
});

describe('toTickets', () => {
  it('maps a live-shaped response into tickets', () => {
    const tickets = toTickets(response, 'team-a');
    assert.equal(tickets.length, 2);

    const [a, b] = tickets;
    assert.equal(a?.identifier, 'ENG-101');
    assert.equal(a?.priority.label, 'High');
    assert.equal(a?.state.value, 'state-ready');
    assert.equal(a?.state.label, 'Ready to Ship');
    assert.equal(a?.branchName, 'sam/eng-101-fe-saved-addresses');
    assert.equal(a?.assignee, 'Sam');

    // A null branch/assignee collapses to undefined, not the string "null".
    assert.equal(b?.branchName, undefined);
    assert.equal(b?.assignee, undefined);
    assert.equal(b?.priority.label, 'None');
  });

  it('skips a node missing an identifier or title, keeps the rest', () => {
    const dirty = {
      issues: {
        nodes: [
          { id: 'x', title: 'no identifier', url: 'u', state: {} },
          { id: 'y', identifier: 'ENG-9', url: 'u', state: {} }, // no title
          {
            id: 'z',
            identifier: 'ENG-10',
            title: 'good',
            url: 'https://l/ENG-10',
            priority: 1,
            state: { id: 'state-todo', name: 'To Do', type: 'unstarted' }
          }
        ]
      }
    };
    const tickets = toTickets(dirty, 'team-a');
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.identifier, 'ENG-10');
  });

  it('is empty for a shape it does not recognise', () => {
    assert.deepEqual(toTickets(undefined, 'team-a'), []);
    assert.deepEqual(toTickets({}, 'team-a'), []);
    assert.deepEqual(toTickets({ issues: {} }, 'team-a'), []);
  });
});

describe('issueFilter', () => {
  it('always scopes by native team ID and uses native state/person IDs and numeric priorities', () => {
    assert.deepEqual(
      issueFilter(
        { assignee: 'user-9', states: ['state-ready'], priorities: ['0', '2'] },
        'team-a'
      ),
      {
        team: { id: { eq: 'team-a' } },
        state: { id: { in: ['state-ready'] } },
        assignee: { id: { eq: 'user-9' } },
        priority: { in: [0, 2] }
      }
    );
    assert.deepEqual(issueFilter({ assignee: 'anyone', states: [], priorities: [] }, 'team-a'), {
      team: { id: { eq: 'team-a' } }
    });
    assert.deepEqual(issueFilter({ assignee: 'me', states: [], priorities: [] }, 'team-a'), {
      team: { id: { eq: 'team-a' } },
      assignee: { isMe: { eq: true } }
    });
    assert.throws(() => issueFilter({ assignee: 'anyone', states: [], priorities: [] }, ''));
    assert.throws(() =>
      issueFilter({ assignee: 'anyone', states: [], priorities: ['urgent'] }, 'team-a')
    );
  });
});

describe('urgency', () => {
  it('sinks No priority below every named one', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4].sort((a, b) => urgency(a) - urgency(b)),
      [1, 2, 3, 4, 0]
    );
  });

  it('leaves the named ones in their own order', () => {
    assert.deepEqual([1, 2, 3, 4].map(urgency), [1, 2, 3, 4]);
  });
});

describe('toOptions', () => {
  const response = {
    users: {
      nodes: [
        { id: 'u_2', displayName: 'sam', name: 'Sam' },
        { id: 'u_1', displayName: 'alex', name: 'alex@example.com' }
      ]
    },
    workflowStates: {
      nodes: [
        { id: 'ready', name: 'Ready to Ship', type: 'started', position: 3 },
        { id: 'todo', name: 'To Do', type: 'unstarted', position: 1 },
        { id: 'backlog', name: 'Backlog', type: 'backlog', position: 0 },
        { id: 'todo', name: 'To Do', type: 'unstarted', position: 999 }, // dupe across a team
        { id: 'progress', name: 'In Progress', type: 'started', position: 2 }
      ]
    },
    // Linear hands the scale back in value order, "No priority" first, and
    // labels it itself — the vocabulary this code refuses to keep a table of.
    issuePriorityValues: [
      { priority: 0, label: 'No priority' },
      { priority: 1, label: 'Urgent' },
      { priority: 2, label: 'High' },
      { priority: 3, label: 'Medium' },
      { priority: 4, label: 'Low' }
    ]
  };

  it('takes the priority labels from the tracker, ordered by urgency', () => {
    const { priorities } = toOptions(response, 'team-a');
    assert.deepEqual(
      priorities.map((p) => p.label),
      ['Urgent', 'High', 'Medium', 'Low', 'No priority'],
      'value order would lead with No priority, which is the least urgent'
    );
    assert.deepEqual(
      priorities.map((p) => p.value),
      ['1', '2', '3', '4', '0']
    );
  });

  it('skips a priority it cannot read rather than inventing a label', () => {
    const { priorities } = toOptions(
      {
        ...response,
        issuePriorityValues: [{ priority: 1, label: 'Urgent' }, { priority: 2 }, { label: 'Low' }]
      },
      'team-a'
    );
    assert.deepEqual(priorities, [{ value: '1', label: 'Urgent', order: 1, tone: 'urgent' }]);
  });

  it('offers Anyone and Unassigned then real users sorted by label without synthetic Me', () => {
    const { assignees } = toOptions(response, 'team-a');
    assert.deepEqual(
      assignees.map((a) => a.id),
      ['anyone', 'unassigned', 'u_1', 'u_2']
    );
    assert.equal(assignees[2]?.label, 'alex');
  });

  it('identifies the viewer without adding a person outside the selected team', () => {
    for (const viewer of [undefined, null, {}, { id: 1 }, { id: '' }]) {
      assert.equal(toOptions({ ...response, viewer }, 'team-a').viewerId, undefined);
    }
    const included = toOptions({ ...response, viewer: { id: 'u_2', name: 'Sam' } }, 'team-a');
    assert.equal(included.viewerId, 'u_2');
    assert.equal(included.assignees.filter((a) => a.id === 'u_2').length, 1);
    const outside = toOptions(
      { ...response, viewer: { id: 'u_3', displayName: 'Robin' } },
      'team-a'
    );
    assert.equal(outside.viewerId, 'u_3');
    assert.ok(!outside.assignees.some((a) => a.id === 'u_3'));
  });

  it('dedupes states by native ID and orders them by workflow type', () => {
    const { states } = toOptions(response, 'team-a');
    assert.deepEqual(
      states.map((s) => s.label),
      ['Backlog', 'To Do', 'In Progress', 'Ready to Ship']
    );
  });

  it('is safe for a shape it does not recognise', () => {
    assert.deepEqual(toOptions(undefined, 'team-a'), {
      scopeId: 'team-a',
      assignees: [
        { id: 'anyone', label: 'Anyone' },
        { id: 'unassigned', label: 'Unassigned' }
      ],
      states: [],
      priorities: []
    });
  });
});

describe('trackerEndpoint', () => {
  const evil = 'https://tracker.example.test/graphql';

  it('is Linear when nothing has set it', () => {
    assert.equal(trackerEndpoint(undefined), LINEAR_ENDPOINT);
    assert.equal(trackerEndpoint({}), LINEAR_ENDPOINT);
  });

  it('ignores a workspace value, which a cloned repo can write', () => {
    assert.equal(trackerEndpoint({ workspaceValue: evil }), LINEAR_ENDPOINT);
    assert.equal(trackerEndpoint({ workspaceFolderValue: evil }), LINEAR_ENDPOINT);
  });

  it('does not let a workspace value beat the user one', () => {
    const mine = 'http://127.0.0.1:9000/graphql';
    assert.equal(trackerEndpoint({ globalValue: mine, workspaceValue: evil }), mine);
  });

  it('takes a user value, trimmed — the smoke suite writes one', () => {
    assert.equal(
      trackerEndpoint({ globalValue: '  http://127.0.0.1:9000/graphql ' }),
      'http://127.0.0.1:9000/graphql'
    );
  });

  it('falls back when the user value is blank', () => {
    assert.equal(trackerEndpoint({ globalValue: '   ' }), LINEAR_ENDPOINT);
  });
});

const page = (nodes: unknown[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!endCursor, endCursor }
});
const ALL: TicketFilterView = { assignee: 'anyone', states: [], priorities: [] };

describe('scoped Linear transport', () => {
  it('discovers every team, independently paginates scoped people/states, and preserves native identities', async (t) => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      const after = body.variables.after;
      const data = body.query.includes('TicketScopes')
        ? {
            teams: after
              ? page([{ id: 'team-b', key: 'OPS', name: 'Operations' }])
              : page([{ id: 'team-a', key: 'ENG', name: 'Engineering' }], 'team-next')
          }
        : body.query.includes('TicketMembers')
          ? {
              team: {
                members: after
                  ? page([{ id: 'u2', name: 'Two' }])
                  : page([{ id: 'u1', name: 'One' }], 'people-next')
              }
            }
          : body.query.includes('TicketStates')
            ? {
                team: {
                  states: after
                    ? page([{ id: 's2', name: 'Ready', type: 'started', position: 2 }])
                    : page(
                        [{ id: 's1', name: 'Ready', type: 'unstarted', position: 1 }],
                        'states-next'
                      )
                }
              }
            : body.query.includes('issuePriorityValues')
              ? {
                  viewer: { id: 'u1', displayName: 'One' },
                  issuePriorityValues: [{ priority: 1, label: 'Urgent' }]
                }
              : { issues: page(response.issues.nodes) };
      return Promise.resolve(new Response(JSON.stringify({ data })));
    });
    const source = new LinearSource(
      'token',
      'https://tracker.example.test/graphql',
      'connection-one'
    );
    assert.deepEqual(
      (await source.discoverScopes()).map((scope) => scope.id),
      ['team-a', 'team-b']
    );
    const options = await source.options('team-a');
    assert.equal(options.scopeId, 'team-a');
    assert.deepEqual(
      options.states.map((s) => s.value),
      ['s1', 's2']
    );
    assert.deepEqual(
      options.assignees.map((p) => p.id),
      ['anyone', 'unassigned', 'u1', 'u2']
    );
    const rows = await source.list('team-a', { ...ALL, states: ['s1'] });
    assert.equal(rows[0]?.key, '["connection-one","iss_1"]');
    assert.equal(rows[0]?.state.value, 'state-ready');
    assert.equal(rows[0]?.scopeId, 'team-a');
    assert.ok(
      calls
        .filter((call) => /TicketMembers|TicketStates/.test(call.query))
        .every((call) => call.variables.scopeId === 'team-a')
    );
    assert.deepEqual(calls.at(-1)?.variables.filter, {
      team: { id: { eq: 'team-a' } },
      state: { id: { in: ['s1'] } }
    });
  });
  it('fetches the complete filtered board and deduplicates issues repeated across pages', async (t) => {
    const calls: Record<string, unknown>[] = [];
    const first = response.issues.nodes[0]!;
    const last = response.issues.nodes[1]!;
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      assert.match(body.query, /includeArchived: false/);
      calls.push(body.variables);
      const issues =
        body.variables.after === undefined ? page([first], 'next') : page([first, last]);
      return Promise.resolve(new Response(JSON.stringify({ data: { issues } })));
    });
    const rows = await new LinearSource('token').list('team-a', {
      assignee: 'user-9',
      states: ['state-ready'],
      priorities: ['2']
    });
    assert.deepEqual(
      rows.map((row) => row.identifier),
      ['ENG-101', 'ENG-102']
    );
    assert.deepEqual(
      calls.map((call) => call.after),
      [undefined, 'next']
    );
    for (const call of calls)
      assert.deepEqual(call.filter, {
        team: { id: { eq: 'team-a' } },
        assignee: { id: { eq: 'user-9' } },
        state: { id: { in: ['state-ready'] } },
        priority: { in: [2] }
      });
  });
  it('rejects a failed or malformed later issue page instead of returning a partial board', async (t) => {
    for (const later of [
      { errors: [{ message: 'Rate limited' }] },
      { data: { issues: { nodes: [] } } },
      { data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
      { data: { issues: page([], 'next') } }
    ]) {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', () =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              ++calls === 1 ? { data: { issues: page(response.issues.nodes, 'next') } } : later
            )
          )
        )
      );
      await assert.rejects(
        new LinearSource('token').list('team-a', ALL),
        /Rate limited|incomplete/i
      );
      assert.equal(calls, 2);
    }
  });
  it('cancels an issue page walk without returning already fetched rows', async (t) => {
    const controller = new AbortController();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      if (++calls === 1)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: { issues: page(response.issues.nodes, 'next') }
            })
          )
        );
      assert.ok(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
        controller.abort();
      });
    });
    await assert.rejects(
      new LinearSource('token').list('team-a', ALL, controller.signal),
      /abort/i
    );
    assert.equal(calls, 2);
  });
  it('rejects incomplete catalogs and failed later pages instead of claiming a sole or empty team', async (t) => {
    for (const broken of [
      { teams: { nodes: [] } },
      { teams: page([{ id: 42, key: 'ENG', name: 'Engineering' }]) },
      { teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }
    ]) {
      t.mock.method(globalThis, 'fetch', () =>
        Promise.resolve(new Response(JSON.stringify({ data: broken })))
      );
      await assert.rejects(new LinearSource('token').discoverScopes(), /incomplete/i);
    }
    let count = 0;
    t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            ++count === 1
              ? { data: { teams: page([{ id: 'a', key: 'ENG', name: 'Engineering' }], 'next') } }
              : { errors: [{ message: 'Rate limited' }] }
          )
        )
      )
    );
    await assert.rejects(new LinearSource('token').discoverScopes(), /Rate limited/);
  });
  it('distinguishes rejected credentials from access denial and preserves parsed HTTP/GraphQL messages', async (t) => {
    for (const [status, body, kind, message] of [
      [401, { errors: [{ message: 'Key revoked' }] }, 'credentials', 'Key revoked'],
      [
        200,
        { errors: [{ message: 'Sign in', extensions: { code: 'UNAUTHENTICATED' } }] },
        'credentials',
        'Sign in'
      ],
      [403, { errors: [{ message: 'Team access denied' }] }, 'service', 'Team access denied'],
      [429, { message: 'Please wait' }, 'service', 'Please wait'],
      [
        200,
        { data: response, errors: [{ message: 'Partial failure' }] },
        'service',
        'Partial failure'
      ]
    ] as const) {
      t.mock.method(globalThis, 'fetch', () =>
        Promise.resolve(new Response(JSON.stringify(body), { status }))
      );
      await assert.rejects(
        new LinearSource('token').list('team-a', ALL),
        (error) =>
          error instanceof Error &&
          error.message === message &&
          'kind' in error &&
          error.kind === kind
      );
    }
  });
  it('bounds requests with a signal, refuses incomplete required options, and supports retirement cancellation', async (t) => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      assert.ok(init?.signal);
      assert.equal(init.signal.aborted, true);
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    controller.abort();
    await assert.rejects(new LinearSource('token').discoverScopes(controller.signal));
    t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ data: {} })))
    );
    await assert.rejects(new LinearSource('token').options('team-a'), /incomplete/i);
    await assert.rejects(new LinearSource('token').list('team-a', ALL), /incomplete/i);
  });
});

describe('individual Linear details', () => {
  it('reads only common fields and preserves Markdown and native identities', async (t) => {
    let returned: unknown = {
      id: 'issue-a',
      identifier: 'ENG-42',
      title: 'Title',
      url: 'https://example.test/ENG-42',
      team: { id: 'team-a' },
      state: { id: 'state-a', name: 'Custom review' },
      assignee: { id: 'person-a', displayName: 'Sam' },
      description: '## Heading\n\n**body**'
    };
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { query: string; variables: unknown };
      assert.deepEqual(body.variables, { id: 'issue-a' });
      assert.match(body.query, /issue\(id: \$id\)/);
      assert.doesNotMatch(body.query, /comments|labels|cycles|priority|descriptionData/);
      return Promise.resolve(new Response(JSON.stringify({ data: { issue: returned } })));
    });
    const source = new LinearSource('token');
    const read = await source.detail('team-a', 'issue-a');
    assert.equal(read.description, '## Heading\n\n**body**');
    assert.deepEqual(read.assignee, { id: 'person-a', label: 'Sam' });
    assert.deepEqual(read.state, { value: 'state-a', label: 'Custom review' });
    assert.equal(read.key, '["linear","issue-a"]');
    returned = { ...(returned as object), description: null, assignee: null };
    const empty = await source.detail('team-a', 'issue-a');
    assert.equal(empty.description, '');
    assert.equal(empty.assignee, null);
    for (const invalid of [
      null,
      {},
      { ...(returned as object), team: { id: 'team-b' } },
      { ...(returned as object), description: 42 }
    ]) {
      returned = invalid;
      await assert.rejects(source.detail('team-a', 'issue-a'), /incomplete/);
    }
    assert.deepEqual(issueFilter({ ...ALL, assignee: 'unassigned' }, 'team-a'), {
      team: { id: { eq: 'team-a' } },
      assignee: { null: true }
    });
    assert.deepEqual(issueFilter(ALL, 'team-a'), { team: { id: { eq: 'team-a' } } });
  });
});
