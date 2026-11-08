/**
 * The MCP sheet: one section per repo, one row per server url inside it, one
 * stable column per CLI.
 *
 * Host-filled, centred across the panel. The accounts popover only keeps the footer
 * that opens this. Design: mockups/mcp-by-repo.html, direction A.
 */

import { brandMark, btn } from './accounts';
import { el } from './dom';
import { closeMenu } from './kit';
import { mcpMark } from './mcp_marks';
import { closeSheet, openSheet } from './sheet';
import { ui, vscode } from './state';

/**
 * The cell whose Disconnect is armed, if any.
 *
 * Module scope rather than the button, because `repaintMcpSheet` replaces
 * the body on a state push — a flag on the element is gone before the
 * second press can land on it.
 */
let armed: string | null = null;
let sheetOpen = false;
const lastSig = { body: '' };
type PendingAction = { operationId: string; kind: 'login' | 'disconnect'; cancelling?: boolean };
const pending = new Map<string, PendingAction>();
const failures = new Map<string, string>();
let operationSequence = 0;

export function takeMcpActionProgress(message: McpActionProgressMessage): void {
  const match = [...pending].find(([, action]) => action.operationId === message.operationId);
  if (!match) return;
  const [key] = match;
  if (message.mcp) ui.state.mcp = message.mcp;
  if (message.phase !== 'progress') {
    pending.delete(key);
    if (message.phase === 'error')
      failures.set(key, message.message ?? 'The action failed. Try again.');
  }
  repaintMcpFooter();
  if (sheetOpen) paintBody(false);
}

function submitAction(
  server: McpServerView,
  cell: McpBrandCell,
  kind: PendingAction['kind']
): void {
  const key = cellKey(server, cell);
  if (
    pending.has(key) ||
    (kind === 'login' && [...pending.values()].some((a) => a.kind === 'login'))
  )
    return;
  const operationId = `mcp-${Date.now()}-${++operationSequence}`;
  pending.set(key, { operationId, kind });
  failures.delete(key);
  armed = null;
  paintBody(true);
  vscode.postMessage({
    type: kind === 'login' ? 'startMcpLogin' : 'mcpLogout',
    operationId,
    ...(cell.target ? { target: cell.target } : {})
  });
}

function cancelAction(action?: PendingAction): void {
  if (action?.cancelling) return;
  if (action) action.cancelling = true;
  if (sheetOpen) paintBody(true);
  vscode.postMessage({
    type: 'cancelMcpLogin',
    ...(action ? { operationId: action.operationId } : {})
  });
}

/**
 * Which sections the reader has opened, and which they have shut.
 *
 * Two sets rather than one, because the default is not the same for every
 * section: this window's repo starts open and the rest start shut, so "not in
 * the open set" cannot mean shut. Module scope for `armed`'s reason — the body
 * is replaced on every state push.
 */
const opened = new Set<string>();
const shut = new Set<string>();

/**
 * A cell's identity across a repaint: the row's key, the brand, and the section.
 *
 * **Both halves are load-bearing.** One url reached from two repos is drawn in
 * two sections, each with a Disconnect of its own, so without the root arming
 * either armed both. And name-plus-host is not an identity — two `.mcp.json`
 * files in two worktrees of one repo can carry one name at two urls, and both
 * rows land in the same section.
 *
 * The row's key rather than its url, because a STDIO server has no url and its
 * command line is the one thing that must not arrive here to stand in for one.
 */
const cellKey = (server: McpServerView, cell: McpBrandCell): string =>
  JSON.stringify([server.key, cell.brand, cell.name, cell.target ?? cell.root ?? null]);

const lastFoot = new WeakMap<HTMLElement, string>();

/**
 * The one-line footer on the accounts popover. Absent when there are no
 * servers. Press opens the sheet.
 *
 * Signatured like the old section: a cpu tick must not replace the node
 * under a pointer that is already on its way down.
 */
export function repaintMcpFooter(root?: HTMLElement): void {
  const menu = root ?? document.querySelector<HTMLElement>('#nav-actions .smenu.accts');
  if (!menu || (!root && menu.hidden)) return;
  const sig = JSON.stringify(ui.state.mcp?.summary ?? null);
  if (!root && lastFoot.get(menu) === sig) return;
  lastFoot.set(menu, sig);
  const current = menu.querySelector<HTMLElement>('.mcpfoot');
  const next = mcpFooter(ui.state.mcp);
  if (current && next) current.replaceWith(next);
  else if (current) current.remove();
  else if (next) menu.append(next);
}

