import type { Reply } from '../../core/coordination/requests';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CDPSession, Locator } from 'playwright-core';
import * as platform from '../../core/platform';
import { listeners, processCwds } from '../../core/devservers/listeners';
import * as ownership from './ownership';
import { descendants, isShellProcess } from '../../core/scan';
import { projectSlug } from '../../core/claude/transcript';
import * as record from '../../core/record';
import { writeJson } from '../helpers';
import { ctx, homeDir, homeVars, onReset, panel } from './boot';
import { procStart } from './process_start';
import { shutDrawer } from './drawer_shut';

/**
 * The board readings more than one scenario file reaches for — the smoke
 * counterpart of what `openThread()` and `enter()` are to the jsdom harness.
 *
 * A helper only one file uses stays in that file. These are here because both
 * the owned-session sequence and the ticket drag start a child and then have to
 * tell "the board never drew it" from "the child was slow".
 */

/**
 * Drag the divider to a page x, and leave it where the drag settles.
 *
 * `hover()` and not `mouse.move()` to the box's own centre: the panel is a
 * frame inside a frame, and a raw move to page coordinates put the pointer
 * somewhere the divider's mousedown never fired — three drags in a row that
 * left `dock.style.width` exactly as they found it, and a ladder that read the
 * same board width at every rung. The locator routes into the frame.
 *
 * The pointer stays inside the panel: the drag listens on the webview's own
 * window, and one that leaves it never gets its mouseup — a wedged drag hangs
 * this process rather than failing it.
 *
 * `steps` is not decoration. The drag's cost is per frame and the thread is
 * taken out of the reflow for the length of it (`#thread.resizing`), so a
 * single-jump move would pose neither.
 */
/**
 * Press New, and get the draft it opens.
 *
 * New no longer starts anything — it opens a draft in the dock, and the first
 * send is what spawns (`TASK_done_draft_new_session.md`). Every scenario
 * that used to click this half and wait for a card now clicks, picks if it
 * cares which brand, types, and *then* waits.
 *
 * `cwd` names a group when the board has more than one; the first slot
 * otherwise, which is every scenario here.
 */
export async function openDraft(cwd?: string): Promise<void> {
  const escapedCwd =
    cwd === undefined
      ? undefined
      : await panel()
          .locator('body')
          .evaluate((_, value) => CSS.escape(value), cwd);
  const half =
    escapedCwd === undefined
      ? panel().locator('.half[data-act="open"]').first()
      : panel().locator(`.half[data-act="open"][data-cwd="${escapedCwd}"]`).first();
  await half.click();
  // The draft's own surface, which is how "the press did nothing" is told from
  // "the press opened something and the composer is slow".
  //
  // Diagnosed rather than merely awaited: a bare `waitFor` on a compound
  // selector fails as "not visible" whichever half is wrong, and the two halves
  // are different bugs — a dock still closed or still on the backlog, against a
  // draft that never opened at all.
  try {
    await panel().locator('#chat.empty.start #composer').waitFor({ timeout: 30_000 });
  } catch (why) {
    const seen = await panel()
      .locator('#chat')
      .evaluate((chat) => ({
        chat: chat.className,
        chatHidden: (chat as HTMLElement).hidden,
        body: document.body.className,
        dockWidth: document.getElementById('dock')?.getBoundingClientRect().width,
        tab: document.getElementById('board-sessions')?.className,
        // Which of the two halves of the compound selector is wrong: a draft
        // that never opened leaves no `drafting` slot, and one stuck sending
        // leaves a spinner where the composer should be.
        slots: [...document.querySelectorAll('.card.add')].map((n) => n.className),
        sending: !!document.querySelector('#thread .vacant .spinner'),
        vacant: document.querySelector('#thread .vacant h3')?.textContent,
        said: document.querySelector('#thread .vacant .said')?.textContent
      }));
    assert.fail(`New opened no draft — ${JSON.stringify(seen)} (${String(why)})`);
  }
}

/**
 * Pick a model on the open draft, by the name the menu draws.
 *
 * The list spans every brand this machine can run, which is what makes a
 * non-Claude New reachable without touching a setting: this is the pick the
 * gear's `Default model` used to be the only way to make, offered where the
 * prompt is typed and good for this one start.
 */
export async function pickDraftModel(name: string): Promise<void> {
  const pill = panel().locator('#ctools .fpill.model');
  const row = panel().locator('#ctools .fmenu .mitem', { hasText: name }).first();
  try {
    await openWithRow(pill, row);
  } catch (why) {
    // Named, because "no such row" and "the list never arrived" are different
    // bugs and the wait cannot tell them apart: the host filters a brand out
    // for a missing binary or a missing account, so an empty list is a machine
    // that cannot start that brand rather than a menu that is slow.
    const offered = await panel()
      .locator('#ctools .fmenu.mmodels')
      .evaluate((menu) => [...menu.querySelectorAll('.mitem .nm')].map((n) => n.textContent ?? ''));
    assert.fail(`no "${name}" row — the menu offers ${JSON.stringify(offered)} (${String(why)})`);
  }
  // The window pill is the control where the catalog states a window, and the
  // row itself is where it does not — `modelItems`' degraded draw, which a
  // fixture brand hits (`fake-codex.js`'s `model/list` names no window).
  const pills = row.locator('.wp');
  if ((await pills.count()) > 0) await pills.first().click();
  else await row.click();
  await pill.locator('.nm').filter({ hasText: name }).waitFor({ timeout: 10_000 });
}

