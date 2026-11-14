import * as path from 'node:path';
import * as vscode from 'vscode';
import * as domain from '../core/routines/routines';
import * as lifetime from '../core/routines/lifetime';
import * as schedules from '../core/routines/schedule';
import * as compose from '../ui/compose_doc';
import * as modelNames from '../core/model_names';
import * as incoming from '../core/incoming';
import * as scan from '../core/scan';
import * as ownerClaim from '../core/coordination/owner_claim';
import * as views from '../ui/routine_view';
import * as routineActions from '../ui/routine_actions';
import * as routineStart from '../core/routines/start';
import * as sessions from './sessions';
import * as opening from './session_open';
import * as watch from './watch';
import type * as reconcile from '../core/reconcile';
import type * as panel from './panel_actions';
import type * as types from '../core/routines/types';
import type * as model from '../core/model';

let registration: reconcile.CheckRegistration | undefined;
let recovery: lifetime.RoutineRecovery | undefined;
let refresh: (() => void) | undefined;
let scopePromise: { cwd: string; value: Promise<types.Scope> } | undefined;

async function scope(): Promise<types.Scope> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) throw new Error('Open a project folder to configure routines.');
  if (scopePromise?.cwd !== cwd) {
    const value = domain.resolveScope(cwd);
    scopePromise = { cwd, value };
    void value.catch(() => {
      if (scopePromise?.value === value) scopePromise = undefined;
    });
  }
  return scopePromise.value;
}

export function activate(reconciler: reconcile.Reconciler, changed: () => void): vscode.Disposable {
  recovery = new lifetime.RoutineRecovery();
  refresh = changed;
  let lastState: string | undefined;
  const publishChange = (state: string): void => {
    if (state === lastState) return;
    lastState = state;
    changed();
  };
  registration = reconciler.register('routines', 500, async () => {
    try {
      const context = await scope();
      const snapshot = await domain.readRoutineSnapshot(context);
      if (snapshot.kind !== 'ok') throw new Error(snapshot.reason);
      const access = await sessions.ownedHostIdentity();
      const recoveryAt = access
        ? await recovery?.reconcile(context, Date.now(), access.host)
        : undefined;
      const times = Object.values(snapshot.snapshot.repository.routines).flatMap((definition) => {
        if (!definition.enabled || definition.deletedAt !== undefined) return [];
        const next = schedules.occurrence(definition, Date.now()).nextDueAt;
        return next === undefined ? [] : [next];
      });
      if (recoveryAt !== undefined) times.push(recoveryAt);
      registration?.schedule(times.length ? Math.min(...times) : undefined);
      publishChange(
        JSON.stringify([
          context.repoKey,
          context.launchCwd,
          snapshot.snapshot.repository.revision,
          views.routineRows(snapshot.snapshot, Date.now(), local)
        ])
      );
    } catch (error) {
      registration?.schedule(undefined);
      publishChange(String(error));
    }
  });
  const disk = watch.onSessionState((change) => {
    if (change === 'watch') registration?.noticeChange();
  });
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    scopePromise = undefined;
    registration?.requestCheck();
  });
  registration.requestCheck();
  return {
    dispose: () => {
      disk();
      folders.dispose();
      recovery?.dispose();
      registration?.dispose();
      registration = undefined;
      refresh = undefined;
    }
  };
}

function local(attempt: types.Attempt): 'busy' | 'idle' | undefined {
  const receiver = attempt.receiver;
  if (!receiver || receiver.host.windowId !== vscode.env.sessionId) return undefined;
  const current = sessions.ownedIncomingSnapshot(receiver.pid)?.receiverIdentity;
  const session = sessions.ownedSession(receiver.pid);
  if (!current || !incoming.sameReceiver(current, receiver) || !session || session.state.exit)
    return undefined;
  return session.state.running ? 'busy' : 'idle';
}

export async function snapshot(
  claims: readonly model.WindowClaim[] = []
): Promise<RoutineScopeView> {
  try {
    const context = await scope();
    const result = await domain.readRoutineSnapshot(context);
    if (result.kind !== 'ok') return { kind: 'unavailable', reason: result.reason };
    const { repository } = result.snapshot;
    const hasForeign = Object.values(repository.routines).some((definition) => {
      const attempt = definition.activeRunId
        ? repository.attempts[definition.activeRunId]
        : undefined;
      return attempt?.receiver !== undefined && attempt.owner.windowId !== vscode.env.sessionId;
    });
    const table = hasForeign ? await scan.scanProcesses() : undefined;
    const presence = (attempt: types.Attempt): views.RunPresence | undefined => {
      const here = local(attempt);
      if (here) return here;
      if (
        !attempt.receiver ||
        attempt.owner.windowId === vscode.env.sessionId ||
        !table ||
        ownerClaim.judge(table, domain.hostMember(attempt.owner)) !== 'live'
      )
        return undefined;
      return {
        kind: 'foreign',
        label: claims.find((claim) => claim.id === attempt.owner.windowId)?.label
      };
    };
    return {
      kind: 'ready',
      scope: { repoKey: context.repoKey, launchCwd: context.launchCwd },
      repoRoot: context.repoRoot,
      label: path.basename(context.repoRoot),
      revision: result.snapshot.repository.revision,
      rows: views.routineRows(result.snapshot, Date.now(), presence).map((row) =>
        row.runId && row.sessionAction === 'unavailable'
          ? {
              ...row,
              reason: `${row.reason ?? 'Startup or cleanup is not yet confirmed.'} Inspect ${domain.routineEvidencePath(context)}`
            }
          : row
      )
    };
  } catch (error) {
    return { kind: 'unavailable', reason: String(error) };
  }
}

