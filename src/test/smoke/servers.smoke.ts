import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { before } from 'node:test';
import type { Locator } from 'playwright-core';
import {
  AMBIG_BRANCH,
  BRANCH,
  homeDir,
  MONO_BRANCH,
  openPanel,
  panel,
  patchSettings,
  section,
  step
} from './boot';
import {
  closeServers,
  FIXTURE_NAME,
  fixtureSession,
  openServers,
  send,
  waitForServerUp
} from './kit';
import { testPlatform, writeJson } from '../helpers';
import * as platform from '../../core/platform';
import { scanProcesses } from '../../core/scan';

/**
 * Where the fixtures listen: outside the repo's own block, below 49152 so the
 * ephemeral gate does not drop them, and high enough to be nobody's default. A
 * different number each, so they cannot overlap in a barrel.
 */
const HAND_PORT = 31_017;
const SESSION_PORT = 31_018;
const OTHER_WINDOW_PORT = 31_019;
const TYPED_PORT = 31_020;

/** A listener this test started, so nothing on the board owns it. */
function handStarted(port: number, cwd: string) {
  return spawn(
    process.execPath,
    [
      '-e',
      `const net = require('net');
       const server = net.createServer();
       server.listen(${port}, () => process.stdout.write('up\\n'));
       server.on('error', (e) => { process.stderr.write(String(e)); process.exit(1); });`
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function listening(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`fixture exited ${code}`)));
  });
}

function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** Has the owned fixture start a server, then waits for its chip. `LISTENERS_MS`
 *  is 7s and the poll 3s; the wait is longer because a cold read is no stopwatch. */
async function sessionServer(port: number) {
  await fixtureSession();
  await send(`serve-port-${port}`);
  const chip = panel().locator('#cards .srv.alien', { hasText: ':' + port });
  await chip.waitFor({ timeout: 60_000 });
  return chip;
}

