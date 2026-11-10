import { openTicketDetail } from './ticket_details';
/**
 * Tickets in the board: the backlog and its existing filter pills and menus.
 */

import { $, dot, el } from './dom';
import { ui, vscode } from './state';
import {
  closeMenu,
  heldOpen,
  iconButton,
  morph,
  dropdownTrigger,
  opensMenu,
  menuItem,
  searchBox
} from './kit';
import { Picker, picker, SortDir } from './picker';
import { linearMark, githubMark } from './mcp_marks';
import * as ticketToken from '../core/ticket_token';

const sourceMarks: Record<TicketSourceMarkId, () => HTMLElement> = {
  linear: linearMark,
  github: githubMark
};
/** The token `settleFilter` last saw; a new one drops the pending pick and its menus. */
let settledToken: TicketSelectionToken | undefined;
let refreshScopeChoices: ((source: TicketSourceStatus) => void) | undefined;
let observedNotice: HTMLElement | null = null;
const noticeResize =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (observedNotice)
          $('tk-list').style.setProperty(
            '--ticket-notice-height',
            `${Math.ceil(observedNotice.getBoundingClientRect().height) + 8}px`
          );
      })
    : undefined;

function paintTicketList(nodes: HTMLElement[]): void {
  const root = $('tk-list');
  morph(root, nodes);
  const notice = root.querySelector<HTMLElement>('.tknotice');
  if (notice === observedNotice) return;
  noticeResize?.disconnect();
  observedNotice = notice;
  root.style.removeProperty('--ticket-notice-height');
  if (notice) noticeResize?.observe(notice);
}

/** Whether the tab still shows the selection a control was painted under. */
function current(was: TicketSelectionToken): boolean {
  const shown = ui.state.ticketSource?.token;
  return !!shown && ticketToken.sameToken(shown, was);
}

// The host's newest tickets state, kept while a pick's optimistic state fences
// it, so a refused pick has something true to return to.
let served: { source: TicketSourceStatus | undefined; tickets: TicketView[] | undefined } = {
  source: undefined,
  tickets: undefined
};

/** A delayed board push must not undo a pick already made in this document. */
export function fenceTicketState(message: StateMessage): void {
  const before = ui.state.ticketSource;
  const next = message.ticketSource;
  served = { source: next, tickets: message.tickets };
  if (before && next && ticketToken.newer(before.token, next.token)) {
    message.ticketSource = before;
    message.tickets = ui.state.tickets;
  }
}

/** A refused pick drops its optimistic board, only while the tab still shows that pick. */
export function refuseTicketScope(refused: TicketSelectionToken): void {
  if (!current(refused)) return;
  ui.state.ticketSource = served.source;
  ui.state.tickets = served.tickets;
  settleFilter();
  renderTickets();
}

