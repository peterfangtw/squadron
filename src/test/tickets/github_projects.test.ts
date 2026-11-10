import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as github from '../../core/tickets/github';

const page = (nodes: unknown[], next: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next }
});
const field = (id: string, name: string, options = [{ id: 'one', name: 'Ready' }]) => ({
  __typename: 'ProjectV2SingleSelectField',
  id,
  name,
  options
});
const issue = {
  __typename: 'Issue',
  id: 'issue',
  number: 12,
  title: 'Fix',
  body: 'Description',
  url: 'https://github.com/acme/web/issues/12',
  repository: { nameWithOwner: 'acme/web' },
  assignees: page([{ id: 'a', login: 'alex' }], 'people2')
};
const item = {
  id: 'item',
  isArchived: false,
  project: { id: 'p' },
  content: issue,
  fieldValues: page([{ optionId: 'one', field: { id: 'status' } }], 'values2')
};

it('paginates project data, preserves item identity and multiple people, and normalizes unavailable filters', async (t) => {
  let fields = [
    field('status', 'sTaTuS'),
    field('priority', 'Priority', [{ id: 'native', name: 'Custom rank' }])
  ];
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    const { query, variables: v } = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, string>;
    };
    calls.push(query);
    let data: unknown;
    if (query.includes('GithubOwner'))
      data = { repositoryOwner: { __typename: 'Organization', id: 'owner' }, viewer: { id: 'b' } };
    else if (query.includes('GithubProjects'))
      data = {
        node: {
          projectsV2: v.after
            ? page([{ id: 'p', title: 'Engineering', number: 2 }])
            : page([], 'projects2')
        }
      };
    else if (query.includes('GithubFields'))
      data = {
        node: { fields: v.after ? page(fields.slice(1)) : page(fields.slice(0, 1), 'fields2') }
      };
    else if (query.includes('GithubItems'))
      data = v.after
        ? { node: { items: page([]) } }
        : {
            node: {
              items: page(
                [
                  item,
                  { ...item, id: 'archived', isArchived: true },
                  { ...item, id: 'pr', content: { __typename: 'PullRequest' } },
                  { ...item, id: 'hidden', content: null }
                ],
                'items2'
              )
            }
          };
    else if (query.includes('GithubValues'))
      data = { node: { fieldValues: page([{ optionId: 'native', field: { id: 'priority' } }]) } };
    else if (query.includes('GithubAssignees'))
      data = { node: { assignees: page([{ id: 'b', login: 'sam' }]) } };
    else if (query.includes('GithubDetail')) data = { node: item };
    else throw new Error('Unexpected query');
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
  });
  const source = new github.GithubSource('secret', 'acme');
  assert.deepEqual(await source.discoverScopes(), [{ id: 'p', key: '2', label: 'Engineering' }]);
  const filter = { assignee: 'b', states: ['one'], priorities: ['native'] };
  const result = await source.read('p', filter);
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.id, 'item');
  assert.equal(result.tickets[0]?.identifier, 'acme/web#12');
  assert.equal(result.tickets[0]?.priority?.label, 'Custom rank');
  assert.equal(result.tickets[0]?.priority?.tone, 'none');
  assert.equal(
    result.options.assignees.filter((p) => !['anyone', 'unassigned'].includes(p.id)).length,
    2
  );
  assert.equal(calls.filter((q) => q.includes('GithubFields')).length, 2);
  assert.equal(calls.filter((q) => q.includes('GithubItems')).length, 2);
  const detail = await source.detail('p', 'item');
  assert.deepEqual(
    detail.assignees?.map((p) => p.label),
    ['alex', 'sam']
  );
  await assert.rejects(source.detail('other', 'item'));
  fields = [field('status', 'Workflow'), field('priority', 'Severity')];
  source.invalidate();
  const missing = await source.read('p', filter);
  assert.equal(missing.tickets.length, 1);
  assert.equal(missing.tickets[0]?.priority, undefined);
  assert.equal(missing.tickets[0]?.state.label, 'No status');
  assert.deepEqual(missing.filter, { assignee: 'b', states: [], priorities: [] });
  assert.match(missing.options.unavailable?.states ?? '', /Status/);
});

it('rejects ambiguous or wrong-type fields without aliases or issue-state inference', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    const q = JSON.parse(init.body as string).query as string;
    const data = q.includes('GithubFields')
      ? {
          node: {
            fields: page([
              field('s1', 'Status'),
              field('s2', 'STATUS'),
              { __typename: 'ProjectV2Field', id: 'p', name: 'Priority' }
            ])
          }
        }
      : q.includes('GithubItems')
        ? {
            node: {
              items: page([
                { ...item, content: { ...issue, assignees: page([]) }, fieldValues: page([]) }
              ])
            }
          }
        : { viewer: { id: 'viewer' } };
    return Promise.resolve(new Response(JSON.stringify({ data })));
  });
  const result = await new github.GithubSource('secret', 'acme').read('p', {
    assignee: 'anyone',
    states: [],
    priorities: []
  });
  assert.ok(result.options.unavailable?.states);
  assert.ok(result.options.unavailable?.priorities);
  assert.equal(result.tickets[0]?.state.label, 'No status');
});

it('classifies only explicit authentication failures as credentials and rejects partial GraphQL data', async (t) => {
  for (const status of [401, 403, 200]) {
    t.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: {}, errors: [{ message: 'Denied', type: 'FORBIDDEN' }] }),
          { status }
        )
      )
    );
    await assert.rejects(
      new github.GithubSource('secret', 'acme').discoverScopes(),
      (e: unknown) => {
        assert.equal((e as { kind: string }).kind, status === 401 ? 'credentials' : 'service');
        return true;
      }
    );
  }
});

