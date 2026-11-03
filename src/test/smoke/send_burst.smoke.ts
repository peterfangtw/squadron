import { procStart } from './process_start';
import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { promisify } from 'node:util';
import type { CountedAction } from '../../core/coordination/actions';
import { wrapMessage } from '../../core/coordination/send';
import type { Reply, Request } from '../../core/coordination/requests';
import type { PublishedLive } from '../../core/published';
import { writeJson } from '../helpers';
import { ctx, homeDir, homeVars, openPanel, panel, patchSettings, section, step } from './boot';
import * as kit from './kit';

const execFile = promisify(childProcess.execFile);

section('idle interrupt send receipt', () => {
  step('reports a send with interrupt to an idle session as sent', async () => {
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    await openPanel();
    const before = await kit.pids();
    await kit.startFromDraft('idle receipt target');
    const pid = await kit.waitForNewPid(before);
    const twin = path.join(homeDir(), '.claude', 'sessions', `${pid}.json`);
    try {
      const sessionId = await kit.publishedSessionId(pid);
      await panel().locator(`#cards .card[data-pid="${pid}"].idle`).waitFor({ timeout: 30_000 });
      await writeDiscoveryTwin(pid, sessionId);
      const { stdout } = await execFile(
        process.execPath,
        [
          platform.launchers.scriptPath(path.join(homeDir(), '.squadron', 'bin'), 'squadron-send'),
          '--pid',
          pid,
          '--caller-session-id',
          sessionId,
          '--text',
          'next ordinary message',
          '--interrupt'
        ],
        {
          cwd: path.join(homeDir(), 'project'),
          env: { ...process.env, ...homeVars() },
          timeout: 30_000
        }
      );
      assert.equal(stdout, `sent to ${pid} (sent)\n`);
    } finally {
      await kit.endCard(pid);
      await fs.rm(twin, { force: true });
    }
  });
});

section('send burst admission in the real IDE', () => {
  step('accepts ten concurrent sends and refuses the rest in the receiving window', async () => {
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    await openPanel();
    const before = await kit.pids();
    await kit.startFromDraft('send burst target');
    const pid = await kit.waitForNewPid(before);
    const state = path.join(homeDir(), '.squadron');
    const twin = path.join(homeDir(), '.claude', 'sessions', `${pid}.json`);
    try {
      const sessionId = await kit.publishedSessionId(pid);
      await panel().locator(`#cards .card[data-pid="${pid}"].idle`).waitFor({ timeout: 30_000 });
      const record = JSON.parse(
        await fs.readFile(path.join(state, 'live', `${pid}.json`), 'utf8')
      ) as PublishedLive;
      const windowId = record.session.windowId;
      assert.ok(windowId);
      await writeDiscoveryTwin(pid, sessionId);
      for (let i = 0; i < 10; i++) {
        await writeJson(path.join(state, 'actions', `other-window-${i}.json`), {
          schema: 1,
          kind: 'send',
          windowId: 'other-window',
          from: 'another-sender',
          toPid: Number(pid),
          at: Date.now(),
          requestId: `other-${i}`
        });
      }
      const send = (i: number) =>
        execFile(
          process.execPath,
          [
            platform.launchers.scriptPath(path.join(state, 'bin'), 'squadron-send'),
            '--pid',
            pid,
            '--caller-session-id',
            sessionId,
            '--text',
            `burst message ${i}`,
            '--force'
          ],
          {
            cwd: path.join(homeDir(), 'project'),
            env: { ...process.env, ...homeVars() },
            timeout: 30_000
          }
        );
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => send(i)));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 10);
      for (const result of results) {
        if (result.status === 'fulfilled') continue;
        const error = result.reason as { code?: number; stderr?: string };
        assert.equal(error.code, 2);
        assert.match(error.stderr ?? '', /this IDE window.*limit is 10/);
      }
      const rows = await Promise.all(
        (await fs.readdir(path.join(state, 'actions'))).map(
          async (file) =>
            JSON.parse(
              await fs.readFile(path.join(state, 'actions', file), 'utf8')
            ) as CountedAction
        )
      );
      assert.equal(rows.filter((row) => row.windowId === windowId).length, 10);
      assert.equal(rows.filter((row) => row.windowId === 'other-window').length, 10);
    } finally {
      await kit.endCard(pid);
      await fs.rm(twin, { force: true });
    }
  });
});