function scopePicker(source: TicketSourceStatus): HTMLElement {
  refreshScopeChoices = undefined;
  const rendered = source.token;
  const boards = (value: TicketSourceStatus): TicketBoard[] | undefined =>
    value.boards ??
    value.scopes?.map((scope) => ({
      ...scope,
      sourceId: value.sourceId,
      presentation: value.presentation
    }));
  const selected = boards(source)?.find(
    (scope) => scope.id === source.scopeId && scope.sourceId === source.sourceId
  );
  const control = dropdownTrigger(selected?.label ?? 'Choose a board');
  control.wrap.classList.add('scope-wrap');
  control.button.classList.add('scope-button');
  control.button.setAttribute('aria-label', 'Switch ticket board');
  if (source.presentation.mark) control.button.prepend(sourceMarks[source.presentation.mark]());
  const menu = opensMenu(control.wrap, control.button, 'start', (body) => {
    const rows = el('div', 'fscroll');
    let catalog = boards(source);
    const paint = (needle: string): void => {
      const scopes = (catalog ?? []).filter((scope) =>
        (scope.presentation.label + ' / ' + scope.label).toLowerCase().includes(needle)
      );
      rows.replaceChildren(
        ...scopes.map((scope) =>
          menuItem(
            scope.presentation.label + ' / ' + scope.label,
            scope.id === source.scopeId && scope.sourceId === source.sourceId,
            'one',
            () => {
              if (!current(rendered)) return;
              closeMenu();
              if (
                scope.id === source.scopeId &&
                scope.sourceId === source.sourceId &&
                ui.state.tickets !== undefined &&
                !ui.state.ticketSource?.stale
              )
                return;
              const next = {
                ...rendered,
                ...(source.boards ? { sourceId: scope.sourceId } : {}),
                selectionSeq: rendered.selectionSeq + 1,
                scopeId: scope.id
              };
              ui.state.ticketSource = {
                ...source,
                token: next,
                sourceId: scope.sourceId,
                scopeId: scope.id,
                presentation: scope.presentation,
                options: undefined,
                filter: { assignee: 'anyone', states: [], priorities: [] },
                loading: true,
                stale: false,
                error: undefined,
                failure: undefined
              };
              ui.state.tickets = undefined;
              vscode.postMessage({ type: 'selectTicketScope', ...next });
              settleFilter();
              $('tk-list').scrollTop = 0;
              renderTickets();
            }
          )
        )
      );
      if (!scopes.length)
        rows.append(el('div', 'fnone', catalog ? 'No boards found.' : 'Loading boards…'));
    };
    const search = searchBox('Find a board…', paint);
    refreshScopeChoices = (next) => {
      if (JSON.stringify(catalog) === JSON.stringify(boards(next))) return;
      catalog = boards(next);
      paint(search.value.trim().toLowerCase());
    };
    paint('');
    body.append(search, rows);
    if (source.connections) {
      const divider = el('div', 'fsep');
      divider.setAttribute('role', 'separator');
      body.append(divider);
    }
    for (const connection of source.connections ?? []) {
      if (!connection.error) continue;
      const recovery = menuItem(
        connection.presentation.label + ': ' + connection.error,
        false,
        'one',
        () => {
          closeMenu();
          vscode.postMessage(
            connection.failure === 'credentials'
              ? { type: 'connectTicketSource', ...rendered, provider: connection.sourceId }
              : { type: 'refreshTickets', ...rendered, catalog: true }
          );
        }
      );
      body.append(recovery);
    }
    for (const connection of source.connections ?? []) {
      const label = connection.presentation.disconnectLabel;
      if (!label) continue;
      body.append(
        menuItem(label, false, 'one', () => {
          closeMenu();
          vscode.postMessage({
            type: 'disconnectTicketSource',
            ...rendered,
            provider: connection.sourceId
          });
        })
      );
    }
    // The host lists only the sources not yet connected; a connected one is
    // re-keyed from the header's key button. Below the same divider as the rest.
    for (const offer of source.connections ? (source.offers ?? []) : []) {
      body.append(
        menuItem('Connect ' + offer.label, false, 'one', () => {
          closeMenu();
          vscode.postMessage({
            type: 'connectTicketSource',
            ...rendered,
            provider: offer.sourceId
          });
        })
      );
    }
  });
  control.wrap.append(menu);
  return control.wrap;
}

function ticketCard(t: TicketView): HTMLElement {
  const node = el('button', 'tk');
  node.setAttribute('type', 'button');
  node.setAttribute('aria-label', 'View ' + t.identifier + ' details');
  node.dataset.act = 'readTicket';
  node.dataset.tid = t.key;
  node.dataset.key = 'tk:' + t.key;

  const idRow = el('span', 'tkid');
  if (t.priority) idRow.append(dot('tone-' + t.priority.tone));
  const key = el('span', 'tkkey', t.identifier);
  key.dataset.key = 'tkkey:' + t.key;
  idRow.append(key);
  if (t.priority) idRow.append(el('span', null, '· ' + t.priority.label));

  const title = el('span', 'tktitle', t.title);
  title.dataset.key = 'tktitle:' + t.key;
  node.append(idRow, title);
  return node;
}

// Options can reorder between pushes; remember closed lanes by value, never by index.
const shutLanes = new Set<string>();

