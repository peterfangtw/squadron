/**
 * Servers line and chips.
 */

import * as serverSheet from '../ui/server_sheet';
import { repaintBoard } from './board_repaint';
import { el } from './dom';
import { vscode } from './state';
import { tipRows, type TipRow } from './tip';

/**
 * Servers a stop has been asked for but not yet seen through: the status each
 * was in when the ✕ was pressed, and when it was pressed.
 *
 * Here rather than in the registry, and that is the load-bearing half: the
 * window holding a server's terminal re-writes its record on every poll, so a
 * `stopping` written to the file by the window that clicked would be flipped
 * straight back to `up` by the window that owns it. Here rather than in the DOM
 * for the reason every other board state is — the line is morphed every three
 * seconds, and a class on a node is not a memory.
 *
 * An entry ends when that row's status changes — gone is a stop that worked —
 * **or** when `STOP_WAIT_MS` is up, which is the half that cannot be left out.
 * A stop can land without anything changing anywhere: since row 71 a stop of a
 * record this window does not hold signals the listener's pid, and a process
 * that sits through its SIGTERM is a process still on the port — nothing writes
 * a status for that. Without a deadline the chip would sit inert on `stopping`
 * for the rest of the session, with no ✕ to press again. It also collects the entries of rows that stop rendering.
 *
 * `pid` is written by the one press that is not a stop of a record of ours — the
 * ✕ on a session server's chip, which signals a process. Such a row has no status either
 * before or after, so the status test can never end its entry, and the mark
 * would always be waited out rather than answered. The pid is what changed.
 */
export const stopping = new Map<string, StopMark>();

export type StopMark = { status: string; at: number; pid?: number };

/** Long enough for the request's own three seconds plus the poll that would
 *  show the result, short enough that a stop nobody honoured comes back. */
export const STOP_WAIT_MS = 8_000;

/**
 * How long the pressed ✕ stays in the tree after the chip has gone `stopping`,
 * so its own exit has something to play on.
 *
 * The chip loses the ✕ the instant the mark is set — there is nothing left to
 * press — and a removed node cannot animate, so it is drawn for this long as an
 * inert span instead. Matches `srv-swallow` in `ui/css/board.ts`; the two are
 * the same number twice and there is no way to share one, since the stylesheet
 * is a string and this is the paint's only caller.
 */
export const SWALLOW_MS = 140;

/**
 * One server's key in `stopping`, and the row's key in the morph.
 *
 * `port` stands in for a `runnerId` that is empty, and **only** then — which is
 * a chip pushed for a listener with no runner of ours behind it. Two of those in
 * one directory would otherwise share a key, and so would one of them and the
 * row of a tree that runs nothing, which already keys as `srv:<cwd>:`. The morph
 * folds any of those into a single node and stops drawing the rest.
 *
 * **A row that has a `runnerId` keeps it, listener or no listener**, and that is
 * the half worth stating: `stopRun` removes our registry record at once while
 * the process is still bound for a beat (`PORT_RELEASE_MS`), so the branch's row
 * spends a poll or two carrying a listener instead of its own server. If
 * the port entered the key there, it would change under a chip whose ✕ had just
 * been pressed — and `stopping`, which `board_actions.ts` writes with two
 * arguments, would be looked up under a key nobody wrote. The chip would skip
 * `stopping` entirely, which is the one thing that map exists to prevent.
 */
export const srvKey = (cwd: string, runnerId: string, port?: number): string =>
  'srv:' + cwd + ':' + (runnerId === '' && port !== undefined ? '@' + port : runnerId);

/** A row's key, the same one its chip wears and its stop writes. */
export const rowKey = (row: ServerRowView): string =>
  srvKey(row.cwd, row.runnerId, row.listener ? row.port : undefined);

/**
 * A group's live servers, between the heading and the grid, so what is serving
 * this repo is answered before the cards are read. Idle worktrees are the
 * sheet's, behind `serverDoor`.
 *
 * Every node here is keyed and nothing closes over the view it was drawn from —
 * the delegated handler reads the branch and the runner back off the DOM,
 * exactly as the card acts do.
 */
export function serverSection(g: GroupView): HTMLElement | null {
  // Every row is asked: a row gone idle answers its stop, so the mark is collected
  // here and cannot meet a restart of that server.
  const rows = (g.servers ?? []).filter((row) => {
    stopMark(row);
    return serverSheet.isLive(row);
  });
  if (!rows.length) return null;

  const wrap = el('div', 'servers');
  wrap.dataset.key = 'servers:' + g.cwd;
  for (const row of rows) wrap.append(serverChip(row, g.cwd));
  return wrap;
}

/** The heading's way into the sheet. A group with no rows has nothing to open:
 *  the experiment is off, or this directory is not a repo we can read. */