/**
 * Open the draft's model menu until it shows `row`. The menu is filled when it
 * opens and then holds still (`heldOpen`), so a row that arrives later, such as
 * a brand just signed in, shows only after the menu is reopened.
 */
async function openWithRow(pill: Locator, row: Locator): Promise<void> {
  const menu = panel().locator('#ctools .fmenu.mmodels');
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (!(await menu.isVisible())) await pill.click();
    const left = deadline - Date.now();
    try {
      await row.waitFor({ timeout: Math.max(1, Math.min(2_000, left)) });
      return;
    } catch (why) {
      if (Date.now() >= deadline) throw why;
    }
    await pill.click();
    await menu.waitFor({ state: 'hidden', timeout: 5_000 });
  }
}

/**
 * The composer's editing root, inside `#input`, the prose editor's host: where
 * a fill, a press, a click and an IME land, and what holds focus.
 */
export function composer(): Locator {
  return panel().locator('#input .ProseMirror');
}

/**
 * The delivery text, a chip as its expansion. `Locator.inputValue` only reads
 * a textarea, so the editor is read through the hook its host carries.
 */
export async function composerValue(): Promise<string> {
  return proseValue(composer());
}

/**
 * A prose box's delivery text, read through the hook on the editor's host:
 * `root` is the editing root or the host itself.
 */
export async function proseValue(root: Locator): Promise<string> {
  return root.evaluate((el) => {
    const own = (el as { prose?: { value(): string } }).prose;
    if (own) return own.value();
    const host = el.closest('.prose') as { prose?: { value(): string } } | null;
    if (host?.prose) return host.prose.value();
    return (el as HTMLTextAreaElement).value;
  });
}

/** The open step's prompt in the workflow editor: its editing root. */
export function stepPrompt(scope: Locator = panel().locator('#wfeditor')): Locator {
  return scope.locator('.wcbody .ProseMirror');
}

/**
 * Empty the composer the way a reader does: Select All, then Backspace, both
 * through the editor's own keymap. `fill('')` on a contenteditable is a DOM
 * selection and a Delete, and the editor can put its own selection back over
 * the first before the second lands; one such clear left `@deliberately` in
 * the box for the next case.
 */
export async function clearComposer(): Promise<void> {
  const box = composer();
  await box.press('ControlOrMeta+a');
  await box.press('Backspace');
}

/**
 * The box as the reader sees it: its text, each chip as its label, where
 * `composerValue` has the chip's expansion.
 */
export async function composerShown(): Promise<string> {
  return (await composer().textContent()) ?? '';
}

/**
 * Chips in the composer. `kind` is a chip's kind class (`skill`, `session`,
 * `model`, `image`, `file`); `ref`, the dock's name for a session pill, is
 * read as `session`.
 */
export function composerPills(kind?: string): Locator {
  const suffix = kind ? `.${kind === 'ref' ? 'session' : kind}` : '';
  return panel().locator(`#input .pchip${suffix}`);
}

/**
 * Whether the composer holds focus, and whether the caret sits at the end of
 * its text. Both are document positions: the caret's, and the end of the last
 * textblock.
 */
export async function composerCaret(): Promise<{
  focused: boolean;
  caret: number | null;
  end: number;
}> {
  return composer().evaluate((root) => {
    type Node = { content?: Node[]; text?: string; type: string };
    const host = root.closest('.prose') as unknown as {
      prose: { snapshot(): Node; selection: { caret(): number | null } };
    };
    const size = (node: Node): number =>
      node.type === 'text'
        ? (node.text?.length ?? 0)
        : node.content
          ? 2 + node.content.reduce((sum, child) => sum + size(child), 0)
          : node.type === 'paragraph'
            ? 2
            : 1;
    const doc = host.prose.snapshot();
    return {
      focused: root.ownerDocument.activeElement === root,
      caret: host.prose.selection.caret(),
      end: size(doc) - 3
    };
  });
}

/**
 * Type the draft's first turn and send it, which is the act that spawns.
 *
 * The wait is the assertion: a draft is spent by the start it makes, because
 * promotion drops it the moment the reveal names it. One still on screen a
 * moment later is a reveal that never carried its id — and left where it is,
 * that draft is refocused by the *next* file's New, which is how one lost
 * reveal reads as three unrelated scenarios failing.
 */
export async function sendDraft(prompt: string): Promise<void> {
  const box = composer();
  await box.fill(prompt);
  await box.press('Enter');
  try {
    await panel().locator('#thread .vacant').waitFor({ state: 'detached', timeout: 30_000 });
  } catch (why) {
    const seen = await panel()
      .locator('#thread .vacant')
      .evaluate((block) => block.textContent);
    assert.fail(`the draft outlived its own start — it still says ${seen} (${String(why)})`);
  }
}

/**
 * The dock handed from a start to its session: the startup feedback gone and
 * the composer taking typing. A fast start holds the dock's paint for its
 * minimum display (`landed` in `chat.ts`) while the board does not, so a card
 * already idle or failed is no sign the dock has caught up.
 */
