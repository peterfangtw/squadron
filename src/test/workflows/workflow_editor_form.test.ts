/**
 * Board-mode workflow editor: create / edit entry and save posts.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachWorkflow,
  openPanel,
  openThread,
  proseKey,
  proseOf,
  proseRoot,
  stateMessage,
  threadView,
  typeProse,
  workflowView,
  type Panel
} from '../harness';
import {
  board,
  ship,
  select,
  openSheet,
  sheetItems,
  clickNew,
  openEditShip,
  escOn,
  interrupts,
  editBehindBusy,
  openNode
} from './workflow_editor_helpers';

describe('workflow authoring from a board view', () => {
  for (const view of ['sessions', 'tickets']) {
    for (const create of [false, true]) {
      it(`returns to ${view} after ${create ? 'create' : 'edit'} without hiding chat or discarding an unsaved edit`, (t) => {
        const p = openThread(t, threadView({ owned: true }), { workflows: [ship] });
        const d = p.window.document;
        const destination = d.querySelector<HTMLElement>(`#nav [data-act="${view}"]`);
        assert.ok(destination);
        destination.click();
        p.posted.length = 0;
        if (create) clickNew(p);
        else {
          openSheet(p);
          sheetItems(p)
            .find((row) => row.textContent?.includes(ship.label))
            ?.querySelector<HTMLElement>('.act.edit')
            ?.click();
        }
        assert.equal(d.getElementById('wfeditor')?.hidden, false);
        assert.equal(d.getElementById('tk-list')?.hidden, true);
        for (const frame of ['board-head', 'board-body']) {
          const n = d.getElementById(frame);
          assert.ok(n && p.window.getComputedStyle(n).display === 'none', frame);
        }
        assert.equal(d.getElementById('chat')?.hidden, false);
        d.querySelector<HTMLElement>('#nav [data-act="sessions"]')?.click();
        assert.equal(d.getElementById('wfeditor')?.hidden, false, 'navigation discarded an editor');
        // A new workflow already differs from its empty label only after typing.
        const label = d.querySelector<HTMLInputElement>('#wfeditor .wename');
        assert.ok(label);
        label.value = 'unfinished workflow';
        label.dispatchEvent(new p.window.Event('input', { bubbles: true }));
        escOn(p, d.body);
        assert.equal(
          d.getElementById('wfeditor')?.hidden,
          false,
          'first Escape lost unsaved edits'
        );
        escOn(p, d.body);
        assert.equal(d.getElementById('wfeditor')?.hidden, true);
        assert.equal(d.getElementById('tk-list')?.hidden, view !== 'tickets');
        assert.equal(d.getElementById('cards')?.hidden, view !== 'sessions');
        assert.equal(d.getElementById('chat')?.hidden, false);
        assert.deepEqual(
          p.posted.filter((m) => m.type === 'ticketsOpen'),
          view === 'tickets'
            ? [
                { type: 'ticketsOpen', open: false },
                { type: 'ticketsOpen', open: true }
              ]
            : []
        );
      });
    }
  }
});

describe('workflow editor', () => {
  // An empty machine has no sheet — there is no list to list (S8) — and no
  // handle to open one from. Both doors that remain carry New instead: the
  // bar's lone pill, and the composer menu's footer (`chat_workflow.test.ts`).
  it('leaves the sheet shut on an empty machine, where New is on the bar', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    assert.ok(p.window.document.querySelector('#wattach .fpill'));
    openSheet(p);
    assert.ok(p.window.document.getElementById('bottomdrawer')?.hidden);
    assert.equal(p.window.document.querySelector('#bottomhub .wmore'), null, 'nothing to handle');
    assert.match(
      p.window.document.querySelector('#bottomhub .fpill')?.textContent ?? '',
      /New workflow/
    );
  });

  // New is the list's last row — an add in the geometry of the thing it adds
  // to — and the foot is a legend again, with nothing filled on it.
  it('draws New under the last row, and leaves the foot a legend', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    openSheet(p);
    const kids = [
      ...(p.window.document.querySelector('#bottomdrawer-body .bdlist')?.children ?? [])
    ];
    assert.ok(kids[0]?.classList.contains('wsrow'));
    assert.ok(kids.at(-1)?.classList.contains('wsnew'), 'the add is the last thing in the list');
    assert.equal(p.window.document.querySelector('#bottomdrawer-foot .faction'), null);
    assert.equal(p.window.document.querySelector('#bottomdrawer-foot button'), null);
  });

  it('opens the board editor from New workflow and hides cards', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    const boardEl = p.window.document.getElementById('board');
    assert.ok(boardEl?.classList.contains('editing'));
    assert.ok(p.window.document.getElementById('wfeditor'));
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false);
  });

  it('posts saveWorkflow without id on create', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);

    const root = p.window.document.getElementById('wfeditor')!;
    const name = root.querySelector<HTMLInputElement>('.wefield input')!;
    name.value = 'My chain';
    name.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    const stepName = root.querySelector<HTMLInputElement>('input.wctitle')!;
    stepName.value = 'Plan';
    stepName.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    typeProse(p, root.querySelector('.wcbody'), 'plan the work');

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    const posted = p.posted.filter((m) => m.type === 'saveWorkflow');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], {
      type: 'saveWorkflow',
      label: 'My chain',
      steps: [{ id: 'step-1', label: 'Plan', prompt: 'plan the work' }]
    });
  });

  it('blocks save when a step has no prompt', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);

    const root = p.window.document.getElementById('wfeditor')!;
    const name = root.querySelector<HTMLInputElement>('.wefield input')!;
    name.value = 'Broken';
    name.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    const stepName = root.querySelector<HTMLInputElement>('input.wctitle')!;
    stepName.value = 'Only';
    stepName.dispatchEvent(new p.window.Event('input', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    assert.equal(p.posted.filter((m) => m.type === 'saveWorkflow').length, 0);
    assert.ok(root.querySelector('.westrip'));
  });

  // The shared editor's conversion, through a box with no toolbar: two lines
  // become one fence, not two (`TASK_done_composer_formatting.md`).
  it("a step prompt's code-block key makes one block of the lines it touches", (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);

    const root = p.window.document.getElementById('wfeditor')!;
    const name = root.querySelector<HTMLInputElement>('.wefield input')!;
    name.value = 'My chain';
    name.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    const stepName = root.querySelector<HTMLInputElement>('input.wctitle')!;
    stepName.value = 'Plan';
    stepName.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    const body = root.querySelector('.wcbody');
    typeProse(p, body, 'one\ntwo');
    proseOf(body).select(1, 9);
    proseKey(p, body, 'c', { ctrlKey: true, altKey: true, keyCode: 67 });

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    const posted = p.posted.filter((m) => m.type === 'saveWorkflow');
    assert.deepEqual(posted[0], {
      type: 'saveWorkflow',
      label: 'My chain',
      steps: [{ id: 'step-1', label: 'Plan', prompt: '```\none\ntwo\n```' }]
    });
  });

  it('opens edit from the chip, prefilled, and posts saveWorkflow with id', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    attachWorkflow(p, 'plan→build→review');
    // Edit is on the named chip — never “Edit …” cloned under every row.
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();

    const root = p.window.document.getElementById('wfeditor')!;
    const name = root.querySelector<HTMLInputElement>('.wefield input')!;
    assert.equal(name.value, 'plan→build→review');
    assert.equal(root.querySelectorAll('.wcbody').length, 0, 'edit opens on closed nodes');
    assert.deepEqual(
      [...root.querySelectorAll('.wcdesc')].map((n) => n.textContent),
      ['/plan the work', 'implement it', 'review the diff']
    );

    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    const posted = p.posted.filter((m) => m.type === 'saveWorkflow');
    assert.equal(posted.length, 1);
    const msg = posted[0];
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    assert.equal(msg.id, 'ship');
    assert.equal(msg.label, 'plan→build→review');
    assert.equal(msg.steps.length, 3);
    assert.equal(msg.steps[0]?.id, 'plan');
  });

  it('offers Delete left of Save only when editing an existing workflow', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    clickNew(p);
    assert.equal(
      p.window.document.querySelector('#wfeditor .wedelete'),
      null,
      'create has no file to delete'
    );

    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    attachWorkflow(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();

    const root = p.window.document.getElementById('wfeditor')!;
    const del = root.querySelector<HTMLButtonElement>('.wedelete');
    const save = root.querySelector<HTMLButtonElement>('.wesave');
    assert.ok(del, 'edit offers Delete');
    assert.ok(save);
    // Delete sits immediately left of Save in the head.
    assert.equal(del?.nextElementSibling, save);

    // First click arms; second posts.
    del?.click();
    assert.equal(
      p.window.document.querySelector('#wfeditor .wedelete')?.textContent,
      'Confirm delete'
    );
    assert.equal(p.posted.filter((m) => m.type === 'deleteWorkflow').length, 0);
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wedelete')?.click();
    const posted = p.posted.filter((m) => m.type === 'deleteWorkflow');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { type: 'deleteWorkflow', id: 'ship' });
    // renderEditor rebuilds the head — re-query, do not read the detached node.
    assert.equal(p.window.document.querySelector('#wfeditor .wedelete')?.textContent, 'Deleting…');
    assert.equal(
      p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.disabled,
      true
    );

    p.push({ type: 'deleteWorkflowResult', ok: true });
    assert.equal(p.window.document.getElementById('board')?.classList.contains('editing'), false);
  });

  it('keeps the form open when delete fails', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    attachWorkflow(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wedelete')?.click();
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wedelete')?.click();
    p.push({ type: 'deleteWorkflowResult', ok: false, reasons: ['disk busy'] });
    assert.ok(p.window.document.getElementById('board')?.classList.contains('editing'));
    assert.ok(p.window.document.querySelector('#wfeditor .westrip'));
    assert.equal(p.window.document.querySelector('#wfeditor .wedelete')?.textContent, 'Delete');
  });

  it('Back closes the editor and restores the board', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .weback')?.click();
    assert.equal(p.window.document.getElementById('board')?.classList.contains('editing'), false);
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, true);
  });

  it('saveWorkflowResult ok closes the editor; fail keeps reasons', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);

    // Simulate postSave having set saving — fill and click Save with empty host.
    const root = p.window.document.getElementById('wfeditor')!;
    const name = root.querySelector<HTMLInputElement>('.wefield input')!;
    name.value = 'Ready';
    name.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    const stepName = root.querySelector<HTMLInputElement>('input.wctitle')!;
    stepName.value = 'A';
    stepName.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    typeProse(p, root.querySelector('.wcbody'), 'go');
    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    assert.equal(root.querySelector<HTMLButtonElement>('.wesave')?.disabled, true);

    p.push({ type: 'saveWorkflowResult', ok: false, reasons: ['needs a label'] });
    assert.ok(p.window.document.querySelector('#wfeditor .westrip'));
    assert.ok(p.window.document.getElementById('board')?.classList.contains('editing'));

    // Re-save so saving is true again for the ok path.
    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    p.push({ type: 'saveWorkflowResult', ok: true, id: 'x' });
    assert.equal(p.window.document.getElementById('board')?.classList.contains('editing'), false);
  });

  it('ignores saveWorkflowResult when not waiting for a save', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [] }));
    select(p);
    clickNew(p);

    // Stale result (e.g. after cancel + re-open) must not close the form.
    p.push({ type: 'saveWorkflowResult', ok: true, id: 'stale' });
    assert.ok(p.window.document.getElementById('board')?.classList.contains('editing'));
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false);
  });

  it('picking a workflow still attaches a mention, not the editor', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    attachWorkflow(p, 'plan→build→review');
    assert.equal(p.window.document.getElementById('board')?.classList.contains('editing'), false);
    assert.ok(p.window.document.querySelector('#wattach .wflow'));
    assert.ok(p.window.document.querySelector('#wattach .wflow .wedit'), 'Edit on the chip');
  });

  it('is one row per workflow, with Edit behind the row rather than beside it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    openSheet(p);
    const rows = sheetItems(p);
    assert.equal(rows.length, 1);
    assert.match(rows[0]?.querySelector('.nm')?.textContent ?? '', /plan→build→review/);
    assert.ok(
      !(rows[0]?.textContent ?? '').includes('Edit'),
      'Edit is in the row menu, not a second row'
    );
    assert.match(
      p.window.document.querySelector('#bottomdrawer-body .wsnew')?.textContent ?? '',
      /New workflow/
    );
  });

  /**
   * The title span and the field's label named the same thing twice, in the
   * densest part of the surface. The label carries the state instead — it is
   * the same `d.id !== undefined` that decides whether Delete is drawn at all.
   */
  it('names the screen on the field label, with no separate title', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    select(p);
    clickNew(p);
    const root = () => p.window.document.getElementById('wfeditor')!;
    assert.equal(root().querySelector('.wetitle'), null, 'no title span');
    assert.equal(root().querySelector('.welabel')?.textContent, 'New workflow');

    root().querySelector<HTMLButtonElement>('.weback')?.click();
    openEditShip(p);
    assert.equal(root().querySelector('.wetitle'), null, 'no title span');
    assert.equal(root().querySelector('.welabel')?.textContent, 'Edit workflow');
    // The field it labels is still the workflow name, and still says so itself.
    assert.equal(
      root().querySelector('.wefield input')?.getAttribute('aria-label'),
      'Workflow name'
    );
  });

  it('a save blocked on a closed node opens that node', (t) => {
    const p = openPanel(t);
    const broken = workflowView({
      steps: [
        { id: 'plan', label: 'Plan', prompt: '/plan the work' },
        { id: 'build', label: 'Build', prompt: 'implement it', needs: ['plan'] },
        { id: 'review', label: 'Review', prompt: '', needs: ['build'] }
      ]
    });
    p.push(stateMessage(board(), { workflows: [broken] }));
    select(p);
    attachWorkflow(p, 'Ship it');
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .wedit')?.click();

    const root = p.window.document.getElementById('wfeditor')!;
    assert.equal(root.querySelectorAll('.wcbody').length, 0);
    root.querySelector<HTMLButtonElement>('.wesave')?.click();
    assert.equal(p.posted.filter((m) => m.type === 'saveWorkflow').length, 0);
    assert.ok(root.querySelector('.westrip'));
    const open = p.window.document.querySelector<HTMLElement>('#wfeditor .wcnode.editing');
    assert.equal(open?.dataset.node, 'review');
    assert.equal(proseOf(open?.querySelector('.wcbody')).value(), '');
  });

  it('posts no output, so a save leaves the file’s own', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), { workflows: [ship] }));
    openEditShip(p);

    p.window.document.querySelector<HTMLButtonElement>('#wfeditor .wesave')?.click();
    const msg = p.posted.filter((m) => m.type === 'saveWorkflow')[0];
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    // A default of `''` here would clear every file's output on save.
    assert.equal('output' in (msg.steps[0] ?? {}), false);
  });
});

