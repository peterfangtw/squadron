/** Pure cursor execution and cross-lane readiness; callers write, spawn, and wait. */

import { edgeOf, type LineageEntry } from '../coordination/lineage';
import type { BrandId } from '../model';
import * as commands from '../platform/commands';
import { stepCommand, toolShell } from '../paths';
import * as graph from './graph';
import {
  NOTE_MAX,
  type Progress,
  type ProgressStep,
  type StepStatus,
  type LaneOpen,
  type Held
} from './progress_store';
import { substitute, type Workflow, type Step } from './workflows';

/**
 * The all-idle wait that would be this many in a row over an unchanged run is
 * refused instead. Such a wait resolves within the resolver's debounce, so
 * without a ceiling it is a wake loop that bills a turn each time round.
 */
export const HELD_MAX = 3;

/**
 * A spawned lane younger than this, with a record but no step in progress,
 * still counts as working. A fresh child reads idle for up to about a second
 * after spawn returns (measured 2026-09-30, Claude and Grok); this check has
 * no debounce of its own, so the window is 2s.
 */
export const FRESH_LANE_MS = 2_000;

/**
 * What one `squadron-step next` learned — the whole answer, including the
 * record to write back.
 *
 * `complete` means every step of this record's lane is `completed` — the whole
 * file, when no step names a lane. `waiting`: the next step is this lane's, and
 * a `needs` step elsewhere is not done. The record is settled so a
 * definition edit still lands; the step stays `pending`. Anything else with
 * nothing servable is `blocked`. A union without `blocked` reports
 * `[completed, failed, pending]` as a finished run, which is a lie the agent
 * acts on — and that shape is reachable from any hand edit, since the file was
 * freehand for the whole of Phase 1.
 */
export type ServeResult =
  | {
      outcome: 'served' | 'reprint';
      id: string;
      header: string;
      body: string;
      /** Template names nothing here could fill — reported, never emptied. */
      unresolved: string[];
      progress: Progress;
    }
  | { outcome: 'complete'; progress: Progress }
  | {
      outcome: 'waiting';
      id: string;
      /** Not-completed ancestors. Does not include `id`, and does not walk past a completed step. */
      pending: readonly string[];
      progress: Progress;
    }
  | { outcome: 'blocked'; reason: string };

