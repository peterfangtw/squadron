import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Progress, StepStatus } from '../../core/workflows/progress_store';
import type { Workflow } from '../../core/workflows/workflows';
import { disposeHome, tempHome } from '../home';
import { laneRecord as laneRecordWith, reviewWf, row, seed, workflow } from './progress_helpers';

let home: string;
let store: typeof import('../../core/workflows/progress_store');
let execution: typeof import('../../core/workflows/progress_execution');
let stepCommand: string;
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  store = await import('../../core/workflows/progress_store');
  execution = await import('../../core/workflows/progress_execution');
  stepCommand = (await import('../../core/paths')).stepCommand('posix');
});

const seeded = () => store.seedProgress(seed());

// ---------------------------------------------------------------------------
// Step-blind delivery: the engine behind `squadron-step`.
//
// `serveNext` walks the **definition** and looks each id up in the record,
// which is what makes a mid-run edit land. The cursor rules it implements are
// tabulated in `TASK_done_step_blind_workflows.md`.
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;

/** A record whose steps are stated directly, rather than seeded all-pending. */
const rec = (steps: readonly [string, StepStatus][], over: object = {}) => ({
  ...store.seedProgress(seed()),
  steps: steps.map(([id, status]) => row(id, status)),
  ...over
});

const serveWith = (record: Progress, wf: Workflow = workflow) =>
  execution.serveNext(record, wf, { cwd: '/repo', now: NOW_MS });

const servedId = (r: ReturnType<typeof serveWith>) => (r.outcome === 'served' ? r.id : undefined);

describe('serveNext', () => {
  it('serves the first pending step and marks it in_progress', () => {
    const r = serveWith(
      rec([
        ['plan', 'pending'],
        ['build', 'pending'],
        ['commit', 'pending']
      ])
    );
    assert.equal(r.outcome, 'served');
    assert.equal(servedId(r), 'plan');
    if (r.outcome !== 'served') return;
    assert.equal(r.progress.steps.find((s) => s.id === 'plan')?.status, 'in_progress');
    assert.equal(r.progress.updatedAt, NOW_MS, 'stamps the caller’s clock, never Date.now()');
  });

  it('serves the step after a completed one', () => {
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'pending'],
        ['commit', 'pending']
      ])
    );
    assert.equal(servedId(r), 'build');
  });

  it('reprints an in_progress step rather than advancing', () => {
    const r = serveWith(
      rec([
        ['plan', 'in_progress'],
        ['build', 'pending']
      ])
    );
    assert.equal(r.outcome, 'reprint');
    if (r.outcome !== 'reprint') return;
    assert.equal(r.id, 'plan');
    assert.match(r.header, /already have this one/i);
  });

  it('takes the FIRST in_progress when a hand edit left two', () => {
    const r = serveWith(
      rec([
        ['plan', 'in_progress'],
        ['build', 'in_progress']
      ])
    );
    assert.equal(r.outcome === 'reprint' ? r.id : undefined, 'plan', 'must match currentStep');
  });

  it('reports complete only when every step is completed', () => {
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'completed'],
        ['commit', 'completed']
      ])
    );
    assert.equal(r.outcome, 'complete');
  });

  it('is BLOCKED, not complete, when a failed step stops the run', () => {
    // The lie the fourth outcome exists to prevent: rules 1-3 all miss, and a
    // three-outcome union would exit 0 saying the run had finished.
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'failed'],
        ['commit', 'pending']
      ])
    );
    assert.equal(r.outcome, 'blocked');
    assert.match(r.outcome === 'blocked' ? r.reason : '', /build/);
  });

  it('is blocked on a cancelled run', () => {
    const r = serveWith(rec([['plan', 'pending']], { cancelledAt: NOW_MS - 1000 }));
    assert.equal(r.outcome, 'blocked');
    assert.match(r.outcome === 'blocked' ? r.reason : '', /cancel/i);
  });

  it('is blocked on a kind it does not drive', () => {
    // `pipelineProgress` refuses a non-pipeline kind for every other reader;
    // advancing one here would drive a run the drawer paints `unknown`.
    const r = serveWith(rec([['plan', 'pending']], { kind: 'loop' }));
    assert.equal(r.outcome, 'blocked');
  });

  it('serves an omitted kind, which defaults to pipeline', () => {
    const r = serveWith(rec([['plan', 'pending']], { kind: undefined }));
    assert.equal(r.outcome, 'served');
  });
});

