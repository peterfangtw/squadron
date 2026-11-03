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
import { linearMark } from './mcp_marks';

const sourceMarks: Record<TicketSourceMarkId, () => HTMLElement> = { linear: linearMark };
let sourceGeneration: string | undefined;
let refreshScopeChoices: ((source: TicketSourceStatus) => void) | undefined;

function token(): TicketSelectionToken {
  const source = ui.state.ticketSource;
  return {
    generation: source?.generation ?? -1,
    selectionSeq: source?.selectionSeq ?? 0,
    ...(source?.scopeId ? { scopeId: source.scopeId } : {})
  };
}
function current(was: TicketSelectionToken): boolean {
  const now = token();
  return (
    now.generation === was.generation &&
    now.selectionSeq === was.selectionSeq &&
    now.scopeId === was.scopeId
  );
}

/** A delayed board push must not undo a pick already made in this document. */
export function fenceTicketState(message: StateMessage): void {
  const before = ui.state.ticketSource;
  const next = message.ticketSource;
  if (
    before &&
    next &&
    (next.generation < before.generation ||
      (next.generation === before.generation && next.selectionSeq < before.selectionSeq))
  ) {
    message.ticketSource = before;
    message.tickets = ui.state.tickets;
  }
}

function scopePicker(source: TicketSourceStatus): HTMLElement {
  refreshScopeChoices = undefined;
  const rendered = token();
  const selected = source.scopes?.find((scope) => scope.id === source.scopeId);
  const control = dropdownTrigger(selected?.label ?? 'Choose a board');
  control.wrap.classList.add('scope-wrap');
  control.button.classList.add('scope-button');
  control.button.setAttribute('aria-label', 'Switch ticket board');
  if (source.presentation.mark) control.button.prepend(sourceMarks[source.presentation.mark]());
  const menu = opensMenu(control.wrap, control.button, 'start', (body) => {
    const rows = el('div', 'fscroll');
    let catalog = source.scopes;
    const paint = (needle: string): void => {
      const scopes = (catalog ?? []).filter((scope) =>
        (source.presentation.label + ' / ' + scope.label).toLowerCase().includes(needle)
      );
      rows.replaceChildren(
        ...scopes.map((scope) =>
          menuItem(
            source.presentation.label + ' / ' + scope.label,
            scope.id === source.scopeId,
            'one',
            () => {
              if (!current(rendered)) return;
              closeMenu();
              if (
                scope.id === source.scopeId &&
                ui.state.tickets !== undefined &&
                !ui.state.ticketSource?.stale
              )
                return;
              const next = {
                ...rendered,
                selectionSeq: rendered.selectionSeq + 1,
                scopeId: scope.id
              };
              ui.state.ticketSource = {
                ...source,
                ...next,
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
      if (JSON.stringify(catalog) === JSON.stringify(next.scopes)) return;
      catalog = next.scopes;
      paint(search.value.trim().toLowerCase());
    };
    paint('');
    body.append(search, rows);
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
  idRow.append(dot('tone-' + t.priority.tone));
  const key = el('span', 'tkkey', t.identifier);
  key.dataset.key = 'tkkey:' + t.key;
  idRow.append(key, el('span', null, '· ' + t.priority.label));

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
function setFilter(next: TicketFilterView, rendered = token()): void {
  if (!current(rendered)) return;
  wantFilter = next;
  vscode.postMessage({ type: 'setTicketFilter', ...rendered, filter: next });
}

/** Drop the pending pick once the host's answer agrees with it. */
export function settleFilter(): void {
  const source = ui.state.ticketSource;
  const identity = source
    ? JSON.stringify([source.sourceId, source.generation, source.selectionSeq, source.scopeId])
    : undefined;
  if (identity !== sourceGeneration) {
    sourceGeneration = identity;
    wantFilter = null;
    shutLanes.clear();
    sortDir = null;
    const root = $('tk-filter');
    if (heldOpen(root) || heldOpen($('tk-source'))) closeMenu();
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
  const options = ui.state.ticketSource?.options;
  if (!options) return;
  const filter = currentFilter();
  const rendered = token();
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
      sort: { dir: sortDir, asc: 'Most urgent first', desc: 'Least urgent first' },
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
    morph(listEl, [pending]);
    return;
  }
  if (!(ui.state.ticketSource?.linked ?? false)) {
    // No source means no filter to hold on to, whatever menu was open. Through
    // closeMenu, so the pill it hangs off is left closed rather than merely
    // forgotten about.
    if (heldOpen(filterEl)) closeMenu();
    filterEl.replaceChildren();
    if (heldOpen(head)) closeMenu();
    head.replaceChildren(el('span', 'src', 'No ticket source'));
    const empty = el('div', 'tkempty');
    empty.dataset.key = 'unlinked';
    empty.append(
      el(
        'div',
        null,
        presentation?.connectHint ?? 'Connect a ticket source to see your backlog here.'
      )
    );
    if (presentation) {
      const connect = el('button', 'tkconnect', presentation.connectLabel);
      connect.dataset.act = 'connect';
      connect.dataset.key = 'connect';
      empty.append(connect);
    }
    morph(listEl, [empty]);
    return;
  }

  if (source) {
    if (heldOpen(head)) refreshScopeChoices?.(source);
    else head.replaceChildren(scopePicker(source));
  }
  const rendered = token();
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
      vscode.postMessage({ type: 'connectTicketSource', ...rendered })
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
  // Keyed, both of them: the banner comes and goes with a failed fetch at the
  // top of the list, and neither it nor an empty-state line may be morphed into
  // the other or into a row.
  if (ui.state.ticketSource?.stale) {
    const banner = el('div', 'tkstale');
    banner.dataset.key = 'stale';
    if (ui.state.tickets) banner.append(el('div', null, 'Showing the last good list.'));
    banner.append(el('div', null, source?.error ?? 'Could not load tickets.'));
    const recovery = el(
      'button',
      'tkconnect',
      source?.failure === 'credentials' ? 'Update credentials' : 'Retry'
    );
    recovery.dataset.act = source?.failure === 'credentials' ? 'connect' : 'retryTickets';
    recovery.toggleAttribute(
      'disabled',
      source?.loading === true && source.failure !== 'credentials'
    );
    banner.append(recovery);
    nodes.push(banner);
  }
  const tickets = ui.state.tickets;
  const blank = (text: string): HTMLElement => {
    const node = el('div', 'tkempty', text);
    node.dataset.key = 'blank';
    return node;
  };
  if (tickets === undefined) {
    // Nothing cached. Stale as well means the fetch failed and there is no last
    // good list to fall back on — saying "Loading…" forever would be a lie.
    nodes.push(
      blank(
        ui.state.ticketSource?.stale
          ? 'Could not load tickets.'
          : source?.scopes && !source.scopeId
            ? source.scopes.length
              ? 'Choose a board to see its tickets.'
              : 'No accessible boards.'
            : 'Loading tickets…'
      )
    );
  } else {
    if (!tickets.length) {
      const none = blank('No tickets match the current filter.');
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
    if (tickets.length || source?.options?.states.length) {
      // Sorting reorders the fetched page locally without another network request.
      const rows =
        sortDir === null
          ? tickets
          : [...tickets].sort((a, b) =>
              sortDir === 'asc'
                ? a.priority.order - b.priority.order
                : b.priority.order - a.priority.order
            );
      // Laned by status once the options that order the lanes have arrived; a flat
      // list until then, which is the same first-paint rule the filter bar keeps.
      const states = ui.state.ticketSource?.options?.states;
      if (!states?.length) {
        nodes.push(...rows.map(ticketCard));
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
  morph(listEl, nodes);
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
  if (acted.dataset.act === 'connect') {
    vscode.postMessage({ type: 'connectTicketSource', ...token() });
    return;
  }
  if (acted.dataset.act === 'retryTickets') {
    vscode.postMessage({ type: 'refreshTickets', ...token() });
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
    openTicketDetail(t, token());
    return;
  }
});
