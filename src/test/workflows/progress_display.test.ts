import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Session } from '../../core/model';
import type { Progress, StepStatus } from '../../core/workflows/progress_store';
import { disposeHome, tempHome } from '../home';
import { laneRecord as laneRecordWith, reviewWf, seed, workflow } from './progress_helpers';

let home: string;
let store: typeof import('../../core/workflows/progress_store');
let display: typeof import('../../core/workflows/progress_display');
let record: typeof import('../../core/record');
let acks: typeof import('../../core/acks');
let runsDir: string;
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  store = await import('../../core/workflows/progress_store');
  display = await import('../../core/workflows/progress_display');
  record = await import('../../core/record');
  acks = await import('../../core/acks');
  runsDir = path.join(home, '.squadron', 'runs');
});

const seeded = () => store.seedProgress(seed());

function laneRecord(
  lane: string,
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): Progress {
  return laneRecordWith(store.seedProgress, lane, steps, over);
}

describe('rollup', () => {
  const withStatuses = (...statuses: StepStatus[]) => {
    const p = seeded();
    return {
      ...p,
      steps: p.steps.map((s, i) => ({
        ...s,
        status: statuses[i] ?? s.status
      }))
    };
  };

  it('all pending is running', () => {
    assert.equal(display.rollup(seeded()), 'running');
  });

  it('one in_progress is running', () => {
    assert.equal(display.rollup(withStatuses('in_progress', 'pending', 'pending')), 'running');
  });

  it('all completed is done', () => {
    assert.equal(display.rollup(withStatuses('completed', 'completed', 'completed')), 'done');
  });

  it('any failed with none in_progress is failed', () => {
    assert.equal(display.rollup(withStatuses('completed', 'failed', 'pending')), 'failed');
    assert.equal(display.rollup(withStatuses('failed', 'pending', 'pending')), 'failed');
  });

  it('failed while another step is in_progress stays running', () => {
    assert.equal(display.rollup(withStatuses('failed', 'in_progress', 'pending')), 'running');
  });

  it('is the phase followingWorkflow ships', () => {
    const cases = [
      seeded(),
      withStatuses('in_progress', 'pending', 'pending'),
      withStatuses('completed', 'completed', 'completed'),
      withStatuses('completed', 'failed', 'pending'),
      withStatuses('failed', 'in_progress', 'pending')
    ];
    for (const p of cases) {
      assert.equal(display.followingWorkflow(p, workflow)?.phase, display.rollup(p));
    }
  });
});

describe('stepTally', () => {
  const withStatuses = (...statuses: StepStatus[]) => {
    const p = seeded();
    return { ...p, steps: p.steps.map((s, i) => ({ ...s, status: statuses[i] ?? s.status })) };
  };

  it('counts every step once the pipeline is done', () => {
    assert.deepEqual(display.stepTally(withStatuses('completed', 'completed', 'completed')), {
      total: 3,
      completed: 3
    });
  });

  it('counts a pipeline still part-way through', () => {
    assert.deepEqual(display.stepTally(withStatuses('completed', 'in_progress', 'pending')), {
      total: 3,
      completed: 1
    });
  });

  it('counts a failed pipeline by its completed steps', () => {
    assert.deepEqual(display.stepTally(withStatuses('completed', 'failed', 'completed')), {
      total: 3,
      completed: 2
    });
  });

  it('says nothing while every step is still pending', () => {
    assert.equal(display.stepTally(seeded()), undefined);
  });

  it('says nothing without a readable pipeline progress file', () => {
    assert.equal(display.stepTally(undefined), undefined);
    assert.equal(display.stepTally({ ...seeded(), steps: [] }), undefined);
    assert.equal(
      display.stepTally({
        ...withStatuses('completed', 'completed', 'completed'),
        kind: 'loop'
      }),
      undefined
    );
  });
});

