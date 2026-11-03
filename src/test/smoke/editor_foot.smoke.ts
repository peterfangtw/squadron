import * as assert from 'node:assert/strict';
import { openPanel, panel, section, step } from './boot';
import { onSheet, pressRowAction, openWorkflowSheet, stepPrompt } from './kit';

/**
 * Where Remove and Done land on an open step.
 *
 * jsdom holds the order and `justify-content: flex-end`. It has no boxes, so
 * a foot that stayed on the left would still pass. This is the edge, and it
 * needs no session: the sheet opens off the workflows planted at boot.
 */
section('an open workflow step, in the real IDE', () => {
  step('puts Remove left of Done, on the right of the tile', async () => {
    await openPanel();
    await onSheet(async () => {
      await openWorkflowSheet();
      await pressRowAction('smoke workflow', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
    });

    assert.equal(
      await panel().locator('#wfeditor .werm').count(),
      0,
      'a closed tile has no remove'
    );
    // Step 1 starts the run and has no Remove.
    await panel().locator('#wfeditor .wcnode[data-node="two"] .wcname').click();
    const editing = panel().locator('#wfeditor .wcnode.editing');
    await stepPrompt(editing).waitFor({ state: 'visible', timeout: 10_000 });
    assert.deepEqual(await editing.locator('.wcfoot button').allTextContents(), ['Remove', 'Done']);
    assert.equal(await editing.locator('.wchead .werm').count(), 0);

    const card = await editing.boundingBox();
    const remove = await editing.locator('.werm').boundingBox();
    const done = await editing.locator('.wcdone').boundingBox();
    assert.ok(card && remove && done, 'the open tile has a foot');
    assert.ok(
      remove.x + remove.width <= done.x + 1,
      `Remove ends at ${remove.x + remove.width}, Done starts at ${done.x}`
    );
    assert.ok(
      done.x + done.width >= card.x + card.width - 20,
      `Done ends at ${done.x + done.width}, the tile ends at ${card.x + card.width}`
    );
    assert.ok(
      done.y > card.y + card.height / 2,
      `Done is at ${done.y}, the tile spans ${card.y}–${card.y + card.height}`
    );

    await panel().locator('#wfeditor .weback').click();
    await panel().locator('#wfeditor').waitFor({ state: 'hidden', timeout: 10_000 });
  });
});
