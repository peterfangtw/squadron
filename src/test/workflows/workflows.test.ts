import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import type { Session } from '../../core/model';
import { tempHome, writeJson } from '../helpers';

type Workflows = typeof import('../../core/workflows/workflows');
/** What a valid file parses to. `validate` itself takes `unknown`, since what it
 *  is handed is whatever somebody typed into the file. */
type Definition = import('../../core/workflows/workflows').Workflow;

let wf: Workflows;
let toWorkflowView: typeof import('../../ui/state').toWorkflowView;
let buildState: typeof import('../../ui/state').buildState;
let home: string;
let claude: string;
let workflowsDir: string;

/**
 * `paths.ts` resolves `~/.claude` when it is first required, so `HOME` moves
 * before the module under test is imported.
 *
 * One home for the whole suite: no two tests write the same filename, and a
 * fresh one per test would cost a `mkdtemp` per assertion to isolate nothing.
 */
before(async () => {
  home = await tempHome();
  // `state.ts` imports `workflows.ts`, which resolves `~` at load. A static
  // import here would read the real home before `tempHome()` moves it.
  wf = await import('../../core/workflows/workflows');
  ({ toWorkflowView, buildState } = await import('../../ui/state'));
  claude = path.join(home, '.claude');
  workflowsDir = path.join(home, '.squadron', 'workflows');
});

/** A valid two-step definition; a test states only what it is about. */
const workflow = (over: Partial<Definition> = {}): Definition => ({
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan ${title}', output: 'plan.md' },
    { id: 'build', label: 'Build', prompt: 'read ${step.plan.output}', needs: ['plan'] }
  ],
  ...over
});

async function write(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

describe('validate', () => {
  it('accepts a definition that states everything it must', () => {
    assert.deepEqual(wf.validate(workflow()), []);
  });

  it('refuses anything that is not an object', () => {
    assert.deepEqual(wf.validate(undefined), ['not an object']);
  });

  it('ignores a stale schema key, whatever it says', () => {
    assert.deepEqual(wf.validate({ ...workflow(), schema: 3 }), []);
  });

  it('accepts a file that states no schema', () => {
    assert.equal('schema' in workflow(), false);
    assert.deepEqual(wf.validate(workflow()), []);
  });

  it('refuses a workflow with no steps at all', () => {
    assert.deepEqual(wf.validate(workflow({ steps: [] })), ['needs at least one step']);
  });

  it('names a repeated step id, since a run addresses steps by it', () => {
    const reasons = wf.validate(
      workflow({
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'a' },
          { id: 'plan', label: 'Again', prompt: 'b', needs: ['plan'] }
        ]
      })
    );
    assert.deepEqual(reasons, ['step 2 repeats the id plan']);
  });

  it('refuses a step with both a uses and a prompt, and one with neither', () => {
    assert.deepEqual(
      wf.validate(workflow({ steps: [{ id: 'a', label: 'A', uses: '/x', prompt: 'y' }] })),
      ['a needs exactly one of uses or prompt']
    );
    assert.deepEqual(wf.validate(workflow({ steps: [{ id: 'a', label: 'A' }] })), [
      'a needs exactly one of uses or prompt'
    ]);
  });

  // Hand-written files, so the shape is a claim rather than a fact: every one of
  // these used to throw out of `validate` — reported as "unreadable" by the one
  // caller that wraps it in a `try`, and as a crash by any that does not.
  it('refuses a step whose prompt is not text, rather than throwing on it', () => {
    assert.deepEqual(wf.validate({ ...workflow(), steps: [{ id: 'a', label: 'A', prompt: 42 }] }), [
      'a needs its prompt to be text'
    ]);
    assert.deepEqual(wf.validate({ ...workflow(), steps: [{ id: 'a', label: 'A', uses: 7 }] }), [
      'a needs its uses to be text'
    ]);
  });

  it('refuses a workflow whose steps are not steps', () => {
    assert.deepEqual(wf.validate({ ...workflow(), steps: 'plan then build' }), [
      'needs at least one step'
    ]);
    assert.deepEqual(wf.validate({ ...workflow(), steps: [null] }), ['step 1 needs an id']);
    assert.deepEqual(wf.validate({ ...workflow(), steps: ['plan'] }), ['step 1 needs an id']);
  });

  it('refuses a check that is not one', () => {
    assert.deepEqual(
      wf.validate({
        ...workflow(),
        steps: [{ id: 'a', label: 'A', prompt: 'x', check: 'npm run check' }]
      }),
      ['a has a check with no command']
    );
  });

  it('refuses a step that reads the output of a later step', () => {
    const reasons = wf.validate(
      workflow({
        steps: [
          { id: 'build', label: 'Build', prompt: 'read ${step.plan.output}' },
          { id: 'plan', label: 'Plan', prompt: 'plan', output: 'plan.md', needs: ['build'] }
        ]
      })
    );
    assert.deepEqual(reasons, ['build reads the output of plan, which is not an earlier step']);
  });

  it('refuses a step that reads an earlier step declaring no output', () => {
    const reasons = wf.validate(
      workflow({
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'plan' },
          { id: 'build', label: 'Build', prompt: 'read ${step.plan.output}', needs: ['plan'] }
        ]
      })
    );
    assert.deepEqual(reasons, ['build reads the output of plan, which declares none']);
  });

  it('collects every reason at once, rather than the first', () => {
    const reasons = wf.validate({ id: '', label: '', steps: [] });
    assert.deepEqual(reasons, ['needs an id', 'needs a label', 'needs at least one step']);
  });

  it('reads lane keys beside a stale schema 1 as it reads them anywhere', () => {
    const steps = [
      { id: 'a', label: 'A', prompt: 'a' },
      {
        id: 'b',
        label: 'B',
        prompt: 'b',
        needs: ['a'],
        lane: 's1',
        brand: 'claude' as const,
        model: 'opus-5'
      }
    ];
    assert.deepEqual(wf.validate({ ...workflow({ steps }), schema: 1 }), []);
  });

  it('refuses a needs that names a step which is not earlier', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [
            { id: 'build', label: 'Build', prompt: 'x', needs: ['plan'] },
            { id: 'plan', label: 'Plan', prompt: 'y', needs: ['build'] }
          ]
        })
      ),
      ['build needs plan, which is not an earlier step']
    );
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [
            { id: 'a', label: 'A', prompt: 'a' },
            { id: 'b', label: 'B', prompt: 'b', needs: ['a', 'gone'] }
          ]
        })
      ),
      ['b needs gone, which is not an earlier step']
    );
  });

  it('refuses a needs that is not a list of step ids', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [{ id: 'a', label: 'A', prompt: 'a', needs: 'b' as unknown as string[] }]
        })
      ),
      ['a needs its needs to be a list of step ids']
    );
  });

  it('refuses a lane that is not a name', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [{ id: 'a', label: 'A', prompt: 'a', lane: 1 as unknown as string }]
        })
      ),
      ['a needs its lane to be a name']
    );
  });

  it('refuses a lane whose later step does not follow the previous one', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [
            { id: 'a', label: 'A', prompt: 'a' },
            { id: 'b', label: 'B', prompt: 'b', lane: 's1' },
            { id: 'c', label: 'C', prompt: 'c', lane: 's1', needs: ['a'] }
          ]
        })
      ),
      ['c does not follow b, the previous step of lane s1']
    );
  });

  it('refuses brand, model and effort except on the step that opens a lane', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [{ id: 'a', label: 'A', prompt: 'a', model: 'opus-5' }]
        })
      ),
      ['a states model, which belongs on the step that opens a lane']
    );
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [
            { id: 'a', label: 'A', prompt: 'a', lane: 's1', brand: 'claude' },
            { id: 'b', label: 'B', prompt: 'b', lane: 's1', needs: ['a'], effort: 'high' }
          ]
        })
      ),
      ['b states effort, which belongs on the step that opens a lane']
    );
  });

  it('refuses a lane opener whose model the spawn check would refuse', () => {
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [{ id: 'a', label: 'A', prompt: 'a', lane: 's1', model: 'opus-5' }]
        })
      ),
      ['a --model-id needs --brand; pass neither to inherit from the spawning session']
    );
    assert.deepEqual(
      wf.validate(
        workflow({
          steps: [
            { id: 'a', label: 'A', prompt: 'a', lane: 's1', brand: 'claude', model: 'grok-4' }
          ]
        })
      ),
      ['a --model-id grok-4 does not belong to --brand claude']
    );
  });

  it('accepts the eleven-step review', () => {
    const step = (
      id: string,
      label: string,
      prompt: string,
      extra: Partial<Definition['steps'][number]> = {}
    ) => ({ id, label, prompt, ...extra });
    assert.deepEqual(
      wf.validate({
        id: 'review',
        label: 'Review loop',
        steps: [
          step('impl', 'Implement this task', 'Read the task and split it.'),
          step('wire', 'Do the wiring', 'Take the wiring half.', { needs: ['impl'] }),
          step('ui', 'Do the UI', 'Take the UI half.', {
            lane: 's1',
            needs: ['impl'],
            brand: 'claude',
            model: 'opus-5'
          }),
          step('rw', 'Review the wiring', 'Review the wiring diff.', {
            lane: 's2',
            needs: ['wire'],
            brand: 'claude',
            model: 'sonnet-5',
            effort: 'medium'
          }),
          step('ru', 'Review the UI', 'Review the UI diff.', {
            lane: 's3',
            needs: ['ui'],
            brand: 'claude',
            model: 'sonnet-5',
            effort: 'medium'
          }),
          step('aw', 'Apply the findings', 'Apply the wiring findings.', { needs: ['rw'] }),
          step('au', 'Apply the findings', 'Apply the UI findings.', { lane: 's1', needs: ['ru'] }),
          step('int', 'Converge and integrate', 'Merge both halves.', { needs: ['aw', 'au'] }),
          step('riw', 'Review the integration', 'Review wiring regressions.', {
            lane: 's2',
            needs: ['int']
          }),
          step('riu', 'Review the integration', 'Review UI regressions.', {
            lane: 's3',
            needs: ['int']
          }),
          step('ship', 'Converge, test, commit', 'Run the gate, then commit.', {
            needs: ['riw', 'riu']
          })
        ]
      }),
      []
    );
  });
});

