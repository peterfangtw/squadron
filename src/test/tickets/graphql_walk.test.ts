import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import { TicketSourceError } from '../../core/tickets';
import {
  REQUEST_MS,
  WALK_MS,
  graphqlRequest,
  walkConnection,
  walkSignal
} from '../../core/tickets/graphql';

const ENDPOINT = 'https://tickets.example/graphql';

function fail(): TicketSourceError {
  return new TicketSourceError('service', 'incomplete');
}

function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true
    });
  });
}

function request(
  signal: AbortSignal,
  requestMs: number,
  variables: Record<string, unknown> = {}
): Promise<unknown> {
  return graphqlRequest({
    endpoint: ENDPOINT,
    authorization: 'secret',
    query: 'query Page($after: String) { nodes }',
    variables,
    signal,
    requestMs,
    credentials: () => false,
    fallback: (status, statusText) => `responded ${status} ${statusText}`,
    fail
  });
}

it('keeps the walk and request budgets', () => {
  assert.equal(WALK_MS, 30_000);
  assert.equal(REQUEST_MS, 15_000);
});

it('rejects a hung fetch from the request budget while the walk stays open', async (t) => {
  const walk = walkSignal(undefined, 2_000);
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
    assert.ok(init?.signal);
    return hang(init.signal);
  });
  await assert.rejects(request(walk, 100), /abort/i);
  assert.equal(walk.aborted, false);
});

it('aborts a second connection after the shared walk budget is spent', async (t) => {
  const walk = walkSignal(undefined, 100);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
    fetches += 1;
    assert.ok(init?.signal);
    return hang(init.signal);
  });
  const page = () => request(walk, 2_000);
  await assert.rejects(walkConnection(walk, page, fail));
  assert.equal(walk.aborted, true);
  assert.equal(fetches, 1);
  await assert.rejects(walkConnection(walk, page, fail));
  assert.equal(fetches, 1);
});

it('requests the page after an embedded cursor once', async (t) => {
  const afters: unknown[] = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init?: RequestInit) => {
    if (!init || typeof init.body !== 'string') throw new Error('expected a string body');
    const body = JSON.parse(init.body) as { variables: { after?: unknown } };
    afters.push(body.variables.after);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: { nodes: [{ id: 'b' }], pageInfo: { hasNextPage: false, endCursor: null } }
        })
      )
    );
  });
  const walk = walkSignal(undefined, 2_000);
  const nodes = await walkConnection(walk, (after) => request(walk, 2_000, { after }), fail, {
    nodes: [{ id: 'a' }],
    pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
  });
  assert.deepEqual(afters, ['cursor-1']);
  assert.deepEqual(nodes, [{ id: 'a' }, { id: 'b' }]);
});
