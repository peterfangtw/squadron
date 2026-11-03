import * as assert from 'node:assert/strict';
import { posixShell } from '../helpers';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mergeOnto,
  parseArgs,
  performNext,
  performOpens,
  stepPlan,
  type NextIo,
  type RunRead,
  type StepPlan,
  type Written
} from '../../cli/step';
import type { LineageEntry } from '../../core/coordination/lineage';
import type { Session } from '../../core/model';
import { FRESH_LANE_MS, NOTE_MAX } from '../../core/workflows/progress';
import { stepCommand } from '../../core/paths';
import type { Progress, StepStatus } from '../../core/workflows/progress';
import { ARMED_LANE_EMPTY, type Workflow } from '../../core/workflows/workflows';

// The program alone, as every prompt that hands `squadron-step` opens it.
const STEP_COMMAND = stepCommand('posix');

const NOW_MS = 1_700_000_000_000;

const WROTE: Written = { ok: true };

const workflow: Workflow = {
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'build', label: 'Build', prompt: 'build it' }
  ]
};

const progress = (
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): Progress => ({
  schema: 1,
  sessionId: 'sess-1',
  workflowId: 'ship',
  label: 'Ship it',
  updatedAt: NOW_MS - 5_000,
  kind: 'pipeline',
  steps: steps.map(([id, status]) => ({ id, label: id, status })),
  ...over
});

const ok = (read: RunRead, over: Partial<Parameters<typeof stepPlan>[0]> = {}): StepPlan =>
  stepPlan({
    verb: 'next',
    shell: 'posix',
    caller: 'sess-1',
    read,
    workflow,
    cwd: '/repo',
    now: NOW_MS,
    ...over
  });

const running = (
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): RunRead => ({
  state: 'ok',
  progress: progress(steps, over)
});

const code = (plan: StepPlan) => (plan.ok ? 0 : plan.code);
const reason = (plan: StepPlan) => (plan.ok ? '' : plan.reason);
const out = (plan: StepPlan) => (plan.ok ? plan.out : '');

describe('dependency registration during the host open request', () => {
  it('holds on the coordinator during the actual claim-before-reply boundary', async () => {
    const definition: Workflow = {
      id: 'ship',
      label: 'Ship',
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
          id: 'implement',
          label: 'Implement',
          prompt: 'implement',
          lane: 'Implementer',
          needs: ['review-plan']
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
    let disk = progress(
      [
        ['plan', 'completed'],
        ['finish', 'pending']
      ],
      {
        sessionId: 'anchor',
        armedAt: NOW_MS - 10_000,
        pid: 10,
        lanes: { Reviewer: { openedAt: NOW_MS - 10_000, pid: 21 } }
      }
    );
    const reviewer = progress(
      [
        ['review-plan', 'completed'],
        ['review-code', 'pending']
      ],
      {
        sessionId: 'reviewer',
        anchor: 'anchor',
        lane: 'Reviewer',
        opened: NOW_MS - 10_000
      }
    );
    const sessions = [
      session({ pid: 10, sessionId: 'anchor', status: 'busy' }),
      session({ pid: 21, sessionId: 'reviewer' })
    ];
    const next = (self: Progress, others: Progress[]) =>
      stepPlan({
        verb: 'next',
        shell: 'posix',
        caller: self.sessionId,
        read: { state: 'ok', progress: self },
        workflow: definition,
        cwd: '/repo',
        now: NOW_MS,
        sessions,
        others
      });
    const plan = next(disk, [reviewer]);
    assert.ok(plan.ok && plan.opens);
    let release!: () => void;
    let requested!: () => void;
    const reply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const opening = performOpens(
      disk,
      plan.opens,
      async () => {
        requested();
        await reply;
        return { ok: true, pid: 31, requestId: 'worker-open', windowLabel: 'window' };
      },
      NOW_MS,
      (record) => {
        disk = record;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    await started;
    try {
      assert.deepEqual(disk.lanes?.Implementer, { openedAt: NOW_MS });
      const held = next(reviewer, [disk]);
      assert.ok(held.ok && held.wait, JSON.stringify(held));
      assert.deepEqual(held.wait.members, [10]);
      assert.equal(held.opens, undefined);
    } finally {
      release();
      assert.equal((await opening).ok, true);
    }
    assert.equal(disk.lanes?.Implementer?.pid, 31);
  });
});

describe('parseArgs', () => {
  it('takes the verb positionally, before any flag', () => {
    assert.deepEqual(parseArgs(['next']), { verb: 'next', opts: {} });
    assert.deepEqual(parseArgs(['done', '--note', 'did it']), {
      verb: 'done',
      opts: { note: 'did it' }
    });
  });

  it('refuses a verb it does not have', () => {
    assert.equal(parseArgs(['skip']), undefined);
    assert.equal(parseArgs([]), undefined);
  });

  it('takes --lane and --anchor-session-id on start', () => {
    assert.deepEqual(
      parseArgs([
        'start',
        '--workflow-id',
        'ship',
        '--lane',
        's1',
        '--anchor-session-id',
        'anchor'
      ]),
      {
        verb: 'start',
        opts: { 'workflow-id': 'ship', lane: 's1', 'anchor-session-id': 'anchor' }
      }
    );
  });

  it('takes the arming token on start', () => {
    assert.deepEqual(parseArgs(['start', '--workflow-id', 'ship', '--opened', '12']), {
      verb: 'start',
      opts: { 'workflow-id': 'ship', opened: '12' }
    });
  });

  it('takes start, and --force as a valueless flag', () => {
    // `bare` must be declared or the flag swallows the next argument, which is
    // the bug `parseFlags`'s own doc block records.
    assert.deepEqual(parseArgs(['start', '--workflow-id', 'ship', '--force']), {
      verb: 'start',
      opts: { 'workflow-id': 'ship', force: '' }
    });
  });

  it('refuses a flag it does not declare, rather than ignoring it', () => {
    // `--not` used to parse perfectly and be reported as a missing argument,
    // which sends an agent looking for something it is in fact passing.
    assert.equal(parseArgs(['done', '--not', 'x']), undefined);
  });

  it('refuses --workflow, which is --workflow-id as spawn spells it', () => {
    assert.equal(parseArgs(['start', '--workflow', 'ship']), undefined);
  });

  it('refuses the verb after a flag, so one spelling is the spelling', () => {
    assert.equal(parseArgs(['--caller-session-id', 'sid', 'next']), undefined);
  });
});

describe('stepPlan refusals', () => {
  it('refuses with no caller, in its own words rather than the run’s', () => {
    // Folding this into "no run at this session" sends the agent hunting a run
    // when the problem is its environment.
    const plan = ok(running([['plan', 'pending']]), { caller: undefined });
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /--caller/);
  });

  it('refuses when no run is at this session', () => {
    const plan = ok({ state: 'missing' });
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /no workflow is running/);
  });

  it('is a 5, not a 2, when the record is there and unreadable', () => {
    // The machine is broken, not the arguments — an agent told "refused"
    // retries a correct command against a disk that is still wrong.
    const plan = ok({ state: 'unusable' });
    assert.equal(code(plan), 5);
  });

  it('refuses `next` when the definition is gone or became invalid', () => {
    const plan = ok(running([['plan', 'pending']]), { workflow: undefined });
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /no longer/);
  });
});