describe('substitute', () => {
  it('fills in every reference it has a value for', () => {
    const { text, unresolved } = wf.substitute('${identifier} ${title} in ${cwd}', {
      identifier: 'ENG-1',
      title: 'Fix it',
      cwd: '/proj'
    });
    assert.equal(text, 'ENG-1 Fix it in /proj');
    assert.deepEqual(unresolved, []);
  });

  it('fills in a step output by its whole dotted name', () => {
    const { text } = wf.substitute('read ${step.plan.output}', { 'step.plan.output': 'plan.md' });
    assert.equal(text, 'read plan.md');
  });

  it('leaves an unresolved reference verbatim and reports it', () => {
    const { text, unresolved } = wf.substitute('read the plan at ${step.plan.output}', {});
    assert.equal(text, 'read the plan at ${step.plan.output}');
    assert.deepEqual(unresolved, ['step.plan.output']);
  });

  it('treats a value that is there but empty as unresolved too', () => {
    const { text, unresolved } = wf.substitute('about ${title}', { title: '' });
    assert.equal(text, 'about ${title}');
    assert.deepEqual(unresolved, ['title']);
  });

  it('leaves a template with no references alone', () => {
    assert.equal(wf.substitute('just words', {}).text, 'just words');
  });
});

describe('readWorkflows', () => {
  it('is empty on a machine that has authored none', async () => {
    assert.deepEqual(await wf.readWorkflows(), []);
  });

  it('reads the definitions it finds, and skips what it cannot use', async () => {
    await writeJson(path.join(workflowsDir, 'ship.json'), workflow());
    await writeJson(path.join(workflowsDir, 'broken.json'), workflow({ steps: [] }));
    await write(path.join(workflowsDir, 'half.json'), '{"schema":1,"id":"h"');
    await write(path.join(workflowsDir, 'notes.txt'), 'not a workflow');

    const found = await wf.readWorkflows();
    assert.deepEqual(
      found.map((w) => w.id),
      ['ship']
    );
  });

  it('writes in the chain an old file leaves to its order, and drops its schema', async () => {
    await writeJson(path.join(workflowsDir, 'old-chain.json'), {
      schema: 1,
      id: 'old-chain',
      label: 'Old chain',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b' },
        { id: 'c', label: 'C', prompt: 'c', needs: [] }
      ]
    });
    const read = (await wf.readWorkflows()).find((w) => w.id === 'old-chain');
    assert.ok(read);
    assert.equal('schema' in read, false);
    assert.deepEqual(
      read.steps.map((s) => s.needs),
      [undefined, ['a'], ['b']]
    );
  });

  it('drops a lanes that is not a list of names, and still reads the file', async () => {
    await writeJson(path.join(workflowsDir, 'odd-lanes.json'), {
      ...workflow({ id: 'odd-lanes' }),
      lanes: [1]
    });
    const read = (await wf.readWorkflows()).find((w) => w.id === 'odd-lanes');
    assert.ok(read);
    assert.equal('lanes' in read, false);
  });

  it('leaves a graph alone: a step with no needs there waits for nothing', async () => {
    await writeJson(path.join(workflowsDir, 'old-graph.json'), {
      schema: 2,
      id: 'old-graph',
      label: 'Old graph',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', lane: 's1', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 's2', needs: ['a'] },
        // Unwired: a per-step fill would wire it to c and let it arm.
        { id: 'd', label: 'D', prompt: 'd', lane: 's3' }
      ]
    });
    const read = (await wf.readWorkflows()).find((w) => w.id === 'old-graph');
    assert.deepEqual(
      read?.steps.map((s) => s.needs),
      [undefined, ['a'], ['a'], undefined]
    );
  });

  it('still refuses a one-lane file whose only needs names no step', async () => {
    await writeJson(path.join(workflowsDir, 'dangling.json'), {
      id: 'dangling',
      label: 'Dangling',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['gone'] }
      ]
    });
    assert.equal(
      (await wf.readWorkflows()).some((w) => w.id === 'dangling'),
      false
    );
  });

  it('carries the file each definition was read from', async () => {
    // The id is read from inside the file, so the path is not derivable from it
    // — and the editor writes back through the path it was read at.
    await writeJson(path.join(workflowsDir, 'renamed.json'), workflow({ id: 'ship-it' }));

    const found = await wf.readWorkflows();
    assert.equal(
      found.find((w) => w.id === 'ship-it')?.path,
      path.join(workflowsDir, 'renamed.json')
    );
  });
});