export async function dockReady(): Promise<void> {
  await panel().locator('#chat-startup').waitFor({ state: 'hidden', timeout: 30_000 });
  await panel().locator('#input[aria-disabled="false"]').waitFor({ timeout: 30_000 });
}

/** End a card, answering its webview confirmation when one is needed. */
export async function endCard(pid: string | number): Promise<void> {
  const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
  if ((await card.count()) === 0) return;
  await card.locator(`[data-key="${pid}:close"]`).click();
  const confirm = panel()
    .locator('#cscrim')
    .getByRole('button', { name: 'End session', exact: true });
  const outcome = await Promise.race([
    confirm.waitFor({ timeout: 10_000 }).then(() => 'confirm' as const),
    card.waitFor({ state: 'detached', timeout: 10_000 }).then(() => 'detached' as const)
  ]);
  if (outcome === 'detached') return;
  await confirm.click();
  await card.waitFor({ state: 'detached', timeout: 60_000 });
}

/** The whole gesture, for a scenario that does not care which model. */
export async function startFromDraft(prompt: string, model?: string): Promise<void> {
  await openDraft();
  if (model !== undefined) await pickDraftModel(model);
  await sendDraft(prompt);
}

export async function dragDivider(x: number, steps = 12): Promise<void> {
  const grip = await panel().locator('#divider').boundingBox();
  assert.ok(grip, 'the divider is not on screen');
  await panel().locator('#divider').hover();
  await ctx.page.mouse.down();
  await ctx.page.mouse.move(x, grip.y + grip.height / 2, { steps });
  await ctx.page.mouse.up();
}

/** Every pid the board is currently drawing a card for, read in one pass: a
 *  card that leaves between a listing and a per-card read would hold that read
 *  to its 30 s timeout. */