function mcpFooter(mcp: McpView | undefined): HTMLElement | undefined {
  if (!mcp?.summary) return undefined;
  const wrap = el('div', 'mcpfoot');
  wrap.append(el('div', 'mrule'));
  // Amber says "there is something for you to do here", so it follows the flag
  // rather than the sentence — the sentence is the host's to word, and matching
  // on it here would put a CLI's vocabulary in the webview.
  const row = el('div', mcp.summaryWants ? 'mcpgo needs' : 'mcpgo');
  row.append(el('span', 'k', 'MCP'), el('span', 'v', mcp.summary));
  wrap.append(row);
  wrap.onclick = (e) => {
    e.stopPropagation();
    closeMenu();
    openMcpSheet();
  };
  return wrap;
}

export function openMcpSheet(): void {
  sheetOpen = true;
  lastSig.body = '';
  // A sheet opens on the arrangement the host describes — this window's repo
  // and nothing else — rather than on whatever the reader left behind an hour
  // ago, which they cannot see to undo.
  opened.clear();
  shut.clear();
  // The one moment a round trip per server is worth spending: someone is
  // looking at the states. Cells keep their disk state until it answers.
  vscode.postMessage({ type: 'refreshMcpHealth' });
  openSheet({
    id: 'mscrim',
    position: 'panel',
    title: 'MCP servers',
    wide: true,
    onClose() {
      sheetOpen = false;
      armed = null;
      failures.clear();
      cancelAction([...pending.values()].find((action) => action.kind === 'login'));
    }
  });
  paintBody(true);
}

export function closeMcpSheet(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  closeSheet('mscrim');
}

/**
 * Refill the open sheet's body. Signatured so a cpu tick does not drop a press.
 */
export function repaintMcpSheet(): void {
  if (!sheetOpen) return;
  if (!ui.state.mcp) {
    closeMcpSheet();
    return;
  }
  paintBody(false);
}

function paintBody(force: boolean): void {
  const body = document.querySelector<HTMLElement>('#mscrim .asbody');
  if (!body) return;
  const groups = ui.state.mcp?.groups ?? [];
  if (
    armed &&
    !groups.some((group) =>
      group.servers.some((s) => s.brands.some((c) => c.canDisconnect && cellKey(s, c) === armed))
    )
  ) {
    armed = null;
  }
  const sig = bodySignature();
  if (!force && lastSig.body === sig) return;
  lastSig.body = sig;
  const focused =
    document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
      ? document.activeElement
      : null;
  const focusKey = focused?.closest<HTMLElement>('[data-cell]')?.dataset.cell;
  const focusRoot = focused?.classList.contains('rhead')
    ? focused.closest<HTMLElement>('.rsec')?.dataset.root
    : undefined;
  const focusIndex = focused?.parentElement
    ? [...focused.parentElement.querySelectorAll('button')].indexOf(focused as HTMLButtonElement)
    : -1;
  body.replaceChildren();
  fillBody(body, ui.state.mcp);
  if (focusKey) {
    const cell = [...body.querySelectorAll<HTMLElement>('[data-cell]')].find(
      (node) => node.dataset.cell === focusKey
    );
    const button = cell?.querySelectorAll<HTMLButtonElement>('button')[Math.max(0, focusIndex)];
    if (button && !button.disabled) button.focus();
    else if (cell) {
      cell.tabIndex = -1;
      cell.focus();
    }
  } else if (focusRoot) {
    const section = [...body.querySelectorAll<HTMLElement>('.rsec')].find(
      (node) => node.dataset.root === focusRoot
    );
    section?.querySelector<HTMLButtonElement>('.rhead')?.focus();
  }
}

function bodySignature(): string {
  return JSON.stringify([
    ui.state.mcp ?? null,
    armed,
    [...opened],
    [...shut],
    [...pending],
    [...failures]
  ]);
}

