import * as assert from 'node:assert/strict';
import { before } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BRANCH, homeDir, MONO_BRANCH, openPanel, panel, section, step } from './boot';
import { closeServers, openServers, waitForServerUp } from './kit';
import { testPlatform } from '../helpers';

/**
 * Which app in a monorepo boots — the half of that feature only a host can
 * answer.
 *
 * The jsdom suite (`runpicker.test.ts`) drives the sheet against a hand-written
 * `PortsMessage` and proves every rule it draws by. What it cannot do is
 * produce that message: `startsFor` walks a real disk, `serverContext` asks
 * `declaresWorkspaces` on the poll, and both live in `host/panel.ts`, which
 * imports `vscode` and so has no headless test at all. Everything below goes
 * through them.
 *
 * Three things, in order of what would hurt most if it broke:
 *
 * - **A root that runs nothing still lists its apps.** The monorepo fixture's root
 *   declares workspaces and resolves to no runner of its own, so its apps exist
 *   only in the host's `ports` answer.
 * - **The rail sits beside the starts.** jsdom has no layout; only real boxes can
 *   say the two columns start together.
 * - **The remembered port belongs to the app.** A round trip through a real
 *   ports file on disk, keyed by `rememberKey` — write on boot, read on the next
 *   open. Two apps whose runners are both `dev` is the whole reason that key
 *   is composed, and a collision is invisible until the second app is started.
 */

