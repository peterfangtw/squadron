import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Progress } from '../../core/workflows/progress_store';
import { disposeHome, tempHome, writeJson } from '../home';
import { reviewWf, seed, workflow } from './progress_helpers';

let home: string;
let store: typeof import('../../core/workflows/progress_store');
let runsDir: string;
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  store = await import('../../core/workflows/progress_store');
  runsDir = path.join(home, '.squadron', 'runs');
});

const seeded = () => store.seedProgress(seed());

describe('progressPath', () => {
  it('is keyed by session id, under RUNS_DIR', () => {
    assert.equal(store.progressPath('sess-1'), path.join(runsDir, 'sess-1.progress.json'));
  });
});

describe('seedProgress', () => {
  it('seeds all steps pending from the workflow definition', () => {
    const p = seeded();
    assert.equal(p.schema, 1);
    assert.equal(p.workflowId, 'ship');
    assert.equal(p.label, 'Ship it');
    assert.equal(p.sessionId, 'sess-1');
    assert.equal(p.kind, 'pipeline');
    assert.ok(typeof p.updatedAt === 'number' && p.updatedAt > 0);
    assert.deepEqual(
      p.steps.map((s) => ({ id: s.id, label: s.label, status: s.status })),
      [
        { id: 'plan', label: 'Plan', status: 'pending' },
        { id: 'build', label: 'Build', status: 'pending' },
        { id: 'commit', label: 'Commit', status: 'pending' }
      ]
    );
  });
});

