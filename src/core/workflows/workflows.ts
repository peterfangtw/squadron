/**
 * Workflow files under ~/.squadron/workflows/<id>.json are user-authored, so
 * prune.ts never sweeps them.
 * Keep parsing separate from execution so armable can refuse the whole chain
 * before writing to a session, rather than strand a run.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { adapter } from '../adapter';
import { brandName } from '../accounts';
import { BRANDS, DEFAULT_BRAND, isBrand, sessionBrand } from '../brands';
import { checkSpawnIdentity } from '../coordination/spawn';
import { readJson, readJsonDir, writeAtomicJson } from '../files';
import type { BrandId, Session } from '../model';
import { WORKFLOWS_DIR } from '../paths';
import * as skills from '../skills';
import * as authoring from './authoring';
import * as graph from './graph';

/** File order controls the editor; steps' needs alone define the graph. */
export type Workflow = {
  /** Stable, and what a run records. Not read from the filename: a file renamed
   *  under a live run would otherwise rename the run's workflow. */
  id: string;
  label: string;
  description?: string;
  /** Lane names in the order they were added, which is the order the canvas
   *  draws them (`graph.layout`). Order only: a lane exists because a step names
   *  it, never because this does. */
  lanes?: string[];
  steps: Step[];
};

/**
 * One step. `uses` and `prompt` are the two ways of saying what the session is
 * told to do, and exactly one of them is required — a step with both would have
 * two bodies and no rule about which wins.
 *
 * `advance` and `onFail` are parsed and kept, and Phase 1 does neither: every
 * step is entered by a click and every failure asks. A file that states
 * otherwise is not an error, because the schema is the user's contract and the
 * phase is ours — it simply does not get what it asked for yet.
 */
export type Step = {
  id: string;
  label: string;
  /** A skill or command name — `/implement`, `/plugin:skill`. Served as the
   *  prose `stepBody` writes, which every brand's agent was measured to load
   *  (`TASK_done_workflow_uses_brand_seam.md`, Step 1 evidence). */
  uses?: string;
  /** A template: `${identifier}`, `${title}`, `${url}`, `${cwd}`,
   *  `${step.<id>.output}`. */
  prompt?: string;
  /** Definition of done. Absent means the step is advanced by a person alone. */
  check?: { command: string; cwd?: string; timeoutMs?: number };
  /** What this step leaves behind for a later one to read — a path, relative to
   *  the step's cwd. How work is handed on: a path, never context (A11). */
  output?: string;
  advance?: 'manual' | 'auto';
  onFail?: 'retry' | 'ask' | 'abort';
  retries?: number;
  /** Steps that must be completed before this one. Absent waits for nothing. */
  needs?: string[];
  /** The session this step runs in. Absent is the armed session. */
  lane?: string;
  /** Only on the step that opens a lane. The armed session is never opened. */
  brand?: BrandId;
  model?: string;
  effort?: string;
};

/**
 * Carry the path for saveWorkflow and duplicateWorkflow: the id comes from
 * inside the file so renaming a file cannot rename a live run's workflow.
 * Sessions receive the id and one step at a time, never this path or the whole
 * definition (PRD_shipped_step_blind_workflows.md §1).
 * The path also stays off the webview and out of user turns. Progress files
 * keep ids and labels, never this path or prompts.
 */
export type ReadWorkflow = Workflow & { path: string };

/**
 * Editable fields only: check, output and the rest stay on disk for
 * saveWorkflow to merge back.
 */
export type WorkflowEditStep = {
  id: string;
  label: string;
  prompt: string;
  lane?: string;
  needs?: string[];
  brand?: BrandId;
  model?: string;
  effort?: string;
};

/**
 * A refused file with graph faults the cards can draw. Keep path off the wire.
 */
export type WorkflowEdit = {
  id: string;
  label: string;
  lanes?: string[];
  steps: WorkflowEditStep[];
  reasons: string[];
  path: string;
};

export type WorkflowIndex = {
  runnable: ReadWorkflow[];
  edits: WorkflowEdit[];
};

/**
 * The refusal every front door to a mention shares, so they refuse in one voice.
 *
 * Read off `source`, and its subject narrowed when hand-started sessions left
 * the board (row 53): what is left for `source !== 'owned'` to catch is a
 * session **another window drives**, whose published record did not land, and a
 * background session, which the CLI's own agents feature runs. Both have a
 * protocol; neither has one this window can put a workflow on. Arming is the
 * most driving thing in the product, so it happens where the pipe is or not at
 * all. `host/workflow_actions.ts` refuses on it at arm; `webview/tickets.ts`
 * and `webview/chat.ts` withhold the mention ahead of one.
 */