function fillBody(body: HTMLElement, mcp: McpView | undefined): void {
  if (!mcp) return;
  if (mcp.hint) body.append(el('div', 'ashint', mcp.hint));
  const present = new Set(
    mcp.groups.flatMap((g) =>
      g.servers.flatMap((server) => server.brands.map((cell) => cellKey(server, cell)))
    )
  );
  for (const [key, message] of failures) {
    if (present.has(key)) continue;
    const notice = el('div', 'ashint mcpfailure', message);
    notice.setAttribute('role', 'alert');
    body.append(notice);
  }
  if (!mcp.groups.length) return;
  const columns = new Map<BrandId, { brand: BrandId; label: string; mark: string }>();
  for (const account of ui.state.accounts ?? []) {
    columns.set(account.brand, { brand: account.brand, label: account.name, mark: account.mark });
  }
  for (const group of mcp.groups) {
    for (const server of group.servers) {
      for (const cell of server.brands) {
        if (!columns.has(cell.brand)) {
          columns.set(cell.brand, { brand: cell.brand, label: cell.label, mark: cell.mark });
        }
      }
    }
  }
  const brands = [...columns.values()];
  const acc = el('div', 'racc');
  for (const group of mcp.groups) acc.append(repoSection(group, brands));
  body.append(acc);
}

/**
 * A login in flight, which is the one thing a section cannot be shut over: the
 * row the host synthesises for one is a Cancel button and nothing else.
 */
const pinned = (group: McpGroupView): boolean =>
  group.servers.some((s) =>
    s.brands.some((c) => c.state === 'busy' || c.state === 'error' || pending.has(cellKey(s, c)))
  );

/** Whether a section is drawn open. */
const isOpen = (group: McpGroupView): boolean => pinned(group) || wantsOpen(group);

/**
 * What the reader has asked for, ignoring the pin.
 *
 * **`toggle` cannot branch on `isOpen`.** A pinned section reads as open, so a
 * press took the close branch, recorded `shut`, and changed nothing on screen —
 * and when the login ended the section collapsed on its own, having been shut
 * by a click that appeared to do nothing. The head is disabled while pinned for
 * the same reason: a control that cannot act should not look like it can.
 */
const wantsOpen = (group: McpGroupView): boolean =>
  shut.has(group.root) ? false : opened.has(group.root) || !!group.here;

function toggle(group: McpGroupView): void {
  if (wantsOpen(group)) {
    shut.add(group.root);
    opened.delete(group.root);
    return;
  }
  opened.add(group.root);
  shut.delete(group.root);
}

/**
 * One repo, open or shut.
 *
 * Shut, a section keeps its name, path, dot and count. The head is a `<button>`,
 * so it is one tab stop and one target.
 */
function repoSection(
  group: McpGroupView,
  columns: { brand: BrandId; label: string; mark: string }[]
): HTMLElement {
  const section = el('section', 'rsec' + (isOpen(group) ? ' open' : ''));
  section.dataset.root = group.root;

  const head = btn('rhead');
  head.disabled = pinned(group);
  head.setAttribute('aria-expanded', String(isOpen(group)));
  head.append(el('span', 'rdot ' + worstOf(group)));
  head.append(el('span', 'rname', group.label));
  if (group.path) head.append(el('span', 'rpath', group.path));
  head.append(el('span', 'rcount', group.servers.length ? String(group.servers.length) : '—'));
  head.append(el('span', 'rchev', '›'));
  head.onclick = (e) => {
    e.stopPropagation();
    toggle(group);
    section.classList.toggle('open', isOpen(group));
    head.setAttribute('aria-expanded', String(isOpen(group)));
    lastSig.body = bodySignature();
  };
  section.append(head);

  const inner = el('div', 'rbody');
  if (group.servers.length) {
    inner.setAttribute('role', 'table');
    inner.style.setProperty('--mcp-brands', String(columns.length));
    const labels = el('div', 'mchead');
    labels.setAttribute('role', 'row');
    const serverLabel = el('span', 'mcsrv', 'Server');
    serverLabel.setAttribute('role', 'columnheader');
    labels.append(serverLabel);
    for (const column of columns) {
      const label = el('span', 'mcbrand');
      label.setAttribute('role', 'columnheader');
      label.append(brandMark(column.mark), el('span', null, column.label));
      labels.append(label);
    }
    inner.append(labels);
    for (const server of group.servers) inner.append(serverRow(server, columns));
  } else if (group.emptyLine) {
    inner.append(el('div', 'rempty', group.emptyLine));
  }
  section.append(inner);
  return section;
}

/**
 * The worst thing in a section, as the dot says it.
 *
 * Three values rather than seven: the dot is read at a glance off a shut head,
 * so it answers whether there is anything to look at and the cells answer what.
 *
 * **`pending` counts, where in the footer it does not.** `summaryWants` stays
 * cool for one because nothing on that footer can approve it; a section dot
 * points at the repo it is approved in, which is exactly where the reader has
 * to go. Same state, two questions.
 *
 * **`unknown` counts as neither.** Amber would send the reader after a problem
 * nobody reported, and green would claim a connection nobody checked — so a
 * section holding only unknowns wears the same bare dot as an empty one.
 */