/** Options are cached: a state added since that read still needs a trailing lane for its rows. */
function laneStates(rows: TicketView[], states: StateOption[], narrowed: string[]): TicketField[] {
  const known = (narrowed.length ? states.filter((s) => narrowed.includes(s.value)) : states)
    .slice()
    .sort((a, b) => a.order - b.order);
  const lanes = new Map<string, TicketField>(known.map((state) => [state.value, state]));
  for (const row of rows) if (!lanes.has(row.state.value)) lanes.set(row.state.value, row.state);
  return [...lanes.values()];
}

function lane(state: TicketField, rows: TicketView[]): HTMLElement {
  const shut = shutLanes.has(state.value);
  const node = el('div', 'lane' + (shut ? ' shut' : ''));
  node.dataset.key = 'lane:' + state.value;
  const head = el('button', 'lhead');
  head.dataset.act = 'lane';
  head.dataset.lane = state.value;
  head.dataset.key = 'lhead:' + state.value;
  head.setAttribute('aria-expanded', String(!shut));
  const label = state.label || 'Unknown status';
  head.setAttribute('aria-label', (shut ? 'Expand ' : 'Collapse ') + label);
  head.dataset.tip = (shut ? 'Expand ' : 'Collapse ') + label;
  const collapse = el('span', 'caret');
  collapse.innerHTML = ICONS.arrowLeftToLine;
  head.append(el('span', 'lname', label), el('span', 'ln', String(rows.length)), collapse);
  const body = el('div', 'lbody');
  body.dataset.key = 'lbody:' + state.value;
  rows.forEach((t) => body.append(ticketCard(t)));
  node.append(head, body);
  return node;
}

/**
 * The filter asked for and not yet echoed back. The host answers a
 * `setTicketFilter` by refetching from the source, which takes long enough for the
 * user to open the other pill and act again — and that second pick composes
 * with whatever the controls believe is selected. Without this, it would compose
 * with the pre-pick state and silently undo the first choice.
 */
let wantFilter: TicketFilterView | null = null;

/** What the controls should show: the pending pick, else the host's answer. */
function currentFilter(): TicketFilterView {
  return (
    wantFilter ??
    ui.state.ticketSource?.filter ?? { assignee: 'anyone', states: [], priorities: [] }
  );
}

/** Post a filter change; the host refetches and echoes the new selection back. */
function setFilter(next: TicketFilterView, rendered = ui.state.ticketSource?.token): void {
  if (!rendered || !current(rendered)) return;
  wantFilter = next;
  vscode.postMessage({ type: 'setTicketFilter', ...rendered, filter: next });
}

/** Drop the pending pick once the host's answer agrees with it. */
export function settleFilter(): void {
  const source = ui.state.ticketSource;
  const shown = source?.token;
  if (
    shown === undefined || settledToken === undefined
      ? shown !== settledToken
      : !ticketToken.sameToken(shown, settledToken)
  ) {
    settledToken = shown;
    wantFilter = null;
    shutLanes.clear();
    sortDir = null;
    const root = $('tk-filter');
    if (heldOpen(root) || heldOpen($('tk-source'))) closeMenu();
  }
  const options = source?.options;
  if (!source?.loading && options) {
    if (options.unavailable?.priorities) sortDir = null;
    if (wantFilter) {
      wantFilter = {
        ...wantFilter,
        assignee:
          options.assigneesComplete &&
          !['anyone', 'unassigned', 'me'].includes(wantFilter.assignee) &&
          !options.assignees.some((person) => person.id === wantFilter?.assignee)
            ? 'anyone'
            : wantFilter.assignee,
        states: wantFilter.states.filter((id) => options.states.some((s) => s.value === id)),
        priorities: wantFilter.priorities.filter((id) =>
          options.priorities.some((p) => p.value === id)
        )
      };
    }
  }
  const echo = source?.filter;
  if (!wantFilter || !echo) return;
  const sameSet = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));
  const same =
    echo.assignee === wantFilter.assignee &&
    sameSet(echo.states, wantFilter.states) &&
    sameSet(echo.priorities, wantFilter.priorities);
  if (same) wantFilter = null;
}

