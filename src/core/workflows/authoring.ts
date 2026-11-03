/**
 * The structural rules of a workflow, and the edits that keep a draft inside them.
 *
 * One copy, because `validate` and the canvas were about to grow a second.
 * Import-free except `graph.ts`: the webview bundle takes this the same way it
 * takes that file, and a brand check cannot live here (`openerIdentity` stays
 * in `workflows.ts`).
 */

import * as graph from './graph';

/** `brand`, `model`, `effort` — only the step that opens a lane may state them. */
export const OPENER_FIELDS = ['brand', 'model', 'effort'] as const;
export type OpenerField = (typeof OPENER_FIELDS)[number];

/**
 * A step as structure sees it. Every field is a claim: `validate` has not
 * narrowed it, and a draft step is the same shape once it has an id.
 */
export type StructuralStep = {
  id?: unknown;
  needs?: unknown;
  lane?: unknown;
  brand?: unknown;
  model?: unknown;
  effort?: unknown;
};

/** A step an edit can copy. Extra fields (`prompt`, `kind`) ride through. */
export type EditStep = {
  id: string;
  label?: string;
  lane?: string;
  needs?: readonly string[];
  brand?: string;
  model?: string;
  effort?: string;
};

export type EditResult<T> = { steps: T[] } | { refused: string };

/** A wire `link` refuses, and which of its three rules refused it. `skips` names
 *  the step a `skip` would jump. */
export type LinkRefusal = { refused: string; why: 'loop' | 'skip' | 'starts'; skips?: string };

/** The ids in `needs`. An empty list when the field is absent, and nothing
 *  when it is not a list of ids. */
export function idsOf(needs: unknown): string[] | undefined {
  if (needs === undefined) return [];
  if (!Array.isArray(needs)) return undefined;
  const ids: string[] = [];
  for (const id of needs) {
    if (typeof id !== 'string' || id === '') return undefined;
    ids.push(id);
  }
  return ids;
}

/** Whether `target` is reachable by walking `needs`, self included as a hit
 *  and not as a start. A cycle cannot hang: a step already walked is skipped. */
export function reaches(
  needs: readonly string[],
  target: string,
  byNeeds: ReadonlyMap<string, readonly string[]>
): boolean {
  const seen = new Set<string>();
  const pending = [...needs];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    if (id === target) return true;
    seen.add(id);
    for (const next of byNeeds.get(id) ?? []) pending.push(next);
  }
  return false;
}

/**
 * The sessions a run would open with the run itself, named by their step.
 *
 * A file that saves but does not run, like `ARMED_LANE_EMPTY`: the canvas makes
 * a new session's step unwired, and the reader wires it after.
 */
export function unopenedLanes(steps: readonly EditStep[]): string[] {
  const needs = graph.needsOf(steps);
  return steps
    .filter((step) => graph.laneOf(step) !== graph.ARMED)
    .filter((step) => (needs.get(step.id) ?? []).length === 0)
    .map(
      (step) =>
        `${step.id} opens ${step.lane} with no step wired before it, so it would start with the run`
    );
}

/**
 * Why these steps are not a legal graph, in the words `validate` already uses.
 * Empty means they are. The brand/model pair is not in here: the editor cannot
 * post a mismatch, and the check names a brand.
 */
