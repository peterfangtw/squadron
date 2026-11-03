import { signCodex } from './kit';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { after, before } from 'node:test';
import { testPlatform } from '../helpers';
import { closeEditors, homeDir, openPanel, panel, patchSettings, section, step } from './boot';
import {
  composer,
  endCard,
  openDraft,
  pickDraftModel,
  pids,
  postSpawnRequest,
  sendDraft,
  waitForNewPid
} from './kit';

type StoredThread = {
  id: string;
  cwd: string;
  preview: string;
};

let livePid = '';

async function waitForThread(preview: string): Promise<StoredThread> {
  const file = path.join(homeDir(), '.codex', 'fake-threads.json');
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      const rows = JSON.parse(await fs.readFile(file, 'utf8')) as StoredThread[];
      const row = rows.find((candidate) => candidate.preview === preview);
      if (row) return row;
    } catch {
      // The first thread/start has not made the store yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Codex never stored the thread for ${preview}`);
}

async function waitForIdle(pid: string): Promise<void> {
  await panel()
    .locator(`#cards .card[data-pid="${pid}"]`)
    .and(panel().locator('.idle'))
    .waitFor({ timeout: 30_000 });
}

/**
 * The response body the child received, read back off the card.
 *
 * `fake-codex.ts` writes `answered:<label>:<json>` the moment it matches a
 * response to one of its own server requests, so this is the app-server's
 * reading of what resolved the tool rather than the panel's — the one claim a
 * dialog scenario cannot make by looking at the dialog.
 *
 * **Read off the fixture's log, not off the card's name.** The fake renames its
 * thread to the same string and that used to be the channel; a session started
 * from a draft now carries a `--name` cut from its prompt, and an explicit name
 * outranks any title the CLI states afterwards (`core/live.ts`) — so the card
 * goes on saying what the reader typed, which is right, and says nothing about
 * this. The file is also steadier: no retitle scramble to poll through.
 */
