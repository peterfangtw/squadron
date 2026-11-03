/**
 * The lane canvas's wire router: two measured rectangles and an edge list in,
 * SVG path data out.
 *
 * Here and not in `core/` because an SVG `d` string is presentation, not a
 * domain rule — `src/AGENTS.md` puts "pure presentation policy" in `ui/`. It
 * stays pure so the geometry has tests: `getBoundingClientRect` is zero in
 * jsdom, so every claim about a corner or a channel is made here, against
 * hand-built rectangles, and never against a rendered graph.
 *
 * Ported from the router at the foot of `docs/mockups/build-workflow-v2-
 * directions.html` rather than re-derived. Orthogonal rails and no beziers: an
 * edge whose corners are right angles can be routed from two rectangles with no
 * layout engine, which is why no coordinate is ever authored.
 */

/** A node's box, in the container's own coordinate space. */
export type RouteRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Horizontal centre — where a wire leaves and arrives. */
  cx: number;
};

/**
 * The container's own size. Node rects alone do not carry it, and the `viewBox`
 * needs both numbers.
 */
export type RouteBox = { width: number; height: number };

/** One dependency, `from` → `to`. */
export type RouteEdge = { from: string; to: string };

export type RoutePath = { d: string };

export type Routed = { viewBox: string; paths: RoutePath[] };

/** Corner radius. Below about 5px two corners on one elbow read as a diagonal. */
const R = 7;

/**
 * How far outside a node the channel sits — the way round for an edge whose
 * direct path would cross a card.
 *
 * Beside the rightmost of the two endpoints rather than against the container's
 * edge: at board width a lane is 294px inside a much wider stage, and an edge
 * parked at the far right reads as belonging to the frame rather than to the
 * graph. For an edge inside one lane that is its own gutter; one that crosses
 * lanes parks beside whichever end is further right.
 */
const CHANNEL = 13;

/** How far below a node's bottom (and above the next one's top) an elbow sits. */
const CLEAR = 14;

/**
 * Route every edge whose endpoints are both present.
 *
 * An edge naming a node that is not on the canvas is dropped rather than
 * throwing: the caller measures what it drew, and a graph mid-edit can name a
 * step that has just been removed.
 */
export function route(
  nodes: ReadonlyMap<string, RouteRect>,
  edges: readonly RouteEdge[],
  box: RouteBox
): Routed {
  const paths: RoutePath[] = [];
  for (const edge of edges) {
    const a = nodes.get(edge.from);
    const z = nodes.get(edge.to);
    if (!a || !z) continue;
    // Around only when something is in the way. A skip was marked by depth
    // once, and went round an empty stretch of its own column (2026-10-01).
    const others = [...nodes].filter(([id]) => id !== edge.from && id !== edge.to);
    const blocked = others.some(([, r]) => directLegs(a, z).some((leg) => crosses(leg, r)));
    paths.push({ d: blocked ? channelPath(a, z) : directPath(a, z) });
  }
  return { viewBox: `0 0 ${box.width} ${box.height}`, paths };
}

/**
 * Out to the channel, down it, and back in.
 *
 * Six segments and four corners: down out of `a`, right to the channel, down
 * the channel, left to `z`'s column, then down into `z`.
 */
function channelPath(a: RouteRect, z: RouteRect): string {
  const cx = Math.max(a.right, z.right) + CHANNEL;
  const y1 = a.bottom + CLEAR;
  const y2 = z.top - CLEAR;
  return (
    `M${a.cx} ${a.bottom} V${y1 - R}` +
    ` Q${a.cx} ${y1} ${a.cx + R} ${y1}` +
    ` H${cx - R} Q${cx} ${y1} ${cx} ${y1 + R}` +
    ` V${y2 - R} Q${cx} ${y2} ${cx - R} ${y2}` +
    ` H${z.cx + R} Q${z.cx} ${y2} ${z.cx} ${y2 + R}` +
    ` V${z.top}`
  );
}

/**
 * Straight down when the two share a column, one elbow when they do not.
 *
 * The elbow sits midway down the gap between the two rows, so every horizontal
 * leg on a row boundary lands on the same line and the fan-out reads as one
 * rail rather than four near-misses.
 */
function directPath(a: RouteRect, z: RouteRect): string {
  if (oneColumn(a, z)) return `M${a.cx} ${a.bottom} V${z.top}`;
  const my = elbowY(a, z);
  const dx = z.cx > a.cx ? 1 : -1;
  return (
    `M${a.cx} ${a.bottom} V${my - R}` +
    ` Q${a.cx} ${my} ${a.cx + dx * R} ${my}` +
    ` H${z.cx - dx * R} Q${z.cx} ${my} ${z.cx} ${my + R}` +
    ` V${z.top}`
  );
}

// 2px, not 0: a node's centre is a fractional pixel and two nodes in one grid
// column can differ in the last place. A hairline dogleg with two corners in
// it is worse than a straight line that is half a pixel off.
const oneColumn = (a: RouteRect, z: RouteRect): boolean => Math.abs(a.cx - z.cx) < 2;

const elbowY = (a: RouteRect, z: RouteRect): number => a.bottom + (z.top - a.bottom) / 2;

/** A straight run from (x1, y1) to (x2, y2), one of the two equal. */
type Leg = { x1: number; y1: number; x2: number; y2: number };

/** `directPath`'s runs, corners squared off — a corner's 7px cuts nothing a card could sit in. */
function directLegs(a: RouteRect, z: RouteRect): Leg[] {
  if (oneColumn(a, z)) return [{ x1: a.cx, y1: a.bottom, x2: a.cx, y2: z.top }];
  const my = elbowY(a, z);
  return [
    { x1: a.cx, y1: a.bottom, x2: a.cx, y2: my },
    { x1: a.cx, y1: my, x2: z.cx, y2: my },
    { x1: z.cx, y1: my, x2: z.cx, y2: z.top }
  ];
}

/** Whether a run passes through a card's inside. Touching an edge is not crossing. */
function crosses(leg: Leg, r: RouteRect): boolean {
  const [x1, x2] = [Math.min(leg.x1, leg.x2), Math.max(leg.x1, leg.x2)];
  const [y1, y2] = [Math.min(leg.y1, leg.y2), Math.max(leg.y1, leg.y2)];
  return x1 < r.right && x2 > r.left && y1 < r.bottom && y2 > r.top;
}
