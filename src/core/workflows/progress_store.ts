/**
 * One workflow running at one session — the whole record there is.
 *
 * There was a `Run` beside this once, holding provenance and a `stepIndex` the
 * panel advanced. The panel does not advance runs (`PRD_shipped_workflows.md`
 * §15), so the record held nothing the file could not: the label moved here,
 * the status became {@link rollup}, and the rest was for a driver that was
 * never built. **This file existing is the follow** — `host/panel.ts` puts one
 * back if the send that seeded it is refused, so nothing else has to say
 * whether the arming message went.
 *
 * Progress is the session-owned cursor: the extension seeds every step
 * `pending` and `squadron-step` moves it as the agent pulls a step and
 * reports it finished. The panel only reads — it never advances steps or
 * invents step N from the transcript (`PRD_shipped_workflow_progress.md`,
 * runtime §15). Freehand editing was how the cursor moved until the CLI
 * shipped, and a run seeded before that still moves that way: the execution owner
 * tolerates a hand-advanced file rather than assuming it wrote every row.
 *
 * Path: `~/.squadron/runs/<sessionId>.progress.json` — keyed by
 * session so a poll is one `stat` and never a `readdir`, and in `RUNS_DIR` for
 * the 7-day sweep `prune.ts` already runs. **The key cannot change**: the
 * briefing puts the literal path in the arming message and the agent holds it
 * as a string, while `squadron-step` recomputes it from the caller's session
 * id on every call — a key that moved would leave the two naming different
 * files. Missing or unreadable is a valid state: coarse “following X” only.
 */

import { rm } from 'fs/promises';
import * as path from 'path';
import { readJson, readJsonDir, writeAtomicJson } from '../files';
import { RUNS_DIR } from '../paths';
import * as graph from './graph';

/** How a step spells its state. Anything else on disk is unusable for that step. */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * A lane the anchor has opened. `openedAt` is written **before** the spawn and
 * is the arming's token: the child is started with it (`--opened`) and a lane
 * record counts for this run only while it matches. It is also the fresh-lane
 * window's start. `pid` is added once the window says which process; an open
 * the window never answered keeps its `requestId` instead, so the lane is found
 * in `lineage/` rather than opened a second time.
 */
export type LaneOpen = {
  openedAt: number;
  pid?: number;
  requestId?: string;
  /**
   * Set once this lane was opened again on the anchor's model, after its
   * stated pick could not start. A later `next` must not retry that pick.
   */
  fellBack?: true;
  /**
   * Set when that fallback was refused for its pick too, so nothing started:
   * the sentence every later `next` stops on, naming both refusals.
   */
  refused?: string;
};

/**
 * The loop breaker's memory, on the caller's own record. `mark` fingerprints
 * the run ({@link runMark}); `count` is how many waits in a row were registered
 * over members that were all idle or gone while the mark stood still.
 */
export type Held = { mark: string; count: number };

/** One step in the progress file — id matches the workflow definition's. */
export type ProgressStep = {
  id: string;
  /** Denormalised for convenience; paint prefers definition labels if they differ. */
  label: string;
  status: StepStatus;
  /** Display only; never used for branching. */
  note?: string;
};

/**
 * The progress artifact. `kind` is reserved for later shapes (loop, …); v1
 * writers set `"pipeline"`, and readers that omit it default to pipeline.
 * Unknown kinds stay on disk but observe UI falls back to coarse (Phase 3).
 */
export type Progress = {
  schema: 1;
  /** The key. Same id the filename is built from. */
  sessionId: string;
  workflowId: string;
  /**
   * What the strip calls it, so a following session needs no second file read
   * to say “Following X”. Paint still prefers the live definition, and falls
   * back to `workflowId` if an agent rewrites the file without this.
   */
  label?: string;
  updatedAt: number;
  kind?: string;
  steps: ProgressStep[];
  /**
   * When the reader stopped this run — the one field the panel writes after the
   * seed, and the reason cancel is a stamp rather than an unlink.
   *
   * `forgetProgress` is right where nothing will write the file again (a
   * dismissed arming message, a resumed session id). It is wrong here: the
   * agent is mid-pipeline with {@link progressBriefing} in its context, so its
   * next `squadron-step` call lands at the same path and the run comes back —
   * the flicker `cancelOrphanedArmed` documents, except certain rather than
   * unlikely.
   *
   * A stamp survives that call, because the CLI re-reads the record immediately
   * before writing and refuses on a stamp that appeared while it was deciding
   * (`cli/step.ts` `commit`). Best-effort for a run seeded before that shipped,
   * whose agent still edits by hand: one that rewrites the file whole loses the
   * stamp, and the interrupt beside it is what makes that rare.
   */
  cancelledAt?: number;
  /**
   * When this run was seeded. With `workflowId` it is the run's identity: a
   * re-arm of the same workflow writes a new one, so a command that decided
   * against the old run can tell it is not merging onto the run it read.
   * Absent on a record seeded before it shipped.
   */
  armedAt?: number;
  /**
   * Only a run whose file names a lane, and all optional so a v1 record still
   * reads. The progress schema stays 1. `pid` and `lanes` belong to the
   * anchor; `anchor`, `lane` and `opened` belong to a lane it opened. A record
   * holds only its own lane's steps — the drawer paints a record, and another
   * lane's rows would stay pending for the whole run.
   */
  pid?: number;
  lanes?: Record<string, LaneOpen>;
  anchor?: string;
  /** Absent on the anchor, which holds the armed lane. */
  lane?: string;
  /** A lane's copy of `LaneOpen.openedAt` for the arming that opened it. */
  opened?: number;
  held?: Held;
};

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);

