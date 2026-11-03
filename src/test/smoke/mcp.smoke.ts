import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as timers from 'node:timers/promises';
import { before } from 'node:test';
import { argvLogPath, clearOnboarding, ctx, openPanel, panel, section, step } from './boot';
import { openDraft } from './kit';

/**
 * MCP servers: footer on the accounts popover, sheet over the board, against
 * a real host.
 *
 * jsdom covers the paint from a canned `mcp` field. `foldBoard` under
 * `npm run check` covers the parse and the fold, including this fixture's
 * twelve-row / two-section / one-Authorise claims. This file is the half
 * neither can reach:
 *
 * - **The login child is real.** The fake CLI requires terminal stdin and waits
 *   for the host to cancel it, through the selected console-login backend.
 * - **The boxes are real.** jsdom never measures a bounding box or a collapse
 *   height; Playwright does.
 *
 * Order matters: the cases run against one sheet state, and cancel follows
 * the child the one before it started.
 */

/** The name the fixture config declares, and the one Authorise acts on. */
const SERVER = 'smoke-mcp';

const lim = () => panel().locator('#nav button.lim');
const accountsMenu = () => panel().locator('#nav-actions .smenu.accts:not([hidden])');
const footer = () => accountsMenu().locator('.mcpfoot');
const sheet = () => panel().locator('#mscrim:not([hidden])');
const rows = () => sheet().locator('.srow');
/** The section holding what this window's repo declares — every filler is in it. */
const repoSec = () => sheet().locator('.rsec', { hasText: 'filler-0' });
/** The trailing one: Grok's config has no repo scope to be in a repo section with. */
const machineSec = () => sheet().locator('.rsec', { hasText: 'Not from a repo' });

/** One extra server per index, so the sheet has enough rows to overflow. */
const filler = (n: number): Record<string, unknown> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `filler-${i}`,
      { type: 'http', url: `https://mcp.filler-${i}.test/mcp` }
    ])
  );

/**
 * Write the Claude and Grok files the panel reads. The fixture `HOME` is
 * what makes this possible — `core/paths.ts` resolves both off
 * `os.homedir()`, and the host is booted with `HOME` pointing at the temp
 * profile.
 */
