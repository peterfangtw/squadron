/** Progress projected into the card tally, live chip, and observe rail. */

import { ackFile } from '../acks';
// The seam, for `workflowDates` alone. It is the whole of the brand registry,
// so `cli/step.ts` — which imports the public progress API — bundles it
// anyway: 23 KB → 318 KB, and 24.8 ms → 29.3 ms per run (measured 2026-09-08,
// ten runs each), which is a step pull's frequency rather than a poll's.
//
// Paid so that `workflowDates`' one caller does not have to know which of the
// three marks is the brand's. Not because the *rule* would otherwise leave
// `core/` — `workflowCompletion` and `speaks` are pure either way, and passing
// a `promptAt` in would keep the progress API brand-free and that bundle at 23 KB.
// That trade is live if a verb here ever gets hot.
import { adapterFor } from '../adapter';
import { speaks } from '../checklist';
import { writtenAt } from '../files';
import type { Session } from '../model';
import * as graph from './graph';
import { progressPath, type Progress, type ProgressStep } from './progress_store';

/** Recomputed on read — never a stored field the agent must maintain. */
export type ProgressRollup = 'running' | 'done' | 'failed';

/**
 * Run-level status from step statuses alone.
 *
 * - any `failed` and none `in_progress` → failed
 * - every step `completed` → done
 * - else running (includes all-pending, and failed while something is still working)
 */
export function rollup(progress: Progress): ProgressRollup {
  const steps = progress.steps;
  if (steps.length === 0) {
    return 'running';
  }
  const anyInProgress = steps.some((s) => s.status === 'in_progress');
  const anyFailed = steps.some((s) => s.status === 'failed');
  if (anyFailed && !anyInProgress) {
    return 'failed';
  }
  if (steps.every((s) => s.status === 'completed')) {
    return 'done';
  }
  return 'running';
}

/**
 * The step the strip should name, if any.
 *
 * Sequential v1: first `in_progress` in snapshot order, else first `pending`.
 * When every step is terminal (`completed` | `failed`), there is no working
 * current — paint uses rollup tone alone. Prefer {@link stepMarker} for the
 * lean strip: it composes this with rollup so a failed pipeline does not name
 * a later still-pending step.
 */
export function currentStep(progress: Progress): ProgressStep | undefined {
  const working = progress.steps.find((s) => s.status === 'in_progress');
  if (working) return working;
  const pending = progress.steps.find((s) => s.status === 'pending');
  if (pending) return pending;
  return undefined;
}

/** Tone the lean strip paints next to a step label (or alone for done/failed). */
export type StepMarkerTone = 'working' | 'done' | 'failed';

/**
 * Thin paint input for the Phase B strip — label + tone, or nothing for coarse.
 *
 * - unknown `kind` (not pipeline / omitted) → `undefined` (coarse only)
 * - all `pending` → `undefined` (coarse “following X” only)
 * - rollup `done` → last completed step, tone `done`
 * - rollup `failed` → first failed step, tone `failed` (not a later pending)
 * - else → {@link currentStep}, tone `working`
 *
 * Labels prefer the run snapshot when `snapshot` is given (PRD: paint prefers
 * snapshot labels if the freehand file disagrees).
 */
/** Lean strip paint input — `id` is the same cursor the observe rail marks current. */
export type StepMarker = { id: string; label: string; tone: StepMarkerTone };

export function stepMarker(
  progress: Progress,
  snapshot?: readonly { id: string; label: string }[]
): StepMarker | undefined {
  // Omitted kind defaults to pipeline; any other kind is a later shape → coarse.
  if (progress.kind !== undefined && progress.kind !== 'pipeline') {
    return undefined;
  }
  if (progress.steps.length === 0) {
    return undefined;
  }
  if (progress.steps.every((s) => s.status === 'pending')) {
    return undefined;
  }

  const labelOf = (step: ProgressStep): string =>
    snapshot?.find((s) => s.id === step.id)?.label ?? step.label;

  const status = rollup(progress);
  if (status === 'done') {
    const last = [...progress.steps].reverse().find((s) => s.status === 'completed');
    return last ? { id: last.id, label: labelOf(last), tone: 'done' } : undefined;
  }
  if (status === 'failed') {
    const failed = progress.steps.find((s) => s.status === 'failed');
    return failed ? { id: failed.id, label: labelOf(failed), tone: 'failed' } : undefined;
  }

  const step = currentStep(progress);
  return step ? { id: step.id, label: labelOf(step), tone: 'working' } : undefined;
}

/** One rail row on the wire — observe only; panel never advances from this. */
export type ObserveStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown';

