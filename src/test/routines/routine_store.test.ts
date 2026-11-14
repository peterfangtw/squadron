import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { before, after, it } from 'node:test';
import * as homeFixture from '../home';
import { linkDir } from '../helpers';
import type * as types from '../../core/routines/types';
import type * as bridge from '../../core/bridge/model';

let home: string;
let routines: typeof import('../../core/routines/routines');
let paths: typeof import('../../core/paths');
before(async () => {
  home = await homeFixture.tempHome();
  routines = await import('../../core/routines/routines');
  paths = await import('../../core/paths');
});
after(() => homeFixture.disposeHome(home));

it('shares admission across a symlinked main checkout and its detected worktree', async () => {
  const { scope, definition, owner } = await setup();
  const main = scope.launchCwd;
  const alias = path.join(home, crypto.randomUUID());
  const tree = path.join(home, crypto.randomUUID());
  const admin = path.join(main, '.git', 'worktrees', 'side');
  await fs.mkdir(admin, { recursive: true });
  await fs.writeFile(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.mkdir(tree);
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${admin}\n`);
  await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
  await fs.writeFile(path.join(admin, 'gitdir'), path.join(tree, '.git'));
  await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/side\n');
  await linkDir(main, alias);
  const aliases = await Promise.all([routines.resolveScope(alias), routines.resolveScope(tree)]);
  assert.equal(aliases[0]?.repoKey, scope.repoKey);
  assert.equal(aliases[1]?.repoKey, scope.repoKey);
  const outcomes = await Promise.all(aliases.map((context) => reserve(context, definition, owner)));
  assert.deepEqual(outcomes.map((result) => result.kind).sort(), ['busy', 'ok']);
  const accepted = outcomes.find((result) => result.kind === 'ok');
  assert.ok(accepted?.kind === 'ok' && accepted.attempt);
  assert.ok([alias, tree].includes(accepted.attempt.cwd));
});

it('resolves current defaults at run time and refuses unavailable explicit contexts and efforts', () => {
  const models: import('../../core/model_names').Model[] = [
    {
      brand: 'codex',
      id: 'test-a',
      value: 'test-a',
      name: 'Model A',
      window: 200000,
      efforts: [{ value: 'low' }, { value: 'high' }],
      defaultEffort: 'low'
    },
    {
      brand: 'codex',
      id: 'test-b',
      value: 'test-b',
      name: 'Model B',
      efforts: [{ value: 'low' }],
      defaultEffort: 'low'
    }
  ];
  const defaults = { model: 'test-a', window: 200000, efforts: { 'test-a': 'high' } };
  const first = routines.routineTarget({ kind: 'default' }, models, defaults);
  assert.equal(first.model, 'test-a');
  assert.equal(first.effort, 'high');
  const later = routines.routineTarget({ kind: 'default' }, models, {
    model: 'test-b',
    efforts: {}
  });
  assert.equal(later.model, 'test-b');
  assert.equal(first.model, 'test-a');
  assert.throws(
    () =>
      routines.routineTarget(
        { kind: 'explicit', target: { ...first, window: 999999 } },
        models,
        defaults
      ),
    /unavailable/
  );
  assert.throws(
    () =>
      routines.routineTarget({ kind: 'default' }, models, {
        ...defaults,
        efforts: { 'test-a': 'unsupported' }
      }),
    /effort is unavailable/
  );
  assert.throws(
    () => routines.routineTarget({ kind: 'default' }, models, { ...defaults, window: 999999 }),
    /context is unavailable/
  );
  assert.deepEqual(routines.routineTarget({ kind: 'default' }, [], { model: '', efforts: {} }), {});
});

async function setup(): Promise<{
  scope: types.Scope;
  definition: types.Definition;
  owner: bridge.HostIdentity;
}> {
  const cwd = path.join(home, crypto.randomUUID());
  await fs.mkdir(cwd);
  const scope = await routines.resolveScope(cwd);
  const result = await routines.applyRoutineAction(
    scope,
    {
      kind: 'save',
      operationId: crypto.randomUUID(),
      expectedDefinitionRevision: null,
      draft: {
        name: 'Review dependencies',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        task: {
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Review the dependencies' }] }
            ]
          },
          delivered: 'Review the dependencies',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: cwd
        }
      }
    },
    new Date(2026, 10, 14, 10).getTime()
  );
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  if (result.kind !== 'ok' || !result.definition) throw new Error('Save failed');
  return {
    scope,
    definition: result.definition,
    owner: {
      version: 1,
      windowId: crypto.randomUUID(),
      pid: process.pid,
      osStartedAt: 1,
      startSource: 'ps-lstart-v1',
      incarnation: crypto.randomUUID()
    }
  };
}

async function reserve(
  scope: types.Scope,
  definition: types.Definition,
  owner: bridge.HostIdentity,
  runId = crypto.randomUUID()
): Promise<types.Result> {
  return routines.applyRoutineAction(
    scope,
    {
      kind: 'reserve',
      id: definition.id,
      expectedDefinitionRevision: definition.definitionRevision,
      operationId: crypto.randomUUID(),
      runId,
      occurrenceKey: `${definition.scheduleEpoch}/day/2026-11-14`,
      owner,
      target: {}
    },
    new Date(2026, 10, 14, 10).getTime()
  );
}

it('serializes competing starts through real files and keeps unknown spawning reserved', async () => {
  const { scope, definition, owner } = await setup();
  const outcomes = await Promise.all([
    reserve(scope, definition, owner),
    reserve(scope, definition, owner)
  ]);
  assert.deepEqual(outcomes.map((result) => result.kind).sort(), ['busy', 'ok']);
  const accepted = outcomes.find((result) => result.kind === 'ok');
  assert.ok(accepted?.kind === 'ok' && accepted.attempt);
  const runId = accepted.attempt.runId;
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        { kind: 'spawning', operationId: crypto.randomUUID(), runId, owner },
        Date.now()
      )
    ).kind,
    'ok'
  );
  assert.equal((await reserve(scope, definition, owner)).kind, 'busy');
  const located = await routines.resolveRoutineRun(runId);
  assert.equal(located?.attempt.phase, 'spawning');
});

it('keeps done authoritative when it races recordStart and cannot clear a newer run', async () => {
  const { scope, definition, owner } = await setup();
  const reserved = await reserve(scope, definition, owner);
  assert.ok(reserved.kind === 'ok' && reserved.attempt);
  const runId = reserved.attempt.runId;
  const receiver: bridge.ReceiverIdentity = {
    version: 1,
    host: owner,
    pid: 4242,
    osStartedAt: 10,
    startSource: 'ps-lstart-v1',
    incarnation: crypto.randomUUID(),
    brand: 'codex',
    cwd: scope.launchCwd
  };
  const apply = (action: {
    kind: 'spawning' | 'admitPrompt' | 'recordStart';
    runId: string;
    owner: bridge.HostIdentity;
  }): Promise<types.Result> =>
    routines.applyRoutineAction(
      scope,
      {
        ...action,
        operationId: crypto.randomUUID()
      },
      Date.now()
    );
  await apply({ kind: 'spawning', runId, owner });
  const child: types.Member = {
    pid: receiver.pid,
    startedAt: receiver.osStartedAt,
    startSource: receiver.startSource
  };
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        { kind: 'recordChild', operationId: crypto.randomUUID(), runId, owner, child },
        Date.now()
      )
    ).kind,
    'ok'
  );
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        {
          kind: 'bind',
          operationId: crypto.randomUUID(),
          runId,
          owner,
          receiver,
          sessionId: crypto.randomUUID()
        },
        Date.now()
      )
    ).kind,
    'ok'
  );
  await apply({ kind: 'admitPrompt', runId, owner });
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        {
          kind: 'done',
          operationId: crypto.randomUUID(),
          runId,
          receiver: { ...receiver, incarnation: crypto.randomUUID() }
        },
        Date.now()
      )
    ).kind,
    'refused'
  );
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        { kind: 'done', operationId: crypto.randomUUID(), runId, receiver },
        Date.now()
      )
    ).kind,
    'ok'
  );
  const late = await apply({ kind: 'recordStart', runId, owner });
  assert.ok(late.kind === 'ok' && late.attempt?.phase === 'done');
  const next = await reserve(scope, definition, owner);
  assert.ok(next.kind === 'ok' && next.attempt);
  await routines.applyRoutineAction(
    scope,
    { kind: 'done', operationId: crypto.randomUUID(), runId, receiver },
    Date.now()
  );
  const snapshot = await routines.readRoutineSnapshot(scope);
  assert.ok(snapshot.kind === 'ok');
  assert.equal(
    snapshot.snapshot.repository.routines[definition.id]?.activeRunId,
    next.attempt.runId
  );
  assert.equal(snapshot.snapshot.repository.routines[definition.id]?.handled.length, 1);
});

it('rejects stale edits and never replaces corrupt state with an empty repository', async () => {
  const { scope, definition } = await setup();
  const change = {
    kind: 'setEnabled' as const,
    operationId: crypto.randomUUID(),
    id: definition.id,
    expectedDefinitionRevision: definition.definitionRevision,
    enabled: false
  };
  assert.equal((await routines.applyRoutineAction(scope, change, Date.now())).kind, 'ok');
  assert.equal(
    (
      await routines.applyRoutineAction(
        scope,
        { ...change, operationId: crypto.randomUUID(), enabled: true },
        Date.now()
      )
    ).kind,
    'conflict'
  );
  const file = path.join(paths.ROUTINES_DIR, scope.repoKey, 'state.json');
  await fs.writeFile(file, '{broken');
  assert.equal((await routines.readRoutineSnapshot(scope)).kind, 'unavailable');
  assert.equal((await routines.applyRoutineAction(scope, change, Date.now())).kind, 'io');
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

it('persists only referenced image bytes and refuses damaged bytes on reload', async () => {
  const { scope, definition } = await setup();
  const imageDoc = {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'chip',
            attrs: { kind: 'image', expansion: '[Image #1]', attachmentId: 'image-1' }
          }
        ]
      }
    ]
  };
  const saved = await routines.applyRoutineAction(
    scope,
    {
      kind: 'save',
      operationId: crypto.randomUUID(),
      id: definition.id,
      expectedDefinitionRevision: 1,
      draft: {
        name: definition.name,
        enabled: true,
        schedule: definition.schedule,
        task: {
          doc: imageDoc,
          delivered: '[Image #1]',
          targetChoice: { kind: 'default' },
          savedFromCwd: scope.launchCwd,
          attachments: {
            'image-1': {
              kind: 'image',
              image: {
                name: 'test.png',
                mediaType: 'image/png',
                dataUrl: 'data:image/png;base64,Ynl0ZXM='
              }
            }
          }
        }
      }
    },
    Date.now()
  );
  assert.ok(saved.kind === 'ok' && saved.definition);
  const restored = await routines.restoreTask(scope, saved.definition.task);
  assert.equal(restored.attachments['image-1']?.image.dataUrl, 'data:image/png;base64,Ynl0ZXM=');
  const hash = saved.definition.task.images['image-1']?.blobHash;
  assert.ok(hash);
  await fs.writeFile(path.join(paths.ROUTINES_DIR, scope.repoKey, 'images', hash), 'corrupted');
  await assert.rejects(routines.restoreTask(scope, saved.definition.task), /damaged/);
});

it('keeps one recovery writer through both grace periods and releases only confirmed absence', async (t) => {
  const { scope, definition, owner } = await setup();
  const scan = await import('../../core/scan');
  const platform = await import('../../core/platform');
  const lifetime = await import('../../core/routines/lifetime');
  const nativeOwner = { ...owner, pid: 999999, osStartedAt: 5 };
  const result = await reserve(scope, definition, nativeOwner);
  assert.ok(result.kind === 'ok' && result.attempt);
  const runId = result.attempt.runId;
  const child: types.Member = { pid: 4242, startedAt: 10, startSource: 'ps-lstart-v1' };
  const tool: types.Member = { pid: 4343, startedAt: 11, startSource: 'ps-lstart-v1' };
  const snapshot = (members: types.Member[]): import('../../core/scan').ProcessTable => ({
    complete: true,
    startSource: 'ps-lstart-v1',
    claude: new Map(),
    codex: new Map(),
    grok: new Map(),
    shellParents: new Set(),
    groups: new Map(),
    starts: new Map([
      [process.pid, 1],
      ...members.map((member): [number, number] => [member.pid, member.startedAt])
    ]),
    parents: new Map(
      members.map((member): [number, number] => [
        member.pid,
        member.pid === tool.pid ? child.pid : 1
      ])
    )
  });
  await routines.applyRoutineAction(
    scope,
    { kind: 'spawning', operationId: crypto.randomUUID(), runId, owner: nativeOwner },
    Date.now()
  );
  await routines.applyRoutineAction(
    scope,
    { kind: 'recordChild', operationId: crypto.randomUUID(), runId, owner: nativeOwner, child },
    Date.now()
  );
  const writer = routines.hostMember(nativeOwner);
  const tenure = crypto.randomUUID();
  await routines.applyRoutineAction(
    scope,
    { kind: 'beginObservation', operationId: crypto.randomUUID(), runId, writer, tenure },
    Date.now()
  );
  await routines.applyRoutineAction(
    scope,
    {
      kind: 'rememberMembers',
      operationId: crypto.randomUUID(),
      runId,
      writer,
      tenure,
      generation: 1,
      members: [child, tool],
      table: snapshot([child, tool]),
      coverage: 'observed'
    },
    Date.now()
  );
  let visible = [child, tool];
  t.mock.method(scan, 'scanProcesses', () => Promise.resolve(snapshot(visible)));
  const signals: { pid: number; intent: string; alone?: boolean }[] = [];
  t.mock.method(
    platform.processes,
    'signal',
    (members: types.Member[], intent: string, _table: unknown, options?: { alone?: boolean }) => {
      for (const member of members)
        signals.push({ pid: member.pid, intent, alone: options?.alone });
      return members.map(() => 'sent');
    }
  );
  const first = new lifetime.RoutineRecovery();
  const competing = new lifetime.RoutineRecovery();
  t.after(() => {
    first.dispose();
    competing.dispose();
  });
  const now = Date.now();
  assert.equal(await first.reconcile(scope, now), now + 2000);
  assert.deepEqual(
    signals.map((signal) => [signal.pid, signal.intent]),
    [
      [tool.pid, 'stop'],
      [child.pid, 'stop']
    ]
  );
  await competing.reconcile(scope, now + 1000);
  assert.equal(signals.length, 2);
  assert.equal(signals[1]?.alone, true);
  await first.reconcile(scope, now + 2000);
  assert.deepEqual(signals.at(-1), { pid: tool.pid, intent: 'kill', alone: undefined });
  visible = [child];
  await competing.reconcile(scope, now + 4000);
  assert.equal(signals.length, 3);
  await first.reconcile(scope, now + 8000);
  assert.deepEqual(signals.at(-1), { pid: child.pid, intent: 'kill', alone: true });
  assert.equal((await reserve(scope, definition, nativeOwner)).kind, 'busy');
  visible = [];
  const apply = routines.applyRoutineAction;
  let failedConfirmation = false;
  t.mock.method(
    routines,
    'applyRoutineAction',
    (
      context: types.Scope,
      action: import('../../core/routines/routines').Action,
      at: number
    ): Promise<types.Result> => {
      if (action.kind === 'confirmCleanup' && !failedConfirmation) {
        failedConfirmation = true;
        return Promise.resolve({ kind: 'io', reason: 'Transient confirmation write failure' });
      }
      return apply(context, action, at);
    }
  );
  assert.equal(await first.reconcile(scope, now + 9000), now + 39000);
  assert.equal((await reserve(scope, definition, nativeOwner)).kind, 'busy');
  await competing.reconcile(scope, now + 10000);
  await first.reconcile(scope, now + 39000);
  const settled = await routines.resolveRoutineRun(runId);
  assert.equal(settled?.attempt.phase, 'stopped');
  assert.equal(settled?.attempt.cleanupConfirmed, true);
  assert.equal((await reserve(scope, definition, nativeOwner)).kind, 'ok');
});

it('retains dead-writer pending evidence instead of manufacturing cleanup from an older union', async () => {
  const { scope, definition, owner } = await setup();
  const result = await reserve(scope, definition, owner);
  assert.ok(result.kind === 'ok' && result.attempt);
  const runId = result.attempt.runId;
  const writer = routines.hostMember(owner);
  const tenure = crypto.randomUUID();
  const pending = await routines.applyRoutineAction(
    scope,
    { kind: 'beginObservation', operationId: crypto.randomUUID(), runId, writer, tenure },
    Date.now()
  );
  assert.ok(pending.kind === 'ok' && pending.attempt?.observation);
  const table: import('../../core/scan').ProcessTable = {
    complete: true,
    startSource: 'ps-lstart-v1',
    starts: new Map(),
    parents: new Map(),
    groups: new Map(),
    shellParents: new Set(),
    claude: new Map(),
    grok: new Map(),
    codex: new Map()
  };
  const takeover = await routines.applyRoutineAction(
    scope,
    {
      kind: 'beginObservation',
      operationId: crypto.randomUUID(),
      runId,
      writer: { pid: 999999, startedAt: 3, startSource: 'ps-lstart-v1' },
      tenure: crypto.randomUUID(),
      table
    },
    Date.now()
  );
  assert.equal(takeover.kind, 'busy');
  assert.equal((await reserve(scope, definition, owner)).kind, 'busy');
  const reread = await routines.resolveRoutineRun(runId);
  assert.equal(reread?.attempt.observation?.pending, true);
});

it('confirms cleanup for a positively childless stop, and refuses that claim once a process was observed', async () => {
  const { scope, definition, owner } = await setup();
  const first = await reserve(scope, definition, owner);
  assert.ok(first.kind === 'ok' && first.attempt);
  const stopped = await routines.applyRoutineAction(
    scope,
    {
      kind: 'recordStopped',
      operationId: crypto.randomUUID(),
      runId: first.attempt.runId,
      owner,
      noChild: true,
      reason: 'Nothing was spawned.'
    },
    Date.now()
  );
  assert.ok(stopped.kind === 'ok' && stopped.attempt);
  assert.equal(stopped.attempt.phase, 'stopped');
  assert.equal(stopped.attempt.cleanupConfirmed, true);
  const second = await reserve(scope, definition, owner);
  assert.ok(second.kind === 'ok' && second.attempt);
  const runId = second.attempt.runId;
  await routines.applyRoutineAction(
    scope,
    { kind: 'spawning', operationId: crypto.randomUUID(), runId, owner },
    Date.now()
  );
  // A durable observation began, so a native child existed: "no child" is no longer positive.
  await routines.applyRoutineAction(
    scope,
    {
      kind: 'beginObservation',
      operationId: crypto.randomUUID(),
      runId,
      writer: routines.hostMember(owner),
      tenure: crypto.randomUUID()
    },
    Date.now()
  );
  const claimed = await routines.applyRoutineAction(
    scope,
    {
      kind: 'recordStopped',
      operationId: crypto.randomUUID(),
      runId,
      owner,
      noChild: true,
      reason: 'The session could not be started.'
    },
    Date.now()
  );
  assert.equal(claimed.kind, 'refused');
  assert.equal((await reserve(scope, definition, owner)).kind, 'busy');
});

it('scans nothing for unbound spawning and judges a live owner from the cached table', async (t) => {
  const unbound = await setup();
  const deadOwner = { ...unbound.owner, pid: 999999, osStartedAt: 5 };
  const pending = await reserve(unbound.scope, unbound.definition, deadOwner);
  assert.ok(pending.kind === 'ok' && pending.attempt);
  await routines.applyRoutineAction(
    unbound.scope,
    {
      kind: 'spawning',
      operationId: crypto.randomUUID(),
      runId: pending.attempt.runId,
      owner: deadOwner
    },
    Date.now()
  );
  const owned = await setup();
  const running = await reserve(owned.scope, owned.definition, owned.owner);
  assert.ok(running.kind === 'ok' && running.attempt);
  const child: types.Member = { pid: 4242, startedAt: 10, startSource: 'ps-lstart-v1' };
  const runningId = running.attempt.runId;
  await routines.applyRoutineAction(
    owned.scope,
    { kind: 'spawning', operationId: crypto.randomUUID(), runId: runningId, owner: owned.owner },
    Date.now()
  );
  assert.equal(
    (
      await routines.applyRoutineAction(
        owned.scope,
        {
          kind: 'recordChild',
          operationId: crypto.randomUUID(),
          runId: runningId,
          owner: owned.owner,
          child
        },
        Date.now()
      )
    ).kind,
    'ok'
  );
  const scan = await import('../../core/scan');
  const lifetime = await import('../../core/routines/lifetime');
  const fresh: boolean[] = [];
  t.mock.method(scan, 'scanProcesses', (refill?: boolean) => {
    fresh.push(refill === true);
    return Promise.resolve(processTable([child]));
  });
  const recovery = new lifetime.RoutineRecovery();
  t.after(() => recovery.dispose());
  assert.equal(await recovery.reconcile(unbound.scope, Date.now()), undefined);
  assert.deepEqual(fresh, [], 'an attempt with no recorded child has nothing to scan for');
  assert.equal(await recovery.reconcile(owned.scope, Date.now()), undefined);
  assert.ok(
    fresh.every((refill) => !refill),
    'a live owner is judged from the cached table'
  );
  const reread = await routines.resolveRoutineRun(pending.attempt.runId);
  assert.equal(reread?.attempt.phase, 'spawning');
});

it('repairs a damaged content-addressed image when the same bytes are saved again', async () => {
  const { scope, definition } = await setup();
  const bytes = Buffer.from('bytes');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const images = path.join(paths.ROUTINES_DIR, scope.repoKey, 'images');
  await fs.mkdir(images, { recursive: true });
  await fs.writeFile(path.join(images, hash), 'byt');
  const saved = await routines.applyRoutineAction(
    scope,
    {
      kind: 'save',
      operationId: crypto.randomUUID(),
      id: definition.id,
      expectedDefinitionRevision: definition.definitionRevision,
      draft: {
        name: definition.name,
        enabled: true,
        schedule: definition.schedule,
        task: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'chip',
                    attrs: { kind: 'image', expansion: '[Image #1]', attachmentId: 'image-1' }
                  }
                ]
              }
            ]
          },
          delivered: '[Image #1]',
          targetChoice: { kind: 'default' },
          savedFromCwd: scope.launchCwd,
          attachments: {
            'image-1': {
              kind: 'image',
              image: {
                name: 'test.png',
                mediaType: 'image/png',
                dataUrl: `data:image/png;base64,${bytes.toString('base64')}`
              }
            }
          }
        }
      }
    },
    Date.now()
  );
  assert.equal(saved.kind, 'ok', JSON.stringify(saved));
  assert.ok(saved.kind === 'ok' && saved.definition);
  assert.deepEqual(await fs.readFile(path.join(images, hash)), bytes);
  const restored = await routines.restoreTask(scope, saved.definition.task);
  assert.equal(
    restored.attachments['image-1']?.image.dataUrl,
    `data:image/png;base64,${bytes.toString('base64')}`
  );
  assert.deepEqual(await fs.readdir(images), [hash], 'no temporary blob is left behind');
});

it('records a captured root whose recordChild never landed, then confirms its absence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scope, definition, owner } = await setup();
  const reserved = await reserve(scope, definition, owner);
  assert.ok(reserved.kind === 'ok' && reserved.attempt);
  const runId = reserved.attempt.runId;
  await routines.applyRoutineAction(
    scope,
    { kind: 'spawning', operationId: crypto.randomUUID(), runId, owner },
    Date.now()
  );
  const scan = await import('../../core/scan');
  const lifetime = await import('../../core/routines/lifetime');
  const { SessionLifetime } = await import('../../core/session_lifetime');
  const root: types.Member = { pid: 5151, startedAt: 20, startSource: 'ps-lstart-v1' };
  let visible = [root];
  t.mock.method(scan, 'scanProcesses', () => Promise.resolve(processTable(visible)));
  let exit!: () => void;
  const exited = new Promise<boolean>((resolve) => {
    exit = () => resolve(true);
  });
  const durable = lifetime.durableOwner(scope, runId, routines.hostMember(owner));
  const session = new SessionLifetime(
    { pid: root.pid, exited, close() {} },
    { durableObservation: durable.durableObservation, gone: () => durable.gone() }
  );
  await session.capture();
  assert.equal(session.initialRoot?.pid, root.pid);
  // The start is abandoned here, between the capture and its recordChild.
  visible = [];
  exit();
  await exited;
  let result = await session.close();
  for (let attempt = 0; attempt < 3 && result !== 'gone'; attempt++)
    result = await session.reconcile();
  assert.equal(result, 'gone');
  const settled = await routines.resolveRoutineRun(runId);
  assert.equal(settled?.attempt.child?.pid, root.pid);
  assert.equal(settled?.attempt.cleanupConfirmed, true);
  assert.equal(settled?.attempt.phase, 'stopped');
  assert.equal((await reserve(scope, definition, owner)).kind, 'ok');
});

function processTable(members: readonly types.Member[]): import('../../core/scan').ProcessTable {
  return {
    complete: true,
    startSource: 'ps-lstart-v1',
    claude: new Map(),
    codex: new Map(),
    grok: new Map(),
    shellParents: new Set(),
    groups: new Map(),
    starts: new Map([
      [process.pid, 1],
      ...members.map((member): [number, number] => [member.pid, member.startedAt])
    ]),
    parents: new Map(members.map((member): [number, number] => [member.pid, 1]))
  };
}
