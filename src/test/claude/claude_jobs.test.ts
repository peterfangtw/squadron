import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';

type Jobs = typeof import('../../core/claude/jobs');

let jobs: Jobs;
let home: string;

before(async () => {
  home = await tempHome();
  jobs = await import('../../core/claude/jobs');
});

/** The record the CLI keeps beside a background session, as it writes it. */
function stateFile(jobId: string): string {
  return path.join(home, '.claude', 'jobs', jobId, 'state.json');
}

describe('readJob', () => {
  it('reads what a job is blocked on and where it stands', async () => {
    await writeJson(stateFile('j1'), { needs: 'approve Bash: git log', state: 'running' });
    assert.deepEqual(await jobs.readJob('j1'), {
      needs: 'approve Bash: git log',
      state: 'running'
    });
  });

  it('is nothing at all for a job that has no record', async () => {
    // Which is every session that is not a background one, so it is the common
    // answer rather than an error case.
    assert.equal(await jobs.readJob('nobody'), undefined);
  });

  it('keeps the fields it can read and drops the ones it cannot', async () => {
    // Another program's file: a field that is not a string is a field this has
    // no reading of, and putting `[object Object]` on a card is worse than
    // putting nothing there.
    await writeJson(stateFile('j2'), { needs: { tool: 'Bash' }, state: 'done' });
    assert.deepEqual(await jobs.readJob('j2'), { needs: undefined, state: 'done' });
    await writeJson(stateFile('j3'), { needs: 'approve Write', state: 7 });
    assert.deepEqual(await jobs.readJob('j3'), { needs: 'approve Write', state: undefined });
  });

  it('answers a record that states neither', async () => {
    await writeJson(stateFile('j4'), { pid: 12 });
    assert.deepEqual(await jobs.readJob('j4'), { needs: undefined, state: undefined });
  });

  it('says nothing about a file it cannot parse', async () => {
    // Half-written, which a record being rewritten as its job advances is for
    // as long as the write takes.
    await fs.mkdir(path.dirname(stateFile('j5')), { recursive: true });
    await fs.writeFile(stateFile('j5'), '{"needs": "approve Ba');
    assert.equal(await jobs.readJob('j5'), undefined);
  });

  it('says nothing about a record that is not an object', async () => {
    await fs.mkdir(path.dirname(stateFile('j6')), { recursive: true });
    await fs.writeFile(stateFile('j6'), 'null');
    assert.equal(await jobs.readJob('j6'), undefined);
  });
});