export const NO_PROTOCOL = 'session is not one this window drives';

/**
 * Skip unreadable, half-written and invalid files so arming cannot refuse one
 * after the reader has chosen a session. A missing directory is an empty list.
 */
export async function readWorkflows(): Promise<ReadWorkflow[]> {
  return (await readWorkflowIndex()).runnable;
}

/**
 * Keep editable graph faults separate from runnable definitions: a flag on
 * the runnable list would let a broken file be mentioned. Skip other faults,
 * which the editor cannot show the reader how to fix.
 */
export async function readWorkflowIndex(): Promise<WorkflowIndex> {
  const rows = await readJsonDir(WORKFLOWS_DIR, classify);
  return {
    runnable: rows.flatMap((row) => (row.kind === 'runnable' ? [row.workflow] : [])),
    edits: rows.flatMap((row) => (row.kind === 'edit' ? [row.edit] : []))
  };
}

type Classified =
  { kind: 'runnable'; workflow: ReadWorkflow } | { kind: 'edit'; edit: WorkflowEdit };

function classify(raw: unknown, name: string): Classified | undefined {
  // Normalise first: implicit chain order would fail the lane-order check.
  // Attach the actual filename here; it is not a field the file supplies.
  const read = normaliseDefinition(raw);
  const reasons = validate(read);
  const file = path.join(WORKFLOWS_DIR, name);
  if (reasons.length === 0) {
    return { kind: 'runnable', workflow: { ...(read as Workflow), path: file } };
  }
  const edit = asEdit(read, reasons);
  return edit ? { kind: 'edit', edit: { ...edit, path: file } } : undefined;
}

/** Skip faults the cards cannot paint: they would block Save with nothing to fix. */
function asEdit(read: unknown, reasons: readonly string[]): Omit<WorkflowEdit, 'path'> | undefined {
  const body = narrowEdit(read);
  if (!body) return undefined;
  const shown = authoring.structuralReasons(body.steps);
  if (shown.length === 0 || reasons.some((reason) => !shown.includes(reason))) return undefined;
  return { ...body, reasons: shown };
}

function narrowEdit(read: unknown): Omit<WorkflowEdit, 'path' | 'reasons'> | undefined {
  const authored = fields(read);
  if (typeof authored.id !== 'string' || authored.id === '') return undefined;
  if (typeof authored.label !== 'string' || authored.label === '') return undefined;
  if (!Array.isArray(authored.steps) || authored.steps.length === 0) return undefined;
  const seen = new Set<string>();
  const steps: WorkflowEditStep[] = [];
  for (const raw of authored.steps) {
    const step = narrowEditStep(raw);
    if (!step || seen.has(step.id)) return undefined;
    seen.add(step.id);
    steps.push(step);
  }
  const lanes = laneNames(authored.lanes);
  return {
    id: authored.id,
    label: authored.label,
    ...(lanes ? { lanes } : {}),
    steps
  };
}

function narrowEditStep(raw: unknown): WorkflowEditStep | undefined {
  const step = fields(raw);
  if (typeof step.id !== 'string' || step.id === '') return undefined;
  if (typeof step.label !== 'string' || step.label === '') return undefined;
  const prompt = stepBody(step);
  if (prompt === undefined) return undefined;
  const needs = stepNeeds(step.needs);
  if (needs === undefined) return undefined;
  if (step.lane !== undefined && typeof step.lane !== 'string') return undefined;
  if (step.brand !== undefined && !isBrand(step.brand)) return undefined;
  if (step.model !== undefined && typeof step.model !== 'string') return undefined;
  if (step.effort !== undefined && typeof step.effort !== 'string') return undefined;
  const lane = typeof step.lane === 'string' && step.lane !== '' ? step.lane : undefined;
  const model = typeof step.model === 'string' && step.model !== '' ? step.model : undefined;
  const effort = typeof step.effort === 'string' && step.effort !== '' ? step.effort : undefined;
  return {
    id: step.id,
    label: step.label,
    prompt,
    ...(lane ? { lane } : {}),
    ...(needs.length > 0 ? { needs } : {}),
    ...(isBrand(step.brand) ? { brand: step.brand } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  };
}

function laneNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const names: string[] = [];
  for (const lane of value) {
    if (typeof lane !== 'string') return undefined;
    names.push(lane);
  }
  return names;
}

function stepBody(step: Record<string, unknown>): string | undefined {
  const { prompt, uses } = step;
  if (prompt !== undefined && typeof prompt !== 'string') return undefined;
  if (uses !== undefined && typeof uses !== 'string') return undefined;
  if ((prompt === undefined) === (uses === undefined)) return undefined;
  if (typeof prompt === 'string') return prompt;
  return typeof uses === 'string' ? uses : undefined;
}

