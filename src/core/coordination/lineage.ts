/**
 * Who spawned whom.
 *
 * A spawn is the only moment that fact exists: the request names the parent, the
 * started process names the child, and a second later the CLI has a session that
 * knows neither. So it is written down here, keyed by **a live pid the spawn is
 * responsible for** — the only identifier there is before the child has a
 * sessionId. Every start a window makes is a CLI child process it drives, so
 * that pid is the CLI's own, and `discover` joins on it. Entries older builds
 * keyed by the shell that held a child's terminal are joined by nothing, and
 * age out with the rest.
 *
 * One file per child, not one shared map: a single `lineage.json`
 * read-modify-written by every window loses edges when two windows spawn in the
 * same tick, and temp-then-rename makes a write atomic, not a read-modify-write
 * safe. Same reason claims, activity and pastes are each a file per owner.
 *
 * Swept by age, never by liveness. Session files are keyed by pid and vanish
 * with the process, so "drop the edge when the child is gone" would delete every
 * edge seconds after the work finished — which is exactly when a lineage view is
 * worth reading. `pruneStatus` sweeps `LINEAGE_DIR` at seven days instead
 * (`core/prune.ts`), which outlasts any reading of the tree.
 */

import * as path from 'path';
import type { SpawnAction } from './actions';
import { readJsonDir, writeAtomicJson } from '../files';
import { LINEAGE_DIR } from '../paths';

/**
 * What one spawn records: the `spawn` variant of `ActionRecord`, because a
 * spawn is the same kind of fact a send is — one session acting on another. The
 * type is shared with `core/coordination/actions.ts`; the store is not, and §5.10 of
 * `PRD_shipped_cross_session_verbs.md` says why.
 *
 * `schema` because the UI (roadmap item 4) and assignments (item 14) will both
 * want more out of this file than it holds, and it outlives the task that
 * introduced it.
 *
 * `parentSessionId` is optional because a prompt-carrying open is written down
 * whether or not its writer said who it was: the entry is also what the spawn
 * cap counts, and an agent that omits the field must not thereby become
 * uncountable.
 *
 * `requestId` is the only key that exists before the child does, so it is what
 * a caller polls on to learn which session its spawn became.
 *
 * `originSessionId` is stamped rather than derived because nothing here can
 * derive it. An entry is keyed by the child's **pid** and never learns the
 * child's own sessionId — it is written before the child has one — so a third
 * generation's `parentSessionId` cannot be turned back into its parent's entry
 * once that session's file is gone. Walking the live board has the same hole:
 * a dismissed middle generation leaves its children with no waypoint back. A
 * sessionId written down at the spawn is what survives the generation between.
 */
export type LineageEntry = SpawnAction;

/**
 * Records one spawn. Best effort: a machine that cannot write this still gets
 * the session it asked for, and every reader degrades a missing edge to
 * "parent unknown". Temp-then-rename, in `writeAtomicJson` — a spawned card
 * should not wait out a poll, so the finished file is what nudges the windows.
 *
 * `kind` is stamped here rather than asked of the caller: every entry in this
 * directory is a spawn, and the field is what makes a record self-describing
 * once one is read anywhere else.
 */
export async function writeLineage(pid: number, entry: LineageEntry): Promise<void> {
  await writeAtomicJson(path.join(LINEAGE_DIR, `${pid}.json`), { ...entry, kind: 'spawn' });
}

/**
 * Every edge on the machine, by the pid its spawn was keyed on — see the header:
 * the CLI child's today, a shell's in files older builds left. Unreadable,
 * half-written and foreign files are skipped rather than thrown over: this is
 * read on the panel's poll, and one bad file must not cost the whole graph.
 */
export async function readLineage(): Promise<Map<number, LineageEntry>> {
  const edges = await readJsonDir(LINEAGE_DIR, (raw, name) => {
    const pid = Number(path.basename(name, '.json'));
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    // A number is the whole requirement: `spawnedAt` is what bounds the join
    // against a re-used terminal, and an entry without one cannot be used.
    const entry = raw as LineageEntry | undefined;
    return entry && typeof entry.spawnedAt === 'number' ? ([pid, entry] as const) : undefined;
  });
  return new Map(edges);
}

