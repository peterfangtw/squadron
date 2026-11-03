import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Box, placeFlyout } from '../../ui/place';

/** A box from a left/top/width/height, the way a rect reads. */
const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
});

/**
 * The panel as it usually is: a 1000px editor tab with a 380px dock, so the
 * board is 615. The settings menu is 268 wide, pinned to the board's right
 * edge under a gear the nav bar insets by 18px; the model row sits partway down
 * it; the flyout is 210 × 120.
 */
const roomy = {
  parent: box(615 - 18 - 268, 40, 268, 300),
  row: box(615 - 18 - 268, 140, 268, 44),
  fly: { width: 210, height: 120 },
  viewport: 800
};

describe('where the flyout goes', () => {
  it('opens left of the parent, top aligned to the row', () => {
    const at = placeFlyout(roomy);
    // Right edge on the parent's left edge, less the hairline.
    assert.equal(at.left + roomy.fly.width, roomy.parent.left - 4);
    assert.equal(at.top, roomy.row.top);
    assert.equal(at.width, undefined, 'a side-by-side flyout keeps its own width');
  });

  // The whole point of choosing left: closing the dock grows the board and
  // slides the gear right, and the pair travels rather than turning around.
  it('stays on the left when the dock closes', () => {
    const wide = { ...roomy, parent: box(1000 - 18 - 268, 40, 268, 300) };
    const at = placeFlyout(wide);
    assert.equal(at.left + wide.fly.width, wide.parent.left - 4);
  });

  // Half an editor with a wide dock: 345px of board, 268 of it the parent, so
  // there are ~70px on its left and the flyout wants 210. This is the one case
  // that misses, and it is the clamp's.
  it('drops under the row when there is no room beside the parent', () => {
    const narrow = {
      ...roomy,
      parent: box(345 - 18 - 268, 40, 268, 300),
      row: box(345 - 18 - 268, 140, 268, 44)
    };
    const at = placeFlyout(narrow);
    assert.equal(at.left, narrow.parent.left, 'not on the parent’s left edge');
    assert.equal(at.top, narrow.row.bottom, 'it covers the row it hangs off');
    assert.equal(at.width, narrow.parent.width, 'the clamp takes the parent’s width');
  });

  // 4 + 210 + 8: the hairline, the flyout, and the margin it may not cross. One
  // pixel either side, so the boundary is asserted rather than the middle of
  // each case — and asserted where the bug was, which is that a flyout with 221
  // pixels of room used to be placed beside a parent it did not fit beside and
  // then clamped back over it.
  it('takes the side-by-side placement at exactly the room it needs', () => {
    const beside = (roomLeft: number) =>
      placeFlyout({ ...roomy, parent: box(roomLeft, 40, 268, 300) }).width === undefined;
    assert.equal(beside(222), true);
    assert.equal(beside(221), false);
  });

  // What the clamp is for, stated as the thing that must never happen rather
  // than as an arithmetic boundary.
  it('never lands the flyout on top of the menu it hangs off', () => {
    for (let roomLeft = 0; roomLeft <= 400; roomLeft += 1) {
      const parent = box(roomLeft, 40, 268, 300);
      const at = placeFlyout({ ...roomy, parent, row: box(roomLeft, 140, 268, 44) });
      if (at.width !== undefined) continue;
      assert.ok(
        at.left + roomy.fly.width <= parent.left,
        `a side-by-side flyout at ${at.left} overlaps a parent at ${parent.left}`
      );
    }
  });

  // A row low in the menu leaves no room below it, so the flyout grows upward
  // instead — the same rule the bottom hub's own menu already follows.
  it('flips upward when there is no room below the row', () => {
    const low = { ...roomy, row: box(roomy.parent.left, 740, 268, 44), viewport: 800 };
    const at = placeFlyout(low);
    assert.equal(at.top + low.fly.height, low.row.top, 'its bottom edge is not on the row’s top');
  });

  // Still the answer when there is nothing under the row to give: 800 - 8 - 784
  // is 8px, which cannot hold the 44px row itself, let alone a menu.
  it('flips upward in the clamped placement when the gap is unusable', () => {
    const at = placeFlyout({
      ...roomy,
      parent: box(59, 40, 268, 300),
      row: box(59, 740, 268, 44),
      viewport: 800
    });
    assert.equal(at.width, 268, 'not the clamped placement');
    assert.equal(at.top + roomy.fly.height, 740);
    assert.equal(at.maxHeight, undefined, 'a flipped flyout keeps its own height');
  });

  /**
   * The case a settings menu one row taller walked into: room under the row,
   * just not 120px of it. Upward here would cover the parent's own switches,
   * since the clamped flyout is in the parent's column at the parent's width —
   * so it stays under the row and scrolls instead.
   */
  it('gives up height rather than climb back over the parent', () => {
    const at = placeFlyout({
      ...roomy,
      parent: box(59, 40, 268, 300),
      row: box(59, 648, 268, 44),
      viewport: 800
    });
    assert.equal(at.width, 268, 'not the clamped placement');
    assert.equal(at.top, 692, 'it left the row it hangs off');
    // 800 - 8 - 692. Enough to be worth opening — it clears the 44px row —
    // and not enough for all 120px of the flyout.
    assert.equal(at.maxHeight, 100);
  });

  // The cap is for the flyout that does not fit, and no other. One with room
  // to spare keeps its own height, 148px of gap being more than its 120.
  it('caps nothing when the flyout already fits under the row', () => {
    const at = placeFlyout({
      ...roomy,
      parent: box(59, 40, 268, 300),
      row: box(59, 600, 268, 44),
      viewport: 800
    });
    assert.equal(at.top, 644);
    assert.equal(at.maxHeight, undefined);
  });

  // Beside the parent the flyout has a column of its own, so climbing costs
  // nobody a row and there is nothing to trade away.
  it('never caps the side-by-side placement', () => {
    const at = placeFlyout({ ...roomy, row: box(roomy.parent.left, 740, 268, 44) });
    assert.equal(at.width, undefined, 'not the side-by-side placement');
    assert.equal(at.maxHeight, undefined);
  });

  // What the trade is actually for, as the thing that must never happen: a
  // clamped flyout sharing the parent's column may not be drawn over its rows.
  it('never lands a clamped flyout above the row it hangs off', () => {
    for (let rowTop = 100; rowTop <= 700; rowTop += 1) {
      const at = placeFlyout({
        ...roomy,
        parent: box(59, 40, 268, 300),
        row: box(59, rowTop, 268, 44),
        viewport: 800
      });
      if (at.maxHeight === undefined) continue;
      assert.ok(at.top >= rowTop + 44, `a capped flyout at ${at.top} is above a row at ${rowTop}`);
      assert.ok(at.top + at.maxHeight <= 800 - 8, `it ends at ${at.top + at.maxHeight}`);
    }
  });

  // Both clamps at once — a tall flyout in a short panel has nowhere to be, and
  // what it gives up is its own foot rather than its head.
  it('never hangs off the top of the panel', () => {
    const at = placeFlyout({ ...roomy, row: box(roomy.parent.left, 60, 268, 44), viewport: 150 });
    assert.equal(at.top, 8);
  });

  it('never hangs off the left of the panel', () => {
    const at = placeFlyout({ ...roomy, parent: box(0, 40, 268, 300), row: box(0, 140, 268, 44) });
    assert.equal(at.left, 8);
  });
});