describe('writeProgress + readProgress', () => {
  it('round-trips a seeded file, keyed by its session id', async () => {
    const p = seeded();
    assert.equal(await store.writeProgress(p), true);
    const read = await store.readProgress('sess-1');
    assert.ok(read);
    assert.equal(read.sessionId, p.sessionId);
    assert.equal(read.workflowId, p.workflowId);
    assert.equal(read.label, p.label);
    assert.equal(read.kind, 'pipeline');
    assert.deepEqual(read.steps, p.steps);
  });

  it('collects the records that name an anchor, and not the anchor itself', async () => {
    await store.writeProgress(seeded());
    await store.writeProgress(
      store.seedProgress({
        sessionId: 'sess-s1',
        workflowId: workflow.id,
        label: workflow.label,
        steps: [{ id: 'a', label: 'A', lane: 's1' }],
        lane: 's1',
        anchor: 'sess-1',
        now: 5
      })
    );
    await store.writeProgress(
      store.seedProgress({
        sessionId: 'sess-other',
        workflowId: workflow.id,
        label: workflow.label,
        steps: [{ id: 'b', label: 'B', lane: 's2' }],
        lane: 's2',
        anchor: 'someone-else',
        now: 5
      })
    );
    const found = await store.readAnchored('sess-1');
    assert.deepEqual(
      found.map((row) => row.sessionId),
      ['sess-s1']
    );
  });

  it('returns undefined when the file is missing', async () => {
    assert.equal(await store.readProgress('no-such-session'), undefined);
  });

  it('returns undefined for invalid JSON', async () => {
    const file = store.progressPath('bad-json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    assert.equal(await store.readProgress('bad-json'), undefined);
  });

  it('returns undefined for wrong schema or empty steps', async () => {
    await writeJson(store.progressPath('schema-2'), {
      schema: 2,
      sessionId: 'schema-2',
      workflowId: 'ship',
      label: 'Ship it',
      steps: [{ id: 'plan', label: 'Plan', status: 'pending' }]
    });
    assert.equal(await store.readProgress('schema-2'), undefined);

    await writeJson(store.progressPath('empty-steps'), {
      schema: 1,
      sessionId: 'empty-steps',
      workflowId: 'ship',
      label: 'Ship it',
      steps: []
    });
    assert.equal(await store.readProgress('empty-steps'), undefined);
  });

  it('returns undefined when a step status is unknown', async () => {
    await writeJson(store.progressPath('bad-status'), {
      schema: 1,
      sessionId: 'bad-status',
      workflowId: 'ship',
      label: 'Ship it',
      steps: [{ id: 'plan', label: 'Plan', status: 'waiting' }]
    });
    assert.equal(await store.readProgress('bad-status'), undefined);
  });

  it('accepts a file an agent rewrote without a label, and does not repair it', async () => {
    await writeJson(store.progressPath('no-label'), {
      schema: 1,
      sessionId: 'no-label',
      workflowId: 'ship',
      updatedAt: 1,
      steps: [{ id: 'plan', label: 'Plan', status: 'pending' }]
    });
    const read = await store.readProgress('no-label');
    assert.ok(read, 'a missing label is not a broken file');
    assert.equal(read.label, undefined, 'the guard does not write to what it reads');
  });

  it('returns undefined when label is present but not a string', async () => {
    await writeJson(store.progressPath('bad-label'), {
      schema: 1,
      sessionId: 'bad-label',
      workflowId: 'ship',
      label: 7,
      updatedAt: 1,
      steps: [{ id: 'plan', label: 'Plan', status: 'pending' }]
    });
    assert.equal(await store.readProgress('bad-label'), undefined);
  });

  it('returns undefined when sessionId is missing or empty', async () => {
    await writeJson(store.progressPath('no-session'), {
      schema: 1,
      workflowId: 'ship',
      label: 'Ship it',
      steps: [{ id: 'plan', label: 'Plan', status: 'pending' }]
    });
    assert.equal(await store.readProgress('no-session'), undefined);
  });
});

describe('forgetProgress', () => {
  it('unlinks the file, so a dismissed arming message clears the strip', async () => {
    await store.writeProgress(store.seedProgress(seed({ sessionId: 'forget-1' })));
    assert.ok(await store.readProgress('forget-1'));
    await store.forgetProgress('forget-1');
    assert.equal(await store.readProgress('forget-1'), undefined);
  });

  it('is quiet when there is nothing to forget', async () => {
    await store.forgetProgress('forget-missing');
  });
});

/**
 * A stamp rather than an unlink, and the tests are about why: the agent is
 * mid-pipeline with the briefing in its context, so an unlinked file is one it
 * writes straight back. What has to survive that write is the mark.
 */
describe('cancelProgress', () => {
  const at = 1_700_000_000_000;

  it('stamps the run and leaves every step where it stood', async () => {
    const started = store.seedProgress(seed({ sessionId: 'cancel-1' }));
    started.steps[0]!.status = 'completed';
    started.steps[1]!.status = 'in_progress';
    await store.writeProgress(started);

    assert.equal(await store.cancelProgress('cancel-1', at), true);

    const after = await store.readProgress('cancel-1');
    assert.equal(after?.cancelledAt, at);
    // Not the panel's to author: a cancel is not a step outcome (§15).
    assert.deepEqual(
      after?.steps.map((s) => s.status),
      ['completed', 'in_progress', 'pending']
    );
    assert.equal(after?.workflowId, 'ship');
    assert.equal(after?.label, 'Ship it');
  });

  it('deletes instead when there is no readable shape to stamp', async () => {
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(runsDir, 'cancel-4.progress.json'), '{ not json');

    assert.equal(await store.cancelProgress('cancel-4', at), true);
    assert.equal(await store.readProgress('cancel-4'), undefined);
    await assert.rejects(() => fs.stat(path.join(runsDir, 'cancel-4.progress.json')));
  });

  it('answers a session that never had a run', async () => {
    assert.equal(await store.cancelProgress('cancel-missing', at), true);
  });

  it('keeps the first mark when pressed twice', async () => {
    await store.writeProgress(store.seedProgress(seed({ sessionId: 'cancel-5' })));
    await store.cancelProgress('cancel-5', at);
    await store.cancelProgress('cancel-5', at + 5_000);
    assert.equal((await store.readProgress('cancel-5'))?.cancelledAt, at);
  });

  it('is refused as a shape when the mark is not a number', async () => {
    await writeJson(path.join(runsDir, 'cancel-6.progress.json'), {
      ...store.seedProgress(seed({ sessionId: 'cancel-6' })),
      cancelledAt: 'yesterday'
    });
    assert.equal(await store.readProgress('cancel-6'), undefined);
  });
});

describe('seedProgress lanes', () => {
  it('seeds only the named lane, and stores the anchor', () => {
    const p = store.seedProgress({
      sessionId: 'sess-s1',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      lane: 's1',
      anchor: 'anchor',
      now: 5
    });
    assert.deepEqual(
      p.steps.map((s) => s.id),
      ['ui', 'au']
    );
    assert.equal(p.lane, 's1');
    assert.equal(p.anchor, 'anchor');
    assert.equal(p.schema, 1);
    assert.ok(p.steps.every((s) => s.status === 'pending'));
  });

  it('seeds the armed lane without storing an empty lane name', () => {
    const p = store.seedProgress({
      sessionId: 'anchor',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      lane: '',
      now: 5
    });
    assert.deepEqual(
      p.steps.map((s) => s.id),
      ['impl', 'wire', 'aw', 'int', 'ship']
    );
    assert.equal(p.lane, undefined);
    assert.equal(p.anchor, undefined);
  });
});

