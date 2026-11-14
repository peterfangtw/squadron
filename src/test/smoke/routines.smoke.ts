import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { before } from 'node:test';
import { writeJson } from '../helpers';
import * as platform from '../../core/platform';
import * as boot from './boot';
import * as kit from './kit';
import type * as types from '../../core/routines/types';

async function saved(): Promise<types.Repository | undefined> {
  const root = path.join(boot.homeDir(), '.squadron', 'routines');
  try {
    for (const directory of await fs.readdir(root)) {
      try {
        return JSON.parse(
          await fs.readFile(path.join(root, directory, 'state.json'), 'utf8')
        ) as types.Repository;
      } catch {
        /* A mutation can be in flight. */
      }
    }
  } catch {
    /* No routine has been saved yet. */
  }
  return undefined;
}

boot.section(
  'repository routines through the native host',
  () => {
    let run: types.Attempt;
    let prior: Set<string>;
    before(async () => {
      await boot.openPanel();
      prior = await kit.pids();
      await kit.openDraft();
    });

    boot.step(
      'mounts the shared input beside chat and saves a reminder without starting anything',
      async () => {
        await kit.composer().fill('Unsent chat beside the recurring work');
        await boot.panel().locator('.routines-tab').click();
        await boot.panel().locator('#bottomdrawer .wsnew').click();
        await boot.panel().locator('.routine-name').fill('Recurring review smoke');
        await boot
          .panel()
          .locator('.routine-input .ProseMirror')
          .fill('Review dependencies and report findings');
        await boot.panel().locator('.routine-cadence input[type=time]').fill('00:00');
        await boot
          .panel()
          .locator('.routine-actions button')
          .filter({ hasText: /^Save$/ })
          .click();
        await boot
          .panel()
          .locator('.routine-save')
          .filter({ hasText: /^Saved$/ })
          .waitFor({ timeout: 15000 });
        assert.equal(await kit.composerValue(), 'Unsent chat beside the recurring work');
        const geometry = await boot
          .panel()
          .locator('.routine-input')
          .evaluate((node) => {
            const editor = node.getBoundingClientRect();
            const chat = document.getElementById('composer')!.getBoundingClientRect();
            const board = document.getElementById('board')!.getBoundingClientRect();
            const tools = node.querySelector('.compose-tools')!.getBoundingClientRect();
            return {
              editor: { left: editor.left, right: editor.right, width: editor.width },
              chat: { left: chat.left, width: chat.width },
              board: { right: board.right },
              tools: { width: tools.width }
            };
          });
        assert.ok(geometry.editor.width > 120 && geometry.chat.width > 120);
        assert.ok(geometry.editor.right <= geometry.board.right + 1);
        assert.ok(geometry.chat.left >= geometry.board.right - 1);
        assert.ok(geometry.tools.width > 80);
        assert.deepEqual(await kit.pids(), prior);
        const artifacts = process.env['SQUADRON_RUN'];
        if (artifacts)
          await boot
            .panel()
            .locator('#bottomdrawer')
            .screenshot({ path: path.join(artifacts, 'routines-drawer.png') });
        await boot.panel().locator('.routine-row input[type=checkbox]').check();
        await boot.panel().locator('#bottomdrawer-close').click();
        await boot
          .panel()
          .locator('.routines-tab .num')
          .filter({ hasText: /^1$/ })
          .waitFor({ timeout: 15000 });
        assert.deepEqual(await kit.pids(), prior);
      }
    );

    boot.step(
      'restores saved reminders across an IDE reload and becomes due without launching',
      async () => {
        const record = await saved();
        assert.ok(record);
        const definition = Object.values(record.routines)[0];
        assert.ok(definition);
        definition.schedule = { kind: 'interval', hours: 1 };
        definition.anchorAt = Date.now() - 3_600_000 + 20_000;
        definition.scheduleEpoch = crypto.randomUUID();
        definition.definitionRevision++;
        record.revision++;
        await writeJson(
          path.join(boot.homeDir(), '.squadron', 'routines', record.repoKey, 'state.json'),
          record
        );
        await boot.panel().locator('.routines-tab .num').filter({ hasText: /^0$/ }).waitFor();
        await Promise.all([
          boot.ctx.page.waitForEvent('load', { timeout: 45000 }),
          boot.ctx.page.keyboard.press('Control+Alt+Shift+F4')
        ]);
        await boot.ctx.page.waitForSelector('.monaco-workbench', { timeout: 45000 });
        await boot.openPanel();
        await boot.panel().locator('.routines-tab .num').filter({ hasText: /^0$/ }).waitFor();
        await boot
          .panel()
          .locator('.routines-tab .num')
          .filter({ hasText: /^1$/ })
          .waitFor({ timeout: 30000 });
        assert.deepEqual(await kit.pids(), prior);
      }
    );

    boot.step(
      'keeps the due pill on the board and launches one fresh session only on its click',
      async () => {
        await boot.panel().locator('.routines-tab').focus();
        await boot.panel().locator('.routines-tab').press('ArrowUp');
        const pill = boot.panel().locator('#bottomhub-routines button');
        await pill.waitFor({ state: 'visible', timeout: 10000 });
        const box = await pill.boundingBox();
        const board = await boot.panel().locator('#board').boundingBox();
        assert.ok(box && board);
        assert.ok(box.x >= board.x && box.x + box.width <= board.x + board.width + 1);
        await pill.click();
        const pid = await kit.waitForNewPid(prior);
        await boot
          .panel()
          .locator(`#cards .card[data-pid="${pid}"].idle`)
          .waitFor({ timeout: 30000 });
        await boot.panel().locator('.routines-tab').click();
        await boot
          .panel()
          .locator('.routine-status')
          .filter({ hasText: /Awaiting completion/ })
          .waitFor({ timeout: 15000 });
        const record = await saved();
        assert.ok(record);
        const attempt = Object.values(record.attempts)[0];
        assert.ok(attempt?.receiver && attempt.child);
        run = attempt;
        assert.equal(run.phase, 'started');
        assert.equal(run.receiver?.pid, Number(pid));
        assert.equal(run.child?.startedAt, run.receiver?.osStartedAt);
        assert.equal(run.cwd, run.receiver?.cwd);
        assert.ok(run.promptAdmittedAt);
        assert.equal(run.doneAt, undefined);
        await boot.panel().locator('#bottomdrawer-close').click();
      }
    );

    boot.step(
      'accepts the installed done command only from the associated native CLI ancestry',
      async () => {
        const shell = platform.commands.shell('native');
        const program = platform.launchers.verbPath(
          path.join(boot.homeDir(), '.squadron', 'bin'),
          'squadron-routine',
          shell
        );
        const command = platform.commands.render(
          program,
          ['done', '--run-id', run.runId],
          { program: 'quoted', args: 'word' },
          shell
        );
        const output = path.join(boot.homeDir(), 'routine-done-result.json');
        await kit.send(`squadron-native-tool ${JSON.stringify({ command, result: output })}`);
        const until = Date.now() + 20000;
        let evidence: { code: number; stdout: string; stderr: string } | undefined;
        while (Date.now() < until) {
          try {
            evidence = JSON.parse(await fs.readFile(output, 'utf8')) as typeof evidence;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.ok(evidence, 'The native tool never recorded its done result.');
        assert.equal(evidence.code, 0, evidence.stderr);
        assert.match(evidence.stdout, /completed/);
        await boot.panel().locator('.routines-tab').click();
        await boot
          .panel()
          .locator('.routine-status')
          .filter({ hasText: /Completed/ })
          .waitFor({ timeout: 15000 });
        const record = await saved();
        assert.equal(record?.attempts[run.runId]?.phase, 'done');
        assert.equal(record?.routines[run.routineId]?.activeRunId, undefined);
      }
    );
  },
  () => ({ 'squadron.orchestrators.enabled': true })
);
