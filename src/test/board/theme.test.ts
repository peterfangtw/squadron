import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { THEME_NAMES } from '../../core/theme_names';
import { panelDocument } from '../../ui/document';
import { groupView, openPanel, openSettings, stateMessage } from '../harness';

/**
 * The theme picker — the swatch row in the settings menu — and the presets
 * behind it.
 *
 * Two kinds of test live here. The first five drive the control the way the
 * host does — push a state, click, read the body attribute and what was posted.
 * The last one reads the stylesheet itself: a preset that forgets a token is
 * not a behaviour bug and no amount of clicking would find it.
 */

/** The presets, in the order the settings menu offers them. */
const swatches = (menu: HTMLElement): HTMLElement[] => [
  ...menu.querySelectorAll<HTMLElement>('.swatches .sws')
];

const names = (menu: HTMLElement): (string | undefined)[] =>
  swatches(menu).map((s) => s.dataset.theme);

const swatch = (menu: HTMLElement, theme: string): HTMLElement => {
  const found = swatches(menu).find((s) => s.dataset.theme === theme);
  assert.ok(found, `no ${theme} swatch`);
  return found;
};

describe('the theme picker', () => {
  it('offers every preset, marking the active one', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'lift' }));
    const menu = openSettings(p, 'Appearance');
    assert.deepEqual(names(menu), [
      'follow',
      'ink',
      'lift',
      'neon',
      'mario',
      'nightcity',
      'arasaka',
      'malachite',
      'paper',
      'polaroid'
    ]);
    assert.deepEqual([...names(menu)].sort(), [...THEME_NAMES].sort());
    const page = menu.querySelector('#settings-appearance');
    assert.equal(
      page?.querySelector('.settings-detail')?.textContent,
      'Kept for the folder this window opened.'
    );
    assert.deepEqual(
      [...(page?.querySelectorAll('.theme-band') ?? [])].map((el) => el.textContent),
      ['Dark', 'Light']
    );
    assert.deepEqual(
      [...(page?.querySelectorAll('.theme-groups .swatches') ?? [])].map((grid) =>
        [...grid.querySelectorAll('.sws')].map((s) => (s as HTMLElement).dataset.theme)
      ),
      [
        ['follow'],
        ['ink', 'lift', 'neon', 'mario', 'nightcity', 'arasaka', 'malachite'],
        ['paper', 'polaroid']
      ]
    );
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'lift');
  });

  // The swatch is the only thing in the menu that says what a preset looks
  // like, and it went blank once already: the class it painted with was a name
  // the composer's attachment chips had taken further down the same sheet, and
  // the later rule won. Nothing about the markup was wrong, so only the
  // computed style could have caught it.
  it('paints every swatch its own preset', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    for (const swatch of swatches(openSettings(p, 'Appearance'))) {
      const hue = swatch.querySelector('.hue');
      assert.ok(hue, `the ${swatch.dataset.theme} swatch has no colour patch`);
      // `follow` alone is painted in the panel's live tokens rather than in a
      // preset's literals, and jsdom does not resolve a var() inside a
      // gradient. Its rule is checked with the stylesheet, below.
      if (swatch.dataset.theme === 'follow') continue;
      assert.match(
        p.window.getComputedStyle(hue).backgroundImage,
        /linear-gradient/,
        `the ${swatch.dataset.theme} swatch is not painted`
      );
    }
  });

  it('paints the follow swatch in the panel’s own two colours', () => {
    const rule = panelDocument().match(/\.sws \.c-follow \{[^}]*\}/)?.[0] ?? '';
    assert.match(rule, /var\(--av-bg\)/, 'the follow swatch lost the panel background');
    assert.match(rule, /var\(--av-fg\)/, 'the follow swatch lost the panel foreground');
  });

  it('posts the pick to the host', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    swatch(openSettings(p, 'Appearance'), 'ink').click();
    assert.deepEqual(p.posted.at(-1), { type: 'setTheme', theme: 'ink' });
  });

  // The host round-trip is a config write and a poll away. Painting on the click
  // is what keeps the switch instant; the echo below only has to agree with it.
  it('paints the pick before the host has answered', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    swatch(openSettings(p, 'Appearance'), 'paper').click();
    assert.equal(p.window.document.body.dataset.theme, 'paper');
  });

  // Trying presets against each other is the whole reason to open this menu, so
  // a pick leaves it open — and with the bar held still, nothing else can move
  // the selection onto the preset just picked.
  it('keeps the menu open on a pick, and moves the mark itself', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'ink' }));
    const menu = openSettings(p, 'Appearance');
    swatch(menu, 'neon').click();
    assert.equal(menu.hidden, false, 'the pick closed the menu');
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'neon');
  });

  // The nav bar is rebuilt by every state push and by a 1s ticker of its own.
  // Either one replaces the gear the open menu hangs off, which snaps the menu
  // shut in the user's face — the same trap the tickets filter bar already
  // holds still for.
  it('keeps an open picker open across a state push', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const menu = openSettings(p, 'Appearance');
    p.push(stateMessage([groupView()]));
    assert.ok(p.window.document.body.contains(menu), 'the state push detached the menu');
    assert.equal(menu.hidden, false, 'the state push closed the menu');
    assert.equal(swatches(menu).length, 10, 'the menu lost its rows');
  });

  // A push that still names the old theme is a poll that started before the
  // write. A refusal is the host saying the pick will never be that push.
  it('holds a pick across a stale push, and drops it when the host refuses', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'ink' }));
    const menu = openSettings(p, 'Appearance');
    swatch(menu, 'paper').click();
    assert.equal(p.window.document.body.dataset.theme, 'paper');
    p.push(stateMessage([groupView()], { theme: 'ink' }));
    assert.equal(p.window.document.body.dataset.theme, 'paper');
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'paper');
    p.push({ type: 'themeChoice', theme: 'paper', landed: false });
    assert.equal(p.window.document.body.dataset.theme, 'ink');
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'ink');
  });

  it('keeps a later pick when an earlier one is refused', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'ink' }));
    const menu = openSettings(p, 'Appearance');
    swatch(menu, 'paper').click();
    swatch(menu, 'neon').click();
    p.push({ type: 'themeChoice', theme: 'paper', landed: false });
    assert.equal(p.window.document.body.dataset.theme, 'neon');
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'neon');
  });

  it('moves from the last dark swatch onto the first light one', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const menu = openSettings(p, 'Appearance');
    const jade = swatch(menu, 'malachite');
    jade.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    assert.equal(p.window.document.body.dataset.theme, 'paper');
    assert.equal(menu.querySelector<HTMLElement>('.sws.on')?.dataset.theme, 'paper');
  });

  it('follows a theme changed outside the panel', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'neon' }));
    assert.equal(p.window.document.body.dataset.theme, 'neon');
  });

  // `follow` is the absence of a preset, not a preset of host-coloured values:
  // an attribute left behind would keep overriding tokens with themselves.
  it('carries no attribute at all when following the host', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { theme: 'ink' }));
    p.push(stateMessage([groupView()], { theme: 'follow' }));
    assert.equal(p.window.document.body.dataset.theme, undefined);
  });
});