describe('stepPlan done', () => {
  it('records the step in flight and its note', () => {
    const plan = ok(
      running([
        ['plan', 'in_progress'],
        ['build', 'pending']
      ]),
      {
        verb: 'done',
        note: 'shipped'
      }
    );
    assert.equal(code(plan), 0);
    assert.match(out(plan), /"plan" completed/);
    const step = plan.ok ? plan.write?.steps.find((s) => s.id === 'plan') : undefined;
    assert.equal(step?.status, 'completed');
    assert.equal(step?.note, 'shipped');
  });

  it('sends the session straight back for the next step', () => {
    // The stall `planDone` is written against — and the path is absolute for
    // the reason `progressBriefing`'s own test states.
    const plan = ok(
      running([
        ['plan', 'in_progress'],
        ['build', 'pending']
      ]),
      { verb: 'done' }
    );
    assert.ok(out(plan).includes(`Run \`${STEP_COMMAND} next\``));
    assert.match(
      out(plan),
      /serves the next step, confirms the run is over, or explains why it cannot continue/
    );
  });

  it('says the same thing on the last step, because `next` owns completion', () => {
    // Byte-identical, not merely both-mention-`next`: a tally or a "that was the
    // last one" would have to come from a denominator this verb cannot read.
    const last = ok(running([['plan', 'in_progress']]), { verb: 'done' });
    const mid = ok(
      running([
        ['plan', 'in_progress'],
        ['build', 'pending']
      ]),
      { verb: 'done' }
    );
    assert.equal(out(last), out(mid));
  });

  it('refuses a note past the cap as a refusal, not a truncation', () => {
    const plan = ok(running([['plan', 'in_progress']]), {
      verb: 'done',
      note: 'x'.repeat(NOTE_MAX + 1)
    });
    assert.equal(code(plan), 2);
    assert.match(plan.ok ? '' : plan.reason, /shorter/);
  });

  it('refuses when nothing is in progress', () => {
    const plan = ok(running([['plan', 'pending']]), { verb: 'done' });
    assert.equal(code(plan), 2);
  });

  it('needs no definition, so a deleted workflow file cannot strand a finished step', () => {
    const plan = ok(running([['plan', 'in_progress']]), { verb: 'done', workflow: undefined });
    assert.equal(code(plan), 0);
  });
});

describe('stepPlan start', () => {
  const start = (read: RunRead, over: Partial<Parameters<typeof stepPlan>[0]> = {}) =>
    ok(read, { verb: 'start', workflowId: 'ship', ...over });

  it('arms a run at a session that has none', () => {
    const plan = start({ state: 'missing' });
    assert.equal(code(plan), 0);
    assert.match(out(plan), /Following "Ship it" \(ship\), 2 steps/);
    const write = plan.ok ? plan.write : undefined;
    assert.equal(write?.workflowId, 'ship');
    assert.equal(write?.sessionId, 'sess-1');
    assert.ok(
      write?.steps.every((s) => s.status === 'pending'),
      'a seed marks no cursor'
    );
    assert.equal(write?.updatedAt, NOW_MS, 'the caller’s clock, so this stays decidable');
  });

  it('writes outright rather than merging — there is nothing to merge onto', () => {
    const plan = start({ state: 'missing' });
    assert.equal(plan.ok ? plan.replace : undefined, true);
  });

  it('refuses over a live run, naming what is already there', () => {
    // Arming over a cursor somebody is working through would discard it, and
    // the record carries no history to put back.
    const plan = start(running([['plan', 'in_progress']]));
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /already at this session \(Ship it\)/);
  });

  it('replaces a live run under --force', () => {
    const plan = start(running([['plan', 'in_progress']]), { force: true });
    assert.equal(code(plan), 0);
  });

  it('replaces an unreadable record under --force, where `next` would exit 5', () => {
    assert.equal(code(start({ state: 'unusable' })), 2);
    assert.equal(code(start({ state: 'unusable' }, { force: true })), 0);
  });

  it('is a usage error with no --workflow-id, and a refusal with an unknown one', () => {
    // Told apart deliberately: 1 means fix the command line, 2 means the
    // command was fine and the machine does not have that workflow.
    assert.equal(code(start({ state: 'missing' }, { workflowId: undefined })), 1);
    assert.equal(code(start({ state: 'missing' }, { workflowId: 'nope', workflow: undefined })), 2);
    assert.match(
      reason(start({ state: 'missing' }, { workflowId: 'nope', workflow: undefined })),
      /nope/
    );
  });

  it('refuses a filename in the words spawn uses, naming the id it meant', () => {
    assert.equal(
      reason(start({ state: 'missing' }, { workflowId: 'ship.json', workflow: undefined })),
      'ship.json cannot run here: no such workflow on this machine; a workflow is named by its id ("ship"), not its file'
    );
  });

  it('tells a session with no run how to arm one, since that is the self-heal', () => {
    // The host seeds at send time, when a brand may not have stated its session
    // id yet. This refusal is what turns that into something the agent fixes.
    const plan = ok({ state: 'missing' });
    assert.ok(reason(plan).includes(`${STEP_COMMAND} start --workflow-id`));
  });
});

const lanesWf: Workflow = {
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'note', label: 'Note', prompt: 'note it', needs: ['plan'] },
    {
      id: 'a',
      label: 'A',
      prompt: 'do a',
      lane: 's1',
      needs: ['plan'],
      brand: 'claude',
      model: 'opus'
    },
    {
      id: 'b',
      label: 'B',
      prompt: 'do b',
      lane: 's2',
      needs: ['plan'],
      brand: 'grok',
      model: 'grok-3',
      effort: 'high'
    },
    { id: 'join', label: 'Join', prompt: 'join them', needs: ['a', 'b', 'note'] }
  ]
};

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/repo',
  name: 'card',
  status: 'busy',
  hasCommand: true,
  startedAt: 0,
  updatedAt: 0,
  transcript: '/tmp/t.jsonl',
  source: 'owned',
  windowId: 'w1',
  ...over
});

const IDLE = { status: 'idle', hasCommand: false } as const;

const anchorBoard = [
  session({ pid: 10, sessionId: 'anchor', name: 'anchor' }),
  session({ pid: 21, sessionId: 'sess-s1', name: 's1', parentSessionId: 'anchor' }),
  session({ pid: 22, sessionId: 'sess-s2', name: 's2', parentSessionId: 'anchor' })
];