export function serverDoor(g: GroupView): HTMLElement | null {
  const rows = g.servers ?? [];
  if (!rows.length) return null;
  const count = serverSheet.worktrees(rows).length;
  const door = el('button', 'sdoor', 'Servers');
  door.dataset.key = 'sdoor:' + g.cwd;
  door.dataset.act = 'openServers';
  door.dataset.group = g.cwd;
  door.setAttribute('aria-label', `Servers, ${count} ${count === 1 ? 'worktree' : 'worktrees'}`);
  door.append(el('span', 'n', `${count} ${count === 1 ? 'worktree' : 'worktrees'} ›`));
  return door;
}

/**
 * The stop still owed on this row, or nothing once it is answered.
 *
 * The status the ✕ was pressed against is still the status, and the wait is not
 * up: nothing has come back yet, so the mark the pointer left stands. Either of
 * those failing means the question is over — answered, or waited out — and the
 * row goes back to offering a stop.
 *
 * **A row that came back holding a listener is not an answer.** `stopRun` drops
 * our registry record at once, but the process holds its socket for a beat after
 * the signal (`PORT_RELEASE_MS`), so the very next poll can find a listener on
 * the port and hand the row back as a session's. The status did change, to none,
 * and reading that as "the stop worked" would flash a live chip across a server
 * this reader just killed. The deadline still bounds it.
 *
 * **A press aimed at a pid reads the pid**, instead of the two rules above. A
 * listener's row has no status before or after the press, so those tests can
 * never come true. The port going quiet, or being taken by something else, is
 * the answer, and `killListener` drops the pid from the reading as soon as the
 * socket frees.
 */
export function stopMark(row: ServerRowView): StopMark | undefined {
  const key = rowKey(row);
  const held = stopping.get(key);
  if (!held) return undefined;
  const settled =
    held.pid !== undefined
      ? row.listener?.pid !== held.pid
      : row.listener === undefined && held.status !== (row.status ?? '');
  if (settled || Date.now() - held.at > STOP_WAIT_MS) {
    stopping.delete(key);
    return undefined;
  }
  return held;
}

/** A stop of a record of ours. The socket goes a beat after the terminal does,
 *  and a server that sat there looking `up` for that beat reads as a lost click. */
export function stopRecord(key: string, status: string, cwd: string, runnerId: string): void {
  stopping.set(key, { status, at: Date.now() });
  vscode.postMessage({ type: 'stopRun', cwd, runnerId });
  repaintBoard();
}

/** A stop of a session's process: the same mark, with the pid that settles it,
 *  since a listener's row carries no status to watch change. */
export function stopListener(
  key: string,
  status: string,
  port: number,
  pid: number,
  startedAt: number,
  command: string
): void {
  stopping.set(key, { status, at: Date.now(), pid });
  vscode.postMessage({ type: 'killListener', port, pid, startedAt, command });
  repaintBoard();
}

function wordFor(row: ServerRowView, shutting: boolean): string {
  if (shutting) return 'stopping';
  if (row.status === 'starting') return 'starting';
  if (row.reason) return row.reason;
  // Without our runner, name what is running. Some OS readings give no command.
  if (row.listener) return row.app ?? (row.listener.command || row.listener.session);
  if (row.portless) return row.label;
  // Which app, for a server running below its tree. Two rows of one branch are
  // otherwise identical, since every app's runner is `npm run dev`.
  return row.app ?? '';
}

/**
 * The body does the useful act and ✕ the destructive one, so no Run or Stop
 * button is needed. Show ✕ on hover to keep the servers line quiet.
 */
