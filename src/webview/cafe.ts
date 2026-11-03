/**
 * The café: a cup of coffee floating over the board, drawn from the approved
 * mockup in `docs/mockups/coffee-cup/cafe-tapered.html`.
 *
 * **Mounted once, never morphed.** The board is repainted by keyed morph on
 * every poll, and `dial()` in `board.ts` states plainly that it does not animate
 * because it is rebuilt each time. The cup has a transition that must survive a
 * poll — a refill only reads as a pour if the node it runs on persists — so this
 * lives on `#board`, outside `#board-body`, and a paint writes `--fill` and
 * the tip and nothing else.
 *
 * **The drawing is not an icon.** `ui/icons.ts` emits stroke-only monochrome
 * paths on a 24 grid and could not carry ceramic, brew and a saucer. This is an
 * illustration, and it is a namespaced SVG string for the reason `dial()` gives:
 * `el` speaks `createElement`, and an SVG child of an HTML parent renders as
 * nothing without the namespace.
 */
import { LEASE_MS } from '../ui/lease';
import { armPot, disarmPot, POT_SVG, potDefs, pourFrom, stopPour } from './pot';
import { ui, vscode } from './state';

/** The board-relative corner the cup sits in before anybody drags it. */
const HOME = { x: 0, y: 0 };

/** How long the pot stays. Five seconds of a nine-minute refill. */
const POUR_MS = 5000;
/** A rise past this is a refill. Within one coffee the level only falls, by
 *  about 0.005 a push, so anything above the noise is a fresh pour or a second
 *  window's hold landing — and both are worth pouring for. */
const RISE = 0.05;
/** Where the steam stops. Half the lease, so on the shipped ten minutes it goes
 *  out with five to run.
 *
 *  It was 0.02, which read as "holding anything at all" and so never fired: the
 *  refill lands a minute before the hold lapses, and 0.10 is the lowest a
 *  live lease is ever pushed at. The cup steamed from the first pour to the
 *  last and told a reader nothing the coffee under it had not already said.
 *  Half is a line the level crossing means something at — and it is also what
 *  stops two SVG paths animating for the half of every lease nobody is being
 *  told anything by them. */
const STEAMING = 0.5;

let node: HTMLElement | undefined;
let at = { ...HOME };
/** The level at the previous draw, or undefined on a first paint. */
let level: number | undefined;
let pourTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while a pointer is driving it, so a poll cannot fight the drag. */
let dragging = false;
/** The position last posted to the host, until a state message echoes it back.
 *  What stops a poll built before that write landed from undoing the drag. */
let posted: { x: number; y: number } | undefined;

const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);

/**
 * The cup, at 128 in its own units, and the pot that pours into it.
 *
 * `--top` is the surface y when full and `--range` how far it falls to empty;
 * both are geometry of this drawing, which is why they ride on the element
 * rather than in the stylesheet. The interior is painted opaque *before* the
 * coffee, and the clip takes in the elliptical mouth — without either, a dark
 * panel shows straight through the cup, which is what the mockup's first draft
 * did.
 *
 * The pot is a sibling in the same SVG rather than a box of its own: it is
 * drawn at negative coordinates above the cup and paints outside the 68px
 * frame. Growing the frame instead would move the clamp — which measures the
 * element — and silently reinterpret every stored `cafeAt`, so a cup that had
 * been dragged would move on upgrade.
 *
 * `dark` is which room the pot is lit for. It is the one thing about the pot
 * the panel cannot compute from the drawing.
 */
