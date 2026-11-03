import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeJson } from '../helpers';
import { homeDir, openPanel, panel, section, step } from './boot';
import { onSheet, pressRowAction, openWorkflowSheet } from './kit';

/**
 * A structurally broken file on disk, through the host poll.
 *
 * jsdom pushes a state the test built. This is the half under that: the
 * extension reads the file, the sheet draws it as something to repair, and a
 * save the editor posts is what the next poll lists as runnable.
 */
section('a hand-broken workflow file', () => {
  step('opens in the editor, and a repaired save is a workflow', async () => {
    const file = path.join(homeDir(), '.squadron', 'workflows', 'hand-broken.json');
    await writeJson(file, {
      id: 'hand-broken',
      label: 'Hand broken',
      description: 'kept on save',
      steps: [
        {
          id: 'plan',
          label: 'Plan',
          prompt: 'plan',
          output: 'plan.md',
          check: { command: 'true' }
        },
        { id: 'review', label: 'Review', prompt: 'review', needs: ['ship'] },
        { id: 'ship', label: 'Ship', prompt: 'ship', needs: ['plan'] }
      ]
    });
    try {
      await openPanel();
      await onSheet(async () => {
        await openWorkflowSheet();
        const row = panel().locator('#bottomdrawer-body .wsrow[data-id="hand-broken"]');
        await row.waitFor({ timeout: 30_000 });
        assert.equal(await row.getAttribute('data-repair'), 'true');
        await pressRowAction('Hand broken', 'Edit');
      });

      const editor = panel().locator('#wfeditor');
      await editor.waitFor({ state: 'visible', timeout: 10_000 });
      const why = panel().locator('#wfeditor .wcnode[data-node="review"] .wcwhy');
      await why.first().waitFor({ timeout: 10_000 });
      assert.match((await why.allTextContents()).join('\n'), /not an earlier step/);
      assert.equal(await panel().locator('#wfeditor .wesave').isDisabled(), true);

      // A same-lane wire's box is 0px wide, so the click is the pipe at the
      // path's midpoint — the hit Playwright will not aim at directly.
      const hit = panel().locator('#wfeditor path.wchit[data-from="ship"][data-to="review"]');
      const pipe = panel().locator('#wfeditor .wcpipe');
      const mid = await hit.evaluate((el) => {
        if (!(el instanceof SVGPathElement)) return { x: 0, y: 0 };
        const at = el.getPointAtLength(el.getTotalLength() / 2);
        return { x: at.x, y: at.y };
      });
      await pipe.click({ position: mid });
      await panel().locator('#wfeditor .wirex').click();

      // Unlink leaves plan and review both roots of one lane. They take two
      // rows, so this press lands on the port rather than the card under it.
      const plan = panel().locator('#wfeditor .wcnode[data-node="plan"]');
      const review = panel().locator('#wfeditor .wcnode[data-node="review"]');
      const ship = panel().locator('#wfeditor .wcnode[data-node="ship"]');
      await plan.locator('.wcport').dragTo(review);
      await review.locator('.wcport').dragTo(ship);
      const save = panel().locator('#wfeditor .wesave');
      const reasons = (await panel().locator('#wfeditor .wcwhy').allTextContents()).join('\n');
      assert.equal(await save.isDisabled(), false, reasons);
      await save.click();
      await editor.waitFor({ state: 'hidden', timeout: 10_000 });

      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
        description?: string;
        steps?: { id?: string; needs?: string[]; output?: string; check?: { command?: string } }[];
      };
      assert.equal(saved.description, 'kept on save');
      assert.deepEqual(
        saved.steps?.map((s) => s.id),
        ['plan', 'review', 'ship']
      );
      assert.equal(saved.steps?.[0]?.output, 'plan.md');
      assert.equal(saved.steps?.[0]?.check?.command, 'true');
      assert.deepEqual(saved.steps?.[1]?.needs, ['plan']);
      assert.deepEqual(saved.steps?.[2]?.needs, ['plan', 'review']);

      // `data-repair` leaving the row is the mark that the poll put the file
      // on the runnable list.
      await onSheet(async () => {
        await openWorkflowSheet();
        const row = panel().locator('#bottomdrawer-body .wsrow[data-id="hand-broken"]');
        const deadline = Date.now() + 30_000;
        let repair = await row.getAttribute('data-repair');
        while (repair !== null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
          repair = await row.getAttribute('data-repair');
        }
        assert.equal(repair, null);

        // A real press: Chromium's mousedown focus is what jsdom cannot show.
        // It selects the row and applies nothing.
        await row.locator('.nm').click();
        const head = panel().locator('#bottomdrawer-body .bddetail .dh');
        await head.waitFor({ timeout: 10_000 });
        assert.match((await head.textContent()) ?? '', /^Hand broken/);
        assert.equal(await panel().locator('#bottomdrawer').isVisible(), true);
        assert.equal(await panel().locator('#wattach .wflow.armed').count(), 0);
      });
    } finally {
      await fs.rm(file, { force: true });
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await panel()
          .locator('#wfeditor')
          .waitFor({ state: 'hidden', timeout: 10_000 })
          .catch(() => {});
      }
    }
  });
});