describe('readWorkflowIndex', () => {
  const at = (name: string): string => path.join(workflowsDir, name);

  it('keeps a forward-needs file editable and out of the runnable list', async () => {
    await writeJson(at('forward-needs.json'), {
      id: 'forward-needs',
      label: 'Forward needs',
      description: 'stays on disk',
      steps: [
        {
          id: 'plan',
          label: 'Plan',
          prompt: 'plan',
          output: 'plan.md',
          check: { command: 'true' }
        },
        { id: 'review', label: 'Review', prompt: 'review', needs: ['ship'] },
        { id: 'ship', label: 'Ship', prompt: 'ship', needs: ['plan'] }
      ]
    });
    const index = await wf.readWorkflowIndex();
    assert.equal(
      index.runnable.some((w) => w.id === 'forward-needs'),
      false
    );
    const edit = index.edits.find((w) => w.id === 'forward-needs');
    assert.ok(edit);
    assert.equal(edit.path, at('forward-needs.json'));
    assert.deepEqual(
      edit.steps.map((s) => s.id),
      ['plan', 'review', 'ship']
    );
    assert.equal('output' in (edit.steps[0] ?? {}), false);
    assert.equal('check' in (edit.steps[0] ?? {}), false);
    // review's forward edge reaches plan through ship, so the lane check does
    // not also say review fails to follow plan. The card still names the edge.
    assert.deepEqual(edit.reasons, [
      'review needs ship, which is not an earlier step',
      'ship does not follow review, the previous step of the armed session'
    ]);
  });

  it('keeps a dangling needs and an unchained lane editable, in file order', async () => {
    await writeJson(at('edit-dangling.json'), {
      id: 'edit-dangling',
      label: 'Edit dangling',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['gone'] }
      ]
    });
    await writeJson(at('unchained.json'), {
      id: 'unchained',
      label: 'Unchained',
      lanes: ['side'],
      steps: [
        { id: 'root', label: 'Root', prompt: 'root' },
        { id: 'open', label: 'Open', prompt: 'open', lane: 'side' },
        { id: 'later', label: 'Later', prompt: 'later', lane: 'side' }
      ]
    });
    const index = await wf.readWorkflowIndex();
    assert.equal(
      (await wf.readWorkflows()).some((w) => w.id === 'edit-dangling' || w.id === 'unchained'),
      false
    );
    const dangling = index.edits.find((w) => w.id === 'edit-dangling');
    const lane = index.edits.find((w) => w.id === 'unchained');
    assert.ok(dangling?.reasons.some((r) => r.includes('not an earlier step')));
    assert.ok(lane);
    assert.deepEqual(lane.lanes, ['side']);
    assert.deepEqual(
      lane.steps.map((s) => s.id),
      ['root', 'open', 'later']
    );
    assert.ok(lane.reasons.some((r) => r.includes('does not follow')));
  });

  it('reads a valid file as runnable only', async () => {
    await writeJson(at('plain-ok.json'), {
      id: 'plain-ok',
      label: 'Plain',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] }
      ]
    });
    const index = await wf.readWorkflowIndex();
    assert.equal(
      index.runnable.some((w) => w.id === 'plain-ok'),
      true
    );
    assert.equal(
      index.edits.some((w) => w.id === 'plain-ok'),
      false
    );
  });

  it('skips what the editor cannot draw, and does not throw on a bad file', async () => {
    await writeJson(at('num-prompt.json'), {
      id: 'num-prompt',
      label: 'Num',
      steps: [{ id: 'a', label: 'A', prompt: 1 }]
    });
    await writeJson(at('bad-needs.json'), {
      id: 'bad-needs',
      label: 'Bad needs',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: 'gone' }
      ]
    });
    await writeJson(at('mixed-fault.json'), {
      id: 'mixed-fault',
      label: 'Mixed',
      steps: [
        { id: 'open', label: 'Open', prompt: 'open', lane: 'side', model: 'opus' },
        { id: 'next', label: 'Next', prompt: 'next', lane: 'side', needs: ['later'] },
        { id: 'later', label: 'Later', prompt: 'later', lane: 'side' }
      ]
    });
    const index = await wf.readWorkflowIndex();
    for (const id of ['num-prompt', 'bad-needs', 'mixed-fault', 'h']) {
      assert.equal(
        index.runnable.some((w) => w.id === id),
        false,
        id
      );
      assert.equal(
        index.edits.some((w) => w.id === id),
        false,
        id
      );
    }
    assert.equal(
      index.edits.some((w) => w.path.endsWith('half.json') || w.path.endsWith('notes.txt')),
      false
    );
  });

  it('opens the broken file from the read, and a repaired save can run', async (t) => {
    await writeJson(at('hand-broken.json'), {
      id: 'hand-broken',
      label: 'Hand broken',
      description: 'kept on save',
      steps: [
        {
          id: 'plan',
          label: 'Plan',
          prompt: 'plan',
          output: 'plan.md',
          check: { command: 'true' }
        },
        { id: 'review', label: 'Review', prompt: 'review', needs: ['ship'] },
        { id: 'ship', label: 'Ship', prompt: 'ship', needs: ['plan'] }
      ]
    });
    await writeJson(at('beside.json'), {
      id: 'beside',
      label: 'Beside',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] }
      ]
    });
    const refused = await wf.armWorkflow('hand-broken', '/proj');
    assert.equal('refused' in refused, true);
    if (!('refused' in refused)) return;
    assert.match(refused.refused, /no such workflow on this machine/);

    const index = await wf.readWorkflowIndex();
    const broken = index.edits.find((w) => w.id === 'hand-broken');
    assert.ok(broken);
    const blank = {
      sessions: [],
      workspaceFolder: undefined,
      folderRoots: new Map(),
      arrangements: new Map(),
      thread: undefined,
      machine: undefined,
      cafe: false,
      cafeRemote: false,
      cafeWarm: false,
      warmOn: false,
      orchestrators: false,
      skipPermissions: false,
      soundLevel: 'off' as const,
      executionCapture: false,
      devServers: false,
      mascot: false,
      warmCache: false,
      theme: 'follow' as const,
      model: '',
      efforts: {},
      models: [],
      tickets: undefined,
      ticketSource: undefined,
      workflowOrder: undefined,
      skills: new Map(),
      now: 0
    };
    const only = buildState({ ...blank, workflows: [], workflowEdits: [broken] });
    const full = buildState({
      ...blank,
      workflows: index.runnable,
      workflowEdits: index.edits
    });

    // After tempHome: a static import of the harness would resolve `~` first.
    const harness = await import('../harness');
    const p = harness.openPanel(t);
    const doc = p.window.document;
    const groups = [
      harness.groupView({ sessions: [harness.cardView({ pid: 5, owned: true, startedAt: 5_000 })] })
    ];
    const thread = harness.threadView({ pid: 5, startedAt: 5_000, owned: true });
    p.push(
      harness.stateMessage(groups, {
        workflows: only.workflows,
        workflowEdits: only.workflowEdits
      })
    );
    assert.ok(doc.querySelector('#bottomhub .wmore'), 'a repair file is enough for the sheet');
    assert.doesNotMatch(doc.querySelector('#bottomhub')?.textContent ?? '', /\+ New workflow/);

    p.push(
      harness.stateMessage(groups, { workflows: full.workflows, workflowEdits: full.workflowEdits })
    );
    doc.querySelector<HTMLElement>('.card')?.click();
    p.push(
      harness.stateMessage(groups, {
        workflows: full.workflows,
        workflowEdits: full.workflowEdits,
        thread
      })
    );
    doc.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
    const repair = doc.querySelector<HTMLElement>(
      '#bottomdrawer-body .wsrow[data-id="hand-broken"]'
    );
    const runnable = doc.querySelector<HTMLElement>('#bottomdrawer-body .wsrow[data-id="beside"]');
    assert.ok(repair && runnable);
    assert.equal(repair.getAttribute('role'), null);
    assert.equal(repair.dataset.repair, 'true');
    assert.equal(runnable.getAttribute('role'), null);

    repair.click();
    assert.equal(doc.getElementById('bottomdrawer')?.hidden, false);
    assert.equal(doc.querySelector('#wattach .wflow.armed'), null);

    doc.querySelector<HTMLElement>('#wattach .fpill')?.click();
    const offered = harness.attachRows(p);
    assert.equal(offered.includes('Hand broken'), false);
    assert.equal(offered.includes('Beside'), true);

    repair.querySelector<HTMLElement>('.act.edit')?.click();
    assert.equal(doc.getElementById('wfeditor')?.hidden, false);
    const why = [...doc.querySelectorAll('#wfeditor .wcnode[data-node="review"] .wcwhy')]
      .map((node) => node.textContent ?? '')
      .join('\n');
    assert.match(why, /not an earlier step/);
    const save = (): HTMLButtonElement | null =>
      doc.querySelector<HTMLButtonElement>('#wfeditor .wesave');
    assert.equal(save()?.disabled, true);
    const posted = p.posted.filter((m) => m.type === 'saveWorkflow').length;
    save()?.click();
    assert.equal(p.posted.filter((m) => m.type === 'saveWorkflow').length, posted);

    const hitIs = (target: Element | null): void => {
      Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: () => target });
    };
    const drawWire = (from: string, to: string): void => {
      hitIs(doc.querySelector(`#wfeditor .wcnode[data-node="${to}"]`));
      doc
        .querySelector(`#wfeditor .wcnode[data-node="${from}"] .wcport`)
        ?.dispatchEvent(new p.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      doc.dispatchEvent(new p.window.MouseEvent('pointermove', { bubbles: true, clientX: 40 }));
      doc.dispatchEvent(new p.window.MouseEvent('pointerup', { bubbles: true, clientX: 40 }));
    };
    doc
      .querySelector<SVGPathElement>('#wfeditor path.wchit[data-from="ship"][data-to="review"]')
      ?.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    doc.querySelector<HTMLButtonElement>('#wfeditor .wirex')?.click();
    drawWire('plan', 'review');
    drawWire('review', 'ship');
    assert.equal(save()?.disabled, false);
    save()?.click();
    const msg = p.posted.filter((m) => m.type === 'saveWorkflow').at(-1);
    assert.ok(msg && msg.type === 'saveWorkflow');
    if (!msg || msg.type !== 'saveWorkflow') return;
    assert.deepEqual(
      msg.steps.map((s) => s.id),
      ['plan', 'review', 'ship']
    );
    assert.deepEqual(msg.steps[1]?.needs, ['plan']);
    assert.deepEqual(msg.steps[2]?.needs, ['plan', 'review']);

    const saved = await wf.saveWorkflow({
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      label: msg.label,
      ...(msg.lanes ? { lanes: msg.lanes } : {}),
      steps: msg.steps
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.workflow.description, 'kept on save');
    assert.equal(saved.workflow.steps[0]?.output, 'plan.md');
    assert.deepEqual(saved.workflow.steps[0]?.check, { command: 'true' });
    const after = await wf.readWorkflowIndex();
    assert.equal(
      after.runnable.some((w) => w.id === 'hand-broken'),
      true
    );
    assert.equal(
      after.edits.some((w) => w.id === 'hand-broken'),
      false
    );
    const armed = await wf.armWorkflow('hand-broken', '/proj');
    assert.equal('workflow' in armed, true);
  });
});