/** Ends a session server through its own chip, and waits for the board to settle. */
async function stopSessionServer(chip: Locator) {
  const x = chip.locator('.x');
  await x.waitFor({ timeout: 10_000 });
  const pid = Number(await x.getAttribute('data-pid'));
  await x.click({ timeout: 10_000 });
  const until = Date.now() + 30_000;
  while (alive(pid) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(!alive(pid), 'the stop signalled nothing the listener felt');
  await panel().locator('#cards .srv.stopping').waitFor({ state: 'detached', timeout: 90_000 });
  assert.equal(await panel().locator('#cards .srv.alien').count(), 0, 'a listener outlived');
}

/**
 * A dev server, booted for real and stopped again.
 *
 * Independent of every session: the section is drawn from the repository, not
 * from anything running — which is why this is its own file and the cheapest of
 * them to run while working on servers.
 */

section('a dev server, in the real IDE', () => {
  before(openPanel);

  /**
   * The board's geometry, which is the whole reason it replaced a menu: every
   * port in the block is on screen at once, and each tile is a target a pointer
   * can actually hit. jsdom has neither — every rect there is zero, so it can
   * only count nodes.
   *
   * A block is ten ports and all ten are drawn, since a held one carries the
   * name of whatever holds it rather than being dropped. 24×24 CSS px is WCAG
   * 2.2 SC 2.5.8, and this repo's own floor (`docs/design_tokens/`).
   *
   * Leaves the sheet as it found it — closed, nothing armed but the default —
   * so the boot below still opens on the first free port. In a `finally`,
   * because a sheet left open by a failure here is a boot case that times out
   * blaming the host.
   */
  step('draws the whole block at once, on targets a pointer can hit', async () => {
    const sheet = await openServers(BRANCH);
    try {
      await sheet.locator('.sstart .spick').first().click();
      const tiles = sheet.locator('.rtile');
      await tiles.first().waitFor({ timeout: 30_000 });
      assert.equal(await tiles.count(), 10, 'the whole block is drawn');

      const sheetBox = await sheet.boundingBox();
      assert.ok(sheetBox, 'the sheet is drawn');
      for (let i = 0; i < 10; i++) {
        const box = await tiles.nth(i).boundingBox();
        assert.ok(box, `tile ${i} has no box`);
        assert.ok(box.width >= 24 && box.height >= 24, `tile ${i} is ${box.width}×${box.height}`);
        assert.ok(
          box.y >= sheetBox.y - 1 && box.y + box.height <= sheetBox.y + sheetBox.height + 1,
          `tile ${i} hangs outside the sheet`
        );
      }

      // The open row's Run names the port it would take.
      const run = sheet.locator('.sact.go');
      assert.match((await run.textContent()) ?? '', /^Run :\d+$/);
      const runBox = await run.boundingBox();
      assert.ok(runBox && runBox.height >= 24, `Run is ${runBox?.height}px tall`);
    } finally {
      await closeServers();
    }
  });

  /**
   * Here rather than in jsdom for two things jsdom cannot reach. **`createTerminal`
   * came back to this codebase for the servers feature** — nothing in `src/` had
   * created a terminal since terminal read-only shipped — and a regression in it
   * is silent: no terminal, no server, and the chip sits `starting` until the
   * probe gives up and says `port taken`, which blames the wrong thing entirely.
   * And the boot is where A13/A14 live: the sheet offers a port only after
   * binding it on **both** loopback families, and the row turns `up` only when
   * `probe` connects to **`localhost`**. The jsdom suite proves a click posts
   * `run`; only a host proves a chip ever goes green.
   *
   * The runner is settings, not detection — a `node -e` http server on the port
   * it is handed. It needs nothing installed and pins no framework, so what is
   * under test is the panel's half rather than Vite's.
   */
  step('boots a dev server on a picked port, and stops it', async (t) => {
    if (testPlatform() === 'win32') {
      t.skip('win32: terminal runner shell execution remains unimplemented, W7.3-W7.5');
      return;
    }
    // A row defaults to the first port in the block that bound free — dual-family,
    // so a port something else on this machine is already serving is not offered.
    const sheet = await openServers(BRANCH);
    const row = sheet.locator('.sstart').first();
    const offered = await row.locator('.spick').textContent({ timeout: 30_000 });
    const picked = /\d+/.exec(offered ?? '')?.[0] ?? assert.fail(`no port in "${offered}"`);
    await row.locator('.sact', { hasText: 'Run' }).click();
    // The sheet stays, and the row is what answers the press.
    assert.equal(await sheet.isVisible(), true, 'Run closed the sheet');
    await closeServers();

    // `up` is the assertion, and it is a strong one: the host wrote the
    // reservation, created a terminal, ran the command in it, and then
    // *connected* to the port it asked for. A green chip cannot happen without
    // a server actually listening on it.
    const live = panel().locator(`#cards .srv.up`, { hasText: BRANCH });
    await waitForServerUp(live, picked);
    assert.equal(await live.locator('.p').textContent(), ':' + picked);

    // And it is **our** server answering, not merely a server. Without this the
    // test passes on a green chip pointing at whatever else on this machine
    // happens to hold that port — which is exactly what it did on 2026-08-04,
    // against another project's Vite, and is how `free`'s wildcard blind spot
    // was found. The fixture answers `ok` and nothing else does.
    const body = await fetch(`http://localhost:${picked}`).then((r) => r.text());
    assert.equal(body, 'ok', 'something else is on that port');

    // Not clicked, deliberately: the URL is `openExternal`, which would open
    // this machine's real browser. That seam is `webUri` shared with
    // `openTicket`, and it is not worth a browser window.
    assert.ok(await live.locator('.x').getAttribute('aria-label'));

    await live.locator('.x').click();
    // Back to a branch with nothing running, which draws no chip at all.
    await live.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await panel().locator('#cards .srv.up').count(), 0);
  });

  /**
   * A typed port something else already listens on. The answer never covered
   * it, so only the host's bind at the press can tell — and `awaitReady`'s
   * probe connects to whatever is there, which once drew this row `up` at the
   * stranger's URL. The fixture answers no HTTP; a connect is all it takes.
   */
  step('fails a typed port something else holds, and starts nothing on it', async (t) => {
    if (testPlatform() === 'win32') {
      t.skip('win32: terminal runner shell execution remains unimplemented, W7.3-W7.5');
      return;
    }
    const child = handStarted(TYPED_PORT, homeDir());
    try {
      await listening(child);
      const sheet = await openServers(BRANCH);
      const row = sheet.locator('.sstart').first();
      await row.locator('.spick').click({ timeout: 30_000 });
      await sheet.locator('.sports input.rport').fill(String(TYPED_PORT));
      await sheet.locator('.sact.go', { hasText: ':' + TYPED_PORT }).click();
      await row.locator('.nm i.bad', { hasText: 'port in use' }).waitFor({ timeout: 15_000 });
      assert.equal(
        await panel()
          .locator('#cards .srv.up', { hasText: ':' + TYPED_PORT })
          .count(),
        0,
        'a port another program holds was drawn up as ours'
      );
      // The failure is dismissed the way any failed row is.
      await row.locator('.sact', { hasText: 'Stop' }).click();
      await row.locator('.nm i.bad').waitFor({ state: 'detached', timeout: 15_000 });
    } finally {
      await closeServers();
      child.kill();
    }
  });

  /**
   * A tree whose scripts detection would not choose between. jsdom draws the note
   * off a view it wrote; nothing it can run produces that view, because
   * `offersFor` parses a real `package.json` on the poll and `startsFor` falls
   * back to the same candidates in the host.
   */
  step('offers the scripts it would not choose between', async () => {
    const sheet = await openServers(AMBIG_BRANCH);
    try {
      assert.match((await sheet.locator('.sstarts .rnote').textContent()) ?? '', /Pick one/);
      // Two, not three: `build` is not one of the four candidate names, and the
      // tree names no command in settings.
      assert.deepEqual(await sheet.locator('.sstart .nm b').allTextContents(), [
        'npm run dev',
        'npm run start'
      ]);
    } finally {
      await closeServers();
    }
  });

  /**
   * Both halves of the scope. The hand-started listener is the negative: a real
   * server in a tree the board draws, heard by the same reading that finds the
   * session's server, and given no chip. The session's is a real child of an
   * owned session, reached through the host's own ancestry join, and its ✕ is
   * why this holds a real process: `killListener` runs in the host and no unit
   * test reaches it.
   */
  step('draws the server a session started, and not one it did not', async () => {
    const cwd = await fs.realpath(path.join(homeDir(), 'mono-tree'));
    const child = handStarted(HAND_PORT, cwd);
    try {
      await listening(child);
      const chip = await sessionServer(SESSION_PORT);
      assert.equal(await chip.locator('.p.alien').textContent(), ':' + SESSION_PORT);
      assert.match((await chip.getAttribute('data-tip-rows')) ?? '', new RegExp(FIXTURE_NAME));
      const x = chip.locator('.x');
      await x.waitFor({ timeout: 10_000 });
      assert.equal(await x.getAttribute('data-act'), 'killListener');
      assert.equal(await x.getAttribute('data-port'), String(SESSION_PORT));
      assert.equal(await chip.locator('.cbody').getAttribute('data-act'), 'openServer');
      assert.equal(
        await panel()
          .locator('#cards .srv', { hasText: ':' + HAND_PORT })
          .count(),
        0,
        'a server no session started was drawn'
      );

      // A forged press: the real ✕ aimed at the stranger, with that process's true
      // start, so only the host's ownership check stands between them.
      const stranger = child.pid ?? assert.fail('no pid');
      const start = (await scanProcesses(true)).starts.get(stranger);
      await x.evaluate(
        (node, aimed) => {
          const copy = node.cloneNode(true) as HTMLElement;
          Object.assign(copy.dataset, aimed);
          node.after(copy);
          copy.click();
          copy.remove();
        },
        { port: String(HAND_PORT), pid: String(stranger), startedAt: String(start), command: '' }
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      assert.ok(alive(stranger), 'a forged stop reached a stranger');

      await stopSessionServer(chip);
      assert.ok(alive(stranger), 'the stop reached a stranger');
    } finally {
      child.kill();
    }
  });

  /**
   * **A server another window started is not a row of this window's** — the
   * design mistake row 71 shipped and a review caught, held against a real host
   * because the filter that fixes it is one line in `host/runs.ts`
   * (`serverContext`) and nothing in the jsdom suite can reach it.
   *
   * `liveServers()` returns every window's records, which is right for the
   * store's own sweep and wrong for a board. Drawn as `running`, another
   * window's server became an ordinary chip of ours — claiming a terminal this
   * window cannot dispose and offering a ✕ that could only guess at what was on
   * the port.
   *
   * A session server is the positive control: its chip arriving proves a poll
   * ran after the record landed, so the count below has something behind it.
   *
   * Both fixtures are removed before it returns, and it waits for the board to
   * settle back — the next step counts this same board's chips.
   */
  step('draws no chip for another window’s record', async () => {
    const cwd = await fs.realpath(path.join(homeDir(), 'mono-tree'));
    // Where `core/devservers/servers.ts` files one: the cwd hashed, the runner
    // id readable. Written by hand rather than through `writeServer`, because
    // `core/paths.ts` resolves `STATE_DIR` off *this* process's home and the
    // one under test is the profile `boot.ts` made.
    const record = path.join(
      homeDir(),
      '.squadron',
      'servers',
      `${createHash('sha256').update(platform.paths.key(cwd)).digest('hex').slice(0, 16)}.dev.json`
    );
    const child = handStarted(OTHER_WINDOW_PORT, cwd);
    try {
      await listening(child);
      // Exactly what the window holding the terminal would have written, bar
      // the id: `reconcileServers` keeps a record whose `windowId` is not ours
      // whatever we think of it, which is the store being right and the board
      // having to decide for itself.
      const now = Date.now();
      await writeJson(record, {
        cwd,
        runnerId: 'dev',
        label: 'another window’s server',
        branch: MONO_BRANCH,
        windowId: 'some-other-window',
        port: OTHER_WINDOW_PORT,
        url: `http://localhost:${OTHER_WINDOW_PORT}`,
        status: 'up',
        startedAt: now,
        updatedAt: now
      });

      const chip = await sessionServer(SESSION_PORT);

      // The one that regressed: no chip anywhere on the board claims to be a
      // server of ours. A session server's chip is `alien`, so `up` is the whole
      // of what a drawn record looks like.
      assert.equal(
        await panel().locator('#cards .srv.up').count(),
        0,
        'another window’s record was drawn as a server this window is running'
      );
      await stopSessionServer(chip);
    } finally {
      child.kill();
      await fs.rm(record, { force: true });
    }
  });

  /**
   * The experiment's switch, proved where it actually lives.
   *
   * `squadron.devServers.enabled` is read in `host/panel.ts`, which imports
   * `vscode` and so is reachable by nothing in the jsdom suite: `rich.test.ts`
   * proves the gear posts `setFlag` and stops at the wire. What is left over is
   * the half that matters — that the setting takes the line off the board at
   * all — and only a real host can say it.
   *
   * No reload: each flag is read through `getConfiguration` per call, so the
   * next poll carries the write. The wait is that poll and the host's own file
   * watch, which is what `patchSettings` already sleeps for.
   *
   * It puts the setting back and waits for the door to return, which proves
   * the switch in both directions. The next section's reset would restore the
   * setting either way.
   */
  step('takes the whole line off the board when the experiment is off', async () => {
    const doors = panel().locator('#cards .sdoor');
    await doors.first().waitFor({ timeout: 30_000 });

    await patchSettings({ 'squadron.devServers.enabled': false });
    await doors.first().waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await doors.count(), 0, 'a door survived the experiment being turned off');
    assert.equal(
      await panel().locator('#cards .servers').count(),
      0,
      'the line is drawn empty rather than not at all'
    );

    await patchSettings({ 'squadron.devServers.enabled': true });
    await doors.first().waitFor({ timeout: 30_000 });
  });
});
