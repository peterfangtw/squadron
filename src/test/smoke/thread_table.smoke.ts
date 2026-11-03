/**
 * A table too wide for the dock scrolls inside itself rather than panning the
 * thread — why it could, on `.body table` in `ui/css/chat.ts`. The claim is
 * geometry, which jsdom does not have.
 *
 * The table is written into a settled turn of the fixture card rather than
 * planted in its transcript: the transcript is shared with `diff.smoke.ts` and
 * `asks.smoke.ts`, and what is under test is the stylesheet's layout of a
 * `.body table`, not the engine that emits one. Layout is read in the same
 * evaluate that inserts it, so no repaint can land between.
 */
import * as assert from 'node:assert/strict';
import { openPanel, panel, section, step } from './boot';
import { FIXTURE_NAME, fixtureSession } from './kit';

/** One unbreakable run longer than any dock this host can lay out. */
const LONG_PATH = 'src/' + 'very_long_directory_name_without_any_break/'.repeat(6) + 'file.ts';

section('a table wider than the dock', () => {
  step('scrolls inside itself and leaves the thread still', async () => {
    await openPanel();
    await fixtureSession();
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();
    const body = panel().locator('#thread .turn .body').last();
    await body.waitFor({ timeout: 30_000 });

    const read = await body.evaluate((el, longPath) => {
      const table = document.createElement('table');
      table.innerHTML =
        '<thead><tr><th>File</th><th>Lines</th><th>Why it changed</th></tr></thead>' +
        `<tbody><tr><td><code>${longPath}</code></td><td>+42 −7</td><td>Tail read</td></tr></tbody>`;
      el.append(table);
      const thread = document.getElementById('thread');
      if (!thread) throw new Error('no #thread');
      const out = {
        threadScroll: thread.scrollWidth,
        threadClient: thread.clientWidth,
        tableScroll: table.scrollWidth,
        tableClient: table.clientWidth,
        tableRight: table.getBoundingClientRect().right,
        bodyRight: el.getBoundingClientRect().right
      };
      table.remove();
      return out;
    }, LONG_PATH);

    assert.ok(
      read.threadScroll <= read.threadClient,
      `the thread pans sideways: ${read.threadScroll} > ${read.threadClient}`
    );
    assert.ok(
      read.tableRight <= read.bodyRight + 0.5,
      `the table overhangs its turn: ${read.tableRight} > ${read.bodyRight}`
    );
    // The path is still whole, and reachable: the table is what scrolls.
    assert.ok(
      read.tableScroll > read.tableClient,
      `the table does not scroll: ${read.tableScroll} <= ${read.tableClient}`
    );
  });
});