function stepNeeds(needs: unknown): string[] | undefined {
  if (needs === undefined) return [];
  return authoring.idsOf(needs);
}

/**
 * What an old or hand-written file leaves unsaid, said once here so that no
 * reader past this one ever sees it — the runner, `squadron-step`, the view and
 * the editor all get explicit `needs`. Nothing is written back: a file on disk
 * keeps what it says until somebody saves it.
 *
 * **Per file, not per step** (`PRD_shipped_workflow_v2.md`, 2026-09-29). A file in
 * which no step states a `needs`, and which uses at most one lane, is a chain:
 * each step after the first waits on the one above it. Any other file is a
 * graph, and a step with no `needs` waits for nothing. Filling per step would
 * wire a hand-written graph's roots to whatever sits above them.
 *
 * Read before `validate`, so nothing here is trusted, and a stale `schema` key
 * is dropped rather than checked. So is a `lanes` that is not a list of names:
 * it only orders columns, and a file that runs should not stop running over it.
 */
export function normaliseDefinition(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const read: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete read.schema;
  const lanes = read.lanes;
  if (!Array.isArray(lanes) || !lanes.every((lane) => typeof lane === 'string')) {
    delete read.lanes;
  }
  const steps = read.steps;
  if (!Array.isArray(steps) || !isChain(steps)) return read;
  read.steps = steps.map((step: unknown, i) =>
    i === 0 ? step : { ...fields(step), needs: [fields(steps[i - 1]).id] }
  );
  return read;
}

/**
 * One lane, and no step that states a `needs`. Over `unknown` rather than
 * `graph.GraphStep` because nothing has been validated yet. A `needs` that names
 * no step in the file makes this false, and `validate` refuses it either way.
 */
function isChain(steps: readonly unknown[]): boolean {
  const lanes = new Set(
    steps.map((step) => {
      const lane = fields(step).lane;
      // `??` replaces only null and undefined. A non-string stays its own lane.
      if (lane === undefined || lane === null) return graph.laneOf({});
      return typeof lane === 'string' ? graph.laneOf({ lane }) : lane;
    })
  );
  const unsaid = steps.every((step) => {
    const needs = fields(step).needs;
    return needs === undefined || (Array.isArray(needs) && needs.length === 0);
  });
  return lanes.size <= 1 && unsaid;
}

/**
 * The text a mentioned workflow puts on the wire: one line naming the workflow,
 * and the message the user actually typed beneath it.
 *
 * **The id, not the text, and no longer the file.** Inlining five steps would
 * put a wall of prose in the composer that a reader scrolls past to find their
 * own sentence (PRD §13); handing over the path was worse, because an agent
 * given the file reads all of it and every later step's criteria are in context
 * before step 1 begins (`PRD_shipped_step_blind_workflows.md` §1). What a session
 * needs from this line is which workflow it is on. The steps arrive one at a
 * time, from `squadron-step`, and `progressBriefing` is what says so.
 *
 * **The id is safe to hand over where the path is not.** `readWorkflows` reads
 * it from inside the file precisely so renaming the file cannot rename a live
 * run's workflow — so an id is not a filename and does not become one. It is
 * also the one thing an agent whose run was never written down needs:
 * `squadron-step start --workflow-id <id>` arms it, which is why there is no
 * fallback here for a seed that failed.
 *
 * The subject may be empty, and then the mention is the whole message: a
 * workflow named on its own says everything a session needs, exactly as a pasted
 * image with no prose does.
 */
export function enrich(workflow: { label: string; id: string }, subject: string): string {
  const line = `Following the workflow "${workflow.label}" (${workflow.id}).`;
  // Emptiness only. Trimming the subject drops a leading blank line the reader typed.
  if (!subject.trim()) return line;
  return `${line}\n\n${subject}`;
}

/**
 * Return every fault so an author can fix several in one save.
 * See outputRefs for the numeric-prompt guard.
 */