describe('workflowCompletion', () => {
  const at = (updatedAt: number, ...statuses: StepStatus[]) => {
    const p = seeded();
    return {
      ...p,
      updatedAt,
      steps: p.steps.map((s, i) => ({ ...s, status: statuses[i] ?? s.status }))
    };
  };

  it('speaks a finished pipeline', () => {
    assert.deepEqual(display.workflowCompletion(at(200, 'completed', 'completed', 'completed')), {
      total: 3,
      completed: 3
    });
  });

  it('speaks a partial pipeline', () => {
    assert.deepEqual(display.workflowCompletion(at(200, 'completed', 'pending', 'pending')), {
      total: 3,
      completed: 1
    });
  });

  it('says nothing when the file predates the last prompt', () => {
    assert.equal(
      display.workflowCompletion(at(100, 'completed', 'pending', 'pending'), { promptAt: 200 }),
      undefined
    );
    assert.equal(
      display.workflowCompletion(at(100, 'completed', 'completed', 'completed'), {
        promptAt: 200
      }),
      undefined
    );
  });

  it('retires a partial tally on the ack, diverging from the checklist rule', () => {
    // `speaks` only retires a list once `completed >= total`; a workflow file is
    // written by an agent that has stopped, so a partial one must retire too.
    assert.equal(
      display.workflowCompletion(at(100, 'completed', 'pending', 'pending'), { ackAt: 100 }),
      undefined
    );
    assert.deepEqual(
      display.workflowCompletion(at(200, 'completed', 'pending', 'pending'), { ackAt: 100 }),
      { total: 3, completed: 1 }
    );
  });

  it('retires a finished tally on the ack like any other list', () => {
    assert.equal(
      display.workflowCompletion(at(100, 'completed', 'completed', 'completed'), { ackAt: 100 }),
      undefined
    );
  });

  it('says nothing when there is no tally to date', () => {
    assert.equal(display.workflowCompletion(undefined), undefined);
    assert.equal(display.workflowCompletion(seeded()), undefined);
  });

  it('dates the file by when it was written, not by its own updatedAt', () => {
    // The seed stamps `updatedAt` *before* the arming message reaches the
    // transcript, and the briefing asks the agent to edit statuses in place —
    // so a well-behaved agent leaves `updatedAt` older than the prompt that
    // started the work. Reading it would silence every tally this exists for.
    const stale = at(100, 'completed', 'in_progress', 'pending');
    assert.equal(
      display.workflowCompletion(stale, { promptAt: 150 }),
      undefined,
      'with nothing but its own stamp it is judged stale'
    );
    assert.deepEqual(
      display.workflowCompletion(stale, { promptAt: 150, writtenAt: 200 }),
      { total: 3, completed: 1 },
      'the mtime is the clock the writer cannot forget to set'
    );
  });

  it('retires on the ack against the same written clock', () => {
    const p = at(100, 'completed', 'in_progress', 'pending');
    assert.equal(display.workflowCompletion(p, { ackAt: 300, writtenAt: 200 }), undefined);
    assert.deepEqual(display.workflowCompletion(p, { ackAt: 100, writtenAt: 200 }), {
      total: 3,
      completed: 1
    });
  });
});