describe('serveNext across a mid-run edit to the definition', () => {
  const midRun = () =>
    rec([
      ['plan', 'completed'],
      ['build', 'pending'],
      ['commit', 'pending']
    ]);
  const review = { id: 'review', label: 'Review', prompt: 'review it' };
  const withReview: Workflow = {
    ...workflow,
    steps: [workflow.steps[0]!, review, workflow.steps[1]!, workflow.steps[2]!]
  };

  it('serves a step inserted above the cursor, adding its row', () => {
    const r = serveWith(midRun(), withReview);
    assert.equal(servedId(r), 'review');
    if (r.outcome !== 'served') return;
    assert.ok(
      r.progress.steps.some((s) => s.id === 'review'),
      'adds a row, never a field'
    );
  });

  it('writes steps back in DEFINITION order, so the rail cursor agrees', () => {
    // `currentStep` reads `progress.steps` order. If an added row were appended
    // the CLI would advance one step and the rail would mark another.
    const r = serveWith(midRun(), withReview);
    if (r.outcome !== 'served') return assert.fail('expected served');
    assert.deepEqual(
      r.progress.steps.map((s) => s.id),
      ['plan', 'review', 'build', 'commit']
    );
  });

  it('ignores a progress row for a step the definition dropped', () => {
    const edited: Workflow = { ...workflow, steps: [workflow.steps[0]!, workflow.steps[2]!] };
    assert.equal(servedId(serveWith(midRun(), edited)), 'commit');
  });

  it('is blocked when the in_progress step was deleted from the definition', () => {
    const edited: Workflow = { ...workflow, steps: [workflow.steps[0]!, workflow.steps[2]!] };
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'in_progress']
      ]),
      edited
    );
    assert.equal(r.outcome, 'blocked', 'no body to reprint — refuse rather than skip silently');
  });

  it('follows a reorder, because predecessors mean the current order', () => {
    const edited: Workflow = {
      ...workflow,
      steps: [workflow.steps[0]!, workflow.steps[2]!, workflow.steps[1]!]
    };
    assert.equal(servedId(serveWith(midRun(), edited)), 'commit');
  });
});

describe('serveNext body text', () => {
  it('substitutes ${cwd} and an earlier step’s declared output', () => {
    const wf: Workflow = {
      ...workflow,
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan', output: 'step-notes' },
        { id: 'build', label: 'Build', prompt: 'in ${cwd} read ${step.plan.output}' }
      ]
    };
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'pending']
      ]),
      wf
    );
    if (r.outcome !== 'served') return assert.fail('expected served');
    assert.equal(r.body, 'in /repo read step-notes');
    assert.deepEqual(r.unresolved, []);
  });

  it('leaves a ticket reference verbatim and reports it', () => {
    // `substitute`'s own rule: an emptied reference reads as a finished
    // sentence, and the agent does something confidently wrong with it.
    const wf: Workflow = {
      ...workflow,
      steps: [{ id: 'plan', label: 'Plan', prompt: 'ship ${identifier}' }]
    };
    const r = serveWith(rec([['plan', 'pending']]), wf);
    if (r.outcome !== 'served') return assert.fail('expected served');
    assert.equal(r.body, 'ship ${identifier}');
    assert.deepEqual(r.unresolved, ['identifier']);
  });

  it('serves a `uses` step as prose, since stdout is not a user frame', () => {
    const wf: Workflow = {
      ...workflow,
      steps: [{ id: 'plan', label: 'Plan', uses: '/implement' }]
    };
    const r = serveWith(rec([['plan', 'pending']]), wf);
    if (r.outcome !== 'served') return assert.fail('expected served');
    assert.match(r.body, /\/implement/);
    assert.ok(!r.body.startsWith('/'), 'a bare slash name expands nowhere here');
  });

  it('counts the header in the definition, not the record', () => {
    const edited: Workflow = {
      ...workflow,
      steps: [...workflow.steps, { id: 'ship', label: 'Ship', prompt: 'ship it' }]
    };
    const r = serveWith(rec([['plan', 'pending']]), edited);
    assert.match(r.outcome === 'served' ? r.header : '', /Step 1 of 4/);
  });
});

describe('completeCurrent', () => {
  it('completes the first in_progress step and attaches a note', () => {
    const r = execution.completeCurrent(
      rec([
        ['plan', 'in_progress'],
        ['build', 'pending']
      ]),
      {
        note: 'done it',
        now: NOW_MS
      }
    );
    assert.equal(r.outcome, 'completed');
    if (r.outcome !== 'completed') return;
    const step = r.progress.steps.find((s) => s.id === 'plan');
    assert.equal(step?.status, 'completed');
    assert.equal(step?.note, 'done it');
    assert.equal(r.progress.updatedAt, NOW_MS);
  });

  it('is blocked on a note past NOTE_MAX, so the step stays open for a shorter one', () => {
    const r = execution.completeCurrent(rec([['plan', 'in_progress']]), {
      note: 'x'.repeat(store.NOTE_MAX + 1),
      now: NOW_MS
    });
    assert.equal(r.outcome, 'blocked');
    assert.match(
      r.outcome === 'blocked' ? r.reason : '',
      new RegExp(`${store.NOTE_MAX + 1} characters`)
    );
  });

  it('takes a note of exactly NOTE_MAX', () => {
    const r = execution.completeCurrent(rec([['plan', 'in_progress']]), {
      note: 'x'.repeat(store.NOTE_MAX),
      now: NOW_MS
    });
    assert.equal(r.outcome, 'completed');
  });

  it('measures the trimmed note, not what the shell handed over', () => {
    const r = execution.completeCurrent(rec([['plan', 'in_progress']]), {
      note: `  ${'x'.repeat(store.NOTE_MAX)}  `,
      now: NOW_MS
    });
    assert.equal(r.outcome, 'completed');
  });

  it('is blocked when nothing is in progress', () => {
    const r = execution.completeCurrent(rec([['plan', 'pending']]), { now: NOW_MS });
    assert.equal(r.outcome, 'blocked');
  });

  it('is blocked on a cancelled run, so `done` never writes into a stamped record', () => {
    const r = execution.completeCurrent(
      rec([['plan', 'in_progress']], { cancelledAt: NOW_MS - 1 }),
      { now: NOW_MS }
    );
    assert.equal(r.outcome, 'blocked');
  });

  it('needs no definition, so a run whose file was deleted can still finish its step', () => {
    const r = execution.completeCurrent(rec([['plan', 'in_progress']]), { now: NOW_MS });
    assert.equal(r.outcome, 'completed');
  });

  it('refuses a kind it does not drive, exactly as serveNext does', () => {
    // `kind` is on the record, not the definition — so without this guard
    // `done` mutates a later shape's run that `next` would have refused.
    const r = execution.completeCurrent(rec([['plan', 'in_progress']], { kind: 'loop' }), {
      now: NOW_MS
    });
    assert.equal(r.outcome, 'blocked');
  });

  it('takes the FIRST in_progress when a hand edit left two', () => {
    const r = execution.completeCurrent(
      rec([
        ['plan', 'in_progress'],
        ['build', 'in_progress']
      ]),
      { now: NOW_MS }
    );
    assert.equal(r.outcome === 'completed' ? r.id : undefined, 'plan');
  });
});

