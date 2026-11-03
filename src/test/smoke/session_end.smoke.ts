import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { testPlatform, writeJson } from '../helpers';
import { ctx, homeDir, openPanel, panel, patchSettings, section, step } from './boot';
import {
  assertMainDraft,
  claudeTwinFile,
  composer,
  composerValue,
  dockWidth,
  end,
  endCard,
  observeEnd,
  openDraft,
  pids,
  plantClaudeTwin,
  postSpawnRequest,
  publishedSessionId,
  send,
  startFromDraft,
  waitForNewPid
} from './kit';

/**
 * End, exit, pipe-error and family sections. Each one arranges its own
 * session, so a red skips that section and not the shared life in
 * `session.smoke.ts`.
 */

/** Plain text planted in the main draft before the session is selected again. */
const UNFINISHED_TASK = 'unfinished task stays';

/** The selected session's chat, not the draft that End returns to. */
async function sessionChat(text: string): Promise<void> {
  await panel()
    .locator('#chat:not(.empty) #thread', { hasText: text })
    .waitFor({ timeout: 30_000 });
  assert.equal(await panel().locator('#chat.empty').count(), 0);
  assert.equal(await panel().locator('body.closed').count(), 0);
}

/** The main draft is up and the ended session's live thread is not. */
async function assertDraftUp(width: number): Promise<void> {
  await panel().locator('#chat.empty.start').waitFor({ timeout: 10_000 });
  assert.equal(await panel().locator('body.closed').count(), 0, 'the shell collapsed');
  assert.match(
    (await panel().locator('#thread .vacant h3').textContent()) ?? '',
    /New session in [\s\S]*project/
  );
  assert.equal(await panel().locator('#thread .turn.assistant.live').count(), 0);
  assert.equal(await dockWidth(), width);
}

section('End confirmation in the webview', () => {
  step('Cancel keeps the session and its chat, then End returns to the main draft', async () => {
    await openPanel();
    await panel().locator('#nav-actions .gear').click();
    // VS Code moved the iframe 4px between dialogs on 2026-10-28; measure inside it.
    const settingsTitleY = await panel()
      .locator('#settings .ashead b')
      .evaluate((node) => node.getBoundingClientRect().y);
    await panel().locator('#settings .settings-close').click();
    const before = await pids();
    await startFromDraft('hello');
    const started = await waitForNewPid(before);
    const live = panel().locator(`#cards .card[data-pid="${started}"]`);
    await live.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await live.click();
    await sessionChat('hello');
    // New, then back to the session: the task is already in the main draft
    // before End, and End is what has to bring that same draft back.
    await openDraft();
    await composer().fill(UNFINISHED_TASK);
    assert.equal(await composerValue(), UNFINISHED_TASK);
    await live.click();
    await sessionChat('hello');
    assert.equal(await composerValue(), '');
    const width = await dockWidth();
    await live.locator(`[data-key="${started}:close"]`).click();
    const modal = panel().locator('#cscrim');
    const confirm = modal.getByRole('button', { name: 'End session', exact: true });
    await confirm.waitFor({ timeout: 30_000 });
    assert.equal(
      await modal
        .getByRole('button', { name: 'Cancel', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    );
    const bounds = await modal.locator('[role="dialog"]').boundingBox();
    const viewport = await panel().locator('html').boundingBox();
    assert.ok(
      bounds &&
        viewport &&
        Math.abs(bounds.x + bounds.width / 2 - (viewport.x + viewport.width / 2)) <= 1,
      'confirmation is not horizontally centered in the panel'
    );
    const titleY = await modal
      .locator('.ashead b')
      .evaluate((node) => node.getBoundingClientRect().y);
    assert.ok(
      Math.abs(titleY - settingsTitleY) <= 1,
      `confirmation title at ${titleY}px does not share Settings at ${settingsTitleY}px`
    );
    assert.equal(await modal.locator('.ashead b').innerText(), 'End this session?');
    const named = (await modal.locator('#confirm-detail').innerText()).split('\n')[0] ?? '';
    assert.ok(
      named && (await live.locator('.name').getAttribute('data-tip')) === named,
      `confirmation body does not open with the card's name: ${named}`
    );
    const run = process.env['SQUADRON_RUN'];
    if (run) await modal.screenshot({ path: path.join(run, 'confirm-modal.png') });
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await live.count(), 1, 'Cancel ended the session');
    await sessionChat('hello');
    assert.equal(await composerValue(), '');
    assert.equal(await dockWidth(), width, 'Cancel moved the divider');
    await live.locator(`[data-key="${started}:close"]`).click();
    await confirm.waitFor({ timeout: 30_000 });
    await confirm.click();
    await live.waitFor({ state: 'detached', timeout: 60_000 });
    await assertMainDraft(width, UNFINISHED_TASK);
  });
});

section('a session exits while End confirmation is open', () => {
  step('removes the exited entry when the reader confirms End', async () => {
    await openPanel();
    const before = await pids();
    await startFromDraft('hello');
    const started = await waitForNewPid(before);
    const live = panel().locator(`#cards .card[data-pid="${started}"]`);
    await live.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await live.locator(`[data-key="${started}:close"]`).click();
    const confirm = panel()
      .locator('#cscrim')
      .getByRole('button', { name: 'End session', exact: true });
    await confirm.waitFor({ timeout: 30_000 });
    process.kill(Number(started), 'SIGTERM');
    const file = path.join(homeDir(), '.squadron', 'live', `${started}.json`);
    let exited = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as { exit?: unknown };
      if (record.exit !== undefined) {
        exited = true;
        break;
      }
      await ctx.page.waitForTimeout(100);
    }
    assert.equal(exited, true, 'host did not observe the child exit while confirmation was open');
    await confirm.click();
    await live.waitFor({ state: 'detached', timeout: 10_000 });
  });
});

