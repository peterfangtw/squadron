import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import { projectSlug } from '../../core/claude/transcript';
import { ctx, openPanel, panel, section, step } from './boot';
import { composer, FIXTURE_NAME, fixtureSession } from './kit';

/**
 * What the panel says, and where it says it.
 *
 * Only a host can answer this. `setStatusBarMessage` and `showInformationMessage`
 * are both `vscode.window` calls that return nothing and assert nothing — under
 * jsdom neither exists, and a scenario there could not tell a routine
 * confirmation that moved to the status bar from one that still toasts. The
 * workbench draws them in two different places, and this file reads both.
 *
 * The rule being pinned (taskhub H27): a confirmation of something the board or
 * the dock is about to show anyway goes to the status bar and raises **no**
 * notification, because a reader who mutes the stream to stop dismissing those
 * also mutes every refusal. `notifyWaiting` is the deliberate exception.
 *
 * The census of all 30 call sites, and which kind each one is, is
 * `docs/reference/panel_notices.md`. Two of the four routine paths are not
 * reachable from one window — a start and a resume in *another* window's group
 * need a second host — so this file covers what one window can reach and the
 * census carries the rest.
 */

/** The workbench's notification stack, which is the thing H27 is about. */
const TOASTS = '.notifications-toasts';

/** What the status bar reads right now, whole. */
const barText = (): Promise<string> => ctx.page.locator('.statusbar').innerText();

/**
 * The bar, once it says this — because a click and the line it causes are on
 * opposite sides of the webview→host hop, and `copyRef` awaits the clipboard
 * before it speaks. Reading the bar on the line after the click reads it before
 * the host has run, which is a race the fast paths here happened to win.
 *
 * Bounded well inside `STATUS_MS` (3000): `setStatusBarMessage` takes the line
 * back down when it expires, so a poll that outlasts it would watch the thing
 * it is waiting for arrive and then leave. Reports the last text it saw, so a
 * genuine failure still names what the bar said instead.
 */
async function barSays(re: RegExp): Promise<void> {
  let last = '';
  for (let waited = 0; waited < 2500; waited += 100) {
    last = await barText();
    if (re.test(last)) return;
    await ctx.page.waitForTimeout(100);
  }
  assert.match(last, re);
}

/**
 * No notification, given a moment for one to have arrived.
 *
 * The wait is the whole assertion: a toast raised by the click under test would
 * be up well inside it, so an empty stack after it is evidence rather than a
 * race won. `.notifications-toasts` stays in the DOM with no children between
 * notifications, so this counts toasts and not the container.
 */
async function noToast(): Promise<void> {
  await ctx.page.waitForTimeout(1000);
  const count = await ctx.page.locator(`${TOASTS} .notification-toast`).count();
  assert.equal(count, 0, 'a routine confirmation raised a notification');
}

/** Empty the stack, so the next assertion reads its own click and not a leftover. */
async function clearToasts(): Promise<void> {
  await ctx.page.keyboard.press('ControlOrMeta+Shift+P');
  await ctx.page.keyboard.type('Notifications: Clear All Notifications');
  await ctx.page.keyboard.press('Enter');
  await ctx.page.waitForTimeout(500);
}

/** Type into the selected session's composer and send it, which is how a turn
 *  the fake CLI scripts is asked for. */
async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press('Enter');
}

section('what the panel says, and where', () => {
  before(async () => {
    await openPanel();
    await fixtureSession();
  });

  /**
   * A copy is the precedent the rest of H27 followed, and it had this ending
   * before the row existed: the reference is about to be pasted, so a toast to
   * dismiss is in the way of the paste.
   */
  step('confirms a copy in the status bar, and raises nothing', async () => {
    const card = panel().locator('.card').first();
    await card.waitFor({ timeout: 30_000 });
    await card.click();
    await clearToasts();

    // Scoped to the card: the dock head carries the same control for the
    // selected session, and either would do — but only one of them is `.card`.
    await card.locator('button[data-act="copyRef"]').click();
    await barSays(/Copied a reference to/);
    await noToast();
  });

  /**
   * Resume a conversation whose session never stopped. The dock swaps to that
   * card on the next line of `resume()`, so the confirmation is explaining a
   * substitution the reader can already see — status bar, not a toast.
   *
   * The conversation is written here rather than in `boot.ts` because it must
   * name the fixture session's own `sessionId` — the branch under test is the
   * one that finds a live session with that id, and a row for any other
   * conversation would spawn a child instead. That id is assigned at spawn
   * since row 71, so it is read off `fixtureSession()` rather than being the
   * literal `smoke` a discovered fixture could fix up front.
   *
   * **The row is found by the fixture's name, not by the prompt written here.**
   * `listConversations` merges the stated names in, and a stated name outranks
   * the title a first prompt derives — so this row reads `smoke session` and
   * the prompt below is only what makes the file a conversation at all.
   */
  step('confirms a resume of a running conversation in the status bar', async () => {
    const { sessionId } = await fixtureSession();
    const project = path.join(ctx.home, 'project');
    const dir = path.join(ctx.home, '.claude', 'projects', projectSlug(project));
    await fs.mkdir(dir, { recursive: true });
    // Overwrites the transcript the fixture adopted; the next section's reset
    // puts it back.
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        cwd: project,
        message: { role: 'user', content: 'a conversation the picker can list' }
      }) + '\n'
    );
    await clearToasts();

    await panel().locator('[data-act="resume"]').first().click();
    const row = panel().locator('.pit', { hasText: FIXTURE_NAME });
    await row.waitFor({ timeout: 30_000 });
    await row.click();

    await barSays(/still running — its card is on the board/);
    await noToast();
  });

  /**
   * The one notice that survives as a notification, and the reason it does: it
   * reports something the reader is not looking at. Everything else the panel
   * had to say confirmed something already on screen.
   *
   * **The fixture is blocked rather than rewritten.** It used to be a
   * discovered session whose `status` this file wrote straight into its pid
   * file; since row 71 the board is this window's own children, and an owned
   * session's state is what its frames say. So the turn is a real one: the fake
   * CLI's `write` script opens a `Write` permission, which `core/live.ts` reads
   * as `waiting` with `permission prompt` behind it.
   *
   * Answered in a `finally` — a dialog left open puts `#scrim` over the board
   * for every later step in this section, which reads as those steps failing
   * rather than this one.
   */
  step('still raises a notification when a session goes waiting', async () => {
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();
    await panel().locator('#chat').waitFor({ timeout: 10_000 });
    await clearToasts();
    try {
      await send('write');
      const toast = ctx.page.locator(`${TOASTS} .notification-toast`).first();
      await toast.waitFor({ timeout: 30_000 });
      const text = await toast.innerText();
      assert.match(text, /permission prompt/);
      // `'Open'` is the half a status-bar line could not carry: it clicks
      // through to the session it names.
      assert.match(text, /Open/);
    } finally {
      await panel().locator('#qlaunch').click();
      const dlg = panel().locator('#question .pdlg').first();
      await dlg.waitFor({ timeout: 10_000 });
      await dlg.locator('.pallow').first().click();
      await panel().locator('#qlaunch').waitFor({ state: 'hidden', timeout: 30_000 });
      await clearToasts();
    }
  });
});
