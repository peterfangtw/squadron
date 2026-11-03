import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panelDocument } from '../../ui/document';

/**
 * The contrast ladder each preset builds: board to card, card to the raised
 * surface, card to its border, and text and accents against the card.
 *
 * **The surface ladder does not fail.** It prints, and it flags. There is no
 * standard for the step between two adjacent surfaces — WCAG has plenty to say
 * about text on a background and nothing at all about a card on a board — so
 * any floor is this repo's own opinion, and four presets are under the one
 * below as it stands.
 * Turning that into a red gate would be this file deciding a design question
 * that belongs to whoever owns the presets. So the readings go out as
 * `t.diagnostic()`, which `node --test` prints and never counts.
 *
 * When there is an agreed floor, the assertion goes here and this comment goes
 * with it. Until then it is a reading, on the same footing as the surface-area
 * measurement in `docs/design_tokens/color_balance.html` — which is generated
 * from a real render and is where the numbers this file prints came from.
 *
 * Filled status text, separately, has a WCAG AA floor of 4.5:1 below.
 *
 * Kept out of `theme.test.ts` deliberately: that file drives the picker and
 * reads the sheet for *presence* (a preset that forgets a token), which needs
 * no colour arithmetic. This one is arithmetic and nothing else.
 */

/** The rule a selector declares, brace to brace. Same walk `theme.test.ts`
 *  does; four lines, and not worth a shared helper across two files. */
const block = (selector: string): string | undefined => {
  const css = panelDocument();
  const at = css.indexOf(selector + ' {');
  return at === -1 ? undefined : css.slice(at, css.indexOf('}', at));
};

/**
 * Every `--av-*` a block declares, by name.
 *
 * Comments are stripped first, and that is not tidiness. `paper`'s block
 * carries the line "not a percentage of --av-fg:" in prose, which this pattern
 * matches as a declaration whose value runs to the next `;` — and because it
 * sits *after* the real one, the Map takes it. The reading that produced was
 * `paper fg:card —`, an unresolvable colour on the one preset whose comments
 * name a token.
 */
const declared = (text: string): Map<string, string> =>
  new Map(
    [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--av-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(
      (m) => [m[1] as string, (m[2] as string).trim()]
    )
  );

type Rgb = { r: number; g: number; b: number };

const hex = (value: string): Rgb | undefined => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return undefined;
  const s = m[1] as string;
  const wide = s.length === 6 ? s : [...s].map((c) => c + c).join('');
  return {
    r: parseInt(wide.slice(0, 2), 16),
    g: parseInt(wide.slice(2, 4), 16),
    b: parseInt(wide.slice(4, 6), 16)
  };
};

/**
 * A token's value as a colour. Three shapes appear in these blocks and no
 * fourth: a literal hex, `var(--av-other)`, and the one `color-mix()` —
 * `--av-lift`, which is a stated *step* rather than a borrowed value (see the
 * comment at `--av-lift` in `css/base.ts`). The mix is computed in sRGB, which
 * is the space it names.
 */
const resolve = (
  name: string,
  tokens: Map<string, string>,
  seen = new Set<string>()
): Rgb | undefined => {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const value = tokens.get(name);
  if (value === undefined) return undefined;

  const literal = hex(value);
  if (literal) return literal;

  const alias = /^var\((--(?:av|vscode)-[a-z0-9-]+)\)$/.exec(value);
  if (alias) return resolve(alias[1] as string, tokens, seen);

  const mix =
    /^color-mix\(in srgb,\s*var\((--av-[a-z0-9-]+)\)\s*([\d.]+)%,\s*var\((--av-[a-z0-9-]+)\)\)$/.exec(
      value
    );
  if (mix) {
    const top = resolve(mix[1] as string, tokens, seen);
    const base = resolve(mix[3] as string, tokens, new Set());
    if (!top || !base) return undefined;
    const w = Number(mix[2]) / 100;
    return {
      r: top.r * w + base.r * (1 - w),
      g: top.g * w + base.g * (1 - w),
      b: top.b * w + base.b * (1 - w)
    };
  }
  return undefined;
};

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb): number =>
  0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

/** WCAG 2.x contrast. On a surface pair this is not a legibility claim — it is
 *  the one scale both ends of the ladder can be stated on. */
