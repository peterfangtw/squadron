/**
 * Which window holds Remote (PRD D37): one at a time, no handover. The holder
 * is an extension host's pid and start time, read off the same process table
 * every reader reads, so a pid the machine has since reused is not mistaken for
 * the window that wrote the file.
 *
 * **Not a security boundary.** Any process of this user can write the file,
 * and one naming a live pid at its start reads as that window holding to every
 * reader, whoever wrote it. What it buys: Remote's request kinds act on nothing
 * while Remote is off unless something forges a holder. The one other rule is
 * a person's press, which takes over a holder whose window no live claim names
 * (`acquireHolder`), so a file naming no open window locks nobody out.
 */

import * as incoming from '../incoming';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { writeAtomicJson } from '../files';
import { ask } from '../coordination/ask';
import { scanProcesses } from '../scan';
import { HOLDER_FILE, REMOTE_DIR } from '../paths';
import { sameSessionStart } from '../model';
import type { WindowClaim } from '../model';
import type { ProcessTable } from '../scan';

export type Holder = {
  incoming?: import('../bridge/model').IncomingHolder;
  windowId: string;
  /** What a refusal names, so the reader knows which window to switch to. */
  label: string;
  folder?: string;
  /** The extension host's `process.pid`. */
  pid: number;
  /** That pid's start, from `scanProcesses().starts`. */
  startedAt: number;
  since: number;
};

/** A refusal names the live holder. It names none when this acquire lost its
 *  one retry to a holder that is gone again, which a second try settles. */
export type Acquired = { ok: true } | { ok: false; holder?: Holder };

type Starts = Pick<ProcessTable, 'starts' | 'complete' | 'startSource'>;

/** The live window claims (`readClaims`); only the ids are read. */
type Claims = readonly Pick<WindowClaim, 'id'>[];

/**
 * Alive while its pid is at its start: `core/control.ts`'s guard before every
 * signal, for the same reason. An empty table is a `ps` that failed
 * (`scan.ts` answers `EMPTY`) and judges nothing: the holder is taken as its
 * file names it, so no reader removes, ignores or turns off a live holder on
 * one failed read.
 */
export function holderAlive(holder: Holder, table: Starts): boolean {
  if (table.starts.size === 0) return true;
  return sameSessionStart(table.starts.get(holder.pid), holder.startedAt);
}

/**
 * Whether a live claim names the holder's window, which only a press asks
 * (`acquireHolder`). A claim goes missing while its window lives: its own
 * close removes it, and a sleep can outlast the heartbeat that rewrites it
 * before a reader sweeps it as stale. So no reader that only looks or serves
 * judges by it. An empty list judges nothing, as an empty table does.
 */
function claimed(holder: Holder, claims: Claims): boolean {
  return claims.length === 0 || claims.some((claim) => claim.id === holder.windowId);
}

/** Rounds of create, read and remove before an acquire gives up unnamed. A
 *  round is lost only to a racer mid-removal, which takes a few file calls. */
const TRIES = 20;

/** Locks above a lock: each level is reached only by a remover that died
 *  holding the one below. */
const LOCK_DEPTH = 3;

/**
 * Holds Remote for `me`, or names the live window that already does. A holder
 * that is dead, or whose window no live claim names, is removed and the
 * create tried again, so any number of windows racing for a dead holder end
 * with one winner.
 */
export async function acquireHolder(me: Holder, table: Starts, claims: Claims): Promise<Acquired> {
  const holding = (holder: Holder) =>
    holder.incoming
      ? !incoming.ownerDead(holder.incoming.host, table)
      : holderAlive(holder, table) && claimed(holder, claims);
  for (let round = 0; round < TRIES; round++) {
    if (await create(HOLDER_FILE, me)) return { ok: true };
    const found = await readFile(HOLDER_FILE);
    if (found === undefined) continue;
    // Metadata no reader can judge is never taken over, rewritten or removed.
    if (found.uncertain) return { ok: false, holder: found.holder };
    if (found.holder && isSameHost(found.holder, me)) {
      if (me.incoming && !(await writeAtomicJson(HOLDER_FILE, me))) return { ok: false };
      return { ok: true };
    }
    if (found.holder && holding(found.holder)) return { ok: false, holder: found.holder };
    await removeDead(HOLDER_FILE, found.text, me, table, 0);
  }
  const winner = await readHolder(table);
  return winner && holding(winner) ? { ok: false, holder: winner } : { ok: false };
}

/**
 * A window's close, in D37's order: its claim goes only once Remote there has
 * stopped and released the holder. A press elsewhere takes over a holder whose
 * window no claim names, so a claim removed while the engine drained would
 * let a second window load the store this one still writes.
 */
export async function unclaimAfter(released: Promise<unknown>, unclaim: () => void): Promise<void> {
  await released.catch(() => undefined);
  unclaim();
}

/** Removes the file only while it still names `me`: a window that lost Remote
 *  to a takeover must not release the window that took it. */
export async function releaseHolder(me: Holder): Promise<void> {
  const found = await readFile(HOLDER_FILE);
  if (found?.holder && sameHolder(found.holder, me)) {
    await fs.rm(HOLDER_FILE, { force: true });
  }
}

/** The live holder, or nothing. A dead one is left for the next acquire. */
export async function readHolder(table: Starts): Promise<Holder | undefined> {
  const found = await readFile(HOLDER_FILE);
  const holder = found?.holder;
  return holder && (found.uncertain || holderAlive(holder, table)) ? holder : undefined;
}