function worstOf(group: McpGroupView): string {
  if (!group.servers.length) return 'none';
  const states = group.servers.flatMap((s) => s.brands.map((c) => c.state));
  if (states.every((state) => state === 'unknown')) return 'none';
  return states.every((state) => state === 'ok' || state === 'unknown') ? 'ok' : 'needs';
}

function serverRow(
  server: McpServerView,
  columns: { brand: BrandId; label: string; mark: string }[]
): HTMLElement {
  const row = el('div', 'srow');
  row.setAttribute('role', 'row');
  const identity = el('div', 'sidentity');
  identity.setAttribute('role', 'rowheader');
  const mark = el('div', 'mark');
  const glyph = mcpMark(server.host);
  if (glyph) mark.append(glyph);
  identity.append(mark);

  const main = el('div', 'smeta');
  main.append(el('div', 'who', server.name));
  // Inside a section the repo is the heading, so this line spends itself on
  // what the flat row had no room for: which config declares it, and — when
  // another section lists the same url — that one login covers both.
  const detail = el('div', 'host', server.host);
  if (server.scopeLabel) {
    detail.append(el('span', 'scope ' + (server.scope ?? ''), server.scopeLabel));
  }
  if (server.alsoIn?.length) {
    const tag = el('span', 'shrd', 'also in ' + server.alsoIn.join(', '));
    tag.dataset.tip = 'One login, keyed by url — both repos share it.';
    detail.append(tag);
  }
  main.append(detail);
  identity.append(main);
  row.append(identity);

  const details = el('div', 'sdetails');
  for (const column of columns) {
    const cell = server.brands.find((candidate) => candidate.brand === column.brand);
    if (cell) {
      row.append(brandCell(server, cell, details));
      continue;
    }
    const absent = el('div', 'bcell absent');
    absent.setAttribute('role', 'cell');
    absent.dataset.brand = column.brand;
    absent.setAttribute('aria-label', `${column.label}: Not listed`);
    absent.append(el('span', 'bs', '—'));
    row.append(absent);
  }
  if (details.childElementCount) row.append(details);
  return row;
}

