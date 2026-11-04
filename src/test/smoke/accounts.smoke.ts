import * as assert from 'node:assert/strict';
import { after, before } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  clearOnboarding,
  closeEditors,
  ctx,
  homeDir,
  openPanel,
  panel,
  patchSettings,
  section,
  step
} from './boot';
import { composer, endCard, FIXTURE_NAME, fixtureSession, startFromDraft } from './kit';

/**
 * Accounts auth surfaces against a real host and the fake CLI's `auth` seam.
 *
 * jsdom covers paint from canned `accounts` / `loginProgress` messages. This
 * file is the half that needs a host: the extension spawns `claude auth …`
 * through `squadron.claudePath`, posts progress, and the webview opens the
 * popover and sheets in a real browser. The fixture defaults to signed-in so
 * the nav ladder still has a `.lim .w5` box; cases below flip state via the
 * same logout/login path a user would.
 *
 * Order matters: each case leaves the machine for the next (signed in → Claude
 * out / Grok in → Claude in again → Claude out for the pipe CTA → both out →
 * Grok in). Log in on the chip only when no live brand is signed in.
 */

/** The nav accounts control once the first auth poll has landed. */
const lim = () => panel().locator('#nav button.lim');

/** Auth sheet scrim (login or sign-out confirm). */
const scrim = () => panel().locator('#ascrim');

/** Accounts flyout under the lim wrap (absolute, end-aligned). */
const accountsMenu = () => panel().locator('#nav-actions .smenu.accts:not([hidden])');

/**
 * Wait until the lim button is in the expected mode. Auth poll is off the 2s
 * board tick (30s) but the first push after activate is prompt, and login /
 * logout force a refresh — so 30s is only the cold-start budget.
 */
async function waitLim(mode: 'login' | 'usage', ms = 30_000): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    const btn = lim();
    if ((await btn.count()) > 0) {
      const text = ((await btn.textContent()) ?? '').trim();
      last = text;
      const isLogin = (await btn.evaluate((el) => el.classList.contains('login'))) === true;
      if (mode === 'login' && isLogin && /log in/i.test(text)) return;
      if (mode === 'usage' && !isLogin && text.length > 0) return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`lim never became ${mode} (last text: ${JSON.stringify(last)})`);
}

async function closeMenuIfOpen(): Promise<void> {
  if (
    await accountsMenu()
      .isVisible()
      .catch(() => false)
  ) {
    // Portalled menu covers the board; Esc is the reliable close (kit onMenuKey).
    await panel().locator('body').press('Escape');
    await accountsMenu()
      .waitFor({ state: 'hidden', timeout: 5_000 })
      .catch(() => {});
  }
}

async function openAccountsMenu(mode?: 'login' | 'usage'): Promise<void> {
  // Log in only when no live brand is signed in. Grok-in / Claude-out is usage.
  if (!mode) {
    await lim().waitFor({ timeout: 30_000 });
    mode = (await lim().evaluate((el) => el.classList.contains('login'))) ? 'login' : 'usage';
  }
  await waitLim(mode);
  await closeMenuIfOpen();
  await lim().click();
  await accountsMenu().waitFor({ state: 'visible', timeout: 10_000 });
}

const claudeRow = () => accountsMenu().locator('.acct', { hasText: 'Claude' });
const grokRow = () => accountsMenu().locator('.acct', { hasText: 'Grok' });
const codexRow = () => accountsMenu().locator('.acct', { hasText: 'Codex' });

/** Reopen the menu until that brand paints Sign in. A held-open menu can keep the signed-in row. */
async function waitBrandSignedOut(
  row: () => ReturnType<typeof claudeRow>,
  label: string
): Promise<void> {
  const until = Date.now() + 15_000;
  for (;;) {
    await closeMenuIfOpen();
    await openAccountsMenu();
    if ((await row().locator('button.act.in').count()) > 0) return;
    assert.ok(Date.now() < until, `${label} row never showed Sign in after logout`);
  }
}

/** Reopen the menu until Grok paints Sign in. A held-open menu can keep the signed-in row. */
async function waitGrokSignedOut(): Promise<void> {
  return waitBrandSignedOut(grokRow, 'Grok');
}

/**
 * Reopen the menu until it paints `want`. Reading `textContent()` once instead
 * is the shape that has made this file cry wolf twice: the rows come from the
 * auth poll, so a menu opened a beat early keeps what it was opened with and
 * fails as a genuine `AssertionError` rather than as a timeout — which reads as
 * a product bug and gets a commit blamed for it. Budget matches `waitLim`, for
 * the reason given there.
 */
async function waitMenuText(
  want: RegExp,
  label: string,
  ms = 30_000,
  mode: 'login' | 'usage' = 'usage'
): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  for (;;) {
    await closeMenuIfOpen();
    await openAccountsMenu(mode);
    last = (await accountsMenu().textContent()) ?? '';
    if (want.test(last)) return;
    assert.ok(Date.now() < until, `${label} never painted (last: ${JSON.stringify(last)})`);
    await accountsMenu().page().waitForTimeout(250);
  }
}

async function expectLoginUrl(want: RegExp): Promise<void> {
  await scrim().locator('.aurl').filter({ hasText: want }).waitFor({ timeout: 15_000 });
}

