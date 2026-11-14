import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import * as harness from '../harness';

const scope = { repoKey: 'a'.repeat(64), launchCwd: '/repo' };
const id = '11111111-1111-4111-8111-111111111111';
const row: RoutineRowView = {
  id,
  definitionRevision: 1,
  name: 'Dependency review',
  enabled: true,
  schedule: { kind: 'daily', time: '09:00' },
  status: 'Due',
  occurrenceKey: 'epoch/day/2026-11-14',
  due: true
};
const routines: RoutineScopeView = {
  kind: 'ready',
  scope,
  repoRoot: '/repo',
  label: 'acme-web',
  revision: 1,
  rows: [row]
};

function editing(t: TestContext): harness.Panel {
  const panel = harness.openPanel(t);
  panel.push({ ...harness.stateMessage([]), routines });
  panel.window.document.querySelector<HTMLElement>('.routines-tab')?.click();
  const request = panel.posted.find((value) => value.type === 'openRoutine');
  assert.ok(request?.type === 'openRoutine');
  panel.push({
    type: 'routineLoaded',
    operationId: request.operationId,
    action: 'openRoutine',
    result: {
      kind: 'ok',
      id,
      definitionRevision: 1,
      draft: {
        name: row.name,
        enabled: true,
        schedule: row.schedule,
        task: {
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Review dependencies' }] }
            ]
          },
          delivered: 'Review dependencies',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: '/repo'
        }
      }
    }
  });
  return panel;
}

function saveButton(panel: harness.Panel): HTMLButtonElement {
  const button = [
    ...panel.window.document.querySelectorAll<HTMLButtonElement>('.routine-actions button')
  ].find((button) => button.textContent === 'Save');
  assert.ok(button);
  return button;
}

it('retries a refused Run without requiring an unrelated edit', (t) => {
  const panel = editing(t);
  const run = panel.window.document.querySelector<HTMLButtonElement>('[data-routine-run]');
  assert.ok(run);
  run.click();
  const first = panel.posted.find((message) => message.type === 'runRoutine');
  assert.ok(first?.type === 'runRoutine');
  panel.push({
    type: 'routineActionResult',
    operationId: first.operationId,
    action: 'runRoutine',
    result: { kind: 'refused', reason: 'The saved file is unavailable.' }
  });
  assert.notEqual(
    panel.window.document.querySelector('.routine-save')?.textContent,
    'Could not save'
  );
  run.click();
  assert.equal(panel.posted.filter((message) => message.type === 'runRoutine').length, 2);
});

it('cancels a pending dirty Run when a later edit changes the requested task', (t) => {
  const panel = editing(t);
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  prose.select(1);
  prose.type('First ');
  panel.window.document.querySelector<HTMLElement>('[data-routine-run]')?.click();
  const first = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(first?.type === 'saveRoutine');
  prose.type('Later ');
  panel.push({
    type: 'routineActionResult',
    operationId: first.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 2 }
  });
  const second = panel.posted.filter((message) => message.type === 'saveRoutine').at(-1);
  assert.ok(second?.type === 'saveRoutine' && second !== first);
  panel.push({
    type: 'routineActionResult',
    operationId: second.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 3 }
  });
  panel.push({
    ...harness.stateMessage([]),
    routines: { ...routines, revision: 3, rows: [{ ...row, definitionRevision: 3 }] }
  });
  assert.equal(panel.posted.filter((message) => message.type === 'runRoutine').length, 0);
});

