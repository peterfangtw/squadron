import * as composeInput from './compose_input';
import * as state from './state';
import type * as routines from '../core/routines/types';

export type Buffer = {
  id: string;
  scope: RoutineScopeToken;
  revision: number | null;
  draft: routines.Draft;
  edits: number;
  savedEdits: number;
  loading?: boolean;
  saving?: { operationId: string; edits: number };
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  runError?: string;
  conflict?: RoutineReply['result'];
  pendingRun?: number;
  pendingEnabled?: boolean;
  running?: string;
};

const buffers = new Map<string, Buffer>();
const operations = new Map<string, { buffer: Buffer; action: RoutineWebviewMessage['type'] }>();
let changed = (): void => {};
let runFailed: (id: string) => void = () => {};

export function onChange(callback: () => void): void {
  changed = callback;
}
export function onRunFailure(callback: (id: string) => void): void {
  runFailed = callback;
}
export function get(id: string): Buffer | undefined {
  return buffers.get(id);
}

export function create(scope: RoutineScopeToken): Buffer {
  const buffer: Buffer = {
    id: crypto.randomUUID(),
    scope,
    revision: null,
    edits: 0,
    savedEdits: 0,
    draft: {
      name: '',
      enabled: false,
      schedule: { kind: 'daily', time: '09:00' },
      task: {
        doc: { type: 'doc', content: [{ type: 'paragraph' }] },
        delivered: '',
        targetChoice: { kind: 'default' },
        attachments: {},
        savedFromCwd: scope.launchCwd
      }
    }
  };
  buffers.set(buffer.id, buffer);
  return buffer;
}

export function load(scope: RoutineScopeToken, row: RoutineRowView): Buffer {
  const existing = buffers.get(row.id);
  if (existing && existing.scope.repoKey === scope.repoKey) {
    if (
      (existing.revision ?? 0) < row.definitionRevision &&
      !existing.loading &&
      !existing.saving &&
      !existing.conflict
    )
      requestLoad(existing);
    return existing;
  }
  const buffer = create(scope);
  buffers.delete(buffer.id);
  buffer.id = row.id;
  buffer.revision = row.definitionRevision;
  buffers.set(buffer.id, buffer);
  requestLoad(buffer);
  return buffer;
}

function requestLoad(buffer: Buffer): void {
  buffer.loading = true;
  post(buffer, { type: 'openRoutine', id: buffer.id });
}

type Request = RoutineWebviewMessage extends infer M
  ? M extends RoutineWebviewMessage
    ? Omit<M, 'operationId' | 'scope'>
    : never
  : never;

function post(buffer: Buffer, request: Request): string {
  const operationId = crypto.randomUUID();
  operations.set(operationId, { buffer, action: request.type });
  state.vscode.postMessage({
    ...request,
    operationId,
    scope: buffer.scope
  });
  return operationId;
}

export function edit(buffer: Buffer, update: (draft: routines.Draft) => void): void {
  buffer.pendingRun = undefined;
  buffer.runError = undefined;
  update(buffer.draft);
  buffer.edits++;
  if (!buffer.conflict) buffer.error = undefined;
  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => flush(buffer), 400);
}

export function flush(buffer: Buffer): void {
  clearTimeout(buffer.timer);
  buffer.timer = undefined;
  if (buffer.loading || buffer.saving || buffer.conflict || buffer.edits === buffer.savedEdits)
    return;
  const operationId = post(buffer, {
    type: 'saveRoutine',
    id: buffer.id,
    expectedDefinitionRevision: buffer.revision,
    draft: structuredClone(buffer.draft)
  });
  buffer.saving = { operationId, edits: buffer.edits };
  changed();
}

export function run(buffer: Buffer, row: RoutineRowView | undefined): void {
  if (buffer.running || buffer.conflict || buffer.loading) return;
  buffer.runError = undefined;
  buffer.pendingRun = buffer.edits;
  resumeRun(buffer, row);
}

function resumeRun(buffer: Buffer, row: RoutineRowView | undefined): void {
  if (buffer.pendingRun === undefined) return;
  if (buffer.pendingRun !== buffer.edits || buffer.conflict || buffer.loading || buffer.running) {
    buffer.pendingRun = undefined;
    return;
  }
  if (
    !buffer.saving &&
    row &&
    buffer.revision !== null &&
    row.definitionRevision > buffer.revision
  ) {
    buffer.pendingRun = undefined;
    buffer.runError = 'This routine changed before it could run. Review it and click Run again.';
    changed();
    return;
  }
  if (buffer.edits !== buffer.savedEdits) {
    flush(buffer);
    return;
  }
  if (
    buffer.saving ||
    !row ||
    buffer.revision === null ||
    buffer.revision !== row.definitionRevision
  )
    return;
  if (buffer.error) {
    buffer.pendingRun = undefined;
    return;
  }
  if (
    buffer.draft.task.workflowId &&
    !state.ui.state.workflows?.some((workflow) => workflow.id === buffer.draft.task.workflowId)
  ) {
    buffer.pendingRun = undefined;
    buffer.runError = 'The saved workflow is unavailable. Restore it or choose another.';
    changed();
    return;
  }
  buffer.pendingRun = undefined;
  const runId = crypto.randomUUID();
  buffer.running = post(buffer, {
    type: 'runRoutine',
    id: buffer.id,
    expectedDefinitionRevision: buffer.revision,
    occurrenceKey: row.occurrenceKey,
    runId
  });
  changed();
}