export async function pids(): Promise<Set<string>> {
  const found = await panel()
    .locator('#cards .card[data-pid]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.pid ?? ''));
  return new Set(found.filter(Boolean));
}

/** The pid of the first card to appear that was not there before. */
export async function waitForNewPid(before: Set<string>, ms = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    for (const pid of await pids()) {
      if (!before.has(pid)) return pid;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail('no new card appeared');
}

/** Poll the composer until it holds `text` — a hand-off arrives on a push. */
export async function composerHolds(text: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await composerValue();
    if (value.includes(text)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`the composer never held ${text}`);
}

/**
 * The bottom drawer, open — pressed only if it is not already.
 *
 * The bar's `⋯` opens it, and whether the sheet is still up when a case comes
 * back to it depends on which poll repainted the bar in between. A blind press
 * is a coin toss between opening and doing nothing, and the wrong side does not
 * read as a shut sheet: it reads, thirty seconds later, as the host never having
 * written the file.
 *
 * Only the standalone run ever lost that toss — a file run alone meets the bar
 * at a different point in the poll than the barrel does — which is exactly the
 * kind of order-dependence splitting the suite was meant to stop hiding.
 *
 * Asked by visibility, not by presence: `#bottomdrawer` is in the markup and shut with
 * the `hidden` attribute, so a `count()` here is always 1 and would skip every
 * press.
 */
export async function openWorkflowSheet(): Promise<void> {
  const sheet = panel().locator('#bottomdrawer');
  // The press is only a request. A poll that repaints the bar between Playwright
  // resolving the handle and clicking it leaves the press landing on a node
  // already replaced. So: press, give the bar a beat, and ask again.
  //
  // The beat is a plain sleep and not `getAnimations()`: the sheet rises on a
  // 180ms transition, and awaiting animations reads as the tighter spelling
  // right up until it is queried in the frame the sheet is unhidden, where the
  // list is still empty and the caller clicks a row mid-flight.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await sheet.isVisible()) {
      await new Promise((r) => setTimeout(r, 400));
      if (await sheet.isVisible()) return;
    }
    await panel().locator('#bottomhub .wmore').click({ timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail('the bottom drawer never opened');
}

/**
 * The sheet in Remote mode, opened by its own bar word from shut — the bar is
 * hidden while any sheet is up, so there is no press from another mode.
 * Returns once the rise has settled: the frame starts one height below the
 * board, and a box read mid-flight is not the one a reader sees.
 */
export async function openRemoteSheet(): Promise<void> {
  const sheet = panel().locator('#bottomdrawer.remote');
  if (!(await sheet.isVisible().catch(() => false))) {
    await panel().locator('#bottomhub .remote-tab').click({ timeout: 30_000 });
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
  }
  await sheet.evaluate(async (n) => {
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const shift = getComputedStyle(n).translate;
      if (shift === 'none' || shift === '0px 0px') return;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

/**
 * Run `body` with the sheet up, and shut the sheet however it ends.
 *
 * **Every case that opens the sheet owes itself this.** `#bottomdrawer-scrim` covers the
 * whole board, so a case that ended with the sheet still up does not fail once:
 * it fails every case after it in the file, each waiting out a 30s timeout on a
 * click the backdrop swallowed, and the whole barrel reads as a dead panel.
 * That is what a mis-tolerated assertion in one geometry case cost the first
 * time this suite met the sheet.
 *
 * A bare `try/finally` around a swallowing close is not the same thing, and the
 * difference is the whole reason this exists. Swallowing is right only while the
 * close is standing between a body that already failed and its error, which is
 * the one worth reporting. When the body **passed**, a close that failed is the
 * only news there is — and eaten, it hands the next twenty cases the exact
 * disease this was written to cure, with nothing naming where it started.
 *
 * Written as two paths rather than a `finally` that decides between them: a
 * `throw` inside `finally` is `no-unsafe-finally`, and the rule is right even
 * where the guard makes it safe. The failure path swallows, the passing path
 * does not.
 */
export async function onSheet<T>(body: () => Promise<T>): Promise<T> {
  let held: T;
  try {
    held = await body();
  } catch (err) {
    // The body's error outranks anything the close can say.
    await shut().catch(() => {});
    throw err;
  }
  await shut();
  return held;
}

/**
 * The close itself: idempotent, and it throws for its caller to weigh.
 *
 * A body that already called `close()` leaves the sheet in its exit. That is
 * not a second press. An open sheet gets one. Either way the hidden wait is
 * the assertion, and a passing body does not swallow it. The timings are on
 * `shutDrawer`.
 */
async function shut(): Promise<void> {
  await shutDrawer(panel().locator('#bottomdrawer'));
}

/** One row of the open sheet, by the name it draws. */
export function sheetRow(label: string) {
  return panel().locator('#bottomdrawer-body .wsrow', { hasText: label });
}

/** Press that row's own Edit, Duplicate or Delete. */
export async function pressRowAction(label: string, verb: 'Edit' | 'Duplicate' | 'Delete') {
  const button = sheetRow(label).locator(`.act[aria-label^="${verb} "]`);
  await button.waitFor({ timeout: 30_000 });
  await button.click({ timeout: 30_000 });
}

/**
 * Post the request file `squadron-spawn` posts, addressed to this window.
 *
 * The only way to reach a workflow armed **at spawn**: the panel's own `+` is
 * promptless (PRD §13, "never auto-send on session create"), and a workflow's
 * briefing rides the turn a prompt becomes. So a start that is already on step
 * 1 exists nowhere in the UI — it comes in over `core/coordination/requests.ts`, which the
 * host claims on its poll (`host/extension.ts`), and the smoke HOME is what
 * makes that reachable from here.
 *
 * The window id is read rather than passed: `boot.ts` runs one window, and a
 * request naming another is one nothing ever claims — a 30s wait for a card
 * that was never going to be started.
 */
export async function requestSpawn(body: {
  cwd: string;
  prompt: string;
  workflowId?: string;
  brand?: string;
  model?: string;
  name?: string;
  parentSessionId?: string;
  originSessionId?: string;
}): Promise<Reply> {
  const windows = path.join(ctx.home, '.squadron', 'windows');
  const claims = await fs.readdir(windows);
  const real: { id: string; folder?: string }[] = [];
  for (const name of claims) {
    const rec = JSON.parse(await fs.readFile(path.join(windows, name), 'utf8')) as {
      id: string;
      folder?: string;
    };
    // A claim with no `folder` owns no panel this scenario could address, so
    // asking it is a start that never happens.
    if (rec.folder !== undefined) real.push(rec);
  }
  assert.equal(real.length, 1, `expected one window with a folder, found ${real.length}`);
  const claim = real[0] as { id: string };

  const id = randomUUID();
  const dir = path.join(ctx.home, '.squadron', 'requests');
  await fs.mkdir(dir, { recursive: true });
  // `.request.json`, not `.json`: `claimRequests` reads by that suffix and a
  // plain `.json` is swept as debris rather than claimed.
  await fs.writeFile(
    path.join(dir, `${id}.request.json`),
    JSON.stringify({ kind: 'open', windowId: claim.id, ...body, id, createdAt: Date.now() })
  );

  // Wait on the reply rather than on the card. Every way this can go wrong —
  // the spawn flag off, a workflow that cannot run here, a cwd that is not a
  // directory — is a `{ ok: false, reason }` the window writes and nothing
  // else reads, so a caller watching only for a new card fails thirty seconds
  // later saying the board never drew one. It draws nothing because the start
  // was refused, in a sentence that was right there.
  const replyFile = path.join(dir, `${id}.reply.json`);
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let reply: Reply;
    try {
      reply = JSON.parse(await fs.readFile(replyFile, 'utf8')) as typeof reply;
    } catch {
      continue;
    }
    await fs.rm(replyFile, { force: true });
    return reply;
  }
  assert.fail('the window never answered the spawn request');
}

/**
 * Wait for a server chip to go green, and say what actually happened if it
 * does not.
 *
 * **Here because a blown wait on `.srv.up` is the least legible failure in the
 * suite.** Three things end the twenty seconds `awaitReady` owns (`host/runs.ts`)
 * — the probe answered, the twenty elapsed and the record says `failed · port
 * taken`, or the terminal went and `awaitReady` returned leaving nothing behind
 * — and only the *record* tells them apart. Before failure evidence copied
 * the smoke HOME, the barrel reported a 60s locator timeout with that record
 * discarded: the boot case failed intermittently on 2026-09-04 with no way to
 * say which exit fired. A failure now keeps HOME, but not a record swept earlier.
 *
 * Sampled rather than read once at the end, and that is the whole design.
 * `awaitReady`'s last word lands by 20s while this waits 60, and both writers
 * behind it are free to move on — `liveServers` sweeps a record of ours whose
 * terminal has gone (`reconcileServers`), and `readServers` drops anything past
 * `SERVER_STALE_MS`. A single read at the timeout can therefore find no record
 * at all for a failure that did write one. The trail keeps every transition with
 * the second it happened on, so `starting → failed · port taken` and
 * `starting → (no record)` read as the different faults they are.
 *
 * Costs one directory read and one board read per 500ms of waiting, so ~5 of
 * each on the passing path.
 */
export async function waitForServerUp(chip: Locator, port: string | null): Promise<void> {
  const trail: string[] = [];
  const started = Date.now();
  let sampling = true;
  const sample = (async () => {
    let last = '';
    while (sampling) {
      const line = `${await serverRecords()}   board: ${await serverChips()}`;
      if (line !== last) {
        trail.push(`${((Date.now() - started) / 1000).toFixed(1)}s  ${line}`);
        last = line;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  let failure: Error | undefined;
  try {
    await chip.waitFor({ timeout: 60_000 });
  } catch (err) {
    failure = err as Error;
  }
  sampling = false;
  await sample;
  if (!failure) return;
  assert.fail(
    [
      failure.message.split('\n')[0],
      '',
      'run records and board, as they moved:',
      ...(trail.length > 0 ? trail : ['  (nothing was ever written)']),
      '',
      await hostProcesses(),
      port ? await portHolder(Number(port)) : 'no port was picked'
    ].join('\n')
  );
}

/** Every run record on disk, one line each, sorted so two samples compare as text. */
async function serverRecords(): Promise<string> {
  const dir = path.join(ctx.home, '.squadron', 'servers');
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return '(no servers dir)';
  }
  const said: string[] = [];
  for (const name of names.sort()) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue; // written atomically, but the rename can still lose a read
    }
    let rec: {
      branch?: string;
      port?: number;
      status?: string;
      reason?: string;
      runnerId?: string;
    };
    try {
      rec = JSON.parse(raw) as typeof rec;
    } catch {
      said.push(`${name}=(unparseable)`);
      continue;
    }
    // No elapsed figure: the trail keeps only what *changed*, and a clock in
    // the line changes on every sample — which is 120 identical rows saying
    // `starting` and the transitions lost among them.
    said.push(
      `${rec.branch ?? '?'}/${rec.runnerId ?? '?'}:${rec.port ?? '-'} ${rec.status ?? '?'}` +
        `${rec.reason ? ` \u00b7 ${rec.reason}` : ''}`
    );
  }
  return said.length > 0 ? said.join(', ') : '(no record)';
}

/** What the board is painting for every server chip on it. */
async function serverChips(): Promise<string> {
  return panel()
    .locator('#cards .srv')
    .evaluateAll((nodes) =>
      nodes.length === 0
        ? '(none)'
        : nodes
            .map((node) =>
              [
                node.className,
                node.querySelector('.s')?.textContent ?? '',
                node.querySelector('.p')?.textContent ?? ''
              ]
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            )
            .join(' | ')
    )
    .catch(() => '(unreadable)');
}

/**
 * The host's terminals and the fixture servers under them, off the native table.
 *
 * The terminal list itself is not reachable from here — terminals are the
 * extension host's, and `app.evaluate` runs in the main process — so this asks
 * the process table instead: a created terminal is a shell descended from this
 * IDE, and `SERVE_CMD` running is the command having actually left `sendText`.
 * "No shell, no node" is `startServer`'s silent regression, which is the whole
 * reason the boot case is a smoke test at all.
 */
async function hostProcesses(): Promise<string> {
  const rows = await ownership.readProcesses();
  const commands = new Map<number, string>();
  const parents = new Map<number, number>();
  for (const row of rows.values()) {
    commands.set(row.pid, row.command ?? '');
    parents.set(row.pid, row.ppid);
  }

  const mine = descendants(ctx.hostPid, parents);
  const shells = mine.filter((pid) => isShellProcess(commands.get(pid) ?? ''));
  // One spawn for all of them, and the same flags the board's own attribution
  // uses. A shell's cwd is the only thing here that says *which* terminal it is.
  const cwds = await processCwds(shells);
  const servers = [...commands].flatMap(([pid, command]) =>
    command.includes("require('http')") ? [{ pid, command }] : []
  );
  return [
    `${mine.length} processes under the IDE, ${shells.length} of them shells:`,
    ...shells.map(
      (pid) => `    ${pid} ${cwds.get(pid) ?? '(cwd unknown)'}  ${commands.get(pid)?.slice(0, 90)}`
    ),
    `${servers.length} fixture servers on this machine:`,
    ...servers.map(({ pid, command }) => `    ${pid} ${command.slice(0, 90)}`)
  ].join('\n');
}

/** A request whose scenario requires an admitted session. */
export async function postSpawnRequest(body: Parameters<typeof requestSpawn>[0]): Promise<void> {
  const reply = await requestSpawn(body);
  assert.ok(reply.ok, `the window refused the spawn: ${reply.reason ?? '(no reason given)'}`);
}

/**
 * Who holds the port the picker offered, if anyone.
 *
 * `listeners()` rather than an `lsof` of our own, so this answers with the same
 * reading `servedFromHere` attributes a revival by: a record saying `port taken`
 * over a listener this names as ours is the probe having been wrong, which is a
 * different bug from the server never having bound.
 */
async function portHolder(port: number): Promise<string> {
  const heard = (await listeners()).get(port);
  return heard
    ? `on ${port}: pid ${heard.pid} ${heard.command ?? '?'} in ${heard.cwd ?? '(cwd unknown)'}`
    : `nothing is listening on ${port}`;
}

/**
 * The board's long-lived card: one owned session, started once and read by
 * every file that needs a card it did not spawn itself.
 *
 * **It used to be a fixture on disk** — a live `claude` pid, a
 * `sessions/<pid>.json` saying `entrypoint: 'sdk-cli'`, and no published record
 * anywhere. The board drew it because a piped session whose record never landed
 * was the degraded case row 53 deliberately kept. Row 71 drops that shape: the
 * board is the sessions this window started plus background ones, and nothing
 * else. So the card has to be a real child of this host.
 *
 * Three things the old fixture gave for free, and how each is kept:
 *
 * - **Its name.** Every locator here finds the card by the text `smoke session`.
 *   The stated-name store (`core/names.ts`) is one file per conversation and is
 *   written by whoever renames, so the fixture takes its name the same way a
 *   `squadron-rename` would — a fact another process wrote, which is what the
 *   pid file was.
 * - **Its transcript.** The fixture is resumed after its CLI history is
 *   planted. A fresh owned session never rereads injected history; recovery
 *   must acquire the fixture's turns before its pipe starts accepting sends.
 * - **Its liveness.** A real child, so nothing has to outlive a `sleep`.
 *
 * Memoised within a section (~3 s a child), and dropped by `onReset` below,
 * since every reset ends the child. The panel must already be open — each
 * file's `before` calls `openPanel()` first.
 */
export type Fixture = { pid: string; sessionId: string };

/** What the fixture's first turn says. None of `fake-cli.ts`'s scripted words
 *  are in it: a product string carrying one of those runs a turn nobody asked
 *  for (`src/test/AGENTS.md`). */
const FIXTURE_TURN = 'the fixture card reporting for duty';

/** The name every locator in this suite finds the fixture card by. */
export const FIXTURE_NAME = 'smoke session';

let fixture: Promise<Fixture> | undefined;
// A reset ends the child (the reload's `deactivate()`, or a new host), so the
// next section that asks spawns its own rather than finding a dead pid.
onReset(() => {
  fixture = undefined;
});

export function fixtureSession(): Promise<Fixture> {
  fixture ??= startFixture();
  return fixture;
}

async function startFixture(): Promise<Fixture> {
  const sessionId = randomUUID();
  const cwd = path.join(ctx.home, 'project');
  await adoptTranscript(sessionId);
  await nameFixture(sessionId);
  const file = path.join(ctx.home, '.squadron', 'transcripts', `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      JSON.stringify({ v: record.SCHEMA, sessionId, cwd, brand: 'claude' }),
      JSON.stringify({ role: 'user', text: FIXTURE_TURN, at: Date.now() })
    ].join('\n') + '\n'
  );
  const before = await pids();
  await panel().locator('[data-act="resume"]').first().click();
  await panel().locator('#picker .pit', { hasText: FIXTURE_NAME }).click();
  const pid = await waitForNewPid(before);
  assert.equal(await publishedSessionId(pid), sessionId);
  // The name is the assertion: until the poll has joined the store to the card
  // there is no card any other locator here can find.
  await panel()
    .locator(`#cards .card[data-pid="${pid}"] .name`)
    .filter({ hasText: FIXTURE_NAME })
    .waitFor({ timeout: 30_000 });
  await composer().fill(FIXTURE_TURN);
  await composer().press('Enter');
  await panel()
    .locator(`#cards .card[data-pid="${pid}"]`)
    .and(panel().locator('.idle.done'))
    .waitFor({ timeout: 30_000 });
  return { pid, sessionId };
}

/**
 * The id the host pre-assigned a child, read off the record it publishes.
 *
 * Polled rather than awaited once: the record is written by the extension host
 * on its own schedule, and the card is on the board a beat before it lands.
 *
 * Exported because a scenario that starts its own child needs the same answer:
 * this profile no longer runs exactly one owned session, so "the only file in
 * `transcripts/`" stopped being a way to name one.
 */
export async function publishedSessionId(pid: string, ms = 30_000): Promise<string> {
  const file = path.join(ctx.home, '.squadron', 'live', `${pid}.json`);
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
        session?: { sessionId?: string };
      };
      const id = raw.session?.sessionId;
      if (id) return id;
      last = 'a record with no sessionId';
    } catch (why) {
      last = String(why);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return assert.fail(`no published record for the fixture child ${pid} — ${last}`);
}

/**
 * File the boot transcript under the id the fixture will resume.
 *
 * Renamed and not copied. The file is this conversation's, and a leftover
 * `smoke.jsonl` that no session owns is a second row in every resume picker
 * opened on this directory — which is enough to push the row a scenario is
 * waiting for below the fold of a list it reads by visibility.
 */
async function adoptTranscript(sessionId: string): Promise<void> {
  const dir = path.join(
    ctx.home,
    '.claude',
    'projects',
    projectSlug(path.join(ctx.home, 'project'))
  );
  await fs.rename(path.join(dir, 'smoke.jsonl'), path.join(dir, `${sessionId}.jsonl`));
}

/** Name the conversation the way a rename from outside the panel would. */
async function nameFixture(sessionId: string): Promise<void> {
  const dir = path.join(ctx.home, '.squadron', 'names');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `claude.${sessionId}.json`),
    JSON.stringify({
      schema: 1,
      brand: 'claude',
      sessionId,
      name: FIXTURE_NAME,
      statedAt: Date.now()
    })
  );
}

/** Processes below the stock IDE launched by this smoke harness. */
export function hostPids(): Set<number> {
  const rows = execFileSync('/bin/ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const parent = new Map<number, number>();
  for (const row of rows.split('\n')) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) parent.set(pid, ppid);
  }
  const ours = new Set<number>([ctx.hostPid]);
  // Walk each pid up to a root or a known ancestor; the table is a few
  // hundred rows, so the cost is nothing and the shape needs no ordering.
  for (const pid of parent.keys()) {
    const seen: number[] = [];
    let at: number | undefined = pid;
    while (at && !ours.has(at) && !seen.includes(at)) {
      seen.push(at);
      at = parent.get(at);
    }
    if (at && ours.has(at)) for (const step of seen) ours.add(step);
  }
  return ours;
}

export type SleepAssertion = { pid: number; watched: number; seconds: number };

/** OS assertions identified by this host's watched pids, never a global count. */
export function hostSleepAssertions(ours: ReadonlySet<number> = hostPids()): SleepAssertion[] {
  const dump = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  return [
    ...dump.matchAll(
      /pid (\d+)\(caffeinate\):[^\n]*\n\s*Details: caffeinate asserting on behalf of Process ID (\d+) for (\d+) secs/g
    )
  ].flatMap((match) => {
    const watched = Number(match[2]);
    return ours.has(watched) ? [{ pid: Number(match[1]), watched, seconds: Number(match[3]) }] : [];
  });
}

export async function signCodex(way: 'in' | 'out'): Promise<void> {
  const lim = panel().locator('#nav button.lim');
  await lim.waitFor({ timeout: 30_000 });
  await lim.click();
  const menu = panel().locator('#nav-actions .smenu.accts:not([hidden])');
  await menu.waitFor({ state: 'visible', timeout: 10_000 });
  const row = menu.locator('.acct', { hasText: 'Codex' });
  const scrim = panel().locator('#ascrim');
  if (way === 'in') {
    await row.locator('button.act.in').click();
    await scrim.locator('.ucode').waitFor({ timeout: 15_000 });
    // What `fake-codex.js` watches for to complete its device-code flow.
    await fs.mkdir(path.join(ctx.home, '.codex'), { recursive: true });
    await fs.writeFile(path.join(ctx.home, '.codex', 'fake-login-complete'), '1');
  } else {
    await row.locator('button.act.out').click();
    await scrim.locator('.asfoot button.dgr', { hasText: 'Sign out of Codex' }).click();
  }
  await scrim.waitFor({ state: 'hidden', timeout: 30_000 });
  // Escape rather than a second press on the button: the popover is rebuilt on
  // the auth push a login forces, so the trigger the first click closed over is
  // not the one on screen — `openBarMenu`'s trap, one control along.
  await panel().locator('body').press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: 10_000 });
}

/** Send `text` and wait for the session to be running it. The fake CLI keys its
 *  whole script off this text — `ask`, `write`, `slow` — so this is also how a
 *  test picks which frames come back. */
export async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press('Enter');
}