export function structuralReasons(steps: readonly StructuralStep[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id === '') continue;
    if (step.needs !== undefined && !idsOf(step.needs)) {
      reasons.push(`${step.id} needs its needs to be a list of step ids`);
    } else {
      for (const id of idsOf(step.needs) ?? []) {
        if (!seen.has(id)) {
          reasons.push(`${step.id} needs ${id}, which is not an earlier step`);
        }
      }
    }
    if (step.lane !== undefined && typeof step.lane !== 'string') {
      reasons.push(`${step.id} needs its lane to be a name`);
    }
    seen.add(step.id);
  }

  const rows = steps.flatMap((step) => {
    if (typeof step.id !== 'string' || step.id === '') return [];
    if (step.lane !== undefined && typeof step.lane !== 'string') return [];
    return [
      {
        id: step.id,
        lane: typeof step.lane === 'string' && step.lane !== '' ? step.lane : graph.ARMED,
        needs: idsOf(step.needs) ?? [],
        brand: step.brand,
        model: step.model,
        effort: step.effort
      }
    ];
  });
  for (const row of rows) {
    if (graph.opener(rows, row.lane) === row) continue;
    for (const field of OPENER_FIELDS) {
      if (row[field] !== undefined) {
        reasons.push(`${row.id} states ${field}, which belongs on the step that opens a lane`);
      }
    }
  }
  const byNeeds = new Map(rows.map((row) => [row.id, row.needs]));
  const last = new Map<string, string>();
  for (const row of rows) {
    const prev = last.get(row.lane);
    last.set(row.lane, row.id);
    if (prev === undefined) continue;
    if (!reaches(row.needs, prev, byNeeds)) {
      const where = row.lane === graph.ARMED ? 'the armed session' : `lane ${row.lane}`;
      reasons.push(`${row.id} does not follow ${prev}, the previous step of ${where}`);
    }
  }
  return reasons;
}

/**
 * File order as a topological order. A file that is already one keeps it: the
 * lowest original index among the steps that are ready is the one that was
 * next, and a new edge moves only the steps it blocks.
 */
export function sortTopo<T extends EditStep>(steps: readonly T[]): T[] {
  const index = new Map(steps.map((step, i) => [step.id, i]));
  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const step of steps) {
    for (const need of unique(step.needs ?? [])) {
      if (!byId.has(need) || need === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependents.get(need)?.push(step.id);
    }
  }
  const ready = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  const out: T[] = [];
  const used = new Set<string>();
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift();
    if (id === undefined || used.has(id)) continue;
    used.add(id);
    const step = byId.get(id);
    if (step) out.push(clone(step));
    for (const dep of dependents.get(id) ?? []) {
      const left = (indegree.get(dep) ?? 1) - 1;
      indegree.set(dep, left);
      if (left === 0) ready.push(dep);
    }
  }
  for (const step of steps) {
    if (!used.has(step.id)) out.push(clone(step));
  }
  return out;
}

/**
 * A new step in lane `session N`. `after` sets `needs` to that step; without
 * it the step shares tier 1, a root in a named lane, which is what
 * `unopenedLanes` refuses to start until it is wired.
 */
export function addLane<T extends EditStep>(
  steps: readonly T[],
  after: string | undefined,
  step: T
): EditResult<T> {
  if (after !== undefined && !steps.some((s) => s.id === after)) {
    return { refused: `${after} is not a step` };
  }
  const base = steps.map(clone);
  const lane = namedLane(step.lane) ?? nextSessionName(base);
  const needs = after === undefined ? undefined : [after];
  const added: T = { ...clone(step), lane, ...(needs ? { needs } : {}) };
  if (after === undefined) delete added.needs;
  return { steps: sortTopo(relocateOpeners(steps, [...base, added])) };
}

/** `to` waits for `from`. An existing `needs` is kept. Refused when `to` is
 *  upstream of `from`, which is the loop the drag draws as *would loop*; when
 *  both are one lane and `from` is not the step right above `to`: that
 *  session runs every step between them first (the user's call, 2026-10-01);
 *  and when `to` starts the run (`blocksStart`). */