export function validate(workflow: unknown): string[] {
  const reasons: string[] = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return ['not an object'];
  }
  const authored = workflow as Stated<Workflow>;
  if (typeof authored.id !== 'string' || authored.id === '') {
    reasons.push('needs an id');
  }
  if (typeof authored.label !== 'string' || authored.label === '') {
    reasons.push('needs a label');
  }
  if (authored.description !== undefined && typeof authored.description !== 'string') {
    reasons.push('needs its description to be text');
  }
  if (
    authored.lanes !== undefined &&
    (!Array.isArray(authored.lanes) || authored.lanes.some((lane) => typeof lane !== 'string'))
  ) {
    reasons.push('needs its lanes to be names');
  }
  if (!Array.isArray(authored.steps) || authored.steps.length === 0) {
    return [...reasons, 'needs at least one step'];
  }
  const steps: Stated<Step>[] = authored.steps.map((s) => (s ?? {}) as Stated<Step>);

  const seen = new Set<string>();
  steps.forEach((step, i) => {
    const where = `step ${i + 1}`;
    if (typeof step.id !== 'string' || step.id === '') {
      reasons.push(`${where} needs an id`);
      return;
    }
    if (seen.has(step.id)) {
      reasons.push(`${where} repeats the id ${step.id}`);
    }
    if (typeof step.label !== 'string' || step.label === '') {
      reasons.push(`${step.id} needs a label`);
    }
    if ((step.uses === undefined) === (step.prompt === undefined)) {
      reasons.push(`${step.id} needs exactly one of uses or prompt`);
    } else if (step.uses !== undefined && typeof step.uses !== 'string') {
      reasons.push(`${step.id} needs its uses to be text`);
    } else if (step.prompt !== undefined && typeof step.prompt !== 'string') {
      reasons.push(`${step.id} needs its prompt to be text`);
    }
    if (step.check !== undefined && typeof fields(step.check).command !== 'string') {
      reasons.push(`${step.id} has a check with no command`);
    }
    if (step.check !== undefined) {
      const check = fields(step.check);
      if (check.cwd !== undefined && typeof check.cwd !== 'string') {
        reasons.push(`${step.id} needs its check cwd to be text`);
      }
      if (
        check.timeoutMs !== undefined &&
        (typeof check.timeoutMs !== 'number' || !Number.isFinite(check.timeoutMs))
      ) {
        reasons.push(`${step.id} needs its check timeoutMs to be a finite number`);
      }
    }
    if (step.output !== undefined && typeof step.output !== 'string') {
      reasons.push(`${step.id} needs its output to be text`);
    }
    if (step.advance !== undefined && step.advance !== 'manual' && step.advance !== 'auto') {
      reasons.push(`${step.id} needs its advance to be manual or auto`);
    }
    if (
      step.onFail !== undefined &&
      step.onFail !== 'retry' &&
      step.onFail !== 'ask' &&
      step.onFail !== 'abort'
    ) {
      reasons.push(`${step.id} needs its onFail to be retry, ask or abort`);
    }
    if (
      step.retries !== undefined &&
      (typeof step.retries !== 'number' || !Number.isFinite(step.retries))
    ) {
      reasons.push(`${step.id} needs its retries to be a finite number`);
    }
    // Refuse forward or undeclared outputs here: at runtime the prompt would
    // name a file that is not there yet.
    for (const ref of outputRefs(step.prompt)) {
      if (!seen.has(ref)) {
        reasons.push(`${step.id} reads the output of ${ref}, which is not an earlier step`);
      } else if (!steps.find((s) => s.id === ref)?.output) {
        reasons.push(`${step.id} reads the output of ${ref}, which declares none`);
      }
    }
    seen.add(step.id);
  });
  reasons.push(...laneReasons(steps));
  return reasons;
}

/**
 * Share structural checks with the canvas. Keep brand/model checks here
 * because the webview must not name brands.
 */
function laneReasons(steps: readonly Stated<Step>[]): string[] {
  const reasons = authoring.structuralReasons(steps);
  const rows = steps.flatMap((step) => {
    if (typeof step.id !== 'string' || step.id === '') return [];
    if (step.lane !== undefined && typeof step.lane !== 'string') return [];
    const { id, lane, brand, model, effort } = step;
    return [{ id, lane, brand, model, effort }];
  });
  for (const lane of new Set(rows.map(graph.laneOf))) {
    const row = graph.opener(rows, lane);
    if (row) reasons.push(...openerIdentity(row));
  }
  return reasons;
}

function openerIdentity(row: {
  id: string;
  brand: unknown;
  model: unknown;
  effort: unknown;
}): string[] {
  const reasons: string[] = [];
  if (row.brand !== undefined && !isBrand(row.brand)) {
    reasons.push(`${row.id} needs its brand to be ${brandWords()}`);
  }
  if (row.model !== undefined && typeof row.model !== 'string') {
    reasons.push(`${row.id} needs its model to be text`);
  }
  if (row.effort !== undefined && typeof row.effort !== 'string') {
    reasons.push(`${row.id} needs its effort to be text`);
  }
  if (
    (row.brand === undefined || isBrand(row.brand)) &&
    (row.model === undefined || typeof row.model === 'string')
  ) {
    const identity = checkSpawnIdentity({
      ...(isBrand(row.brand) ? { brand: row.brand } : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {})
    });
    if (!identity.ok) reasons.push(`${row.id} ${identity.reason}`);
  }
  return reasons;
}