describe('workflowDates', () => {
  const session = (brand: string, sessionId: string, transcript = ''): Session =>
    ({ pid: 1, sessionId, cwd: '/tmp', transcript, brand }) as Session;

  it("dates a non-Claude tally against that brand's own prompt clock", async () => {
    // The bug this closes: `readLastPromptAt` scanned Claude\'s `"type":"user"`
    // jsonl whatever the card was, so a Grok or Codex follow had no `promptAt`
    // at all and its tally never retired via `speaks`.
    await record.appendLine('wd-grok', { role: 'user', text: 'follow it', at: 5000 });

    const dated = await display.workflowDates(session('grok', 'wd-grok'));
    assert.equal(dated.promptAt, 5000);
  });

  it("dates Claude against the CLI's own file, as it always did", async () => {
    const at = Date.parse('2026-09-08T10:00:00.000Z');
    const dir = path.join(runsDir, '..');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'wd-claude.jsonl');
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u-wd',
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'have a look' }] }
      })}\n`
    );

    const dated = await display.workflowDates(session('claude', 'wd-claude', file));
    assert.equal(dated.promptAt, at);
  });

  it('still reads the two marks that are ours', async () => {
    assert.equal(
      await store.writeProgress(store.seedProgress(seed({ sessionId: 'wd-marks' }))),
      true
    );
    await acks.writeAck('wd-marks');

    const dated = await display.workflowDates(session('claude', 'wd-marks'));
    assert.ok(dated.ackAt !== undefined && dated.ackAt > 0);
    assert.ok(dated.writtenAt !== undefined && dated.writtenAt > 0);
    assert.equal(dated.promptAt, undefined, 'no source, so nothing to say');
  });
});

describe('currentStep', () => {
  const withStatuses = (...statuses: StepStatus[]) => {
    const p = seeded();
    return {
      ...p,
      steps: p.steps.map((s, i) => ({
        ...s,
        status: statuses[i] ?? s.status
      }))
    };
  };

  it('prefers the first in_progress', () => {
    const step = display.currentStep(withStatuses('completed', 'in_progress', 'in_progress'));
    assert.equal(step?.id, 'build');
  });

  it('falls back to the first pending when none are in_progress', () => {
    const step = display.currentStep(withStatuses('completed', 'pending', 'pending'));
    assert.equal(step?.id, 'build');
  });

  it('all pending yields the first step', () => {
    assert.equal(display.currentStep(seeded())?.id, 'plan');
  });

  it('all terminal yields no working current', () => {
    assert.equal(
      display.currentStep(withStatuses('completed', 'completed', 'completed')),
      undefined
    );
    assert.equal(display.currentStep(withStatuses('completed', 'failed', 'completed')), undefined);
  });
});

describe('stepMarker', () => {
  const withStatuses = (...statuses: StepStatus[]) => {
    const p = seeded();
    return {
      ...p,
      steps: p.steps.map((s, i) => ({
        ...s,
        status: statuses[i] ?? s.status
      }))
    };
  };

  it('all pending is coarse only', () => {
    assert.equal(display.stepMarker(seeded()), undefined);
  });

  it('names the working step while running', () => {
    assert.deepEqual(display.stepMarker(withStatuses('in_progress', 'pending', 'pending')), {
      id: 'plan',
      label: 'Plan',
      tone: 'working'
    });
    assert.deepEqual(display.stepMarker(withStatuses('completed', 'pending', 'pending')), {
      id: 'build',
      label: 'Build',
      tone: 'working'
    });
  });

  it('on done, tones success from the last completed step', () => {
    assert.deepEqual(display.stepMarker(withStatuses('completed', 'completed', 'completed')), {
      id: 'commit',
      label: 'Commit',
      tone: 'done'
    });
  });

  it('on failed, names the failed step — not a later pending', () => {
    // currentStep alone would return Build (first pending); the strip must not.
    assert.equal(display.currentStep(withStatuses('failed', 'pending', 'pending'))?.id, 'build');
    assert.deepEqual(display.stepMarker(withStatuses('failed', 'pending', 'pending')), {
      id: 'plan',
      label: 'Plan',
      tone: 'failed'
    });
    assert.deepEqual(display.stepMarker(withStatuses('completed', 'failed', 'pending')), {
      id: 'build',
      label: 'Build',
      tone: 'failed'
    });
  });

  it('failed while another step is in_progress stays working on that step', () => {
    assert.deepEqual(display.stepMarker(withStatuses('failed', 'in_progress', 'pending')), {
      id: 'build',
      label: 'Build',
      tone: 'working'
    });
  });

  it('prefers snapshot labels over freehand denormalised ones', () => {
    const p = withStatuses('in_progress', 'pending', 'pending');
    p.steps[0] = { ...p.steps[0]!, label: 'agent renamed me' };
    assert.deepEqual(
      display.stepMarker(p, [
        { id: 'plan', label: 'Plan' },
        { id: 'build', label: 'Build' },
        { id: 'commit', label: 'Commit' }
      ]),
      { id: 'plan', label: 'Plan', tone: 'working' }
    );
  });

  it('unknown kind is coarse only (forward-compat for loop)', () => {
    const p = { ...withStatuses('in_progress', 'pending', 'pending'), kind: 'loop' };
    assert.equal(display.stepMarker(p), undefined);
  });
});

describe('followingWorkflow', () => {
  const rail = (
    statuses: Array<'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown'>,
    over: { current?: number; notes?: (string | undefined)[] } = {}
  ) =>
    (['plan', 'build', 'commit'] as const).map((id, i) => {
      const label = id === 'plan' ? 'Plan' : id === 'build' ? 'Build' : 'Commit';
      const row: {
        id: string;
        label: string;
        status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown';
        note?: string;
        current?: boolean;
      } = {
        id,
        label,
        status: statuses[i] ?? 'pending'
      };
      const note = over.notes?.[i];
      if (note) row.note = note;
      if (over.current === i) row.current = true;
      return row;
    });

  it('carries the coarse label and a definition rail once a step has moved', () => {
    const working = seeded();
    working.steps[0] = { ...working.steps[0]!, status: 'in_progress' };
    assert.deepEqual(display.followingWorkflow(working, workflow), {
      label: 'Ship it',
      phase: 'running',
      step: { label: 'Plan', tone: 'working' },
      steps: rail(['in_progress', 'pending', 'pending'], { current: 0 })
    });
  });

  it('says nothing at all only when there is no file', () => {
    assert.equal(display.followingWorkflow(undefined, workflow), undefined);
  });

  it('seats a bare chip for a seeded file, so the slot is spoken for', () => {
    // The composer gates its exclusivity on this: going quiet between the send
    // and the agent's first write would offer Attach again and let a second
    // mention through. No `step` — an untouched file names no cursor.
    const view = display.followingWorkflow(seeded(), workflow);
    assert.deepEqual(view, {
      label: 'Ship it',
      phase: 'running',
      steps: rail(['pending', 'pending', 'pending'])
    });
  });

  it('names the workflow by id when an agent rewrote the file without a label', () => {
    const p = seeded();
    delete p.label;
    p.steps[0] = { ...p.steps[0]!, status: 'in_progress' };
    assert.equal(display.followingWorkflow(p, undefined)?.label, 'ship');
  });

  it('falls back to the file when the definition has gone', () => {
    const working = seeded();
    working.steps[0] = { ...working.steps[0]!, status: 'in_progress' };
    assert.deepEqual(display.followingWorkflow(working, undefined), {
      label: 'Ship it',
      phase: 'running',
      step: { label: 'Plan', tone: 'working' },
      steps: rail(['in_progress', 'pending', 'pending'], { current: 0 })
    });
  });

  it('failed rollup marks failed as current, not a later pending', () => {
    const p = seeded();
    p.steps[0] = { ...p.steps[0]!, status: 'failed', note: 'check died' };
    p.steps[1] = { ...p.steps[1]!, status: 'pending' };
    assert.deepEqual(display.followingWorkflow(p, workflow), {
      label: 'Ship it',
      phase: 'failed',
      step: { label: 'Plan', tone: 'failed' },
      steps: rail(['failed', 'pending', 'pending'], {
        current: 0,
        notes: ['check died', undefined, undefined]
      })
    });
  });

  it('unknown kind paints unknown statuses and stays coarse on the strip', () => {
    const p = { ...seeded(), kind: 'loop' };
    p.steps[0] = { ...p.steps[0]!, status: 'in_progress' };
    assert.deepEqual(display.followingWorkflow(p, workflow), {
      label: 'Ship it',
      phase: 'running',
      steps: rail(['unknown', 'unknown', 'unknown'])
    });
  });

  it('prefers definition labels and ignores progress-only extra ids', () => {
    const p = seeded();
    p.steps[0] = { ...p.steps[0]!, label: 'agent renamed me', status: 'in_progress' };
    p.steps.push({ id: 'ghost', label: 'Ghost', status: 'pending' });
    const view = display.followingWorkflow(p, workflow);
    assert.ok(view);
    assert.equal(view.steps.length, 3);
    assert.equal(view.steps[0]?.label, 'Plan');
    assert.equal(view.step?.label, 'Plan');
    assert.ok(!view.steps.some((s) => s.id === 'ghost'));
  });

  it('definition ids missing from progress stay pending', () => {
    const p = seeded();
    p.steps = [{ ...p.steps[0]!, status: 'completed' }];
    // Only plan on progress; build/commit still listed from the definition.
    const view = display.followingWorkflow(p, workflow);
    assert.deepEqual(
      view?.steps.map((s) => s.status),
      ['completed', 'pending', 'pending']
    );
  });
});

/**
 * A stamp rather than an unlink, and the tests are about why: the agent is
 * mid-pipeline with the briefing in its context, so an unlinked file is one it
 * writes straight back. What has to survive that write is the mark.
 */
describe('cancelProgress', () => {
  const at = 1_700_000_000_000;

  it('goes quiet on every surface that asks whether a run is live', async () => {
    const running = store.seedProgress(seed({ sessionId: 'cancel-2' }));
    running.steps[0]!.status = 'in_progress';
    await store.writeProgress(running);
    assert.ok(display.followingWorkflow(await store.readProgress('cancel-2')));

    await store.cancelProgress('cancel-2', at);
    const after = await store.readProgress('cancel-2');
    assert.equal(display.followingWorkflow(after), undefined);
    assert.equal(display.stepTally(after), undefined);
    assert.equal(display.workflowCompletion(after), undefined);
  });

  /**
   * The stamp only works because the briefing already asks the agent to edit in
   * place and leave every other field alone. This is that contract, exercised:
   * the write that would have resurrected the chip does not.
   */
  it('survives the agent’s next in-place step write', async () => {
    await store.writeProgress(store.seedProgress(seed({ sessionId: 'cancel-3' })));
    await store.cancelProgress('cancel-3', at);

    const held = await store.readProgress('cancel-3');
    assert.ok(held);
    held.steps[0]!.status = 'completed';
    held.updatedAt = at + 1_000;
    await store.writeProgress(held);

    const after = await store.readProgress('cancel-3');
    assert.equal(after?.cancelledAt, at, 'the mark outlived the write');
    assert.equal(display.followingWorkflow(after), undefined);
  });
});

describe('followingWorkflow at a lane record', () => {
  it('draws only the record’s own lane, so a finished anchor reads finished', () => {
    const anchor = laneRecord('', [
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'completed'],
      ['ship', 'completed']
    ]);
    const seen = display.followingWorkflow(anchor, reviewWf);
    assert.deepEqual(
      seen?.steps.map((s) => s.id),
      ['impl', 'wire', 'aw', 'int', 'ship']
    );
    assert.ok(seen?.steps.every((s) => s.status === 'completed'));
    assert.equal(seen?.phase, 'done');

    const lane = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'pending']
    ]);
    assert.deepEqual(
      display.followingWorkflow(lane, reviewWf)?.steps.map((s) => s.id),
      ['ui', 'au']
    );
  });
});
