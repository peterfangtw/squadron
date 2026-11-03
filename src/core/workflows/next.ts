/**
 * What `squadron-step next` should do, decided from a snapshot of the run.
 *
 * The one place the order lives: a cancelled run, the arming proof, lane pids
 * filled from `lineage/`, the fallback of a lane whose pick never started,
 * readiness, then serving. Pure — `cli/step.ts` ends, opens, registers and
 * writes what this returns, and asks again with a refreshed snapshot after an
 * open. The wait resolver (`wait.ts`) keeps its own order on purpose: it puts
 * refusals before fallback (`TASK_done_workflow_wait_before_lane_start.md`).
 */

import { catalogFor } from '../catalog';
import type { BrandId, Session } from '../model';
import { LINEAGE_DIR, stepCommand } from '../paths';
import type * as commands from '../platform/commands';
import * as graph from './graph';
import {
  armingMiss,
  heldReason,
  holdAfter,
  readiness,
  runMark,
  runRecords,
  serveNext,
  unstarted,
  type Held,
  type LaneOpen,
  type Member,
  type Progress,
  type ServeResult,
  type SpawnEdge
} from './progress';
import type { Workflow } from './workflows';

/** Everything `next` reads, already read. */
export type NextSnapshot = {
  /** The caller's own record. */
  progress: Progress;
  workflow: Workflow;
  cwd: string;
  /** The shell the caller runs what `next` tells it to. */
  shell: commands.Shell;
  /** Frozen for the whole call: a lane opened at it is fresh to every later pass. */
  now: number;
  /** The other records of this run. Read only for a file that names a lane. */
  others?: readonly Progress[];
  /** The board, when it loaded. */
  sessions?: readonly Session[];
  /** Set when the board could not be loaded. Used only if this call must open or wait. */
  boardRefused?: { code: 3; reason: string };
  /** The caller's pid, from the board. Stamped onto an anchor that has none. */
  pid?: number;
  /** Read only when a lane is open: it names a lane's pid by `requestId`, and proves a pid is still that lane's. */
  lineage?: ReadonlyMap<number, SpawnEdge>;
};

/** One lane to open. `fellBack` is the one retry, on the anchor's model. */
export type LaneToOpen = { lane: string; fellBack?: true };

/**
 * `write` is the record given when nothing moved, so the caller can tell an
 * unchanged run by identity and write nothing.
 */
export type NextDecision =
  /** A step served or reprinted, or the run complete. */
  | { kind: 'serve'; out: string; unresolved: readonly string[]; write: Progress }
  /** End `ends` first, then open `opens`, then decide again. */
  | { kind: 'open'; ends: readonly number[]; opens: readonly LaneToOpen[]; write: Progress }
  /** Register a wait over `pids` instead of serving. The blocked step stays pending. */
  | { kind: 'wait'; pids: readonly number[]; write: Progress }
  | { kind: 'refuse'; code: 2 | 3; reason: string };

