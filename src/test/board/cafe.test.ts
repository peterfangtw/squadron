import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { css } from '../../ui/css/cafe';
import { LEASE_MS } from '../../ui/lease';
import { cardView, groupView, openPanel, stateMessage } from '../harness';

/** One ordinary group, since none of these scenarios care what is on the board. */
const board = (pid = 100) => [groupView({ sessions: [cardView({ pid })] })];

/** A coffee with `share` of a lease left to run. */
const coffee = (share: number): AwakeView => ({
  reason: 'drinking',
  until: Date.now() + share * LEASE_MS,
  sessions: 1
});

/**
 * The cup is dismounted, 2026-10-05: an open panel spent ~25% of a core
 * animating it. `webview/cafe.ts` and `pot.ts` stay for whatever shows the
 * café's status next, and the hold the host runs is untouched — so the panel
 * is still handed `awake`, and must not draw it.
 */
describe('the café cup', () => {
  it('is not mounted, even while the machine is held', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { awake: coffee(1) }));
    assert.equal(p.window.document.querySelector('#cafe'), null);
  });
});

/**
 * Two of the café's subtrees sit at `opacity: 0` for almost the whole of a
 * lease — the steam until the cup is hot, the pour until the pot leans in — and
 * an opacity of zero does not stop an animation from ticking. A keyframe on
 * something invisible is style recalc and paint at frame rate for nobody, and
 * `.streaks` is the worst of them: `stroke-dashoffset` cannot be composited, so
 * it is main-thread work on every frame of a half-second cycle.
 *
 * So the rule is not "fewer animations" but "an animation under a hidden
 * subtree names the class that reveals it". `.drift` is deliberately not here:
 * the coffee surface is visible whenever the cup is, so it has nothing to gate
 * on. This reads the stylesheet source rather than a computed style because the
 * defect is a *missing selector*, which no rendered cup can be asked about.
 */
describe('the café animates nothing it is not showing', () => {
  /** Which class has to appear on a rule that runs each hidden animation. */
  const GATES: Record<string, string> = {
    // The steam, revealed by `#cafe.hot .steam`.
    'cafe-rise': '.hot',
    // Both halves of the pour, revealed by `#cafe.pouring`.
    'cafe-rip': '.pouring',
    'cafe-streaks': '.pouring'
  };

  /** cafe.ts with its `@keyframes` bodies dropped, so the braces nested inside
   *  one cannot be read as a rule of their own. A `@media` opener survives as a
   *  stray brace, which is harmless: the rules inside it still match. */
  const flat = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const rules = [...flat.matchAll(/([^{}@]+)\{([^{}]+)\}/g)].map((m) => ({
    selector: (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body: m[2] ?? ''
  }));

  for (const [name, gate] of Object.entries(GATES)) {
    it(`runs ${name} only under ${gate}`, () => {
      // `animation: none` is the reduced-motion override, not a run of it.
      const runs = rules.filter(
        (r) => new RegExp(`\\b${name}\\b`).test(r.body) && !/animation:\s*none/.test(r.body)
      );
      assert.ok(runs.length > 0, `${name} is animated by nothing — renamed?`);
      for (const rule of runs) {
        assert.ok(
          rule.selector.includes(gate),
          `${rule.selector} runs ${name} without ${gate}, so it animates while invisible`
        );
      }
    });
  }

  /** A media query adds no specificity, so a reduced-motion override written
   *  one class shorter than the rule it means to beat loses the cascade and
   *  reads as working. `#cafe .rip` against `#cafe.pouring .rip` was exactly
   *  that, and left the ripples running for a reader who asked for no motion. */
  it('stops every hidden animation under reduced motion', () => {
    const off = rules.filter((r) => /animation:\s*none/.test(r.body));
    for (const [name, gate] of Object.entries(GATES)) {
      const run = rules.find(
        (r) => new RegExp(`\\b${name}\\b`).test(r.body) && !/animation:\s*none/.test(r.body)
      );
      const classes = (run?.selector.match(/\.[\w-]+/g) ?? []).length;
      const beats = off.some((r) => {
        const part = r.selector.split(',').find((s) => s.includes(gate));
        return part !== undefined && (part.match(/\.[\w-]+/g) ?? []).length >= classes;
      });
      assert.ok(beats, `nothing outweighs the rule running ${name}, so it survives reduce`);
    }
  });
});