for (const leave of ['close', 'select another routine'] as const) {
  it(`launches an acknowledged dirty Run once even after ${leave}`, (t) => {
    const panel = editing(t);
    const other = { ...row, id: '22222222-2222-4222-8222-222222222222', name: 'Other review' };
    panel.push({ ...harness.stateMessage([]), routines: { ...routines, rows: [row, other] } });
    const prose = harness.proseOf(
      panel.window.document.querySelector('.routine-input .compose-editor')
    );
    prose.select(1);
    prose.type('Updated ');
    panel.window.document.querySelector<HTMLElement>('[data-routine-run]')?.click();
    const save = panel.posted.find((message) => message.type === 'saveRoutine');
    assert.ok(save?.type === 'saveRoutine');
    if (leave === 'close')
      panel.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
    else
      panel.window.document.querySelector<HTMLElement>(`[data-routine-id="${other.id}"]`)?.click();
    panel.push({
      type: 'routineActionResult',
      operationId: save.operationId,
      action: 'saveRoutine',
      result: { kind: 'ok', id, definitionRevision: 2 }
    });
    panel.push({
      ...harness.stateMessage([]),
      routines: { ...routines, revision: 2, rows: [{ ...row, definitionRevision: 2 }, other] }
    });
    const runs = panel.posted.filter((message) => message.type === 'runRoutine');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, id);
    if (leave === 'close')
      panel.window.document.querySelector<HTMLElement>('.routines-tab')?.click();
    else panel.window.document.querySelector<HTMLElement>(`[data-routine-id="${id}"]`)?.click();
    assert.equal(panel.posted.filter((message) => message.type === 'runRoutine').length, 1);
  });
}

it('does not revive a closed Run after another window supersedes its saved definition', (t) => {
  const panel = editing(t);
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  prose.select(1);
  prose.type('Updated ');
  panel.window.document.querySelector<HTMLElement>('[data-routine-run]')?.click();
  const save = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(save?.type === 'saveRoutine');
  panel.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
  panel.push({
    type: 'routineActionResult',
    operationId: save.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 2 }
  });
  panel.push({
    ...harness.stateMessage([]),
    routines: { ...routines, revision: 3, rows: [{ ...row, definitionRevision: 3 }] }
  });
  panel.window.document.querySelector<HTMLElement>('.routines-tab')?.click();
  const load = panel.posted.filter((message) => message.type === 'openRoutine').at(-1);
  assert.ok(load?.type === 'openRoutine');
  panel.push({
    type: 'routineLoaded',
    operationId: load.operationId,
    action: 'openRoutine',
    result: {
      kind: 'ok',
      id,
      definitionRevision: 3,
      draft: { ...save.draft, name: 'Review changed elsewhere' }
    }
  });
  assert.equal(panel.posted.filter((message) => message.type === 'runRoutine').length, 0);
});

it('opens the failed routine after a due-pill refusal so its reason is visible', (t) => {
  const panel = editing(t);
  panel.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
  panel.window.document.querySelector<HTMLElement>('#bottomhub-routines button')?.click();
  const run = panel.posted.find((message) => message.type === 'runRoutine');
  assert.ok(run?.type === 'runRoutine');
  panel.push({
    type: 'routineActionResult',
    operationId: run.operationId,
    action: 'runRoutine',
    result: { kind: 'invalid', reason: 'The configured default model is unavailable.' }
  });
  assert.equal(panel.window.document.querySelector<HTMLElement>('#bottomdrawer')?.hidden, false);
  assert.match(
    panel.window.document.querySelector('.routine-error')?.textContent ?? '',
    /default model is unavailable/
  );
});

it('queues an enable toggle behind an in-flight save without dropping it', (t) => {
  const panel = editing(t);
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  prose.select(1);
  prose.type('Updated ');
  saveButton(panel).click();
  const first = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(first?.type === 'saveRoutine');
  const enabled = panel.window.document.querySelector<HTMLInputElement>(
    '.routine-row input[type=checkbox]'
  );
  assert.ok(enabled);
  enabled.click();
  panel.push({
    type: 'routineActionResult',
    operationId: first.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 2 }
  });
  const saves = panel.posted.filter((message) => message.type === 'saveRoutine');
  assert.equal(saves.length, 2);
  assert.equal(saves[1]?.expectedDefinitionRevision, 2);
  assert.equal(saves[1]?.draft.enabled, false);
});