/** The step to serve, or why there is none. Pure: the caller writes and clocks. */
export function serveNext(
  progress: Progress,
  workflow: Workflow,
  opts: {
    cwd: string;
    now: number;
    /** Statuses this record does not hold. Own rows win on a shared id. */
    others?: readonly { id: string; status: StepStatus }[];
  }
): ServeResult {
  // Same guard `pipelineProgress` applies for display readers. A
  // `loop` record advanced as a pipeline would be driven by the CLI while the
  // drawer painted every row `unknown`.
  if (progress.kind !== undefined && progress.kind !== 'pipeline') {
    return {
      outcome: 'blocked',
      reason: `this run is a ${progress.kind}, which this command does not drive`
    };
  }
  if (progress.cancelledAt !== undefined) {
    return { outcome: 'blocked', reason: 'this run was cancelled from the panel' };
  }
  // Nothing downstream re-checks this, and joining one run's record to another
  // run's definition would write the join back. The CLI's re-read guard names
  // the same invariant; asserted here so it holds for every caller.
  if (progress.workflowId !== workflow.id) {
    return {
      outcome: 'blocked',
      reason: `this run follows ${progress.workflowId}, not ${workflow.id}`
    };
  }
  // `validate` forbids it, but this takes a `Workflow` rather than a
  // `ReadWorkflow`, so nothing in the signature promises it was validated.
  // Without the guard the run reports `complete` vacuously, where `rollup`
  // calls a stepless record `running`.
  if (workflow.steps.length === 0) {
    return { outcome: 'blocked', reason: 'this workflow has no steps' };
  }

  // **The definition is the step list; the record is the status map.** Walking
  // the definition is what makes a mid-run edit land, and rebuilding the rows
  // in its order is what keeps this cursor and `currentStep` — which reads
  // `progress.steps` order — naming the same step after an insert or a reorder.
  // This lane only, which in a file with no named lane is the whole file.
  const defined = workflow.steps.filter((s) => graph.laneOf(s) === graph.laneOf(progress));
  if (defined.length === 0) {
    return { outcome: 'blocked', reason: 'this lane has no steps' };
  }
  const held = new Map(progress.steps.map((s) => [s.id, s]));
  const rows: ProgressStep[] = defined.map(
    (s) => held.get(s.id) ?? { id: s.id, label: s.label, status: 'pending' as const }
  );
  const settled = settle(progress, rows, opts.now);

  // An `in_progress` step the definition no longer has cannot be reprinted:
  // there is no body left to print. Refused rather than skipped, so a workflow
  // edited under a live run does not silently drop the step being worked.
  const known = new Set(defined.map((s) => s.id));
  const orphan = progress.steps.find((s) => s.status === 'in_progress' && !known.has(s.id));
  if (orphan) {
    return {
      outcome: 'blocked',
      reason: `${orphan.id} is in progress but is no longer in this workflow`
    };
  }

  const current = rows.find((s) => s.status === 'in_progress');
  if (current) {
    return served('reprint', current.id, workflow, settled, opts.cwd, defined);
  }

  // First-not-completed **is** the predecessors-all-completed rule, which is
  // why nothing scans backwards: every row before this one is `completed` by
  // construction, or the find would have stopped there. The cursor is that
  // cursor — a lane is one chain — and then asks whether the step's `needs`
  // are done.
  // Carries `settled` because this outcome can still owe a write: deleting the
  // *last* step mid-run makes the run complete and leaves a `pending` row for a
  // step that is gone, which `rollup` and `stepTally` go on counting against a
  // CLI that has already said the run finished.
  const stuck = rows.find((s) => s.status !== 'completed');
  if (!stuck) {
    return { outcome: 'complete', progress: settled };
  }
  if (stuck.status !== 'pending') {
    return { outcome: 'blocked', reason: `${stuck.id} is ${stuck.status}` };
  }
  const statusOf = statusOfRows(rows, opts.others ?? []);
  const step = workflow.steps.find((s) => s.id === stuck.id);
  if (step && !stepReady(workflow, step, statusOf)) {
    return {
      outcome: 'waiting',
      id: stuck.id,
      pending: pendingAncestors(workflow, step, statusOf),
      progress: settled
    };
  }
  const marked = rows.map((s) =>
    s.id === stuck.id ? { ...s, status: 'in_progress' as const } : s
  );
  return served(
    'served',
    stuck.id,
    workflow,
    { ...progress, steps: marked, updatedAt: opts.now },
    opts.cwd,
    defined
  );
}

function served(
  outcome: 'served' | 'reprint',
  id: string,
  workflow: Workflow,
  progress: Progress,
  cwd: string,
  lane: readonly { id: string; label: string }[]
): ServeResult {
  const step = workflow.steps.find((s) => s.id === id);
  const { body, unresolved } = stepBody(step, workflow, cwd);
  // A real header over an empty body is the failure `substitute` refuses to
  // create for an unresolved reference: it reads as a finished instruction.
  // Same unvalidated-input guard as the two in `serveNext`, and it covers the
  // otherwise silent missing-step case with it.
  if (body === '') {
    return {
      outcome: 'blocked',
      reason: `${id} has no instruction to give — it declares neither a prompt nor a skill`
    };
  }
  return {
    outcome,
    id,
    header: stepHeader(lane, id, outcome === 'reprint'),
    body,
    unresolved,
    progress
  };
}

/**
 * Where the reader is, counted **in the definition** — this record's lane of
 * it, which in a file with no named lane is every step.
 *
 * Counting the record instead would disagree with the drawer the moment the
 * workflow is edited, since a row is added for a step the record never had.
 * Retrospective by construction: it names where the run has got to and never
 * the *content* of a step that has not been served. `of M` does tell the agent
 * how many are left — the middle ground §3 chose deliberately, steps countable
 * and bodies withheld, rather than nothing at all.
 */
export function stepHeader(
  steps: readonly { id: string; label: string }[],
  id: string,
  repeat: boolean
): string {
  const index = steps.findIndex((s) => s.id === id);
  const label = steps[index]?.label ?? id;
  const head = `Step ${index + 1} of ${steps.length} · "${label}"`;
  return repeat ? `${head} — you already have this one.` : head;
}

