import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before } from 'node:test';
import { readInstalledText, skillPaths, skillTarget } from '../../core/skill_install';
import { adapter } from '../../core/adapter';
import { BRANDS } from '../../core/brands';
import { grokCwdSlug } from '../../core/grok/transcript';
import { SCHEMA } from '../../core/record';
import { fakeGrok, writeJson } from '../helpers';
import { ctx, homeDir, openPanel, panel, patchSettings, section, step } from './boot';
import {
  composer,
  endCard,
  openDraft,
  pickDraftModel,
  pids,
  postSpawnRequest,
  requestSpawn,
  sendDraft,
  waitForNewPid
} from './kit';

/**
 * The draft's pick, the picker, a permission, and a typed grok, against a real
 * host. jsdom cannot start a real CLI from a picked model, walk
 * `~/.grok/sessions` through `host/session_open.ts`, or join a click to a live
 * ACP child. Live
 * send/interrupt on a real `grok` stays a hand-check — this fixture is
 * `fake-acp.js`.
 *
 * Resume through permission share one spawn: a second Grok child would
 * double the wait to prove the same pipe. The card the picker starts is
 * the one later cases send on. The transcript case below seeds a competing
 * `chat_history.jsonl`; the other turns draw our own record.
 */

/** fake-acp.js `session/load` only accepts this id. Any other is FS_NOT_FOUND. */
const RESUME_ID = 'g1';
const RESUME_TITLE = 'Smoke Grok resume';

/** Our own record for that conversation — what the picker reads, and what the
 *  resumed session appends to. `core/record.ts` resolves this against the real
 *  home, so the path is spelled out here against the fixture's. */
const recordFile = () => path.join(homeDir(), '.squadron', 'transcripts', `${RESUME_ID}.jsonl`);

/** Pid of the card the picker started, handed to every case that shares it. */
let resumed = '';

const grokCard = () => panel().locator(`#cards .card[data-pid="${resumed}"]`);

async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press('Enter');
}

async function grokIdle(): Promise<void> {
  await grokCard().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
}

/** End a Grok session through the same webview confirmation as every brand. */
async function endSpoken(pid: string): Promise<void> {
  const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
  if ((await card.count()) === 0) return;
  await card.locator(`[data-key="${pid}:close"]`).click();
  const confirm = panel()
    .locator('#cscrim')
    .getByRole('button', { name: 'End session', exact: true });
  await confirm.waitFor({ timeout: 30_000 });
  await confirm.click();
  await card.waitFor({ state: 'detached', timeout: 60_000 });
}