/**
 * How the list is ordered, and the only piece of the bar's state that never
 * leaves this half of the panel.
 *
 * A sort reorders tickets already on screen, so posting it would spend a refetch
 * of the source — a few hundred milliseconds, inside a menu built to stay open while
 * the direction is changed — to learn nothing new. It stays a plain `let` rather
 * than joining `ui`, for the same reason `wantFilter` above does: `ui` is for
 * state more than one module writes, and this file is the only writer.
 */
let sortDir: SortDir = null;

/**
 * The filter bar: an assignee pill, a status pill and a priority pill, all three
 * the same control with different props. The bar is skipped entirely until
 * options arrive, so it never flashes a half-empty menu on the first paint.
 *
 * Composition is done here rather than inside a picker, on purpose: each one
 * reports only its own facet, and `currentFilter()` supplies the rest at the
 * moment of the post. A menu that composed against the snapshot it opened with
 * would silently undo a pick made since.
 */
function renderTicketFilter(root: HTMLElement): void {
  const source = ui.state.ticketSource;
  const options = source?.options;
  if (!options) return;
  const filter = currentFilter();
  const rendered = source.token;
  const changeFilter = (next: TicketFilterView): void => setFilter(next, rendered);

  const pills: Picker[] = [];
  /**
   * One pill has just claimed the sort, so no other may keep one — a bar where
   * two controls both say they order the list is lying about one of them. The
   * arbitration lives here because a picker that reached for its siblings would
   * need the bar handed to it.
   */
  const claimSort = (mine: Picker): void => {
    pills.forEach((p) => p !== mine && p.clearSort());
  };

  if (options.assignees.length) {
    const assignees = [
      { id: 'anyone', label: 'Anyone (All)' },
      ...options.assignees.filter((a) => a.id === 'unassigned'),
      ...options.assignees
        .filter((a) => a.id !== 'anyone' && a.id !== 'me' && a.id !== 'unassigned')
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((a) => ({
          id: a.id,
          label: a.id === options.viewerId ? `${a.label} (Me)` : a.label
        }))
    ];
    const assignee = filter.assignee === 'me' ? (options.viewerId ?? 'me') : filter.assignee;
    pills.push(
      picker({
        floating: true,
        label:
          assignees.find((a) => a.id === assignee)?.label ??
          (filter.assignee === 'me' ? 'Current user unavailable' : 'Unavailable assignee'),
        options: assignees,
        value: assignee === 'anyone' ? [] : [assignee],
        select: 'one',
        // A wide space is a long scroll of names; typing beats hunting through it.
        search: true,
        onChange: ({ value }) =>
          changeFilter({ ...currentFilter(), assignee: value[0] ?? 'anyone' })
      })
    );
  }

  if (options.states.length > 0) {
    pills.push(
      picker({
        floating: true,
        label: filter.states.length ? `${filter.states.length} status` : 'Any status',
        options: options.states
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s) => ({ id: s.value, label: s.label })),
        value: filter.states,
        select: 'many',
        // `2 statuses` beats two more chips when the dock is narrow.
        summary: (n) => `${n} statuses`,
        onChange: ({ value }) => changeFilter({ ...currentFilter(), states: value })
      })
    );
  }

  if (options.priorities.length > 0) {
    const priority: Picker = picker({
      floating: true,
      label: filter.priorities.length ? `${filter.priorities.length} priority` : 'Any priority',
      options: options.priorities
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((p) => ({
          id: p.value,
          label: p.label,
          dot: 'tone-' + p.tone
        })),
      value: filter.priorities,
      select: 'many',
      summary: (n) => `${n} priorities`,
      sort: {
        dir: sortDir,
        ...(options.prioritySort ?? { asc: 'Most urgent first', desc: 'Least urgent first' })
      },
      onChange: ({ value, dir }) => {
        // Both halves are settled before anything repaints. A Clear changes the
        // two at once, and a repaint between them showed the pill its own stale
        // selection — `renderTickets` rebuilds the bar from `currentFilter()`,
        // which is only current once `setFilter` has run.
        if (dir !== sortDir) {
          sortDir = dir;
          if (dir !== null) claimSort(priority);
        }
        const priorities = value;
        const was = currentFilter();
        const changed =
          priorities.length !== was.priorities.length ||
          priorities.some((n) => !was.priorities.includes(n));
        if (changed) changeFilter({ ...was, priorities });
        // The bar is held still while its menu is open, so the list has to be
        // repainted from here; a sort that waited for the next state push would
        // look broken until the menu was closed.
        renderTickets();
      }
    });
    pills.push(priority);
  }

  root.append(...pills);
  for (const [facet, label] of [
    ['states', 'Any status'],
    ['priorities', 'Any priority']
  ] as const) {
    const explanation = options.unavailable?.[facet];
    if (!explanation) continue;
    const wrap = el('span', 'fwrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-disabled', 'true');
    wrap.setAttribute('aria-label', label + '. ' + explanation);
    wrap.dataset.tip = explanation;
    const button = el('button', 'fpill', label);
    button.setAttribute('disabled', '');
    button.style.pointerEvents = 'none';
    wrap.append(button);
    if (facet === 'states' && options.priorities.length)
      root.insertBefore(wrap, pills.at(-1) ?? null);
    else root.append(wrap);
  }
}

