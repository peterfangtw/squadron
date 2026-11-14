import * as crypto from 'node:crypto';
import * as routines from './routines';
import * as workflows from '../workflows/workflows';
import * as compose from '../../ui/compose_doc';
import * as composeImages from '../compose_images';
import * as paths from '../paths';
import type * as types from './types';
import type * as model from '../model';
import type * as modelNames from '../model_names';
import type * as bridge from '../bridge/model';
import type * as startup from '../startup';
import type * as commands from '../platform/commands';

export type Request = {
  operationId: string;
  id: string;
  expectedDefinitionRevision: number;
  runId: string;
  occurrenceKey: string;
};
export type Launch = {
  cwd: string;
  target: model.LaunchTarget;
  prompt: string;
  images: model.ImageBlock[];
  workflow?: workflows.ReadWorkflow;
  name: string;
  attemptId: string;
  routine: {
    scope: types.Scope;
    runId: string;
    owner: bridge.HostIdentity;
    validateTarget(): void;
  };
};
export type Ports = {
  models(): readonly modelNames.Model[];
  defaults: { model: string; window?: number; efforts: Record<string, string> };
  owner(): Promise<bridge.HostIdentity | undefined>;
  launch(options: Launch): Promise<startup.StartOutcome>;
};
export type Result =
  { kind: 'ok'; id: string; session: Extract<startup.StartOutcome, { ok: true }> } | types.Failure;

export async function start(scope: types.Scope, request: Request, ports: Ports): Promise<Result> {
  const snapshot = await routines.readRoutineSnapshot(scope);
  if (snapshot.kind !== 'ok') return snapshot;
  const definition = snapshot.snapshot.repository.routines[request.id];
  if (!definition || definition.deletedAt !== undefined)
    return { kind: 'notFound', reason: 'This routine was deleted.' };
  let task: types.TaskInput;
  let target: model.LaunchTarget;
  let workflow: workflows.ReadWorkflow | undefined;
  let owner: bridge.HostIdentity | undefined;
  const validateTarget = (): void => {
    // No override is a captured account default, independent of a later catalog.
    if (!Object.keys(target).length) return;
    routines.routineTarget({ kind: 'explicit', target }, ports.models(), {
      model: '',
      efforts: {}
    });
  };
  try {
    task = await routines.restoreTask(scope, definition.task, true);
    target = routines.routineTarget(task.targetChoice, ports.models(), ports.defaults);
    if (task.workflowId) {
      const armed = await workflows.armWorkflow(task.workflowId, scope.launchCwd, target.brand);
      if ('refused' in armed) return { kind: 'invalid', reason: armed.refused };
      workflow = armed.workflow;
    }
    owner = await ports.owner();
    validateTarget();
  } catch (error) {
    return { kind: 'invalid', reason: String(error) };
  }
  if (!owner) return { kind: 'unavailable', reason: 'Native host identity is unavailable.' };
  const reserved = await routines.applyRoutineAction(
    scope,
    {
      ...request,
      kind: 'reserve',
      target,
      owner
    },
    Date.now()
  );
  if (reserved.kind !== 'ok') return reserved;
  if (!reserved.attempt || reserved.attempt.phase !== 'reserved')
    return { kind: 'busy', reason: 'This run is already starting or outstanding.' };
  let result: startup.StartOutcome;
  try {
    result = await ports.launch({
      cwd: scope.launchCwd,
      target,
      prompt: task.delivered,
      images: composeImages.imageBlocks(compose.capture(task.doc, task.attachments).images),
      workflow,
      name: definition.name,
      attemptId: request.runId,
      routine: { scope, runId: request.runId, owner, validateTarget }
    });
  } catch (error) {
    result = { ok: false, outcome: 'unknown', reason: String(error) };
  }
  if (result.ok) return { kind: 'ok', id: definition.id, session: result };
  await routines.applyRoutineAction(
    scope,
    {
      kind: 'recordStopped',
      operationId: crypto.randomUUID(),
      runId: request.runId,
      owner,
      noChild: result.outcome === 'stopped',
      reason: result.reason
    },
    Date.now()
  );
  return { kind: 'refused', reason: result.reason };
}

export function completionInstruction(runId: string, shell: commands.Shell): string {
  return `\n\nThis is a routine run. Only after judging the requested work finished, mark this exact run done with:\n${paths.verbCommand(shell, 'squadron-routine', 'done', '--run-id', runId)}\nA normal turn, idle status or completed workflow does not complete this routine. If the command is refused, report why; never claim completion on its behalf.`;
}