section('interrupt completion outside send admission', () => {
  step(
    'admits a neighbouring send while the first target withholds its interrupt response',
    async () => {
      await patchSettings({ 'squadron.orchestrators.enabled': true });
      await openPanel();
      const state = path.join(homeDir(), '.squadron');
      const sessions: { pid: string; sessionId: string; record: PublishedLive }[] = [];
      let signal: string | undefined;
      let pendingReply: string | undefined;
      try {
        for (const prompt of ['slow delayed-interrupt', 'interrupt neighbour']) {
          const before = await kit.pids();
          await kit.startFromDraft(prompt);
          const pid = await kit.waitForNewPid(before);
          const sessionId = await kit.publishedSessionId(pid);
          await panel()
            .locator(`#cards .card[data-pid="${pid}"].${sessions.length ? 'idle' : 'busy'}`)
            .waitFor({ timeout: 30_000 });
          const record = JSON.parse(
            await fs.readFile(path.join(state, 'live', `${pid}.json`), 'utf8')
          ) as PublishedLive;
          sessions.push({ pid, sessionId, record });
          await writeDiscoveryTwin(pid, sessionId);
        }
        const [target, neighbour] = sessions;
        assert.ok(target && neighbour && target.record.session.windowId);
        signal = path.join(state, `interrupt-${target.sessionId}`);
        const id = 'smoke-delayed-interrupt';
        pendingReply = path.join(state, 'requests', `${id}.reply.json`);
        const request: Request = {
          kind: 'send',
          id,
          createdAt: Date.now(),
          windowId: target.record.session.windowId,
          pid: Number(target.pid),
          startedAt: target.record.session.startedAt,
          from: neighbour.sessionId,
          via: 'verb',
          interrupt: true,
          text: wrapMessage('continue after the pause', neighbour.sessionId)
        };
        await writeJson(path.join(state, 'requests', `${id}.request.json`), request);
        const deadline = Date.now() + 15_000;
        while (!(await fs.stat(signal).catch(() => undefined))) {
          assert.ok(Date.now() < deadline, 'target never received the interrupt');
          await ctx.page.waitForTimeout(100);
        }
        const { stdout } = await execFile(
          process.execPath,
          [
            platform.launchers.scriptPath(path.join(state, 'bin'), 'squadron-send'),
            '--pid',
            neighbour.pid,
            '--caller-session-id',
            target.sessionId,
            '--text',
            'ordinary neighbouring message'
          ],
          {
            cwd: path.join(homeDir(), 'project'),
            env: { ...process.env, ...homeVars() },
            timeout: 10_000
          }
        );
        assert.equal(stdout, `sent to ${neighbour.pid} (sent)\n`);
        assert.equal(await fs.readFile(signal, 'utf8'), 'held');
        assert.equal(await fs.stat(pendingReply).catch(() => undefined), undefined);
      } finally {
        if (signal) await fs.writeFile(signal, 'release');
        if (pendingReply) {
          const deadline = Date.now() + 15_000;
          while (!(await fs.stat(pendingReply).catch(() => undefined))) {
            assert.ok(Date.now() < deadline, 'interrupt did not finish after release');
            await ctx.page.waitForTimeout(100);
          }
          const reply = JSON.parse(await fs.readFile(pendingReply, 'utf8')) as Reply;
          assert.equal(reply.ok, true);
        }
        for (const { pid } of sessions.reverse()) {
          await kit.endCard(pid);
          await fs.rm(path.join(homeDir(), '.claude', 'sessions', `${pid}.json`), { force: true });
        }
      }
    }
  );
});

async function writeDiscoveryTwin(pid: string, sessionId: string): Promise<void> {
  // The pipe fixture does not write the CLI's discovery twin.
  await writeJson(path.join(homeDir(), '.claude', 'sessions', `${pid}.json`), {
    pid: Number(pid),
    sessionId,
    cwd: path.join(homeDir(), 'project'),
    procStart: await procStart(pid),
    kind: 'interactive',
    entrypoint: 'sdk-cli'
  });
}
