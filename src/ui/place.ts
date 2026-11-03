/**
 * Pure placement for trigger-anchored popovers and nested flyouts.
 *
 * Measuring is the DOM's job (`webview/kit.ts`, `webview/tip.ts`); deciding is
 * this file's. jsdom has no layout engine, so every flip/clamp rule that
 * matters is unit-tested here rather than only in a scenario that can only say
 * "the menu exists".
 *
 * Two call shapes, one module:
 *
 * - **`placeAnchored`** — hang a panel off a trigger (fixed menus, tips). Prefer
 *   below; flip up when below would overflow and above has room; clamp both axes.
 * - **`placeFlyout`** — a menu's own submenu. Prefer left of the parent menu;
 *   fall under the row when side-by-side does not fit, and give up height
 *   rather than climb back over the parent. Nested prefs, not a second policy
 *   brain.
 *
 * Absolute in-flow menus (CSS `left:0` / `right:0` under `.fwrap`) do not call
 * here — transport, not a second algorithm. Sheets never call here.
 *
 * No import from `webview/` — pure arithmetic only. `placeAnchored` takes `gap`
 * and `margin` rather than defaulting them: both callers stated both anyway, so
 * the defaults were two numbers that could drift from the two that were used.
 * The nested flyout keeps its own 4 and 8 below.
 */

/** What a caller measures off an element — `getBoundingClientRect`'s shape,
 *  narrowed to what is read here. Viewport coordinates. */
export type Box = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

/** Where to put a nested flyout. `width` and `maxHeight` are set only by the
 *  clamped (under-row) placement — the first takes the parent's column, the
 *  second is set only when the flyout has to give up height to stay in it.
 *  Otherwise the flyout keeps its own of both. */
export type Placement = {
  left: number;
  top: number;
  width?: number;
  maxHeight?: number;
};

export type PlaceAlign = 'start' | 'end' | 'center';
export type PlaceSide = 'top' | 'bottom';

/** Gap between nested menus when side by side. */
const FLYOUT_GAP = 4;

/** How close a nested flyout may come to the panel edge. */
const FLYOUT_MARGIN = 8;

/**
 * Keep a value on an axis inside [margin, room - size - margin]. This was a
 * second copy of `webview/dom.ts`'s `clampInset`, kept because `ui/` may not
 * import webview; that one had no callers left once `tip.ts` moved here, so
 * this is the only copy now.
 */
export function clampAxis(want: number, size: number, room: number, margin: number): number {
  return Math.max(margin, Math.min(want, room - size - margin));
}

/**
 * Hang a popover off a trigger box. Normative math matches the historical fixed
 * branch of `anchorMenu` in `kit.ts` (gap 5, margin 6 for menus).
 *
 * Flip predicate (do not paraphrase at call sites):
 *   wantBelow = anchor.bottom + gap
 *   wantAbove = anchor.top - gap - height
 *   flip = wantBelow + height + margin > viewportH && wantAbove >= margin
 *   top = clamp(flip ? wantAbove : wantBelow)
 *
 * When neither side holds the whole popup it takes the roomier side and gives
 * up height (`maxHeight`) instead. Clamping it into the viewport at full height
 * slid it back up over its own trigger — the settings dialog's model menu
 * covered the row that opened it.
 */
