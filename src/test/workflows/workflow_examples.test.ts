import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import * as graph from '../../core/workflows/graph';
import type { Workflow } from '../../core/workflows/workflows';
import { needsFileSymlinks, repoRoot, resetDir, tempHome, writeJson } from '../helpers';

const SOURCE = path.resolve(repoRoot(), 'install/workflows');
const IDS = ['example-read-do-review', 'example-multiple-models'];
let home: string;
let workflows: typeof import('../../core/workflows/workflows');
let examples: typeof import('../../core/workflows/examples');
let progress: typeof import('../../core/workflows/progress');
let paths: typeof import('../../core/paths');
let definitions: Workflow[];

before(async () => {
  home = await tempHome();
  workflows = await import('../../core/workflows/workflows');
  examples = await import('../../core/workflows/examples');
  progress = await import('../../core/workflows/progress');
  paths = await import('../../core/paths');
  definitions = await Promise.all(
    IDS.map(
      async (id) =>
        JSON.parse(await fs.readFile(path.join(SOURCE, `${id}.json`), 'utf8')) as Workflow
    )
  );
});

describe('packaged workflow examples', () => {
  it('runs without repository-specific skills and serves every step without unresolved templates', async () => {
    for (const workflow of definitions) {
      assert.deepEqual(await workflows.armable(workflow, home), []);
      const completed: { id: string; status: 'completed' }[] = [];
      const runs = new Map<string, ReturnType<typeof progress.seedProgress>>();
      for (const step of workflow.steps) {
        const lane = graph.laneOf(step);
        const run =
          runs.get(lane) ??
          progress.seedProgress({
            sessionId: lane || 'starter',
            workflowId: workflow.id,
            label: workflow.label,
            steps: workflow.steps,
            ...(lane ? { lane, anchor: 'starter', opened: 1 } : {}),
            now: 1
          });
        const served = progress.serveNext(run, workflow, { cwd: home, now: 2, others: completed });
        assert.equal(served.outcome, 'served');
        if (served.outcome !== 'served') throw new Error('step not served');
        assert.equal(served.id, step.id);
        assert.deepEqual(served.unresolved, []);
        const done = progress.completeCurrent(served.progress, { now: 3 });
        assert.equal(done.outcome, 'completed');
        if (done.outcome !== 'completed') throw new Error('step not completed');
        runs.set(lane, done.progress);
        completed.push({ id: step.id, status: 'completed' });
      }
    }
  });

  it('keeps basic delegation in prose and every workflow step in the starting session', () => {
    const basic = definitions[0];
    assert.ok(basic);
    assert.equal(basic.lanes, undefined);
    assert.ok(
      basic.steps.every(
        (s) => s.lane === undefined && s.brand === undefined && s.model === undefined
      )
    );
    const prompt = basic.steps.find((s) => s.id === 'peer-review')?.prompt ?? '';
    for (const command of ['squadron-spawn', 'squadron-wait', 'squadron-list'])
      assert.ok(prompt.includes(command));
    assert.match(prompt, /end your turn/);
  });

  it('declares the advanced model choices on lane openers and waits for review before applying fixes', () => {
    const advanced = definitions[1];
    assert.ok(advanced);
    assert.deepEqual(advanced.lanes, ['Reviewer', 'Implementer']);
    const openers = advanced.steps.filter((s) => s.model !== undefined);
    assert.deepEqual(
      openers.map((s) => [s.id, s.lane, s.brand, s.model]),
      [
        ['review-plan', 'Reviewer', 'claude', 'claude-opus-5-5'],
        ['implement', 'Implementer', 'grok', 'grok-4.7']
      ]
    );
    const run = progress.seedProgress({
      sessionId: 'worker',
      workflowId: advanced.id,
      label: advanced.label,
      steps: advanced.steps,
      lane: 'Implementer',
      anchor: 'starter',
      opened: 1
    });
    const implemented = run.steps[0];
    assert.ok(implemented);
    implemented.status = 'completed';
    const waiting = progress.serveNext(run, advanced, {
      cwd: home,
      now: 2,
      others: [{ id: 'align-plan', status: 'completed' }]
    });
    assert.equal(waiting.outcome, 'waiting');
  });
});

