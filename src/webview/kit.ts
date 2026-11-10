/**
 * The panel's composed controls, and the guards that go with them: `dom.ts`
 * makes elements, this assembles them, and assembled things are what a repaint
 * can damage — an open menu, a block someone is reading, a control someone is
 * pressing. `morph` is the third of those guards and the general one: it
 * repaints a container without ever replacing what is inside it.
 *
 * Nothing here runs at load, which is why the menu's document listeners are
 * registered in `main.ts` instead.
 */

import morphdom from 'morphdom';
import { placeAnchored, placeFlyout } from '../ui/place';
import { LAYER_INSET, dot, el, imeKey, typingIn } from './dom';
import * as layers from './layers';

export type DropdownTrigger = {
  wrap: HTMLElement;
  button: HTMLButtonElement;
  label: HTMLElement;
  caret: HTMLElement;
};

/** UI only: callers attach opensMenu or their own popover and keep these nodes
 *  when relabelling, so an update cannot replace the button under a press. */
export function dropdownTrigger(text: string, className = ''): DropdownTrigger {
  const wrap = el('span', 'fwrap');
  const button = el('button', 'fpill' + (className ? ` ${className}` : '')) as HTMLButtonElement;
  button.type = 'button';
  const label = el('span', 'nm', text);
  const caret = el('span', 'caret', '▾');
  button.append(label, caret);
  wrap.append(button);
  return { wrap, button, label, caret };
}

/**
 * Every icon button in the panel, and so the one place H23 moved them all at
 * once: the label goes on `data-tip` for our own hover layer instead of on
 * `title` for the host's.
 *
 * It goes on `aria-label` as well, and that is not belt-and-braces. These
 * buttons are a glyph and nothing else, so `title` was doing two jobs — the
 * hover explanation and the accessible name — and only one of them moves.
 * Dropping it without `aria-label` would leave a screen reader calling every
 * one of them "button", which is the opposite of what H23 is for.
 */
const iconEl = (markup: string, title: string): HTMLElement => {
  const button = el('button', 'icon');
  button.innerHTML = markup;
  button.dataset.tip = title;
  button.setAttribute('aria-label', title);
  return button;
};

export const iconButton = (markup: string, title: string, onClick: () => void): HTMLElement => {
  const button = iconEl(markup, title);
  button.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return button;
};

/**
 * The same button, for a surface whose clicks are delegated: it says what it
 * is rather than closing over what to do, and the listener on the container
 * reads that back. The `stopPropagation` above has no counterpart because it
 * needs none — a delegated handler resolves `[data-act]` before it resolves
 * the card around it, so a button click cannot also select the card.
 *
 * Both spellings live here because both are in use: `iconButton` serves the
 * ticket tab's head, which is not inside anything that morphs.
 */
export const iconAction = (markup: string, title: string, act: string): HTMLElement => {
  const button = iconEl(markup, title);
  button.dataset.act = act;
  return button;
};

/**
 * What a reader can land on inside an open menu. Written once because the open
 * (focus the first) and the arrow keys (walk them) both ask, and as two literals
 * they had already drifted.
 *
 * `[data-skip]` is a row drawn but not offered — a port already taken — and is
 * out of the traversal for the same reason it refuses a click.
 *
 * `.fbtn` and not `.mfoot`: `.mfoot` is also the settings menu's build stamp, a
 * `<div>` that cannot take `.focus()`, so the traversal *stalled* on it at the
 * bottom of the one menu a keyboard is likeliest to enter. One clause, because
 * every footer button in the panel is an `.fbtn`.
 *
 * `.wp` is the model menu's window pill, and `:not(.wins)` is what keeps its
 * *row* out. A `.mitem.wins` is a `role="presentation"` label holding those
 * pills — a `<div>`, so a walk that stopped on one would stall exactly the way
 * `.mfoot` did, and that is a mistake this selector has already made once.
 *
 * Not `[data-skip]` for the exclusion: at its only other call site (`picker.ts`)
 * that attribute means *unavailable*, and a live row wearing it would read as
 * disabled to whoever met it there.
 */
const MENU_ROWS = '.mitem:not([data-skip]):not(.wins), .wp, .mrow, .fbtn:not([hidden])';

/** The rows of *this* menu, and not of a menu opened from inside it. A flyout's
 *  own rows are `.mitem`s like any other, so an unfiltered walk over the parent
 *  would visit both levels as one list — stepping off the last switch straight
 *  into a model.
 *
 *  **And nothing inside a hidden box.** A row a reader cannot see is not a stop
 *  the arrows may land on — the model flyout folds a brand's older rows away
 *  behind one row, and they are hidden in place rather than removed so a fold
 *  toggle does not move the focus. `MENU_ROWS` already spells this for `.fbtn`;
 *  asking the ancestor instead covers a `.wp` inside a folded row, which no
 *  selector on the pill itself can. */
