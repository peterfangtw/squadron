import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Box, clampAxis, placeAnchored } from '../../ui/place';

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
});

/** Typical fixed-menu call: gap 5, margin 6, end-align under a right-edge control. */
const menuOpts = {
  gap: 5,
  margin: 6,
  preferAlign: 'end' as const,
  viewport: { width: 1000, height: 800 }
};

describe('clampAxis', () => {
  it('keeps the layer inside the margin on both ends', () => {
    assert.equal(clampAxis(-10, 100, 400, 6), 6);
    assert.equal(clampAxis(500, 100, 400, 6), 400 - 100 - 6);
    assert.equal(clampAxis(50, 100, 400, 6), 50);
  });
});

describe('placeAnchored', () => {
  it('end-aligns under the trigger and opens below when there is room', () => {
    const anchor = box(900, 40, 28, 24);
    const at = placeAnchored({
      ...menuOpts,
      anchor,
      popup: { width: 200, height: 120 }
    });
    assert.equal(at.left, anchor.right - 200);
    assert.equal(at.top, anchor.bottom + 5);
    assert.equal(at.side, 'bottom');
    assert.equal(at.align, 'end');
  });

  it('start-aligns under the trigger', () => {
    const anchor = box(20, 40, 80, 24);
    const at = placeAnchored({
      ...menuOpts,
      preferAlign: 'start',
      anchor,
      popup: { width: 200, height: 120 }
    });
    assert.equal(at.left, anchor.left);
    assert.equal(at.side, 'bottom');
  });

  it('center-aligns and clamps horizontally (tip shape)', () => {
    const anchor = box(10, 40, 20, 16);
    const at = placeAnchored({
      anchor,
      popup: { width: 180, height: 40 },
      viewport: { width: 400, height: 600 },
      preferAlign: 'center',
      gap: 6,
      margin: 6
    });
    // mid of anchor is 20; 20 - 90 = -70 → clamp to margin 6
    assert.equal(at.left, 6);
    assert.equal(at.side, 'bottom');
    assert.equal(at.align, 'center');
  });

  // Normative flip: wantBelow + height + margin > vh && wantAbove >= margin
  it('flips upward when below would overflow and above has room', () => {
    const anchor = box(100, 700, 28, 24);
    // below = 729, height 120 → 729+120+6 = 855 > 800; above = 700-5-120 = 575 >= 6
    const at = placeAnchored({
      ...menuOpts,
      anchor,
      popup: { width: 200, height: 120 }
    });
    assert.equal(at.side, 'top');
    assert.equal(at.top, anchor.top - 5 - 120);
  });

  it('stays below when wantBelow + height + margin equals the viewport exactly', () => {
    // wantBelow = 100, height = 94, margin = 6 → 100+94+6 = 200 === vh → no flip
    const anchor = box(50, 90, 20, 5);
    const at = placeAnchored({
      ...menuOpts,
      viewport: { width: 400, height: 200 },
      anchor,
      popup: { width: 100, height: 94 }
    });
    assert.equal(anchor.bottom + 5 + 94 + 6, 200);
    assert.equal(at.side, 'bottom');
  });

  it('flips when wantBelow + height + margin is one past the viewport', () => {
    // Exactly-at-room used wantBelow 100 + h 94 + m 6 = 200. One past: 201.
    // wantBelow = 110; height 85; margin 6 → 201; above = 100-5-85 = 10 >= 6
    const anchor = box(50, 100, 20, 5);
    assert.equal(anchor.bottom + 5 + 85 + 6, 201);
    const at = placeAnchored({
      ...menuOpts,
      viewport: { width: 400, height: 200 },
      anchor,
      popup: { width: 100, height: 85 }
    });
    assert.equal(at.side, 'top');
  });

  it('does not flip when above would also sit under the margin', () => {
    // Trigger near the top: above has no room, so stay below even if tight.
    const anchor = box(100, 4, 28, 20);
    const at = placeAnchored({
      ...menuOpts,
      viewport: { width: 1000, height: 100 },
      anchor,
      popup: { width: 200, height: 80 }
    });
    // wantAbove = 4 - 5 - 80 = -81 < 6 → no flip
    assert.equal(at.side, 'bottom');
  });

  it('gives up height below the trigger when neither side fits and below is roomier', () => {
    // The settings dialog's model menu: a row mid-panel, a 420px menu.
    const anchor = box(260, 246, 400, 54);
    const at = placeAnchored({
      ...menuOpts,
      viewport: { width: 1000, height: 600 },
      anchor,
      popup: { width: 220, height: 420 }
    });
    // below: 600 - 6 - 305 = 289; above: 246 - 5 - 6 = 235
    assert.equal(at.side, 'bottom');
    assert.equal(at.top, anchor.bottom + 5);
    assert.equal(at.maxHeight, 289);
  });

  it('gives up height above the trigger when that side is roomier', () => {
    const anchor = box(100, 40, 28, 24);
    const at = placeAnchored({
      ...menuOpts,
      viewport: { width: 1000, height: 100 },
      anchor,
      popup: { width: 200, height: 200 }
    });
    // below: 100 - 6 - 69 = 25; above: 40 - 5 - 6 = 29
    assert.equal(at.side, 'top');
    assert.equal(at.top, 6);
    assert.equal(at.maxHeight, 29);
  });

  it('states no cap when one side holds the whole popup', () => {
    const at = placeAnchored({
      ...menuOpts,
      anchor: box(900, 40, 28, 24),
      popup: { width: 200, height: 120 }
    });
    assert.equal(at.maxHeight, undefined);
  });

  it('clamps end-align that would hang off the right edge', () => {
    const anchor = box(950, 40, 40, 24);
    const at = placeAnchored({
      ...menuOpts,
      anchor,
      popup: { width: 300, height: 80 }
    });
    // raw left = 990 - 300 = 690; max = 1000 - 300 - 6 = 694 → no clamp yet
    assert.equal(at.left, 690);
    // Trigger hard against the right edge: raw left = 1000 - 500 = 500 > max 494
    const flush = placeAnchored({
      ...menuOpts,
      anchor: box(960, 40, 40, 24),
      popup: { width: 500, height: 80 }
    });
    assert.equal(flush.left, 1000 - 500 - 6);
  });
});