section('a pipe error is not native termination', () => {
  step('confirms and awaits End after stdin has failed while the child is alive', async () => {
    await openPanel();
    const before = await pids();
    const marker = path.join(homeDir(), '.squadron', 'fake-closed-input');
    await fs.writeFile(marker, 'hold');
    try {
      if (testPlatform() === 'win32') {
        const fixture = path.join(homeDir(), 'closed-input.exe');
        const compiled = spawnSync(
          path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
          [
            '/nologo',
            '/target:exe',
            '/reference:System.Web.Extensions.dll',
            `/out:${fixture}`,
            path.join(__dirname, '../../../src/test/fixtures/closed_input_native.cs')
          ],
          { windowsHide: true, encoding: 'utf8', timeout: 10000 }
        );
        assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
        await patchSettings({ 'squadron.claudePath': fixture });
      }
      await startFromDraft('closed-input');
      const started = await waitForNewPid(before);
      const card = panel().locator(`#cards .card[data-pid="${started}"]`);
      await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
      await fs.writeFile(marker, 'close');
      const deadline = performance.now() + 5000;
      while ((await fs.readFile(marker, 'utf8')) !== 'closed') {
        assert.ok(performance.now() < deadline, 'fixture did not close stdin');
        await ctx.page.waitForTimeout(20);
      }
      await send('after input closure');
      await card.and(panel().locator('.unknown')).waitFor({ timeout: 30_000 });
      assert.equal(process.kill(Number(started), 0), true, 'fixture exited before End');
      const assertNoFlash = await observeEnd(started);
      await card.locator(`[data-key="${started}:close"]`).click();
      const confirm = panel()
        .locator('#cscrim')
        .getByRole('button', { name: 'End session', exact: true });
      await confirm.waitFor({ timeout: 30_000 });
      await confirm.click();
      await card.and(panel().locator('.closing')).waitFor({ timeout: 2_500 });
      await card.waitFor({ state: 'detached', timeout: 30_000 });
      await assertNoFlash();
      assert.throws(
        () => process.kill(Number(started), 0),
        'card disappeared before native termination'
      );
    } finally {
      await fs.rm(marker, { force: true });
    }
  });
});

/**
 * An accepted self end leaves the selected chat for the main-folder draft
 * while the card can still say it is ending. Host delivery: the installed
 * shim, `serveOwned`, `endSession`. A jsdom `closeResult` cannot see that hop.
 * A later push must not put the ended session's thread back.
 */
section(
  'a self end leaves the selected chat for the main draft before the process exits',
  () => {
    step('shows the main draft while the card still says it is ending', async () => {
      let started = '';
      let confirmation = '';
      const requestsDir = path.join(homeDir(), '.squadron', 'requests');
      try {
        await openPanel();
        const before = await pids();
        // Busy, and still alive for 3s after stdin closes, so the card and the
        // chat can be read apart.
        await startFromDraft('slow eof-hold');
        started = await waitForNewPid(before);
        const live = panel().locator(`#cards .card[data-pid="${started}"]`);
        await live.click();
        await live.and(panel().locator('.busy.selected')).waitFor({ timeout: 30_000 });
        await panel()
          .locator('#thread .turn.assistant.live')
          .filter({ hasText: 'working' })
          .waitFor({ timeout: 30_000 });
        const sessionId = await publishedSessionId(started);
        await plantClaudeTwin(Number(started), sessionId, 'self end', Date.now());

        const record = JSON.parse(
          await fs.readFile(path.join(homeDir(), '.squadron', 'live', `${started}.json`), 'utf8')
        ) as { session: { windowId: string; pid: number; startedAt: number } };
        const width = await dockWidth();
        const assertNoFlash = await observeEnd(started);
        const ended = end(['--pid', started, '--caller-session-id', sessionId, '--self']);
        assert.equal(ended.code, 0, ended.said);
        assert.match(ended.said, /ending this session/);
        await assertDraftUp(width);
        await live.and(panel().locator('.closing')).waitFor({ timeout: 2_500 });
        assert.equal(await live.locator('.pill').textContent(), 'Ending…');
        confirmation = randomUUID();
        await writeJson(path.join(requestsDir, `${confirmation}.request.json`), {
          kind: 'close',
          windowId: record.session.windowId,
          pid: record.session.pid,
          startedAt: record.session.startedAt,
          id: confirmation,
          createdAt: Date.now()
        });
        let reply: { ok: boolean; reason?: string } | undefined;
        for (let attempt = 0; attempt < 25; attempt++) {
          try {
            reply = JSON.parse(
              await fs.readFile(path.join(requestsDir, `${confirmation}.reply.json`), 'utf8')
            ) as typeof reply;
            break;
          } catch {
            await ctx.page.waitForTimeout(100);
          }
        }
        assert.equal(
          reply?.ok,
          true,
          `overlapping close was not accepted: ${reply?.reason ?? 'no reply'}`
        );
        // The file watch and the poll both land inside the hold.
        await ctx.page.waitForTimeout(800);
        await assertDraftUp(width);
        await live.waitFor({ state: 'detached', timeout: 30_000 });
        await assertNoFlash();
        await assertDraftUp(width);
      } finally {
        if (started) await fs.rm(claudeTwinFile(Number(started)), { force: true });
        if (confirmation) {
          await Promise.all(
            ['request', 'reply'].map((suffix) =>
              fs.rm(path.join(requestsDir, `${confirmation}.${suffix}.json`), { force: true })
            )
          );
        }
      }
    });
  },
  () => ({
    // `squadron-end` is a write verb, gated on Orchestration (`cli/gate.ts`).
    'squadron.orchestrators.enabled': true
  })
);

