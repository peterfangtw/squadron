/**
 * The servers sheet: every worktree of a repo beside everything the selected one
 * can start, each row live or not.
 *
 * A sheet over the board rather than a popover on the heading, and for the
 * reason `resume.ts` is one: occupancy and a worktree's starts arrive in their
 * own push. The rail paints from the state message; the starts wait for `ports`.
 *
 * Rail and starts are morphed from the state on every push, so a click is
 * delegated and reads its target off the DOM: a morph keeps a node and drops
 * what a handler closed over. The same morph keeps focus across the 3s push.
 *
 * Its own backdrop, like `resume.ts`'s: `#scrim` belongs to `question.ts`, and
 * two owners of one element is a bug waiting for the day both are open.
 */

import { unsafePort } from '../core/devservers/unsafe';
import { pathLeaf } from '../ui/local_path';
import * as serverSheet from '../ui/server_sheet';
import { rowKey, srvKey, STOP_WAIT_MS, stopListener, stopMark, stopRecord } from './board_servers';
import { findCard } from './board_card';
import { $, el, q } from './dom';
import { morph } from './kit';
import { chats, ui, vscode } from './state';

const scrim = $('rscrim');
const sheet = $('runsheet');
const body = $('rbody');

/** Long enough for the poll that shows a started server, short enough that a
 *  start nobody honoured offers Run again. */
const LAUNCH_WAIT_MS = 8_000;

/** The repo and worktree the sheet is on, or nothing when it is shut. Also what a
 *  late answer is checked against. */
let open: { group: string; tree: string; branch: string } | undefined;

/** Every start's block as the host last answered it, each port once. Each start
 *  draws its own rows out of it (`serverSheet.blockRows`). `undefined` until the
 *  selected worktree has an answer. */
let block: PortsMessage['ports'] | undefined;
let starts: PortsMessage['starts'] = [];
let lastUsed: PortsMessage['lastUsed'] = {};

/** The start whose port row is open, and each start's chosen port. */
let expanded: string | undefined;
let chosen = new Map<string, number>();
/** What each start's field holds, as typed. Written back as `value` on every
 *  paint: morphdom assigns `value` on an input it keeps, so text held only in
 *  the DOM would go on the next push. */
let typed = new Map<string, string>();
/** Ports a tile's Stop has told to go, and when. The socket goes a beat after the
 *  terminal does, so the tile says so until an answer finds the port free, or
 *  the wait a chip gives a stop runs out and the tile offers Stop again. */
let stoppingPorts = new Map<number, number>();
/** Starts just run, and when: nothing shows a press until the next poll, and a
 *  second press would start a second server. */
let launching = new Map<string, number>();
/** What the last ask saw, so a server taking or leaving a port asks again. */
let asked = '';

export function openRunPicker(group: string, tree?: string): void {
  const rows = rowsOf(group);
  const entries = serverSheet.worktrees(rows);
  const entry = entries.find((e) => e.tree === tree) ?? selectedCardsTree(entries) ?? entries[0];
  if (!entry) return;
  open = { group, tree: entry.tree, branch: entry.branch };
  scrim.hidden = false;
  sheet.hidden = false;
  ask(rows, entry);
  paint();
  // The sheet itself: Escape is listened for here, and before the answer lands
  // the sheet may hold nothing else to focus.
  sheet.focus();
}

export function closeRunPicker(): void {
  const group = open?.group;
  open = undefined;
  block = undefined;
  starts = [];
  lastUsed = {};
  expanded = undefined;
  chosen = new Map();
  typed = new Map();
  stoppingPorts = new Map();
  launching = new Map();
  asked = '';
  scrim.hidden = true;
  sheet.hidden = true;
  [...document.querySelectorAll<HTMLElement>('.sdoor')]
    .find((door) => door.dataset.group === group)
    ?.focus();
}