const svgMarkup = (dark: boolean): string => `
<svg viewBox="0 0 128 128" role="img" aria-label="Coffee keeping this machine awake">
  <defs>
    ${potDefs(dark)}
    <linearGradient id="cafeBody" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f0ece3"/><stop offset=".44" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d6cfc0"/>
    </linearGradient>
    <linearGradient id="cafeCav" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ded6c6"/><stop offset=".28" stop-color="#b8ae9a"/>
      <stop offset="1" stop-color="#756b5b"/>
    </linearGradient>
    <linearGradient id="cafeBrew" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8a5426"/><stop offset=".45" stop-color="#5a2e13"/>
      <stop offset="1" stop-color="#33190a"/>
    </linearGradient>
    <clipPath id="cafeIn">
      <ellipse cx="64" cy="47" rx="27" ry="6.4"/>
      <path d="M37 47h54l-11 45a8 8 0 0 1-8 6H56a8 8 0 0 1-8-6z"/>
    </clipPath>
  </defs>

  <g class="steam" fill="none" stroke="#b9ae9c" stroke-width="3.4" stroke-linecap="round">
    <path d="M56 36c-6-5-6-11 0-16s6-11 0-16"/>
    <path d="M75 33c-5-4-5-9 0-13s5-9 0-13"/>
  </g>

  <ellipse cx="64" cy="110" rx="44" ry="10" fill="#cbc3b2"/>
  <ellipse cx="64" cy="107" rx="44" ry="10" fill="#eae5da"/>
  <ellipse cx="64" cy="106" rx="26" ry="5" fill="#d8d1c2" opacity=".7"/>

  <path d="M94 58c14 2 19 8 19 15s-6 14-17 16" fill="none" stroke="#e6e0d3"
        stroke-width="10" stroke-linecap="round"/>
  <path d="M94 58c14 2 19 8 19 15s-6 14-17 16" fill="none" stroke="#fff"
        stroke-width="3.5" stroke-linecap="round" opacity=".5"/>

  <path d="M31 47h66l-13 50a9 9 0 0 1-9 7H53a9 9 0 0 1-9-7z" fill="url(#cafeBody)"/>

  <g clip-path="url(#cafeIn)">
    <rect x="30" y="38" width="68" height="70" fill="url(#cafeCav)"/>
    <ellipse cx="64" cy="44.5" rx="27" ry="6.4" fill="#4e4536" opacity=".38"/>
    <g class="liquid" style="--top:44; --range:54">
      <path class="drift" fill="url(#cafeBrew)"
            d="M28 0q8.5-3 17 0t17 0t17 0t17 0t17 0t17 0t17 0t17 0V74H28Z"/>
      <path class="drift slow" fill="#9c6538" opacity=".5"
            d="M11 0q8.5-3 17 0t17 0t17 0t17 0t17 0t17 0t17 0t17 0t17 0V13H11Z"/>
      <g fill="none" stroke="#e2b98a" stroke-width="1.6">
        <ellipse class="rip" cx="55" cy="1" rx="10" ry="2.8"/>
        <ellipse class="rip" cx="55" cy="1" rx="10" ry="2.8"/>
        <ellipse class="rip" cx="55" cy="1" rx="10" ry="2.8"/>
      </g>
    </g>
  </g>

  <ellipse cx="64" cy="47" rx="30" ry="7.2" fill="none" stroke="#efeade" stroke-width="6"/>
  <ellipse cx="64" cy="47" rx="30" ry="7.2" fill="none" stroke="#fff" stroke-width="1.6" opacity=".5"/>
  <path d="M40 56l8 42" fill="none" stroke="#fff" stroke-width="3" opacity=".38" stroke-linecap="round"/>
${POT_SVG}
</svg>`;

/**
 * What the cup says when asked.
 *
 * One phrase per reason, and the two that never arrive — `off` and
 * `unsupported` — are still spelled, because a reason that reached the panel
 * with no phrase would draw an empty tip rather than fail loudly.
 */
function phrase(view: AwakeView): string {
  switch (view.reason) {
    case 'drinking':
      return `Some sessions are still running, so this machine is staying awake. It sleeps ${left(view.until)} after the last one stops.`;
    case 'idle':
      return 'Nothing is working, so this machine may sleep.';
    case 'stale':
      return 'A session says it is working but has not moved in a while, so this machine may sleep.';
    case 'battery':
      return 'Battery is nearly flat, so this machine may sleep rather than run itself down.';
    case 'off':
      return 'The café is off.';
    case 'unsupported':
      return 'Keeping the machine awake only works on macOS.';
  }
}

