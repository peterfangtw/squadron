/**
 * The resume picker: a directory's past conversations, over the board.
 *
 * Resume is a way *in*, not a repair for a dead card, so this hangs off the
 * `+ New` slot rather than off any session — by the time a reader wants
 * a conversation back it usually left the board hours ago. What it shows comes
 * from the transcript index, because a CLI's own list may be cloud-backed and
 * has been seen to lose sessions.
 *
 * Its own backdrop rather than the ask layer's `#scrim`: that one is owned by
 * `question.ts`, down to the click that dismisses it, and two owners of one
 * element is a bug waiting for the day both are open at once.
 */

import { brandMark } from './accounts';
import { $, ago, el, imeKey, q } from './dom';
import { DEFAULT_BRAND } from '../core/brands';
import type { LaunchTarget } from '../core/model';
import { brandForModel, effortFor } from '../core/model_names';
import { ui, vscode } from './state';
import { morph } from './kit';
import * as layers from './layers';
import { repaintBoard } from './board_repaint';

const scrim = $('pscrim');
const sheet = $('picker');
/** On the stack while the picker is up. Escape is its own only from inside it:
 *  the picker is modal over the board, and Escape at a session's ask is a
 *  different Escape entirely. */
let layer: layers.Handle | undefined;
const list = $('plist');
const filter = $('pfilter') as HTMLInputElement;

type ListConversations = Extract<WebviewMessage, { type: 'listConversations' }>;

/** Which directory the open sheet is about, or nothing when it is shut, and
 *  the one ask a reply may answer. A late reply — to a picker closed and opened
 *  again on the same folder, to an earlier query, to a page of an older
 *  snapshot — answers some other ask and is dropped. `query` is the search the
 *  drawn list is the result of, which is not the box's text while typing. */
let open:
  | {
      cwd: string;
      asked: ListConversations;
      answered: boolean;
      snapshotId?: string;
      query: string;
    }
  | undefined;

/** The rows the host has sent for this list, every page appended. Undefined
 *  until it answers: a read in flight and a directory with no history say
 *  different things, and `[]` is only the second. */
let rows: ConversationView[] | undefined;

/** Where the next page starts, while the host says there is one. Absent at the
 *  end of the list and at its 500-row limit; search still reaches every row. */
let next: ConversationCursor | undefined;

let searching: ReturnType<typeof setTimeout> | undefined;
/** How long typing must pause before the host is asked. Engineering default. */
const SEARCH_PAUSE_MS = 150;

/** Enter was pressed before the list answered the box, so the first row of the
 *  answer is taken when it lands. The rows drawn meanwhile answer an older ask,
 *  and pressing one would resume a conversation the search did not find. */
let pickFirst = false;

type ResumeRequest = Extract<WebviewMessage, { type: 'resume' }>;
/** What the host said this resume came to, from its reply or a later status. */
type Settled = { attemptId?: string; notice: string } & (
  { outcome: 'started'; pid: number; startedAt: number } | { outcome: 'stopped' | 'unknown' }
);
type PendingResume = {
  group: string;
  title: string;
  request: ResumeRequest;
  result?: Settled;
  note?: string;
};

const pending = new Map<string, PendingResume>();

function startResume(group: string, title: string, ask: Omit<ResumeRequest, 'requestId'>): void {
  for (const [id, other] of pending) {
    if (
      other.request.sessionId !== ask.sessionId ||
      other.request.target?.brand !== ask.target?.brand
    )
      continue;
    if (other.result?.outcome !== 'stopped') return;
    pending.delete(id);
  }
  const request = { ...ask, requestId: globalThis.crypto.randomUUID() };
  pending.set(request.requestId, { group, title, request });
  vscode.postMessage(request);
  repaintBoard();
}

/** A reply settles an attempt still open or unknown; a final word stands. */
export function takeResumeResult(msg: ResumeResultMessage): void {
  const attempt = pending.get(msg.requestId);
  if (!attempt || (attempt.result && attempt.result.outcome !== 'unknown')) return;
  const attemptId = msg.attemptId === undefined ? {} : { attemptId: msg.attemptId };
  attempt.result =
    msg.outcome === 'started'
      ? {
          ...attemptId,
          outcome: 'started',
          notice: msg.notice,
          pid: msg.pid,
          startedAt: msg.startedAt
        }
      : { ...attemptId, outcome: msg.outcome, notice: msg.notice };
  repaintBoard();
}