describe('serveNext, the record it hands back', () => {
  // `settle` was reachable on one path and pinned by nothing: inverting it, or
  // returning the input unchanged always, left every other test green.
  it('returns the record by identity when nothing moved, so no write is owed', () => {
    const before = rec([
      ['plan', 'in_progress'],
      ['build', 'pending'],
      ['commit', 'pending']
    ]);
    const r = serveWith(before);
    if (r.outcome !== 'reprint') return assert.fail('expected reprint');
    assert.equal(r.progress, before, 'same object — the CLI skips the write on identity');
    assert.equal(r.progress.updatedAt, before.updatedAt, 'a reprint is not news');
  });

  it('reorders and stamps when an edit moved the rows', () => {
    const before = rec([
      ['plan', 'in_progress'],
      ['commit', 'pending']
    ]);
    const edited: Workflow = {
      ...workflow,
      steps: [
        workflow.steps[0]!,
        { id: 'review', label: 'Review', prompt: 'review it' },
        workflow.steps[2]!
      ]
    };
    const r = serveWith(before, edited);
    if (r.outcome !== 'reprint') return assert.fail('expected reprint');
    assert.deepEqual(
      r.progress.steps.map((s) => s.id),
      ['plan', 'review', 'commit']
    );
    assert.equal(r.progress.updatedAt, NOW_MS);
  });

  it('carries the settled record when a trailing-step deletion completes the run', () => {
    // Otherwise the row for the deleted step stays `pending` forever: `rollup`
    // and `stepTally` go on counting it while the CLI has said the run is over.
    const before = rec([
      ['plan', 'completed'],
      ['build', 'pending']
    ]);
    const edited: Workflow = { ...workflow, steps: [workflow.steps[0]!] };
    const r = serveWith(before, edited);
    assert.equal(r.outcome, 'complete');
    if (r.outcome !== 'complete') return;
    assert.deepEqual(
      r.progress.steps.map((s) => s.id),
      ['plan'],
      'the dropped row goes with the step'
    );
  });

  it('serves a step inserted BELOW the cursor when the run reaches it', () => {
    const edited: Workflow = {
      ...workflow,
      steps: [
        workflow.steps[0]!,
        workflow.steps[1]!,
        { id: 'ship', label: 'Ship', prompt: 'ship it' }
      ]
    };
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'completed']
      ]),
      edited
    );
    assert.equal(r.outcome === 'served' ? r.id : undefined, 'ship');
  });

  it('reprints the same body it served, not a differently substituted one', () => {
    const wf: Workflow = {
      ...workflow,
      steps: [{ id: 'plan', label: 'Plan', prompt: 'work in ${cwd}' }]
    };
    const first = serveWith(rec([['plan', 'pending']]), wf);
    const again = serveWith(rec([['plan', 'in_progress']]), wf);
    if (first.outcome !== 'served' || again.outcome !== 'reprint') return assert.fail('shape');
    assert.equal(again.body, first.body);
  });
});

