import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as backlog from '../../core/backlog';
import * as tickets from '../../core/tickets';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const ALL: TicketFilterView = { assignee: 'anyone', states: [], priorities: [] };
const SCOPES = ticketSourceView().scopes!;
const OPTIONS: TicketOptions = {
  scopeId: 'team-a',
  assignees: [{ id: 'anyone', label: 'Anyone' }],
  states: [ticketState('Ready')],
  priorities: [ticketPriority()]
};
const row = (id: string): tickets.Ticket => ({
  scopeId: 'team-a',
  id,
  key: tickets.ticketKey('linear', id),
  identifier: id,
  title: id,
  url: 'https://example.test/' + id,
  priority: ticketPriority(),
  state: ticketState('Ready')
});
class Source implements tickets.TicketSource {
  catalogs: ReturnType<typeof deferred<TicketScope[]>>[] = [];
  lists: {
    scopeId: string;
    filter: TicketFilterView;
    signal?: AbortSignal;
    result: ReturnType<typeof deferred<tickets.Ticket[]>>;
  }[] = [];
  optionReads: { scopeId: string; result: ReturnType<typeof deferred<TicketOptions>> }[] = [];
  discoverScopes(): Promise<TicketScope[]> {
    const result = deferred<TicketScope[]>();
    this.catalogs.push(result);
    return result.promise;
  }
  list(scopeId: string, filter: TicketFilterView, signal?: AbortSignal): Promise<tickets.Ticket[]> {
    const result = deferred<tickets.Ticket[]>();
    this.lists.push({ scopeId, filter, signal, result });
    return result.promise;
  }
  options(scopeId: string): Promise<TicketOptions> {
    const result = deferred<TicketOptions>();
    this.optionReads.push({ scopeId, result });
    return result.promise;
  }
  details: { signal?: AbortSignal; result: ReturnType<typeof deferred<TicketDetail>> }[] = [];
  detail(_scopeId: string, _id: string, signal?: AbortSignal): Promise<TicketDetail> {
    const result = deferred<TicketDetail>();
    this.details.push({ signal, result });
    return result.promise;
  }
  async ready(id = 'ENG-1', index = this.lists.length - 1): Promise<void> {
    this.lists[index]!.result.resolve([row(id)]);
    this.optionReads[index]!.result.resolve(OPTIONS);
    await drain();
  }
}
describe('one selected ticket board', () => {
  let source: Source;
  let store: backlog.TicketStore;
  let configured: tickets.ConfiguredSource;
  let clock: number;
  let changes: number;
  beforeEach(() => {
    source = new Source();
    clock = 1000;
    changes = 0;
    store = new backlog.TicketStore({ onChange: () => changes++, now: () => clock });
    configured = {
      sourceId: 'linear',
      generation: 1,
      source,
      presentation: ticketSourceView().presentation
    };
  });
  const token = (scopeId = 'team-a', selectionSeq = 0): TicketSelectionToken => ({
    generation: 1,
    scopeId,
    selectionSeq
  });
  async function catalog(scopes = SCOPES): Promise<void> {
    store.state(configured);
    source.catalogs.at(-1)!.resolve(scopes);
    await drain();
    store.state(configured);
  }
  async function selected(): Promise<void> {
    store.restoreSelection({ sourceId: 'linear', scopeId: 'team-a' });
    await catalog();
  }

  it('never issues an unscoped read and requires a choice for multiple or no teams', async () => {
    await catalog();
    assert.equal(source.lists.length, 0);
    assert.deepEqual(store.state(configured).status?.scopes, SCOPES);
    store.reset();
    await catalog([]);
    assert.equal(source.lists.length, 0);
    assert.deepEqual(store.state(configured).status?.scopes, []);
    store.refetch();
    store.state(configured);
    assert.equal(source.catalogs.length, 3);
    source.catalogs[2]!.resolve([SCOPES[0]!]);
    await drain();
    store.state(configured);
    assert.equal(source.lists.at(-1)?.scopeId, 'team-a');
  });
  it('migrates a legacy team key, prefers saved identity, and never substitutes for a missing saved team', async () => {
    configured.legacyTeamKey = 'OPS';
    await catalog();
    assert.equal(source.lists[0]?.scopeId, 'team-b');
    store.reset();
    store.restoreSelection({ sourceId: 'linear', scopeId: 'team-a' });
    await catalog();
    assert.equal(source.lists[1]?.scopeId, 'team-a');
    store.reset();
    store.restoreSelection({ sourceId: 'linear', scopeId: 'gone' });
    await catalog([SCOPES[0]!]);
    assert.equal(store.state(configured).status?.scopeId, undefined);
    assert.equal(source.lists.length, 2);
  });
  it('auto-selects a sole team and publishes tickets and required options atomically', async () => {
    await catalog([SCOPES[0]!]);
    source.lists[0]!.result.resolve([row('ENG-1')]);
    await drain();
    assert.equal(store.state(configured).tickets, undefined);
    assert.equal(store.state(configured).status?.options, undefined);
    source.optionReads[0]!.result.resolve(OPTIONS);
    await drain();
    assert.equal(store.state(configured).tickets?.[0]?.identifier, 'ENG-1');
    assert.deepEqual(store.state(configured).status?.options, OPTIONS);
  });
  it('resets filters and removes the prior board immediately, accepts B to A before echoes and retires old A', async () => {
    await selected();
    await source.ready();
    store.setFilter({ ...ALL, states: ['ready'], priorities: ['1'] }, token());
    assert.deepEqual(store.selectScope('team-b', { ...token('team-b', 1) }), {
      sourceId: 'linear',
      scopeId: 'team-b'
    });
    assert.equal(store.state(configured).tickets, undefined);
    assert.equal(store.state(configured).status?.options, undefined);
    assert.deepEqual(store.state(configured).status?.filter, ALL);
    store.selectScope('team-a', token('team-a', 2));
    store.state(configured);
    assert.equal(source.lists.at(-1)?.scopeId, 'team-a');
    await source.ready('ENG-NEW');
    await source.ready('OPS-OLD', 1);
    assert.equal(store.state(configured).tickets?.[0]?.identifier, 'ENG-NEW');
    assert.equal(store.selectScope('team-b', token('team-b', 1)), undefined);
    assert.equal(store.setFilter(ALL, token()), undefined);
  });
  it('retains same-scope rows and options on refresh failure, Retry bypasses TTL and retries options', async () => {
    await selected();
    await source.ready();
    store.refetch();
    store.state(configured);
    source.lists[1]!.result.resolve([row('ENG-2')]);
    source.optionReads[1]!.result.reject(new Error('Service unavailable'));
    await drain();
    const failed = store.state(configured);
    assert.equal(failed.tickets?.[0]?.identifier, 'ENG-1');
    assert.deepEqual(failed.status?.options, OPTIONS);
    assert.equal(failed.status?.error, 'Service unavailable');
    assert.equal(source.lists.length, 2);
    store.refetch();
    store.state(configured);
    await source.ready('ENG-3');
    assert.equal(store.state(configured).tickets?.[0]?.identifier, 'ENG-3');
    assert.equal(source.catalogs.length, 1);
  });
  it('throttles failed discovery and Retry retries discovery instead of reading issues', async () => {
    store.state(configured);
    source.catalogs[0]!.reject(new Error('offline'));
    await drain();
    assert.equal(store.state(configured).status?.error, 'offline');
    store.state(configured);
    assert.equal(source.catalogs.length, 1);
    store.refetch();
    store.state(configured);
    assert.equal(source.catalogs.length, 2);
    assert.equal(source.lists.length, 0);
  });
  it('cancels obsolete filters immediately, fences late completion, and caches until TTL expires', async () => {
    await selected();
    store.setFilter({ ...ALL, priorities: ['1'] }, token());
    store.setFilter({ ...ALL, priorities: ['2'] }, token());
    store.state(configured);
    assert.equal(source.lists.length, 2);
    assert.equal(source.lists[0]?.signal?.aborted, true);
    await source.ready('OLD', 0);
    assert.equal(store.state(configured).tickets, undefined);
    assert.equal(store.state(configured).status?.loading, true);
    assert.deepEqual(source.lists[1]?.filter.priorities, ['2']);
    await source.ready('NEW');
    store.state(configured);
    assert.equal(source.lists.length, 2);
    clock += backlog.TICKET_TTL_MS + 1;
    store.state(configured);
    assert.equal(source.lists.length, 3);
  });
  it('reuses scoped options for filter changes and retires an original A read after A to B to A', async () => {
    await selected();
    store.selectScope('team-b', token('team-b', 1));
    store.state(configured);
    store.selectScope('team-a', token('team-a', 2));
    store.state(configured);
    await source.ready('CURRENT', 2);
    source.lists[0]!.result.reject(new Error('old A'));
    source.optionReads[0]!.result.resolve(OPTIONS);
    await drain();
    assert.equal(store.state(configured).tickets?.[0]?.identifier, 'CURRENT');
    assert.equal(store.state(configured).status?.error, undefined);
    store.setFilter({ ...ALL, priorities: ['1'] }, token('team-a', 2));
    store.state(configured);
    assert.equal(source.optionReads.length, 3);
    source.lists[3]!.result.resolve([row('FILTERED')]);
    await drain();
    assert.equal(store.state(configured).tickets?.[0]?.identifier, 'FILTERED');
    store.dispose();
  });
  it('fences current links and ignores success, rejection and notification after credential replacement or disposal', async () => {
    await selected();
    await source.ready();
    assert.equal(store.openTarget(row('ENG-1').key, token()), row('ENG-1').url);
    assert.equal(store.openTarget(row('ENG-1').key, token('team-b')), undefined);
    store.refetch();
    store.state(configured);
    store.state({ ...configured, generation: 2 });
    changes = 0;
    source.lists[1]!.result.reject(new Error('old'));
    source.optionReads[1]!.result.resolve(OPTIONS);
    await drain();
    assert.equal(changes, 0);
    assert.equal(store.state({ ...configured, generation: 2 }).tickets, undefined);
    store.dispose();
    source.catalogs.at(-1)!.resolve(SCOPES);
    await drain();
    assert.deepEqual(store.state(configured), {});
    assert.equal(changes, 0);
  });
});

