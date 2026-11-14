import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import * as boot from './boot';

/**
 * Agents on the bottom drawer, where jsdom has no layout and no host. The hub
 * word is reachable by pointer and raises the drawer, and Orchestration,
 * pressed there, lands in this profile's settings through the host's
 * `setFlag`. What the drawer draws for each value is `agents_sheet.test.ts`.
 */

const word = () => boot.panel().locator('#bottomhub .agents-tab');
const sheet = () => boot.panel().locator('#bottomdrawer');
/** Orchestration's row: its name shares `.t` with the On/Off beside it. */
const master = () => sheet().locator('.bdlist .mrow.master[role="switch"]');

async function openAgents(): Promise<void> {
  // The bar is not a control while the drawer is up.
  if (
    await boot
      .panel()
      .locator('#bottomdrawer.agents')
      .isVisible()
      .catch(() => false)
  )
    return;
  if (!(await word().isVisible())) await boot.panel().locator('#bottomhub-more').click();
  // A plain click, with no `force`: Playwright refuses a target another box
  // covers, which is the reachability the case is about.
  await word().click();
  await sheet().waitFor({ state: 'visible', timeout: 10_000 });
  await boot.panel().locator('#bottomdrawer.agents').waitFor({ state: 'visible', timeout: 10_000 });
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

async function flip(want: boolean): Promise<void> {
  await master().click();
  await master()
    .and(boot.panel().locator(`[aria-checked="${want}"]`))
    .waitFor({ timeout: 10_000 });
  await waitSetting('squadron.orchestrators.enabled', want);
  // The pushed flag, not the flip: the count follows the host's answer.
  await sheet()
    .locator('.bddetail .summary', { hasText: want ? '13 of 13 available' : '2 of 13 available' })
    .waitFor({ timeout: 10_000 });
}

boot.section('Agents on the bottom drawer, in the real IDE', () => {
  before(async () => {
    await boot.openPanel();
  });

  boot.step('the hub word opens the Agents drawer', async () => {
    await openAgents();
    assert.equal(await sheet().locator('#bottomdrawer-head .ttl').textContent(), 'Agents');
  });

  boot.step('Orchestration flips through the host into settings.json', async () => {
    await openAgents();
    const was = (await master().getAttribute('aria-checked')) === 'true';
    await flip(!was);
    await flip(was);
    await boot.panel().locator('body').press('Escape');
    await sheet().waitFor({ state: 'hidden', timeout: 5_000 });
  });
});