/** A state push: redraw, and ask again if a port changed hands. */
export function repaintRunPicker(): void {
  if (!open) return;
  const rows = rowsOf(open.group);
  const entries = serverSheet.worktrees(rows);
  if (!entries.length) {
    closeRunPicker();
    return;
  }
  const entry = entries.find((e) => e.tree === open?.tree);
  if (!entry) {
    select(entries[0]);
    return;
  }
  // A checkout can change branch under an open sheet: the answer is keyed by
  // branch, and what is remembered belongs to the new one.
  const moved = entry.branch !== open.branch;
  if (moved) open = { ...open, branch: entry.branch };
  const live = serverSheet.liveSignature(rows);
  if (live !== asked) launching = new Map();
  if (live !== asked || moved) ask(rows, entry);
  paint();
}

/** The host's answer, ignored unless the sheet is still on that worktree. */
export function takePorts(msg: PortsMessage): void {
  if (!open || msg.cwd !== open.tree || msg.branch !== open.branch) return;
  block = msg.ports;
  starts = msg.starts;
  lastUsed = msg.lastUsed;
  stoppingPorts = new Map(
    [...stoppingPorts].filter(([port]) => msg.ports.some((row) => row.port === port && !row.free))
  );
  paint();
}

const rowsOf = (group: string): ServerRowView[] =>
  ui.state.groups.find((g) => g.cwd === group)?.servers ?? [];

/** The worktree of the selected card. The nearest containing one: a worktree is
 *  commonly nested under the repo's own, which contains it too. */
function selectedCardsTree(
  entries: serverSheet.WorktreeEntry[]
): serverSheet.WorktreeEntry | undefined {
  const active = chats.active();
  if (active?.kind !== 'session') return undefined;
  const cwd = findCard(active.pid)?.card.fullCwd;
  if (cwd === undefined) return undefined;
  return entries
    .filter((e) => e.tree === cwd || relativeTo(e.tree, cwd) !== undefined)
    .sort((a, b) => b.tree.length - a.tree.length)[0];
}

/** `path` below `root`, or nothing. Either separator: a Windows checkout. */
function relativeTo(root: string, path: string): string | undefined {
  const next = path[root.length];
  return path.startsWith(root) && (next === '/' || next === '\\')
    ? path.slice(root.length + 1)
    : undefined;
}

function ask(rows: ServerRowView[], entry: serverSheet.WorktreeEntry): void {
  asked = serverSheet.liveSignature(rows);
  vscode.postMessage({
    type: 'openRunPicker',
    cwd: entry.tree,
    tree: entry.tree,
    branch: entry.branch
  });
}

function select(entry: serverSheet.WorktreeEntry | undefined): void {
  if (!open || !entry) return;
  open = { group: open.group, tree: entry.tree, branch: entry.branch };
  block = undefined;
  starts = [];
  lastUsed = {};
  expanded = undefined;
  chosen = new Map();
  typed = new Map();
  launching = new Map();
  ask(rowsOf(open.group), entry);
  paint();
}