/**
 * `squadron-end`, run the way an agent runs it: the copy `installShim` put in
 * `~/.squadron/bin`, under this suite's `HOME` so it reads the same claims,
 * published records and lineage the panel does.
 *
 * Never throws on a refusal — the exit code *is* the assertion, and `execFileSync`
 * would turn the case this exists for into an error before anything was read.
 */
export function end(args: string[]): { code: number; said: string } {
  const shim = platform.launchers.scriptPath(
    path.join(homeDir(), '.squadron', 'bin'),
    'squadron-end'
  );
  const run = spawnSync(process.execPath, [shim, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...homeVars() }
  });
  return { code: run.status ?? -1, said: `${run.stdout}${run.stderr}` };
}

/**
 * An IME composition in the focused box, and its commit — the one thing about
 * 注音 that only a host can answer, and the reason this pair is here rather than
 * in the jsdom suite.
 *
 * Driven over CDP because Playwright's keyboard cannot compose: `page.keyboard`
 * dispatches key events, while an IME's pending buffer is state inside Blink's
 * input-method controller that nothing but the IME protocol reaches.
 * `imeSetComposition` sets the pending text — `compositionstart`, then the
 * underlined draft in the box — and `insertText` commits it. Both address the
 * page's focused frame, so the caret must already be in the box; the panel is two
 * iframes deep, which is why neither takes a locator.
 *
 * **The commit fires `input` before `compositionend`**, and the fix under test
 * depends on that order: the flush on `compositionend` is what paints the CTA, so
 * the reverse order would paint from staged text one keystroke behind. Blink's
 * order is what the scenarios that drive this pair observe.
 *
 * One session for both halves — attaching a fresh one per keystroke is a
 * round-trip to prove nothing.
 */
