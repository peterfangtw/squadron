import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionEvidence } from '../../core/checkpoint';
import { ctx, homeDir, openPanel, panel, patchSettings, section, step } from './boot';
import { composer, pids, startFromDraft, waitForNewPid } from './kit';

section(
  'scoped execution capture through the stock host',
  () => {
    let pid = '';
    const evidence = async (): Promise<ExecutionEvidence[]> => {
      const directory = path.join(homeDir(), '.squadron', 'checkpoints');
      const files = await fs.readdir(directory);
      const lines = await Promise.all(
        files.map((file) => fs.readFile(path.join(directory, file), 'utf8'))
      );
      return lines.flatMap((text) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as ExecutionEvidence)
      );
    };
    step(
      'draws a shell write from the bundled hook and excludes the gap before completion',
      async () => {
        await openPanel();
        const before = await pids();
        await startFromDraft('execution-window-smoke-on');
        pid = await waitForNewPid(before);
        await panel().locator(`#cards .card[data-pid="${pid}"]`).click();
        const pill = panel().locator('#thread .wpill', { hasText: 'execution-on-owned.txt' });
        await pill.waitFor({ timeout: 30_000 });
        assert.equal(
          await panel().locator('#thread .wpill', { hasText: 'execution-on-gap.txt' }).count(),
          0
        );
      }
    );
    step('turns capture off for this running runtime and keeps its turn fallback', async () => {
      const directory = path.join(homeDir(), '.squadron', 'execution');
      const runtime = (await fs.readdir(directory)).find((name) => name !== 'runners');
      assert.ok(runtime);
      const contextFile = path.join(directory, runtime, 'context.json');
      const admission = async (): Promise<{ enabled?: boolean }> =>
        JSON.parse(await fs.readFile(contextFile, 'utf8')) as { enabled?: boolean };
      const state = async (): Promise<{ diskEnabled: unknown; admissionEnabled: unknown }> => {
        const settings = JSON.parse(
          await fs.readFile(path.join(ctx.profile, 'data', 'User', 'settings.json'), 'utf8')
        ) as Record<string, unknown>;
        return {
          diskEnabled: settings['squadron.checkpoints.execution.enabled'],
          admissionEnabled: (await admission()).enabled
        };
      };
      console.log('capture-off before patch', JSON.stringify(await state()));
      assert.equal((await admission()).enabled, true);
      await patchSettings({ 'squadron.checkpoints.execution.enabled': false });
      const deadline = Date.now() + 10_000;
      while ((await admission()).enabled !== false && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      console.log('capture-off before send or at timeout', JSON.stringify(await state()));
      assert.equal((await admission()).enabled, false, 'the host applied capture-off admission');
      await composer().fill('execution-window-smoke-off');
      await panel().locator('#send').click();
      await panel()
        .locator('#thread .wpill', { hasText: 'execution-off-owned.txt' })
        .waitFor({ timeout: 30_000 });
      await panel()
        .locator('#thread .wpill', { hasText: 'execution-off-gap.txt' })
        .waitFor({ timeout: 30_000 });
      const owned = (files: readonly string[]): boolean =>
        files.some((file) => path.basename(file) === 'execution-off-owned.txt');
      const rows = await evidence();
      const off = rows
        .filter((row) => row.kind === 'coverage')
        .find((row) => row.runtime === runtime && owned(row.floor?.changes.files ?? []));
      assert.equal(off?.source, 'turn', 'the off turn persisted its turn fallback');
      assert.ok(
        rows.some((row) => !('kind' in row) && owned((row as { paths?: string[] }).paths ?? [])),
        'the off turn kept its floor as a legacy window'
      );
    });
    step('awaits checkpoint cleanup before the extension host reloads', async () => {
      const gitDir = path.join(homeDir(), 'project', '.git');
      const indexes = async (): Promise<string[]> =>
        (await fs.readdir(gitDir)).filter(
          (name) => name.startsWith('squadron-') && name.endsWith('.index')
        );
      assert.ok((await indexes()).length > 0, 'the live session warmed a floor index');
      const runtime = (await evidence()).find((row) => row.kind === 'active')?.runtime;
      assert.ok(runtime);
      await ctx.page.keyboard.press('ControlOrMeta+Shift+P');
      await ctx.page.keyboard.type('Developer: Reload Window');
      await Promise.all([ctx.page.waitForEvent('load'), ctx.page.keyboard.press('Enter')]);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (await indexes()).length)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(await indexes(), []);
      assert.ok(
        (await evidence()).some((row) => row.kind === 'runtime-end' && row.runtime === runtime)
      );
      await ctx.page.waitForSelector('.monaco-workbench', { timeout: 45_000 });
      await openPanel();
      assert.equal((await pids()).has(pid), false);
    });
  },
  () => ({ 'squadron.checkpoints.execution.enabled': true })
);
