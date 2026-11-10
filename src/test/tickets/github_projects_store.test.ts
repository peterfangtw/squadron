import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as backlog from '../../core/backlog';
import * as tickets from '../../core/tickets';
import { opened, ticketSourceView } from '../ticket_fixtures';

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const scope = { id: 'same', key: 'ENG', label: 'Engineering' };
/** A source whose read answers `rows` beside empty options. */
function source(
  id: string,
  rows: (scopeId: string, filter: TicketFilterView) => Promise<tickets.Ticket[]>,
  discoverScopes = () => Promise.resolve([scope])
): tickets.ConfiguredSource {
  return {
    sourceId: id,
    generation: 1,
    presentation: { ...ticketSourceView().presentation, label: id },
    source: {
      discoverScopes,
      read: async (scopeId, filter) => ({
        tickets: await rows(scopeId, filter),
        options: { scopeId, assignees: [], states: [], priorities: [] },
        filter
      }),
      invalidate: () => undefined,
      detail: () => Promise.reject(new Error('unused'))
    }
  };
}
it('routes colliding scope IDs across sources and retires a late previous-source read', async () => {
  let finish!: (rows: tickets.Ticket[]) => void;
  const linear = source(
    'linear',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const github = source('github', () =>
    Promise.resolve([
      {
        id: 'item',
        scopeId: 'same',
        key: '["github","item"]',
        identifier: 'acme/web#1',
        title: 'GitHub',
        url: 'https://example.test',
        state: { value: '', label: 'No status' }
      }
    ])
  );
  const configured = [linear, github];
  const store = new backlog.TicketStore({ onChange: () => undefined });
  store.restoreSelection({ sourceId: 'linear', scopeId: 'same' });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  assert.equal(store.state(opened(configured)).status?.boards?.length, 2);
  assert.ok(
    store.selectScope('same', {
      sourceId: 'github',
      generation: 1,
      selectionSeq: 1,
      scopeId: 'same'
    })
  );
  assert.equal(store.state(opened(configured)).tickets, undefined);
  await drain();
  finish([]);
  await drain();
  const state = store.state(opened(configured));
  assert.equal(state.status?.sourceId, 'github');
  assert.equal(state.tickets?.[0]?.title, 'GitHub');
  assert.equal(
    store.accepts({ sourceId: 'linear', generation: 1, selectionSeq: 1, scopeId: 'same' }),
    false
  );
  store.dispose();
});
it('keeps healthy provider choices usable after another provider discovery fails and retries its catalog', async () => {
  let failed = true;
  const configured = [
    source('linear', () => Promise.resolve([])),
    source(
      'github',
      () => Promise.resolve([]),
      () => {
        if (failed) return Promise.reject(new tickets.TicketSourceError('credentials', 'Rejected'));
        return Promise.resolve([scope]);
      }
    )
  ];
  const store = new backlog.TicketStore({ onChange: () => undefined });
  store.restoreSelection({ sourceId: 'github', scopeId: 'gone' });
  store.state(opened(configured));
  await drain();
  assert.equal(store.state(opened(configured)).status?.connections?.[1]?.failure, 'credentials');
  assert.ok(
    store.selectScope('same', {
      sourceId: 'linear',
      generation: 1,
      selectionSeq: 1,
      scopeId: 'same'
    })
  );
  store.state(opened(configured));
  await drain();
  assert.deepEqual(store.state(opened(configured)).tickets, []);
  failed = false;
  store.refetchCatalog();
  store.state(opened(configured));
  await drain();
  assert.equal(store.state(opened(configured)).status?.boards?.length, 2);
  assert.equal(store.state(opened(configured)).status?.scopeId, 'same');
  store.dispose();
});

it('loads a remembered healthy board while another provider is still discovering', async () => {
  let finish!: (scopes: TicketScope[]) => void;
  const configured = [
    source('linear', () => Promise.resolve([])),
    source(
      'github',
      () => Promise.resolve([]),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
  ];
  const store = new backlog.TicketStore({ onChange: () => undefined });
  store.restoreSelection({ sourceId: 'linear', scopeId: 'same' });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  assert.deepEqual(store.state(opened(configured)).tickets, []);
  assert.equal(store.state(opened(configured)).status?.boards?.length, 1);
  finish([scope]);
  await drain();
  assert.equal(store.state(opened(configured)).status?.boards?.length, 2);
  assert.equal(store.state(opened(configured)).status?.sourceId, 'linear');
  store.dispose();
});

it('retries failed discovery after TTL without confusing it with a successful empty catalog', async () => {
  let clock = 1000;
  let reads = 0;
  const configured = source(
    'github',
    () => Promise.resolve([]),
    () => {
      reads++;
      return reads === 1 ? Promise.reject(new Error('Offline')) : Promise.resolve([scope]);
    }
  );
  const store = new backlog.TicketStore({ onChange: () => undefined, now: () => clock });
  store.state(opened(configured));
  await drain();
  assert.match(store.state(opened(configured)).status?.error ?? '', /Offline/);
  assert.equal(reads, 1);
  clock += backlog.TICKET_TTL_MS + 1;
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  assert.equal(reads, 2);
  assert.deepEqual(store.state(opened(configured)).tickets, []);
  assert.equal(store.state(opened(configured)).status?.error, undefined);
  store.dispose();
});

it('refresh discovers new projects and retires a disappeared selected project snapshot', async () => {
  let scopes = [scope];
  const configured = source(
    'github',
    () => Promise.resolve([]),
    () => Promise.resolve(scopes)
  );
  const store = new backlog.TicketStore({ onChange: () => undefined });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  assert.equal(store.state(opened(configured)).status?.scopeId, 'same');
  const before = store.identity()!;
  scopes = [{ id: 'new', key: 'NEW', label: 'New project' }];
  store.refetchCatalog();
  const refreshing = store.state(opened(configured));
  assert.deepEqual(refreshing.tickets, []);
  assert.equal(refreshing.status?.scopeId, 'same');
  await drain();
  const after = store.state(opened(configured));
  assert.equal(after.tickets, undefined);
  assert.equal(after.status?.scopeId, undefined);
  assert.equal(after.status?.scopes?.[0]?.id, 'new');
  assert.equal(store.accepts(before), false);
  store.dispose();
});

it('keeps catalog and selected-list failures independent in either completion order', async () => {
  for (const catalogLast of [true, false]) {
    let resolveCatalog!: (scopes: TicketScope[]) => void;
    let rejectCatalog!: (error: Error) => void;
    let resolveList!: (rows: tickets.Ticket[]) => void;
    let rejectList!: (error: Error) => void;
    let hold = false;
    const configured = source(
      'github',
      () =>
        hold
          ? new Promise((resolve, reject) => {
              resolveList = resolve;
              rejectList = reject;
            })
          : Promise.resolve([]),
      () =>
        hold
          ? new Promise((resolve, reject) => {
              resolveCatalog = resolve;
              rejectCatalog = reject;
            })
          : Promise.resolve([scope])
    );
    const store = new backlog.TicketStore({ onChange: () => undefined });
    store.state(opened(configured));
    await drain();
    store.state(opened(configured));
    await drain();
    hold = true;
    store.refetchCatalog();
    store.state(opened(configured));
    if (catalogLast) {
      rejectList(new Error('List failed'));
      await drain();
      resolveCatalog([scope]);
    } else {
      rejectCatalog(new Error('Catalog failed'));
      await drain();
      resolveList([]);
    }
    await drain();
    const state = store.state(opened(configured));
    assert.equal(state.status?.stale, true);
    assert.match(state.status?.error ?? '', catalogLast ? /List failed/ : /Catalog failed/);
    assert.deepEqual(state.tickets, []);
    store.dispose();
  }
});

it('shows the failure when selecting a cached board whose provider has failed', async () => {
  let failed = false;
  const configured = [
    source('linear', () => Promise.resolve([])),
    source(
      'github',
      () => Promise.resolve([]),
      () =>
        failed
          ? Promise.reject(new tickets.TicketSourceError('credentials', 'Token rejected'))
          : Promise.resolve([scope])
    )
  ];
  const store = new backlog.TicketStore({ onChange: () => undefined });
  store.restoreSelection({ sourceId: 'linear', scopeId: 'same' });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  failed = true;
  store.refetchCatalog();
  store.state(opened(configured));
  await drain();
  assert.ok(
    store.selectScope('same', {
      sourceId: 'github',
      generation: 1,
      selectionSeq: 1,
      scopeId: 'same'
    })
  );
  const state = store.state(opened(configured));
  assert.equal(state.tickets, undefined);
  assert.equal(state.status?.loading, false);
  assert.equal(state.status?.stale, true);
  assert.equal(state.status?.failure, 'credentials');
  assert.match(state.status?.error ?? '', /Token rejected/);
  store.dispose();
});

it('re-reads cached content by its own deadline while filter picks keep arriving', async () => {
  let clock = 1000;
  let reads = 0;
  let cached = false;
  const configured = source('github', () => {
    if (!cached) reads++;
    cached = true;
    return Promise.resolve([]);
  });
  configured.source.invalidate = () => {
    cached = false;
  };
  const store = new backlog.TicketStore({ onChange: () => undefined, now: () => clock });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  assert.equal(reads, 1);
  const pick = async (assignee: string) => {
    const token = store.identity();
    assert.ok(token);
    store.setFilter({ assignee, states: [], priorities: [] }, token);
    store.state(opened(configured));
    await drain();
  };
  clock += backlog.TICKET_TTL_MS / 2;
  await pick('me');
  assert.equal(reads, 1, 'a filter pick re-read cached content');
  clock += backlog.TICKET_TTL_MS / 2 + 1;
  store.state(opened(configured));
  await drain();
  assert.equal(reads, 2, 'a filter pick postponed the content deadline');
  for (let i = 0; i < 4; i++) {
    clock += backlog.TICKET_TTL_MS / 2 + 1;
    await pick(i % 2 ? 'me' : 'anyone');
  }
  assert.equal(reads, 4, 'filter picks every half TTL starved the content refresh');
  store.dispose();
});
it('refreshes every source on the store TTL, dropping its cache, and reads catalogs only when asked', async () => {
  let clock = 1000;
  let lists = 0;
  let catalogs = 0;
  let invalidations = 0;
  const configured = source(
    'github',
    () => {
      lists++;
      return Promise.resolve([]);
    },
    () => {
      catalogs++;
      return Promise.resolve([scope]);
    }
  );
  configured.source.invalidate = () => {
    invalidations++;
  };
  const store = new backlog.TicketStore({ onChange: () => undefined, now: () => clock });
  store.state(opened(configured));
  await drain();
  store.state(opened(configured));
  await drain();
  assert.equal(lists, 1);
  const token = store.identity();
  assert.ok(token);
  store.setFilter({ assignee: 'anyone', states: [], priorities: [] }, token);
  store.state(opened(configured));
  await drain();
  assert.equal(lists, 2);
  assert.equal(invalidations, 0, 'a filter pick dropped the source cache');
  clock += backlog.TICKET_TTL_MS + 1;
  store.state(opened(configured));
  await drain();
  assert.equal(lists, 3);
  assert.equal(invalidations, 1, 'a TTL refetch reused the source cache');
  clock += 10 * backlog.TICKET_TTL_MS;
  store.state(opened(configured));
  await drain();
  assert.equal(catalogs, 1, 'a successful catalog began polling');
  store.dispose();
});