/**
 * The instruction itself.
 *
 * A `uses` step is served as prose rather than as the bare slash name: the
 * comment on {@link Step.uses} is about a name arriving as a *user frame*,
 * which the CLI expands. Nothing expands one on stdout, so a lone `/implement`
 * would be a string the agent has to guess the intent of.
 */
function stepBody(
  step: Step | undefined,
  workflow: Workflow,
  cwd: string
): { body: string; unresolved: string[] } {
  if (!step) {
    return { body: '', unresolved: [] };
  }
  if (step.uses !== undefined) {
    return { body: `Run the ${step.uses} command.`, unresolved: [] };
  }
  // Only steps *before* this one, which is the rule `validate` already enforces
  // when it refuses a prompt reading a later step's output.
  const vars: Record<string, string | undefined> = { cwd };
  for (const earlier of workflow.steps) {
    if (earlier.id === step.id) break;
    if (earlier.output !== undefined) {
      vars[`step.${earlier.id}.output`] = earlier.output;
    }
  }
  const { text, unresolved } = substitute(step.prompt ?? '', vars);
  return { body: text, unresolved };
}

/**
 * Bump the clock only when the rows actually moved — a reprint is not news.
 *
 * The `JSON.stringify` comparison is safe **here specifically** because an
 * unchanged row is the same object reference: `rows` reuses what the parsed
 * file gave, so key order comes from that file rather than from reconstruction.
 * A caller that rebuilt rows field by field would break this without touching
 * it, which is why the guarantee is written down rather than left local.
 */
function settle(progress: Progress, rows: ProgressStep[], now: number): Progress {
  const same = JSON.stringify(progress.steps) === JSON.stringify(rows);
  return same ? progress : { ...progress, steps: rows, updatedAt: now };
}

/** What one `squadron-step done` did, or why it did nothing. */
export type CompleteResult =
  { outcome: 'completed'; id: string; progress: Progress } | { outcome: 'blocked'; reason: string };

/**
 * Close the step in flight.
 *
 * **The first `in_progress`**, matching {@link currentStep} — a hand-edited
 * file can hold two, and picking differently would let this cursor and the
 * rail's `current` name different steps on one record.
 *
 * Takes no definition on purpose: a run whose workflow file was deleted or
 * edited invalid mid-flight can still record the step it just finished.
 */
export function completeCurrent(
  progress: Progress,
  opts: { note?: string; now: number }
): CompleteResult {
  // The same guard `serveNext` applies, and for the same reason: `kind` is on
  // the record rather than the definition, so without it `done` mutates a later
  // shape's run that `next` would have refused to touch.
  if (progress.kind !== undefined && progress.kind !== 'pipeline') {
    return {
      outcome: 'blocked',
      reason: `this run is a ${progress.kind}, which this command does not drive`
    };
  }
  if (progress.cancelledAt !== undefined) {
    return { outcome: 'blocked', reason: 'this run was cancelled from the panel' };
  }
  const current = progress.steps.find((s) => s.status === 'in_progress');
  if (!current) {
    return { outcome: 'blocked', reason: 'no step is in progress — run `next` first' };
  }
  const note = opts.note?.trim();
  if (note !== undefined && note.length > NOTE_MAX) {
    // Refused, not sliced: a cut puts the half-sentence beyond every reader's reach.
    return {
      outcome: 'blocked',
      reason: `that note is ${note.length} characters and the limit is ${NOTE_MAX} — call \`done\` again with a shorter one. The step is still in progress.`
    };
  }
  const steps = progress.steps.map((s) =>
    s.id === current.id ? { ...s, status: 'completed' as const, ...(note ? { note } : {}) } : s
  );
  return {
    outcome: 'completed',
    id: current.id,
    progress: { ...progress, steps, updatedAt: opts.now }
  };
}

