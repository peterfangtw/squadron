import { procStart } from './process_start';
import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { promisify } from 'node:util';
import type { WaitRecord } from '../../core/coordination/wait';
import type { Progress } from '../../core/workflows/progress';
import { writeJson } from '../helpers';
import { ctx, homeDir, homeVars, openPanel, panel, section, step } from './boot';
import * as kit from './kit';

const execFile = promisify(childProcess.execFile);

section(
  'workflow dependency waits in the real IDE',
  () => {
    step('holds sibling startup and wakes once after the required step completes', async () => {
      await openPanel();
      const sessions: { pid: string; sessionId: string }[] = [];
      try {
        const start = async (prompt: string) => {
          const before = await kit.pids();
          await kit.startFromDraft(prompt);
          const pid = await kit.waitForNewPid(before);
          const sessionId = await kit.publishedSessionId(pid);
          sessions.push({ pid, sessionId });
          await panel()
            .locator(`#cards .card[data-pid="${pid}"].idle`)
            .waitFor({ timeout: 30_000 });
          // The real CLI writes this discovery twin; the pipe fixture does not.
          await writeJson(path.join(homeDir(), '.claude', 'sessions', `${pid}.json`), {
            pid: Number(pid),
            sessionId,
            cwd: path.join(homeDir(), 'project'),
            procStart: await procStart(pid),
            kind: 'interactive',
            entrypoint: 'sdk-cli'
          });
          return { pid, sessionId };
        };
        await start('dependency anchor');
        await start('dependency reviewer');
        const anchor = sessions[0];
        const reviewer = sessions[1];
        assert.ok(anchor && reviewer);
        const state = path.join(homeDir(), '.squadron');
        const armedAt = Date.now() - 10_000;
        const workflowId = 'smoke-dependency-wait';
        await writeJson(path.join(state, 'workflows', `${workflowId}.json`), {
          id: workflowId,
          label: 'Dependency wait',
          steps: [
            { id: 'plan', label: 'Plan', prompt: 'plan' },
            {
              id: 'review-plan',
              label: 'Review plan',
              lane: 'Reviewer',
              needs: ['plan'],
              prompt: 'review'
            },
            {
              id: 'prepare',
              label: 'Prepare',
              lane: 'Implementer',
              needs: ['review-plan'],
              prompt: 'prepare'
            },
            {
              id: 'implement',
              label: 'Implement',
              lane: 'Implementer',
              needs: ['prepare'],
              prompt: 'implement'
            },
            {
              id: 'review-code',
              label: 'Review code',
              lane: 'Reviewer',
              needs: ['review-plan', 'implement'],
              prompt: 'review code'
            }
          ]
        });
        const anchorRun: Progress = {
          schema: 1,
          sessionId: anchor.sessionId,
          workflowId,
          armedAt,
          updatedAt: armedAt,
          pid: Number(anchor.pid),
          lanes: { Reviewer: { pid: Number(reviewer.pid), openedAt: armedAt } },
          steps: [{ id: 'plan', label: 'Plan', status: 'completed' }]
        };
        const runFile = path.join(state, 'runs', `${anchor.sessionId}.progress.json`);
        await writeJson(runFile, anchorRun);
        await writeJson(path.join(state, 'runs', `${reviewer.sessionId}.progress.json`), {
          schema: 1,
          sessionId: reviewer.sessionId,
          workflowId,
          armedAt,
          updatedAt: armedAt,
          anchor: anchor.sessionId,
          lane: 'Reviewer',
          opened: armedAt,
          steps: [
            { id: 'review-plan', label: 'Review plan', status: 'completed' },
            { id: 'review-code', label: 'Review code', status: 'pending' }
          ]
        });
        const { stdout } = await execFile(
          process.execPath,
          [
            platform.launchers.scriptPath(path.join(state, 'bin'), 'squadron-step'),
            'next',
            '--caller-session-id',
            reviewer.sessionId
          ],
          {
            cwd: path.join(homeDir(), 'project'),
            env: { ...process.env, ...homeVars() },
            timeout: 30_000
          }
        );
        assert.match(stdout, /registered a wait/);
        const transcript = path.join(state, 'transcripts', `${reviewer.sessionId}.jsonl`);
        const wakes = async () =>
          (await fs.readFile(transcript, 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"role":"wait"') && line.includes('Your workflow wait'))
            .map((line) => JSON.parse(line) as { text: string; at: number });
        const waitDir = path.join(state, 'waits');
        const waitRecords = await Promise.all(
          (await fs.readdir(waitDir))
            .filter((file) => file.endsWith('.json'))
            .map(async (file) => ({
              file,
              record: JSON.parse(await fs.readFile(path.join(waitDir, file), 'utf8')) as WaitRecord
            }))
        );
        const workflowWait = waitRecords.find(
          ({ record }) =>
            record.requesterPid === Number(reviewer.pid) &&
            record.workflow?.workflowId === workflowId
        );
        assert.ok(workflowWait, 'the reviewer never registered its workflow wait');
        const waitFile = path.join(waitDir, workflowWait.file);
        const anchorTranscript = path.join(state, 'transcripts', `${anchor.sessionId}.jsonl`);
        const controlWakes = async () =>
          (await fs.readFile(anchorTranscript, 'utf8'))
            .split('\n')
            .filter((line) => line.includes('"role":"wait"') && line.includes('All 1 session'));
        const witness = async (expected: number): Promise<void> => {
          const { stdout: control } = await execFile(
            process.execPath,
            [
              platform.launchers.scriptPath(path.join(state, 'bin'), 'squadron-wait'),
              '--pids',
              reviewer.pid,
              '--caller-session-id',
              anchor.sessionId
            ],
            {
              cwd: path.join(homeDir(), 'project'),
              env: { ...process.env, ...homeVars() },
              timeout: 30_000
            }
          );
          assert.match(control, /registered/i);
          const until = Date.now() + 30_000;
          while ((await controlWakes()).length < expected) {
            assert.ok(Date.now() < until, 'the control wait never witnessed a resolver pass');
            await ctx.page.waitForTimeout(100);
          }
          // The control witnesses evaluation; final content/order checks cover later delivery.
          assert.equal((await wakes()).length, 0, 'a held dependency woke the reviewer');
          assert.ok(await fs.stat(waitFile));
          console.log(`  held dependency witnessed by control wake ${expected}`);
        };
        await witness(1);
        anchorRun.lanes!.Implementer = { openedAt: armedAt };
        await writeJson(runFile, anchorRun);
        await witness(2);
        const worker = await start('dependency implementer');
        const workerRun: Progress = {
          schema: 1,
          sessionId: worker.sessionId,
          workflowId,
          armedAt,
          updatedAt: armedAt,
          anchor: anchor.sessionId,
          lane: 'Implementer',
          opened: armedAt,
          steps: [
            { id: 'prepare', label: 'Prepare', status: 'completed' },
            { id: 'implement', label: 'Implement', status: 'pending' }
          ]
        };
        const workerFile = path.join(state, 'runs', `${worker.sessionId}.progress.json`);
        await writeJson(workerFile, workerRun);
        anchorRun.lanes!.Implementer.pid = Number(worker.pid);
        await writeJson(runFile, anchorRun);
        await witness(3);
        workerRun.steps[1]!.status = 'completed';
        await writeJson(workerFile, workerRun);
        const completedAt = Math.floor((await fs.stat(workerFile)).mtimeMs);
        const until = Date.now() + 30_000;
        while ((await wakes()).length === 0) {
          assert.ok(Date.now() < until, 'progress-file completion never woke the reviewer');
          await ctx.page.waitForTimeout(100);
        }
        while (await fs.stat(waitFile).catch(() => undefined)) {
          assert.ok(Date.now() < until, 'the delivered workflow wait was not removed');
          await ctx.page.waitForTimeout(100);
        }
        const notifications = await wakes();
        assert.equal(notifications.length, 1);
        assert.match(notifications[0]!.text, /ready to check the next step/);
        assert.ok(
          notifications[0]!.at >= completedAt,
          'the workflow wake preceded dependency completion'
        );
        for (const notification of notifications) {
          assert.doesNotMatch(
            notification.text,
            /workflow stopped or stalled|reached its deadline|dependencies not ready/
          );
        }
      } finally {
        for (const session of sessions.reverse()) await kit.endCard(session.pid).catch(() => {});
      }
    });
  },
  () => ({
    // `squadron-step` and `squadron-wait` are write verbs, gated on Orchestration (`cli/gate.ts`).
    'squadron.orchestrators.enabled': true
  })
);