describe('serveNext on input nothing promised was valid', () => {
  it('refuses to join one run’s record to another run’s definition', () => {
    const r = serveWith(rec([['plan', 'pending']], { workflowId: 'other' }));
    assert.equal(r.outcome, 'blocked');
    assert.match(r.outcome === 'blocked' ? r.reason : '', /other/);
  });

  it('refuses a workflow with no steps rather than calling it complete', () => {
    // `rollup` calls a stepless record `running`; reporting `complete` here
    // would be the two disagreeing about the same file.
    const r = serveWith(rec([['plan', 'pending']]), { ...workflow, steps: [] });
    assert.equal(r.outcome, 'blocked');
  });

  it('refuses a step that declares neither a prompt nor a skill', () => {
    // A real header over an empty body reads as a finished instruction — the
    // failure `substitute` refuses to create for an unresolved reference.
    const wf: Workflow = { ...workflow, steps: [{ id: 'plan', label: 'Plan' }] };
    const r = serveWith(rec([['plan', 'pending']]), wf);
    assert.equal(r.outcome, 'blocked');
    assert.match(r.outcome === 'blocked' ? r.reason : '', /plan/);
  });

  it('blocks when the step in flight was renamed, which the cursor rules call out', () => {
    // A rename reads as delete-plus-insert and replays the step — *unless* it
    // is the one in flight, where the orphan guard fires first and every later
    // `next` is blocked. The table says so; this is what pins it.
    const edited: Workflow = {
      ...workflow,
      steps: [workflow.steps[0]!, { id: 'built', label: 'Build', prompt: 'build it' }]
    };
    const r = serveWith(
      rec([
        ['plan', 'completed'],
        ['build', 'in_progress']
      ]),
      edited
    );
    assert.equal(r.outcome, 'blocked');
    assert.match(r.outcome === 'blocked' ? r.reason : '', /build/);
  });
});

// ---------------------------------------------------------------------------
// Lanes. §3d is the eleven-step review loop: the armed session, three
// named lanes, and the converges back. Records are built by hand — nothing
// here spawns.
// ---------------------------------------------------------------------------

const OLD = NOW_MS - 10_000;

/** Whose pid is whose in these fixtures, for a board that names sessions. */
const SESSION_AT: Record<number, string> = {
  10: 'anchor',
  11: 'sess-s1',
  12: 'sess-s2',
  13: 'sess-s3'
};
const openedAt = (pid: number, at = OLD) => ({ pid, openedAt: at });

function laneRecord(
  lane: string,
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): Progress {
  return laneRecordWith(store.seedProgress, lane, steps, over);
}

function flat(records: readonly Progress[]): { id: string; status: StepStatus }[] {
  return records.flatMap((r) => r.steps.map((s) => ({ id: s.id, status: s.status })));
}

function serveLane(record: Progress, others: readonly Progress[] = []) {
  return execution.serveNext(record, reviewWf, { cwd: '/repo', now: NOW_MS, others: flat(others) });
}

function readyFor(
  self: Progress,
  others: readonly Progress[] = [],
  opened: Record<string, { pid: number; openedAt: number }> = {},
  members?: readonly { pid: number; idle: boolean }[],
  now = NOW_MS
) {
  // A board's members name their session, which is how a record finds its
  // pid. The fixtures number lanes s1..s3 at pids 11..13.
  const named = members?.map((m) => ({ ...m, sessionId: SESSION_AT[m.pid] }));
  return execution.readiness({ workflow: reviewWf, self, others, opened, members: named, now });
}

describe('a file that names no lane', () => {
  it('readiness reports nothing, idle member included', () => {
    const self = laneRecord('', [
      ['impl', 'completed'],
      ['wire', 'in_progress']
    ]);
    const r = execution.readiness({
      workflow,
      self,
      others: [],
      opened: { s1: openedAt(11) },
      members: [{ pid: 10, idle: true }],
      now: NOW_MS
    });
    assert.deepEqual(r, { openLanes: [], waitPids: [] });
  });
});