/** Which lanes to open, who to wait on, or why there is nothing to wait for. */
export type Readiness = {
  openLanes: readonly string[];
  waitPids: readonly number[];
  /** One per wait pid, in the same order. Absent when there is no wait. */
  waitOn?: readonly WaitTarget[];
  stall?: string;
  /** A terminal startup refusal cannot be recovered by a coordinator fallback wake. */
  refused?: true;
};

/** A session on the board, as far as a wait needs one. */
export type Member = {
  pid: number;
  /** Absent is Claude: which shell a command addressed to it is written for. */
  brand?: BrandId;
  sessionId?: string;
  /** When its process started, which is what ties a pid to one spawn in `lineage/`. */
  startedAt?: number;
  idle: boolean;
};

/** What `lineage/` says about one spawn: the request that asked for it, and when. */
export type SpawnEdge = Pick<LineageEntry, 'requestId' | 'spawnedAt'>;

/**
 * One session a wait is over. `idle` is idle **or gone** — the two a wait
 * resolves over at once, which is what the loop breaker counts.
 */
export type WaitTarget = {
  pid: number;
  who: string;
  holds: readonly string[];
  idle: boolean;
  brand?: BrandId;
};

/**
 * Which lanes an anchor should open, who a blocked step waits on, or a stall.
 *
 * Pure, like {@link serveNext}: the caller spawns and registers. A run whose
 * file names no lane returns nothing here — `decideNext` never asks for one — and
 * neither does a cancelled one. A lane record never opens a lane. The wait is
 * the sessions holding a step among the blocked step's not-completed ancestors
 * that is `in_progress` **or ready** — a ready step is served the next time its
 * holder runs `next`, so the holder is who to wait on — plus an opened lane
 * with no record yet. A lane younger than {@link FRESH_LANE_MS} whose record
 * has no step in progress counts as working too. An idle member whose step is
 * `in_progress` is a stall — a wait over it resolves at once.
 *
 * `others` must already be this arming's records ({@link runRecords}).
 * `members` is the board; absent means none was read, and stored pids stand in.
 */
export function readiness(input: {
  workflow: Workflow;
  self: Progress;
  others?: readonly Progress[];
  opened?: Readonly<Record<string, LaneOpen>>;
  members?: readonly Member[];
  /** `lineage/`, read when a lane has no record yet; see `waitTargets`. */
  lineage?: ReadonlyMap<number, SpawnEdge>;
  now: number;
}): Readiness {
  const open: Readiness = { openLanes: [], waitPids: [] };
  if (!graph.hasLanes(input.workflow.steps)) return open;
  if (input.self.cancelledAt !== undefined) return open;

  const others = input.others ?? [];
  const opened = input.opened ?? {};
  const records = [input.self, ...others];
  const statusOf = statusFrom(records, input.workflow);
  const openLanes = input.self.lane ? [] : lanesToOpen(input.workflow, opened, statusOf);

  const defined = input.workflow.steps.filter((s) => graph.laneOf(s) === graph.laneOf(input.self));
  const held = new Map(input.self.steps.map((s) => [s.id, s.status]));
  const stuck = defined.find((s) => (held.get(s.id) ?? 'pending') !== 'completed');
  const stuckStatus = stuck ? (held.get(stuck.id) ?? 'pending') : undefined;
  // Own steps done, and a lane still not open: the anchor is not finished
  // until every lane is in `lanes`, so that lane's first step is what it waits
  // on. A step that is ready is already in `openLanes` and is not a wait.
  const heldOpen =
    !stuck && !input.self.lane
      ? unopenedBlocked(input.workflow, opened, openLanes, statusOf)
      : undefined;
  if (
    !heldOpen &&
    (!stuck || stuckStatus !== 'pending' || stepReady(input.workflow, stuck, statusOf))
  ) {
    return { openLanes, waitPids: [] };
  }
  const blocking = heldOpen ?? stuck;
  if (!blocking) return { openLanes, waitPids: [] };

  const pending = pendingAncestors(input.workflow, blocking, statusOf);
  const refused = pending
    .map((id) => opened[laneOfId(input.workflow, id)]?.refused)
    .find((reason) => reason !== undefined);
  if (refused !== undefined) {
    return { openLanes, waitPids: [], stall: refused, refused: true };
  }
  const cancelled = records.find(
    (record) =>
      record.cancelledAt !== undefined &&
      pending.some((id) => laneOfId(input.workflow, id) === graph.laneOf(record))
  );
  if (cancelled) {
    return {
      openLanes,
      waitPids: [],
      stall: `${laneWord(graph.laneOf(cancelled))} was cancelled before its required steps completed`
    };
  }
  const members = input.members;
  const gone: string[] = [];
  const targets = waitTargets(
    pending,
    input.workflow,
    laneRecords(records),
    opened,
    statusOf,
    {
      members,
      now: input.now,
      lineage: input.lineage,
      anchor: input.self.lane
        ? records.find((record) => record.sessionId === input.self.anchor && !record.lane)
        : undefined
    },
    gone
  );
  if (gone.length > 0) return { openLanes, waitPids: [], stall: gone.join('; ') };
  const idle = idleAmong(targets, members);
  if (idle) return { openLanes, waitPids: [], stall: idle };
  const covered = openLanes.some((lane) =>
    pending.some((id) => laneOfId(input.workflow, id) === lane)
  );
  if (targets.length === 0) {
    if (covered) return { openLanes, waitPids: [] };
    return {
      openLanes,
      waitPids: [],
      stall: `${laneWord(graph.laneOf(input.self))} is blocked at ${blocking.id}, and nothing is in progress`
    };
  }
  return {
    openLanes,
    waitPids: targets.map((target) => target.pid),
    waitOn: targets.map(({ pid, who, holds, idle }) => ({ pid, who, holds, idle }))
  };
}