/** When the anchor opened its lanes in these fixtures — old enough not to be fresh. */
const OPENED = NOW_MS - 10_000;

/** A lane record of the arming whose token is {@link OPENED}. */
const laneRun = (
  lane: string,
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
) =>
  progress(steps, { sessionId: `sess-${lane}`, lane, anchor: 'anchor', opened: OPENED, ...over });

describe('next in a file with lanes', () => {
  const anchor = (
    steps: readonly [string, StepStatus][],
    over: Partial<Progress> = {}
  ): { state: 'ok'; progress: Progress } => ({
    state: 'ok',
    progress: progress(steps, { sessionId: 'anchor', pid: 10, ...over })
  });

  const nextAt = (read: RunRead, over: Partial<Parameters<typeof stepPlan>[0]> = {}): StepPlan =>
    stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: read.state === 'ok' ? read.progress.sessionId : 'anchor',
      read,
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: anchorBoard,
      pid: 10,
      ...over
    });

  it('builds the spawn request for every ready lane from its step', () => {
    const read = anchor([
      ['plan', 'completed'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    const plan = nextAt(read);
    assert.equal(code(plan), 0);
    assert.ok(plan.ok);
    const s1 = plan.opens?.[0]?.request;
    const s2 = plan.opens?.[1]?.request;
    assert.equal(s1?.name, 's1');
    assert.equal(s1?.cwd, '/repo');
    assert.equal(s1?.parentSessionId, 'anchor');
    assert.equal(s1?.workflowId, undefined);
    assert.equal(s1?.brand, 'claude');
    assert.equal(s1?.model, 'opus');
    assert.ok(
      s1?.prompt.includes(
        `${STEP_COMMAND} start --workflow-id ship --lane s1 --anchor-session-id anchor`
      )
    );
    assert.ok(s1?.prompt.includes(`${STEP_COMMAND} next`));
    assert.equal(s2?.brand, 'grok');
    assert.equal(s2?.model, 'grok-3');
    assert.equal(s2?.effort, 'high');
    assert.equal(s2?.name, 's2');
  });

  it('writes the first lane’s pid before it opens the second', async () => {
    const read = anchor([
      ['plan', 'completed'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    const plan = nextAt(read);
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const writes: Progress[] = [];
    let calls = 0;
    const opened = await performOpens(
      plan.write ?? read.progress,
      plan.opens,
      (request) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(writes.length, 1);
          assert.deepEqual(writes[0]?.lanes, { s1: { openedAt: NOW_MS } });
        }
        if (calls === 2) {
          assert.equal(writes.length, 3);
          assert.equal(writes[1]?.lanes?.s1?.pid, 11);
          assert.equal(writes[1]?.lanes?.s2, undefined);
          assert.deepEqual(writes[2]?.lanes?.s2, { openedAt: NOW_MS });
        }
        return Promise.resolve({
          ok: true as const,
          pid: request.name === 's1' ? 11 : 22,
          windowLabel: 'w'
        });
      },
      NOW_MS,
      (next) => {
        writes.push(next);
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(writes.at(-1))
    );
    assert.equal(opened.ok, true);
    assert.equal(opened.ok ? opened.progress.lanes?.s1?.pid : undefined, 11);
    assert.equal(opened.ok ? opened.progress.lanes?.s2?.pid : undefined, 22);
    assert.equal(writes.length, 4);
  });

  it('opens a lane whose name is inherited from Object.prototype', async () => {
    // `builder` is opened first, so `lanes` exists. A bare read of
    // `constructor`, `toString` or `__proto__` then sees the prototype and
    // `performOpens` skips a lane readiness already scheduled.
    const names = ['builder', 'constructor', 'toString', '__proto__'] as const;
    const workflow: Workflow = {
      id: 'ship',
      label: 'Ship it',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        ...names.map((lane) => ({
          id: lane,
          label: lane,
          prompt: lane,
          lane,
          needs: ['plan']
        })),
        { id: 'join', label: 'Join', prompt: 'join', needs: [...names] }
      ]
    };
    const plan = stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: anchor([
        ['plan', 'completed'],
        ['join', 'pending']
      ]),
      workflow,
      cwd: '/repo',
      now: NOW_MS,
      sessions: anchorBoard,
      pid: 10
    });
    assert.deepEqual(plan.ok ? plan.opens?.map((start) => start.lane) : [], [...names]);
    if (!plan.ok || !plan.opens) throw new Error('expected every ready lane');
    const pids = new Map<string, number>(names.map((lane, i) => [lane, 11 + i]));
    const seen: string[] = [];
    const writes: Progress[] = [];
    const opened = await performOpens(
      plan.write ??
        anchor([
          ['plan', 'completed'],
          ['join', 'pending']
        ]).progress,
      plan.opens,
      (request) => {
        seen.push(request.name ?? '');
        return Promise.resolve({
          ok: true as const,
          pid: pids.get(request.name ?? '') ?? 0,
          windowLabel: 'w'
        });
      },
      NOW_MS,
      (next) => {
        writes.push(next);
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(writes.at(-1))
    );
    assert.deepEqual(seen, [...names]);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const lanes = opened.progress.lanes ?? {};
    for (const name of names) {
      assert.equal(Object.hasOwn(lanes, name), true, name);
      assert.equal(lanes[name]?.pid, pids.get(name));
    }
  });
});

describe('stepPlan start lanes', () => {
  const anchorRun = (over: Partial<Progress> = {}): RunRead => ({
    state: 'ok',
    progress: progress([['plan', 'in_progress']], {
      sessionId: 'anchor',
      lanes: { s1: { openedAt: OPENED } },
      ...over
    })
  });

  const startLane = (over: Partial<Parameters<typeof stepPlan>[0]> = {}): StepPlan =>
    stepPlan({
      verb: 'start',
      shell: 'posix',
      caller: 'sess-s1',
      read: { state: 'missing' },
      workflow: lanesWf,
      workflowId: 'ship',
      cwd: '/repo',
      now: NOW_MS,
      lane: 's1',
      anchor: 'anchor',
      opened: OPENED,
      anchorRun: anchorRun(),
      ...over
    });

  it('seeds only the named lane and records its anchor', () => {
    const plan = startLane();
    assert.equal(code(plan), 0);
    assert.match(out(plan), /Following "Ship it" \(ship\), 1 steps/);
    const write = plan.ok ? plan.write : undefined;
    assert.deepEqual(
      write?.steps.map((step) => step.id),
      ['a']
    );
    assert.equal(write?.lane, 's1');
    assert.equal(write?.anchor, 'anchor');
    assert.equal(write?.opened, OPENED);
    assert.equal(plan.ok ? plan.replace : undefined, true);
  });

  it('seeds only the armed steps of a file with lanes', () => {
    const plan = startLane({
      shell: 'posix',
      caller: 'anchor',
      lane: undefined,
      anchor: undefined,
      anchorRun: undefined
    });
    const write = plan.ok ? plan.write : undefined;
    assert.deepEqual(
      write?.steps.map((step) => step.id),
      ['plan', 'note', 'join']
    );
    assert.equal(write?.lane, undefined);
    assert.equal(write?.anchor, undefined);
    assert.match(out(plan), /3 steps/);
  });

  it('refuses to arm a file whose armed session would hold no step', () => {
    const lanesOnly: Workflow = {
      ...lanesWf,
      steps: lanesWf.steps.filter((step) => step.lane !== undefined)
    };
    const plan = startLane({
      shell: 'posix',
      caller: 'anchor',
      workflow: lanesOnly,
      lane: undefined,
      anchor: undefined,
      anchorRun: undefined
    });
    assert.equal(code(plan), 2);
    assert.equal(reason(plan), ARMED_LANE_EMPTY);
  });

  it('refuses to arm a file whose session step waits on nothing', () => {
    const unwired: Workflow = {
      ...lanesWf,
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 's1' }
      ]
    };
    const plan = startLane({
      shell: 'posix',
      caller: 'anchor',
      workflow: unwired,
      lane: undefined,
      anchor: undefined,
      anchorRun: undefined
    });
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /^c opens s1 with no step wired before it/);
  });

  it('refuses a lane start the anchor cannot own', () => {
    assert.equal(code(startLane({ anchor: undefined, anchorRun: undefined })), 1);
    assert.equal(code(startLane({ anchorRun: { state: 'missing' } })), 2);
    assert.equal(code(startLane({ anchorRun: { state: 'unusable' } })), 5);
    assert.equal(code(startLane({ anchorRun: anchorRun({ workflowId: 'other' }) })), 2);
    assert.match(reason(startLane({ lane: 'nope' })), /no lane nope/);
  });
});

