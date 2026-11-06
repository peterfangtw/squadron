import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import { processCwds } from '../../core/devservers/listeners';
import { homeDir, openPanel, panel, section, step } from './boot';
import {
  composer,
  dockReady,
  endCard,
  openDraft,
  pids,
  publishedSessionId,
  sendDraft,
  waitForNewPid
} from './kit';

section(
  'sessions in an IDE window without a folder',
  () => {
    let firstPid: string;
    let secondPid: string;
    let firstCwd: string;
    let sessionId: string;
    before(openPanel);

    step('offers an ordinary draft without creating a working directory', async () => {
      const root = path.join(homeDir(), '.squadron', 'scratch');
      await panel().locator('#chat.start').waitFor({ timeout: 30_000 });
      assert.equal(await panel().locator('.half[data-act="open"]').getAttribute('data-cwd'), root);
      await assert.rejects(fs.stat(root), { code: 'ENOENT' });
      const windows = path.join(homeDir(), '.squadron', 'windows');
      const claims = await Promise.all(
        (await fs.readdir(windows))
          .filter((name) => name.endsWith('.json'))
          .map(
            async (name) =>
              JSON.parse(await fs.readFile(path.join(windows, name), 'utf8')) as { folder?: string }
          )
      );
      assert.ok(claims.length > 0);
      assert.ok(
        claims.every((claim) => claim.folder === undefined),
        'the host really has no IDE folder'
      );
    });

    step('runs two sessions in distinct child directories under one group', async () => {
      let was = await pids();
      await sendDraft('scratch alpha hello');
      firstPid = await waitForNewPid(was);
      await panel().locator(`.card.idle[data-pid="${firstPid}"]`).waitFor({ timeout: 30_000 });
      await dockReady();
      sessionId = await publishedSessionId(firstPid);
      firstCwd = await childCwd(firstPid);
      assert.equal(path.dirname(firstCwd), path.join(homeDir(), '.squadron', 'scratch'));
      was = await pids();
      await openDraft(path.dirname(firstCwd));
      await sendDraft('scratch beta hello');
      secondPid = await waitForNewPid(was);
      await panel().locator(`.card.idle[data-pid="${secondPid}"]`).waitFor({ timeout: 30_000 });
      await dockReady();
      const secondCwd = await childCwd(secondPid);
      assert.equal(path.dirname(secondCwd), path.dirname(firstCwd));
      assert.notEqual(secondCwd, firstCwd);
      assert.equal(await panel().locator('#cards .repo').count(), 1);
      assert.equal(await panel().locator('.card.add').count(), 1);
    });

    step('resumes an ended conversation in its original working directory', async () => {
      await fs.writeFile(path.join(firstCwd, 'keep.txt'), 'keep this output');
      await endCard(firstPid);
      await panel().locator('.half[data-act="resume"]').click();
      const row = panel().locator('#picker .pit', { hasText: 'scratch alpha hello' });
      await row.waitFor({ timeout: 30_000 });
      const was = await pids();
      await row.click();
      const resumed = await waitForNewPid(was);
      await dockReady();
      assert.equal(await publishedSessionId(resumed), sessionId);
      assert.equal(await childCwd(resumed), firstCwd);
      assert.equal(await fs.readFile(path.join(firstCwd, 'keep.txt'), 'utf8'), 'keep this output');
      await endCard(resumed);
      await endCard(secondPid);
    });
  },
  undefined,
  { folderless: true }
);

section(
  'a folderless working directory that cannot be created',
  () => {
    before(openPanel);
    step('retains the first prompt and reports a definitive start failure', async () => {
      const root = path.join(homeDir(), '.squadron', 'scratch');
      await fs.writeFile(root, 'not a directory');
      const text = 'scratch allocation hello';
      await composer().fill(text);
      await composer().press('Enter');
      await panel().locator('#chat.start .why').waitFor({ timeout: 30_000 });
      assert.equal((await panel().locator('#thread .send-failed .body').innerText()).trim(), text);
      assert.equal((await pids()).size, 0);
      assert.equal(await fs.readFile(root, 'utf8'), 'not a directory');
      await fs.unlink(root);
      const was = await pids();
      await panel().locator('[data-act="retry-held"]').click();
      const pid = await waitForNewPid(was);
      await panel().locator(`.card.idle[data-pid="${pid}"]`).waitFor({ timeout: 30_000 });
      await dockReady();
      assert.equal(
        (await panel().locator('#thread .turn.user .body').first().innerText()).trim(),
        text
      );
      await endCard(pid);
    });
  },
  undefined,
  { folderless: true }
);

async function childCwd(pid: string): Promise<string> {
  const actual = (await processCwds([Number(pid)])).get(Number(pid));
  assert.ok(actual, 'the child process exposes its actual working directory');
  return fs.realpath(actual);
}