/** Binds `done` alone — a run advanced by hand writes what it likes. */
export const NOTE_MAX = 200;

/** One workflow per session, so the session id is the whole key. */
export function progressPath(sessionId: string): string {
  return path.join(RUNS_DIR, `${sessionId}.progress.json`);
}

/** What a seed needs to know: who, which workflow, and its steps. */
export type ProgressSeed = {
  sessionId: string;
  workflowId: string;
  label: string;
  steps: readonly { id: string; label: string; lane?: string }[];
  /** Supplied by a caller that must stay deterministic — `squadron-step
   *  start`, whose whole plan is decided from values so it can be tested
   *  without a clock. The host seeds have no such need and omit it. */
  now?: number;
  /**
   * The lane this record holds. Absent is the armed lane, which in a file with
   * no named lane is every step; a name seeds that lane. Stored only for a
   * name, so an armed record stays shaped like a progress record from before
   * lanes.
   */
  lane?: string;
  /** The anchor's session id. Set on a lane's record. */
  anchor?: string;
  opened?: number;
  pid?: number;
};

/**
 * Pure seed from a workflow definition — every step `pending`.
 *
 * The panel does not mark step 1 active; the agent is told (via host append) to
 * set `in_progress` before work. Nothing is written here; the caller writes.
 */
export function seedProgress(seed: ProgressSeed): Progress {
  const lane = graph.laneOf(seed);
  const steps = seed.steps.filter((step) => graph.laneOf(step) === lane);
  const now = seed.now ?? Date.now();
  return {
    schema: 1,
    sessionId: seed.sessionId,
    workflowId: seed.workflowId,
    label: seed.label,
    updatedAt: now,
    armedAt: now,
    kind: 'pipeline',
    ...(seed.pid === undefined ? {} : { pid: seed.pid }),
    ...(seed.anchor ? { anchor: seed.anchor } : {}),
    ...(seed.lane ? { lane: seed.lane } : {}),
    ...(seed.opened === undefined ? {} : { opened: seed.opened }),
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      status: 'pending' as const
    }))
  };
}

/** Temp-then-rename, same trap as every other writer under `~/.squadron`. */
export async function writeProgress(progress: Progress): Promise<boolean> {
  return writeAtomicJson(progressPath(progress.sessionId), progress, 'state');
}

/**
 * Progress for a session, or nothing when missing/invalid.
 *
 * Best-effort: one bad file must not throw. Schema equality (not a floor) so a
 * newer writer is ignored rather than half-read. Unknown top-level fields are
 * kept only if they survive JSON parse into our shape — we re-emit known fields.
 */
export async function readProgress(sessionId: string): Promise<Progress | undefined> {
  const raw = await readJson<unknown>(progressPath(sessionId));
  return usable(raw) ? raw : undefined;
}

/**
 * Lane records that name this anchor. The anchor's own file has no `anchor`
 * field, so it is not in the result — the caller already holds that one.
 */
export async function readAnchored(anchorId: string): Promise<Progress[]> {
  return readJsonDir(
    RUNS_DIR,
    (raw) => (usable(raw) && raw.anchor === anchorId ? raw : undefined),
    (name) => name.endsWith('.progress.json')
  );
}

/** The anchor and its siblings, excluding the caller's own record. */
export async function readRunRecords(self: Progress): Promise<Progress[]> {
  const anchorId = self.anchor ?? self.sessionId;
  const anchored = (await readAnchored(anchorId)).filter(
    (record) => record.sessionId !== self.sessionId
  );
  if (!self.anchor) return anchored;
  const anchor = await readProgress(self.anchor);
  return anchor
    ? [anchor, ...anchored.filter((record) => record.sessionId !== anchor.sessionId)]
    : anchored;
}