export type ObserveStep = {
  id: string;
  label: string;
  status: ObserveStepStatus;
  note?: string;
  /** At most one; false/absent when all-pending or progress unusable. */
  current?: boolean;
};

/**
 * A pipeline in the shape a card's step list speaks — or nothing.
 *
 * The card's `done` has one author today, the CLI's own checklist
 * (`core/checklist.ts`), and a session driven through a workflow need never
 * write one: it works the workflow's steps instead, and its card says `idle`
 * however far the pipeline got. This is that same statement in the same shape,
 * so nothing downstream learns a second word.
 *
 * **A partial pipeline counts, where it used to say nothing.** The old rule was
 * written for a run the panel advanced: an idle session between steps was the
 * panel's own pause and not news. Under session-owned execution the agent
 * advances its own steps, so idle with steps left is work sitting still — which
 * is the reading `stalled` was built for (`core/checklist.ts`). A `failed`
 * rollup counts the same way: orange and a count is honest about steps left,
 * and a fifth status word is a separate decision.
 *
 * All-pending still says nothing: a seeded file nobody has touched cannot
 * distinguish "the agent did nothing" from "the agent never wrote the file".
 * Unknown `kind` says nothing for the reason every other reader here skips it —
 * a later shape is not ours to summarise.
 */
export function stepTally(
  progress: Progress | undefined
): { total: number; completed: number } | undefined {
  if (progress?.cancelledAt !== undefined) return undefined;
  const usable = pipelineProgress(progress);
  if (!usable || usable.steps.length === 0) return undefined;
  if (usable.steps.every((s) => s.status === 'pending')) return undefined;
  return {
    total: usable.steps.length,
    completed: usable.steps.filter((s) => s.status === 'completed').length
  };
}

/**
 * The tally a card should actually paint, dated against the same two marks the
 * CLI's own list is — or nothing.
 *
 * Lives here rather than in `host/panel.ts` so the composition is testable at
 * all: the panel is `vscode`-bound, and this is the whole of what the board
 * learns from a workflow.
 *
 * The prompt rule is `speaks`' unchanged — a file older than the last thing
 * somebody said to the session is about work it has moved past.
 *
 * **The ack rule deliberately diverges.** `speaks` retires a list only once
 * `completed >= total` (`checklist.ts:165`), because the CLI's own list is
 * rewritten by a session still working and its `stalled` is therefore
 * transient. A workflow progress file is written by an agent that has
 * **stopped**, and nothing will ever move it to done — so an abandoned run, a
 * `failed` rollup, or an agent that marked step 1 and wandered off would sit
 * orange and unclickable until prune, on a dead session too (an exited session
 * reads `idle`). So a workflow tally retires on the ack whether or not it
 * finished, and one click clears an abandoned run.
 */
/**
 * The three marks a workflow tally is dated against.
 *
 * The prompt is the brand's to answer — `CliAdapter.lastPromptAt` — and is the
 * only thing here a CLI knows: the ack and the file are both ours. This used to
 * scan Claude's `"type":"user"` jsonl whatever brand the card was, so a Grok or
 * Codex follow had no `promptAt` at all and its tally never retired via
 * `speaks`.
 *
 * Not `checklist.listDates`: that one reads the ack lazily, because a list
 * still short of done never retires and the `stat` would be wasted. A partial
 * workflow tally *does* retire (see {@link workflowCompletion}), so the ack is
 * read for every following session — one `stat` on the sessions that have a
 * usable tally at all.
 */
export async function workflowDates(
  session: Session
): Promise<{ promptAt?: number; ackAt?: number; writtenAt?: number }> {
  const sessionId = session.sessionId ?? '';
  return {
    promptAt: await adapterFor(session)?.lastPromptAt?.(session),
    ackAt: await writtenAt(ackFile(sessionId)),
    writtenAt: await writtenAt(progressPath(sessionId))
  };
}

export function workflowCompletion(
  progress: Progress | undefined,
  dated: { promptAt?: number; ackAt?: number; writtenAt?: number } = {}
): { total: number; completed: number } | undefined {
  if (!progress) return undefined;
  const tally = stepTally(progress);
  if (!tally) return undefined;
  // **The clock is the file's mtime, not its `updatedAt`.** `updatedAt` is
  // stamped by the seed, which happens *before* the arming message is written
  // to the transcript — so a run whose agent edits the file in place, as one
  // seeded before `squadron-step` shipped still does, is permanently older
  // than the prompt that started it and `speaks` would silence every tally this
  // feature exists to show. An mtime is what a writer cannot forget to set,
  // which is true of the hand and of the CLI alike.
  const list = { ...tally, newestAt: dated.writtenAt ?? progress.updatedAt };
  if (!speaks(list, { promptAt: dated.promptAt })) return undefined;
  if (dated.ackAt !== undefined && list.newestAt <= dated.ackAt) return undefined;
  return tally;
}

