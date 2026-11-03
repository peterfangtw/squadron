import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel, openPanel } from '../harness';
import { panelStylesheet } from '../../ui/document';
import { openReview } from '../workflows/workflow_review';

/**
 * The containment invariant: nothing drawn `position: fixed` may sit under an
 * ancestor that is a containing block for fixed descendants.
 *
 * **Why this is a test and not a comment.** `position: fixed` is what the panel
 * spends whenever a popover opens inside a box that hides its overflow — a menu
 * on a card is inside two of them, `.card` and `.specs`, and absolute draws it
 * cut off at the card's edge. Fixed is only worth anything while it really
 * escapes: a *single unrelated property* on any ancestor — `transform`,
 * `filter`, `contain: layout` — silently makes that ancestor the containing
 * block again, and the menu is back inside the clip it was moved out of.
 * Nothing errors, no rule is overridden, and the property that did it is
 * usually in a different file, added for a different reason, by someone who
 * never touched the menu.
 *
 * The panel's live traps are the three boxes that carry a `transform` for
 * centring alone — `#bottomhub` (`css/bottom_hub.ts`), `#picker` and `#runsheet`
 * (`css/composer.ts`) — and none of them was put there by anyone thinking about
 * popovers. A `translateX(-50%)` is how a box is centred, and it is also why the
 * bottom hub's own menu has to stay `absolute`.
 *
 * **Two properties that look like traps are not**, and this file asserted
 * otherwise until they were measured: `container-type` forms neither a
 * containing block nor a stacking context, and `view-transition-name` forms a
 * stacking context only. So neither `#board` nor `.card` catches a fixed
 * descendant, and a fixed menu opened inside a card is drawn against the
 * viewport, unclipped. Measured in the IDE's own Chromium (142) and in a desktop
 * Chrome (151), which agree — `docs/reference/z_index.md` holds the matrix and
 * the method.
 *
 * **jsdom cannot see it, so this does not look for the clip.** There is no
 * layout here and never will be; a scenario that opened the menu and measured
 * it would pass under every version of the bug. What this reads instead is the
 * stylesheet and the DOM: which selectors declare `position: fixed`, which
 * declare a property that creates a containing block, and — against the real
 * rendered panel, with the real ancestor chain — whether any pair of them lands
 * on an element and one of its ancestors. Static enough to run headlessly, live
 * enough that the ancestry is not a hand-written map that would drift.
 *
 * Three approximations, all stated rather than hidden, because a test whose
 * limits are unwritten is read as proving more than it does:
 *
 * - **Every at-rule is taken as active.** A rule inside `@media` or
 *   `@container` counts whatever the query says. Worst-case is the right
 *   posture for the trap half — a containing block that only appears at one
 *   width is still a bug — and the cost is on the other half: a neutralising
 *   rule in a query that could never be true at the same time as the trap's
 *   would be believed. Nothing here is written that way, and a reader who does
 *   write it that way should expect this to go quiet rather than red.
 * - **The cascade is specificity then source order, counted textually.** Ids,
 *   classes, attributes and pseudo-classes are counted where they appear, with
 *   the arguments of `:is()`, `:has()` and `:not()` counted in full rather than
 *   by their largest branch. Specificity is not optional here and was the first
 *   thing this file got wrong: `.fmenu { position: absolute }` is written
 *   *after* `.fmenu.floating { position: fixed }`, so order alone reports every
 *   floating menu as absolute and the sweep finds nothing to check.
 * - **Only what is on screen is swept.** A popover shut with `hidden` — which
 *   is how every menu here is shut — is not drawn, so an ancestor containing it
 *   is not yet a bug. The cost is that a trap reachable only from a state this
 *   render is not in goes unseen: a menu inside `#runsheet` is checked only on a
 *   render where the sheet is up.
 * - **`@keyframes` are not read.** An animating `transform` is a containing
 *   block for as long as it runs, and finding that would mean resolving
 *   `animation-name` to its frames. Out of scope; if a fixed popover ever opens
 *   inside something mid-spin, this will not say so.
 */

/** One flattened rule: a single selector, what it declares, and how loudly. */
interface Rule {
  selector: string;
  decls: Record<string, string>;
  weight: number;
}

