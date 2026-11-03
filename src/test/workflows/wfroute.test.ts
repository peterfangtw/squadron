import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { route } from '../../ui/wfroute';
import type { RouteEdge, RouteRect } from '../../ui/wfroute';

/**
 * The router's tests, and the only place the lane canvas's geometry is checked.
 *
 * `getBoundingClientRect` is zero in jsdom, so a path measured off a rendered
 * graph is degenerate and proves nothing. `route` is pure and takes rectangles,
 * so the rectangles are built by hand here and the DOM tests next door assert
 * structure only.
 */

/** A node box, from its left edge, top edge and size. */
const rect = (left: number, top: number, width = 196, height = 60): RouteRect => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
  cx: left + width / 2
});

const edge = (from: string, to: string): RouteEdge => ({ from, to });

const only = (nodes: [string, RouteRect][], e: RouteEdge): string => {
  const routed = route(new Map(nodes), [e], { width: 900, height: 700 });
  assert.equal(routed.paths.length, 1, 'expected exactly one path');
  return routed.paths[0]?.d ?? '';
};

/** Every number in a `d` string, in order. */
const numbers = (d: string): number[] =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

describe('the lane canvas wire router', () => {
  it('draws a straight line between two nodes in one column', () => {
    const d = only(
      [
        ['a', rect(0, 0)],
        ['b', rect(0, 94)]
      ],
      edge('a', 'b')
    );
    // A straight V and nothing else: no corner, so no quadratic.
    assert.ok(!d.includes('Q'), `expected no corner, got ${d}`);
    assert.equal(d, 'M98 60 V94');
  });

  it('treats a sub-pixel difference in centre as one column', () => {
    // Two nodes in one grid column can differ in the last place. A hairline
    // dogleg with two corners in it is worse than a line half a pixel off.
    const d = only(
      [
        ['a', rect(0, 0, 196.4)],
        ['b', rect(0, 94, 196)]
      ],
      edge('a', 'b')
    );
    assert.ok(!d.includes('Q'), `expected no corner, got ${d}`);
  });

  it('puts an elbow at the midpoint of the gap when the lane changes', () => {
    // a: rows 0–60. b: starts at 94, one lane right. The gap is 60→94, so the
    // horizontal leg belongs at 77 — every edge crossing this row boundary
    // lands on that same line and the fan-out reads as one rail.
    const d = only(
      [
        ['a', rect(0, 0)],
        ['b', rect(222, 94)]
      ],
      edge('a', 'b')
    );
    assert.ok(d.includes('Q'), 'expected corners');
    // The horizontal leg's y, which is every Q's second number and the V's
    // approach: 60 + (94 - 60) / 2.
    assert.ok(d.includes('V70'), `expected the drop to stop 7px short of 77: ${d}`);
    assert.ok(d.includes('H313'), `expected the leg to end 7px short of 320: ${d}`);
    for (const y of [...d.matchAll(/Q\S+ (\S+)/g)].map((m) => Number(m[1]))) {
      assert.equal(y, 77, `every corner sits on the midpoint of the gap: ${d}`);
    }
  });

  it('elbows leftward when the target lane is to the left', () => {
    const d = only(
      [
        ['a', rect(222, 0)],
        ['b', rect(0, 94)]
      ],
      edge('a', 'b')
    );
    // Leaving 320 for 98: the first corner steps left, not right.
    assert.ok(d.startsWith('M320 60'), d);
    assert.ok(d.includes('313 77'), `expected the corner to step left: ${d}`);
    assert.ok(d.includes('H105'), `expected the leg to stop 7px short of 98: ${d}`);
  });

  it('routes a generation-skipping edge out to a channel beside the endpoints', () => {
    // `a` is the wider of the two, so the channel is 13px past its right edge.
    const d = only(
      [
        ['a', rect(0, 0, 300)],
        ['m', rect(0, 130)],
        ['z', rect(0, 260, 196)]
      ],
      edge('a', 'z')
    );
    assert.ok(d.includes('313'), `channel at max(right) + 13 = 313: ${d}`);
    // The horizontal legs sit 14px clear of each node — 60 + 14 = 74 on the way
    // out, 260 - 14 = 246 on the way back — and the vertical legs stop 7px
    // short of each so the corner has room.
    assert.ok(d.includes('V67 Q150 74'), `leaves 14px below a: ${d}`);
    assert.ok(d.includes('V239 Q313 246'), `arrives 14px above z: ${d}`);
    assert.ok(d.endsWith('V260'), `lands on the target's top edge: ${d}`);
    // Four corners and no more: out, down, back, in.
    assert.equal([...d.matchAll(/Q/g)].length, 4, d);
  });

  it('parks the channel beside whichever endpoint is further right', () => {
    const d = only(
      [
        ['a', rect(0, 0, 196)],
        ['m', rect(0, 94)],
        ['z', rect(400, 260, 196)]
      ],
      edge('a', 'z')
    );
    assert.ok(d.includes('609'), `channel at 596 + 13: ${d}`);
  });

  it('runs a generation-skipping edge straight down when its column is empty', () => {
    // Rows 2 and 3 of the column hold no card: there is nothing to go around.
    const d = only(
      [
        ['a', rect(0, 0)],
        ['other', rect(222, 130)],
        ['z', rect(0, 260)]
      ],
      edge('a', 'z')
    );
    assert.equal(d, 'M98 60 V260');
  });

  it('elbows a lane-changing skip directly when nothing is in its way', () => {
    const d = only(
      [
        ['a', rect(222, 0)],
        ['z', rect(0, 260)]
      ],
      edge('a', 'z')
    );
    // Midway down the gap, 60 + (260 - 60) / 2 = 160; no channel past 418.
    assert.ok(d.includes('V153'), d);
    assert.ok(!d.includes('431'), `expected no channel: ${d}`);
  });

  it('sizes the viewBox from the container, not from the nodes', () => {
    // Node rects alone do not carry the container's size, which is the whole
    // reason `route` takes a box.
    const routed = route(new Map([['a', rect(0, 0)]]), [], { width: 884, height: 612 });
    assert.equal(routed.viewBox, '0 0 884 612');
    assert.equal(routed.paths.length, 0);
  });

  it('drops an edge whose endpoint is not on the canvas', () => {
    // A graph mid-edit can name a step that has just been removed. The caller
    // measures what it drew, so the router refuses rather than throwing.
    const routed = route(new Map([['a', rect(0, 0)]]), [edge('a', 'gone')], {
      width: 900,
      height: 700
    });
    assert.equal(routed.paths.length, 0);
  });

  it('starts every path on the source and ends it on the target', () => {
    // The one invariant all three shapes share: an edge leaves a node's bottom
    // edge and enters the next one's top, whatever it does in between.
    const nodes: [string, RouteRect][] = [
      ['a', rect(0, 0)],
      ['b', rect(222, 94)],
      ['c', rect(0, 94)],
      ['d', rect(444, 260)]
    ];
    for (const e of [edge('a', 'b'), edge('a', 'c'), edge('a', 'd')]) {
      const d = only(nodes, e);
      const at = numbers(d);
      assert.equal(at[0], 98, `leaves a's centre: ${d}`);
      assert.equal(at[1], 60, `leaves a's bottom: ${d}`);
      const target = new Map(nodes).get(e.to);
      assert.equal(at[at.length - 1], target?.top, `lands on the target's top: ${d}`);
    }
  });
});
