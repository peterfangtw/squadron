/** Rebuildable metadata for our append-only transcript store. */
import * as fs from 'fs/promises';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import * as files from './files';
import * as brands from './brands';
import type { BrandId } from './model';
import { CATALOG_FILE, TRANSCRIPTS_DIR } from './paths';
import { SCHEMA } from './record';

export type Stamp = readonly [number, number, number, number, number];
export type Entry = {
  f: string;
  stamp: Stamp;
  cwd?: string;
  brand?: BrandId;
  summary?: { at?: number; title?: string; aged?: true };
};
export type Catalog = Map<string, Entry>;
/** What one read saw; only a `stable` one may be cached. */
export type Observed = { entry: Entry; stable: boolean };
export const WINDOW_MS = 30 * 86400000;
const ENTRY_BYTES = 2048;
const TAIL_BYTES = 128 * 1024;
const TITLE_CHUNK = 64 * 1024;

/** One worker's read buffers, reused across every record it summarises: a
 *  full-family first visit allocating them per record measured 96 MiB of peak
 *  RSS rise against 53 MiB reused (Phase 2 spike, densest family). */
export type SummaryBuffers = { tail: Buffer; title: Buffer };

export function summaryBuffers(): SummaryBuffers {
  return { tail: Buffer.alloc(TAIL_BYTES), title: Buffer.alloc(TITLE_CHUNK) };
}

export async function readCatalog(): Promise<Catalog | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(CATALOG_FILE, 'r');
    const entries: Catalog = new Map();
    const duplicates = new Set<string>();
    let header = true;
    let valid = false;
    await consumeLines(handle, (line) => {
      if (header) {
        header = false;
        const value = parsed(line);
        valid = value?.v === 1 && Object.keys(value).length === 1;
        return valid;
      }
      const entry = decoded(line);
      if (!entry || duplicates.has(entry.f)) return true;
      const previous = entries.get(entry.f);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
        entries.delete(entry.f);
        duplicates.add(entry.f);
      } else entries.set(entry.f, entry);
      return true;
    });
    return valid ? entries : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeCatalog(
  entries: Catalog,
  current: () => boolean = () => true
): Promise<boolean> {
  return files.writeAtomicText(CATALOG_FILE, encoded(entries), current);
}

export function cacheable(entry: Entry): boolean {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') <= ENTRY_BYTES;
}

export async function recordNames(): Promise<string[] | undefined> {
  try {
    return (await fs.readdir(TRANSCRIPTS_DIR)).filter(basename);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined;
  }
}

export async function readHeader(
  f: string,
  buffer: Buffer = Buffer.alloc(4096)
): Promise<Observed | undefined> {
  if (!basename(f)) return undefined;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(TRANSCRIPTS_DIR, f), 'r');
    const before = await handle.stat();
    if (!before.isFile()) return undefined;
    const line = await firstLine(handle, buffer);
    if (line === undefined) return undefined;
    const value = parsed(line);
    const entry: Entry = { f, stamp: stamp(before) };
    if (
      value?.v === SCHEMA &&
      value.sessionId === f.slice(0, -6) &&
      typeof value.cwd === 'string' &&
      value.cwd.length > 0 &&
      brands.isBrand(value.brand)
    ) {
      entry.cwd = value.cwd;
      entry.brand = value.brand;
    }
    return { entry, stable: await unmoved(handle, f, entry.stamp) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function currentStamp(f: string): Promise<Stamp | undefined> {
  try {
    const stat = await fs.stat(path.join(TRANSCRIPTS_DIR, f));
    return stat.isFile() ? stamp(stat) : undefined;
  } catch {
    return undefined;
  }
}

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.every((value, i) => value === b[i]);
}

export async function readSummary(
  entry: Entry,
  now: number,
  buffers: SummaryBuffers = summaryBuffers()
): Promise<Observed | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(TRANSCRIPTS_DIR, entry.f), 'r');
    const before = stamp(await handle.stat());
    const size = before[0];
    const start = Math.max(0, size - TAIL_BYTES);
    const { bytesRead } = await handle.read(buffers.tail, 0, size - start, start);
    const at = lastAt(buffers.tail.subarray(0, bytesRead), start > 0);
    const title =
      at !== undefined && at >= now - WINDOW_MS
        ? await firstTitle(handle, buffers.title)
        : undefined;
    const stable = sameStamp(before, entry.stamp) && (await unmoved(handle, entry.f, before));
    return {
      entry: {
        ...entry,
        summary: {
          ...(at === undefined ? {} : { at }),
          ...(title === undefined ? {} : { title }),
          ...(at !== undefined && at < now - WINDOW_MS ? { aged: true as const } : {})
        }
      },
      stable
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Eight workers bound both active IO and the number of scheduled tasks. */
export async function mapRecords<T, U>(
  items: readonly T[],
  read: (item: T, worker: number) => Promise<U>
): Promise<U[]> {
  const iterator = items.entries();
  const result: U[] = [];
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async (_, worker) => {
      for (;;) {
        const item = iterator.next();
        if (item.done) break;
        const [index, value] = item.value;
        result[index] = await read(value, worker);
      }
    })
  );
  return result;
}

/** The handle saw one version, and the path still names it: a replacement
 *  leaves an open handle stable but already obsolete. */
async function unmoved(handle: fs.FileHandle, f: string, before: Stamp): Promise<boolean> {
  if (!sameStamp(before, stamp(await handle.stat()))) return false;
  const current = await currentStamp(f);
  return current !== undefined && sameStamp(before, current);
}