/**
 * The properties that make an element a containing block for its fixed
 * descendants, each with the test for whether the declared value actually does
 * it — `transform: none` is the value a neutralising rule is written in, and
 * counting it would make every such fix look like the bug it repairs.
 *
 * **This list is measured, not read off the spec.** `container-type` and
 * `view-transition-name` were both in it and are both out: neither makes an
 * element a containing block for a fixed descendant in Chromium 142 or 151.
 * They are the two that read most like traps — one is containment by name, the
 * other applies containment in the prose — which is exactly why they are worth
 * a sentence here rather than a silent absence. `view-transition-name` does
 * form a *stacking context*, which is a different question and is
 * `docs/reference/z_index.md`'s. Anything added here should be measured the
 * same way before it is trusted.
 */
const TRAPS: Record<string, (value: string) => boolean> = {
  transform: (v) => v !== 'none',
  translate: (v) => v !== 'none',
  rotate: (v) => v !== 'none',
  scale: (v) => v !== 'none',
  perspective: (v) => v !== 'none',
  filter: (v) => v !== 'none',
  'backdrop-filter': (v) => v !== 'none',
  contain: (v) => /\b(strict|content|paint|layout)\b/.test(v),
  'will-change': (v) =>
    /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(v)
};

/** The properties this file reads at all — everything else is skipped whole.
 *  `display` is here for the visibility test rather than for the invariant. */
const READS = new Set(['position', 'display', ...Object.keys(TRAPS)]);

/** At-rules whose body is rules, and so is walked into rather than parsed as
 *  declarations. Anything else beginning with `@` is a leaf here. */
const NESTS = /^@(media|supports|container|layer|scope)\b/;

/** Split on a separator only at bracket depth zero — `:is(.card, .fam)` is one
 *  selector, and `linear-gradient(90deg, …)` is one value. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(part);
      part = '';
    } else part += ch;
  }
  out.push(part);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseDecls(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const one of splitTop(body, ';')) {
    const at = one.indexOf(':');
    if (at === -1) continue;
    const prop = one.slice(0, at).trim();
    if (READS.has(prop)) decls[prop] = one.slice(at + 1).trim();
  }
  return decls;
}

/**
 * How loudly a selector speaks, counted from its text: ids, then everything
 * class-shaped. Enough to order the pairs this file has to order, and stated as
 * an approximation at the top rather than sold as the real algorithm.
 */
function weigh(selector: string): number {
  // Functional pseudo-classes are opened out so their contents count, and
  // pseudo-elements are dropped — a rule for `::before` is never read here.
  const flat = selector.replace(/::[\w-]+/g, '').replace(/[(),]/g, ' ');
  const ids = (flat.match(/#[\w-]+/g) ?? []).length;
  const classy = (flat.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  return ids * 1000 + classy;
}

/** Flatten the stylesheet to one entry per selector, in source order. */
function parse(css: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string): void => {
    let prelude = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch !== '{') {
        prelude += ch;
        i++;
        continue;
      }
      let depth = 0;
      let end = i;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      const body = text.slice(i + 1, end);
      const head = prelude.trim();
      if (head.startsWith('@')) {
        if (NESTS.test(head)) walk(body);
      } else {
        const decls = parseDecls(body);
        if (Object.keys(decls).length) {
          for (const selector of splitTop(head, ','))
            out.push({ selector, decls, weight: weigh(selector) });
        }
      }
      prelude = '';
      i = end + 1;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return out;
}

/**
 * A rule for a pseudo-element is dropped rather than matched. `el.matches()`
 * cannot answer one, and neither half of the invariant needs it: a
 * pseudo-element is never an ancestor, and one drawn fixed takes its containing
 * block from the chain of the element it hangs off, which is swept anyway.
 */
const RULES = parse(panelStylesheet()).filter((r) => !r.selector.includes('::'));

/** Selectors the matcher could not answer, so a reader is told rather than
 *  quietly given a pass. Filled by `matches`, asserted by the guard below. */
const unmatchable = new Set<string>();

function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    unmatchable.add(selector);
    return false;
  }
}

/** What the cascade would leave on this element for one property, under the
 *  approximations at the top of this file. */