function brandCell(server: McpServerView, cell: McpBrandCell, details: HTMLElement): HTMLElement {
  const key = cellKey(server, cell);
  const action = pending.get(key);
  const failure = failures.get(key);
  if (action)
    cell = {
      ...cell,
      state: 'busy',
      canDisconnect: false,
      note: action.cancelling
        ? 'Cancelling…'
        : action.kind === 'disconnect'
          ? 'Disconnecting…'
          : cell.state === 'busy'
            ? cell.note
            : 'Starting…'
    };
  else if (failure) cell = { ...cell, state: 'error', note: failure };
  const box = el('div', 'bcell ' + cell.state);
  box.dataset.cell = key;
  if (action || cell.state === 'busy') box.setAttribute('aria-busy', 'true');
  box.setAttribute('role', 'cell');
  box.dataset.brand = cell.brand;
  box.append(brandMark(cell.mark));
  const id = el('div', 'bn', cell.label);
  box.append(id);
  box.append(el('div', 'bs', cellStatus(cell)));

  // One line per cell, however many parts it carries: the mark and the brand
  // name are the line's "which cell is this about", and a second copy of them
  // under one cell reads as a second cell.
  const addDetail = (...parts: (HTMLElement | undefined)[]): void => {
    const stack = el('div', 'bdstack');
    for (const part of parts) if (part) stack.append(part);
    if (!stack.childElementCount) return;
    const line = el('div', 'bdetail ' + cell.state);
    line.append(brandMark(cell.mark), el('span', 'bdbrand', cell.label), stack);
    details.append(line);
  };
  if (cell.state === 'error' && cell.note) addDetail(el('div', 'why', cell.note));

  // `broken` is authorised and unreachable, so it takes the same verb as `ok`:
  // Authorise is wrong — the login is fine — and Disconnect is all that applies.
  // Which cells those are is the host's answer now, not this file's: a Codex
  // server can be connected on a token it configured and owe us nothing.
  if (cell.canDisconnect) {
    const isArmed = armed === cellKey(server, cell);
    box.append(isArmed ? disconnectConfirm(server, cell) : disconnectArm(server, cell));
    // Armed on a url another repo also reaches: one login, so this takes
    // theirs. The confirm is the last place that can say so.
    addDetail(
      isArmed && server.alsoIn?.length ? el('div', 'why', reachOf(server)) : undefined,
      cell.note && cell.state === 'broken' ? el('div', 'why', cell.note) : undefined
    );
    return box;
  }
  // Declared in a `.mcp.json` nobody has approved. It does not load into a
  // session and `claude mcp login` refuses it, so neither verb applies.
  if (cell.state === 'pending') {
    if (cell.note) addDetail(el('div', 'why', cell.note));
    return box;
  }
  // Nothing was asked and nothing failed. Authorise would be a guess about
  // which of the two it is.
  if (cell.state === 'unknown') {
    if (cell.note) addDetail(el('div', 'why', cell.note));
    return box;
  }
  if (cell.state === 'busy') {
    const act = btn(
      'ba',
      action?.cancelling
        ? 'Cancelling…'
        : action?.kind === 'disconnect'
          ? 'Disconnecting…'
          : 'Cancel'
    );
    act.disabled = !!action?.cancelling || action?.kind === 'disconnect';
    act.onclick = (e) => {
      e.stopPropagation();
      cancelAction(action);
    };
    box.append(act);
    addDetail(
      cell.note ? el('div', 'wait', cell.note) : undefined,
      cell.url ? mcpUrlBlock(cell.url) : undefined
    );
    return box;
  }
  if (cell.fromAccount) {
    box.append(el('span', 'said', 'From the account'));
    return box;
  }
  if (!cell.supported) {
    box.append(el('span', 'said', cell.state === 'needs' ? 'Needs auth' : 'Failed'));
    return box;
  }
  // Connected, and its credential is not ours — a configured bearer token, or a
  // STDIO process with no auth at all. The status line above is the whole cell.
  if (cell.state === 'ok' || cell.state === 'broken') {
    if (cell.note && cell.state === 'broken') addDetail(el('div', 'why', cell.note));
    return box;
  }
  const act = btn('ba fix', cell.state === 'error' ? 'Retry' : 'Authorise');
  act.disabled = [...pending.values()].some((a) => a.kind === 'login');
  act.onclick = (e) => {
    e.stopPropagation();
    submitAction(server, cell, 'login');
  };
  box.append(act);
  return box;
}

/** Every repo one login reaches, for the confirm that is about to take it. */
function reachOf(server: McpServerView): string {
  const every = server.projects.length ? server.projects : (server.alsoIn ?? []);
  return 'One login, keyed by url — this takes it for ' + every.join(' and ') + '.';
}

function cellStatus(cell: McpBrandCell): string {
  if (cell.state === 'ok') return 'Connected';
  if (cell.state === 'needs') return 'Needs auth';
  // Short here, reason on its own full-width line: the CLI's sentences run to
  // 90 characters and this is a 10px cell beside a button.
  if (cell.state === 'broken') return 'Unreachable';
  if (cell.state === 'pending') return 'Not approved';
  if (cell.state === 'unknown') return 'Not checked';
  if (cell.state === 'error') return 'Failed';
  return cell.url ? 'Browser opened' : cell.note === 'Starting…' ? 'Starting…' : 'Waiting';
}

function disconnectArm(server: McpServerView, cell: McpBrandCell): HTMLElement {
  const act = btn('ba out', 'Disconnect');
  act.onclick = (e) => {
    e.stopPropagation();
    armed = cellKey(server, cell);
    paintBody(true);
  };
  return act;
}

function disconnectConfirm(server: McpServerView, cell: McpBrandCell): HTMLElement {
  const act = btn('ba out arm', 'Disconnect?');
  act.onclick = (e) => {
    e.stopPropagation();
    submitAction(server, cell, 'disconnect');
  };
  return act;
}

function mcpUrlBlock(url: string): HTMLElement {
  const wrap = el('div', 'mcpurl');
  const block = el('div', 'aurl');
  block.append(el('span', null, url.replace(/^https:\/\//, '')));
  const copy = btn('b sec', 'Copy');
  copy.onclick = (e) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(url);
  };
  const open = btn('b pri', 'Open');
  open.onclick = (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'openLoginUrl', url });
  };
  block.append(copy, open);
  wrap.append(block);
  return wrap;
}
