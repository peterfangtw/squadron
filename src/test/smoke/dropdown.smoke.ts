import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as boot from './boot';
import * as kit from './kit';

boot.section('composer dropdown borders, in the real IDE', () => {
  boot.step('shares border styling at rest and while each menu is open', async () => {
    await boot.openPanel();
    await kit.openDraft();
    const model = boot.panel().locator('#ctools .fpill.model');
    await model.click();
    await boot
      .panel()
      .locator('.fmenu:not([hidden]) .wp')
      .filter({ hasText: '1M' })
      .first()
      .click();
    const effort = boot.panel().locator('#ctools .fpill.effort');
    await effort.waitFor();
    await kit.composer().focus();

    const read = async (selector: string) =>
      boot
        .panel()
        .locator(selector)
        .evaluate((node) => {
          const css = getComputedStyle(node);
          return {
            color: css.borderTopColor,
            width: css.borderTopWidth,
            style: css.borderTopStyle
          };
        });
    const resting = await read('#ctools .fpill.model');
    assert.deepEqual(resting, await read('#ctools .fpill.effort'));
    const onePixelBorder = await model.evaluate((node) => {
      const reference = document.createElement('span');
      reference.style.borderTop = '1px solid';
      node.append(reference);
      const width = getComputedStyle(reference).borderTopWidth;
      reference.remove();
      return width;
    });
    assert.equal(resting.width, onePixelBorder);
    assert.equal(resting.style, 'solid');
    assert.notEqual(resting.color, 'rgba(0, 0, 0, 0)');
    const run = process.env['SQUADRON_RUN'];
    if (run)
      await boot
        .panel()
        .locator('#composer')
        .screenshot({ path: path.join(run, 'dropdown.png') });

    await model.hover();
    const hovered = await read('#ctools .fpill.model');
    await effort.hover();
    assert.deepEqual(hovered, await read('#ctools .fpill.effort'));
    await boot.panel().locator('#input').hover();
    await model.focus();
    const focused = await read('#ctools .fpill.model');
    await effort.focus();
    assert.deepEqual(focused, await read('#ctools .fpill.effort'));

    await model.click();
    const expanded = await read('#ctools .fpill.model');
    await boot.ctx.page.keyboard.press('Escape');
    await effort.click();
    assert.deepEqual(expanded, await read('#ctools .fpill.effort'));
    await boot.ctx.page.keyboard.press('Escape');
  });

  boot.step('keeps the empty code-block hint aligned and unformatted', async () => {
    const hint = boot.panel().locator('.hintghost');
    const read = () =>
      hint.evaluate((node) => {
        const label = node.querySelector('.hintlabel')!;
        const keys = node.querySelector('.hintkeys')!;
        const a = label.getBoundingClientRect();
        const b = keys.getBoundingClientRect();
        // centreDelta, not each mid: the toggle moves the composer and both
        // mids with it. The row is the label, the keys and the gap between them.
        return {
          label: label.textContent,
          labelLeft: a.left,
          keysLeft: b.left,
          centreDelta: (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2,
          font: getComputedStyle(label).fontFamily
        };
      });
    const before = await read();
    assert.equal(before.label, 'Describe a task…');
    assert.ok(Math.abs(before.centreDelta) < 2, `centres differ by ${before.centreDelta}`);
    assert.ok(
      before.keysLeft > before.labelLeft,
      `keys at ${before.keysLeft}, label at ${before.labelLeft}`
    );
    await boot.panel().locator('#formatbar [data-format="codeBlock"]').click();
    assert.deepEqual(await read(), before);
    const code = boot.panel().locator('#input pre');
    assert.equal(
      await code.evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgba(0, 0, 0, 0)'
    );
    const run = process.env['SQUADRON_RUN'];
    if (run)
      await boot
        .panel()
        .locator('#composer')
        .screenshot({ path: path.join(run, 'composer-hint.png') });
    await kit.composer().pressSequentially('const n = 1;');
    assert.equal(await hint.isVisible(), false);
    assert.notEqual(
      await code.evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgba(0, 0, 0, 0)'
    );
  });

  // The host's webview stylesheet fills every blockquote, which jsdom never
  // loads: only here does the quote's paint meet it.
  boot.step('quotes the caret line as a bar, over the host stylesheet', async () => {
    await kit.clearComposer();
    if (await boot.panel().locator('#input pre').isVisible()) {
      await boot.panel().locator('#formatbar [data-format="codeBlock"]').click();
    }
    const box = kit.composer();
    await box.pressSequentially('line1');
    await box.press('Shift+Enter');
    await box.pressSequentially('line2');
    await box.press('Shift+Enter');
    await box.pressSequentially('line3');
    await box.press('ArrowUp');
    await boot.panel().locator('#formatbar [data-format="blockquote"]').click();

    const quote = boot.panel().locator('#input blockquote');
    assert.equal(await quote.count(), 1);
    assert.equal(await quote.textContent(), 'line2');
    assert.equal(await kit.composerValue(), 'line1\n\n> line2\n\nline3');
    const paint = await quote.evaluate((node) => {
      const bar = getComputedStyle(node, '::before');
      return {
        fill: getComputedStyle(node).backgroundColor,
        bar: bar.width,
        barFill: bar.backgroundColor
      };
    });
    assert.equal(paint.fill, 'rgba(0, 0, 0, 0)');
    assert.equal(paint.bar, '4px');
    assert.notEqual(paint.barFill, 'rgba(0, 0, 0, 0)');
    const run = process.env['SQUADRON_RUN'];
    if (run)
      await boot
        .panel()
        .locator('#composer')
        .screenshot({ path: path.join(run, 'composer-quote.png') });
    await kit.clearComposer();
  });
});