export function link<T extends EditStep>(
  steps: readonly T[],
  from: string,
  to: string
): { steps: T[] } | LinkRefusal | { refused: string } {
  const source = steps.find((step) => step.id === from);
  const target = steps.find((step) => step.id === to);
  if (!source || !target) return { refused: 'that step is not in the draft' };
  if (from === to) return { refused: 'would loop', why: 'loop' };
  const base = steps.map(clone);
  const byNeeds = needsMap(base);
  if (reaches(byNeeds.get(from) ?? [], to, byNeeds)) return { refused: 'would loop', why: 'loop' };
  if (graph.laneOf(source) === graph.laneOf(target) && previousInLane(base, to)?.id !== from) {
    const mates = laneOrder(base, from);
    const skipped = mates[mates.findIndex((step) => step.id === from) + 1];
    const name = skipped?.label?.trim() || skipped?.id || '';
    const where = graph.laneOf(target) === graph.ARMED ? 'this session' : graph.laneOf(target);
    return {
      refused: `Skips ${name}. ${where} is one session: this already waits for the step above it`,
      why: 'skip',
      skips: name
    };
  }
  const next = base.map((step) =>
    step.id === to ? { ...step, needs: unique([...(step.needs ?? []), from]) } : step
  );
  const result = blocksStart(steps, sortTopo(next));
  return 'refused' in result ? { ...result, why: 'starts' } : result;
}

/** Every step a wire from `from` cannot reach, by `link`'s own answer — what a
 *  wire drag marks, so the marks cannot say other than the drop would. */
export function linkRefusals(steps: readonly EditStep[], from: string): Map<string, LinkRefusal> {
  const out = new Map<string, LinkRefusal>();
  for (const step of steps) {
    if (step.id === from) continue;
    const result = link(steps, from, step.id);
    if ('why' in result) out.set(step.id, result);
  }
  return out;
}

/** Drop one wire. Refused when it is the only link keeping a lane in order,
 *  in the words the card shows under `needs`. */
export function unlink<T extends EditStep>(
  steps: readonly T[],
  from: string,
  to: string
): EditResult<T> {
  const base = steps.map(clone);
  const target = base.find((step) => step.id === to);
  const source = base.find((step) => step.id === from);
  if (!target || !source) return { refused: 'that step is not in the draft' };
  if (!(target.needs ?? []).includes(from)) return { steps: base };
  const lane = graph.laneOf(target);
  const holdsOrder = lane === graph.laneOf(source) && previousInLane(base, to)?.id === from;
  if (holdsOrder) {
    const without = (target.needs ?? []).filter((id) => id !== from);
    const byNeeds = needsMap(
      base.map((step) => (step.id === to ? { ...step, needs: without } : step))
    );
    if (!reaches(without, from, byNeeds)) {
      const where = lane === graph.ARMED ? 'this session' : lane;
      const ran = source.label?.trim() || source.id;
      return {
        refused: `Kept. ${where} is one session: it runs ${ran}, then this`
      };
    }
  }
  const next = base.map((step) =>
    step.id === to ? { ...step, needs: (step.needs ?? []).filter((id) => id !== from) } : step
  );
  return { steps: sortTopo(next) };
}

/** Delete a step. Whatever waited for it loses the wire and inherits nobody's
 *  `needs`, and every lane closes over the gap. The last step of a named lane
 *  takes the column with it. Refused when the step left first starts the run
 *  waiting (`blocksStart`). */
export function removeStep<T extends EditStep>(steps: readonly T[], id: string): EditResult<T> {
  if (!steps.some((step) => step.id === id)) return { refused: 'that step is not in the draft' };
  const next = steps.filter((step) => step.id !== id).map((step) => withoutNeeds(step, [id]));
  return blocksStart(steps, orderLanes(steps, sortTopo(relocateOpeners(steps, next))));
}

/**
 * Put a step right after `after` in its lane, or first when `after` is null —
 * a row dropped on the canvas. Only its neighbours are rewired, as
 * `insertInLane` splices a new step: it waits on `after`, the step that
 * followed `after` waits on it, and the two either side of where it was are
 * joined. A step further down whose order ran through it is not rewired, and
 * Save says so in its card (the user's call, 2026-10-01). Refused when the
 * step put first starts the run waiting (`blocksStart`).
 */