describe('enrich', () => {
  const named = { label: 'Ship it', id: 'ship-it' };

  it('names the label and the id, and puts the message under it', () => {
    const text = wf.enrich(named, 'do the thing');
    assert.match(text, /"Ship it" \(ship-it\)/);
    assert.ok(text.endsWith('\n\ndo the thing'));
  });

  it('is the whole message when nothing was typed', () => {
    // A mention alone is a send, exactly as a pasted image alone is.
    const text = wf.enrich(named, '   ');
    assert.ok(!text.includes('\n\n'));
    assert.ok(text.endsWith('(ship-it).'));
  });

  it('inlines no step, so the composer stays readable', () => {
    assert.ok(!wf.enrich(named, '').includes('plan'));
  });

  it('hands over no path, which is the whole of step-blind delivery', () => {
    // The assertion this feature exists for: a session that is told where the
    // file is reads all of it, and every later step's criteria are in context
    // before step 1 begins. Nothing composed here may name one.
    const withPath = { label: 'Ship it', id: 'ship-it', path: '/w/ship.json' };
    const text = wf.enrich(withPath, 'do the thing');
    assert.ok(!text.includes('/w/ship.json'));
    assert.ok(!text.includes('.json'));
  });
});

describe('resolveUses', () => {
  it('finds a user command and a user skill', async () => {
    await write(path.join(claude, 'commands', 'deploy.md'), '# deploy');
    await write(path.join(claude, 'skills', 'review', 'SKILL.md'), '# review');
    assert.equal(await wf.resolveUses('/deploy', '/nowhere'), true);
    assert.equal(await wf.resolveUses('/review', '/nowhere'), true);
  });

  it('finds a project command and a project skill, in that checkout only', async () => {
    const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-proj-'));
    await write(path.join(proj, '.claude', 'commands', 'local.md'), '# local');
    await write(path.join(proj, '.claude', 'skills', 'housestyle', 'SKILL.md'), '# style');

    assert.equal(await wf.resolveUses('/local', proj), true);
    assert.equal(await wf.resolveUses('/housestyle', proj), true);
    // The same names, one directory over: per-cwd is the whole reason arming
    // validates against the session's own checkout.
    assert.equal(await wf.resolveUses('/local', os.tmpdir()), false);
    assert.equal(await wf.resolveUses('/housestyle', os.tmpdir()), false);
  });

  // Deliberately unchecked, and this test is where that decision is written down.
  // A plugin's trees carry a marketplace directory and a content hash, so they can
  // only be walked, and a walk knows only the layouts that have been observed —
  // which would refuse a valid workflow at arm time for a plugin that put its
  // command somewhere new. Accepting costs one wasted step; refusing costs a run.
  it('accepts any plugin-qualified name without looking for it', async () => {
    assert.equal(await wf.resolveUses('/caveman:brief', '/nowhere'), true);
    assert.equal(await wf.resolveUses('/nothing:installed-here', '/nowhere'), true);
  });

  it('says no to a name nothing declares, and to no name at all', async () => {
    assert.equal(await wf.resolveUses('/nosuchthing', '/nowhere'), false);
    assert.equal(await wf.resolveUses('/', '/nowhere'), false);
  });
});

describe('slugId', () => {
  it('slugs a label and falls back when empty', () => {
    assert.equal(wf.slugId('Plan → Build', 'x'), 'plan-build');
    assert.equal(wf.slugId('  ', 'workflow'), 'workflow');
  });
});

describe('deleteWorkflow', () => {
  it('removes a file that is there', async () => {
    await writeJson(path.join(workflowsDir, 'doomed.json'), {
      schema: 1,
      id: 'doomed',
      label: 'Doomed',
      steps: [{ id: 'a', label: 'A', prompt: 'go' }]
    });
    assert.ok((await wf.readWorkflows()).some((w) => w.id === 'doomed'));
    const gone = await wf.deleteWorkflow('doomed');
    assert.equal(gone.ok, true);
    assert.ok(!(await wf.readWorkflows()).some((w) => w.id === 'doomed'));
  });

  it('is ok when the file is already gone', async () => {
    const gone = await wf.deleteWorkflow('never-was');
    assert.equal(gone.ok, true);
  });

  it('refuses an unsafe id', async () => {
    const bad = await wf.deleteWorkflow('../escape');
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.ok(bad.reasons.some((r) => r.includes('invalid')));
  });
});

describe('duplicateWorkflow', () => {
  /** Everything the editor's form never shows, on one workflow. */
  const rich = {
    schema: 1,
    id: 'rich',
    label: 'Rich',
    steps: [
      {
        id: 'one',
        label: 'One',
        uses: '/implement',
        check: { command: 'npm test' },
        output: 'plan.md',
        advance: 'auto'
      },
      { id: 'two', label: 'Two', prompt: 'build ${step.one.output}' }
    ]
  };

  it('keeps every field a round trip through the form would drop', async () => {
    await writeJson(path.join(workflowsDir, 'rich.json'), rich);
    const copy = await wf.duplicateWorkflow('rich');
    assert.equal(copy.ok, true);
    if (!copy.ok) return;

    assert.equal(copy.workflow.label, 'Rich copy');
    assert.notEqual(copy.workflow.id, 'rich');
    // `uses` above all: a create deletes it where a prompt is set, and the copy
    // would stop resolving at arm time.
    assert.deepEqual(copy.workflow.steps[0], rich.steps[0]);
    // An old chain's order comes out written, and its schema does not.
    assert.deepEqual(copy.workflow.steps[1], { ...rich.steps[1], needs: ['one'] });
    assert.equal('schema' in copy.workflow, false);
    const raw = JSON.parse(
      await fs.readFile(path.join(workflowsDir, `${copy.workflow.id}.json`), 'utf8')
    ) as Record<string, unknown>;
    assert.equal('schema' in raw, false);
  });

  it('keeps the lane order', async () => {
    await writeJson(path.join(workflowsDir, 'dup-laned.json'), {
      id: 'dup-laned',
      label: 'Dup laned',
      lanes: ['s2', 's1'],
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', lane: 's1', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 's2', needs: ['a'] }
      ]
    });
    const copy = await wf.duplicateWorkflow('dup-laned');
    assert.equal(copy.ok, true);
    if (!copy.ok) return;
    assert.deepEqual(copy.workflow.lanes, ['s2', 's1']);
  });

  it('refuses an id that is not a single safe segment as invalid', async () => {
    const unsafe = await wf.duplicateWorkflow('../escape');
    assert.equal(unsafe.ok, false);
    if (unsafe.ok) return;
    assert.ok(unsafe.reasons.some((r) => r.includes('invalid')));
  });
});

