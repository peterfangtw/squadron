import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TicketSourceError } from '../../core/tickets';
import { LinearSource, LINEAR_ENDPOINT, trackerEndpoint } from '../../core/tickets/linear';

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
    const source = new LinearSource('token', 'https://tracker.example.test/graphql');
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
    const rows = await source.issues('team-a', { ...ALL, states: ['s1'] });
    assert.equal(rows[0]?.key, '["linear","iss_1"]');
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
    const outOfRange = { ...first, id: 'iss_9', identifier: 'ENG-109', priority: 9 };
    const noPriority = { ...last, id: 'iss_null', identifier: 'ENG-100', priority: null };
    const noState = {
      id: 'iss_state',
      identifier: 'ENG-110',
      title: 'no state',
      priority: 3,
      url: 'https://linear.app/acme/issue/ENG-110'
    };
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      assert.match(body.query, /includeArchived: false/);
      calls.push(body.variables);
      const issues =
        body.variables.after === undefined
          ? page([first], 'next')
          : page([first, last, outOfRange, noPriority, noState]);
      return Promise.resolve(new Response(JSON.stringify({ data: { issues } })));
    });
    const rows = await new LinearSource('token').issues('team-a', {
      assignee: 'user-9',
      states: ['state-ready'],
      priorities: ['2']
    });
    const [a, b, clamped, blank, stateless] = rows;
    assert.equal(a?.identifier, 'ENG-101');
    assert.equal(a?.priority?.label, 'High');
    assert.equal(a?.state.value, 'state-ready');
    assert.equal(a?.state.label, 'Ready to Ship');
    assert.equal(a?.branchName, 'sam/eng-101-fe-saved-addresses');
    assert.equal(a?.assignee, 'Sam');
    assert.equal(b?.identifier, 'ENG-102');
    assert.equal(b?.priority?.label, 'None');
    assert.equal(b?.state.value, 'state-todo');
    assert.equal(b?.state.label, 'To Do');
    assert.equal(b?.branchName, undefined);
    assert.equal(b?.assignee, undefined);
    assert.equal(clamped?.identifier, 'ENG-109');
    assert.equal(clamped?.priority?.label, 'None');
    assert.equal(blank?.identifier, 'ENG-100');
    assert.equal(blank?.priority?.label, 'None');
    assert.equal(stateless?.identifier, 'ENG-110');
    assert.equal(stateless?.priority?.label, 'Medium');
    assert.equal(stateless?.state.value, '');
    assert.equal(stateless?.state.label, '');
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
        new LinearSource('token').issues('team-a', ALL),
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
      new LinearSource('token').issues('team-a', ALL, controller.signal),
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
        new LinearSource('token').issues('team-a', ALL),
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
    await assert.rejects(new LinearSource('token').issues('team-a', ALL), /incomplete/i);
  });
  it('rejects a node missing an identifier instead of returning the other tickets', async (t) => {
    t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              issues: page([
                response.issues.nodes[0],
                { id: 'x', title: 'no identifier', url: 'https://linear.app/acme/issue/x' }
              ])
            }
          })
        )
      )
    );
    await assert.rejects(new LinearSource('token').issues('team-a', ALL), (error) => {
      assert.ok(error instanceof TicketSourceError);
      assert.equal(error.kind, 'service');
      assert.equal(error.message, 'Linear returned an incomplete response.');
      return true;
    });
  });
  it('rejects an empty scope or a non-numeric priority before fetch', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', () => {
      calls += 1;
      return Promise.resolve(new Response('{}'));
    });
    const source = new LinearSource('token');
    for (const read of [
      () => source.issues('', ALL),
      () => source.issues('team-a', { ...ALL, priorities: ['urgent'] })
    ]) {
      await assert.rejects(read(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof TicketSourceError, false);
        assert.equal(error.message, 'Invalid Linear ticket filter');
        return true;
      });
    }
    assert.equal(calls, 0);
  });
  it('posts me and unassigned as assignee filters', async (t) => {
    const filters: unknown[] = [];
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { variables: { filter: unknown } };
      filters.push(body.variables.filter);
      return Promise.resolve(new Response(JSON.stringify({ data: { issues: page([]) } })));
    });
    const source = new LinearSource('token');
    await source.issues('team-a', { ...ALL, assignee: 'me' });
    await source.issues('team-a', { ...ALL, assignee: 'unassigned' });
    await source.issues('team-a', ALL);
    assert.deepEqual(filters, [
      { assignee: { isMe: { eq: true } }, team: { id: { eq: 'team-a' } } },
      { assignee: { null: true }, team: { id: { eq: 'team-a' } } },
      { team: { id: { eq: 'team-a' } } }
    ]);
  });
  it('omits a priority it cannot label and keeps the rest of the menu', async (t) => {
    t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { query: string };
      const data = body.query.includes('TicketMembers')
        ? {
            team: {
              members: page([
                { id: 'u_2', name: 'sam' },
                { id: 'u_1', displayName: 'alex' }
              ])
            }
          }
        : body.query.includes('TicketStates')
          ? {
              team: {
                states: page([
                  { id: 'ready', name: 'Ready to Ship', type: 'started', position: 3 },
                  { id: 'todo', name: 'To Do', type: 'unstarted', position: 1 },
                  { id: 'backlog', name: 'Backlog', type: 'backlog', position: 0 },
                  { id: 'todo', name: 'To Do', type: 'unstarted', position: 999 },
                  { id: 'progress', name: 'In Progress', type: 'started', position: 2 }
                ])
              }
            }
          : {
              viewer: { id: 'u_3', displayName: 'Robin' },
              issuePriorityValues: [
                { priority: 0, label: 'No priority' },
                { priority: 1, label: 'Urgent' },
                { priority: 2, label: 'High' },
                { priority: 3, label: 'Medium' },
                { priority: 4, label: 'Low' },
                { priority: 2 },
                { label: 'Later' }
              ]
            };
      return Promise.resolve(new Response(JSON.stringify({ data })));
    });
    const options = await new LinearSource('token').options('team-a');
    assert.deepEqual(
      options.priorities.map((priority) => priority.label),
      ['Urgent', 'High', 'Medium', 'Low', 'No priority']
    );
    assert.deepEqual(
      options.states.map((state) => state.label),
      ['Backlog', 'To Do', 'In Progress', 'Ready to Ship']
    );
    assert.deepEqual(
      options.assignees.map((person) => ({ id: person.id, label: person.label })),
      [
        { id: 'anyone', label: 'Anyone' },
        { id: 'unassigned', label: 'Unassigned' },
        { id: 'u_1', label: 'alex' },
        { id: 'u_2', label: 'sam' }
      ]
    );
    assert.equal(options.viewerId, 'u_3');
    assert.equal(
      options.assignees.some((person) => person.id === 'u_3'),
      false
    );
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
  });
});