export function placeInLane<T extends EditStep>(
  steps: readonly T[],
  id: string,
  after: string | null
): EditResult<T> {
  const step = steps.find((s) => s.id === id);
  if (!step) return { refused: 'that step is not in the draft' };
  const mates = laneOrder(steps, id);
  const at = mates.findIndex((s) => s.id === id);
  const others = mates.filter((s) => s.id !== id);
  const anchor = after === null ? -1 : others.findIndex((s) => s.id === after);
  if (after !== null && anchor < 0) return { refused: `${after} is not in this lane` };
  if (anchor + 1 === at) return { steps: steps.map(clone) };
  const above = mates[at - 1]?.id;
  const below = mates[at + 1]?.id;
  const follower = others[anchor + 1]?.id;
  const next = steps.map((s) => {
    const copy = clone(s);
    let needs = [...(s.needs ?? [])];
    if (s.id === id) needs = [...needs.filter((n) => n !== above), ...(after ? [after] : [])];
    if (s.id === below) needs = needs.flatMap((n) => (n !== id ? [n] : above ? [above] : []));
    if (s.id === follower) {
      needs = after === null ? [...needs, id] : needs.map((n) => (n === after ? id : n));
    }
    needs = unique(needs);
    if (needs.length === 0) delete copy.needs;
    else copy.needs = needs;
    return copy;
  });
  const byNeeds = needsMap(next);
  const loops = [id, follower].some(
    (s) => s !== undefined && reaches(byNeeds.get(s) ?? [], s, byNeeds)
  );
  if (loops) return { refused: 'would loop' };
  // Sorted first: the new order is only in `needs` until then, and the opener
  // fields follow whichever step the sort puts first.
  return blocksStart(steps, relocateOpeners(steps, sortTopo(next)));
}

/** Where a released card lands, as a row of its own column, 1-based as the
 *  canvas numbers its cells. `last` is the column's Add step slot. */
export type DropRow = { row: number; last: boolean };

/**
 * A card dropped into a row of its own column: after the column's step in the
 * row above, first in the column's first row (2 for a named session), or last
 * on its Add step. Rows are read with the card lifted out, so the rows under
 * it close up. No step in the row above is a refusal: a row across sessions is
 * a wire the reader draws. Undefined when nothing moved and no wire explains
 * why — it was dropped where it already is, or nothing it waits on is drawn.
 */
export function dropInRow<T extends EditStep>(
  steps: readonly T[],
  id: string,
  drop: DropRow
): EditResult<T> | undefined {
  const step = steps.find((s) => s.id === id);
  if (!step) return { refused: 'that step is not in the draft' };
  const lane = graph.laneOf(step);
  const inLane = (s: T): boolean => graph.laneOf(s) === lane && s.id !== id;
  const lifted = removeStep(steps, id);
  const aimed = 'refused' in lifted ? steps : lifted.steps;
  const rows = graph.layout(aimed).at;
  const first = lane === graph.ARMED ? 1 : 2;
  const after = drop.last
    ? (aimed.filter(inLane).at(-1)?.id ?? null)
    : drop.row <= first
      ? null
      : aimed.find((s) => inLane(s) && rows.get(s.id)?.row === drop.row - 2)?.id;
  if (after === undefined) {
    return { refused: `Draw a wire from a row-${drop.row - 1} step to put it here.` };
  }
  const placed = placeInLane(steps, id, after);
  if ('refused' in placed || JSON.stringify(placed.steps) !== JSON.stringify(steps)) return placed;
  // Nothing moved. Say which wire holds it, unless it was dropped where it is.
  const drawn = graph.layout(steps).at;
  const at = (drawn.get(id)?.row ?? 0) + 1;
  if (at === drop.row || drop.last) return undefined;
  const holds = (step.needs ?? [])
    .filter((n) => drawn.has(n))
    .sort((a, b) => (drawn.get(b)?.row ?? 0) - (drawn.get(a)?.row ?? 0))[0];
  const name = steps.find((s) => s.id === holds)?.label?.trim() || holds;
  if (!name) return undefined;
  return { refused: `Kept in row ${at}: it waits on ${name}. Delete that wire to move it up.` };
}

