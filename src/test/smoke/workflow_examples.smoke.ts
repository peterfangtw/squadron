import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import * as paths from '../../core/paths';
import * as platform from '../../core/platform';
import * as skillInstall from '../../core/skill_install';
import { ctx, homeVars, openPanel, panel, patchSettings, section, step } from './boot';
import { pressRowAction, openWorkflowSheet, sheetRow } from './kit';

const EXAMPLES = [
  { id: 'example-read-do-review', label: 'Example: Read, Do, Review', lanes: 1 },
  { id: 'example-multiple-models', label: 'Example: Multiple Models', lanes: 3 }
];
const execFile = util.promisify(childProcess.execFile);

section('deletable examples installed once', () => {
  step('installs the CLI and builder skills when session orchestration is enabled', async () => {
    await patchSettings({ 'squadron.orchestrators.enabled': false });
    for (const cli of ['.claude', '.grok', '.codex']) {
      await fs.mkdir(path.join(ctx.home, cli), { recursive: true });
      for (const skill of new Set(skillInstall.SKILL_FILES.map((asset) => asset.skill))) {
        await fs.rm(path.join(ctx.home, cli, 'skills', skill), { recursive: true, force: true });
      }
    }
    try {
      await patchSettings({ 'squadron.orchestrators.enabled': true });
      const files = ['.claude', '.grok', '.codex'].flatMap((cli) =>
        skillInstall.SKILL_FILES.map((asset) => skillInstall.skillPaths(cli, ctx.home, asset).file)
      );
      const until = Date.now() + 30_000;
      while (true) {
        const texts = await Promise.all(
          files.map((file) => fs.readFile(file, 'utf8').catch(() => undefined))
        );
        if (texts.every((text) => text !== undefined)) {
          for (const text of texts) assert.equal(skillInstall.readInstalledText(text).kind, 'ours');
          break;
        }
        assert.ok(Date.now() < until, 'extension did not install both skills and their references');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await patchSettings({ 'squadron.orchestrators.enabled': false });
    }
  });

  step(
    'validates candidate JSON with the installed command while orchestration is off',
    async () => {
      const command = platform.launchers.scriptPath(
        path.join(ctx.home, '.squadron', 'bin'),
        paths.WORKFLOW_VALIDATION_SHIM
      );
      const until = Date.now() + 30_000;
      while (!(await fs.stat(command).catch(() => undefined))) {
        assert.ok(Date.now() < until, 'extension did not install workflow-validation');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const file = path.join(ctx.home, 'workflow-candidate.json');
      const cwd = path.join(ctx.home, 'project');
      await fs.writeFile(
        file,
        JSON.stringify({
          id: 'candidate',
          label: 'Candidate',
          steps: [{ id: 'review', label: 'Review', prompt: 'Review the task.' }]
        })
      );
      const options = { env: { ...process.env, ...homeVars() }, timeout: 10_000 };
      const { stdout } = await execFile(
        process.execPath,
        [command, '--file-path', file, '--cwd-path', cwd],
        options
      );
      assert.deepEqual(JSON.parse(stdout), { ok: true, file, cwd, reasons: [] });
      await fs.writeFile(file, JSON.stringify({ id: 'candidate', label: 'Candidate', steps: [] }));
      await assert.rejects(
        execFile(process.execPath, [command, '--file-path', file, '--cwd-path', cwd], options),
        (error: unknown) => {
          const result = error as { code: number; stdout: string };
          assert.equal(result.code, 2);
          assert.deepEqual(JSON.parse(result.stdout), {
            ok: false,
            file,
            cwd,
            reasons: ['needs at least one step']
          });
          return true;
        }
      );
    }
  );

  step('seeds the examples at activation and opens both in the existing editor', async () => {
    const root = path.join(ctx.home, '.squadron');
    await fs.rm(path.join(root, 'workflows'), { recursive: true, force: true });
    await fs.rm(path.join(root, paths.WORKFLOW_EXAMPLES_MARKER_NAME), { force: true });
    await reloadWindow();
    assert.deepEqual(
      (await fs.readdir(path.join(root, 'workflows'))).sort(),
      EXAMPLES.map((w) => `${w.id}.json`).sort()
    );
    assert.ok(await fs.stat(path.join(root, paths.WORKFLOW_EXAMPLES_MARKER_NAME)));
    await openPanel();
    for (const example of EXAMPLES) {
      await openWorkflowSheet();
      await sheetRow(example.label).waitFor({ timeout: 30_000 });
      await pressRowAction(example.label, 'Edit');
      const editor = panel().locator('#wfeditor');
      await editor.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await editor.locator('.wchd').count(), example.lanes);
      await panel()
        .locator('body')
        .screenshot({ path: path.join(os.tmpdir(), `${example.id}.png`) });
      await editor.locator('.weback').click();
      await editor.waitFor({ state: 'hidden', timeout: 10_000 });
    }
  });

  step('deletes the examples through the sheet and keeps them deleted after reload', async () => {
    await openWorkflowSheet();
    for (const example of EXAMPLES) {
      await pressRowAction(example.label, 'Delete');
      const row = sheetRow(example.label);
      await row.locator('.fbtn', { hasText: 'Delete' }).click();
      await row.waitFor({ state: 'hidden', timeout: 30_000 });
      await assert.rejects(
        fs.stat(path.join(ctx.home, '.squadron', 'workflows', `${example.id}.json`))
      );
    }
    await reloadWindow();
    await openPanel();
    assert.deepEqual(await fs.readdir(path.join(ctx.home, '.squadron', 'workflows')), []);
    assert.equal(await panel().locator('#bottomhub .fpill').textContent(), '+ New workflow');
    assert.ok(await fs.stat(path.join(ctx.home, '.squadron', paths.WORKFLOW_EXAMPLES_MARKER_NAME)));
  });
});

async function reloadWindow(): Promise<void> {
  const page = ctx.page;
  await page.keyboard.press('Escape');
  await Promise.all([
    page.waitForEvent('load', { timeout: 45_000 }),
    page.keyboard.press('Control+Alt+Shift+F4')
  ]);
  await page.waitForSelector('.monaco-workbench', { timeout: 45_000 });
  await openPanel();
}
