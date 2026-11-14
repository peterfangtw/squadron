import * as dom from './dom';
import * as kit from './kit';
import * as state from './state';
import * as editor from './routine_editor';
import * as input from './compose_input';
import * as markup from '../ui/compose_input_markup';
import * as compose from '../ui/compose_doc';
import * as prose from './prose';
import * as bottomDrawer from './bottom_drawer';
import * as numInput from './num_input';
import type * as types from '../core/routines/types';

let selected: string | undefined;
let confirming: string | undefined;
let mounted:
  | {
      buffer: editor.Buffer;
      root: HTMLElement;
      input: input.ComposeInput;
      choices: ReturnType<typeof input.choiceControls>;
      name: HTMLInputElement;
      cadence: HTMLSelectElement;
      time: HTMLInputElement;
      weekday: HTMLSelectElement;
      hours: HTMLInputElement;
      status: HTMLElement;
      saved: HTMLElement;
      error: HTMLElement;
      run: HTMLButtonElement;
      skip: HTMLButtonElement;
      association: HTMLElement;
    }
  | undefined;
let active = false;

editor.onChange(() => {
  if (active) paint();
});
editor.onRunFailure((id) => {
  if (active && selected === id) return;
  if (selected !== id) closeEditor();
  selected = id;
  bottomDrawer.open('routines');
});

export function scope(): Extract<RoutineScopeView, { kind: 'ready' }> | undefined {
  const value = state.ui.state.routines;
  return value?.kind === 'ready' ? value : undefined;
}

export function bar(): { count: number; tip: string } {
  const count = scope()?.rows.filter((row) => row.due).length ?? 0;
  return {
    count,
    tip: count
      ? `${count} routines due. Arrow Up to browse; click to configure.`
      : 'Recurring tasks for this project'
  };
}

export function repaint(shown: boolean): void {
  active = shown;
  if (shown) paint();
  else closeEditor();
}

export function closed(): void {
  active = false;
  closeEditor();
}

function closeEditor(): void {
  if (!mounted) return;
  stash();
  editor.flush(mounted.buffer);
  mounted.choices.dispose();
  mounted.input.dispose();
  mounted = undefined;
}

function stash(): void {
  if (!mounted) return;
  const snapshot = mounted.input.snapshot();
  mounted.buffer.draft.task = {
    ...mounted.buffer.draft.task,
    doc: snapshot.doc,
    delivered: snapshot.delivered,
    attachments: { ...mounted.buffer.draft.task.attachments, ...snapshot.attachments }
  };
}

function rowBy(id: string): RoutineRowView | undefined {
  return scope()?.rows.find((row) => row.id === id);
}

