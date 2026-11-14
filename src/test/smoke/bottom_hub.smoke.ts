import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as boot from './boot';
import * as fixtures from '../harness';

boot.section('responsive bottom hub, in the real IDE', () => {
  boot.step('fits the board and expands separate chips above More', async () => {
    await boot.openPanel();
    const board = boot.panel().locator('#board');
    const more = boot.panel().locator('#bottomhub-more');
    const stack = boot.panel().locator('#bottomhub-overflow');
    try {
      for (const width of [240, 280, 320, 360, 480]) {
        await board.evaluate(async (node, size) => {
          const element = node as HTMLElement;
          element.style.flex = 'none';
          element.style.width = `${size}px`;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          );
        }, width);
        await more.waitFor({ state: 'visible' });
        const fits = await board.evaluate((node) => {
          const board = node.getBoundingClientRect();
          const bar = node.querySelector('#bottomhub')!.getBoundingClientRect();
          const row = node.querySelector('#bottomhub .bottomhub-row')!;
          return (
            bar.left >= board.left &&
            bar.right <= board.right &&
            row.scrollWidth <= row.clientWidth + 1
          );
        });
        assert.equal(fits, true, `bar overflowed a ${width}px board`);
        const primaryFits = await boot
          .panel()
          .locator('#bottomhub .bottomhub-row > button')
          .first()
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
        assert.equal(primaryFits, true, `primary label clipped at ${width}px`);
        await more.hover();
        await stack.evaluate(async (node) => {
          await Promise.allSettled(
            node.getAnimations({ subtree: true }).map((animation) => animation.finished)
          );
        });
        const chipsFit = await stack.evaluate((node) => {
          const board = document.getElementById('board')!.getBoundingClientRect();
          const more = document.getElementById('bottomhub-more')!.getBoundingClientRect();
          const stack = node.getBoundingClientRect();
          const chips = [...node.children].map((chip) => chip.getBoundingClientRect());
          return (
            Math.abs(
              (document.getElementById('bottomhub')!.getBoundingClientRect().left +
                document.getElementById('bottomhub')!.getBoundingClientRect().right) /
                2 -
                (board.left + board.right) / 2
            ) <= 1 &&
            Math.abs(chips[0]!.left - Math.min(more.left, board.right - stack.width - 8)) <= 1 &&
            chips.length > 0 &&
            chips.every(
              (chip, i) =>
                chip.left >= board.left &&
                chip.right <= board.right &&
                chip.top >= board.top &&
                chip.bottom < more.top &&
                (i === 0 || chip.top - chips[i - 1]!.bottom >= 7)
            )
          );
        });
        assert.equal(chipsFit, true, `chips overflowed or shared a row at ${width}px`);
        await more.press('Escape');
        await stack.waitFor({ state: 'hidden' });
        assert.equal(await more.evaluate((node) => node === document.activeElement), true);
      }
      await board.evaluate(async (node) => {
        (node as HTMLElement).style.width = '240px';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await more.click();
      await stack.locator('.warm-tab').click();
      await boot.panel().locator('#bottomdrawer.warm').waitFor({ state: 'visible' });
      await boot.panel().locator('body').press('Escape');
      assert.equal(await more.evaluate((node) => node === document.activeElement), true);
      await board.evaluate(async (node) => {
        (node as HTMLElement).style.width = '900px';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await more.waitFor({ state: 'hidden' });
      assert.equal(
        await boot.panel().locator('#bottomhub .bottomhub-row > button:not([hidden])').count(),
        6
      );
    } finally {
      await board.evaluate((node) => {
        (node as HTMLElement).style.removeProperty('width');
        (node as HTMLElement).style.removeProperty('flex');
      });
    }
  });

  boot.step('shows accessible warning pills on hover, with contrast across themes', async () => {
    await boot.holdingHostState(async () => {
      const board = boot.panel().locator('#board');
      const originalStyle = await board.getAttribute('style');
      const groups = [
        fixtures.groupView({
          sessions: Array.from({ length: 12 }, (_, i) =>
            fixtures.cardView({
              pid: 5000 + i,
              name: `Review request ${i + 1}`,
              status: 'waiting',
              owned: true
            })
          )
        })
      ];
      try {
        await board.evaluate((node) => {
          node.style.flex = 'none';
          node.style.width = '700px';
        });
        for (const theme of [
          'follow',
          'ink',
          'lift',
          'paper',
          'neon',
          'polaroid',
          'mario',
          'nightcity',
          'arasaka',
          'malachite'
        ] as const) {
          const state = fixtures.stateMessage(groups, { theme });
          await boot
            .panel()
            .locator('body')
            .evaluate(
              (_, data) => window.dispatchEvent(new MessageEvent('message', { data })),
              state
            );
          const agents = boot.panel().locator('.agents-tab');
          await agents.hover();
          const stack = boot.panel().locator('#bottomhub-waiting');
          await stack.waitFor({ state: 'visible' });
          await stack.evaluate(async (node) => {
            await Promise.allSettled(
              node.getAnimations({ subtree: true }).map((animation) => animation.finished)
            );
          });
          const measured = await stack.evaluate((node) => {
            const trigger = document.querySelector('.agents-tab')!.getBoundingClientRect();
            const box = node.getBoundingClientRect();
            const chip = node.querySelector('button')!;
            const style = getComputedStyle(chip);
            const badge = getComputedStyle(document.querySelector('.waiting-count')!);
            const channels = (color: string): number[] =>
              (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            const luminance = (color: string): number =>
              channels(color)
                .map((v) => {
                  const c = v / 255;
                  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
            const fg = luminance(style.color),
              bg = luminance(style.backgroundColor);
            const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
            return {
              left: Math.abs(box.left - trigger.left),
              above: box.bottom <= trigger.top,
              scrolls: node.scrollHeight > node.clientHeight,
              ratio,
              badgeMatches:
                badge.backgroundColor === style.backgroundColor && badge.color === style.color
            };
          });
          assert.ok(
            measured.left <= 1 && measured.above && measured.scrolls,
            `${theme}: ${JSON.stringify(measured)}`
          );
          assert.ok(
            measured.ratio >= 4.5 && measured.badgeMatches,
            `${theme}: ${JSON.stringify(measured)}`
          );
          const run = process.env['SQUADRON_RUN'];
          if (run && theme === 'mario')
            await board.screenshot({ path: path.join(run, 'session-attention.png') });
          const nearest = stack.locator('button').last();
          await nearest.hover();
          assert.equal(await stack.isVisible(), true, 'crossing the gap retains the stack');
          const hover = await nearest.evaluate((node) => ({
            filter: getComputedStyle(node).filter,
            underline: getComputedStyle(node).textDecorationLine
          }));
          assert.equal(hover.filter, 'brightness(1.12)');
          assert.equal(hover.underline, 'none');
          await agents.press('Escape');
        }
        await boot.panel().locator('.agents-tab').press('ArrowUp');
        assert.equal(await boot.panel().locator('#bottomhub-waiting button:focus').count(), 1);
        await boot.panel().locator('#bottomhub-waiting button:focus').press('Escape');
        await boot.panel().locator('.agents-tab').click();
        await boot.panel().locator('#bottomdrawer.agents').waitFor({ state: 'visible' });
        assert.equal(await boot.panel().locator('#bottomhub-waiting').isVisible(), false);
        await boot.panel().locator('body').press('Escape');
      } finally {
        await board.evaluate((node, style) => {
          if (style === null) node.removeAttribute('style');
          else node.setAttribute('style', style);
        }, originalStyle);
      }
    });
  });
});
