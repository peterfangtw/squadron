/**
 * Live Grok pids some window has published, so the fold has a twin to promote.
 *
 * Grok states no channel on disk, so the published record is the only proof a
 * process is ours — the same rule Codex keeps. A grok somebody typed at a shell
 * has none and is dropped before anything about it is read. The process table
 * itself keeps every grok: `grok/auth.ts` refuses a token refresh while any
 * runs, since a TUI spends the same refresh token.
 *
 * Lineage too, so a child this machine spawned boards under its parent rather
 * than beside it.
 */

import { readLineage, spawnedBy, type LineageEntry } from '../coordination/lineage';
import type { Session } from '../model';
import {
  publishedProcess,
  readPublished,
  type PassEvidence,
  type PublishedLive
} from '../published';
import { runsCommand, scanProcesses, type ProcessTable } from '../scan';

export async function discoverGrok(
  given?: ProcessTable,
  evidence?: PassEvidence
): Promise<Session[]> {
  const table = given ?? (await scanProcesses());
  const { grok } = table;
  // Only when there is something to join: `readLineage` is 3-6 ms over a real
  // store (214 edges), and most machines running this panel have no Grok alive.
  // A caller's one read of the records when it has one (see Codex's).
  const published: ReadonlyMap<number, PublishedLive> =
    grok.size === 0 ? new Map() : evidence ? evidence.published.records : await readPublished();
  const edges = grok.size > 0 ? await readLineage() : new Map<number, LineageEntry>();
  const rows = new Map<number, Session>();
  for (const proc of grok.values()) {
    // The start too, not the pid alone: a force-quit window's record sits in
    // `live/` for days, and a typed grok can land on the recycled pid.
    const found = publishedProcess(proc, 'grok', published, table);
    if (!found || rows.has(found.pid)) continue;
    rows.set(found.pid, {
      pid: found.pid,
      brand: 'grok',
      sessionId: '',
      cwd: '',
      name: '',
      status: 'unknown',
      // Probed 2026-10-05 on 1.0.46: a tool shell, backgrounded or not, is a
      // direct child of the grok pid, and an idle grok keeps no shell child.
      hasCommand: runsCommand(table, found.pid, 'grok'),
      startedAt: found.startedAt,
      updatedAt: found.startedAt,
      transcript: '',
      ...spawnedBy(edges, found)
    });
  }
  return [...rows.values()];
}