/**
 * The records that belong to one arming of an anchor: the anchor's own, and
 * each lane record whose `opened` is the token the anchor holds for that lane.
 *
 * Re-arming writes the anchor afresh with no `lanes`, so every record an
 * earlier arming's lanes wrote stops counting without being touched — one
 * writer per file still holds, and a stale lane's `completed` cannot satisfy
 * this run's `needs`.
 */
export function runRecords(anchor: Progress, records: readonly Progress[]): Progress[] {
  return records.filter(
    (record) => record.sessionId === anchor.sessionId || armingMiss(anchor, record) === undefined
  );
}

/**
 * Why a lane is not part of the arming its anchor is on now, or `undefined`
 * when it is. `opened` is the proof: the token the anchor wrote for that lane
 * before the spawn, carried by the lane's own record or `start --opened`.
 */
export function armingMiss(
  anchor: Progress,
  lane: Pick<Progress, 'workflowId' | 'lane' | 'opened'>
): 'cancelled' | 'workflow' | 'opened' | undefined {
  if (anchor.cancelledAt !== undefined) return 'cancelled';
  if (anchor.workflowId !== lane.workflowId) return 'workflow';
  if (
    lane.lane === undefined ||
    lane.opened === undefined ||
    anchor.lanes?.[lane.lane]?.openedAt !== lane.opened
  ) {
    return 'opened';
  }
  return undefined;
}

/**
 * What the loop breaker compares between two waits: every step status across
 * the run, which lanes the anchor has opened and whether each has a pid, and
 * which lanes have a record. A lane opening, starting or moving a step is
 * progress, so each of those changes the mark.
 */
export function runMark(
  records: readonly Progress[],
  opened: Readonly<Record<string, LaneOpen>>
): string {
  const rows = records
    .flatMap((record) => record.steps.map((s) => `${graph.laneOf(record)}/${s.id}=${s.status}`))
    .sort();
  const lanes = Object.entries(opened)
    .map(([name, entry]) => `${name}:${entry.pid ?? ''}`)
    .sort();
  const recorded = records.map((record) => graph.laneOf(record)).sort();
  return JSON.stringify([rows, lanes, recorded]);
}

/**
 * The loop breaker, applied to one wait about to be registered.
 *
 * Only a wait whose every member is idle or gone counts: it resolves within the
 * resolver's debounce, the waiter wakes, nothing moved, and it waits again. A
 * wait with a busy member resolves only once that member did something, however
 * long that takes, so it resets the count — which is what keeps a handoff, a
 * lane asking the reader questions, and a step outliving several deadlines from
 * tripping it. The refusal writes nothing, so a retried `next` meets it again
 * until the mark moves.
 *
 * A heuristic: a handoff can still trip it if one side cycles {@link HELD_MAX}
 * times before the other's wake lands, and a member busy past a wait's deadline
 * is a slow loop it never counts. `TASK_*_workflow_v2_review_fixes.md` records
 * why both were accepted.
 */