section('a monorepo, in the real IDE', () => {
  before(openPanel);

  const sheet = () => panel().locator('#runsheet');
  const starts = () => sheet().locator('.sstart');
  const startOf = (text: string) => sheet().locator('.sstart', { hasText: text });
  /** The port a row would start on. */
  const portOf = async (text: string): Promise<string | undefined> =>
    /\d+/.exec((await startOf(text).locator('.spick').textContent({ timeout: 10_000 })) ?? '')?.[0];

  /** Waits until nothing answers on a port — the fixture server's own socket
   *  outliving the terminal that ran it, which is a real gap and not a long one. */
  async function released(port: number): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const answering = await fetch(`http://localhost:${port}`).then(
        () => true,
        () => false
      );
      if (!answering) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`port ${port} still answering after the server was stopped`);
  }

  step('offers the apps of a root that runs nothing itself', async () => {
    await openServers(MONO_BRANCH);
    try {
      // Two, not three: `apps/three` matches the glob and has no manifest, so
      // it is not a project. And not four: the root declares workspaces but
      // resolves to no runner, so it contributes no row of its own.
      assert.equal(await starts().count(), 2, 'the walk found the wrong number of apps');
      const labels = await starts().allTextContents();
      assert.ok(
        labels.some((l) => l.includes(path.join('apps', 'one'))) &&
          labels.some((l) => l.includes(path.join('apps', 'two'))),
        `expected both apps, got ${JSON.stringify(labels)}`
      );
      // The settings `commands` map, keyed by a subdirectory. Before this
      // feature an entry there rendered nowhere.
      assert.ok(
        labels.some((l) => l.includes('smoke one')),
        'the app’s own runner is unnamed'
      );
    } finally {
      await closeServers();
    }
  });

  step('lays the rail beside the starts', async () => {
    await openServers(MONO_BRANCH);
    try {
      const rail = await sheet().locator('.srail').boundingBox();
      const list = await sheet().locator('.sstarts').boundingBox();
      assert.ok(rail && list, 'both columns are drawn');
      assert.equal(Math.round(rail.y), Math.round(list.y), 'the two columns start ragged');
      assert.ok(list.x >= rail.x + rail.width, 'the starts are not beside the rail');
    } finally {
      await closeServers();
    }
  });

  /**
   * The whole path, once: pick an app, boot it, prove it is ours, stop it, and
   * then prove the port came back to that app and not to its neighbour.
   *
   * One test rather than four because it is one sequence — each step leaves the
   * state the next one reads, and splitting it would boot the fixture server
   * more than once for nothing.
   */
  step('boots the app it was told to, and remembers the port for that app alone', async (t) => {
    if (testPlatform() === 'win32') {
      t.skip('win32: terminal runner shell execution remains unimplemented, W7.3-W7.5');
      return;
    }
    const one = path.join('apps', 'one');
    const two = path.join('apps', 'two');
    await openServers(MONO_BRANCH);
    await startOf(one).locator('.spick').click({ timeout: 10_000 });

    // **Deliberately not the port the row opened on.** An unstarted app defaults
    // to the first free port, so booting `apps/one` on that same port makes the
    // two readings identical and the assertion below cannot fail. Taking the
    // *last* free port separates "its own, remembered" from "the first free one",
    // so the two apps can be told apart by what they show.
    const free = sheet().locator('.sports .rtile:not(.busy)');
    const freeCount = await free.count();
    assert.ok(freeCount >= 2, `need two free ports in the block, this machine has ${freeCount}`);
    const firstFree = await free.first().locator('.p').textContent();
    await free.last().click({ timeout: 10_000 });

    const picked = await portOf(one);
    assert.ok(picked && firstFree, 'no port was offered');
    assert.notEqual(picked, firstFree, 'the last free port is the first one');
    await sheet().locator('.sact.go').click();
    await closeServers();

    // Green means the host wrote the reservation, created a terminal, ran the
    // command in the **app's** directory and then connected to the port it asked
    // for. The word slot names the app, which is the only thing that tells two
    // rows of this branch apart — every app's runner is `dev`.
    const live = panel().locator('#cards .srv.up', { hasText: MONO_BRANCH });
    await waitForServerUp(live, picked);
    assert.equal(await live.locator('.p').textContent(), ':' + picked);
    assert.equal(await live.locator('.s').textContent(), path.join('apps', 'one'));

    // And it is ours, not merely something on that port — the trap that made
    // `free` test all four addresses.
    assert.equal(await fetch(`http://localhost:${picked}`).then((r) => r.text()), 'ok');

    // What the store actually holds, read off disk. The key is the claim — a
    // bare `dev` would be the same string for every app in the repo — and it is
    // not something the panel ever draws, so this is the only place it can be
    // asserted rather than inferred from a default two screens later.
    // Narrowed rather than cast, like every other read of a file this repo did
    // not write: the store is one repo's record per file, hashed by root, so
    // which file is this branch's is a question rather than an index.
    type Stored = { lastUsed?: { [branch: string]: { [key: string]: number } } };
    const dir = path.join(homeDir(), '.squadron', 'ports');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    const records: Stored[] = await Promise.all(
      files.map(async (f) => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Stored)
    );
    const mine = records.find((r) => r.lastUsed?.[MONO_BRANCH]);
    assert.deepEqual(
      mine?.lastUsed?.[MONO_BRANCH],
      { 'apps/one:dev': Number(picked) },
      `the ports store keyed it wrong: ${JSON.stringify(records.map((r) => r.lastUsed))}`
    );

    // **Held up long enough for `lsof` to have seen it**, which is the whole of
    // what makes the assertion after the stop mean anything.
    //
    // The listener reading is started on the first poll past `LISTENERS_MS`, so
    // one lands every 7s + a 3s poll grid + the spawn pair itself. Everything
    // above takes two seconds, so without this dwell the reading has usually
    // never sampled the port at all — and a reading that never held it has
    // nothing stale to hand back, which is why this scenario went green on some
    // runs and not others with the same bug in place. Measured both ways
    // (2026-09-01): no dwell reproduces on a phase, twelve seconds reproduces
    // every time.
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    // **Stopped from the held port's own tile, in another branch's sheet.**
    // The fixture is a worktree of the repo the plain row is on, so both share
    // one block: the port `apps/one` took shows on `smoke-main`'s board as
    // held, named for the branch holding it, with the Stop that names it.
    //
    // Only a host can prove what follows, and it is the whole reason that Stop
    // is worth having. Occupancy is posted from exactly one place — the sheet
    // asking on open — so a tile that stopped a server and then sat there
    // saying `stopping…` would be a dead end until the sheet was closed and
    // reopened. The board coming back to a free, armable tile is the host
    // having waited for the socket and re-answered by itself.
    await openServers(BRANCH);
    await sheet().locator('.sstart .spick').first().click({ timeout: 10_000 });
    const heldTile = sheet().locator('.rtile.busy', { hasText: picked ?? '' });
    await heldTile.waitFor({ timeout: 30_000 });
    assert.equal(
      await heldTile.locator('.u').textContent(),
      MONO_BRANCH,
      'the held tile does not name the branch holding the port'
    );
    await heldTile.locator('.stop').click({ timeout: 10_000 });

    // Armable again, without the sheet being touched: this is the re-answer.
    await sheet()
      .locator('.rtile:not(.busy)', { hasText: picked ?? '' })
      .waitFor({ timeout: 30_000 });
    await closeServers();

    await panel()
      .locator('#cards .srv.up', { hasText: MONO_BRANCH })
      .waitFor({ state: 'detached', timeout: 30_000 });

    // **And wait for the port itself, not just the chip.** Disposing the
    // terminal signals the shell; the node process holding the socket dies a
    // beat later. Reopening inside that beat is a sheet whose occupancy says the
    // remembered port is taken — so it offers the first free one instead, which
    // is `defaultPort` behaving exactly as A17 says it should and reads here as
    // "the app lost its port". The product is right and the race is the test's.
    await released(Number(picked));

    // **And it does not come back as a listener.** A picker server runs below no
    // session, so the line draws no second chip over the server just stopped.
    await panel().locator('#cards .srv.alien').waitFor({ state: 'detached', timeout: 5_000 });

    try {
      // The round trip. `apps/one` gets its port back; `apps/two` has never been
      // started, so it must not inherit it — which is the collision the
      // tree-relative key exists to prevent, and which a bare `dev` key would
      // have produced silently.
      await openServers(MONO_BRANCH);
      assert.equal(await portOf(one), picked, 'the app did not get its own port back');

      // The neighbour has never been started, so it falls back to the first free
      // port rather than inheriting its sibling's. A bare `dev` key — the same
      // string for every app in the repo — would have shown `picked` here, and
      // nothing on screen would have said why.
      assert.equal(
        await portOf(two),
        firstFree,
        'the neighbouring app did not fall back to the first free port'
      );
    } finally {
      await closeServers();
    }
  });
});