export async function act(host: panel.PanelActions, message: RoutineWebviewMessage): Promise<void> {
  let result: RoutineReply['result'];
  try {
    result = await perform(host, message);
  } catch (error) {
    result = { kind: 'io', reason: String(error) };
  }
  host.post({
    type: message.type === 'openRoutine' ? 'routineLoaded' : 'routineActionResult',
    operationId: message.operationId,
    action: message.type,
    result
  });
  registration?.noticeChange();
  refresh?.();
}

async function perform(
  host: panel.PanelActions,
  message: RoutineWebviewMessage
): Promise<RoutineReply['result']> {
  const context = await scope();
  if (!routineActions.matchesScope(message, context))
    return { kind: 'conflict', reason: 'The opened project changed. Reopen this routine.' };
  if (message.type === 'runRoutine') {
    const result = await routineStart.start(context, message, {
      models: () => host.models,
      defaults: defaults(),
      owner: async () => (await sessions.ownedHostIdentity())?.host,
      launch: (options) => sessions.startOwned(options)
    });
    if (result.kind !== 'ok') return reply(result);
    if (!host.disposed) opening.revealSession(host, result.session.pid, result.session.startedAt);
    return { kind: 'ok', id: result.id };
  }
  const snapshot = await domain.readRoutineSnapshot(context);
  if (snapshot.kind !== 'ok') return snapshot;
  const definition = message.id ? snapshot.snapshot.repository.routines[message.id] : undefined;
  if (message.type === 'openRoutine') {
    if (!definition || definition.deletedAt !== undefined)
      return { kind: 'notFound', reason: 'This routine was deleted.' };
    return loaded(context, definition);
  }
  if (message.type === 'recheckRoutine' || message.type === 'openRoutineSession') {
    const attempt = snapshot.snapshot.repository.attempts[message.runId];
    if (!attempt || attempt.routineId !== message.id || definition?.activeRunId !== attempt.runId)
      return { kind: 'refused', reason: 'That run is no longer active.' };
    if (message.type === 'recheckRoutine') {
      registration?.requestCheck();
      return { kind: 'ok' };
    }
    if (!local(attempt) || !attempt.receiver)
      return { kind: 'refused', reason: 'Open this session in its own IDE window.' };
    const session = host.sessions.find((value) => value.pid === attempt.receiver?.pid);
    if (!session)
      return { kind: 'refused', reason: 'The session is no longer available in this window.' };
    opening.revealSession(host, session.pid, session.startedAt);
    return { kind: 'ok' };
  }
  const action = routineActions.mutation(message);
  if (!action) return { kind: 'invalid', reason: 'Unknown routine action.' };
  const result = await domain.applyRoutineAction(context, action, Date.now());
  if (result.kind === 'ok' && result.definition && message.type !== 'deleteRoutine')
    return loaded(context, result.definition);
  if (result.kind === 'conflict' && result.definition)
    return {
      ...(await loaded(context, result.definition)),
      kind: 'conflict',
      reason: result.reason
    };
  return reply(result);
}

async function loaded(
  context: types.Scope,
  definition: types.Definition
): Promise<RoutineReply['result']> {
  const task = await domain.restoreTask(context, definition.task, false, true);
  const reason =
    compose.attachmentIds(task.doc).size !== Object.keys(task.attachments).length
      ? 'Some saved images are unavailable. Paste them again or remove their chips before saving or running.'
      : undefined;
  return {
    kind: 'ok',
    id: definition.id,
    definitionRevision: definition.definitionRevision,
    reason,
    draft: {
      name: definition.name,
      enabled: definition.enabled,
      schedule: definition.schedule,
      task
    }
  };
}

function reply(result: types.Result): RoutineReply['result'] {
  return result.kind === 'ok'
    ? {
        kind: 'ok',
        id: result.definition?.id,
        definitionRevision: result.definition?.definitionRevision
      }
    : { kind: result.kind, reason: result.reason };
}

function defaults(): routineStart.Ports['defaults'] {
  const config = vscode.workspace.getConfiguration('squadron');
  return {
    model: config.get<string>('model', '').trim(),
    window: config.get<number>('contextWindow'),
    efforts: modelNames.modelEfforts(config.get<unknown>('efforts'))
  };
}