describe('selection storage and errors', () => {
  it('serializes selection saves and writes the latest choice after an older pending save', async () => {
    const source = new Source();
    const gate = deferred<void>();
    const writes: tickets.SavedTicketSelection[] = [];
    const store = new backlog.TicketStore({
      onChange: () => undefined,
      onSelection: async (selection) => {
        writes.push(selection);
        if (writes.length === 1) await gate.promise;
      }
    });
    const configured: tickets.ConfiguredSource = {
      sourceId: 'linear',
      generation: 1,
      source,
      presentation: ticketSourceView().presentation
    };
    store.restoreSelection({ sourceId: 'linear', scopeId: 'team-a' });
    store.state(configured);
    source.catalogs[0]!.resolve(SCOPES);
    await drain();
    store.state(configured);
    await drain();
    // The first save is still pending when two more selections arrive.
    store.selectScope('team-b', { generation: 1, selectionSeq: 1, scopeId: 'team-b' });
    store.selectScope('team-a', { generation: 1, selectionSeq: 2, scopeId: 'team-a' });
    gate.resolve();
    await drain();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.at(-1), { sourceId: 'linear', scopeId: 'team-a' });
    store.dispose();
  });
  it('validates saved identities and filters and gives unknown exceptions a readable fallback', () => {
    assert.deepEqual(tickets.storedSelection({ sourceId: 'linear', scopeId: 'a' }), {
      sourceId: 'linear',
      scopeId: 'a'
    });
    for (const bad of [
      null,
      {},
      { sourceId: 'linear', scopeId: 3 },
      { sourceId: 'linear', scopeId: '' }
    ])
      assert.equal(tickets.storedSelection(bad), undefined);
    assert.equal(tickets.validFilter(ALL), true);
    assert.equal(tickets.validFilter({ ...ALL, states: [null] }), false);
    assert.equal(
      tickets.sourceError({ secret: 'unreadable' }).message,
      'Could not load tickets. Please try again.'
    );
    assert.equal(
      tickets.sourceError(new tickets.TicketSourceError('credentials', 'Revoked')).kind,
      'credentials'
    );
  });
});

