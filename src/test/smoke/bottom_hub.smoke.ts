import * as assert from 'node:assert/strict';
import * as boot from './boot';

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
        await more.click();
        await stack.evaluate(async (node) => {
          await Promise.allSettled(
            node.getAnimations({ subtree: true }).map((animation) => animation.finished)
          );
        });
        const chipsFit = await stack.evaluate((node) => {
          const board = document.getElementById('board')!.getBoundingClientRect();
          const more = document.getElementById('bottomhub-more')!.getBoundingClientRect();
          const chips = [...node.children].map((chip) => chip.getBoundingClientRect());
          return (
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
        5
      );
    } finally {
      await board.evaluate((node) => {
        (node as HTMLElement).style.removeProperty('width');
        (node as HTMLElement).style.removeProperty('flex');
      });
    }
  });
});