function brandWords(): string {
  const last = BRANDS.at(-1);
  if (last === undefined) return '';
  const head = BRANDS.slice(0, -1);
  return head.length === 0 ? last : `${head.join(', ')} or ${last}`;
}

/** Every field stays unknown until checked; a file's claimed shape is not proof. */
type Stated<T> = { [K in keyof T]?: unknown };

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Accept unknown so a numeric prompt cannot turn matchAll into a crash. */
function outputRefs(template: unknown): string[] {
  return [
    ...(typeof template === 'string' ? template : '').matchAll(/\$\{step\.([^.}]+)\.output\}/g)
  ]
    .map((m) => m[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * Keep unresolved references verbatim and report them: emptying one makes a
 * broken instruction such as "read the plan at " look complete.
 * Keys are whole references (step.plan.output), not nested object paths;
 * validate has already checked which references may appear.
 */
export function substitute(
  template: string,
  vars: Record<string, string | undefined>
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined || value === '') {
      unresolved.push(name);
      return whole;
    }
    return value;
  });
  return { text, unresolved };
}

/**
 * Does this name exist for `brand` where the run will run.
 *
 * Looked up in that brand's own sources (`CliAdapter.skillSources`), by the
 * name `SkillDiscovery` lists. Each CLI lists a skill by its frontmatter name,
 * and Codex lists only one that states a name and a description
 * (`docs/reference/cli_state/skill_roots.md`). Project sources are read from
 * every directory `skills.projectDirectories` names, because a session in a
 * subdirectory loads its repo root's skills.
 *
 * **A namespaced `/<plugin>:<name>` that no declared source lists is accepted
 * unchecked**, for every brand. Each brand has plugin trees that are not
 * scanned (Claude's cache and marketplaces, `~/.codex/plugins`,
 * `~/.grok/installed-plugins`), and their layouts are observed, not declared.
 * So the name's absence is unknown, not proof that it is missing. Refusing it
 * would cost the whole run. Accepting it puts that one step at risk: the agent
 * is told to run a name it may not find.
 */
export async function resolveUses(
  name: string,
  cwd: string,
  brand: BrandId = DEFAULT_BRAND
): Promise<boolean> {
  return usesFound(name, brand, await skillSnapshot([brand], cwd));
}

function usesFound(name: string, brand: BrandId, found: skills.SkillNames): boolean {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  if (bare === '') return false;
  // Case-blind: Grok lists `CaseSkill` as `caseskill`, and the old
  // existence check matched either spelling on a case-insensitive disk.
  const wanted = bare.toLowerCase();
  return (found[brand] ?? []).some((n) => n.toLowerCase() === wanted) || bare.includes(':');
}

/** One preflight's read of the brands' skill folders, discarded with it. */
async function skillSnapshot(brands: readonly BrandId[], cwd: string): Promise<skills.SkillNames> {
  const providers = [...new Set(brands)].flatMap((brand) => adapter(brand) ?? []);
  const discovery = new skills.SkillDiscovery(providers, os.homedir(), process.env);
  return discovery.forDirectories(await skills.projectDirectories(cwd));
}

/**
 * The brand a step's file states it runs on, or nothing for the anchor's. A
 * lane is opened by `squadron-step` with its opener's brand or none, and an
 * open with none inherits the anchor's (`resolveSpawnIdentity`).
 */
export function statedBrand(steps: readonly Step[], step: Step): BrandId | undefined {
  const lane = graph.laneOf(step);
  return lane === '' ? undefined : graph.opener(steps, lane)?.brand;
}

/**
 * Check the whole chain before writing to a session: a missing skill on step
 * three must not waste two steps when its absence is knowable at arm time.
 * Refusals name the step and cwd so a missing per-project command is
 * actionable, and the lane's brand when it is not the anchor's.
 *
 * `anchor` is the brand of the session the run is armed at.
 */