it('keeps the same issue distinct in two project items with different native status options', async (t) => {
  let selected = 'a';
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    const { query, variables } = JSON.parse(init.body as string) as {
      query: string;
      variables: { id: string };
    };
    let data: unknown;
    if (query.includes('GithubFields')) {
      selected = variables.id;
      data = {
        node: {
          fields: page([
            field('status-' + selected, 'Status', [
              { id: 'option-' + selected, name: selected === 'a' ? 'Ready' : 'Review' }
            ])
          ])
        }
      };
    } else if (query.includes('GithubItems') || query.includes('GithubDetail')) {
      const scoped = {
        ...item,
        id: 'item-' + selected,
        project: { id: selected },
        content: { ...issue, assignees: page([]) },
        fieldValues: page([{ optionId: 'option-' + selected, field: { id: 'status-' + selected } }])
      };
      data = { node: query.includes('GithubItems') ? { items: page([scoped]) } : scoped };
    } else data = { viewer: { id: 'viewer' } };
    return Promise.resolve(new Response(JSON.stringify({ data })));
  });
  const source = new github.GithubSource('secret', 'acme');
  const filter = { assignee: 'anyone', states: [], priorities: [] };
  const a = await source.read('a', filter);
  const b = await source.read('b', filter);
  assert.equal(a.tickets[0]?.url, b.tickets[0]?.url);
  assert.notEqual(a.tickets[0]?.key, b.tickets[0]?.key);
  assert.equal(a.tickets[0]?.state.label, 'Ready');
  assert.equal(b.tickets[0]?.state.label, 'Review');
  const detail = await source.detail('b', 'item-b');
  assert.equal(detail.state.label, 'Review');
  assert.equal(detail.scopeId, 'b');
});

it('filters one cached selected-project snapshot, invalidates on refresh and drops removed assignees', async (t) => {
  let reads = 0;
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  let people = [{ id: 'a', login: 'alex' }];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    const { query, variables } = JSON.parse(init.body as string) as {
      query: string;
      variables: { id: string };
    };
    let data: unknown;
    if (query.includes('GithubFields')) data = { node: { fields: page([]) } };
    else if (query.includes('GithubItems')) {
      reads++;
      data = {
        node: {
          items: page([
            {
              ...item,
              project: { id: variables.id },
              fieldValues: page([]),
              content: { ...issue, assignees: page(people) }
            }
          ])
        }
      };
    } else data = { viewer: { id: 'a' } };
    return Promise.resolve(new Response(JSON.stringify({ data })));
  });
  const source = new github.GithubSource('secret', 'acme');
  const all = { assignee: 'anyone', states: [], priorities: [] };
  await source.read('p', all);
  await source.read('p', { ...all, assignee: 'a' });
  assert.equal(reads, 1, 'a filter pick reread the project');
  people = [];
  source.invalidate();
  const refreshed = await source.read('p', { ...all, assignee: 'a' });
  assert.equal(reads, 2);
  assert.equal(refreshed.filter.assignee, 'anyone');
  assert.equal(refreshed.tickets.length, 1);
  await source.read('q', all);
  await source.read('p', all);
  assert.equal(reads, 4, 'a retired project snapshot was retained');
  clock += 60 * 60_000;
  await source.read('p', all);
  assert.equal(reads, 4, 'the source expired its own snapshot');
});

it('warns about inaccessible content while preserving readable issues and rejecting other partial errors', async (t) => {
  let path: unknown[] = ['node', 'items', 'nodes', 1, 'content'];
  let type = 'FORBIDDEN';
  let hidden = true;
  let visible = true;
  let errors = true;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(typeof init.body, 'string');
    const query = (JSON.parse(init.body as string) as { query: string }).query;
    const data = query.includes('GithubFields')
      ? { node: { fields: page([]) } }
      : query.includes('GithubItems')
        ? {
            node: {
              items: page([
                ...(visible
                  ? [{ ...item, content: { ...issue, assignees: page([]) }, fieldValues: page([]) }]
                  : []),
                ...(hidden ? [{ ...item, id: 'private', type: 'REDACTED', content: null }] : [])
              ])
            }
          }
        : { viewer: { id: 'viewer' } };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data,
          ...(errors && query.includes('GithubItems')
            ? { errors: [{ type, path, message: 'Access denied' }] }
            : {})
        })
      )
    );
  });
  const source = new github.GithubSource('secret', 'acme');
  const all = { assignee: 'anyone', states: [], priorities: [] };
  const partial = await source.read('p', all);
  assert.equal(partial.tickets.length, 1);
  assert.match(partial.options.accessWarning ?? '', /repo/);
  source.invalidate();
  type = 'RATE_LIMITED';
  await assert.rejects(source.read('p', all));
  type = 'FORBIDDEN';
  path = ['node', 'items'];
  await assert.rejects(source.read('p', all));
  errors = false;
  visible = false;
  const redacted = await source.read('p', all);
  assert.equal(redacted.tickets.length, 0);
  assert.match(redacted.options.accessWarning ?? '', /1 project item/);
  hidden = false;
  visible = true;
  source.invalidate();
  const restored = await source.read('p', all);
  assert.equal(restored.tickets.length, 1);
  assert.equal(restored.options.accessWarning, undefined);
});