export function serverChip(row: ServerRowView, group: string): HTMLElement {
  const key = rowKey(row);
  const mark = stopMark(row);
  const shutting = mark !== undefined;

  // A listener's row has no status. Give it its own state, or a live port
  // would appear inside a stopped chip.
  const state = shutting ? 'stopping' : row.listener ? 'alien' : (row.status ?? 'off');
  const node = el('div', 'srv ' + state);
  node.dataset.key = key;
  // A failed server's next act is another port, which is the sheet's. Without a
  // url there is nothing to open, so the body is a span.
  const bodyAct = shutting
    ? undefined
    : row.status === 'failed'
      ? 'openServers'
      : row.url
        ? 'openServer'
        : undefined;
  const body = el(bodyAct ? 'button' : 'span', 'cbody');
  body.dataset.key = 'cbody:' + key;
  if (bodyAct) {
    body.dataset.act = bodyAct;
    body.dataset.group = group;
    body.dataset.tree = row.tree;
    if (row.url) body.dataset.url = row.url;
    // The chip's own words are a branch and a number, which name the subject and
    // not the act — and the ⧉ beside them is a span, whose label AT would fold
    // into this name if there were no explicit one and ignore entirely when the
    // body is a span. So the verb is said here, in full, on the one node that
    // can carry it.
    body.setAttribute(
      'aria-label',
      bodyAct === 'openServer' ? 'Open ' + (row.url ?? row.branch) : 'Servers for ' + row.branch
    );
  }
  // **Every slot in the body is keyed**, and the word below is why. The morph
  // matches unkeyed children positionally, so a chip that arrives — and loses
  // its word, since `wordFor` has nothing to say about a plain repo that is up —
  // has the ⧉ span morphed *into* the word's slot rather than the word removed.
  // A node that was never removed is a node no exit can play on, and for one
  // paint the owner mark renders as the word's own slot.
  //
  // `off` and not the record's status while shutting: the record still says
  // `up` for as long as the stop is in flight, so the one chip on the line that
  // is going away was the one drawing the colour of health. What it draws
  // instead is `.srv.stopping .dot`, in `ui/css/board.ts`.
  const statusDot = el(
    'span',
    'dot ' + (shutting ? 'off' : row.listener ? 'alien' : (row.status ?? 'off'))
  );
  statusDot.dataset.key = 'dot:' + key;
  const branchName = el('span', 'br', row.branch);
  branchName.dataset.key = 'br:' + key;
  body.append(statusDot, branchName);

  // The port slot, with a rendering for a port we only observed: a session's
  // process is there, and nothing here has probed it.
  const port =
    row.port !== undefined ? el('span', row.listener ? 'p alien' : 'p', ':' + row.port) : undefined;
  if (port) {
    port.dataset.key = 'p:' + key;
    body.append(port);
  }

  const word = wordFor(row, shutting);
  if (word) {
    const said = el('span', 's' + (row.reason && !shutting ? ' bad' : ''), word);
    said.dataset.key = 's:' + key;
    body.append(said);
  }

  node.append(body);

  // Everything the line has no room for. Rows and not a phrase, because `fill()`
  // draws `data-tip-rows` whenever it is set and never looks at `data-tip` —
  // so a chip that wants both says both here or says the second one nowhere.
  tipRows(node, row.branch, [
    ['runner', row.label, ''],
    ...(row.url ? ([['url', row.url, '']] as TipRow[]) : []),
    // Which process, and whose: the ✕ on this chip signals it.
    ...(row.listener
      ? ([
          ...(row.listener.command ? [['command', row.listener.command, '']] : []),
          ['pid', String(row.listener.pid), ''],
          ['session', row.listener.session, '']
        ] as TipRow[])
      : []),
    // The command carries no measured port flag, so the port is a request and
    // not a guarantee. Said here rather than on the line: it is true of the
    // runner whether or not anything is running, and the line is for now.
    ...(row.guessed ? ([['port flag', 'none — PORT only', 'warn']] as TipRow[]) : [])
  ]);

  // Stopping is the one act that cannot be the body's, and the one that has to
  // be aimed at. Nothing here forgets a record: a stop that goes unanswered is
  // settled by `stopRun`, which drops the record only when the window holding
  // the terminal has no live claim — a question the panel can answer for itself
  // and has no business asking the reader.
  if (row.status !== undefined && !shutting) {
    const x = el('button', 'x', '✕');
    x.dataset.act = 'stopServer';
    x.dataset.cwd = row.cwd;
    x.dataset.runner = row.runnerId;
    x.dataset.stopKey = key;
    x.dataset.status = row.status;
    x.dataset.key = 'x:' + key;
    // A glyph is not an accessible name, and the tip is not one either.
    x.setAttribute('aria-label', 'Stop ' + row.branch);
    x.dataset.tip = 'Stop this server';
    node.append(x);
  } else if (row.listener && row.port !== undefined && !shutting) {
    // No terminal to dispose, so this stop is a signal to the pid — which is
    // why both halves of what was drawn travel with the press. The host reads
    // the port again on arrival and refuses if either moved: this chip's
    // reading is up to a poll old, and a pid is a number the kernel re-issues.
    //
    // Gated on the port and not on `listener` alone: a row with no port has no
    // listener behind it, and there is nothing on it to aim at.
    const x = el('button', 'x', '✕');
    x.dataset.act = 'killListener';
    x.dataset.port = String(row.port);
    x.dataset.pid = String(row.listener.pid);
    x.dataset.startedAt = String(row.listener.startedAt);
    x.dataset.command = row.listener.command;
    x.dataset.stopKey = key;
    x.dataset.status = row.status ?? '';
    x.dataset.key = 'x:' + key;
    // The process, not the branch. "Stop main" is what a picker server says,
    // and it is true because closing its terminal is the whole act; this one
    // signals a process, so the name says which.
    const what = (row.listener.command || 'process') + ' ' + row.listener.pid;
    x.setAttribute('aria-label', 'Stop ' + what);
    x.dataset.tip = 'Signal ' + what;
    node.append(x);
  } else if (mark && Date.now() - mark.at < SWALLOW_MS) {
    // The ✕ that was just pressed, kept for the length of its own exit and no
    // longer. A span and not a button, because there is nothing left to press
    // and a control a keyboard can reach that does nothing is worse than none —
    // and the tag change is what makes the morph replace the node rather than
    // update it, so the animation starts rather than resuming mid-way.
    // Invisible and inert at rest (`ui/css/board.ts`), so a repaint that comes
    // late leaves nothing behind that a reader or a pointer can find.
    const gone = el('span', 'x', '✕');
    gone.dataset.key = 'x:' + key;
    gone.setAttribute('aria-hidden', 'true');
    node.append(gone);
  }
  return node;
}