export async function armable(
  workflow: Workflow,
  cwd: string,
  anchor: BrandId = DEFAULT_BRAND
): Promise<string[]> {
  const reasons = validate(workflow);
  if (reasons.length > 0) {
    return reasons;
  }
  // Here and not in `validate`: the canvas draws a file with every step in a
  // lane on purpose, and only running one needs the armed session to hold a
  // step. Armed, it seeds a record with no rows, which `readProgress` rejects,
  // so `next` exits 5 — a disk fault — and the agent retries it.
  if (!workflow.steps.some((step) => graph.laneOf(step) === '')) {
    return [ARMED_LANE_EMPTY];
  }
  const unopened = authoring.unopenedLanes(workflow.steps);
  if (unopened.length > 0) return unopened;
  const uses = workflow.steps.flatMap((step) =>
    step.uses === undefined
      ? []
      : [{ step, uses: step.uses, brand: statedBrand(workflow.steps, step) ?? anchor }]
  );
  if (uses.length === 0) return [];
  // Slash names resolve at the session's cwd, not check.cwd. Lanes spawn
  // in this directory too, so it covers their steps.
  const found = await skillSnapshot(
    uses.map((use) => use.brand),
    cwd
  );
  return uses
    .filter((use) => !usesFound(use.uses, use.brand, found))
    .map(
      ({ step, uses, brand }) =>
        `${step.id} uses ${uses}, which does not exist in ${cwd}` +
        (brand === anchor ? '' : ` for its ${brandName(brand)} lane`)
    );
}

/** Shared with `squadron-step start`, which seeds without calling {@link armable}. */
export const ARMED_LANE_EMPTY =
  'every step is in a lane, so the session it is armed at would have no step of its own to open them from';

/** A refusal in one voice, wherever it was decided. Every reason, not the
 *  first, for the reason `validate` returns a list at all. */
export function cannotRunHere(label: string, reasons: readonly string[]): string {
  return `${label} cannot run here: ${reasons.join('; ')}`;
}

/** Said of the id rather than a label, since a file that is not there has no
 *  label to be said of. */
export const NO_SUCH_WORKFLOW = 'no such workflow on this machine';

/**
 * {@link NO_SUCH_WORKFLOW}, pointing a filename at the id it most likely meant.
 * Shared by spawn, a mention and `squadron-step start`, which all match the
 * `id` alone: a file's name is not one (see {@link enrich}), so
 * `qa-mutation.json` names nothing even beside a file of that name.
 */
export function noSuchWorkflow(id: string): string {
  const stem = id.endsWith('.json') ? id.slice(0, -'.json'.length) : '';
  return cannotRunHere(id, [
    stem === ''
      ? NO_SUCH_WORKFLOW
      : `${NO_SUCH_WORKFLOW}; a workflow is named by its id ("${stem}"), not its file`
  ]);
}

/**
 * Spawn has no pid or session id yet, unlike armMention. It creates a session
 * this window drives and mints its id before the child, satisfying those gates.
 * Keep this decision in core so it can be tested.
 */
export async function armWorkflow(
  workflowId: string,
  cwd: string,
  brand: BrandId = DEFAULT_BRAND
): Promise<{ workflow: ReadWorkflow } | { refused: string }> {
  const workflow = (await readWorkflows()).find((w) => w.id === workflowId);
  if (!workflow) {
    return { refused: noSuchWorkflow(workflowId) };
  }
  const reasons = await armable(workflow, cwd, brand);
  return reasons.length > 0 ? { refused: cannotRunHere(workflow.label, reasons) } : { workflow };
}

/**
 * Everything that has to be true before a mentioned workflow may be sent, and
 * the session it will be sent at if it is.
 *
 * A refusal is **nothing written at all** (S7), handed back as words for the
 * send to put in the composer's own line. It is worth the words because both
 * halves of one are actionable: which step asked for what, and which directory
 * the answer was looked for in — `armable` writes both, and a per-project
 * command missing from one checkout is unreadable without them.
 *
 * The definition is re-read here rather than taken off the last poll's state:
 * only `id`, `label` and the step names ever crossed the wire, and the steps'
 * bodies are what the message is made of.
 *
 * **Two snapshots, and `live` is asked first.** It is this window's own
 * registry, current as of the last frame; `board` is the 3s poll's, and is the
 * only place a session *another* window drives appears at all. Neither of the
 * three fields read below is enriched on the way to the board — `relocate`
 * writes `transcript` and `completion` and drops `home` on the floor
 * deliberately (`host/panel.ts`), `withProcessCwd` writes `liveCwd`, and
 * `withTwin` never touches `cwd`, `sessionId` or `source` — so between the two
 * copies the only difference is staleness, and asking the stale one first buys
 * nothing. It costs something: a `/clear` mints a new session id that `init`
 * restates (`claude/reduce.ts`), so a mention inside the poll window would key
 * `stageForSend` to the id the session has stopped wearing, and
 * `readProgress(session.sessionId)` would never find the file again.
 *
 * `live` also answers the case that made this a bug: a start is on the registry
 * before any poll has run, because `revealSession` posts the reveal and only
 * *then* kicks a refresh, so a promoted draft's first turn names a pid the
 * board has never listed. Refusing that turn lost the one message the reader
 * had written. The delivery this gates already reads the registry first
 * (`core/coordination/route.ts`), and a gate that refuses what the thing behind it would
 * reach is the bug rather than the rule.
 *
 * The two refusals below `armable` came off `armRun` when the record went, and
 * neither is decoration. `session gone` is the pid being on neither snapshot.
 * The other is the house rule: a workflow goes on a pipe some window holds or
 * it does not go, and a session the CLI runs under its daemon is not that.
 * Without it such a mention would pass, seed a file, enrich the body, and then
 * fall to `UNROUTED` at the bottom of `send` — an orphan file and a lit strip
 * on a session the panel cannot write to. `webview/tickets.ts` and
 * `webview/chat.ts` withhold the mention for the same reason and quote the same
 * words.
 *
 * In `core/` beside {@link armWorkflow}, and for the reason that one states: a
 * decision `host/` cannot test is one nothing catches. This one was in `host/`
 * until it ate a first turn.
 */
