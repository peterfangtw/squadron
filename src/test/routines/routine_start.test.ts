import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, after, it } from 'node:test';
import * as homeFixture from '../home';
import * as actions from '../../ui/routine_actions';
import type * as types from '../../core/routines/types';
import type * as launch from '../../core/routines/start';
import type * as bridge from '../../core/bridge/model';
import type * as modelNames from '../../core/model_names';

let home: string;
let routines: typeof import('../../core/routines/routines');
let starts: typeof import('../../core/routines/start');
let schedules: typeof import('../../core/routines/schedule');
before(async () => {
  home = await homeFixture.tempHome();
  routines = await import('../../core/routines/routines');
  starts = await import('../../core/routines/start');
  schedules = await import('../../core/routines/schedule');
});
after(() => homeFixture.disposeHome(home));

async function setup(): Promise<{
  scope: types.Scope;
  request: launch.Request;
  owner: bridge.HostIdentity;
}> {
  const cwd = path.join(home, crypto.randomUUID());
  await fs.mkdir(cwd);
  const scope = await routines.resolveScope(cwd);
  const saved = await routines.applyRoutineAction(
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
              { type: 'paragraph', content: [{ type: 'text', text: 'Review dependencies' }] }
            ]
          },
          delivered: 'Review dependencies',
          targetChoice: { kind: 'default' },
          attachments: {},
          savedFromCwd: cwd
        }
      }
    },
    Date.now()
  );
  assert.ok(saved.kind === 'ok' && saved.definition);
  return {
    scope,
    request: {
      operationId: crypto.randomUUID(),
      id: saved.definition.id,
      expectedDefinitionRevision: saved.definition.definitionRevision,
      occurrenceKey: schedules.occurrence(saved.definition, Date.now()).key,
      runId: crypto.randomUUID()
    },
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

it('reserves through the real store before native handoff and retains an uncertain outcome', async () => {
  const { scope, request, owner } = await setup();
  let launches = 0;
  const ports: launch.Ports = {
    models: () => [],
    defaults: { model: '', efforts: {} },
    owner: () => Promise.resolve(owner),
    launch: async (options) => {
      launches++;
      const stored = await routines.resolveRoutineRun(options.attemptId);
      assert.ok(stored);
      assert.equal(stored?.attempt.phase, 'reserved');
      assert.equal(stored.attempt.cwd, scope.launchCwd);
      assert.deepEqual(options.target, {});
      return { ok: false, outcome: 'unknown', reason: 'Native handoff was not confirmed.' };
    }
  };
  const results = await Promise.all([
    starts.start(scope, request, ports),
    starts.start(
      scope,
      { ...request, operationId: crypto.randomUUID(), runId: crypto.randomUUID() },
      ports
    )
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ['busy', 'refused']);
  assert.equal(launches, 1);
  const stored = await routines.readRoutineSnapshot(scope);
  assert.ok(stored.kind === 'ok');
  assert.ok(stored.snapshot.repository.routines[request.id]?.activeRunId);
});

it('releases positive no-child failures for a deliberate retry', async () => {
  const { scope, request, owner } = await setup();
  let launches = 0;
  const ports: launch.Ports = {
    models: () => [],
    defaults: { model: '', efforts: {} },
    owner: () => Promise.resolve(owner),
    launch: () => {
      launches++;
      return Promise.resolve({ ok: false, outcome: 'stopped', reason: 'Binary unavailable.' });
    }
  };
  assert.equal((await starts.start(scope, request, ports)).kind, 'refused');
  assert.equal(
    (
      await starts.start(
        scope,
        {
          ...request,
          operationId: crypto.randomUUID(),
          runId: crypto.randomUUID()
        },
        ports
      )
    ).kind,
    'refused'
  );
  assert.equal(launches, 2);
  const stored = await routines.resolveRoutineRun(request.runId);
  assert.equal(stored?.attempt.cleanupConfirmed, true);
});

it('refuses a catalog change during asynchronous preparation before reserving', async () => {
  const { scope, request, owner } = await setup();
  let models: modelNames.Model[] = [
    { brand: 'codex', id: 'test-model', value: 'test-model', name: 'Test model' }
  ];
  let launches = 0;
  const result = await starts.start(scope, request, {
    models: () => models,
    defaults: { model: 'test-model', efforts: {} },
    owner: () => {
      models = [];
      return Promise.resolve(owner);
    },
    launch: () => {
      launches++;
      throw new Error('Native handoff must not run.');
    }
  });
  assert.equal(result.kind, 'invalid');
  assert.equal(launches, 0);
  const stored = await routines.readRoutineSnapshot(scope);
  assert.ok(stored.kind === 'ok');
  assert.deepEqual(stored.snapshot.repository.attempts, {});
});

it('carries captured target validation into native handoff without stranding admission', async () => {
  const { scope, request, owner } = await setup();
  let models: modelNames.Model[] = [
    { brand: 'codex', id: 'test-model', value: 'test-model', name: 'Test model' }
  ];
  const result = await starts.start(scope, request, {
    models: () => models,
    defaults: { model: 'test-model', efforts: {} },
    owner: () => Promise.resolve(owner),
    launch: (options) => {
      assert.equal(options.target.model, 'test-model');
      models = [];
      assert.throws(() => options.routine.validateTarget(), /unavailable/);
      return Promise.resolve({
        ok: false,
        outcome: 'stopped',
        reason: 'The captured target became unavailable.'
      });
    }
  });
  assert.equal(result.kind, 'refused');
  const stored = await routines.readRoutineSnapshot(scope);
  assert.ok(stored.kind === 'ok');
  assert.equal(stored.snapshot.repository.routines[request.id]?.activeRunId, undefined);
});

it('keeps a captured native account default when the catalog arrives during preparation', async () => {
  const { scope, request, owner } = await setup();
  let models: modelNames.Model[] = [];
  let launches = 0;
  const result = await starts.start(scope, request, {
    models: () => models,
    defaults: { model: '', efforts: {} },
    owner: () => {
      models = [{ brand: 'codex', id: 'test-model', value: 'test-model', name: 'Test model' }];
      return Promise.resolve(owner);
    },
    launch: (options) => {
      launches++;
      assert.deepEqual(options.target, {});
      options.routine.validateTarget();
      return Promise.resolve({ ok: false, outcome: 'stopped', reason: 'Binary unavailable.' });
    }
  });
  assert.equal(result.kind, 'refused');
  assert.equal(launches, 1);
});

it('validates the whole request context and rejects a malformed operation ID', () => {
  const scope = { repoKey: 'a'.repeat(64), launchCwd: '/repo-side' };
  const message: RoutineWebviewMessage = {
    type: 'runRoutine',
    scope,
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    expectedDefinitionRevision: 1,
    occurrenceKey: 'cycle'
  };
  assert.equal(actions.matchesScope(message, scope), true);
  assert.equal(
    actions.matchesScope({ ...message, scope: { ...scope, launchCwd: '/repo' } }, scope),
    false
  );
  assert.equal(actions.matchesScope({ ...message, operationId: '-'.repeat(36) }, scope), false);
});

it('instructs the agent to complete only its exact run through the installed verb', () => {
  const runId = crypto.randomUUID();
  const instruction = starts.completionInstruction(runId, 'posix');
  assert.ok(instruction.includes(`done --run-id ${runId}`));
  assert.match(instruction, /squadron-routine/);
  assert.match(instruction, /idle status or completed workflow does not complete/);
});
