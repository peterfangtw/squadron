import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ctx, openPanel, panel, section, step } from './boot';

section(
  'onboarding in a clean profile with no CLI',
  () => {
    // What jsdom cannot say: that the CSP and asWebviewUri deliver the
    // screenshots from media/onboarding, and that the flow runs in a real host.
    step('holds setup behind the box, then tours with pictures, then stays shut', async () => {
      await openPanel();

      const dialog = panel().locator('#onboarding');
      await dialog.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await dialog.locator('.acct').count(), 3);
      assert.equal(await dialog.locator('#onboarding-continue').isDisabled(), true);
      await dialog.locator('#onboarding-ack').check();
      await dialog.locator('#onboarding-continue').click();

      for (const title of ['Every session', 'Agents that work', 'Your Linear backlog']) {
        await dialog.locator('.ashead b', { hasText: title }).waitFor({ timeout: 10_000 });
        const img = dialog.locator('.obshot img');
        await img.waitFor({ timeout: 10_000 });
        // decode() rejects when a CSP refusal or a bad webview URI stops the load.
        const decoded = await img.evaluate((node) =>
          (node as HTMLImageElement).decode().then(
            () => true,
            () => false
          )
        );
        assert.ok(decoded, `no picture on "${title}"`);
        await dialog.locator('#onboarding-next').click();
      }
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    });
  },
  () => {
    const missing = path.join(ctx.profile, 'no-such-cli');
    return {
      'squadron.claudePath': missing,
      'squadron.codexPath': missing,
      'squadron.grokPath': missing
    };
  }
);