export function holdAfter(
  held: Held | undefined,
  mark: string,
  allIdle: boolean
): { refuse: true } | { refuse: false; held?: Held } {
  if (!allIdle) return { refuse: false };
  const count = held?.mark === mark ? held.count + 1 : 1;
  return count >= HELD_MAX ? { refuse: true } : { refuse: false, held: { mark, count } };
}

/** The refusal {@link holdAfter} leads to, naming who is waited on and what each holds. */
export function heldReason(targets: readonly WaitTarget[], shell: commands.Shell): string {
  const who = targets
    .map((target) =>
      target.holds.length === 0
        ? `${target.who} (pid ${target.pid}) has not started its lane`
        : `${target.who} (pid ${target.pid}) holds ${target.holds.join(', ')}`
    )
    .join('; ');
  return (
    `woken ${HELD_MAX} times with nothing in this run moving, so this wait would loop: ${who}. ` +
    `Ask the reader to have that session run ${theirNext(targets, shell)}, then run \`${stepCommand(shell, 'next')}\` here again.`
  );
}

/** One command when every target runs the same shell; otherwise one per shell, named. */
function theirNext(targets: readonly WaitTarget[], caller: commands.Shell): string {
  const shells = [...new Set(targets.map((target) => toolShell(target.brand)))];
  const [only = caller] = shells;
  if (shells.length <= 1) return `\`${stepCommand(only, 'next')}\``;
  return shells
    .map((shell) => `\`${stepCommand(shell, 'next')}\` (${commands.SHELL_NAMES[shell]})`)
    .join(' or ');
}

/** Every resolvable `needs` is done. A step with none is a root. */
function stepReady(
  workflow: Workflow,
  step: Step,
  statusOf: (id: string) => StepStatus | undefined
): boolean {
  return (graph.needsOf(workflow.steps).get(step.id) ?? []).every(
    (id) => statusOf(id) === 'completed'
  );
}

function pendingAncestors(
  workflow: Workflow,
  step: Step,
  statusOf: (id: string) => StepStatus | undefined
): string[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const current = byId.get(id);
    if (!current) return;
    for (const need of (current.needs ?? []).filter((n) => byId.has(n))) {
      if (seen.has(need)) continue;
      seen.add(need);
      if (statusOf(need) === 'completed') continue;
      visit(need);
    }
  };
  visit(step.id);
  return workflow.steps
    .map((s) => s.id)
    .filter((id) => seen.has(id) && statusOf(id) !== 'completed');
}

function statusOfRows(
  rows: readonly ProgressStep[],
  others: readonly { id: string; status: StepStatus }[]
): (id: string) => StepStatus | undefined {
  const own = new Map(rows.map((s) => [s.id, s.status]));
  const rest = new Map<string, StepStatus>();
  for (const other of others) if (!rest.has(other.id)) rest.set(other.id, other.status);
  return (id) => own.get(id) ?? rest.get(id);
}

function statusFrom(
  records: readonly Progress[],
  workflow: Workflow
): (id: string) => StepStatus | undefined {
  const byLane = laneRecords(records);
  const lanes = new Map(workflow.steps.map((s) => [s.id, graph.laneOf(s)]));
  return (id) => {
    const lane = lanes.get(id);
    if (lane === undefined) return undefined;
    return byLane.get(lane)?.steps.find((s) => s.id === id)?.status;
  };
}

function laneRecords(records: readonly Progress[]): Map<string, Progress> {
  const byLane = new Map<string, Progress>();
  for (const record of records) {
    const lane = graph.laneOf(record);
    if (!byLane.has(lane)) byLane.set(lane, record);
  }
  return byLane;
}

