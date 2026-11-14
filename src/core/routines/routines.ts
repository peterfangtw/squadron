import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as files from '../files';
import * as paths from '../paths';
import * as incoming from '../incoming';
import * as claim from '../coordination/owner_claim';
import * as store from './store';
import * as schedule from './schedule';
import * as modelNames from '../model_names';
import * as modelListing from '../model_listing';
import type * as bridge from '../bridge/model';
import type * as model from '../model';
import type * as scan from '../scan';
import type * as types from './types';

export { resolveScope, restoreTask, stateFile as routineEvidencePath } from './store';

type DefinitionAction = { id?: string; expectedDefinitionRevision: number | null } & (
  | { kind: 'save'; draft: types.Draft }
  | { kind: 'duplicate' | 'delete' }
  | { kind: 'setEnabled'; enabled: boolean }
  | { kind: 'skip'; occurrenceKey: string }
  | {
      kind: 'reserve';
      runId: string;
      occurrenceKey: string;
      target: model.LaunchTarget;
      owner: bridge.HostIdentity;
    }
);
type RunAction = { runId: string } & (
  | { kind: 'spawning' | 'admitPrompt' | 'recordStart'; owner: bridge.HostIdentity }
  | { kind: 'recordChild'; owner: bridge.HostIdentity; child: types.Member }
  | {
      kind: 'bind';
      owner: bridge.HostIdentity;
      receiver: bridge.ReceiverIdentity;
      sessionId: string;
    }
  | { kind: 'recordStopped'; owner: bridge.HostIdentity; reason: string; noChild?: boolean }
  | { kind: 'done'; receiver: bridge.ReceiverIdentity; note?: string }
  | { kind: 'beginObservation'; writer: types.Member; tenure: string; table?: scan.ProcessTable }
  | {
      kind: 'rememberMembers';
      writer: types.Member;
      tenure: string;
      generation: number;
      members: readonly types.Member[];
      table: scan.ProcessTable;
      coverage: 'observed' | 'limited';
    }
  | { kind: 'confirmCleanup'; writer: types.Member; tenure: string; generation: number }
  | { kind: 'recordUnprovable'; writer: types.Member; reason: string }
);
export type Action = (DefinitionAction | RunAction) & { operationId: string };

export function routineTarget(
  choice: types.TargetChoice,
  models: readonly modelNames.Model[],
  defaults: { model: string; window?: number; efforts: Record<string, string> }
): model.LaunchTarget {
  const target =
    choice.kind === 'explicit'
      ? choice.target
      : (modelNames.defaultPick(models, defaults.model, defaults.window, defaults.efforts) ?? {});
  if (choice.kind === 'default') {
    if ((defaults.model || defaults.window !== undefined) && !target.model)
      throw new Error('The configured default model is unavailable. Update it before running.');
    if (defaults.model && defaults.window !== undefined && target.window !== defaults.window)
      throw new Error('The configured default context is unavailable. Update it before running.');
    const effort = target.model === undefined ? undefined : defaults.efforts[target.model];
    if (effort !== undefined && target.effort !== effort)
      throw new Error('The configured default effort is unavailable. Update it before running.');
  }
  if (
    !target.model &&
    !target.brand &&
    target.window === undefined &&
    target.effort === undefined &&
    !models.length
  )
    return {};
  const listing = models.map((row) => ({
    brand: row.brand,
    model: row.value,
    name: row.name,
    context: row.window,
    efforts: row.efforts,
    defaultEffort: row.defaultEffort
  }));
  if (!modelListing.catalogTarget({ brands: [], models: listing }, target))
    throw new Error(
      'The saved model, context or effort is unavailable. Choose another in the task input.'
    );
  return { ...target };
}

export async function readRoutineSnapshot(scope: types.Scope): Promise<types.Result> {
  try {
    return { kind: 'ok', snapshot: { scope, repository: await store.read(scope) } };
  } catch (error) {
    return { kind: 'unavailable', reason: String(error) };
  }
}

