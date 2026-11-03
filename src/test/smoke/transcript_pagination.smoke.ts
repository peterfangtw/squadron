import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { before } from 'node:test';
import * as boot from './boot';
import { composer, endCard, pids, waitForNewPid } from './kit';
import { projectSlug } from '../../core/claude/transcript';

boot.section('ten user turns and full history in stock VS Code', () => {
  before(boot.openPanel);
  boot.step(
    'shows ten user turns, opens all history and hides its action without a backlog',
    async () => {
      await boot.patchSettings({ 'squadron.devServers.enabled': false });
      const id = randomUUID();
      const cwd = path.join(boot.homeDir(), 'project');
      const records = path.join(boot.homeDir(), '.squadron', 'transcripts');
      const cli = path.join(boot.homeDir(), '.claude', 'projects', projectSlug(cwd));
      const names = path.join(boot.homeDir(), '.squadron', 'names');
      await Promise.all([records, cli, names].map((dir) => fs.mkdir(dir, { recursive: true })));
      const text = (i: number): string => `History row ${i}. ${'recorded prose '.repeat(64)}`;
      const lines = Array.from({ length: 1500 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: text(i),
        ...(i === 1498 ? {} : { blocks: [{ text: text(i) }] }),
        at: Date.now() - 1500 + i,
        m: `history-${i}`
      }));
      await fs.writeFile(
        path.join(records, `${id}.jsonl`),
        [
          JSON.stringify({ v: 2, sessionId: id, cwd, brand: 'claude' }),
          ...lines.map((line) => JSON.stringify(line)),
          ''
        ].join('\n')
      );
      await fs.writeFile(
        path.join(cli, `${id}.jsonl`),
        lines
          .map((line, i) =>
            JSON.stringify({
              type: i % 2 ? 'assistant' : 'user',
              sessionId: id,
              cwd,
              timestamp: new Date(line.at).toISOString(),
              message: {
                id: `history-${i}`,
                role: line.role,
                content: [{ type: 'text', text: line.text }]
              }
            })
          )
          .join('\n') + '\n'
      );
      await fs.writeFile(
        path.join(names, `claude.${id}.json`),
        JSON.stringify({
          schema: 1,
          brand: 'claude',
          sessionId: id,
          name: 'pagination fixture',
          statedAt: Date.now()
        })
      );
      await boot
        .panel()
        .locator('body')
        .evaluate(() => {
          const messages: { type: string; bytes: number; at: number }[] = [];
          Object.assign(window, { paginationWire: messages });
          window.addEventListener('message', (event: MessageEvent<PanelMessage>) => {
            if (!['thread', 'threadPatch', 'state'].includes(event.data.type)) return;
            messages.push({
              type: event.data.type,
              bytes: new TextEncoder().encode(JSON.stringify(event.data)).length,
              at: Date.now()
            });
          });
        });
      const was = await pids();
      const start = Date.now();
      await boot.panel().locator('[data-act="resume"]').first().click();
      await boot.panel().locator('#picker .pit', { hasText: 'pagination fixture' }).click();
      const pid = await waitForNewPid(was);
      const latest = boot.panel().locator('#thread .body', { hasText: 'History row 1499.' });
      await latest.waitFor({ timeout: 30_000 });
      const initialMs = Date.now() - start;
      const initialTurns = await boot.panel().locator('#thread .turn').count();
      const initialWire = await boot
        .panel()
        .locator('body')
        .evaluate(
          () =>
            (window as unknown as { paginationWire: { type: string; bytes: number; at: number }[] })
              .paginationWire
        );
      const evidence = { initialMs, initialTurns, initialWire };
      console.log('pagination initial', JSON.stringify(evidence));
      if (process.env['SQUADRON_RUN_DIR'])
        await fs.writeFile(
          path.join(process.env['SQUADRON_RUN_DIR'], 'pagination-initial.json'),
          JSON.stringify(evidence)
        );
      assert.equal(initialTurns, 20);
      await boot.panel().locator('#thread .body', { hasText: 'History row 1480.' }).waitFor();
      assert.equal(
        await boot.panel().locator('#thread .body', { hasText: 'History row 1478.' }).count(),
        0
      );
      assert.equal(await boot.panel().locator('.history-nav button').count(), 1);
      await boot
        .panel()
        .locator('#thread .body', { hasText: 'History row 1498.' })
        .waitFor({ timeout: 30_000 });
      await boot.panel().locator('[data-history="browse"]').click();
      await boot.panel().locator('[data-history="recent"]').waitFor({ timeout: 30_000 });
      await boot.panel().locator('#thread .body', { hasText: 'History row 0.' }).waitFor();
      assert.equal(await boot.panel().locator('#thread .turn').count(), 1500);
      assert.equal(await boot.panel().locator('.history-nav button').count(), 1);
      assert.equal(
        await boot
          .panel()
          .locator('[data-history="older"], [data-history="newer"], [data-history="live"]')
          .count(),
        0
      );
      const boxes = await boot
        .panel()
        .locator('.history-nav button')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          })
        );
      assert.ok(boxes.every((box) => box.width >= 24 && box.height >= 24));
      await composer().fill('pagination-stream');
      await composer().press('Enter');
      await boot
        .panel()
        .locator(`#cards .card[data-pid="${pid}"].busy`)
        .waitFor({ timeout: 30_000 });
      await boot
        .panel()
        .locator('#thread')
        .evaluate((node) => {
          node.scrollTop = 1000;
        });
      const parked = await boot
        .panel()
        .locator('#thread')
        .evaluate((node) => node.scrollTop);
      await boot
        .panel()
        .locator('body')
        .evaluate(async () => {
          const wire = (window as unknown as { paginationWire: { type: string }[] }).paginationWire;
          const at = wire.length;
          const deadline = Date.now() + 6000;
          while (!wire.slice(at).some((entry) => entry.type === 'threadPatch')) {
            if (Date.now() > deadline) throw new Error('no live patch while viewing history');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        });
      assert.equal(
        await boot
          .panel()
          .locator('#thread')
          .evaluate((node) => node.scrollTop),
        parked,
        'live growth moved the recorded history reader'
      );
      await boot
        .panel()
        .locator(`#cards .card[data-pid="${pid}"].idle`)
        .waitFor({ timeout: 30_000 });
      assert.equal(
        await boot.panel().locator('#thread .body', { hasText: 'History row 0.' }).count(),
        1
      );
      await boot.panel().locator('[data-history="recent"]').click();
      await boot
        .panel()
        .locator('#thread .body', { hasText: 'Page stream 20.' })
        .waitFor({ timeout: 30_000 });
      await boot
        .panel()
        .locator(`#cards .card[data-pid="${pid}"].idle`)
        .waitFor({ timeout: 30_000 });
      const wire = await boot
        .panel()
        .locator('body')
        .evaluate(
          () =>
            (window as unknown as { paginationWire: { type: string; bytes: number; at: number }[] })
              .paginationWire
        );
      assert.ok(
        wire.some((message) => message.type === 'threadPatch'),
        'host emitted no incremental update'
      );
      console.log(
        'pagination final',
        JSON.stringify({
          bytes: wire.reduce((sum, message) => sum + message.bytes, 0),
          snapshots: wire.filter((message) => message.type === 'thread').length,
          patches: wire.filter((message) => message.type === 'threadPatch').length
        })
      );
      await boot
        .panel()
        .locator('body')
        .evaluate((body) => {
          body.setAttribute('data-pagination-witness', 'old');
        });
      await boot.ctx.page.keyboard.press('ControlOrMeta+Shift+P');
      await boot.ctx.page.keyboard.type('Developer: Reload Webviews');
      await boot.ctx.page.keyboard.press('Enter');
      await boot
        .panel()
        .locator('body:not([data-pagination-witness]) #cards')
        .waitFor({ timeout: 15_000 });
      await boot
        .panel()
        .locator('#thread .body', { hasText: 'Page stream 20.' })
        .waitFor({ timeout: 30_000 });
      assert.equal(await boot.panel().locator('#thread .turn.user:not(.sending)').count(), 10);
      assert.equal(await boot.panel().locator('.history-nav button').count(), 1);
      await endCard(pid);

      const short = lines.slice(0, 20);
      await fs.writeFile(
        path.join(records, `${id}.jsonl`),
        [
          JSON.stringify({ v: 2, sessionId: id, cwd, brand: 'claude' }),
          ...short.map((line) => JSON.stringify(line)),
          ''
        ].join('\n')
      );
      await fs.writeFile(
        path.join(cli, `${id}.jsonl`),
        short
          .map((line, i) =>
            JSON.stringify({
              type: i % 2 ? 'assistant' : 'user',
              sessionId: id,
              cwd,
              timestamp: new Date(line.at).toISOString(),
              message: {
                id: `history-${i}`,
                role: line.role,
                content: [{ type: 'text', text: line.text }]
              }
            })
          )
          .join('\n') + '\n'
      );
      const beforeShort = await pids();
      await boot.panel().locator('[data-act="resume"]').first().click();
      await boot.panel().locator('#picker .pit', { hasText: 'pagination fixture' }).click();
      const shortPid = await waitForNewPid(beforeShort);
      await boot.panel().locator('#thread .body', { hasText: 'History row 19.' }).waitFor();
      assert.equal(await boot.panel().locator('#thread .turn.user').count(), 10);
      assert.equal(await boot.panel().locator('.history-nav').count(), 0);
      await composer().fill('pagination-stream');
      await composer().press('Enter');
      await boot.panel().locator('[data-history="browse"]').waitFor();
      assert.equal(
        await boot.panel().locator('#thread .body', { hasText: 'History row 0.' }).count(),
        0
      );
      await boot.panel().locator('#thread .body', { hasText: 'Page stream 20.' }).waitFor();
      await boot.panel().locator(`#cards .card[data-pid="${shortPid}"].idle`).waitFor();
      await endCard(shortPid);
    }
  );
});