/** The ticket backlog, or the connect / empty / stale states. */
export function renderTickets(): void {
  const source = ui.state.ticketSource;
  const presentation = source?.presentation;
  const head = $('tk-source');
  const actions = $('tk-actions');
  const filterEl = $('tk-filter');
  const listEl = $('tk-list');
  if (!heldOpen(head)) head.replaceChildren();
  actions.replaceChildren();
  listEl.setAttribute(
    'aria-busy',
    String(
      !ui.ready ||
        source?.loading === true ||
        (source?.linked === true && !source.stale && !ui.state.tickets && !source.scopes)
    )
  );
  if (!ui.ready) {
    if (!heldOpen(head)) head.append(el('span', 'src', 'Tickets'));
    filterEl.replaceChildren();
    const pending = el('div', 'tkempty', 'Loading tickets…');
    pending.dataset.key = 'loading';
    paintTicketList([pending]);
    return;
  }
  if (!source?.linked) {
    // No source means no filter to hold on to, whatever menu was open. Through
    // closeMenu, so the pill it hangs off is left closed rather than merely
    // forgotten about.
    if (heldOpen(filterEl)) closeMenu();
    filterEl.replaceChildren();
    if (heldOpen(head)) closeMenu();
    head.replaceChildren(el('span', 'src', 'No ticket source'));
    paintTicketList([connectPrompt(source)]);
    return;
  }

  if (heldOpen(head)) refreshScopeChoices?.(source);
  else head.replaceChildren(scopePicker(source));
  const rendered = source.token;
  const refresh = iconButton(ICONS.refresh, 'Refresh tickets', () =>
    vscode.postMessage({ type: 'refreshTickets', ...rendered })
  );
  refresh.classList.add('refresh');
  refresh.toggleAttribute('disabled', source?.loading === true);
  if (source?.loading && ui.state.tickets !== undefined) {
    const note = el('span', 'tkrefresh-note', 'Refreshing…');
    note.setAttribute('role', 'status');
    actions.append(note);
  }
  actions.append(refresh);
  if (presentation?.reconfigureLabel) {
    const reconfigure = iconButton(ICONS.keyRound, presentation.reconfigureLabel, () =>
      vscode.postMessage({ type: 'connectTicketSource', ...rendered, provider: source.sourceId })
    );
    reconfigure.classList.add('reconfigure');
    actions.append(reconfigure);
  }

  // Hold only this bar while its menu is open; the list and stale banner still update.
  if (!heldOpen(filterEl)) {
    filterEl.replaceChildren();
    renderTicketFilter(filterEl);
  }

  const nodes: HTMLElement[] = [];
  const tickets = ui.state.tickets;
  const accessWarning = source?.options?.accessWarning;
  if (accessWarning && !source?.stale) {
    const warning = el('div', tickets?.length ? 'tkstale tknotice' : 'tkstale tkempty');
    warning.dataset.key = 'access-warning';
    warning.setAttribute('role', 'status');
    warning.append(el('div', null, accessWarning));
    if (presentation?.reconfigureLabel) {
      const recovery = el('button', 'tkconnect', 'Update credentials');
      recovery.dataset.act = 'connect';
      recovery.dataset.provider = source.sourceId;
      warning.append(recovery);
    }
    nodes.push(warning);
  }
  if (ui.state.ticketSource?.stale) {
    const banner = el('div', tickets?.length ? 'tkstale tknotice' : 'tkstale tkempty');
    banner.dataset.key = 'stale';
    banner.setAttribute('role', 'alert');
    banner.append(
      el(
        'div',
        'tkstate-title',
        tickets?.length ? 'Showing the last good list.' : 'Could not load tickets.'
      )
    );
    if (source?.error) banner.append(el('div', null, source.error));
    const recovery = el(
      'button',
      'tkconnect',
      source?.failure === 'credentials' ? 'Update credentials' : 'Retry'
    );
    recovery.dataset.act = source?.failure === 'credentials' ? 'connect' : 'retryTickets';
    recovery.dataset.provider = source.sourceId;
    recovery.toggleAttribute(
      'disabled',
      source?.loading === true && source.failure !== 'credentials'
    );
    banner.append(recovery);
    nodes.push(banner);
  }
  const blank = (text: string): HTMLElement => {
    const node = el('div', 'tkempty', text);
    node.dataset.key = 'blank';
    return node;
  };
  if (tickets === undefined) {
    // Nothing cached. Stale as well means the fetch failed and there is no last
    // good list to fall back on — saying "Loading…" forever would be a lie.
    if (!source?.stale)
      nodes.push(
        blank(
          source?.scopes && !source.scopeId
            ? source.scopes.length
              ? 'Choose a board to see its tickets.'
              : 'No accessible boards.'
            : 'Loading tickets…'
        )
      );
  } else {
    if (!tickets.length && !accessWarning && !source?.stale) {
      const none = blank('No tickets match the current filter.');
      none.setAttribute('role', 'status');
      // One click, where the sentence used to be a dead end.
      //
      // Status and priority only, which is why the label names them: the assignee
      // is who you are looking at rather than how much of their backlog, and an
      // empty list under `anyone` with no other narrowing is a true statement
      // about the source, with nothing to undo.
      const filter = currentFilter();
      if (filter.states.length || filter.priorities.length) {
        const clear = el('button', 'tkclear', 'Clear status and priority');
        clear.dataset.act = 'clearFilter';
        clear.dataset.key = 'clearFilter';
        none.append(clear);
      }
      nodes.push(none);
    }
    if (tickets.length || source?.options?.states.length || source?.options?.noStatusLane) {
      // Sorting reorders the fetched page locally without another network request.
      const rows =
        sortDir === null
          ? tickets
          : [...tickets].sort((a, b) => {
              if (!a.priority) return b.priority ? 1 : 0;
              if (!b.priority) return -1;
              return sortDir === 'asc'
                ? a.priority.order - b.priority.order
                : b.priority.order - a.priority.order;
            });
      // Laned by status once the options that order the lanes have arrived; a flat
      // list until then, which is the same first-paint rule the filter bar keeps.
      const states = ui.state.ticketSource?.options?.noStatusLane
        ? [{ value: '', label: 'No status', order: 0 }]
        : ui.state.ticketSource?.options?.states;
      if (!states?.length) {
        const list = el('div', 'tkrows');
        list.dataset.key = 'rows';
        list.append(...rows.map(ticketCard));
        nodes.push(list);
      } else {
        const columns = el('div', 'tkcolumns');
        columns.dataset.key = 'columns';
        columns.setAttribute('role', 'region');
        columns.setAttribute('aria-label', 'Ticket status columns');
        columns.tabIndex = 0;
        columns.append(
          ...laneStates(rows, states, currentFilter().states).map((state) =>
            lane(
              state,
              rows.filter((t) => t.state.value === state.value)
            )
          )
        );
        nodes.push(columns);
      }
    }
  }
  // Morphed, not replaced, for the reason the board is: a push lands every 3 s
  // while the tab is up, and a row rebuilt between a mousedown and a mouseup
  // takes the click with it — the press dispatches on `#tk-list`, where the
  // delegated listener below finds no `[data-act]` and returns.
  paintTicketList(nodes);
}

