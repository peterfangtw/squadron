import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ctx, homeDir, openPanel, panel, section, step } from './boot';
import { fixtureSession, pressRowAction, openWorkflowSheet, proseValue, stepPrompt } from './kit';

/**
 * The canvas seam's hand-checks (`TASK_done_canvas_seam.md`, Steps 3.3, 4.3
 * and 5.2), in a real host. jsdom has every handler and none of the boxes, so
 * what is asserted here is what needs them: wire ends against card edges after
 * each gesture that resizes a card, menus that open where a pointer can reach
 * them, a native grip drag, and a lock read in the click that paints it.
 *
 * A sequence, not a set: each step leaves the draft as the next expects it.
 * Releasing a grip outside the panel stays a hand-check — Playwright drops
 * through the workbench's frame, so the webview never hears `dragend`, and a
 * webview that thinks a drag is still up eats every click after it.
 */

const ed = () => panel().locator('#wfeditor');
const node = (id: string) => ed().locator(`.wcnode[data-node="${id}"]`);
/** Chip menus are portalled to `<body>`, so the open one is whichever is visible. */
const openMenu = () => panel().locator('.fmenu:not(#mentionmenu):visible').first();
const prompt = () => stepPrompt(ed().locator('.wcnode.editing'));

/** Every wire's two ends, against the boxes of the two cards it joins. */
async function assertWiresHug(): Promise<void> {
  const report = await ed()
    .locator('.wcscroll')
    .evaluate((root) => {
      const svg = root.querySelector<SVGSVGElement>('svg.wcwires');
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return { wires: [] as string[], worst: Infinity };
      const off = (p: DOMPoint, r: DOMRect): number => {
        const outside = Math.hypot(
          Math.max(r.left - p.x, 0, p.x - r.right),
          Math.max(r.top - p.y, 0, p.y - r.bottom)
        );
        return outside > 0
          ? outside
          : Math.min(p.x - r.left, r.right - p.x, p.y - r.top, r.bottom - p.y);
      };
      let worst = 0;
      const wires: string[] = [];
      for (const hit of svg.querySelectorAll<SVGPathElement>('path.wchit')) {
        const from = root.querySelector(`[data-node="${hit.dataset.from}"]`);
        const to = root.querySelector(`[data-node="${hit.dataset.to}"]`);
        const name = `${hit.dataset.from}->${hit.dataset.to}`;
        if (!from || !to) {
          wires.push(`${name}: no card`);
          worst = Infinity;
          continue;
        }
        const a = off(hit.getPointAtLength(0).matrixTransform(ctm), from.getBoundingClientRect());
        const b = off(
          hit.getPointAtLength(hit.getTotalLength()).matrixTransform(ctm),
          to.getBoundingClientRect()
        );
        worst = Math.max(worst, a, b);
        wires.push(`${name}: ${a.toFixed(1)}/${b.toFixed(1)}px`);
      }
      return { wires, worst };
    });
  assert.ok(report.wires.length > 0, 'no wires drawn');
  // Measured 0.0px on every wire, 2026-10-06; the slack is subpixel rounding.
  assert.ok(report.worst <= 2, `a wire end is off its card: ${report.wires.join(', ')}`);
}