let cdp: CDPSession | undefined;
onReset(() => {
  cdp = undefined;
});
const ime = async (): Promise<CDPSession> =>
  (cdp ??= await ctx.page.context().newCDPSession(ctx.page));

export async function compose(text: string): Promise<void> {
  const session = await ime();
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length
  });
}

export async function commitComposition(text: string): Promise<void> {
  const session = await ime();
  await session.send('Input.insertText', { text });
}

/** The dock's painted width. An accepted End must leave the divider here. */
export async function dockWidth(): Promise<number> {
  return panel()
    .locator('#dock')
    .evaluate((dock) => Math.round(dock.getBoundingClientRect().width));
}

/**
 * The opened folder's task draft. `text` is the unfinished task End has to
 * bring back; omitted when this End had no task waiting.
 */
export async function assertMainDraft(width: number, text?: string): Promise<void> {
  await panel().locator('#chat.empty.start #composer').waitFor({ timeout: 30_000 });
  assert.equal(await panel().locator('body.closed').count(), 0, 'End collapsed the shell');
  const project = await fs.realpath(path.join(homeDir(), 'project'));
  const cwd = await panel().locator('.half[data-act="open"]').first().getAttribute('data-cwd');
  assert.ok(cwd, 'New names no folder');
  assert.equal(await fs.realpath(cwd), project, 'End did not return to the opened folder');
  assert.match(
    (await panel().locator('#thread .vacant h3').textContent()) ?? '',
    /New session in [\s\S]*project/
  );
  assert.equal(await panel().locator('.card.selected').count(), 0, 'End left a session selected');
  assert.equal(await dockWidth(), width, 'End moved the divider');
  if (text !== undefined) assert.equal(await composerValue(), text);
}