export function takeResumeStartup(msg: StartupStatusMessage): void {
  const attempt = [...pending.values()].find(
    (value) => (value.result?.attemptId ?? value.request.requestId) === msg.attemptId
  );
  if (!attempt) return;
  if (msg.state === 'started' && msg.pid !== undefined && msg.startedAt !== undefined)
    attempt.result = {
      attemptId: msg.attemptId,
      outcome: 'started',
      notice: msg.notice,
      pid: msg.pid,
      startedAt: msg.startedAt
    };
  else if (msg.state === 'stopped')
    attempt.result = { attemptId: msg.attemptId, outcome: 'stopped', notice: msg.notice };
  else attempt.note = msg.notice;
  repaintBoard();
}

export function retryResume(id: string | undefined): void {
  const attempt = id ? pending.get(id) : undefined;
  if (attempt?.result?.outcome === 'stopped')
    startResume(attempt.group, attempt.title, attempt.request);
}

export function dismissResume(id: string | undefined): void {
  const attempt = id ? pending.get(id) : undefined;
  if (!attempt?.result || attempt.result.outcome === 'started') return;
  pending.delete(attempt.request.requestId);
  repaintBoard();
}

export function pendingResumeCards(cwd: string): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const [id, attempt] of pending) {
    const result = attempt.result;
    if (
      result?.outcome === 'started' &&
      ui.state.groups.some((group) =>
        group.sessions.some(
          (session) => session.pid === result.pid && session.startedAt === result.startedAt
        )
      )
    ) {
      pending.delete(id);
      continue;
    }
    if (attempt.group !== cwd) continue;
    const failed = result?.outcome === 'stopped';
    const node = el('div', 'card starting resuming' + (failed ? ' refused' : ''));
    node.dataset.key = id;
    node.append(el('div', 'resume-title', attempt.title));
    const status = el('div', 'resume-state');
    status.setAttribute('role', 'status');
    if (!failed) status.append(el('span', 'spinner'));
    status.append(
      el(
        'span',
        null,
        result && result.outcome !== 'started' ? result.notice : (attempt.note ?? 'Resuming…')
      )
    );
    node.append(status);
    if (result?.outcome !== 'started' && !failed) {
      const actions = el('div', 'resume-actions startup-actions');
      for (const [action, label] of [
        ['status', 'Check status'],
        ['cancel', 'Cancel start']
      ] as const) {
        const button = el('button', null, label);
        button.dataset.startup = action;
        button.dataset.startupId = result?.attemptId ?? id;
        button.onclick = () =>
          vscode.postMessage({
            type: 'startup',
            attemptId: button.dataset.startupId ?? id,
            action
          });
        actions.append(button);
      }
      node.append(actions);
    }
    if (failed) {
      const actions = el('div', 'resume-actions startup-actions');
      const retry = el('button', null, 'Try again');
      retry.dataset.act = 'retry-resume';
      retry.dataset.resumeId = id;
      const dismiss = el('button', null, 'Dismiss');
      dismiss.dataset.act = 'dismiss-resume';
      dismiss.dataset.resumeId = id;
      actions.append(retry, dismiss);
      node.append(actions);
    }
    nodes.push(node);
  }
  return nodes;
}

export function openPicker(cwd: string): void {
  clearTimeout(searching);
  pickFirst = false;
  rows = undefined;
  next = undefined;
  filter.value = '';
  q(sheet, '.cw').textContent = cwd.replace(/^.*\//, '') || cwd;
  scrim.hidden = false;
  sheet.hidden = false;
  // Read before the filter takes focus: that is where closing returns.
  const opener = focusOutside();
  layer ??= layers.push({
    kind: 'resumePicker',
    close: closePicker,
    escape: (e) => {
      if (!(e.target instanceof Node && sheet.contains(e.target))) return false;
      closePicker();
      return true;
    },
    restoreFocus: opener,
    root: () => [sheet, scrim]
  });
  ask(cwd);
  render();
  filter.focus();
}

export function closePicker(): void {
  clearTimeout(searching);
  pickFirst = false;
  open = undefined;
  rows = undefined;
  next = undefined;
  scrim.hidden = true;
  sheet.hidden = true;
  layer?.pop();
  layer = undefined;
}

/** The control that had focus when the picker opened. The filter is not it:
 *  opening focuses that next, and closing would otherwise return there. */
function focusOutside(): HTMLElement | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  if (active === document.body || active === document.documentElement) return undefined;
  if (sheet.contains(active) || scrim.contains(active)) return undefined;
  return active;
}

/**
 * Asks the host for a page. No cursor ranks the folder afresh, which is how a
 * picker opens and how it recovers from a snapshot the host has dropped; a
 * cursor pages the snapshot it names.
 */