describe('one-time example installation', () => {
  beforeEach(async () => {
    await resetDir(paths.STATE_DIR);
  });

  it('creates two normal workflows on a fresh machine', async () => {
    await examples.seedExamples(SOURCE);
    assert.deepEqual((await workflows.readWorkflows()).map((w) => w.id).sort(), [...IDS].sort());
    assert.ok(await fs.stat(path.join(paths.STATE_DIR, 'workflows.examples.seeded')));
  });

  it('preserves edited examples and user workflows when another install activates', async () => {
    await examples.seedExamples(SOURCE);
    const edited = { ...definitions[0], label: 'My version' };
    await writeJson(path.join(paths.WORKFLOWS_DIR, `${IDS[0]}.json`), edited);
    await writeJson(path.join(paths.WORKFLOWS_DIR, 'mine.json'), { ...edited, id: 'mine' });
    const before = await fs.readFile(path.join(paths.WORKFLOWS_DIR, `${IDS[0]}.json`), 'utf8');
    assert.deepEqual(await examples.seedExamples(path.join(home, 'removed-old-extension')), []);
    assert.equal(
      await fs.readFile(path.join(paths.WORKFLOWS_DIR, `${IDS[0]}.json`), 'utf8'),
      before
    );
    assert.equal((await workflows.readWorkflows()).length, 3);
  });

  it('keeps both deletions after an update even if all workflows are gone', async () => {
    await examples.seedExamples(SOURCE);
    for (const id of IDS) assert.deepEqual(await workflows.deleteWorkflow(id), { ok: true });
    const updatedSource = path.join(home, 'updated-extension');
    await fs.cp(SOURCE, updatedSource, { recursive: true });
    await examples.seedExamples(updatedSource);
    assert.deepEqual(await workflows.readWorkflows(), []);
    assert.ok(await fs.stat(path.join(paths.STATE_DIR, 'workflows.examples.seeded')));
  });

  it('keeps one example deleted while the other remains', async () => {
    await examples.seedExamples(SOURCE);
    await workflows.deleteWorkflow('example-read-do-review');
    await examples.seedExamples(SOURCE);
    assert.deepEqual(
      (await workflows.readWorkflows()).map((w) => w.id),
      [IDS[1]]
    );
  });

  it('preserves an existing invalid file and seeds the other example once', async () => {
    await fs.mkdir(paths.WORKFLOWS_DIR, { recursive: true });
    const file = path.join(paths.WORKFLOWS_DIR, `${IDS[0]}.json`);
    await fs.writeFile(file, 'unfinished user content');
    await examples.seedExamples(SOURCE);
    assert.equal(await fs.readFile(file, 'utf8'), 'unfinished user content');
    assert.deepEqual(
      (await workflows.readWorkflows()).map((w) => w.id),
      [IDS[1]]
    );
  });

  it(
    'does not overwrite an existing symlink or its target',
    { skip: needsFileSymlinks() },
    async () => {
      await fs.mkdir(paths.WORKFLOWS_DIR, { recursive: true });
      const target = path.join(home, 'user-workflow.txt');
      await fs.writeFile(target, 'user content');
      const file = path.join(paths.WORKFLOWS_DIR, `${IDS[0]}.json`);
      await fs.symlink(target, file);
      await examples.seedExamples(SOURCE);
      assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
      assert.equal(await fs.readFile(target, 'utf8'), 'user content');
    }
  );

  it('offers the examples once when two windows activate concurrently', async () => {
    const results = await Promise.all([
      examples.seedExamples(SOURCE),
      examples.seedExamples(SOURCE)
    ]);
    assert.equal(results.filter((r) => r.length > 0).length, 1);
    assert.equal((await workflows.readWorkflows()).length, 2);
  });

  it('does not consume the offer when packaged sources are missing or invalid', async () => {
    const bad = path.join(home, 'bad-extension');
    await fs.cp(SOURCE, bad, { recursive: true });
    await writeJson(path.join(bad, `${IDS[1]}.json`), { ...definitions[1], id: 'wrong-id' });
    assert.ok((await examples.seedExamples(bad)).length > 0);
    assert.deepEqual(await workflows.readWorkflows(), []);
    await assert.rejects(fs.stat(path.join(paths.STATE_DIR, 'workflows.examples.seeded')));
    assert.ok((await examples.seedExamples(path.join(home, 'missing-extension'))).length > 0);
    await examples.seedExamples(SOURCE);
    assert.equal((await workflows.readWorkflows()).length, 2);
  });

  it('retains the marker after a copy failure and never retries deleted content', async (t) => {
    const copy = t.mock.method(fs, 'copyFile', () => Promise.reject(new Error('disk failed')));
    assert.ok((await examples.seedExamples(SOURCE)).some((line) => line.includes('disk failed')));
    copy.mock.restore();
    assert.ok(await fs.stat(path.join(paths.STATE_DIR, 'workflows.examples.seeded')));
    await examples.seedExamples(SOURCE);
    assert.deepEqual(await workflows.readWorkflows(), []);
  });

  it('leaves the offer available when the destination directory cannot be created', async () => {
    await fs.mkdir(paths.STATE_DIR, { recursive: true });
    await fs.writeFile(paths.WORKFLOWS_DIR, 'user content');
    assert.ok((await examples.seedExamples(SOURCE)).some((line) => line.includes('directory')));
    await assert.rejects(fs.stat(paths.WORKFLOW_EXAMPLES_MARKER));
    assert.equal(await fs.readFile(paths.WORKFLOWS_DIR, 'utf8'), 'user content');
    await fs.rm(paths.WORKFLOWS_DIR);
    await examples.seedExamples(SOURCE);
    assert.equal((await workflows.readWorkflows()).length, 2);
  });
});
