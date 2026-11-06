/**
 * Where the reader put the cards.
 *
 * A group's order is derived — `startedAt` ascending, families after the loose
 * cards — and derived order is nobody's. This is the one thing on the board that
 * a person states rather than the machine: a flat list of top-level **slots**,
 * each either a loose card's pid or the pid of the parent a family box is headed
 * by. The two namespaces cannot collide, since a card is drawn in exactly one
 * place, so the stored form needs no tag and no nesting.
 *
 * One file per group rather than a shared map, for the reason `lineage.ts` gives
 * at length: temp-then-rename makes a write atomic, not a read-modify-write
 * safe, and two windows dragging in the same tick would cost one of them its
 * order. Here the blast radius is one directory's arrangement instead of every
 * edge on the machine.
 *
 * Last write wins, with no lock. Two windows arranging the same group in the
 * same second is one of them losing and finding out on the next poll; at one
 * user that is a shrug, and it is written down here so it is not later filed as
 * a bug.
 *
 * **An arrangement lives exactly as long as its sessions.** Every slot is a pid,
 * guarded by the `startedAt` it had when the drag happened, so a recycled pid
 * places nothing and a file whose sessions have all ended resolves to an empty
 * order — which is today's derived board. That is the property that makes this
 * safe to keep no matter how stale: forgetting it is free, and remembering it
 * wrongly is impossible.
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readJsonDir, writeAtomicJson } from './files';
import { ARRANGE_DIR } from './paths';
import * as platform from './platform';
import type { PathKey } from './platform/paths';

/**
 * One slot in the order. `startedAt` is not identity — `pid` is — it is the
 * guard: pids are recycled within a session of the panel's own lifetime, and a
 * new session inheriting a dead one's number must not inherit its place.
 */
export type ArrangeSlot = { pid: number; startedAt: number };

/**
 * What one group's order records. `schema` because the slot may yet want a
 * work-shaped key alongside the pid (PRD OQ1), and this file outlives the task
 * that introduced it.
 *
 * `cwd` is stored inside the file as well as hashed into its name, which is what
 * makes a hash collision detectable rather than silent — and what lets a person
 * reading the directory tell which order belongs to what.
 */
export type Arrangement = { schema: 1; cwd: string; updatedAt: number; slots: ArrangeSlot[] };

/**
 * A cwd's file name. Hashed rather than escaped: a path contains `/`, and a deep
 * one blows the 255-byte limit on a single path component long before it blows
 * anything else. Sixteen hex characters of SHA-256 is 64 bits, which at the
 * dozens-of-directories this holds is a collision nobody will see — and if one
 * ever lands, the `cwd` inside the file is what says so.
 */
function fileFor(cwd: string): string {
  return createHash('sha256').update(platform.paths.key(cwd)).digest('hex').slice(0, 16) + '.json';
}

/**
 * Records one group's order. Best effort: a machine that cannot write this still
 * has a board, drawn in the order it derives.
 *
 * Temp-then-rename, in `writeAtomicJson` — the other window's board should agree
 * within a paint, not within a poll, and the finished file is what nudges it.
 */
export async function writeArrangement(cwd: string, slots: ArrangeSlot[]): Promise<void> {
  const record: Arrangement = { schema: 1, cwd, updatedAt: Date.now(), slots };
  await writeAtomicJson(path.join(ARRANGE_DIR, fileFor(cwd)), record);
}

/**
 * Every stored order on the machine, by its cwd's key. Unreadable, half-written and
 * foreign files are skipped rather than thrown over: this is read on the panel's
 * poll, and one bad file must not cost every other group its arrangement.
 */
export async function readArrangements(): Promise<Map<PathKey, Arrangement>> {
  const orders = await readJsonDir(ARRANGE_DIR, (value, name) => {
    const raw = value as Arrangement | undefined;
    if (!raw || raw.schema !== 1 || typeof raw.cwd !== 'string' || !Array.isArray(raw.slots)) {
      return undefined;
    }
    // Only the file today's key names. One hashed from an older key (a win32
    // lower-drive spelling) holds the same cwd, and whichever the directory
    // listed last would win the map, new saves or not. Left on disk, unread.
    if (name !== fileFor(raw.cwd)) return undefined;
    // Every slot, not the list's length: a slot missing its guard would place a
    // card on pid alone, which is the one thing the guard exists to stop.
    const slots = raw.slots.filter(
      (s): s is ArrangeSlot => !!s && typeof s.pid === 'number' && typeof s.startedAt === 'number'
    );
    return slots.length === raw.slots.length
      ? ([platform.paths.key(raw.cwd), { ...raw, slots }] as [PathKey, Arrangement])
      : undefined;
  });
  return new Map(orders);
}

/**
 * Forgets every order on the machine — what the gear's reset item calls. Board
 * wide rather than per group, because the derived order is the thing being
 * returned to and it has no per-group half.
 */
export async function clearArrangements(): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(ARRANGE_DIR);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.rm(path.join(ARRANGE_DIR, name), { force: true }).catch(() => {}))
  );
}