/**
 * An ending child stays in the family box after its discovery twin is removed,
 * and leaves the box only when the process does. The twins are planted so the
 * box exists before the end; deleting the child's file is the missing-twin
 * interval, not a claim about Claude's own shutdown timing.
 */
section(
  'an ending child stays in its family until the process exits',
  () => {
    const planted: number[] = [];

    async function plantTwin(pid: number, sessionId: string, name: string): Promise<void> {
      await plantClaudeTwin(pid, sessionId, name, Date.now());
      planted.push(pid);
    }

    async function familyPids(pid: string): Promise<string[] | undefined> {
      const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
      const box = card.locator('xpath=ancestor::*[contains(@class,"fam")][1]');
      if ((await box.count()) === 0) return undefined;
      return box
        .locator('.card[data-pid]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-pid') ?? '').filter((id) => id !== '')
        );
    }

    step('keeps the ending child in the box after its twin file is removed', async () => {
      const project = path.join(homeDir(), 'project');
      const started: string[] = [];
      try {
        await openPanel();
        let before = await pids();
        await startFromDraft('family anchor');
        const anchor = await waitForNewPid(before);
        started.push(anchor);
        const anchorCard = panel().locator(`#cards .card[data-pid="${anchor}"]`);
        await anchorCard.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
        const originId = await publishedSessionId(anchor);
        await plantTwin(Number(anchor), originId, 'family anchor');

        before = await pids();
        await postSpawnRequest({
          cwd: project,
          prompt: 'family peer',
          parentSessionId: originId,
          originSessionId: originId
        });
        const peer = await waitForNewPid(before);
        started.push(peer);
        await panel()
          .locator(`#cards .card[data-pid="${peer}"]`)
          .and(panel().locator('.idle'))
          .waitFor({ timeout: 30_000 });
        await plantTwin(Number(peer), await publishedSessionId(peer), 'family peer');

        before = await pids();
        await postSpawnRequest({
          cwd: project,
          prompt: 'eof-hold',
          parentSessionId: originId,
          originSessionId: originId
        });
        const child = await waitForNewPid(before);
        started.push(child);
        const childCard = panel().locator(`#cards .card[data-pid="${child}"]`);
        await childCard.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
        await plantTwin(Number(child), await publishedSessionId(child), 'family child');

        const boxed = async (): Promise<void> => {
          const members = await familyPids(child);
          assert.ok(members, 'the child is outside every family');
          assert.ok(members.includes(anchor) && members.includes(peer) && members.includes(child));
          assert.equal(
            await panel().locator(`#cards .card[data-pid="${child}"]`).count(),
            1,
            'the ending child is drawn twice'
          );
        };
        await boxed();

        await childCard.locator(`[data-key="${child}:close"]`).click();
        const confirm = panel()
          .locator('#cscrim')
          .getByRole('button', { name: 'End session', exact: true });
        await confirm.waitFor({ timeout: 30_000 });
        await confirm.click();
        await childCard.and(panel().locator('.closing')).waitFor({ timeout: 2_500 });
        assert.equal(await childCard.locator('.pill').textContent(), 'Ending…');
        await fs.rm(claudeTwinFile(Number(child)), { force: true });
        // The session-file watch refreshes inside the 3s hold. Sample twice.
        await ctx.page.waitForTimeout(700);
        await boxed();
        await ctx.page.waitForTimeout(700);
        await boxed();
        await childCard.waitFor({ state: 'detached', timeout: 30_000 });
        const left = await familyPids(anchor);
        assert.ok(left, 'the anchor left its family');
        assert.ok(left.includes(anchor) && left.includes(peer));
        assert.equal(left.includes(child), false);
      } finally {
        await Promise.all(planted.map((pid) => fs.rm(claudeTwinFile(pid), { force: true })));
        for (const pid of started.reverse()) await endCard(pid);
      }
    });
  },
  () => ({ 'squadron.orchestrators.enabled': true })
);