const ratio = (a: Rgb | undefined, b: Rgb | undefined): number | undefined => {
  if (!a || !b) return undefined;
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * The floors, and where they come from. All four are this repo's, none is a
 * standard, and none of them fails a build.
 *
 * `bgCard` is the one that matters: below it a card is not a surface above the
 * board but a rectangle with a border drawn round it. Set just under the
 * presets written specifically to fix the host's flat ground, and read off the
 * case it exists for — Dark Modern puts `#202020` on `#1f1f1f`, a ratio of
 * 1.01, which is `follow` and is the panel's default.
 *
 * `fgCard` is the one borrowed value: WCAG 2.x AAA for body text.
 */
const FLOOR = { bgCard: 1.1, cardBorder: 1.25, fgCard: 7, accent: 3.5 };

const ACCENTS = ['blue', 'orange', 'purple', 'green', 'red', 'yellow', 'focus', 'link'];

const fixed = (n: number | undefined, places = 2): string =>
  n === undefined ? '—' : n.toFixed(places);

/** Compared at the precision it is printed at, so a flag can never contradict
 *  the number beside it — `polaroid`'s bg:card is 1.0999…, and reading
 *  "1.10 < 1.1" in a warning is how a reader stops trusting the warning. */
const under = (n: number | undefined, floor: number, places = 2): boolean =>
  n !== undefined && Number(n.toFixed(places)) < floor;

describe('the preset contrast ladder', () => {
  // The one assertion in this file, and it is about the measurement rather than
  // about any preset: that every preset was actually read. Without it a rename
  // in `css/base.ts` would leave this printing nothing, passing forever, and
  // measuring no theme at all — which is the way a warning-only test dies.
  it('reads a ladder off every preset, and warns where a step is shallow', (t) => {
    const css = panelDocument();
    const presets = [...css.matchAll(/body\[data-theme="([a-z]+)"\]\s*\{/g)].map(
      (m) => m[1] as string
    );
    assert.ok(presets.length >= 8, `only ${presets.length} presets found in the stylesheet`);

    const shallow: string[] = [];
    let read = 0;

    for (const name of presets) {
      const rule = block(`body[data-theme="${name}"]`);
      if (!rule) {
        t.diagnostic(`${name}: no preset block — the ladder was not read`);
        continue;
      }
      const tokens = declared(rule);
      // `block()` slices to the first `}`, which a brace inside a comment would
      // cut short. No preset comment holds one today; this is what would say so
      // if one ever did, rather than the ladder quietly reading half a preset.
      if (!tokens.has('--av-hl-number')) {
        t.diagnostic(`${name}: block looks truncated — ${tokens.size} tokens, no --av-hl-number`);
      }
      const at = (token: string) => resolve(`--av-${token}`, tokens);

      const bgCard = ratio(at('bg'), at('card'));
      const cardLift = ratio(at('card'), at('lift'));
      const cardBorder = ratio(at('card'), at('border'));
      const fgCard = ratio(at('fg'), at('card'));
      const accents = ACCENTS.map((k) => ratio(at(k), at('card'))).filter(
        (n): n is number => n !== undefined
      );
      const lowest = accents.length ? Math.min(...accents) : undefined;

      if (bgCard === undefined) {
        t.diagnostic(`${name}: could not resolve --av-bg or --av-card`);
        continue;
      }
      read++;

      t.diagnostic(
        `${name.padEnd(10)} bg:card ${fixed(bgCard)}  card:lift ${fixed(cardLift)}  ` +
          `card:border ${fixed(cardBorder)}  fg:card ${fixed(fgCard, 1)}  ` +
          `accent:card lowest ${fixed(lowest)}`
      );

      // Flagged, not failed. `card:lift` is deliberately not among these: it is
      // exactly 1.00 on the two light presets because there is nothing above
      // `#ffffff` to mix toward, which `css/base.ts` reasons about at length.
      const flags: string[] = [];
      if (under(bgCard, FLOOR.bgCard)) flags.push(`bg:card ${fixed(bgCard)} < ${FLOOR.bgCard}`);
      if (under(cardBorder, FLOOR.cardBorder))
        flags.push(`card:border ${fixed(cardBorder)} < ${FLOOR.cardBorder}`);
      if (under(fgCard, FLOOR.fgCard, 1))
        flags.push(`fg:card ${fixed(fgCard, 1)} < ${FLOOR.fgCard}`);
      if (under(lowest, FLOOR.accent)) flags.push(`accent:card ${fixed(lowest)} < ${FLOOR.accent}`);
      if (flags.length) shallow.push(`${name} — ${flags.join(', ')}`);
    }

    assert.equal(
      read,
      presets.length,
      `read a ladder off ${read} of ${presets.length} presets — the rest could not be resolved`
    );

    if (shallow.length) {
      t.diagnostic(`under floor (nothing fails on this): ${shallow.length} of ${read}`);
      for (const line of shallow) t.diagnostic(`  ${line}`);
      t.diagnostic('surface area for the same presets: docs/design_tokens/color_balance.html');
    }
  });
});

describe('the filled status pills', () => {
  const check = (name: string, tokens: Map<string, string>): void => {
    for (const accent of ['green', 'red']) {
      const contrast = ratio(
        resolve(`--av-${accent}`, tokens),
        resolve(`--av-on-${accent}`, tokens)
      );
      assert.ok(contrast !== undefined, `${name}: unresolved ${accent} pill`);
      assert.ok(contrast >= 4.5, `${name}: ${accent} pill contrast ${contrast.toFixed(2)} < 4.5`);
    }
  };

  it('keeps done and failed text legible in every preset', () => {
    const presets = [...panelDocument().matchAll(/body\[data-theme="([a-z]+)"\]\s*\{/g)];
    assert.ok(presets.length >= 9, 'no complete preset set');
    for (const preset of presets) {
      const name = preset[1] as string;
      check(name, declared(block(`body[data-theme="${name}"]`) ?? ''));
    }
  });

  // Chart defaults read from the installed stock VS Code color registry,
  // 2026-10-07. charts.red aliases editorError.foreground; hcLight uses its
  // own webview body class rather than vscode-light.
  for (const [host, green, red] of [
    ['vscode-dark', '#89D185', '#F14C4C'],
    ['vscode-light', '#388A34', '#E51400'],
    ['vscode-high-contrast', '#89D185', '#F48771'],
    ['vscode-high-contrast-light', '#374e06', '#B5200D']
  ] as const) {
    it(`keeps done and failed text legible when following ${host}`, () => {
      const tokens = new Map([
        ...declared(block(':root') ?? ''),
        ...declared(block(`.${host}`) ?? ''),
        ['--vscode-charts-green', green],
        ['--vscode-charts-red', red]
      ]);
      check(host, tokens);
    });
  }
});