function paint(): void {
  if (!open) return;
  const rows = rowsOf(open.group);
  const entries = serverSheet.worktrees(rows);
  const entry = entries.find((e) => e.tree === open?.tree);
  const group = ui.state.groups.find((g) => g.cwd === open?.group);
  q(sheet, '.ttl').textContent = group?.label ?? '';
  q(sheet, '.cw').textContent = headCount(entries.length, rows.filter(serverSheet.isLive).length);
  morph(body, [rail(entries), startsColumn(entry)]);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const headCount = (trees: number, live: number): string =>
  live ? `${plural(trees, 'worktree')} · ${plural(live, 'server')}` : plural(trees, 'worktree');

function rail(entries: serverSheet.WorktreeEntry[]): HTMLElement {
  const col = el('div', 'srail');
  col.dataset.key = 'srail';
  col.setAttribute('role', 'group');
  col.setAttribute('aria-label', 'Worktrees');
  const section = (word: string, members: serverSheet.WorktreeEntry[]): void => {
    if (!members.length) return;
    const cap = el('span', 'cap', word);
    cap.dataset.key = 'cap:' + word;
    col.append(cap, ...members.map(railRow));
  };
  section(
    'Running',
    entries.filter((e) => e.running)
  );
  section(
    'Idle',
    entries.filter((e) => !e.running)
  );
  return col;
}

function railRow(entry: serverSheet.WorktreeEntry): HTMLElement {
  const on = entry.tree === open?.tree;
  const row = el('button', on ? 'rstart on' : 'rstart');
  row.dataset.key = 'tree:' + entry.tree;
  row.dataset.sheet = 'tree';
  row.dataset.tree = entry.tree;
  row.setAttribute('aria-pressed', String(on));
  row.append(stateDot(entry.dot), el('span', 'nm', entry.branch));
  if (entry.meta) row.append(el('span', entry.failed ? 'np bad' : 'np', entry.meta));
  return row;
}

const stateDot = (state: string): HTMLElement => {
  const wrap = el('span', 'srv sdot ' + state);
  wrap.append(el('span', 'dot ' + state));
  return wrap;
};

function startsColumn(entry: serverSheet.WorktreeEntry | undefined): HTMLElement {
  const col = el('div', 'sstarts');
  col.dataset.key = 'sstarts';
  if (!entry || !open) return col;
  const head = el('div', 'sshead');
  head.dataset.key = 'sshead';
  head.append(
    el('b', null, entry.branch),
    el('span', null, relativeTo(open.group, entry.tree) ?? pathLeaf(entry.tree))
  );
  col.append(head);
  const note = startsNote(entry);
  if (note) col.append(note);
  for (const row of serverSheet.startRows(entry.rows, starts)) {
    col.append(startRow(row));
    if (row.key === expanded && row.start && block && runnable(row)) {
      col.append(portRow(row.start, block));
    }
  }
  return col;
}

/** The one sentence the column owes, or nothing. Keyed, so a morph updates it. */
function startsNote(entry: serverSheet.WorktreeEntry): HTMLElement | undefined {
  const text = noteText(entry);
  if (text === undefined) return undefined;
  const note = el('div', 'rnote', text);
  note.dataset.key = 'rnote';
  return note;
}

function noteText(entry: serverSheet.WorktreeEntry): string | undefined {
  if (!block) return 'Checking which ports are free…';
  if (starts.length === 0) {
    return entry.rows.some((row) => row.workspaces)
      ? 'This repo declares workspaces, but nothing here resolved to something to run. ' +
          'Name a command in the squadron.run.commands setting, keyed by the directory.'
      : 'Nothing here to start. Name a command in the squadron.run.commands setting.';
  }
  if (entry.rows.some((row) => row.candidates !== undefined)) {
    return 'More than one script could be the server. Pick one to run.';
  }
  const ranges = exhaustedRanges(block);
  if (ranges) {
    return (
      `Every port ${ranges.join(' and ')} is in use. ` +
      'Free one, type another in a start’s port row, or widen this repo’s block.'
    );
  }
  return undefined;
}

/**
 * Each distinct range the port-taking starts are offered, once none of them
 * has a port to run on — or nothing while any start has one (a free tile, its
 * outside row, a typed port), whose full neighbours then say `no free port`
 * on their own (`portSlot`).
 */
function exhaustedRanges(union: PortsMessage['ports']): string[] | undefined {
  const takers = starts.filter((start) => !start.portless);
  if (!takers.length || takers.some((start) => portFor(start) !== undefined)) return undefined;
  const rows = takers.map((start) => serverSheet.blockRows(start, union));
  const ranges = rows.map((own) => `from ${own[0]?.port} to ${own[own.length - 1]?.port}`);
  return [...new Set(ranges)];
}

function startRow(row: serverSheet.StartRow): HTMLElement {
  const live = row.live;
  const going = live !== undefined && stopMark(live) !== undefined;
  const state = going ? 'stopping' : live ? serverSheet.rowDot(live) : 'off';
  const node = el('div', row.key === expanded ? 'sstart open' : 'sstart');
  node.dataset.key = 'sstart:' + row.key;
  node.append(stateDot(state), nameOf(row, going), portSlot(row, going), actions(row, going));
  return node;
}

function nameOf(row: serverSheet.StartRow, going: boolean): HTMLElement {
  const nm = el('span', 'nm');
  nm.append(el('b', null, row.name));
  const failed = row.live?.status === 'failed';
  const sub = going
    ? 'stopping…'
    : failed
      ? (row.live?.reason ?? 'failed')
      : row.live?.status === 'starting'
        ? 'starting…'
        : row.live?.listener
          ? row.live.listener.session
          : row.start?.guessed
            ? `${row.runner || row.start.label} · PORT only`
            : row.runner;
  if (sub && sub !== row.name) nm.append(el('i', failed && !going ? 'bad' : null, sub));
  return nm;
}

/** What the row's port says: a link when it answers, a choice when it can run. */
function portSlot(row: serverSheet.StartRow, going: boolean): HTMLElement {
  const slot = el('span', 'port');
  const live = row.live;
  if (live && live.status !== 'failed') {
    if (live.url && !going && live.status !== 'starting') {
      const link = el('button', 'slink', ':' + live.port);
      link.dataset.sheet = 'open';
      link.dataset.url = live.url;
      link.setAttribute('aria-label', 'Open ' + live.url);
      slot.append(link);
    } else if (live.port !== undefined) {
      slot.textContent = ':' + live.port;
    }
    return slot;
  }
  if (!row.start) return slot;
  if (row.start.portless) {
    slot.textContent = 'no port';
    return slot;
  }
  const port = portFor(row.start);
  if (port !== undefined && launchedAt(row.key) !== undefined) {
    slot.textContent = ':' + port;
  } else if (refusalOf(row.start) !== undefined) {
    const text = typed.get(row.key)?.trim() ?? '';
    slot.append(pickButton(row, ':' + text, `on port ${text}, change`));
  } else if (port !== undefined) {
    slot.append(pickButton(row, ':' + port, `on port ${port}, change`));
  } else if (block) {
    // Its own block is full, and still a pick: the field in the port row is
    // what reaches past the block.
    slot.append(pickButton(row, 'no free port', 'has no free port, type another'));
  }
  return slot;
}

function pickButton(row: serverSheet.StartRow, shown: string, says: string): HTMLElement {
  const pick = el('button', 'spick', `${shown} ▾`);
  pick.dataset.sheet = 'ports';
  pick.dataset.start = row.key;
  pick.setAttribute('aria-expanded', String(row.key === expanded));
  pick.setAttribute('aria-label', `${row.name} ${says}`);
  return pick;
}

function actions(row: serverSheet.StartRow, going: boolean): HTMLElement {
  const acts = el('span', 'acts');
  const live = row.live;
  if (going) return acts;
  if (live) acts.append(stopButton(live, row.name));
  if (row.start && runnable(row)) {
    const run = runButton(row.start, row);
    if (run) acts.append(run);
  }
  return acts;
}

/** Nothing running there, or what ran failed. */
const runnable = (row: serverSheet.StartRow): boolean => !row.live || row.live.status === 'failed';

/** When this start was run, while that press is still unanswered. */
function launchedAt(key: string): number | undefined {
  const pressed = launching.get(key);
  return pressed !== undefined && Date.now() - pressed < LAUNCH_WAIT_MS ? pressed : undefined;
}

function stopButton(live: ServerRowView, name: string): HTMLElement {
  const stop = el('button', 'sact', 'Stop');
  stop.dataset.key = 'stop:' + rowKey(live);
  stop.dataset.stopKey = rowKey(live);
  stop.dataset.status = live.status ?? '';
  if (live.status !== undefined) {
    stop.dataset.sheet = 'stop';
    stop.dataset.cwd = live.cwd;
    stop.dataset.runner = live.runnerId;
    stop.setAttribute('aria-label', 'Stop ' + name);
  } else if (live.listener && live.port !== undefined) {
    stop.dataset.sheet = 'kill';
    stop.dataset.port = String(live.port);
    stop.dataset.pid = String(live.listener.pid);
    stop.dataset.startedAt = String(live.listener.startedAt);
    stop.dataset.command = live.listener.command;
    stop.setAttribute(
      'aria-label',
      `Stop ${live.listener.command || 'process'} ${live.listener.pid}`
    );
  }
  return stop;
}

function runButton(start: RunStart, row: serverSheet.StartRow): HTMLElement | undefined {
  const key = row.key;
  if (launchedAt(key) !== undefined) {
    const wait = el('button', 'sact', 'Starting…');
    wait.dataset.key = 'wait:' + key;
    wait.toggleAttribute('disabled', true);
    return wait;
  }
  if (!block) return undefined;
  const port = portFor(start);
  const refused = refusalOf(start) !== undefined;
  if (!start.portless && port === undefined && !refused) return undefined;
  const armed = key === expanded;
  const button = el('button', armed ? 'sact go' : 'sact', armed && port ? `Run :${port}` : 'Run');
  button.dataset.key = 'run:' + key;
  button.dataset.sheet = 'run';
  button.dataset.start = key;
  button.setAttribute('aria-label', port ? `Run ${row.name} on port ${port}` : `Run ${row.name}`);
  // The field says why, beside itself.
  if (refused) button.toggleAttribute('disabled', true);
  return button;
}

/** What this start's field says, or nothing while it is empty. */
function typedEntry(start: RunStart): serverSheet.TypedPort | undefined {
  const text = typed.get(start.key) ?? '';
  return text.trim() ? serverSheet.typedPort(text, block ?? []) : undefined;
}

/** Why this start's field cannot be run on, or nothing. */
function refusalOf(start: RunStart): string | undefined {
  const entry = typedEntry(start);
  return entry && 'refusal' in entry ? entry.refusal : undefined;
}

/** The port a Run on this start would take: the reader's pick while it stays
 *  free, otherwise the default. */
function portFor(start: RunStart): number | undefined {
  if (!block || start.portless) return undefined;
  const entry = typedEntry(start);
  if (entry) return entry.port;
  const pick = serverSheet
    .offeredRows(start, block, lastUsed)
    .find((row) => row.port === chosen.get(start.key));
  return pick && serverSheet.pickable(pick)
    ? pick.port
    : serverSheet.defaultPort(start, block, lastUsed);
}

function portRow(start: RunStart, union: PortsMessage['ports']): HTMLElement {
  const ports = serverSheet.blockRows(start, union);
  const row = el('div', 'sports');
  row.dataset.key = 'sports:' + start.key;
  const head = el('div', 'colhead');
  const count = el('span', 'cnt');
  count.append(
    el('b', null, String(ports.filter(serverSheet.pickable).length)),
    document.createTextNode(` of ${ports.length} free`)
  );
  head.append(el('span', null, 'Port'), count);
  const grid = el('div', 'rgrid');
  // A group and not a radiogroup: ten tiles are ten tab stops and arrows move
  // nothing, which is not what `radiogroup` promises.
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Port');
  const armed = portFor(start);
  for (const port of ports) grid.append(tileFor(port, start, armed));
  row.append(head, grid);
  const outside = serverSheet.outsideRow(start, union, lastUsed);
  if (outside) row.append(outsideLine(outside, start, armed));
  row.append(portField(start));
  return row;
}

/**
 * Any port at all, typed. Hand-built rather than `numInput`, which clamps and
 * commits on blur: this field shows a refusal as it is typed. `type=text` for
 * `numInput`'s reason — Chromium steps a focused `type=number` on the wheel.
 * Not bind-tested per keystroke: a port the answer shows taken is refused here
 * (`typedPort`), and any other the host binds once at the press, failing the
 * row as `port in use` rather than spawning onto it (`runServerHere`).
 */
function portField(start: RunStart): HTMLElement {
  const line = el('div', 'rtype');
  line.dataset.key = 'rtype:' + start.key;
  const input = el('input', 'rport') as HTMLInputElement;
  input.dataset.key = 'rport:' + start.key;
  input.dataset.start = start.key;
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Other port';
  input.setAttribute('aria-label', 'Another port');
  input.value = typed.get(start.key) ?? '';
  line.append(input);
  const refusal = refusalOf(start);
  if (refusal !== undefined) {
    input.setAttribute('aria-invalid', 'true');
    line.append(el('span', 'rwhy', refusal));
  }
  return line;
}

/**
 * The port this start used last, outside its block: its own line under the
 * grid and never an eleventh cell, which would say the block has eleven ports.
 * Outside `.rgrid` too, so a count of the grid's tiles still counts the block.
 */
function outsideLine(
  port: PortsMessage['ports'][number],
  start: RunStart,
  armed: number | undefined
): HTMLElement {
  const line = el('div', 'rout');
  line.dataset.key = 'rout:' + start.key;
  const tile = tileFor(port, start, armed);
  const number = tile.querySelector('.p');
  if (number) number.textContent = 'last: ' + port.port;
  // The line already says it was used last.
  if (serverSheet.pickable(port)) tile.querySelector('.u')?.remove();
  line.append(tile);
  return line;
}

/** What a tile says on hover and when read out: the panel's own tip rather than
 *  the host's `title`, which pops two inches from the sheet it belongs to. */
function explain(tile: HTMLElement, text: string): void {
  tile.dataset.tip = text;
  tile.setAttribute('aria-label', text);
}

function tileFor(
  row: PortsMessage['ports'][number],
  start: RunStart,
  armed: number | undefined
): HTMLElement {
  if (!row.free) return heldTile(row);
  const refused = unsafePort(row.port);
  return refused === undefined ? freeTile(row, start, armed) : refusedTile(row, refused);
}

/** Free on this machine and still no use: a browser will not open it, or the
 *  OS may hand it out. A container like `heldTile`, for its reason, and a tab
 *  stop of its own: it has no Stop to carry the reader's focus to the reason. */
function refusedTile(row: { port: number }, reason: string): HTMLElement {
  const tile = el('div', 'rtile refused');
  tile.dataset.key = 'tile:' + row.port;
  tile.append(el('span', 'p', String(row.port)), el('span', 'u', 'unsafe'));
  tile.setAttribute('role', 'group');
  tile.tabIndex = 0;
  explain(tile, `${row.port} — ${reason}`);
  return tile;
}

function freeTile(row: { port: number }, start: RunStart, armed: number | undefined): HTMLElement {
  const on = row.port === armed;
  const tile = el('button', on ? 'rtile on' : 'rtile');
  tile.dataset.key = 'tile:' + row.port;
  tile.dataset.sheet = 'tile';
  tile.dataset.start = start.key;
  tile.dataset.port = String(row.port);
  tile.append(el('span', 'p', String(row.port)));
  // Only the states that are news get a word.
  if (row.port === lastUsed[start.key]) tile.append(el('span', 'u', 'last'));
  explain(tile, `${row.port} — free`);
  tile.setAttribute('aria-pressed', String(on));
  return tile;
}

/**
 * A held tile is a container, not a disabled control: `disabled` would take the
 * one fact the reader came for out of the tab ring. `role="group"` because ARIA
 * exposes no name on a plain `div`.
 */
function heldTile(row: Exclude<PortsMessage['ports'][number], { free: true }>): HTMLElement {
  const tile = el('div', 'rtile busy');
  tile.dataset.key = 'tile:' + row.port;
  const held = 'holder' in row ? row : undefined;
  const told = stoppingPorts.get(row.port);
  const going = told !== undefined && Date.now() - told < STOP_WAIT_MS;
  tile.append(
    el('span', 'p', String(row.port)),
    el('span', 'u', going ? 'stopping…' : (held?.heldBy ?? 'in use'))
  );
  tile.setAttribute('role', 'group');
  explain(
    tile,
    held
      ? `${row.port} — held by ${held.heldBy}`
      : `${row.port} — in use by something outside this panel`
  );
  if (going) {
    tile.classList.add('going');
    return tile;
  }
  // Only ours to stop. A port something else is listening on offers no button
  // that would have nothing to send.
  if (!held) return tile;
  const stop = el('button', 'stop', 'Stop');
  stop.dataset.sheet = 'tilestop';
  stop.dataset.port = String(row.port);
  stop.dataset.cwd = held.holder.cwd;
  stop.dataset.runner = held.holder.runnerId;
  stop.setAttribute('aria-label', `Stop ${held.heldBy}, which holds port ${row.port}`);
  tile.append(stop);
  return tile;
}

/** Start what a row says, on the port it shows. */
function run(key: string): void {
  const row = openRows().find((r) => r.key === key);
  if (!open || !row?.start || !runnable(row) || launchedAt(key) !== undefined) return;
  if (row.live && stopMark(row.live) !== undefined) return;
  const start = row.start;
  const port = portFor(start);
  if (!start.portless && port === undefined) return;
  vscode.postMessage({
    type: 'run',
    cwd: start.cwd,
    tree: open.tree,
    runnerId: start.runnerId,
    branch: open.branch,
    ...(port === undefined ? {} : { port })
  });
  launching.set(key, Date.now());
  expanded = undefined;
  paint();
}

const openRows = (): serverSheet.StartRow[] =>
  open
    ? serverSheet.startRows(
        rowsOf(open.group).filter((row) => row.tree === open?.tree),
        starts
      )
    : [];

const heldBy =
  (cwd: string, runner: string) =>
  (row: ServerRowView): boolean =>
    row.cwd === cwd && row.runnerId === runner;

function press(node: HTMLElement): void {
  const { start, port, cwd, runner, stopKey, status, tree, url } = node.dataset;
  switch (node.dataset.sheet) {
    case 'tree':
      if (tree !== open?.tree && open) {
        select(serverSheet.worktrees(rowsOf(open.group)).find((e) => e.tree === tree));
      }
      return;
    case 'open':
      if (url) vscode.postMessage({ type: 'openServer', url });
      return;
    case 'run':
      if (start !== undefined) run(start);
      return;
    case 'ports':
      expanded = expanded === start ? undefined : start;
      paint();
      return;
    case 'tile':
      if (start !== undefined) {
        chosen.set(start, Number(port));
        typed.delete(start);
      }
      paint();
      return;
    case 'stop':
      if (stopKey !== undefined && cwd !== undefined && runner !== undefined) {
        stopRecord(stopKey, status ?? '', cwd, runner);
        paint();
      }
      return;
    case 'kill':
      if (stopKey !== undefined && node.dataset.pid !== undefined) {
        stopListener(
          stopKey,
          status ?? '',
          Number(port),
          Number(node.dataset.pid),
          Number(node.dataset.startedAt),
          node.dataset.command ?? ''
        );
        paint();
      }
      return;
    case 'tilestop':
      if (cwd !== undefined && runner !== undefined) {
        stoppingPorts.set(Number(port), Date.now());
        // The holder may be a row of this sheet, whose chip and row then agree.
        const held = open ? rowsOf(open.group).find(heldBy(cwd, runner)) : undefined;
        stopRecord(held ? rowKey(held) : srvKey(cwd, runner), held?.status ?? 'up', cwd, runner);
        paint();
      }
  }
}

body.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  const hit = target?.closest<HTMLElement>('[data-sheet]');
  if (!hit) return;
  press(hit);
  // Run and Stop replace what was pressed. Focus falling to the document would
  // take Escape with it, which is listened for on the sheet.
  if (document.activeElement === document.body) sheet.focus();
});
// Delegated, as clicks are: the field is morphed and keeps no handler.
body.addEventListener('input', (e) => {
  const input = e.target instanceof HTMLInputElement ? e.target : null;
  const start = input?.classList.contains('rport') ? input.dataset.start : undefined;
  if (!input || start === undefined) return;
  typed.set(start, input.value);
  paint();
});
scrim.onclick = () => closeRunPicker();

// On the sheet rather than the document: this is modal over the board, and
// Escape at a session's ask is a different Escape entirely.
sheet.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeRunPicker();
  } else if (e.key === 'Enter' && expanded !== undefined) {
    // Not over a button: a tile's own Enter arms it, and booting as well would
    // make one keystroke pick a port and start on it. Nor over a refused or
    // held tile, which is not a button and whose port is not the armed one.
    if (e.target instanceof HTMLElement && e.target.closest('button, .rtile')) return;
    run(expanded);
  } else {
    return;
  }
  e.preventDefault();
});
