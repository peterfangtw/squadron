import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import * as boot from './boot';

/**
 * Keep-awake on the bottom drawer, where jsdom has no layout and no host. The
 * open frame stays on screen with its two columns side by side, and each
 * switch, pressed by pointer, lands in this profile's settings through the
 * host's `setFlag`. What the master switch says for each hold is `awake_sheet.test.ts`.
 */

const word = () => boot.panel().locator('#bottomhub .awake-tab');
const sheet = () => boot.panel().locator('#bottomdrawer');
const toggle = (label: string) =>
  sheet().locator('.bdlist [role="switch"]', {
    has: boot.panel().getByText(label, { exact: true })
  });

async function openAwake(): Promise<void> {
  if (
    await sheet()
      .isVisible()
      .catch(() => false)
  )
    return;
  if (!(await word().isVisible())) await boot.panel().locator('#bottomhub-more').click();
  await word().click();
  await sheet().waitFor({ state: 'visible', timeout: 10_000 });
  // `hidden` clears at the start of the rise; wait out the translate.
  await sheet().evaluate(async (n) => {
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const shift = getComputedStyle(n).translate;
      if (shift === 'none' || shift === '0px 0px') return;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

/** What the host wrote to this profile's User settings for one key. */
async function waitSetting(key: string, want: unknown): Promise<void> {
  const file = path.join(boot.ctx.profile, 'data', 'User', 'settings.json');
  const start = Date.now();
  let last: unknown = 'missing';
  while (Date.now() - start < 15_000) {
    try {
      last = (JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>)[key];
      if (last === want) return;
    } catch (why) {
      last = String(why);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(
    `${key} stayed ${JSON.stringify(last)} in settings.json, wanted ${JSON.stringify(want)}`
  );
}

async function flip(label: string, key: string, want: boolean): Promise<void> {
  // A plain click, with no `force`: Playwright refuses a target another box
  // covers, which is the reachability the case is about.
  await toggle(label).click();
  await toggle(label)
    .and(boot.panel().locator(`[aria-checked="${want}"]`))
    .waitFor({ timeout: 10_000 });
  await waitSetting(key, want);
}

boot.section('Keep-awake on the bottom drawer, in the real IDE', () => {
  before(async () => {
    await boot.openPanel();
  });

  boot.step('opens on screen, with the master switch beside the figures', async () => {
    await openAwake();
    const box = await sheet().evaluate((n) => {
      const r = n.getBoundingClientRect();
      const board = document.getElementById('board')?.getBoundingClientRect();
      const row = n.querySelector('.awake-now')?.getBoundingClientRect();
      const figures = n.querySelector('.bddetail .awake-cfg')?.getBoundingClientRect();
      return {
        height: r.height,
        insetLeft: board ? r.left - board.left : Number.NaN,
        insetBottom: board ? board.bottom - r.bottom : Number.NaN,
        row: row ? { left: row.left, height: row.height } : null,
        figuresLeft: figures?.left ?? Number.NaN
      };
    });
    assert.ok(box.height > 40, 'the frame has no height');
    assert.ok(box.insetLeft >= 8 && box.insetLeft <= 16, `left inset ${box.insetLeft}px`);
    assert.ok(box.insetBottom >= -1 && box.insetBottom <= 2, `bottom inset ${box.insetBottom}px`);
    assert.ok(box.row && box.row.height > 20, 'the master switch has no height');
    assert.ok(box.figuresLeft > box.row.left + 8, 'the figures are not beside the master switch');
  });

  boot.step(
    'turns the Remote and Warm holds and keep-awake off and on through the host',
    async () => {
      await openAwake();
      await flip('Stay awake while Remote is on', 'squadron.cafe.remote', false);
      await flip('Stay awake while Remote is on', 'squadron.cafe.remote', true);
      await flip('Stay awake while Warm is on', 'squadron.cafe.warm', false);
      await flip('Stay awake while Warm is on', 'squadron.cafe.warm', true);
      await flip('Keep awake', 'squadron.cafe.enabled', false);
      for (const label of ['Stay awake while Remote is on', 'Stay awake while Warm is on'])
        await toggle(label)
          .and(boot.panel().locator('[aria-disabled="true"]'))
          .waitFor({ timeout: 10_000 });
      await flip('Keep awake', 'squadron.cafe.enabled', true);
      await boot.panel().locator('body').press('Escape');
      await sheet().waitFor({ state: 'hidden', timeout: 5_000 });
    }
  );
});
