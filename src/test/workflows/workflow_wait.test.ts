import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Session } from '../../core/model';
import type { WaitMember, WaitRecord } from '../../core/coordination/wait';
import type { Progress, StepStatus } from '../../core/workflows/progress';
import type { Workflow } from '../../core/workflows/workflows';
import { disposeHome, resetDir, tempHome, writeJson } from '../helpers';

let progress: typeof import('../../core/workflows/progress');
let waits: typeof import('../../core/coordination/wait');
let workflowWait: typeof import('../../core/workflows/wait');
let workflows: typeof import('../../core/workflows/workflows');
let step: typeof import('../../cli/step');
let paths: typeof import('../../core/paths');

let home: string;

before(async () => {
  home = await tempHome();
  paths = await import('../../core/paths');
  progress = await import('../../core/workflows/progress');
  waits = await import('../../core/coordination/wait');
  workflowWait = await import('../../core/workflows/wait');
  workflows = await import('../../core/workflows/workflows');
  step = await import('../../cli/step');
});

after(async () => {
  await disposeHome(home);
});

const NOW = 1_700_000_000_000;
const OPENED = NOW - 10_000;
const workflow: Workflow = {
  id: 'handoff',
  label: 'Handoff',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan' },
    {
      id: 'review-plan',
      label: 'Review plan',
      prompt: 'review',
      lane: 'Reviewer',
      needs: ['plan']
    },
    { id: 'confirm', label: 'Confirm', prompt: 'confirm', needs: ['plan'] },
    { id: 'implement', label: 'Implement', prompt: 'implement', needs: ['confirm'] },
    { id: 'peer-review', label: 'Peer review', prompt: 'peer review', needs: ['implement'] },
    {
      id: 'review-code',
      label: 'Review code',
      prompt: 'review code',
      lane: 'Reviewer',
      needs: ['review-plan', 'peer-review']
    },
    { id: 'finish', label: 'Finish', prompt: 'finish', needs: ['review-code'] }
  ]
};

function record(
  sessionId: string,
  statuses: readonly [string, StepStatus][],
  extra: Partial<Progress> = {}
): Progress {
  return {
    schema: 1,
    workflowId: workflow.id,
    sessionId,
    armedAt: OPENED,
    updatedAt: NOW,
    kind: 'pipeline',
    steps: statuses.map(([id, status]) => ({ id, label: id, status })),
    ...extra
  };
}

const anchor = (over: Partial<Progress> = {}) =>
  record(
    'anchor',
    [
      ['plan', 'completed'],
      ['confirm', 'pending'],
      ['implement', 'pending'],
      ['peer-review', 'pending'],
      ['finish', 'pending']
    ],
    { pid: 10, lanes: { Reviewer: { pid: 21, openedAt: OPENED } }, ...over }
  );
const reviewer = (over: Partial<Progress> = {}) =>
  record(
    'reviewer',
    [
      ['review-plan', 'completed'],
      ['review-code', 'pending']
    ],
    { lane: 'Reviewer', anchor: 'anchor', opened: OPENED, ...over }
  );
const board: (Session & WaitMember)[] = [
  { pid: 10, sessionId: 'anchor' },
  { pid: 21, sessionId: 'reviewer' }
].map((member) => ({
  ...member,
  name: member.sessionId,
  transcript: '/tmp/workflow-wait.jsonl',
  cwd: '/repo',
  status: 'idle',
  hasCommand: false,
  ended: false,
  startedAt: OPENED,
  updatedAt: NOW,
  source: 'owned',
  windowId: 'window'
}));

beforeEach(async () => {
  await resetDir(paths.RUNS_DIR);
  await resetDir(paths.WORKFLOWS_DIR);
  await writeJson(path.join(paths.WORKFLOWS_DIR, `${workflow.id}.json`), {
    schema: 2,
    ...workflow
  });
  assert.equal(await progress.writeProgress(anchor()), true);
  assert.equal(await progress.writeProgress(reviewer()), true);
});

function registered(self: Progress, others: Progress[], definition = workflow): WaitRecord {
  const plan = step.stepPlan({
    verb: 'next',
    shell: 'posix',
    caller: self.sessionId,
    read: { state: 'ok', progress: self },
    workflow: definition,
    cwd: '/repo',
    now: NOW,
    sessions: board,
    others
  });
  assert.ok(plan.ok && plan.wait, JSON.stringify(plan));
  return plan.wait;
}

