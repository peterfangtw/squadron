import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import { before } from 'node:test';
import type { Locator } from 'playwright-core';
import { catalogFor } from '../../core/catalog';
import { writeJson, testPlatform } from '../helpers';
import {
  argvLogPath,
  clearOnboarding,
  ctx,
  homeDir,
  homeVars,
  openPanel,
  panel,
  patchSettings,
  PICKABLE,
  section,
  step
} from './boot';
import {
  hostSleepAssertions,
  dragDivider,
  endCard,
  FIXTURE_NAME,
  fixtureSession,
  publishedSessionId,
  onSheet,
  openDraft,
  pressRowAction,
  openWorkflowSheet,
  clearComposer,
  composer,
  composerCaret,
  composerPills,
  composerShown,
  composerValue,
  assertMainDraft,
  claudeTwinFile,
  commitComposition,
  compose,
  dockWidth,
  end,
  observeEnd,
  plantClaudeTwin,
  send,
  proseValue,
  sendDraft,
  sheetRow,
  startFromDraft,
  stepPrompt,
  waitForNewPid,
  pids
} from './kit';

/**
 * One owned session's whole life, against a real child on a real pipe: spawn →
 * dialog → answer → turn → the composer's clip → a mentioned workflow and the
 * observe drawer → the board editor → permission → interrupt → the busy refusal
 * an agent meets → end.
 *
 * The tests below are a sequence, not a set. They share one spawn deliberately
 * — a second child would double the slowest part of this file to prove nothing
 * new — so each leaves the session where the next expects it, ending idle so
 * the one after can send.
 *
 * That is also why the workflow cases live here rather than in a file of their
 * own: they are steps in this session's life, and splitting them out would buy
 * granularity with a second child.
 *
 * The composer editor, and the End, exit, pipe-error and family sections, each
 * start a session of their own. They are `composer_editor.smoke.ts` and
 * `session_end.smoke.ts`. The barrel loads those after this file.
 */

/**
 * The pid of the session these tests started, read off its card once and shared
 * from there.
 */
let owned = 0;

/**
 * A moment strictly before that session's own `startedAt`, taken at the click
 * that spawns it. `discover.ts` joins a lineage edge only when the session
 * started *after* the edge was written and within `LINEAGE_MATCH_MS` of it, so
 * the busy case below cannot date its fixture edge `Date.now()` — by the time
 * it runs, that is minutes past the session it is trying to claim.
 */
let clicked = 0;

/** That session's card, by pid, whatever the board has done with it since. */
const card = () => panel().locator(`#cards .card[data-pid="${owned}"]`);

type CapturedSendResult = {
  type: 'sendResult';
  pid: number;
  ok: boolean;
  operationId?: string;
  startedAt?: number;
};

async function assertPillGaps(root: Locator): Promise<void> {
  const gaps = await root.evaluate((node) => {
    const pills = node.querySelectorAll('.pchip');
    const first = pills[0];
    const last = pills[1];
    const before = first?.previousSibling;
    const after = last?.nextSibling;
    if (!first || !last || pills.length !== 2 || !before || !after) {
      throw new Error('expected two pills between prose text nodes');
    }
    const left = (before.textContent ?? '').search(/\S\s*$/);
    const right = (after.textContent ?? '').search(/\S/);
    if (left < 0 || right < 0) throw new Error('expected prose on both sides');
    const range = node.ownerDocument.createRange();
    range.setStart(before, left);
    range.setEnd(before, left + 1);
    const proseRight = range.getBoundingClientRect().right;
    range.setStart(after, right);
    range.setEnd(after, right + 1);
    return {
      before: first.getBoundingClientRect().left - proseRight,
      between: last.getBoundingClientRect().left - first.getBoundingClientRect().right,
      after: range.getBoundingClientRect().left - last.getBoundingClientRect().right
    };
  });
  console.log(`  pill gaps (${String(root)}): ${JSON.stringify(gaps)}`);
  for (const [side, gap] of Object.entries(gaps)) {
    assert.ok(gap > 0, `${side} pill gap must be positive, measured ${gap}px`);
  }
}

async function waitForSendResults(count: number): Promise<CapturedSendResult[]> {
  const body = panel().locator('body');
  for (let look = 0; look < 100; look++) {
    const results = await body.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      return (view.__sendResults ?? []) as CapturedSendResult[];
    });
    if (results.length >= count) return results;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`only ${count - 1} send results reached the webview`);
}

async function installSendCapture(): Promise<void> {
  await panel()
    .locator('body')
    .evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      (view.__sendObserver as MutationObserver | undefined)?.disconnect();
      const window = node.ownerDocument.defaultView;
      const previous = view.__sendListener as ((event: MessageEvent) => void) | undefined;
      if (window && previous) window.removeEventListener('message', previous);
      view.__sendResults = [];
      view.__sendOperations = [];
      const listener = (event: MessageEvent) => {
        const message = event.data as CapturedSendResult | undefined;
        if (message?.type === 'sendResult') {
          (view.__sendResults as CapturedSendResult[]).push(message);
        }
      };
      window?.addEventListener('message', listener);
      view.__sendListener = listener;
      const observer = new MutationObserver(() => {
        for (const turn of node.ownerDocument.querySelectorAll<HTMLElement>(
          '[data-operation-id]'
        )) {
          const id = turn.dataset.operationId;
          const seen = view.__sendOperations as string[];
          if (id && !seen.includes(id)) seen.push(id);
        }
      });
      observer.observe(node, { childList: true, subtree: true });
      view.__sendObserver = observer;
    });
}

async function waitForSendOperation(): Promise<string> {
  const body = panel().locator('body');
  for (let look = 0; look < 100; look++) {
    const operations = await body.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      return (view.__sendOperations ?? []) as string[];
    });
    if (operations[0]) return operations[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the originating send never exposed its operation id');
}

/** `squadron-step`, run the same way as `end` and for the same reason — the installed
 *  copy, under this suite's HOME, so it reads the run the panel just seeded. */
function runStep(args: string[]): { code: number; said: string } {
  const shim = platform.launchers.scriptPath(
    path.join(homeDir(), '.squadron', 'bin'),
    'squadron-step'
  );
  const run = spawnSync(process.execPath, [shim, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...homeVars() }
  });
  return { code: run.status ?? -1, said: `${run.stdout}${run.stderr}` };
}

/**
 * Poll until the published record reads `want` — the status word another
 * process gets, rather than the one this window has painted.
 *
 * The two are not the same clock and the gap is the whole hazard: the card
 * repaints off this window's own memory the moment a frame lands, and the
 * record is written by a publish that may be up to `PUBLISH_MS` behind it. A
 * case that gates on the paint and then asks a *separate* process what the
 * session is doing is reading a file from the previous turn.
 */
type PublishedSession = {
  status?: string;
  updatedAt?: number;
  model?: string;
  modelPick?: string;
};

async function waitSessionRecord(
  what: string,
  want: (session: PublishedSession) => boolean,
  ms = 30_000
): Promise<PublishedSession> {
  const file = path.join(homeDir(), '.squadron', 'live', `${owned}.json`);
  const start = Date.now();
  let saw: PublishedSession = {};
  while (Date.now() - start < ms) {
    const record = await fs.readFile(file, 'utf8').then(
      (raw) => JSON.parse(raw) as { session?: PublishedSession },
      () => undefined
    );
    saw = record?.session ?? {};
    if (want(saw)) return saw;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`published record never reached ${what}; last was ${JSON.stringify(saw)}`);
}

async function waitRecord(want: string, ms = 30_000): Promise<void> {
  await waitSessionRecord(want, (session) => session.status === want, ms);
}

/** Poll until a path exists or is gone — host writes are async off Save/Delete. */
async function waitPath(file: string, want: 'exists' | 'gone', ms = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const here = await fs.access(file).then(
      () => true,
      () => false
    );
    if (want === 'exists' ? here : !here) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${file} still ${want === 'exists' ? 'missing' : 'present'} after ${ms}ms`);
}

/** Board editor closed — `hidden` on `#wfeditor`, not a detached node. */
async function waitEditorClosed(): Promise<void> {
  await panel().locator('#wfeditor').waitFor({ state: 'hidden', timeout: 30_000 });
}

/**
 * Un-follow every workflow under the smoke HOME so `#wattach` paints Attach
 * again, without going through the panel — the state a later case needs, set
 * from outside it.
 *
 * Cancel *is* product now, and the case above drives it; this stays because the
 * two are different claims. Cancel asks whether the panel can end a run a
 * reader is looking at; this only wants the shelf empty for the editor cases,
 * and reaching for the product path to arrange a fixture would make those cases
 * fail for a reason that is not theirs.
 *
 * Unlinking the file *is* the un-follow: there is no run record with a status to
 * finish any more, and the progress file is the whole of what the strip paints
 * off (`core/workflows/progress.ts`). Same act the dismiss path performs.
 */
async function forgetFollowedWorkflows(): Promise<void> {
  const runsDir = path.join(ctx.home, '.squadron', 'runs');
  let names: string[];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.progress.json')) continue;
    await fs.rm(path.join(runsDir, name), { force: true });
  }
  // Poll finds nothing to follow and frees the shelf.
  await panel().locator('#wattach .fpill').waitFor({ timeout: 30_000 });
}

/**
 * The workflow this session is following under the smoke HOME, if any.
 *
 * One file per session, named for it, so this is a `readdir` for the test's
 * convenience rather than the shape the panel reads — the panel builds the path
 * from the session id it already has.
 */
async function followedWorkflow(): Promise<
  | {
      sessionId: string;
      workflowId: string;
      label: string;
      progressFile: string;
      steps: { id: string; label: string }[];
    }
  | undefined
> {
  const runsDir = path.join(ctx.home, '.squadron', 'runs');
  let names: string[];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith('.progress.json')) continue;
    const file = path.join(runsDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const progress = raw as {
      sessionId?: string;
      workflowId?: string;
      label?: string;
      steps?: { id?: string; label?: string }[];
    };
    if (typeof progress.sessionId !== 'string' || !progress.sessionId) continue;
    const steps = (progress.steps ?? [])
      .filter((s): s is { id: string; label: string } => !!s?.id && !!s?.label)
      .map((s) => ({ id: s.id, label: s.label }));
    return {
      sessionId: progress.sessionId,
      workflowId: progress.workflowId ?? '',
      label: progress.label ?? '',
      progressFile: file,
      steps
    };
  }
  return undefined;
}

/**
 * Overwrite progress so the drawer rail can show a working current — what the
 * agent itself would write, from outside the panel. Deliberately writes the
 * file *whole*, the way an agent regenerating JSON would, so nothing the panel
 * needs may live in a field only the panel knows to keep.
 *
 * `note` rides on every step, and is how the scroll case makes a three-step
 * rail taller than the drawer — notes are `pre-wrap`, so lines are height.
 */
async function writeProgressWorking(
  followed: NonNullable<Awaited<ReturnType<typeof followedWorkflow>>>,
  workingId: string,
  note?: string,
  completedIds: readonly string[] = []
): Promise<void> {
  await writeJson(followed.progressFile, {
    schema: 1,
    sessionId: followed.sessionId,
    workflowId: followed.workflowId,
    label: followed.label,
    // **Deliberately ancient.** A real agent edits statuses in place and leaves
    // `updatedAt` where the seed put it — which is before the arming message
    // reached the transcript. Writing a fresh stamp here would supply the one
    // field the agent never touches and hide a card that had gone silent, which
    // is exactly how this shipped broken once. The panel dates the file by its
    // mtime; if it ever reads this number again, the card assertions below fail.
    updatedAt: 1,
    kind: 'pipeline',
    steps: followed.steps.map((s) => ({
      id: s.id,
      label: s.label,
      status: completedIds.includes(s.id)
        ? 'completed'
        : s.id === workingId
          ? 'in_progress'
          : 'pending',
      ...(note === undefined ? {} : { note })
    }))
  });
}

/** Tall enough that the rail overflows whatever height the drawer got. */
const TALL_LINES = Array.from({ length: 40 }, (_, i) => `note line ${i + 1}`);
const TALL_NOTE = TALL_LINES.join('\n');
/**
 * The same note, one line's text changed — same line count on purpose. A note
 * that grew would move `scrollTop` legitimately: Chromium anchors the scroll to
 * what the reader is looking at, so content added above them shifts the number
 * without shifting the view, and the assertion could not tell that apart from
 * the rail being rebuilt.
 */
const TALL_NOTE_ALT = [...TALL_LINES.slice(0, -1), 'still working'].join('\n');