/** Sign in from the accounts popover (Claude only). */
async function startClaudeSignInFromMenu(mode: 'login' | 'usage' = 'login'): Promise<void> {
  await openAccountsMenu(mode);
  await claudeRow().locator('button.act.in').click();
  await scrim().waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * The chip follows the last busy→idle edge, not the first signed-in row. The
 * store under test is Claude's, so idle the fixture (Claude) to make that edge
 * own the chip, whatever an earlier step in this section left it on.
 */
async function pinChipToClaude(): Promise<void> {
  const { pid } = await fixtureSession();
  const card = panel().locator(`#cards .card[data-pid="${pid}"]`);
  await card.waitFor({ timeout: 30_000 });
  // A real turn, because the fixture is an owned session since row 71 and its
  // state is what its frames say rather than what a pid file claims. The edge
  // is the whole point, so idle is waited for on both sides of it: a `busy`
  // read off a paint left over from an earlier case proves nothing
  // (`src/test/AGENTS.md`, *a gate satisfied by the previous turn*).
  await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  await card.locator('.name').click();
  await panel().locator('#chat').waitFor({ timeout: 10_000 });
  await composer().fill('one more turn for the chip');
  await composer().press('Enter');
  await card.and(panel().locator('.idle')).waitFor({ timeout: 30_000 });
  await lim().locator('svg.bm.cl').waitFor({ timeout: 10_000 });
}

section('account usage without a conversation', () => {
  before(async () => {
    await openPanel();
    await clearOnboarding();
  });

  const readingFile = () => path.join(homeDir(), '.squadron', 'usage.claude.json');
  const waitForReading = async (after: number): Promise<void> => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const reading = await fs
        .readFile(readingFile(), 'utf8')
        .then((text) => JSON.parse(text) as { at?: number; windows?: { pct?: number }[] })
        .catch(() => undefined);
      if ((reading?.at ?? 0) >= after && reading?.windows?.some((window) => window.pct === 3))
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('background usage never received a current Claude reading');
  };

  step('fetches usage without creating a session card', async () => {
    await waitForReading(Date.now() - 30_000);
    assert.equal(await panel().locator('#cards .card[data-pid]').count(), 0);
    await openAccountsMenu('usage');
    await waitMenuText(/3%/, 'fresh Claude usage');
    assert.match((await claudeRow().textContent()) ?? '', /3%/);
    await closeMenuIfOpen();
  });

  step('refreshes stale usage with the panel closed', async () => {
    await closeEditors();
    const stateFile = path.join(homeDir(), '.squadron', 'usage-refresh.claude.json');
    const until = Date.now() + 10_000;
    let state: { attempt?: unknown; notBefore: number };
    for (;;) {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as typeof state;
      if (!state.attempt) break;
      assert.ok(Date.now() < until, 'initial usage child did not finish');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const after = Date.now();
    await fs.writeFile(
      readingFile(),
      JSON.stringify({
        at: after - 2 * 60 * 60_000,
        windows: [{ id: 'session', short: '5h', pct: 81, at: after - 2 * 60 * 60_000 }]
      })
    );
    await fs.writeFile(stateFile, JSON.stringify({ ...state, notBefore: 0 }));
    await waitForReading(after);
    await openPanel();
    assert.equal(await panel().locator('#cards .card[data-pid]').count(), 0);
  });
  step('refreshes another brand while one quota record is damaged', async () => {
    const state = path.join(homeDir(), '.squadron', 'usage-refresh.claude.json');
    const auth = path.join(homeDir(), '.codex', 'auth.json');
    const fakeAuth = path.join(homeDir(), '.codex', 'fake-auth.json');
    const saved = await fs.readFile(state, 'utf8');
    const savedAuth = await fs.readFile(auth).catch(() => undefined);
    await closeEditors();
    try {
      await fs.writeFile(state, '{}');
      await fs.writeFile(fakeAuth, JSON.stringify({ email: 'codex-smoke@example.invalid' }));
      await fs.writeFile(auth, '{}');
      const file = path.join(homeDir(), '.squadron', 'usage.codex.json');
      const until = Date.now() + 10_000;
      for (;;) {
        const reading = await fs
          .readFile(file, 'utf8')
          .then((text) => JSON.parse(text) as { windows: { pct?: number }[] })
          .catch(() => undefined);
        if (reading?.windows.some((window) => window.pct === 45)) break;
        assert.ok(Date.now() < until, 'healthy Codex quota blocked by damaged Claude state');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await fs.writeFile(state, saved);
      await fs.rm(fakeAuth, { force: true });
      if (savedAuth) await fs.writeFile(auth, savedAuth);
      else await fs.rm(auth, { force: true });
      await openPanel();
    }
  });

  step('starts a conversation when quota maintenance state is damaged', async () => {
    const file = path.join(homeDir(), '.squadron', 'usage-refresh.claude.json');
    const saved = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, '{}');
      await startFromDraft('damaged quota record conversation');
      const card = panel().locator('#cards .card[data-pid]').first();
      await card.waitFor({ timeout: 10_000 });
      const pid = await card.getAttribute('data-pid');
      assert.ok(pid);
      await endCard(pid);
    } finally {
      await fs.writeFile(file, saved);
    }
  });
});

/**
 * Usage follows a live session rather than the hourly fallback
 * (PRD_planned_live_account_usage.md). Part A is a turn with no quota push:
 * the read it schedules returns the same figure, and the stamp still moves.
 * Part B is a push, which lands at once and is held to no bound.
 */
