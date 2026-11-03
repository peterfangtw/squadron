import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { shutDrawer } from '../smoke/drawer_shut';
import { tempHome } from '../helpers';

/**
 * The product's bottom-drawer exit, copied so this does not boot an IDE.
 * `src/ui/css/bottom_drawer.ts` is the rule under test's transition.
 */
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  @media (prefers-reduced-motion: no-preference) {
    #bottomdrawer { transition: translate 180ms cubic-bezier(.2, .7, .3, 1),
                          display 180ms allow-discrete; }
    #bottomdrawer[hidden] { translate: 0 100%; }
    @starting-style { #bottomdrawer:not([hidden]) { translate: 0 100%; } }
  }
  #bottomdrawer[hidden] { display: none; }
  #bottomdrawer { position: absolute; left: 12px; right: 12px; bottom: 0; height: 220px;
                  display: flex; background: white; }
  #bottomdrawer-close { width: 32px; height: 32px; }
</style>
<div id="bottomdrawer">
  <button id="bottomdrawer-close" aria-label="Close">x</button>
</div>
<script>
  const sheet = document.getElementById('bottomdrawer');
  const close = document.getElementById('bottomdrawer-close');
  close.addEventListener('click', () => {
    close.dataset.clicked = '1';
    if (close.dataset.broken === '1') return;
    sheet.hidden = true;
  });
</script>`;

describe('bottom drawer cleanup', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  before(async () => {
    const home = await tempHome();
    // Chrome refuses its debugging pipe when a moved USERPROFILE has no LocalAppData directory.
    const local = path.join(home, 'AppData', 'Local');
    await fs.mkdir(local, { recursive: true });
    try {
      browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        env: { ...process.env, LOCALAPPDATA: local }
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Chromium distribution 'chrome' is not found")
      ) {
        return;
      }
      throw error;
    }
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent(html);
  });

  after(async () => {
    await browser?.close();
  });

  async function openSheet(): Promise<Page> {
    if (!page) throw new Error('Chrome is not available');
    await page.locator('#bottomdrawer').evaluate((node) => {
      if (!(node instanceof HTMLElement)) return;
      node.hidden = false;
      const close = node.querySelector('#bottomdrawer-close');
      if (close instanceof HTMLElement) {
        delete close.dataset.clicked;
        delete close.dataset.broken;
      }
    });
    await page.locator('#bottomdrawer').waitFor({ state: 'visible' });
    // Let the rise finish so an open-path click is not waiting on it.
    await page.waitForTimeout(250);
    return page;
  }

  it('waits out a drawer that is already closing, without clicking', async (t) => {
    if (!page) {
      t.skip('env: Chrome is not available for the drawer actionability check');
      return;
    }
    const open = await openSheet();
    await open.locator('#bottomdrawer').evaluate((node) => {
      if (node instanceof HTMLElement) node.hidden = true;
    });
    const started = Date.now();
    await shutDrawer(open.locator('#bottomdrawer'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `already-closing took ${elapsed}ms`);
    assert.equal(await open.locator('#bottomdrawer-close').getAttribute('data-clicked'), null);
    assert.equal(await open.locator('#bottomdrawer').isVisible(), false);
  });

  it('clicks Close on a drawer that is still open', async (t) => {
    if (!page) {
      t.skip('env: Chrome is not available for the drawer actionability check');
      return;
    }
    const open = await openSheet();
    const started = Date.now();
    await shutDrawer(open.locator('#bottomdrawer'));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `open close took ${elapsed}ms`);
    assert.equal(await open.locator('#bottomdrawer-close').getAttribute('data-clicked'), '1');
    assert.equal(await open.locator('#bottomdrawer').isVisible(), false);
  });

  it('reports a close that leaves the drawer up', async (t) => {
    if (!page) {
      t.skip('env: Chrome is not available for the drawer actionability check');
      return;
    }
    const open = await openSheet();
    await open.locator('#bottomdrawer-close').evaluate((node) => {
      if (node instanceof HTMLElement) node.dataset.broken = '1';
    });
    const started = Date.now();
    await assert.rejects(
      () => shutDrawer(open.locator('#bottomdrawer')),
      /Timeout 10000ms exceeded/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 9_000 && elapsed < 15_000, `a broken close rejected in ${elapsed}ms`);
    assert.equal(await open.locator('#bottomdrawer-close').getAttribute('data-clicked'), '1');
    assert.equal(await open.locator('#bottomdrawer').isVisible(), true);
  });

  it('returns immediately when reduced motion has already hidden the drawer', async (t) => {
    if (!page) {
      t.skip('env: Chrome is not available for the drawer actionability check');
      return;
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      const open = await openSheet();
      await open.locator('#bottomdrawer').evaluate((node) => {
        if (node instanceof HTMLElement) node.hidden = true;
      });
      const started = Date.now();
      await shutDrawer(open.locator('#bottomdrawer'));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1_000, `reduced-motion close took ${elapsed}ms`);
      assert.equal(await open.locator('#bottomdrawer-close').getAttribute('data-clicked'), null);
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
});