function ask(cwd: string, cursor?: ConversationCursor, query = ''): void {
  const asked: ListConversations = {
    type: 'listConversations',
    requestId: globalThis.crypto.randomUUID(),
    cwd,
    ...(cursor ? { cursor } : {}),
    ...(query ? { query } : {})
  };
  open = { cwd, asked, answered: false, snapshotId: cursor?.snapshotId, query };
  vscode.postMessage(asked);
}

/** The next page, unless it is already asked for. */
function older(): void {
  if (open && next && open.answered) ask(open.cwd, next, open.query);
}

/** Searches the open's snapshot once typing pauses: the host matches every row
 *  of the folder's window, not only the pages loaded here. */
function search(): void {
  pickFirst = false;
  clearTimeout(searching);
  searching = setTimeout(askQuery, SEARCH_PAUSE_MS);
}

function askQuery(): void {
  searching = undefined;
  if (!open) return;
  const query = filter.value.trim();
  ask(open.cwd, open.snapshotId ? { snapshotId: open.snapshotId, offset: 0 } : undefined, query);
}

/** Whether the drawn list answers the box: no search is waiting for its pause,
 *  and nothing asked since replaces the list. A page being appended does not. */
function settled(): boolean {
  return (
    searching === undefined && !!open && (open.answered || (open.asked.cursor?.offset ?? 0) > 0)
  );
}

/** Enter before the list answers the box: a search still waiting is sent now,
 *  and the first row of whatever answers it is taken. */
function takeFirst(): void {
  if (searching !== undefined) {
    clearTimeout(searching);
    askQuery();
  }
  pickFirst = true;
}

/**
 * The host's answer, drawn only if it answers this picker's last ask. Offset 0
 * replaces the list and any other appends to it, without a row it already has.
 * An expired snapshot is asked again from page 1, keeping the search text; the
 * rows on screen stay until that page replaces them.
 */
export function takeConversations(msg: ConversationsMessage): void {
  if (!open || msg.cwd !== open.cwd || msg.requestId !== open.asked.requestId) return;
  const cursor = open.asked.cursor;
  if (cursor && msg.snapshotId !== cursor.snapshotId) return;
  if (msg.expired) {
    ask(open.cwd, undefined, filter.value.trim());
    return;
  }
  open.answered = true;
  open.snapshotId = msg.snapshotId;
  const walked = !!list.querySelector('.pmore.on');
  const held = list.querySelector<HTMLElement>('.pit.on')?.dataset.key;
  let first: string | undefined;
  if (msg.offset === 0 || !rows) rows = msg.rows;
  else {
    const have = new Set(rows.map(rowKey));
    const added = msg.rows.filter((row) => !have.has(rowKey(row)));
    first = added[0] && rowKey(added[0]);
    rows = [...rows, ...added];
  }
  next = msg.next;
  render();
  if (pickFirst && msg.offset === 0) {
    pickFirst = false;
    pick(list.querySelector<HTMLElement>('.pit') ?? undefined);
    return;
  }
  // A page appended keeps the reader's place: the row they rested on, or, when
  // they arrowed onto Show older, the first row it brought.
  if (msg.offset !== 0) rest(walked ? first : held);
}

/** Moves the highlight to the row with this key, if it is drawn. */
function rest(key: string | undefined): void {
  const row = [...list.querySelectorAll<HTMLElement>('.pit')].find((n) => n.dataset.key === key);
  if (!row) return;
  list.querySelectorAll('.on').forEach((n) => n.classList.remove('on'));
  row.classList.add('on');
}

function rowKey(row: ConversationView): string {
  return `${row.brand}\0${row.sessionId}`;
}