describe('§3d by hand-built records', () => {
  const armed = (steps: readonly [string, StepStatus][]) => laneRecord('', steps);

  it('serves impl and opens no lane', () => {
    const self = armed([
      ['impl', 'pending'],
      ['wire', 'pending'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const served = serveLane(self);
    assert.equal(served.outcome, 'served');
    if (served.outcome !== 'served') return;
    assert.equal(served.id, 'impl');
    assert.match(served.header, /Step 1 of 5/);
    assert.equal(served.progress.steps.find((s) => s.id === 'impl')?.status, 'in_progress');
    assert.deepEqual(readyFor(self), { openLanes: [], waitPids: [] });
  });

  it('after impl, opens s1 and serves wire', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'pending'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const served = serveLane(self);
    assert.equal(served.outcome === 'served' ? served.id : undefined, 'wire');
    assert.deepEqual(readyFor(self).openLanes, ['s1']);
  });

  it('after wire, s1 and s2 are openable and aw waits on rw', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const served = serveLane(self);
    assert.equal(served.outcome, 'waiting');
    if (served.outcome !== 'waiting') return;
    assert.equal(served.id, 'aw');
    assert.deepEqual(served.pending, ['rw']);
    assert.equal(served.progress.steps.find((s) => s.id === 'aw')?.status, 'pending');
    assert.equal(served.progress.updatedAt, 1, 'an unchanged lane owes no write');
    const found = readyFor(self);
    assert.deepEqual(found.openLanes, ['s1', 's2']);
    assert.deepEqual(found.waitPids, []);
    assert.equal(found.stall, undefined);
  });

  it('an opened lane with no record yet is the wait', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const opened = { s1: openedAt(11), s2: openedAt(12) };
    const found = readyFor(self, [], opened);
    assert.deepEqual(found.openLanes, []);
    assert.deepEqual(found.waitPids, [12]);
    assert.equal(found.stall, undefined);
  });

  it('rw in progress is the wait, and ui completing opens s3', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const s1 = laneRecord('s1', [
      ['ui', 'in_progress'],
      ['au', 'pending']
    ]);
    const s2 = laneRecord('s2', [
      ['rw', 'in_progress'],
      ['riw', 'pending']
    ]);
    const opened = { s1: openedAt(11), s2: openedAt(12) };
    const before = readyFor(self, [s1, s2], opened);
    assert.deepEqual(before.openLanes, []);
    assert.deepEqual(before.waitPids, [12]);

    const done = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'pending']
    ]);
    assert.deepEqual(readyFor(self, [done, s2], opened).openLanes, ['s3']);
  });

  it('serves aw once rw is completed, and counts inside the lane', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const s2 = laneRecord('s2', [
      ['rw', 'completed'],
      ['riw', 'pending']
    ]);
    const served = serveLane(self, [s2]);
    assert.equal(served.outcome, 'served');
    if (served.outcome !== 'served') return;
    assert.equal(served.id, 'aw');
    assert.match(served.header, /Step 3 of 5/);
  });

  it('a lane serves its own step, and never opens one', () => {
    const anchor = armed([
      ['impl', 'completed'],
      ['wire', 'pending'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const s1 = laneRecord('s1', [
      ['ui', 'pending'],
      ['au', 'pending']
    ]);
    const served = serveLane(s1, [anchor]);
    assert.equal(served.outcome, 'served');
    if (served.outcome !== 'served') return;
    assert.equal(served.id, 'ui');
    assert.equal(served.body, 'read step-notes');
    assert.match(served.header, /Step 1 of 2/);
    assert.deepEqual(
      served.progress.steps.map((s) => s.id),
      ['ui', 'au']
    );
    const found = readyFor(s1, [anchor], {}, [], NOW_MS);
    assert.deepEqual(found.openLanes, []);
  });

  it('does not serve a later step of the lane while an earlier one is waiting', () => {
    const anchor = armed([
      ['impl', 'pending'],
      ['wire', 'pending'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const s1 = laneRecord('s1', [
      ['ui', 'pending'],
      ['au', 'pending']
    ]);
    const s3 = laneRecord('s3', [
      ['ru', 'completed'],
      ['riu', 'pending']
    ]);
    const served = serveLane(s1, [anchor, s3]);
    assert.equal(served.outcome, 'waiting');
    if (served.outcome !== 'waiting') return;
    assert.equal(served.id, 'ui');
    assert.deepEqual(served.pending, ['impl']);
    // `impl` is ready and unserved: the anchor serves it on its next `next`.
    assert.deepEqual(readyFor(s1, [anchor]).waitPids, [10]);
    const working = armed([
      ['impl', 'in_progress'],
      ['wire', 'pending'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    assert.deepEqual(readyFor(s1, [working]).waitPids, [10]);
  });

  it('waits on the review while the lane that applies it has not started', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const s1 = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'pending']
    ]);
    const s3 = laneRecord('s3', [
      ['ru', 'in_progress'],
      ['riu', 'pending']
    ]);
    const opened = { s1: openedAt(11), s2: openedAt(12), s3: openedAt(13) };
    const served = serveLane(self, [s1, s3]);
    assert.equal(served.outcome, 'waiting');
    if (served.outcome !== 'waiting') return;
    assert.equal(served.id, 'int');
    assert.deepEqual(served.pending, ['ru', 'au']);
    assert.deepEqual(readyFor(self, [s1, s3], opened).waitPids, [13]);
  });

  it('serves au once ru is completed, then the anchor waits on that session', () => {
    const s3 = laneRecord('s3', [
      ['ru', 'completed'],
      ['riu', 'pending']
    ]);
    const s1 = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'pending']
    ]);
    const served = serveLane(s1, [s3]);
    assert.equal(served.outcome, 'served');
    if (served.outcome !== 'served') return;
    assert.equal(served.id, 'au');
    assert.match(served.header, /Step 2 of 2/);

    const working = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'in_progress']
    ]);
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const opened = { s1: openedAt(11), s3: openedAt(13) };
    const found = readyFor(self, [working, s3], opened);
    assert.deepEqual(found.waitPids, [11]);
    assert.equal(found.stall, undefined);
  });

  it('serves the converge, and does not open a lane a second time for its later step', () => {
    const s1 = laneRecord('s1', [
      ['ui', 'completed'],
      ['au', 'completed']
    ]);
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const served = serveLane(self, [s1]);
    assert.equal(served.outcome === 'served' ? served.id : undefined, 'int');
    if (served.outcome === 'served') assert.match(served.header, /Step 4 of 5/);

    const done = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'completed'],
      ['ship', 'pending']
    ]);
    const s2 = laneRecord('s2', [
      ['rw', 'completed'],
      ['riw', 'in_progress']
    ]);
    const s3 = laneRecord('s3', [
      ['ru', 'completed'],
      ['riu', 'in_progress']
    ]);
    const opened = { s1: openedAt(11), s2: openedAt(12), s3: openedAt(13) };
    const waiting = serveLane(done, [s2, s3]);
    assert.equal(waiting.outcome, 'waiting');
    if (waiting.outcome !== 'waiting') return;
    assert.equal(waiting.id, 'ship');
    assert.deepEqual(waiting.pending, ['riw', 'riu']);
    const found = readyFor(done, [s2, s3], opened);
    assert.deepEqual(found.openLanes, []);
    assert.deepEqual(found.waitPids, [12, 13]);
  });

  it('serves ship once both reviews are done, then the anchor’s own steps are complete', () => {
    const s2 = laneRecord('s2', [
      ['rw', 'completed'],
      ['riw', 'completed']
    ]);
    const s3 = laneRecord('s3', [
      ['ru', 'completed'],
      ['riu', 'completed']
    ]);
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'completed'],
      ['ship', 'pending']
    ]);
    const served = serveLane(self, [s2, s3]);
    assert.equal(served.outcome === 'served' ? served.id : undefined, 'ship');
    if (served.outcome === 'served') assert.match(served.header, /Step 5 of 5/);

    const done = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'completed'],
      ['ship', 'completed']
    ]);
    assert.equal(serveLane(done, [s2, s3]).outcome, 'complete');
    const opened = { s1: openedAt(11), s2: openedAt(12), s3: openedAt(13) };
    assert.deepEqual(readyFor(done, [s2, s3], opened), { openLanes: [], waitPids: [] });
  });

  it('own status wins when another record disagrees', () => {
    const self = armed([
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'completed'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);
    const served = execution.serveNext(self, reviewWf, {
      cwd: '/repo',
      now: NOW_MS,
      others: [
        { id: 'aw', status: 'pending' },
        { id: 'au', status: 'completed' }
      ]
    });
    assert.equal(served.outcome === 'served' ? served.id : undefined, 'int');
  });

  it('reprints the step in progress before it considers needs', () => {
    const s1 = laneRecord('s1', [
      ['ui', 'in_progress'],
      ['au', 'pending']
    ]);
    const served = serveLane(s1);
    assert.equal(served.outcome, 'reprint');
    assert.equal(served.outcome === 'reprint' ? served.id : undefined, 'ui');
  });

  it('refuses a record whose lane the file does not have', () => {
    const self = laneRecord('s1', [
      ['ui', 'pending'],
      ['au', 'pending']
    ]);
    const r = serveLane({ ...self, lane: 'nope' });
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.outcome === 'blocked' ? r.reason : '', 'this lane has no steps');
  });
});