async function resolve(wait: WaitRecord, members = board, now = NOW) {
  const workflowStates = await workflowWait.readWorkflowWaitStates([wait], members, now);
  return waits.resolveWaits({ waits: [wait], board: members, workflowStates, now });
}

describe('workflow dependency waits across CLI registration and disk resolution', () => {
  it('ends a wait on a cancelled dependency and refuses to register it again', async () => {
    const self = anchor({
      steps: anchor().steps.map((row) => ({
        ...row,
        status: row.id === 'finish' ? 'pending' : 'completed'
      }))
    });
    await progress.writeProgress(self);
    const wait = registered(self, [reviewer()]);
    const cancelled = reviewer({ cancelledAt: NOW });
    await progress.writeProgress(cancelled);
    assert.match((await resolve(wait))[0]?.text ?? '', /workflow stopped or stalled/);
    const next = step.stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: self },
      workflow,
      cwd: '/repo',
      now: NOW,
      sessions: board,
      others: [cancelled]
    });
    assert.equal(next.ok, false);
    assert.match(next.ok ? '' : next.reason, /Reviewer was cancelled/);
  });

  it('ignores cancellation of a lane outside the blocked dependency chain', async () => {
    const wait = registered(reviewer(), [anchor()]);
    const self = anchor();
    self.lanes = { ...self.lanes, Other: { pid: 31, openedAt: OPENED } };
    await progress.writeProgress(self);
    await progress.writeProgress(
      record('other', [['unrelated', 'pending']], {
        lane: 'Other',
        anchor: 'anchor',
        opened: OPENED,
        cancelledAt: NOW
      })
    );
    assert.deepEqual(await resolve(wait), []);
  });

  it('schedules a fresh recordless lane and wakes for fallback if it stays idle', async () => {
    const self = anchor({
      steps: anchor().steps.map((row) => ({
        ...row,
        status: row.id === 'finish' ? 'pending' : 'completed'
      })),
      lanes: { Reviewer: { pid: 21, openedAt: NOW, requestId: 'fresh-reviewer' } }
    });
    await progress.writeProgress(self);
    await fs.rm(progress.progressPath('reviewer'));
    await writeJson(path.join(paths.LINEAGE_DIR, '21.json'), {
      spawnedAt: OPENED,
      requestId: 'fresh-reviewer'
    });
    const wait = registered(self, []);
    const states = await workflowWait.readWorkflowWaitStates([wait], board, NOW);
    assert.deepEqual(states.get(wait.id), {
      state: 'pending',
      checkAt: NOW + progress.FRESH_LANE_MS
    });
    assert.deepEqual(await resolve(wait), []);
    assert.equal((await resolve(wait, board, NOW + progress.FRESH_LANE_MS)).length, 1);
  });

  it('ignores idle and intermediate completion, then wakes when the needed step completes', async () => {
    const wait = registered(reviewer(), [anchor()]);
    assert.deepEqual(wait.workflow, { workflowId: workflow.id, armedAt: OPENED });
    for (let round = 0; round < 5; round++) assert.deepEqual(await resolve(wait), []);
    const moved = anchor();
    for (const id of ['confirm', 'implement']) {
      const row = moved.steps.find((entry) => entry.id === id);
      assert.ok(row);
      row.status = 'completed';
      await progress.writeProgress(moved);
      assert.deepEqual(await resolve(wait), [], id);
    }
    const peer = moved.steps.find((row) => row.id === 'peer-review');
    assert.ok(peer);
    peer.status = 'completed';
    await progress.writeProgress(moved);
    // Completion can land before the CLI's final idle frame.
    const busyBoard = board.map((member) => ({ ...member, status: 'busy' as const }));
    const out = await resolve(wait, busyBoard);
    assert.equal(out.length, 1);
    assert.match(out[0]?.text ?? '', /workflow wait is over/);
    assert.doesNotMatch(out[0]?.text ?? '', /sessions.*finished/);
    assert.equal(
      step.stepPlan({
        verb: 'next',
        shell: 'posix',
        caller: 'reviewer',
        read: { state: 'ok', progress: reviewer() },
        workflow,
        cwd: '/repo',
        now: NOW,
        sessions: board,
        others: [moved]
      }).ok,
      true
    );
  });

  it('wakes the anchor at the join, not when its reviewer merely ends a turn', async () => {
    const self = anchor({
      steps: anchor().steps.map((row) => ({
        ...row,
        status: row.id === 'finish' ? 'pending' : 'completed'
      }))
    });
    const lane = reviewer();
    const wait = registered(self, [lane]);
    await progress.writeProgress(self);
    assert.deepEqual(await resolve(wait), []);
    await progress.writeProgress(
      reviewer({ steps: reviewer().steps.map((row) => ({ ...row, status: 'completed' })) })
    );
    assert.equal((await resolve(wait)).length, 1);
  });

  it('wakes an anchor to open a later lane before its own join is ready', async () => {
    const extended: Workflow = {
      ...workflow,
      steps: [
        ...workflow.steps.slice(0, -1),
        {
          id: 'late-build',
          label: 'Late build',
          prompt: 'build',
          lane: 'Builder',
          needs: ['review-code']
        },
        { ...workflow.steps[workflow.steps.length - 1]!, needs: ['late-build'] }
      ]
    };
    await writeJson(path.join(paths.WORKFLOWS_DIR, `${workflow.id}.json`), {
      schema: 2,
      ...extended
    });
    const self = anchor({
      steps: anchor().steps.map((row) => ({
        ...row,
        status: row.id === 'finish' ? 'pending' : 'completed'
      }))
    });
    await progress.writeProgress(self);
    const wait = registered(self, [reviewer()], extended);
    assert.deepEqual(await resolve(wait), []);
    await progress.writeProgress(
      reviewer({ steps: reviewer().steps.map((row) => ({ ...row, status: 'completed' })) })
    );
    assert.equal((await resolve(wait)).length, 1);
    const next = step.stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: self },
      workflow: extended,
      cwd: '/repo',
      now: NOW,
      sessions: board,
      others: [
        reviewer({ steps: reviewer().steps.map((row) => ({ ...row, status: 'completed' })) })
      ]
    });
    assert.deepEqual(next.ok ? next.opens?.map((open) => open.lane) : [], ['Builder']);
  });

  for (const change of [
    'cancel',
    'rearm',
    'requester-rearm',
    'requester-cancel',
    'replace-lane',
    'missing-definition',
    'dead-anchor',
    'idle-in-progress'
  ] as const) {
    it(`ends a dependency wait after ${change}`, async () => {
      const wait = registered(reviewer(), [anchor()]);
      const changed = anchor();
      if (change === 'requester-rearm') await progress.writeProgress(reviewer({ armedAt: NOW }));
      if (change === 'requester-cancel')
        await progress.writeProgress(reviewer({ cancelledAt: NOW }));
      if (change === 'cancel') changed.cancelledAt = NOW;
      if (change === 'rearm' || change === 'replace-lane')
        changed.lanes = { Reviewer: { pid: 21, openedAt: NOW } };
      if (change === 'idle-in-progress') changed.steps[1]!.status = 'in_progress';
      await progress.writeProgress(changed);
      if (change === 'missing-definition') await resetDir(paths.WORKFLOWS_DIR);
      const members =
        change === 'dead-anchor'
          ? board.map((member) => ({ ...member, ended: member.pid === 10 }))
          : board;
      const out = await resolve(wait, members);
      assert.equal(out.length, 1);
      assert.match(out[0]?.text ?? '', /workflow stopped or stalled/);
    });
  }

  it('does not satisfy the current arming with an earlier lane’s completed rows', async () => {
    const self = anchor({
      steps: anchor().steps.map((row) => ({
        ...row,
        status: row.id === 'finish' ? 'pending' : 'completed'
      }))
    });
    await progress.writeProgress(self);
    const wait = registered(self, [reviewer()]);
    await progress.writeProgress(
      reviewer({
        opened: OPENED - 1,
        steps: reviewer().steps.map((row) => ({ ...row, status: 'completed' }))
      })
    );
    // A recordless lane still has its original live spawn, as lineage proves.
    await writeJson(path.join(paths.LINEAGE_DIR, '21.json'), {
      schema: 1,
      pid: 21,
      spawnedAt: OPENED,
      parentSessionId: 'anchor',
      requestId: 'open-reviewer'
    });
    self.lanes = { Reviewer: { pid: 21, openedAt: OPENED, requestId: 'open-reviewer' } };
    await progress.writeProgress(self);
    const states = await workflowWait.readWorkflowWaitStates(
      [wait],
      board.map((member) => ({ ...member, status: 'busy' })),
      NOW
    );
    assert.equal(states.get(wait.id)?.state, 'pending');
  });

  it('expires without claiming idle sessions completed their dependencies', async () => {
    const wait = registered(reviewer(), [anchor()]);
    const out = await resolve(wait, board, wait.expiresAt);
    assert.equal(out.length, 1);
    assert.match(out[0]?.text ?? '', /reached its deadline/);
    assert.match(out[0]?.text ?? '', /dependencies not ready/);
  });
});