/** How long the coffee has left, in the roundest words that are still true.
 *  Only ever asked of a lease that exists — the empty arm carries no deadline
 *  and its phrase names none. */
function left(until: number): string {
  const mins = Math.round((until - Date.now()) / 60_000);
  if (mins <= 0) {
    return 'any moment';
  }
  return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
}

/**
 * Draw the cup for this poll, making it if this is the first one.
 *
 * `undefined` removes it: there is no café on this platform, or the setting is
 * off. That is a different statement from an empty cup, which is a café that is
 * simply not holding — and the reason then says which.
 */
export function renderCafe(view: AwakeView | undefined, stored?: { x: number; y: number }): void {
  if (!view) {
    node?.remove();
    node = undefined;
    // A café switched off and on again has no history to compare against, so it
    // must not pour on its first paint back — and nothing may go on animating
    // over a board the cup has left.
    clearTimeout(pourTimer);
    pourTimer = undefined;
    level = undefined;
    disarmPot();
    return;
  }
  if (!node) {
    node = make();
    document.getElementById('board')?.appendChild(node);
    at = stored ?? { ...HOME };
  }
  // A drag in progress owns the position, and so does a drag that has just
  // ended: `moveCafe` is stored without being awaited, so the next state message
  // can still carry the *previous* `cafeAt`. Applying it would snap the cup back
  // for one poll and then return it. Only a stored position that agrees with
  // what was last posted is allowed to move it.
  if (!dragging && stored && (posted === undefined || same(stored, posted))) {
    at = stored;
    posted = undefined;
  }
  // On every paint, not only on drag: a window narrowed after a drag — or
  // reopened on a smaller display — would otherwise leave the cup outside the
  // board, unreachable, and its position is persisted so it would stay there.
  clamp();
  place();
  draw(view);
}

/**
 * How full the cup is: the coffee left, as a share of one lease.
 *
 * This division used to be the host's, on the state message. It is here because
 * a level computed against a moving `now` differed on every push and so made a
 * post dedupe impossible — `docs/tasks/TASK_done_panel_repaint_cost.md`.
 * The deadline it needs rides the wire instead; the lease it is a share of is a
 * constant both halves compile against (`ui/lease.ts`), so it is not on the wire
 * at all. Neither moves between refills.
 *
 * Clamped both ends, and both ends happen. A hold record is written by whichever
 * window took it — possibly an older build on a longer lease — so an `until`
 * beyond one of ours is a real reading and not a bug to assert against; and a
 * lapsed one must read as an empty cup rather than as negative coffee.
 */
function cupFill(until: number, now: number): number {
  const remaining = until - now;
  return remaining <= 0 ? 0 : Math.min(1, remaining / LEASE_MS);
}

/**
 * The level, a second older.
 *
 * On the beat `main.ts` already runs for the stamps, because the coffee going
 * down is a clock rather than a state change and nothing is pushed when it
 * moves. A cup with no push behind it yet has nothing to draw.
 */
export function tickCafe(): void {
  if (node && ui.state.awake) {
    draw(ui.state.awake);
  }
}

/** Everything a level change writes, from either driver. */
function draw(view: AwakeView): void {
  if (!node) {
    return;
  }
  // The empty arm carries no deadline, because there is nothing to run down.
  const fill = view.reason === 'drinking' ? cupFill(view.until, Date.now()) : 0;
  // Before `--fill`, so the four-and-a-half second transition is the one in
  // effect when the level changes: at the shipped half second the cup is full
  // for the rest of the pour, which reads as a pot pouring into a full cup.
  // A first paint records the level and stays quiet — a panel opened mid-lease
  // has nothing to compare against, and a cup that poured on every reopen would
  // be reporting the panel's history rather than the machine's.
  if (level !== undefined && fill - level > RISE) {
    pour(level, fill);
  }
  level = fill;
  node.style.setProperty('--fill', String(fill));
  node.classList.toggle('hot', fill > STEAMING);
  node.dataset.tip = phrase(view);
}

