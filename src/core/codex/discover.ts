/**
 * Live Codex pids some window has published, so the fold has a twin to promote.
 *
 * Codex states no channel on disk, so the published record is the only proof a
 * process is ours — the rule Grok keeps too. A typed TUI, somebody else's
 * app-server and one of our own unpublished account/model/usage helpers all
 * look alike from here, and none of them is a card.
 *
 * **What is still dropped is an owned session whose record never landed**, and
 * no cheap reading tells one from a helper. Measured 2026-09-05: *argv* is
 * identical, both call sites hardcoding the same flags; *ppid* is identical,
 * both being pipe children of the same extension-host utility process; *cwd*
 * differs (`os.homedir()` for a helper, the session's directory for a card) but
 * needs an `lsof` per poll and reads a session started in `~` as a helper.
 */

import { readLineage, spawnedBy, type LineageEntry } from '../coordination/lineage';
import type { Session } from '../model';
import {
  publishedProcess,
  readPublished,
  type PassEvidence,
  type PublishedLive
} from '../published';
import { runsCommand, scanProcesses, type Ancestry, type ProcessTable } from '../scan';

/** Pure fold kept separate so the ownership rule has fixture tests. */
export function sessionsFromCodexProcesses(
  table: Ancestry,
  published: ReadonlyMap<number, PublishedLive>,
  edges: ReadonlyMap<number, LineageEntry> = new Map()
): Session[] {
  const rows = new Map<number, Session>();
  for (const proc of table.codex.values()) {
    // The start too, not the pid alone: a force-quit window's record sits in
    // `live/` for days, and a typed codex can land on the recycled pid.
    const found = publishedProcess(proc, 'codex', published, table);
    if (!found || rows.has(found.pid)) continue;
    rows.set(found.pid, {
      pid: found.pid,
      brand: 'codex',
      sessionId: '',
      cwd: '',
      name: '',
      status: 'unknown',
      hasCommand: runsCommand(table, found.pid, 'codex'),
      startedAt: found.startedAt,
      updatedAt: found.startedAt,
      transcript: '',
      ...spawnedBy(edges, found)
    });
  }
  return [...rows.values()];
}

export async function discoverCodex(
  given?: ProcessTable,
  evidence?: PassEvidence
): Promise<Session[]> {
  const table = given ?? (await scanProcesses());
  // Only when there is something to join: most machines running this panel
  // have no Codex alive, and both reads walk a whole directory.
  if (table.codex.size === 0) return [];
  // A caller's one read of the records when it has one, so its board and its
  // confidence describe the same read.
  const [published, edges] = await Promise.all([
    evidence ? evidence.published.records : readPublished(),
    readLineage()
  ]);
  return sessionsFromCodexProcesses(table, published, edges);
}
