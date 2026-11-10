import { icon } from '../ui/icons';
import * as ticketRefs from '../core/ticket_ref';
import * as ticketToken from '../core/ticket_token';
import * as clipboard from './mention_clipboard';
import { iconButton } from './kit';
import { el } from './dom';
import { ui, vscode } from './state';
import * as sheets from './sheet';
import { sanitized } from './markdown_dom';

const ID = 'ticket-detail';
let current:
  | {
      requestId: string;
      token: TicketSelectionToken;
      sourceId: string;
      row: TicketView;
      sheet: sheets.Sheet;
      title: HTMLElement;
      assignee: HTMLElement;
      status: HTMLElement;
    }
  | undefined;

export function openTicketDetail(row: TicketView, token: TicketSelectionToken): void {
  closeTicketDetail();
  const sheet = sheets.openSheet({
    id: ID,
    title: row.identifier,
    position: 'board',
    interactionScope: 'board',
    onClose: closeTicketDetail
  });
  sheet.element.classList.add('ticket-detail');
  const head = sheet.head;
  const tools = el('div', 'td-tools');
  const identifier = sheet.title;
  const close = head.querySelector('.ax');
  tools.append(identifier);
  const source = ui.state.ticketSource;
  if (source && /^https?:\/\//i.test(row.url)) {
    const external = iconButton(icon('external'), 'Open in ' + source.presentation.label, () => {
      if (current)
        vscode.postMessage({ type: 'openTicket', ...current.token, key: current.row.key });
    });
    external.classList.add('td-external');
    const feedback = el('span', 'td-copy-status');
    feedback.setAttribute('role', 'status');
    tools.append(feedback, external);
    const ref = ticketRefs.ticketRef(row.identifier, row.url);
    if (ref) {
      const copy = iconButton(icon('copy'), 'Copy ticket', () => {
        feedback.textContent = 'Copying…';
        copy.setAttribute('disabled', '');
        void clipboard
          .copyMention(ref)
          .then(
            () => {
              feedback.textContent = 'Copied';
            },
            () => {
              feedback.textContent = 'Could not copy. Try again.';
            }
          )
          .finally(() => copy.removeAttribute('disabled'));
      });
      copy.classList.add('td-copy');
      tools.append(copy);
    }
  }
  if (close) tools.append(close);
  const title = el('h2', 'td-title', row.title);
  title.id = ID + '-title';
  title.tabIndex = 0;
  identifier.removeAttribute('id');
  const fields = el('dl', 'td-fields');
  const field = (name: string): HTMLElement => {
    const pair = el('div');
    const value = el('dd', null, '—');
    pair.append(el('dt', null, name), value);
    fields.append(pair);
    return value;
  };
  const assignee = field('Assignee');
  const status = field('Status');
  head.replaceChildren(tools, title, fields);
  sheet.body.classList.add('td-description');
  sheet.body.tabIndex = 0;
  sheet.body.setAttribute('aria-label', 'Ticket description');
  sheet.body.onclick = (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link) return;
    event.preventDefault();
    const url = link.getAttribute('href');
    if (current && url && /^https?:\/\//i.test(url))
      vscode.postMessage({ type: 'openTicketLink', requestId: current.requestId, url });
  };
  current = {
    requestId: '',
    sourceId: source?.sourceId ?? '',
    token,
    row,
    sheet,
    title,
    assignee,
    status
  };
  request();
  title.focus({ preventScroll: true });
}

export function closeTicketDetail(): void {
  const was = current;
  if (!was) return;
  current = undefined;
  was.sheet.close();
  vscode.postMessage({ type: 'closeTicketDetail', requestId: was.requestId });
}

export function syncTicketDetail(source: TicketSourceStatus | undefined): void {
  if (!current) return;
  if (
    !source?.linked ||
    !ticketToken.sameToken(source.token, current.token) ||
    source.sourceId !== current.sourceId
  )
    closeTicketDetail();
}

export function takeTicketDetail(message: TicketDetailMessage): void {
  const view = current;
  if (!view || view.requestId !== message.requestId) return;
  if (message.state === 'closed') {
    closeTicketDetail();
    return;
  }
  const focusBody = view.sheet.body.contains(document.activeElement);
  const body = view.sheet.body;
  body.removeAttribute('aria-busy');
  body.replaceChildren();
  if (message.state === 'error') {
    const error = el('p', 'td-notice', message.reason);
    error.setAttribute('role', 'alert');
    const retry = el('button', 'td-retry', 'Retry');
    retry.onclick = request;
    body.append(error, retry);
    if (focusBody) retry.focus({ preventScroll: true });
    return;
  }
  view.title.textContent = message.detail.title;
  view.assignee.textContent = message.detail.assignees
    ? message.detail.assignees.map((person) => person.label).join(', ') || 'Unassigned'
    : (message.detail.assignee?.label ?? 'Unassigned');
  view.status.textContent = message.detail.state.label;
  if (message.empty) body.append(el('p', 'td-notice', 'No description.'));
  else {
    const prose = el('div', 'body');
    prose.append(sanitized(message.html));
    for (const link of prose.querySelectorAll('a[href]')) {
      if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    }
    body.append(prose);
  }
  if (focusBody) view.title.focus({ preventScroll: true });
}

function request(): void {
  const view = current;
  if (!view) return;
  const focusBody = view.sheet.body.contains(document.activeElement);
  view.requestId = globalThis.crypto.randomUUID();
  view.assignee.textContent = '—';
  view.status.textContent = '—';
  const notice = el('p', 'td-notice', 'Loading ticket…');
  notice.setAttribute('role', 'status');
  view.sheet.body.replaceChildren(notice);
  view.sheet.body.setAttribute('aria-busy', 'true');
  if (focusBody) view.sheet.body.focus({ preventScroll: true });
  vscode.postMessage({
    type: 'readTicket',
    ...view.token,
    key: view.row.key,
    requestId: view.requestId
  });
}

export function openTicketReference(expansion: string): void {
  const [ref] = ticketRefs.findTickets(expansion);
  if (!ref || ref.text !== expansion) return;
  const source = ui.state.ticketSource;
  const identity = ticketRefs.ticketRef(ref.identifier, ref.url);
  const row = ui.state.tickets?.find(
    (ticket) => ticketRefs.ticketRef(ticket.identifier, ticket.url) === identity
  );
  if (source?.linked && row && source.scopeId === row.scopeId) {
    openTicketDetail(row, source.token);
  } else vscode.postMessage({ type: 'openTicketReference', reference: expansion });
}