const levelRows = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>(MENU_ROWS)].filter(
    (row) => row.closest('.fmenu') === menu && row.closest('[hidden]') === null
  );

/** One open menu: what holds it, what opened it, and how to shut it. */
type OpenMenu = {
  /** The element the trigger and the menu share, and so the thing a repaint
   *  must leave alone. */
  wrap: HTMLElement;
  menu: HTMLElement;
  /** What opened it, and what the focus goes back to when it closes. */
  trigger: HTMLElement;
  close: () => void;
  /** Its place on the panel's layer stack: one entry per menu, so a flyout
   *  is above its parent and Escape takes one level. */
  layer: layers.Handle;
};

/**
 * The menus open right now, outermost first. A native `<select>` carried its
 * own menu, which the host theme could not reach inside; these are ordinary
 * elements, so the 3s state push can destroy one mid-use. Hence this handle:
 * the bar holding an open menu is held still while it is set, and only that bar
 * — the list, the stale banner and the nav bar carry on updating underneath.
 *
 * Keep menus in a stack because a settings row can open its own menu; one slot
 * would overwrite the parent and leave it uncloseable.
 */
const openMenus: OpenMenu[] = [];

/** Close all menus innermost first, after a pick or before repainting the world. */
export function closeMenu(): void {
  while (openMenus.length) {
    closeTopMenu();
  }
}

/** Close only the innermost menu; callers outside this module mean all menus. */
function closeTopMenu(): void {
  const top = openMenus.pop();
  top?.close();
  top?.layer.pop();
}

/**
 * Hold only roots containing an open menu: rebuilding detaches its trigger,
 * shuts it mid-pick and leaves an orphaned handle. A menu elsewhere must not
 * freeze this bar. Check every stack entry because an innermost-only check
 * would let a poll rebuild the bar under both menus.
 */
export function heldOpen(root: HTMLElement): boolean {
  return openMenus.some((open) => root.contains(open.wrap));
}

/**
 * The other half of the same problem: `heldOpen` asks whether someone is using
 * this, and this asks whether the picture changed — skipping the paint when it
 * did not, since the host pushes the same state every 3s and a rebuild costs
 * hover, focus and an open preview mid-read.
 *
 * Keyed by the element, the same handle `heldOpen` takes. The signature stays
 * the caller's to compose: one that misses a field paints stale, one with a
 * clock in it never stops painting. (`lastPaint`, not `painted` — `board.ts`
 * has one of those, and the bundle is a single scope.)
 */
const lastPaint = new WeakMap<HTMLElement, string>();

/**
 * The element an IME is composing in right now, if any — the third thing a
 * repaint can damage, and the one nothing else here can put back.
 *
 * A composition (注音, pinyin, kana) is browser state **held on that one
 * element**: the keystrokes are not text yet, so they are in no `value` a
 * repaint could copy across. Detach the element and the browser cancels the
 * composition and drops the buffer — which is what the ask layer did to every
 * box in it, loudest in the `Other` row, whose own `input` repaints the dialog
 * and so ate the draft on the first ㄓ. The note box beside it was no safer:
 * nothing repaints on *its* input, but the layer's signature carries every
 * request, so a second one arriving mid-composition rebuilt it too. ASCII
 * survived all of this because each keypress is committed before the rebuild and
 * `question.ts` puts the text and the caret back; a half-built 注 has nowhere to
 * be put back from.
 *
 * One element and not a count: the guard below is scoped to the container being
 * painted, so it must know *where* the composition is, and nothing may hold a
 * bar still on account of a composition somewhere else.
 *
 * `morph` needs no such guard, and that is a property of morphdom rather than
 * luck: a keyed element is the same node across paints, so the box is never
 * detached. It is not a licence either — morphdom assigns `fromEl.value` on a
 * `<textarea>` it keeps, and writing `value` under a live composition disturbs
 * the buffer. No morphed container holds one today.
 */
let composingIn: HTMLElement | undefined;

/**
 * Keep only the newest skipped paint: captured sig and paint make an
 * overwritten entry the stale one. Use Map because flushing must iterate.
 * Only #question composes inside a painted container today; per-item keys
 * would retain elements, the same trap paintIfChanged carries.
 */
const heldPaints = new Map<HTMLElement, () => void>();

/** Which box the IME is in, taken as it starts. */
export function onCompositionStart(e: Event): void {
  const at = e.target;
  // In an editor the event can come from a node inside the editing root, and
  // the root is what holds the focus.
  composingIn =
    at instanceof HTMLElement
      ? (at.closest<HTMLElement>('[contenteditable="true"]') ?? at)
      : undefined;
}

/**
 * The hold released, and every paint it caught run at once.
 *
 * `compositionend` fires after the composed text has landed in the box, so this
 * paints what was typed rather than what was pending. Run now rather than left
 * to the next poll because a held paint is what draws the CTA those words just
 * enabled, and three seconds of a dead button reads as a box that took nothing.
 */