section('a session the panel owns, in the real IDE', () => {
  /** The shared fixture card, which this file's own child has to be told from.
   *  Assigned in `before` rather than read per site: it is one child for this
   *  section and its pid does not move. */
  let fixturePid = '';

  before(async () => {
    await openPanel();
    ({ pid: fixturePid } = await fixtureSession());
  });

  /**
   * The one thing the jsdom suite cannot reach: a dialog that arrived as a
   * frame off a real child's pipe rather than as a `PanelMessage` a test wrote.
   * Only an owned session can raise one — `core/claude/asks.ts` stopped reading the
   * hook's overlay, so a session in a terminal has no ask to show — which makes
   * this the start button, the spawn, the transport, the reducer and the ask
   * layer in one press.
   */
  step('raises a dialog from a session it started', async () => {
    // Again here: the layer can mount a beat after the workbench, so clearing it
    // once at startup is not enough to make the first click land.
    await clearOnboarding();

    clicked = Date.now();
    // New opens a draft, and the send is what spawns — the press posts nothing
    // at all now (`TASK_done_draft_new_session.md`). A workflow is armed only
    // when the reader picks one, so this New arrives with an empty slot and
    // later Attach cases still see one.
    await openDraft();
    assert.equal(await panel().locator('#wattach .wflow').count(), 0);
    // The prompt is what the card comes up named after, so it is a sentence
    // rather than a word.
    await sendDraft('smoke draft first turn');

    // The card that was not there before, by pid rather than by name — the CLI
    // names it off the cwd, and the two things on the board that are `.card`
    // without being a session (the start slot, the spinner) have no name to
    // exclude. `[data-pid]` is what a real card carries and neither of those
    // does, so this cannot resolve to a slot in the window before the spawn
    // lands and click the button a second time.
    const started = panel().locator(`#cards .card[data-pid]:not([data-pid="${fixturePid}"])`);
    await started.waitFor({ timeout: 60_000 });
    owned = Number(await started.getAttribute('data-pid'));
    assert.ok(owned > 0, 'the started card carries no pid');
    await started.click();

    // `ask` is the fake CLI's script for an AskUserQuestion control request.
    await send('ask');

    // The ask does not open itself. It raises the composer's launcher, naming
    // what is waiting, and the layer is behind that — so the launcher appearing
    // is the frame having landed, and the click is the reader's way in.
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    assert.equal(await launch.locator('.at').textContent(), '1 of 3');
    await launch.click();

    const block = panel().locator('#question .qblock').first();
    await block.waitFor({ timeout: 10_000 });
    assert.equal(await block.locator('.qtext').first().textContent(), 'Which fruit?');
    // The header carries the ask's own word plus the layer's hint ("pick one").
    assert.match((await block.locator('.qhdr').first().textContent()) ?? '', /^Fruit/);
    // The ask's two options, plus the `Other` row every ask on the pipe carries.
    assert.equal(await block.locator('.qopt').count(), 3);
    assert.equal(await block.locator('.qopt .qopt-label').first().textContent(), 'Banana');
  });

  /**
   * The other direction of the same seam, and the settle is the assertion.
   *
   * What the child received cannot be read back here: the fake CLI echoes every
   * control response as the session's own words, but those words are *live*
   * text, and it answers in about a millisecond — gone before the panel's next
   * poll, since a fixture that writes no transcript leaves nothing for the live
   * turn to be replaced by. `claude_session.test.ts` reads that echo, off the state
   * rather than off a paint, which is where it can be read at all.
   *
   * The card returning to idle is not a weaker claim than it looks. The fake
   * splices the answered id out of its open list and only emits `result` once
   * that list is empty, so a response the child could not match — wrong id,
   * wrong shape — leaves the turn open and the card where it was.
   */
  step('answers the dialog, and the child accepts the decision', async () => {
    // One question at a time, and the CTA reads `Next` until the last of them —
    // the picks are posted once, as one response, which is the shape the tool
    // takes. The CTA belongs to the layer rather than to the block it is under.
    for (let i = 0; i < 3; i++) {
      // Question two is answered with an IME, in the reader's own words, for the
      // one claim about 注音 that no headless layer can make: a composition is
      // state inside the renderer's input-method controller, and the `Other`
      // row's box repaints the whole dialog on the very `input` event the
      // composition raises. jsdom can only show the box surviving that repaint
      // (`question.test.ts`); this shows the composition surviving it, which is
      // the thing that was broken — the draft used to be dropped on the first
      // ㄓ and the box came back empty.
      if (i === 1) {
        await panel().locator('#question .qopt.other .qother-pick').click();
        const box = panel().locator('#question .qother-in');
        await box.waitFor({ timeout: 10_000 });
        // Picking the row is asking to type in it, so the caret is already
        // there — which is what the composition below needs, since CDP composes
        // into the focused frame's focused element rather than into a locator.
        await compose('ㄓㄨˋㄧㄣ');
        // The box is an editor, so its words are the editing root's text.
        assert.equal(
          await box.locator('.ProseMirror').textContent(),
          'ㄓㄨˋㄧㄣ',
          'the composition draft never reached the box, or the repaint ate it'
        );
        await commitComposition('注音');
        assert.equal(
          await panel().locator('#question .qother-in .ProseMirror').textContent(),
          '注音',
          'the committed characters are not what is staged'
        );
        await panel().locator('#question .cta').click();
        continue;
      }
      await panel().locator('#question .qblock .qopt').first().click();
      // A note on the first question only, for the one claim jsdom cannot make
      // about it: what a pointer actually gets. `.qnote-add` is a line of text
      // with padding, and padding is in the stylesheet while the box a press
      // lands on is padding plus the line — which only a browser knows.
      if (i === 0) {
        const add = panel().locator('#question .qnote-add').first();
        await add.waitFor({ timeout: 10_000 });
        const hit = await add.boundingBox();
        assert.ok(hit, 'the note trigger has a box');
        assert.ok(
          hit.height >= 24,
          `the note trigger is ${hit.height}px tall, under WCAG 2.2 SC 2.5.8's 24`
        );
        await add.click();
        const box = panel().locator('#question .qnote-in').first();
        await box.waitFor({ timeout: 10_000 });
        // The caret goes where the press asked for it, across a repaint the
        // host drove rather than the test.
        // The caret is in the editing root, inside the box it belongs to.
        assert.equal(
          await panel()
            .locator('#question')
            .evaluate(
              () =>
                document.activeElement?.closest('.prose')?.classList.contains('qnote-in') ?? false
            ),
          true,
          'the box that was asked for is the box the caret is in'
        );
        await box.locator('.ProseMirror').fill('but only for the staging deploy');
        // The pick is still the answer: a note has never gated this button.
        assert.match((await panel().locator('#question .cta').textContent()) ?? '', /^Next/);
      }
      await panel().locator('#question .cta').click();
    }

    // Nothing is left waiting, and the turn the ask blocked has ended.
    await panel().locator('#qlaunch').waitFor({ state: 'hidden', timeout: 30_000 });
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * A turn with nothing special about it, which is the case every other one
   * here is a departure from: text down the pipe, deltas back, a `result` that
   * settles the card. jsdom proves the composer posts `send`; `claude_session.test.ts`
   * proves the transport carries it; only this proves the host joins them.
   */
  step('carries a plain turn to the child and back', async () => {
    await installSendCapture();
    await send('hullo');
    // The reader's own words, echoed by the panel before any child has seen
    // them — this half is the composer's, not the pipe's.
    //
    // A drain baselines the working tree before it releases the turn
    // (`core/checkpoint.ts`), so for that window the message is still held —
    // 43ms warm and 566ms cold, and the last `.turn` matching the words is that
    // row for as long as it lasts. It is drawn as `.turn.user.sending` rather
    // than as a queued row now, because on an idle thread the only thing holding
    // it is our own drain; `.who` reads "you" either way, which is what this
    // case is about. `:not(.queued)` stays for the busy case, where a row really
    // is the agent's to take.
    const said = panel().locator('#thread .turn:not(.queued)', { hasText: 'hullo' }).last();
    await said.waitFor({ timeout: 30_000 });
    // Matched rather than compared, because `.who` is a box and not a word: a
    // turn carrying `at` hangs a clock in it beside the label (`chat.ts`'s
    // `clockSpan`). This used to read the composer's own echo row, which has no
    // stamp; since row 54's Phase 2 the same words are a real turn out of our
    // record, and a real turn is stamped. The label is what this case is about.
    assert.match((await said.locator('.who').textContent()) ?? '', /^you/);
    // And this half is the pipe's: nothing but a `result` off the child ends the
    // turn, so an idle card is the round trip having closed.
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    const reply = panel().locator('#thread .turn.assistant', { hasText: 'hullo' }).last();
    await reply.waitFor({ timeout: 30_000 });
    assert.equal(await reply.locator('.cut').count(), 0, 'an ordinary reply completed');
    const [accepted] = await waitForSendResults(1);
    assert.equal(accepted?.ok, true);
    assert.equal(accepted?.pid, owned);
    assert.ok(accepted.operationId, 'the accepted send lost its operation id at the host');
    assert.equal(accepted.operationId, await waitForSendOperation());
    assert.equal(typeof accepted.startedAt, 'number', 'the accepted send lost its incarnation');
  });

  step('keeps a message selection when the host copies after editing a draft', async () => {
    // A turn's rows are replaced once more as it settles, which takes a selection
    // with them. Measured 2026-11-02: that repaint landed 2 ms after the copy.
    await panel()
      .locator('#thread')
      .evaluate(
        (node) =>
          new Promise<void>((resolve) => {
            let quiet = setTimeout(resolve, 1_500);
            new MutationObserver(() => {
              clearTimeout(quiet);
              quiet = setTimeout(resolve, 1_500);
            }).observe(node, { subtree: true, childList: true });
          })
      );
    await composer().focus();
    const message = panel().locator('#thread .turn.user .body', { hasText: 'hullo' }).last();
    const position = await message.evaluate((node) => {
      const doc = node.ownerDocument;
      const texts = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text = texts.nextNode();
      while (text && !text.textContent?.includes('hullo')) text = texts.nextNode();
      if (!text) throw new Error('the message has no hullo text');
      const range = doc.createRange();
      range.selectNodeContents(text);
      const word = range.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { x: word.left + word.width / 2 - box.left, y: word.top + word.height / 2 - box.top };
    });
    await message.dblclick({ position });
    const thread = panel().locator('#thread');
    const selected = await thread.evaluate((node) => {
      const doc = node.ownerDocument;
      const text = doc.getSelection()?.toString() ?? '';
      delete (node as HTMLElement).dataset.copySelection;
      doc.addEventListener(
        'copy',
        (event) => {
          (node as HTMLElement).dataset.copySelection = doc.getSelection()?.toString() ?? '';
          // Observe the native command without replacing the system clipboard.
          event.preventDefault();
        },
        { once: true }
      );
      return { text, focused: doc.activeElement === node };
    });
    assert.ok(selected.text.trim(), 'the double click selected message text');
    assert.equal(selected.focused, true, 'message selection must hold focus outside the composer');
    await ctx.page.keyboard.press('ControlOrMeta+c');
    await panel().locator('#thread[data-copy-selection]').waitFor();
    assert.equal(await thread.getAttribute('data-copy-selection'), selected.text);
    assert.equal(
      await thread.evaluate((node) => node.ownerDocument.getSelection()?.toString()),
      selected.text
    );
  });

  step('returns the same correlation on a host refusal', async () => {
    await installSendCapture();
    await panel().locator('#wattach .fpill').click({ timeout: 30_000 });
    const menu = panel().locator('#wattach .fmenu');
    await menu.waitFor({ timeout: 10_000 });
    await menu.locator('.mitem', { hasText: 'smoke workflow' }).click({ timeout: 10_000 });
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });
    await composer().fill('correlation refusal');
    await panel().locator('#wattach .wflow.armed').waitFor({ timeout: 10_000 });

    const file = path.join(ctx.home, '.squadron', 'workflows', 'smoke-flow.json');
    const held = path.join(ctx.home, '.squadron', 'workflows', 'smoke-flow.held');
    await fs.rename(file, held);
    try {
      await composer().press('Enter');
      await panel()
        .locator('#blocked', { hasText: 'no such workflow' })
        .waitFor({ timeout: 30_000 });
      await composer().waitFor({ state: 'visible' });
      assert.equal(await composerValue(), 'correlation refusal');
      const [refused] = await waitForSendResults(1);
      assert.equal(refused?.ok, false);
      assert.equal(refused?.pid, owned);
      assert.ok(refused.operationId, 'the refused send lost its operation id at the host');
      assert.equal(refused.operationId, await waitForSendOperation());
      assert.equal(typeof refused.startedAt, 'number', 'the refused send lost its incarnation');
    } finally {
      await fs.rename(held, file).catch(() => undefined);
    }

    await clearComposer();
    const drop = panel().locator('#wattach .wflow.armed .drop');
    if ((await drop.count()) > 0) await drop.click({ timeout: 10_000 });
  });

  /**
   * The dock reading **our own record** of that turn rather than the CLI's file
   * — roadmap row 54's Phase 2, end to end.
   *
   * Nothing else can make this claim. The jsdom suite drives `ThreadView` and so
   * can only assert what the note does once the host has already decided; the
   * decision itself is `readSessionTranscript`, over a record file the extension
   * host wrote from a real child's frames and a `.jsonl` read off this profile's
   * disk. Both halves are `host/`, and the record does not exist until a real
   * session has said something.
   *
   * It is also the case worth guarding hardest: everything here degrades to the
   * fallback silently, so a rule that refused every record would look exactly
   * like a rule that worked and no unit test would notice.
   *
   * `fake-cli.ts` writes no transcript, so the CLI side is the "cannot be
   * located" branch — an empty id set, no evidence of a hole, and the record
   * draws. That is the shape a fresh conversation has before the CLI has
   * flushed anything, and it is the one this fixture can reach.
   *
   * Sends nothing, so the session is left idle exactly as the case above left
   * it — these are a sequence.
   */
  step('draws the turn from the record it wrote, not from the CLI file', async () => {
    const dir = path.join(homeDir(), '.squadron', 'transcripts');
    // **This session's own id, not "the only file there is".** That shortcut
    // held while the board's one other card was a fixture on disk; since row 71
    // the fixture is an owned session too, so `transcripts/` holds its record
    // beside this one and the first entry read is a coin toss — which failed as
    // this case reading the fixture's opening turn and reporting it as a
    // missing one.
    const id = await publishedSessionId(String(owned));
    const record = path.join(dir, `${id}.jsonl`);
    let written = false;
    for (let look = 0; look < 60 && !written; look++) {
      written = await fs.access(record).then(
        () => true,
        () => false
      );
      if (!written) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(written, 'the session should have written a record of its own');

    // Polled for the *line*, not just for the file. The record is appended off
    // the drain, which now waits on its turn checkpoint's baseline before it
    // releases the turn — so the case above can be green (the words are on
    // screen, the card is idle) tens of milliseconds before the append lands.
    // Measured: the read beat it by 25ms.
    let lines: Record<string, unknown>[] = [];
    for (let look = 0; look < 60; look++) {
      lines = (await fs.readFile(record, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (lines.some((line) => line.role === 'user' && line.text === 'hullo')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(lines[0]?.sessionId, id, 'the header names it');
    assert.ok(
      lines.some((line) => line.role === 'user' && line.text === 'hullo'),
      `the turn the case above sent: ${JSON.stringify(lines.slice(1, 4))}`
    );

    // And the reader is not being told the thread was reconstructed, because it
    // was not — this is what the panel watched arrive.
    await panel().locator('#thread .turn').first().waitFor({ timeout: 30_000 });
    assert.equal(await panel().locator('#thread .sourced').count(), 0);
  });

  /**
   * The composer's clip, end to end: host dialog → short token + inline pill in
   * the box → send expands the absolute path **in place** on the wire (echo
   * bubble), not a chip strip and not a path wall under the message.
   *
   * This is the seam and nothing else can prove it — the webview has no way to
   * name a file on this machine, so `showOpenDialog` is the whole feature and
   * jsdom can only assert the message that asks for it. Expand-on-send is the
   * second half: only a real host posts `send` and paints the echo from it.
   *
   * What it does not prove is the platform's own sheet: the profile sets
   * `files.simpleDialog.enable`, so the same API is answered by a quick input
   * inside the window. The native panel is out of Playwright's reach entirely
   * — a click on the clip without that setting hangs the suite rather than
   * failing it — and everything past the dialog's own chrome is shared.
   *
   * Leaves the session idle so the next case can arm a workflow.
   */
  /**
   * The card states the context window its session runs in — end to end,
   * through a real IDE, off a real launch line.
   *
   * **An owned card could not say this before.** `contextSize` came only from a
   * statusline dump, and the CLI writes one only in a terminal of fifteen rows
   * or more; a session spawned into the panel has no terminal at all
   * (`core/claude/context.ts`). So the figure now comes off `result.modelUsage`
   * on the wire, and this is the only proof that it crosses every hop between
   * there and the paint — reducer, `LiveState`, `toSession`, `views.ts`'s
   * hand-written map, `board_card.ts`.
   *
   * The footer keeps the actual window and usage visible at snug widths.
   * The fake CLI reports a 1M window in result.modelUsage, so this exercises
   * the full host path rather than supplying the card's reading directly.
   */
  step('keeps context usage and its window visible on snug cards', async () => {
    const context = card().locator('.foot .strip-reading');
    await context.waitFor({ state: 'attached', timeout: 30_000 });
    assert.match((await context.textContent()) ?? '', /% \/ 1M/);
    const sizes = await card().evaluate((node) => {
      const el = node as HTMLElement;
      const held = { width: el.style.width, justify: el.style.justifySelf };
      el.style.justifySelf = 'start';
      try {
        return [420, 200, 165].map((width) => {
          el.style.width = width + 'px';
          const reading = el.querySelector<HTMLElement>('.strip-reading')!;
          const footer = el.querySelector<HTMLElement>('.foot')!;
          const rect = reading.getBoundingClientRect();
          const strip = footer.getBoundingClientRect();
          return {
            width,
            visible: reading.getClientRects().length > 0,
            fits: rect.left >= strip.left && rect.right <= strip.right,
            noSpecsContext: !el.querySelector('.specs .s-ctx, .specs .s-sep-ctx')
          };
        });
      } finally {
        el.style.width = held.width;
        el.style.justifySelf = held.justify;
      }
    });
    for (const sample of sizes) {
      assert.ok(sample.visible, `context hidden at ${sample.width}px`);
      assert.ok(sample.fits, `context overflows at ${sample.width}px`);
      assert.ok(sample.noSpecsContext, 'context still occupies the specs row');
    }
  });

  step('inserts a short token from the host file dialog and expands it on send', async () => {
    // Resolved, because the host's is: `showOpenDialog` answers a `Uri` and
    // `fsPath` has already followed the symlink, so on macOS a `ctx.home` under
    // `/var/folders` comes back as `/private/var/folders`.
    const wanted = platform.paths.key(await fs.realpath(path.join(ctx.home, 'project', PICKABLE)));
    await composer().fill('see');
    await panel().locator('#fattach').click({ timeout: 30_000 });
    // The host's dialog, not ours: its quick input is in the workbench page,
    // outside both webview frames.
    const quick = ctx.page.locator('.quick-input-widget');
    await quick.waitFor({ timeout: 30_000 });
    // It opened on the session's own directory, which is the point of passing
    // one: the file is a row here without anything being typed.
    const row = quick.locator('.monaco-list-row', { hasText: PICKABLE });
    await row.waitFor({ timeout: 30_000 });
    // The dialog's own button, wearing the word the host asked for. Read before
    // the row is touched, because clicking a file row can be the accept itself
    // — and then this button is gone rather than merely unpressed.
    const accept = quick.locator('.quick-input-action .monaco-button').first();
    assert.equal((await accept.textContent())?.trim(), 'Attach');
    await row.click();
    // The row click is usually the accept itself, and then this button is not
    // merely gone — it is leaving, which reads as visible for an instant longer
    // than it is clickable. Guarding on `isVisible()` catches that instant and
    // then spends the suite's whole budget chasing a widget mid-teardown. So:
    // bounded, and swallowed. The dialog closing below is the assertion, and a
    // host that needs the button pressed still gets it pressed.
    await accept.click({ timeout: 5_000 }).catch(() => {});
    await quick.waitFor({ state: 'hidden', timeout: 30_000 });

    // A file chip in the box, its name on it and its path behind it. A file
    // alone is still a message, so Send is offered.
    const token = `@${PICKABLE}`;
    const box = composer();
    await box.waitFor({ timeout: 30_000 });
    const pill = composerPills('file').filter({ hasText: token });
    await pill.waitFor({ timeout: 10_000 });
    const selected = (await composerValue()).slice(4, -1);
    assert.equal(platform.paths.key(selected), wanted);
    assert.ok((await composerValue()).startsWith('see '));
    assert.ok((await composerValue()).endsWith(' '));
    assert.equal(await panel().locator('#send').isDisabled(), false);
    assert.equal(await panel().locator('#chips').count(), 0, 'no chip strip');
    await box.pressSequentially('now', { delay: 20 });

    // Expand-in-place on the wire: the echo is what `send` carried (absolute
    // path), not the name the chip shows in the box.
    await box.press('Enter');
    // Echo is the formatted delivery (`proseHtml`), class `turn user sending`
    // until the transcript catches up. The words are the expanded path.
    const said = panel().locator('#thread .turn.user', { hasText: selected }).last();
    await said.waitFor({ timeout: 30_000 });
    // Matched, not compared: a settled turn hangs a clock in `.who` beside the
    // label. Same reason as the case above.
    assert.match((await said.locator('.who').textContent()) ?? '', /^you/);
    const raw = ((await said.locator('.body').textContent()) ?? '').trim();
    assert.equal(raw, `see ${selected} now`, 'echo must contain the expanded path');
    assert.equal(await composerValue(), '');
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  // Conversion and send are `chat_refs.test.ts`'s; this is the ring's register
  // over the box's text, which jsdom cannot lay out. Pids no card has, so the
  // names are fixed and nothing is sent — and short, because the gap reading
  // needs one line and six-digit pids wrapped `now` in the dock's box.
  step('rings a pasted session reference where its name is typed', async () => {
    const box = composer();
    await box.fill('see @squadron[1][/t/a.jsonl] @squadron[2][/t/b.jsonl] now');
    await composerPills('ref').nth(1).waitFor({ timeout: 10_000 });
    assert.equal(await composerShown(), 'see @session 1 @session 2 now');
    await assertPillGaps(panel().locator('#input'));
    await clearComposer();
  });

  /**
   * The `@` menu's geometry, which is the whole reason this case is here rather
   * than in `chat_skills.test.ts`.
   *
   * jsdom lays nothing out: every rect is zero, so a menu that runs off the
   * panel reads there exactly like one that fits. Every other rule about this
   * surface — which rows, what a pick mints, what a send posts — is asserted in
   * the jsdom suite, and none of it is repeated here.
   *
   * Skill files are planted before activation by boot.ts, including the wide name.
   */
  step('keeps the skill menu inside the panel, however wide a name is', async () => {
    const box = composer();
    await box.waitFor({ timeout: 30_000 });
    await box.click();
    // Searched rather than a bare `@`: with models and sessions offered too, a
    // bare `@` lists kinds, and the wide row is a skill.
    await box.pressSequentially('@deliberately', { delay: 20 });
    const menu = panel().locator('#mentionmenu');
    await menu.waitFor({ state: 'visible', timeout: 30_000 });
    // The long name is drawn, so the box being measured is the wide one.
    await menu.locator('.mnrow', { hasText: 'deliberately-very-long-name' }).waitFor({
      timeout: 10_000
    });
    const menuBox = await menu.boundingBox();
    const panelBox = await panel().locator('body').boundingBox();
    const boxBox = await box.boundingBox();
    assert.ok(menuBox && panelBox && boxBox, 'no boxes to compare — the menu never laid out');
    assert.ok(
      menuBox.x >= panelBox.x - 1 && menuBox.x + menuBox.width <= panelBox.x + panelBox.width + 1,
      `the menu ran off the panel: menu ${menuBox.x}..${menuBox.x + menuBox.width}, ` +
        `panel ${panelBox.x}..${panelBox.x + panelBox.width}`
    );
    // **Vertical is the half that actually broke**, and the half a
    // `height > 0` assertion cannot see. Without `top: auto` the inherited
    // `.fmenu` rule put `top` a viewport-height down, `place()`'s inline
    // `bottom` over-constrained the box, and the menu solved to 8px of padding
    // below the fold — visible to Playwright, invisible to a person. Assert it
    // is on screen and sits above the box it belongs to.
    assert.ok(
      menuBox.height > 40,
      `the menu collapsed to ${menuBox.height}px — over-constrained, check top: auto`
    );
    assert.ok(
      menuBox.y >= panelBox.y - 1 && menuBox.y + menuBox.height <= boxBox.y + 1,
      `the menu is not above the composer: menu ${menuBox.y}..${menuBox.y + menuBox.height}, ` +
        `panel top ${panelBox.y}, box top ${boxBox.y}`
    );
    // Escape belongs to the menu while it is open — the interrupt only gets it
    // back once the menu has gone.
    await box.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });
    await clearComposer();
  });

  // Fourteen lines pass `#input`'s 10lh ceiling, so the box also scrolls: the
  // editing root's top is then above the visible box as well as above the caret.
  step('opens the @ menu against the caret line of a tall, scrolled box', async () => {
    const box = composer();
    await box.click();
    for (let line = 1; line < 14; line += 1) {
      await box.pressSequentially(`line ${line}`, { delay: 5 });
      await box.press('Shift+Enter');
    }
    await box.pressSequentially('@', { delay: 20 });
    const menu = panel().locator('#mentionmenu');
    await menu.waitFor({ state: 'visible', timeout: 30_000 });
    // One document, one coordinate space: the menu is portalled to this body.
    const read = await box.evaluate((root) => {
      const doc = root.ownerDocument;
      const range = doc.getSelection()?.getRangeAt(0).cloneRange();
      range?.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
      const caret = range?.getBoundingClientRect();
      const menuRect = doc.getElementById('mentionmenu')?.getBoundingClientRect();
      const host = root.closest('#input');
      return {
        caret: caret && { top: caret.top, bottom: caret.bottom },
        menu: menuRect && { bottom: menuRect.bottom, left: menuRect.left },
        rootLeft: root.getBoundingClientRect().left,
        scrolled: (host?.scrollTop ?? 0) > 0,
        hostTop: host?.getBoundingClientRect().top ?? 0
      };
    });
    assert.ok(read.caret && read.menu, 'no caret or menu rect to compare');
    assert.ok(read.scrolled, 'the box did not scroll — the fixture is not tall enough');
    assert.ok(
      read.caret.top > read.hostTop,
      `the caret line is not inside the box: caret ${read.caret.top}, box top ${read.hostTop}`
    );
    const gap = read.caret.top - read.menu.bottom;
    assert.ok(
      gap >= 0 && gap <= 8,
      `the menu is not against the caret line: menu bottom ${read.menu.bottom}, ` +
        `caret top ${read.caret.top} (gap ${gap}px)`
    );
    assert.ok(
      Math.abs(read.menu.left - read.rootLeft) <= 1,
      `the menu left the box's edge: menu ${read.menu.left}, box ${read.rootLeft}`
    );
    // Scrolled with the menu open: no edit or caret move, and the caret moves.
    const moved = await box.evaluate(async (root) => {
      const doc = root.ownerDocument;
      const host = root.closest('#input');
      if (host) host.scrollTop -= 2 * parseFloat(getComputedStyle(host).lineHeight);
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      const range = doc.getSelection()?.getRangeAt(0).cloneRange();
      range?.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
      return {
        caretTop: range?.getBoundingClientRect().top ?? 0,
        menuBottom: doc.getElementById('mentionmenu')?.getBoundingClientRect().bottom ?? 0
      };
    });
    assert.ok(moved.caretTop > read.caret.top + 10, 'the scroll did not move the caret');
    const after = moved.caretTop - moved.menuBottom;
    assert.ok(
      after >= 0 && after <= 8,
      `the menu stayed behind a scroll: menu bottom ${moved.menuBottom}, ` +
        `caret top ${moved.caretTop} (gap ${after}px)`
    );
    await box.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });
    await clearComposer();
  });

  // jsdom has the walk. This is the round trip — the wire says `the <name>
  // skill` and the turn that comes back draws `@<name>` — and the green that
  // `var(--av-green)` resolves to, which jsdom cannot compute.
  step('draws a sent skill as a green pill in the turn', async () => {
    const box = composer();
    await box.click();
    // Narrowed to skills: a bare `@` lists kinds once models are offered.
    await box.pressSequentially('@skill:', { delay: 20 });
    const menu = panel().locator('#mentionmenu');
    await menu.waitFor({ state: 'visible', timeout: 30_000 });
    await menu.locator('.mnrow').first().click();
    // The chip's label, which is what the dock's pill says; the box's value is
    // the skill's expansion.
    const token = ((await composerPills('skill').first().textContent()) ?? '').trim();
    await box.press('Enter');
    const pill = panel().locator('#thread .turn.user .sref.skill', { hasText: token }).last();
    await pill.waitFor({ timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    let paint = { skill: '', ref: '' };
    do {
      await pill.waitFor({ timeout: Math.max(1, deadline - Date.now()) });
      // Host echoes replace pills; query and sample the current node together.
      paint = await panel()
        .locator('#thread')
        .evaluate((thread, token) => {
          const node = Array.from(thread.querySelectorAll('.turn.user .sref.skill'))
            .filter((pill) => pill.textContent?.includes(token))
            .at(-1);
          if (!node?.isConnected) return { skill: '', ref: '' };
          const ref = node.ownerDocument.createElement('span');
          ref.className = 'sref';
          node.after(ref);
          const colours = {
            skill: getComputedStyle(node).backgroundColor,
            ref: getComputedStyle(ref).backgroundColor
          };
          ref.remove();
          return colours;
        }, token);
    } while ((!paint.skill || !paint.ref) && Date.now() < deadline);
    assert.ok(paint.skill && paint.ref, 'the current pills have no computed fill');
    assert.notEqual(paint.skill, 'rgba(0, 0, 0, 0)', 'the skill pill has no fill');
    assert.notEqual(paint.skill, paint.ref, 'the skill pill wears the session pill’s colour');
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * The model half of the `@` menu, through the host's own catalog: a narrowed
   * list, a pointer pick that lands the pill and offers its efforts, and an
   * effort that replaces it. jsdom has the behaviour; this has what it cannot
   * — the menu's box at a narrow dock, where focus goes after a pointer pick,
   * and the colour `var()` resolves to. Nothing is sent: a model pill asks the
   * session to spawn.
   */
  step('names a model and its effort from the @ menu at a narrow dock', async () => {
    const dock = panel().locator('#dock');
    const held = await dock.evaluate((node) => (node as HTMLElement).style.width);
    await dock.evaluate((node) => {
      (node as HTMLElement).style.width = '320px';
    });
    try {
      const box = composer();
      await clearComposer();
      await box.click();
      await box.pressSequentially('@model:', { delay: 20 });
      const menu = panel().locator('#mentionmenu');
      await menu.locator('.mncrumb').waitFor({ timeout: 30_000 });
      // A row that opens an effort step — the catalog decides which.
      const model = menu.locator('.mnrow:has(.go)').first();
      await model.waitFor({ timeout: 10_000 });
      await model.click();
      await menu.locator('.mncrumb', { hasText: 'effort' }).waitFor({ timeout: 10_000 });

      const placed = async (): Promise<void> => {
        const menuBox = await menu.boundingBox();
        const panelBox = await panel().locator('body').boundingBox();
        const boxBox = await box.boundingBox();
        assert.ok(menuBox && panelBox && boxBox, 'no boxes to compare — the menu never laid out');
        assert.ok(menuBox.height > 40, `the menu collapsed to ${menuBox.height}px`);
        assert.ok(
          menuBox.x >= panelBox.x - 1 &&
            menuBox.x + menuBox.width <= panelBox.x + panelBox.width + 1,
          `the menu ran off the panel: menu ${menuBox.x}..${menuBox.x + menuBox.width}`
        );
        assert.ok(
          menuBox.y >= panelBox.y - 1 && menuBox.y + menuBox.height <= boxBox.y + 1,
          `the menu is not above the composer: menu ${menuBox.y}..${menuBox.y + menuBox.height}, ` +
            `box top ${boxBox.y}`
        );
      };
      await placed();
      // A pointer pick is a press on a button: focus and caret have to stay in
      // the box, or the next keystroke goes nowhere and the effort step's caret
      // test fails at once.
      const where = await composerCaret();
      assert.ok(where.focused, 'a pointer pick took focus out of the box');
      assert.equal(where.caret, where.end, 'a pointer pick moved the caret off the pill');

      // The first explicit effort, after the default row.
      await menu.locator('.mnrow').nth(1).click();
      await menu.waitFor({ state: 'hidden', timeout: 10_000 });
      const pill = composerPills('model');
      await pill.waitFor({ timeout: 10_000 });
      assert.match((await pill.textContent()) ?? '', / · /, 'the effort did not replace the pill');

      const paint = await pill.evaluate((node) => {
        const fill = (cls: string): string => {
          const probe = node.ownerDocument.createElement('span');
          probe.className = cls;
          node.after(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        };
        return {
          model: getComputedStyle(node).backgroundColor,
          accents: ['pchip image', 'pchip file', 'pchip skill', 'pchip session'].map(fill)
        };
      });
      assert.notEqual(paint.model, 'rgba(0, 0, 0, 0)', 'the model pill has no fill');
      for (const accent of paint.accents) {
        assert.notEqual(paint.model, accent, 'the model pill wears another kind’s colour');
      }
      await clearComposer();
    } finally {
      await dock.evaluate((node, width) => {
        (node as HTMLElement).style.width = width;
      }, held);
    }
  });

  /**
   * Composer shelf observe + drawer: attach → live `.wflow` → chip opens
   * `#workflowoverviewdrawer` over the board with a snapshot rail; progress on disk updates
   * current on the poll. Host seam: `enrich`, run record, `readProgress` join.
   * jsdom covers paint rules alone; only here does a real host arm a run and
   * seat the chip.
   *
   * Ends by **cancelling** that run through the product — the × , the confirm,
   * and the three acts behind the answer — which is a host seam of its own: the
   * message, the interrupt and the stop line on the pipe, and the stamp on disk
   * the next poll reads back. `Keep` is pressed first, because a confirm that
   * cannot be declined is not one.
   *
   * Then unlinks whatever is left from outside the panel, so later cases open
   * `#wattach .fpill` without depending on the case above having passed.
   */
  step('seats live observe on the composer shelf after a mentioned workflow', async () => {
    // Upward is the half jsdom cannot see, and the half that has broken twice
    // at this end of the panel — an inherited `top: calc(100% + 5px)` puts a
    // menu a viewport below the fold (`#mentionmenu`, above). So this case
    // measures it: the menu sits above the pill and inside the panel.
    await panel().locator('#wattach .fpill').click({ timeout: 30_000 });
    const menu = panel().locator('#wattach .fmenu');
    await menu.waitFor({ timeout: 10_000 });
    const menuBox = await menu.boundingBox();
    const pillBox = await panel().locator('#wattach .fpill').boundingBox();
    const panelBox = await panel().locator('body').boundingBox();
    assert.ok(menuBox && pillBox && panelBox, 'no boxes to compare — the menu never laid out');
    assert.ok(menuBox.height > 40, `the menu collapsed to ${menuBox.height}px — check top: auto`);
    assert.ok(
      menuBox.y + menuBox.height <= pillBox.y + 1,
      `the menu is not above the pill: menu ${menuBox.y}..${menuBox.y + menuBox.height}, ` +
        `pill top ${pillBox.y}`
    );
    assert.ok(menuBox.y >= panelBox.y - 1, `the menu ran off the top: ${menuBox.y}`);
    // A press on the row is the apply, and the apply shuts the menu.
    await menu.locator('.mitem', { hasText: 'smoke workflow' }).click({ timeout: 10_000 });
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });

    // Armed alone — exclusive slot, no Attach sibling, no strip.
    const armed = panel().locator('#wattach .wflow.armed');
    await armed.waitFor({ timeout: 10_000 });
    assert.equal(await panel().locator('#wattach .fpill').count(), 0, 'armed alone');
    assert.equal(await armed.locator('.wedit').count(), 1);
    assert.equal(await panel().locator('#wfstrip').count(), 0);

    await send('and then stop');

    const said = panel().locator('#thread .turn', { hasText: 'smoke workflow' }).last();
    await said.waitFor({ timeout: 30_000 });
    const text = (await said.textContent()) ?? '';
    // The label and the id, and **no path**: step-blind delivery hands over the
    // file location nowhere, so the agent cannot read the chain ahead.
    assert.match(text, /Following the workflow "smoke workflow" \(smoke-flow\)/);
    assert.doesNotMatch(text, /workflows\/smoke-flow\.json/);
    assert.match(text, /and then stop/, 'the subject rides under the line, not instead of it');
    assert.match(
      text,
      /Progress for this workflow run is tracked at .*\.progress\.json/,
      'the briefing rides the same message'
    );

    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    assert.equal(await panel().locator('#wattach .wflow.armed').count(), 0, 'mention spent');

    // The mention is spent and the file is seeded, so the slot is spoken for
    // even though no step has moved: the chip reads a bare "Following X" with
    // no cursor, and Attach stays away. Going quiet here would offer a second
    // mention while the first was already on its way.
    const live = panel().locator('#wattach .wflow:not(.armed)');
    await live.waitFor({ timeout: 30_000 });
    assert.equal(await panel().locator('#wattach .fpill').count(), 0, 'no Attach while live');
    assert.match((await live.textContent()) ?? '', /smoke workflow/);
    assert.equal(
      await panel().locator('#wattach .wflow .sname').count(),
      0,
      'an untouched file names no current step'
    );

    // The seeded file the send left, named for the session rather than for a
    // run record — which is the whole of what the panel now reads.
    const followed = await followedWorkflow();
    assert.ok(followed, 'the send should have seeded a progress file under the smoke HOME');
    assert.ok(
      followed.steps.some((s) => s.id === 'two'),
      'fixture is multi-step'
    );
    assert.ok(
      followed.progressFile.endsWith(`${followed.sessionId}.progress.json`),
      'the file is keyed by the session id'
    );

    // The agent marks a step → poll joins the current step onto the chip.
    await writeProgressWorking(followed, 'two');
    await panel()
      .locator('#wattach .wflow.live .sname', { hasText: 'Two' })
      .waitFor({ timeout: 30_000 });
    assert.equal(await panel().locator('#wfstrip').count(), 0, 'no full-bleed strip');
    assert.ok(
      await panel().locator('#composer #wattach .wflow:not(.armed)').count(),
      'live chip seats inside #composer'
    );

    // Observe drawer (placement E): live chip toggles `#workflowoverviewdrawer`; rail lists
    // every step from the definition, not only the ones progress names.
    const drawer = panel().locator('#workflowoverviewdrawer');
    assert.ok(await drawer.isHidden(), 'drawer closed until the chip is clicked');
    await live.click();
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await live.getAttribute('aria-expanded'), 'true');
    assert.match((await drawer.locator('.rdhead .lbl').textContent()) ?? '', /smoke workflow/);
    const rows = drawer.locator('.strow');
    assert.equal(await rows.count(), 3, 'definition rail has every step');
    assert.deepEqual(await rows.locator('.slabel').allTextContents(), ['One', 'Two', 'Three']);
    // No Model A chrome on the host path either.
    assert.equal(await drawer.locator('.sbtn, .scta, .sacts').count(), 0);

    // The shut slides (taskhub H37), and what holds the box up for its length
    // is `display` being in the transition. A host that parsed `allow-discrete`
    // away would cut instead, with every assertion in this case still green —
    // so read the rule off the element rather than trusting the stylesheet.
    // Only a host computes a cascade at all; jsdom has no such answer to give.
    const motion = await drawer.evaluate((n) => ({
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      props: getComputedStyle(n).transitionProperty,
      behavior: getComputedStyle(n).getPropertyValue('transition-behavior')
    }));
    if (motion.reduce) {
      console.log('  ↳ reduced motion on this machine: the drawer exit rule is not asserted');
    } else {
      assert.match(motion.props, /display/, 'the exit transitions display');
      assert.match(motion.behavior, /allow-discrete/, 'and this host kept allow-discrete');
    }

    await drawer.locator('.strow.now .slabel', { hasText: 'Two' }).waitFor({ timeout: 30_000 });
    await panel()
      .locator('#wattach .wflow.live .sname', { hasText: 'Two' })
      .waitFor({ timeout: 30_000 });

    // The reversal, on the board rather than in the dock: an idle session
    // part-way through a pipeline reads `stalled` in the waiting hue,
    // where until 2026-08-04 it said nothing at all and a stopped run read
    // green `done`. One step completed, one working, one pending.
    await writeProgressWorking(followed, 'two', undefined, ['one']);
    // `attached`, not `visible`: the dock is open over the board for the whole
    // of this case, so the card is rendered and covered rather than absent.
    await card()
      .locator('.pill', { hasText: /^stalled$/ })
      .waitFor({ state: 'attached', timeout: 30_000 });
    assert.ok(
      await card().and(panel().locator('.stalled')).count(),
      'a partial pipeline wears the waiting hue, not the done one'
    );
    assert.equal(
      await card().and(panel().locator('.done')).count(),
      0,
      'a pipeline part-way through must not read green done'
    );
    const headerGeometry = await card().evaluate((node) => {
      const saved = node.getAttribute('style');
      node.style.setProperty('width', '180px');
      node.style.setProperty('box-sizing', 'border-box');
      try {
        const bounds = node.getBoundingClientRect();
        const status = node.querySelector('.pill')?.getBoundingClientRect();
        const actions = [...node.querySelectorAll<HTMLButtonElement>('.head button')];
        return {
          statusVisible: !!status && status.width > 0 && status.right <= bounds.right,
          actions: actions.map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              act: button.dataset.act,
              visible:
                rect.width > 0 &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                rect.bottom <= bounds.bottom
            };
          })
        };
      } finally {
        if (saved === null) node.removeAttribute('style');
        else node.setAttribute('style', saved);
      }
    });
    assert.ok(headerGeometry.statusVisible, 'narrow card hides its stalled status');
    assert.ok(
      headerGeometry.actions.some(({ act }) => act === 'close'),
      'no End action'
    );
    assert.ok(
      headerGeometry.actions.every(({ visible }) => visible),
      'narrow card clips an action'
    );
    await writeProgressWorking(followed, 'two');

    // Scroll retention across a poll. Only a host has layout, so only here can
    // a rail actually overflow: notes make it tall, the reader parks at the
    // bottom, and a repaint that rebuilt `.rdsteps` would fling them to the top
    // — which is what a live run did every few hundred ms before the morph.
    const rail = drawer.locator('.rdsteps');
    await writeProgressWorking(followed, 'two', TALL_NOTE);
    await drawer.locator('.strow.now .snote').waitFor({ timeout: 30_000 });
    await rail.evaluate((n) => {
      n.scrollTop = Math.floor(n.scrollHeight / 2);
    });
    const parked = await rail.evaluate((n) => n.scrollTop);
    assert.ok(parked > 0, 'the rail overflows, so there is a scroll to keep');
    // A repaint nobody asked for: same current step, same height, new words.
    await writeProgressWorking(followed, 'two', TALL_NOTE_ALT);
    await drawer
      .locator('.strow.now .snote', { hasText: 'still working' })
      .waitFor({ timeout: 30_000 });
    assert.equal(
      await rail.evaluate((n) => n.scrollTop),
      parked,
      'a poll that moved no cursor left the reader where they were'
    );
    await writeProgressWorking(followed, 'two');
    await drawer.locator('.strow.now .snote').waitFor({ state: 'detached', timeout: 30_000 });

    // Toggle shut; second click re-opens with the same rail still current.
    await live.click();
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 });
    assert.equal(await live.getAttribute('aria-expanded'), 'false');
    await live.click();
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await drawer.locator('.strow.now .slabel').textContent(), 'Two');
    await drawer.locator('.rdhead .x').click();
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 });

    // Click out on the board dismisses it (taskhub H37). Here rather than only
    // in jsdom because the claim is about hit-testing: the drawer is painted
    // over the board it is dismissed by, so the press has to land on `#cards`
    // and not on the rail covering it. The padding at the board's top-left
    // corner is the point that is board and nothing else — Playwright's own
    // actionability check fails loudly if the drawer has grown over it.
    await live.click();
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    await panel()
      .locator('#cards')
      .click({ position: { x: 4, y: 4 }, timeout: 10_000 });
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 });
    assert.equal(await live.getAttribute('aria-expanded'), 'false');

    // Free-text while live must not re-arm: no second enrich line on this send.
    await send('keep following');
    const free = panel().locator('#thread .turn', { hasText: 'keep following' }).last();
    await free.waitFor({ timeout: 30_000 });
    assert.doesNotMatch(
      (await free.textContent()) ?? '',
      /Following the workflow/,
      'live exclusivity: free-text send carried no workflowId'
    );
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await live.waitFor({ timeout: 10_000 });

    // Held queue + live: slow never ends, second send sits in the outbox; chip
    // stays in the composer (the whole reason the strip was retired).
    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    await live.waitFor({ timeout: 10_000 });
    await send('held while live');
    await panel().locator('#thread .outbox').waitFor({ timeout: 30_000 });
    assert.ok(
      await panel().locator('#composer #wattach .wflow:not(.armed)').count(),
      'chip stays in composer while the queue is held in the thread'
    );
    // Dismiss the held row so idle drain does not fire it after interrupt.
    await panel()
      .locator('#thread .outbox .qact', { hasText: 'Dismiss' })
      .click({ timeout: 10_000 });
    await panel().locator('#thread .outbox').waitFor({ state: 'hidden', timeout: 30_000 });
    await panel().locator('#chat-interrupt').click();
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });

    // Waiting tint while a permission is up — same `.wflow` seat.
    await send('write');
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    const waiting = panel().locator('#wattach .wflow.waiting');
    await waiting.waitFor({ timeout: 30_000 });
    assert.match((await waiting.textContent()) ?? '', /Waiting/);
    await launch.click();
    await panel().locator('#question .pdlg .pallow').first().click();
    await panel().locator('#qlaunch').waitFor({ state: 'hidden', timeout: 30_000 });
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });

    // Cancel, through the product: the × asks, and the answer is what acts.
    // Only a real host can join the three halves of it — the confirm's message,
    // the interrupt and the stop line on the pipe, and the stamp on disk that
    // the next poll reads back as a slot with nothing following in it.
    await panel().locator('#wattach .wcancel').click({ timeout: 10_000 });
    const ask = panel().locator('#wattach .wask');
    await ask.waitFor({ timeout: 10_000 });
    assert.match((await ask.textContent()) ?? '', /smoke workflow/);
    assert.equal(
      await panel().locator('#wattach .wflow').count(),
      0,
      'the question stands where the chip was'
    );

    // Keep first: a confirm that cannot be declined is not a confirm.
    await panel().locator('#wattach .act', { hasText: 'Keep' }).click({ timeout: 10_000 });
    await panel().locator('#wattach .wflow').waitFor({ timeout: 10_000 });
    assert.ok(await followedWorkflow(), 'Keep wrote nothing to disk');

    await panel().locator('#wattach .wcancel').click({ timeout: 10_000 });
    await panel().locator('#wattach .act', { hasText: 'Cancel run' }).click({ timeout: 10_000 });

    // The chip goes because the host stamped the file and the poll read it
    // back — not because the webview painted what it hoped for.
    await panel().locator('#wattach .fpill').waitFor({ timeout: 30_000 });
    assert.equal(await panel().locator('#wattach .wflow').count(), 0);
    const stamped = await followedWorkflow();
    assert.ok(stamped, 'a cancel stamps the run rather than unlinking it');
    const onDisk = JSON.parse(await fs.readFile(stamped.progressFile, 'utf8')) as {
      cancelledAt?: number;
      steps?: { status?: string }[];
    };
    assert.equal(typeof onDisk.cancelledAt, 'number', 'the mark the agent must not lose');
    assert.ok(
      (onDisk.steps ?? []).some((s) => s.status !== 'pending'),
      'the steps stand where they stood — a cancel is not a step outcome'
    );
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });

    // Free the shelf for later Attach / editor cases, from outside the panel.
    await forgetFollowedWorkflows();
    assert.equal(await panel().locator('#wattach .wflow').count(), 0);
    assert.ok(
      await panel().locator('#wattach .fpill').count(),
      'Attach returns when provenance ends'
    );

    // Second start on the same session: the menu still lists both workflows —
    // one just ran and is not spent — so pick the other, live observe its label,
    // and free the shelf again for the editor cases.
    await panel().locator('#wattach .fpill').click({ timeout: 10_000 });
    const again = panel().locator('#wattach .fmenu');
    await again.waitFor({ timeout: 10_000 });
    assert.equal(await again.locator('.mitem').count(), 2, 'both workflows still listed');
    await again.locator('.mitem', { hasText: 'smoke alt' }).click({ timeout: 10_000 });
    await again.waitFor({ state: 'hidden', timeout: 10_000 });
    await panel().locator('#wattach .wflow.armed').waitFor({ timeout: 10_000 });
    assert.match((await panel().locator('#wattach .wflow.armed').textContent()) ?? '', /smoke alt/);

    await send('second chain');
    const altSaid = panel().locator('#thread .turn', { hasText: 'smoke alt' }).last();
    await altSaid.waitFor({ timeout: 30_000 });
    assert.match(
      (await altSaid.textContent()) ?? '',
      /Following the workflow "smoke alt" \(smoke-alt\)/
    );
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });

    // The second mention overwrote the same path — one file per session, so the
    // older workflow is gone rather than retired.
    const alt = await followedWorkflow();
    assert.ok(alt, 'the second mention re-seeded the same session-keyed file');
    const altLive = panel().locator('#wattach .wflow:not(.armed)');
    await altLive.waitFor({ timeout: 30_000 });
    assert.match((await altLive.textContent()) ?? '', /smoke alt/);

    await forgetFollowedWorkflows();
    assert.ok(
      await panel().locator('#wattach .fpill').count(),
      'Attach returns after the second run is finished'
    );
  });

  /**
   * The pull itself: the shim an agent runs serves one step, and the panel
   * follows the cursor it wrote.
   *
   * Everything else about step-blind delivery is unit-tested — `serveNext` and
   * `completeCurrent` in `progress_execution.test.ts`, `stepPlan` in `step_cli.test.ts`,
   * the two re-read guards in `step_race.test.ts`. None of them run the file
   * `installShim` copied. A verb that reached `src/` and not `~/.squadron/bin`
   * is green in all three and missing on the machine, which is what
   * `SHIM_NAMES` and the esbuild entry list disagreeing costs — and it went
   * unnoticed for a fortnight once.
   *
   * The second half is the join the CLI cannot see: the panel's own 3 s poll
   * reading back `in_progress` a *different process* wrote, and painting the
   * rail from it. Every other workflow case here hand-writes that file.
   *
   * Leaves the shelf free, like the case above it.
   */
  step('serves a step to the installed squadron-step, and the panel follows it', async () => {
    // `squadron-step` is a write verb, gated on Orchestration (`cli/gate.ts`).
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    await panel().locator('#wattach .fpill').click({ timeout: 10_000 });
    const menu = panel().locator('#wattach .fmenu');
    await menu.waitFor({ timeout: 10_000 });
    await menu.locator('.mitem', { hasText: 'smoke workflow' }).click({ timeout: 10_000 });
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });
    await panel().locator('#wattach .wflow.armed').waitFor({ timeout: 10_000 });

    await send('pull the steps');
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    const followed = await followedWorkflow();
    assert.ok(followed, 'the send seeded no run for the shim to find');
    const caller = ['--caller-session-id', followed.sessionId];

    // Every step pending, so the chip names no current step — the state the
    // pull is about to move, and the one a stale poll would look identical to.
    const live = panel().locator('#wattach .wflow:not(.armed)');
    await live.waitFor({ timeout: 30_000 });
    assert.equal(
      await panel().locator('#wattach .wflow .sname').count(),
      0,
      'nothing has been pulled yet, so nothing is current'
    );

    const first = runStep(['next', ...caller]);
    assert.equal(first.code, 0, `next refused: ${first.said}`);
    assert.match(first.said, /^Step 1 of 3 · "One"/, first.said);
    assert.match(first.said, /do the one step/, 'the step body is what the agent came for');
    assert.ok(
      !first.said.includes('do the two step') && !first.said.includes('do the three step'),
      'one step at a time — the whole point of the feature'
    );

    // Written by the shim, read by the panel, on the panel's own clock.
    await panel()
      .locator('#wattach .wflow.live .sname', { hasText: 'One' })
      .waitFor({ timeout: 30_000 });
    const drawer = panel().locator('#workflowoverviewdrawer');
    await live.click();
    await drawer.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await drawer.locator('.strow.now .slabel').textContent(), 'One');

    // Twice without a `done` reprints under a header, rather than advancing —
    // the case an agent that lost the text to compaction lands in.
    const again = runStep(['next', ...caller]);
    assert.equal(again.code, 0, `the second next refused: ${again.said}`);
    assert.match(again.said, /already have this one/, again.said);
    assert.equal(await drawer.locator('.strow.now .slabel').textContent(), 'One');

    const finished = runStep(['done', '--note', 'pulled it', ...caller]);
    assert.equal(finished.code, 0, `done refused: ${finished.said}`);
    const second = runStep(['next', ...caller]);
    assert.equal(second.code, 0, `the third next refused: ${second.said}`);
    assert.match(second.said, /^Step 2 of 3 · "Two"/, second.said);
    await drawer.locator('.strow.now .slabel', { hasText: 'Two' }).waitFor({ timeout: 30_000 });

    await drawer.locator('.rdhead .x').click();
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 });
    await forgetFollowedWorkflows();
    await patchSettings({ 'squadron.orchestrators.enabled': false });
  });

  /**
   * Board-mode editor entry from both doors: Edit behind a row's own `⋯`, and
   * New under the list's last row. Only the host can own the form's Save/Delete wire;
   * this case only proves the chrome opens and Back restores the board —
   * create/delete on disk is the next test.
   */
  step('opens the board editor from a row Edit and from the list’s New', async () => {
    await onSheet(async () => {
      // Edit is on every row now, rather than on whichever one the bar had picked.
      await openWorkflowSheet();
      await pressRowAction('smoke workflow', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      // The name field's own label says which screen this is — there is no title
      // span above it, since the two named the same thing twice.
      assert.match(
        (await panel().locator('#wfeditor .welabel').textContent()) ?? '',
        /Edit workflow/
      );
      assert.equal(await panel().locator('#wfeditor .wedelete').count(), 1);
      await panel().locator('#wfeditor .weback').click();
      await waitEditorClosed();

      // The list's own New, under the last row — create has no Delete.
      await openWorkflowSheet();
      await panel().locator('#bottomdrawer-body .wsnew').click();
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      assert.match(
        (await panel().locator('#wfeditor .welabel').textContent()) ?? '',
        /New workflow/
      );
      assert.equal(await panel().locator('#wfeditor .wedelete').count(), 0);
      await panel().locator('#wfeditor .weback').click();
      await waitEditorClosed();
    });
  });

  /**
   * The `@` menu in a step prompt, opened on the **first** step on purpose.
   *
   * Geometry is the one thing jsdom cannot answer — every rect there is zero, so
   * a menu that opens off the top of the panel measures identically to one that
   * fits. The composer's box is pinned to the panel's bottom edge, so `place()`
   * only ever opened upward; a step field sits near the top of a scrolling
   * column, and upward from there is off-screen. The first step is where that
   * fails, which is why this case does not use any other.
   */
  step('opens a step’s skill menu where it can be read, not off the top', async () => {
    await onSheet(async () => {
      await openWorkflowSheet();
      await panel().locator('#bottomdrawer-body .wsnew').click();
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });

      const box = stepPrompt().first();
      await box.click();
      await box.pressSequentially('i @skill:', { delay: 20 });
      const menu = panel().locator('#mentionmenu');
      await menu.waitFor({ state: 'visible', timeout: 30_000 });

      const menuBox = await menu.boundingBox();
      const panelBox = await panel().locator('body').boundingBox();
      assert.ok(menuBox && panelBox, 'no boxes to compare — the menu never laid out');
      assert.ok(
        menuBox.height > 40,
        `the menu collapsed to ${menuBox.height}px — over-constrained, check top: auto`
      );
      assert.ok(
        menuBox.y >= panelBox.y - 1 &&
          menuBox.y + menuBox.height <= panelBox.y + panelBox.height + 1,
        `the menu left the panel: menu ${menuBox.y}..${menuBox.y + menuBox.height}, ` +
          `panel ${panelBox.y}..${panelBox.y + panelBox.height}`
      );

      // A pick is a chip showing the name; the prompt holds the full phrase.
      await menu.locator('.mnrow').filter({ hasText: 'dataviz' }).click();
      const chips = panel().locator('#wfeditor .wcbody .pchip.skill');
      assert.equal(await chips.count(), 1);
      assert.equal(await proseValue(box), 'i the dataviz skill ');
      await box.pressSequentially('@skill:', { delay: 20 });
      await menu.waitFor({ state: 'visible', timeout: 10_000 });
      await menu.locator('.mnrow').filter({ hasText: 'dataviz' }).click();
      assert.equal(await chips.count(), 2);
      await box.pressSequentially('x', { delay: 20 });
      assert.equal(await proseValue(box), 'i the dataviz skill the dataviz skill x');
      await assertPillGaps(panel().locator('#wfeditor .wcbody').first());

      await panel().locator('#wfeditor .weback').click();
      await waitEditorClosed();
    });
  });

  /**
   * Reorder, which is the other gesture only a host can make: every drag in
   * `workflow_editor_canvas.test.ts` is a hand-made object on a plain `Event`, so it
   * proves the handlers and nothing about the platform's own drag — the grip's
   * real hit box, the node the pointer actually presses, and whether the drag
   * the browser starts ever finishes. That last one is what this case was
   * written for: `body.dragging-step` took the pointer off the card while the grip
   * lived inside that same card, and the drag then wedged with no dragover, no drop
   * and no dragend — a grip that could be pressed and never released.
   *
   * A wedged drag **hangs** rather than failing: Playwright's own timeout does
   * not end a drag the renderer never resolves, so a regression here stops the
   * suite instead of reddening it. That is the symptom to recognise, not a
   * flake to retry — and running this file alone is the cheapest way to
   * reproduce it.
   *
   * The form is never saved, so the fixture on disk is still what the cases
   * after this one read.
   */
  step('reorders steps by dragging the grip', async () => {
    const names = () =>
      panel()
        .locator('#wfeditor .wcnode')
        .evaluateAll((els) =>
          els.map((e) => {
            const field = e.querySelector('input.wctitle');
            return field instanceof HTMLInputElement
              ? field.value
              : (e.querySelector('.wcname:not(.empty)')?.textContent ?? '');
          })
        );
    try {
      // Edit is on the row, so there is no pick to arrange first.
      await openWorkflowSheet();
      await pressRowAction('smoke workflow', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      assert.deepEqual(await names(), ['One', 'Two', 'Three']);

      // Dropped on the second card, the carried first step takes its row.
      const grip = panel().locator('#wfeditor .wcnode[data-node="one"] .wegrip');
      const second = panel().locator('#wfeditor .wcnode[data-node="two"]');
      await grip.dragTo(second);

      assert.deepEqual(await names(), ['Two', 'One', 'Three']);
      // Nothing left in flight: the fields are live again and no row is lit.
      assert.equal(
        await panel().locator('#wfeditor .target').count(),
        0,
        'lit row cleared after the release'
      );
    } finally {
      await panel()
        .locator('#wfeditor .weback')
        .click({ timeout: 5_000 })
        .catch(() => {});
      await waitEditorClosed().catch(() => {});
    }
  });

  /**
   * A wire under the pointer, which jsdom cannot put one under: the hover
   * highlight is a `:has()` off the hit band, and the trash is placed off a
   * click measured against the canvas — every rect in jsdom is zero.
   *
   * Aimed through the pipe, not the path: One → Two is a straight drop down one
   * lane, whose box is 0px wide, and Playwright calls a 0px box not visible and
   * will not hover it. The path's units are the pipe's pixels (the SVG is
   * `inset: 0` in it), so its midpoint is a position on the pipe.
   *
   * Then a grip carried onto that same wire, because the reorder's drop is
   * bound on `.wcgrid` and the hit band stacks over it. Aimed three quarters
   * down it: the wire crosses the gap between One and Two, and a gap belongs
   * to the nearer row, so at its midpoint the row is a coin toss. The form is
   * never saved.
   */
  step('lights a wire on hover, offers its trash, and lets a step drop on it', async () => {
    try {
      await openWorkflowSheet();
      await pressRowAction('smoke workflow', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });

      const hit = panel().locator('#wfeditor path.wchit[data-from="one"][data-to="two"]');
      const drawn = () =>
        hit.evaluate((e) => {
          const wire = e.previousElementSibling;
          return wire ? getComputedStyle(wire).strokeWidth : '';
        });
      const pipe = panel().locator('#wfeditor .wcpipe');
      const mid = await hit.evaluate((e) => {
        const path = e as SVGPathElement;
        const p = path.getPointAtLength(path.getTotalLength() / 2);
        return { x: p.x, y: p.y };
      });
      await pipe.hover({ position: mid });
      // Reachability first: jsdom dispatches onto the path, so only a host can say.
      const under = await hit.evaluate((e, m) => {
        const r = e.closest('.wcpipe')?.getBoundingClientRect();
        const at = r ? document.elementFromPoint(r.left + m.x, r.top + m.y) : null;
        return at?.getAttribute('class') ?? at?.tagName ?? 'nothing';
      }, mid);
      assert.equal(under, 'wchit', 'the wire is what the pointer reaches');
      assert.equal(await drawn(), '2.5px', 'the hovered wire lights');
      // 60px aside is the empty gap beside the wire. Off the page instead, the
      // nested webview frames never hear the pointer leave.
      await pipe.hover({ position: { x: mid.x + 60, y: mid.y } });
      assert.equal(await drawn(), '1.5px', 'and goes back when the pointer leaves');

      const low = await hit.evaluate((e) => {
        const path = e as SVGPathElement;
        const p = path.getPointAtLength((path.getTotalLength() * 3) / 4);
        return { x: p.x, y: p.y };
      });
      await pipe.click({ position: mid });
      const box = await pipe.boundingBox();
      const trash = await panel().locator('#wfeditor .wirex').boundingBox();
      assert.ok(box && trash, 'the canvas and the trash both have a box');
      // SC 2.5.8's 24×24.
      assert.ok(trash.width >= 24 && trash.height >= 24, `trash is ${trash.width}×${trash.height}`);
      const off = Math.hypot(
        trash.x + trash.width / 2 - (box.x + mid.x),
        trash.y + trash.height / 2 - (box.y + mid.y)
      );
      assert.ok(off < 2, `trash centred on the click, ${off.toFixed(1)}px off`);

      await ctx.page.keyboard.press('Escape');
      await panel().locator('#wfeditor .wirex').waitFor({ state: 'detached', timeout: 5_000 });
      await panel()
        .locator('#wfeditor .wcnode[data-node="three"] .wegrip')
        .dragTo(pipe, { targetPosition: low });
      const names = await panel()
        .locator('#wfeditor .wcnode')
        .evaluateAll((els) =>
          els.map((e) => {
            const field = e.querySelector('input.wctitle');
            return field instanceof HTMLInputElement
              ? field.value
              : (e.querySelector('.wcname:not(.empty)')?.textContent ?? '');
          })
        );
      assert.deepEqual(names, ['One', 'Three', 'Two'], 'the step dropped on the wire landed');
    } finally {
      await panel()
        .locator('#wfeditor .weback')
        .click({ timeout: 5_000 })
        .catch(() => {});
      await waitEditorClosed().catch(() => {});
    }
  });

  /**
   * The canvas is the editor. Opening a workflow shows closed nodes; opening
   * one shows the prompt that will be saved; Save still closes the form.
   * Nothing here is rewritten — the file's prompts are what the next case
   * that opens this workflow reads back.
   */
  step('opens a workflow node and saves it', async () => {
    try {
      await openWorkflowSheet();
      await pressRowAction('smoke workflow', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await panel().locator('#wfeditor .wcbody').count(), 0, 'edit opens closed');
      // 2026-09-29, full barrel: `.wcnode`.first().click() opened "do the two
      // step". The two cases above reorder and insert, then discard, so a
      // fresh Edit has to show the file — and the centre of each card has to
      // be that card, which is the click those cases cannot see.
      const face = await panel()
        .locator('#wfeditor .wcnode')
        .evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            const mid = e.ownerDocument.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2
            );
            return {
              name: e.querySelector('.wcname')?.textContent ?? '',
              desc: e.querySelector('.wcdesc')?.textContent ?? '',
              id: e.getAttribute('data-node') ?? '',
              hit: mid?.closest('.wcnode')?.getAttribute('data-node') ?? mid?.className ?? 'none'
            };
          })
        );
      const onDisk = JSON.parse(
        await fs.readFile(path.join(ctx.home, '.squadron', 'workflows', 'smoke-flow.json'), 'utf8')
      ) as { steps?: { id?: string; label?: string; prompt?: string }[] };
      const disk = (onDisk.steps ?? []).map((s) => `${s.id}:${s.label}:${s.prompt}`);
      assert.deepEqual(
        face.map((n) => ({ name: n.name, desc: n.desc, own: n.hit === n.id })),
        [
          { name: 'One', desc: 'do the one step', own: true },
          { name: 'Two', desc: 'do the two step', own: true },
          { name: 'Three', desc: 'do the three step', own: true }
        ],
        `closed face ${JSON.stringify(face)} disk ${JSON.stringify(disk)}`
      );
      // The name, not the card centre. A centre click is what the face probe
      // above already hit-tests; the open itself has to be the step named One.
      await panel().locator('#wfeditor .wcnode[data-node="one"] .wcname').click();
      const box = stepPrompt(panel().locator('#wfeditor .wcnode.editing'));
      await box.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await proseValue(box), 'do the one step');
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();
    } finally {
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * The permission dialog, which is the ask's opposite in the one way that
   * matters: nothing stages. Each button is the decision, so `.pallow` is both
   * the click and the send.
   */
  step('raises a permission dialog and allows it', async () => {
    await send('write');
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    assert.equal(await launch.locator('.at').textContent(), 'permission');
    await launch.click();

    const dlg = panel().locator('#question .pdlg').first();
    await dlg.waitFor({ timeout: 10_000 });
    assert.equal(await dlg.locator('.ptool').textContent(), 'Write');
    assert.equal(await dlg.locator('.plabel').textContent(), 'notes.txt');

    await dlg.locator('.pallow').first().click();
    await panel().locator('#qlaunch').waitFor({ state: 'hidden', timeout: 30_000 });
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * Refusing is two presses, not one — `.pdeny` opens a box for a reason and
   * `.pdeny-go` sends it — which is the point of having this here as well as in
   * jsdom: a two-stage control is where a real host's repaints get a chance to
   * lose the half-finished state between them.
   *
   * The child sees a different decision and does the same thing with it, so the
   * settle reads the same as the allow above. That is the honest limit of this
   * case: what distinguishes deny from allow on the wire is not visible from a
   * paint, and `permission.test.ts` is where the shape of it is asserted.
   */
  step('denies a permission dialog, with a reason', async () => {
    await send('write');
    const launch = panel().locator('#qlaunch');
    await launch.waitFor({ timeout: 30_000 });
    await launch.click();

    const dlg = panel().locator('#question .pdlg').first();
    await dlg.waitFor({ timeout: 10_000 });
    // No box before anyone means to refuse.
    assert.equal(await dlg.locator('.say-in').count(), 0);

    await dlg.locator('.pdeny').first().click();
    await dlg.locator('.say-in .ProseMirror').first().fill('not that file');
    await dlg.locator('.pdeny-go').first().click();

    await panel().locator('#qlaunch').waitFor({ state: 'hidden', timeout: 30_000 });
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * `slow` is the fake CLI's turn that never ends on its own, so the only thing
   * that can end it is the interrupt — which is a control frame down the same
   * pipe, answered by a `result` the reducer has to read as the turn stopping.
   * A card still reading `busy` afterwards is the latch this guards.
   */
  step('interrupts a turn that will not end by itself', async () => {
    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });

    // The one place a frame's *content* is readable from a paint, and the only
    // reason it is: this turn never ends, so its live text stays put instead of
    // being gone by the next poll the way every settled turn's is. Between the
    // delta and this assertion sit the reducer, the host's markdown engine and
    // DOMPurify — so a word arriving here is the whole inbound path, not just
    // the transport.
    const live = panel().locator('#thread .turn.live');
    await live.waitFor({ timeout: 30_000 });
    assert.equal(
      await live.locator('.who').evaluate((node) => {
        const label = node.cloneNode(true) as HTMLElement;
        label.querySelector('.at')?.remove();
        return label.textContent?.trim();
      }),
      'Claude'
    );
    assert.match((await live.textContent()) ?? '', /working/);

    await panel().locator('#chat-interrupt').click();
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * The same interrupt from the keyboard with the caret out of the composer: a
   * click on a turn takes focus off the box, and Escape has to reach the
   * window's listener from there. jsdom dispatches the key at an element it
   * names; only a host says where a real press lands after a real click.
   */
  step('interrupts on Escape with focus on the thread', async () => {
    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    const live = panel().locator('#thread .turn.live');
    await live.waitFor({ timeout: 30_000 });
    await live.locator('.who').click();
    assert.equal(
      await panel()
        .locator('#input')
        .evaluate((box) => box === box.ownerDocument.activeElement),
      false,
      'the click left the caret in the composer, so this proves nothing new'
    );
    await ctx.page.keyboard.press('Escape');
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * The half of the busy refusal no headless layer can reach.
   *
   * `endPlan` is pure and every rule in it is a case in `end_cli.test.ts` —
   * but all of those are written against a board the test itself composed. What
   * none of them can answer is whether a session that is *really* mid-turn
   * reads as `busy` to a *different process*. That word travels the reducer →
   * `core/published.ts` → a file → the CLI's own `foldTwins`, and the only
   * thing that can put a record on that path is `host/sessions.ts`, which
   * imports `vscode`. A publish that lagged the turn, or that wrote `unknown`
   * the way an owned session's transcript twin does by construction, leaves the
   * refusal correct in every test and never firing in life.
   *
   * The shipped bundle rather than `out/cli/end.js`: `installShim` copies
   * `dist/squadron-end.js` into `~/.squadron/bin/`, and that copy is the
   * only thing an agent ever runs — so this also covers the emit and the copy.
   *
   * The lineage edge is what makes this session the boot fixture's child.
   * Descent is checked before busy, so without it the command is refused for a
   * different reason and a case asserting only the exit code passes on the
   * wrong branch. That is why the sentence is asserted too, and why the two
   * assertions are not interchangeable.
   */
  step('refuses an agent ending a session that is mid-turn', async () => {
    // `squadron-end` is a write verb, gated on Orchestration (`cli/gate.ts`).
    await patchSettings({ 'squadron.orchestrators.enabled': true });
    // The twin a real CLI writes and `fake-cli.ts` does not. `foldTwins` is
    // called with no owned list out here — the panel's registry is in another
    // process — so a published record with nothing discovered under it is
    // dropped, and the session is invisible to every command in `cli/`.
    //
    // **No `status` field, deliberately.** That is what the real CLI writes for
    // a print-mode session (`cli_state/claude/sessions.md`), and it is what
    // makes this case worth running: `busy` can then only have come down the
    // published path, which is the one thing being proved. A hand-written
    // `busy` here would assert the fixture.
    //
    // `procStart` is what makes it findable at all. `discover.ts` requires the
    // pid to still be there, and its cheap test — a process named `claude` — is
    // one this fixture cannot pass: the shim named `claude` `exec`s node, so
    // the command left in `ps` names the fake and not the shell. `procStart` is
    // the other half of that gate, matched against `ps` within 2s, and is the
    // field the real CLI writes for exactly this reason.
    await plantClaudeTwin(owned, 'smoke-owned', 'owned session', clicked + 1);
    // The parent is the shared fixture card, and it is named by the id that
    // card actually has. It was the literal `smoke` while the fixture was a
    // file on disk; since row 71 it is an owned session whose id is assigned at
    // spawn.
    //
    // **And it needs a twin of its own, for the same reason this session does.**
    // The shims fold `discoverAll` with the published records and drop a record
    // with nothing discovered under it — so a session the panel owns is
    // invisible out here until something writes the file a real CLI would.
    // Without it the command is refused one branch earlier, with
    // `<id> is not a session on the board, so it has nothing below it`, which
    // is exactly the wrong reason this case's second assertion exists to catch.
    const { pid: parentPid, sessionId: parentSessionId } = await fixtureSession();
    await plantClaudeTwin(Number(parentPid), parentSessionId, 'smoke session', clicked + 1);
    await writeJson(path.join(homeDir(), '.squadron', 'lineage', `${owned}.json`), {
      schema: 1,
      spawnedAt: clicked,
      cwd: path.join(homeDir(), 'project'),
      requestId: 'smoke-busy',
      parentSessionId
    });

    // The turn above this one is still `busy` on disk when this case starts —
    // the interrupt that ended it lands tens of milliseconds before the case
    // returns, and the publish behind it up to `PUBLISH_MS` after. A refusal
    // read off *that* record proves nothing about this turn, and for as long as
    // the gate below was the paint alone that is what the green runs were
    // reading: the first `busy` write of a whole run measured 250 ms *later*
    // than the shim's read of it (2026-08-18, one publish sample per 10 ms).
    // So the record is brought to `idle` first, and the `busy` the shim meets
    // can only be this send's.
    await waitRecord('idle');

    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });

    const refused = end(['--pid', String(owned), '--caller-session-id', parentSessionId]);

    // Both fixtures gone before anything is asserted. They are a stand-in for
    // what a real CLI writes, and the panel reads the same directory: the twin
    // feeds `hasCommand` back into this card through `withTwin`, and a session
    // holding a backgrounded command has no composer — which cost two later
    // cases in this file, intermittently, when they outlived the one command
    // that needed them. Scoped to that command, and removed on the failing path
    // too, since an assertion below is exactly when it matters.
    await fs.rm(claudeTwinFile(owned), { force: true });
    await fs.rm(claudeTwinFile(parentPid), { force: true });
    await fs.rm(path.join(homeDir(), '.squadron', 'lineage', `${owned}.json`), { force: true });

    assert.equal(refused.code, 2, refused.said);
    assert.match(refused.said, /is busy/);

    // Still running, which is the whole point: a refusal posts no `close`, so
    // there is nothing for the window to act on and the turn is untouched.
    // The selected chat stays up with it. A refusal is not an accepted end.
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    assert.equal(
      await panel()
        .locator('body')
        .evaluate((node) => node.classList.contains('closed')),
      false
    );

    await panel().locator('#chat-interrupt').click();
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await patchSettings({ 'squadron.orchestrators.enabled': false });
  });

  /**
   * The beat between our write and the CLI's own copy of a message — the one
   * thing about this feature jsdom structurally cannot see, because it is not a
   * paint rule but a race between two clocks: the outbox pops the row the
   * instant we write it, and the transcript is read on a 3s poll.
   *
   * Both `slow`s are deliberate. The first holds a turn open so the second send
   * is *held* rather than written; the second is what the drain then writes, and
   * because it also never ends there is no `result` to clear `inFlight` and no
   * settled turn to race the assertion. The fake writes no transcript at all, so
   * nothing can retire the bubble either — which is exactly the state a real
   * session is in for one poll, held still long enough to read.
   *
   * The bubble asserted here is the host's and not the composer's own echo: that
   * one was retired when the message reached the outbox, two steps back.
   */
  /**
   * A drained message is **never off screen**, across the whole handover from
   * the outbox to the thread.
   *
   * This used to wait for the `.turn.user.sending` placeholder by name, and that
   * assertion died with roadmap row 54's Phase 2 rather than being weakened
   * here. The placeholder exists to cover the window between our write and the
   * transcript's own copy; for an owned Claude session there is no longer a
   * window, because we write the turn into our own record at the drain
   * (`core/claude/tee.ts`'s `exchangeForSend`) and the next push already has it
   * as a settled turn. `stillSending` retires the row on that same push, by
   * design — it only ever retires against the list it is about to draw.
   *
   * So the case asserts the property it was written for instead of the node that
   * happened to carry it, and asserts it **over the transition rather than at
   * one instant**, which the original `waitFor` could not. A single sample can
   * be taken before the gap or after it; this samples throughout and requires
   * every frame to hold the words somewhere.
   *
   * `.turn.user` covers both holders — `rawTurn('turn user sending', …)` wears
   * both classes — which is the honest statement of the invariant: *something*
   * must hold it, and this does not care which. That is what keeps it a real
   * test after the change rather than a restatement of it.
   *
   * The sampler runs once per painted frame, between tasks, and the webview's
   * morph runs synchronously inside its own `message` handler, so it cannot
   * observe a half-built thread.
   *
   * The placeholder itself is still production behaviour and still covered end
   * to end — by the Grok case in `grok.smoke.ts`, which is the brand that writes
   * no record of its own and therefore still has the window this fills.
   */
  step('never lets a drained message leave the screen', async () => {
    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    await panel().locator('#thread .turn.live').waitFor({ timeout: 30_000 });

    const held = 'slow, and this one was held';
    await send(held);
    const outbox = panel().locator('#thread .outbox');
    await outbox.waitFor({ timeout: 30_000 });

    // Watching before the drain, so the frame the handover happens on is inside
    // the sample and not before it.
    const thread = panel().locator('#thread');
    await thread.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      view.__gap = 0;
      view.__seen = 0;
      view.__at = '';
      view.__live = true;
      // Frames, not a timer: after a reset's reload, Chromium runs this frame's
      // timers on whole seconds (a 5 ms interval ticked 3 times in 1.5 s) while
      // rAF holds 60 fps — measured 2026-09-24, cause not found.
      const sample = (): void => {
        if (!view.__live) return;
        view.__seen = (view.__seen as number) + 1;
        // `.qrow` is `webview/question.ts`'s and has never been in this block.
        // An outbox row is `turn ${outboxClass} queued` (`webview/chat.ts`), and
        // `outboxClass` answers `user` or `user peer` for everything except a
        // `role: wait` row, which gets a bare `wait` — so `.turn.user` already
        // reaches every row but that one, and naming it is the exact statement
        // of the invariant. A bare `.outbox .turn` would widen the predicate
        // instead, which is the one thing this must not do.
        const held = [...node.querySelectorAll('.turn.user, .outbox .turn.wait')].some((el) =>
          (el.textContent ?? '').includes('this one was held')
        );
        if (!held) {
          view.__gap = (view.__gap as number) + 1;
          // The first gap frame only, so a run of them cannot cost the page a
          // string per frame. This is the discriminator the last red could not
          // answer: an empty thread is the transcript read having come back
          // with nothing, and a thread holding its other turns is the drained
          // message alone having gone missing.
          if (!view.__at) {
            view.__at = `turns=${node.querySelectorAll('.turn').length} ${node.innerHTML.slice(0, 600)}`;
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    // Interrupt ends the turn the row was waiting on, and the idle edge drains
    // it — the case above dismisses its row precisely to stop this happening.
    await panel().locator('#chat-interrupt').click();
    await outbox.waitFor({ state: 'hidden', timeout: 30_000 });
    await panel()
      .locator('#thread .turn.user', { hasText: 'this one was held' })
      .waitFor({ timeout: 30_000 });
    // Kept running past the settled turn, and for longer than the handover
    // itself took: the transition is now milliseconds — that is the whole point
    // of the record — so stopping on it would sample a handful of frames and
    // prove little. This also carries the sampler across a 3s poll's repaint,
    // where a turn dropping out again would show.
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    const watched = await thread.evaluate((node) => {
      const view = node.ownerDocument.defaultView as unknown as Record<string, unknown>;
      view.__live = false;
      return {
        gap: view.__gap as number,
        seen: view.__seen as number,
        at: view.__at as string
      };
    });
    // 3.5 s at 60 fps is 210; the floor leaves room for frames a loaded machine
    // drops.
    assert.ok(
      watched.seen > 100,
      `the sampler did not span the transition: ${watched.seen} frames`
    );
    assert.equal(
      watched.gap,
      0,
      `the message left the outbox with nothing holding it — ${watched.gap} of ${watched.seen} frames, first at ${watched.at}`
    );

    await panel().locator('#chat-interrupt').click();
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * The coffee, end to end: a real session going busy makes this machine really
   * hold a real sleep assertion.
   *
   * Nothing below the host can prove this. `core/awake.ts` decides, and its
   * tests cover the deciding; `host/keepawake.ts` spawns, and importing `vscode`
   * puts it out of reach of every headless suite. Only here do frames from a
   * live child reach `onOwnedChange`, wake the keeper, and end as a
   * `PreventUserIdleSystemSleep` the OS will list.
   *
   * `slow` is why this can be asserted at all: it is the fake CLI's turn that
   * never ends on its own, so the session stays busy long enough to ask the OS
   * a question. Every other turn here settles in about a millisecond.
   *
   * `pmset -g assertions` rather than our own record: the record is what the
   * panel believes, and a scenario that read it would pass just as happily if
   * `caffeinate` had never started.
   *
   * **Read as this host's holds, not as a count.** An earlier version counted
   * the machine-wide list against a baseline, and it was wrong twice over. Any
   * other window running this extension holds one too, so the number says
   * nothing about us; and the keeper no longer pours one coffee per busy edge,
   * so an earlier case in this very file may already have poured the hold this
   * one is looking for, leaving the count flat while everything works. The
   * `Details:` line names the watched pid, so the honest question is whether
   * *our* extension host is the one being held for — which also proves the
   * flags reached the child.
   *
   * Own case rather than assertions bolted onto the interrupt above, so this
   * leaves the session idle the way every case in this sequence must.
   */
  step('keeps the machine awake while the session works, and goes on holding', async () => {
    if (testPlatform() !== 'darwin') {
      return; // no caffeinate to hold, and no cup drawn — see `decide`.
    }

    const held = (): number[] => hostSleepAssertions().map((one) => one.watched);

    /** Poll, because the keeper coalesces its change hook over one second and the
     *  spawn is a process start — neither is instant, and neither is slow. */
    const settle = async (what: string, ms = 30_000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (held().length > 0) {
          return;
        }
        await ctx.page.waitForTimeout(500);
      }
      assert.fail(`${what}: nothing held on behalf of this host after ${ms}ms`);
    };

    await send('slow');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });

    // `slow` never ends on its own, so anything that throws below would leave a
    // session running for every case after this one — which is how this first
    // failed: the assertion went off, the interrupt never ran, and the stop case
    // at the end of the file sat for sixty seconds on a turn nothing closed.
    try {
      await settle('no sleep assertion while a session was working');
    } finally {
      await panel().locator('#chat-interrupt').click();
      await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    }

    // **The work stopping releases nothing**, which is the rule this case exists
    // to pin. The lease in hand runs out on `-t` ten minutes later; killing it
    // early bought ten minutes of a Mac not sleeping and cost a spawn, a `pmset`
    // and a machine-wide repaint on every gap between turns. Five seconds is
    // well past the keeper's one-second delay, so a release would have happened by
    // now if one were coming.
    await ctx.page.waitForTimeout(5_000);
    assert.ok(
      held().length > 0,
      'the hold was poured away when the session went idle — it should wear off on its own'
    );
    try {
      await patchSettings({ 'squadron.cafe.enabled': false });
      const until = Date.now() + 10_000;
      while (held().length > 0) {
        assert.ok(Date.now() < until, 'Café off left a sleep assertion belonging to this host');
        await ctx.page.waitForTimeout(250);
      }
      console.log('  Café retained its idle lease and released this host’s assertions on off');
    } finally {
      await patchSettings({ 'squadron.cafe.enabled': true });
    }
  });

  /**
   * Create and delete cross the host: the form posts, the extension writes or
   * unlinks under the real `HOME`, and the next poll repaints the bar. jsdom
   * cannot see that directory. Delete is two clicks in the webview (Delete →
   * Confirm delete) so the suite does not depend on a workbench modal.
   *
   * Last before stop so a stuck editor cannot hide cards for earlier cases.
   */
  step('creates a workflow on disk from the editor, then deletes it', async () => {
    const file = path.join(ctx.home, '.squadron', 'workflows', 'smoke-created.json');

    try {
      await onSheet(async () => {
        await openWorkflowSheet();
        await panel().locator('#bottomdrawer-body .wsnew').click();
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });

      // Workflow name is the first labelled field; step name + prompt are the row.
      await panel().locator('#wfeditor .wename').fill('smoke created');
      await panel().locator('#wfeditor input.wctitle').fill('Step A');
      await stepPrompt().fill('do the created step');
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();
      await waitPath(file, 'exists');

      // The sheet lists the new file once the host refreshes. Unlike the menu
      // this replaces, the list is morphed on every push rather than filled on
      // open — so waiting is enough, and the sheet may simply stay up.
      await onSheet(async () => {
        const created = sheetRow('smoke created');
        await openWorkflowSheet();
        await created.waitFor({ timeout: 30_000 });
        await pressRowAction('smoke created', 'Edit');
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      await panel().locator('#wfeditor .wedelete').click();
      await panel()
        .locator('#wfeditor .wedelete', { hasText: 'Confirm delete' })
        .click({ timeout: 5_000 });
      await waitEditorClosed();
      await waitPath(file, 'gone');
    } finally {
      // Never leave board-mode open: cards are `display: none` while editing.
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * The `needs` a draft posts are the webview's call and the host only
   * validates them (`TASK_done_workflow_v2_lane_authoring.md`), so jsdom
   * proves the message and only a host proves the file.
   */
  step('saves a workflow with a second session, its chain written out', async () => {
    const file = path.join(ctx.home, '.squadron', 'workflows', 'smoke-lanes.json');
    const editing = panel().locator('#wfeditor .wcnode.editing');

    try {
      await onSheet(async () => {
        await openWorkflowSheet();
        await panel().locator('#bottomdrawer-body .wsnew').click();
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });

      await panel().locator('#wfeditor .wename').fill('smoke lanes');
      await editing.locator('input.wctitle').fill('Plan');
      await stepPrompt(editing).fill('plan it');
      await panel().locator('#wfeditor .wcaddstep').click();
      await editing.locator('input.wctitle').fill('Build');
      await stepPrompt(editing).fill(
        Array.from({ length: 8 }, (_, i) => `build line ${i + 1}`).join('\n')
      );
      // The screenshot this case holds: an open card that grew drew over the
      // Add step placed under the lowest card. The slot is a grid cell now.
      const card = await editing.boundingBox();
      const slot = await panel().locator('#wfeditor .wcaddstep[data-lane=""]').boundingBox();
      assert.ok(card && slot, 'no boxes to compare');
      assert.ok(
        slot.y >= card.y + card.height,
        `Add step at ${slot.y} is inside the open card, which ends at ${card.y + card.height}`
      );
      await panel().locator('#wfeditor .wcadd').click();
      // Beside Build, not beside Plan: a session cannot open with the run.
      assert.equal(await editing.locator('.wcg b').textContent(), '2b');
      await editing.locator('input.wctitle').fill('Notes');
      await stepPrompt(editing).fill('write them');
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();
      await waitPath(file, 'exists');

      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
        schema?: number;
        steps?: { id?: string; label?: string; lane?: string; needs?: string[] }[];
      };
      assert.equal('schema' in saved, false);
      const plan = saved.steps?.find((s) => s.label === 'Plan');
      const build = saved.steps?.find((s) => s.label === 'Build');
      assert.ok(plan?.id, 'no Plan step saved');
      assert.deepEqual(build?.needs, [plan.id]);
      assert.equal(build?.lane, undefined);
      const notes = saved.steps?.find((s) => s.label === 'Notes');
      assert.equal(notes?.lane, 'session 1');
      assert.equal(notes?.needs, undefined);
    } finally {
      await fs.rm(file, { force: true });
      // Never leave board-mode open: cards are `display: none` while editing.
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * A wire drawn by hand: pressed on a port, released over another card. The
   * port listened on itself, so the drag went deaf the moment the pointer left
   * its 24px and nothing was ever linked — jsdom dispatches wherever it is
   * told, and only a real pointer leaves the handle.
   */
  step('draws a wire from a port to another card and saves the needs', async () => {
    const file = path.join(ctx.home, '.squadron', 'workflows', 'smoke-wire.json');
    const editing = panel().locator('#wfeditor .wcnode.editing');

    try {
      await onSheet(async () => {
        await openWorkflowSheet();
        await panel().locator('#bottomdrawer-body .wsnew').click();
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      await panel().locator('#wfeditor .wename').fill('smoke wire');
      await editing.locator('input.wctitle').fill('Plan');
      await stepPrompt(editing).fill('plan it');
      await panel().locator('#wfeditor .wcghost .wcadd').click();
      await editing.locator('input.wctitle').fill('Notes');
      await stepPrompt(editing).fill('write them');
      await editing.locator('.wcdone').click();

      // One step and one unwired session: the first wire is the one drawn here.
      const plan = panel().locator('#wfeditor .wcnode[data-lane=""]');
      const notes = panel().locator('#wfeditor .wcnode[data-lane="session 1"]');
      await plan.locator('.wcport').dragTo(notes);
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();
      await waitPath(file, 'exists');

      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
        steps?: { id?: string; label?: string; needs?: string[] }[];
      };
      const planId = saved.steps?.find((s) => s.label === 'Plan')?.id;
      assert.deepEqual(saved.steps?.find((s) => s.label === 'Notes')?.needs, [planId]);
    } finally {
      await fs.rm(file, { force: true });
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * A lane is named `session N`, and a column was placed by `var()` on that
   * name unescaped — a space Chromium drops, so the card auto-placed into the
   * first free column. Only the second session shows it: wired one row down,
   * it landed under the first. jsdom lays nothing out.
   */
  step('draws each session in its own column', async () => {
    const editing = panel().locator('#wfeditor .wcnode.editing');
    try {
      await onSheet(async () => {
        await openWorkflowSheet();
        await panel().locator('#bottomdrawer-body .wsnew').click();
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      await editing.locator('input.wctitle').fill('Plan');
      for (const name of ['Notes', 'Review']) {
        await panel().locator('#wfeditor .wcghost .wcadd').click();
        await editing.locator('input.wctitle').fill(name);
        await editing.locator('.wcdone').click();
      }
      const notes = panel().locator('#wfeditor .wcnode[data-lane="session 1"]');
      const review = panel().locator('#wfeditor .wcnode[data-lane="session 2"]');
      await notes.locator('.wcport').dragTo(review);
      await panel()
        .locator('#wfeditor .wcnode[data-lane="session 2"][data-row="3"]')
        .waitFor({ timeout: 5_000 });

      const a = await notes.boundingBox();
      const b = await review.boundingBox();
      assert.ok(a && b, 'both cards are drawn');
      assert.ok(b.x >= a.x + a.width, `session 2 at ${b.x}, session 1 ends at ${a.x + a.width}`);
    } finally {
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * jsdom stores `scrollLeft` and never lays the grid out, so a rebuild can
   * put the number back and still have nothing to scroll. Three lanes overflow
   * this board. The click is dispatched in the page: a locator click scrolls
   * the hit into view and moves the place on its own.
   */
  step('keeps the canvas scrolled sideways across an unlink', async () => {
    const file = path.join(homeDir(), '.squadron', 'workflows', 'smoke-scroll.json');
    await writeJson(file, {
      schema: 2,
      id: 'smoke-scroll',
      label: 'smoke scroll',
      steps: [
        { id: 'a', label: 'A', prompt: 'a' },
        { id: 'b', label: 'B', prompt: 'b', needs: ['a'] },
        { id: 'c', label: 'C', prompt: 'c', lane: 'builder', needs: ['a'] },
        { id: 'd', label: 'D', prompt: 'd', lane: 'reviewer', needs: ['a'] }
      ]
    });
    try {
      await openWorkflowSheet();
      await pressRowAction('smoke scroll', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      await panel().locator('#wfeditor .wcnode[data-lane="reviewer"]').waitFor({ timeout: 5_000 });

      const place = await panel()
        .locator('#wfeditor .wcscroll')
        .evaluate((el) => {
          const scroller = el as HTMLElement;
          const max = scroller.scrollWidth - scroller.clientWidth;
          const left = Math.min(408, max);
          scroller.scrollLeft = left;
          return { max, left: scroller.scrollLeft };
        });
      assert.ok(place.max >= 100, `the canvas does not overflow (${place.max})`);
      assert.ok(place.left >= 100, `scrollLeft landed at ${place.left}`);

      await panel()
        .locator('#wfeditor .wcscroll')
        .evaluate(async (el) => {
          const hit = (el as HTMLElement).querySelector('path.wchit[data-from="a"][data-to="c"]');
          hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          (el as HTMLElement).querySelector<HTMLButtonElement>('.wirex')?.click();
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        });

      const after = await panel()
        .locator('#wfeditor .wcscroll')
        .evaluate((el) => ({
          left: (el as HTMLElement).scrollLeft,
          wire: el.querySelector('path.wchit[data-from="a"][data-to="c"]') !== null
        }));
      assert.equal(after.wire, false, 'the wire was removed');
      assert.ok(
        Math.abs(after.left - place.left) <= 1,
        `scrollLeft ${after.left}, was ${place.left}`
      );
    } finally {
      await fs.rm(file, { force: true });
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * A card dropped on a card of its own column takes that row. jsdom is lent
   * its geometry, so which row a real release is read as is only answered
   * here.
   */
  step('puts a card into its own column’s row by dragging it there', async () => {
    const file = path.join(ctx.home, '.squadron', 'workflows', 'smoke-rows.json');
    const editing = panel().locator('#wfeditor .wcnode.editing');

    try {
      await onSheet(async () => {
        await openWorkflowSheet();
        await panel().locator('#bottomdrawer-body .wsnew').click();
      });
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });
      await panel().locator('#wfeditor .wename').fill('smoke rows');
      await editing.locator('input.wctitle').fill('Plan');
      await stepPrompt(editing).fill('plan it');
      await panel().locator('#wfeditor .wcaddstep').click();
      await editing.locator('input.wctitle').fill('Build');
      await stepPrompt(editing).fill('build it');
      await editing.locator('.wcdone').click();
      // After panel.smoke, the click on Done left the canvas at its right end
      // (scrollLeft 295 of 295, 2026-10-02; 0 with this file alone). The editor
      // keeps a sideways scroll across the rebuild, so both cards started the
      // drag off the board's left edge and dragTo missed ~1 in 4.
      // A reader scrolls back to the cards before dragging one.
      await panel()
        .locator('#wfeditor .wcscroll')
        .evaluate((s) => {
          s.scrollLeft = 0;
        });

      const build = panel().locator('#wfeditor .wcnode', { hasText: 'Build' });
      const plan = panel().locator('#wfeditor .wcnode', { hasText: 'Plan' });
      await build.locator('.wegrip').dragTo(plan);
      await panel()
        .locator('#wfeditor .wcnode[data-row="1"]', { hasText: 'Build' })
        .waitFor({ timeout: 5_000 });
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();
      await waitPath(file, 'exists');

      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
        steps?: { label?: string }[];
      };
      assert.deepEqual(
        saved.steps?.map((s) => s.label),
        ['Build', 'Plan']
      );
    } finally {
      await fs.rm(file, { force: true });
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * A card of this session released on an empty row of another, below that
   * session's Add step, stays in its lane. jsdom is lent its columns, so where
   * a real release is read is only answered here. The carry lights its own
   * Add step first, so a drag that never started cannot pass, and lights
   * nothing over the other session. The drop commits on `drop`, so Save
   * straight after reads it.
   */
  step('keeps a card in its session when released on another’s row', async () => {
    const file = path.join(homeDir(), '.squadron', 'workflows', 'smoke-across.json');
    await writeJson(file, {
      schema: 2,
      id: 'smoke-across',
      label: 'smoke across',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan it' },
        { id: 'build', label: 'Build', prompt: 'build it', needs: ['plan'] },
        { id: 'ship', label: 'Ship', prompt: 'ship it', needs: ['build'] },
        { id: 'docs', label: 'Docs', prompt: 'write docs', lane: 's1', needs: ['plan'] }
      ]
    });
    try {
      await openWorkflowSheet();
      await pressRowAction('smoke across', 'Edit');
      await panel().locator('#wfeditor').waitFor({ state: 'visible', timeout: 10_000 });

      const ship = panel().locator('#wfeditor .wcnode[data-node="ship"] .wegrip');
      const cell = panel().locator('#wfeditor .wccell[data-lane="s1"][data-row="4"]');
      const add = panel().locator('#wfeditor .wcaddstep[data-lane=""]');
      await add.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
      assert.ok(
        await add.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return (
            document
              .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              ?.closest('.wcaddstep') === node
          );
        }),
        'the origin Add step is under the pointer inside the visible canvas'
      );
      const from = await ship.boundingBox();
      const to = await cell.boundingBox();
      assert.ok(from && to, 'Ship and s1’s row 4 both have a box');
      assert.ok(
        await cell.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return (
            document.elementFromPoint(box.x + 30, box.y + box.height / 2)?.closest('.wccell') ===
            node
          );
        }),
        'the foreign row is under the intended release point'
      );

      // Two 382px lanes are wider than the smoke window's board: s1 sits past
      // the scroller's edge, and only its left side clears the dock. Aim just
      // inside it.
      const mouse = ctx.page.mouse;
      await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await mouse.down();
      const home = await add.boundingBox();
      assert.ok(home, 'this session’s Add step has a box');
      await mouse.move(home.x + home.width / 2, home.y + home.height / 2, { steps: 8 });
      await panel()
        .locator('#wfeditor .wcaddstep[data-lane=""].target')
        .waitFor({ timeout: 5_000 });
      await mouse.move(to.x + 30, to.y + to.height / 2, { steps: 8 });
      assert.equal(await panel().locator('#wfeditor .target').count(), 0);
      await mouse.up();
      await panel().locator('#wfeditor .wesave').click();
      await waitEditorClosed();

      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
        steps?: { id?: string; lane?: string; needs?: string[] }[];
      };
      const kept = saved.steps?.find((s) => s.id === 'ship');
      assert.equal(kept?.lane, undefined);
      assert.deepEqual(kept?.needs, ['build']);
    } finally {
      await ctx.page.mouse.up().catch(() => {});
      await fs.rm(file, { force: true });
      if (
        await panel()
          .locator('#wfeditor')
          .isVisible()
          .catch(() => false)
      ) {
        await panel()
          .locator('#wfeditor .weback')
          .click({ timeout: 5_000 })
          .catch(() => {});
        await waitEditorClosed().catch(() => {});
      }
    }
  });

  /**
   * Last, because it ends the session these tests share. End is the signal
   * every card has, and the one thing here that outlives the panel: the card
   * goes when the child does, and the child goes because its stdin closed.
   *
   * It is also what leaves the board clean for whatever scenario file the
   * barrel loads next.
   */
  /**
   * The seam under the composer's model pill: a pick really moves the child.
   *
   * The card's own model bit used to open this menu, and the case that stood
   * here proved the menu painted clear of the card's `overflow: hidden`. The
   * bit is a reading now — a pick from a board buys nothing until a turn runs
   * — so the only trigger left is the composer's, which sits in the dock and
   * clips nothing. What is worth a host is the other half: `chat_composer.test.ts`
   * proves the click holds a send target, `claude_session.test.ts` proves the target
   * puts one `set_model` on the pipe, and only here do the two join through a
   * real host.
   *
   * The *timing* is the part worth having: the change lands on the next turn's
   * `init`, not on the control response, so the card goes on saying the old
   * model until something runs. The fixture reports the model it was last set
   * to, so a client that answered the response and never sent the frame fails.
   */
  step('moves the child onto the model picked from the composer', async () => {
    const shown = () => card().locator('.s-model').textContent();
    // Case-insensitive since the bit spells the catalog's name — `Opus 5`,
    // not the id the CLI reported.
    assert.match((await shown()) ?? '', /opus/i, 'not starting where this case assumes');
    const rowBox = await panel().locator('#hintrow').boundingBox();
    const effortBox = await panel().locator('#ctools .fpill.effort').boundingBox();
    const sendBox = await panel().locator('#send').boundingBox();
    assert.ok(rowBox && effortBox && sendBox, 'the two target pills and Send are not on screen');
    assert.ok(
      effortBox.x + effortBox.width <= sendBox.x &&
        sendBox.x + sendBox.width <= rowBox.x + rowBox.width,
      'the target pills overflow the composer row'
    );
    const before = await waitSessionRecord(
      'the idle activity baseline',
      (session) => session.status === 'idle' && typeof session.updatedAt === 'number'
    );

    await panel().locator('#ctools .fpill.model').click({ timeout: 30_000 });
    const menu = panel().locator('#ctools .fmenu:not([hidden])');
    await menu.waitFor({ timeout: 30_000 });
    // This used to be three: the fake answered `list_models` with four rows and
    // the panel dropped the CLI's own `default`. The panel no longer asks the
    // fake — or any CLI — so the list is this brand's slice of
    // `core/catalog.ts`, and the count is read off it rather than pinned again.
    // What is proved is unchanged: the list arrived, populated, before a pick.
    //
    // **The same list the gear draws**, narrowed only by brand host-side
    // (`modelsForSession`): a Claude session cannot become a Grok one
    // mid-conversation. The window is not a filter — the row is never dropped,
    // and only the windows this session's own line and account cannot reach are
    // dimmed (`TASK_done_window_fixed.md`).
    //
    // **Models, not entries.** Shape B draws one row per model with a pill per
    // window, so the eighteen flattened entries are ten rows. Counted off the
    // offered list de-duplicated by `value` rather than pinned again — a
    // literal here would pass whatever the catalog said, and `CLAUDE_MODELS`
    // would be right by accident today and wrong the day a model gains a
    // window.
    const offered = catalogFor('claude');
    // `:not(.mfold)` because the row a brand's older models fold behind is an
    // `.mitem` itself (`drawRun`, `webview/board_settings.ts`) — a control, not
    // a model, and counting it read this eleven-model list as twelve.
    assert.equal(
      await menu.locator('.mitem:not(.mfold)').count(),
      new Set(offered.map((m) => m.value)).size,
      'the model list did not arrive'
    );
    // And the pills really reached this surface: a row with no window draws the
    // degraded single-control shape, which would pass the count above while
    // offering nothing to press.
    assert.ok(
      (await menu.locator('.wp').count()) >= offered.length,
      'the rows arrived without their windows'
    );

    // The pill, not the row: the row is `role="presentation"` and a click on it
    // does nothing at all.
    await menu
      .locator('.mitem', { hasText: 'Haiku 4.5' })
      .locator('.wp')
      .first()
      .click({ timeout: 30_000 });
    // The menu shuts on its own pick.
    await panel()
      .locator('#ctools .fmenu:not([hidden])')
      .waitFor({ state: 'detached', timeout: 30_000 });

    assert.match((await shown()) ?? '', /opus/i, 'an unsent pick moved the session');

    // A turn, because that is what makes the change observable at all.
    await send('hullo again');
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await waitSessionRecord(
      'the prompt advancing activity',
      (session) =>
        session.status === 'idle' &&
        session.model === 'claude-haiku-4-5' &&
        typeof session.updatedAt === 'number' &&
        session.updatedAt > (before.updatedAt ?? 0)
    );
    // `attached`, not the default `visible`: the dock is open for the whole of
    // this case, which leaves the card under the 180px compact breakpoint where
    // `.s-model` is deliberately `display: none` (css/board.ts — since alone is
    // enough in specs at that width). What is being proved is what the card
    // *says*, and a hidden node still says it; the opening assertion above
    // reads the same bit through `textContent` for the same reason.
    await panel()
      .locator(`#cards .card[data-pid="${owned}"] .s-model`, { hasText: 'haiku' })
      .waitFor({ state: 'attached', timeout: 30_000 });
  });

  /**
   * The legacy rows are reachable, which jsdom structurally cannot say.
   *
   * `.fmenu` is a capped scroller, so the question this asks — can a pointer get
   * to the bottom row at all — is a layout question, and every rect in jsdom is
   * zero. The separator scenarios in `model_picker_menu.test.ts` prove the *order*
   * the rows are built in and are blind to whether the last of them is on
   * screen.
   *
   * **The rule became a fold** (`08addb40`). `drawRun` draws one or the other
   * and never both, so the older rows no longer sit below a separator but behind
   * a control, drawn hidden rather than left out. Reaching them is two questions
   * now — does the fold open, and is what it reveals on screen — and this case
   * asks both. It matters more than an ordinary overflow case: reaching a model
   * the CLI stopped advertising is the whole reason the catalog exists. Picks
   * nothing — a second model switch would cost a turn to prove something this
   * case is not about.
   */
  step('reaches the legacy rows behind the fold, rather than clipping them', async () => {
    await panel().locator('#ctools .fpill.model').click({ timeout: 30_000 });
    const menu = panel().locator('#ctools .fmenu:not([hidden])');
    await menu.waitFor({ timeout: 30_000 });

    // Read off the offered list, not the authoring rows: what must be reachable
    // is a legacy row *this menu draws*. De-duplicated by `value` because the
    // fold counts rows and the catalog carries one entry per window.
    const legacy = new Set(
      catalogFor('claude')
        .filter((m) => m.legacy)
        .map((m) => m.value)
    );
    assert.ok(legacy.size, 'the catalog carries no legacy row to reach');

    const fold = menu.locator('.mitem.mfold').first();
    await fold.waitFor({ timeout: 30_000 });
    assert.equal(
      (await fold.locator('.nm').textContent())?.trim(),
      `${legacy.size} older`,
      'the fold stands for every legacy row the menu drew'
    );

    // It opens itself when the model in force is behind it, and the case above
    // leaves this session on whichever model it picked — so press only when it
    // is shut, and this reads the same either way.
    if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
    const last = menu.locator('.mitem:not(.mfold)').last();
    await last.waitFor({ state: 'visible', timeout: 30_000 });

    // **Not whether it scrolls.** This case asserted an overflow for as long as
    // the rows were a flat list, and with the fold open the list now fits the
    // cap — measured 2026-09-03, `scrollHeight` within a pixel of `clientHeight`
    // — because folding the older rows away is exactly what stopped the
    // clipping. The claim that survives the fix is the one the case was always
    // for: the row is *on screen*, whether or not a scroll was needed to reach
    // it. Kept as a `scrollIntoViewIfNeeded` so it still holds the day a fourth
    // brand puts the list back over the cap.
    await last.scrollIntoViewIfNeeded({ timeout: 30_000 });
    assert.ok(await last.isVisible(), 'the last row can be reached');

    const menuBox = await menu.boundingBox();
    const foldBox = await fold.boundingBox();
    const lastBox = await last.boundingBox();
    assert.ok(menuBox && foldBox && lastBox, 'the menu, the fold and the last row have boxes');
    // Inside the scroller and not merely painted somewhere: a clipped row is
    // visible to `isVisible` while hanging past the cap.
    assert.ok(
      lastBox.y >= menuBox.y - 1 && lastBox.y + lastBox.height <= menuBox.y + menuBox.height + 1,
      `the last row spans ${lastBox.y}-${lastBox.y + lastBox.height} and the menu ` +
        `${menuBox.y}-${menuBox.y + menuBox.height}`
    );
    // Below the fold once both are laid out — the ordering assertion in jsdom is
    // over DOM order, and this is the one over pixels.
    assert.ok(
      lastBox.y > foldBox.y,
      `the last row is at ${lastBox.y} and the fold at ${foldBox.y}`
    );

    // Shut it without picking, so the next case finds the session where this
    // one did.
    await composer().press('Escape');
    await panel()
      .locator('#ctools .fmenu:not([hidden])')
      .waitFor({ state: 'detached', timeout: 30_000 });
  });

  /**
   * What a dimmed window pill actually paints, and what hovering does not
   * repaint — **the two claims `npm run check` cannot make.** jsdom has no
   * cascade and no computed style, so every scenario there can say is which
   * class landed on which node; whether `.wp.off` dims anything, and whether a
   * hover rule outranks `.wp.on`, live only here.
   *
   * Both were real. The `.off` rule is this task's; the hover half is a
   * regression it caused and a review caught — `.wp:not(.off):hover` is (0,3,0)
   * against `.wp.on`'s (0,2,0), where the original `.wp:hover` was (0,2,0) and
   * lost by order, so adding the `:not()` quietly started repainting the pill
   * a reader's session is actually in.
   *
   * **The class is put on here rather than waited for**, and that is the point
   * of the case: which pill the host stamps depends on the account this machine
   * is signed into, so a scenario that waited for a dimmed pill would assert
   * nothing on half the machines and flake on the rest. What is under test is
   * the stylesheet, and the stylesheet does not care who stamped.
   */
  step('dims a fixed window pill, and leaves the one in force alone on hover', async () => {
    await panel().locator('#ctools .fpill.model').click({ timeout: 30_000 });
    const menu = panel().locator('#ctools .fmenu:not([hidden])');
    await menu.waitFor({ timeout: 30_000 });

    // The window in force, before anything hovers it.
    const on = menu.locator('.wp.on').first();
    await on.waitFor({ timeout: 30_000 });
    const paint = (where: Locator) =>
      where.evaluate((el) => {
        const css = getComputedStyle(el);
        return { border: css.borderTopColor, color: css.color, opacity: css.opacity };
      });
    const before = await paint(on);
    await on.hover({ timeout: 30_000 });
    assert.deepEqual(await paint(on), before, 'hover repainted the window in force');

    // A pill that is not the in-force one, dimmed the way the host would.
    const other = menu.locator('.wp:not(.on)').first();
    await other.evaluate((el) => el.classList.add('off'));
    const dimmed = await paint(other);
    assert.equal(dimmed.opacity, '0.45', 'a fixed pill is not dimmed');
    assert.equal(
      await other.evaluate((el) => getComputedStyle(el).cursor),
      'default',
      'a fixed pill still offers the pointer a press'
    );
    // And it stays dim under the pointer: a control that lights up on hover
    // reads as pressable however dim it started.
    await other.hover({ timeout: 30_000 });
    assert.deepEqual(await paint(other), dimmed, 'hover lit a fixed pill back up');

    await composer().press('Escape');
    await panel()
      .locator('#ctools .fmenu:not([hidden])')
      .waitFor({ state: 'detached', timeout: 30_000 });
  });

  /**
   * The window pill is big enough to press, **probed rather than rected.**
   *
   * `getBoundingClientRect` does not include a pseudo-element that overflows
   * its host, and the pill's target is exactly that: an absolutely positioned
   * `::before` at `inset: -3px -1px`. So a rect here would read the 46x24 of
   * paint, clear a floor of 24 for the wrong reason, and go on passing the day
   * somebody deletes the inset. Checked by deleting it, not by assuming.
   *
   * The method is `docs/design_tokens/lib/lift.mjs`'s `hitBox`, which is where
   * the reasoning lives: walk out from the drawn edge a pixel at a time and ask
   * the document what is under each point; the target is where the answer stops
   * being this node. `scrollIntoView` first — `elementFromPoint` answers only
   * for points inside the viewport, and this menu is a 260px scroller.
   *
   * SC 2.5.8's floor is 24, which `.fbtn` already sits exactly on.
   */
  step('gives the window pill a target a pointer can hit', async () => {
    await panel().locator('#ctools .fpill.model').click({ timeout: 30_000 });
    const menu = panel().locator('#ctools .fmenu:not([hidden])');
    await menu.waitFor({ timeout: 30_000 });

    // The smallest pill in the menu, because a control is as pressable as its
    // worst case rather than its roomiest.
    const worst = await menu.evaluate((box) => {
      const REACH = 24; // no pseudo-element on this panel claims more than a few px
      const hit = (node: Element): { w: number; h: number; drawn: number } | null => {
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const r = node.getBoundingClientRect();
        const mine = (x: number, y: number): boolean => {
          const at = document.elementFromPoint(x, y);
          return !!at && (at === node || node.contains(at));
        };
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (!mine(cx, cy)) return null; // covered, or clipped away entirely
        const over = (x: number, y: number, dx: number, dy: number): number => {
          let n = 0;
          while (n < REACH && mine(x + dx * (n + 1), y + dy * (n + 1))) n++;
          return n;
        };
        return {
          w: r.width + over(r.left, cy, -1, 0) + over(r.right, cy, 1, 0),
          h: r.height + over(cx, r.top, 0, -1) + over(cx, r.bottom, 0, 1),
          drawn: r.height
        };
      };
      let small: { w: number; h: number; drawn: number } | null = null;
      for (const node of box.querySelectorAll('.wp')) {
        const one = hit(node);
        if (!one) continue;
        if (!small || Math.min(one.w, one.h) < Math.min(small.w, small.h)) small = one;
      }
      return small;
    });

    assert.ok(worst, 'no window pill answered elementFromPoint — covered or clipped');
    assert.ok(
      worst.h >= 24 && worst.w >= 24,
      `the smallest window pill takes a ${worst.w}x${worst.h} press, under SC 2.5.8's 24`
    );
    // The claim that would survive the ::before being deleted, stated so the
    // case above cannot quietly become one about paint: the target is taller
    // than what is drawn.
    assert.ok(
      worst.h > worst.drawn,
      `the pill's target is ${worst.h} against ${worst.drawn} drawn — the ::before reaches nothing`
    );

    await composer().press('Escape');
    await panel()
      .locator('#ctools .fmenu:not([hidden])')
      .waitFor({ state: 'detached', timeout: 30_000 });
  });

  /**
   * The dock paints every session into one `#thread`, so a position left in it
   * is the last reader's unless it is written down against a pid — which is why
   * reading one session to its top used to open the next one standing at its
   * top too.
   *
   * jsdom holds that bookkeeping (`chat_place.test.ts`),
   * but only against a ruler it is lent: it stores `scrollTop` and overflows
   * nothing, so it cannot say whether a reader parked at the top of a real
   * thread is still there after a detour. Same shape as the drawer rail's
   * scroll, and here for the same reason.
   *
   * One direction only. The fixture session's transcript is four entries and
   * does not overflow, so it is at its top and its bottom at once — what it can
   * do is be somewhere else in between, which is the whole of what this needs.
   */
  step('gives a session back its own place in the thread', async () => {
    const thread = panel().locator('#thread');
    const scroll = (): Promise<number> => thread.evaluate((n) => n.scrollTop);
    // Nothing before this leaves a thread taller than the box, and a thread that
    // fits keeps no place at all. `spool` is the fake's long answer — check any
    // new keyword against the list above `turn` in `fixtures/fake-cli.ts`.
    await send('spool it out');
    await panel()
      .locator('#thread .turn.assistant.live', { hasText: 'Line 39 of an answer' })
      .waitFor({ timeout: 30_000 });
    const room = await thread.evaluate((n) => n.scrollHeight - n.clientHeight);
    assert.ok(
      room > 100,
      `this session's thread does not overflow (${room}px), so it keeps no place`
    );

    await thread.evaluate((n) => {
      n.scrollTop = 0;
    });
    // Somebody else's session, and back.
    await panel().locator(`#cards .card[data-pid="${fixturePid}"]`).click({ timeout: 30_000 });
    await panel()
      .locator('#chat-head span.name', { hasText: FIXTURE_NAME })
      .waitFor({ timeout: 30_000 });
    await card().click({ timeout: 30_000 });
    await panel().locator('#thread', { hasText: 'spool it out' }).waitFor({ timeout: 30_000 });

    // The place is taken twice — once as the turns land, once against the
    // composer after it settles — so this waits for the second rather than
    // reading between them.
    for (let tries = 0; (await scroll()) !== 0 && tries < 30; tries++) {
      await ctx.page.waitForTimeout(100);
    }
    assert.equal(
      await scroll(),
      0,
      'the session came back standing somewhere its reader never left it'
    );

    // Left idle for the case below, which is the rule this whole file runs on.
    await panel().locator('#chat-interrupt').click();
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  });

  /**
   * The half of `#thread.resizing` (`css/chat.ts`) that only a host can pose.
   * While that class is on, a turn which has never been on screen stands at a
   * guessed 140px instead of its own height, so every offset in the thread is
   * wrong by however much of it is above the reader — and the thread's own
   * measurements are what a drag would otherwise put them back by.
   *
   * `dock.test.ts` poses the class and the scoping and says in its own comment
   * that this is all it can: jsdom's every rect is zero, `offsetTop` included,
   * so a position assertion there passes without measuring anything. This is
   * the measurement. Ungated it is not a near miss — a headless run of the same
   * shape put the held turn 32334px out of place.
   *
   * Read by index rather than by identity, because the fold can legitimately
   * move: the turn a reader stands inside re-wraps shorter as the dock widens,
   * and the next one can cross above them. What must not move is the turn they
   * were on, and how far under the fold it sits.
   */
  step('leaves the reader on the same turn when the divider moves', async () => {
    const thread = panel().locator('#thread');
    // `spool` stays open until interrupted, so the geometry is measured while
    // this reply is streaming rather than against a retained earlier reply.
    await send('spool it out for the drag');
    await panel()
      .locator('#thread .turn.assistant.live', { hasText: 'Line 39 of an answer' })
      .waitFor({ timeout: 30_000 });

    // A quarter down, not half. The dock reaches this case at its 280px floor,
    // so the only direction the divider has is wider — which re-wraps 40
    // paragraphs into fewer lines and takes the thread with it, measured 1663px
    // down to 1003px over a 535px box. A reader parked deep in a thread that
    // then shrinks is clamped by the scroller itself, and no anchoring keeps a
    // position the content no longer has: at half, the anchor wanted 564 of a
    // scroller that now ends at 468. A quarter still leaves a whole turn off
    // screen above them, which is the thing being posed.
    const dock = await panel().locator('#dock').boundingBox();
    assert.ok(dock, 'the dock is not on screen');
    try {
      await thread.evaluate((n) => {
        n.scrollTop = Math.floor((n.scrollHeight - n.clientHeight) / 4);
      });
      /** The turn at the fold: its index, its opening words, and how far under
       *  the fold its top sits. */
      const read = (at?: number) =>
        thread.evaluate((n, want) => {
          let i = want ?? 0;
          if (want === undefined) {
            for (let k = 0; k < n.childElementCount; k++) {
              if ((n.children[k] as HTMLElement).offsetTop <= n.scrollTop) i = k;
            }
          }
          const kid = n.children[i] as HTMLElement | undefined;
          if (!kid) return undefined;
          return {
            at: i,
            under: n.scrollTop - kid.offsetTop,
            text: (kid.textContent ?? '').slice(0, 40),
            above: kid.offsetTop,
            height: n.scrollHeight
          };
        }, at);

      const before = await read();
      assert.ok(before, 'the thread has no turns to stand in');
      // A reader inside the first turn has nothing off screen above them, so
      // there is no guessed height to be wrong about and the case poses nothing.
      assert.ok(
        before.at > 0 && before.above > 20,
        `the reader is standing in turn ${before.at}, ${before.above}px down the thread — no turn is off screen above them`
      );

      // 200px of dock, taken off the board. Not the panel's edge: `#nav` spans
      // the board only, so its right edge is where the divider already is, and
      // the dock arrives at its floor, so a drag the other way is clamped to
      // the width it started at and poses nothing.
      await dragDivider(dock.x - 200);

      const after = await read(before.at);
      assert.ok(after, 'the turn the reader was on left the thread');
      assert.equal(after.text, before.text, 'the thread was rebuilt under the drag');
      assert.ok(
        after.height !== before.height,
        `the thread did not re-wrap (${before.height}px both sides), so no offset in it moved and nothing was posed`
      );
      assert.ok(
        Math.abs(after.under - before.under) <= 2,
        `the reader ended ${after.under - before.under}px off the turn they were reading`
      );
    } finally {
      // Both in a finally, the way the nav ladder in `panel.smoke.ts` puts its
      // divider back, and for a sharper reason than tidiness: a failure above
      // leaves the turn open, and stopping a *busy* session raises a workbench
      // confirm that nothing in this suite answers. The case below then spends
      // its whole 60s behind a modal and reads as the broken one, while the
      // divider it inherits is wherever this stopped.
      await dragDivider(dock.x);
      const stop = panel().locator('#chat-interrupt');
      if (await stop.isVisible()) await stop.click();
      await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    }
  });

  /**
   * The trailing room, which only a host has the layout to produce.
   *
   * A prompt can be lifted to the top of the thread only while its `offsetTop`
   * is inside `scrollHeight - clientHeight`, and until `fitRoom` the newest ones
   * never were: nothing follows them but their own replies, so the last
   * screenful of prompts could not reach the top however far the arrow scrolled.
   * `chat_composer.test.ts` runs its tail scenarios against a ceiling it is
   * *lent* — jsdom lays nothing out and clamps nothing, so the arithmetic there
   * is real and the geometry is a fake. This is the geometry, and it is the
   * claim the previous fix's own commit message said only a host could settle.
   *
   * Short turns, and several of them, because the room is the shortfall between
   * the newest exchange and the height of the box: a thread has to overflow
   * before it needs any, and its newest reply has to be short before there is
   * any to need. `spool` above is the opposite shape and produces none. Each
   * send here is a turn the panel keeps in its own record, so they stack.
   */
  step('lifts the newest prompt to the top of the thread', async () => {
    const thread = panel().locator('#thread');
    // Following, first. The case above leaves its reader parked a quarter down
    // the thread, and a reader who is not at the end is not moved to it — so
    // without this the sends below land under a thread nobody is following and
    // the rest position asserted at the end is the previous case's.
    //
    // The end of the *content*, and not `scrollHeight`, which is the end of the
    // room under it. Those were the same pixel before the room existed and are
    // not now: a reader at the far edge is standing in the blank, which is a
    // place they chose, and this fixture answers in about a millisecond — the
    // reply lands between two polls, so the panel never sees `busy` and a
    // parked reader is left where they parked. Aim where a follower rests.
    //
    // And wait to have been heard. The browser delivers the scroll event a
    // frame after the write, and the panel takes the pin off that event. A
    // send in the same frame paints a turn under a reader the panel has not
    // yet been told is at the end, so the event, when it lands, measures them
    // short of an end that has moved and unpins them — and nothing follows
    // after that. Measured 2026-09-05 with a probe on the pin: the send's
    // paint landed 13ms after the aim and the event 3ms after that, reading
    // 88px short, and the case ended 167px short of the tail — the same figure
    // on all five red runs, because the order never varied.
    await thread.evaluate(
      (n) =>
        new Promise<void>((resolve) => {
          const room = parseFloat(n.style.getPropertyValue('--room')) || 0;
          const to = n.scrollHeight - n.clientHeight - room;
          // An unchanged position fires no scroll event — a reader already
          // there, or a write the browser clamps back to where they are — and
          // `evaluate` has no timeout, so a listener left waiting would hang
          // the file rather than redden it.
          if (Math.abs(n.scrollTop - to) < 1) return resolve();
          n.addEventListener('scroll', () => resolve(), { once: true });
          const was = n.scrollTop;
          n.scrollTop = to;
          if (n.scrollTop === was) resolve();
        })
    );
    // Three, and the thread this case inherits carries the rest. Each is waited
    // for as a turn and then to idle, because a send landing on a session still
    // running the one before it queues into the outbox — and the outbox is not
    // a turn, so it would leave the tail a prompt short with nothing failing.
    // Not the `.sending` echo, which matches the instant Enter is acked: the
    // fixture answers before the panel sees busy, so the next send lands while
    // this one is still held and the two merge into one turn (`mergeQueued`) —
    // on the base too, seen 2026-10-01 with a probe on a green run.
    for (let i = 1; i <= 3; i++) {
      await send(`tail ${i}`);
      await panel()
        .locator('#thread .turn.user:not(.sending)', { hasText: `tail ${i}` })
        .waitFor({ timeout: 30_000 });
      await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    }
    // A send that lands while the one before it is still running is held rather
    // than refused, and a held row is not a turn — so the tail is only what it
    // reads as once the outbox has drained and the last of them is on screen.
    await panel().locator('#thread .outbox').waitFor({ state: 'detached', timeout: 30_000 });
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    await panel()
      .locator('#thread .turn.user:not(.sending)', { hasText: 'tail 3' })
      .waitFor({ timeout: 30_000 });

    /** Every prompt's offset, where the scroller stops, and the room under it. */
    const geometry = () =>
      thread.evaluate((n) => ({
        tops: [...n.querySelectorAll('.turn.user:not(.peer)')].map(
          (p) => (p as HTMLElement).offsetTop
        ),
        texts: [...n.querySelectorAll('.turn.user:not(.peer)')].map(
          (p) => p.querySelector('.body')?.textContent ?? ''
        ),
        max: n.scrollHeight - n.clientHeight,
        room: parseFloat(n.style.getPropertyValue('--room')) || 0,
        top: n.scrollTop,
        kids: n.childElementCount
      }));

    /**
     * A reading taken once two 500ms apart agree.
     *
     * **`idle` is not rest.** The record goes on catching up with the sends
     * above for a beat after the status flips, and the pin lands on the paint
     * that brings the last of it: read before that and the reader is still
     * short of the tail. The end state was never in doubt; this is how the case
     * waits for one. A reader left *past* the end was a different fault and a
     * real one, fixed in `fitRoom` rather than waited out — and the 167px
     * *short* this was first written against, on 2026-09-03, was a third: the
     * aim above landing unheard, which no wait here could take back.
     */
    const settled = async () => {
      let prev = await geometry();
      for (let i = 0; i < 20; i++) {
        await ctx.page.waitForTimeout(500);
        const next = await geometry();
        if (
          next.top === prev.top &&
          next.max === prev.max &&
          next.room === prev.room &&
          next.kids === prev.kids
        ) {
          return next;
        }
        prev = next;
      }
      return prev;
    };

    const before = await settled();
    assert.ok(
      before.max > 100,
      `this thread does not overflow (${before.max}px) and needs no room`
    );
    assert.ok(
      before.room > 0,
      'the newest exchange fills the box on its own, so no room was called for and nothing is posed'
    );
    // The whole of the fix, in one reading: the last prompt is addressable.
    const last = before.tops[before.tops.length - 1] ?? -1;
    assert.ok(
      before.max >= last,
      `the newest prompt is ${last}px down and the scroller stops at ${before.max}`
    );
    // And the reader rests at the end of the conversation rather than at the end
    // of the room — the pin, unchanged, against a thread that now has both.
    assert.ok(
      Math.abs(before.top - (before.max - before.room)) <= 2,
      `a followed session came to rest ${before.top - (before.max - before.room)}px into the blank ` +
        `(top ${before.top}, max ${before.max}, room ${before.room}, end of content ` +
        `${before.max - before.room})`
    );

    // Up puts the prompt it names at the very top of the box, twice over. This
    // is what the reader reported: near the end it used to scroll only far
    // enough to bring the prompt on screen, leaving it in the lower half.
    await panel().locator('#prompt-bar .up').click();
    const once = await geometry();
    // Against the thread rather than against a literal: a send held behind the
    // one before it is merged into one turn by the drain, so how many prompts
    // three sends leave is the outbox's business and not this case's. What is
    // asserted is that the bar and the scroll name the same one.
    assert.equal(
      await panel().locator('#prompt-bar .txt').textContent(),
      once.texts.at(-2),
      'the bar named a prompt other than the one the arrow scrolled to'
    );
    assert.ok(
      Math.abs(once.top - (once.tops.at(-2) ?? -1)) <= 2,
      `the seventh prompt sits ${(once.tops.at(-2) ?? 0) - once.top}px below the top of the thread`
    );
    await panel().locator('#prompt-bar .up').click();
    const twice = await geometry();
    assert.ok(
      Math.abs(twice.top - (twice.tops.at(-3) ?? -1)) <= 2,
      `the sixth prompt sits ${(twice.tops.at(-3) ?? 0) - twice.top}px below the top of the thread`
    );

    // And the room is somewhere a reader can stay. Scrolled into by hand — the
    // arrows park a cursor and `repin` has always declined those, so the press
    // above poses the easy half. A hand scroll clears the cursor, which used to
    // leave the reader indistinguishable from one resting on the tail: `repin`
    // asserted the end on the next repaint and the room could be scrolled into
    // and never stayed in.
    //
    // Only a host can pose this. jsdom has the arithmetic but neither the
    // layout that produces a room nor the 3s poll that used to spend it, so the
    // wait below is the whole point — two of them, against a card reading idle.
    //
    // Idle and still moving: the panel's record goes on catching up with the
    // sends above for seconds after the status flips, and the reply body
    // landing counts as the conversation growing. A gate on growth alone
    // followed it and moved the reader 422px here. `t.status === 'busy'` is
    // what says the difference between a session speaking and one whose record
    // is still being read.
    // Well inside the room rather than against its far edge. The edge is where
    // the browser's own clamp lives: the panel reconciles its record — an empty
    // assistant shell went away here, twice, on the poll after the sends — and
    // a thread that loses a turn loses scroll range, taking a reader standing
    // on the last pixel of it down by the difference. That is the clamp and not
    // `repin`, it moved this reader 41.5px with the fix in, and posing it here
    // would measure the browser instead of the thing under test.
    await thread.evaluate((n) => {
      n.scrollTop = n.scrollHeight - n.clientHeight - 60;
    });
    const parked = await geometry();
    assert.ok(
      parked.top > parked.max - parked.room,
      `the scroller stopped ${parked.max - parked.room - parked.top}px short of the room`
    );
    await ctx.page.waitForTimeout(7_000);
    const held = await geometry();
    assert.ok(
      Math.abs(held.top - parked.top) <= 2,
      `two polls moved the reader ${parked.top - held.top}px back towards the tail ` +
        `(${parked.kids} turns and ${parked.room}px of room became ${held.kids} and ${held.room})`
    );

    // And the room survives leaving the session and coming back to it. Here
    // rather than in jsdom because an arrival rebuilds every turn: the tail
    // scenarios there lend `offsetTop` to the elements themselves, and the
    // elements a switch returns to are new ones, so the room collapses to 0 and
    // the reading would be of the ruler rather than of the panel.
    //
    // `spoken` holds how much the conversation had said when the thread was
    // last painted, and on an arrival that reading is the other session's — a
    // shorter one there reads as turns having landed in this one. `place`
    // stands the reader back in the room before `repin` runs, so that
    // misreading lands as an override of the restore. The guard is
    // `painted === t.pid` in `renderThread`.
    await panel().locator(`#cards .card[data-pid="${fixturePid}"]`).click({ timeout: 30_000 });
    await panel().locator('#thread .turn', { hasText: 'tail 3' }).waitFor({
      state: 'detached',
      timeout: 30_000
    });
    await card().click({ timeout: 30_000 });
    await panel().locator('#thread .turn.user', { hasText: 'tail 3' }).waitFor({ timeout: 30_000 });
    const back = await geometry();
    assert.ok(
      back.top > back.max - back.room + 20,
      `coming back put the reader ${back.max - back.room - back.top}px from the end of the ` +
        `content, and they left ${parked.max - parked.room - parked.top}px past it`
    );
  });

  step('reveals off-screen current prompts before stepping back', async () => {
    const thread = panel().locator('#thread');
    await thread.evaluate(
      (node) =>
        new Promise<void>((resolve) => {
          node.addEventListener('scroll', () => resolve(), { once: true });
          const was = node.scrollTop;
          node.scrollTop = node.scrollHeight;
          if (node.scrollTop === was) resolve();
        })
    );

    await send('spool reveal current');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    await panel()
      .locator('#thread .turn.assistant.live', { hasText: 'Line 39 of an answer' })
      .waitFor({ timeout: 30_000 });

    const geometry = () =>
      thread.evaluate((node) => {
        const prompts = [...node.querySelectorAll<HTMLElement>('.turn.user:not(.peer)')];
        const current = prompts.at(-1);
        const previous = prompts.at(-2);
        return {
          top: node.scrollTop,
          currentTop: current?.offsetTop ?? -1,
          currentBottom: current ? current.offsetTop + current.offsetHeight : -1,
          previousTop: previous?.offsetTop ?? -1,
          previousBottom: previous ? previous.offsetTop + previous.offsetHeight : -1,
          olderTop: prompts.at(-3)?.offsetTop ?? -1
        };
      });

    let before = await geometry();
    for (let i = 0; i < 20 && before.currentBottom > before.top; i++) {
      await ctx.page.waitForTimeout(100);
      before = await geometry();
    }
    assert.ok(
      before.currentBottom <= before.top,
      `the current prompt still intersects the viewport (${JSON.stringify(before)})`
    );
    const count = await panel().locator('#prompt-bar .count').textContent();
    const [at, total] = count?.split('/') ?? [];
    assert.equal(at, total, `the bar is not naming its newest prompt (${count ?? 'empty'})`);

    await panel().locator('#prompt-bar .up').click();
    const once = await geometry();
    assert.equal(await panel().locator('#prompt-bar .count').textContent(), count);
    assert.ok(
      Math.abs(once.top - once.currentTop) <= 2,
      `the current prompt sits ${once.currentTop - once.top}px below the top of the thread`
    );

    await panel().locator('#prompt-bar .up').click();
    const twice = await geometry();
    assert.ok(
      Math.abs(twice.top - twice.previousTop) <= 2,
      `the previous prompt sits ${twice.previousTop - twice.top}px below the top of the thread`
    );

    await thread.evaluate((node) => {
      const prompts = [...node.querySelectorAll<HTMLElement>('.turn.user:not(.peer)')];
      const current = prompts.at(-1);
      const previous = prompts.at(-2);
      if (current && previous) {
        node.scrollTop = Math.min(
          current.offsetTop - 1,
          previous.offsetTop + previous.offsetHeight + 1
        );
      }
    });
    const previousCount = `${Number(total) - 1}/${total}`;
    await panel()
      .locator('#prompt-bar .count', { hasText: previousCount })
      .waitFor({ timeout: 5_000 });
    const away = await geometry();
    assert.ok(
      away.previousBottom <= away.top && away.top < away.currentTop,
      `the previous prompt was not wholly above the view before the current one (${JSON.stringify(away)})`
    );

    await panel().locator('#prompt-bar .up').click();
    const restored = await geometry();
    assert.equal(await panel().locator('#prompt-bar .count').textContent(), previousCount);
    assert.ok(
      Math.abs(restored.top - restored.previousTop) <= 2,
      `the previous prompt sits ${restored.previousTop - restored.top}px below the top of the thread`
    );

    await panel().locator('#prompt-bar .up').click();
    const older = await geometry();
    assert.ok(
      Math.abs(older.top - older.olderTop) <= 2,
      `the older prompt sits ${older.olderTop - older.top}px below the top of the thread`
    );
  });

  step('ends the session, returns to the main draft, and removes its card', async () => {
    await card().click();
    await panel().locator('#chat:not(.empty)').waitFor({ timeout: 30_000 });
    const width = await dockWidth();
    await endCard(owned);
    await assertMainDraft(width);
  });

  /**
   * **`squadron.efforts` reaching a real child, which is the one span nothing
   * else covers.**
   *
   * The setting used to be read inside `startOwned`, moments before launch, so a
   * draft's brand and model were decided at one time and paired with an
   * application-wide effort read at another. It travels on the launch target now
   * (`TASK_done_launch_target.md`): read once into the state push, folded
   * into the draft's pick, carried on the `open`, rebuilt into a target at
   * `panel.ts`'s dispatch, and handed to `cli.launch` and `cli.connect` off one
   * local.
   *
   * jsdom holds every hop up to the posted `open`
   * (`model_picker_draft.test.ts` and `model_picker_menu.test.ts`) and
   * `adapter.test.ts` holds the far end. **Between them is `host/`, which has no
   * unit test at all**, and where a target can be dropped with no compile error:
   * `panel.ts` used to hand its whole message to these verbs, which type-checks
   * against a nested parameter while delivering nothing.
   *
   * Matched by what the log gained while this scenario was starting a child.
   * It used to match `--name effort probe`, until e39d1dfd stopped a typed
   * prompt going out as one — a crop is `placeholder` now and never reaches a
   * command line, so the flag this waited on can no longer appear. Counting
   * spawns from zero is still wrong for the reason it always was: the barrel
   * runs this file after others, and the board it inherits is not this
   * scenario's to predict. A snapshot taken immediately before the start makes
   * that inheritance irrelevant without needing a name.
   */
  /** Every launch line the Claude fixture has recorded, oldest first. An absent
   *  file is no spawn yet, which is an empty list rather than an error. */
  const readArgv = async (file: string): Promise<string[][]> => {
    try {
      const text = await fs.readFile(file, 'utf8');
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };

  /**
   * Poll that log until it holds the launch this scenario started.
   *
   * Read once, this raced. `waitForNewPid` answers with the first card on the
   * board that was not there a moment ago, which is not necessarily the child
   * this scenario just asked for — the poll re-reading a session file draws one
   * too, and it arrives already idle, so the wait above it is satisfied by a
   * card nobody here started. The log was then read before our own launch had
   * been appended, and the failure named every line except the one it wanted.
   * Twice in a barrel under load, green alone both times after.
   */
  const waitForLaunch = async (
    before: string[][],
    ms = 30_000
  ): Promise<{ lines: string[][]; ours: string[][] }> => {
    const start = Date.now();
    for (;;) {
      const lines = await readArgv(argvLogPath());
      // Appended oldest-first, so what arrived since the snapshot is a slice.
      // `--session-id` is what tells a launch from the `auth status --json`
      // probes the same fixture records, which land on their own schedule and
      // would otherwise answer this wait with a line nobody here asked for.
      const ours = lines.slice(before.length).filter((argv) => argv.includes('--session-id'));
      if (ours.length > 0 || Date.now() - start > ms) return { lines, ours };
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  step('carries the effort setting from the gear onto the launch line', async () => {
    const NAME = 'effort probe';
    let started: string | undefined;
    try {
      await patchSettings({
        'squadron.model': 'claude-fable-5-1',
        // Not Fable's native `high`: a start that ignored the setting would
        // land there anyway and pass.
        'squadron.efforts': { 'claude-fable-5-1': 'medium' }
      });
      // A full poll on top of `patchSettings`' own wait. That helper sleeps
      // 1500ms while `POLL_MS` is 3000, so the state push carrying the new value
      // can still be in flight — and a draft seeds its pick **once**, on the
      // first paint with a model list, so one opened a moment early takes the
      // effort that was there then and never revisits it.
      await ctx.page.waitForTimeout(4000);

      const before = await pids();
      const loggedBefore = await readArgv(argvLogPath());
      await startFromDraft(NAME);
      started = await waitForNewPid(before);
      const live = panel().locator(`#cards .card[data-pid="${started}"]`);
      await live.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });

      const { lines, ours } = await waitForLaunch(loggedBefore);
      assert.equal(
        ours.length,
        1,
        `expected one launch since the draft, saw ${JSON.stringify(lines.map((a) => a.join(' ')))}`
      );
      const argv = ours[0] ?? [];
      const at = argv.indexOf('--effort');
      assert.ok(at >= 0, `no --effort on the launch line: ${JSON.stringify(argv)}`);
      assert.equal(argv[at + 1], 'medium');
    } finally {
      if (started) await endCard(started);
      // In `finally`. Left set, it put an extra bit on every card's specs row
      // and an extra flag on every launch line, and once took 42 tests down
      // across six files; the reset before the next section now rewrites the
      // settings either way.
      await patchSettings({ 'squadron.model': '', 'squadron.efforts': {} });
    }
  });

  /**
   * Nothing replies to an end, so the card spins from the send until its child
   * is seen to exit, and only then leaves. `eof-hold` keeps the fake alive 3s
   * past its stdin closing — the gap this step reads. Host-only: the registry
   * that holds the card until the exit is `host/sessions.ts`.
   */
  step('spins a card from its end until the process exits', async () => {
    const before = await pids();
    await startFromDraft('eof-hold');
    const started = await waitForNewPid(before);
    const card = panel().locator(`#cards .card[data-pid="${started}"]`);
    await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    const assertNoFlash = await observeEnd(started);
    await card.locator(`[data-key="${started}:close"]`).click();
    const confirm = panel()
      .locator('#cscrim')
      .getByRole('button', { name: 'End session', exact: true });
    await confirm.waitFor({ timeout: 30_000 });
    await confirm.click();
    await card.and(panel().locator('.closing')).waitFor({ timeout: 2_500 });
    assert.equal(await card.locator('.pill').textContent(), 'Ending…');
    await card.waitFor({ state: 'detached', timeout: 30_000 });
    await assertNoFlash();
  });
});