describe('saveWorkflow', () => {
  it('writes a valid create and reads it back', async () => {
    const saved = await wf.saveWorkflow({
      label: 'First chain',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan the work' },
        { id: 'build', label: 'Build', prompt: 'implement it', needs: ['plan'] }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal('schema' in saved.workflow, false);
    assert.equal(saved.workflow.id, 'first-chain');
    assert.equal(saved.workflow.steps.length, 2);
    const found = await wf.readWorkflows();
    assert.ok(found.some((w) => w.id === 'first-chain'));
  });

  it('writes the lane order, without a lane no step is in', async () => {
    const saved = await wf.saveWorkflow({
      label: 'Laned',
      lanes: ['session 2', 'gone', 'session 1'],
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'a', label: 'A', prompt: 'a', lane: 'session 1', needs: ['plan'] },
        { id: 'b', label: 'B', prompt: 'b', lane: 'session 2', needs: ['plan'] }
      ]
    });
    assert.equal(saved.ok, true);
    const read = (await wf.readWorkflows()).find((w) => w.id === 'laned');
    assert.deepEqual(read?.lanes, ['session 2', 'session 1']);
  });

  it('writes no lanes key when no step names a lane', async () => {
    const saved = await wf.saveWorkflow({
      label: 'Unlaned',
      lanes: ['gone'],
      steps: [{ id: 'plan', label: 'Plan', prompt: 'plan' }]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal('lanes' in saved.workflow, false);
  });

  it('writes nothing when invalid', async () => {
    const before = await wf.readWorkflows();
    const saved = await wf.saveWorkflow({
      label: 'Broken',
      steps: [{ label: 'Only', prompt: '' }]
    });
    assert.equal(saved.ok, false);
    if (saved.ok) return;
    assert.ok(saved.reasons.length > 0);
    assert.deepEqual(await wf.readWorkflows(), before);
  });

  it('preserves check on a sibling step when editing one prompt', async () => {
    await writeJson(path.join(workflowsDir, 'keep.json'), {
      schema: 1,
      id: 'keep',
      label: 'Keep fields',
      steps: [
        { id: 'a', label: 'A', prompt: 'first', check: { command: 'npm run check' } },
        { id: 'b', label: 'B', prompt: 'second', output: 'out.md' }
      ]
    });
    const saved = await wf.saveWorkflow({
      id: 'keep',
      label: 'Keep fields',
      steps: [
        { id: 'a', label: 'A', prompt: 'first revised' },
        { id: 'b', label: 'B', prompt: 'second', needs: ['a'] }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.deepEqual(saved.workflow.steps[0]?.check, { command: 'npm run check' });
    assert.equal(saved.workflow.steps[1]?.output, 'out.md');
    assert.equal(saved.workflow.steps[0]?.prompt, 'first revised');
  });

  it('tells the editor no schema', () => {
    assert.equal('schema' in toWorkflowView({ ...workflow(), path: '/x/ship.json' }), false);
  });

  it('keeps a file identical apart from the prompt the draft changed, and its stale schema', async () => {
    const file = {
      schema: 2 as const,
      id: 'lane-keep',
      label: 'Lane keep',
      description: 'kept',
      steps: [
        {
          id: 'a',
          label: 'A',
          prompt: 'first',
          check: { command: 'npm run check' },
          output: 'out.md',
          advance: 'manual' as const,
          onFail: 'ask' as const,
          retries: 1
        },
        {
          id: 'b',
          label: 'B',
          prompt: 'second',
          needs: ['a'],
          lane: 's1',
          brand: 'claude' as const,
          model: 'opus-5',
          effort: 'high',
          check: { command: 'npm run check' },
          output: 'b.md'
        }
      ]
    };
    await writeJson(path.join(workflowsDir, 'lane-keep.json'), file);
    const saved = await wf.saveWorkflow({
      id: 'lane-keep',
      label: 'Lane keep',
      steps: [
        { id: 'a', label: 'A', prompt: 'first revised' },
        {
          id: 'b',
          label: 'B',
          prompt: 'second',
          needs: ['a'],
          lane: 's1',
          brand: 'claude',
          model: 'opus-5',
          effort: 'high'
        }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const raw = JSON.parse(
      await fs.readFile(path.join(workflowsDir, 'lane-keep.json'), 'utf8')
    ) as unknown;
    const { schema: _stale, ...kept } = file;
    const expected = {
      ...kept,
      steps: file.steps.map((step, i) => (i === 0 ? { ...step, prompt: 'first revised' } : step))
    };
    assert.equal(JSON.stringify(raw), JSON.stringify(expected));
  });

  it('a create with a lane writes its lane and needs, and no schema', async () => {
    const saved = await wf.saveWorkflow({
      label: 'Two sessions',
      steps: [
        { label: 'Plan', prompt: 'plan the work' },
        { label: 'Build', prompt: 'implement it', lane: 'session 1', needs: ['plan'] }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal('schema' in saved.workflow, false);
    assert.equal(saved.workflow.steps[1]?.lane, 'session 1');
    assert.deepEqual(saved.workflow.steps[1]?.needs, ['plan']);
  });

  it('suffixes a repeated step id and does not rewrite the needs that named it', async () => {
    const saved = await wf.saveWorkflow({
      label: 'Dup step',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan the work' },
        {
          id: 'plan',
          label: 'Plan again',
          prompt: 'the other one',
          lane: 'session 1',
          needs: ['plan']
        }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.workflow.steps[0]?.id, 'plan');
    assert.equal(saved.workflow.steps[1]?.id, 'plan-2');
    assert.deepEqual(saved.workflow.steps[1]?.needs, ['plan']);
  });

  it('a draft that states brand, model and effort overwrites those and leaves the rest', async () => {
    await writeJson(path.join(workflowsDir, 'lane-pick.json'), {
      schema: 2,
      id: 'lane-pick',
      label: 'Lane pick',
      steps: [
        { id: 'a', label: 'A', prompt: 'first', check: { command: 'true' } },
        {
          id: 'b',
          label: 'B',
          prompt: 'second',
          needs: ['a'],
          lane: 's1',
          brand: 'claude',
          model: 'opus-5',
          effort: 'high'
        }
      ]
    });
    const saved = await wf.saveWorkflow({
      id: 'lane-pick',
      label: 'Lane pick',
      steps: [
        { id: 'a', label: 'A', prompt: 'first' },
        {
          id: 'b',
          label: 'B',
          prompt: 'second',
          needs: ['a'],
          lane: 's1',
          brand: 'grok',
          model: 'grok-4',
          effort: 'low'
        }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal('schema' in saved.workflow, false);
    assert.deepEqual(saved.workflow.steps[0]?.check, { command: 'true' });
    const opener = saved.workflow.steps[1];
    assert.equal(opener?.brand, 'grok');
    assert.equal(opener?.model, 'grok-4');
    assert.equal(opener?.effort, 'low');
    assert.equal(opener?.lane, 's1');
    assert.deepEqual(opener?.needs, ['a']);
    assert.equal(opener?.prompt, 'second');
  });

  it('refuses an edit of an unknown id', async () => {
    const saved = await wf.saveWorkflow({
      id: 'ghost',
      label: 'Ghost',
      steps: [{ label: 'A', prompt: 'x' }]
    });
    assert.equal(saved.ok, false);
  });

  it('refuses an edit id that is not a single path segment', async () => {
    const saved = await wf.saveWorkflow({
      id: '../escape',
      label: 'Escape',
      steps: [{ label: 'A', prompt: 'x' }]
    });
    assert.equal(saved.ok, false);
    if (saved.ok) return;
    assert.ok(saved.reasons.some((r) => r.includes('invalid workflow id')));
  });

  it('create does not clobber an existing slug file', async () => {
    const first = await wf.saveWorkflow({
      label: 'Twice',
      steps: [{ label: 'A', prompt: 'first body' }]
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.workflow.id, 'twice');

    const second = await wf.saveWorkflow({
      label: 'Twice',
      steps: [{ label: 'B', prompt: 'second body' }]
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.workflow.id, 'twice-2');

    const found = await wf.readWorkflows();
    const a = found.find((w) => w.id === 'twice');
    const b = found.find((w) => w.id === 'twice-2');
    assert.equal(a?.steps[0]?.prompt, 'first body');
    assert.equal(b?.steps[0]?.prompt, 'second body');
  });

  it('new draft steps do not inherit index-aligned preserved fields', async () => {
    await writeJson(path.join(workflowsDir, 'reindex.json'), {
      schema: 1,
      id: 'reindex',
      label: 'Reindex',
      steps: [
        { id: 'a', label: 'A', prompt: 'old a', check: { command: 'true' } },
        { id: 'b', label: 'B', prompt: 'old b', output: 'out.md' }
      ]
    });
    // Keep only b (by id), add a new step at the former index of a.
    const saved = await wf.saveWorkflow({
      id: 'reindex',
      label: 'Reindex',
      steps: [
        { id: 'b', label: 'B', prompt: 'old b' },
        { label: 'New', prompt: 'brand new', needs: ['b'] }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(saved.workflow.steps.length, 2);
    assert.equal(saved.workflow.steps[0]?.id, 'b');
    assert.equal(saved.workflow.steps[0]?.output, 'out.md');
    const added = saved.workflow.steps[1];
    assert.ok(added);
    assert.equal(added.label, 'New');
    assert.equal(added.prompt, 'brand new');
    assert.equal(added.check, undefined);
    assert.equal(added.output, undefined);
    assert.notEqual(added.id, 'a');
  });

  it('drops uses when the form sets a prompt on that step', async () => {
    await writeJson(path.join(workflowsDir, 'uses-step.json'), {
      schema: 1,
      id: 'uses-step',
      label: 'Uses step',
      steps: [
        { id: 'do', label: 'Do', uses: '/plan', check: { command: 'true' } },
        { id: 'next', label: 'Next', prompt: 'after', output: 'out.md' }
      ]
    });
    const saved = await wf.saveWorkflow({
      id: 'uses-step',
      label: 'Uses step',
      steps: [
        { id: 'do', label: 'Do', prompt: 'now a prompt' },
        { id: 'next', label: 'Next', prompt: 'after', needs: ['do'] }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const doStep = saved.workflow.steps[0];
    assert.ok(doStep);
    assert.equal(doStep.prompt, 'now a prompt');
    assert.equal(doStep.uses, undefined);
    assert.deepEqual(doStep.check, { command: 'true' });
    assert.equal(saved.workflow.steps[1]?.output, 'out.md');
  });

  it('writes the five structural fields as posted: one left off is gone, the rest stay', async () => {
    await writeJson(path.join(workflowsDir, 'whole.json'), {
      schema: 2,
      id: 'whole',
      label: 'Whole',
      steps: [
        { id: 'a', label: 'A', prompt: 'first' },
        {
          id: 'b',
          label: 'B',
          prompt: 'second',
          needs: ['a'],
          lane: 's1',
          brand: 'claude',
          model: 'opus-5',
          effort: 'high',
          check: { command: 'true' },
          output: 'b.md',
          retries: 1
        }
      ]
    });
    const saved = await wf.saveWorkflow({
      id: 'whole',
      label: 'Whole',
      steps: [
        { id: 'a', label: 'A', prompt: 'first' },
        { id: 'b', label: 'B', prompt: 'second', needs: ['a'], lane: 's1' }
      ]
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const raw = JSON.parse(
      await fs.readFile(path.join(workflowsDir, 'whole.json'), 'utf8')
    ) as Definition;
    assert.equal('schema' in raw, false);
    assert.deepEqual(raw.steps[1], {
      id: 'b',
      label: 'B',
      prompt: 'second',
      check: { command: 'true' },
      output: 'b.md',
      retries: 1,
      needs: ['a'],
      lane: 's1'
    });
  });

  it('writes the needs a one-lane draft states, and no schema', async () => {
    await writeJson(path.join(workflowsDir, 'derive-down.json'), {
      schema: 2,
      id: 'derive-down',
      label: 'Derive down',
      steps: [
        { id: 'a', label: 'A', prompt: 'first' },
        { id: 'b', label: 'B', prompt: 'second', needs: ['a'], lane: 's1' }
      ]
    });
    const down = await wf.saveWorkflow({
      id: 'derive-down',
      label: 'Derive down',
      steps: [
        { id: 'a', label: 'A', prompt: 'first' },
        // Waits on the step before it: plain order, which the file states.
        { id: 'b', label: 'B', prompt: 'second', needs: ['a'] }
      ]
    });
    assert.equal(down.ok, true);
    if (!down.ok) return;
    assert.equal('schema' in down.workflow, false);
    assert.deepEqual(down.workflow.steps[1]?.needs, ['a']);

    const up = await wf.saveWorkflow({
      label: 'Derive up',
      steps: [
        { label: 'Plan', prompt: 'plan the work' },
        { label: 'Build', prompt: 'implement it', lane: 'session 1', needs: ['plan'] }
      ]
    });
    assert.equal(up.ok, true);
    if (!up.ok) return;
    assert.equal('schema' in up.workflow, false);
    assert.equal(up.workflow.steps[1]?.lane, 'session 1');
  });
});

describe('armable', () => {
  it('passes a workflow whose every slash name resolves', async () => {
    await write(path.join(claude, 'commands', 'implement.md'), '# implement');
    const w = workflow({ steps: [{ id: 'do', label: 'Do', uses: '/implement' }] });
    assert.deepEqual(await wf.armable(w, '/nowhere'), []);
  });

  it('names the step, the name and the directory it refused for', async () => {
    const w = workflow({ steps: [{ id: 'do', label: 'Do', uses: '/ghost' }] });
    assert.deepEqual(await wf.armable(w, '/proj'), [
      'do uses /ghost, which does not exist in /proj'
    ]);
  });

  it('checks the whole chain at once, not up to the first refusal', async () => {
    const w = workflow({
      steps: [
        { id: 'one', label: 'One', uses: '/ghost-one' },
        { id: 'two', label: 'Two', prompt: 'prose is always fine', needs: ['one'] },
        { id: 'three', label: 'Three', uses: '/ghost-two', needs: ['two'] }
      ]
    });
    const reasons = await wf.armable(w, '/proj');
    assert.equal(reasons.length, 2);
    assert.match(reasons[0] ?? '', /^one uses \/ghost-one/);
    assert.match(reasons[1] ?? '', /^three uses \/ghost-two/);
  });

  it('refuses a lane step whose skill is missing where the anchor stands', async () => {
    const w = workflow({
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'ui', label: 'UI', lane: 's1', needs: ['plan'], uses: '/ghost' }
      ]
    });
    assert.deepEqual(await wf.armable(w, '/proj'), [
      'ui uses /ghost, which does not exist in /proj'
    ]);
  });

  it('refuses a file with every step in a lane, which validate still accepts', async () => {
    const w = workflow({
      steps: [
        { id: 'a', label: 'A', prompt: 'a', lane: 's1' },
        { id: 'b', label: 'B', prompt: 'b', lane: 's2' }
      ]
    });
    assert.deepEqual(wf.validate(w), []);
    assert.deepEqual(await wf.armable(w, '/proj'), [wf.ARMED_LANE_EMPTY]);
  });

  it('refuses a session step that waits on nothing, which validate still accepts', async () => {
    const w = workflow({
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 's1' }
      ]
    });
    assert.deepEqual(wf.validate(w), []);
    const reasons = await wf.armable(w, '/proj');
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? '', /^c opens s1 with no step wired before it/);
  });

  it('reports an invalid definition rather than looking for its commands', async () => {
    assert.deepEqual(await wf.armable(workflow({ steps: [] }), '/proj'), [
      'needs at least one step'
    ]);
  });
});

describe('armWorkflow', () => {
  it('hands back the definition, path and all, when the chain resolves', async () => {
    await writeJson(path.join(workflowsDir, 'spawnable.json'), workflow({ id: 'spawnable' }));
    const armed = await wf.armWorkflow('spawnable', '/proj');
    assert.ok('workflow' in armed);
    assert.equal(armed.workflow.path, path.join(workflowsDir, 'spawnable.json'));
  });

  it('refuses an id no file on this machine answers to', async () => {
    assert.deepEqual(await wf.armWorkflow('ghost', '/proj'), {
      refused: 'ghost cannot run here: no such workflow on this machine'
    });
  });

  it('refuses a filename even beside that file, naming the id it meant', async () => {
    await writeJson(path.join(workflowsDir, 'spawnable.json'), workflow({ id: 'spawnable' }));
    assert.deepEqual(await wf.armWorkflow('spawnable.json', '/proj'), {
      refused:
        'spawnable.json cannot run here: no such workflow on this machine; a workflow is named by its id ("spawnable"), not its file'
    });
  });

  it('refuses in the label, and says which step wanted what where', async () => {
    await writeJson(
      path.join(workflowsDir, 'needs-a-skill.json'),
      workflow({
        id: 'needs-a-skill',
        label: 'Needs a skill',
        steps: [{ id: 'do', label: 'Do', uses: '/nowhere-command' }]
      })
    );
    assert.deepEqual(await wf.armWorkflow('needs-a-skill', '/proj'), {
      refused:
        'Needs a skill cannot run here: do uses /nowhere-command, which does not exist in /proj'
    });
  });
});

describe('duplicateWorkflow', () => {
  /**
   * The whole reason this is host-side and file-to-file.
   *
   * `toWorkflowView` carries id, label and a per-step prompt; a duplicate is a
   * create, so `saveWorkflow` would have no `existing` to merge from and would
   * drop every field below. The `uses` step is the loudest: through a draft it
   * comes back as a `prompt`, and the copy stops resolving at arm time — a
   * workflow that will not run, made by a menu item called Duplicate.
   */
  it('keeps every field the panel never sees', async () => {
    await writeJson(path.join(workflowsDir, 'rich.json'), {
      schema: 1,
      id: 'rich',
      label: 'Rich',
      description: 'has everything',
      steps: [
        {
          id: 'one',
          label: 'One',
          uses: '/plan',
          check: { command: 'true', cwd: '/tmp', timeoutMs: 5 },
          output: 'plan.md',
          advance: 'auto',
          onFail: 'retry',
          retries: 2
        },
        { id: 'two', label: 'Two', prompt: 'read ${step.one.output}' }
      ]
    });

    const copy = await wf.duplicateWorkflow('rich');
    assert.equal(copy.ok, true);
    if (!copy.ok) return;

    const on = JSON.parse(await fs.readFile(copy.workflow.path, 'utf8')) as Definition;
    assert.equal(on.description, 'has everything');
    assert.equal(on.steps[0]?.uses, '/plan');
    assert.equal(on.steps[0]?.prompt, undefined);
    assert.deepEqual(on.steps[0]?.check, { command: 'true', cwd: '/tmp', timeoutMs: 5 });
    assert.equal(on.steps[0]?.output, 'plan.md');
    assert.equal(on.steps[0]?.advance, 'auto');
    assert.equal(on.steps[0]?.onFail, 'retry');
    assert.equal(on.steps[0]?.retries, 2);
    assert.equal(on.steps[1]?.prompt, 'read ${step.one.output}');
  });

  it('gives the copy its own id and a name that says so', async () => {
    // A label of its own: this suite shares one home, and `Twice` is already
    // spoken for by a saveWorkflow case above.
    await writeJson(path.join(workflowsDir, 'dupe.json'), {
      schema: 1,
      id: 'dupe',
      label: 'Dupe',
      steps: [{ id: 'a', label: 'A', prompt: 'go' }]
    });

    const first = await wf.duplicateWorkflow('dupe');
    const second = await wf.duplicateWorkflow('dupe');
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.equal(first.workflow.label, 'Dupe copy');
    assert.equal(first.workflow.id, 'dupe-copy');
    // The second must not clobber the first — the suffix loop is what stops it.
    assert.equal(second.workflow.id, 'dupe-copy-2');
    const found = await wf.readWorkflows();
    assert.deepEqual(
      found
        .filter((w) => w.id.startsWith('dupe'))
        .map((w) => w.id)
        .sort(),
      ['dupe', 'dupe-copy', 'dupe-copy-2']
    );
  });

  it('refuses a workflow that is not there', async () => {
    const result = await wf.duplicateWorkflow('never-existed');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reasons[0] ?? '', /no such workflow/);
  });
});

/**
 * The mention's own gate, and the half of it this suite exists for: which
 * snapshot answers "is there a session at this pid".
 *
 * It lived in `host/` until a promoted draft's first turn was lost to it
 * (`TASK_done_draft_new_session.md`), where no test could reach it — the
 * same reason `armWorkflow` above was put here, said by the bug instead of by
 * the docstring.
 */
describe('armMention', () => {
  const session = (over: Partial<Session> = {}): Session => ({
    pid: 100,
    sessionId: 'sid-100',
    cwd: '/proj',
    name: 'card',
    status: 'idle',
    hasCommand: false,
    startedAt: 0,
    updatedAt: 0,
    transcript: '/tmp/t.jsonl',
    source: 'owned',
    windowId: 'w1',
    brand: 'claude',
    ...over
  });

  before(async () => {
    await writeJson(path.join(workflowsDir, 'mentionable.json'), workflow({ id: 'mentionable' }));
  });

  it('arms a session the poll has not caught up with', async () => {
    // The bug: `revealSession` posts the reveal and only *then* kicks a
    // refresh, so a promoted draft's first turn names a pid the board has
    // never listed. Refusing it lost the one message the reader wrote.
    const armed = await wf.armMention(100, 'mentionable', {
      board: [],
      live: [session()]
    });
    assert.ok('workflow' in armed, 'a session this window started is not gone');
    assert.equal(armed.sessionId, 'sid-100');
  });

  it('takes the live copy when both have the pid', async () => {
    // Nothing the gate reads is enriched on the way to the board, so the only
    // difference between the two is staleness. It is not cosmetic: a `/clear`
    // mints a new session id, and the poll can be 3s behind it — arming off the
    // board would key the progress file to an id the session has stopped
    // wearing, and nothing would ever read it back.
    const armed = await wf.armMention(100, 'mentionable', {
      board: [session({ sessionId: 'before-the-clear' })],
      live: [session({ sessionId: 'after-the-clear' })]
    });
    assert.ok('workflow' in armed);
    assert.equal(armed.sessionId, 'after-the-clear');
  });

  it('still refuses a pid neither snapshot knows', async () => {
    assert.deepEqual(await wf.armMention(404, 'mentionable', { board: [], live: [] }), {
      refused: 'Ship it cannot run here: session gone'
    });
  });

  it('refuses a session this window does not drive', async () => {
    assert.deepEqual(
      await wf.armMention(100, 'mentionable', {
        board: [session({ source: undefined })],
        live: []
      }),
      { refused: 'Ship it cannot run here: session is not one this window drives' }
    );
  });

  it('refuses a session no id has been minted for', async () => {
    assert.deepEqual(
      await wf.armMention(100, 'mentionable', { board: [session({ sessionId: '' })], live: [] }),
      { refused: 'Ship it cannot run here: session has not been named yet' }
    );
  });

  it('refuses an id no file on this machine answers to', async () => {
    assert.deepEqual(await wf.armMention(100, 'ghost', { board: [session()], live: [] }), {
      refused: 'ghost cannot run here: no such workflow on this machine'
    });
  });
});

/**
 * Preflight checks each step against the folders of the brand that runs it.
 * Every fixture is a real file in a real temp directory, read through each
 * brand's own `skillSources`; nothing here stands in for the lookup.
 */
describe('armable for the executing brand', () => {
  const skill = (dir: string, name: string, frontmatter = true): Promise<void> =>
    write(
      path.join(dir, 'SKILL.md'),
      frontmatter ? `---\nname: ${name}\ndescription: A probe.\n---\nbody\n` : 'body only\n'
    );
  const uses = (name: string): Definition =>
    workflow({ steps: [{ id: 'do', label: 'Do', uses: name }] });
  const laned = (opener: Partial<Definition['steps'][number]>, name: string): Definition =>
    workflow({
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'ui', label: 'UI', lane: 's1', needs: ['plan'], uses: name, ...opener }
      ]
    });
  let proj: string;

  before(async () => {
    proj = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-brands-')));
    await skill(path.join(proj, '.agents', 'skills', 'codex-only'), 'codex-only');
    await skill(path.join(proj, '.claude', 'skills', 'claude-folder'), 'claude-folder');
    await skill(path.join(proj, '.grok', 'skills', 'grok-only'), 'grok-only');
    await skill(path.join(proj, '.agents', 'skills', 'bare-codex'), 'bare-codex', false);
    await skill(path.join(proj, '.claude', 'skills', 'on-disk'), 'stated-name');
  });

  it('finds a skill only in the folders of the anchor brand', async () => {
    assert.deepEqual(await wf.armable(uses('/codex-only'), proj, 'codex'), []);
    assert.deepEqual(await wf.armable(uses('/grok-only'), proj, 'grok'), []);
    assert.deepEqual(await wf.armable(uses('/codex-only'), proj, 'claude'), [
      `do uses /codex-only, which does not exist in ${proj}`
    ]);
    assert.deepEqual(await wf.armable(uses('/grok-only'), proj, 'codex'), [
      `do uses /grok-only, which does not exist in ${proj}`
    ]);
  });

  it('refuses a same-name skill in another brand’s folder, unless this brand reads it', async () => {
    // Codex never reads `.claude`; Grok reads it as a compatibility root.
    assert.deepEqual(await wf.armable(uses('/claude-folder'), proj, 'codex'), [
      `do uses /claude-folder, which does not exist in ${proj}`
    ]);
    assert.deepEqual(await wf.armable(uses('/claude-folder'), proj, 'grok'), []);
  });

  it('refuses a Codex skill that states no name and description', async () => {
    assert.deepEqual(await wf.armable(uses('/bare-codex'), proj, 'codex'), [
      `do uses /bare-codex, which does not exist in ${proj}`
    ]);
  });

  it('matches a skill by the name it states, not by its folder', async () => {
    assert.deepEqual(await wf.armable(uses('/stated-name'), proj, 'claude'), []);
    assert.equal((await wf.armable(uses('/on-disk'), proj, 'claude')).length, 1);
  });

  it('keeps a skill whose frontmatter fence never closes, under its folder, except for Codex', async () => {
    // Probed 2026-10-18: Claude and Grok list such a file by its folder;
    // Codex, which needs a stated name and description, lists nothing.
    for (const root of ['.claude', '.agents', '.grok']) {
      await write(
        path.join(proj, root, 'skills', 'unclosed', 'SKILL.md'),
        '---\nname: unclosed\ndescription: A probe.\nno closing fence\n'
      );
    }
    assert.deepEqual(await wf.armable(uses('/unclosed'), proj, 'claude'), []);
    assert.deepEqual(await wf.armable(uses('/unclosed'), proj, 'grok'), []);
    assert.equal((await wf.armable(uses('/unclosed'), proj, 'codex')).length, 1);
  });

  it('finds a Claude command for Grok, which lists command files as skills', async () => {
    await write(path.join(proj, '.claude', 'commands', 'shared-cmd.md'), '# shared');
    assert.deepEqual(await wf.armable(uses('/shared-cmd'), proj, 'grok'), []);
    assert.equal((await wf.armable(uses('/shared-cmd'), proj, 'codex')).length, 1);
  });

  it('matches a name in any case, as the old check did on a case-insensitive disk', async () => {
    await skill(path.join(proj, '.grok', 'skills', 'CaseSkill'), 'CaseSkill');
    assert.deepEqual(await wf.armable(uses('/caseskill'), proj, 'grok'), []);
    assert.deepEqual(await wf.armable(uses('/CASESKILL'), proj, 'grok'), []);
  });

  it('checks a lane under the brand its opener states, and names that lane', async () => {
    assert.deepEqual(
      await wf.armable(laned({ brand: 'codex' }, '/codex-only'), proj, 'claude'),
      []
    );
    assert.deepEqual(
      await wf.armable(laned({ brand: 'codex' }, '/claude-folder'), proj, 'claude'),
      [`ui uses /claude-folder, which does not exist in ${proj} for its Codex lane`]
    );
  });

  it('checks a lane whose opener states no brand under the anchor’s', async () => {
    assert.deepEqual(await wf.armable(laned({}, '/codex-only'), proj, 'codex'), []);
    assert.deepEqual(await wf.armable(laned({}, '/claude-folder'), proj, 'codex'), [
      `ui uses /claude-folder, which does not exist in ${proj}`
    ]);
  });

  it('accepts a namespaced name no declared folder lists, for every brand', async () => {
    for (const brand of ['claude', 'codex', 'grok'] as const) {
      assert.deepEqual(await wf.armable(uses('/someplugin:review'), proj, brand), [], brand);
    }
  });

  it('reads project skills from the working tree root when the cwd is below it', async () => {
    const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-tree-')));
    await write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await skill(path.join(repo, '.agents', 'skills', 'root-skill'), 'root-skill');
    await skill(path.join(repo, 'pkg', '.agents', 'skills', 'mid-skill'), 'mid-skill');
    const deep = path.join(repo, 'pkg', 'src');
    await fs.mkdir(deep, { recursive: true });
    assert.equal(await wf.resolveUses('/root-skill', deep, 'codex'), true);
    assert.equal(await wf.resolveUses('/mid-skill', deep, 'codex'), true);
    // Above the tree's root is not read, and neither is a sibling.
    assert.equal(await wf.resolveUses('/mid-skill', repo, 'codex'), false);
  });

  it('arms a spawn and a mention under the brand they run', async () => {
    await writeJson(
      path.join(workflowsDir, 'codex-skill.json'),
      workflow({
        id: 'codex-skill',
        label: 'Codex skill',
        steps: [{ id: 'do', label: 'Do', uses: '/codex-only' }]
      })
    );
    assert.ok('workflow' in (await wf.armWorkflow('codex-skill', proj, 'codex')));
    assert.deepEqual(await wf.armWorkflow('codex-skill', proj, 'claude'), {
      refused: `Codex skill cannot run here: do uses /codex-only, which does not exist in ${proj}`
    });
    const session = (brand: Session['brand']): Session => ({
      pid: 300,
      sessionId: 'sid-300',
      cwd: proj,
      name: 'card',
      status: 'idle',
      hasCommand: false,
      startedAt: 0,
      updatedAt: 0,
      transcript: '/tmp/t.jsonl',
      source: 'owned',
      windowId: 'w1',
      ...(brand ? { brand } : {})
    });
    const mention = (brand: Session['brand']) =>
      wf.armMention(300, 'codex-skill', { board: [], live: [session(brand)] });
    assert.ok('workflow' in (await mention('codex')));
    // Grok reads `.agents` as well; Claude does not.
    assert.ok('workflow' in (await mention('grok')));
    assert.ok('refused' in (await mention('claude')));
    // A session stating no brand is Claude's, as everywhere else.
    assert.ok('refused' in (await mention(undefined)));
  });
});