describe('readiness stalls', () => {
  const waiting = () =>
    laneRecord('', [
      ['impl', 'completed'],
      ['wire', 'completed'],
      ['aw', 'pending'],
      ['int', 'pending'],
      ['ship', 'pending']
    ]);

  it('waits on an idle lane holding a ready step, since its next `next` serves it', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'pending'],
      ['riw', 'pending']
    ]);
    const found = readyFor(self, [s2], { s2: openedAt(12) }, [{ pid: 12, idle: true }]);
    assert.equal(found.stall, undefined);
    assert.deepEqual(found.waitPids, [12]);
    assert.deepEqual(found.waitOn, [{ pid: 12, who: 's2', holds: ['rw'], idle: true }]);
  });

  it('refuses when the step it waits on failed, and nothing is in progress', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'failed'],
      ['riw', 'pending']
    ]);
    const found = readyFor(self, [s2], { s2: openedAt(12) }, [{ pid: 12, idle: true }]);
    assert.equal(found.stall, 'the armed session is blocked at aw, and nothing is in progress');
    assert.deepEqual(found.waitPids, []);
  });

  it('refuses an idle member whose step is still in progress', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'in_progress'],
      ['riw', 'pending']
    ]);
    const found = readyFor(self, [s2], { s2: openedAt(12, NOW_MS - 100) }, [
      { pid: 12, idle: true }
    ]);
    assert.equal(
      found.stall,
      `s2 is idle with rw still in progress — ask it to finish and run \`${stepCommand} done\``
    );
    assert.deepEqual(found.waitPids, []);
  });

  it('counts a lane opened under 2s ago, with no step in progress, as working', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'failed'],
      ['riw', 'pending']
    ]);
    const opened = { s2: openedAt(12, NOW_MS - (execution.FRESH_LANE_MS - 1)) };
    const found = readyFor(self, [s2], opened, [{ pid: 12, idle: true }]);
    assert.equal(found.stall, undefined);
    assert.deepEqual(found.waitPids, [12]);
  });

  it('at 2s that same lane is the empty-set refusal', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'failed'],
      ['riw', 'pending']
    ]);
    const opened = { s2: openedAt(12, NOW_MS - execution.FRESH_LANE_MS) };
    const found = readyFor(self, [s2], opened, [{ pid: 12, idle: true }]);
    assert.equal(found.stall, 'the armed session is blocked at aw, and nothing is in progress');
  });

  it('an idle session that is not the one being waited on is not a stall', () => {
    const self = waiting();
    const s2 = laneRecord('s2', [
      ['rw', 'in_progress'],
      ['riw', 'pending']
    ]);
    const s3 = laneRecord('s3', [
      ['ru', 'completed'],
      ['riu', 'in_progress']
    ]);
    const found = readyFor(self, [s2, s3], { s2: openedAt(12), s3: openedAt(13) }, [
      { pid: 12, idle: false },
      { pid: 13, idle: true }
    ]);
    assert.equal(found.stall, undefined);
    assert.deepEqual(found.waitPids, [12]);
  });
});