describe('Linear reads and their options memo', () => {
  /** A team with one state, counting each query by its operation; `hold` parks the next options read. */
  function tracker(t: import('node:test').TestContext) {
    const calls = { options: 0, issues: [] as unknown[] };
    const held: (() => void)[] = [];
    let hold = false;
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      fetches++;
      const body = JSON.parse(init?.body as string) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes('issuePriorityValues')) {
        calls.options++;
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
      }
      if (body.query.includes('Backlog')) calls.issues.push(body.variables.filter);
      const data = body.query.includes('TicketMembers')
        ? { team: { members: page([]) } }
        : body.query.includes('TicketStates')
          ? { team: { states: page([{ id: 's1', name: 'Todo', type: 'unstarted' }]) } }
          : body.query.includes('issuePriorityValues')
            ? { viewer: { id: 'me' }, issuePriorityValues: [{ priority: 1, label: 'Urgent' }] }
            : { issues: page(response.issues.nodes) };
      return new Response(JSON.stringify({ data }));
    });
    return {
      calls,
      held,
      fetches: () => fetches,
      hold: (on: boolean) => {
        hold = on;
      }
    };
  }

  it('reuses one read of a team options for later filter changes on that team', async (t) => {
    const { calls } = tracker(t);
    const source = new LinearSource('token');
    const first = await source.read('team-a', ALL);
    assert.deepEqual(
      first.options.states.map((s) => s.value),
      ['s1']
    );
    assert.equal(calls.options, 1);
    const filtered = await source.read('team-a', { ...ALL, states: ['s1'] });
    assert.equal(calls.options, 1);
    assert.deepEqual(filtered.filter.states, ['s1']);
    assert.deepEqual(filtered.options, first.options);
    assert.equal(calls.issues.length, 2);
    await source.read('team-b', ALL);
    assert.equal(calls.options, 2, 'another team reads its own options');
  });

  it('reads options again after invalidate, and keeps no answer that invalidate overtook', async (t) => {
    const fake = tracker(t);
    const source = new LinearSource('token');
    await source.read('team-a', ALL);
    source.invalidate();
    fake.hold(true);
    const overtaken = source.read('team-a', ALL);
    for (let spin = 0; !fake.held.length; spin++) {
      assert.ok(spin < 1000, 'the read after invalidate never asked for options');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fake.calls.options, 2);
    source.invalidate();
    fake.hold(false);
    fake.held.shift()!();
    await overtaken;
    await source.read('team-a', ALL);
    assert.equal(fake.calls.options, 3, 'the overtaken options were memoised');
  });

  it('prunes a state the options do not list before the issues request', async (t) => {
    const { calls } = tracker(t);
    const read = await new LinearSource('token').read('team-a', {
      ...ALL,
      states: ['s1', 'gone'],
      priorities: ['1', '3']
    });
    assert.deepEqual(read.filter, { ...ALL, states: ['s1'], priorities: ['1'] });
    assert.deepEqual(calls.issues, [
      { team: { id: { eq: 'team-a' } }, state: { id: { in: ['s1'] } }, priority: { in: [1] } }
    ]);
  });

  it('arms one walk budget for a read of options and issues', async (t) => {
    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      timeouts.push(ms);
      return timeout.call(AbortSignal, ms);
    });
    const { calls, fetches } = tracker(t);
    const read = await new LinearSource('token').read('team-a', ALL);
    assert.ok(read.tickets.length > 0);
    assert.equal(calls.options, 1);
    assert.equal(calls.issues.length, 1);
    assert.equal(timeouts.filter((ms) => ms === 30_000).length, 1);
    assert.equal(timeouts.filter((ms) => ms === 15_000).length, fetches());
  });
});