export async function observeEnd(pid: string): Promise<() => Promise<void>> {
  const trace = await panel()
    .locator('#cards')
    .evaluateHandle((root, id) => {
      const phases: string[] = [];
      const sample = (): void => {
        const card = root.querySelector(`.card[data-pid="${id}"]`);
        const phase = !card
          ? 'gone'
          : card.classList.contains('closing')
            ? 'ending'
            : card.classList.contains('endstuck')
              ? 'failed'
              : 'normal';
        if (phases.at(-1) !== phase) phases.push(phase);
      };
      const observer = new MutationObserver(sample);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      });
      sample();
      setTimeout(() => observer.disconnect(), 30_000);
      return { phases, observer };
    }, pid);
  return async () => {
    // Keep observing beyond detachment to catch a stale gather restoring a card.
    await ctx.page.waitForTimeout(1_200);
    const phases = await trace.evaluate((captured) => {
      captured.observer.disconnect();
      return captured.phases;
    });
    await trace.dispose();
    const firstEnding = phases.indexOf('ending');
    assert.notEqual(firstEnding, -1, `Ending never painted: ${phases.join(', ')}`);
    assert.deepEqual(
      phases.slice(firstEnding),
      ['ending', 'gone'],
      'the card left Ending before native removal, or reappeared'
    );
  };
}

