import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { promisify } from 'node:util';
import { testPlatform } from '../helpers';
import type { ModelListing } from '../../core/model_listing';
import { argvLogPath, ctx, homeDir, homeVars, openPanel, panel, section, step } from './boot';

const execFile = promisify(childProcess.execFile);

section('model discovery in the real IDE', () => {
  step(
    'installs the command and reads configured CLI accounts without opening a panel',
    async () => {
      assert.equal(await ctx.page.locator('iframe.webview').count(), 0);
      const shim = platform.launchers.scriptPath(
        path.join(homeDir(), '.squadron', 'bin'),
        'squadron-models'
      );
      const until = Date.now() + 30_000;
      while (!(await fs.stat(shim).catch(() => undefined))) {
        assert.ok(Date.now() < until, 'extension did not install squadron-models');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const read = async (): Promise<ModelListing> => {
        const { stdout } = await execFile(process.execPath, [shim], {
          cwd: path.join(homeDir(), 'project'),
          env: { ...process.env, ...homeVars(), SQUADRON_ORIGIN_WINDOW: '' },
          timeout: 30_000
        });
        return JSON.parse(stdout) as ModelListing;
      };
      const listing = await read();
      for (const brand of ['claude', 'grok', 'codex']) {
        const available = listing.brands.find((row) => row.brand === brand);
        assert.equal(available?.installed, true, `${brand} must use the configured fixture binary`);
        assert.equal(available.signedIn, brand !== 'codex', `${brand} fixture account status`);
      }
      assert.ok(listing.models.some((row) => row.brand === 'claude' && row.context === 200_000));
      assert.ok(listing.models.some((row) => row.brand === 'grok'));
      assert.ok(listing.models.every((row) => row.brand !== 'codex'));
      assert.equal(listing.brands.find((row) => row.brand === 'codex')?.source, 'account');
      const authFile = path.join(homeDir(), '.codex/fake-auth.json');
      try {
        await fs.mkdir(path.dirname(authFile), { recursive: true });
        await fs.writeFile(authFile, JSON.stringify({ email: 'codex-smoke@example.invalid' }));
        const signedIn = await read();
        assert.equal(signedIn.brands.find((row) => row.brand === 'codex')?.signedIn, true);
        assert.ok(signedIn.models.some((row) => row.model === 'gpt-codex-signed-in'));
      } finally {
        await fs.rm(authFile, { force: true });
      }
      assert.equal(await ctx.page.locator('iframe.webview').count(), 0);
    }
  );

  step('reports unknown when auth fails after the panel cached a signed-in account', async () => {
    await openPanel();
    const lim = panel().locator('#nav button.lim');
    await lim.waitFor({ timeout: 30_000 });
    await lim.click();
    const account = panel().locator('#nav-actions .smenu.accts:not([hidden]) .acct', {
      hasText: 'Claude'
    });
    await account.locator('button.act.out').waitFor({ timeout: 30_000 });
    await panel().locator('body').press('Escape');
    const binary = path.join(
      path.dirname(argvLogPath()),
      testPlatform() === 'win32' ? 'claude.js' : 'claude'
    );
    const original = await fs.readFile(binary, 'utf8');
    try {
      await fs.writeFile(
        binary,
        testPlatform() === 'win32' ? 'process.exit(1);\n' : '#!/bin/sh\nexit 1\n'
      );
      const { stdout } = await execFile(
        process.execPath,
        [
          platform.launchers.scriptPath(
            path.join(homeDir(), '.squadron', 'bin'),
            'squadron-models'
          ),
          '--brand',
          'claude'
        ],
        {
          cwd: path.join(homeDir(), 'project'),
          env: { ...process.env, ...homeVars(), SQUADRON_ORIGIN_WINDOW: '' },
          timeout: 30_000
        }
      );
      const listing = JSON.parse(stdout) as ModelListing;
      assert.equal(listing.brands[0]?.installed, true);
      assert.equal(listing.brands[0]?.signedIn, null);
      assert.ok(listing.models.length > 0, 'unknown auth must not be treated as signed out');
    } finally {
      await fs.writeFile(binary, original);
      await panel().locator('body').press('ControlOrMeta+w');
      await ctx.page.locator('iframe.webview').waitFor({ state: 'detached', timeout: 10_000 });
    }
  });
});