section('Grok from the draft’s own pick, in the real IDE', () => {
  before(async () => {
    await openPanel();
    // Binary is boot.ts's fake-grok shim (login + fake-acp). A non-empty
    // auth.json is the start gate; boot already writes one.
    await writeJson(path.join(homeDir(), '.grok', 'auth.json'), { token: 'smoke' });
  });

  after(async () => {
    // Tidy-up only: the next section's reset restores `HOME`, which removes
    // both files, and ends `resumed` with the host's other children.
    const project = path.join(homeDir(), 'project');
    await fs.rm(path.join(homeDir(), '.grok', 'sessions', grokCwdSlug(project), RESUME_ID), {
      recursive: true,
      force: true
    });
    await fs.rm(recordFile(), { force: true });
    if (resumed) {
      await endSpoken(resumed);
    }
  });

  /**
   * A Grok model picked on the draft. The start must come up Grok from that
   * pick alone — and must not put a leftover Claude id on `-m`.
   *
   * **No settings patch.** This case used to write `agentsview.cli` and
   * `agentsview.model` and press `+`. `agentsview.cli` is gone and the brand
   * rides the model row now; `squadron.model` stayed, but it only says what a
   * draft *opens* on, and the pick that decides a start is on the draft
   * (`TASK_done_draft_new_session.md` Step 8). Picking it here is
   * therefore the path a reader takes, and patching a setting would prove less
   * than it used to. This is the only test in the
   * tree that proves a Grok New end to end, so the replacement lands in the
   * same change rather than after it.
   */
  step('exposes explicit native model rejection as a safe workflow pick refusal', async () => {
    const flag = path.join(homeDir(), '.grok', 'fake-model-refuse');
    await fs.mkdir(path.dirname(flag), { recursive: true });
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    const initial = await pids();
    try {
      await fs.writeFile(flag, 'reject offered model natively');
      const result = await requestSpawn({
        cwd: path.join(homeDir(), 'project'),
        prompt: 'must never be sent',
        brand: 'grok',
        model: 'grok-4.7'
      });
      assert.equal(result.ok, false);
      assert.equal(result.startupVersion, 1);
      assert.equal(result.notStarted, true);
      assert.equal(!result.ok && result.cause, 'pick');
      assert.deepEqual(await pids(), initial);
    } finally {
      await fs.rm(flag, { force: true });
      await patchSettings({ 'squadron.orchestrators.enabled': false });
    }
  });

  step('starts a Grok card from a Grok model picked on the draft', async () => {
    const before = await pids();
    await openDraft();
    await pickDraftModel('Grok 4.7');
    await sendDraft('say hello');
    const pid = await waitForNewPid(before);
    const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
    await card.locator('.bm.gr').waitFor({ timeout: 10_000 });
    assert.equal(await card.locator('.bm.cl').count(), 0, 'the new card drew Claude’s mark');
    // Idle first, then `endCard` rather than a bare close: a draft's start
    // carries a first turn, so this session has an exchange and `closePlan`
    // asks before ending it — see `endCard`.
    await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await endCard(pid);
  });

  /**
   * The picker used to walk Claude transcripts only, and a press without a
   * brand started the wrong CLI. There is no default model anywhere any more,
   * so a Grok card here is the row's own brand and nothing else.
   *
   * **Two fixtures, because two readers.** The picker reads our own transcript
   * index and nothing else since `4e57f742` — a conversation the panel never
   * drove is one it will not offer (`TASK_done_own_resume_index.md`, accepted
   * losses) — so the row comes from the record below. `summary.json` stays
   * because `readGrokChrome` (`core/grok/transcript.ts`) still reads it for the
   * resumed card's title and model. This case planted only the second one until
   * the index landed, and asked for a row that can no longer exist.
   */
  step('resumes a Grok conversation from the picker as a Grok card', async () => {
    const project = path.join(homeDir(), 'project');
    const dir = path.join(homeDir(), '.grok', 'sessions', grokCwdSlug(project), RESUME_ID);
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, 'summary.json'), {
      info: { id: RESUME_ID, cwd: project },
      generated_title: RESUME_TITLE,
      last_active_at: new Date().toISOString()
    });

    // The header keys the file (`header()` matches `sessionId` to the basename)
    // and carries the birth context the row is built from; the turn under it
    // supplies both the title `title()` takes — first `user` line, header
    // skipped — and the `at` that `summarise()` reports as last activity.
    // Without a turn there is no title and the conversation is dropped whole.
    await fs.mkdir(path.dirname(recordFile()), { recursive: true });
    await fs.writeFile(
      recordFile(),
      [
        JSON.stringify({ v: SCHEMA, sessionId: RESUME_ID, cwd: project, brand: 'grok' }),
        JSON.stringify({ role: 'user', text: RESUME_TITLE, at: Date.now() })
      ].join('\n') + '\n'
    );

    const before = await pids();
    await panel().locator('[data-act="resume"]').first().click();
    const row = panel().locator('#picker .pit', { hasText: RESUME_TITLE });
    await row.waitFor({ timeout: 30_000 });
    assert.ok(await row.locator('.bm.gr').count(), 'the Grok row has no brand mark');
    await row.click();

    resumed = await waitForNewPid(before);
    const card = grokCard();
    await card.locator('.bm.gr').waitFor({ timeout: 10_000 });
    assert.equal(await card.locator('.bm.cl').count(), 0, 'resume drew Claude’s mark');
  });

  /**
   * The dock reading **our own record** of that turn rather than the CLI's file
   * — roadmap row 54's Phase 3, end to end. Claude's sibling is in
   * `session.smoke.ts`.
   *
   * A vendor transcript added after recovery must not replace the owned
   * thread. The disk-only echo still witnesses the prompt we send next.
   *
   * Keyed on `g1.jsonl`, not "the only file", so a Claude record in the same
   * directory cannot pass for it.
   *
   * Leaves the card idle for the cases below.
   */
  step('draws the turn from the record it wrote, not from the CLI file', async () => {
    assert.ok(resumed, 'the picker case left no card');
    await grokCard().click();
    await composer().waitFor({ timeout: 10_000 });
    await grokIdle();

    const prompt = 'no-user-echo hullo grok';
    const vendor = path.join(
      homeDir(),
      '.grok',
      'sessions',
      grokCwdSlug(path.join(homeDir(), 'project')),
      RESUME_ID,
      'chat_history.jsonl'
    );
    await fs.writeFile(
      vendor,
      JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: `<user_query>${prompt}</user_query>` }],
        prompt_index: 0
      }) + '\n'
    );
    await ctx.page.waitForTimeout(3_500);
    assert.equal(await panel().locator('#thread .sourced').count(), 0);
    await send(prompt);
    await grokIdle();
    await panel().locator('#thread .sourced').waitFor({ state: 'detached', timeout: 30_000 });

    // `:not(.sending)` is load-bearing. Grok echoes the prompt as a
    // `.turn.user.sending` row until `stillSending` retires it against the
    // record (`ui/views.ts`). That echo has no clock (`rawTurn` in `chat.ts`);
    // idle is not enough — `session/prompt` resolving idles the card, and the
    // record append is a later tick. `.last()` of `.turn.user` is the echo for
    // as long as it lasts. Claude's sibling uses `:not(.queued)` for the same
    // reason against the drain's held row.
    const said = panel().locator('#thread .turn.user:not(.sending)', { hasText: prompt }).last();
    await said.waitFor({ timeout: 30_000 });
    // Matched rather than compared: a settled turn hangs a clock in `.who`
    // beside the label (`chat.ts` `clockSpan`). Two Claude cases broke in
    // Phase 2 comparing `.who` textContent to `'you'`.
    assert.match((await said.locator('.who').textContent()) ?? '', /^you/);
    assert.ok(
      await said.locator('.who .at').count(),
      'a settled record turn hangs a clock in .who'
    );

    // Idle and a drawn send precede the disk-only echo; wait for its line,
    // not the record the picker already seeded.
    const file = recordFile();
    let raw = '';
    for (let look = 0; look < 60; look++) {
      raw = await fs.readFile(file, 'utf8').catch(() => '');
      if (raw.includes(prompt)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(raw, 'the session should have written a record of its own');
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0]?.sessionId, RESUME_ID, 'the header names it');
    assert.ok(
      lines.some((line) => line.role === 'user' && line.text === prompt),
      `the turn this case sent: ${JSON.stringify(lines.slice(1, 4))}`
    );

    // Witness enrichment does not change the recovered thread's source.
    assert.equal(await panel().locator('#thread .sourced').count(), 0);
  });

  /**
   * A drained message is **never off screen**, across the whole handover from
   * the outbox to the thread.
   *
   * This used to wait for the `.turn.user.sending` placeholder by name. Phase 3
   * closed that window for Grok the same way Phase 2 did for Claude: the fake
   * echoes every prompt as `user_message_chunk` (`slow` included), the tee
   * mints the user turn from that echo, and `stillSending` retires the row on
   * the next push. Which of the two rows carries the words is a race this test
   * must not care about.
   *
   * So it asserts the property it was written for, **over the transition
   * rather than at one instant** — the same sampler `session.smoke.ts` uses.
   * `.turn.user` covers both holders (`rawTurn('turn user sending', …)` wears
   * both classes). Grok's `slow` is a thought chunk with no assistant prose, so
   * there is no `.turn.live` to wait on; `.busy` is the gate.
   *
   * Leaves the card open and idle: the ask case below is the next step in
   * this session's life.
   */
  step('holds a drained Grok message on screen until its transcript catches up', async () => {
    assert.ok(resumed, 'the picker case left no card');
    await grokCard().click();
    await composer().waitFor({ timeout: 10_000 });
    await grokIdle();

    // `slow` works and then waits for `session/cancel` — the turn the held
    // message queues behind. Idle first, so `.busy` is this send's edge.
    await send('slow');
    await grokCard().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });

    // `slow` again, and it is load-bearing: the row lives until the turn it
    // opened ends, so a held message that answers immediately would draw it for
    // a few milliseconds and Playwright would sample either side of it.
    await send('slow, and this one was held');
    const outbox = panel().locator('#thread .outbox');
    await outbox.waitFor({ timeout: 30_000 });

    const thread = panel().locator('#thread');
    await thread.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      view.__gap = 0;
      view.__seen = 0;
      view.__live = true;
      // Per frame rather than on a timer — see the same sampler in
      // `session.smoke.ts` for why.
      const sample = (): void => {
        if (!view.__live) return;
        view.__seen = (view.__seen as number) + 1;
        // `.qrow` is `webview/question.ts`'s and never an outbox row's — see the
        // same sampler in `session.smoke.ts` for why the second term is
        // `.turn.wait` rather than `.turn`.
        const held = [...node.querySelectorAll('.turn.user, .outbox .turn.wait')].some((el) =>
          (el.textContent ?? '').includes('this one was held')
        );
        if (!held) {
          view.__gap = (view.__gap as number) + 1;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await panel().locator('#chat-interrupt').click();
    await outbox.waitFor({ state: 'hidden', timeout: 30_000 });
    const held = panel().locator('#thread .turn.user', { hasText: 'this one was held' });
    await held.waitFor({ timeout: 30_000 });
    // The body, not the whole turn: `.who` is a box that now also hangs a
    // clock, and matching the turn's textContent would pass on the label.
    assert.match((await held.locator('.body').textContent()) ?? '', /this one was held/);

    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const watched = await thread.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      view.__live = false;
      return { gap: view.__gap as number, seen: view.__seen as number };
    });
    assert.ok(
      watched.seen > 100,
      `the sampler did not span the transition: ${watched.seen} frames`
    );
    assert.equal(watched.gap, 0, 'the message left the outbox with nothing holding it');

    await panel().locator('#chat-interrupt').click();
    await grokIdle();
  });

  /**
   * **A turn Grok started itself, in a real panel.** The hand-check Step 3 of
   * `TASK_done_grok_self_started_turn.md` asked for, automated.
   *
   * A background command finishing wakes Grok into a turn we never prompted.
   * On 1.0.5 that turn has one closer where ours has two, so a lost frame used
   * to latch the card busy forever and `canDrain` then refused every queued
   * message. Two claims here, and neither is reachable from a unit test
   * because both are about what the board and the dock actually draw:
   *
   * 1. The wake is drawn as the turn it is — `busy` while it streams, idle
   *    after. `## Notes` is explicit that hiding a wake is not the fix.
   * 2. A message the reader stages during the wake **goes out on its own**,
   *    with no Send-now click. That is the reported harm, and the reason the
   *    drain gate opens for a turn we did not start.
   *
   * `self-started-paced` holds the wake open ~2.5 s, because the panel polls
   * and the unit fixture's 60 ms wake would open and close inside one beat.
   * The fake queues the staged message behind the wake exactly as 1.0.5 does,
   * so its answer lands after the wake's close, not beside it.
   *
   * Leaves the card idle for the ask case below.
   */
  step('draws a turn Grok started itself, and drains through it', async () => {
    assert.ok(resumed, 'the picker case left no card');
    await grokCard().click();
    await composer().waitFor({ timeout: 10_000 });
    await grokIdle();

    // Our own turn answers, then the wake opens ~5 ms behind it. **Waiting on
    // `.busy` here would be a race** — it cannot tell our turn's edge from the
    // wake's, and the two are milliseconds apart. `woke` is the wake's own
    // word and nothing else on this wire says it, so the bubble carrying it is
    // proof the running turn is the one nobody prompted.
    await send('self-started-paced');
    const wokeTurn = panel().locator('#thread .turn', { hasText: 'woke' });
    await wokeTurn.first().waitFor({ timeout: 30_000 });

    // Claim 1a: a card nobody prompted is drawn busy while that turn streams.
    await grokCard().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });

    // Claim 2: staged mid-wake, and nothing is clicked after this line. The
    // settled record row (`:not(.sending)`) is the proof it reached the wire
    // and came back — the echo alone would only prove it was drawn.
    await send('and this went out by itself');
    const sent = panel()
      .locator('#thread .turn.user:not(.sending)', { hasText: 'and this went out by itself' })
      .last();
    await sent.waitFor({ timeout: 30_000 });
    assert.match((await sent.locator('.body').textContent()) ?? '', /and this went out by itself/);

    // Claim 1b: and it ends. No interrupt, no Send-now — the point is that
    // the card gets here without the reader doing anything.
    await grokIdle();
  });

  /**
   * An answered Grok ask, as the dock draws it off our record.
   *
   * `chat_history.jsonl` keeps a sentence; our record files a structured
   * `AnsweredAsk` on the call. The fake writes no CLI file, so pills on the
   * thread are the record having survived the fold — the same claim
   * `asks.smoke.ts` makes for Claude, against a fixture that file wrote.
   *
   * Two questions, no note arm (`canNote: false`). Leaves the card idle for
   * the permission case.
   */
  step('answers a Grok ask and the dock draws the structured record', async () => {
    assert.ok(resumed, 'the picker case left no card');
    await grokCard().click();
    await composer().waitFor({ timeout: 10_000 });
    await grokIdle();

    await send('ask');
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    assert.equal(await launch.locator('.at').textContent(), '1 of 2');
    await launch.click();

    const block = panel().locator('#question .qblock').first();
    await block.waitFor({ timeout: 10_000 });
    assert.equal(
      await block.locator('.qtext').first().textContent(),
      'Which route should we take?'
    );
    await panel().locator('#question .qopt .qopt-label', { hasText: 'Left' }).click();
    await panel().locator('#question .cta').click();

    const pace = panel().locator('#question .qtext', { hasText: 'Which pace?' });
    await pace.waitFor({ timeout: 10_000 });
    await panel().locator('#question .qopt .qopt-label', { hasText: 'Slow' }).click();
    await panel().locator('#question .cta').click();

    await launch.waitFor({ state: 'hidden', timeout: 30_000 });
    await grokIdle();

    const pills = panel().locator('#thread .tool .askpill');
    await pills.first().waitFor({ timeout: 30_000 });
    assert.equal(await pills.count(), 2);
    await pills.first().click();

    const dialog = panel().locator('#question .pdlg.replay');
    await dialog.waitFor({ timeout: 10_000 });
    assert.equal(
      await panel().locator('#question .qtext').textContent(),
      'Which route should we take?'
    );
    assert.equal(await panel().locator('#question .qhdr .cnt').textContent(), 'picked');
    assert.deepEqual(await panel().locator('#question .qopt.on .qopt-label').allTextContents(), [
      'Left'
    ]);
    assert.equal(await panel().locator('#question .cta').count(), 0);
    assert.equal(await panel().locator('#question textarea').count(), 0);

    await panel().locator('#question .qclose').click();
    await panel().locator('#ask').waitFor({ state: 'hidden', timeout: 10_000 });
  });

  /**
   * `--always-approve` still emits `session/request_permission`. The host has
   * to reply `{ outcome: { outcome: selected, optionId } }` or the tool hangs.
   * fake-acp scripts `perm` the same way fake-cli scripts `write`.
   */
  step('answers a Grok permission prompt and the card goes idle', async () => {
    assert.ok(resumed, 'the picker case left no card');
    await grokCard().click();
    await composer().waitFor({ timeout: 10_000 });
    await grokIdle();
    await send('perm');

    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    assert.equal(await launch.locator('.at').textContent(), 'permission');
    await launch.click();

    const dlg = panel().locator('#question .pdlg').first();
    await dlg.waitFor({ timeout: 10_000 });
    assert.equal(await dlg.locator('.ptool').textContent(), 'Write');
    assert.match((await dlg.locator('.plabel').textContent()) ?? '', /probe-write\.txt/);

    await dlg.locator('.pallow').first().click();
    await launch.waitFor({ state: 'hidden', timeout: 30_000 });
    await grokIdle();

    await endSpoken(resumed);
  });

  step('draws no card for a typed grok', async () => {
    const typed = await fakeGrok(60);
    try {
      await ctx.page.waitForTimeout(4000);
      assert.equal(
        await panel().locator(`#cards .card[data-pid="${typed.pid}"]`).count(),
        0,
        'a typed grok was drawn as a card'
      );
    } finally {
      typed.stop();
    }
  });
  step('shows the reconstruction notice when resume acquires vendor history', async () => {
    await endSpoken(resumed);
    resumed = '';
    const project = path.join(homeDir(), 'project');
    const title = 'Smoke reconstructed Grok history';
    const dir = path.join(homeDir(), '.grok', 'sessions', grokCwdSlug(project), RESUME_ID);
    await fs.writeFile(
      recordFile(),
      [
        JSON.stringify({ v: SCHEMA, sessionId: RESUME_ID, cwd: project, brand: 'grok' }),
        JSON.stringify({ role: 'user', text: title, at: Date.now() })
      ].join('\n') + '\n'
    );
    await fs.writeFile(
      path.join(dir, 'chat_history.jsonl'),
      [
        {
          type: 'user',
          content: [{ type: 'text', text: `<user_query>${title}</user_query>` }],
          prompt_index: 0
        },
        { type: 'assistant', content: [{ type: 'text', text: 'Recovered vendor reply' }] }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    const before = await pids();
    await panel().locator('[data-act="resume"]').first().click();
    const row = panel().locator('#picker .pit', { hasText: title });
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    resumed = await waitForNewPid(before);
    await grokCard().click();
    await panel().locator('#thread .sourced').waitFor({ timeout: 30_000 });
    await panel()
      .locator('#thread .turn.assistant', { hasText: 'Recovered vendor reply' })
      .waitFor({ timeout: 30_000 });
    await endSpoken(resumed);
    resumed = '';
  });

  /**
   * The run a spawn seeds is keyed by the id the **child** states, not by the
   * one the host minted for `--session-id`.
   *
   * Claude adopts that mint, so both ids are one string and the bug was
   * invisible. Grok takes no such flag and mints its own at ACP `session/new`
   * (`fake-acp.js` answers `g1`, as a real Grok answers a uuid of its own), so
   * a run filed under the mint is filed under a name nothing will ever claim:
   * the child drives the steps into a real file, and the board, reading
   * `readProgress(session.sessionId)`, finds nothing for the life of the run.
   *
   * Only smoke can hold both ends of this. The decision is in `host/sessions.ts`
   * (imports `vscode`, so no unit test reaches it), and what it has to agree
   * with is a file a *different* process wrote after stating its own id.
   */
  step('seeds a spawned Grok run under the id Grok states, not the host mint', async () => {
    const runs = path.join(homeDir(), '.squadron', 'runs');
    await fs.mkdir(runs, { recursive: true });
    const before = new Set(await fs.readdir(runs));

    // The gate on every prompt-carrying open (`host/extension.ts`), off by
    // default and so off in a fresh smoke profile. Without it the window
    // refuses before any of this is exercised.
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    try {
      // `reconcileSkill` (`host/extension.ts`) is the one seam of the skill
      // install with no test at all — it imports `vscode` — and the flag above
      // is the whole of what arms it. It rides here rather than in a scenario of
      // its own because this is the only place that flips the flag, and the
      // install lands in the fixture `HOME`, never the reader's own CLI dirs.
      // Every brand whose directory the fixture has gets its copy; one it
      // lacks is `no-cli-dir` by design. Written on the config change, so poll
      // rather than read once.
      const roots: string[] = [];
      for (const brand of BRANDS) {
        const root = adapter(brand)?.skillRoot(homeDir(), {});
        if (root && (await fs.stat(root).catch(() => undefined))) {
          roots.push(root);
        }
      }
      assert.ok(roots.length >= 2, `the fixture HOME has one CLI directory: ${roots.join(', ')}`);
      for (const root of roots) {
        const skillFile = skillPaths(...skillTarget(root)).file;
        let installed = 'absent';
        for (let i = 0; i < 40 && installed !== 'ours'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          installed = await fs.readFile(skillFile, 'utf8').then(
            (text) => readInstalledText(text).kind,
            () => 'absent'
          );
        }
        assert.equal(installed, 'ours', `the flag armed no skill install under ~/${root}`);
      }

      const started = await pids();
      await postSpawnRequest({
        cwd: path.join(homeDir(), 'project'),
        prompt: 'walk the smoke workflow',
        workflowId: 'smoke-flow',
        brand: 'grok',
        name: 'spawned grok run'
      });
      const pid = await waitForNewPid(started);
      const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
      await card.locator('.bm.gr').waitFor({ timeout: 30_000 });

      // The seed lands with the turn, so it is there by the time the card is —
      // but the card is drawn off the publish and the file off the send, so poll
      // rather than read once.
      let fresh: string[] = [];
      for (let i = 0; i < 60 && fresh.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        fresh = (await fs.readdir(runs)).filter((n) => !before.has(n));
      }
      assert.deepEqual(
        fresh,
        [`${RESUME_ID}.progress.json`],
        'the spawn seeded its run under a key the Grok child never answers to'
      );
      const seeded = JSON.parse(
        await fs.readFile(path.join(runs, `${RESUME_ID}.progress.json`), 'utf8')
      ) as { sessionId: string; workflowId: string };
      assert.equal(seeded.sessionId, RESUME_ID, 'the record names a session that is not the child');
      assert.equal(seeded.workflowId, 'smoke-flow');

      await fs.rm(path.join(runs, `${RESUME_ID}.progress.json`), { force: true });
      await endSpoken(pid);
    } finally {
      // Left on, the flag would follow this profile into every later
      // scenario — and the one it changes is whether a stray request file
      // starts a session, which is not a thing to leave armed behind us.
      await patchSettings({ 'squadron.orchestrators.enabled': false });
    }
  });
});
