import * as assert from 'node:assert/strict';
import { before } from 'node:test';
import { closeEditors, ctx, openPanel, panel, section, step } from './boot';
import { composer, dockReady, endCard, openDraft, pids, sendDraft, waitForNewPid } from './kit';

/**
 * A turn that could not run, from the child's `result` to the card's red, and
 * the two host lifetimes the facet has to outlive. jsdom paints `failed` off a
 * `CardView` a test wrote and `live.test.ts` traces the outcome through the
 * reducer; neither has the half between them — the host minting the reading on
 * every refresh, and a panel disposed and rebuilt over the same `LiveState`
 * (`TASK_verifying_session_failed_status.md` Step 9, review R9).
 *
 * Its own section rather than a step in `session.smoke.ts`: closing the panel
 * disposes the webview that file's later cases read their dock state off, and
 * a failure leg there would sit behind forty cases that bail on the first red.
 */
section('a failed turn, through the real pipe and poll', () => {
  let pid = '';
  const card = () => panel().locator(`#cards .card[data-pid="${pid}"]`);

  before(async () => {
    await openPanel();
  });

  step('reads failed until a later turn begins, across a refresh and a reopen', async () => {
    const was = await pids();
    await openDraft();
    // `api-529` is the fake's refused turn: a `<synthetic>` reply and a
    // `result` whose only tell is `terminal_reason: "api_error"`.
    await sendDraft('api-529 smoke');
    pid = await waitForNewPid(was);
    await failed();
    await card().and(panel().locator('.selected.attention')).waitFor({ timeout: 30_000 });
    assert.equal(
      await card()
        .locator('.dot')
        .evaluate(
          (node) => node.ownerDocument.defaultView!.getComputedStyle(node).animationDuration
        ),
      '1.5s'
    );
    await ctx.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await card()
        .locator('.dot')
        .evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).animationName),
      'none'
    );
    await ctx.page.emulateMedia({ reducedMotion: 'no-preference' });
    await panel().locator('#thread').click();
    await card().and(panel().locator(':not(.attention)')).waitFor({ timeout: 30_000 });
    await failed();

    // Leave the session for composition, so the select below is a real one.
    await openDraft();
    await panel().locator('.card.selected').waitFor({ state: 'hidden', timeout: 30_000 });
    await failed();

    // Whatever the host pushes next was built by a refresh after the paint:
    // the deselect's, or, with nothing changed, the whole board resent on the
    // `UNCHANGED_MS` (15s) beat. Either way it must carry the reading itself.
    assert.equal(await nextPush(), 'failed', 'a refresh repainted the failure away');
    await failed();

    await closeEditors();
    await openPanel();
    if (await card().evaluate((node) => node.classList.contains('selected'))) {
      await openDraft();
      await panel().locator('.card.selected').waitFor({ state: 'hidden', timeout: 30_000 });
    }
    await failed();

    await card().click();
    await card().and(panel().locator('.selected')).waitFor({ timeout: 30_000 });
    await panel().locator('#chat').waitFor({ state: 'visible', timeout: 30_000 });
    await failed();

    // The next turn supersedes it as soon as it runs; `linger` stays open 4s.
    await composer().fill('try again, linger');
    await composer().press('Enter');
    await card().and(panel().locator('.busy')).waitFor({ timeout: 30_000 });
    assert.equal(await card().evaluate((node) => node.classList.contains('failed')), false);
    await card().and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
    assert.equal(await card().evaluate((node) => node.classList.contains('failed')), false);
    assert.equal(await card().locator('.head .pill').textContent(), 'done');
    await panel().locator('#thread').click();
    await card().and(panel().locator(':not(.done)')).waitFor({ timeout: 30_000 });
    assert.equal(await card().locator('.head .pill').textContent(), 'idle');

    await endCard(pid);
  });

  step('matches the failed card word and hue in the dock header', async () => {
    const was = await pids();
    await openDraft();
    await sendDraft('api-529 dock smoke');
    pid = await waitForNewPid(was);
    await failed();
    await card().and(panel().locator('.selected')).waitFor({ timeout: 30_000 });
    await dockReady();
    const head = panel().locator('#chat-head');
    assert.equal(await head.locator('.pill').textContent(), 'failed');
    assert.equal(await head.evaluate((node) => node.classList.contains('idle')), true);
    assert.equal(await head.evaluate((node) => node.classList.contains('failed')), true);
    const background = (node: Element): string =>
      node.ownerDocument.defaultView!.getComputedStyle(node).backgroundColor;
    const color = (node: Element): string =>
      node.ownerDocument.defaultView!.getComputedStyle(node).color;
    assert.equal(
      await head.locator('.pill').evaluate(background),
      await card().locator('.head .pill').evaluate(color)
    );
    const contrasts = await head.locator('.pill').evaluate((node) => {
      const doc = node.ownerDocument;
      const original = doc.body.dataset.theme;
      const luminance = (value: string): number =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).reduce((sum, value, index) => {
          const channel = Number(value) / 255;
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
        }, 0);
      try {
        return [
          'ink',
          'lift',
          'paper',
          'neon',
          'polaroid',
          'mario',
          'nightcity',
          'arasaka',
          'malachite'
        ].map((theme) => {
          doc.body.dataset.theme = theme;
          const style = doc.defaultView!.getComputedStyle(node);
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return {
            theme,
            ratio:
              (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          };
        });
      } finally {
        if (original === undefined) delete doc.body.dataset.theme;
        else doc.body.dataset.theme = original;
      }
    });
    for (const { theme, ratio } of contrasts) {
      assert.ok(ratio >= 4.5, `${theme} failed pill contrast is ${ratio.toFixed(2)}:1`);
    }
    if (process.env['SQUADRON_RUN']) {
      await ctx.page.screenshot({ path: `${process.env['SQUADRON_RUN']}/dock-status.png` });
    }
    await endCard(pid);
  });

  /** The card reading `failed`, in red: the facet over `.idle`, and the word. */
  async function failed(): Promise<void> {
    await card().and(panel().locator('.idle.failed')).waitFor({ timeout: 30_000 });
    assert.equal(await card().locator('.head .pill').textContent(), 'failed');
  }

  /** The base reading the host ships for this card on its next state push. */
  async function nextPush(): Promise<string> {
    const body = panel().locator('body');
    await body.evaluate((node, want) => {
      const view = node.ownerDocument.defaultView;
      const seen: string[] = [];
      (view as unknown as Record<string, unknown>).__failedPushes = seen;
      view?.addEventListener('message', (event: MessageEvent) => {
        const message = event.data as StateMessage | undefined;
        if (message?.type !== 'state') return;
        const ours = message.groups
          .flatMap((group) => group.sessions)
          .find((session) => session.pid === want);
        seen.push(ours?.reading.word ?? 'absent');
      });
    }, Number(pid));
    for (let look = 0; look < 250; look++) {
      const [first] = await body.evaluate(
        (node) =>
          (node.ownerDocument.defaultView as unknown as Record<string, unknown>)
            .__failedPushes as string[]
      );
      if (first !== undefined) return first;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('no state push in 25s');
  }
});