export function onCompositionEnd(): void {
  composingIn = undefined;
  const flush = [...heldPaints.values()];
  heldPaints.clear();
  for (const paint of flush) paint();
}

/**
 * Whether a repaint of `root` would cancel a composition: the box being composed
 * in is inside it. Scoped like `heldOpen`, and for the same reason — a
 * composition in the dock's composer must not freeze the board.
 *
 * **The focus clause is what makes a lost `compositionend` harmless**, and this
 * is a hold only an event releases: without it, a composition abandoned rather
 * than committed — the layer hidden from under it, focus moved by a push — would
 * freeze its container for the life of the webview. A composition can only be
 * live in the focused element, so focus having moved means it committed or was
 * cancelled either way, and holding on its account is wrong by definition. A
 * detached box is covered twice over, since `contains` refuses one too.
 */
function composing(root: HTMLElement): boolean {
  return !!composingIn && composingIn === document.activeElement && root.contains(composingIn);
}

export function paintIfChanged(root: HTMLElement, sig: string, paint: () => void): void {
  if (lastPaint.get(root) === sig) return;
  // Leave a held paint's signature unrecorded: recording a paint that never ran
  // would leave it stale indefinitely while polls keep pushing the same state.
  if (composing(root)) {
    heldPaints.set(root, () => paintIfChanged(root, sig, paint));
    return;
  }
  lastPaint.set(root, sig);
  paint();
}

/**
 * What a node is, for a morph: a keyed node is the same element across paints
 * wherever the key matches, so the node under the pointer is still there when
 * the pointer comes up.
 *
 * `data-key` and not the `data-pid`/`data-tid` the handlers read: morphdom's key
 * map is one flat map over the whole tree, and an waiting pill carries a pid too,
 * so a chip and a card sharing a key could be morphed into each other's place.
 * Keys are namespaced by what they name (`ask:`, `count:`, `tk:`) for that
 * reason; the id fallback is morphdom's own default.
 *
 * **Everything a press can rest on needs one** — every `data-act` node, the rows
 * and slots around them, anything holding a closure. An unkeyed acting node does
 * not lose the click landing on it, it hands that click to whatever slid into
 * its place: a press aimed at "Open terminal" that stops the session.
 *
 * Unkeyed matches positionally, which is right for headings, grids and label
 * spans. morphdom calls this on text nodes too, hence the element check.
 */
const nodeKey = (node: Node): string | undefined =>
  node instanceof HTMLElement ? (node.dataset.key ?? (node.id || undefined)) : undefined;

/**
 * Repaint a container's children without replacing them. The caller builds nodes
 * exactly as it did for `replaceChildren`; they are staged out of document and
 * morphdom rewrites in place whatever differs.
 *
 * This is what makes a delegated click enough: a replaced node is detached, so
 * the click dispatches on the container and `closest('[data-act]')` resolves
 * nothing. Keep the node and the click keeps its subject.
 *
 * `childrenOnly`, so `root` — where every delegated listener is registered — is
 * left alone. `keep` is morphdom's `onBeforeElUpdated`.
 */
export function morph(
  root: HTMLElement,
  nodes: HTMLElement[],
  keep?: (from: HTMLElement, to: HTMLElement) => boolean
): void {
  const staging = el('div');
  staging.append(...nodes);
  morphdom(root, staging, { childrenOnly: true, getNodeKey: nodeKey, onBeforeElUpdated: keep });
}

/**
 * Unlike morph's childrenOnly, update the card itself because status, closing
 * and selection live in its class. Use card() as the one description so a new
 * field updates on the clock without a second enumeration.
 */
export function morphNode(
  node: HTMLElement,
  next: HTMLElement,
  keep?: (from: HTMLElement, to: HTMLElement) => boolean
): void {
  morphdom(node, next, { getNodeKey: nodeKey, onBeforeElUpdated: keep });
}

/**
 * Use the cards' coloured dot for variant so priority rows and tickets share
 * a mark. It adds a lead column: a one menu would have two left edges; only
 * the multi-select priority picker spends it today (css/tickets.ts), with a
 * checkbox already in front.
 */
export function menuItem(
  label: string,
  selected: boolean,
  kind: 'one' | 'many',
  onPick: () => void,
  variant?: string
): HTMLElement {
  const item = el('button', 'mitem' + (kind === 'one' ? ' pick' : '') + (selected ? ' on' : ''));
  // Only `many` gets a lead column. A checkbox is a control the reader operates,
  // drawn whether or not the row is on, so its column is never empty. A tick is
  // a receipt, and reserving 20px for one that is absent on every row but one
  // put the labels 20px right of the footer's buttons — three left edges in one
  // menu. `one` says which row is picked by filling it, in `tickets.ts`.
  if (kind === 'many') item.append(el('span', 'cbox'));
  if (variant !== undefined) item.append(dot(variant));
  item.append(el('span', 'nm', label));
  // The role has to come with them: `aria-checked` and `aria-selected` mean
  // nothing on a plain button, and the tick beside the label is only paint.
  item.setAttribute('role', kind === 'many' ? 'menuitemcheckbox' : 'menuitemradio');
  item.setAttribute('aria-checked', String(selected));
  item.onclick = onPick;
  return item;
}

