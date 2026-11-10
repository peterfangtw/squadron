import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as backlog from '../../core/backlog';
import * as tickets from '../../core/tickets';
import { openPanel, stateMessage } from '../harness';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

// The store's status, painted by the real tab, and the tab's posts handed back
// to the same store: the token the tab echoes is the one the store accepts.

const SCOPES = ticketSourceView().scopes!;
const OPTIONS: TicketOptions = {
  scopeId: 'team-a',
  assignees: [{ id: 'anyone', label: 'Anyone' }],
  states: [ticketState('Ready')],
  priorities: [ticketPriority()]
};
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

function source(catalog: () => TicketScope[]): tickets.TicketSource {
  const row = (scopeId: string): tickets.Ticket => ({
    scopeId,
    id: 'ENG-1',
    key: tickets.ticketKey('linear', 'ENG-1'),
    identifier: 'ENG-1',
    title: 'Ready ticket',
    url: 'https://example.test/ENG-1',
    priority: ticketPriority(),
    state: ticketState('Ready')
  });
  return {
    discoverScopes: () => Promise.resolve(catalog()),
    read: (scopeId, filter) =>
      Promise.resolve({ tickets: [row(scopeId)], options: OPTIONS, filter }),
    invalidate: () => undefined,
    detail: () => Promise.reject(new Error('not read here'))
  };
}

/** A store with one Linear source, its catalog served, settled on `team-a`. */
async function linked(catalog = () => SCOPES) {
  const store = new backlog.TicketStore({ onChange: () => undefined });
  const configured: tickets.ConfiguredSource = {
    sourceId: 'linear',
    generation: 4,
    source: source(catalog),
    presentation: ticketSourceView().presentation
  };
  const input = { generation: 4, sources: [configured] };
  store.restoreSelection({ sourceId: 'linear', scopeId: 'team-a' });
  store.state(input);
  await drain();
  store.state(input);
  await drain();
  return { store, input };
}

function panel(t: Parameters<typeof openPanel>[0]) {
  const p = openPanel(t);
  const show = (state: ReturnType<backlog.TicketStore['state']>) =>
    p.push(stateMessage([], { ticketSource: state.status, tickets: state.tickets }));
  const find = (selector: string) => p.window.document.querySelector<HTMLElement>(selector);
  const last = <K extends WebviewMessage['type']>(type: K) =>
    p.posted.filter((m): m is Extract<WebviewMessage, { type: K }> => m.type === type).at(-1);
  const pick = (label: string) => {
    find('#tk-source .fpill')?.click();
    const option = [...p.window.document.querySelectorAll<HTMLElement>('#tk-source .mitem')].find(
      (n) => n.textContent?.includes(label)
    );
    assert.ok(option, label + ' is offered');
    option.click();
  };
  return { p, show, find, last, pick };
}

describe('the ticket selection token, store to tab and back', () => {
  it('accepts an unlinked connect press at its generation, and not after a reset', (t) => {
    const store = new backlog.TicketStore({ onChange: () => undefined });
    const { show, find, last } = panel(t);
    show(store.state({ generation: 7, sources: [] }));
    find('#board-tickets')?.click();
    find('#tk-list [data-provider="github"]')?.click();
    const press = last('connectTicketSource');
    assert.equal(press?.provider, 'github');
    assert.ok(press && store.accepts(press));
    store.reset();
    store.state({ generation: 8, sources: [] });
    assert.equal(store.accepts(press), false);
  });

  it('accepts what a linked tab posts, and nothing from an older paint', async (t) => {
    const { store, input } = await linked();
    const { show, find, last } = panel(t);
    show(store.state(input));
    find('#board-tickets')?.click();
    assert.ok(find('#tk-list .tk'));
    find('#tk-actions .refresh')?.click();
    find('#tk-list .tk')?.click();
    const refresh = last('refreshTickets');
    const read = last('readTicket');
    assert.ok(refresh && store.accepts(refresh));
    assert.ok(read && store.accepts(read));
    store.selectScope('team-b', { ...store.identity()!, selectionSeq: 1 });
    assert.equal(store.accepts(refresh), false);
  });

  it('returns to the served board on a refused pick, and its next post is accepted', async (t) => {
    let catalog = SCOPES;
    const { store, input } = await linked(() => catalog);
    const { p, show, find, last, pick } = panel(t);
    show(store.state(input));
    find('#board-tickets')?.click();
    await shrink(store, input, () => (catalog = [SCOPES[0]!]));
    pick('Operations');
    assert.equal(find('#tk-list .tk'), null);
    refuse(p, store, last('selectTicketScope')!);
    assert.ok(find('#tk-list .tk'));
    assert.match(find('#tk-source')?.textContent ?? '', /Engineering/);
    find('#tk-actions .refresh')?.click();
    assert.ok(store.accepts(last('refreshTickets')!));
  });

  it('keeps the newer pick when an overtaken one is refused, and serves it', async (t) => {
    let catalog = SCOPES;
    const { store, input } = await linked(() => catalog);
    const { p, show, find, last, pick } = panel(t);
    show(store.state(input));
    find('#board-tickets')?.click();
    await shrink(store, input, () => (catalog = [SCOPES[0]!]));
    pick('Operations');
    const overtaken = last('selectTicketScope')!;
    pick('Engineering');
    const newer = last('selectTicketScope')!;
    refuse(p, store, overtaken);
    assert.match(find('#tk-source')?.textContent ?? '', /Engineering/);
    assert.ok(store.selectScope(newer.scopeId, newer));
    store.state(input);
    await drain();
    show(store.state(input));
    assert.ok(find('#tk-list .tk'));
    find('#tk-actions .refresh')?.click();
    assert.ok(store.accepts(last('refreshTickets')!));
  });
});

/** The store's catalog loses boards the tab, painted earlier, still offers. */
async function shrink(
  store: backlog.TicketStore,
  input: backlog.TicketConnections,
  narrow: () => void
): Promise<void> {
  narrow();
  store.refetchCatalog();
  store.state(input);
  await drain();
}

/** What the host does with a pick the store refuses: echo its token back. */
function refuse(
  p: ReturnType<typeof openPanel>,
  store: backlog.TicketStore,
  asked: Extract<WebviewMessage, { type: 'selectTicketScope' }>
): void {
  assert.equal(store.selectScope(asked.scopeId, asked), undefined);
  const { type: _type, ...token } = asked;
  p.push({ type: 'ticketScopeChoice', landed: false, ...token });
}
