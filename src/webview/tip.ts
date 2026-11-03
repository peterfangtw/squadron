/**
 * The panel's own hover explanation, in place of the browser's `title=`.
 *
 * A native tooltip is the host's, not ours: roughly a second before it appears
 * and no way to change that, the OS font at the OS size, none of the theme, and
 * wherever the host decides to put it — off the edge of a 400px panel, for the
 * ones that are whole sentences. This layer is the same words at `--av-fs-md`
 * on the menu surface, on a delay we pick, clamped inside the panel, and opened
 * by keyboard focus as well as by the pointer. That last one is not a nicety:
 * `title` never fires on focus, so for as long as the panel wrote them every
 * explanation in it was invisible to anyone who tabs.
 *
 * Content rides on data attributes rather than closures, for the same reason
 * `data-act` does — the bars this hangs off are morphed every second, and a
 * handler closed over a node the paint replaced points at an orphan. Attributes
 * survive the morph with the node they are on.
 *
 * One layer, two renderings: `data-tip` is a phrase and draws as `.tip.phrase`,
 * `data-tip-rows` is a readout and draws as keyed rows. Every explanation the
 * panel writes now speaks it — H23 moved the last of the `title=` sites over,
 * and a new one is a bug. Where the phrase is a whole sentence it wraps at
 * 280px rather than running off the panel; nothing here has to ask which,
 * because the CSS decides it by the width of the words.
 *
 * `phrase` and not `chip`, which it was called first — see `show()`.
 *
 * A control whose only name is a glyph needs `aria-label` beside its tip: the
 * tip is not an accessible name, and `title` used to be doing both jobs.
 */

import { placeAnchored } from '../ui/place';
import { LAYER_INSET, el } from './dom';

/** One line of a keyed tip: the label, the value, and the value's rank class. */
export type TipRow = [key: string, value: string, rank: string];

/**
 * Say a readout's detail as keyed rows. Empty rows means no tip at all rather
 * than an empty one — a window with no reset time has nothing to explain, and
 * the attribute has to go or the layer would open on a blank box.
 */
export function tipRows(node: HTMLElement, head: string, rows: TipRow[]): void {
  if (!rows.length) {
    delete node.dataset.tipHead;
    delete node.dataset.tipRows;
    return;
  }
  node.dataset.tipHead = head;
  node.dataset.tipRows = JSON.stringify(rows);
}

/**
 * An (i) that carries its explanation: the sheet's way of keeping a sentence
 * out of a column. Named by its tip, since the glyph says nothing.
 */
export function why(tip: string): HTMLButtonElement {
  const button = el('button', 'why') as HTMLButtonElement;
  button.type = 'button';
  button.innerHTML = ICONS.info;
  button.dataset.tip = tip;
  button.setAttribute('aria-label', tip);
  return button;
}

/**
 * How long the pointer rests before a tip opens. The host's own is around a
 * second, which is long enough that nobody waits for it; nothing is faster to
 * feel wrong either — at zero the panel twitches as the pointer crosses it.
 */
const OPEN_MS = 450;

/**
 * The warm period. Once one tip has been up, the next opens with no delay until
 * the pointer has rested somewhere neutral for this long — so reading along a
 * bar is one wait, not one per control. This is what the OS does, and its
 * absence is the tell that a hand-rolled tooltip is hand-rolled.
 */
const WARM_MS = 400;

/** The gap a tip keeps from the thing it explains. */
const GAP = 6;

let tip: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let warmUntil = 0;

const SEL = '[data-tip],[data-tip-rows]';

/** What the tip holds, read off the anchor — or nothing, if it says nothing. */
function fill(node: HTMLElement): HTMLElement[] | null {
  const rows = node.dataset.tipRows;
  if (rows !== undefined) {
    const grid = el('div', 'rows');
    for (const [key, value, rank] of JSON.parse(rows) as TipRow[]) {
      grid.append(el('span', 'k', key), el('span', ('v ' + rank).trim(), value));
    }
    return [el('div', 'hd', node.dataset.tipHead ?? ''), grid];
  }
  const text = node.dataset.tip;
  return text === undefined || text === '' ? null : [el('span', null, text)];
}

/**
 * Hang the tip off its anchor via the shared popover placer (`ui/place.ts`):
 * prefer below, flip up when short, clamp both axes, center on the trigger.
 * Same brain as fixed menus; tip only differs on gap and align.
 *
 * `position: fixed`, so the coordinates are the anchor's own rect and no
 * positioned ancestor has to be found or invented. The layer is a child of
 * `<body>` for the same reason: a tip inside a bar that morphs is a tip the
 * next paint can take away mid-read.
 */
