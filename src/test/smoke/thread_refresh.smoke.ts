import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { before } from 'node:test';
import { testPlatform } from '../helpers';
import * as ownership from './ownership';
import * as boot from './boot';
import { endCard, openDraft, pids, startFromDraft, waitForNewPid } from './kit';

type ProcessReading = { pid: number; parent: number; cpu: number | null; rss: number | null };
async function processes(): Promise<ProcessReading[]> {
  if (testPlatform() === 'win32')
    return [...(await ownership.readProcesses()).values()].map((row) => ({
      pid: row.pid,
      parent: row.ppid,
      cpu: null,
      rss: null
    }));
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)/.exec(line);
      return m
        ? [
            {
              pid: Number(m[1]),
              parent: Number(m[2]),
              cpu: (m[3] ?? '').split(':').reduce((sum, n) => sum * 60 + Number(n), 0),
              rss: Number(m[4])
            }
          ]
        : [];
    });
}
function tree(all: ProcessReading[]): ProcessReading[] {
  const mine = new Set([boot.ctx.hostPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all)
      if (!mine.has(p.pid) && mine.has(p.parent)) {
        mine.add(p.pid);
        grew = true;
      }
  }
  return all.filter((p) => mine.has(p.pid));
}

// Opt-in measurement, also asserts the real pipe's transcript/status completion.
// Run alone: npm run test:smoke:one -- out/test/smoke/thread_refresh.smoke.js
async function command(title: string): Promise<void> {
  await boot.ctx.page.keyboard.press('ControlOrMeta+Shift+P');
  await boot.ctx.page.keyboard.type(title);
  await boot.ctx.page.keyboard.press('Enter');
}

