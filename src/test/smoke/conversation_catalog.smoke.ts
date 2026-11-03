import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SCHEMA } from '../../core/record';
import { homeDir, openPanel, panel, section, step } from './boot';

section('the transcript catalog in the real IDE', () => {
  step('bootstraps after cold history, reads warm history and discovers new records', async () => {
    await openPanel();
    const cwd = await fs.realpath(path.join(homeDir(), 'project'));
    const store = path.join(homeDir(), '.squadron', 'transcripts');
    const directory = path.join(homeDir(), '.squadron', 'catalog');
    const file = path.join(directory, 'transcripts.v1.jsonl');
    await fs.mkdir(store, { recursive: true });
    await fs.rm(directory, { recursive: true, force: true });
    const title = 'Catalog smoke history';
    await plant(store, cwd, 'catalog-smoke', title);

    // Cold: every header and the family's summaries are read before page 1,
    // and published together after it.
    await panel().locator('[data-act="resume"]').first().click();
    await panel().locator('#picker .pit', { hasText: title }).waitFor({ timeout: 30_000 });
    await cached(file, 'catalog-smoke.jsonl', true);
    await panel().locator('#pfilter').press('Escape');

    await panel().locator('[data-act="resume"]').first().click();
    await panel().locator('#picker .pit', { hasText: title }).waitFor({ timeout: 30_000 });
    await cached(file, 'catalog-smoke.jsonl', true);
    await panel().locator('#pfilter').press('Escape');

    await plant(store, cwd, 'catalog-new', 'New catalog history');
    await panel().locator('[data-act="resume"]').first().click();
    await panel()
      .locator('#picker .pit', { hasText: 'New catalog history' })
      .waitFor({ timeout: 30_000 });
    await panel().locator('#picker .pit', { hasText: title }).waitFor({ timeout: 30_000 });
    await panel().locator('#pfilter').press('Escape');
  });

  step('pages a family past two pages and searches rows no page has loaded', async () => {
    await openPanel();
    const cwd = await fs.realpath(path.join(homeDir(), 'project'));
    const store = path.join(homeDir(), '.squadron', 'transcripts');
    const now = Date.now();
    // Newer than everything the step above planted, newest first.
    for (let i = 0; i < 45; i++)
      await plant(store, cwd, `paged-${i}`, `Paged history ${i}`, now + 60_000 - i * 1000);
    const rows = panel().locator('#picker .pit');
    const more = panel().locator('#picker .pmore');

    await panel().locator('[data-act="resume"]').first().click();
    await panel()
      .locator('#picker .pit', { hasText: 'Paged history 0' })
      .waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 20);
    await more.click();
    await panel()
      .locator('#picker .pit', { hasText: 'Paged history 39' })
      .waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 40);
    assert.equal(await panel().locator('#picker .pit', { hasText: 'Paged history 44' }).count(), 0);

    await panel().locator('#pfilter').fill('paged history 44');
    await panel()
      .locator('#picker .pit', { hasText: 'Paged history 44' })
      .waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 1);
    await panel().locator('#pfilter').fill('');
    await panel()
      .locator('#picker .pit', { hasText: 'Paged history 0' })
      .waitFor({ timeout: 30_000 });
    await more.waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 20);
    await panel().locator('#pfilter').press('Escape');
  });

  step('ranks a cold first page by recorded activity, never by file mtime', async () => {
    await openPanel();
    const cwd = await fs.realpath(path.join(homeDir(), 'project'));
    const store = path.join(homeDir(), '.squadron', 'transcripts');
    await fs.rm(path.join(homeDir(), '.squadron', 'catalog'), { recursive: true, force: true });
    // The newest activity in the store, in files older than every other one:
    // the 47 records planted above hold the 47 newest mtimes, so a page chosen
    // by mtime would hold none of these.
    const now = Date.now();
    const old = new Date(now - 20 * 86_400_000);
    for (let i = 0; i < 25; i++) {
      const file = await plant(
        store,
        cwd,
        `cold-${i}`,
        `Cold recent ${i}`,
        now + 120_000 - i * 1000
      );
      await fs.utimes(file, old, old);
    }
    const rows = panel().locator('#picker .pit');

    await panel().locator('[data-act="resume"]').first().click();
    await panel()
      .locator('#picker .pit', { hasText: 'Cold recent 0' })
      .waitFor({ timeout: 30_000 });
    assert.deepEqual(
      await rows.locator('.t').allTextContents(),
      Array.from({ length: 20 }, (_, i) => `Cold recent ${i}`)
    );
    await panel().locator('#picker .pmore').waitFor({ timeout: 30_000 });
    await panel().locator('#pfilter').press('Escape');
  });
});

async function plant(
  store: string,
  cwd: string,
  sessionId: string,
  text: string,
  at = Date.now()
): Promise<string> {
  const file = path.join(store, sessionId + '.jsonl');
  await fs.writeFile(
    file,
    [
      JSON.stringify({ v: SCHEMA, sessionId, cwd, brand: 'codex' }),
      JSON.stringify({ role: 'user', text, at }),
      ''
    ].join('\n')
  );
  return file;
}

async function cached(file: string, name: string, summary: boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const body = await fs.readFile(file, 'utf8').catch(() => '');
    const entries = body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { f?: string; summary?: { title?: string } });
    const found = entries.find((entry) => entry.f === name);
    if (found && Boolean(found.summary?.title) === summary) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('the host did not publish the expected catalog metadata');
}
