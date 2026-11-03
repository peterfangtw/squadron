import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { groupView, openThread, stateMessage, threadView } from '../harness';
import { ticketPriority, ticketSourceView, ticketState } from '../ticket_fixtures';

const row: TicketView = {
  scopeId: 'team-a',
  key: '["linear","issue-a"]',
  identifier: 'ENG-42',
  title: 'Read this ticket',
  url: 'https://example.test/ENG-42',
  priority: ticketPriority(),
  state: ticketState('Ready')
};
const detail: Omit<TicketDetail, 'description'> = {
  scopeId: row.scopeId,
  key: row.key,
  identifier: row.identifier,
  title: 'Latest title',
  url: row.url,
  assignee: null,
  state: { value: 'ready-id', label: 'Ready' }
};

function openOnJira(t: TestContext, ticket: TicketView) {
  const p = openThread(t, threadView({ owned: true }));
  const doc = p.window.document;
  const source = ticketSourceView();
  const presentation = { ...source.presentation, label: 'Jira' };
  p.push(
    stateMessage([groupView()], {
      ticketSource: { ...source, presentation },
      tickets: [ticket]
    })
  );
  doc.querySelector<HTMLElement>('#board-tickets')!.click();
  doc.querySelector<HTMLElement>('.tk')!.click();
  return { p, link: doc.querySelector<HTMLElement>('#ticket-detail .td-external') };
}

describe('ticket details beside chat', () => {
  it('names the source on its external link', (t) => {
    const { p, link } = openOnJira(t, row);
    assert.equal(link?.textContent, 'Open in Jira');
    link?.click();
    const opened = p.posted.filter((m) => m.type === 'openTicket').at(-1);
    assert.equal(opened?.key, row.key);
  });

  for (const url of ['', 'mailto:team@example.test']) {
    it(`offers no external link for a ticket whose url is "${url}"`, (t) => {
      assert.equal(openOnJira(t, { ...row, url }).link, null);
    });
  }

  it('loads only on demand, renders sanitized details and preserves chat access and scroll across pushes', (t) => {
    const p = openThread(t, threadView({ owned: true }));
    const doc = p.window.document;
    const state = () =>
      stateMessage([groupView()], { ticketSource: ticketSourceView(), tickets: [row] });
    p.push(state());
    doc.querySelector<HTMLElement>('#board-tickets')!.click();
    assert.equal(
      p.posted.some((m) => m.type === 'readTicket'),
      false
    );
    const opener = doc.querySelector<HTMLElement>('.tk')!;
    opener.focus();
    opener.click();
    const request = p.posted.filter((m) => m.type === 'readTicket').at(-1);
    assert.ok(request?.type === 'readTicket');
    assert.equal(request.key, row.key);
    const surface = doc.querySelector<HTMLElement>('#ticket-detail')!;
    assert.ok(surface);
    assert.equal(surface.querySelector('[aria-modal="true"]'), null);
    assert.match(surface.textContent, /Loading/);
    assert.notEqual(doc.querySelector<HTMLElement>('#dock')!.inert, true);
    p.push({
      type: 'ticketDetail',
      requestId: request.requestId,
      state: 'ready',
      detail,
      empty: false,
      html: '<h3>Acceptance</h3><p>Markdown <strong>body</strong></p><button data-act="end">forged</button><a href="command:evil">bad</a><script>evil()</script>'
    });
    assert.match(surface.textContent, /Latest title/);
    assert.match(surface.textContent, /Unassigned/);
    assert.equal(surface.querySelector('.body strong')?.textContent, 'body');
    assert.equal(
      surface.querySelector('script, [data-act="end"], .body button, .body a[href^="command:"]'),
      null
    );
    const body = surface.querySelector<HTMLElement>('.td-description')!;
    body.scrollTop = 84;
    const composer = doc.querySelector<HTMLElement>('#input .ProseMirror')!;
    composer.focus();
    composer.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(surface.hidden, false);
    p.push(state());
    assert.equal(body.scrollTop, 84);
    assert.equal(doc.activeElement, composer);
    assert.equal(p.posted.filter((m) => m.type === 'readTicket').length, 1);
    surface.querySelector<HTMLElement>('.ax')!.focus();
    surface
      .querySelector<HTMLElement>('.ax')!
      .dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(surface.hidden, true);
    assert.equal(surface.textContent, '');
    p.push({
      type: 'ticketDetail',
      requestId: request.requestId,
      state: 'ready',
      detail,
      empty: false,
      html: '<p>late</p>'
    });
    assert.equal(surface.hidden, true);
    opener.click();
    assert.equal(p.posted.filter((m) => m.type === 'readTicket').length, 2);
  });

  it('retries with a fresh identity, ignores previous replies and retires on source replacement', (t) => {
    const p = openThread(t, threadView());
    const doc = p.window.document;
    p.push(stateMessage([groupView()], { ticketSource: ticketSourceView(), tickets: [row] }));
    doc.querySelector<HTMLElement>('#board-tickets')!.click();
    doc.querySelector<HTMLElement>('.tkkey')!.click();
    const request = p.posted.filter((m) => m.type === 'readTicket').at(-1);
    assert.ok(request?.type === 'readTicket');
    p.push({
      type: 'ticketDetail',
      requestId: request.requestId,
      state: 'error',
      reason: 'Service unavailable'
    });
    doc.querySelector<HTMLElement>('#ticket-detail .td-retry')!.click();
    const retry = p.posted.filter((m) => m.type === 'readTicket').at(-1);
    assert.ok(retry?.type === 'readTicket');
    assert.notEqual(retry.requestId, request.requestId);
    p.push({
      type: 'ticketDetail',
      requestId: request.requestId,
      state: 'ready',
      detail,
      empty: false,
      html: 'old'
    });
    assert.match(doc.querySelector('#ticket-detail')!.textContent, /Loading/);
    p.push({
      type: 'ticketDetail',
      requestId: retry.requestId,
      state: 'ready',
      detail,
      empty: true,
      html: ''
    });
    assert.match(doc.querySelector('#ticket-detail')!.textContent, /No description/);
    p.push(
      stateMessage([groupView()], {
        ticketSource: ticketSourceView({ generation: 2 }),
        tickets: [row]
      })
    );
    assert.equal(doc.querySelector<HTMLElement>('#ticket-detail')!.hidden, true);
  });
});