function place(): void {
  if (!tip || !anchor) return;
  const at = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const put = placeAnchored({
    anchor: {
      left: at.left,
      right: at.right,
      top: at.top,
      bottom: at.bottom,
      width: at.width,
      height: at.height
    },
    popup: { width, height },
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight
    },
    preferAlign: 'center',
    gap: GAP,
    margin: LAYER_INSET
  });
  tip.style.top = put.top + 'px';
  tip.style.left = put.left + 'px';
}

function hide(): void {
  clearTimeout(openTimer);
  if (!tip) return;
  tip.remove();
  tip = null;
  anchor = null;
  // The warm period starts when a tip closes, and lapses on its own once the
  // pointer has rested anywhere long enough to have earned a wait of its own.
  warmUntil = Date.now() + WARM_MS;
}

function show(node: HTMLElement): void {
  const body = fill(node);
  if (!body) return;
  hide();
  anchor = node;
  // `phrase`, not `chip`: the composer declares a top-level `.chip` of its own
  // and is joined later into the same sheet, so the two would have shared a
  // selector and painted each other's padding, surface and width. `.shotchip`
  // in `css/chat.ts` is the same collision, found the hard way — the rule there
  // is to rename rather than to out-specify, and this is that rule applied.
  tip = el('div', node.dataset.tipRows === undefined ? 'tip phrase' : 'tip');
  tip.append(...body);
  document.body.append(tip);
  place();
}

/**
 * Re-read an open tip from its anchor. The usage readout counts down, so a tip
 * left alone through the 1s repaint states a time that has stopped moving; and
 * an anchor a paint did take away is a tip explaining nothing.
 */
export function refreshTip(): void {
  if (!tip || !anchor) return;
  const body = anchor.isConnected ? fill(anchor) : null;
  if (!body) {
    hide();
    return;
  }
  tip.replaceChildren(...body);
  place();
}

/**
 * The listeners, delegated at the document like every other handler in a panel
 * whose containers are repainted out from under them. Registered from `main.ts`
 * with the rest of the load-time wiring.
 */
export function mountTips(): void {
  document.addEventListener('mouseover', (e) => {
    const node = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SEL);
    // A press is not a rest, and a tip is a rest's reward: `buttons` is nonzero
    // for as long as one is held, so nothing opens mid-gesture. See the
    // `pointerdown` listener below for the drag this is really about.
    if (!node || node === anchor || e.buttons) return;
    clearTimeout(openTimer);
    if (Date.now() < warmUntil) show(node);
    else openTimer = setTimeout(() => show(node), OPEN_MS);
  });
  document.addEventListener('mouseout', (e) => {
    const node = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SEL);
    if (node) hide();
  });
  // Focus is the half `title` never had. `:focus-visible`, not `:focus`, so a
  // click on a control does not leave its own explanation sitting over the
  // thing the click just did.
  document.addEventListener('focusin', (e) => {
    const node = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SEL);
    if (node && node.matches(':focus-visible')) show(node);
  });
  document.addEventListener('focusout', () => hide());
  // A drag begins from a rest, which also opens a tip. Take it down on dragstart
  // rather than assuming mouseout fired first.
  document.addEventListener('dragstart', () => hide());
  // And a drag the HTML5 event never announces. A pointer drag under
  // `setPointerCapture` — the cup that shows keep-awake is one, since a
  // `draggable` cup would fight the board's own delegated reorder — retargets
  // the compat mouse events at the capture target, so neither `dragstart` nor
  // `mouseout` fires and a tip opened on the rest before the press would sit
  // where the thing used to be for the length of the drag. The press closes it
  // instead. Nothing is lost: a tip is placed once from its anchor's rect and
  // never traces it, so an open one is stale the moment its anchor moves.
  //
  // Closing once is not the whole fix, because that retargeted `mouseover`
  // fires a frame later and — inside the warm period — reopens with no delay to
  // sit through. What keeps the layer shut for the rest of the drag is the
  // `buttons` read above rather than a flag latched here: the state is the
  // browser's, read fresh per event, so no release this listener never hears
  // (a native drag's `dragend`, a right-click's menu, a blur mid-press) can
  // strand the panel with every tooltip switched off.
  document.addEventListener('pointerdown', () => hide());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  // Capturing, because the board and the dock scroll, not the window.
  document.addEventListener('scroll', () => hide(), true);
}