section('the workflow canvas, in the real IDE', () => {
  const file = (): string => path.join(homeDir(), '.squadron', 'workflows', 'canvas-flow.json');

  step('opens a three-lane workflow with its wires on the cards', async () => {
    // Publish waits on Test as well as Review, which leaves an empty row in
    // its lane under Docs — the only kind of empty row a drop can land in.
    await fs.writeFile(
      file(),
      JSON.stringify({
        schema: 2,
        id: 'canvas-flow',
        label: 'canvas flow',
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'plan it' },
          { id: 'build', label: 'Build', prompt: 'build it', needs: ['plan'] },
          { id: 'test', label: 'Test', prompt: 'test it', needs: ['build'] },
          { id: 'ship', label: 'Ship', prompt: 'ship it', needs: ['test'] },
          { id: 'docs', label: 'Docs', prompt: 'write docs', lane: 's1', needs: ['plan'] },
          { id: 'notes', label: 'Notes', prompt: 'release notes', lane: 's2', needs: ['plan'] },
          {
            id: 'review',
            label: 'Review',
            prompt: 'review docs',
            lane: 's1',
            needs: ['docs', 'test']
          },
          { id: 'publish', label: 'Publish', prompt: 'publish', lane: 's1', needs: ['review'] }
        ]
      })
    );
    await openPanel();
    // The `@` menu lists the skills a session's `init` named, and only a live
    // session sends one.
    await fixtureSession();
    await openWorkflowSheet();
    await pressRowAction('canvas flow', 'Edit');
    await ed().waitFor({ state: 'visible', timeout: 10_000 });
    await assertWiresHug();
  });

  step('draws a draggable grip on every card, with its tip', async () => {
    const cards = await ed().locator('.wcnode').count();
    assert.equal(await ed().locator('.wcnode .wegrip[draggable="true"]').count(), cards);
    await node('build').hover();
    await node('build').locator('.wegrip').hover();
    await panel()
      .locator('.tip, [role="tooltip"]', { hasText: 'Drag to reorder' })
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
  });

  step('renames a lane: Escape keeps it, a taken name says so, Enter saves', async () => {
    const field = ed().locator('.wchd input.name');
    await ed().locator('.wchd button.name', { hasText: 's1' }).click();
    await field.fill('zzz');
    await field.press('Escape');
    await ed().locator('.wchd button.name', { hasText: 's1' }).waitFor({ timeout: 5_000 });
    assert.equal(await field.count(), 0);

    await ed().locator('.wchd button.name', { hasText: 's1' }).click();
    await field.fill('s2');
    await field.press('Enter');
    await ed()
      .locator('.wchd', { hasText: 's2 is taken' })
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });

    if ((await field.count()) === 0) {
      await ed().locator('.wchd button.name', { hasText: 's1' }).click();
    }
    await field.fill('writers');
    await field.press('Enter');
    await ed().locator('.wchd button.name', { hasText: 'writers' }).waitFor({ timeout: 5_000 });
    await assertWiresHug();
  });

  step('formats a prompt with shared code/list controls and keeps native selection', async () => {
    await node('build').locator('.wcname').click();
    await prompt().waitFor({ timeout: 5_000 });
    const bar = ed().locator('.wcnode.editing [role="toolbar"]');
    assert.deepEqual(
      await bar
        .locator('[data-format]')
        .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.format)),
      ['bulletList', 'orderedList', 'code', 'codeBlock']
    );
    for (const button of await bar.locator('button').all()) {
      const box = await button.boundingBox();
      assert.ok(box && box.width >= 24 && box.height >= 24);
    }
    await prompt().click();
    await prompt().press('ControlOrMeta+a');
    await bar.locator('[data-format="codeBlock"]').click();
    assert.equal(await proseValue(prompt()), '```\nbuild it\n```');
    assert.equal(
      await prompt().evaluate((root) => root.ownerDocument.activeElement === root),
      true
    );
    await assertWiresHug();
    await prompt().press('ControlOrMeta+z');
    assert.equal(await proseValue(prompt()), 'build it');
    await bar.locator('[data-format="bulletList"]').click();
    assert.equal(await proseValue(prompt()), '- build it');
    await prompt().press('ControlOrMeta+z');
    assert.equal(await proseValue(prompt()), 'build it');
    await ed().locator('.wcnode.editing .wcdone').click();
  });

  step('makes a skill picked off `@` a chip, and takes it whole on Backspace', async () => {
    await node('build').locator('.wcname').click();
    await prompt().waitFor({ timeout: 5_000 });
    await assertWiresHug();
    // The click scrolls the editor body smoothly, and any body scroll shuts the
    // menu; type once it has settled.
    await prompt().click();
    await ctx.page.waitForTimeout(400);
    // The caret at the end, set as a DOM selection, which the editor reads back.
    await prompt().evaluate((root) => {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = root.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await prompt().pressSequentially(' @skill:', { delay: 30 });
    const menu = panel().locator('#mentionmenu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    await menu.locator('.mnrow').first().click();
    const chip = ed().locator('.wcnode.editing .wcbody .pchip.skill');
    await chip.waitFor({ timeout: 5_000 });

    // A pick is the chip and one space after it: the space is the platform's
    // Backspace, the chip the editor's.
    await prompt().press('Backspace');
    assert.equal(await chip.count(), 1, 'the first Backspace is the space after the chip');
    await prompt().press('Backspace');
    assert.equal(await chip.count(), 0);
    assert.equal((await proseValue(prompt())).trimEnd(), 'build it');
    await assertWiresHug();
  });

  step('removes an open step and opens the next; the first step has no Remove', async () => {
    await ed().locator('.wcnode.editing .werm').click();
    await node('build').waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(await ed().locator('.wcnode.editing').getAttribute('data-node'), 'test');
    await assertWiresHug();

    await node('plan').locator('.wcname').click();
    await ed().locator('.wcnode.editing[data-node="plan"]').waitFor({ timeout: 5_000 });
    assert.equal(await ed().locator('.wcnode.editing .werm').count(), 0);
    await ed().locator('.wcnode.editing .wcdone').click();
    await ed().locator('.wcnode.editing').waitFor({ state: 'detached', timeout: 5_000 });
    await assertWiresHug();
  });

  step('opens the model and effort chips’ menus without opening the card', async () => {
    const docs = node('docs');
    const model = docs.locator('.wcchip:not(.effort)');
    const before = await model.innerText();
    await model.click();
    await openMenu().waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await docs.evaluate((n) => n.classList.contains('editing')), false);
    // Any row's narrow window: the pick is the claim, not which model it is.
    await openMenu().getByText('200k').first().click();
    await ctx.page.waitForTimeout(300);
    assert.notEqual(await model.innerText(), before);

    const effort = docs.locator('.wcchip.effort');
    await effort.waitFor({ timeout: 5_000 });
    await model.click();
    const modelMenu = await openMenu().innerText();
    await effort.click();
    await ctx.page.waitForTimeout(200);
    const effortMenu = await openMenu().innerText();
    assert.notEqual(effortMenu, modelMenu, 'the effort chip left the model menu up');
    assert.match(effortMenu, /default/);
    await ctx.page.keyboard.press('Escape');
    await assertWiresHug();
  });

  step('dims the carried card, lights its row, and lands it there', async () => {
    await ed()
      .locator('.wcscroll')
      .evaluate((s) => {
        s.scrollLeft = 0;
      });
    const from = await node('ship').locator('.wegrip').boundingBox();
    const to = await node('test').boundingBox();
    assert.ok(from && to, 'Ship’s grip and Test both have a box');
    const mouse = ctx.page.mouse;
    try {
      await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await mouse.down();
      await mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      assert.equal(await ed().locator('.wcnode.lifted').count(), 1);
      assert.ok((await ed().locator('.target').count()) >= 1, 'no row lit');
    } finally {
      await mouse.up();
    }
    assert.equal(await node('ship').getAttribute('data-row'), '2');
    assert.equal(await node('test').getAttribute('data-row'), '3');
    await assertWiresHug();
  });

  step('lands a card in an empty row of its own lane', async () => {
    const row = Number(await node('docs').getAttribute('data-row')) + 1;
    const cell = ed().locator(`.wccell[data-lane="writers"][data-row="${row}"]`);
    await node('publish').scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    assert.ok(box, `no empty row ${row} under Docs`);
    // Docs → Review's wire runs down this cell, and its 24px hit takes the pointer.
    await node('publish')
      .locator('.wegrip')
      .dragTo(cell, { force: true, targetPosition: { x: box.width - 30, y: box.height / 2 } });
    await node('publish')
      .and(ed().locator(`[data-row="${row}"]`))
      .waitFor({ timeout: 5_000 });
    await assertWiresHug();
  });

  step('sends a card dropped on another session’s column back, and stays clickable', async () => {
    const before = await node('test').getAttribute('data-row');
    const cell = ed().locator('.wccell[data-lane="s2"]').last();
    await cell.scrollIntoViewIfNeeded();
    await node('test').locator('.wegrip').dragTo(cell, { force: true });
    assert.equal(await node('test').getAttribute('data-row'), before);

    await ed()
      .locator('.wcscroll')
      .evaluate((s) => {
        s.scrollLeft = 0;
      });
    await node('test').locator('.wcname').click();
    await prompt().click();
    await prompt().pressSequentially(' ok');
    assert.match(await proseValue(prompt()), / ok$/);
    await ed().locator('.wcnode.editing .wcdone').click();
  });

  step('locks every field and gesture while a delete is in flight', async () => {
    // An open card, so its Done is among what the lock has to reach.
    await node('plan').locator('.wcname').click();
    await ed().locator('.wcnode.editing[data-node="plan"]').waitFor({ timeout: 5_000 });
    await ed().locator('.wedelete').click();
    await ed().locator('.wedelete.armed').waitFor({ timeout: 5_000 });
    const state = await ed().evaluate((root) => {
      // Read in the click's own tick: `renderEditor` paints the lock before
      // the message posts, and the host answers within a few ms.
      root.querySelector<HTMLButtonElement>('.wedelete')?.click();
      const off = (sel: string) =>
        [...root.querySelectorAll<HTMLButtonElement>(sel)].map((e) => e.disabled);
      return {
        fields: [off('.wename'), off('.wcdone'), off('.wcchip'), off('.wcaddstep')],
        grips: [...root.querySelectorAll('.wegrip')].map((g) => g.getAttribute('draggable'))
      };
    });
    for (const group of state.fields) {
      assert.ok(group.length > 0 && group.every(Boolean), JSON.stringify(state));
    }
    assert.ok(state.grips.length > 0 && state.grips.every((g) => g === 'false'));
    await ed().waitFor({ state: 'hidden', timeout: 10_000 });
    await assert.rejects(fs.stat(file()));
  });
});