export async function armMention(
  pid: number,
  workflowId: string,
  sessions: { board: readonly Session[]; live: readonly Session[] }
): Promise<{ sessionId: string; workflow: ReadWorkflow } | { refused: string }> {
  const workflow = (await readWorkflows()).find((w) => w.id === workflowId);
  if (!workflow) {
    return { refused: noSuchWorkflow(workflowId) };
  }
  const refuse = (...reasons: string[]): { refused: string } => ({
    refused: cannotRunHere(workflow.label, reasons)
  });
  const session =
    sessions.live.find((s) => s.pid === pid) ?? sessions.board.find((s) => s.pid === pid);
  if (!session) {
    return refuse('session gone');
  }
  if (session.source !== 'owned') {
    return refuse(NO_PROTOCOL);
  }
  // Every owned session is named from the moment it spawns (`--session-id` in
  // `host/sessions.ts`), so the placeholder is a session this build did not
  // start — a published record from an older one. Nothing can be keyed to it.
  if (!session.sessionId) {
    return refuse('session has not been named yet');
  }
  const reasons = await armable(workflow, session.cwd, sessionBrand(session.brand));
  if (reasons.length > 0) {
    return refuse(...reasons);
  }
  return { sessionId: session.sessionId, workflow };
}

export type SaveWorkflowResult =
  { ok: true; workflow: ReadWorkflow } | { ok: false; reasons: string[] };

export type DeleteWorkflowResult = { ok: true } | { ok: false; reasons: string[] };

export function slugId(label: string, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/**
 * Single path segment under WORKFLOWS_DIR — no separators, no `..`.
 * Matches what `slugId` mints (and hand-written ids that stay one segment).
 */
function safeWorkflowId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[\\/]/.test(id);
}

/** Share id allocation so duplicated suffix loops cannot drift and clobber a file. */
async function freeId(label: string): Promise<string> {
  const base = slugId(label, 'workflow');
  let id = base;
  let n = 2;
  while ((await readJson(path.join(WORKFLOWS_DIR, `${id}.json`))) !== undefined) {
    id = `${base}-${n++}`;
  }
  return id;
}

/**
 * Copies a definition whole, under a new id and a name that says it is a copy.
 *
 * **File to file, and never through a `WorkflowDraft`.** The panel's view of a
 * workflow carries id, label and a per-step prompt; everything else a file may
 * hold — `check`, `output`, `advance`, `onFail`, `retries`, `description` — is
 * host-only. `saveWorkflow` restores those from the file it is overwriting, but
 * a duplicate is a *create*, so there is no `existing` to restore from and every
 * one of them would be silently dropped. A step whose body was `uses` is the
 * loudest of them: it comes back as a `prompt`, and the copy stops resolving
 * through `resolveUses` at arm time — a workflow that refuses to run, made by a
 * menu item called Duplicate.
 *
 * The label is the reader's to fix afterwards; this only has to be different,
 * because two rows with one name is a list nobody can use. The copy is a new
 * file, so it is written as normaliseDefinition reads it: an old chain's order
 * comes out as needs, and no schema.
 */