function declared(el: Element, prop: string): string | undefined {
  let value: string | undefined;
  let won = -1;
  for (const rule of RULES) {
    const decl = rule.decls[prop];
    // `>=`, so a later rule of equal weight still wins — source order is the
    // tie-break, exactly as the cascade has it.
    if (decl !== undefined && rule.weight >= won && matches(el, rule.selector)) {
      value = decl;
      won = rule.weight;
    }
  }
  return value;
}

/**
 * Whether this element is on screen at all. Two questions and no layout: the
 * `hidden` attribute, which is how every menu in the panel is shut, and a
 * declared `display: none`, which is how the ones with no attribute are. Asked
 * of the whole chain, since either answer on an ancestor takes the element with
 * it.
 */
function shown(el: Element): boolean {
  for (let up: Element | null = el; up; up = up.parentElement) {
    if (up.hasAttribute('hidden')) return false;
    if (declared(up, 'display') === 'none') return false;
  }
  return true;
}

/** The trap this element sets, if it sets one — `prop: value`, for the message. */
function containsFixed(el: Element): string | null {
  for (const [prop, isTrap] of Object.entries(TRAPS)) {
    const value = declared(el, prop);
    if (value !== undefined && isTrap(value)) return `${prop}: ${value}`;
  }
  return null;
}

/** An element as a reader would point at it in the stylesheet. */
function where(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = [...el.classList].map((c) => `.${c}`).join('');
  return el.tagName.toLowerCase() + id + cls;
}

/**
 * The sweep itself: every fixed element in this document, against its own
 * ancestor chain. Takes whatever the panel happens to be showing, so a scenario
 * adds coverage by opening something rather than by naming a selector here.
 */
function sweep(p: Panel, what: string): void {
  const all = [...p.window.document.querySelectorAll('*')];
  const fixed = all.filter(
    (el) =>
      ((el as HTMLElement).style?.position === 'fixed' || declared(el, 'position') === 'fixed') &&
      shown(el)
  );
  // A sweep over a document with nothing fixed on screen passes while proving
  // nothing, which is the failure mode of a scenario that quietly stopped
  // opening the popover it was written for.
  assert.ok(
    fixed.length > 0,
    `${what}: nothing on screen here is position: fixed — the sweep proved nothing`
  );
  for (const el of fixed) {
    for (let up = el.parentElement; up; up = up.parentElement) {
      const trap = containsFixed(up);
      assert.equal(
        trap,
        null,
        `${what}: ${where(el)} is position: fixed to escape an overflow, but its ancestor ` +
          `${where(up)} declares ${trap} — which makes it the containing block for ` +
          `fixed descendants, so the escape is undone and the popover draws clipped.`
      );
    }
  }
}

describe('fixed popovers escape their ancestors', () => {
  /**
   * A lane chip's model menu on the workflow editor's canvas: a
   * `position: fixed` popover a reader opens by pressing things, born inside
   * `#board` → `#wfeditor` → the canvas → a node → the chip's own `.fwrap`.
   *
   * It stands where the bottom drawer's row menu stood until that row's Edit,
   * Duplicate and Delete moved onto the row, and the settings flyout before
   * that — `TASK_done_draft_new_session.md` Step 8. It is `.fmenu.floating`,
   * the spelling of the trap that survives.
   *
   * A scenario adds coverage here by *opening* something — the sweep takes
   * whatever the document is showing — so a popover that arrives later needs a
   * case of its own and nothing else.
   */
  it('the workflow editor’s model chip menu', (t) => {
    const p = openPanel(t);
    openReview(p);
    const chip = p.window.document.querySelector<HTMLElement>(
      '#wfeditor .wcchip:not(.effort):not([disabled])'
    );
    assert.ok(chip, 'no chip to open a menu from');
    chip.click();
    const menu = p.window.document.querySelector<HTMLElement>('.fmenu.floating:not([hidden])');
    assert.ok(menu, 'the chip opened no menu');
    sweep(p, 'the workflow editor’s model chip menu');
  });

  /**
   * The guard on the sweep's own reach, and the last case so it has every
   * scenario's matching behind it. A selector nwsapi cannot answer is counted
   * as not matching, and a trap hidden behind one would be a silent pass — so
   * the run is failed by the *sweep having been blind*, with the selector
   * named, rather than by the bug it then missed.
   */
  it('reads every selector the panel is written in', () => {
    assert.deepEqual([...unmatchable], [], 'selectors the matcher could not answer');
  });
});
