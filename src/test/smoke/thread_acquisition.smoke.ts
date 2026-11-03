import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import { homeDir, openPanel, panel, section, step } from './boot';
import { endCard, pids, publishedSessionId, startFromDraft, waitForNewPid } from './kit';

section('owned thread acquisition, in the real IDE', () => {
  before(openPanel);

  step('acquires a streaming owned thread from memory through growth and completion', async () => {
    const was = await pids();
    await startFromDraft('thread-acquisition');
    const pid = await waitForNewPid(was);
    const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
    const live = panel().locator('#thread .turn.live');
    await card.and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    await live.filter({ hasText: 'Acquired from memory.' }).waitFor({ timeout: 30_000 });
    assert.equal(await live.count(), 1);

    const id = await publishedSessionId(pid);
    const record = path.join(homeDir(), '.squadron', 'transcripts', `${id}.jsonl`);
    // No durable assistant row exists yet. A failed record read must not become
    // the owned dock's source, either while streaming or after completion.
    const saved = await fs.readFile(record, 'utf8');
    assert.ok(!saved.includes('Acquired from memory.'));
    await fs.rm(record);
    await fs.mkdir(record);
    const signal = path.join(homeDir(), '.squadron', 'thread-acquisition');
    try {
      await fs.writeFile(signal, 'grow');
      const reply = 'Acquired from memory. Still here after another delta.';
      await live.filter({ hasText: reply }).waitFor({ timeout: 30_000 });
      assert.equal((await live.locator('.body').textContent())?.trim(), reply);
      assert.equal(await live.count(), 1);

      await fs.writeFile(signal, 'complete');
      await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
      await live.waitFor({ state: 'detached', timeout: 30_000 });
      const settled = panel().locator('#thread .turn.assistant', { hasText: reply });
      await settled.waitFor({ timeout: 30_000 });
      assert.equal(await settled.count(), 1);
      assert.equal((await settled.locator('.body').textContent())?.trim(), reply);
      assert.equal(await panel().locator('#thread .sourced').count(), 0);
      assert.ok((await fs.stat(record)).isDirectory(), 'the record stayed unreadable');
      await endCard(pid);
    } finally {
      await fs.rm(signal, { force: true });
      await fs.rm(record, { recursive: true, force: true });
      await fs.writeFile(record, saved);
    }
  });
});