export function placeAnchored(o: {
  anchor: Box;
  popup: { width: number; height: number };
  viewport: { width: number; height: number };
  preferAlign: PlaceAlign;
  /** Both callers state these, so neither defaults. The constant map is in
   *  `TASK_done_popover_placement.md`: menu 5/6, tip 6/6, flyout 4/8. */
  gap: number;
  margin: number;
}): { left: number; top: number; side: PlaceSide; align: PlaceAlign; maxHeight?: number } {
  const { gap, margin } = o;
  const { width, height } = o.popup;
  const vw = o.viewport.width;
  const vh = o.viewport.height;

  const wantBelow = o.anchor.bottom + gap;
  const wantAbove = o.anchor.top - gap - height;
  // Below unless below overflows and above clears the margin. A prefer-above
  // mode was written here and had no caller — every popover in this panel hangs
  // downward off a control near the top of its column, and the one that opens
  // upward (`#bottomhub`'s) is a CSS pin that never reaches this file.
  const flip = wantBelow + height + margin > vh && wantAbove >= margin;
  const roomBelow = vh - margin - wantBelow;
  const roomAbove = o.anchor.top - gap - margin;
  const capped = height > roomBelow && height > roomAbove;
  let side: PlaceSide = flip ? 'top' : 'bottom';
  if (capped) side = roomAbove > roomBelow ? 'top' : 'bottom';
  const drawn = capped ? (side === 'bottom' ? roomBelow : roomAbove) : height;
  const rawTop = side === 'bottom' ? wantBelow : o.anchor.top - gap - drawn;
  const top = clampAxis(rawTop, drawn, vh, margin);

  let rawLeft: number;
  if (o.preferAlign === 'end') {
    rawLeft = o.anchor.right - width;
  } else if (o.preferAlign === 'center') {
    rawLeft = o.anchor.left + o.anchor.width / 2 - width / 2;
  } else {
    rawLeft = o.anchor.left;
  }
  const left = clampAxis(rawLeft, width, vw, margin);

  return { left, top, side, align: o.preferAlign, ...(capped ? { maxHeight: drawn } : {}) };
}

/**
 * The flyout's place, given what everything measured.
 *
 * **The room on the left is the parent's own left edge**, and that is the only
 * horizontal measurement taken. Stating it as the board's width instead is the
 * same rule at one remove, and it is off by whatever sits between the board's
 * edge and the menu's. Asking the parent is exact.
 */
export function placeFlyout(o: {
  /** The menu the row belongs to. */
  parent: Box;
  /** The row itself — what the flyout is aligned to, and what it must not
   *  cover in the clamped placement. */
  row: Box;
  /** The flyout, measured before it is placed. */
  fly: { width: number; height: number };
  /** The panel's height, for the upward flip. */
  viewport: number;
}): Placement {
  const beside = o.parent.left >= FLYOUT_GAP + o.fly.width + FLYOUT_MARGIN;
  const left = beside ? o.parent.left - FLYOUT_GAP - o.fly.width : o.parent.left;
  // Top-aligned to the row beside it; under its bottom edge when clamped.
  const want = beside ? o.row.top : o.row.bottom;
  const room = o.viewport - FLYOUT_MARGIN - o.row.bottom;
  /**
   * Give up height rather than flip — the clamped placement only.
   *
   * Flipping means something different in each placement, and only one of them
   * is harmless. Beside the parent the flyout is in its own column, so upward
   * costs nothing. **Clamped, it is in the parent's column at the parent's
   * width**, so upward puts it over the menu's own rows — the reader loses the
   * switches above the one they are drilling into, to keep a flyout at a height
   * nobody asked for. A short scrolling menu under the row is the better trade:
   * `.fmenu` is already `overflow-y: auto`, so what this costs is a scroll.
   *
   * The floor is the row's own height, and it is measured rather than picked: a
   * gap too small to hold the row it hangs off cannot hold a menu worth opening
   * either, and below it the upward flip is still the least-bad answer. That
   * keeps the old behaviour exactly where it was the only option and takes it
   * away everywhere else — which is the case a settings menu one row taller
   * walked into, `Default model` having moved down by a row.
   */
  const capped = !beside && o.fly.height > room && room >= o.row.height;
  const flip = !capped && want + o.fly.height > o.viewport - FLYOUT_MARGIN;
  const top = flip ? o.row.top - o.fly.height : want;
  return {
    left: Math.max(FLYOUT_MARGIN, left),
    top: Math.max(FLYOUT_MARGIN, top),
    ...(beside ? {} : { width: o.parent.width }),
    ...(capped ? { maxHeight: room } : {})
  };
}
