import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import type { Budget } from '../../core/platform/files';
import * as win32 from '../../core/platform/files/win32';
import { disposeHome, modeBitsSkip, tempHome } from '../home';
import { seed, workflow } from './progress_helpers';

let home: string;
let store: typeof import('../../core/workflows/progress_store');
let briefing: typeof import('../../core/workflows/progress_briefing');
let runsDir: string;
let stepCommand: string;
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  store = await import('../../core/workflows/progress_store');
  briefing = await import('../../core/workflows/progress_briefing');
  runsDir = path.join(home, '.squadron', 'runs');
  stepCommand = (await import('../../core/paths')).stepCommand('posix');
});

describe('progressBriefing', () => {
  it('names the path, both verbs, and why the later steps are withheld', () => {
    const file = store.progressPath('sess-1');
    const text = briefing.progressBriefing(file, 'posix');
    assert.ok(text.includes(file));
    // Absolute, as every verb an agent is handed is — a bare `squadron-step`
    // is only on PATH if the reader put it there.
    assert.ok(text.includes(`${stepCommand} next`));
    assert.ok(text.includes(`${stepCommand} done`));
    assert.match(text, /not given the later steps on purpose/);
    assert.match(text, /Do not read the workflow file/);
    // The cap is only useful before the note is written; learning it from a
    // refusal costs the agent a round trip and the long note it already wrote.
    assert.ok(text.includes(String(store.NOTE_MAX)));
  });

  it('asks for no hand-edit at all, which is what the CLI replaced', () => {
    // The four sentences that went. An agent told both to pull and to set
    // statuses by hand has two cursors and will disagree with itself.
    const text = briefing.progressBriefing(store.progressPath('sess-1'), 'posix');
    assert.ok(!text.includes('in_progress'));
    assert.ok(!text.includes('completed'));
    assert.ok(!text.includes('failed'));
    assert.ok(!/edit the file|set that step|do not invent/i.test(text));
  });
});

describe('withProgressBriefing', () => {
  it('puts the briefing under the enriched body', () => {
    const file = store.progressPath('sess-1');
    const body = 'Following the workflow "Ship it" (ship).';
    const joined = briefing.withProgressBriefing(body, file, 'posix');
    assert.ok(joined.startsWith(body));
    assert.ok(joined.includes(`\n\n${briefing.progressBriefing(file, 'posix')}`));
  });
});

describe('workflowFirstTurn', () => {
  /** What a spawn arms with: the definition plus the file it came out of. */
  const armed = { ...workflow, path: '/wf/ship.json' };

  it('leaves a spawn with no workflow saying exactly what it was given', async () => {
    assert.equal(
      await briefing.workflowFirstTurn('fix the flake', undefined, 'ft-none', 'posix'),
      'fix the flake'
    );
    assert.equal(await store.readProgress('ft-none'), undefined);
  });

  it('names the file, keeps the subject, and briefs the run it just seeded', async () => {
    const turn = await briefing.workflowFirstTurn('fix the flake', armed, 'ft-1', 'posix');
    assert.match(turn, /^Following the workflow "Ship it" \(ship\)\./);
    assert.match(turn, /fix the flake/);
    // The briefing names the path the seed actually landed at, in this one
    // message — the agent is given the work and the file together or neither.
    assert.match(turn, new RegExp(store.progressPath('ft-1').replace(/[.\\/]/g, '\\$&')));

    const read = await store.readProgress('ft-1');
    assert.ok(read);
    assert.equal(read.workflowId, 'ship');
    assert.deepEqual(
      read.steps.map((s) => s.status),
      ['pending', 'pending', 'pending']
    );
  });

  it('still hands over the workflow when the seed cannot be written', async () => {
    // A directory where the file goes, so the rename cannot land. The line
    // naming the workflow still goes out — a session running the steps
    // untracked beats one never told about them — and nothing briefs a file
    // that is not there.
    await fs.mkdir(store.progressPath('ft-unwritable'), { recursive: true });
    const turn = await briefing.workflowFirstTurn('go', armed, 'ft-unwritable', 'posix');
    assert.match(turn, /^Following the workflow "Ship it" \(ship\)\./);
    assert.doesNotMatch(turn, /Progress for this workflow run/);
  });

  it('hands over the workflow but seeds nothing when the session has no id yet', async () => {
    // A brand that states its id late leaves this empty. Seeding anyway files
    // the run at `runs/.progress.json` and briefs the child to drive a key
    // nothing will ever read it under — which is the Grok spawn bug, re-enacted
    // by the guard against it. Say the workflow, seed nothing.
    const before = await fs.readdir(runsDir);
    const turn = await briefing.workflowFirstTurn('go', armed, '', 'posix');
    assert.match(turn, /^Following the workflow "Ship it" \(ship\)\./);
    assert.doesNotMatch(turn, /Progress for this workflow run/);
    assert.deepEqual(await fs.readdir(runsDir), before);
  });

  it('seeds only the armed steps when a workflow with lanes is spawned', async () => {
    const lanes = {
      id: 'lanes',
      label: 'Lanes',
      path: '/wf/lanes.json',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan' },
        { id: 'build', label: 'Build', lane: 's1', needs: ['plan'], prompt: 'build' }
      ]
    };
    await briefing.workflowFirstTurn('go', lanes, 'ft-lanes', 'posix');
    const read = await store.readProgress('ft-lanes');
    assert.ok(read);
    assert.equal(read.lane, undefined);
    assert.deepEqual(
      read.steps.map((s) => s.id),
      ['plan']
    );
  });

  it('writes straight to the run, since a fresh id has nothing to overwrite', async () => {
    // The one difference from `stageForSend`, and the reason there is no temp
    // to commit: the file is there the moment the turn is composed.
    await briefing.workflowFirstTurn('go', armed, 'ft-2', 'posix');
    assert.deepEqual(
      (await fs.readdir(runsDir)).filter((n) => n.startsWith('ft-2')),
      ['ft-2.progress.json']
    );
  });
});

