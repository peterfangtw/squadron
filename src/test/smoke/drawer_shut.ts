import type { Locator } from 'playwright-core';

/**
 * Shut `#bottomdrawer` and leave its hidden state as the assertion.
 *
 * New workflow and a row's Edit call `close()`, which sets `hidden` and
 * starts the 180ms exit in `src/ui/css/bottom_drawer.ts` (only without
 * reduced motion). `isVisible()` stays true until that exit ends. A click
 * on `#bottomdrawer-close` in the interval never becomes stable, then the
 * node is `display: none`, so the click uses its whole timeout.
 *
 * Measured 2026-10-17 in headless Chrome 151, `prefers-reduced-motion:
 * no-preference`, with that transition: the click timed out at 10004ms and
 * the following hide wait took 2ms (10007ms). Skipping the click and
 * waiting for hidden took 182ms. A sheet that was still open clicked in
 * 32ms and hid in 283ms (318ms). A click that does not set `hidden` still
 * fails the hide wait at 10004ms. With reduced motion the node is not
 * visible on the same turn, and this returns without a click (3ms).
 */
export async function shutDrawer(sheet: Locator): Promise<void> {
  if (!(await sheet.isVisible())) return;
  // `hidden` is set for the whole exit, before the node stops being visible.
  if (!(await sheet.evaluate((node) => node.hasAttribute('hidden')))) {
    await sheet
      .locator('#bottomdrawer-close')
      .click({ timeout: 10_000 })
      .catch(() => {});
  }
  await sheet.waitFor({ state: 'hidden', timeout: 10_000 });
}