/**
 * A new step right after the anchor in its lane, spliced into that lane's
 * order: it waits on the anchor, and the step that followed the anchor waits on
 * it. Appended rather than placed beside the anchor — `sortTopo` puts it after
 * the anchor, and an older step that is also ready stays ahead of it.
 */
export function insertInLane<T extends EditStep>(
  steps: readonly T[],
  id: string,
  step: T
): EditResult<T> {
  const anchor = steps.find((s) => s.id === id);
  if (!anchor) return { refused: 'that step is not in the draft' };
  const lane = graph.laneOf(anchor);
  const mates = steps.filter((s) => graph.laneOf(s) === lane);
  const nextMate = mates[mates.findIndex((s) => s.id === id) + 1];
  const created: T = clone(step);
  if (lane === graph.ARMED) delete created.lane;
  else created.lane = lane;
  created.needs = [anchor.id];

  const placed = [...steps.map(clone), created];
  const follower = nextMate && placed.find((s) => s.id === nextMate.id);
  if (follower) {
    const needs = unique(
      (follower.needs ?? []).map((need) => (need === anchor.id ? created.id : need))
    );
    if (!needs.includes(created.id)) needs.push(created.id);
    follower.needs = needs;
  }
  return { steps: sortTopo(relocateOpeners(steps, placed)) };
}

/** Every step of `from` takes the name `to`. Blank, taken, and this session
 *  are refused — this session is not a name in the file. */
export function renameLane<T extends EditStep>(
  steps: readonly T[],
  from: string,
  to: string
): EditResult<T> {
  const nextName = to.trim();
  if (namedLane(from) === undefined) {
    return { refused: 'this session is not a name in the file' };
  }
  if (nextName === '') return { refused: 'a lane needs a name' };
  if (steps.some((step) => step.lane === nextName) && nextName !== from) {
    return { refused: `${nextName} is taken — two lanes can't share a name` };
  }
  return {
    steps: steps.map((step) =>
      step.lane === from ? { ...clone(step), lane: nextName } : clone(step)
    )
  };
}

function clone<T extends EditStep>(step: T): T {
  const copy = { ...step };
  if (step.needs !== undefined) copy.needs = [...step.needs];
  return copy;
}

