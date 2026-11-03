import * as fs from 'fs/promises';
import * as path from 'path';
import * as platform from './platform';
import type { Kind } from './platform/files';

/**
 * The filesystem questions more than one reader here asks, kept where none of
 * them owns the answer.
 *
 * Small on purpose. What lands here is a call with no domain in it at all —
 * `writtenAt` is a `stat`, and it was exported from `discover.ts` only because
 * that is where it was first needed, which made `acks.ts` import the whole of
 * discovery for one line of it.
 *
 * `writeAtomicJson`, `writeAtomicText`, `readJson` and `readJsonDir` are the
 * file idiom every per-session store under `STATE_DIR` is written in. They
 * were written out per module instead, and the copies drifted: a pruner that
 * could not see the `.tmp` its own writers rename from, and a claim reader
 * that cast where its five siblings narrowed, were both consequences of that
 * rather than independent mistakes. One body each is what stops the class,
 * not just the copies.
 */

/**
 * When a file was last written, or nothing when it cannot be stat'd — which
 * degrades exactly as a failed read does, into "this source has no say".
 *
 * The cheapest thing that would answer, and usually a page-cache hit: every
 * caller is stat'ing a file the same pass already reads. `discover.ts` could
 * hand the transcript's mtime out of the stat its tail read already pays for,
 * but `Stats` is what the newest *answer* said and a file's clock is not that.
 */
export async function writtenAt(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * A file's write time and size as one string, or `absent`: a fingerprint of
 * state another program owns, taken without reading it. Equal means the file
 * was not rewritten; a rewrite that kept both is not one any caller here has
 * met, since the writers this serves replace the whole file.
 */
export async function fileStamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

/** Distinguishes overlapping writes' temp files, as `WindowClaimant` does. */
let seq = 0;

/**
 * Temp-then-rename of one finished body. Returns whether the write landed.
 * Never throws.
 *
 * `writeFile` truncates first, so a reader catching it mid-write parses garbage
 * and whatever it was drawing blinks out. Renaming a finished file into place
 * is atomic, and the reader either sees the old one or the new one.
 *
 * **The temp name deliberately does not end in `.json`.** `host/watch.ts`
 * watches every `.json` under the state root, subdirectories included, so a
 * `.json` temp name would nudge every window on the machine on every write
 * *and* be there to be parsed half-written. The finished file nudging them is
 * the point. This trap was rediscovered three times while this body was written
 * out four — and the `.tmp` suffix it settles on is what `prune.ts`'s `record`
 * sweeps, since a crashed write's leftovers are invisible to a `.json` filter
 * by construction.
 */
async function writeAtomic(
  file: string,
  body: string | AsyncIterable<string>,
  kind: Kind,
  current: () => boolean = () => true
): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, body);
    if (!current()) {
      await fs.rm(tmp, { force: true });
      return false;
    }
    await platform.files.replace(tmp, file, { kind });
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * One JSON record, through `writeAtomic`. Callers that treat disk as
 * best-effort (status stores, claims) ignore the boolean; callers that must
 * report failure (workflow save) check it.
 *
 * `JSON.stringify` throws on a cycle. The `try` keeps that a `false`.
 */
export async function writeAtomicJson(file: string, record: unknown, kind: Kind): Promise<boolean> {
  try {
    return await writeAtomic(file, JSON.stringify(record), kind);
  } catch {
    return false;
  }
}

/** Text or bounded chunks, through the same publication as `writeAtomicJson`. */
export async function writeAtomicText(
  file: string,
  body: string | AsyncIterable<string>,
  kind: Kind,
  current: () => boolean = () => true
): Promise<boolean> {
  return writeAtomic(file, body, kind, current);
}

/**
 * One file's contents, parsed, or nothing when it cannot be read or is not
 * JSON — which are the same outcome to every caller here: this source has no
 * say. The cast is the caller's to earn; `readJsonDir` hands `unknown` on.
 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Every `.json` in one directory, read in parallel and narrowed by `pick`.
 *
 * A missing directory is an empty list — the machine that has written none.
 * Unreadable, half-written and foreign files are skipped rather than thrown
 * over: these are read on the panel's poll, and one bad file must not cost the
 * caller every other record.
 *
 * `pick` gets the parsed value as `unknown` and the file's name, and returns
 * what it is worth keeping or nothing. Narrowing is deliberately its job and
 * not this function's: the shapes differ per store, and the one copy of this
 * loop that skipped the step is what made a malformed claim immortal.
 *
 * Optional `keepName` drops files **before** they are opened — for sibling
 * suffixes that share a directory with the store (e.g. `*.progress.json` next
 * to run records) so a poll does not pay parse cost on known foreign names.
 *
 * The files are read in parallel and picked over afterwards, rather than picked
 * inside the read: `pick` is synchronous, so a caller with something to do about
 * a file it rejects — `claims.ts` removes it — does that on the names it kept
 * back, and nothing here has to thread a promise through the narrowing.
 */
export async function readJsonDir<T>(
  dir: string,
  pick: (raw: unknown, name: string) => T | undefined,
  keepName: (name: string) => boolean = () => true
): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const read = await Promise.all(
    names
      .filter((name) => name.endsWith('.json') && keepName(name))
      .map(async (name) => ({ name, raw: await readJson<unknown>(path.join(dir, name)) }))
  );

  const kept: T[] = [];
  for (const { name, raw } of read) {
    if (raw === undefined) {
      continue; // half-written, or not ours — the next poll sees it whole
    }
    const value = pick(raw, name);
    if (value !== undefined) {
      kept.push(value);
    }
  }
  return kept;
}