function stamp(value: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}): Stamp {
  return [value.size, value.mtimeMs, value.ctimeMs, value.dev, value.ino];
}

function basename(value: string): boolean {
  if (value.length <= 6 || !/^[^<>:"/\\|?*]+\.jsonl$/.test(value)) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return false;
  return true;
}

function parsed(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function decoded(line: string): Entry | undefined {
  if (Buffer.byteLength(line, 'utf8') > ENTRY_BYTES) return undefined;
  const row = parsed(line);
  if (
    !row ||
    typeof row.f !== 'string' ||
    !basename(row.f) ||
    !Array.isArray(row.stamp) ||
    row.stamp.length !== 5 ||
    !Number.isInteger(row.stamp[0]) ||
    row.stamp[0] < 0 ||
    row.stamp[3] < 0 ||
    row.stamp[4] < 0
  )
    return undefined;
  for (const key in row)
    if (key !== 'f' && key !== 'stamp' && key !== 'cwd' && key !== 'brand' && key !== 'summary')
      return undefined;
  for (const value of row.stamp)
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (
    (row.cwd !== undefined || row.brand !== undefined) &&
    !(typeof row.cwd === 'string' && row.cwd.length > 0 && brands.isBrand(row.brand))
  )
    return undefined;
  if (row.summary !== undefined) {
    const summary = row.summary;
    if (!row.cwd || typeof summary !== 'object' || summary === null || Array.isArray(summary))
      return undefined;
    const values = summary as Record<string, unknown>;
    if (
      Object.keys(values).some((key) => key !== 'at' && key !== 'title' && key !== 'aged') ||
      (values.aged !== undefined && values.aged !== true) ||
      (values.aged === true && (values.at === undefined || values.title !== undefined)) ||
      (values.title !== undefined && values.at === undefined) ||
      (values.at !== undefined && !(typeof values.at === 'number' && Number.isFinite(values.at))) ||
      (values.title !== undefined &&
        !(
          typeof values.title === 'string' &&
          values.title.length > 0 &&
          values.title.length <= 120
        ))
    )
      return undefined;
  }
  return row as Entry;
}

async function consumeLines(
  handle: fs.FileHandle,
  accept: (line: string) => boolean
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = '';
  let oversized = false;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    const text = bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const part = text.slice(start, end < 0 ? undefined : end);
      if (!oversized) {
        if (carry.length + part.length > ENTRY_BYTES) {
          carry = '';
          oversized = true;
        } else carry += part;
      }
      if (end < 0) break;
      if (!accept(oversized ? '' : carry)) return;
      carry = '';
      oversized = false;
      start = end + 1;
    }
    if (!bytesRead) break;
  }
  if (carry || oversized) accept(oversized ? '' : carry);
}

async function* encoded(entries: Catalog): AsyncGenerator<string> {
  let chunk = '{"v":1}\n';
  for (const entry of entries.values()) {
    if (!cacheable(entry)) continue;
    chunk += JSON.stringify(entry) + '\n';
    if (chunk.length >= 32 * 1024) {
      yield chunk;
      await new Promise<void>((resolve) => setImmediate(resolve));
      chunk = '';
    }
  }
  if (chunk) yield chunk;
}

async function firstLine(handle: fs.FileHandle, buffer: Buffer): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for (let position = 0; position < 64 * 1024; position += buffer.length) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    const end = bytes.indexOf(10);
    if (end >= 0 && !chunks.length) return bytes.subarray(0, end).toString('utf8');
    chunks.push(Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)));
    if (end >= 0) return Buffer.concat(chunks).toString('utf8');
  }
  return undefined;
}

/**
 * The last top-level `at` in a record's tail, scanned from its end: the line
 * holding it is usually the last, so no other line is decoded. A cut tail's
 * first line is a fragment and never counts. Newline bytes never occur inside
 * a UTF-8 sequence, so this reads the same lines as decoding the whole tail and
 * splitting it.
 */
function lastAt(bytes: Buffer, cut: boolean): number | undefined {
  const first = bytes.indexOf(10);
  if (cut && first < 0) return undefined;
  const floor = cut ? first + 1 : 0;
  let end = bytes.length;
  for (;;) {
    const newline = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    const start = newline < floor ? floor - 1 : newline;
    const value = parsed(bytes.toString('utf8', start + 1, end))?.at;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (start < floor) return undefined;
    end = start;
  }
}

async function firstTitle(handle: fs.FileHandle, buffer: Buffer): Promise<string | undefined> {
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let carry = '';
  let header = true;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    position += bytesRead;
    const text = carry + (bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end());
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end < 0) break;
      if (header) header = false;
      else {
        const title = promptTitle(text.slice(start, end));
        if (title) return title;
      }
      start = end + 1;
    }
    carry = text.slice(start);
    if (!bytesRead) return header ? undefined : promptTitle(carry);
  }
}

function promptTitle(raw: string): string | undefined {
  const row = parsed(raw);
  if (row?.role !== 'user' || typeof row.text !== 'string') return undefined;
  const line = row.text.split('\n', 1)[0]?.trim();
  if (!line) return undefined;
  const title = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  // Detaches the title from its 64 KiB chunk. A JSON round trip keeps a
  // surrogate split by the cut, as the legacy reader does; a UTF-8 copy would not.
  return JSON.parse(JSON.stringify(title)) as string;
}