function unique(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

function namedLane(lane: string | undefined): string | undefined {
  return lane !== undefined && lane !== '' ? lane : undefined;
}

function needsMap(steps: readonly EditStep[]): Map<string, readonly string[]> {
  return new Map(steps.map((step) => [step.id, step.needs ?? []]));
}

/** One past the highest `session N` a step names: `session 1` and `session 3`
 *  give `session 4`. Never a gap, so names read 1, 2 … N left to right, which is
 *  the order lanes are drawn in (the user's call, 2026-10-01). */
function nextSessionName(steps: readonly EditStep[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^session (\d+)$/.exec(graph.laneOf(step));
    const n = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `session ${max + 1}`;
}

/**
 * The edit's result, or a refusal when it leaves the starting session's first
 * step waiting on a step. That step starts the run, so whatever it waits on is
 * a lane only it could open, and the run never starts. Linked, the canvas also
 * lost row 1: no step drew there (the bug of 2026-10-05). A draft that already
 * began so is left as the author wrote it, as `orderLanes` leaves a lane.
 */
function blocksStart<T extends EditStep>(before: readonly T[], after: T[]): EditResult<T> {
  const waiting = (steps: readonly T[]): T | undefined => {
    const first = steps.find((step) => graph.laneOf(step) === graph.ARMED);
    return (first?.needs ?? []).some((id) => steps.some((step) => step.id === id))
      ? first
      : undefined;
  };
  const first = waiting(after);
  if (!first || waiting(before)) return { steps: after };
  const name = first.label?.trim() || first.id;
  return { refused: `${name} would start the run, so it can wait for no step` };
}

function laneOrder<T extends EditStep>(steps: readonly T[], id: string): T[] {
  const step = steps.find((s) => s.id === id);
  if (!step) return [];
  const lane = graph.laneOf(step);
  return steps.filter((s) => graph.laneOf(s) === lane);
}

function previousInLane<T extends EditStep>(steps: readonly T[], id: string): T | undefined {
  const mates = laneOrder(steps, id);
  const at = mates.findIndex((step) => step.id === id);
  return at > 0 ? mates[at - 1] : undefined;
}

/**
 * Every lane stays one session: a step that no longer reaches the step above it
 * in its lane waits on it. The one wire the editor draws by itself, and only
 * inside a lane (the user's call, 2026-10-01). A lane `before` already had out
 * of order is left as the author wrote it (PRD §5.6) — the whole lane, since a
 * re-sort can move the gap onto its other step.
 * `after` is in topological order, so the step above is never downstream.
 */
function orderLanes<T extends EditStep>(before: readonly T[], after: T[]): T[] {
  const broken = new Set(laneGaps(before).map(([step]) => graph.laneOf(step)));
  const byNeeds = needsMap(after);
  for (const [step, above] of laneGaps(after)) {
    // An earlier join can close a later gap too.
    if (broken.has(graph.laneOf(step)) || reaches(step.needs ?? [], above, byNeeds)) continue;
    step.needs = [...(step.needs ?? []), above];
    byNeeds.set(step.id, step.needs);
  }
  return after;
}

/** Each step after its lane's first that does not reach the step above it. */
function laneGaps<T extends EditStep>(steps: readonly T[]): [T, string][] {
  const byNeeds = needsMap(steps);
  const last = new Map<string, string>();
  const gaps: [T, string][] = [];
  for (const step of steps) {
    const above = last.get(graph.laneOf(step));
    last.set(graph.laneOf(step), step.id);
    if (above !== undefined && !reaches(step.needs ?? [], above, byNeeds)) gaps.push([step, above]);
  }
  return gaps;
}

function withoutNeeds<T extends EditStep>(step: T, ids: readonly (string | undefined)[]): T {
  const copy = clone(step);
  const needs = (step.needs ?? []).filter((need) => !ids.includes(need));
  if (needs.length === 0) delete copy.needs;
  else copy.needs = needs;
  return copy;
}

function fieldsOf(step: EditStep): Pick<EditStep, OpenerField> {
  const out: Pick<EditStep, OpenerField> = {};
  for (const field of OPENER_FIELDS) {
    if (step[field] !== undefined) out[field] = step[field];
  }
  return out;
}

function hasFields(fields: Pick<EditStep, OpenerField>): boolean {
  return OPENER_FIELDS.some((field) => fields[field] !== undefined);
}

function clearFields<T extends EditStep>(step: T): void {
  for (const field of OPENER_FIELDS) delete step[field];
}

function applyFields<T extends EditStep>(step: T, fields: Pick<EditStep, OpenerField>): void {
  clearFields(step);
  for (const field of OPENER_FIELDS) {
    if (fields[field] !== undefined) step[field] = fields[field];
  }
}

/**
 * Opener fields belong to the lane. When its first step changes they move to
 * the new first; when the lane empties they go with its last step — unless it
 * lands in the armed session, which keeps none.
 */
function relocateOpeners<T extends EditStep>(before: readonly T[], after: readonly T[]): T[] {
  const lanes = new Set<string>([...before, ...after].map(graph.laneOf));
  const next = after.map(clone);
  for (const lane of lanes) {
    const oldId = graph.opener(before, lane)?.id;
    const newId = graph.opener(next, lane)?.id;
    if (oldId === undefined) continue;
    const old = before.find((step) => step.id === oldId);
    const fields = old ? fieldsOf(old) : {};
    if (!hasFields(fields)) continue;
    if (newId === undefined || newId === oldId) continue;
    const from = next.find((step) => step.id === oldId);
    const to = next.find((step) => step.id === newId);
    if (from) clearFields(from);
    if (to) applyFields(to, fields);
  }
  for (const step of next) {
    if (graph.opener(next, graph.laneOf(step))?.id !== step.id) clearFields(step);
  }
  return next;
}