/**
 * The unlinked tab: one prompt, a row per source the host offers. A row goes
 * straight to its source's connect flow; one whose IDE prompt is open is held
 * until the host says it returned, so a second press cannot open a second.
 */
function connectPrompt(source: TicketSourceStatus | undefined): HTMLElement {
  const prompt = el('div', 'tkempty tkpick');
  prompt.dataset.key = 'unlinked';
  const rows = el('div', 'tksrcs');
  rows.setAttribute('role', 'list');
  for (const offer of source?.offers ?? []) {
    const busy = source?.connecting === offer.sourceId;
    const row = el('button', 'tksrc');
    row.setAttribute('role', 'listitem');
    row.dataset.act = 'connect';
    row.dataset.provider = offer.sourceId;
    row.dataset.key = 'connect:' + offer.sourceId;
    row.toggleAttribute('disabled', busy);
    const mark = el('span', 'mk');
    if (offer.mark) mark.append(sourceMarks[offer.mark]());
    const text = el('span', 'tx');
    text.append(
      el('span', 'nm', offer.label),
      el('span', 'what', busy ? 'Waiting for the key…' : offer.detail)
    );
    const go = el('span', 'go', '›');
    go.setAttribute('aria-hidden', 'true');
    row.append(mark, text, go);
    rows.append(row);
  }
  prompt.append(
    el('div', 'tkstate-title', 'Connect a ticket source'),
    el('div', 'lead', 'Your backlog shows here once one is connected.'),
    rows
  );
  return prompt;
}