/**
 * Forget the workflow at this session, if there is one.
 *
 * Two callers, both closing a hole the run record used to cover. A dismissed
 * arming message left an `armed` record `toCancelArmed` retired; there is no
 * status left to cancel, so the file goes. And a **resume** reuses a session id
 * (`host/sessions.ts`), which within the 7-day sweep can land on a file from a
 * workflow nobody armed this time — child exit used to finish those records.
 */
export async function forgetProgress(sessionId: string): Promise<void> {
  await rm(progressPath(sessionId), { force: true });
}

/**
 * Stop the run at this session: stamp {@link Progress.cancelledAt} and leave
 * every step exactly where it stood.
 *
 * The steps are kept deliberately. A cancel is not a step outcome — nothing
 * failed and nothing completed — and rewriting four `pending`s to some fifth
 * status word would be the panel authoring progress, which is the one thing it
 * does not do (§15). What the reader stopped is the run, so that is what is
 * written down.
 *
 * Falls back to a delete when the file is missing or unreadable: there is no
 * shape to stamp, and a run whose record cannot be read is not one anything can
 * go on following. Answers whether the session is free either way.
 */
export async function cancelProgress(sessionId: string, at: number): Promise<boolean> {
  const progress = await readProgress(sessionId);
  if (!progress) {
    await forgetProgress(sessionId);
    return true;
  }
  if (progress.cancelledAt !== undefined) return true;
  return writeProgress({ ...progress, cancelledAt: at });
}

/**
 * What moved under a command since it read `planned`: the reader cancelled the
 * run, or a run was armed again at this session. `workflowId` + `armedAt` is
 * the run's identity, so a re-read record that differs on either is another
 * run, and merging onto it would file one run's progress under another's id.
 */
export function runMoved(
  fresh: Progress,
  planned: Pick<Progress, 'workflowId' | 'armedAt'>
): 'cancelled' | 'workflow' | 'armed' | undefined {
  if (fresh.cancelledAt !== undefined) return 'cancelled';
  if (fresh.workflowId !== planned.workflowId) return 'workflow';
  if (fresh.armedAt !== planned.armedAt) return 'armed';
  return undefined;
}

function laneMapOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const open = entry as Partial<LaneOpen>;
    if (typeof open.openedAt !== 'number') return false;
    if (open.pid !== undefined && typeof open.pid !== 'number') return false;
    if (open.requestId !== undefined && typeof open.requestId !== 'string') return false;
    if (open.fellBack !== undefined && open.fellBack !== true) return false;
    if (open.refused !== undefined && typeof open.refused !== 'string') return false;
  }
  return true;
}

function heldOk(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const held = value as Partial<Held>;
  return typeof held.mark === 'string' && typeof held.count === 'number';
}

function usable(value: unknown): value is Progress {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const p = value as Partial<Progress>;
  if (p.schema !== 1) {
    return false;
  }
  if (typeof p.sessionId !== 'string' || p.sessionId === '') {
    return false;
  }
  if (typeof p.workflowId !== 'string' || p.workflowId === '') {
    return false;
  }
  // `label` is optional on read and never repaired here: a guard that wrote to
  // its own subject would mutate files it goes on to reject. An agent that
  // rewrites the file without it still describes a real workflow, and
  // `followingWorkflow` falls back to `workflowId` for the name.
  if (p.label !== undefined && typeof p.label !== 'string') {
    return false;
  }
  if (p.cancelledAt !== undefined && typeof p.cancelledAt !== 'number') {
    return false;
  }
  if (p.pid !== undefined && typeof p.pid !== 'number') {
    return false;
  }
  if (p.anchor !== undefined && (typeof p.anchor !== 'string' || p.anchor === '')) {
    return false;
  }
  if (p.lane !== undefined && (typeof p.lane !== 'string' || p.lane === '')) {
    return false;
  }
  if (p.lanes !== undefined && !laneMapOk(p.lanes)) {
    return false;
  }
  if (p.armedAt !== undefined && typeof p.armedAt !== 'number') {
    return false;
  }
  if (p.opened !== undefined && typeof p.opened !== 'number') {
    return false;
  }
  if (p.held !== undefined && !heldOk(p.held)) {
    return false;
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    return false;
  }
  for (const step of p.steps) {
    if (!step || typeof step !== 'object') {
      return false;
    }
    const s = step as Partial<ProgressStep>;
    if (typeof s.id !== 'string' || s.id === '') {
      return false;
    }
    if (typeof s.label !== 'string') {
      return false;
    }
    if (typeof s.status !== 'string' || !STATUSES.has(s.status)) {
      return false;
    }
  }
  return true;
}
