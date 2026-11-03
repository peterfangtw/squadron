/**
 * The graph a workflow draws as, derived from the steps — and the file's
 * `lanes`, for column order — and from nothing else.
 *
 * Two numbers place a node: **its tier is when, its lane is who**. Both are
 * computed here rather than stored, which is PRD A4 — a file a person wrote by
 * hand has to open identically to one the canvas drew, and a coordinate in the
 * file would make the canvas the author of record. The same argument retires a
 * badge numbered in file order: a `3` on a step that can run at the same time as
 * the `2` above it states an order the file never did.
 *
 * Three questions are answered here, and the arithmetic behind them is private
 * so no caller grows a copy of it: `needsOf` (which wires resolve), `opener`
 * (which step opens a lane — the one place that rule lives) and `layout` (where
 * the canvas puts everything). `wfgraph.ts` builds the canvas from `layout`.
 *
 * **Import-free, deliberately.** The webview bundle takes the import-free
 * `core/` leaves: `tokens`, `markers`, and this file. `authoring.ts` may import
 * this and nothing else, for the same reason — a dependency would push it out
 * of the bundle. Anything here that grew one would have to move to `ui/`,
 * which is where `wfroute.ts` already sits: an SVG path is presentation and
 * this is not.
 */

/**
 * What a canvas needs to know about one step. A subset of the authored step on
 * purpose: this module has no opinion about prompts, outputs or checks, and a
 * type that named them would have to change every time one of them did.
 */
export type GraphStep = {
  id: string;
  /**
   * The session it runs in. **Absent means the armed one** — the session the
   * reader started the workflow in, which is a worker like any other and not a
   * spine that waits.
   */
  lane?: string;
  /** Absent or empty waits for nothing. */
  needs?: readonly string[];
  /** The glyph, and **not** what decides a model chip — see `opener`. */
  kind?: 'step' | 'fanout' | 'converge' | 'calls';
};

/** The armed session's lane id. Empty rather than a word, so no authored lane
 *  can collide with it and no file has to spell it to mean the default. */
export const ARMED = '';

export const laneOf = (x: { readonly lane?: string }): string => x.lane ?? ARMED;

/**
 * Whether any step runs outside the armed session. A run asks it to decide
 * whether it may need another session's record, or the board, at all: a
 * one-session run reads neither.
 */
export const hasLanes = (steps: readonly GraphStep[]): boolean =>
  steps.some((s) => laneOf(s) !== ARMED);

/**
 * Each step's `needs`, kept to the ids `steps` holds, once each, in the order
 * written. A need naming a step that is gone resolves to nothing rather than
 * waiting forever. A self-need is kept: it is an id the list holds. A
 * duplicated id maps to its last copy's needs — `validate` refuses the file,
 * and a draft that has one draws that copy's wires on both.
 */
export const needsOf = (steps: readonly GraphStep[]): ReadonlyMap<string, readonly string[]> => {
  const ids = new Set(steps.map((s) => s.id));
  return new Map(steps.map((s) => [s.id, [...new Set(s.needs ?? [])].filter((n) => ids.has(n))]));
};

/**
 * The step that opens `lane`, and so the only one that gets to choose a model:
 * the first one the file lists in it. Undefined for the armed lane and for a
 * lane no step names.
 *
 * **File order, not depth** (the user's call, 2026-10-05) — it is the step
 * save writes the opener fields to and the scheduler starts the session on. In
 * a file `validate` accepts the two agree, because a lane's steps chain; only a
 * draft with a broken chain can list a deeper step first. Of two steps of one
 * lane in one tier, likewise, the first listed opened it, and a second chip
 * would offer the same session a model twice.
 *
 * **Positional, and never `kind`.** A workflow is armed *in* a session that
 * already has a model, so the armed lane offers nothing at any depth; a control
 * restating a decision already made is one that gets undone by accident. What is
 * left is the first node of every other lane.
 *
 * The tempting shortcut is `kind === 'fanout'`, and in §3d it selects a disjoint
 * set: `impl` is the only fan-out there and it runs in the armed session, while
 * the three nodes that do open a lane are ordinary steps. Branching and opening
 * a session are different events that happen to coincide in simpler graphs.
 */
export const opener = <T extends GraphStep>(steps: readonly T[], lane: string): T | undefined =>
  lane === ARMED ? undefined : steps.find((s) => laneOf(s) === lane);

/** Where the canvas puts one step. */
export type Placed = {
  /** Depth: 0 is the run's first generation. */
  tier: number;
  /** The grid row it is drawn on, 0-based. A tier is as tall as its busiest
   *  lane, so below a tall tier this runs ahead of `tier`. */
  row: number;
  /** The tier and not the line in the file. A tier of one gets no letter,
   *  because there is nothing to tell it apart from and a bare `3` reads
   *  better than a `3a` with no `3b` anywhere. */
  badge: string;
  /** It opens its lane (`opener`), and so is the one step offering a model. */
  opens: boolean;
};

export type Layout = {
  /** Lane ids in draw order: the armed session first, then the ones `order`
   *  names, then the rest by the tier they first appear in and then by file
   *  order. */
  lanes: readonly string[];
  /** By step id. A duplicated id is placed where its first copy is. */
  at: ReadonlyMap<string, Placed>;
};

