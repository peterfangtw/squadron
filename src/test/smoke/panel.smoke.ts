import { clearComposer, composer, openDraft, pickDraftModel, signCodex } from './kit';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ctx, homeDir, panel, passOnboarding, patchSettings, section, step } from './boot';
import { dragDivider, FIXTURE_NAME, fixtureSession, onSheet, openWorkflowSheet } from './kit';
import { fakeClaude, writeJson, testPlatform } from '../helpers';

/** Poll until a path exists — the order file is a host write off a webview message. */
async function waitPath(file: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (
      await fs.access(file).then(
        () => true,
        () => false
      )
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${file} still missing after ${ms}ms`);
}

/** The dock box, in the pixels the divider's clamp actually paints. */
type ShellRead = {
  inner: number;
  dock: number;
  board: number;
  divider: number;
};

/**
 * The three widths `main.ts` allows. The floor is a constant; the initial
 * width and the ceiling are fractions of the webview, and the same clamp
 * applies to a saved width on the next open.
 */
function dockPolicy(inner: number): { initial: number; floor: number; ceiling: number } {
  const ceiling = Math.round(inner * 0.5);
  return {
    initial: Math.max(280, Math.min(Math.round(inner * 0.36), ceiling)),
    floor: 280,
    ceiling
  };
}

async function readShell(): Promise<ShellRead> {
  return panel()
    .locator('#dock')
    .evaluate((dock) => {
      const doc = dock.ownerDocument;
      const view = doc.defaultView;
      const width = (id: string): number =>
        Math.round(doc.getElementById(id)?.getBoundingClientRect().width ?? -1);
      return {
        inner: view?.innerWidth ?? 0,
        dock: width('dock'),
        board: width('board'),
        divider: width('divider')
      };
    });
}

/**
 * Move the divider to `px` through the listener a drag ends on.
 *
 * `clientX` is the webview's, which is the coordinate `setWidth` subtracts
 * from. A page-coordinate move is the overshoot the floor and ceiling need;
 * this is the exact width a later case has to inherit.
 */
async function moveDock(px: number): Promise<void> {
  await panel()
    .locator('#divider')
    .evaluate((divider, width: number) => {
      const view = divider.ownerDocument.defaultView;
      if (!view) throw new Error('the panel has no window');
      const x = view.innerWidth - width;
      divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x }));
      view.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x }));
      view.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x }));
    }, px);
}

/**
 * Load the webview document again, so `getState` is read at load.
 *
 * Disposing the editor does not do that. A new panel is a new webview, and
 * this one is not revived, so the stored width is gone. Measured 2026-10-27:
 * after a drag to 408px, close and reopen painted 294px, which is 36% of the
 * 816px webview. Reload Webviews re-sends the stored state into a new document.
 */
async function reloadWebview(): Promise<void> {
  await ctx.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await panel()
    .locator('body')
    .evaluate((body) => {
      body.dataset.smokeGen = 'old';
    });
  await ctx.page.keyboard.press('ControlOrMeta+Shift+P');
  const quick = ctx.page.locator('.quick-input-widget');
  await quick.waitFor({ timeout: 10_000 });
  await ctx.page.keyboard.type('Reload Webviews');
  const row = quick.locator('.monaco-list-row', { hasText: 'Reload Webviews' }).first();
  await row.waitFor({ timeout: 10_000 });
  await row.click();
  await quick.waitFor({ state: 'hidden', timeout: 10_000 });
  await panel().locator('body:not([data-smoke-gen="old"])').waitFor({ timeout: 30_000 });
  await panel().locator('#dock').waitFor({ timeout: 30_000 });
  await panel().locator('#cards').waitFor({ timeout: 30_000 });
  await passOnboarding();
}

/**
 * The panel arriving, and the chrome it draws from disk before any session is
 * owned: activate → discover → the command → a card → the persistent shell →
 * the bottom hub → settings (model flyout placement, theme swatches, the
 * sound row over its two settings).
 *
 * The shared fixture resumes one child before the card assertions.
 */

section('the panel arriving, in the real IDE', () => {
  step('opens from the command palette', async () => {
    await ctx.page.keyboard.press('ControlOrMeta+Shift+P');
    await ctx.page.keyboard.type('Squadron: Show Sessions Overview');
    await ctx.page.keyboard.press('Enter');
    await panel().locator('#cards').waitFor({ timeout: 30_000 });
    await passOnboarding();
  });

  /**
   * The shell's real boxes, and the folder the paired slot still names.
   *
   * jsdom writes `style.width` and never lays the column out, and it never
   * reloads the webview, so a saved width and a host workspace folder are
   * both invisible there. The clamp is the production one: 36% on a fresh
   * open, 280px when the pointer overshoots right, half the webview when it
   * overshoots left, and the dragged width again after the webview reloads.
   * The last reload puts 36% back for the rest of this file. A later section
   * opens its own panel.
   */
  step('keeps the chat shell at its desktop width and the opened folder', async () => {
    await panel().locator('#chat.empty.start').waitFor({ timeout: 30_000 });
    await panel().locator('.half[data-act="resume"]').waitFor({ timeout: 30_000 });
    // git and the host can spell this folder with `/private` while the launch
    // path does not. Both halves have to name it, and name the same one.
    const opened = await fs.realpath(path.join(homeDir(), 'project'));
    const halves = await panel()
      .locator('.card.add .half')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          act: (node as HTMLElement).dataset.act ?? '',
          cwd: (node as HTMLElement).dataset.cwd ?? ''
        }))
      );
    assert.deepEqual(
      halves.map((half) => half.act),
      ['resume', 'open'],
      'the add slot is no longer Resume then New'
    );
    assert.equal(halves[0]?.cwd, halves[1]?.cwd, 'Resume and New name different folders');
    for (const half of halves) {
      assert.equal(await fs.realpath(half.cwd), opened, `${half.act} left the opened folder`);
    }
    assert.match(
      (await panel().locator('#thread .vacant h3').textContent()) ?? '',
      /New session in [\s\S]*project/
    );
    assert.equal(await panel().locator('.card[data-pid]').count(), 0, 'launch started a session');
    assert.equal(await panel().locator('#chat-close, #thread .dshut').count(), 0);

    const fresh = await readShell();
    const policy = dockPolicy(fresh.inner);
    console.log(
      `  (shell inner ${fresh.inner}px, dock ${fresh.dock}px, board ${fresh.board}px,` +
        ` divider ${fresh.divider}px)`
    );
    assert.ok(await panel().locator('#dock').isVisible(), 'the shell is not on screen');
    assert.ok(await panel().locator('#divider').isVisible(), 'the divider is not on screen');
    assert.ok(
      policy.initial > policy.floor && policy.initial < policy.ceiling,
      'not a desktop width'
    );
    assert.equal(fresh.dock, policy.initial, 'the first open was not 36%');
    assert.equal(fresh.divider, 1);

    const nav = await panel().locator('#nav').boundingBox();
    const dockBox = await panel().locator('#dock').boundingBox();
    assert.ok(nav && dockBox, 'the shell has no boxes to drag');
    await dragDivider(dockBox.x + dockBox.width - 2);
    const floored = await readShell();
    assert.equal(floored.dock, policy.floor, 'the dock passed its 280px floor');
    await dragDivider(nav.x + 8);
    const capped = await readShell();
    assert.equal(capped.dock, dockPolicy(capped.inner).ceiling, 'the dock passed half the panel');
    assert.ok(capped.board < floored.board, 'the ceiling did not narrow the board');

    await reloadWebview();
    const remembered = await readShell();
    console.log(`  (remembered dock ${remembered.dock}px at inner ${remembered.inner}px)`);
    assert.equal(remembered.dock, capped.dock, 'reloading forgot the dragged width');
    assert.notEqual(remembered.dock, dockPolicy(remembered.inner).initial);

    await moveDock(dockPolicy(remembered.inner).initial);
    await reloadWebview();
    const restored = await readShell();
    console.log(`  (restored dock ${restored.dock}px at inner ${restored.inner}px)`);
    assert.equal(
      restored.dock,
      dockPolicy(restored.inner).initial,
      'the barrel was left at the ceiling'
    );
    assert.equal(await panel().locator('#chat-close, #thread .dshut').count(), 0);
  });

  step('discovers skill folders for every CLI before the first prompt', async () => {
    assert.equal(await panel().locator('.card[data-pid]').count(), 0);
    await signCodex('in');
    await openDraft();
    const box = composer();
    for (const [model, marker] of [
      ['Opus', 'dataviz'],
      ['Codex Test', 'codex-folder-marker'],
      ['Grok 4.7', 'grok-folder-marker']
    ] as const) {
      await pickDraftModel(model);
      await box.pressSequentially(`@skill:${marker}`);
      const menu = panel().locator('#mentionmenu:not([hidden])');
      await menu.locator('.mnrow', { hasText: marker }).waitFor({ timeout: 10_000 });
      await clearComposer();
      await box.pressSequentially('@skill:project-folder-marker');
      await menu
        .locator('.mnrow', { hasText: 'project-folder-marker' })
        .waitFor({ timeout: 10_000 });
      await clearComposer();
    }
    assert.equal(await panel().locator('.card[data-pid]').count(), 0);
    await signCodex('out');
    assert.equal(await panel().locator('#thread .dshut, #chat-close').count(), 0);
    assert.ok(await panel().locator('#dock').isVisible(), 'discovery closed the shell');
  });

  /**
   * The fixture card, and the act that makes one.
   *
   * Since row 71 the board draws the sessions this window started and nothing
   * else, so there is no card to find until this host has started one. The
   * fixture resumes planted history and sends one turn; `fixtureSession()`
   * memoises the child for every file after this one. It settles to `idle`
   * because the fake CLI answers a turn in about a millisecond, and reads
   * `done`: the resume's select marked it seen before
   * that turn, and a selected card keeps `done` until a dock act.
   */
  step('shows a card for the fixture session', async () => {
    const { pid } = await fixtureSession();
    const card = panel().locator(`.card[data-pid="${pid}"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.and(panel().locator('.idle.done')).waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('.pill').textContent(), 'done');
  });

  step(
    'offers a reachable chat close that returns to a task while the session stays alive',
    async () => {
      const { pid } = await fixtureSession();
      const card = panel().locator(`.card[data-pid="${pid}"]`);
      await card.click();
      const close = panel().getByRole('button', { name: 'Close chat', exact: true });
      const box = await close.boundingBox();
      assert.ok(box, 'close must be visible');
      const reachable = await close.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return [-11.5, 11.5].every((x) =>
          [-11.5, 11.5].every((y) => {
            const hit = button.ownerDocument.elementFromPoint(cx + x, cy + y);
            return hit === button || (hit !== null && button.contains(hit));
          })
        );
      });
      assert.ok(reachable, 'close needs a reachable 24px target including its hit padding');
      const stop = await panel().locator('#chat-stop').boundingBox();
      assert.ok(stop && box.x >= stop.x + stop.width, 'close must sit after End');
      await close.click();
      await panel().locator('#chat.start #input[aria-disabled="false"]').waitFor();
      assert.ok(await card.isVisible(), 'closing the chat ended its session');
      assert.equal(await card.evaluate((node) => node.classList.contains('selected')), false);
      await composer().fill('a fresh task');
      await clearComposer();
      await card.click();
      await close.waitFor({ state: 'visible' });
    }
  );

  /**
   * A card's height is a fact about the card, not about the session it draws.
   *
   * The only layer that can hold it. jsdom lays nothing out, so the unit suite
   * can assert the *rows* do not vary (`board_card.test.ts`) and nothing more —
   * delete the `min-height` off `.card .name` and `npm run check` stays green
   * while every card on the board jumps a line on its next retitle.
   *
   * Fixed means fixed against what the session reports. Width may still change
   * it: the compact container rule below 180px gives the title one line instead
   * of two on purpose, so this measures one card across a change in its own
   * state rather than two cards against each other.
   *
   * Runs before any divider drag on purpose. The shell is already open, and a
   * card that crosses the compact breakpoint mid-scenario is measuring the
   * breakpoint. The fixture's name is put back before this returns, because
   * every later case here finds its card by that text.
   */
  step('holds a card at one height when its title grows a line', async () => {
    const { pid, sessionId } = await fixtureSession();
    // The stated-name store, which is where a rename from outside this window
    // lands — the fixture's own name is written there, so a retitle is one more
    // write to the same file rather than a verb on the wire.
    const file = path.join(ctx.home, '.squadron', 'names', `claude.${sessionId}.json`);
    const stated = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    const retitle = (name: string): Promise<void> =>
      fs.writeFile(file, JSON.stringify({ ...stated, name, statedAt: Date.now() }));
    const card = panel().locator(`.card[data-pid="${pid}"]`);
    await card.waitFor({ timeout: 30_000 });

    /** The card's box, and how many lines of its own title are inside it. */
    const read = async (): Promise<{ h: number; lines: number }> => {
      const box = await card.boundingBox();
      assert.ok(box, 'the card left the document');
      const lines = await card.locator('.name').evaluate((n) => {
        // The text's own painted height, off a Range — not the element's
        // scrollHeight. The `min-height: 2.6em` floor makes scrollHeight report
        // two lines even for a one-line title. Chromium may return one Range
        // rect spanning both painted lines, so count its height, not its boxes.
        const range = n.ownerDocument.createRange();
        range.selectNodeContents(n);
        const view = n.ownerDocument.defaultView;
        if (!view) return 0;
        const lineHeight = Number.parseFloat(view.getComputedStyle(n).lineHeight);
        const height = [...range.getClientRects()].reduce((sum, rect) => sum + rect.height, 0);
        return Math.round(height / lineHeight);
      });
      return { h: Math.round(box.height), lines };
    };

    const one = await read();
    assert.equal(one.lines, 1, 'the fixture title was not one line to begin with');
    assert.ok(await card.locator('.foot .strip-reading').isVisible(), 'no footer context reading');
    assert.equal(await card.locator('.bar').count(), 0, 'standalone context track remains');

    await retitle(
      'smoke session whose title runs long enough to take both of the lines a card gives it'
    );
    // The poll, then the scramble the retitle animates through (500ms).
    await card.locator('.name').getByText('both of the lines').waitFor({ timeout: 30_000 });
    await ctx.page.waitForTimeout(800);

    const two = await read();
    assert.ok(two.lines >= 2, `the long title did not wrap: ${two.lines} line(s)`);
    assert.equal(two.h, one.h, `the card grew with its title: ${one.h}px -> ${two.h}px`);

    await retitle(FIXTURE_NAME);
    await card
      .locator('.name')
      .getByText(FIXTURE_NAME, { exact: true })
      .waitFor({ timeout: 30_000 });
  });

  /**
   * Selecting a card fills the chat. It does not open a column — the shell is
   * already there — and it does not change the column's width. jsdom can see
   * the missing close control; the box staying put is layout.
   */
  step('keeps the chat shell when a card is selected', async () => {
    const before = await readShell();
    await panel()
      .locator('.card', { hasText: FIXTURE_NAME })
      .locator('.name')
      .click({ timeout: 30_000 });
    await panel().locator('#chat:not(.empty)').waitFor({ timeout: 10_000 });
    const after = await readShell();
    assert.ok(await panel().locator('#chat').isVisible(), 'chat tab up on select');
    assert.ok(await panel().locator('#dock').isVisible(), 'select hid the shell');
    assert.equal(await panel().locator('#chat-close').count(), 0);
    assert.equal(
      after.dock,
      before.dock,
      `select moved the dock from ${before.dock}px to ${after.dock}px`
    );
  });

  /**
   * A named card is captured for a view transition, and a capture paints above
   * every overlay — which is how a dock toggle flew cards over the cup and the
   * tip (`TASK_done_dock_flip.md`). Card travel is FLIP now, in the page, and
   * the dock no longer takes a snapshot. The guard is that nothing names a
   * card. jsdom reports the property as '' whether or not a rule sets it, so
   * the resolved value is only a fact here.
   */
  step('names no card for a view transition', async () => {
    const named = await panel()
      .locator('#cards')
      .evaluate(
        (cards) =>
          [...cards.querySelectorAll('.card, .fam')].filter(
            (n) =>
              cards.ownerDocument.defaultView?.getComputedStyle(n).viewTransitionName !== 'none'
          ).length
      );
    assert.equal(named, 0, 'a card is captured, and will paint over the overlays');
  });

  step('opens tickets in the shell and offers no close', async () => {
    // The tab, not the nav's Tickets entry: nothing is linked yet, so that one
    // asks the host for a Linear key — the drag test's business.
    const before = await readShell();
    await panel().locator('#board-tickets').click();
    const head = panel().locator('#tk-head');
    await head.waitFor({ timeout: 10_000 });
    assert.ok(await panel().locator('#tk-list').isVisible(), 'tickets tab up');
    assert.ok(await panel().locator('#chat').isVisible(), 'chat stays visible beside Tickets');
    assert.equal(await head.locator('button[aria-label="Close"]').count(), 0);
    const after = await readShell();
    assert.ok(await panel().locator('#dock').isVisible(), 'the tickets tab hid the shell');
    assert.equal(after.dock, before.dock, 'the tickets tab resized the shell');
    await panel().locator('#board-sessions').click();
    await panel().locator('#chat').waitFor({ state: 'visible', timeout: 10_000 });
  });

  step('keeps the status dropdown and its menu inside a narrow board', async () => {
    const { pid } = await fixtureSession();
    const card = panel().locator(`.card[data-pid="${pid}"]`);
    await card.locator('.name').click();
    const before = (await readShell()).dock;
    const nav = panel().locator('#nav');
    const box = await nav.boundingBox();
    assert.ok(box);
    await dragDivider(box.x + 8);
    const trigger = panel().locator('#status-filter');
    const rect = await trigger.boundingBox();
    assert.ok(rect && rect.width < 180 && rect.width >= 24 && rect.height >= 24);
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    const menu = panel().locator('#status-menu');
    await menu.waitFor({ state: 'visible' });
    const menuBox = await menu.boundingBox();
    const boardBox = await panel().locator('#board').boundingBox();
    assert.ok(menuBox && boardBox);
    assert.ok(
      menuBox.x >= boardBox.x && menuBox.x + menuBox.width <= boardBox.x + boardBox.width + 1,
      'status menu spills into the conversation'
    );
    const choice = menu
      .locator('.mitem')
      .filter({ has: panel().locator('.dot') })
      .first();
    assert.equal(
      await choice.locator('.dot').evaluate((n) => getComputedStyle(n).backgroundColor),
      await card.locator('.head .dot').evaluate((n) => getComputedStyle(n).backgroundColor),
      'the menu must paint the same status hue as its card'
    );
    await choice.click();
    await trigger.click();
    await panel().locator('#status-menu').waitFor({ state: 'visible' });
    await ctx.page.keyboard.press('Escape');
    await panel().locator('#status-menu').waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate((n) => n === n.ownerDocument.activeElement), true);
    await trigger.click();
    await panel().locator('#status-menu .fclear').click();
    assert.equal(await card.isVisible(), true);
    await moveDock(before);
    const restored = await readShell();
    assert.equal(restored.dock, before, 'the status case left the board narrow');
  });

  /**
   * The nav bar's responsive steps, and the bug they exist for.
   *
   * The bar used to be a row of nowrap children with no overflow anywhere: past
   * the width where its content stopped fitting, the actions kept their width
   * and painted over the divider and into the dock. `css/nav.ts` answers that
   * with six container steps against the board's inline size, and jsdom can say
   * nothing at all about them — no layout, no container queries — so its
   * scenarios can only check that each step has something to select. Whether a
   * step *fires*, and whether the bar stays inside its own box afterwards, is a
   * question for a browser.
   *
   * Also the divider's first coverage of any kind.
   *
   * **A ladder, not one narrow reading.** The first version of this dragged
   * straight to the ceiling and asserted every step at or above the width it
   * landed on — and passed with the 900px step deliberately broken. At the
   * ceiling this window gives a ~460px board, where the 480px step has already
   * taken the whole dial away: `.mach .k` has no box whatever its own step
   * says, and four of the assertions were reading the same one step. A step is
   * only tested by a pair of widths that straddle it, so this reads the bar at
   * three and requires each claim to be a before *and* an after.
   *
   * What the ladder can reach is bounded by the shell. The dock no longer
   * shuts, so the board runs from the 280px floor to the half-panel ceiling,
   * not from the whole panel. On the pinned desktop window that span straddles
   * the 480px step. The wider steps needed the shut dock and are reported as
   * unreached; the 380px step was already below the floor. A shut dock is not
   * brought back to reach them.
   */
  step('sheds nav bar readouts as the divider narrows the board, and never spills', async () => {
    /** The bar, as the six steps can be seen from outside: what still has a box.
     *  `getClientRects()` and not a class or a computed value, because half the
     *  steps hide an ancestor rather than the element itself. */
    const readBar = () =>
      panel()
        .locator('#nav')
        .evaluate((n) => {
          const shown = (sel: string): boolean =>
            (n.querySelector(sel)?.getClientRects().length ?? 0) > 0;
          const gear = n.querySelector('.gear')?.getBoundingClientRect();
          return {
            board: Math.round(n.parentElement?.getBoundingClientRect().width ?? 0),
            scroll: n.scrollWidth,
            client: n.clientWidth,
            right: n.getBoundingClientRect().right,
            gearRight: gear?.right ?? Infinity,
            marker: shown('.mach .k'),
            figure: shown('.mach .v'),
            w5: shown('.lim .w5'),
            dial: shown('.mach'),
            plan: shown('.lim')
          };
        });

    const before = await readShell();
    const bar = await panel().locator('#nav').boundingBox();
    const dockBox = await panel().locator('#dock').boundingBox();
    assert.ok(bar && dockBox, 'the nav bar is not on screen');
    const initial = await readBar();

    try {
      // Right, until the dock's 280px floor stops it, then left until its
      // half-panel ceiling does. Both are clamped in `main.ts`, so the pointer
      // only has to overshoot. The third rung is the width this case started
      // at, between those two on a desktop window.
      await dragDivider(dockBox.x + dockBox.width - 2);
      const floored = await readShell();
      assert.equal(
        floored.dock,
        dockPolicy(floored.inner).floor,
        'the ladder missed the 280px floor'
      );
      const wide = await readBar();
      await dragDivider(bar.x + 8);
      const capped = await readShell();
      assert.equal(
        capped.dock,
        dockPolicy(capped.inner).ceiling,
        'the ladder missed the half-panel ceiling'
      );
      const narrow = await readBar();

      const rungs = [wide, initial, narrow].sort((a, b) => b.board - a.board);
      const widest = rungs[0];
      const middle = rungs[1];
      const narrowest = rungs[2];
      assert.ok(widest && middle && narrowest, 'the ladder lost a rung');
      // The bug itself, at every width, and the claim that holds whatever the
      // steps do: the bar is a box, and nothing in it is drawn outside that box.
      for (const rung of rungs) {
        assert.ok(
          rung.scroll <= rung.client + 1,
          `at a ${rung.board}px board the bar overflows its own box by ${rung.scroll - rung.client}px`
        );
        assert.ok(
          rung.gearRight <= rung.right + 1,
          `at a ${rung.board}px board the gear is drawn ${Math.round(rung.gearRight - rung.right)}px past the bar`
        );
      }
      assert.ok(
        widest.board > middle.board && middle.board > narrowest.board,
        `the ladder did not narrow: ${rungs.map((r) => r.board).join(' -> ')}`
      );

      // The ladder as `css/nav.ts` actually writes it, which is not the order
      // this list was first written in. `dc9834a` moved the two spelled-out
      // labels to the top step — they restate a mark that is still on the bar,
      // so they are the cheapest ~182px there is — and every step below them
      // shifted down one. This list kept the old order and went on asserting
      // that the status words survive to 600px, which they have not done since.
      // It passed anyway until a rung happened to land between 600 and 900 and
      // read the truth. Reordered with the stylesheet; this table is not the
      // source, and any edit to the `@container` blocks belongs here too.
      const STEPS = [
        [800, 'marker', 'the CPU/MEM markers'],
        [700, 'figure', 'the dial figures'],
        [600, 'w5', 'the 5h window'],
        [480, 'dial', 'the dials'],
        [380, 'plan', 'the plan readout']
      ] as const;

      const unreached: number[] = [];
      let proved = 0;
      for (const [at, key, what] of STEPS) {
        const above = rungs.filter((r) => r.board > at);
        const below = rungs.filter((r) => r.board <= at);
        // No rung either side of it: this window cannot straddle this step, and
        // an assertion made from one side alone is the vacuous one this case was
        // rewritten to stop making.
        if (!above.length || !below.length) {
          unreached.push(at);
          continue;
        }
        // The narrowest board still above the step, and the widest at or below.
        const last = above[above.length - 1];
        const first = below[0];
        assert.ok(last && first, 'a straddled step with a missing rung');
        assert.equal(
          last[key],
          true,
          `${what} were already gone at ${last.board}px, above the ${at}px step`
        );
        assert.equal(first[key], false, `${what} survived the ${at}px step at ${first.board}px`);
        proved++;
      }
      assert.ok(
        !unreached.includes(480),
        `the 480px step was not straddled by ${rungs.map((r) => r.board).join('/')} (${proved} proved)`
      );
      console.log(
        `  (nav ladder read ${rungs.map((r) => r.board).join('/')}px;` +
          ` ${proved} straddled; out of reach: ${unreached.join(', ') || 'none'}px)`
      );
    } finally {
      // Back to the width this case started at. A rung left at the ceiling
      // gives the model flyout no room on its left, and there is no close
      // gesture that would hand the board the whole panel.
      await moveDock(before.dock);
    }
  });

  /**
   * The divider is felt wider than it is painted.
   *
   * A splitter whose target is exactly its paint strobes: rested on a 1px line,
   * the smallest tremor takes the pointer off the box and `#divider:hover`
   * follows it off and back on several times a second. The fix is a hit band
   * reaching 5px into each neighbour (`css/shell.ts`), and it is two claims a
   * browser has to answer — hit testing, which jsdom does not do at all, and
   * the stacking order that decides who wins where the band overlaps. The dock
   * side is the one that had to be paid for: `#thread` is positioned at z-index
   * auto and comes later in the document, so at equal rank it would take the
   * band back.
   *
   * `elementFromPoint` and not a hover plus a computed colour: the question is
   * which box owns the point, and the answer is the same one the browser gives
   * a resting pointer.
   */
  step('gives the divider a hit band wider than the line it paints', async () => {
    await panel()
      .locator('.card', { hasText: FIXTURE_NAME })
      .locator('.name')
      .click({ timeout: 30_000 });
    await panel().locator('#divider').waitFor({ timeout: 10_000 });

    const owners = await panel()
      .locator('#divider')
      .evaluate((d) => {
        const box = d.getBoundingClientRect();
        const y = box.top + box.height / 2;
        const at = (x: number): string => {
          const hit = d.ownerDocument.elementFromPoint(x, y);
          return hit === d ? 'divider' : (hit?.id ?? hit?.tagName ?? 'nothing');
        };
        const cards = d.ownerDocument.getElementById('cards');
        return {
          gutter: (cards?.offsetWidth ?? 0) - (cards?.clientWidth ?? 0),
          width: Math.round(box.width),
          board: at(box.left - 2),
          line: at(box.left + box.width / 2),
          dock: at(box.right + 2),
          offBoard: at(box.left - 7),
          offDock: at(box.right + 7)
        };
      });

    // What the board half of the band is really overlapping. #cards scrolls,
    // and a scroller with a laid-out gutter would put ~15px of scrollbar
    // flush against the divider, of which the band would take the outer 5px
    // — a press there resizing the dock instead of dragging the thumb. On
    // macOS the gutter is 0: the bar is an overlay drawn inside the content
    // box only while it is used, so the two meet on a few pixels of a
    // transient bar rather than on a permanent one. Read rather than assumed,
    // and a platform whose gutter is laid out has this trade to re-take.
    console.log(`  (#cards scroll gutter: ${owners.gutter}px)`);
    if (testPlatform() === 'darwin')
      assert.equal(owners.gutter, 0, 'the board now lays out a scroll gutter under the band');
    assert.equal(owners.width, 1, 'the painted line is no longer 1px wide');
    assert.equal(owners.line, 'divider', 'the divider does not own its own middle');
    assert.equal(owners.board, 'divider', `2px into the board is owned by ${owners.board}`);
    assert.equal(owners.dock, 'divider', `2px into the dock is owned by ${owners.dock}`);
    // Bounded, or the band is a strip of dead dock a reader cannot press.
    assert.notEqual(owners.offBoard, 'divider', 'the band reaches 7px into the board');
    assert.notEqual(owners.offDock, 'divider', 'the band reaches 7px into the dock');
  });

  /**
   * A session someone typed `claude` for draws nothing.
   *
   * A session file with no `entrypoint` is what one looks like on disk, and
   * discovery drops it before reading anything else about it. This is the one
   * place a real host asserts that — jsdom only ever sees a list a test built.
   *
   * Everything it writes is removed before it returns, and the assertion runs
   * against a poll it waits for rather than a paint it assumes.
   */
  step('draws no card for a typed claude', async () => {
    const typed = await fakeClaude(60);
    const sessions = path.join(homeDir(), '.claude', 'sessions', `${typed.pid}.json`);
    await writeJson(sessions, {
      pid: typed.pid,
      sessionId: 'typed',
      cwd: path.join(homeDir(), 'project'),
      name: 'typed by hand',
      status: 'idle',
      startedAt: Date.now(),
      kind: 'interactive'
    });

    try {
      // Waited on rather than asserted at once: the fixture lands through the
      // poll, so an immediate read would pass against a board that has not seen
      // it yet — which is a green that proves nothing. The card for this
      // window's own fixture is the beat to wait for.
      await panel().locator('.card', { hasText: FIXTURE_NAME }).waitFor({ timeout: 30_000 });
      await ctx.page.waitForTimeout(4000);

      assert.equal(
        await panel().locator('.card', { hasText: 'typed by hand' }).count(),
        0,
        'a session someone typed `claude` for was drawn as a card'
      );
    } finally {
      typed.stop();
      await fs.rm(sessions, { force: true });
    }
  });

  /**
   * **The whole of row 71, asserted against a real host.**
   *
   * A session another window *owns* — on a pipe, with a published record behind
   * it naming that window — is the one shape this row drops, and the only one
   * that used to draw a fully driveable card from somebody else's extension
   * host. The step above it is a different claim: that one is a hand-typed
   * session, dropped by discovery before the fold.
   *
   * jsdom holds the rule at `onBoard` against a list a test composed. Only
   * here do the two files a real window would have written go through
   * `discoverAll` and `readPublished` on a real poll and come back drawing
   * nothing. Written exactly as `boot.ts` used to write its fixture, plus the
   * record: before this row that pair *was* a card.
   *
   * Everything it writes is removed before it returns.
   */
  step('draws no card for a session another window owns, record and all', async () => {
    const theirs = await fakeClaude(60);
    const sessions = path.join(homeDir(), '.claude', 'sessions', `${theirs.pid}.json`);
    const record = path.join(homeDir(), '.squadron', 'live', `${theirs.pid}.json`);
    const startedAt = Date.now();
    // `sdk-cli` is the CLI's own word for having been started on a pipe, and
    // what discovery keeps a Claude session by — so this twin reaches the fold,
    // and it is the board's filter that has to drop it.
    await writeJson(sessions, {
      pid: theirs.pid,
      sessionId: 'theirs',
      cwd: path.join(homeDir(), 'project'),
      name: 'another window drives this',
      status: 'idle',
      startedAt,
      kind: 'interactive',
      entrypoint: 'sdk-cli'
    });
    await writeJson(record, {
      schema: 1,
      session: {
        pid: theirs.pid,
        sessionId: 'theirs',
        cwd: path.join(homeDir(), 'project'),
        name: 'another window drives this',
        status: 'idle',
        hasCommand: false,
        startedAt,
        updatedAt: startedAt,
        transcript: '',
        source: 'owned',
        windowId: 'some-other-window'
      },
      pending: [],
      queued: [],
      updatedAt: startedAt
    });

    try {
      // Waited on rather than asserted at once: the fixtures land through the
      // poll, so an immediate read would pass against a board that has not seen
      // them. This window's own card is the beat to wait for.
      await panel().locator('.card', { hasText: FIXTURE_NAME }).waitFor({ timeout: 30_000 });
      await ctx.page.waitForTimeout(4000);

      assert.equal(
        await panel().locator(`#cards .card[data-pid="${theirs.pid}"]`).count(),
        0,
        'a session another window owns was drawn as a card'
      );
      assert.equal(
        await panel().locator('.card', { hasText: 'another window drives this' }).count(),
        0,
        'and it was not drawn under any other pid either'
      );
    } finally {
      theirs.stop();
      await fs.rm(sessions, { force: true });
      await fs.rm(record, { force: true });
    }
  });

  /**
   * The bottom bar is host-read chrome: files under
   * `~/.squadron/workflows/` land via the poll, not a webview message.
   * jsdom can paint a bar it is handed; only here does a real directory become
   * the capsule.
   *
   * Here rather than with the rest of the workflow cases because it needs no
   * session — and it leaves the bar as it found it, with nothing picked, so the
   * sequence in `session.smoke.ts` can pick for itself.
   */
  step('shows the bottom hub for authored files on disk', async () => {
    const bar = panel().locator('#bottomhub');
    await bar.waitFor({ timeout: 30_000 });
    assert.match((await bar.textContent()) ?? '', /Workflow/);

    // The bar draws no list of its own any more — the handle opens the one
    // surface that does.
    await onSheet(async () => {
      await openWorkflowSheet();
      const rows = panel().locator('#bottomdrawer-body .wsrow');
      // Two fixture files — a one-row list cannot prove a pick.
      assert.equal(await rows.count(), 2);
      const labels = (await rows.locator('.nm').allTextContents()).join(' | ');
      assert.match(labels, /smoke workflow/);
      assert.match(labels, /smoke alt/);
      // Author entry: one New under the whole list, not a second row per workflow.
      assert.match(
        (await panel().locator('#bottomdrawer-body .wsnew').textContent()) ?? '',
        /New workflow/
      );
    });
  });

  /**
   * New is the list's last row, sticky to the column it belongs to, and the
   * foot below it is a legend and nothing else. All three are layout claims, so
   * they belong here: jsdom can say which container holds the node and nothing
   * about where it lands or what it sticks to.
   *
   * It leaves the sheet shut, which is what lets `session.smoke.ts` open it for
   * itself — a blind press there would be a toggle whose losing side reads as
   * the host never having written a file.
   */
  step('puts New under the last row, and leaves the foot a legend', async () => {
    await onSheet(async () => {
      await openWorkflowSheet();
      const read = await panel()
        .locator('#bottomdrawer-body')
        .evaluate((n) => {
          // Position off the rect and size off `offset*`, deliberately: the sheet
          // rises on a transform, which a rect reports mid-flight and
          // `offsetHeight` does not — a 24px control measured then is 23.04 by
          // rect, and the size claim below would fail for the animation rather
          // than for the padding it is about.
          const box = (sel: string, root: ParentNode = n) => {
            const found = root.querySelector<HTMLElement>(sel);
            if (!found) {
              return null;
            }
            const { x, y, bottom } = found.getBoundingClientRect();
            return { x, y, bottom, w: found.offsetWidth, h: found.offsetHeight };
          };
          const list = n.querySelector('.bdlist');
          const add = n.querySelector<HTMLElement>('.wsnew');
          const foot = document.getElementById('bottomdrawer-foot');
          return {
            create: box('.bdlist .wsnew'),
            lastRow: box('.bdlist .wsrow:last-of-type'),
            // The one thing that makes an in-list add safe on a long list.
            stick: add ? getComputedStyle(add).position : '',
            isLast: list?.lastElementChild?.classList.contains('wsnew') === true,
            hint: foot ? box('.hint', foot) : null,
            footButtons: foot?.querySelectorAll('button').length ?? -1,
            footLeft: foot?.getBoundingClientRect().x ?? 0,
            footPad: foot ? parseFloat(getComputedStyle(foot).paddingLeft) : 0
          };
        });
      const { create, lastRow, hint } = read;
      assert.ok(create && lastRow && hint, 'the list draws New under its rows');
      assert.ok(read.isLast, 'New is the last thing in the list column');
      assert.ok(create.y >= lastRow.bottom - 1, 'New sits below the last workflow, never above it');
      assert.equal(read.stick, 'sticky', 'a long list would scroll New out of reach');
      // WCAG 2.2 SC 2.5.8: 24×24 CSS px — 7px of padding on a 12px line box is
      // what buys it, and nothing in the jsdom suite can tell.
      assert.ok(create.h >= 24, `New is ${create.h}px tall, under the 24px target`);
      assert.ok(create.w >= 24, `New is ${create.w}px wide, under the 24px target`);
      // The foot is a legend now: no control on it, and the legend stated at the
      // left edge where the rows start rather than floated by a `margin: auto`.
      assert.equal(read.footButtons, 0, 'the foot carries no controls');
      assert.ok(
        Math.abs(hint.x - (read.footLeft + read.footPad)) <= 2,
        `the hint starts at ${hint.x}, not at the foot's own left edge`
      );
    });
  });

  /**
   * The grip drag, in a browser that dispatches real pointer events.
   *
   * jsdom can prove every decision the flight makes — it is handed synthetic
   * `PointerEvent`s against a stacked ruler — and it structurally cannot prove
   * that a press on a 14px grip inside a scroller reaches the listener at all:
   * hit-testing, capture and the `click` a release synthesises are the browser's,
   * and a `dragging-wf` left set would be invisible to a layer that paints
   * nothing. The order lands on disk through the host, which is the other half.
   *
   * It drags back afterwards, so the rest of the barrel finds the two fixture
   * workflows in the order it expects. The order **file** stays behind, stating
   * the label order the panel would have shown anyway.
   */
  step('reorders the list on a grip drag, and writes the order to disk', async () => {
    const file = path.join(ctx.home, '.squadron', 'workflows.order.json');
    const labels = async (): Promise<string[]> =>
      panel().locator('#bottomdrawer-body .wsrow .nm').allTextContents();

    /** Carry row `from` past row `to`, by the grip and with real pointer moves. */
    const dragRow = async (from: number, to: number): Promise<void> => {
      const rows = panel().locator('#bottomdrawer-body .wsrow');
      const grip = rows.nth(from).locator('.wsgrip');
      const source = await grip.boundingBox();
      const target = await rows.nth(to).boundingBox();
      assert.ok(source && target, 'the sheet drew no rows to drag');
      await ctx.page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await ctx.page.mouse.down();
      // Two moves, not one: a single jump lands the pointer with no intervening
      // `pointermove`, which is how a real hand never moves and how a drop line
      // never gets drawn.
      await ctx.page.mouse.move(target.x + target.width / 2, target.y, { steps: 4 });
      await ctx.page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.75, {
        steps: 4
      });
      await ctx.page.mouse.up();
    };

    await onSheet(async () => {
      await openWorkflowSheet();
      const before = await labels();
      assert.equal(before.length, 2, 'two fixture workflows');

      await dragRow(0, 1);
      await panel()
        .locator('#bottomdrawer-body .wsrow')
        .first()
        .locator('.nm', { hasText: before[1] ?? '' })
        .waitFor({ timeout: 10_000 });
      assert.deepEqual(await labels(), [before[1], before[0]], 'the two rows traded places');
      // Nothing is left in the air: the ghost, the line and the body class all go.
      assert.equal(await panel().locator('.wsrow.flying, .wsins, .wsrow.lifted').count(), 0);
      assert.equal(await panel().locator('body.dragging-wf').count(), 0);
      // And the release applied nothing — a click is what a drag ends in.
      assert.ok(await panel().locator('#bottomdrawer').isVisible(), 'the drag applied and closed');

      await waitPath(file);
      const stated = JSON.parse(await fs.readFile(file, 'utf8')) as { order?: unknown };
      // Only as far down as the move reached — both, here, since the list is two.
      assert.deepEqual(stated.order, ['smoke-flow', 'smoke-alt']);

      // Put the list back the way the barrel found it.
      await dragRow(0, 1);
      await panel()
        .locator('#bottomdrawer-body .wsrow')
        .first()
        .locator('.nm', { hasText: before[0] ?? '' })
        .waitFor({ timeout: 10_000 });
      assert.deepEqual(await labels(), before);
    });
  });

  /**
   * A row's own Edit, Duplicate and Delete, pressed where the sheet actually
   * sits: on the board's bottom edge, on the last row. They are revealed on
   * hover, so jsdom cannot say a real pointer reaches them — only a host can.
   */
  step('reaches a row’s own buttons on the last row', async () => {
    await onSheet(async () => {
      await openWorkflowSheet();
      const last = panel().locator('#bottomdrawer-body .wsrow').last();
      // Plainly, with no `force`: this file has no owned session, so the rows are
      // unpickable — and managing them is still live (S5), which is exactly what
      // a real pointer reaching them proves.
      await last.hover();
      assert.equal(await last.locator('.act').count(), 3, 'Edit, Duplicate and Delete');
      assert.equal(
        await panel().locator('#bottomdrawer-body .act.more, #bottomdrawer-body .act.peek').count(),
        0
      );
      // It only *asks*; the file is not touched until the row's own Delete,
      // which this never presses, so the fixture the later cases read survives.
      await last.locator('.act.del').click({ timeout: 5_000 });
      // The confirm lands on the row it was opened from, not in the foot.
      await last.locator('.fbtn', { hasText: 'Cancel' }).click({ timeout: 5_000 });
      assert.equal(
        await panel().locator('#bottomdrawer-foot .fbtn').count(),
        0,
        'the foot holds no buttons'
      );
      await last.locator('.act.del').waitFor({ timeout: 5_000 });
    });
  });

  step('lays out Report actions on one row with red survey notification dots', async () => {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    await settings.getByRole('tab', { name: 'Report', exact: true }).click();
    const actions = settings.locator('#settings-report .settings-report');
    const boxes = await actions.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const dot = getComputedStyle(button, '::after');
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          background: style.backgroundColor,
          color: style.color,
          dot: {
            content: dot.content,
            color: dot.backgroundColor,
            width: dot.width,
            height: dot.height,
            radius: dot.borderRadius
          }
        };
      })
    );
    assert.equal(boxes.length, 3);
    const [survey, bugs, request] = boxes;
    assert.ok(survey && bugs && request);
    assert.ok(Math.abs(survey.y - bugs.y) < 1 && Math.abs(survey.y - request.y) < 1);
    assert.ok(survey.right < bugs.x && bugs.right < request.x, 'actions have room between them');
    for (const box of boxes) assert.ok(box.width >= 24 && box.height >= 24);
    const edge = await actions.boundingBox();
    assert.ok(edge && request.right <= edge.x + edge.width + 1, 'actions fit their page');
    const indicators = await panel()
      .locator('#nav-actions .gear, #settings-tab-report')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const dot = getComputedStyle(button, '::after');
          return {
            content: dot.content,
            color: dot.backgroundColor,
            width: dot.width,
            height: dot.height,
            radius: dot.borderRadius
          };
        })
      );
    assert.equal(indicators.length, 2);
    assert.equal(survey.background, bugs.background, 'Survey keeps the ordinary button background');
    assert.equal(survey.color, bugs.color);
    for (const dot of [survey.dot, ...indicators]) {
      assert.equal(dot.content, '""', 'the notification dot is drawn');
      assert.ok(parseFloat(dot.width) > 0 && dot.width === dot.height, 'the dot has a square box');
      assert.equal(dot.radius, '50%', 'the dot is round');
      const channels = dot.color.match(/\d+/g)?.map(Number);
      assert.ok(
        channels && channels[0]! > channels[1]! && channels[0]! > channels[2]!,
        'the dot is red'
      );
    }
    for (const indicator of indicators) assert.equal(survey.dot.color, indicator.color);
    assert.equal(bugs.dot.content, 'none', 'other Report actions have no notification dot');
    const run = process.env['SQUADRON_RUN'];
    if (run) await settings.screenshot({ path: path.join(run, 'report-actions.png') });
    await settings.locator('.settings-close').click();
  });

  step('opens model choices in the settings dialog top layer', async () => {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    await settings.getByRole('tab', { name: 'Model', exact: true }).click();
    const row = settings.locator('.mrow', { hasText: 'Default model' });
    await row.click();
    const fly = settings.locator('.fmenu.fly:not([hidden])');
    await fly.waitFor({ state: 'visible', timeout: 20_000 });
    const [flyBox, menuBox] = await Promise.all([fly.boundingBox(), settings.boundingBox()]);
    assert.ok(flyBox && menuBox, 'the dialog and choices are on screen');
    assert.ok(flyBox.x >= menuBox.x && flyBox.x < menuBox.x + menuBox.width);
    assert.ok(flyBox.height > 0);
    const pair = settings.locator('.dual-config .mrow');
    assert.equal(await pair.count(), 2);
    const first = await pair.nth(0).boundingBox();
    const second = await pair.nth(1).boundingBox();
    assert.ok(first && second && Math.abs(first.y - second.y) < 2, 'model and effort share a row');

    // The pick states itself in one cue — a fill, no rail beside it — so a fill
    // that fails to paint leaves a menu saying nothing about what is in force.
    // Only a host can answer that: the value is a color-mix of a theme
    // variable, and jsdom resolves neither.
    //
    // **On the pill, not the row.** Since shape B the model flyout draws one
    // row per model and one `.wp` per window, and the tick that means "this
    // start" is the pill's. No row here is `.pick` or `.on` any more — the row
    // wears `.lit`, which is the same fill at 10% and is not what a reader
    // reads a *pick* off. Same claim, at the scale the pick moved to.
    //
    // The setting is unset here, so the pill that is on is the one `''`
    // resolves to — the first window of the first current model of the brand.
    const painted = await fly.evaluate((menu) => {
      const on = menu.querySelector('.wp.on');
      const off = menu.querySelector('.wp:not(.on)');
      if (!on || !off) return null;
      const bg = (node: Element): string => getComputedStyle(node).backgroundColor;
      return { on: bg(on), off: bg(off) };
    });
    assert.ok(painted, 'the flyout drew no picked window and unpicked window to compare');
    assert.notEqual(
      painted.on,
      painted.off,
      `the picked window paints ${painted.on}, as every other one does`
    );
    // The inverted case, which notEqual above cannot tell from the right one:
    // a picked pill painting nothing while its neighbours paint something.
    assert.ok(
      !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(painted.on),
      'the picked window paints no background at all'
    );

    // Shut without picking. Every row here writes a real model **and window**
    // to the shared smoke profile — which the owned-session file then starts a
    // session under, and which the draft cases below open their pill on.
    // Escape keeps this case about placement, which is all it ever claimed to
    // be.
    await fly.press('Escape');
    await fly.waitFor({ state: 'hidden', timeout: 10_000 });
    assert.ok(await settings.isVisible(), 'Escape closes only the choices');
    await settings.locator('.settings-close').click();
    await settings.waitFor({ state: 'hidden', timeout: 10_000 });
  });

  step('keeps settings chrome anchored while release notes scroll', async () => {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    assert.equal(await settings.getByRole('tab').count(), 7);
    await settings.getByRole('tab', { name: 'Changelog', exact: true }).click();
    const head = settings.locator('.ashead');
    const before = await head.boundingBox();
    await settings.locator('#settings-changelog').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    assert.deepEqual(
      await head.boundingBox(),
      before,
      'scrolling content does not move the header'
    );
    await settings.getByRole('tab', { name: 'Accounts', exact: true }).click();
    const note = settings.locator('.account-help');
    const first = settings.locator('.acct').first();
    const [noteBox, accountBox] = await Promise.all([note.boundingBox(), first.boundingBox()]);
    assert.ok(noteBox && accountBox && noteBox.y < accountBox.y, 'path guidance precedes accounts');
    await first.locator('.act.out').click();
    await settings.waitFor({ state: 'hidden', timeout: 10_000 });
    const auth = panel().locator('#ascrim:not([hidden])');
    await auth.waitFor({ state: 'visible', timeout: 10_000 });
    await auth.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      await settings
        .getByRole('tab', { name: 'Accounts', exact: true })
        .getAttribute('aria-selected'),
      'true'
    );
    await settings.locator('.settings-close').click();
  });

  step('retains setting focus through a configuration echo and closes with Escape', async () => {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    const mascot = settings.locator('.mrow', { hasText: 'Mascot' });
    const original = (await mascot.getAttribute('aria-checked')) === 'true';
    const previous = await mascot.elementHandle();
    assert.ok(previous);
    await mascot.focus();
    await mascot.click();
    await previous.waitForElementState('hidden', { timeout: 20_000 });
    assert.equal(
      await mascot.evaluate((node) => document.activeElement === node),
      true,
      'the echoed control retains keyboard focus'
    );
    await mascot.press('Escape');
    await settings.waitFor({ state: 'hidden', timeout: 10_000 });
    await patchSettings({ 'squadron.mascot.enabled': original });
  });

  /**
   * Theme swatches in the settings gear. jsdom proves the click paints
   * `body[data-theme]` and that a refusal drops it. What only a host can say
   * is that the real menu lays the swatches out, and that the pick is a file
   * for the folder this window opened — not `squadron.theme`. A later change
   * to that setting must not recolour a folder that has chosen.
   *
   * Restores `follow` so every later scenario still sees the host palette.
   */
  step('paints a theme pick and keeps it for the opened folder', async () => {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    await settings.waitFor({ state: 'visible', timeout: 20_000 });
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('heading', { name: 'Dark', exact: true }).waitFor();
    await settings.getByRole('heading', { name: 'Light', exact: true }).waitFor();

    const city = settings.locator('.sws[data-theme="nightcity"]');
    await city.waitFor({ timeout: 10_000 });
    await city.click();
    // Instant paint, before any host message comes back.
    await panel().locator('body[data-theme="nightcity"]').waitFor({ timeout: 5_000 });
    assert.equal(await city.getAttribute('aria-checked'), 'true');
    // Picking a swatch leaves the menu open — same bargain as the unit suite.
    assert.ok(await settings.isVisible(), 'the pick closed the settings menu');

    const folder = await waitRepoTheme('nightcity');
    assert.equal(path.basename(folder), 'project');
    assert.notEqual(await sharedTheme(), 'nightcity');
    await waitTheme('nightcity');

    const corp = settings.locator('.sws[data-theme="arasaka"]');
    await corp.click();
    await panel().locator('body[data-theme="arasaka"]').waitFor({ timeout: 5_000 });
    assert.equal(await waitRepoTheme('arasaka'), folder);
    await waitTheme('arasaka');
    assert.equal(await corp.getAttribute('aria-checked'), 'true');
    assert.notEqual(await sharedTheme(), 'arasaka');

    // Follow is the absence of a preset — attribute must go, not become empty —
    // and it is still this folder's choice, not the absence of a file.
    await settings.locator('.sws[data-theme="follow"]').click();
    await waitTheme(null);
    assert.equal(await waitRepoTheme('follow'), folder);
    assert.equal(
      await settings.locator('.sws[data-theme="follow"]').getAttribute('aria-checked'),
      'true'
    );

    // The shared setting is what a folder uses when it has no file. This one
    // has one, so the push that follows the write leaves the panel following.
    await patchSettings({ 'squadron.theme': 'paper' });
    await staysTheme(null, 5_000);
    assert.equal(await waitRepoTheme('follow'), folder);
    await patchSettings({ 'squadron.theme': undefined });

    await settings.locator('.settings-close').click();
    await settings.waitFor({ state: 'hidden', timeout: 10_000 });
  });

  /**
   * The sound row's round trip through `host/`.
   *
   * `setSound` writes the pick to `sound.level` and `soundLevel` reads it back.
   * Both are `panel.ts` methods behind `vscode.workspace`, so no unit test can
   * reach either: jsdom sees the `setSound` message leave and the optimistic
   * paint land, and that is the end of what it knows.
   *
   * **It really sounds.** Picking a level plays `done` at it, out of the host's
   * own audio — nothing here asserts on that (a cue is a courtesy `playCue`
   * swallows wherever there is none to be had), so the noise a run makes at this
   * point is the feature working rather than a test needing it.
   *
   * Starts and ends at `Off`, which `boot.ts` seeds: a profile left audible
   * makes every finished turn in the barrel beep. The `Normal` default is read
   * by unsetting the key for that one check.
   */
  step('writes the sound level from the row, and leaves it at Off', async () => {
    await waitSoundRow('Off');
    // The unset key's default: `undefined` drops it from the JSON. Back to Off
    // straight after, before a finished turn can sound at it.
    await patchSettings({ 'squadron.sound.level': undefined });
    await waitSoundRow('Normal');
    await patchSettings({ 'squadron.sound.level': 'off' });
    await waitSoundRow('Off');
    await pickSound('Loud');
    // The row is filled from the state push when the menu opens, so reading
    // `Loud` back off a menu opened again is the whole host path: the write,
    // the configuration echo, the poll, `soundLevel`.
    await waitSoundRow('Loud');
    assert.equal(await writtenSoundLevel(), 'loud', 'Loud was not written to the profile');
    await pickSound('Off');
    await waitSoundRow('Off');
    assert.equal(await writtenSoundLevel(), 'off', 'Off was not written to the profile');
  });
});