/**
 * The list's clicks, delegated to the one element here a repaint never
 * replaces. A 3 s push rebuilds every row, and a `click` fires on the nearest
 * common ancestor of its mousedown and mouseup targets — so a row replaced
 * between the two took its handler with it and the press landed on `#tk-list`,
 * which is now exactly where this is listening. The ticket is looked up by id
 * out of live state rather than closed over, for the same reason.
 */
$('tk-list').addEventListener('click', (e) => {
  // `Element`, not `HTMLElement`: a press on a row's icon reports the `<path>`
  // inside it, which is an `SVGElement` and fails that test. See `hitOf` in
  // `board.ts` — same trap, same fix.
  const target = e.target instanceof Element ? e.target : null;
  const acted = target?.closest<HTMLElement>('[data-act]');
  if (!acted) return;
  const shown = ui.state.ticketSource?.token;
  if (!shown) return;
  if (acted.dataset.act === 'connect') {
    const provider = acted.dataset.provider;
    if (provider) vscode.postMessage({ type: 'connectTicketSource', ...shown, provider });
    return;
  }
  if (acted.dataset.act === 'retryTickets') {
    vscode.postMessage({ type: 'refreshTickets', ...shown });
    return;
  }
  if (acted.dataset.act === 'clearFilter') {
    setFilter({ ...currentFilter(), states: [], priorities: [] });
    // Repainted here rather than on the host's echo, for the reason the sort is
    // (`renderTicketFilter`): a refetch of the source is a few hundred milliseconds,
    // and a button still offering an act already taken is the tab looking broken
    // for all of them. `currentFilter()` answers with the pending pick, so the
    // guard that drew this button is already false.
    renderTickets();
    return;
  }
  if (acted.dataset.act === 'lane') {
    const name = acted.dataset.lane ?? '';
    if (!shutLanes.delete(name)) shutLanes.add(name);
    renderTickets();
    return;
  }
  const id = acted.closest<HTMLElement>('.tk')?.dataset.tid;
  const t = (ui.state.tickets ?? []).find((row) => row.key === id);
  if (!t) return;
  if (acted.dataset.act === 'readTicket') {
    openTicketDetail(t, shown);
    return;
  }
});
