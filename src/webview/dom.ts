/**
 * The small tools every other file here builds with: element lookup, element
 * construction, and the formatters a card leans on. Primitives only —
 * anything composed out of them lives in `kit.ts`.
 *
 * The module graph's leaf: it imports nothing and runs nothing at load, so
 * any module can reach it from a top-level line.
 */

export const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing element #${id}`);
  }
  return node;
};

/** A descendant that the markup guarantees, so its absence is a bug, not a state. */
export const q = (root: HTMLElement, selector: string): HTMLElement => {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) {
    throw new Error(`missing ${selector}`);
  }
  return node;
};

/**
 * A key that belongs to an IME composition is the IME's: its Enter commits the
 * candidate, its Escape cancels the conversion, its Backspace edits it.
 * `isComposing` is the standard answer; hosts that leave it false report the
 * composing key as 229 instead, so both are asked.
 */
export const imeKey = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

/**
 * Somewhere the reader is typing: a form field, or an editor, whose key
 * arrives from its `contenteditable` root rather than from a tag.
 */
export const typingIn = (at: EventTarget | null): boolean =>
  at instanceof HTMLInputElement ||
  at instanceof HTMLTextAreaElement ||
  at instanceof HTMLSelectElement ||
  (at instanceof Element && at.closest('[contenteditable="true"]') !== null);

/**
 * The gap a layer keeps from the panel's own edges — and from its trigger.
 *
 * The clamp that spent it, `clampInset`, was here too and is gone: every
 * popover in the panel places through `ui/place.ts` now, whose `clampAxis` is
 * the same three lines with the inset passed in rather than baked, and the last
 * caller left when `tip.ts` moved. The constant stays because both call sites
 * hand it to `placeAnchored` as their `margin`.
 */
export const LAYER_INSET = 6;

/**
 * Put a freshly built stamp in place of the one on screen, unless it says the
 * same thing — in which case the node on screen is the one kept.
 *
 * Why it is worth the compare. `ago()` is seconds only under a minute; past
 * that the words change once a minute and the 1s beat has 59 nothings to do,
 * which was 20 nodes a second replaced on a 20-card board to write the same
 * string back. And a replaced node is a tip's anchor taken away — `refreshTip`
 * hides a tip whose anchor left the document, and the only reason that tip
 * survives today is the browser re-firing `mouseover` when the node under a
 * still pointer changes, landing inside `WARM_MS` so it reopens with no delay.
 * Keeping the node is what makes the tip's survival deliberate.
 */
export const swapStamp = (old: HTMLElement, next: HTMLElement): void => {
  if (old.isEqualNode(next)) return;
  old.replaceWith(next);
};

export const ago = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

/**
 * How full is too full, as a class, for a plan window — the nav bar's two
 * readings. A rate limit is only worth saying anything about near its end, so
 * there are two steps and both are late.
 */
export const pctRank = (pct: number): string => (pct > 90 ? 'full' : pct > 70 ? 'high' : '');

/**
 * The same, for a context window, which is read earlier and so warns earlier: a
 * plain traffic light at 30 and 70. Deliberately not `pctRank` — the two
 * readings are looked at in different moments and one shared rule would have to
 * be wrong for one of them.
 *
 * Green, yellow, red and no orange, though orange sits between the last two:
 * orange is what a waiting card is painted, and a bar that borrowed it would
 * put the status hue on a card that is not in that status.
 */
export const ctxRank = (pct: number): string => (pct > 70 ? 'full' : pct > 30 ? 'mid' : '');

/**
 * Time left, from epoch seconds. `Nh Nm` up to a day and `Nd Nh` past it, which
 * is the split a rate-limit window wants: the 5-hour one is read to the minute,
 * the weekly one never is. Every part carries its unit, because `3:31` on the
 * weekly row was read as three days — a colon says nothing about which two
 * units it sits between. Never counts past zero — a reset that has come and
 * gone reads as due, not as overdue, because the dump saying so is only as new
 * as the last status bar that drew it.
 */
export const until = (epochSeconds: number): string => {
  const s = Math.max(0, epochSeconds - Date.now() / 1000);
  if (s >= 86400) return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
};

/**
 * The words for a window this brand does not have. Shared because two surfaces
 * with room for the phrase print it — the nav tip and the accounts popover —
 * and one fact spelled two ways is what `until()` is next door to prevent. The
 * chip declines to call this on purpose: a one-line readout has room for
 * `none` and nothing more.
 */
export const noLimitLabel = (short: string): string => 'no ' + short + ' limit';

export const ctxLabel = (size: number): string =>
  size >= 900000 ? '1M' : size >= 1000 ? Math.round(size / 1000) + 'k' : String(size);

export const el = (tag: string, className?: string | null, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * A dot, meaning whatever the caller means by one — a session's status, a
 * ticket's priority. The CSS shares the circle and stops there, so `variant` is
 * the class that paints it and this knows none of them.
 *
 * `size` is in pixels and optional; without it the dot is the 7px `.dot`
 * defaults to. It is set as `--dot` rather than a width, so the rule keeps one
 * definition of what a dot's geometry is and callers only override the number.
 */
export const dot = (variant?: string, size?: number): HTMLElement => {
  const node = el('span', variant ? 'dot ' + variant : 'dot');
  if (size !== undefined) node.style.setProperty('--dot', size + 'px');
  return node;
};