describe('unstarted', () => {
  const lineage = new Map([[21, { requestId: 'req-A', spawnedAt: 0 }]]);
  const idle = [{ pid: 21, sessionId: 'sess-A', startedAt: 0, idle: true }];
  const open = (
    over: { openedAt?: number; requestId?: string; fellBack?: true; pid?: number } = {}
  ) => ({
    A: {
      pid: 21,
      openedAt: NOW_MS - execution.FRESH_LANE_MS,
      requestId: 'req-A',
      ...over
    }
  });
  const rows = (
    over: Parameters<typeof open>[0] = {},
    opts: {
      members?: typeof idle | undefined;
      records?: { lane?: string }[];
      edges?: Map<number, { requestId?: string; spawnedAt: number }>;
    } = {}
  ) =>
    execution.unstarted({
      opened: open(over),
      records: opts.records ?? [],
      members: opts.members === undefined && !('members' in opts) ? idle : opts.members,
      now: NOW_MS,
      lineage: opts.edges ?? lineage
    });

  it('is not a lane still inside the fresh window', () => {
    assert.deepEqual(rows({ openedAt: NOW_MS - (execution.FRESH_LANE_MS - 1) }), []);
  });

  it('names an idle lane once the window has passed, with the child to end', () => {
    assert.deepEqual(rows(), [{ lane: 'A', fellBack: false, pid: 21 }]);
  });

  it('names a gone lane with no pid', () => {
    assert.deepEqual(rows({}, { members: [] }), [{ lane: 'A', fellBack: false }]);
  });

  it('never names a lane that has a record', () => {
    assert.deepEqual(rows({}, { records: [{ lane: 'A' }] }), []);
  });

  it('still names a lane that has already fallen back, and says so', () => {
    assert.deepEqual(rows({ fellBack: true }), [{ lane: 'A', fellBack: true, pid: 21 }]);
  });

  it('does not name a busy lane, or one whose lineage is not this open', () => {
    assert.deepEqual(
      rows({}, { members: [{ pid: 21, sessionId: 'sess-A', startedAt: 0, idle: false }] }),
      []
    );
    assert.deepEqual(
      rows({}, { edges: new Map([[21, { requestId: 'other', spawnedAt: 0 }]]) }),
      []
    );
    assert.deepEqual(
      rows({ requestId: undefined }, { edges: new Map([[21, { spawnedAt: 0 }]]) }),
      []
    );
    assert.deepEqual(rows({}, { members: undefined }), []);
  });
});

describe('a lane waiting on this session', () => {
  const chain: Workflow = {
    id: 'chain',
    label: 'Chain',
    steps: [
      { id: 'a', label: 'A', prompt: 'a' },
      { id: 'b', label: 'B', prompt: 'b', lane: 's1', needs: ['a'] }
    ]
  };

  it('opens the lane only once the step it needs is completed', () => {
    const self = store.seedProgress({
      sessionId: 'anchor',
      workflowId: chain.id,
      label: chain.label,
      steps: chain.steps,
      lane: '',
      pid: 10,
      now: 1
    });
    const pending = execution.readiness({ workflow: chain, self, now: NOW_MS });
    assert.deepEqual(pending.openLanes, []);
    const done = {
      ...self,
      steps: self.steps.map((s) => ({ ...s, status: 'completed' as const }))
    };
    assert.deepEqual(execution.readiness({ workflow: chain, self: done, now: NOW_MS }).openLanes, [
      's1'
    ]);
    assert.equal(
      execution.serveNext(done, chain, { cwd: '/repo', now: NOW_MS }).outcome,
      'complete'
    );
  });
});

describe('the anchor can finish its own steps while a lane is still unopened', () => {
  it('serveNext says complete and readiness still lists the lane', () => {
    const wf: Workflow = {
      id: 'split',
      label: 'Split',
      steps: [
        { id: 'impl', label: 'Implement', prompt: 'impl' },
        { id: 'ui', label: 'UI', prompt: 'ui', lane: 's1', needs: ['impl'] }
      ]
    };
    const self = store.seedProgress({
      sessionId: 'anchor',
      workflowId: wf.id,
      label: wf.label,
      steps: wf.steps,
      lane: '',
      pid: 10,
      now: 1
    });
    const done = {
      ...self,
      steps: self.steps.map((s) => ({ ...s, status: 'completed' as const }))
    };
    assert.equal(execution.serveNext(done, wf, { cwd: '/repo', now: NOW_MS }).outcome, 'complete');
    assert.deepEqual(execution.readiness({ workflow: wf, self: done, now: NOW_MS }).openLanes, [
      's1'
    ]);
  });
});