export function paint(): void {
  active = true;
  const body = dom.$('bottomdrawer-body');
  const list = dom.q(body, '.bdlist');
  const detail = dom.q(body, '.bddetail');
  const view = scope();
  if (!view) {
    closeEditor();
    list.replaceChildren(
      dom.el(
        'div',
        'empty',
        state.ui.state.routines?.kind === 'unavailable'
          ? state.ui.state.routines.reason
          : 'Loading routines…'
      )
    );
    detail.replaceChildren();
    return;
  }
  if (mounted && mounted.buffer.scope.repoKey !== view.scope.repoKey) {
    closeEditor();
    selected = undefined;
  }
  if (selected === undefined && view.rows[0]) selected = view.rows[0].id;
  kit.morph(list, [...view.rows.map((row) => routineRow(row, view.scope)), newRow(view.scope)]);
  const savedRow = selected === undefined ? undefined : rowBy(selected);
  const buffer = savedRow
    ? editor.load(view.scope, savedRow)
    : selected
      ? editor.get(selected)
      : undefined;
  if (!buffer) {
    closeEditor();
    detail.replaceChildren(
      dom.el('div', 'empty', 'Save a task and cadence. Every run starts only when you click Run.')
    );
    return;
  }
  if (!mounted || mounted.buffer !== buffer || !mounted.root.isConnected) {
    closeEditor();
    if (buffer.loading) {
      detail.replaceChildren(
        dom.el('div', 'empty', buffer.runError ?? buffer.error ?? 'Loading task…')
      );
      return;
    }
    mount(detail, buffer);
  }
  if (!mounted) return;
  const held = mounted;
  const draft = buffer.draft;
  dom
    .q(held.root, '.compose-editor')
    .classList.toggle('empty', compose.showComposeHint(draft.task.doc));
  if (document.activeElement !== held.name) held.name.value = draft.name;
  held.cadence.value = draft.schedule.kind;
  held.time.hidden = draft.schedule.kind === 'interval';
  held.hours.hidden = draft.schedule.kind !== 'interval';
  held.weekday.hidden = draft.schedule.kind !== 'weekly';
  if (draft.schedule.kind === 'interval') {
    if (document.activeElement !== held.hours) {
      held.hours.value = String(draft.schedule.hours);
      held.hours.dataset.value = String(draft.schedule.hours);
    }
  } else {
    if (document.activeElement !== held.time) held.time.value = draft.schedule.time;
    if (draft.schedule.kind === 'weekly') held.weekday.value = String(draft.schedule.weekday);
  }
  const liveDoc = held.input.editor.snapshot() as compose.ComposeDoc;
  if (!compose.sameDoc(liveDoc, draft.task.doc))
    held.input.editor.restore(draft.task.doc, { history: 'fresh' });
  input.workflowSlot(
    dom.q(held.root, '.compose-workflow'),
    state.ui.state.workflows ?? [],
    draft.task.workflowId,
    (workflowId) => {
      editor.edit(buffer, (value) => {
        value.task.workflowId = workflowId;
      });
      paint();
    }
  );
  held.choices.render();
  held.status.textContent = savedRow
    ? `${savedRow.status}${savedRow.nextDueAt === undefined ? '' : ` · Next due ${new Date(savedRow.nextDueAt).toLocaleString()}`}`
    : 'New routine · Paused until enabled';
  held.saved.textContent = buffer.saving
    ? 'Saving…'
    : buffer.conflict
      ? 'Conflict'
      : buffer.error
        ? 'Could not save'
        : buffer.edits === buffer.savedEdits && buffer.revision !== null
          ? 'Saved'
          : 'Unsaved';
  held.error.replaceChildren();
  if (buffer.error || buffer.runError || savedRow?.reason)
    held.error.append(
      dom.el('span', null, buffer.error ?? buffer.runError ?? savedRow?.reason ?? '')
    );
  if (buffer.conflict) {
    held.error.append(
      button('Reload saved', () => {
        editor.resolveConflict(buffer, false);
        paint();
      }),
      button('Save my edits', () => editor.resolveConflict(buffer, true))
    );
  }
  const missingWorkflow =
    draft.task.workflowId !== undefined &&
    !state.ui.state.workflows?.some((workflow) => workflow.id === draft.task.workflowId);
  held.run.disabled =
    !!savedRow?.runId ||
    !!buffer.running ||
    !!buffer.conflict ||
    missingWorkflow ||
    !draft.name.trim() ||
    (compose.blank(draft.task.doc) && !draft.task.workflowId);
  held.run.textContent = buffer.running
    ? 'Starting…'
    : savedRow?.status === 'Needs attention'
      ? 'Retry'
      : 'Run now';
  held.skip.disabled =
    !savedRow || !!savedRow.runId || !!buffer.saving || buffer.edits !== buffer.savedEdits;
  held.association.replaceChildren();
  if (savedRow?.runId) {
    if (savedRow.sessionAction === 'openLocal')
      held.association.append(
        button('Open session', () => postSession('openRoutineSession', savedRow))
      );
    else if (savedRow.sessionAction === 'switchWindow')
      held.association.append(
        dom.el(
          'p',
          null,
          `Open its IDE window · ${savedRow.windowLabel ?? savedRow.location ?? ''}`
        )
      );
    held.association.append(button('Recheck', () => postSession('recheckRoutine', savedRow)));
  }
  if (savedRow?.lastRun)
    held.association.append(
      dom.el(
        'p',
        'routine-last',
        `Previous run ${new Date(savedRow.lastRun.at).toLocaleString()} · ${savedRow.lastRun.done ? 'Completed' : 'Not completed'}${savedRow.lastRun.note ? ` · ${savedRow.lastRun.note}` : ''}`
      )
    );
}

