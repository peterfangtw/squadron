import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { homeEnv, outRoot, tempHome, writeLiveClaim } from '../helpers';

import { pauseSource, preloadEnv } from '../fixtures/preload';

/**
 * `squadron-step`'s one guard that no unit test can reach: the record moving
 * under it between the read it decided on and the write it planned.
 *
 * `cli/step.ts`'s `commit` re-reads immediately before writing and refuses on a
 * `cancelledAt` that appeared or a `workflowId` that changed — the first because
 * cancel is a read-modify-write that stamps and leaves the steps alone, so
 * writing a snapshot back whole would erase the stamp and relight a run the
 * reader stopped; the second because `stageForSend`'s commit renames a whole new
 * seeded file over the same path, so merging steps onto it would file one run's
 * progress under another run's id. Both arms need a **second writer between the
 * two reads**, which `stepPlan` — a pure function taking records — cannot have.
 *
 * Drive the real compiled CLI with a child-only read interceptor. A readiness
 * file proves it reached the workflow read after reading progress; release
 * follows the second writer. No filesystem FIFO or product hook is required.
 */

const CLI = path.join(outRoot(), 'cli', 'step.js');
const SESSION = 'race-sess';

type Run = { code: number; stderr: string };

const SHIP = {
  schema: 1,
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'build', label: 'Build', prompt: 'build it' }
  ]
};

const seeded = (workflowId: string): Record<string, unknown> => ({
  schema: 1,
  sessionId: SESSION,
  workflowId,
  label: 'Ship it',
  kind: 'pipeline',
  updatedAt: 1_000,
  steps: [
    { id: 'plan', label: 'Plan', status: 'pending' },
    { id: 'build', label: 'Build', status: 'pending' }
  ]
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

/** A home with one workflow, one seeded run, and a handshake that stalls the read. */
async function stage(): Promise<{
  home: string;
  progress: string;
  ready: string;
  release: string;
  env: NodeJS.ProcessEnv;
}> {
  const home = await tempHome();
  await writeLiveClaim(home);
  const state = path.join(home, '.squadron');
  await writeJson(path.join(state, 'workflows', 'ship.json'), SHIP);
  const progress = path.join(state, 'runs', `${SESSION}.progress.json`);
  await writeJson(progress, seeded('ship'));
  const file = path.join(state, 'workflows', 'ship.json');
  const ready = path.join(home, 'ready');
  const release = path.join(home, 'release');
  const env = preloadEnv(
    home,
    pauseSource(ready, release) +
      `
const fs = require('node:fs/promises');
const read = fs.readFile;
fs.readFile = function(file, ...args) {
  if (file === ${JSON.stringify(file)}) pause();
  return read.call(this, file, ...args);
};
`
  );
  return { home, progress, ready, release, env };
}

/** Pause at the actual read boundary, then let the original CLI finish. */
async function raced(
  fixture: Awaited<ReturnType<typeof stage>>,
  between: () => Promise<void>
): Promise<Run> {
  const { home, ready, release, env } = fixture;
  const child = execFile(process.execPath, [CLI, 'next', '--caller-session-id', SESSION], {
    env: { ...process.env, ...homeEnv(home), ...env },
    timeout: 10000
  });
  const exited = new Promise<Run>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
  try {
    const deadline = Date.now() + 4000;
    while (!(await fs.stat(ready).catch(() => undefined))) {
      if (Date.now() > deadline) throw new Error('CLI did not reach workflow read');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await between();
    await fs.writeFile(release, 'release');
    return await exited;
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

describe('squadron-step against a record that moves under it', () => {
  it('leaves a run cancelled mid-next cancelled, and refuses', { timeout: 30_000 }, async (t) => {
    const fixture = await stage();
    t.after(() =>
      fs.rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    );
    const { progress } = fixture;
    const run = await raced(fixture, async () => {
      const record = JSON.parse(await fs.readFile(progress, 'utf8')) as Record<string, unknown>;
      await writeJson(progress, { ...record, cancelledAt: 2_000 });
    });

    assert.equal(run.code, 2, `expected a refusal, got ${run.code}: ${run.stderr}`);
    assert.match(run.stderr, /cancelled/);
    const after = JSON.parse(await fs.readFile(progress, 'utf8')) as {
      cancelledAt?: number;
      steps: { status: string }[];
    };
    assert.equal(after.cancelledAt, 2_000, 'the stamp was erased by the write it refused');
    assert.deepEqual(
      after.steps.map((s) => s.status),
      ['pending', 'pending'],
      'a cancelled run was advanced anyway'
    );
  });

  it(
    'files no steps under a workflow armed after it read, and refuses',
    { timeout: 30_000 },
    async (t) => {
      const fixture = await stage();
      t.after(() =>
        fs.rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      );
      const { progress } = fixture;
      const run = await raced(fixture, async () => {
        // What `stageForSend`'s commit does: a whole new seeded record renamed
        // over the same session-keyed path.
        await writeJson(progress, seeded('other'));
      });

      assert.equal(run.code, 2, `expected a refusal, got ${run.code}: ${run.stderr}`);
      assert.match(run.stderr, /other/);
      const after = JSON.parse(await fs.readFile(progress, 'utf8')) as {
        workflowId: string;
        steps: { status: string }[];
      };
      assert.equal(after.workflowId, 'other');
      assert.deepEqual(
        after.steps.map((s) => s.status),
        ['pending', 'pending'],
        "the older run's steps landed under the newer run's id"
      );
    }
  );

  it(
    'files no steps under the same workflow armed again after it read, and refuses',
    { timeout: 30_000 },
    async (t) => {
      const fixture = await stage();
      t.after(() =>
        fs.rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      );
      const { progress } = fixture;
      await writeJson(progress, { ...seeded('ship'), armedAt: 1_000 });
      const run = await raced(fixture, async () => {
        // The same id re-armed: only `armedAt` tells this run from the one read.
        await writeJson(progress, { ...seeded('ship'), armedAt: 3_000 });
      });

      assert.equal(run.code, 2, `expected a refusal, got ${run.code}: ${run.stderr}`);
      assert.match(run.stderr, /armed again/);
      const after = JSON.parse(await fs.readFile(progress, 'utf8')) as {
        armedAt: number;
        steps: { status: string }[];
      };
      assert.equal(after.armedAt, 3_000);
      assert.deepEqual(
        after.steps.map((s) => s.status),
        ['pending', 'pending'],
        "the older run's step landed on the newer run"
      );
    }
  );
});