/** A holder file alone cannot prove that its engine is still accepting starts. */
export async function incomingHolderNow(
  windowId: string,
  current: import('../bridge/model').IncomingHolder | undefined
): Promise<Holder | undefined> {
  const table = await scanProcesses(true);
  if (!table.complete) return undefined;
  const holder = await readHolder(table);
  const expected = holder?.incoming;
  if (
    !holder ||
    !expected ||
    table.startSource !== expected.host.startSource ||
    table.starts.get(expected.host.pid) !== expected.host.osStartedAt
  )
    return undefined;
  if (expected.host.windowId === windowId)
    return current &&
      incoming.sameHost(current.host, expected.host) &&
      current.generation === expected.generation
      ? holder
      : undefined;
  const challenge = randomUUID();
  const result = await ask({
    kind: 'incomingEvidenceV1',
    version: 1,
    windowId: expected.host.windowId,
    expectedHost: expected.host,
    challenge,
    query: { kind: 'holder', holder: expected }
  });
  const proof = result.ok ? result.reply.incomingHolderEvidence : undefined;
  return proof &&
    proof.challenge === challenge &&
    incoming.sameHost(proof.holder.host, expected.host) &&
    proof.holder.generation === expected.generation
    ? holder
    : undefined;
}

/** Whoever the file names, alive or not; nothing when there is no file or it
 *  names nobody. */
export async function namedHolder(): Promise<Holder | undefined> {
  return (await readFile(HOLDER_FILE))?.holder;
}

/** The same extension host: one pid at one start. */
export function isSameHost(a: Holder, b: Holder): boolean {
  return (
    a.windowId === b.windowId &&
    a.pid === b.pid &&
    (a.incoming && b.incoming
      ? incoming.sameHost(a.incoming.host, b.incoming.host)
      : sameSessionStart(a.startedAt, b.startedAt))
  );
}

export function sameHolder(a: Holder, b: Holder): boolean {
  return (
    isSameHost(a, b) &&
    (a.incoming || b.incoming
      ? !!a.incoming && !!b.incoming && a.incoming.generation === b.incoming.generation
      : true)
  );
}

export async function ownsHolder(me: Holder): Promise<boolean> {
  const current = await namedHolder();
  return !!current && sameHolder(current, me);
}

/**
 * Exclusive and whole at once. `link` fails on an existing name as `wx` does,
 * and the file it names is already written, where a `wx` create is empty until
 * its write lands — and a reader that met it empty would take it for dead.
 */
async function create(file: string, me: Holder): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(REMOTE_DIR, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(me));
    await fs.link(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Removes `file` while it still reads `judged`, one remover at a time. The name
 * is reused, so a remove by every acquirer that judged it dead could take the
 * live holder a racer created since; a rename that checks what it took and
 * links it back still loses it to a third window's create in between. Only
 * the window holding `<file>.lock` reads it again and removes it, and nothing
 * else removes a dead file, so what it read is still there. A lock whose owner
 * died holding it is removed the same way, one level up.
 */
async function removeDead(
  file: string,
  judged: string,
  me: Holder,
  table: Starts,
  depth: number
): Promise<void> {
  const lock = `${file}.lock`;
  if (await create(lock, me)) {
    try {
      const text = await fs.readFile(file, 'utf8').catch(() => undefined);
      if (text === judged) await fs.rm(file, { force: true });
    } finally {
      await fs.rm(lock, { force: true });
    }
    return;
  }
  if (depth >= LOCK_DEPTH) return;
  const owner = await readFile(lock);
  if (owner && !owner.uncertain && !(owner.holder && holderAlive(owner.holder, table))) {
    await removeDead(lock, owner.text, me, table, depth + 1);
  }
}

/**
 * A holder file as read. Absent `incoming` is a legacy holder, judged by
 * pid and start. Present but unreadable or naming another host (an unknown
 * clock among them) is `uncertain`: it is kept as held, its metadata
 * dropped, so neither the legacy rules nor incoming proof can judge it.
 */
async function readFile(
  file: string
): Promise<{ text: string; holder?: Holder; uncertain?: true } | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!isHolder(raw)) return { text };
    const { incoming: optional, ...holder } = raw;
    const metadata = incoming.readIncomingHolder(optional);
    if (
      metadata &&
      metadata.host.pid === holder.pid &&
      metadata.host.osStartedAt === holder.startedAt &&
      metadata.host.windowId === holder.windowId
    )
      return { text, holder: { ...holder, incoming: metadata } };
    return optional === undefined ? { text, holder } : { text, holder, uncertain: true };
  } catch {
    return { text };
  }
}

function isHolder(value: unknown): value is Omit<Holder, 'incoming'> & { incoming?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const holder = value as Partial<Holder>;
  return (
    typeof holder.windowId === 'string' &&
    typeof holder.label === 'string' &&
    (holder.folder === undefined || typeof holder.folder === 'string') &&
    typeof holder.pid === 'number' &&
    Number.isInteger(holder.pid) &&
    holder.pid > 0 &&
    typeof holder.startedAt === 'number' &&
    Number.isFinite(holder.startedAt) &&
    typeof holder.since === 'number' &&
    Number.isFinite(holder.since)
  );
}