function render(): void {
  if (!rows?.length) {
    list.replaceChildren(
      el(
        'div',
        'pnote',
        !rows
          ? 'Reading this folder’s conversations…'
          : open?.query
            ? 'No conversation matches that.'
            : 'No conversation in the last 30 days.'
      )
    );
    return;
  }
  const nodes = rows.map((row) => {
    const it = el('div', row.running ? 'pit running' : 'pit');
    it.dataset.key = rowKey(row);
    const body = el('div', 'bd');
    const title = el('div', 't', row.title);
    // A prompt standing in for a title is set in italics rather than dressed
    // up as one: the CLI titles a conversation a turn in, so an untitled row
    // is a short conversation, and the type says so before it is read.
    if (!row.titled) title.classList.add('said');
    const meta = el('div', 'm');
    meta.append(el('span', 'b', ago(Date.now() - row.lastActivity) + ' ago'));
    if (row.branch) meta.append(el('span', null, row.branch));
    // Which checkout it was had in, when that is not the one asked about. Two
    // packages of a monorepo share a branch, so the branch alone cannot tell
    // their rows apart.
    if (row.where) meta.append(el('span', 'w', row.where));
    body.append(title, meta);
    it.append(brandMark(row.brand), body);
    // Shown and pressable, not inert: this is often the exact conversation
    // the reader came looking for, and the host answers a running one by
    // revealing its card instead of starting a second child on its transcript.
    if (row.running) it.append(el('span', 'now', 'running'));
    return it;
  });
  // Last in the list, so the arrows reach it the way they reach a row.
  if (next) {
    const more = el('div', 'pmore', 'Show older');
    more.dataset.key = '\0more';
    nodes.push(more);
  }
  morph(list, nodes);
  if (!list.querySelector('.pit.on, .pmore.on')) {
    list.querySelector('.pit')?.classList.add('on');
  }
}

/** Walks the rows; walking onto Show older loads the next page. */
function move(by: number): void {
  pickFirst = false;
  const all = [...list.querySelectorAll<HTMLElement>('.pit, .pmore')];
  if (!all.length) return;
  const at = all.findIndex((n) => n.classList.contains('on'));
  const to = all[Math.max(0, Math.min(all.length - 1, (at < 0 ? 0 : at) + by))];
  if (!to) return;
  all.forEach((n) => n.classList.remove('on'));
  to.classList.add('on');
  to.scrollIntoView({ block: 'nearest' });
  if (to.classList.contains('pmore')) older();
}

/**
 * Start the conversation a row stands for.
 *
 * The row's own title rides along as the name: `--name` is read at start and
 * never again, so a resumed card would otherwise come up called after its
 * directory. Only a real title — a prompt standing in for one is not a name.
 *
 * And the row's own directory, not the picker's: the list spans every checkout
 * of the repository, and the CLI finds a session id only under the slug of the
 * cwd it is run in.
 */
function pick(node: HTMLElement | undefined): void {
  const row = rows?.find((r) => rowKey(r) === node?.dataset.key);
  if (!open || !row) return;
  // What the resume starts on, stated on the message rather than read at the
  // far end — one place decides, and it is the surface the reader pressed.
  //
  // **The gear's setting, and not `startingPick`'s resolution of it.** That
  // helper opens a *pill* on a row a reader can then see and change, and there
  // is no pill here; resolving silently would pin a conversation to a model it
  // had never run on, decided by a ranking nobody read. `''` is an unset gear.
  const brand = ui.state.models.find((m) => m.value === ui.state.model)?.brand;
  const mine =
    ui.state.model === '' ||
    (brand ?? brandForModel(ui.state.model) ?? DEFAULT_BRAND) === row.brand;
  const effort = mine
    ? effortFor(
        ui.state.models,
        ui.state.model,
        ui.state.contextWindow,
        ui.state.efforts[ui.state.model]
      )
    : undefined;
  const target: LaunchTarget = {
    brand: row.brand,
    model: mine ? ui.state.model : '',
    ...(mine && ui.state.contextWindow !== undefined ? { window: ui.state.contextWindow } : {}),
    // Validated against the same row as the model. A setting left on another
    // brand names no safe effort here, so neither half crosses the seam.
    ...(effort === undefined ? {} : { effort })
  };
  startResume(open.cwd, row.title, {
    type: 'resume',
    cwd: row.cwd,
    sessionId: row.sessionId,
    // A stated name is a name; a prompt standing in is a label. The second
    // must not reach `--name` — see `core/naming.ts`.
    name: row.titled ? row.title : undefined,
    ...(row.titled ? {} : { placeholder: row.title }),
    target
  });
  closePicker();
}

scrim.onclick = () => closePicker();

list.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.pmore')) older();
  else pick(target.closest<HTMLElement>('.pit') ?? undefined);
});

filter.addEventListener('input', search);

// Keys are read on the sheet rather than the document: the picker is modal over
// the board. Its Escape is the layer's, above.
sheet.addEventListener('keydown', (e) => {
  if (imeKey(e)) return;
  if (e.key === 'ArrowDown') {
    move(1);
  } else if (e.key === 'ArrowUp') {
    move(-1);
  } else if (e.key === 'Enter') {
    if (!settled()) takeFirst();
    else if (list.querySelector('.pmore.on')) older();
    else pick(list.querySelector<HTMLElement>('.pit.on') ?? undefined);
  } else {
    return;
  }
  e.preventDefault();
});