describe('armings of a file with lanes', () => {
  const anchor = (over: Partial<Progress> = {}): Progress =>
    progress(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { sessionId: 'anchor', pid: 10, ...over }
    );
  const nextAt = (self: Progress, over: Partial<Parameters<typeof stepPlan>[0]> = {}) =>
    stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: self.sessionId,
      read: { state: 'ok', progress: self },
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: anchorBoard,
      ...over
    });

  it('puts the arming token in the lane’s command, quoted so a spaced name is one word', (t) => {
    const shell = posixShell();
    if (shell.skip !== false) {
      t.skip(shell.skip);
      return;
    }
    const spaced: Workflow = {
      ...lanesWf,
      steps: lanesWf.steps.map((step) =>
        step.lane === 's1' ? { ...step, lane: 'auth review' } : step
      )
    };
    const plan = nextAt(anchor(), { workflow: spaced, origin: 'root-sess' });
    const start = plan.ok ? plan.opens?.find((open) => open.lane === 'auth review') : undefined;
    assert.equal(start?.openedAt, NOW_MS);
    assert.equal(start?.request.originSessionId, 'root-sess');
    // The coordinator wrote this prompt, so the lane's dock names it as a peer.
    assert.equal(start?.request.from, 'anchor');
    const command = /`([^`]*start[^`]*)`/.exec(start?.request.prompt ?? '')?.[1] ?? '';
    const words = execFileSync(shell.bin, ['-c', `set -- ${command}; printf '%s\\n' "$@"`], {
      encoding: 'utf8'
    }).split('\n');
    assert.deepEqual(words.slice(1, 9), [
      'start',
      '--workflow-id',
      'ship',
      '--lane',
      'auth review',
      '--anchor-session-id',
      'anchor',
      '--opened'
    ]);
    assert.equal(words[9], String(NOW_MS));
  });

  it('keeps the claim of a lane whose open was never answered', async () => {
    const plan = nextAt(anchor());
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    let disk = anchor();
    const failed = await performOpens(
      disk,
      plan.opens,
      () =>
        Promise.resolve({
          ok: false as const,
          code: 4 as const,
          reason: 'silent',
          requestId: 'req-1'
        }),
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(failed.ok, false);
    // What the open left on disk, not a record written here to match.
    const after = disk;
    assert.deepEqual(after.lanes, { s1: { openedAt: NOW_MS, requestId: 'req-1' } });
  });

  it('drops the entry of an open that was refused, so the next call may try again', async () => {
    const plan = nextAt(anchor());
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const writes: Progress[] = [];
    const refused = await performOpens(
      anchor(),
      plan.opens,
      () => Promise.resolve({ ok: false as const, code: 2 as const, reason: 'no such model' }),
      NOW_MS,
      (next) => {
        writes.push(next);
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(writes.at(-1))
    );
    assert.equal(refused.ok, false);
    assert.deepEqual(writes[0]?.lanes, { s1: { openedAt: NOW_MS } });
    assert.deepEqual(writes.at(-1)?.lanes, {});
  });

  it('does not open a lane another call claimed while this one was deciding', async () => {
    const plan = nextAt(anchor());
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    // The other call wrote s1 first; this one planned from the record before it.
    let disk = anchor({ lanes: { s1: { openedAt: NOW_MS - 5 } } });
    const opened: string[] = [];
    const result = await performOpens(
      anchor(),
      plan.opens,
      (request) => {
        opened.push(request.name ?? '');
        return Promise.resolve({ ok: true as const, pid: 40, windowLabel: 'w' });
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.deepEqual(opened, ['s2']);
    assert.deepEqual(result.ok ? result.progress.lanes?.s1 : undefined, { openedAt: NOW_MS - 5 });
  });

  it('stops before the spawn when the run was cancelled after the lane was claimed', async () => {
    const plan = nextAt(anchor());
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    let disk = anchor();
    let spawned = 0;
    const result = await performOpens(
      disk,
      plan.opens,
      () => {
        spawned += 1;
        return Promise.resolve({ ok: true as const, pid: 40, windowLabel: 'w' });
      },
      NOW_MS,
      (next) => {
        // The reader presses Cancel the moment the claim lands.
        disk = { ...next, cancelledAt: NOW_MS };
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(spawned, 0);
    assert.equal(result.ok ? 0 : result.code, 2);
  });

  it('refuses a lane start with a stale or missing token, or a cancelled anchor', () => {
    const start = (over: Partial<Parameters<typeof stepPlan>[0]>) =>
      stepPlan({
        verb: 'start',
        shell: 'posix',
        caller: 'sess-s1',
        read: { state: 'missing' },
        workflow: lanesWf,
        workflowId: 'ship',
        cwd: '/repo',
        now: NOW_MS,
        lane: 's1',
        anchor: 'anchor',
        opened: OPENED,
        anchorRun: { state: 'ok', progress: anchor({ lanes: { s1: { openedAt: OPENED } } }) },
        ...over
      });
    assert.equal(code(start({})), 0);
    assert.equal(code(start({ opened: undefined })), 1);
    assert.match(reason(start({ opened: OPENED - 1 })), /belongs to an earlier one/);
    const cancelled = start({
      anchorRun: {
        state: 'ok',
        progress: anchor({ lanes: { s1: { openedAt: OPENED } }, cancelledAt: NOW_MS })
      }
    });
    assert.equal(code(cancelled), 2);
    assert.match(reason(cancelled), /cancelled/);
  });
});

describe('a lane whose picked model never starts', () => {
  const anchorSteps: [string, StepStatus][] = [
    ['plan', 'completed'],
    ['note', 'pending'],
    ['join', 'pending']
  ];
  const anchorRecord = (over: Partial<Progress> = {}) =>
    progress(anchorSteps, { sessionId: 'anchor', pid: 10, ...over });
  const effortBoard = [
    session({ pid: 10, sessionId: 'anchor', name: 'anchor', effort: 'xhigh' }),
    session({ pid: 21, sessionId: 'sess-s1', name: 's1', parentSessionId: 'anchor' }),
    session({ pid: 22, sessionId: 'sess-s2', name: 's2', parentSessionId: 'anchor' })
  ];
  const openPlan = () =>
    stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: anchorRecord() },
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: effortBoard
    });

  it('retries a pick refusal once, on the anchor’s effort, and remembers it', async () => {
    const plan = openPlan();
    assert.ok(plan.ok && plan.opens);
    const s2 = plan.opens?.find((start) => start.lane === 's2');
    assert.equal(s2?.request.effort, 'high');
    assert.equal(s2?.request.model, 'grok-3');
    assert.deepEqual(s2?.fallback, { effort: 'xhigh' });
    assert.equal(s2?.fellBack, undefined);
    if (!s2) throw new Error('expected s2');
    const calls: { model?: string; brand?: string; effort?: string; prompt: string }[] = [];
    let disk = anchorRecord();
    const opened = await performOpens(
      disk,
      [s2],
      (request) => {
        calls.push(request);
        if (calls.length === 1) {
          return Promise.resolve({
            ok: false as const,
            code: 2 as const,
            reason: 'no such model',
            cause: 'pick' as const
          });
        }
        return Promise.resolve({
          ok: true as const,
          pid: 22,
          windowLabel: 'w',
          requestId: 'req-2'
        });
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.brand, undefined);
    assert.equal(calls[1]?.model, undefined);
    assert.equal(calls[1]?.effort, 'xhigh');
    assert.match(calls[1]?.prompt ?? '', new RegExp(`--opened ${NOW_MS + 1}`));
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.ok ? opened.notices : [], [
      "s2: grok-3 could not start (no such model) — opened on this session's model instead"
    ]);
    assert.deepEqual(disk.lanes?.s2, {
      openedAt: NOW_MS + 1,
      fellBack: true,
      pid: 22,
      requestId: 'req-2'
    });
  });

  it('does not retry a fleet refusal', async () => {
    const plan = openPlan();
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const s1 = plan.opens.find((start) => start.lane === 's1');
    if (!s1) throw new Error('expected s1');
    let calls = 0;
    const writes: Progress[] = [];
    const refused = await performOpens(
      anchorRecord(),
      [s1],
      () => {
        calls += 1;
        return Promise.resolve({
          ok: false as const,
          code: 2 as const,
          reason: '15 live sessions'
        });
      },
      NOW_MS,
      (next) => {
        writes.push(next);
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(writes.at(-1))
    );
    assert.equal(calls, 1);
    assert.equal(refused.ok, false);
    assert.deepEqual(writes.at(-1)?.lanes, {});
  });

  it('keeps fellBack when the retry is refused too', async () => {
    const plan = openPlan();
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const s2 = plan.opens.find((start) => start.lane === 's2');
    if (!s2) throw new Error('expected s2');
    let calls = 0;
    let disk = anchorRecord();
    const refused = await performOpens(
      disk,
      [s2],
      () => {
        calls += 1;
        return Promise.resolve({
          ok: false as const,
          code: 2 as const,
          reason: 'no such model',
          cause: 'pick' as const
        });
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(calls, 2);
    const said =
      "s2: grok-3 could not start (no such model), and neither could this session's model (no such model)";
    assert.deepEqual(refused, { ok: false, code: 2, reason: said, opened: [], notices: [] });
    assert.deepEqual(disk.lanes?.s2, { openedAt: NOW_MS + 1, fellBack: true, refused: said });
  });

  it('names a catalog model the way the model menu does', async () => {
    const wf: Workflow = {
      ...lanesWf,
      steps: lanesWf.steps.map((step) =>
        step.lane === 's1' ? { ...step, model: 'claude-opus-5-5' } : step
      )
    };
    const plan = stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: anchorRecord() },
      workflow: wf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: effortBoard
    });
    const s1 = plan.ok ? plan.opens?.find((start) => start.lane === 's1') : undefined;
    if (!s1) throw new Error('expected s1');
    assert.equal(s1.request.model, 'claude-opus-5-5');
    let disk = anchorRecord();
    let calls = 0;
    const opened = await performOpens(
      disk,
      [s1],
      () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                ok: false as const,
                code: 2 as const,
                reason: 'not signed in',
                cause: 'pick' as const
              }
            : { ok: true as const, pid: 21, windowLabel: 'w', requestId: 'req-1' }
        );
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.deepEqual(opened.ok ? opened.notices : [], [
      "s1: Opus 5.5 could not start (not signed in) — opened on this session's model instead"
    ]);
  });

  it('drops the claim when the retry is refused for something other than the pick', async () => {
    const plan = openPlan();
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const s2 = plan.opens.find((start) => start.lane === 's2');
    if (!s2) throw new Error('expected s2');
    let calls = 0;
    let disk = anchorRecord();
    const refused = await performOpens(
      disk,
      [s2],
      () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                ok: false as const,
                code: 2 as const,
                reason: 'no such model',
                cause: 'pick' as const
              }
            : { ok: false as const, code: 2 as const, reason: '15 live sessions' }
        );
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(calls, 2);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, '15 live sessions');
    assert.equal(disk.lanes?.s2, undefined);
    const again = stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: disk },
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: effortBoard
    });
    const opened = again.ok ? again.opens?.find((start) => start.lane === 's2') : undefined;
    assert.equal(opened?.request.model, 'grok-3');
    assert.equal(opened?.fellBack, undefined);
  });

  it('keeps a silent retry, with the requestId that finds it', async () => {
    const plan = openPlan();
    if (!plan.ok || !plan.opens) throw new Error('expected lanes to open');
    const s2 = plan.opens.find((start) => start.lane === 's2');
    if (!s2) throw new Error('expected s2');
    let calls = 0;
    let disk = anchorRecord();
    const refused = await performOpens(
      disk,
      [s2],
      () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                ok: false as const,
                code: 2 as const,
                reason: 'no such model',
                cause: 'pick' as const
              }
            : {
                ok: false as const,
                code: 4 as const,
                reason: 'no reply',
                requestId: 'req-silent'
              }
        );
      },
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(calls, 2);
    assert.equal(refused.ok, false);
    assert.deepEqual(disk.lanes?.s2, {
      openedAt: NOW_MS + 1,
      fellBack: true,
      requestId: 'req-silent'
    });
  });

  const idleChild = (over: Partial<Session> = {}) =>
    session({
      pid: 21,
      sessionId: 'sess-s1',
      name: 's1',
      parentSessionId: 'anchor',
      ...IDLE,
      ...over
    });
  const recordless = (over: Partial<Progress> = {}) =>
    anchorRecord({
      lanes: { s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' } },
      ...over
    });
  const atIdle = (sessions: Session[], self = recordless()) =>
    stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: { state: 'ok', progress: self },
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions,
      lineage: new Map([[21, { requestId: 'req-s1', spawnedAt: 0 }]])
    });

  it('builds the fallback reopen of an idle recordless lane on the anchor’s effort', async () => {
    const self = recordless();
    const plan = atIdle([
      session({ pid: 10, sessionId: 'anchor', effort: 'xhigh', ...IDLE }),
      idleChild()
    ]);
    assert.equal(code(plan), 0);
    assert.ok(plan.ok);
    const start = plan.opens?.[0];
    assert.equal(start?.request.brand, undefined);
    assert.equal(start?.request.model, undefined);
    assert.equal(start?.request.effort, 'xhigh');
    assert.equal(start?.openedAt, NOW_MS);
    assert.equal(start?.fellFrom, 's1: opus could not start (never started its lane)');
    if (!start) throw new Error('expected a reopen');
    // Disk still holds the failed claim. The reopen has to replace it: sync
    // reads that claim back, and a skip would leave the child in place.
    let disk = self;
    const opened = await performOpens(
      plan.write ?? self,
      [start],
      () => Promise.resolve({ ok: true as const, pid: 31, windowLabel: 'w', requestId: 'req-new' }),
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(opened.ok, true);
    assert.deepEqual(disk.lanes?.s1, {
      openedAt: NOW_MS,
      fellBack: true,
      pid: 31,
      requestId: 'req-new'
    });
  });

  it('drops a fallback reopen the window refused', async () => {
    const self = recordless();
    const plan = atIdle([
      session({ pid: 10, sessionId: 'anchor', effort: 'xhigh', ...IDLE }),
      idleChild()
    ]);
    const start = plan.ok ? plan.opens?.[0] : undefined;
    if (!start) throw new Error('expected a reopen');
    let disk = self;
    const refused = await performOpens(
      plan.ok ? (plan.write ?? self) : self,
      [start],
      () => Promise.resolve({ ok: false as const, code: 3 as const, reason: 'no window' }),
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 3);
    assert.equal(disk.lanes?.s1, undefined);
  });

  it('keeps fellBack when a fallback reopen is refused for the pick', async () => {
    const self = recordless();
    const plan = atIdle([
      session({ pid: 10, sessionId: 'anchor', effort: 'xhigh', ...IDLE }),
      idleChild()
    ]);
    const start = plan.ok ? plan.opens?.[0] : undefined;
    if (!start) throw new Error('expected a reopen');
    let disk = self;
    const refused = await performOpens(
      plan.ok ? (plan.write ?? self) : self,
      [start],
      () =>
        Promise.resolve({
          ok: false as const,
          code: 2 as const,
          reason: 'no such effort',
          cause: 'pick' as const
        }),
      NOW_MS,
      (next) => {
        disk = next;
        return Promise.resolve(WROTE);
      },
      () => Promise.resolve(disk)
    );
    const said =
      "s1: opus could not start (never started its lane), and neither could this session's model (no such effort)";
    assert.deepEqual(refused, { ok: false, code: 2, reason: said, opened: [], notices: [] });
    assert.deepEqual(disk.lanes?.s1, { openedAt: NOW_MS, fellBack: true, refused: said });
  });

  it('refuses to end a pid that is not this session’s child', () => {
    const plan = atIdle([
      session({ pid: 10, sessionId: 'anchor', ...IDLE }),
      idleChild({ parentSessionId: undefined, name: 'stranger' })
    ]);
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /not below you/);
  });

  it('refuses ending its own session, and the reason names no --self', () => {
    // The lane's recorded pid is this session. The plan refuses that, and
    // the flag a direct `squadron-end` would name is not this verb's.
    const plan = stepPlan({
      verb: 'next',
      shell: 'posix',
      caller: 'anchor',
      read: {
        state: 'ok',
        progress: recordless({
          lanes: { s1: { pid: 10, openedAt: OPENED, requestId: 'req-s1' } }
        })
      },
      workflow: lanesWf,
      cwd: '/repo',
      now: NOW_MS,
      sessions: [session({ pid: 10, sessionId: 'anchor', ...IDLE })],
      lineage: new Map([[10, { requestId: 'req-s1', spawnedAt: 0 }]])
    });
    assert.equal(code(plan), 2);
    assert.match(reason(plan), /your own session/);
    assert.doesNotMatch(reason(plan), /--self/);
  });
});