boot.section('selected transcript refresh isolation', () => {
  before(boot.openPanel);
  boot.step('streams deterministic model-free text through the real host', async () => {
    await boot
      .panel()
      .locator('body')
      .evaluate(() => {
        const rows: { type: string; bytes: number; at: number; text: string }[] = [];
        const visibleChunks: { chunk: number; at: number }[] = [];
        const seen = new Set<number>();
        Object.assign(window, { refreshWire: rows, visibleChunks });
        new MutationObserver(() => {
          const text = document.getElementById('thread')?.textContent ?? '';
          for (const match of text.matchAll(/Chunk (\d+)\./g)) {
            const chunk = Number(match[1]);
            if (seen.has(chunk)) continue;
            seen.add(chunk);
            visibleChunks.push({ chunk, at: Date.now() });
          }
        }).observe(document.getElementById('thread')!, {
          childList: true,
          subtree: true,
          characterData: true
        });
        window.addEventListener('message', (event: MessageEvent<PanelMessage>) => {
          const msg = event.data;
          if (msg.type !== 'state' && msg.type !== 'thread' && msg.type !== 'threadPatch') return;
          const wire = msg as { type: string; thread?: ThreadView };
          const exchanges =
            msg.type === 'threadPatch' ? msg.splice.exchanges : (wire.thread?.exchanges ?? []);
          rows.push({
            type: wire.type,
            bytes: new TextEncoder().encode(JSON.stringify(msg)).length,
            at: Date.now(),
            text: exchanges.map((x) => ('text' in x ? x.text : '')).join('')
          });
        });
      });
    const was = await pids();
    const start = Date.now();
    const a = tree(await processes());
    await startFromDraft('transcript-refresh-benchmark');
    const pid = await waitForNewPid(was);
    const card = boot.panel().locator(`#cards .card[data-pid="${pid}"]`);
    await card.and(boot.panel().locator('.busy')).waitFor({ timeout: 30_000 });
    await boot
      .panel()
      .locator('#thread .turn.assistant', { hasText: 'Chunk 48.' })
      .waitFor({ timeout: 30_000 });
    await card.and(boot.panel().locator('.idle')).waitFor({ timeout: 30_000 });
    const end = Date.now();
    const b = tree(await processes());
    const wire = await boot
      .panel()
      .locator('body')
      .evaluate(
        () =>
          (
            window as unknown as {
              refreshWire: { type: string; bytes: number; at: number; text: string }[];
            }
          ).refreshWire
      );
    const rows = wire.filter((row) => row.at >= start && row.at <= end);
    const first = rows.find((row) => row.text.includes('Chunk 1.'));
    assert.ok(first, 'the host published the selected transcript');
    const visibleChunks = await boot
      .panel()
      .locator('body')
      .evaluate(
        () =>
          (window as unknown as { visibleChunks: { chunk: number; at: number }[] }).visibleChunks
      );
    const emitted = (
      await fs.readFile(path.join(boot.homeDir(), '.squadron', 'refresh-fixture.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { chunk: number; at: number });
    const latency = emitted
      .map((row) => {
        const shown = visibleChunks.find((seen) => seen.chunk === row.chunk);
        assert.ok(shown, `chunk ${row.chunk} reached the DOM`);
        return shown.at - row.at;
      })
      .sort((a, b) => a - b);
    const reading = {
      visibleLatencyP50Ms: latency[Math.floor(latency.length * 0.5)],
      visibleLatencyP95Ms: latency[Math.floor(latency.length * 0.95)],
      visibleLatencyMaxMs: latency.at(-1),
      start,
      end,
      seconds: (end - start) / 1000,
      hostTreeCpuSeconds: b.some((p) => p.cpu === null)
        ? null
        : b.reduce((sum, p) => sum + (p.cpu ?? 0) - (a.find((q) => q.pid === p.pid)?.cpu ?? 0), 0),
      hostTreeRssStartKiB: a.some((p) => p.rss === null)
        ? null
        : a.reduce((sum, p) => sum + (p.rss ?? 0), 0),
      hostTreeRssEndKiB: b.some((p) => p.rss === null)
        ? null
        : b.reduce((sum, p) => sum + (p.rss ?? 0), 0),
      statePushes: rows.filter((r) => r.type === 'state').length,
      threadPushes: rows.filter((r) => r.type === 'thread' || r.type === 'threadPatch').length,
      bytes: rows.reduce((sum, p) => sum + p.bytes, 0),
      firstPublicationMs: first.at - start,
      finalPublicationMs: (rows.find((r) => r.text.includes('Chunk 48.'))?.at ?? end) - start
    };
    console.log('TRANSCRIPT_REFRESH ' + JSON.stringify(reading));
    if (process.env['SQUADRON_RUN'])
      await fs.writeFile(
        path.join(process.env['SQUADRON_RUN'], 'transcript-refresh.json'),
        JSON.stringify({ reading, wire: rows, emitted, visibleChunks }, null, 2)
      );
    assert.ok(reading.threadPushes >= 6, 'stream growth uses the independent transcript channel');
    assert.ok(
      reading.statePushes < reading.threadPushes,
      'board publication is independent of steady text'
    );
    await endCard(pid);
  });

  boot.step(
    'recovers the selected thread after deselection, hidden completion and document reconstruction',
    async () => {
      const was = await pids();
      await startFromDraft('thread-acquisition');
      const pid = await waitForNewPid(was);
      const card = () => boot.panel().locator(`#cards .card[data-pid="${pid}"]`);
      await boot
        .panel()
        .locator('#thread .turn.live', { hasText: 'Acquired from memory.' })
        .waitFor();
      const signal = path.join(boot.homeDir(), '.squadron', 'thread-acquisition');
      try {
        await openDraft();
        await fs.writeFile(signal, 'grow');
        await card().click();
        const reply = 'Acquired from memory. Still here after another delta.';
        await boot
          .panel()
          .locator('#thread .turn.live', { hasText: reply })
          .waitFor({ timeout: 15_000 });
        await boot.ctx.page.getByText('pick-me.txt', { exact: true }).dblclick();
        await boot.ctx.page.locator('.tab.active', { hasText: 'pick-me.txt' }).waitFor();
        await fs.writeFile(signal, 'complete');
        await command('Squadron: Show Sessions Overview');
        await card().and(boot.panel().locator('.idle')).waitFor({ timeout: 15_000 });
        await boot
          .panel()
          .locator('#thread .turn.assistant:not(.live)', { hasText: reply })
          .waitFor();
        await boot
          .panel()
          .locator('body')
          .evaluate((body) => {
            body.setAttribute('data-refresh-witness', 'old');
          });
        await command('Developer: Reload Webviews');
        await boot
          .panel()
          .locator('body:not([data-refresh-witness]) #cards')
          .waitFor({ timeout: 15_000 });
        await boot
          .panel()
          .locator('#thread .turn.assistant', { hasText: reply })
          .waitFor({ timeout: 15_000 });
        assert.equal(
          await boot.panel().locator('#thread .turn.assistant', { hasText: reply }).count(),
          1
        );
        await endCard(pid);
      } finally {
        await fs.rm(signal, { force: true });
      }
    }
  );

  boot.step('keeps selected text flowing while unrelated owned metadata changes', async () => {
    let was = await pids();
    await startFromDraft('transcript-refresh-churn');
    const noisy = await waitForNewPid(was);
    was = await pids();
    await startFromDraft('thread-acquisition');
    const selected = await waitForNewPid(was);
    const signal = path.join(boot.homeDir(), '.squadron', 'thread-acquisition');
    const complete = path.join(boot.homeDir(), '.squadron', 'refresh-churn-complete');
    try {
      await boot
        .panel()
        .locator('#thread .turn.live', { hasText: 'Acquired from memory.' })
        .waitFor({ timeout: 3000 });
      await fs.writeFile(signal, 'grow');
      await boot
        .panel()
        .locator('#thread .turn.live', { hasText: 'Still here after another delta.' })
        .waitFor({ timeout: 2500 });
      assert.ok(
        await boot.panel().locator(`#cards .card.busy[data-pid="${noisy}"]`).count(),
        'the other session is still changing metadata'
      );
      await fs.writeFile(signal, 'complete');
      await boot
        .panel()
        .locator(`#cards .card.idle[data-pid="${selected}"]`)
        .waitFor({ timeout: 15_000 });
      await endCard(selected);
      await fs.writeFile(complete, 'complete');
      await boot
        .panel()
        .locator(`#cards .card.idle[data-pid="${noisy}"]`)
        .waitFor({ timeout: 15_000 });
      await endCard(noisy);
    } finally {
      await fs.rm(signal, { force: true });
      await fs.rm(complete, { force: true });
    }
  });
});