async function writeMcpFixture(needsAuth: boolean): Promise<void> {
  const project = path.join(ctx.home, 'project').split(path.sep).join('/');
  await fs.writeFile(
    path.join(ctx.home, '.claude.json'),
    JSON.stringify({
      projects: {
        [project]: {
          mcpServers: {
            [SERVER]: { type: 'http', url: 'https://mcp.smoke.test/mcp' },
            ...filler(11)
          }
        }
      }
    })
  );
  await fs.mkdir(path.join(ctx.home, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(ctx.home, '.claude', 'mcp-needs-auth-cache.json'),
    needsAuth ? JSON.stringify({ [SERVER]: { timestamp: 1 } }) : '{}'
  );
  // Same URL as SERVER, so foldMcpView keeps one row. Credentials make the
  // Grok cell `ok` so the Claude-only Authorise count below stays 1.
  await fs.mkdir(path.join(ctx.home, '.grok'), { recursive: true });
  await fs.writeFile(
    path.join(ctx.home, '.grok', 'config.toml'),
    `[mcp_servers.${SERVER}]\nurl = "https://mcp.smoke.test/mcp"\nenabled = true\n`
  );
  await fs.writeFile(
    path.join(ctx.home, '.grok', 'mcp_credentials.json'),
    JSON.stringify({ [`${SERVER}:https://mcp.smoke.test/mcp`]: { token_response: {} } })
  );
  await writeCodexFixture();
}

/** The Codex name that starts `not_logged_in` and gets authorised below. */
const CODEX_OAUTH = 'codex-oauth';
/** The Codex name with no auth at all — a local process. */
const CODEX_STDIO = 'codex-stdio';

/**
 * What the fake `codex mcp list --json` answers, per cwd.
 *
 * **User scope only, deliberately.** Every Codex row lands in the trailing
 * section, so the repo section's DOM is exactly what it was — the cases above
 * reach for `button.ba.fix` sheet-wide with `.first()`, and a Codex Authorise
 * ahead of Claude's would silently retarget them.
 */
async function writeCodexFixture(): Promise<void> {
  await fs.mkdir(path.join(ctx.home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(ctx.home, '.codex', 'fake-mcp-user.json'),
    JSON.stringify([
      {
        name: CODEX_OAUTH,
        oauth: true,
        transport: { type: 'streamable_http', url: 'https://mcp.codex-smoke.test/mcp' }
      },
      {
        name: CODEX_STDIO,
        auth_status: 'unsupported',
        transport: {
          type: 'stdio',
          command: '/opt/smoke/pencil-server',
          // Neither may be painted. The assertion below is that they are not.
          args: ['--token', 'do-not-paint-me'],
          env: { SECRET: 'do-not-paint-me' },
          env_vars: ['SECRET']
        }
      }
    ])
  );
  await fs.rm(path.join(ctx.home, '.codex', 'fake-mcp-grants.json'), { force: true });
}

async function openAccountsMenu(): Promise<void> {
  await lim().waitFor({ state: 'visible', timeout: 30_000 });
  if (
    await accountsMenu()
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }
  await lim().click();
  await accountsMenu().waitFor({ state: 'visible', timeout: 10_000 });
}

async function openSheet(): Promise<void> {
  // The sheet covers the nav. Asking lim to open the accounts menu while
  // #mscrim is already up just times out — the first case leaves the sheet
  // open, and the rest reuse it.
  if (
    await sheet()
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }
  await openAccountsMenu();
  await footer().waitFor({ state: 'visible', timeout: 40_000 });
  await footer().click();
  await sheet().waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Open a section rather than trusting the default.
 *
 * This window's repo is open when the sheet opens, and that match is a path
 * comparison — `os.tmpdir()` hands back `/var/folders/…` for
 * `/private/var/folders/…`, so a miss shuts every section and takes five cases
 * with it. Pressing the head makes each case say what it needs.
 */
async function openSection(section: ReturnType<typeof repoSec>): Promise<void> {
  await section.waitFor({ state: 'attached', timeout: 30_000 });
  const open = await section.evaluate((el) => el.classList.contains('open'));
  if (open) return;
  await section.locator('.rhead').click();
  await section.locator('.srow').first().waitFor({ state: 'visible', timeout: 10_000 });
}

const openRepo = () => openSection(repoSec());

async function waitForHeldCommand(): Promise<void> {
  const marker = path.join(ctx.home, '.claude', 'fake-mcp-hold.entered');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await fs.stat(marker).catch(() => undefined)) return;
    await timers.setTimeout(20);
  }
  assert.fail('MCP CLI did not reach the held command');
}

section('mcp servers (smoke)', () => {
  before(async () => {
    await writeMcpFixture(true);
    await openPanel();
    await clearOnboarding();
  });

  step('draws a footer on the accounts popover, and the sheet opens', async () => {
    await openDraft();
    await panel().locator('#chat').waitFor({ state: 'visible' });
    const dock = await panel().locator('#dock').boundingBox();
    assert.ok(dock && dock.width > 100, 'dock must occupy part of the panel');
    await panel().locator('#nav-actions .gear').click();
    const settingsTitleY = await panel()
      .locator('#settings .ashead b')
      .evaluate((node) => node.getBoundingClientRect().y);
    await panel().locator('#settings .settings-close').click();
    await openAccountsMenu();
    await footer().waitFor({ state: 'visible', timeout: 40_000 });
    assert.match((await footer().textContent()) ?? '', /MCP/);
    await openSheet();
    await openRepo();
    await rows().first().waitFor({ state: 'visible', timeout: 10_000 });
    const bounds = await sheet().locator('[role="dialog"]').boundingBox();
    const viewport = await panel().locator('html').boundingBox();
    assert.ok(
      bounds &&
        viewport &&
        Math.abs(bounds.x + bounds.width / 2 - (viewport.x + viewport.width / 2)) <= 1,
      `MCP must center across the full panel with the dock open: ${JSON.stringify({ bounds, viewport })}`
    );
    const run = process.env['SQUADRON_RUN'];
    if (run)
      await panel()
        .locator('body')
        .screenshot({ path: path.join(run, 'mcp-dock-open.png') });
    const titleY = await sheet()
      .locator('.ashead b')
      .evaluate((node) => node.getBoundingClientRect().y);
    assert.ok(
      Math.abs(titleY - settingsTitleY) <= 1,
      'MCP title does not share the Settings header anchor'
    );
  });

  step('scrolls twelve rows rather than clipping them', async () => {
    await openSheet();
    await openRepo();
    const body = sheet().locator('.asbody');
    const overflowing = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    assert.ok(overflowing, 'sheet body overflows and therefore scrolls');
    // The trailing section is shut: its rows are in the sheet and not on
    // screen. Twelve repo rows are the overflow this case is about.
    const last = repoSec().locator('.srow').last();
    await last.scrollIntoViewIfNeeded();
    assert.ok(await last.isVisible(), 'the last row can be reached by scrolling');
  });

  step('gives every control a hit target a pointer can actually land on', async () => {
    await openSheet();
    await openRepo();
    await openSection(machineSec());
    const box = await sheet().locator('button.ba.fix').first().boundingBox();
    assert.ok(box, 'Authorise has a box');
    assert.ok(box.height >= 24, `Authorise is ${box.height}px tall, want >= 24`);
    assert.ok(box.width >= 24, `Authorise is ${box.width}px wide, want >= 24`);
    const claude = repoSec()
      .locator('.srow', { hasText: SERVER })
      .locator('.bcell', { has: panel().locator('.bm.cl') });
    const grok = machineSec()
      .locator('.srow', { hasText: SERVER })
      .locator('.bcell', { has: panel().locator('.bm.gr') });
    const gBox = await grok.boundingBox();
    const cBox = await claude.boundingBox();
    assert.ok(gBox && gBox.height >= 24 && gBox.width >= 24, 'Grok cell hit target');
    assert.ok(cBox && cBox.height >= 24 && cBox.width >= 24, 'Claude cell hit target');
  });

  step('packs each server into stable CLI columns without horizontal overflow', async () => {
    await openSheet();
    await openRepo();
    const labels = await repoSec().locator('.mchead > *').allTextContents();
    assert.deepEqual(
      labels.map((label) => label.trim()),
      ['Server', 'Claude', 'Grok', 'Codex']
    );

    const row = repoSec().locator('.srow', { hasText: 'filler-0' });
    assert.equal(await row.locator(':scope > .bcell').count(), 3, 'one cell per CLI');
    const box = await row.boundingBox();
    assert.ok(box && box.height <= 60, `ordinary row is ${box?.height}px tall, want <= 60`);

    const body = sheet().locator('.asbody');
    const sizes = await body.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(
      sizes.scroll <= sizes.client + 1,
      `body scroll width ${sizes.scroll}, client ${sizes.client}`
    );
  });

  step('responds immediately and cancels while login preparation is held', async () => {
    await openSheet();
    await openRepo();
    const hold = path.join(ctx.home, '.claude', 'fake-mcp-hold');
    await fs.rm(hold + '.entered', { force: true });
    await fs.writeFile(hold, `get:${SERVER}`);
    const row = repoSec().locator('.srow', { hasText: SERVER });
    try {
      const immediate = await row.locator('button.ba.fix').evaluate((node) => {
        (node as HTMLButtonElement).focus();
        (node as HTMLButtonElement).click();
        const cell = document.querySelector<HTMLElement>('.bcell[aria-busy="true"]');
        return {
          busy: !!cell,
          text: cell?.textContent,
          focused: cell?.contains(document.activeElement)
        };
      });
      assert.ok(immediate.busy, 'busy in the click task, before any host response');
      assert.match(immediate.text ?? '', /Starting/);
      assert.ok(immediate.focused, 'focus stays on the action');
      await waitForHeldCommand();
      assert.equal(await row.locator('.bcell[aria-busy="true"]').count(), 1);
      await row.locator('button.ba', { hasText: 'Cancel' }).click();
      await row.locator('button.ba.fix').waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(
        await sheet().locator('.mcpurl').count(),
        0,
        'cancel during preflight does not start login'
      );
    } finally {
      await fs.rm(hold, { force: true });
    }
  });

  step('runs the real login child and surfaces the url it printed', async () => {
    await openSheet();
    await openRepo();
    await sheet().locator('button.ba.fix').first().click();
    const url = sheet().locator('.mcpurl .aurl');
    await url.waitFor({ state: 'visible', timeout: 30_000 });
    const shown = (await url.textContent()) ?? '';
    assert.match(shown, /mcp\.smoke\.test\/authorize/);
    assert.ok(!shown.includes(String.fromCharCode(27)), 'no ESC reached the reader');
    assert.ok(!shown.includes(String.fromCharCode(7)), 'no BEL reached the reader');
    await sheet().locator('.mcpurl .b.pri').waitFor({ state: 'visible', timeout: 5_000 });
  });

  step('refuses a stale Disconnect without cancelling another login', async () => {
    await openSheet();
    await openRepo();
    const row = repoSec().locator('.srow', { hasText: 'filler-9' });
    await row.locator('button.ba.out').click();
    await row.locator('button.ba.arm').evaluate((node) => {
      (window as unknown as { staleMcpButton?: HTMLElement }).staleMcpButton = node as HTMLElement;
    });
    const file = path.join(ctx.home, '.claude.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8')) as {
      projects: Record<string, { mcpServers: Record<string, { url: string }> }>;
    };
    const servers =
      config.projects[path.join(ctx.home, 'project').split(path.sep).join('/')]?.mcpServers;
    assert.ok(servers);
    servers['filler-9'] = { url: 'https://changed.example/mcp' };
    await fs.writeFile(file, JSON.stringify(config));
    await sheet().evaluate(() => {
      const holder = window as unknown as { staleMcpButton?: HTMLElement };
      holder.staleMcpButton?.click();
      delete holder.staleMcpButton;
    });
    await repoSec()
      .locator('.srow', { hasText: 'changed.example' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await sheet().locator('.mcpurl .aurl').waitFor({ state: 'visible', timeout: 10_000 });
    const lines = (await fs.readFile(argvLogPath(), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      lines.some(
        (args) => args.includes('mcp') && args.includes('logout') && args.includes('filler-9')
      ),
      false
    );
  });

  step('cancels the child and puts the cell back', async () => {
    await openSheet();
    await openRepo();
    // Count Authorise before the click, because the assertion below is that
    // this row's own came back. Waiting on an unscoped `button.ba.fix` proves
    // nothing: a dozen rows never left Authorise, so one is already visible
    // when the click lands and the wait returns before the cancelled row has
    // repainted — and `count()` does not auto-wait, so it then raced it.
    const fixes = await sheet().locator('button.ba.fix').count();
    await sheet().locator('button.ba', { hasText: 'Cancel' }).first().click();
    // The url block and the restored cell are two halves of one repaint:
    // `cellBox` rebuilds the whole cell off `cell.state`, so a detached url
    // block is the repaint, not a step before it. Scoping to the running row
    // instead would not work — the row is only identifiable by the `.mcpurl`
    // the repaint removes, so the locator stops matching mid-wait.
    await sheet().locator('.mcpurl').waitFor({ state: 'detached', timeout: 20_000 });
    assert.equal(await sheet().locator('.mcpurl').count(), 0, 'url block went with the child');
    assert.equal(
      await sheet().locator('button.ba.fix').count(),
      fixes + 1,
      'the cancelled cell offers Authorise again'
    );
  });

  step('disconnects an authorised server, through the real logout child', async () => {
    await openSheet();
    await openRepo();
    const target = sheet().locator('.srow', { hasText: 'filler-0' });
    await target.waitFor({ state: 'visible', timeout: 20_000 });
    const disconnect = target.locator('button.ba.out');
    assert.equal((await disconnect.textContent())?.trim(), 'Disconnect');
    const box = await disconnect.boundingBox();
    assert.ok(box && box.height >= 24 && box.width >= 24, 'WCAG 2.2 SC 2.5.8 hit target');

    await disconnect.click();
    await target.locator('button.ba.arm').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(
      (await target.locator('button.ba.arm').textContent())?.trim(),
      'Disconnect?',
      'first press only arms'
    );

    const hold = path.join(ctx.home, '.claude', 'fake-mcp-hold');
    await fs.rm(hold + '.entered', { force: true });
    await fs.writeFile(hold, 'logout:filler-0');
    try {
      const immediate = await target.locator('button.ba.arm').evaluate((node) => {
        (node as HTMLButtonElement).click();
        const cell = document.querySelector<HTMLElement>('.bcell[aria-busy="true"]');
        return {
          busy: !!cell,
          text: cell?.textContent,
          disabled: cell?.querySelector('button')?.disabled
        };
      });
      assert.ok(immediate.busy);
      assert.match(immediate.text ?? '', /Disconnecting/);
      assert.ok(immediate.disabled);
      await waitForHeldCommand();
      assert.equal(
        await target.locator('.bcell[aria-busy="true"]').count(),
        1,
        'still pending while logout is held'
      );
    } finally {
      await fs.rm(hold, { force: true });
    }
    const authorise = sheet().locator('.srow', { hasText: 'filler-0' }).locator('button.ba.fix');
    await authorise.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal((await authorise.textContent())?.trim(), 'Authorise');
  });

  step('shuts a section down to a head that still says what is in it', async () => {
    // The whole reason a section is worth shutting: a reader with six repos on
    // the board gets six lines and can still see which one wants them.
    await openSheet();
    await openRepo();
    const head = repoSec().locator('.rhead');
    assert.equal(await repoSec().locator('.rcount').textContent(), '12');
    assert.equal(await repoSec().locator('.rdot').count(), 1, 'the head carries a state');

    const before = (await repoSec().boundingBox())?.height ?? 0;
    await head.click();
    await repoSec().locator('.srow').first().waitFor({ state: 'hidden', timeout: 10_000 });
    const shut = (await repoSec().boundingBox())?.height ?? 0;
    assert.ok(shut < before / 2, `shut section is ${shut}px, open was ${before}px`);
    assert.equal(await repoSec().locator('.rcount').textContent(), '12', 'the count survives');

    await head.click();
    await repoSec().locator('.srow').first().waitFor({ state: 'visible', timeout: 10_000 });
  });

  step('reads added config on a tick, then quotes the login refusal', async (t) => {
    await openSheet();
    await openRepo();
    const row = repoSec().locator('.srow', { hasText: 'gone-mcp' });
    assert.equal(await row.count(), 0, 'the added server was not in the initial config');
    const began = performance.now();
    const project = path.join(ctx.home, 'project').split(path.sep).join('/');
    const configPath = path.join(ctx.home, '.claude.json');
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    const servers = raw.projects[project]?.mcpServers;
    assert.ok(servers);
    servers['gone-mcp'] = { type: 'http', url: 'https://mcp.gone.test/mcp' };
    await fs.writeFile(configPath, JSON.stringify(raw));
    const cachePath = path.join(ctx.home, '.claude', 'mcp-needs-auth-cache.json');
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8')) as Record<string, unknown>;
    cache['gone-mcp'] = { timestamp: 1 };
    await fs.writeFile(cachePath, JSON.stringify(cache));
    const written = performance.now();

    // The sheet re-reads on the auth tick, up to 30s after the last one.
    await row.waitFor({ state: 'visible', timeout: 45_000 });
    const discovered = performance.now();
    await row.locator('button.ba.fix').click();
    await row.locator('.bdetail .why', { hasText: 'No MCP server named "gone-mcp"' }).waitFor({
      state: 'visible',
      timeout: 20_000
    });
    const refused = performance.now();
    assert.equal((await row.locator('.bcell.error .bs').textContent())?.trim(), 'Failed');
    assert.equal((await row.locator('button.ba.fix').textContent())?.trim(), 'Retry');
    t.diagnostic(
      `MCP runtime (ms): fixture=${(written - began).toFixed(1)}, ` +
        `periodic discovery=${(discovered - written).toFixed(1)}, ` +
        `login refusal=${(refused - discovered).toFixed(1)}`
    );
  });
});

/**
 * Codex on the sheet, against the real `codex mcp` child.
 *
 * jsdom covers the cell shapes and `codex_mcp.test.ts` covers the parse. This
 * is the half neither reaches: the panel actually spawns `codex mcp list
 * --json` per root, `codex mcp login` blocks on a callback, and `codex mcp
 * logout` removes the grant — all of it through `panel_auth.ts`.
 */
section('mcp servers — Codex (smoke)', () => {
  const codexRow = (name: string) => machineSec().locator('.srow', { hasText: name });

  before(async () => {
    // Its own, not the section above's: the reset between them puts `HOME` back.
    await writeMcpFixture(true);
    await openPanel();
    await clearOnboarding();
  });

  step('reads codex mcp list and draws what it found', async () => {
    await openSheet();
    await openSection(machineSec());
    // The panel reads Codex on the auth tick, so the first appearance can lag
    // the sheet opening.
    await codexRow(CODEX_OAUTH).waitFor({ state: 'visible', timeout: 60_000 });
    await codexRow(CODEX_STDIO).waitFor({ state: 'visible', timeout: 20_000 });
  });

  step('draws a STDIO server by its program, and never by its arguments', async () => {
    await openSheet();
    await openSection(machineSec());
    const row = codexRow(CODEX_STDIO);
    const text = (await row.textContent()) ?? '';
    assert.match(text, /STDIO/, 'the transport is named');
    assert.match(text, /pencil-server/, 'the program is named');
    assert.doesNotMatch(text, /do-not-paint-me/, 'no argument or env value is drawn');
    assert.equal(await row.locator('button.ba').count(), 0, 'a process owns no credential');
  });

  step('authorises through the real login child and surfaces its url', async () => {
    await openSheet();
    await openSection(machineSec());
    const authorise = codexRow(CODEX_OAUTH).locator('button.ba.fix');
    assert.equal((await authorise.textContent())?.trim(), 'Authorise');
    const box = await authorise.boundingBox();
    assert.ok(box && box.height >= 24 && box.width >= 24, 'WCAG 2.2 SC 2.5.8 hit target');
    await authorise.click();

    const url = sheet().locator('.mcpurl .aurl');
    await url.waitFor({ state: 'visible', timeout: 30_000 });
    assert.match((await url.textContent()) ?? '', /mcp\.smoke\.test\/authorize/);

    // Stands in for the operator approving in the browser the CLI opened.
    await fs.writeFile(path.join(ctx.home, '.codex', 'fake-mcp-approve'), '');
    await codexRow(CODEX_OAUTH)
      .locator('button.ba.out')
      .waitFor({ state: 'visible', timeout: 60_000 });
    assert.match((await codexRow(CODEX_OAUTH).textContent()) ?? '', /Connected/);
  });

  step('disconnects through the real logout child, and offers Authorise again', async () => {
    await openSheet();
    await openSection(machineSec());
    const disconnect = codexRow(CODEX_OAUTH).locator('button.ba.out');
    await disconnect.click();
    assert.equal((await disconnect.textContent())?.trim(), 'Disconnect?', 'armed, not posted');
    await disconnect.click();
    await codexRow(CODEX_OAUTH)
      .locator('button.ba.fix')
      .waitFor({ state: 'visible', timeout: 60_000 });
  });
});