/**
 * Flip the switch before the host answers because heldOpen prevents the state
 * echo from repainting this menu; waiting would look broken until it closed.
 * Put tag inside .t so it wraps with the label, not below it; switchLabel
 * (test/harness.ts) must read the same shape.
 */
export function switchRow(
  label: string,
  detail: string | HTMLElement | undefined,
  on: boolean,
  onFlip: (next: boolean) => void,
  tag?: string,
  role: 'menuitemcheckbox' | 'switch' = 'menuitemcheckbox'
): HTMLElement {
  const row = el('button', 'mrow');
  const text = el('span', 'txt');
  const name = el('span', 't', label);
  if (tag !== undefined) name.append(el('span', 'tag', tag));
  text.append(name);
  if (detail !== undefined)
    text.append(typeof detail === 'string' ? el('span', 'd', detail) : detail);
  const knob = el('i', on ? 'sw on' : 'sw');
  row.append(text, knob);
  row.setAttribute('role', role);
  row.setAttribute('aria-checked', String(on));
  row.onclick = () => {
    // A refusing row stays focusable so its reason is read; only the press is
    // dead. Read at the press, since a repaint may refuse or free it.
    if (row.getAttribute('aria-disabled') === 'true') return;
    const next = !knob.classList.contains('on');
    knob.classList.toggle('on', next);
    row.setAttribute('aria-checked', String(next));
    onFlip(next);
  };
  return row;
}

/**
 * A control on a dialog whose decision is already on its way: dead, and saying
 * so where the press was made.
 *
 * One rule for every dialog control, because they share one gap: the response
 * goes straight onto the pipe, but the refresh behind it takes about a second,
 * and until the push lands the dialog is still on screen. A live control there
 * reads as a button that did nothing, and a second press posts a second response
 * against an answered request.
 *
 * Only where `sent` and `at` agree does a button claim the decision — an
 * `Always allow` reading "Sending…" because `Deny` was pressed would name the
 * wrong answer. A control with no `at` can never claim one, by construction.
 */
export function awaiting(button: HTMLButtonElement, sent: string | undefined, at?: string): void {
  if (!sent) return;
  button.disabled = true;
  button.classList.add('away');
  if (sent === at) button.textContent = 'Sending…';
}

/**
 * Place an open menu against the trigger it hangs off. The edge it anchors to
 * is the caller's — `end` for a control at the right-hand end of a bar.
 *
 * **Fixed menus** use pure `placeAnchored` in `ui/place.ts` (flip + clamp on
 * both axes). **Absolute menus** keep CSS edge pins under `.fwrap` so a
 * zero-width open frame still hangs (accounts rationale) — transport, not a
 * second policy. See H58 / `TASK_done_popover_placement.md`.
 */
function anchorMenu(
  wrap: HTMLElement,
  menu: HTMLElement,
  align: 'start' | 'end',
  fixed = false
): void {
  // Trigger is a tighter anchor than wrap when the wrap once held a portalled
  // menu or other siblings; prefer the control the reader pressed when present.
  const trigger = wrap.querySelector<HTMLElement>('[aria-haspopup="menu"]');
  const anchor = (trigger ?? wrap).getBoundingClientRect();
  // offsetWidth, not a rect: the bottom hub's menu opens with a scale, and a
  // rect read on the frame it unhides is the scaled width — a menu measured 4%
  // narrow than it lands is one the clamp lets past the panel's edge.
  // Force a layout pass so a just-unhidden / just-portalled menu is not
  // measured as 0 (which collapses end-align to the left inset).
  // A cap left by the last open would be what `offsetHeight` reports, and the
  // menu would stay squeezed however much room this open has.
  if (fixed) menu.style.maxHeight = '';
  void menu.offsetHeight;
  const width = menu.offsetWidth || menu.getBoundingClientRect().width;
  if (fixed) {
    if (width <= 0) return;
    const height = menu.offsetHeight;
    const at = placeAnchored({
      anchor: {
        left: anchor.left,
        right: anchor.right,
        top: anchor.top,
        bottom: anchor.bottom,
        width: anchor.width,
        height: anchor.height
      },
      popup: { width, height },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      },
      preferAlign: align,
      // gap 5 and margin 6 (LAYER_INSET) are placeAnchored defaults matching
      // the historical fixed-menu branch.
      gap: 5,
      margin: LAYER_INSET
    });
    menu.style.left = at.left + 'px';
    menu.style.right = 'auto';
    menu.style.top = at.top + 'px';
    menu.style.maxHeight = at.maxHeight === undefined ? '' : at.maxHeight + 'px';
    return;
  }
  // Absolute menus live inside `.fwrap`. `end` is CSS `right: 0` against the
  // wrap — not a measured left — so a wide menu (accounts 316px) hangs under a
  // narrow trigger without needing a correct offsetWidth on the open frame.
  // `start` clears any prior end from a morph reuse of the same node.
  if (align === 'end') {
    menu.style.left = 'auto';
    menu.style.right = '0';
  } else {
    menu.style.right = 'auto';
    menu.style.left = '0';
  }
}