async function answered(label: string, body: string): Promise<void> {
  const want = `answered:${label}:${body}`;
  const log = path.join(homeDir(), '.codex', 'fake-answers.log');
  const until = Date.now() + 30_000;
  let saw = '';
  while (Date.now() < until) {
    saw = await fs.readFile(log, 'utf8').catch(() => '');
    if (saw.split('\n').includes(want)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`the ${label} decision never reached the Codex child — the log holds ${saw}`);
}

/** One approval turn: send the fake's keyword, open the ask layer, hand back the dialog. */
async function raise(text: string) {
  await composer().fill(text);
  await composer().press('Enter');
  const launch = panel().locator('#qlaunch');
  await launch.waitFor({ timeout: 30_000 });
  await launch.click();
  const dialog = panel().locator('#question .pdlg', { has: panel().locator('.pallow') });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}

// `endSpoken` stood here and is `endCard` in `kit.ts` now: every file that
// starts a session from a draft needs it, because a first turn is an exchange
// and `closePlan` asks before ending one.

/**
 * Sign Codex in or out **through the panel**, which is the only way to make the
 * change land promptly: `refreshAuthIfDue` is on a 30s tick, and a login or a
 * logout is what forces one. Writing `fake-auth.json` and waiting is the same
 * fact half a minute later.
 *
 * It is needed at all because being signed in is now a **start gate** rather
 * than only an accounts row. `gatherModels` filters a brand out for a missing
 * binary or a missing account, and the draft's pick is the one door to a
 * non-Claude start — so a Codex the panel calls signed out is a Codex nothing
 * here can begin. This file used to write `squadron.model` and bypass the
 * menu altogether, which is exactly why the gate went unnoticed.
 */

section('Codex discovery and resume in the real IDE', () => {
  before(async () => {
    await openPanel();
    await signCodex('in');
  });

  after(async () => {
    if (livePid) await endCard(livePid);
    // Tidy-up only: the next section's reset restores `HOME` and ends this
    // host's children whether or not this runs.
    await signCodex('out');
  });

  step('keeps fast startup feedback visible for its minimum duration', async () => {
    const initial = await pids();
    let pid = '';
    await openDraft();
    await pickDraftModel('Codex Test');
    const startup = panel().locator('#chat-startup');
    const motion = await startup.evaluateHandle((block) => {
      const reading = { shownAt: 0, hiddenAt: 0, positions: [] as number[] };
      const deadline = performance.now() + 10_000;
      const sample = (): void => {
        const now = performance.now();
        if (!block.isConnected || now > deadline) return;
        if (!block.hasAttribute('hidden')) {
          if (reading.shownAt === 0) reading.shownAt = now;
          reading.positions.push(block.querySelector('.start-note')!.getBoundingClientRect().y);
        } else if (reading.shownAt > 0) {
          reading.hiddenAt = now;
          return;
        }
        requestAnimationFrame(sample);
      };
      sample();
      return reading;
    });
    try {
      await sendDraft('minimum startup display');
      pid = await waitForNewPid(initial);
      await waitForIdle(pid);
      await startup.waitFor({ state: 'hidden' });
      const reading = await motion.evaluate(async (reading) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return reading;
      });
      assert.ok(
        reading.shownAt > 0 && reading.hiddenAt - reading.shownAt >= 360,
        `startup feedback flashed: ${JSON.stringify(reading)}`
      );
      assert.ok(
        Math.max(...reading.positions) - Math.min(...reading.positions) < 1,
        `startup feedback moved: ${JSON.stringify(reading.positions)}`
      );
      assert.match(
        (await panel().locator('#thread').textContent()) ?? '',
        /minimum startup display/
      );
    } finally {
      await motion.dispose();
      if (pid) await endCard(pid);
    }
  });

  step('keeps a first prompt through a 26-second native opening and sends it once', async () => {
    const hold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
    await fs.mkdir(path.dirname(hold), { recursive: true });
    await fs.writeFile(hold, 'hold opening');
    const initial = await pids();
    let pid = '';
    try {
      await openDraft();
      await pickDraftModel('Codex Test');
      await sendDraft('late opening prompt');
      const startup = panel().locator('#chat-startup');
      await startup.locator('[data-startup="cancel"]').waitFor({ timeout: 15_000 });
      const layout = await startup.evaluate(async (block) => {
        const doc = block.ownerDocument;
        const prompt = doc.querySelector<HTMLElement>('#thread .turn.user')!;
        await Promise.all(prompt.getAnimations().map((animation) => animation.finished));
        const note = block.querySelector<HTMLElement>('.start-note')!.getBoundingClientRect();
        const room = block.getBoundingClientRect();
        return {
          centeredX: Math.abs(note.x + note.width / 2 - (room.x + room.width / 2)),
          centeredY: Math.abs(note.y + note.height / 2 - (room.y + room.height / 2)),
          promptBefore: prompt.getBoundingClientRect().bottom <= note.top,
          headerHidden: getComputedStyle(doc.getElementById('chat-head')!).display === 'none',
          targets: [...block.querySelectorAll('button')].map((button) => {
            const box = button.getBoundingClientRect();
            return { width: box.width, height: box.height };
          })
        };
      });
      assert.ok(layout.centeredX < 2 && layout.centeredY < 2, JSON.stringify(layout));
      assert.ok(layout.promptBefore && layout.headerHidden, JSON.stringify(layout));
      assert.ok(layout.targets.every((box) => box.width >= 24 && box.height >= 24));
      await new Promise((resolve) => setTimeout(resolve, 26_000));
      assert.deepEqual(await pids(), initial, 'an unready native child became a card');
      assert.equal(await panel().locator('[data-act="retry-held"]').count(), 0);
      assert.match((await panel().locator('#thread').textContent()) ?? '', /late opening prompt/);
      const motion = await startup.evaluateHandle((block) => {
        const positions: number[] = [];
        const deadline = performance.now() + 3000;
        const sample = (): void => {
          if (!block.isConnected || block.hasAttribute('hidden') || performance.now() > deadline)
            return;
          positions.push(block.querySelector('.start-note')!.getBoundingClientRect().y);
          requestAnimationFrame(sample);
        };
        sample();
        return positions;
      });
      await fs.rm(hold);
      pid = await waitForNewPid(initial);
      await waitForThread('late opening prompt');
      await waitForIdle(pid);
      const turns = panel().locator('#thread .turn.user', { hasText: 'late opening prompt' });
      assert.equal(await turns.count(), 1);
      await startup.waitFor({ state: 'hidden' });
      const positions = await motion.jsonValue();
      await motion.dispose();
      assert.ok(
        Math.max(...positions) - Math.min(...positions) < 1,
        `startup feedback moved before disappearing: ${JSON.stringify(positions)}`
      );
    } finally {
      await fs.rm(hold, { force: true });
      if (pid) await endCard(pid);
    }
  });

  step(
    'cancels an unprompted opening and preserves the held text for a deliberate retry',
    async () => {
      const hold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
      await fs.writeFile(hold, 'hold opening');
      const initial = await pids();
      try {
        await openDraft();
        await pickDraftModel('Codex Test');
        await sendDraft('cancelled opening prompt');
        await panel().locator('[data-startup="cancel"]').click();
        await panel().locator('[data-act="retry-held"]').waitFor({ timeout: 25_000 });
        assert.deepEqual(await pids(), initial);
        assert.match(
          (await panel().locator('#thread').textContent()) ?? '',
          /cancelled opening prompt/
        );
        await panel().locator('[data-act="dismiss-held"]').click();
        await panel().locator('#chat.empty.start #composer').waitFor();
      } finally {
        await fs.rm(hold, { force: true });
      }
    }
  );

  step('cancels a coalesced resume immediately after recreating the panel', async () => {
    const prompt = 'recreated panel resume cancellation';
    const initial = await pids();
    await openDraft();
    await pickDraftModel('Codex Test');
    await sendDraft(prompt);
    const first = await waitForNewPid(initial);
    await waitForIdle(first);
    const stored = await waitForThread(prompt);
    await endCard(first);
    const hold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
    await fs.writeFile(hold, 'hold resume');
    const choose = async (): Promise<void> => {
      await panel().locator('[data-act="resume"]').first().click();
      await panel().locator('#picker .pit').first().waitFor({ timeout: 30_000 });
      const index = await panel()
        .locator('#picker .pit')
        .evaluateAll(
          (nodes, id) =>
            nodes.findIndex((node) => (node as HTMLElement).dataset.key === `codex\0${id}`),
          stored.id
        );
      assert.ok(index >= 0, 'stored conversation missing from picker');
      await panel().locator('#picker .pit').nth(index).click();
      await panel().locator('.card.resuming').waitFor({ timeout: 10_000 });
    };
    try {
      await choose();
      await closeEditors();
      await openPanel();
      await choose();
      await panel().locator('.resuming [data-startup="cancel"]').click();
      await panel().locator('.resuming [data-act="retry-resume"]').waitFor({ timeout: 25_000 });
      assert.deepEqual(await pids(), initial);
      await fs.rm(hold);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.deepEqual(
        await pids(),
        initial,
        'cancelled original resume revealed after the hold cleared'
      );
      await panel().locator('[data-act="dismiss-resume"]').click();
    } finally {
      await fs.rm(hold, { force: true });
    }
  });

  step('keeps a cancelled promptless resume owned until its native child exits', async (t) => {
    if (testPlatform() === 'win32')
      return t.skip(
        'win32: pending native-owner acceptance remains open; TerminateProcess exits the standalone root immediately'
      );
    const prompt = 'stopping resume owner';
    const initial = await pids();
    await openDraft();
    await pickDraftModel('Codex Test');
    await sendDraft(prompt);
    const seeded = await waitForNewPid(initial);
    await waitForIdle(seeded);
    const stored = await waitForThread(prompt);
    await endCard(seeded);
    const openingHold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
    const stopHold = path.join(homeDir(), '.codex', 'fake-stop.hold');
    const choose = async (): Promise<void> => {
      await panel().locator('[data-act="resume"]').first().click();
      await panel().locator('#picker .pit').first().waitFor({ timeout: 30000 });
      // Native conversation keys contain NUL; locate through the actual dataset.
      const index = await panel()
        .locator('#picker .pit')
        .evaluateAll(
          (nodes, id) =>
            nodes.findIndex((node) => (node as HTMLElement).dataset.key === `codex\0${id}`),
          stored.id
        );
      assert.ok(index >= 0);
      await panel().locator('#picker .pit').nth(index).click();
    };
    await fs.writeFile(openingHold, 'hold opening');
    let resumed = '';
    try {
      await choose();
      const cancel = await panel().locator('.resuming [data-startup="cancel"]').elementHandle();
      assert.ok(cancel);
      await fs.writeFile(stopHold, 'keep native child alive during cancellation');
      await fs.rm(openingHold);
      resumed = await waitForNewPid(initial);
      // Preserve the real button's action to exercise cancellation just after handoff.
      await cancel.evaluate((button) => (button as HTMLButtonElement).click());
      const until = Date.now() + 10000;
      while ((await pids()).has(resumed) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await pids(), initial);
      assert.doesNotThrow(
        () => process.kill(Number(resumed), 0),
        'fixture exited before ownership refusal'
      );
      await choose();
      await panel().locator('.resuming [data-act="retry-resume"]').waitFor({ timeout: 10000 });
      assert.match(
        await panel().locator('.card.resuming').innerText(),
        /still starting, running or stopping/
      );
      assert.deepEqual(await pids(), initial, 'a second native owner was revealed');
      await fs.rm(stopHold);
      const deadBy = Date.now() + 10000;
      while (Date.now() < deadBy) {
        try {
          process.kill(Number(resumed), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await panel().locator('[data-act="retry-resume"]').click();
      livePid = await waitForNewPid(initial);
      await endCard(livePid);
      livePid = '';
    } finally {
      await fs.rm(openingHold, { force: true });
      await fs.rm(stopHold, { force: true });
      for (const pid of await pids()) if (!initial.has(pid)) await endCard(pid);
    }
  });
  step(
    'cancels an immediately exiting Windows resume and admits exactly one replacement',
    async (t) => {
      if (testPlatform() !== 'win32') return t.skip('posix: Windows immediate native exit');
      const prompt = 'stopping resume owner';
      const initial = await pids();
      await openDraft();
      await pickDraftModel('Codex Test');
      await sendDraft(prompt);
      const seeded = await waitForNewPid(initial);
      await waitForIdle(seeded);
      const stored = await waitForThread(prompt);
      await endCard(seeded);
      const openingHold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
      const stopHold = path.join(homeDir(), '.codex', 'fake-stop.hold');
      const choose = async (): Promise<void> => {
        await panel().locator('[data-act="resume"]').first().click();
        await panel().locator('#picker .pit').first().waitFor({ timeout: 30000 });
        // Native conversation keys contain NUL; locate through the actual dataset.
        const index = await panel()
          .locator('#picker .pit')
          .evaluateAll(
            (nodes, id) =>
              nodes.findIndex((node) => (node as HTMLElement).dataset.key === `codex\0${id}`),
            stored.id
          );
        assert.ok(index >= 0);
        await panel().locator('#picker .pit').nth(index).click();
      };
      await fs.writeFile(openingHold, 'hold opening');
      let resumed = '';
      try {
        await choose();
        const cancel = await panel().locator('.resuming [data-startup="cancel"]').elementHandle();
        assert.ok(cancel);
        await fs.writeFile(stopHold, 'keep native child alive during cancellation');
        await fs.rm(openingHold);
        resumed = await waitForNewPid(initial);
        // Preserve the real button's action to exercise cancellation just after handoff.
        await cancel.evaluate((button) => (button as HTMLButtonElement).click());
        const until = Date.now() + 10000;
        while ((await pids()).has(resumed) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(await pids(), initial);
        const deadBy = Date.now() + 10000;
        let dead = false;
        while (Date.now() < deadBy) {
          try {
            process.kill(Number(resumed), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            dead = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(dead, 'cancelled native root stayed alive');
        await fs.rm(stopHold);
        await choose();
        livePid = await waitForNewPid(initial);
        assert.deepEqual(await pids(), new Set([...initial, livePid]));
        await endCard(livePid);
        livePid = '';
      } finally {
        await fs.rm(openingHold, { force: true });
        await fs.rm(stopHold, { force: true });
        for (const pid of await pids()) if (!initial.has(pid)) await endCard(pid);
      }
    }
  );

  step('reports a protocol opening failure with its reason and no session card', async () => {
    const refused = path.join(homeDir(), '.codex', 'fake-open-refuse');
    await fs.writeFile(refused, 'refuse thread/start');
    const initial = await pids();
    try {
      await openDraft();
      await pickDraftModel('Codex Test');
      await sendDraft('refused opening prompt');
      await panel().locator('[data-act="retry-held"]').waitFor({ timeout: 35_000 });
      assert.deepEqual(await pids(), initial);
      assert.match(
        (await panel().locator('#thread').textContent()) ?? '',
        /fake opening protocol failure/
      );
      await panel().locator('[data-act="dismiss-held"]').click();
      await panel().locator('#chat.empty.start #composer').waitFor();
    } finally {
      await fs.rm(refused, { force: true });
    }
  });

  /**
   * **No settings patch.** This case used to write `agentsview.cli` and
   * `agentsview.model` and press `+`. `agentsview.cli` is gone and the brand
   * rides the model row now; `squadron.model` stayed, but it only says what a
   * draft *opens* on, and the pick that decides a start is on the draft
   * (`TASK_done_draft_new_session.md` Step 8). Picking it here is
   * therefore the path a reader takes, and patching a setting would prove less
   * than it used to. With `grok.smoke.ts` this is the
   * whole of what proves a non-Claude New end to end, so the replacement lands
   * in the same change rather than after it.
   *
   * `Codex Test` is the display name `fake-codex.js`'s `model/list` answers
   * with — the catalog filters Codex rows through that call, so the menu names
   * what the fixture named.
   */
  step('starts, stores, resumes, and reveals one running Codex thread', async () => {
    const title = 'request pair';
    const words = 'codex smoke durable thread';
    const beforeNew = await pids();
    await openDraft();
    await pickDraftModel('Codex Test');
    await sendDraft(title);
    const firstPid = await waitForNewPid(beforeNew);
    const firstCard = panel().locator(`#cards .card[data-pid="${firstPid}"]`);
    await firstCard.locator('.bm.cx').waitFor({ timeout: 30_000 });

    // No second send: the draft's own first turn *is* `request pair`, posted by
    // the promotion the reveal made, and the dock is already on the card it
    // became. Sending again here would run the fixture's approval turn twice.
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    await launch.click();

    // Command approval, the first of the three request methods the 2026-09-05
    // pass saw on 0.153.2 (`cli_state/codex/protocol.md`). The label is the
    // request's own `reason`, and Deny carries no ellipsis because
    // `CommandExecutionApprovalDecision` has no message member — the panel
    // offers the drawer only where the union can carry words.
    const permission = panel().locator('#question .pdlg', { has: panel().locator('.pallow') });
    await permission.waitFor({ timeout: 10_000 });
    assert.equal(await permission.locator('.ptool').textContent(), 'Command');
    assert.equal(await permission.locator('.plabel').textContent(), 'Run the suite');
    assert.equal(await permission.locator('.pdeny').textContent(), 'Deny');
    assert.equal(await permission.locator('.palways').count(), 1);
    // The button says where the rule lands, not which member of the decision
    // union rides it — that half is the response body two lines down.
    assert.equal(
      await permission.locator('.palways').textContent(),
      'Always allow · this session only'
    );
    await permission.locator('.palways').click();
    await answered('command', '{"decision":"acceptForSession"}');

    const question = panel().locator('#question .pdlg', {
      has: panel().locator('.qtext', { hasText: 'Which route?' })
    });
    await question.waitFor({ timeout: 10_000 });
    // Reply instead stays hidden: `ToolRequestUserInputResponse` has no
    // feedback arm at any observed version.
    assert.equal(await question.locator('.qbail-t').count(), 0);
    // The note button is withheld until a pick is staged, so this has to be
    // read after the click, not before it.
    assert.equal(await question.locator('.qnote-add').count(), 0);
    await question.locator('.qopt .qopt-label', { hasText: 'Right' }).click();
    // `count()` does not auto-wait, so this reads the repaint the click causes
    // rather than racing it.
    await question.locator('.qnote-add').waitFor({ timeout: 10_000 });
    assert.equal(
      await question.locator('.qnote-add').count(),
      1,
      'a Codex question should offer a note once a pick is staged'
    );
    // Submit a note-bearing answer, not a bare pick: `user_note:` is the arm
    // the `canNote` flip exists for, and only this proves it survives the
    // child/host/dialog seam rather than just painting.
    await question.locator('.qnote-add').click();
    await question.locator('.qnote-in .ProseMirror').fill('scenic detour');
    await question.locator('.cta').click();
    await launch.waitFor({ state: 'hidden', timeout: 30_000 });
    await waitForIdle(firstPid);

    // Permissions, the second method, and the only one of the three the pass
    // captured as a frame log. Allow once sends the requested subset back at
    // turn scope — the body the live app-server accepted before completing the
    // turn. Always is offered because the request suggests a session grant.
    let dialog = await raise('permission request');
    assert.equal(await dialog.locator('.ptool').textContent(), 'Permissions');
    assert.equal(await dialog.locator('.plabel').textContent(), 'Use the shared output');
    assert.equal(await dialog.locator('.pdeny').textContent(), 'Deny');
    assert.equal(
      await dialog.locator('.palways').textContent(),
      'Always allow · this session only',
      'the permissions request should offer its session-scope grant'
    );
    await dialog.locator('.pallow').click();
    await answered(
      'permissions',
      '{"permissions":{"network":{"enabled":true},"fileSystem":{"write":["/tmp/codex-project/shared"]}},"scope":"turn"}'
    );
    await waitForIdle(firstPid);

    // Deny sends the empty subset. That is also what app-server fabricates for
    // a client that answers this request with a JSON-RPC error, and the model
    // cannot tell the two apart — so the decision a reader took is the only
    // thing that makes this body mean a refusal. The wrong turn is recorded in
    // `cli_state/codex/protocol.md`.
    dialog = await raise('permission request');
    await dialog.locator('.pdeny').click();
    await answered('permissions', '{"permissions":{},"scope":"turn"}');
    await waitForIdle(firstPid);

    // File change, the third. No Always: `FileChangeApprovalDecision` does
    // carry `acceptForSession`, but `fileRequest` returns `undefined` for the
    // always branch, so the panel offers two decisions. This asserts the
    // reader we wrote, and the protocol note beside it says the union is wider.
    dialog = await raise('patch request');
    assert.equal(await dialog.locator('.ptool').textContent(), 'Files');
    assert.equal(await dialog.locator('.plabel').textContent(), 'Apply the patch');
    assert.equal(await dialog.locator('.pdeny').textContent(), 'Deny');
    assert.equal(await dialog.locator('.palways').count(), 0);
    await dialog.locator('.pdeny').click();
    await answered('file', '{"decision":"decline"}');
    await waitForIdle(firstPid);

    dialog = await raise('patch request');
    await dialog.locator('.pallow').click();
    await answered('file', '{"decision":"accept"}');
    await waitForIdle(firstPid);

    await composer().fill(words);
    await composer().press('Enter');
    await waitForIdle(firstPid);

    const stored = await waitForThread(words);
    assert.equal(
      platform.paths.key(stored.cwd),
      platform.paths.key(path.join(homeDir(), 'project'))
    );
    await endCard(firstPid);

    const beforeResume = await pids();
    await panel().locator('[data-act="resume"]').first().click();
    const row = panel().locator('#picker .pit', { hasText: title });
    await row.waitFor({ timeout: 30_000 });
    assert.ok(await row.locator('.bm.cx').count(), 'the Codex row has no brand mark');
    const startHold = path.join(homeDir(), '.codex', 'fake-resume-start.hold');
    const historyHold = path.join(homeDir(), '.codex', 'fake-resume-history.hold');
    await fs.writeFile(startHold, '');
    await fs.writeFile(historyHold, '');
    try {
      await row.click();
      const pending = panel().locator('.card.resuming');
      await pending.waitFor({ timeout: 10_000 });
      assert.match((await pending.textContent()) ?? '', /Resuming/);
      assert.match((await pending.textContent()) ?? '', /request pair/);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.equal(
        await pending.locator('.spinner').count(),
        1,
        'startup feedback survived a poll'
      );
      assert.deepEqual(
        await pids(),
        beforeResume,
        'an unready session became a real card beside its pending resume'
      );
      await panel()
        .locator('body')
        .screenshot({
          path: path.join(process.env['SQUADRON_RUN'] ?? homeDir(), 'resume-startup.png')
        });
      await closeEditors();
      await openPanel();
      await panel().locator('[data-act="resume"]').first().click();
      const reopening = panel().locator('#picker .pit', { hasText: title });
      await reopening.waitFor({ timeout: 15_000 });
      await reopening.click();
      await pending.waitFor({ timeout: 10_000 });
      await fs.rm(startHold);
      livePid = await waitForNewPid(beforeResume);
      const loading = panel().locator('#thread .history-note');
      await loading.waitFor({ timeout: 10_000 });
      assert.match((await loading.textContent()) ?? '', /Loading conversation/);
      assert.equal(await panel().locator('.card.resuming').count(), 0);
      assert.doesNotMatch(
        (await panel().locator('#thread').textContent()) ?? '',
        /No conversation found/
      );
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.equal(await loading.locator('.spinner').count(), 1, 'history loading survived a poll');
      assert.equal((await pids()).size, beforeResume.size + 1, 'reopening started a second child');
      await panel()
        .locator('body')
        .screenshot({
          path: path.join(process.env['SQUADRON_RUN'] ?? homeDir(), 'resume-history.png')
        });
      await fs.rm(historyHold);
      await loading.waitFor({ state: 'detached', timeout: 15_000 });
      await panel()
        .locator('#thread .turn', { hasText: words })
        .first()
        .waitFor({ timeout: 15_000 });
    } finally {
      await fs.rm(startHold, { force: true });
      await fs.rm(historyHold, { force: true });
    }
    const resumed = panel().locator(`#cards .card[data-pid="${livePid}"]`);
    await resumed.locator('.bm.cx').waitFor({ timeout: 30_000 });
    await resumed.click();

    const beforeReveal = await pids();
    await panel().locator('[data-act="resume"]').first().click();
    const running = panel().locator('#picker .pit.running', { hasText: title });
    await running.waitFor({ timeout: 30_000 });
    assert.equal(await running.locator('.now').textContent(), 'running');
    await running.click();
    await resumed.waitFor({ timeout: 30_000 });
    assert.ok(
      await resumed.evaluate((node) => node.classList.contains('selected')),
      'choosing a running row did not reveal its existing card'
    );
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.deepEqual(await pids(), beforeReveal, 'a running resume started a competing child');

    // The durable id is the identity through both app-server processes. The
    // fake refuses unknown ids on thread/resume, so reaching this card already
    // proves the stored id was used; keep the assertion explicit for the
    // fixture contract readers depend on.
    assert.match(stored.id, /^thread-codex-/);

    await endCard(livePid);
    livePid = '';
    const beforeRetry = await pids();
    await panel().locator('[data-act="resume"]').first().click();
    const retryRow = panel().locator('#picker .pit', { hasText: title });
    await retryRow.waitFor({ timeout: 15_000 });
    const storeFile = path.join(homeDir(), '.codex', 'fake-threads.json');
    const savedStore = await fs.readFile(storeFile, 'utf8');
    try {
      await fs.writeFile(storeFile, '[]');
      await retryRow.click();
      const refused = panel().locator('.card.resuming.refused');
      await refused.waitFor({ timeout: 15_000 });
      assert.match((await refused.textContent()) ?? '', /could not be opened/);
      assert.equal(await refused.locator('.spinner').count(), 0);
      assert.deepEqual(await pids(), beforeRetry, 'a refused startup left a session card');
    } finally {
      await fs.writeFile(storeFile, savedStore);
    }
    await panel().locator('[data-act="retry-resume"]').click();
    livePid = await waitForNewPid(beforeRetry);
    await panel().locator('.card.resuming').waitFor({ state: 'detached', timeout: 15_000 });
    await panel().locator('#thread .turn', { hasText: words }).first().waitFor({ timeout: 15_000 });
  });

  // Same claim as `grok.smoke.ts`'s seed scenario; Codex mints at
  // `thread/start` where Grok mints at `session/new`. `host/sessions.ts` imports
  // `vscode`, so only a real host reaches it.
  step('seeds a spawned Codex run under the thread id, not the host mint', async () => {
    const runs = path.join(homeDir(), '.squadron', 'runs');
    const store = path.join(homeDir(), '.codex', 'fake-threads.json');
    await fs.mkdir(runs, { recursive: true });
    const beforeRuns = new Set(await fs.readdir(runs));
    const beforeThreads = new Set(
      await fs
        .readFile(store, 'utf8')
        .then((text) => (JSON.parse(text) as StoredThread[]).map((row) => row.id))
        .catch(() => [])
    );

    const skillDir = path.join(homeDir(), 'project', '.agents', 'skills', 'codex-preflight');
    const workflowFile = path.join(homeDir(), '.squadron', 'workflows', 'codex-preflight.json');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: codex-preflight\ndescription: smoke fixture\n---\nFixture.\n'
    );
    await fs.writeFile(
      workflowFile,
      JSON.stringify({
        id: 'codex-preflight',
        label: 'Codex preflight',
        steps: [{ id: 'one', label: 'One', uses: '/codex-preflight' }]
      })
    );

    // The gate on every prompt-carrying open (`host/extension.ts`), off in a
    // fresh smoke profile. Without it the window refuses before any of this
    // runs. The skill-install half of this flag is asserted once, in
    // `grok.smoke.ts`; there is nothing brand-specific in it to repeat.
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    let spawned = '';
    try {
      const started = await pids();
      await postSpawnRequest({
        cwd: path.join(homeDir(), 'project'),
        prompt: 'walk the smoke workflow',
        workflowId: 'codex-preflight',
        brand: 'codex',
        name: 'spawned codex run'
      });
      spawned = await waitForNewPid(started);
      await panel()
        .locator(`#cards .card[data-pid="${spawned}"] .bm.cx`)
        .waitFor({ timeout: 30_000 });

      // The card is drawn off the publish and the record off the send, so the
      // two do not land together — poll rather than read once.
      let fresh: string[] = [];
      for (let i = 0; i < 60 && fresh.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        fresh = (await fs.readdir(runs)).filter((name) => !beforeRuns.has(name));
      }

      const rows = JSON.parse(await fs.readFile(store, 'utf8')) as StoredThread[];
      const opened = rows.filter((row) => !beforeThreads.has(row.id));
      assert.equal(opened.length, 1, 'the spawn opened no single new Codex thread');
      const threadId = opened[0]?.id ?? '';

      assert.deepEqual(
        fresh,
        [`${threadId}.progress.json`],
        'the spawn seeded its run under a key the Codex child never answers to'
      );
      const seeded = JSON.parse(await fs.readFile(path.join(runs, fresh[0] ?? ''), 'utf8')) as {
        workflowId: string;
      };
      assert.equal(seeded.workflowId, 'codex-preflight');

      await fs.rm(path.join(runs, `${threadId}.progress.json`), { force: true });
    } finally {
      if (spawned) await endCard(spawned);
      await fs.rm(workflowFile, { force: true });
      await fs.rm(skillDir, { recursive: true, force: true });
      // Left on, the flag follows this profile into every later scenario, and
      // what it changes is whether a stray request file starts a session.
      await patchSettings({ 'squadron.orchestrators.enabled': false });
    }
  });
});
