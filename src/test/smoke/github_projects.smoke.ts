import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { before } from 'node:test';
import { ctx, openPanel, panel, section, step } from './boot';

section('GitHub Projects through the host', () => {
  before(openPanel);
  step(
    'connects a project, explains unavailable facets and retains shipped collapse behavior',
    async () => {
      await panel().locator('#board-tickets').click();
      const source = panel().locator('#tk-source .scope-button');
      if (await source.count()) {
        await source.click();
        await panel()
          .getByRole('menuitemradio', { name: 'Connect a ticket source…', exact: true })
          .click();
      } else
        await panel()
          .getByRole('button', { name: 'Connect a ticket source…', exact: true })
          .click();
      await ctx.page.locator('.quick-input-widget').waitFor({ state: 'visible' });
      await ctx.page.keyboard.type('GitHub Projects');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.getByText('I have a classic token', { exact: true }).waitFor();
      await ctx.page.keyboard.type('I have a classic token');
      await ctx.page.keyboard.press('Enter');
      await ctx.page
        .locator('.quick-input-title', { hasText: 'Connect GitHub Projects' })
        .waitFor();
      await ctx.page.keyboard.type('acme');
      await ctx.page.keyboard.press('Enter');
      await ctx.page
        .locator('.quick-input-message', { hasText: 'Paste a classic token' })
        .waitFor();
      await ctx.page.keyboard.type('github_pat_fine_grained');
      await ctx.page.keyboard.press('Enter');
      await ctx.page
        .getByText('Use a personal access token (classic), not a fine-grained token.', {
          exact: true
        })
        .waitFor();
      await ctx.page.locator('.quick-input-widget input').fill('');
      await ctx.page.keyboard.type('github_smoke');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
      await panel().locator('#tk-source .scope-button').click();
      await panel().locator('#tk-source .mitem', { hasText: 'GitHub / Engineering' }).click();
      await panel().locator('.tk', { hasText: 'acme/web#12' }).waitFor();
      const disabled = panel().locator('#tk-filter [aria-disabled="true"]');
      assert.equal(await disabled.count(), 2);
      await disabled.first().hover();
      await panel()
        .locator('.tip', { hasText: 'No usable single-select field named "Status"' })
        .waitFor();
      await disabled.first().focus();
      assert.match((await disabled.first().getAttribute('aria-label')) ?? '', /Status/);
      assert.match(await disabled.first().ariaSnapshot(), /No usable single-select field named/);
      const head = panel().locator('.lane .lhead');
      await head.click();
      await panel().locator('.lane.shut').waitFor();
      await panel().locator('#tk-actions .refresh').click();
      await panel().locator('#tk-actions .refresh:enabled').waitFor();
      assert.equal(await panel().locator('.lane.shut').count(), 1);
      await head.click();
      await panel().locator('.tk', { hasText: 'acme/web#12' }).click();
      await panel().locator('#ticket-detail', { hasText: 'alex, sam' }).waitFor();
      await panel().locator('#ticket-detail .ax').click();
    }
  );
  step('keeps column headers in place when an assignee filter matches no issues', async () => {
    const head = panel().locator('.lane .lhead');
    const before = await head.boundingBox();
    assert.ok(before);
    await panel().locator('#tk-filter .fpill').first().click();
    await panel().getByRole('menuitemradio', { name: 'Unassigned', exact: true }).click();
    const empty = panel().locator('#tk-list .tkempty');
    await empty.waitFor();
    assert.match((await empty.textContent()) ?? '', /No tickets match/);
    const after = await head.boundingBox();
    assert.ok(after);
    assert.equal(after.y, before.y, 'the empty state moved the column header');
    assert.equal(after.x, before.x);
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    const board = await panel().locator('#tk-list').boundingBox();
    const message = await empty.boundingBox();
    assert.ok(board && message);
    assert.ok(message.y > after.y + after.height, 'empty state obscures the column header');
    const padding = await panel()
      .locator('#tk-list')
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) };
      });
    const center = board.y + padding.top + (board.height - padding.top - padding.bottom) / 2;
    assert.ok(
      Math.abs(message.y + message.height / 2 - center) < 4,
      'empty state is not centered within the usable board area'
    );
    const runFolder = process.env['SQUADRON_RUN'];
    if (runFolder) await ctx.page.screenshot({ path: path.join(runFolder, 'tickets-empty.png') });
    await head.click();
    await panel().locator('.lane.shut').waitFor();
    await head.click();
    await panel().locator('#tk-filter .fpill').first().click();
    await panel().getByRole('menuitemradio', { name: 'Anyone (All)', exact: true }).click();
    await panel().locator('.tk', { hasText: 'acme/web#12' }).waitFor();
    await empty.waitFor({ state: 'detached' });
    const restored = await head.boundingBox();
    assert.equal(restored?.y, before.y);
  });
  step('disconnects GitHub through its source action and removes the connection', async () => {
    await panel().locator('#tk-source .scope-button').click();
    await panel().getByRole('menuitemradio', { name: 'Disconnect GitHub', exact: true }).click();
    await panel().locator('#tk-source', { hasText: 'No ticket source' }).waitFor();
    assert.equal(await panel().locator('#tk-list .tk').count(), 0);
    await panel().getByRole('button', { name: 'Connect a ticket source…', exact: true }).waitFor();
  });
});