export function decideNext(snapshot: NextSnapshot): NextDecision {
  const { progress, workflow } = snapshot;
  // A file that names no lane has no board to read and no sibling records.
  if (!graph.hasLanes(workflow.steps)) {
    return spoken(serveNext(progress, workflow, { cwd: snapshot.cwd, now: snapshot.now }));
  }

  // `serveNext` refuses a cancelled run too, but it runs after `readiness`,
  // which would already have opened any lane that was ready.
  if (progress.cancelledAt !== undefined) {
    return refuse(2, 'this run was cancelled from the panel');
  }
  const stamped = stampPid(progress, snapshot.pid);
  const anchor = stamped.lane
    ? snapshot.others?.find((record) => record.sessionId === stamped.anchor)
    : stamped;
  if (!anchor || (stamped.lane && armingMiss(anchor, stamped))) {
    return refuse(
      2,
      'the run this lane was opened for is over — its anchor was re-armed, cancelled, or is gone'
    );
  }
  const others = runRecords(anchor, snapshot.others ?? []);
  const reconciled = stamped.lane
    ? { ok: true as const, progress: stamped }
    : fillLanePids(stamped, others, snapshot.lineage, snapshot.shell);
  if (!reconciled.ok) {
    return refuse(2, reconciled.reason);
  }
  const self = reconciled.progress;
  const opened = self.lane ? anchor.lanes : self.lanes;
  const members = snapshot.sessions?.map((session) => ({
    pid: session.pid,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    ...(session.brand ? { brand: session.brand } : {}),
    idle: session.status === 'idle' && !session.hasCommand
  }));
  // Before readiness, and for every opened lane: a lane nothing waits on would
  // otherwise never fall back. A lane's own next does not open lanes.
  if (!self.lane) {
    const fallback = decideFallback(
      workflow,
      self,
      others,
      opened,
      members,
      snapshot.now,
      snapshot.lineage
    );
    if (fallback) return fallback;
  }
  const found = readiness({
    workflow,
    self,
    others,
    opened,
    members,
    lineage: snapshot.lineage,
    now: snapshot.now
  });
  if (found.stall) {
    return refuse(2, found.stall);
  }
  // Open before serving. A step marked in_progress in this same decision would
  // be written before the lane pids, and a crash in between would open the lane again.
  if (found.openLanes.length > 0) {
    if (snapshot.boardRefused) return { kind: 'refuse', ...snapshot.boardRefused };
    return {
      kind: 'open',
      ends: [],
      opens: found.openLanes.map((lane) => ({ lane })),
      write: self
    };
  }

  const served = serveNext(self, workflow, {
    cwd: snapshot.cwd,
    now: snapshot.now,
    others: others.flatMap((record) =>
      record.steps.map((step) => ({ id: step.id, status: step.status }))
    )
  });
  const holding =
    found.waitPids.length > 0 &&
    (served.outcome === 'waiting' || (served.outcome === 'complete' && !self.lane));
  if (holding) {
    if (snapshot.boardRefused) return { kind: 'refuse', ...snapshot.boardRefused };
    const waitOn = found.waitOn ?? [];
    const hold = holdAfter(
      self.held,
      runMark([self, ...others], opened ?? {}),
      waitOn.every((target) => target.idle)
    );
    if (hold.refuse) {
      return refuse(2, heldReason(waitOn, snapshot.shell));
    }
    return { kind: 'wait', pids: found.waitPids, write: withHeld(served.progress, hold.held) };
  }
  const said = spoken(served);
  // The anchor is done when its own steps are done and every lane is already
  // in `lanes`. It does not wait for those lanes to finish their work.
  if (said.kind === 'serve' && served.outcome === 'complete' && !self.lane) {
    return { ...said, out: 'Run complete — your steps are done, and every lane is open.' };
  }
  return said;
}

function refuse(code: 2 | 3, reason: string): NextDecision {
  return { kind: 'refuse', code, reason };
}

function stampPid(progress: Progress, pid: number | undefined): Progress {
  if (pid === undefined || progress.pid !== undefined || progress.lane) return progress;
  return { ...progress, pid };
}

/**
 * Give each lane the window never named a pid for one, from `lineage/`.
 *
 * The window writes a spawn's lineage under the `requestId` that asked for it,
 * which is the one name this side holds for a session it never heard the pid
 * of. A lane that has written its record needs none: the board is asked by its
 * session id. Not found is a refusal naming the id, never a second open —
 * the first may yet have started, and two would each work the lane.
 */
