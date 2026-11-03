/**
 * Lazy repaint hook so board submodules can request a rebuild without importing
 * board.ts (breaks ticker/paint cycles).
 *
 * Starts as a no-op until board.ts finishes loading and calls setBoardRepaint.
 * Safe for event handlers and tickers after the bundle is up; silent if anything
 * calls repaintBoard during module init before that wire-up. Do not rely on
 * import-time side effects to paint the board.
 *
 * Cross-module cycles among board_* (card ↔ stamps ↔ nav) stay safe only while
 * those imports are used inside functions, not at module top-level init — a
 * top-level read of a cycle neighbour can TDZ.
 */
let repaint: () => void = () => {};

export function setBoardRepaint(fn: () => void): void {
  repaint = fn;
}

export function repaintBoard(): void {
  repaint();
}

/**
 * The dock's draft surface, repainted from a module that may not reach `chat.ts`.
 *
 * `board_nav.ts` is imported *by* `board.ts`, which `chat.ts` reaches through
 * `dock.ts` — so a direct import there closes a cycle at module-init time,
 * which is the one shape the H56 note says is unsafe. The board's own repaint
 * hook already solves exactly this, and this is its second hole: `main.ts`
 * wires it at load, and it is a no-op before that.
 *
 * Needed because the draft is the one surface no push repaints: the state
 * handler's `renderThread` is gated on `ui.selected`, which is null while a
 * draft is up. So a change made to a draft *outside* an event on the draft —
 * the pending timeout is the only one — has nothing else to draw it.
 */
let paintDraft: () => void = () => {};

export function setDraftRepaint(fn: () => void): void {
  paintDraft = fn;
}

export function repaintDraft(): void {
  paintDraft();
}