/**
 * A Claude session file the fake CLI does not write. `startedAt` stays the
 * caller's: the busy refusal joins lineage on `clicked + 1`, and `Date.now()`
 * there would refuse for the wrong reason.
 */
export function claudeTwinFile(pid: number | string): string {
  return path.join(homeDir(), '.claude', 'sessions', `${pid}.json`);
}

export async function plantClaudeTwin(
  pid: number,
  sessionId: string,
  name: string,
  startedAt: number
): Promise<void> {
  await writeJson(claudeTwinFile(pid), {
    pid,
    sessionId,
    cwd: path.join(homeDir(), 'project'),
    name,
    startedAt,
    procStart: await procStart(pid),
    kind: 'interactive',
    entrypoint: 'sdk-cli'
  });
}

/** Opens the servers sheet by the door and selects a worktree, then waits for the
 *  host's answer: the checking note gone from the starts. */
export async function openServers(branch: string): Promise<Locator> {
  const sheet = panel().locator('#runsheet');
  await panel().locator('#cards .sdoor').first().click({ timeout: 30_000 });
  await sheet.waitFor({ timeout: 30_000 });
  const name = panel().locator('.nm', { hasText: new RegExp(`^${branch}$`) });
  await sheet.locator('.srail .rstart', { has: name }).click({ timeout: 30_000 });
  await sheet.locator('.sshead b', { hasText: new RegExp(`^${branch}$`) }).waitFor();
  await sheet
    .locator('.sstarts .rnote', { hasText: 'Checking' })
    .waitFor({ state: 'detached', timeout: 30_000 });
  return sheet;
}

/** Top-left of the backdrop: the sheet covers its centre. */
export async function closeServers(): Promise<void> {
  await panel()
    .locator('#rscrim')
    .click({ position: { x: 8, y: 8 }, timeout: 5_000 })
    .catch(() => {});
  await panel()
    .locator('#runsheet')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => {});
}