/** The rule a selector declares, brace to brace. */
const block = (selector: string): string => {
  const css = panelDocument();
  const at = css.indexOf(selector + ' {');
  assert.notEqual(at, -1, `no ${selector} block in the panel stylesheet`);
  return css.slice(at, css.indexOf('}', at));
};

/** Every shipped `squadron.theme` value that is a preset — `follow` is the
 *  absence of one, and is checked as `:root` where it is checked at all. */
const PRESETS = [
  'ink',
  'lift',
  'paper',
  'neon',
  'polaroid',
  'mario',
  'nightcity',
  'arasaka',
  'malachite'
];

/**
 * Selection and hover spend `--av-focus`. Hover is a flat border; selection
 * adds a ring and glow. The glow stays inside the grid gap so a selected card
 * does not wash its neighbour.
 *
 * **There is deliberately no assertion that `--av-focus` differs from a status
 * hue, and adding one back would be wrong.** It is the same blue as `--av-blue`
 * in ink, lift and paper, so such a test fails on the presets as shipped. There
 * was one once, against `--av-fg` — when selection was a white/near-black ring
 * that no status could wear — and it went out with that ring (`1860284`),
 * because a neutral that is identical in all eight presets is a ring that
 * flattens what makes each theme look like itself. Hue separation was traded
 * for theme identity on purpose, and the shape assertions below are what was
 * bought with it. The reasoning lives beside `--av-focus` in `css/base.ts`;
 * this has now been read as an unguarded regression twice.
 */
describe('the selected card', () => {
  it('is marked in the focus colour, with a ring and glow', () => {
    const rule = block('.card.selected');
    assert.match(rule, /var\(--av-focus\)/, 'the selected card lost its focus mark');
    assert.match(rule, /box-shadow[^;]*\d+px/, 'the selected card lost its glow');
  });

  // Hover is the same focus colour, quieter — border only, no glow.
  it('glows, where a hovered card only outlines', () => {
    const hover = block('.card:hover');
    assert.match(hover, /var\(--av-focus\)/, 'hover is not the focus colour');
    assert.doesNotMatch(hover, /box-shadow/, 'hover took the selected card’s glow');
  });

  it('needs no idle opacity override because no status dims', () => {
    assert.doesNotMatch(panelDocument(), /\.card\.(selected\.)?idle\s*\{[^}]*opacity/);
  });

  // The glow is the whole of the separation, so it is the one number here worth
  // pinning: under the grid's 10px gap, or a lit card washes the one beside it.
  it('keeps its glow inside the grid gap', () => {
    const blur = /0 0 7px/.exec(block('.card.selected'));
    assert.ok(blur, 'the selected card lost the 7px glow that separates it from a hover');
  });
});

describe('the presets', () => {
  it('declare every token the default set declares', () => {
    const tokens = (text: string): string[] =>
      [...text.matchAll(/(--av-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string);

    // Type and lifecycle opacity sit in the root but are not colour tokens. Type
    // is relative to the host's own font size, and a preset that restated it
    // would be overriding the reader's editor setting to make a colour change.
    const base = tokens(block(':root')).filter(
      (name) => !name.startsWith('--av-fs-') && name !== '--av-dim' && name !== '--av-ghost'
    );
    assert.ok(base.length > 20, 'the token layer looks empty');
    for (const name of PRESETS) {
      const declared = new Set(tokens(block(`body[data-theme="${name}"]`)));
      const missing = base.filter((token) => !declared.has(token));
      // Most of these would fall back to a host colour, the rest to the default
      // set's own hex. Either way the preset is not the one deciding.
      assert.deepEqual(missing, [], `${name} does not declare ${missing.join(', ')}`);
    }
  });
});

describe('shared lifecycle and motion tokens', () => {
  it('declares opacity and pulse period once, outside presets', () => {
    const root = block(':root');
    for (const [token, value] of [
      ['--av-dim', '.55'],
      ['--av-ghost', '.35'],
      ['--pulse-period', '1.5s']
    ]) {
      assert.ok(root.includes(`${token}: ${value};`), token);
      for (const name of PRESETS)
        assert.ok(!block(`body[data-theme="${name}"]`).includes(`${token}:`), name);
    }
  });
});
