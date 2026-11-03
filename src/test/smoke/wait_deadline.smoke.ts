import { procStart } from './process_start';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WaitRecord } from '../../core/coordination/wait';
import type { ActionRecord } from '../../core/coordination/actions';
import type { Exchange } from '../../core/transcript';
import { writeJson, testPlatform } from '../helpers';
import { ctx, homeDir, openPanel, panel, section, step } from './boot';
import * as kit from './kit';

section(
  'ordinary wait deadline in the real IDE',
  () => {
    step('wakes an idle requester at a quiet busy member’s deadline', async () => {
      await openPanel();
      const state = path.join(homeDir(), '.squadron');
      const sessions: { pid: string; sessionId: string }[] = [];
      const planted: string[] = [];
      try {
        for (const prompt of ['slow deadline member', 'deadline requester']) {
          const before = await kit.pids();
          await kit.startFromDraft(prompt);
          const pid = await kit.waitForNewPid(before);
          const sessionId = await kit.publishedSessionId(pid);
          sessions.push({ pid, sessionId });
          await panel()
            .locator(`#cards .card[data-pid="${pid}"].${sessions.length === 1 ? 'busy' : 'idle'}`)
            .waitFor({ timeout: 30_000 });
          // The real CLI writes this discovery twin; the pipe fixture does not.
          const twin = path.join(homeDir(), '.claude', 'sessions', `${pid}.json`);
          planted.push(twin);
          await writeJson(twin, {
            pid: Number(pid),
            sessionId,
            cwd: path.join(homeDir(), 'project'),
            procStart: await procStart(pid),
            kind: 'interactive',
            entrypoint: 'sdk-cli'
          });
          if (sessions.length === 1) {
            // Await Café's hold write before starting this quiet window.
            if (testPlatform() === 'darwin') {
              const until = Date.now() + 10_000;
              for (;;) {
                const holds = await Promise.all(
                  (await fs.readdir(path.join(state, 'awake'))).map(
                    async (file) =>
                      JSON.parse(await fs.readFile(path.join(state, 'awake', file), 'utf8')) as {
                        sessions?: number[];
                      }
                  )
                );
                if (holds.some((hold) => hold.sessions?.includes(Number(pid)))) break;
                assert.ok(Date.now() < until, 'the busy member’s Café hold never settled');
                await ctx.page.waitForTimeout(100);
              }
            }
            await ctx.page.waitForTimeout(1_000);
          }
        }
        const member = sessions[0];
        const requester = sessions[1];
        assert.ok(member && requester);
        // Let setup's change pass finish, so the turn below starts a fresh 15s window.
        await ctx.page.waitForTimeout(17_000);
        const createdAt = Date.now();
        // One change window after that turn, plus slack for the click and a loaded host.
        const expiresAt = createdAt + 30_000;
        const wait: WaitRecord = {
          schema: 1,
          id: 'smoke-quiet-deadline',
          requesterPid: Number(requester.pid),
          requesterSessionId: requester.sessionId,
          members: [Number(member.pid)],
          createdAt,
          expiresAt
        };
        const waitFile = path.join(state, 'waits', `${wait.id}.json`);
        planted.push(waitFile);
        await writeJson(waitFile, wait);
        // A real `squadron-wait` runs inside the requester's turn, and that turn's
        // end is what tells the resolver. The planted file's watcher event is not
        // enough: under load macOS delivered it seconds late or never, 1 run in 4.
        await panel().locator(`#cards .card[data-pid="${requester.pid}"]`).click();
        await kit.composer().fill('deadline nudge');
        await kit.composer().press('Enter');
        const transcript = path.join(state, 'transcripts', `${requester.sessionId}.jsonl`);
        const rows = async (): Promise<Exchange[]> =>
          (await fs.readFile(transcript, 'utf8').catch(() => ''))
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line) as Exchange);
        const wakes = async (): Promise<Exchange[]> =>
          (await rows()).filter((row) => 'role' in row && row.role === 'wait');
        // The nudge's change window must close before expiry, or a pass landing at
        // expiry would pass this case without the deadline timer ever being armed.
        for (;;) {
          const taken = (await rows()).some(
            (row) => 'role' in row && row.role === 'user' && row.text === 'deadline nudge'
          );
          if (taken) break;
          assert.ok(
            Date.now() + 15_000 < expiresAt,
            'the nudge turn was taken too late to prove the deadline'
          );
          await ctx.page.waitForTimeout(50);
        }
        let observed: Exchange[];
        for (;;) {
          observed = await wakes();
          const now = Date.now();
          if (now < expiresAt) assert.equal(observed.length, 0, 'wait woke before its deadline');
          if (observed.length > 0) break;
          assert.ok(
            now <= expiresAt + 3_000,
            'quiet deadline never woke within its delivery bound'
          );
          await ctx.page.waitForTimeout(50);
        }
        assert.equal(observed.length, 1);
        const wake = observed[0];
        assert.ok(wake && 'role' in wake && wake.role === 'wait' && wake.at !== undefined);
        assert.ok(wake.at >= expiresAt && wake.at <= expiresAt + 3_000);
        assert.match(wake.text, /reached its deadline/);
        assert.match(wake.text, new RegExp(`${member.pid} .*never reported`));
        const until = Date.now() + 1_000;
        while (await fs.stat(waitFile).catch(() => undefined)) {
          assert.ok(Date.now() < until, 'the delivered wait record was not removed');
          await ctx.page.waitForTimeout(50);
        }
        const actions = await Promise.all(
          (await fs.readdir(path.join(state, 'actions'))).map(
            async (file) =>
              JSON.parse(
                await fs.readFile(path.join(state, 'actions', file), 'utf8')
              ) as ActionRecord
          )
        );
        const action = actions.find(
          (one) => one.kind === 'wait' && one.toPid === Number(requester.pid)
        );
        assert.ok(action && action.kind === 'wait');
        assert.ok(action.at >= expiresAt && action.at <= expiresAt + 3_000);
        assert.equal((await wakes()).length, 1, 'the wait woke more than once');
        console.log(
          `  quiet deadline wake ${wake.at - expiresAt}ms after expiry; action and removal witnessed`
        );
      } finally {
        for (const file of planted) await fs.rm(file, { force: true });
        for (const session of sessions.reverse()) await kit.endCard(session.pid).catch(() => {});
      }
    });
  },
  () => ({
    // `squadron-wait` is a write verb, gated on Orchestration (`cli/gate.ts`).
    'squadron.orchestrators.enabled': true
  })
);