function fillLanePids(
  self: Progress,
  others: readonly Progress[],
  lineage: ReadonlyMap<number, SpawnEdge> | undefined,
  shell: commands.Shell
): { ok: true; progress: Progress } | { ok: false; reason: string } {
  let lanes = self.lanes;
  for (const [name, entry] of Object.entries(self.lanes ?? {})) {
    if (entry.refused !== undefined) {
      return {
        ok: false,
        reason: `${entry.refused}. Nothing was started for ${name}, so this run stops here. Only a new run of this workflow (\`${stepCommand(shell, 'start', '--workflow-id', self.workflowId, '--force')}\`) tries its pick again`
      };
    }
    if (entry.pid !== undefined || others.some((record) => record.lane === name)) continue;
    const pid =
      entry.requestId === undefined
        ? undefined
        : [...(lineage ?? [])].find(([, edge]) => edge.requestId === entry.requestId)?.[0];
    if (pid === undefined) {
      return {
        ok: false,
        reason:
          entry.requestId === undefined
            ? `${name} was being opened when an earlier call stopped, and nothing says whether it started — look for a session named ${name} before anything opens it again`
            : `${name} was asked for and its window never said which session it became. A session may still have started: look under ${LINEAGE_DIR} for an entry whose requestId is ${entry.requestId} before anything opens it again`
      };
    }
    lanes = { ...lanes, [name]: { ...entry, pid } };
  }
  return { ok: true, progress: lanes === self.lanes ? self : { ...self, lanes } };
}

function withHeld(progress: Progress, held: Held | undefined): Progress {
  if (held !== undefined) return { ...progress, held };
  if (progress.held === undefined) return progress;
  const { held: _cleared, ...rest } = progress;
  return rest;
}

/**
 * Lanes whose stated pick never started: the idle children to end, and the
 * lanes to reopen once, falling back to the anchor's model. A lane that has already fallen back, or that stated
 * no pick, is left for readiness.
 *
 * Implies a board, and does not check `boardRefused`: `members` is absent
 * without one.
 */
function decideFallback(
  workflow: Workflow,
  self: Progress,
  others: readonly Progress[],
  opened: Readonly<Record<string, LaneOpen>> | undefined,
  members: readonly Member[] | undefined,
  now: number,
  lineage: ReadonlyMap<number, SpawnEdge> | undefined
): NextDecision | undefined {
  if (members === undefined) return undefined;
  const rows = unstarted({
    opened: opened ?? {},
    records: [self, ...others],
    members,
    now,
    lineage
  }).filter(
    (row) => !row.fellBack && pickName(graph.opener(workflow.steps, row.lane)) !== undefined
  );
  if (rows.length === 0) return undefined;
  const lanes = { ...(self.lanes ?? {}) };
  for (const row of rows) delete lanes[row.lane];
  return {
    kind: 'open',
    ends: rows.flatMap((row) => (row.pid === undefined ? [] : [row.pid])),
    opens: rows.map((row) => ({ lane: row.lane, fellBack: true as const })),
    write: { ...self, lanes }
  };
}

/** A lane's stated pick as the model menu names it: `Opus 5.5`, not `claude-opus-5-5`. */
export function pickName(
  step: { brand?: BrandId; model?: string; effort?: string } | undefined
): string | undefined {
  const model = step?.model;
  const named =
    step?.brand === undefined || model === undefined
      ? undefined
      : catalogFor(step.brand).find((entry) => entry.value === model)?.name;
  return named ?? model ?? step?.brand ?? step?.effort;
}

function spoken(result: ServeResult): NextDecision {
  if (result.outcome === 'complete') {
    // Carries a record because a run can finish *by* an edit — deleting the
    // last step — and the rows it leaves behind would otherwise go on being
    // counted by the drawer against a command that has said the run is over.
    return {
      kind: 'serve',
      out: 'Run complete — every step is done.',
      unresolved: [],
      write: result.progress
    };
  }
  if (result.outcome === 'blocked') {
    return refuse(2, result.reason);
  }
  if (result.outcome === 'waiting') {
    // A run with lanes registers this as a wait above. A one-session run never
    // waits: its cursor is the first step not done, and every `needs` is above it.
    const who = result.pending.length === 0 ? 'an earlier step' : result.pending.join(', ');
    return refuse(2, `${result.id} is waiting on ${who}`);
  }
  return {
    kind: 'serve',
    out: `${result.header}\n\n${result.body}`,
    unresolved: result.unresolved,
    write: result.progress
  };
}