/**
 * Pass placement and focus as callbacks so pills, the gear and submenu rows
 * share the toggle and repaint guard instead of branching by control.
 */
function wireMenu(o: {
  wrap: HTMLElement;
  trigger: HTMLElement;
  menu: HTMLElement;
  fill: (menu: HTMLElement) => void;
  place: (menu: HTMLElement) => void;
  focus: (menu: HTMLElement) => HTMLElement | null;
  /** A class the trigger wears while its menu stands open, for a trigger whose
   *  `aria-expanded` has nothing painted on it. */
  lit?: string;
  /**
   * Move the menu out of clipping ancestors while it stands open, and put it back in
   * its wrap when it shuts. For a `position: fixed` menu, and it is what makes
   * that word mean anything — see `opensMenu`.
   */
  portal?: boolean;
}): void {
  o.trigger.setAttribute('aria-expanded', 'false');
  o.trigger.setAttribute('aria-haspopup', 'menu');

  // Closing only closes. Rebuilding the bar here would detach the very trigger
  // whose click handler is running — leaving the handle pointing at orphans,
  // which held the bar frozen for good. The next state push repaints it, and
  // `wantFilter` means that paint already shows the pick.
  //
  // How soon that push comes moved, and this is the surface that pays for it.
  // The 1s beat used to call `renderBoard`, so "the next push" was in practice
  // within a second and free; it ticks stamps now, and an idle board's next
  // push is the host's 15s floor. A status that changed while the menu was open
  // — `heldOpen` skips this subtree on the push that carries it — can therefore
  // sit unshown for that long after the menu closes. Self-healing and cosmetic,
  // but no longer immediate. See `UNCHANGED_MS` in `host/panel.ts`.
  const close = (): void => {
    o.menu.hidden = true;
    o.menu.replaceChildren();
    o.trigger.setAttribute('aria-expanded', 'false');
    if (o.lit) o.trigger.classList.remove(o.lit);
    // Return the menu to .fwrap because readers expect both halves there and a
    // wrap morphed away must take its menu into garbage rather than leak it.
    if (o.portal) o.wrap.append(o.menu);
  };

  o.trigger.onclick = () => {
    // Re-clicking a trigger closes it and its descendants, rather than reopening.
    const at = openMenus.findIndex((open) => open.wrap === o.wrap);
    if (at !== -1) {
      while (openMenus.length > at) {
        closeTopMenu();
      }
      return;
    }
    // Close sibling menus but keep ancestors: the submenu's parent must stay,
    // while another pill's menu goes. This is what makes the stack a stack.
    while (openMenus.length && !openMenus[openMenus.length - 1]?.menu.contains(o.wrap)) {
      closeTopMenu();
    }
    o.fill(o.menu);
    // Portal before unhide so place measures the menu where it will be drawn.
    if (o.portal) (o.wrap.closest('dialog[open]') ?? document.body).append(o.menu);
    o.menu.hidden = false;
    o.trigger.setAttribute('aria-expanded', 'true');
    if (o.lit) o.trigger.classList.add(o.lit);
    openMenus.push({
      wrap: o.wrap,
      menu: o.menu,
      trigger: o.trigger,
      close,
      layer: layers.push({
        kind: 'menu',
        // Shut from the top down to this one: a parent never closes under an
        // open flyout.
        close: () => {
          const at = openMenus.findIndex((open) => open.menu === o.menu);
          while (at !== -1 && openMenus.length > at) closeTopMenu();
        },
        escape: () => {
          if (openMenus[openMenus.length - 1]?.menu !== o.menu) return false;
          closeTopMenu();
          o.trigger.focus();
          return true;
        },
        root: () => [o.wrap, o.menu]
      })
    });
    o.place(o.menu);
    // Portalled menus can measure `offsetWidth` as 0 (or a wrong box) on the
    // same turn they leave `display: none` and land on `body`. A second place
    // after layout keeps `end` alignment under a right-of-bar control (accounts
    // lim was landing at left: inset with a zero-width measure).
    if (o.portal) {
      requestAnimationFrame(() => {
        if (!o.menu.hidden && openMenus.some((open) => open.menu === o.menu)) {
          o.place(o.menu);
        }
      });
    }
    o.focus(o.menu)?.focus();
  };
}

