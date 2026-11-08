import { pruneStartupRecords } from './coordination/startup_records';
import * as fs from 'fs/promises';
import * as path from 'path';
import { WINDOWS_DIR } from './coordination/claims';
import {
  CATALOG_DIR,
  ACKS_DIR,
  ACTIONS_DIR,
  ARRANGE_DIR,
  THREADS_DIR,
  LINEAGE_DIR,
  LIVE_DIR,
  RUNS_DIR,
  DUMP_DIR,
  STATE_DIR,
  WORKFLOW_ORDER_NAME
} from './paths';

/**
 * Dropping what dead sessions leave behind. Nothing that writes these ever
 * removes them.
 *
 * Every age below, and why it is what it is: `docs/reference/state_retention.md`.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweeps every store under `STATE_DIR` that has no sweep of its own, and the
 * sidecar top at `DUMP_DIR`. Ages: `docs/reference/state_retention.md`.
 *
 * Two are not housekeeping and should not be shortened without reading it:
 * `runs/` decides how long a finished workflow stays readable, and `workflows/`
 * is absent here because the user wrote those by hand. `STATE_DIR`'s top is
 * unswept and holds more than `workflows.order.json`:
 * `workflows.examples.seeded`, and the usage, models, and signin files
 * (`docs/reference/state_retention.md`).
 */
export async function pruneStatus(): Promise<void> {
  await pruneStartupRecords();
  await pruneOlderThan(CATALOG_DIR, DAY_MS, temp);
  await pruneOlderThan(ACKS_DIR, 7 * DAY_MS);
  await pruneOlderThan(DUMP_DIR, 7 * DAY_MS, statusRecord);
  await pruneOlderThan(LINEAGE_DIR, 7 * DAY_MS, record);
  await pruneOlderThan(ACTIONS_DIR, 7 * DAY_MS, record);
  await pruneOlderThan(RUNS_DIR, 7 * DAY_MS, record);
  await pruneOlderThan(LIVE_DIR, 7 * DAY_MS, record, async (file) => {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return !raw || typeof raw !== 'object' || !('receiverIdentity' in raw);
  });
  await pruneOlderThan(ARRANGE_DIR, 30 * DAY_MS, record);
  // Conversation deletion shares the holder's loaded Bridge mutation queue, never another window's age sweep.
  // No `record` filter: it matches `.json` and `.tmp`, and this file is `.md`.
  await pruneOlderThan(THREADS_DIR, 30 * DAY_MS);
  await pruneOlderThan(WINDOWS_DIR, DAY_MS, temp);
  await pruneExecution();
}

/**
 * `execution/<runtime>/` directories and `runners/`, by age alone like every
 * store above, and nothing else removes either. A runtime directory goes once
 * nothing inside it has been written for seven days — `context.json` is
 * rewritten at every turn's admission — so a dead runtime keeps its journal
 * for activation's sweep to end it, and a late hook after a clean end still
 * finds that journal's runtime-end. A runner goes once its mtime is seven days
 * old: `prepareExecution` touches it on reuse and `admitExecution` on every
 * turn. Nothing here reads `host.json`.
 */
export async function pruneExecution(
  root: string = path.join(STATE_DIR, 'execution')
): Promise<void> {
  const cutoff = Date.now() - 7 * DAY_MS;
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => RUNTIME.test(name))
      .map(async (name) => {
        const directory = path.join(root, name);
        try {
          if ((await touchedAt(directory)) < cutoff) await fs.rm(directory, { recursive: true });
        } catch {
          // gone already, or something inside vanished mid-read
        }
      })
  );
  await pruneOlderThan(path.join(root, 'runners'), 7 * DAY_MS, (name) =>
    /^[0-9a-f]{64}\.js$/.test(name)
  );
}

const RUNTIME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The newest mtime of a directory and everything under it. Grok's plugin is a subdirectory. */
async function touchedAt(directory: string): Promise<number> {
  const inside = await fs.readdir(directory, { recursive: true });
  const stats = await Promise.all(
    [directory, ...inside.map((name) => path.join(directory, name))].map((file) => fs.stat(file))
  );
  return Math.max(...stats.map((stat) => stat.mtimeMs));
}

/** The finished `.json`, or a `${file}.${pid}.${seq}.tmp` a crashed write left. */
function record(name: string): boolean {
  return name.endsWith('.json') || name.endsWith('.tmp');
}

/**
 * `record`, less a leftover `workflows.order.json` at the old dump top —
 * `docs/reference/state_retention.md`. The live order sits unswept on
 * `STATE_DIR`; this exclude is so a later hand-copy is not deleted first.
 */
function statusRecord(name: string): boolean {
  return record(name) && name !== WORKFLOW_ORDER_NAME;
}

/**
 * The temp half alone, for a directory whose finished files are swept by their
 * own reader — a claim is live or stale by its `updatedAt`, 90s and not a day.
 */
function temp(name: string): boolean {
  return name.endsWith('.tmp');
}

/**
 * Removes the files directly in `dir` that `match` accepts and whose mtime is
 * older than `maxAgeMs`. Subdirectories are skipped whatever `match` says — each
 * is swept on its own terms, by its own call above.
 *
 * Age rather than a liveness check, on purpose; the argument, and where it does
 * not hold, is in `docs/reference/state_retention.md`.
 *
 * Never throws: a missing directory is a machine that has not written one yet,
 * and a file that vanishes mid-sweep is one someone else got to first.
 */
export async function pruneOlderThan(
  dir: string,
  maxAgeMs: number,
  match: (name: string) => boolean = () => true,
  eligible: (file: string) => Promise<boolean> = () => Promise.resolve(true)
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names.filter(match).map(async (name) => {
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff && (await eligible(file))) {
          await fs.rm(file, { force: true });
        }
      } catch {
        // gone already, or never ours to remove
      }
    })
  );
}