function routineRow(row: RoutineRowView, token: RoutineScopeToken): HTMLElement {
  const root = dom.el(
    'div',
    `routine-row${row.id === selected ? ' sel' : ''}${row.enabled ? '' : ' paused'}`
  );
  root.dataset.key = row.id;
  const choose = button(row.name, () => {
    closeEditor();
    selected = row.id;
    confirming = undefined;
    paint();
  });
  choose.dataset.routineId = row.id;
  choose.className = 'routine-select';
  choose.append(dom.el('span', 'routine-meta', `${cadenceLabel(row.schedule)} · ${row.status}`));
  const enabled = dom.el('input', 'check') as HTMLInputElement;
  enabled.type = 'checkbox';
  const buffered = editor.get(row.id);
  enabled.checked =
    buffered?.pendingEnabled ??
    (buffered && !buffered.loading ? buffered.draft.enabled : row.enabled);
  enabled.disabled = !!buffered?.conflict;
  enabled.setAttribute('aria-label', `Enable ${row.name}`);
  enabled.onchange = (event) => {
    const current = rowBy(row.id);
    if (current)
      editor.setEnabled(
        editor.load(token, current),
        (event.currentTarget as HTMLInputElement).checked
      );
  };
  const duplicate = button('Duplicate', () => {
    const current = rowBy(row.id);
    if (current) editor.simple(editor.load(token, current), 'duplicateRoutine', current);
  });
  duplicate.className = 'routine-small';
  const remove = button(confirming === row.id ? 'Delete routine' : 'Delete', () => {
    if (confirming !== row.id) {
      confirming = row.id;
      paint();
      return;
    }
    const current = rowBy(row.id);
    if (current) editor.simple(editor.load(token, current), 'deleteRoutine', current);
    confirming = undefined;
  });
  remove.className = 'routine-small';
  duplicate.disabled = remove.disabled = !!editor.get(row.id)?.saving;
  const enableTarget = dom.el('label', 'routine-enable');
  enableTarget.append(enabled);
  const actions = dom.el('div', 'routine-row-actions');
  actions.append(duplicate, remove);
  root.append(choose, enableTarget, actions);
  if (confirming === row.id)
    actions.append(
      button('Keep', () => {
        confirming = undefined;
        paint();
      })
    );
  return root;
}

function newRow(token: RoutineScopeToken): HTMLElement {
  const root = button('New routine', () => {
    closeEditor();
    selected = editor.create(token).id;
    paint();
  });
  root.className = 'wsnew';
  root.dataset.key = 'routine:new';
  return root;
}

