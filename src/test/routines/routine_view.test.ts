import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as views from '../../ui/routine_view';
import type * as types from '../../core/routines/types';

function snapshot(): types.Snapshot {
  const scope = { repoRoot: '/repo', repoKey: 'a'.repeat(64), launchCwd: '/repo-side' };
  const owner = {
    version: 1 as const,
    windowId: 'original-window',
    pid: 42,
    osStartedAt: 1,
    startSource: 'ps-lstart-v1' as const,
    incarnation: 'original-activation'
  };
  const task: types.Task = {
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    delivered: 'Review the project',
    targetChoice: { kind: 'default' },
    images: {},
    savedFromCwd: '/repo'
  };
  const attempt: types.Attempt = {
    runId: 'active',
    routineId: 'review',
    definitionRevision: 1,
    scheduleEpoch: 'epoch',
    occurrenceKey: 'epoch/day/2026-11-14',
    requestedAt: 10,
    cwd: '/repo',
    nativeCwd: '/repo',
    task,
    target: {},
    owner,
    phase: 'started',
    members: [],
    receiver: {
      version: 1,
      host: owner,
      pid: 43,
      osStartedAt: 2,
      startSource: 'ps-lstart-v1',
      incarnation: 'receiving-cli',
      brand: 'claude',
      cwd: '/repo'
    }
  };
  return {
    scope,
    repository: {
      schema: 1,
      repoRoot: scope.repoRoot,
      repoKey: scope.repoKey,
      revision: 1,
      routines: {
        review: {
          id: 'review',
          definitionRevision: 1,
          name: 'Review',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          task,
          schedule: { kind: 'daily', time: '09:00' },
          scheduleEpoch: 'epoch',
          handled: [],
          activeRunId: 'active'
        }
      },
      attempts: {
        previous: {
          ...attempt,
          runId: 'previous',
          requestedAt: 5,
          phase: 'done',
          doneAt: 6,
          note: 'All checked'
        },
        active: attempt
      }
    }
  };
}

it('describes a live foreign run by its window without claiming incomplete evidence', () => {
  const row = views.routineRows(snapshot(), 20, () => ({
    kind: 'foreign',
    label: 'acme-web · main'
  }))[0];
  assert.ok(row);
  assert.equal(row?.status, 'In another window');
  assert.equal(row.sessionAction, 'switchWindow');
  assert.equal(row.windowLabel, 'acme-web · main');
  assert.equal(row.reason, undefined);
  assert.equal(row.due, false);
});

it('shows the settled previous attempt while a new run is active', () => {
  const row = views.routineRows(snapshot(), 20, () => 'busy')[0];
  assert.deepEqual(row?.lastRun, { at: 5, done: true, note: 'All checked' });
});

it('keeps unknown ownership unresolved and explains limited descendant coverage', () => {
  const state = snapshot();
  const active = state.repository.attempts.active;
  assert.ok(active);
  active.observation = {
    writer: { pid: 42, startedAt: 1, startSource: 'ps-lstart-v1' },
    tenure: 'launch',
    generation: 1,
    pending: false,
    absent: false,
    coverage: 'limited'
  };
  const row = views.routineRows(state, 20, () => undefined)[0];
  assert.ok(row);
  assert.equal(row?.status, 'Unresolved');
  assert.match(row.reason ?? '', /descendant coverage/i);
});