it('does not launch a dirty editor until its save succeeds, and keeps text after a failure', (t) => {
  const panel = editing(t);
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  prose.select(1);
  prose.type('New ');
  panel.window.document.querySelector<HTMLElement>('[data-routine-run]')?.click();
  const save = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(save?.type === 'saveRoutine');
  assert.equal(save.draft.task.delivered, 'New Review dependencies');
  assert.equal(
    panel.posted.some((message) => message.type === 'runRoutine'),
    false
  );
  panel.push({
    type: 'routineActionResult',
    operationId: save.operationId,
    action: 'saveRoutine',
    result: { kind: 'io', reason: 'Disk unavailable' }
  });
  assert.equal(prose.value(), 'New Review dependencies');
  assert.match(
    panel.window.document.querySelector('.routine-error')?.textContent ?? '',
    /Disk unavailable/
  );
  assert.equal(
    panel.posted.some((message) => message.type === 'runRoutine'),
    false
  );
});

it('queues newer edits behind one save and advances only the matching acknowledgment', (t) => {
  const panel = editing(t);
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  prose.select(1);
  prose.type('First ');
  saveButton(panel).click();
  const first = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(first?.type === 'saveRoutine');
  prose.select(1);
  prose.type('Second ');
  panel.push({
    type: 'routineActionResult',
    operationId: 'unrelated',
    action: 'saveRoutine',
    result: { kind: 'ok', definitionRevision: 99 }
  });
  assert.equal(panel.posted.filter((message) => message.type === 'saveRoutine').length, 1);
  panel.push({
    type: 'routineActionResult',
    operationId: first.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 2 }
  });
  const saves = panel.posted.filter((message) => message.type === 'saveRoutine');
  assert.equal(saves.length, 2);
  const next = saves[1];
  assert.ok(next?.type === 'saveRoutine');
  assert.equal(next.expectedDefinitionRevision, 2);
  assert.equal(next.draft.task.delivered, 'Second First Review dependencies');
  assert.equal(prose.value(), 'Second First Review dependencies');
});

it('routes a late file reply back to the closed routine and restores it on reopening', (t) => {
  const panel = editing(t);
  panel.window.document.querySelector<HTMLElement>('.routine-input .compose-attach')?.click();
  const request = panel.posted.find((message) => message.type === 'pickFiles');
  assert.ok(request?.type === 'pickFiles');
  panel.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
  panel.push({ type: 'pickedFiles', operationId: request.operationId, paths: ['/repo/notes.txt'] });
  panel.window.document.querySelector<HTMLElement>('.routines-tab')?.click();
  const prose = harness.proseOf(
    panel.window.document.querySelector('.routine-input .compose-editor')
  );
  assert.match(prose.value(), /\/repo\/notes\.txt/);
  saveButton(panel).click();
  const save = panel.posted.filter((message) => message.type === 'saveRoutine').at(-1);
  assert.ok(save?.type === 'saveRoutine');
  assert.match(save.draft.task.delivered, /\/repo\/notes\.txt/);
});

it('waits for the newly saved cadence occurrence before launching a dirty Run', (t) => {
  const panel = editing(t);
  const cadence = panel.window.document.querySelector<HTMLSelectElement>('.routine-cadence select');
  assert.ok(cadence);
  cadence.value = 'interval';
  cadence.dispatchEvent(new panel.window.Event('change', { bubbles: true }));
  panel.window.document.querySelector<HTMLElement>('[data-routine-run]')?.click();
  const save = panel.posted.find((message) => message.type === 'saveRoutine');
  assert.ok(save?.type === 'saveRoutine');
  panel.push({
    type: 'routineActionResult',
    operationId: save.operationId,
    action: 'saveRoutine',
    result: { kind: 'ok', id, definitionRevision: 2 }
  });
  assert.equal(
    panel.posted.some((message) => message.type === 'runRoutine'),
    false
  );
  panel.push({
    ...harness.stateMessage([]),
    routines: {
      ...routines,
      revision: 2,
      rows: [
        {
          ...row,
          definitionRevision: 2,
          schedule: { kind: 'interval', hours: 24 },
          occurrenceKey: 'new-epoch/interval/1'
        }
      ]
    }
  });
  const run = panel.posted.find((message) => message.type === 'runRoutine');
  assert.ok(run?.type === 'runRoutine');
  assert.equal(run.expectedDefinitionRevision, 2);
  assert.equal(run.occurrenceKey, 'new-epoch/interval/1');
});

