/**
 * The words the lane canvas draws.
 *
 * Placement is `graph.layout`. This file names each column and writes the
 * label, the description, and what a lane-opening step's model chip reads.
 */

import * as graph from '../core/workflows/graph';

export type CanvasNode = {
  id: string;
  /** Which lane — which session — this step runs in. */
  lane: string;
  /** Grid row, 0-based — past a tier taller than one row, not the tier. The
   *  badge is what a reader sees instead. */
  depth: number;
  /** `1`, `2a`, `2b`… A bare number for a tier of one, a letter when it shares. */
  badge: string;
  /** What the step is called. `label`, like the file's own step field — and
   *  never `title`, which on an HTMLElement is the native tooltip the panel
   *  draws none of (`webview/tip.ts`, and the guard in `webview.test.ts`). */
  label: string;
  description: string;
  /**
   * The model this step's session runs on, on the node `graph.opener` names
   * and on no other. Absent means no model chip.
   */
  model?: string;
  /**
   * The effort chip beside the model chip. Absent means no effort chip — a
   * model with no effort setting (Haiku), or a node that does not open a lane.
   * An unstated effort still carries the model's own default here; `stated`
   * is what makes that face dashed.
   */
  effort?: string;
  /**
   * Which of the two the file stated. False draws the dashed inherit face:
   * an unstated model reads as model/effort selection, an unstated effort as
   * the model's own default. Absent means that chip was stated.
   */
  stated?: { model?: boolean; effort?: boolean };
  /** A session's step that waits on nothing: it cannot start until a wire is
   *  drawn into it, and is drawn dashed until one is. */
  waiting?: boolean;
  /** Why the editor refused or will not save this step, a line each. The
   *  editor's to fill; `toCanvas` leaves it absent. */
  why?: string[];
  /** Whether the open node's foot offers Remove. The editor's to fill. */
  removable?: boolean;
};

/**
 * One lane's header. The column runs the full height; the header is what names
 * it, on row 1, whatever depth its first step sits at.
 */
export type CanvasTrack = {
  /** The lane id. Empty is the starting session. The same value as `file`. */
  lane: string;
  /** The file's lane. Empty is the starting session. */
  file: string;
  name: string;
  note: string;
  /** The starting session, which the file names nowhere, so it cannot be
   *  renamed. Every other lane can. */
  armed: boolean;
  /** Why a rename of this lane was refused. The editor's to fill. */
  why?: string;
};

export type CanvasGraph = {
  /** Column order: `graph.layout`'s `lanes`. */
  lanes: string[];
  tracks: CanvasTrack[];
  nodes: CanvasNode[];
  /** `[from, to]` per dependency. Derived from `needs` once `needs` exists. */
  edges: [string, string][];
  /** The one node open for editing, by id. Never an index. */
  open: string | null;
  /** A save or delete is in flight: every field and button on a node, and
   *  every Add step, is drawn disabled. */
  locked: boolean;
  /** The node just added, which plays the settle-in once. */
  enter: string | null;
};

/**
 * What a draft knows about one step before the graph places it.
 * `effortDefault` is the model's own default, carried so an unstated effort
 * can be drawn without a catalog living in `webview/`. Absent, the model
 * offers no effort and the node draws no effort chip.
 */
export type CanvasSource = {
  id: string;
  label: string;
  description: string;
  lane?: string;
  needs?: readonly string[];
  model?: string;
  effort?: string;
  effortDefault?: string;
};

const stepOf = (s: CanvasSource): graph.GraphStep => ({
  id: s.id,
  lane: s.lane,
  needs: s.needs
});

/**
 * Place every step. Chips land only where `graph.opener` says a session starts,
 * which is not `kind` and not "the step mentioned a model".
 */
export function toCanvas(
  steps: readonly CanvasSource[],
  open: string | null = null,
  order: readonly string[] = []
): CanvasGraph {
  const placed = steps.map(stepOf);
  const { lanes, at } = graph.layout(placed, order);
  const needs = graph.needsOf(placed);
  const tracks: CanvasTrack[] = lanes.map((lane) => {
    const armed = lane === graph.ARMED;
    const name = armed ? 'starting session' : lane;
    let note = 'where you start it';
    if (!armed) {
      const opener = graph.opener(placed, lane);
      note = `opens at ${opener ? (at.get(opener.id)?.badge ?? '') : ''}`;
    }
    return { lane, file: lane, name, note, armed };
  });
  const nodes: CanvasNode[] = steps.map((s) => {
    const spot = at.get(s.id);
    if (!spot) throw new Error(`missing step ${s.id}`);
    const node: CanvasNode = {
      id: s.id,
      lane: graph.laneOf(s),
      depth: spot.row,
      badge: spot.badge,
      label: s.label,
      description: s.description
    };
    if (graph.laneOf(s) !== graph.ARMED && (needs.get(s.id) ?? []).length === 0) {
      node.waiting = true;
    }
    if (!spot.opens) return node;
    const modelStated = s.model !== undefined;
    node.model = s.model ?? 'model/effort selection';
    node.stated = { model: modelStated };
    // An inherited model has no ladder to borrow a default from. A stated
    // effort under it is still legal; an unstated one draws nothing.
    if (!modelStated) {
      if (s.effort !== undefined) {
        node.effort = s.effort;
        node.stated = { model: false, effort: true };
      }
      return node;
    }
    // No default means the model offers no effort. Haiku draws the model chip
    // and nothing beside it, even when a hand-written effort is sitting there.
    if (s.effortDefault === undefined) return node;
    const effortStated = s.effort !== undefined;
    node.effort = s.effort ?? s.effortDefault;
    node.stated = { model: true, effort: effortStated };
    return node;
  });
  return {
    lanes: [...lanes],
    tracks,
    nodes,
    edges: placed.flatMap((g) => (needs.get(g.id) ?? []).map((n): [string, string] => [n, g.id])),
    open,
    locked: false,
    enter: null
  };
}