export async function applyRoutineAction(
  scope: types.Scope,
  action: Action,
  now: number
): Promise<types.Result> {
  if (!store.UUID.test(action.operationId) || !Number.isFinite(now))
    return failure('invalid', 'Invalid routine operation.');
  return store.mutate(scope, async (record) => {
    const ok = (definition?: types.Definition, attempt?: types.Attempt): types.Result => ({
      kind: 'ok',
      snapshot: { scope, repository: record },
      definition,
      attempt
    });
    if ('expectedDefinitionRevision' in action) {
      const existing = action.id === undefined ? undefined : record.routines[action.id];
      if (action.kind === 'reserve' && store.UUID.test(action.runId)) {
        const prior = record.attempts[action.runId];
        if (prior)
          return prior.routineId === action.id
            ? ok(existing, prior)
            : failure('refused', 'That run ID belongs to another routine.');
      }
      if (action.expectedDefinitionRevision === null) {
        if (action.kind !== 'save' || existing)
          return failure('conflict', 'This routine already exists.', existing);
      } else {
        if (!existing || existing.deletedAt !== undefined)
          return failure('notFound', 'This routine was deleted.');
        if (existing.definitionRevision !== action.expectedDefinitionRevision)
          return failure(
            'conflict',
            'This routine changed in another window. Review the saved version.',
            existing
          );
      }
      if (action.kind === 'save') {
        const { draft } = action;
        if (
          !draft ||
          typeof draft.name !== 'string' ||
          !draft.name.trim() ||
          draft.name.length > 120 ||
          typeof draft.enabled !== 'boolean' ||
          !schedule.validSchedule(draft.schedule) ||
          !store.validTaskInput(draft.task)
        )
          return failure('invalid', 'Enter a name, task and valid cadence.');
        let task: types.Task;
        try {
          task = await store.saveTask(scope, draft.task);
        } catch (error) {
          return failure('invalid', String(error));
        }
        const changedSchedule =
          !existing || JSON.stringify(existing.schedule) !== JSON.stringify(draft.schedule);
        const id = existing?.id ?? action.id ?? crypto.randomUUID();
        if (!store.UUID.test(id)) return failure('invalid', 'Invalid routine ID.');
        const definition: types.Definition = {
          ...existing,
          id,
          definitionRevision: (existing?.definitionRevision ?? 0) + 1,
          name: draft.name.trim(),
          enabled: draft.enabled,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          task,
          schedule: draft.schedule,
          scheduleEpoch: changedSchedule ? crypto.randomUUID() : existing.scheduleEpoch,
          handled: existing?.handled ?? []
        };
        if (changedSchedule) delete definition.anchorAt;
        if (
          definition.schedule.kind === 'interval' &&
          definition.enabled &&
          definition.anchorAt === undefined
        )
          definition.anchorAt = now;
        record.routines[id] = definition;
        return ok(definition);
      }
      if (!existing) return failure('notFound', 'Routine not found.');
      switch (action.kind) {
        case 'duplicate': {
          const definition = structuredClone(existing);
          definition.id = crypto.randomUUID();
          definition.name = `${definition.name.slice(0, 113)} (copy)`;
          definition.enabled = false;
          definition.definitionRevision = 1;
          definition.createdAt = definition.updatedAt = now;
          definition.scheduleEpoch = crypto.randomUUID();
          definition.handled = [];
          delete definition.activeRunId;
          delete definition.anchorAt;
          record.routines[definition.id] = definition;
          return ok(definition);
        }
        case 'setEnabled':
          if (typeof action.enabled !== 'boolean')
            return failure('invalid', 'Invalid enabled state.');
          existing.enabled = action.enabled;
          existing.definitionRevision++;
          existing.updatedAt = now;
          if (
            action.enabled &&
            existing.schedule.kind === 'interval' &&
            existing.anchorAt === undefined
          )
            existing.anchorAt = now;
          return ok(existing);
        case 'delete':
          existing.deletedAt = now;
          existing.definitionRevision++;
          return ok(existing);
        case 'skip':
        case 'reserve': {
          if (existing.activeRunId)
            return {
              kind: 'busy',
              reason: 'This routine already has an outstanding run.',
              attempt: record.attempts[existing.activeRunId]
            };
          const current = schedule.occurrence(existing, now);
          if (current.key !== action.occurrenceKey)
            return failure(
              'conflict',
              'The scheduled occurrence changed. Review it before running.',
              existing
            );
          if (action.kind === 'skip') {
            if (!current.handled)
              existing.handled.push({ key: current.key, outcome: 'skipped', at: now });
            return ok(existing);
          }
          if (!store.UUID.test(action.runId) || !incoming.readHostIdentity(action.owner))
            return failure('invalid', 'Invalid run identity.');
          try {
            await store.restoreTask(scope, existing.task, true);
          } catch (error) {
            return failure('invalid', String(error));
          }
          const attempt: types.Attempt = {
            runId: action.runId,
            routineId: existing.id,
            definitionRevision: existing.definitionRevision,
            scheduleEpoch: existing.scheduleEpoch,
            occurrenceKey: current.key,
            requestedAt: now,
            cwd: scope.launchCwd,
            nativeCwd: await fs.realpath(scope.launchCwd),
            task: structuredClone(existing.task),
            target: { ...action.target },
            owner: action.owner,
            phase: 'reserved',
            members: []
          };
          if (
            !(await files.writeAtomicJson(
              path.join(paths.ROUTINE_RUNS_DIR, `${action.runId}.json`),
              {
                schema: 1,
                runId: action.runId,
                repoKey: scope.repoKey,
                repoRoot: scope.repoRoot,
                routineId: existing.id
              }
            ))
          )
            return failure('io', 'Could not record the run locator.');
          record.attempts[action.runId] = attempt;
          existing.activeRunId = attempt.runId;
          return ok(existing, attempt);
        }
      }
    }
    if (!store.UUID.test(action.runId)) return failure('invalid', 'Invalid run ID.');
    const attempt = record.attempts[action.runId];
    const definition = attempt && record.routines[attempt.routineId];
    if (!attempt || !definition) return failure('notFound', 'No associated routine run was found.');
    if ('owner' in action && !incoming.sameHost(attempt.owner, action.owner))
      return failure('refused', 'This window does not own that run.');
    const settle = (): void => {
      if (definition.activeRunId === attempt.runId) delete definition.activeRunId;
    };
    switch (action.kind) {
      case 'spawning':
        if (attempt.phase !== 'reserved')
          return failure('refused', 'The attempt is no longer reserved.');
        attempt.phase = 'spawning';
        break;
      case 'recordChild':
        // The start and its cleanup can both record the one captured root.
        if (attempt.child && sameMember(attempt.child, action.child))
          return ok(definition, attempt);
        if (attempt.phase !== 'spawning' || !store.validMember(action.child))
          return failure('refused', 'The child cannot be recorded in this phase.');
        if (
          attempt.members.some(
            (member) => member.pid === action.child.pid && !sameMember(member, action.child)
          )
        )
          return failure('refused', 'The established child identity changed.');
        attempt.child = action.child;
        attempt.members = union(attempt.members, [action.child]);
        attempt.phase = 'child';
        break;
      case 'bind':
        if (
          attempt.phase !== 'child' ||
          !attempt.child ||
          !incoming.readReceiverIdentity(action.receiver) ||
          !incoming.sameHost(attempt.owner, action.receiver.host) ||
          action.receiver.pid !== attempt.child.pid ||
          action.receiver.osStartedAt !== attempt.child.startedAt ||
          action.receiver.startSource !== attempt.child.startSource ||
          action.receiver.cwd !== attempt.nativeCwd ||
          !action.sessionId
        )
          return failure('refused', 'The receiver does not match the established native child.');
        attempt.receiver = action.receiver;
        attempt.sessionId = action.sessionId;
        attempt.phase = 'bound';
        break;
      case 'admitPrompt':
        if (attempt.phase !== 'bound' || !attempt.receiver)
          return failure('refused', 'The routine has no bound receiver.');
        attempt.phase = 'admitted';
        attempt.promptAdmittedAt = now;
        break;
      case 'recordStart':
        if (attempt.phase === 'done') return ok(definition, attempt);
        if (attempt.phase !== 'admitted') return failure('refused', 'The prompt was not admitted.');
        attempt.phase = 'started';
        break;
      case 'recordStopped': {
        if (attempt.phase === 'done') return ok(definition, attempt);
        // A durable observation begins only once a native child exists, so its
        // presence turns "no child" from a fact into a guess.
        const childless =
          action.noChild === true &&
          ['reserved', 'spawning'].includes(attempt.phase) &&
          !attempt.child &&
          attempt.members.length === 0 &&
          !attempt.observation &&
          !attempt.cleanupUnprovable;
        if (!attempt.cleanupConfirmed && !childless)
          return failure('refused', 'Cleanup is unconfirmed; the reservation remains held.');
        if (childless) attempt.cleanupConfirmed = true;
        attempt.phase = 'stopped';
        attempt.reason = action.reason;
        settle();
        break;
      }
      case 'done':
        if (
          !attempt.receiver ||
          !incoming.sameReceiver(attempt.receiver, action.receiver) ||
          (action.note !== undefined &&
            (typeof action.note !== 'string' || action.note.length > 200))
        )
          return failure('refused', 'Only the associated routine session can mark this run done.');
        if (attempt.phase === 'done') return ok(definition, attempt);
        if (
          !['admitted', 'started'].includes(attempt.phase) ||
          definition.activeRunId !== attempt.runId
        )
          return failure('refused', 'This is not the current admitted attempt.');
        attempt.phase = 'done';
        attempt.doneAt = now;
        attempt.note = action.note;
        if (!definition.handled.some((item) => item.key === attempt.occurrenceKey))
          definition.handled.push({
            key: attempt.occurrenceKey,
            outcome: 'completed',
            at: now,
            runId: attempt.runId
          });
        settle();
        break;
      case 'beginObservation': {
        if (
          !store.validMember(action.writer) ||
          !store.UUID.test(action.tenure) ||
          attempt.cleanupConfirmed
        )
          return failure('refused', 'Invalid cleanup writer.');
        const prior = attempt.observation;
        const owns =
          prior && sameMember(prior.writer, action.writer) && prior.tenure === action.tenure;
        const launchWriter =
          action.writer.pid === attempt.owner.pid &&
          action.writer.startedAt === attempt.owner.osStartedAt &&
          action.writer.startSource === attempt.owner.startSource;
        if (prior?.pending && !owns)
          return failure('busy', 'An unfinished observation retains cleanup ownership.');
        if (!owns && !launchWriter) {
          if (
            !attempt.child ||
            !action.table ||
            claim.judge(action.table, hostMember(attempt.owner)) !== 'gone' ||
            (prior && claim.judge(action.table, prior.writer) !== 'gone')
          )
            return failure('busy', 'Another live or unknown writer owns cleanup.');
        }
        if (prior && !owns && launchWriter)
          return failure('refused', 'The launch writer no longer owns this cleanup tenure.');
        if (owns && prior.pending) return ok(definition, attempt);
        attempt.observation = {
          generation: (prior?.generation ?? 0) + 1,
          writer: action.writer,
          tenure: action.tenure,
          pending: true,
          coverage: prior?.coverage ?? 'observed',
          absent: false
        };
        break;
      }
      case 'rememberMembers': {
        const observation = attempt.observation;
        if (
          !observation ||
          !observation.pending ||
          observation.generation !== action.generation ||
          observation.tenure !== action.tenure ||
          !sameMember(observation.writer, action.writer) ||
          !action.members.every(store.validMember)
        )
          return failure('refused', 'This observation no longer owns the run.');
        attempt.members = union(attempt.members, action.members);
        observation.coverage = action.coverage === 'limited' ? 'limited' : observation.coverage;
        observation.absent =
          !!attempt.child &&
          union(attempt.members, [attempt.child]).every(
            (member) => claim.judge(action.table, member) === 'gone'
          );
        observation.pending = false;
        break;
      }
      case 'confirmCleanup': {
        if (attempt.cleanupConfirmed) return ok(definition, attempt);
        const observation = attempt.observation;
        if (
          !observation ||
          observation.pending ||
          !observation.absent ||
          observation.generation !== action.generation ||
          observation.tenure !== action.tenure ||
          !sameMember(observation.writer, action.writer)
        )
          return failure('refused', 'Complete committed cleanup evidence is required.');
        attempt.cleanupConfirmed = true;
        delete attempt.cleanupUnprovable;
        if (attempt.phase !== 'done') {
          attempt.phase = 'stopped';
          attempt.reason = 'The session ended without reporting completion.';
          settle();
        }
        break;
      }
      case 'recordUnprovable': {
        // Diagnostic only: the reservation and its unresolved ownership stay.
        if (attempt.cleanupUnprovable) return ok(definition, attempt);
        if (
          !store.validMember(action.writer) ||
          !sameMember(action.writer, hostMember(attempt.owner)) ||
          typeof action.reason !== 'string' ||
          !action.reason ||
          action.reason.length > 300 ||
          attempt.phase !== 'spawning' ||
          attempt.child ||
          attempt.members.length ||
          attempt.cleanupConfirmed
        )
          return failure('refused', 'Only the launch writer can report an unidentified exit.');
        attempt.cleanupUnprovable = true;
        attempt.reason = action.reason;
        break;
      }
    }
    return ok(definition, attempt);
  });
}