section('account usage follows a live session', () => {
  before(async () => {
    await openPanel();
    await clearOnboarding();
  });

  const dir = () => path.join(homeDir(), '.squadron');
  type Stored = { at?: number; windows?: { id: string; pct?: number; at?: number }[] };
  const stored = async (): Promise<Stored | undefined> =>
    fs
      .readFile(path.join(dir(), 'usage.claude.json'), 'utf8')
      .then((text) => JSON.parse(text) as Stored)
      .catch(() => undefined);
  const waitStored = async (want: (reading: Stored) => boolean, label: string, ms = 20_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const reading = await stored();
      if (reading && want(reading)) return reading;
      assert.ok(Date.now() < until, `${label}: ${JSON.stringify(reading)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  /** Reopen the menu until the Claude row says it: another brand's row may
   *  carry its own "updated" age. */
  const waitClaudeRow = async (want: RegExp, label: string): Promise<void> => {
    const until = Date.now() + 20_000;
    let last = '';
    for (;;) {
      await closeMenuIfOpen();
      await openAccountsMenu('usage');
      last = (await claudeRow().textContent()) ?? '';
      if (want.test(last)) return;
      assert.ok(Date.now() < until, `${label}: ${last}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  let pid: string | null = null;

  after(async () => {
    if (pid) await endCard(pid).catch(() => {});
  });

  step('restamps an unchanged figure when a turn ends, without the hourly read', async () => {
    const stateFile = path.join(dir(), 'usage-refresh.claude.json');
    // Let activation's own fallback read finish, then make the reading 50
    // minutes old with the figures the fake's get_usage answers, so only the
    // stamp can tell a new observation from the seed.
    const settled = Date.now() + 15_000;
    let state: { attempt?: unknown; notBefore: number; activeAfter?: number };
    for (;;) {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as typeof state;
      if (!state.attempt) break;
      assert.ok(Date.now() < settled, 'activation usage read did not finish');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const seeded = Date.now() - 50 * 60_000;
    const hour = Math.floor(Date.now() / 1000) + 3 * 3600;
    const week = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
    await fs.writeFile(
      path.join(dir(), 'usage.claude.json'),
      JSON.stringify({
        at: seeded,
        windows: [
          { id: 'session', short: '5h', pct: 3, resetsAt: hour, at: seeded },
          { id: 'weekly', short: 'wk', pct: 47, resetsAt: week, at: seeded }
        ]
      })
    );
    const { activeAfter: _drop, ...rest } = state;
    await fs.writeFile(stateFile, JSON.stringify({ ...rest, notBefore: seeded + 60 * 60_000 }));
    await waitClaudeRow(/updated 50m ago/, 'the seeded 50-minute-old reading');
    await closeMenuIfOpen();

    const started = Date.now();
    await startFromDraft('live usage card');
    const card = panel().locator('#cards .card[data-pid]').first();
    await card.waitFor({ timeout: 10_000 });
    pid = await card.getAttribute('data-pid');
    await panel()
      .locator(`#cards .card[data-pid="${pid}"]`)
      .and(panel().locator('.idle'))
      .waitFor({ timeout: 30_000 });
    // The draft's own first turn is the hint: a card counts its turns from zero.
    const read = await waitStored(
      (reading) => (reading.at ?? 0) > seeded,
      'the turn end never brought a fresh reading'
    );
    assert.ok((read.at ?? 0) >= started);
    assert.equal(read.windows?.find((window) => window.id === 'weekly')?.pct, 47);
    await waitClaudeRow(/updated \d+s ago/, 'the row still dates the seeded reading');
    await closeMenuIfOpen();
  });

  step('takes a quota push at once, inside the active-refresh bound', async () => {
    const sent = Date.now();
    await composer().fill('quota-push please');
    await composer().press('Enter');
    const read = await waitStored(
      (reading) => reading.windows?.some((window) => window.pct === 62) === true,
      'the pushed figure never reached the store',
      10_000
    );
    assert.ok((read.at ?? 0) >= sent);
    await waitClaudeRow(/62%/, 'the pushed figure');
    await closeMenuIfOpen();
  });
});

section('accounts auth surfaces, in the real IDE', () => {
  before(async () => {
    await openPanel();
    await clearOnboarding();
    // Stock VS Code showed no link prompt in accounts smoke on 2026-10-23;
    // older hosts can block sheet actions with one. Cancel it if it appears.
    await ctx.page.addLocatorHandler(ctx.page.locator('.monaco-dialog-box'), async (box) => {
      assert.match((await box.textContent()) ?? '', /claude\.com\/cai\/oauth|codex\.smoke\.test/);
      await box.locator('.monaco-button', { hasText: 'Cancel' }).click();
    });
  });

  after(async () => {
    if (!ctx.page.isClosed()) {
      await ctx.page.removeLocatorHandler(ctx.page.locator('.monaco-dialog-box'));
    }
  });

  step('paints a figure another process wrote to the store', async () => {
    // The one claim in this feature only a host can answer. The store is
    // canonical: no session here is reporting anything, no dump on this machine
    // carries limits, and the figure still has to reach the chip — written by
    // something else, re-read by the host, and painted. The unit test covers
    // missed file events; this checks the full path through the host's poll.
    await pinChipToClaude();
    // The widest reset `until()` can print, mid-minute so a clock tick under the
    // render cannot shorten it: `resets 23h 59m`, an hours-and-minutes window
    // just under a day. It is the popover's worst case, and measuring it is
    // what the fit assertion below does with it.
    const reset = Math.floor(Date.now() / 1000) + 23 * 3600 + 59 * 60 + 30;
    await fs.mkdir(path.join(homeDir(), '.squadron'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir(), '.squadron', 'usage.claude.json'),
      JSON.stringify({
        // Stamped, as every reading is: the store ranks them by when they were
        // taken, and a record with no stamp is one whose age nothing can
        // establish.
        at: Date.now(),
        windows: [
          { id: 'session', short: '5h', pct: 61, resetsAt: reset },
          { id: 'weekly', short: 'wk', pct: 77, resetsAt: reset },
          // The rollover, stated the way the store states it: `narrow` keeps a
          // window declaring only its name and its reset, and `currentUsage`
          // does not retire one whose reset is still ahead. It reaches the
          // popover with a reset time and no number, which is the row the
          // popover used to draw without its reset.
          { id: 'monthly', short: 'mo', resetsAt: reset }
        ]
      })
    );
    // Poll for the reading rather than for the next paint. Grok's half is
    // dashes on a machine with no reachable billing endpoint, which is what
    // the barrel showed while this still assumed the first signed-in row.
    const start = Date.now();
    let last = '';
    while (Date.now() - start < 30_000) {
      last = (await lim().textContent()) ?? '';
      if (last.includes('61%')) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.match(last, /61%/, 'the store never reached the chip');
    assert.match(last, /77%/);
  });

  step('opens the accounts popover from the usage control', async () => {
    await openAccountsMenu();
    const text = (await accountsMenu().textContent()) ?? '';
    assert.match(text, /Accounts/);
    assert.match(text, /smoke@example\.invalid/);
    assert.match(text, /Sign out/);
    assert.match(text, /Codex/);
    assert.ok((await codexRow().locator('button.act.in').count()) > 0, 'Codex is not live');
    // Gear settings must not be mixed into this flyout.
    assert.ok(!/Board|Theme/.test(text), 'settings rows leaked into accounts');

    // End-aligned under lim: menu right edge tracks the lim control (CSS right:0
    // on .fwrap). Absolute + measured left was landing a 316px menu at left:0.
    const geom = await panel()
      .locator('body')
      .evaluate(() => {
        const menu = document.querySelector<HTMLElement>('#nav-actions .smenu.accts:not([hidden])');
        const lim = document.querySelector<HTMLElement>('#nav button.lim');
        if (!menu || !lim) return null;
        const m = menu.getBoundingClientRect();
        const a = lim.getBoundingClientRect();
        return {
          menuRight: m.right,
          menuLeft: m.left,
          menuTop: m.top,
          menuWidth: m.width,
          limRight: a.right,
          limBottom: a.bottom,
          styleRight: menu.style.right,
          styleLeft: menu.style.left
        };
      });
    assert.ok(geom, 'menu and lim measurable');

    assert.equal(geom.styleRight, '0px');
    assert.equal(geom.styleLeft, 'auto');
    assert.ok(geom.menuWidth > 200, `menu width ${geom.menuWidth}`);
    assert.ok(
      Math.abs(geom.menuRight - geom.limRight) < 8,
      `menu right ${geom.menuRight} should track lim right ${geom.limRight}`
    );
    assert.ok(
      geom.menuTop >= geom.limBottom - 4,
      `menu top ${geom.menuTop} should sit under lim bottom ${geom.limBottom}`
    );

    // Last, so a regression here cannot mask the anchoring above. Each window
    // gets a line of its own, four fixed tracks wide, ending in when it turns
    // over — lines that can widen the 316px popover or scroll it sideways, and
    // jsdom lays nothing out to say whether they did. The age moved up to the
    // detail line, which is nowrap in the same `1fr` track and measured with
    // them. Claude's row by name, not the first one with figures: the seeded
    // reading is Claude's, and a selector that slid to Grok's undated row would
    // fail as an AssertionError about the product rather than about test order.
    const fits = await panel()
      .locator('body')
      .evaluate(() => {
        const menu = document.querySelector<HTMLElement>('#nav-actions .smenu.accts:not([hidden])');
        const row = [...(menu?.querySelectorAll<HTMLElement>('.acct') ?? [])].find((r) =>
          r.textContent?.includes('Claude')
        );
        const detail = row?.querySelector<HTMLElement>('.pl');
        const wins = [...(row?.querySelectorAll<HTMLElement>('.win') ?? [])];
        if (!menu || !detail || wins.length === 0) return null;
        const over = (n: HTMLElement): number => n.scrollWidth - n.clientWidth;
        return {
          detail: detail.textContent ?? '',
          resets: wins.map((w) => w.querySelector('.wl')?.textContent ?? ''),
          lineOver: Math.max(
            over(detail),
            ...wins.flatMap((w) => [over(w), ...[...w.children].map((c) => over(c as HTMLElement))])
          ),
          menuOver: menu.scrollWidth - menu.clientWidth
        };
      });
    assert.ok(fits, 'a Claude row with window lines to measure');
    assert.match(fits.detail, /updated .+ ago$/, 'the seeded reading is dated on its row');
    // Every seeded window carries a `resetsAt`, so every line prints one — the
    // claim the popover gained, measured where it is drawn.
    assert.ok(
      fits.resets.every((r) => /^ resets \d/.test(r)),
      `every seeded window states its reset: ${JSON.stringify(fits.resets)}`
    );
    // The seed prints `resets 23h 59m`, the widest thing `until()` can put in
    // that column, so this is the worst case and not merely a case. The bar is
    // a fixed 46px and spends the width the reset then has to fit in; over the
    // line the column ellipsises a duration into a lie rather than overflowing
    // visibly, which is why the measurement is here and not on the text.
    assert.ok(
      fits.lineOver <= 1,
      `a window line is clipped by ${fits.lineOver}px — narrow the bar or ` +
        `shorten the phrase (${JSON.stringify(fits.resets)})`
    );
    assert.ok(fits.menuOver <= 1, `popover scrolls sideways by ${fits.menuOver}px`);
    await closeMenuIfOpen();
  });

  /**
   * The plan chip used to be inline content inside the label's own clipped box,
   * so a long email pushed it under the ellipsis and it vanished whole — a real
   * account's `Max 20x` was nowhere on screen. jsdom can say the clip moved off
   * the chip's box (`accounts.test.ts`); only a host can say the chip is still
   * there once the label has run out of room.
   *
   * Probed on a clone of the live row, in place, so the panel's own font and the
   * real 316px track decide the answer rather than this file's guess at it — the
   * idiom the readout-slot case below uses, and for the same reason. The fake
   * CLI states no `subscriptionType`, so its row carries no chip to borrow.
   */
  step('keeps a plan chip whole beside a label too long for the row', async () => {
    await openAccountsMenu();
    const geom = await accountsMenu().evaluate((menu) => {
      const em = menu.querySelector<HTMLElement>('.acct .em');
      if (!em?.parentElement) return null;
      const probe = em.cloneNode(true) as HTMLElement;
      const label = probe.querySelector<HTMLElement>('.t');
      if (!label) return null;
      label.textContent = 'alexandra.morgan@example-co.dev';
      let chip = probe.querySelector<HTMLElement>('.plan');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'plan';
        chip.textContent = 'Enterprise';
        probe.append(chip);
      }
      em.parentElement.append(probe);
      const c = chip.getBoundingClientRect();
      const box = probe.getBoundingClientRect();
      const out = {
        chipWidth: c.width,
        chipVisible: Math.max(0, Math.min(c.right, box.right) - c.left),
        labelClipped: label.scrollWidth > Math.ceil(label.getBoundingClientRect().width)
      };
      probe.remove();
      return out;
    });
    assert.ok(geom, 'an account label to probe');
    assert.ok(geom.chipWidth > 0, 'the chip has a box at all');
    // Without this the case passes on a row with room to spare and proves
    // nothing: the label has to be the thing that runs out of room.
    assert.ok(geom.labelClipped, 'the label is not long enough to force the question');
    assert.ok(
      geom.chipVisible >= geom.chipWidth - 0.5,
      `chip clipped: ${geom.chipVisible}px of ${geom.chipWidth}px drawn`
    );
    await closeMenuIfOpen();
  });

  /**
   * A window out of a rollover has a reset time and no number — `core/usage.ts`
   * keeps the declaration and retires the figure — and the popover has to say
   * the reset anyway, which is the whole of what was asked for. The words then
   * share the line with it: without `.wv.bare:not(:last-child)` they span all
   * three of the cells a track would have, the reset has nowhere to be placed,
   * and it drops to a second row. jsdom lays nothing out and can only see that
   * the rule exists (`accounts.test.ts`); one line or two is knowable here.
   *
   * Read off the live row, not a clone: the `monthly` window the store was
   * seeded with above arrives in exactly that state, so this measures the DOM
   * `windowRow` builds rather than one this file re-types after it. Against a
   * figure row, because the claim that matters is that the resets line up down
   * the popover whether or not the window beside them still has a number.
   */
  step('keeps a figure-less window and its reset on one line', async () => {
    await openAccountsMenu();
    const geom = await accountsMenu().evaluate((menu) => {
      const rows = [...menu.querySelectorAll<HTMLElement>('.win')];
      const bare = rows.find((w) => w.querySelector('.wv.bare') && w.querySelector('.wl'));
      const figure = rows.find((w) => w.querySelector('.wb') && w.querySelector('.wl'));
      if (!bare || !figure) return null;
      const box = (n: Element): DOMRect => n.getBoundingClientRect();
      const words = bare.querySelector('.wv.bare') as Element;
      const reset = bare.querySelector('.wl') as Element;
      return {
        text: (bare.textContent ?? '').replace(/\s+/g, ' ').trim(),
        rows: Math.round(box(bare).height / Math.max(1, Math.round(box(figure).height))),
        sameTop: Math.abs(box(reset).top - box(words).top) <= 1,
        // The reset column, read on both rows: a bare row that took the last
        // cell too would push its reset out of the column it aligns in.
        drift: Math.abs(box(reset).left - box(figure.querySelector('.wl') as Element).left)
      };
    });
    assert.ok(geom, 'a rollover window line and a figure line to read');
    assert.match(geom.text, /^mo - resets \d/, `the seeded rollover row: ${geom.text}`);
    assert.equal(geom.rows, 1, 'the reset dropped to a second row');
    assert.ok(geom.sameTop, 'the reset does not sit on the words it follows');
    assert.ok(geom.drift <= 1, `the reset column drifts ${geom.drift}px without a figure`);
    await closeMenuIfOpen();
  });

  /**
   * A figure that changes must not move the phrase around it. `.lim .v` buys
   * that with a hand-sized `min-width`, so the slot is only ever as wide as the
   * last string somebody thought to measure — and 100% was not one of them. It
   * was cut to fit `none` and `99%`, and a third digit is a whole tabular
   * character more. A week at 100% is not hypothetical: it is the reading the
   * usage store was built to keep.
   *
   * Measured off the live node, cloned in place, so the panel's own font
   * decides the answer rather than this file's guess at it. jsdom lays nothing
   * out, so this is only knowable here.
   */
  step('holds the readout slot width from a dash to 100%', async () => {
    await waitLim('usage');
    const widths = await lim().evaluate((btn) => {
      const live = btn.querySelector<HTMLElement>('.v');
      if (!live) return null;
      const probe = live.cloneNode(false) as HTMLElement;
      live.parentElement?.append(probe);
      const of = (text: string): number => {
        probe.textContent = text;
        return probe.getBoundingClientRect().width;
      };
      const out = { dash: of('-'), none: of('none'), two: of('42%'), full: of('100%') };
      probe.remove();
      return out;
    });
    assert.ok(widths, 'a usage slot to measure');
    assert.equal(
      new Set(Object.values(widths).map((w) => Math.round(w))).size,
      1,
      `the readout slot resizes with its reading: ${JSON.stringify(widths)}`
    );
  });

  /**
   * The fill is as long as the figure beside it says. Why it was not, and the
   * measurement: `css/nav.ts`, on the `.wb` rule. `accounts.test.ts` holds the
   * cascade half; only a laid-out host can say what was actually painted, and
   * that is the half a reader would have noticed.
   *
   * `said` is read off the row rather than from the seed above, because by the
   * time this runs the figure on screen may not be the seeded one: the fake
   * CLI answers `get_usage` with its own utilizations (`fixtures/fake-cli.ts`),
   * and whichever reading is newer is the one the store keeps. The claim does
   * not need to know which — each fill is where its own figure puts it, and no
   * two of them land in the same place.
   *
   * Two, because a track is only built for a window that has a figure: the
   * figure-less rollover row filters itself out by having none.
   */
  step('paints each usage fill the length of its figure', async () => {
    await openAccountsMenu('usage');
    const bars = await claudeRow().evaluate((row) =>
      [...row.querySelectorAll<HTMLElement>('.win .wb')].map((track) => ({
        said: Number.parseInt(track.parentElement?.querySelector('.wv')?.textContent ?? '', 10),
        // Rounded to whole percent: a sub-pixel fill is the bug, and a half
        // pixel of the browser's own rounding is not.
        drew: Math.round(
          ((track.firstElementChild?.getBoundingClientRect().width ?? 0) /
            track.getBoundingClientRect().width) *
            100
        )
      }))
    );
    assert.equal(bars.length, 2, `two Claude windows with figures: ${JSON.stringify(bars)}`);
    for (const b of bars) {
      assert.ok(
        Math.abs(b.drew - b.said) <= 2,
        `a fill for ${b.said}% painted ${b.drew}% of its track`
      );
    }
    assert.notEqual(bars[0]?.drew, bars[1]?.drew, 'both windows painted the same length');
    await closeMenuIfOpen();
  });

  step('opens the sign-out confirm sheet and cancels without logging out', async () => {
    await openAccountsMenu();
    await claudeRow().locator('button.act.out').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign out of Claude/);
    assert.match((await scrim().textContent()) ?? '', /Credentials are shared/);
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    // Still signed in — usage control, not Log in.
    await waitLim('usage', 10_000);
  });

  step('signs out Claude and keeps the usage chip while Grok is in', async () => {
    await openAccountsMenu();
    await claudeRow().locator('button.act.out').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    await scrim().locator('.asfoot button.dgr', { hasText: 'Sign out of Claude' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    await waitBrandSignedOut(claudeRow, 'Claude');
    await waitLim('usage');
    assert.equal(await lim().evaluate((el) => el.classList.contains('login')), false);

    // Grok alone on the chip, and Grok states one window. `waitLim` only asks
    // that the readout is non-empty, so the shape of it is asserted here: no
    // phantom `5h` slot, and no separator left dangling after the only one.
    await closeMenuIfOpen();

    // Grok alone on the chip. `waitLim` only asks that the readout is non-empty,
    // so the shape of it is asserted here: Grok has no 5-hour limit and says so
    // as `5h none`, which is a different claim from `5h -`.
    //
    // **After the popover closes, not before.** `pickUsageAccount` freezes the
    // chip on whichever brand it is showing while a menu is open, so asserting
    // with it up reads Claude's two windows however long you wait for it.
    let readout = '';
    // 30s, not 15: a duration budget has to clear the *interval* it waits on.
    // Signing out forces an auth refresh, so this normally lands in well under a
    // second — but when that push is missed the next one is `AUTH_MS`
    // (`host/panel_auth.ts`, 30s interval) away, and a 15s budget could not
    // reach it. It flaked exactly there, on a barrel 39% slower than baseline.
    // Same budget and same reason as `waitLim`.
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      readout = ((await lim().textContent()) ?? '').trim();
      if (/^5h none\b/.test(readout)) break;
      await lim().page().waitForTimeout(250);
    }
    assert.match(readout, /^5h none · wk\b/, readout);
    assert.doesNotMatch(readout, /·\s*$/, readout);
  });

  step('opens the accounts popover from the usage chip, then the Claude login sheet', async () => {
    await openAccountsMenu('usage');
    const text = (await accountsMenu().textContent()) ?? '';
    assert.match(text, /Accounts/);
    assert.match(text, /Sign in/);
    assert.match(text, /Codex/);
    assert.ok((await codexRow().locator('button.act.in').count()) > 0, 'Codex is not live');
    await claudeRow().locator('button.act.in').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign in to Claude/);
    // Host spawn → fake-cli prints URL + paste prompt → phase browser/paste.
    await scrim().locator('input.acode').waitFor({ timeout: 15_000 });
    await expectLoginUrl(/claude\.com\/cai\/oauth/);
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    // Cancel does not complete login. Grok is still in, so the chip stays usage.
    await waitLim('usage', 10_000);
  });

  step('fits a masked authorization code in the checking input', async () => {
    await startClaudeSignInFromMenu('usage');
    const input = scrim().locator('input.acode');
    await input.waitFor({ timeout: 15_000 });
    await expectLoginUrl(/claude\.com\/cai\/oauth/);
    assert.equal(await input.getAttribute('type'), 'password');
    await input.fill('abcd.secret-middle.wxyz');
    // Hold the checking phase for geometry; the fake CLI exits on submission.
    await input.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'loginProgress', brand: 'claude', phase: 'waiting' }
        })
      );
    });
    assert.equal(await input.inputValue(), 'abcd••••••••wxyz');
    const fit = await input.evaluate((node) => {
      const field = node as HTMLInputElement;
      const style = getComputedStyle(field);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      ctx.font = style.font;
      return {
        text: ctx.measureText(field.value).width,
        available:
          field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: field.getBoundingClientRect().height
      };
    });
    assert.ok(fit.text <= fit.available, JSON.stringify(fit));
    assert.ok(fit.height >= 24, JSON.stringify(fit));
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
  });

  step('completes paste-code login and restores the accounts control', async () => {
    // A cancelled login must not leave the scrim up (host gen guard).
    if (
      await scrim()
        .isVisible()
        .catch(() => false)
    ) {
      await scrim()
        .locator('.asfoot button', { hasText: 'Cancel' })
        .click()
        .catch(() => {});
      await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await startClaudeSignInFromMenu('usage');
    await scrim().locator('input.acode').waitFor({ timeout: 15_000 });
    await expectLoginUrl(/claude\.com\/cai\/oauth/);
    await scrim().locator('input.acode').fill('smoke-auth-code');
    await scrim().locator('.asfoot button.pri', { hasText: 'Submit' }).click();
    // forceAuth after exit 0; sheet closes on done.
    await scrim().waitFor({ state: 'hidden', timeout: 30_000 });
    await waitLim('usage');
    await waitMenuText(/smoke@example\.invalid/, 'the signed-in email');
    await closeMenuIfOpen();
  });

  /**
   * Pipe CTA needs an owned session and a signed-out account. Spawn a short
   * child, open the dock, sign the account out from under it, assert the CTA
   * opens the same sheet, then stop so later steps do not inherit an extra card.
   *
   * **The session starts before the sign-out, and that order is load-bearing.**
   * A draft opens on `defaultPick()`, the first row of the offered list, and
   * `offeredModels` drops a brand with no account — so a New pressed after
   * Claude is out starts *Grok*, and a Claude CTA has no card to sit on. Which
   * is the case H53 is written for anyway: the pipe outlives the account, not
   * the other way round.
   *
   * It ran the other way until a3569106 and passed on a race — sign-out hid its
   * sheet on the click, so New was pressed while the accounts push still said
   * signed in. Keeping that sheet up until the host answers is what exposed it.
   */
  step('shows a Log in CTA on an owned pipe thread when signed out', async () => {
    await clearOnboarding();
    // New opens a draft; the send is what spawns.
    await startFromDraft('accounts smoke first turn', 'Opus');
    // Prefer a card that is not the shared fixture when both exist.
    const owned = panel()
      .locator('#cards .card[data-pid]')
      .filter({
        hasNot: panel().locator('.name', { hasText: FIXTURE_NAME })
      });
    await owned.first().waitFor({ timeout: 60_000 });
    const pid = await owned.first().getAttribute('data-pid');
    assert.ok(pid, 'owned card has no pid');
    await owned.first().click();
    await panel().locator('#chat').waitFor({ timeout: 10_000 });
    // The fake emits only a live delta; it can drain before this read.
    // The card's persistent mark still proves which brand started.
    await owned.first().locator('.bm.cl').waitFor({ timeout: 30_000 });

    // Sign Claude out under it. Grok stays in, so the chip is still usage —
    // the dock CTA is brand-scoped, not the nav Log in flip.
    await openAccountsMenu('usage');
    await claudeRow().locator('button.act.out').click();
    await scrim().locator('.asfoot button.dgr', { hasText: 'Sign out of Claude' }).click();
    // The sheet stays up until the host answers. The CTA opens the next sheet
    // on the same scrim, so this one has to be gone before they can be told
    // apart.
    await scrim().waitFor({ state: 'hidden', timeout: 30_000 });
    await waitLim('usage');

    const cta = panel().locator('.login-cta');
    await cta.waitFor({ timeout: 15_000 });
    assert.match((await cta.textContent()) ?? '', /Not signed in to Claude/);
    await cta.locator('button', { hasText: 'Log in' }).click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign in to Claude/);
    await expectLoginUrl(/claude\.com\/cai\/oauth/);
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });

    // Tear down the owned card so the files after this keep a clean board.
    // `endCard` and not a bare close: this session was started from a draft, so
    // it has run a turn and `closePlan` asks before ending it.
    await endCard(pid);
  });

  step('opens the Grok device-code sheet and cancels without a paste field', async () => {
    await openAccountsMenu();
    await grokRow().locator('button.act.out').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign out of Grok/);
    await scrim().locator('.asfoot button.dgr', { hasText: 'Sign out of Grok' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });

    await waitLim('login');
    await waitGrokSignedOut();
    await grokRow().locator('button.act.in').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign in to Grok/);
    await scrim().locator('.ucode').waitFor({ timeout: 15_000 });
    assert.equal(await scrim().locator('input.acode').count(), 0);
    assert.equal(await scrim().locator('.asfoot button.pri').count(), 0);
    assert.match((await scrim().textContent()) ?? '', /CGB6-Y7VF/);
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
  });

  step('completes Grok device-code login when the fixture flips signed in', async () => {
    if (
      await scrim()
        .isVisible()
        .catch(() => false)
    ) {
      await scrim()
        .locator('.asfoot button', { hasText: 'Cancel' })
        .click()
        .catch(() => {});
      await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await openAccountsMenu();
    await grokRow().locator('button.act.in').click();
    await scrim().locator('.ucode').waitFor({ timeout: 15_000 });
    await fs.writeFile(path.join(homeDir(), '.grok', 'fake-login-complete'), '1');
    await scrim().waitFor({ state: 'hidden', timeout: 30_000 });
    await openAccountsMenu('usage');
    assert.match((await accountsMenu().textContent()) ?? '', /grok-smoke@example\.invalid/);
    await closeMenuIfOpen();
  });

  step('signs Grok out through the confirm sheet', async () => {
    await openAccountsMenu();
    await grokRow().locator('button.act.out').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    await scrim().locator('.asfoot button.dgr', { hasText: 'Sign out of Grok' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    // Claude is already out (the pipe-CTA case). Signing Grok out leaves
    // nobody, so the chip flips to Log in. Inferring mode from the button
    // mid-flip sampled usage and then waited 30s for a chip that had already
    // become Log in — that refused the v2026.34.11 install twice.
    await waitLim('login');
    await waitGrokSignedOut();
    assert.match((await grokRow().textContent()) ?? '', /Sign in/);
    await closeMenuIfOpen();
  });

  step('starts and cancels the Codex device-code flow', async () => {
    await openAccountsMenu('login');
    await codexRow().locator('button.act.in').click();
    await scrim().waitFor({ state: 'visible', timeout: 10_000 });
    await scrim().locator('.ucode').waitFor({ timeout: 15_000 });
    assert.match((await scrim().textContent()) ?? '', /Sign in to Codex/);
    assert.match((await scrim().textContent()) ?? '', /CDX5-SMOK/);
    assert.equal(await scrim().locator('input.acode').count(), 0);
    await expectLoginUrl(/codex\.smoke\.test/);
    await scrim().locator('.asfoot button', { hasText: 'Cancel' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    await waitLim('login');
  });

  step('signs Codex in, reads usage, and signs out through the live row', async () => {
    await openAccountsMenu('login');
    await codexRow().locator('button.act.in').click();
    await scrim().locator('.ucode').waitFor({ timeout: 15_000 });
    await expectLoginUrl(/codex\.smoke\.test/);
    await fs.mkdir(path.join(homeDir(), '.codex'), { recursive: true });
    await fs.writeFile(path.join(homeDir(), '.codex', 'fake-login-complete'), '1');
    await scrim().waitFor({ state: 'hidden', timeout: 30_000 });
    await waitLim('usage');
    await waitMenuText(/codex-smoke@example\.invalid/, 'the signed-in Codex email');
    await waitMenuText(/45%/, 'fresh Codex usage');
    // One line per window now, and the reset with it. `no 5h limit` is the
    // nav tip's wording for a window this brand does not have — the chip above
    // still says `none`, which is all a one-line readout has room for.
    const codexWindows = (await codexRow().locator('.win').allTextContents()).map((w) =>
      w.replace(/\s+/g, ' ').trim()
    );
    assert.equal(codexWindows[0], '5h no 5h limit');
    assert.match(codexWindows[1] ?? '', /^wk 45% resets \d+d \d+h$/, codexWindows[1]);
    await codexRow().locator('button.act.out').click();
    await scrim().locator('.asfoot button.dgr', { hasText: 'Sign out of Codex' }).click();
    await scrim().waitFor({ state: 'hidden', timeout: 10_000 });
    await waitLim('login');
  });

  /**
   * The host half jsdom cannot see: `installed` read off a real `resolveBinary`
   * and carried onto the row, and two acts that lay out side by side rather
   * than on one grid cell. Nothing is clicked — Install opens a browser.
   */
  step('says a CLI whose path resolves to nothing is not installed', async () => {
    await patchSettings({ 'squadron.codexPath': path.join(ctx.profile, 'no-such-codex') });
    try {
      // The installed reading rides the auth tick (`AUTH_MS`), so a whole one
      // and some. Every brand is signed out by the step before: Log in mode.
      await waitMenuText(/Not installed/, 'a Not installed row', 45_000, 'login');
      assert.match((await codexRow().textContent()) ?? '', /Not installed/);
      const install = await codexRow().locator('button.act.install').boundingBox();
      const setPath = await codexRow().locator('button.act.path').boundingBox();
      assert.ok(install && setPath);
      assert.ok(install.x + install.width <= setPath.x, 'Install and Set path overlap');
      assert.ok(install.height >= 24 && setPath.height >= 24, 'an act is under 24px tall');
    } finally {
      await closeMenuIfOpen();
      await patchSettings({ 'squadron.codexPath': path.join(ctx.profile, 'codex') });
    }
  });
});
