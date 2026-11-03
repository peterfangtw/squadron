import * as assert from 'node:assert/strict';
import * as boot from './boot';
import * as fixtures from '../harness';

/**
 * Where the permission word sits in the footer.
 *
 * jsdom holds the DOM order and the stylesheet. It lays nothing out, so a
 * word parked on the percentage would still pass. The owned smoke card is in
 * the default mode, which paints no word, so this pushes its own cards.
 */

interface Edge {
  left: number;
  right: number;
}

interface Sample {
  foot: Edge;
  name: Edge | null;
  mode: Edge | null;
  reading: Edge;
  hit: string | null;
  nameClipped: boolean;
  modeClipped: boolean;
}

boot.section('the permission word in the footer, in the real IDE', () => {
  boot.step('sticks the word to the branch and leaves the reading at the right', async () => {
    await boot.openPanel();
    const message = fixtures.stateMessage([
      fixtures.groupView({
        sessions: [
          fixtures.cardView({
            pid: 701,
            name: 'Per-game cursor hide',
            branch: 'staging',
            contextPct: 30,
            contextSize: 500_000,
            mode: { label: 'bypass', holds: false, bypass: true }
          }),
          fixtures.cardView({
            pid: 702,
            name: 'No branch',
            branch: undefined,
            contextPct: 30,
            contextSize: 500_000,
            mode: { label: 'bypass', holds: false, bypass: true }
          }),
          fixtures.cardView({
            pid: 703,
            name: 'Long branch',
            branch: 'feature/per-game-cursor-hide-across-the-whole-menu',
            contextPct: 46,
            contextSize: 500_000,
            mode: { label: 'bypass', holds: false, bypass: true }
          }),
          fixtures.cardView({
            pid: 704,
            name: 'No mode',
            branch: 'staging',
            contextPct: 30,
            contextSize: 500_000
          })
        ]
      })
    ]);
    const reading = await boot.holdingHostState(() =>
      boot
        .panel()
        .locator('body')
        .evaluate(async (_, state) => {
          window.dispatchEvent(new MessageEvent('message', { data: state }));
          await new Promise(requestAnimationFrame);
          const edge = (node: Element | null): Edge | null => {
            if (!node) return null;
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right };
          };
          const sample = (pid: number, width: number): Sample => {
            const card = document.querySelector<HTMLElement>(`.card[data-pid="${pid}"]`);
            if (!card) throw new Error(`no card ${pid}`);
            const held = {
              width: card.style.width,
              min: card.style.minWidth,
              max: card.style.maxWidth,
              justify: card.style.justifySelf
            };
            card.style.justifySelf = 'start';
            card.style.minWidth = '0';
            card.style.width = width + 'px';
            card.style.maxWidth = width + 'px';
            card.scrollIntoView({ block: 'center' });
            const foot = card.querySelector<HTMLElement>('.foot');
            const name = card.querySelector<HTMLElement>('.br .n');
            const mode = card.querySelector<HTMLElement>('.mode');
            const strip = card.querySelector<HTMLElement>('.strip-reading');
            if (!foot || !strip) throw new Error(`card ${pid} has no strip`);
            const modeBox = mode?.getBoundingClientRect();
            const hit = modeBox
              ? (document
                  .elementFromPoint(
                    modeBox.left + modeBox.width / 2,
                    modeBox.top + modeBox.height / 2
                  )
                  ?.closest('.mode, .br, .strip-reading')?.className ?? null)
              : null;
            const out: Sample = {
              foot: edge(foot)!,
              name: edge(name),
              mode: edge(mode),
              reading: edge(strip)!,
              hit,
              nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
              modeClipped: mode ? mode.scrollWidth > mode.clientWidth + 1 : false
            };
            card.style.width = held.width;
            card.style.minWidth = held.min;
            card.style.maxWidth = held.max;
            card.style.justifySelf = held.justify;
            return out;
          };
          return {
            split: sample(701, 320),
            branchless: sample(702, 320),
            cramped: sample(703, 220),
            plain: sample(704, 320)
          };
        }, message)
    );

    const gap = (from: Edge, to: Edge): number => to.left - from.right;
    const split = reading.split;
    assert.ok(split.name && split.mode, 'the split card lost its branch or its mode');
    assert.ok(
      gap(split.name, split.mode) < 20,
      `the word left the branch by ${gap(split.name, split.mode)}px`
    );
    assert.ok(
      gap(split.mode, split.reading) > 40,
      `the reading stayed on the word, ${gap(split.mode, split.reading)}px away`
    );
    assert.ok(split.reading.right <= split.foot.right + 1, 'the reading overflows the strip');
    assert.ok(split.foot.right - split.reading.right < 20, 'the reading left the right end');
    assert.equal(split.hit, 'mode bypass');

    const branchless = reading.branchless;
    assert.ok(branchless.mode, 'the branchless card lost its mode');
    assert.ok(
      branchless.mode.left - branchless.foot.left < 24,
      `a branchless word starts at ${branchless.mode.left - branchless.foot.left}px`
    );
    assert.ok(branchless.reading.right <= branchless.foot.right + 1);
    assert.ok(branchless.foot.right - branchless.reading.right < 20);
    assert.ok(gap(branchless.mode, branchless.reading) > 40);

    const cramped = reading.cramped;
    assert.ok(cramped.name && cramped.mode, 'the cramped card lost its branch or its mode');
    assert.equal(cramped.hit, 'mode bypass', `the branch covers the word (${cramped.hit})`);
    assert.equal(cramped.modeClipped, false, 'the word itself was clipped');
    assert.ok(
      cramped.reading.right <= cramped.foot.right + 1,
      'the reading overflows when cramped'
    );
    assert.ok(cramped.nameClipped, 'a long branch did not give way');

    const plain = reading.plain;
    assert.equal(plain.mode, null, 'a default card painted a mode');
    assert.ok(plain.name, 'the plain card lost its branch');
    assert.ok(plain.name.left - plain.foot.left < 40, 'the branch left the left end');
    assert.ok(plain.reading.right <= plain.foot.right + 1);
    assert.ok(plain.foot.right - plain.reading.right < 20, 'the reading left the right end');
    assert.ok(gap(plain.name, plain.reading) > 40, 'the reading sat on the branch');
  });
});