describe('stageForSend', () => {
  it('names the path for the briefing but writes nothing there until commit', async (context) => {
    let attempts = 0;
    let waits = 0;
    const backend = win32.files({
      stat: () => Promise.reject(new Error('target metadata unavailable')),
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: (source, destination) => {
        attempts++;
        return fs.rename(source, destination);
      },
      sleep: () => {
        waits++;
        return Promise.resolve();
      }
    });
    context.mock.method(
      platform.files,
      'replace',
      async (source: string, destination: string, budget: Budget) => {
        assert.deepEqual(budget, { kind: 'state' });
        await backend.replace(source, destination, budget);
      }
    );

    const staged = await briefing.stageForSend(seed({ sessionId: 'stage-1' }));
    assert.ok(staged);
    assert.equal(staged.file, store.progressPath('stage-1'));
    // The briefing can already name it, and a reader still sees no follow.
    assert.equal(await store.readProgress('stage-1'), undefined);

    await staged.commit();
    const read = await store.readProgress('stage-1');
    assert.ok(read);
    assert.equal(read.sessionId, 'stage-1');
    assert.ok(read.steps.every((s) => s.status === 'pending'));
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  });

  it('discard leaves no trace, so a refused send is not a follow', async () => {
    const staged = await briefing.stageForSend(seed({ sessionId: 'stage-discard' }));
    assert.ok(staged);
    await staged.discard();
    assert.equal(await store.readProgress('stage-discard'), undefined);
    assert.deepEqual(
      (await fs.readdir(runsDir)).filter((n) => n.startsWith('stage-discard')),
      [],
      'no staging file left behind'
    );
  });

  it('never touches a workflow already running at that session until it commits', async () => {
    // The whole reason for staging: one file per session, so a second mention
    // that is then refused must not have deleted the first.
    const live = store.seedProgress(seed({ sessionId: 'stage-live' }));
    live.steps[0] = { ...live.steps[0]!, status: 'completed' };
    await store.writeProgress(live);

    const staged = await briefing.stageForSend(
      seed({ sessionId: 'stage-live', workflowId: 'other', label: 'Other' })
    );
    assert.ok(staged);
    assert.equal(
      (await store.readProgress('stage-live'))?.workflowId,
      'ship',
      'staging alone does not displace the running workflow'
    );

    await staged.discard();
    const after = await store.readProgress('stage-live');
    assert.equal(after?.workflowId, 'ship');
    assert.equal(after?.steps[0]?.status, 'completed', 'its progress survived the refused send');
  });

  it('commit replaces the running workflow, which is the last-write-wins rule', async () => {
    await store.writeProgress(store.seedProgress(seed({ sessionId: 'stage-swap' })));
    const staged = await briefing.stageForSend(
      seed({ sessionId: 'stage-swap', workflowId: 'other', label: 'Other' })
    );
    assert.ok(staged);
    await staged.commit();
    assert.equal((await store.readProgress('stage-swap'))?.workflowId, 'other');
  });

  it(
    'returns undefined when the staging write fails (host skips briefing)',
    { skip: modeBitsSkip },
    async () => {
      await fs.mkdir(runsDir, { recursive: true });
      await fs.chmod(runsDir, 0o555);
      try {
        assert.equal(await briefing.stageForSend(seed({ sessionId: 'stage-fail' })), undefined);
        assert.equal(await store.readProgress('stage-fail'), undefined);
      } finally {
        await fs.chmod(runsDir, 0o755);
      }
    }
  );
});