function unopenedBlocked(
  workflow: Workflow,
  opened: Readonly<Record<string, LaneOpen>>,
  openLanes: readonly string[],
  statusOf: (id: string) => StepStatus | undefined
): Step | undefined {
  const opening = new Set(openLanes);
  for (const lane of new Set(workflow.steps.map(graph.laneOf))) {
    const step = graph.opener(workflow.steps, lane);
    if (!step || Object.hasOwn(opened, lane) || opening.has(lane)) continue;
    if (!stepReady(workflow, step, statusOf)) return step;
  }
  return undefined;
}

function lanesToOpen(
  workflow: Workflow,
  opened: Readonly<Record<string, LaneOpen>>,
  statusOf: (id: string) => StepStatus | undefined
): string[] {
  const out: string[] = [];
  for (const lane of new Set(workflow.steps.map(graph.laneOf))) {
    const step = graph.opener(workflow.steps, lane);
    if (!step || Object.hasOwn(opened, lane)) continue;
    if (stepReady(workflow, step, statusOf)) out.push(lane);
  }
  return out;
}

/** A wait target before it is trimmed for the wire: the record it came from, if any. */
type Target = WaitTarget & { working?: string };

function waitTargets(
  pending: readonly string[],
  workflow: Workflow,
  byLane: ReadonlyMap<string, Progress>,
  opened: Readonly<Record<string, LaneOpen>>,
  statusOf: (id: string) => StepStatus | undefined,
  board: {
    members: readonly Member[] | undefined;
    now: number;
    lineage: ReadonlyMap<number, SpawnEdge> | undefined;
    anchor: Progress | undefined;
  },
  gone: string[]
): Target[] {
  const targets: Target[] = [];
  const add = (target: Omit<Target, 'idle'>) => {
    if (targets.some((t) => t.pid === target.pid)) return;
    // Not on the board is gone, and a wait over a gone member resolves at once
    // exactly as one over an idle member does.
    const idle = !(board.members ?? []).some((m) => m.pid === target.pid && !m.idle);
    const brand = board.members?.find((m) => m.pid === target.pid)?.brand;
    targets.push({ ...target, idle, ...(brand ? { brand } : {}) });
  };
  for (const lane of new Set(pending.map((id) => laneOfId(workflow, id)))) {
    const mine = pending.filter((pid) => laneOfId(workflow, pid) === lane);
    const record = byLane.get(lane);
    if (!record) {
      const pid = lane === '' ? undefined : opened[lane]?.pid;
      if (pid === undefined) {
        const first = graph.opener(workflow.steps, lane);
        const claimed = Object.hasOwn(opened, lane);
        if (!board.anchor || !first || (!claimed && !stepReady(workflow, first, statusOf))) {
          continue;
        }
        // A claim is written before the host replies. Session identity, not
        // the coordinator's stored PID, keeps that opening responsibility live.
        const coordinator = board.members?.find(
          (member) => member.sessionId === board.anchor?.sessionId
        );
        if (!coordinator) {
          gone.push(`the coordinator responsible for opening ${lane} is no longer running`);
          continue;
        }
        add({ pid: coordinator.pid, who: `the coordinator opening ${lane}`, holds: [] });
        continue;
      }
      // No record means no session id to ask the board by, so the stored pid
      // is all there is. The window named it seconds ago while the lane is
      // fresh; after that the process at that pid must be the very spawn that
      // opened this lane — its `lineage/` entry carries this open's
      // `requestId`, and it started when that entry says. The anchor's id is
      // not enough: another child of the same anchor could hold the pid.
      const member = board.members?.find((m) => m.pid === pid);
      const edge =
        member && board.lineage
          ? edgeOf(board.lineage, { pid, startedAt: member.startedAt ?? NaN })
          : undefined;
      const ours =
        !board.members ||
        freshLane(lane, opened, board.now) ||
        (edge !== undefined && edge.requestId === opened[lane]?.requestId);
      if (ours) add({ pid, who: lane, holds: [] });
      else gone.push(`${lane} was opened as pid ${pid}, and that pid is no longer its session`);
      continue;
    }
    const working = mine.find((step) => statusOf(step) === 'in_progress');
    const ready = mine.filter((step) => {
      const def = workflow.steps.find((s) => s.id === step);
      return (
        statusOf(step) === 'pending' && def !== undefined && stepReady(workflow, def, statusOf)
      );
    });
    const holds = working !== undefined ? [working, ...ready] : ready;
    const quiet = !record.steps.some((s) => s.status === 'in_progress');
    if (holds.length === 0 && !(quiet && freshLane(lane, opened, board.now))) continue;
    const pid = livePid(record, lane, opened, board.members);
    if (pid === undefined) {
      gone.push(
        `${laneWord(lane)} holds ${holds.join(', ') || 'its lane'} and is no longer running`
      );
      continue;
    }
    add({ pid, who: laneWord(lane), holds, ...(working ? { working } : {}) });
  }
  return targets;
}