describe('Escape in the board editor', () => {
  const editor = (p: Panel) => p.window.document.getElementById('wfeditor');
  const back = (p: Panel) => p.window.document.querySelector<HTMLElement>('#wfeditor .weback');
  const rename = (p: Panel, label: string): void => {
    const name = editor(p)!.querySelector<HTMLInputElement>('.wefield input')!;
    name.value = label;
    name.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  };

  it('goes back to the board, and never ends the turn behind it', (t) => {
    const p = editBehindBusy(t);
    escOn(p, p.window.document.body);
    assert.equal(editor(p)?.hidden, true);
    assert.equal(interrupts(p), 0, 'one Escape left the editor and ended the turn');
  });

  it('asks a second Escape before it drops an edit', (t) => {
    const p = editBehindBusy(t);
    rename(p, 'shipping');
    escOn(p, p.window.document.body);
    assert.equal(editor(p)?.hidden, false, 'the first Escape dropped the edit');
    assert.equal(back(p)?.textContent, 'Discard edits');
    escOn(p, p.window.document.body);
    assert.equal(editor(p)?.hidden, true);
    assert.equal(interrupts(p), 0);
  });

  it('disarms on the next edit', (t) => {
    const p = editBehindBusy(t);
    rename(p, 'shipping');
    escOn(p, p.window.document.body);
    rename(p, 'shipping it');
    assert.equal(back(p)?.textContent, '← Board', 'the warning outlived the draft it was about');
    escOn(p, p.window.document.body);
    assert.equal(editor(p)?.hidden, false, 'a newer edit was dropped on the old warning');
  });

  it('never ends the turn while a save holds the editor', (t) => {
    // The editor ignores Escape mid-write, and the board is still covered: the
    // key falls to nobody rather than to the session behind it.
    const p = editBehindBusy(t);
    editor(p)?.querySelector<HTMLButtonElement>('.wesave')?.click();
    assert.equal(back(p)?.hasAttribute('disabled'), true, 'no save in flight');
    escOn(p, p.window.document.body);
    assert.equal(editor(p)?.hidden, false);
    assert.equal(interrupts(p), 0);
  });

  it('leaves a box its own Escape', (t) => {
    const p = editBehindBusy(t);
    escOn(p, editor(p)?.querySelector('.wefield input'));
    assert.equal(editor(p)?.hidden, false);
    assert.equal(interrupts(p), 0);
  });

  it('leaves a step prompt its own Escape', (t) => {
    const p = editBehindBusy(t);
    openNode(p, 0);
    escOn(p, proseRoot(editor(p)?.querySelector('.wcnode.editing .wcbody')));
    assert.equal(editor(p)?.hidden, false);
    assert.equal(interrupts(p), 0);
  });

  it('disarms when a step prompt is edited', (t) => {
    // The prompt writes the draft from its editor's change, not from an
    // `input` event the body would hear.
    const p = editBehindBusy(t);
    rename(p, 'shipping');
    escOn(p, p.window.document.body);
    assert.equal(back(p)?.textContent, 'Discard edits');
    openNode(p, 0);
    typeProse(p, editor(p)?.querySelector('.wcnode.editing .wcbody'), 'plan it again');
    assert.equal(back(p)?.textContent, '← Board', 'the warning outlived the draft it was about');
  });
});