const settingsMenu = () => panel().locator('#settings');

/** The gear's sound row. No other row in this menu says the word. */
const soundRow = () => settingsMenu().locator('.mrow', { hasText: 'Sound' });

/**
 * Open the gear, read the sound row's value, shut it — until the value is
 * `want`.
 *
 * Opened again each time rather than watched in place: the row is filled when
 * the menu opens and nothing repaints one inside an open menu, so a state push
 * that lands a moment after the pick is invisible to a menu that was already
 * up. Ends shut, like every other reader here.
 */
async function waitSoundRow(want: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await panel().locator('#nav-actions .gear').click();
    const settings = settingsMenu();
    await settings.waitFor({ state: 'visible', timeout: 20_000 });
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    // `.val` carries the chevron as well as the label, and the chevron is an
    // empty `<i>` — so the text is the value and nothing else.
    const got = (await soundRow().locator('.val').textContent())?.trim();
    await settings.locator('.settings-close').click();
    await settings.waitFor({ state: 'hidden', timeout: 10_000 });
    if (got === want) return;
    assert.ok(Date.now() - start < ms, `the sound row reads ${got}, not ${want}, after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function writtenSoundLevel(): Promise<unknown> {
  const written = JSON.parse(
    await fs.readFile(path.join(ctx.profile, 'data', 'User', 'settings.json'), 'utf8')
  ) as Record<string, unknown>;
  return written['squadron.sound.level'];
}

/** Drill the sound row open and pick a level off it, from a shut gear to a shut gear. */
async function pickSound(label: string): Promise<void> {
  await panel().locator('#nav-actions .gear').click();
  const settings = settingsMenu();
  await settings.waitFor({ state: 'visible', timeout: 20_000 });
  await settings.getByRole('tab', { name: 'General', exact: true }).click();
  await soundRow().click();
  const fly = panel().locator('.fmenu.fly:not([hidden])');
  await fly.waitFor({ state: 'visible', timeout: 20_000 });
  await fly.locator('.mitem', { hasText: label }).click();
  await fly.waitFor({ state: 'hidden', timeout: 10_000 });
  // The pick takes the flyout down and leaves the menu it was drilled from
  // standing — so the gear is what shuts it, and a pick that closed both would
  // be read here rather than as a stray timeout in the next opener.
  assert.ok(await settings.isVisible(), 'the pick took the settings menu down with the flyout');
  await settings.locator('.settings-close').click();
  await settings.waitFor({ state: 'hidden', timeout: 10_000 });
}

/**
 * Poll until `body[data-theme]` matches `want` (or is absent when `want` is
 * null). The host's config write is async; a single read after a fixed sleep
 * is how the wipe race would hide.
 */
/** The folder theme file the host wrote under the fixture home. */
async function waitRepoTheme(theme: string, ms = 15_000): Promise<string> {
  const dir = path.join(homeDir(), '.squadron', 'themes');
  const start = Date.now();
  for (;;) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as {
        folder?: unknown;
        theme?: unknown;
      };
      if (raw.theme === theme && typeof raw.folder === 'string' && raw.folder !== '') {
        return raw.folder;
      }
    }
    assert.ok(Date.now() - start < ms, `no folder theme ${theme} under ${dir} after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function sharedTheme(): Promise<unknown> {
  const written = JSON.parse(
    await fs.readFile(path.join(ctx.profile, 'data', 'User', 'settings.json'), 'utf8')
  ) as Record<string, unknown>;
  return written['squadron.theme'];
}

/** The attribute stays `want` for the whole window. A late push that recolours
 *  the panel fails here instead of arriving after a single matching read. */
async function staysTheme(want: string | null, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const got = await panel()
      .locator('body')
      .evaluate((b) => b.getAttribute('data-theme'));
    assert.equal(got, want);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitTheme(want: string | null, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const got = await panel()
      .locator('body')
      .evaluate((b) => b.getAttribute('data-theme'));
    if (got === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const final = await panel()
    .locator('body')
    .evaluate((b) => b.getAttribute('data-theme'));
  assert.equal(final, want, `theme still ${final} after ${ms}ms, wanted ${want}`);
}
