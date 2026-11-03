import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import type { RecordLine } from './record';
import * as transcript from './transcript';

export const PAGE_ROWS = 60;
export const PAGE_BYTES = 256 * 1024;
const CHUNK = 64 * 1024;
const RECORDS = 4;

type Span = { at: number; bytes: number; returns?: number[]; witness?: string };
type Row = { span: Span; notes: Span[]; authored: boolean; role?: string; maintenance?: boolean };
type Index = {
  epoch: string;
  identity: string;
  size: number;
  mtime: number;
  head: Buffer;
  end: Buffer;
  pending: Buffer[];
  pendingAt: number;
  header: boolean;
  refused: boolean;
  rows: Row[];
  witnesses: Map<string, number>;
  witnessLines: Map<number, Span[]>;
  calls: Map<string, number>;
  warm: Map<string, Span>;
  warmRows: Map<string, number>;
  last?: number;
  page?: { key: string; value: IndexedPage };
};

export type IndexedPage = {
  lines: RecordLine[];
  witnesses: ReadonlyMap<string, number>;
  from: number;
  total: number;
  cursor: string;
  revision: string;
  older?: string;
  newer?: string;
};

type Bounds = { from: number; to: number };
type PageOptions = {
  cursor?: string;
  rows?: number;
  bytes?: number;
  floor?: number;
  authored?: boolean;
  keepUserTurns?: boolean;
};
type PageSelection = { range: Bounds; floor: number; limit: number; budget: number };
const indexes = new Map<string, Index>();
const reading = new Map<string, Promise<unknown>>();

/** Offset metadata only. Cold legacy files need one scan; append reads start at
 * the preceding descriptor size, including when a UTF-8 line is incomplete. */
export async function read(
  file: string,
  sessionId: string,
  schema: number,
  options: PageOptions = {}
): Promise<IndexedPage | undefined> {
  const prior = reading.get(file);
  const task = (async () => {
    await prior?.catch(() => undefined);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw Object.assign(new Error('record is not a file'), { code: 'EISDIR' });
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let index = indexes.get(file);
      if (
        index &&
        (index.identity !== identity ||
          stat.size < index.size ||
          (stat.size === index.size && stat.mtimeMs !== index.mtime) ||
          !(await unchangedPrefix(handle, index)))
      )
        index = undefined;
      index ??= {
        epoch: randomUUID(),
        identity,
        size: 0,
        mtime: 0,
        head: Buffer.alloc(0),
        end: Buffer.alloc(0),
        pending: [],
        pendingAt: 0,
        header: false,
        refused: false,
        rows: [],
        witnesses: new Map(),
        witnessLines: new Map(),
        calls: new Map(),
        warm: new Map(),
        warmRows: new Map()
      };
      indexes.delete(file);
      indexes.set(file, index);
      while (indexes.size > RECORDS) {
        const oldest = indexes.keys().next().value;
        if (oldest !== undefined) indexes.delete(oldest);
      }
      await scan(handle, index, stat.size, sessionId, schema);
      index.mtime = stat.mtimeMs;
      index.head = await bytesAt(handle, 0, Math.min(64, index.size));
      index.end = await bytesAt(handle, Math.max(0, index.size - 64), Math.min(64, index.size));
      if (!index.header || index.refused) return undefined;
      const selection = selectPage(index.rows, index.epoch, options);
      if (!selection) return undefined;
      const { range, floor, limit, budget } = selection;
      const pageKey = `${index.size}:${index.mtime}:${range.from}:${range.to}:${floor}:${limit}:${budget}:${options.authored ?? false}:${options.keepUserTurns ?? false}`;
      const cached = index.page?.key === pageKey ? index.page.value : undefined;
      const lines = cached?.lines ?? (await materialize(handle, index, range));
      const after = await handle.stat();
      const current = await fs.stat(file);
      if (
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.birthtimeMs !== stat.birthtimeMs ||
        after.size < stat.size ||
        (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)
      ) {
        indexes.delete(file);
        throw new Error('record changed during page read');
      }
      if (cached) return cached;
      const value = {
        lines,
        witnesses: options.authored ? new Map(index.witnesses) : new Map<string, number>(),
        from: range.from,
        total: index.rows.length,
        revision: `${index.epoch}:${index.size}:${index.mtime}`,
        ...pageCursors(index.rows, index.epoch, selection)
      };
      index.page = { key: pageKey, value };
      return value;
    } finally {
      await handle.close();
    }
  })();
  reading.set(file, task);
  try {
    return await task;
  } finally {
    if (reading.get(file) === task) reading.delete(file);
  }
}