describe('a lane that is not yet openable is a wait', () => {
  const wf: Workflow = {
    id: 'split',
    label: 'Split',
    steps: [
      { id: 'impl', label: 'Implement', prompt: 'impl' },
      { id: 'ui', label: 'UI', prompt: 'ui', lane: 's1', needs: ['impl'] },
      { id: 'rw', label: 'Review', prompt: 'rw', lane: 's2', needs: ['ui'] }
    ]
  };

  const anchorDone = () => {
    const self = store.seedProgress({
      sessionId: 'anchor',
      workflowId: wf.id,
      label: wf.label,
      steps: wf.steps,
      lane: '',
      pid: 10,
      now: 1
    });
    return {
      ...self,
      steps: self.steps.map((step) => ({ ...step, status: 'completed' as const }))
    };
  };

  it('waits on the lane already working, and does not list the one that is not ready', () => {
    const s1 = store.seedProgress({
      sessionId: 'sess-s1',
      workflowId: wf.id,
      label: wf.label,
      steps: wf.steps,
      lane: 's1',
      anchor: 'anchor',
      now: 1
    });
    const working = {
      ...s1,
      steps: s1.steps.map((step) => ({ ...step, status: 'in_progress' as const }))
    };
    const found = execution.readiness({
      workflow: wf,
      self: anchorDone(),
      others: [working],
      opened: { s1: { pid: 11, openedAt: OLD } },
      now: NOW_MS
    });
    assert.deepEqual(found.openLanes, []);
    assert.deepEqual(found.waitPids, [11]);
    assert.equal(found.stall, undefined);
  });

  it('does not wait on a lane that is ready to open', () => {
    const found = execution.readiness({ workflow: wf, self: anchorDone(), now: NOW_MS });
    assert.deepEqual(found.openLanes, ['s1']);
    assert.deepEqual(found.waitPids, []);
  });
});

describe('the loop breaker', () => {
  it('marks a step moving, a lane opening, and a lane writing its record as progress', () => {
    const lane = laneRecord('s2', [
      ['rw', 'pending'],
      ['riw', 'pending']
    ]);
    const opened = { s2: openedAt(12) };
    const before = execution.runMark([lane], opened);
    const moved = laneRecord('s2', [
      ['rw', 'in_progress'],
      ['riw', 'pending']
    ]);
    assert.notEqual(execution.runMark([moved], opened), before);
    assert.notEqual(execution.runMark([lane], { ...opened, s3: openedAt(13) }), before);
    assert.notEqual(
      execution.runMark([lane, laneRecord('s3', [['ru', 'pending']])], opened),
      before
    );
    assert.equal(execution.runMark([lane], { s2: openedAt(12) }), before);
  });

  it('counts all-idle waits over one mark, resets on another mark or a busy member', () => {
    assert.deepEqual(execution.holdAfter(undefined, 'm', true), {
      refuse: false,
      held: { mark: 'm', count: 1 }
    });
    assert.deepEqual(execution.holdAfter({ mark: 'm', count: 1 }, 'm', true), {
      refuse: false,
      held: { mark: 'm', count: 2 }
    });
    assert.deepEqual(execution.holdAfter({ mark: 'm', count: 2 }, 'm', true), { refuse: true });
    assert.deepEqual(execution.holdAfter({ mark: 'm', count: 2 }, 'moved', true), {
      refuse: false,
      held: { mark: 'moved', count: 1 }
    });
    assert.deepEqual(execution.holdAfter({ mark: 'm', count: 2 }, 'm', false), { refuse: false });
  });
});

describe('armingMiss', () => {
  const anchor = (over: Partial<Progress> = {}): Progress => ({
    ...seeded(),
    lanes: { s1: { pid: 21, openedAt: 500 } },
    ...over
  });
  const claim = { workflowId: workflow.id, lane: 's1', opened: 500 };

  it('passes a lane the anchor opened for the arming it is on', () => {
    assert.equal(execution.armingMiss(anchor(), claim), undefined);
  });

  it('names the first check that fails, cancel before workflow before token', () => {
    assert.equal(
      execution.armingMiss(anchor({ cancelledAt: 1 }), { ...claim, workflowId: 'other' }),
      'cancelled'
    );
    assert.equal(
      execution.armingMiss(anchor(), { ...claim, workflowId: 'other', opened: 1 }),
      'workflow'
    );
    assert.equal(execution.armingMiss(anchor(), { ...claim, opened: 499 }), 'opened');
    assert.equal(execution.armingMiss(anchor(), { ...claim, lane: 's2' }), 'opened');
    assert.equal(execution.armingMiss(anchor(), { workflowId: workflow.id, lane: 's1' }), 'opened');
    assert.equal(
      execution.armingMiss(anchor(), { workflowId: workflow.id, opened: 500 }),
      'opened'
    );
  });

  it('keeps only the anchor of a cancelled arming in runRecords', () => {
    const lane: Progress = { ...seeded(), sessionId: 'lane-1', lane: 's1', opened: 500 };
    assert.deepEqual(
      execution.runRecords(anchor(), [anchor(), lane]).map((r) => r.sessionId),
      ['sess-1', 'lane-1']
    );
    assert.deepEqual(
      execution.runRecords(anchor({ cancelledAt: 1 }), [anchor(), lane]).map((r) => r.sessionId),
      ['sess-1']
    );
  });
});