it('opens the repository routines after Workflows and posts an explicit saved run', (t) => {
  const panel = harness.openPanel(t);
  panel.push({ ...harness.stateMessage([], { workflows: [harness.workflowView()] }), routines });
  const words = [
    ...panel.window.document.querySelectorAll<HTMLElement>('#bottomhub [data-drawer-mode]')
  ];
  assert.equal(
    words[words.findIndex((word) => word.dataset.drawerMode === 'workflows') + 1]?.dataset
      .drawerMode,
    'routines'
  );
  panel.window.document.querySelector<HTMLElement>('[data-drawer-mode="routines"]')?.click();
  assert.match(
    panel.window.document.querySelector('#bottomdrawer')?.textContent ?? '',
    /Dependency review/
  );
  const opened = panel.posted.find((value) => value.type === 'openRoutine');
  assert.ok(opened?.type === 'openRoutine');
  panel.push({
    type: 'routineLoaded',
    operationId: opened.operationId,
    action: 'openRoutine',
    result: {
      kind: 'ok',
      id,
      definitionRevision: 1,
      draft: {
        name: row.name,
        enabled: true,
        schedule: row.schedule,
        task: {
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Review dependencies' }] }
            ]
          },
          delivered: 'Review dependencies',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: '/repo'
        }
      }
    }
  });
  const button = panel.window.document.querySelector<HTMLButtonElement>('[data-routine-run]');
  assert.ok(button);
  button.click();
  const message = panel.posted.find((value) => value.type === 'runRoutine');
  assert.ok(message?.type === 'runRoutine');
  assert.equal(message.id, id);
  assert.equal(message.expectedDefinitionRevision, 1);
  assert.equal(message.occurrenceKey, row.occurrenceKey);
  assert.deepEqual(message.scope, scope);
});

it('keeps routine editing independent of chat and preserves a missing workflow for repair', (t) => {
  const panel = harness.openThread(t, harness.threadView());
  harness.importComposer(panel, 'Unsent chat message');
  panel.push({
    ...harness.stateMessage([harness.groupView({ sessions: [harness.cardView()] })]),
    routines
  });
  panel.window.document.querySelector<HTMLElement>('[data-drawer-mode="routines"]')?.click();
  panel.window.document.querySelector<HTMLElement>('[data-routine-id]')?.click();
  const request = [...panel.posted].reverse().find((value) => value.type === 'openRoutine');
  assert.ok(request?.type === 'openRoutine');
  panel.push({
    type: 'routineLoaded',
    operationId: request.operationId,
    action: 'openRoutine',
    result: {
      kind: 'ok',
      id,
      definitionRevision: 1,
      draft: {
        name: row.name,
        enabled: true,
        schedule: row.schedule,
        task: {
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Review dependencies' }] }
            ]
          },
          delivered: 'Review dependencies',
          workflowId: 'unavailable',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: '/repo'
        }
      }
    }
  });
  assert.equal(panel.window.document.querySelectorAll('.compose-editor').length, 2);
  assert.match(
    panel.window.document.querySelector('.routine-editor')?.textContent ?? '',
    /Unavailable workflow/
  );
  assert.equal(harness.composerValue(panel), 'Unsent chat message');
  panel.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
  assert.equal(harness.composerValue(panel), 'Unsent chat message');
});