async function unchangedPrefix(handle: fs.FileHandle, index: Index): Promise<boolean> {
  return (
    index.head.equals(await bytesAt(handle, 0, index.head.length)) &&
    index.end.equals(await bytesAt(handle, Math.max(0, index.size - 64), index.end.length))
  );
}

async function bytesAt(handle: fs.FileHandle, at: number, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const got = await handle.read(bytes, offset, size - offset, at + offset);
    if (!got.bytesRead) throw new Error('record shortened during read');
    offset += got.bytesRead;
  }
  return bytes;
}

async function scan(
  handle: fs.FileHandle,
  index: Index,
  size: number,
  id: string,
  schema: number
): Promise<void> {
  while (index.size < size) {
    const chunk = await bytesAt(handle, index.size, Math.min(CHUNK, size - index.size));
    let from = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, end);
      const raw = index.pending.length ? Buffer.concat([...index.pending, piece]) : piece;
      const span = { at: index.pendingAt, bytes: index.size + end + 1 - index.pendingAt };
      const line = parsed(raw);
      if (!index.header) {
        index.header = true;
        index.refused = line?.v !== schema || line.sessionId !== id;
      } else if (!index.refused && line) associate(index, line, span);
      index.pending = [];
      index.pendingAt = index.size + end + 1;
      from = end + 1;
    }
    if (from < chunk.length) index.pending.push(Buffer.from(chunk.subarray(from)));
    index.size += chunk.length;
  }
}