function mount(detail: HTMLElement, buffer: editor.Buffer): void {
  const root = dom.el('div', 'routine-editor');
  root.dataset.key = buffer.id;
  const name = dom.el('input', 'routine-name') as HTMLInputElement;
  name.maxLength = 120;
  name.placeholder = 'Routine name';
  name.setAttribute('aria-label', 'Routine name');
  name.oninput = () => {
    editor.edit(buffer, (draft) => {
      draft.name = name.value;
    });
  };
  const task = dom.el('div', 'compose-root routine-input');
  task.innerHTML = markup.composeInputMarkup(
    `routine-${buffer.id}-`,
    'Describe the recurring task…'
  );
  task.querySelector('.hintkeys')?.remove();
  task.querySelector('.compose-send')?.remove();
  const blocked = dom.el('div', 'routine-error');
  const native = input.mount({
    input: dom.q(task, '.compose-editor'),
    formatbar: dom.q(task, '.compose-formatbar'),
    owner: () => buffer.id,
    value: () => ({
      pool: buffer.draft.task.attachments
    }),
    opened: () => state.vscode.postMessage({ type: 'refreshSkills' }),
    sources: () => ({
      models: state.ui.state.models,
      tickets: state.ui.state.tickets,
      sessions: state.ui.state.groups.flatMap((group) => group.sessions),
      skills: state.ui.state.skills ?? []
    }),
    locked: () => false,
    canAttach: () => true,
    attach: (image) => {
      const id = crypto.randomUUID();
      buffer.draft.task.attachments = {
        ...buffer.draft.task.attachments,
        [id]: { kind: 'image', image }
      };
      return id;
    },
    error: (reason) => {
      buffer.error = reason;
      paint();
    },
    changed: () => {
      editor.edit(buffer, (draft) => {
        const value = native.snapshot();
        draft.task.doc = value.doc;
        draft.task.delivered = value.delivered;
      });
      task
        .querySelector('.compose-editor')
        ?.classList.toggle('empty', compose.showComposeHint(buffer.draft.task.doc));
    }
  });
  native.editor.restore(buffer.draft.task.doc, { history: 'fresh' });
  const controls = dom.q(task, '.compose-tools');
  const modelControls = input.choiceControls(controls, () => ({
    models: state.ui.state.models,
    target:
      buffer.draft.task.targetChoice.kind === 'explicit'
        ? buffer.draft.task.targetChoice.target
        : undefined,
    efforts: state.ui.state.efforts,
    allowDefault: true,
    onPick: (target) => {
      editor.edit(buffer, (draft) => {
        draft.task.targetChoice = target ? { kind: 'explicit', target } : { kind: 'default' };
      });
      paint();
    }
  }));
  dom.q(task, '.compose-attach').onclick = () => {
    const operationId = crypto.randomUUID();
    input.registerFilePick(operationId, buffer.id, (paths) => {
      editor.edit(buffer, (draft) => {
        draft.task.doc = input.appendFiles(draft.task.doc, paths);
        draft.task.delivered = prose
          .deliveryOf(compose.capture(draft.task.doc, draft.task.attachments).wire)
          .trimEnd();
      });
      if (mounted?.buffer === buffer) {
        native.editor.restore(buffer.draft.task.doc, { history: 'fresh' });
        paint();
      }
    });
    state.vscode.postMessage({ type: 'pickFiles', cwd: buffer.scope.launchCwd, operationId });
  };
  const cadence = dom.el('select') as HTMLSelectElement;
  cadence.setAttribute('aria-label', 'Cadence');
  for (const [value, label] of [
    ['daily', 'Daily'],
    ['weekly', 'Weekly'],
    ['interval', 'Every N hours']
  ]) {
    const option = dom.el('option', null, label);
    (option as HTMLOptionElement).value = value ?? '';
    cadence.append(option);
  }
  const time = dom.el('input') as HTMLInputElement;
  time.type = 'time';
  time.setAttribute('aria-label', 'Local time');
  const weekday = dom.el('select') as HTMLSelectElement;
  weekday.setAttribute('aria-label', 'Weekday');
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(
    (label, index) => {
      const option = dom.el('option', null, label) as HTMLOptionElement;
      option.value = String(index + 1);
      weekday.append(option);
    }
  );
  const hours = numInput.numInput({
    value: buffer.draft.schedule.kind === 'interval' ? buffer.draft.schedule.hours : 24,
    min: 1,
    max: 168,
    label: 'Hours between reminders',
    onCommit: (value) =>
      editor.edit(buffer, (draft) => {
        if (draft.schedule.kind === 'interval') draft.schedule.hours = value;
      })
  });
  cadence.onchange = () => {
    editor.edit(buffer, (draft) => {
      draft.schedule =
        cadence.value === 'interval'
          ? { kind: 'interval', hours: 24 }
          : cadence.value === 'weekly'
            ? { kind: 'weekly', weekday: 1, time: '09:00' }
            : { kind: 'daily', time: '09:00' };
    });
    paint();
  };
  time.onchange = () =>
    editor.edit(buffer, (draft) => {
      if (draft.schedule.kind !== 'interval') draft.schedule.time = time.value;
    });
  weekday.onchange = () =>
    editor.edit(buffer, (draft) => {
      if (draft.schedule.kind === 'weekly') draft.schedule.weekday = Number(weekday.value);
    });
  const cadenceRow = dom.el('div', 'routine-cadence');
  cadenceRow.append(
    cadence,
    weekday,
    time,
    hours,
    dom.el('span', 'routine-timezone', Intl.DateTimeFormat().resolvedOptions().timeZone)
  );
  const status = dom.el('div', 'routine-status');
  const saved = dom.el('span', 'routine-save');
  saved.setAttribute('role', 'status');
  const actions = dom.el('div', 'routine-actions');
  const run = button('Run now', () => {
    stash();
    editor.run(buffer, rowBy(buffer.id));
  });
  run.dataset.routineRun = buffer.id;
  const skip = button('Skip cycle', () => {
    const row = rowBy(buffer.id);
    if (row) editor.simple(buffer, 'skipRoutine', row);
  });
  const save = button('Save', () => {
    stash();
    editor.flush(buffer);
  });
  actions.append(run, skip, save, saved);
  const association = dom.el('div', 'routine-association');
  root.append(name, task, cadenceRow, status, actions, blocked, association);
  if (buffer.draft.task.savedFromCwd !== buffer.scope.launchCwd)
    root.append(
      dom.el(
        'p',
        'routine-meta',
        `File references were saved from ${buffer.draft.task.savedFromCwd}`
      )
    );
  detail.replaceChildren(root);
  mounted = {
    buffer,
    root,
    input: native,
    choices: modelControls,
    name,
    cadence,
    time,
    weekday,
    hours,
    status,
    saved,
    error: blocked,
    run,
    skip,
    association
  };
}

function button(label: string, press: () => void): HTMLButtonElement {
  const control = dom.el('button', 'fbtn', label) as HTMLButtonElement;
  control.type = 'button';
  control.onclick = press;
  return control;
}

function postSession(type: 'openRoutineSession' | 'recheckRoutine', row: RoutineRowView): void {
  const view = scope();
  if (!view || !row.runId) return;
  state.vscode.postMessage({
    type,
    scope: view.scope,
    operationId: crypto.randomUUID(),
    id: row.id,
    runId: row.runId
  });
}

export function runSaved(id: string): void {
  const view = scope();
  const row = rowBy(id);
  if (!view || !row || !row.due) return;
  editor.runSaved(view.scope, row);
}

function cadenceLabel(schedule: types.Schedule): string {
  return schedule.kind === 'interval'
    ? `Every ${schedule.hours} hours`
    : `${schedule.kind === 'daily' ? 'Daily' : 'Weekly'} at ${schedule.time}`;
}