describe('unassigned filter choice', () => {
  it('offers Anyone, Unassigned and people separately and posts their distinct meanings', (t) => {
    const p = openThread(t, threadView());
    p.push(
      stateMessage([groupView()], {
        tickets: [row],
        ticketSource: ticketSourceView({
          filter: { assignee: 'anyone', states: [], priorities: [] },
          options: {
            scopeId: 'team-a',
            states: [],
            priorities: [],
            assignees: [
              { id: 'person-a', label: 'Alex' },
              { id: 'unassigned', label: 'Unassigned' },
              { id: 'anyone', label: 'Anyone' }
            ]
          }
        })
      })
    );
    const doc = p.window.document;
    doc.querySelector<HTMLElement>('#board-tickets')!.click();
    doc.querySelector<HTMLElement>('#tk-filter .fpill')!.click();
    const choices = () => [
      ...doc.querySelectorAll<HTMLElement>('.fmenu.pmenu:not([hidden]) .mitem')
    ];
    assert.deepEqual(
      choices().map((n) => n.querySelector('.nm')?.textContent),
      ['Anyone (All)', 'Unassigned', 'Alex']
    );
    choices()[1]!.click();
    const chosen = p.posted.filter((m) => m.type === 'setTicketFilter').at(-1);
    assert.equal(chosen?.filter.assignee, 'unassigned');
    doc.querySelector<HTMLElement>('#tk-filter .fpill')!.click();
    choices()[0]!.click();
    const cleared = p.posted.filter((m) => m.type === 'setTicketFilter').at(-1);
    assert.equal(cleared?.filter.assignee, 'anyone');
  });
});