/** Fill on every open so selections cannot be stale and closed triggers cost nothing. */
export function opensMenu(
  wrap: HTMLElement,
  trigger: HTMLElement,
  align: 'start' | 'end',
  fill: (menu: HTMLElement) => void,
  /**
   * Take the menu out of its ancestors' overflow, at the cost of a placement
   * that does not follow a scroll.
   *
   * A menu opened from inside a card sits inside two boxes that hide their
   * overflow (`.card`, `.specs`), so absolute draws it cut off at the card's
   * edge. And `position: fixed` alone is not enough — an ancestor claims the
   * containing block by setting `transform`, `filter`, `perspective`,
   * `will-change` or `contain: layout`, which `#bottomhub`, `#picker` and
   * `#runsheet` all do to centre themselves. The full matrix, including what
   * does *not* catch: `docs/reference/z_index.md`.
   *
   * Portal to the open dialog when present: body children cannot rise above
   * a native dialog’s top layer. Otherwise portal to `document.body`.
   *
   * jsdom lays nothing out, so `test/containment.test.ts` reads the stylesheet
   * against the real ancestor chain instead — the only place this is checked.
   *
   * Only for a trigger inside a clipping box. A bar's own menu stays absolute:
   * fixed would leave it behind when the board scrolls.
   */
  fixed = false
): HTMLElement {
  const menu = el('div', 'fmenu' + (fixed ? ' floating' : ''));
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  wireMenu({
    wrap,
    trigger,
    menu,
    fill,
    place: () => anchorMenu(wrap, menu, align, fixed),
    focus: (m) => m.querySelector<HTMLElement>(`.fsearch, ${MENU_ROWS}`),
    portal: fixed
  });
  return menu;
}

/**
 * A menu's search band: the box that stays put while the list under it scrolls.
 *
 * Two menus grow one — every filter pill's (`picker.ts`) and the model
 * flyout's — and they had already drifted on whether it carries an accessible
 * name. That is not a preference to leave to each: a field with no label is
 * announced as "edit text", and a placeholder is not one, so the caller states
 * the wording once and it lands in both places.
 *
 * The needle is trimmed and folded here rather than in each `paint`, because
 * both callers matched case-insensitively and one of them doing it differently
 * is the next thing to drift.
 */
export function searchBox(
  placeholder: string,
  onNeedle: (needle: string) => void
): HTMLInputElement {
  const box = el('input', 'fsearch') as HTMLInputElement;
  box.placeholder = placeholder;
  box.setAttribute('aria-label', placeholder);
  box.oninput = () => onNeedle(box.value.trim().toLowerCase());
  return box;
}

export function drillRow(o: {
  label: string;
  detail: string;
  value: string;
  fill: (menu: HTMLElement, done: (label: string) => void) => void;
}): HTMLElement {
  const wrap = el('div', 'mwrap');
  const row = el('button', 'mrow');
  const text = el('span', 'txt');
  text.append(el('span', 't', o.label), el('span', 'd', o.detail));
  const value = el('span', 'val', o.value);
  value.append(el('i', 'into'));
  row.append(text, value);
  const menu = el('div', 'fmenu fly');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  wrap.append(row, menu);

  const done = (picked: string): void => {
    // Both children restated, rather than the text node rewritten in place: an
    // `el()` given an empty string sets `textContent` and so creates *no* text
    // node, which left `firstChild` pointing at the chevron — and a row whose
    // value happened to be empty would have had its label written into it.
    value.replaceChildren(picked, el('i', 'into'));
    closeTopMenu();
    row.focus();
  };

  wireMenu({
    wrap,
    trigger: row,
    menu,
    lit: 'drilled',
    fill: (m) => o.fill(m, done),
    place: (m) => anchorFlyout(wrap, m),
    // Fixed, so portalled. No ancestor of this flyout traps it today — `#board`
    // is a query container, which catches nothing — so this buys nothing now
    // and costs nothing; it is what keeps the drill row correct if it is ever
    // opened from inside a centred box. See `opensMenu`'s note.
    portal: true,
    // Focus the chosen value so the reader need not walk back to it. .wp.on must
    // lead because model rows have no .on and would fall through to the first pill;
    // .mitem.on still names the chosen row in other menus. Both cannot match here.
    // Search comes first, as in opensMenu: a searchable menu is reached by typing,
    // and the chosen row is one ArrowDown away. One selector uses document order
    // because the search band is above the list.
    focus: (m) =>
      m.querySelector<HTMLElement>('.fsearch, .wp.on, .mitem.on') ??
      m.querySelector<HTMLElement>(MENU_ROWS)
  });
  return wrap;
}

/**
 * Put the flyout where `ui/place.ts` says. Everything measured here, everything
 * decided there — jsdom has no layout engine, so a rule left in this function is
 * a rule no scenario can assert.
 *
 */
