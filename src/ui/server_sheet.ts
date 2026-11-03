/**
 * What the servers sheet and the servers line decide about a repo's rows.
 *
 * Pure: rows arrive on the state message and a `ports` answer arrives when a
 * worktree is selected. `webview/runpicker.ts` paints what this returns.
 */

import { unsafePort } from '../core/devservers/unsafe';

export type RowDot = 'failed' | 'starting' | 'up' | 'alien' | 'off';

/** One worktree of the sheet's rail. */
export interface WorktreeEntry {
  tree: string;
  branch: string;
  dot: RowDot;
  /** A port, `:3001 +1`, the failure's word, or nothing. */
  meta: string;
  failed: boolean;
  running: boolean;
  rows: ServerRowView[];
}

/** One thing a worktree can start, or a live server no start offers. */
export interface StartRow {
  key: string;
  name: string;
  runner: string;
  start?: RunStart;
  live?: ServerRowView;
}

/** Worst first: the rail's one dot says the state most worth a press. */
const DOT_ORDER: RowDot[] = ['failed', 'starting', 'up', 'alien', 'off'];

export const isLive = (row: ServerRowView): boolean =>
  row.status !== undefined || row.listener !== undefined;

export const rowDot = (row: ServerRowView): RowDot =>
  row.listener ? 'alien' : (row.status ?? 'off');

/** Running above idle. Each half keeps the host's order, so a row never moves
 *  under the pointer when another worktree's state changes. */
export function worktrees(rows: ServerRowView[]): WorktreeEntry[] {
  const byTree = new Map<string, ServerRowView[]>();
  for (const row of rows) {
    const held = byTree.get(row.tree);
    if (held) held.push(row);
    else byTree.set(row.tree, [row]);
  }
  const entries = [...byTree].map(([tree, members]) => entryOf(tree, members));
  return [...entries.filter((e) => e.running), ...entries.filter((e) => !e.running)];
}

function entryOf(tree: string, rows: ServerRowView[]): WorktreeEntry {
  const live = rows.filter(isLive);
  const dot = DOT_ORDER.find((candidate) => live.some((row) => rowDot(row) === candidate)) ?? 'off';
  return {
    tree,
    branch: rows[0]?.branch ?? tree,
    dot,
    meta: metaOf(live, dot),
    failed: dot === 'failed',
    running: live.length > 0,
    rows
  };
}

function metaOf(live: ServerRowView[], dot: RowDot): string {
  if (dot === 'failed') {
    return live.find((row) => row.status === 'failed')?.reason ?? 'failed';
  }
  const ports = live.flatMap((row) => (row.port === undefined ? [] : [row.port]));
  const first = ports[0];
  if (first === undefined) return '';
  return ports.length > 1 ? `:${first} +${ports.length - 1}` : `:${first}`;
}

/**
 * A worktree's starts joined to what is running. A live row with no start beside
 * it stays, or its Stop would be out of reach: a session's server carries no
 * runner, and a `ports` answer may not have landed yet.
 */
export function startRows(rows: ServerRowView[], starts: RunStart[]): StartRow[] {
  const live = rows.filter(isLive);
  const joined = new Set<ServerRowView>();
  const drawn = starts.map((start) => {
    const match = live.find(
      (row) => !joined.has(row) && row.cwd === start.cwd && row.runnerId === start.runnerId
    );
    if (match) joined.add(match);
    const [name = start.label, runner = ''] = start.label.split(' · ');
    return { key: start.key, name, runner, start, ...(match ? { live: match } : {}) };
  });
  const loose = live
    .filter((row) => !joined.has(row))
    .map((row) => ({
      key: `live:${row.cwd}:${row.runnerId}:${row.port ?? ''}`,
      // A listener can fill a row whose label is a sentence about the tree.
      name: row.app ?? (row.listener ? row.listener.command || row.listener.session : row.label),
      runner: row.app ? row.label : '',
      live: row
    }));
  return [...drawn, ...loose];
}

/** The rows of the answer inside this start's own block, in order. The answer
 *  is the union of every start's block; a start with none (an older host, or a
 *  portless one) is offered every row, as before blocks were per start. */
export function blockRows(start: RunStart, ports: PortsMessage['ports']): PortsMessage['ports'] {
  const block = start.block;
  if (!block) return ports;
  return ports.filter((row) => row.port >= block.base && row.port < block.base + block.span);
}

/**
 * The row for the port this start used last when it lies outside the start's
 * own block — the host adds such a port to the answer for exactly this. Per
 * start, so it is derived here and not marked on the wire: one row can be
 * inside one start's block and outside another's. A start with no block is
 * offered every row already, so nothing is outside it.
 */
export function outsideRow(
  start: RunStart,
  ports: PortsMessage['ports'],
  lastUsed: PortsMessage['lastUsed']
): PortsMessage['ports'][number] | undefined {
  const block = start.block;
  const last = lastUsed[start.key];
  if (!block || last === undefined) return undefined;
  if (last >= block.base && last < block.base + block.span) return undefined;
  return ports.find((row) => row.port === last);
}

/** The rows a start may be run on: its block, then its outside row if any. */
export function offeredRows(
  start: RunStart,
  union: PortsMessage['ports'],
  lastUsed: PortsMessage['lastUsed']
): PortsMessage['ports'] {
  const outside = outsideRow(start, union, lastUsed);
  const block = blockRows(start, union);
  return outside ? [...block, outside] : block;
}

/** Free, and not a port the sheet refuses (`unsafePort`) — what a tile may be
 *  pressed for, a default may be, and a free count counts. The rule is asked
 *  first and the bind test's answer second; neither replaces the other. */
export const pickable = (row: PortsMessage['ports'][number]): boolean =>
  row.free && unsafePort(row.port) === undefined;

/** What this start used last if it is still pickable — inside its block or its
 *  outside row — otherwise the block's first pickable port. A remembered port
 *  confers nothing, so a taken one is never the default. */
export function defaultPort(
  start: RunStart,
  union: PortsMessage['ports'],
  lastUsed: PortsMessage['lastUsed']
): number | undefined {
  if (start.portless) return undefined;
  const last = offeredRows(start, union, lastUsed).find((row) => row.port === lastUsed[start.key]);
  return last && pickable(last) ? last.port : blockRows(start, union).find(pickable)?.port;
}

/** A port typed into a start's port row: the number, or why it cannot be run
 *  on, in the words drawn beside the field. The rules, then what the answer
 *  already says of it — a port it does not cover is the host's to bind-test at
 *  the press. */
export type TypedPort = { port: number } | { port?: undefined; refusal: string };

export function typedPort(text: string, union: PortsMessage['ports']): TypedPort {
  const trimmed = text.trim();
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 1 || port > 65535) {
    return { refusal: 'not a port number' };
  }
  const refusal = unsafePort(port);
  if (refusal !== undefined) return { refusal };
  const known = union.find((row) => row.port === port);
  if (!known || known.free) return { port };
  return { refusal: 'heldBy' in known ? `held by ${known.heldBy}` : 'in use' };
}

/** Changes when a server takes or leaves a port, which is when occupancy moves.
 *  Status stays out: `starting` becoming `up` holds the same port. */
export const liveSignature = (rows: ServerRowView[]): string =>
  rows
    .filter(isLive)
    .map((row) => `${row.cwd}|${row.runnerId}|${row.port ?? ''}`)
    .join('\n');