/** Lean the pot in for five seconds. A second rise inside those five restarts
 *  the clock rather than stacking a timer, or two refills in a row leave a pot
 *  that never leaves. */
function pour(was: number, now: number): void {
  node?.classList.add('pouring');
  clearTimeout(pourTimer);
  pourTimer = setTimeout(() => {
    node?.classList.remove('pouring');
    stopPour();
    pourTimer = undefined;
  }, POUR_MS);
  pourFrom(was, now);
}

function make(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'cafe';
  // Which room the pot is lit for. The host puts its theme kind on the body of
  // every webview it opens, so it is read rather than configured — and the two
  // light spellings are both spelled, since an unknown one lands on dark, which
  // is what a panel is nine times in ten.
  const kind = document.body.classList;
  const dark = !kind.contains('vscode-light') && !kind.contains('vscode-high-contrast-light');
  el.innerHTML = svgMarkup(dark);
  const svg = el.querySelector('svg');
  if (svg) {
    armPot(svg, dark);
  }
  arm(el);
  // A narrowed window strands the cup outside the board otherwise, and the poll
  // that would have re-clamped it is up to three seconds away — long enough to
  // watch it sit off the edge.
  window.addEventListener('resize', () => {
    if (!dragging) {
      clamp();
      place();
    }
  });
  return el;
}

function place(): void {
  if (node) {
    // Up and right from the bottom-left corner the stylesheet anchors it to, so
    // a resized window keeps it near the same edge rather than the same point.
    node.style.transform = `translate(${at.x}px, ${-at.y}px)`;
  }
}

/**
 * Pointer drag, deliberately not HTML5 drag.
 *
 * `#cards` owns delegated `dragstart` and `dragover` for card
 * reordering; a `draggable` cup inside the board would fire those handlers and
 * be read as a card being rearranged. Pointer events with capture keep the whole
 * gesture here, and `touch-action: none` in the stylesheet stops the webview
 * scrolling the board instead.
 */
function arm(el: HTMLElement): void {
  let from = { x: 0, y: 0 };
  let origin = { x: 0, y: 0 };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    dragging = true;
    from = { x: e.clientX, y: e.clientY };
    origin = { ...at };
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) {
      return;
    }
    at = { x: origin.x + (e.clientX - from.x), y: origin.y - (e.clientY - from.y) };
    clamp();
    place();
  });

  const end = (e: PointerEvent) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    // Once, on release. Posting through the drag would be a message per frame
    // for a value only a reload ever reads.
    posted = { ...at };
    vscode.postMessage({ type: 'moveCafe', x: at.x, y: at.y });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/**
 * Keep the cup inside the board.
 *
 * Without this a drag to the edge, or a window narrowed after one, strands the
 * cup somewhere it cannot be grabbed back from — and its position is persisted,
 * so it would stay stranded across reloads.
 */
function clamp(): void {
  const board = document.getElementById('board');
  if (!node || !board) {
    return;
  }
  const room = board.getBoundingClientRect();
  const cup = node.getBoundingClientRect();
  // A board with no measurable box is a board nothing can be clamped against —
  // jsdom reports every rect as zero, and clamping to that would collapse a
  // stored position to the corner and quietly lose it. No measurement, no
  // opinion.
  if (room.width <= 0 || room.height <= 0 || cup.width <= 0) {
    return;
  }
  const maxX = Math.max(0, room.width - cup.width - 28);
  const maxY = Math.max(0, room.height - cup.height - 28);
  at = {
    x: Math.min(Math.max(0, at.x), maxX),
    y: Math.min(Math.max(0, at.y), maxY)
  };
}