/**
 * What the composer live chip and observe drawer need for the workflow a
 * session is following — or nothing, which is most sessions.
 *
 * - `label` always (coarse “Following X”), from the file.
 * - `phase` always — {@link rollup} of the file, so paint maps a class and
 *   does not reconstruct running | done | failed from `steps`.
 * - `step` only when progress is readable and not all-pending (lean chip).
 * - `steps` from the **live definition**'s order/labels where one is given;
 *   status/note/current from progress. Unknown `kind` → unknown statuses, no
 *   current, no strip step. Extra progress ids ignored; definition ids missing
 *   from progress → pending. Pure join after `readProgress` + `readWorkflows`.
 *
 * **Present for a seeded file nobody has touched**, unlike the card's tally.
 * The two surfaces are asking different questions: the card asks “is there news
 * here”, and an untouched file is not news; the chip asks “is this session
 * spoken for”, and it is — from the moment the message is taken. Going quiet in
 * that window would put Attach back under the reader's cursor while a workflow
 * was already on its way, and a second mention with it (`webview/composer.ts`
 * gates exclusivity on this very field). `step` stays absent until a step
 * moves, so the chip reads a bare “Following X” and invents no cursor.
 */
export type WorkflowObserve = {
  label: string;
  /** Run-level rollup — the one answer paint maps to a class. */
  phase: ProgressRollup;
  /** Lean chip paint — id stays internal so rail `current` is the only cursor on the wire. */
  step?: { label: string; tone: StepMarkerTone };
  steps: ObserveStep[];
};

/** Pipeline progress the rail can trust — omitted kind defaults to pipeline. */
function pipelineProgress(progress: Progress | undefined): Progress | undefined {
  if (!progress) return undefined;
  if (progress.kind !== undefined && progress.kind !== 'pipeline') return undefined;
  return progress;
}

export function followingWorkflow(
  progress: Progress | undefined,
  definition?: {
    label: string;
    steps: readonly { id: string; label: string; lane?: string }[];
  }
): WorkflowObserve | undefined {
  if (!progress) {
    return undefined;
  }
  // A cancelled run is not one the session is following, so every surface that
  // asks this question goes quiet at once: the composer's live chip, the drawer
  // behind it, and the exclusivity the chip holds — which is what puts `Apply
  // workflow…` back and lets the reader arm the next one. The file stays on
  // disk for prune, and for the agent write that may still be on its way.
  if (progress.cancelledAt !== undefined) {
    return undefined;
  }
  // Definition labels win where one is still on disk (PRD: paint prefers the
  // definition if the freehand file disagrees, and `ProgressStep.label` is
  // denormalised for convenience). A deleted or renamed workflow leaves the
  // file's own copies, which is why they are kept; an agent that rewrote the
  // file without `label` leaves the id, which at least names something real.
  // A record holds its own lane's steps and the definition holds every lane's,
  // so the rest would paint pending for the whole run.
  const own = definition?.steps.filter((s) => graph.laneOf(s) === graph.laneOf(progress));
  const snapshot = own ?? progress.steps;
  const label = definition?.label ?? progress.label ?? progress.workflowId;
  const phase = rollup(progress);
  const usable = pipelineProgress(progress);
  // One cursor: marker id is rail `current` and chip `.sname` — never a second pick.
  const marker = usable ? stepMarker(usable, snapshot) : undefined;
  const step = marker ? { label: marker.label, tone: marker.tone } : undefined;
  const currentId = marker?.id;
  const byId = new Map((usable?.steps ?? []).map((s) => [s.id, s]));
  // Missing file → pending (not yet written). Present but unusable kind →
  // unknown (we must not invent pipeline statuses for a later shape).
  const fallback: ObserveStepStatus = progress && !usable ? 'unknown' : 'pending';

  const steps: ObserveStep[] = snapshot.map((s) => {
    const p = byId.get(s.id);
    const status: ObserveStepStatus = p ? p.status : fallback;
    const row: ObserveStep = { id: s.id, label: s.label, status };
    if (p?.note) row.note = p.note;
    if (currentId !== undefined && s.id === currentId) row.current = true;
    return row;
  });

  return step ? { label, phase, step, steps } : { label, phase, steps };
}