export async function resolveRoutineRun(
  runId: string
): Promise<{ scope: types.Scope; attempt: types.Attempt } | undefined> {
  if (!store.UUID.test(runId)) return undefined;
  const locator: unknown = JSON.parse(
    await fs.readFile(path.join(paths.ROUTINE_RUNS_DIR, `${runId}.json`), 'utf8')
  );
  if (!locator || typeof locator !== 'object') throw new Error('Invalid routine locator.');
  const value = locator as Record<string, unknown>;
  if (
    value.schema !== 1 ||
    value.runId !== runId ||
    typeof value.repoRoot !== 'string' ||
    typeof value.repoKey !== 'string' ||
    typeof value.routineId !== 'string'
  )
    throw new Error('Invalid routine locator.');
  const scope = { repoRoot: value.repoRoot, repoKey: value.repoKey, launchCwd: value.repoRoot };
  const repository = await store.read(scope);
  const attempt = repository.attempts[runId];
  if (!attempt || attempt.routineId !== value.routineId) return undefined;
  return { scope: { ...scope, launchCwd: attempt.cwd }, attempt };
}

export function hostMember(host: bridge.HostIdentity): types.Member {
  return { pid: host.pid, startedAt: host.osStartedAt, startSource: host.startSource };
}

export function sameMember(a: types.Member, b: types.Member): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.startSource === b.startSource;
}

function union(a: readonly types.Member[], b: readonly types.Member[]): types.Member[] {
  const members = new Map(
    a.map((member) => [`${member.startSource}/${member.pid}/${member.startedAt}`, member])
  );
  for (const member of b)
    members.set(`${member.startSource}/${member.pid}/${member.startedAt}`, member);
  return [...members.values()];
}

function failure(
  kind: types.Failure['kind'],
  reason: string,
  definition?: types.Definition
): types.Failure {
  return { kind, reason, definition };
}