function anchorFlyout(wrap: HTMLElement, menu: HTMLElement): void {
  const parent = wrap.closest<HTMLElement>('.fmenu');
  const row = wrap.querySelector<HTMLElement>('.mrow');
  if (!row) return;
  if (!parent && wrap.closest('dialog')) {
    // The value and its caret sit at the row's right end, so the menu hangs
    // from there; start-aligned it landed under the label.
    anchorMenu(wrap, menu, 'end', true);
    wrap.closest('.settings-page')?.addEventListener(
      'scroll',
      () => {
        if (openMenus[openMenus.length - 1]?.menu === menu) closeTopMenu();
      },
      { once: true }
    );
    return;
  }
  if (!parent) return;
  // Cleared before it is measured, and that order is the whole of it: this node
  // is reused across opens, so a cap left by the last one would be what
  // `offsetHeight` reports — the flyout would be measured at the height it was
  // squeezed to, decide it fits, and stay squeezed for the rest of the session
  // however much room the next row has.
  menu.style.maxHeight = '';
  const at = placeFlyout({
    parent: parent.getBoundingClientRect(),
    row: row.getBoundingClientRect(),
    // offsetWidth for the same reason `anchorMenu` reads it: a rect taken on
    // the frame a menu unhides can be a transformed one.
    fly: { width: menu.offsetWidth, height: menu.offsetHeight },
    viewport: document.documentElement.clientHeight
  });
  // Viewport coordinates, straight through: the flyout is `position: fixed`
  // rather than absolute, because its parent's `overflow-y: auto` clips
  // anything placed outside its box — and the flyout's whole placement is
  // outside it.
  menu.style.left = at.left + 'px';
  menu.style.top = at.top + 'px';
  // Only the clamped placement states one; side by side, the flyout keeps the
  // width its own rows gave it.
  menu.style.width = at.width === undefined ? '' : at.width + 'px';
  // And only when that placement had to give height up. Inline, so it beats
  // `.fmenu`'s own cap rather than joining it.
  menu.style.maxHeight = at.maxHeight === undefined ? '' : at.maxHeight + 'px';

  // The parent scrolls now (`.smenu:not(.accts)`, css/tickets.ts) and this
  // flyout is `position: fixed`, so a wheel over the settings menu slides the
  // row out from under a flyout that stays exactly where it was placed. Shut it
  // rather than chase it: re-placing on every scroll frame is a menu that walks
  // up the panel, and a reader who scrolls is looking for a different row
  // anyway.
  //
  // The guard is idempotence, not tidiness. One listener is added per open and
  // the flyout node is reused across them, so a reader who opens and shuts the
  // same drill row five times before scrolling has five of these waiting — and
  // five bare `closeTopMenu()` calls would take the settings menu down with the
  // flyout. Asking whether this menu is still the top one is true for exactly
  // the first of them. `once`, so the rest go with that scroll either way.
  parent.addEventListener(
    'scroll',
    () => {
      if (openMenus[openMenus.length - 1]?.menu === menu) closeTopMenu();
    },
    { once: true }
  );
}

/* `filterPill` used to live here: a pill, a caret, and a `relabel` handed to
   whoever filled its menu. Every caller had to write the menu body itself, and
   the two that existed had already drifted on what a re-click meant. `picker.ts`
   took the shape as a spec instead and absorbed the pill with it. */

/**
 * Left closes one level, as Escape does on the layer stack, because leaving a
 * flyout means leaving that model pick, not settings. Left/right perform those
 * moves only in nested menus; top-level Left has no parent to return to.
 */
