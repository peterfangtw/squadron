import * as fs from 'node:fs/promises';
import * as platform from '../platform';
import { isStartSource, type StartSource } from '../platform/processes';
import * as scan from '../scan';

/**
 * A process a durable record names, as it decodes. Bytes written before the
 * tag have no `startSource` and mean `ps-lstart-v1` (`sourceOf`).
 */
export type Known = { pid: number; startedAt: number; startSource?: StartSource };
export type Owner = Known & { generation: string };

/**
 * What a new record writes: a start with the clock it was read on, or no
 * start at all (0, from no complete recognized table), which no reader judges.
 * Never untagged with a start, so a new record cannot decode as legacy.
 */
export type Identity =
  { pid: number; startedAt: number; startSource: StartSource } | { pid: number; startedAt: 0 };
export type NewOwner = Identity & { generation: string };

/** The clock a durable record names. Untagged bytes predate the tag and were `ps lstart`. */
export function sourceOf(known: Known): StartSource {
  return known.startSource ?? 'ps-lstart-v1';
}

export function isKnown(raw: unknown): raw is Known {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Known;
  return (
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    Number.isFinite(value.startedAt) &&
    (value.startSource === undefined || isStartSource(value.startSource))
  );
}

export function owner(raw: unknown): raw is Owner {
  return isKnown(raw) && typeof (raw as Owner).generation === 'string';
}

/**
 * What a native table says of a recorded process. Only a complete table on a
 * recognized clock, judging a valid record on that same clock, says `live`
 * or `gone`. Anything else is `unknown`: it neither keeps the record alive
 * nor proves it gone, so nothing the record holds is released on it.
 */
export function judge(
  table: Pick<scan.ProcessTable, 'complete' | 'startSource' | 'starts'>,
  record: Known
): 'live' | 'gone' | 'unknown' {
  if (
    table.complete !== true ||
    !isStartSource(table.startSource) ||
    !isKnown(record) ||
    table.startSource !== sourceOf(record)
  )
    return 'unknown';
  return table.starts.get(record.pid) === record.startedAt ? 'live' : 'gone';
}

/**
 * Members a new record keeps, read by the same selected capability as their
 * owner. An explicit tag is kept, and must name a known clock and agree with
 * a tagged owner's; an untagged member takes the owner's tag. Under an owner
 * with no tag, an untagged member stays untagged (legacy `ps-lstart-v1`).
 */
export function onOwnerClock<M extends { pid: number; startedAt: number; startSource?: unknown }>(
  owner: Known,
  members: readonly M[]
): (Omit<M, 'startSource'> & { startSource?: StartSource })[] {
  return members.map((member) => {
    const explicit = member.startSource;
    if (
      explicit !== undefined &&
      (!isStartSource(explicit) ||
        (owner.startSource !== undefined && explicit !== owner.startSource))
    )
      throw new Error(
        `A remembered process start is on another clock (${JSON.stringify(explicit)}) than its owner's.`
      );
    const startSource = explicit ?? owner.startSource;
    return (startSource === undefined ? member : { ...member, startSource }) as Omit<
      M,
      'startSource'
    > & {
      startSource?: StartSource;
    };
  });
}

export async function native(): Promise<scan.ProcessTable & { startSource: StartSource }> {
  const table = await scan.scanProcesses(true);
  if (!table.complete || !isStartSource(table.startSource))
    throw new Error('Native process identity is unavailable; new agent starts are paused.');
  return table as scan.ProcessTable & { startSource: StartSource };
}

/**
 * Waits a bounded time for a claim. A contended error waits as a held claim
 * does; if the last try still ended on one, that error is the failure reported.
 */
export async function acquire(
  file: string,
  me: NewOwner,
  busy: string,
  known?: scan.ProcessTable
): Promise<() => Promise<void>> {
  let refused: Error | undefined;
  for (let i = 0; i < 100; i++) {
    refused = undefined;
    try {
      const release = await claim(file, me, 0, known);
      if (release) return release;
    } catch (error) {
      if (!platform.files.contended(error)) throw error;
      refused = error as Error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw refused ?? new Error(busy);
}

/** Exclusive create is never stolen by age. Dead-owner removal has its own fence. */
export async function claim(
  file: string,
  me: NewOwner,
  depth = 0,
  known?: scan.ProcessTable
): Promise<(() => Promise<void>) | undefined> {
  const temporary = `${file}.${me.generation}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(me), { flag: 'wx' });
    // Publish complete identity bytes atomically; exclusive create alone exposes an empty file.
    await fs.link(temporary, file);
    return async () => {
      await fs.rm(file);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const text = await read(file);
  if (text === undefined) return undefined;
  let found: unknown;
  try {
    found = JSON.parse(text);
  } catch {
    throw new Error(`Unfinished admission claim: ${file}. Inspect its owner before removing it.`);
  }
  if (!owner(found))
    throw new Error(`Unsupported admission claim: ${file}. Inspect it before retrying.`);
  if (found.startedAt === 0 || (found.pid === me.pid && found.startedAt === me.startedAt))
    return undefined;
  if (known && judge(known, found) === 'live') return undefined;
  const table = await native();
  const verdict = judge(table, found);
  if (verdict === 'live') return undefined;
  if (verdict === 'unknown')
    throw new Error(
      `Admission claim ${file} was written on another process clock. Inspect its owner before removing it.`
    );
  if (depth >= 3)
    throw new Error(`Admission recovery is fenced: ${file}. Inspect the dead owner claims.`);
  const release = await claim(`${file}.lock`, me, depth + 1, table);
  if (!release) return undefined;
  try {
    if ((await read(file)) === text && judge(await native(), found) === 'gone') await fs.rm(file);
  } finally {
    await release();
  }
  return undefined;
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