function parsed(raw: Buffer): { [key: string]: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { [key: string]: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

function associate(index: Index, raw: { [key: string]: unknown }, span: Span): void {
  const line = raw as RecordLine & {
    m?: string;
    wm?: { id?: string };
    ret?: { id?: string }[];
    ck?: unknown;
    ex?: unknown;
    role?: string;
    maintenance?: boolean;
    mark?: string;
    warmId?: string;
    blocks?: { call?: { id?: string } }[];
  };
  if (typeof line.m === 'string' && !index.witnesses.has(line.m)) {
    const at = index.rows.length;
    index.witnesses.set(line.m, at);
    const witnesses = index.witnessLines.get(at) ?? [];
    witnesses.push({ ...span, witness: line.m });
    index.witnessLines.set(at, witnesses);
  }
  if (line.wm?.id) {
    index.warm.set(line.wm.id, span);
    const row = index.warmRows.get(line.wm.id);
    if (row !== undefined) index.rows[row]?.notes.push(span);
    return;
  }
  if (line.ex || line.ck) {
    if (index.last !== undefined) index.rows[index.last]?.notes.push(span);
    return;
  }
  if (Array.isArray(line.ret)) {
    const targets = new Map<number, number[]>();
    line.ret.forEach((ret, at) => {
      const target = ret?.id ? index.calls.get(ret.id) : undefined;
      if (target === undefined) return;
      const parts = targets.get(target) ?? [];
      parts.push(at);
      targets.set(target, parts);
    });
    for (const [target, returns] of targets) index.rows[target]?.notes.push({ ...span, returns });
    return;
  }
  if (line.role === undefined && line.mark === undefined) return;
  const at = index.rows.length;
  const row: Row = {
    span,
    notes: [],
    authored: line.mark === undefined,
    role: line.role,
    maintenance: line.maintenance
  };
  index.rows.push(row);
  if (row.authored) index.last = at;
  if (line.role === 'warm' && line.warmId) {
    const prior = index.warm.get(line.warmId);
    if (prior) row.notes.push(prior);
    if (!index.warmRows.has(line.warmId)) index.warmRows.set(line.warmId, at);
  }
  for (const block of Array.isArray(line.blocks) ? line.blocks : [])
    if (block?.call?.id) index.calls.set(block.call.id, at);
}

function selectPage(
  rows: readonly Row[],
  epoch: string,
  options: PageOptions
): PageSelection | undefined {
  const floor = Math.min(rows.length, Math.max(0, options.floor ?? 0));
  const limit = options.rows ?? PAGE_ROWS;
  const budget = options.bytes ?? PAGE_BYTES;
  let range = options.cursor
    ? decode(options.cursor, epoch, rows.length, floor)
    : backwards(rows, rows.length, floor, limit, budget, options.authored);
  if (!range) return undefined;
  if (options.keepUserTurns && rows.some((row) => row.role === 'user' && !row.maintenance))
    range.from = Math.max(floor, Math.min(range.from, transcript.recentUserFrom(rows)));
  if (
    range.to - range.from > 1 &&
    rows.slice(range.from, range.to).reduce((sum, row) => sum + weight(row), 0) > budget
  )
    range = backwards(rows, range.to, Math.max(floor, range.from), limit, budget);
  return { range, floor, limit, budget };
}

function pageCursors(
  rows: readonly Row[],
  epoch: string,
  { range, floor, limit, budget }: PageSelection
): Pick<IndexedPage, 'cursor' | 'older' | 'newer'> {
  const token = (bounds: Bounds): string => `${epoch}:${bounds.from}:${bounds.to}`;
  return {
    cursor: token(range),
    ...(range.from > floor
      ? { older: token(backwards(rows, range.from, floor, limit, budget)) }
      : {}),
    ...(range.to < rows.length ? { newer: token(forwards(rows, range.to, limit, budget)) } : {})
  };
}

function weight(row: Row): number {
  return row.span.bytes + row.notes.reduce((sum, span) => sum + span.bytes, 0);
}

function backwards(
  entries: readonly Row[],
  to: number,
  floor: number,
  rows: number,
  budget: number,
  authored = false
): Bounds {
  let from = to;
  let count = 0;
  let bytes = 0;
  while (from > floor) {
    const row = entries[from - 1];
    if (!row || (count >= rows && (!authored || row.authored))) break;
    const more = weight(row);
    if (from < to && bytes + more > budget) break;
    bytes += more;
    if (!authored || row.authored) count++;
    from--;
  }
  return { from, to };
}

function forwards(entries: readonly Row[], from: number, rows: number, budget: number): Bounds {
  let to = from;
  let bytes = 0;
  while (to < entries.length && to - from < rows) {
    const row = entries[to];
    if (!row) break;
    const more = weight(row);
    if (to > from && bytes + more > budget) break;
    bytes += more;
    to++;
  }
  return { from, to };
}

function decode(
  cursor: string,
  currentEpoch: string,
  total: number,
  floor: number
): Bounds | undefined {
  const [epoch, first, last, extra] = cursor.split(':');
  const from = Number(first),
    to = Number(last);
  return extra === undefined &&
    epoch === currentEpoch &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= floor &&
    from <= to &&
    to <= total &&
    to - from <= PAGE_ROWS
    ? { from, to }
    : undefined;
}

async function materialize(
  handle: fs.FileHandle,
  index: Index,
  range: Bounds
): Promise<RecordLine[]> {
  const spans = new Map<number, Span>();
  for (const row of index.rows.slice(range.from, range.to)) {
    spans.set(row.span.at, row.span);
    for (const note of row.notes) {
      const was = spans.get(note.at);
      spans.set(
        note.at,
        was?.returns && note.returns
          ? { ...note, returns: [...was.returns, ...note.returns] }
          : note
      );
    }
  }
  for (let at = range.from; at < range.to + Number(range.to === index.rows.length); at++) {
    for (const witness of index.witnessLines.get(at) ?? [])
      if (!spans.has(witness.at)) spans.set(witness.at, witness);
  }
  const lines: RecordLine[] = [];
  for (const span of [...spans.values()].sort((a, b) => a.at - b.at)) {
    if (span.witness !== undefined) {
      lines.push({ m: span.witness });
      continue;
    }
    const line = parsed(await bytesAt(handle, span.at, span.bytes));
    if (!line) continue;
    // A single result line can name calls on several pages. Resolve its true
    // owners during the global scan, so omitted duplicate IDs cannot retarget it.
    if (span.returns && Array.isArray(line.ret))
      line.ret = [...span.returns].sort((a, b) => a - b).map((at) => (line.ret as unknown[])[at]);
    lines.push(line as RecordLine);
  }
  return lines;
}