describe('lane records on disk', () => {
  it('round-trips pid, lanes, anchor and lane', async () => {
    const p = store.seedProgress({
      sessionId: 'lane-round',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      lane: 's1',
      anchor: 'anchor',
      pid: 4,
      now: 5
    });
    assert.equal(await store.writeProgress({ ...p, lanes: { s2: { pid: 9, openedAt: 8 } } }), true);
    const read = await store.readProgress('lane-round');
    assert.equal(read?.pid, 4);
    assert.equal(read?.anchor, 'anchor');
    assert.equal(read?.lane, 's1');
    assert.deepEqual(read?.lanes, { s2: { pid: 9, openedAt: 8 } });
  });

  it('refuses a lane field, a pid or a lanes map of the wrong shape', async () => {
    const base = store.seedProgress({
      sessionId: 'lane-bad',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      lane: 's1',
      now: 5
    });
    await writeJson(store.progressPath('lane-blank'), {
      ...base,
      sessionId: 'lane-blank',
      lane: ''
    });
    await writeJson(store.progressPath('lane-pid'), {
      ...base,
      sessionId: 'lane-pid',
      pid: 'no'
    });
    await writeJson(store.progressPath('lane-map'), {
      ...base,
      sessionId: 'lane-map',
      lanes: { s2: { pid: 1 } }
    });
    assert.equal(await store.readProgress('lane-blank'), undefined);
    assert.equal(await store.readProgress('lane-pid'), undefined);
    assert.equal(await store.readProgress('lane-map'), undefined);
  });

  it('round-trips fellBack and refuses any other value', async () => {
    const base = store.seedProgress({
      sessionId: 'lane-fell',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      lane: 's1',
      anchor: 'anchor',
      pid: 4,
      now: 5
    });
    assert.equal(
      await store.writeProgress({
        ...base,
        lanes: { s2: { pid: 9, openedAt: 8, fellBack: true } }
      }),
      true
    );
    assert.deepEqual((await store.readProgress('lane-fell'))?.lanes, {
      s2: { pid: 9, openedAt: 8, fellBack: true }
    });
    await writeJson(store.progressPath('lane-fell-false'), {
      ...base,
      sessionId: 'lane-fell-false',
      lanes: { s2: { openedAt: 8, fellBack: false } }
    });
    await writeJson(store.progressPath('lane-fell-word'), {
      ...base,
      sessionId: 'lane-fell-word',
      lanes: { s2: { openedAt: 8, fellBack: 'yes' } }
    });
    assert.equal(await store.readProgress('lane-fell-false'), undefined);
    assert.equal(await store.readProgress('lane-fell-word'), undefined);
  });

  it('round-trips a refused fallback and refuses one that is not text', async () => {
    const base = store.seedProgress({
      sessionId: 'lane-refused',
      workflowId: reviewWf.id,
      label: reviewWf.label,
      steps: reviewWf.steps,
      now: 5
    });
    const lanes = {
      s2: { openedAt: 8, fellBack: true as const, refused: 's2: x could not start' }
    };
    assert.equal(await store.writeProgress({ ...base, lanes }), true);
    assert.deepEqual((await store.readProgress('lane-refused'))?.lanes, lanes);
    await writeJson(store.progressPath('lane-refused-flag'), {
      ...base,
      sessionId: 'lane-refused-flag',
      lanes: { s2: { openedAt: 8, fellBack: true, refused: true } }
    });
    assert.equal(await store.readProgress('lane-refused-flag'), undefined);
  });
});

describe('runMoved', () => {
  const plan = (): Progress => ({ ...seeded(), armedAt: 100 });

  it('passes the run it was planned on', () => {
    const planned = plan();
    assert.equal(store.runMoved({ ...planned, updatedAt: 999 }, planned), undefined);
  });

  it('names what moved, cancel before workflow before arming', () => {
    const planned = plan();
    assert.equal(
      store.runMoved({ ...planned, cancelledAt: 1, workflowId: 'other' }, planned),
      'cancelled'
    );
    assert.equal(
      store.runMoved({ ...planned, workflowId: 'other', armedAt: 1 }, planned),
      'workflow'
    );
    assert.equal(store.runMoved({ ...planned, armedAt: 101 }, planned), 'armed');
    assert.equal(
      store.runMoved(planned, { workflowId: planned.workflowId }),
      'armed',
      'a record armed after one with no armedAt is a different run'
    );
  });
});