/**
 * How long after a spawn a session may still be recognised as its child.
 *
 * The key a lineage edge carries is a pid, and a pid is not an identity: it
 * is reused once the number space wraps, and the edge sits on disk for the
 * seven days `pruneStatus` gives it. Without a ceiling, *any* later session
 * landing on that number inherits a stranger's parent — a card in the wrong
 * family box, and an End-all that offers to end a session it never started.
 *
 * Five minutes rather than the second the real gap takes — a start read off
 * `ps` lands within `START_SLACK_MS` either side of its edge, measured over ten
 * sessions on 2026-09-16 — because the measured cases are all panel-driven,
 * where the child is started directly. A terminal spawn creates a shell first
 * and then cold-starts node inside it, and that gap has never been measured;
 * the bound is set well past anything it could plausibly be. It still cuts the
 * window a recycled pid can land in by three orders of magnitude against the
 * seven-day sweep, and the cost of being too tight is only a session with no
 * parent, which every surface already draws as nothing.
 */
export const LINEAGE_MATCH_MS = 5 * 60_000;

/**
 * How far *before* its edge a start may sit and still be that spawn's.
 *
 * Both ends of the gap are measured. `startedAt` is `ps` `lstart` for every
 * brand, which states no sub-second field (`parsePsRow`), so a reported start
 * is up to 1000 ms earlier than the fork; and the edge is stamped `Date.now()`
 * after `spawn()` returned (`host/sessions.ts`), so it is later still. Every
 * owned child is therefore on the wrong side of a floor of zero —
 * deterministically, not sometimes. Two seconds is that second plus headroom,
 * against a ceiling that is untouched.
 */
const START_SLACK_MS = 2000;

/**
 * The edge a live process was spawned under, or none: `edges` joined on its pid,
 * inside the start-time window {@link spawnedBy} explains. Also how
 * `squadron-step` proves a lane's stored pid is still that lane's child.
 */
export function edgeOf<E extends { spawnedAt: number }>(
  edges: ReadonlyMap<number, E>,
  live: { pid: number; startedAt: number }
): E | undefined {
  const edge = edges.get(live.pid);
  const since = live.startedAt - (edge?.spawnedAt ?? 0);
  return edge !== undefined && since >= -START_SLACK_MS && since < LINEAGE_MATCH_MS
    ? edge
    : undefined;
}

/** The process `edge` spawned is still `pid` only inside {@link edgeOf}'s window.
 *  A missing start is a different process, or none. */
export function lineageAlive(
  pid: number,
  edge: { spawnedAt: number },
  start: number | undefined
): boolean {
  return (
    start !== undefined && edgeOf(new Map([[pid, edge]]), { pid, startedAt: start }) !== undefined
  );
}

/**
 * What a live session's parentage is, joined on the session's own pid. Every
 * brand's discover calls this: the edges are keyed by pid and the rule knows
 * nothing about any CLI's files or wire.
 *
 * Bounded at both ends, because a pid is not an identity: pids are recycled,
 * and an edge outlives its child by the seven days `pruneStatus` allows. The
 * floor catches a pid that started before the edge was written; the ceiling
 * catches one meeting a days-old edge; see `LINEAGE_MATCH_MS`.
 *
 * The floor carries `START_SLACK_MS` because of the clock `startedAt` is read
 * on, which is `ps` `lstart` for every brand.
 *
 * Written as one bound the gap must land *inside*, so a `startedAt` of `NaN`
 * fails it. `parsePsRow` parses a localised `lstart` to `NaN` — `ps` honours
 * `LC_TIME`, and the regex matches a weekday `Date.parse` cannot read — and a
 * `NaN` gap is below no floor and above no ceiling, so two negated comparisons
 * admitted the edge that both of them exist to refuse.
 */
export function spawnedBy(
  edges: ReadonlyMap<number, LineageEntry>,
  live: { pid: number; startedAt: number }
): { parentSessionId?: string; originSessionId?: string } {
  const edge = edgeOf(edges, live);
  if (edge === undefined) {
    return {};
  }
  // The window is shared, the presence check is per field: an entry with an
  // origin and no parent must still stamp the origin.
  return {
    ...(edge.parentSessionId !== undefined ? { parentSessionId: edge.parentSessionId } : {}),
    ...(edge.originSessionId !== undefined ? { originSessionId: edge.originSessionId } : {})
  };
}