describe('performNext: plan, end and open, then plan again', () => {
  /**
   * The effects over one `disk`, in the `performOpens` tests' style. `log` is
   * every effect in the order it ran; `pids` is what each lane's open answers.
   */
  const harness = (record: Progress, pids: Record<string, number | undefined> = {}) => {
    const h = {
      disk: record as Progress | undefined,
      log: [] as string[],
      lineage: new Map<number, LineageEntry>(),
      lineageReads: 0,
      requestIds: {} as Record<string, string>
    };
    const io: NextIo = {
      closeOne: (member) => {
        h.log.push(`close ${member.pid}`);
        return Promise.resolve({ ok: true });
      },
      openSession: (request) => {
        const lane = request.name ?? '';
        h.log.push(`open ${lane}`);
        const pid = pids[lane];
        const requestId = h.requestIds[lane];
        return Promise.resolve({
          ok: true as const,
          windowLabel: 'w',
          ...(pid === undefined ? {} : { pid }),
          ...(requestId === undefined ? {} : { requestId })
        });
      },
      commit: (planned) => {
        h.log.push('commit');
        h.disk = h.disk ? mergeOnto(h.disk, planned) : planned;
        return Promise.resolve(WROTE);
      },
      replace: (planned) => {
        h.log.push('replace');
        h.disk = planned;
        return Promise.resolve(WROTE);
      },
      writeWait: () => {
        h.log.push('wait');
        return Promise.resolve(true);
      },
      reread: () => Promise.resolve(h.disk),
      readLineage: () => {
        h.lineageReads += 1;
        return Promise.resolve(h.lineage);
      }
    };
    return { h, io };
  };

  const fieldsAt = (
    record: Progress,
    over: Partial<Parameters<typeof performNext>[0]> = {}
  ): Parameters<typeof performNext>[0] => ({
    verb: 'next',
    shell: 'posix',
    caller: 'anchor',
    read: { state: 'ok', progress: record },
    workflow: lanesWf,
    cwd: '/repo',
    now: NOW_MS,
    others: [],
    sessions: anchorBoard,
    pid: 10,
    ...over
  });

  const anchorAt = (steps: readonly [string, StepStatus][], over: Partial<Progress> = {}) =>
    progress(steps, { sessionId: 'anchor', pid: 10, ...over });

  /** Refuses the first commit `failing` matches, as `commit` itself would. */
  const failCommit = (io: NextIo, failing: (planned: Progress) => boolean, failure: Written) => {
    const commit = io.commit;
    io.commit = (planned) => (failing(planned) ? Promise.resolve(failure) : commit(planned));
  };

  const CANT_WRITE = { ok: false, code: 5, reason: 'the record could not be written' } as const;
  const CANCELLED = {
    ok: false,
    code: 2,
    reason: 'this run was cancelled from the panel'
  } as const;

  it('plans again at the same now, so lanes the board has not seen yet are not read as gone', async () => {
    const record = anchorAt([
      ['plan', 'completed'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    // 31 and 32 are not on `anchorBoard`: the board was loaded before the spawns.
    const { h, io } = harness(record, { s1: 31, s2: 32 });
    const done = await performNext(fieldsAt(record), io);
    assert.ok(done.ok, JSON.stringify(done));
    assert.match(done.out, /^Opened s1 \(pid 31\), s2 \(pid 32\)\.\nStep 2 of 3/);
    assert.deepEqual(h.log, [
      'commit',
      'open s1',
      'commit',
      'commit',
      'open s2',
      'commit',
      'commit'
    ]);
    assert.equal(h.disk?.updatedAt, NOW_MS);
    assert.equal(h.disk?.steps.find((step) => step.id === 'note')?.status, 'in_progress');
    // The first plan had no lane to look up; the second reads lineage afresh.
    assert.equal(h.lineageReads, 1);
    // Planned a moment later, the same record falls both lanes back.
    if (!h.disk) throw new Error('expected a record');
    const later = stepPlan({
      ...fieldsAt(h.disk),
      now: NOW_MS + FRESH_LANE_MS,
      lineage: h.lineage
    });
    assert.deepEqual(later.ok ? later.opens?.map((start) => start.fellBack) : [], [true, true]);
  });

  it('fills an open answered without a pid from the lineage it reads again', async () => {
    const record = anchorAt([
      ['plan', 'completed'],
      ['note', 'pending'],
      ['join', 'pending']
    ]);
    const { h, io } = harness(record, { s2: 32 });
    h.requestIds.s1 = 'req-s1';
    // The window writes the spawn's lineage as it opens, then never names the pid.
    const open = io.openSession;
    io.openSession = (request) => {
      if (request.name === 's1') {
        h.lineage.set(41, { schema: 1, requestId: 'req-s1', spawnedAt: NOW_MS, cwd: '/repo' });
      }
      return open(request);
    };
    const done = await performNext(fieldsAt(record), io);
    assert.ok(done.ok, JSON.stringify(done));
    assert.match(done.out, /^Opened s1 \(pid not yet known\), s2 \(pid 32\)\./);
    assert.equal(h.disk?.lanes?.s1?.pid, 41);
    assert.equal(h.disk?.lanes?.s1?.requestId, 'req-s1');
  });

  it('writes nothing when a second next finds the run unchanged', async () => {
    const record = anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { lanes: { s1: { pid: 21, openedAt: NOW_MS }, s2: { pid: 22, openedAt: NOW_MS } } }
    );
    const { h, io } = harness(record);
    const first = await performNext(fieldsAt(record), io);
    assert.ok(first.ok, JSON.stringify(first));
    assert.match(first.out, /Step 2 of 3/);
    assert.deepEqual(h.log, ['commit']);
    if (!h.disk) throw new Error('expected a record');
    const again = await performNext(fieldsAt(h.disk), io);
    assert.ok(again.ok, JSON.stringify(again));
    assert.match(again.out, /Step 2 of 3/);
    assert.deepEqual(h.log, ['commit']);
  });

  it('writes the wait before it commits the record', async () => {
    // No pid on the record, so the board's is stamped and there is a write.
    const record = progress(
      [
        ['plan', 'completed'],
        ['note', 'completed'],
        ['join', 'pending']
      ],
      {
        sessionId: 'anchor',
        lanes: { s1: { pid: 21, openedAt: OPENED }, s2: { pid: 22, openedAt: OPENED } }
      }
    );
    const { h, io } = harness(record);
    const done = await performNext(
      fieldsAt(record, {
        others: [laneRun('s1', [['a', 'in_progress']]), laneRun('s2', [['b', 'completed']])]
      }),
      io
    );
    assert.ok(done.ok, JSON.stringify(done));
    assert.match(done.out, /registered a wait over 1 session: 21/);
    assert.ok(done.out.includes(`When you are woken, run \`${STEP_COMMAND} next\``));
    assert.deepEqual(h.log, ['wait', 'commit']);
  });

  it('opens in the same call what the second plan finds ready', async () => {
    // s1 opened on its pick and its session is gone; s2 was never opened. The
    // first plan falls s1 back, and only the second sees s2.
    const record = anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { lanes: { s1: { pid: 21, openedAt: OPENED } } }
    );
    const board = [session({ pid: 10, sessionId: 'anchor', name: 'anchor' })];
    const { h, io } = harness(record, { s1: 31, s2: 32 });
    const done = await performNext(fieldsAt(record, { sessions: board }), io);
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual(
      h.log.filter((effect) => effect !== 'commit'),
      ['open s1', 'open s2']
    );
    assert.match(
      done.out,
      /^s1: opus could not start \(never started its lane\) — opened on this session's model instead\nOpened s1 \(pid 31\), s2 \(pid 32\)\.\nStep 2 of 3/
    );
    assert.deepEqual(h.disk?.lanes?.s2, { openedAt: NOW_MS, pid: 32 });
  });

  it('ends a child that never started its lane before it opens that lane again', async () => {
    const record = anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { lanes: { s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' } } }
    );
    const board = [
      session({ pid: 10, sessionId: 'anchor', name: 'anchor' }),
      session({ pid: 21, sessionId: 'sess-s1', name: 's1', parentSessionId: 'anchor', ...IDLE })
    ];
    const { h, io } = harness(record, { s1: 31, s2: 32 });
    h.lineage.set(21, { schema: 1, requestId: 'req-s1', spawnedAt: 0, cwd: '/repo' });
    const done = await performNext(fieldsAt(record, { sessions: board }), io);
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual(
      h.log.filter((effect) => effect !== 'commit'),
      ['close 21', 'open s1', 'open s2']
    );
  });

  it('refuses with 4 when the window never answers the end, and opens nothing', async () => {
    const record = anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { lanes: { s1: { pid: 21, openedAt: OPENED, requestId: 'req-s1' } } }
    );
    const board = [
      session({ pid: 10, sessionId: 'anchor', name: 'anchor' }),
      session({ pid: 21, sessionId: 'sess-s1', name: 's1', parentSessionId: 'anchor', ...IDLE })
    ];
    const { h, io } = harness(record, { s1: 31 });
    h.lineage.set(21, { schema: 1, requestId: 'req-s1', spawnedAt: 0, cwd: '/repo' });
    io.closeOne = () => Promise.resolve({ ok: false, kind: 'silent', reason: 's1: no answer' });
    const done = await performNext(fieldsAt(record, { sessions: board }), io);
    assert.deepEqual(done, { ok: false, code: 4, reason: 's1: no answer' });
    assert.deepEqual(h.log, []);
  });

  it('still names what an earlier pass opened when a later one is refused', async () => {
    const record = anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      { lanes: { s1: { pid: 21, openedAt: OPENED } } }
    );
    const board = [session({ pid: 10, sessionId: 'anchor', name: 'anchor' })];
    const { h, io } = harness(record, { s1: 31 });
    const open = io.openSession;
    io.openSession = (request) =>
      request.name === 's2'
        ? Promise.resolve({ ok: false as const, code: 2 as const, reason: 'fleet is full' })
        : open(request);
    const done = await performNext(fieldsAt(record, { sessions: board }), io);
    assert.equal(done.ok, false);
    assert.equal(
      done.ok ? '' : done.reason,
      "s1: opus could not start (never started its lane) — opened on this session's model instead\nOpened s1 (pid 31).\nfleet is full"
    );
    assert.equal(h.disk?.lanes?.s1?.pid, 31);
  });

  const threeSteps = (over: Partial<Progress> = {}) =>
    anchorAt(
      [
        ['plan', 'completed'],
        ['note', 'pending'],
        ['join', 'pending']
      ],
      over
    );

  it('names a lane opened earlier in the same pass when a later open is refused', async () => {
    const record = threeSteps();
    const { h, io } = harness(record, { s1: 31 });
    const open = io.openSession;
    io.openSession = (request) =>
      request.name === 's2'
        ? Promise.resolve({ ok: false as const, code: 2 as const, reason: 'fleet is full' })
        : open(request);
    const done = await performNext(fieldsAt(record), io);
    assert.deepEqual(done, { ok: false, code: 2, reason: 'Opened s1 (pid 31).\nfleet is full' });
    assert.equal(h.disk?.lanes?.s1?.pid, 31);
  });

  it('keeps a same-pass fallback notice when a later open is refused', async () => {
    const record = threeSteps();
    const { io } = harness(record, { s1: 31 });
    const open = io.openSession;
    io.openSession = (request) => {
      if (request.name === 's2') {
        return Promise.resolve({ ok: false as const, code: 2 as const, reason: 'fleet is full' });
      }
      return request.model === undefined
        ? open(request)
        : Promise.resolve({
            ok: false as const,
            code: 2 as const,
            cause: 'pick' as const,
            reason: 'no such model'
          });
    };
    const done = await performNext(fieldsAt(record), io);
    assert.deepEqual(done, {
      ok: false,
      code: 2,
      reason:
        "s1: opus could not start (no such model) — opened on this session's model instead\nOpened s1 (pid 31).\nfleet is full"
    });
  });

  // These prove a refused write reaches the caller. `commit`'s own refusals are
  // `step_race.test.ts`, against the real file.
  for (const { name, failing, failure, opened, tried } of [
    {
      name: 'the pid of a lane that just started',
      failing: (planned: Progress) => planned.lanes?.s1?.pid !== undefined,
      failure: CANT_WRITE,
      opened: 'Opened s1 (pid 31).',
      tried: ['open s1']
    },
    {
      name: "the next lane's claim",
      failing: (planned: Progress) => planned.lanes?.s2 !== undefined,
      failure: CANCELLED,
      opened: 'Opened s1 (pid 31).',
      tried: ['open s1']
    },
    {
      name: 'the served step',
      failing: (planned: Progress) =>
        planned.steps.some((step) => step.id === 'note' && step.status === 'in_progress'),
      failure: CANCELLED,
      opened: 'Opened s1 (pid 31), s2 (pid 32).',
      tried: ['open s1', 'open s2']
    }
  ]) {
    it(`reports every opened lane when writing ${name} fails`, async () => {
      const record = threeSteps();
      const { h, io } = harness(record, { s1: 31, s2: 32 });
      failCommit(io, failing, failure);
      const done = await performNext(fieldsAt(record), io);
      assert.deepEqual(done, {
        ok: false,
        code: failure.code,
        reason: `${opened}\n${failure.reason}`
      });
      assert.deepEqual(
        h.log.filter((effect) => effect.startsWith('open')),
        tried
      );
    });
  }

  it('reports every opened lane when the wait cannot be written', async () => {
    const record = anchorAt([
      ['plan', 'completed'],
      ['note', 'completed'],
      ['join', 'pending']
    ]);
    const { io } = harness(record, { s1: 31, s2: 32 });
    io.writeWait = () => Promise.resolve(false);
    const done = await performNext(fieldsAt(record), io);
    assert.deepEqual(done, {
      ok: false,
      code: 5,
      reason: 'Opened s1 (pid 31), s2 (pid 32).\ncould not write the wait'
    });
  });

  for (const { name, code, expected } of [
    { name: 'a silent open stays 4', code: 4 as const, expected: 4 },
    { name: 'a refused open takes the write failure', code: 2 as const, expected: 5 }
  ]) {
    it(`gives both reasons when its outcome cannot be written: ${name}`, async () => {
      const record = threeSteps();
      const { io } = harness(record);
      let answered = false;
      io.openSession = () => {
        answered = true;
        return Promise.resolve({ ok: false as const, code, reason: 'not opened' });
      };
      failCommit(io, () => answered, CANT_WRITE);
      const done = await performNext(fieldsAt(record), io);
      assert.deepEqual(done, {
        ok: false,
        code: expected,
        reason: `not opened\n${CANT_WRITE.reason}`
      });
    });
  }

  it('does not name a lane a concurrent next claimed first', async () => {
    const record = threeSteps();
    const { h, io } = harness(record, { s2: 32 });
    h.disk = { ...record, lanes: { s1: { pid: 77, openedAt: NOW_MS } } };
    const done = await performNext(fieldsAt(record), io);
    assert.ok(done.ok, JSON.stringify(done));
    assert.match(done.out, /^Opened s2 \(pid 32\)\.\n/);
    assert.ok(!h.log.includes('open s1'));
  });
});