export function reconcileRuns(): void {
  const view = state.ui.state.routines;
  if (view?.kind !== 'ready') return;
  for (const buffer of buffers.values()) {
    if (buffer.pendingRun === undefined) continue;
    if (
      buffer.scope.repoKey !== view.scope.repoKey ||
      buffer.scope.launchCwd !== view.scope.launchCwd
    ) {
      buffer.pendingRun = undefined;
      continue;
    }
    resumeRun(
      buffer,
      view.rows.find((row) => row.id === buffer.id)
    );
  }
}

export function runSaved(scope: RoutineScopeToken, row: RoutineRowView): void {
  const buffer = load(scope, row);
  if (buffer.running) return;
  buffer.runError = undefined;
  buffer.running = post(buffer, {
    type: 'runRoutine',
    id: row.id,
    expectedDefinitionRevision: row.definitionRevision,
    occurrenceKey: row.occurrenceKey,
    runId: crypto.randomUUID()
  });
}

export function setEnabled(buffer: Buffer, enabled: boolean): void {
  if (buffer.conflict) return;
  if (buffer.loading) {
    buffer.pendingEnabled = enabled;
    changed();
    return;
  }
  const dirty = buffer.edits !== buffer.savedEdits;
  edit(buffer, (draft) => {
    draft.enabled = enabled;
  });
  if (buffer.saving || dirty || buffer.revision === null) {
    flush(buffer);
    changed();
    return;
  }
  clearTimeout(buffer.timer);
  buffer.timer = undefined;
  const operationId = post(buffer, {
    type: 'setRoutineEnabled',
    id: buffer.id,
    expectedDefinitionRevision: buffer.revision,
    enabled
  });
  buffer.saving = { operationId, edits: buffer.edits };
  changed();
}

export function simple(
  buffer: Buffer,
  action: 'duplicateRoutine' | 'deleteRoutine' | 'skipRoutine',
  row: RoutineRowView
): void {
  if (buffer.saving || buffer.conflict) return;
  const base = { id: row.id, expectedDefinitionRevision: row.definitionRevision };
  if (action === 'skipRoutine')
    post(buffer, { ...base, type: action, occurrenceKey: row.occurrenceKey });
  else post(buffer, { ...base, type: action });
}

export function clear(buffer: Buffer): void {
  clearTimeout(buffer.timer);
  composeInput.discardFilePicks(buffer.id);
  buffers.delete(buffer.id);
  for (const [id, pending] of operations) if (pending.buffer === buffer) operations.delete(id);
}

export function resolveConflict(buffer: Buffer, keep: boolean): void {
  const latest = buffer.conflict;
  if (!latest?.draft || latest.definitionRevision === undefined) return;
  buffer.revision = latest.definitionRevision;
  if (!keep) {
    buffer.draft = latest.draft;
    buffer.savedEdits = buffer.edits;
  }
  buffer.conflict = undefined;
  buffer.error = undefined;
  if (buffer.pendingEnabled !== undefined) {
    if (keep) {
      buffer.draft.enabled = buffer.pendingEnabled;
      buffer.edits++;
    }
    buffer.pendingEnabled = undefined;
  }
  if (keep) flush(buffer);
  changed();
}

export function takeReply(message: RoutineReply): void {
  const operation = operations.get(message.operationId);
  if (!operation || operation.action !== message.action) return;
  operations.delete(message.operationId);
  const { buffer } = operation;
  const result = message.result;
  if (buffer.running === message.operationId) buffer.running = undefined;
  if (message.action === 'openRoutine') {
    buffer.loading = false;
    if (result.kind === 'ok' && result.draft) {
      if (buffer.edits !== buffer.savedEdits && result.definitionRevision !== buffer.revision) {
        buffer.conflict = result;
        buffer.error = 'This routine changed in another window. Your edits are preserved.';
      } else if (buffer.edits === buffer.savedEdits) {
        buffer.draft = result.draft;
        buffer.revision = result.definitionRevision ?? buffer.revision;
        buffer.savedEdits = buffer.edits;
        buffer.error = result.reason;
      }
    } else buffer.error = result.reason ?? 'Could not load this routine.';
    if (buffer.pendingEnabled !== undefined && !buffer.conflict) {
      const enabled = buffer.pendingEnabled;
      buffer.pendingEnabled = undefined;
      setEnabled(buffer, enabled);
    }
  } else if (message.action === 'saveRoutine' || message.action === 'setRoutineEnabled') {
    const saving = buffer.saving;
    if (saving?.operationId !== message.operationId) return;
    buffer.saving = undefined;
    if (result.kind === 'ok') {
      buffer.revision = result.definitionRevision ?? buffer.revision;
      buffer.savedEdits = saving.edits;
      buffer.error = undefined;
      if (message.action === 'setRoutineEnabled' && result.draft && buffer.edits === saving.edits)
        buffer.draft = result.draft;
      if (buffer.edits > saving.edits) flush(buffer);
    } else {
      buffer.error = result.reason ?? 'Could not save. Your edits are preserved.';
      buffer.pendingRun = undefined;
      if (result.kind === 'conflict') buffer.conflict = result;
    }
  } else if (message.action === 'runRoutine') {
    buffer.pendingRun = undefined;
    if (result.kind !== 'ok') buffer.runError = result.reason ?? 'The run could not be started.';
  } else if (result.kind !== 'ok') {
    buffer.error = result.reason ?? 'The action could not be completed.';
  } else if (message.action === 'deleteRoutine') clear(buffer);
  changed();
  reconcileRuns();
  if (message.action === 'runRoutine' && result.kind !== 'ok') runFailed(buffer.id);
}