/**
 * The pid the board has **now** for a record's session, or none: a session with
 * a record that the board does not show is gone. An IDE restart moves every pid
 * (observed 2026-09-30), so a stored one is a dead process — or, once reused, a
 * stranger whose work would hold the wait open. Stored pids are read only with
 * no board at all, which is a caller that refuses before it waits.
 */
function livePid(
  record: Progress,
  lane: string,
  opened: Readonly<Record<string, LaneOpen>>,
  members: readonly Member[] | undefined
): number | undefined {
  if (members) return members.find((m) => m.sessionId === record.sessionId)?.pid;
  return lane === '' ? record.pid : opened[lane]?.pid;
}

function freshLane(lane: string, opened: Readonly<Record<string, LaneOpen>>, now: number): boolean {
  const at = opened[lane]?.openedAt;
  return at !== undefined && now - at < FRESH_LANE_MS;
}

function idleAmong(
  targets: readonly Target[],
  members: readonly Member[] | undefined
): string | undefined {
  for (const target of targets) {
    if (target.working === undefined) continue;
    if (!(members ?? []).some((m) => m.pid === target.pid && m.idle)) continue;
    return `${target.who} is idle with ${target.working} still in progress — ask it to finish and run \`${stepCommand(toolShell(target.brand), 'done')}\``;
  }
  return undefined;
}

function laneOfId(workflow: Workflow, id: string): string {
  return graph.laneOf(workflow.steps.find((s) => s.id === id) ?? {});
}

function laneWord(lane: string): string {
  return lane === '' ? 'the armed session' : lane;
}

/**
 * Lanes opened past {@link FRESH_LANE_MS} that never wrote a record, and whose
 * session is idle or gone.
 *
 * Checked for every opened lane, not only one a step is waiting on: a lane
 * nothing needs would otherwise never fall back. `members` absent means the
 * board was not read, and this answers nothing rather than treating every pid
 * as gone. A member that is still busy is not named — a bad model can stay
 * busy past this window (Codex, probed 2026-09-30). Gone has no pid: there is
 * no child to end. An idle child is named only when `lineage` proves the pid
 * is still this open's, the same proof `waitTargets` uses, and two missing
 * request ids do not count as that proof.
 */
export function unstarted(input: {
  opened: Readonly<Record<string, LaneOpen>>;
  records: readonly { lane?: string }[];
  members: readonly Member[] | undefined;
  now: number;
  /** `requestId` may be absent: two missing ids are not proof the pid is this open. */
  lineage: ReadonlyMap<number, { requestId?: string; spawnedAt: number }> | undefined;
}): { lane: string; fellBack: boolean; pid?: number }[] {
  if (input.members === undefined) return [];
  const recorded = new Set(input.records.flatMap((record) => (record.lane ? [record.lane] : [])));
  const out: { lane: string; fellBack: boolean; pid?: number }[] = [];
  for (const [lane, open] of Object.entries(input.opened)) {
    if (recorded.has(lane) || open.pid === undefined) continue;
    if (input.now - open.openedAt < FRESH_LANE_MS) continue;
    const member = input.members.find((candidate) => candidate.pid === open.pid);
    const fellBack = open.fellBack === true;
    if (!member) {
      out.push({ lane, fellBack });
      continue;
    }
    if (!member.idle) continue;
    const edge = input.lineage
      ? edgeOf(input.lineage, { pid: open.pid, startedAt: member.startedAt ?? NaN })
      : undefined;
    if (edge?.requestId === undefined || edge.requestId !== open.requestId) continue;
    out.push({ lane, fellBack, pid: open.pid });
  }
  return out;
}