export function onMenuKey(e: KeyboardEvent): void {
  if (imeKey(e)) return;
  const top = openMenus[openMenus.length - 1];
  if (!top) return;
  // Caret keys belong to editable fields.
  const typing = typingIn(document.activeElement);
  if (
    e.key === 'ArrowLeft' &&
    (openMenus.length > 1 || top.menu.classList.contains('fly')) &&
    !typing
  ) {
    e.preventDefault();
    e.stopPropagation();
    closeTopMenu();
    top.trigger.focus();
    return;
  }
  // Into a row's own menu, landing on whatever it has ticked. Enter does this
  // as well and needs no code: the row is a button, so it is already a click.
  //
  // No `typing` guard here, and it needs none: this acts only on an element
  // carrying `aria-haspopup="menu"`, which a field never does.
  if (e.key === 'ArrowRight') {
    const on = document.activeElement;
    if (
      on instanceof HTMLElement &&
      on.getAttribute('aria-haspopup') === 'menu' &&
      top.menu.contains(on)
    ) {
      e.preventDefault();
      on.click();
    }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = levelRows(top.menu);
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  (rows[at + step] ?? rows[step === 1 ? 0 : rows.length - 1])?.focus();
}

/**
 * A click away closes the innermost menu — and *away* means outside every menu in
 * the stack. A click on a model row is inside the flyout and outside the settings
 * menu's box, so asking only about the outermost one took the flyout down and
 * landed the pick on a menu already gone.
 *
 * The menu is asked as well as the wrap, because a portalled one is a child of
 * `document.body` while open (see `opensMenu`) — a wrap-only test would read
 * every click on its own rows as a click away. A press in a layer opened above
 * the innermost menu is not away either: it is that layer's.
 */
export function onMenuBlur(e: MouseEvent): void {
  const top = openMenus[openMenus.length - 1];
  if (!top || layers.above(top.layer, e)) return;
  const at = e.target as Node;
  if (openMenus.some((open) => open.wrap.contains(at) || open.menu.contains(at))) return;
  closeTopMenu();
}

/** What the board slides, and how long for. The easing is `css/shell.ts`'s. */
const SLIDES = '.card, .fam';
const SLIDE_MS = 320;
const SLIDE_EASE = 'cubic-bezier(.2,.7,.25,1)';

/**
 * A box's position inside `host`, in the scroller's own coordinates rather than
 * the viewport's — so a re-slot that also changes `scrollHeight` does not read
 * as every card having moved. `getBoundingClientRect` includes any transform
 * currently on the element, which is what makes an interrupted slide continue
 * from where it visually is rather than jumping back to its layout position.
 */
function boxIn(node: HTMLElement, host: HTMLElement): [number, number] {
  const r = node.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return [r.left - h.left + host.scrollLeft, r.top - h.top + host.scrollTop];
}

/**
 * The board's re-slot, animated **in the page**: measure, repaint, invert with a
 * transform, transition it away. FLIP, and the four letters are the four lines.
 *
 * A view transition replaces elements
 * rather than animating them, and the snapshots are painted in a pseudo-element
 * tree the spec renders after all page content *and after the top layer* — so
 * nothing drawn over the board can rank against it, a modal `<dialog>` included
 * (`docs/reference/z_index.md`). Every overlay was flown over by a re-slot, and
 * the answer had been a stylesheet rule per overlay. A list that grows is the
 * wrong shape for an invariant.
 *
 * FLIP has no list, because it moves the real cards: through all four steps a
 * card is in the page, in the stacking order and hit-testable, so an overlay is
 * above it for the same reason it is at rest. The live drag preview needs this
 * regardless (`TASK_done_board_motion.md`, "What FLIP is still for").
 *
 * **The cost, stated.** One forced reflow per re-slot, where
 * `startViewTransition` charged none. And a transform makes its element a
 * containing block for fixed-position descendants, which a
 * `view-transition-name` does not — so a fixed popover opened inside a card
 * would be caught by the card's box mid-slide. Nothing opens one there today
 * because `portal` moves such menus to `<body>`;
 * `test/containment.test.ts` is what fails if that changes.
 *
 * Reduced motion writes no transform at all, so the re-slot is the cut it was.
 * jsdom lays nothing out, so every delta is zero and this is `update()` with two
 * loops that write nothing — which keeps the suite synchronous here.
 */
export function slide(host: HTMLElement, update: () => void): void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const from = new Map<HTMLElement, [number, number]>();
  for (const node of host.querySelectorAll<HTMLElement>(SLIDES)) from.set(node, boxIn(node, host));

  update();

  // Both loops before any measuring: clearing a transform is a write, and a
  // read between two writes is a reflow per card rather than one for the board.
  const moved: HTMLElement[] = [];
  for (const node of from.keys()) {
    if (!node.isConnected) continue;
    node.style.transition = 'none';
    node.style.transform = '';
    moved.push(node);
  }
  const landed = moved.map((node) => boxIn(node, host));
  let any = false;
  for (const [i, node] of moved.entries()) {
    const was = from.get(node);
    const now = landed[i];
    if (!was || !now) continue;
    const dx = was[0] - now[0];
    const dy = was[1] - now[1];
    if (!dx && !dy) continue;
    node.style.transform = `translate(${dx}px, ${dy}px)`;
    any = true;
  }
  if (!any) return;
  // **The read is the animation.** A transition needs a resolved style to leave,
  // and every write above is still sitting in the same task — so without this
  // the browser resolves style once, sees the invert and the clear together,
  // finds no change and animates nothing. Measured in Chromium against the real
  // stylesheet: no forced reflow, and `getAnimations()` is empty 900ms in with
  // every card already at its destination. It is the one cost FLIP has over a
  // view transition, and it is one reflow for the board rather than one a card.
  void host.offsetHeight;
  // Then next frame, so the inverted state is painted rather than merely
  // resolved — and so jsdom, which runs no frames in a test's own task, can read
  // the invert back as the thing this wrote.
  requestAnimationFrame(() => {
    for (const node of moved) {
      if (!node.style.transform) continue;
      node.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASE}`;
      node.style.transform = '';
    }
  });
}
