import * as assert from 'node:assert/strict';
import * as boot from './boot';
import * as fixtures from '../harness';

boot.section('permission mode beside the model, in the real IDE', () => {
  boot.step('keeps bypass beside the model and abbreviates it on narrow cards', async () => {
    await boot.openPanel();
    const message = fixtures.stateMessage([
      fixtures.groupView({
        sessions: [
          fixtures.cardView({
            pid: 701,
            name: 'Review session configuration',
            model: 'claude-opus-5',
            effort: 'high',
            branch: 'feature/review-session-configuration',
            contextPct: 30,
            contextSize: 500_000,
            mode: { label: 'bypass', holds: false, bypass: true }
          })
        ]
      })
    ]);
    await boot.holdingHostState(async () => {
      await boot
        .panel()
        .locator('body')
        .evaluate((_, data) => {
          window.dispatchEvent(new MessageEvent('message', { data }));
        }, message);
      const card = boot.panel().locator('.card[data-pid="701"]');
      await card.waitFor();
      const originalStyle = await card.getAttribute('style');
      try {
        for (const width of [320, 241, 240, 180, 120, 320]) {
          const sample = await card.evaluate((node, width) => {
            node.style.justifySelf = 'start';
            node.style.minWidth = '0';
            node.style.width = width + 'px';
            node.style.maxWidth = width + 'px';
            node.scrollIntoView({ block: 'center' });
            const mode = node.querySelector<HTMLElement>('.specs .mode');
            const model = node.querySelector('.s-model');
            const since = node.querySelector('.since');
            const reading = node.querySelector('.strip-reading');
            const foot = node.querySelector('.foot');
            if (!mode || !model || !since || !reading || !foot)
              throw new Error('session configuration or footer is missing');
            const glyph = mode.querySelector('.g')!;
            const label = mode.lastElementChild!;
            const box = mode.getBoundingClientRect();
            const modelBox = model.getBoundingClientRect();
            const sinceBox = since.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              contentWidth:
                node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              modeVisible: box.width > 0 && box.height > 0,
              sameRow: Math.abs(box.top + box.height / 2 - modelBox.top - modelBox.height / 2) <= 1,
              overlaps: modelBox.right > box.left + 1 || box.right > sinceBox.left + 1,
              gap: box.left - modelBox.right,
              glyphVisible: getComputedStyle(glyph).display !== 'none',
              labelHidden: getComputedStyle(label).clipPath !== 'none',
              tooltip: mode.dataset.tip,
              footerMode: foot.querySelector('.mode') !== null,
              readingContained:
                reading.getBoundingClientRect().right <= foot.getBoundingClientRect().right
            };
          }, width);
          assert.equal(sample.contentWidth, width);
          assert.equal(sample.modeVisible, true, `bypass missing at ${width}px`);
          assert.equal(sample.sameRow, true, `bypass left the model row at ${width}px`);
          assert.equal(sample.overlaps, false, `configuration overlaps at ${width}px`);
          assert.ok(sample.gap >= 0 && sample.gap < 70, `bypass left the model at ${width}px`);
          assert.equal(sample.glyphVisible, width <= 240);
          assert.equal(sample.labelHidden, width <= 240);
          assert.match(sample.tooltip ?? '', /permission mode: bypass/);
          assert.equal(sample.footerMode, false);
          assert.equal(sample.readingContained, true);
        }
      } finally {
        await card.evaluate((node, style) => {
          if (style === null) node.removeAttribute('style');
          else node.setAttribute('style', style);
        }, originalStyle);
      }
    });
  });
});