describe('a workflow wait before its required sibling starts', () => {
  const sibling: Workflow = {
    id: workflow.id,
    label: 'Sibling startup',
    steps: [
      { id: 'plan', label: 'Plan', prompt: 'plan' },
      {
        id: 'review-plan',
        label: 'Review plan',
        prompt: 'review',
        lane: 'Reviewer',
        needs: ['plan']
      },
      {
        id: 'prepare',
        label: 'Prepare',
        prompt: 'prepare',
        lane: 'Implementer',
        needs: ['review-plan']
      },
      {
        id: 'implement',
        label: 'Implement',
        prompt: 'implement',
        lane: 'Implementer',
        needs: ['prepare']
      },
      {
        id: 'review-code',
        label: 'Review code',
        prompt: 'review',
        lane: 'Reviewer',
        needs: ['implement']
      },
      { id: 'finish', label: 'Finish', prompt: 'finish', needs: ['review-code'] }
    ]
  };
  const coordinator = () =>
    record(
      'anchor',
      [
        ['plan', 'completed'],
        ['finish', 'pending']
      ],
      {
        pid: 10,
        lanes: { Reviewer: { pid: 21, openedAt: OPENED } }
      }
    );
  const worker = (over: Partial<Progress> = {}) =>
    record(
      'worker',
      [
        ['prepare', 'pending'],
        ['implement', 'pending']
      ],
      {
        lane: 'Implementer',
        anchor: 'anchor',
        opened: OPENED,
        ...over
      }
    );
  const workerBoard = [
    ...board,
    { ...board[1]!, pid: 31, sessionId: 'worker', status: 'busy' as const }
  ];
  const next = (self: Progress, others: Progress[], members = board, definition = sibling) =>
    step.stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: self.sessionId,
      read: { state: 'ok', progress: self },
      workflow: definition,
      cwd: '/repo',
      now: NOW,
      sessions: members,
      others
    });
  const register = (self: Progress, others: Progress[], members = board): WaitRecord => {
    const plan = next(self, others, members);
    assert.ok(plan.ok && plan.wait, JSON.stringify(plan));
    assert.equal(plan.opens, undefined);
    return plan.wait;
  };

  beforeEach(async () => {
    await resetDir(paths.LINEAGE_DIR);
    await writeJson(path.join(paths.WORKFLOWS_DIR, `${sibling.id}.json`), {
      schema: 2,
      ...sibling
    });
    await progress.writeProgress(coordinator());
  });

  it('registers before a claim, holds through startup and intermediate work, and resolves only completion', async () => {
    const anchor = coordinator();
    const wait = register(reviewer(), [anchor]);
    assert.deepEqual(wait.members, [10]);
    assert.deepEqual(await resolve(wait), []);
    anchor.lanes!.Implementer = { openedAt: OPENED };
    await progress.writeProgress(anchor);
    assert.deepEqual(await resolve(wait), []);
    anchor.lanes!.Implementer.requestId = 'unknown-outcome';
    await progress.writeProgress(anchor);
    assert.deepEqual(await resolve(wait), []);
    assert.equal(next(anchor, [reviewer()]).ok, false, 'unknown outcome cannot spawn twice');
    anchor.lanes!.Implementer = { openedAt: OPENED, pid: 31, requestId: 'worker-open' };
    await progress.writeProgress(anchor);
    await writeJson(path.join(paths.LINEAGE_DIR, '31.json'), {
      spawnedAt: OPENED,
      requestId: 'worker-open'
    });
    assert.deepEqual(await resolve(wait, workerBoard), [], 'PID alone is not completion');
    const live = worker();
    await progress.writeProgress(live);
    assert.deepEqual(register(reviewer(), [anchor, live], workerBoard).members, [31]);
    assert.deepEqual(await resolve(wait, workerBoard), []);
    live.steps[0]!.status = 'completed';
    await progress.writeProgress(live);
    assert.deepEqual(await resolve(wait, workerBoard), [], 'intermediate completion');
    live.steps[1]!.status = 'completed';
    await progress.writeProgress(live);
    const out = await resolve(wait, workerBoard);
    assert.equal(out.length, 1);
    assert.match(out[0]!.text, /ready to check the next step/);
    assert.doesNotMatch(out[0]!.text, /stopped or stalled|dependencies not ready/);
  });

  it('opens from coordinator next instead of registering a self-wait', () => {
    const plan = next(coordinator(), [reviewer()]);
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.opens?.map((open) => open.lane),
      ['Implementer']
    );
    assert.equal(plan.wait, undefined);
  });

  it('uses the current coordinator session identity and retains the unchanged-run loop breaker', () => {
    const members = board.map((member) => (member.pid === 10 ? { ...member, pid: 99 } : member));
    let self = reviewer();
    for (const round of [1, 2]) {
      const plan = next(self, [coordinator()], members);
      assert.ok(plan.ok && plan.wait);
      assert.deepEqual(plan.wait.members, [99]);
      assert.equal(plan.write?.held?.count, round);
      self = plan.write!;
    }
    const held = next(self, [coordinator()], members);
    assert.equal(held.ok, false);
    assert.match(held.ok ? '' : held.reason, /woken 3 times/);
  });

  for (const change of [
    'absent',
    'ended',
    'reused',
    'cancelled',
    'rearmed',
    'stale-worker',
    'refused',
    'expired'
  ] as const) {
    it(`keeps the startup outcome observable: ${change}`, async () => {
      const anchor = coordinator();
      const wait = register(reviewer(), [anchor]);
      anchor.lanes!.Implementer = { openedAt: OPENED, requestId: 'unknown-outcome' };
      if (change === 'cancelled') anchor.cancelledAt = NOW;
      if (change === 'rearmed') anchor.lanes!.Reviewer = { openedAt: NOW };
      if (change === 'refused') anchor.lanes!.Implementer.refused = 'both model picks refused';
      await progress.writeProgress(anchor);
      if (change === 'stale-worker') {
        await progress.writeProgress(
          worker({
            opened: OPENED - 1,
            steps: worker().steps.map((row) => ({ ...row, status: 'completed' }))
          })
        );
        assert.deepEqual(await resolve(wait), [], 'old completion cannot satisfy the dependency');
        return;
      }
      const members =
        change === 'absent'
          ? board.filter((member) => member.pid !== 10)
          : board.map((member) =>
              member.pid !== 10
                ? member
                : change === 'ended'
                  ? { ...member, ended: true }
                  : change === 'reused'
                    ? { ...member, sessionId: 'stranger' }
                    : member
            );
      const out = await resolve(wait, members, change === 'expired' ? wait.expiresAt : NOW);
      assert.equal(out.length, 1);
      assert.match(
        out[0]!.text,
        change === 'expired' ? /reached its deadline/ : /workflow stopped or stalled/
      );
    });
  }

  for (const identity of [
    'record-ready',
    'record-working',
    'request-mismatch',
    'start-mismatch'
  ] as const) {
    it(`does not turn a known gone worker into an unopened lane: ${identity}`, async () => {
      const anchor = coordinator();
      const wait = register(reviewer(), [anchor]);
      anchor.lanes!.Implementer = { openedAt: OPENED, pid: 31, requestId: 'worker-open' };
      await progress.writeProgress(anchor);
      if (identity.startsWith('record')) {
        const live = worker();
        if (identity === 'record-working') live.steps[0]!.status = 'in_progress';
        await progress.writeProgress(live);
      } else {
        await writeJson(path.join(paths.LINEAGE_DIR, '31.json'), {
          spawnedAt: identity === 'start-mismatch' ? NOW : OPENED,
          requestId: identity === 'request-mismatch' ? 'another-open' : 'worker-open'
        });
      }
      const members = identity.startsWith('record') ? board : workerBoard;
      assert.match((await resolve(wait, members))[0]?.text ?? '', /workflow stopped or stalled/);
    });
  }

  it('lets an authoritative live worker hold the dependency after the coordinator ends', async () => {
    const anchor = coordinator();
    const wait = register(reviewer(), [anchor]);
    anchor.lanes!.Implementer = { openedAt: OPENED, pid: 31 };
    await progress.writeProgress(anchor);
    await progress.writeProgress(worker());
    const members = workerBoard.filter((member) => member.pid !== 10);
    assert.deepEqual(await resolve(wait, members), []);
    assert.deepEqual(register(reviewer(), [anchor, worker()], members).members, [31]);
  });

  it('preserves required terminal refusal beside cancellation and a fallback candidate', async () => {
    const anchor = coordinator();
    const laneWait = register(reviewer(), [anchor]);
    const coordinatorWait: WaitRecord = {
      ...laneWait,
      id: 'coordinator-wait',
      requesterPid: 10,
      requesterSessionId: 'anchor',
      members: [21]
    };
    const mixed: Workflow = {
      ...sibling,
      steps: sibling.steps.flatMap((row) =>
        row.id === 'finish'
          ? [
              {
                id: 'cancelled-work',
                label: 'Cancelled work',
                prompt: 'work',
                lane: 'Cancelled',
                needs: ['plan']
              },
              { ...row, needs: ['review-code', 'cancelled-work'] }
            ]
          : [row]
      )
    };
    const cancelled = record('cancelled', [['cancelled-work', 'pending']], {
      lane: 'Cancelled',
      anchor: 'anchor',
      opened: OPENED,
      cancelledAt: NOW
    });
    anchor.lanes!.Cancelled = { openedAt: OPENED };
    anchor.lanes!.Implementer = { openedAt: OPENED, refused: 'both model picks refused' };
    anchor.lanes!.Reviewer = { openedAt: OPENED, pid: 21, requestId: 'reviewer-open' };
    await writeJson(path.join(paths.WORKFLOWS_DIR, `${sibling.id}.json`), { schema: 2, ...mixed });
    assert.equal((await workflows.readWorkflows()).length, 1, 'fixture must be runnable');
    await progress.writeProgress(anchor);
    await progress.writeProgress(cancelled);
    await fs.rm(progress.progressPath('reviewer'));
    await writeJson(path.join(paths.LINEAGE_DIR, '21.json'), {
      spawnedAt: OPENED,
      requestId: 'reviewer-open'
    });
    assert.match((await resolve(coordinatorWait))[0]?.text ?? '', /workflow stopped or stalled/);
    assert.equal(next(anchor, [cancelled], board, mixed).ok, false);
  });

  it('ranks required terminal refusal ahead of another fallback candidate or live target', async () => {
    const anchor = coordinator();
    const laneWait = register(reviewer(), [anchor]);
    const coordinatorWait: WaitRecord = {
      ...laneWait,
      id: 'coordinator-wait',
      requesterPid: 10,
      requesterSessionId: 'anchor',
      members: [21]
    };
    anchor.lanes!.Implementer = { openedAt: OPENED, refused: 'both model picks refused' };
    anchor.lanes!.Reviewer = { openedAt: OPENED, pid: 21, requestId: 'reviewer-open' };
    await progress.writeProgress(anchor);
    await fs.rm(progress.progressPath('reviewer'));
    await writeJson(path.join(paths.LINEAGE_DIR, '21.json'), {
      spawnedAt: OPENED,
      requestId: 'reviewer-open'
    });
    assert.match((await resolve(coordinatorWait))[0]?.text ?? '', /workflow stopped or stalled/);
    assert.equal(next(anchor, []).ok, false);
    await progress.writeProgress(reviewer());
    const mixed: Workflow = {
      ...sibling,
      steps: sibling.steps.flatMap((row) =>
        row.id === 'prepare'
          ? [
              {
                id: 'other-work',
                label: 'Other work',
                prompt: 'work',
                lane: 'Other',
                needs: ['plan']
              },
              { ...row, needs: ['review-plan', 'other-work'] }
            ]
          : [row]
      )
    };
    anchor.lanes!.Other = { openedAt: OPENED, pid: 31 };
    const other = record('worker', [['other-work', 'in_progress']], {
      lane: 'Other',
      anchor: 'anchor',
      opened: OPENED
    });
    await writeJson(path.join(paths.WORKFLOWS_DIR, `${sibling.id}.json`), { schema: 2, ...mixed });
    assert.equal((await workflows.readWorkflows()).length, 1, 'fixture must be runnable');
    await progress.writeProgress(anchor);
    await progress.writeProgress(other);
    assert.match(
      (await resolve(laneWait, workerBoard))[0]?.text ?? '',
      /workflow stopped or stalled/
    );
    assert.equal(next(reviewer(), [anchor, other], workerBoard, mixed).ok, false);
  });
});