export async function duplicateWorkflow(id: string): Promise<SaveWorkflowResult> {
  if (!safeWorkflowId(id)) {
    return { ok: false, reasons: [`invalid workflow id ${id}`] };
  }
  const source = normaliseDefinition(await readJson(path.join(WORKFLOWS_DIR, `${id}.json`))) as
    Workflow | undefined;
  if (!source) {
    return { ok: false, reasons: [`no such workflow ${id}`] };
  }
  const label = `${source.label} copy`;
  const next: Workflow = { ...source, id: await freeId(label), label };
  const reasons = validate(next);
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  const file = path.join(WORKFLOWS_DIR, `${next.id}.json`);
  if (!(await writeAtomicJson(file, next, 'state'))) {
    return { ok: false, reasons: ['could not write workflow file'] };
  }
  return { ok: true, workflow: { ...next, path: file } };
}

/**
 * Removes `~/.squadron/workflows/<id>.json`. Refuses an unsafe id;
 * a missing file is still ok (already gone).
 */
export async function deleteWorkflow(id: string): Promise<DeleteWorkflowResult> {
  if (!safeWorkflowId(id)) {
    return { ok: false, reasons: [`invalid workflow id ${id}`] };
  }
  const file = path.join(WORKFLOWS_DIR, `${id}.json`);
  try {
    await fs.rm(file, { force: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reasons: [err instanceof Error ? err.message : 'could not delete workflow file']
    };
  }
}

/**
 * Writes a draft to disk after `validate`. The five fields the editor owns are
 * replaced whole; fields the form does not show (`check`, `output`, …) survive
 * from the file.
 *
 * `needs` is written as the draft states it, one-lane chains included, and no
 * `schema` is written: the `needs` are the whole of what it used to say.
 *
 * Nothing is written when validation fails. Create mints `id` from the label
 * (suffixing when that file already exists); edit refuses an unknown or unsafe
 * id rather than inventing a second file. Steps merge by `id` only — a new row
 * never inherits index-aligned fields from the old file.
 */
export async function saveWorkflow(draft: WorkflowDraft): Promise<SaveWorkflowResult> {
  if (draft.id !== undefined && !safeWorkflowId(draft.id)) {
    return { ok: false, reasons: [`invalid workflow id ${draft.id}`] };
  }

  const existing =
    draft.id !== undefined
      ? ((await readJson<Workflow>(path.join(WORKFLOWS_DIR, `${draft.id}.json`))) ?? undefined)
      : undefined;
  if (draft.id !== undefined && !existing) {
    return { ok: false, reasons: [`no such workflow ${draft.id}`] };
  }

  const id =
    draft.id === undefined
      ? await freeId(draft.label)
      : (existing?.id ?? slugId(draft.label, 'workflow'));

  const used = new Set<string>();
  const steps: Step[] = draft.steps.map((d, i) => {
    // Merge by id only. A new step (no id) starts fresh — index fallback would
    // steal check/output/advance from whatever used to sit at that slot.
    const prev = d.id !== undefined ? existing?.steps.find((s) => s.id === d.id) : undefined;
    let stepId = d.id ?? slugId(d.label, `step-${i + 1}`);
    if (used.has(stepId)) {
      let n = 2;
      while (used.has(`${stepId}-${n}`)) n++;
      stepId = `${stepId}-${n}`;
    }
    used.add(stepId);
    const prompt = d.prompt;
    // Form always authors a prompt. Drop uses when prompt is set so validate's
    // exactly-one rule holds. The five the form owns come from the draft whole;
    // every other field is prev's.
    const base: Step = prev
      ? { ...prev, id: stepId, label: d.label }
      : { id: stepId, label: d.label };
    const step: Step = prompt.trim() !== '' ? { ...base, prompt } : base;
    if (prompt.trim() !== '') delete step.uses;
    // Assigned in place rather than rebuilt, so a key the file already had
    // keeps its position and an unchanged step writes back byte for byte.
    if (d.needs?.length) step.needs = [...d.needs];
    else delete step.needs;
    if (d.lane) step.lane = d.lane;
    else delete step.lane;
    if (d.brand) step.brand = d.brand;
    else delete step.brand;
    if (d.model) step.model = d.model;
    else delete step.model;
    if (d.effort) step.effort = d.effort;
    else delete step.effort;
    return step;
  });
  const lanes = (draft.lanes ?? []).filter((lane) => steps.some((s) => s.lane === lane));
  const next: Workflow = {
    id,
    label: draft.label,
    ...(existing?.description !== undefined ? { description: existing.description } : {}),
    ...(lanes.length > 0 ? { lanes } : {}),
    steps
  };
  const reasons = validate(next);
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  const file = path.join(WORKFLOWS_DIR, `${id}.json`);
  if (!(await writeAtomicJson(file, next, 'state'))) {
    return { ok: false, reasons: ['could not write workflow file'] };
  }
  return { ok: true, workflow: { ...next, path: file } };
}