/**
 * Everything the canvas places, from the steps and the file's `lanes`.
 *
 * A tier is one row **only while no session has two steps in it**. A file
 * `structuralReasons` refuses can still have two of one lane at one depth.
 * They cannot run at once, and stacking them paints the second over the
 * first — the wire handle under it could not be pressed. So a tier is as
 * tall as its busiest lane, and the k-th step of a lane within a tier sits
 * k rows down.
 */
export const layout = (steps: readonly GraphStep[], order: readonly string[] = []): Layout => {
  const byTier = tiers(steps);
  const start = rowStarts(byTier);
  const openers = new Set(steps.map((s) => opener(steps, laneOf(s))?.id));
  const at = new Map<string, Placed>();
  byTier.forEach((tier, d) => {
    const inLane = new Map<string, number>();
    tier.forEach((s, i) => {
      const k = inLane.get(laneOf(s)) ?? 0;
      inLane.set(laneOf(s), k + 1);
      if (at.has(s.id)) return;
      at.set(s.id, {
        tier: d,
        row: (start[d] ?? 0) + k,
        badge: String(d + 1) + (tier.length < 2 ? '' : letter(i)),
        opens: openers.has(s.id)
      });
    });
  });
  return { lanes: lanes(steps, order, byTier), at };
};

/** One generation. Steps that can run at once, in the order the file lists them. */
type Tier = readonly GraphStep[];

/**
 * Depth per step id: a step with no `needs` is a root — depth 0 — wherever it
 * happens to be written, and every other step is one below its deepest parent.
 * Never file order: a root written third is still tier 1.
 *
 * **A root in a named lane is depth 1.** A run opens a session only when a
 * step it waits on finishes, so the earliest such a step can ever run is the
 * second row — drawn beside step 1 it read as starting with the run (the
 * user's call, 2026-10-01). `unopenedLanes` refuses to start it until wired.
 */
const depths = (steps: readonly GraphStep[]): Map<string, number> => {
  const out = new Map<string, number>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const needs = needsOf(steps);
  // A step already on the stack scores 0, so a cycle cannot hang this walk.
  // `structuralReasons` refuses one: a `needs` that names a later step.
  const walking = new Set<string>();
  const of = (id: string): number => {
    const cached = out.get(id);
    if (cached !== undefined) return cached;
    if (walking.has(id)) return 0;
    const step = byId.get(id);
    if (!step) return 0;
    walking.add(id);
    const parents = needs.get(id) ?? [];
    const root = laneOf(step) === ARMED ? 0 : 1;
    const d = parents.length === 0 ? root : 1 + Math.max(...parents.map(of));
    walking.delete(id);
    out.set(id, d);
    return d;
  };
  for (const s of steps) of(s.id);
  return out;
};

/** Steps grouped by depth, file order within a tier. Index is the depth. */
const tiers = (steps: readonly GraphStep[]): readonly Tier[] => {
  const d = depths(steps);
  const out: GraphStep[][] = [];
  for (const s of steps) {
    const at = d.get(s.id) ?? 0;
    (out[at] ??= []).push(s);
  }
  // A cycle *does* leave a hole: the back-edge scores 0, so `1 + max(parent)`
  // can land everything at 1 and above with nothing at 0. `Array.prototype.map`
  // **skips holes and preserves them**, so the `?? []` never ran and `lanes()`
  // spread `undefined` — a blank surface where the panel should have degraded.
  // `Array.from` visits every index. `structuralReasons` refuses the cycle;
  // a draft that still has one has to draw.
  return Array.from({ length: out.length }, (_, i) => out[i] ?? []);
};

/** Base-26, so a tier wider than the alphabet keeps producing letters. The
 *  first cut was `fromCharCode(97 + i)`, which gave a 27-wide tier `2{`. */
const letter = (i: number): string =>
  (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(97 + (i % 26));

/** Lane ids in draw order — `Layout.lanes`. `order` is the file's `lanes`,
 *  which is when each was added: by tier alone an unwired new session, on row
 *  2, took the column of one opening on row 4 (the user's call, 2026-10-01:
 *  always starter, 1, 2 … N). A name no step is in is skipped. */
const lanes = (
  steps: readonly GraphStep[],
  order: readonly string[],
  byTier: readonly Tier[]
): readonly string[] => {
  const seen: string[] = [];
  // The armed lane leads when it has work, and is absent when it does not. It
  // was seeded unconditionally at first, which drew a session nobody was in: a
  // graph where every step names a lane got a ghost first column, every node
  // one column right of where it belonged, and a track spanning
  // `Infinity / -Infinity` because the lane had no steps to take a min over.
  if (steps.some((s) => laneOf(s) === ARMED)) seen.push(ARMED);
  for (const lane of order) {
    if (!seen.includes(lane) && steps.some((s) => laneOf(s) === lane)) seen.push(lane);
  }
  for (const tier of byTier) {
    for (const s of tier) {
      const lane = laneOf(s);
      if (!seen.includes(lane)) seen.push(lane);
    }
  }
  return seen;
};

/** The grid row each tier starts on: the rows of every tier before it.
 *  Why a tier can be more than one row is `layout`'s. */
const rowStarts = (byTier: readonly Tier[]): readonly number[] => {
  const start: number[] = [];
  let at = 0;
  for (const tier of byTier) {
    start.push(at);
    const per = new Map<string, number>();
    for (const s of tier) per.set(laneOf(s), (per.get(laneOf(s)) ?? 0) + 1);
    at += Math.max(1, ...per.values());
  }
  return start;
};