describe('on-demand detail lifetime', () => {
  it('keeps one read independent of filters, retires late results and fetches again on reopen', async () => {
    const source = new Source();
    const closed: string[] = [];
    const store = new backlog.TicketStore({
      onChange: () => {},
      onDetailClosed: (id) => closed.push(id)
    });
    const configured: tickets.ConfiguredSource = {
      sourceId: 'markdown',
      generation: 1,
      source,
      presentation: ticketSourceView().presentation
    };
    store.restoreSelection({ sourceId: 'markdown', scopeId: 'team-a' });
    store.state(configured);
    source.catalogs[0]!.resolve(SCOPES);
    await drain();
    store.state(configured);
    source.lists[0]!.result.resolve([
      { ...row('ENG-1'), key: tickets.ticketKey('markdown', 'ENG-1') }
    ]);
    source.optionReads[0]!.result.resolve(OPTIONS);
    await drain();
    const token = store.identity()!;
    const key = tickets.ticketKey('markdown', 'ENG-1');
    const value: TicketDetail = {
      key,
      scopeId: 'team-a',
      identifier: 'ENG-1',
      title: 'Title',
      url: 'https://example.test/ENG-1',
      assignee: null,
      state: ticketState('Ready'),
      description: 'body'
    };
    assert.equal(source.details.length, 0);
    const first = store.readDetail(key, token, 'first');
    store.setFilter({ ...ALL, assignee: 'unassigned' }, token);
    assert.equal(source.details[0]!.signal?.aborted, false);
    source.details[0]!.result.resolve(value);
    assert.deepEqual(await first, value);
    store.closeDetail('wrong');
    assert.equal(store.detailCurrent('first'), true);
    store.closeDetail('first');
    assert.equal(store.detailCurrent('first'), false);
    assert.equal(source.details[0]!.signal?.aborted, true);
    const second = store.readDetail(key, token, 'second');
    assert.equal(source.details.length, 2);
    store.reset();
    source.details[1]!.result.resolve(value);
    assert.equal(await second, undefined);
    assert.deepEqual(closed, ['first', 'second']);
    assert.equal(await store.readDetail(key, token, 'old'), undefined);
    store.dispose();
  });
});
