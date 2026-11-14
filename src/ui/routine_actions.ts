import type * as routines from '../core/routines/routines';

const KINDS = {
  openRoutine: null,
  saveRoutine: 'save',
  duplicateRoutine: 'duplicate',
  deleteRoutine: 'delete',
  setRoutineEnabled: 'setEnabled',
  skipRoutine: 'skip',
  runRoutine: 'reserve',
  openRoutineSession: null,
  recheckRoutine: null
} as const satisfies Record<RoutineWebviewMessage['type'], routines.Action['kind'] | null>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAction(message: WebviewMessage): message is RoutineWebviewMessage {
  return Object.hasOwn(KINDS, message.type);
}

export function matchesScope(message: RoutineWebviewMessage, scope: RoutineScopeToken): boolean {
  return (
    message.scope?.repoKey === scope.repoKey &&
    message.scope.launchCwd === scope.launchCwd &&
    UUID.test(message.operationId)
  );
}

export function mutation(message: RoutineWebviewMessage): routines.Action | undefined {
  if (!('expectedDefinitionRevision' in message)) return undefined;
  const kind = KINDS[message.type];
  const base = {
    operationId: message.operationId,
    id: message.id,
    expectedDefinitionRevision: message.expectedDefinitionRevision
  };
  switch (kind) {
    case 'save':
      return message.type === 'saveRoutine' ? { ...base, kind, draft: message.draft } : undefined;
    case 'setEnabled':
      return message.type === 'setRoutineEnabled'
        ? { ...base, kind, enabled: message.enabled }
        : undefined;
    case 'skip':
      return message.type === 'skipRoutine'
        ? { ...base, kind, occurrenceKey: message.occurrenceKey }
        : undefined;
    case 'duplicate':
    case 'delete':
      return { ...base, kind };
    default:
      return undefined;
  }
}
