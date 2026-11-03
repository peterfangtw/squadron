import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as disk from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after } from 'node:test';
import * as awake from '../../core/awake';
import type { PublishedLive } from '../../core/published';
import * as boot from './boot';
import * as kit from './kit';
import { testPlatform } from '../helpers';

// Opt-in only: real production leases take about twenty minutes. No e2e import.
const repo = path.join(__dirname, '..', '..', '..');
const bundles = ['dist/extension.js', 'dist/webview/main.js'];
const hashes = (): string[] =>
  bundles.map((file) =>
    crypto
      .createHash('sha256')
      .update(disk.readFileSync(path.join(repo, file)))
      .digest('hex')
  );
const revision = (): string =>
  childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const startedHashes = hashes();
const startedRevision = revision();
console.log(`${new Date().toISOString()} before launch ${startedRevision}`);
console.log(
  childProcess.execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' })
);
console.log(JSON.stringify(Object.fromEntries(bundles.map((file, i) => [file, startedHashes[i]]))));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let closingExpected = false;
let watchedHost: number | undefined;

function requireHost(): void {
  if (closingExpected) return;
  assert.ok(
    !boot.ctx.page.isClosed(),
    'lease observation interrupted: stock IDE window closed; see host-logs exthost.log'
  );
  const pid = watchedHost ?? boot.ctx.hostPid;
  assert.ok(pid > 0, 'lease observation interrupted: stock IDE has no host pid');
  try {
    process.kill(pid, 0);
  } catch {
    assert.fail('lease observation interrupted: stock IDE host exited; see host-logs exthost.log');
  }
}

async function until(at: number, why: string): Promise<void> {
  let reportAt = Date.now();
  requireHost();
  while (Date.now() < at) {
    requireHost();
    if (Date.now() >= reportAt) {
      console.log(
        `${new Date().toISOString()} ${why}: ${Math.ceil((at - Date.now()) / 1000)}s left`
      );
      reportAt = Date.now() + 60_000;
    }
    await sleep(Math.min(1000, at - Date.now()));
  }
}

async function settle<T>(
  read: () => Promise<T> | T,
  ready: (value: T) => boolean,
  why: string,
  ms = 30_000
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    requireHost();
    const value = await read();
    requireHost();
    if (ready(value)) return value;
    assert.ok(Date.now() < deadline, why);
    await sleep(250);
  }
}

boot.section(
  'production-length Café leases in the real IDE (opt-in)',
  () => {
    after(async () => {
      await boot.closeHost();
      console.log(`${new Date().toISOString()} after cleanup ${revision()}`);
      console.log(
        childProcess.execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' })
      );
      const endedHashes = hashes();
      console.log(
        JSON.stringify(Object.fromEntries(bundles.map((file, i) => [file, endedHashes[i]])))
      );
      assert.deepEqual(endedHashes, startedHashes, 'bundles changed during the lease observation');
      assert.equal(revision(), startedRevision, 'revision changed during the lease observation');
    });

    boot.step(
      'refills with overlap, releases on off, lapses idle, and releases on host disposal',
      async (t) => {
        if (testPlatform() !== 'darwin') {
          t.skip('win32, linux: requires macOS power assertions');
          return;
        }
        const power = childProcess.execFileSync('/usr/bin/pmset', ['-g', 'batt'], {
          encoding: 'utf8'
        });
        console.log(`${new Date().toISOString()} ${power.trim()}`);
        assert.match(power, /'AC Power'/, 'AC power is required for this lease observation');
        await boot.openPanel();
        assert.match(
          await boot.ctx.page.title(),
          /Café lease smoke/,
          'test window title is missing'
        );
        await boot.patchSettings({ 'squadron.cafe.enabled': true });
        const before = await kit.pids();
        await kit.startFromDraft('held-tool Café lease observation');
        const pid = await kit.waitForNewPid(before);
        const card = boot.panel().locator(`#cards .card[data-pid="${pid}"]`);
        await card.and(boot.panel().locator('.busy')).waitFor({ timeout: 30_000 });
        const liveDir = path.join(boot.homeDir(), '.squadron', 'live');
        const readSession = async (): Promise<PublishedLive> =>
          JSON.parse(await fs.readFile(path.join(liveDir, `${pid}.json`), 'utf8')) as PublishedLive;
        const active = await settle(
          readSession,
          (record) => record.session.status === 'busy' && record.session.activeTool === 'Bash',
          'held-tool fixture did not publish its busy activeTool'
        );
        assert.equal(active.pending.length, 0, 'held tool opened a dialog');
        console.log(
          `${new Date().toISOString()} held-tool owned input: ${JSON.stringify(active.session)}`
        );
        const owned = kit.hostPids();
        const records = path.join(boot.homeDir(), '.squadron', 'awake');
        const readHold = async (): Promise<awake.HoldRecord | undefined> => {
          requireHost();
          const files = await fs.readdir(records);
          for (const file of files) {
            const raw = await fs.readFile(path.join(records, file), 'utf8').catch(() => undefined);
            if (raw === undefined) continue;
            const hold = JSON.parse(raw) as awake.HoldRecord;
            if (hold.sessions.includes(Number(pid))) return hold;
          }
          return undefined;
        };
        const assertions = (): kit.SleepAssertion[] => kit.hostSleepAssertions(owned);
        const observe = (label: string): kit.SleepAssertion[] => {
          const holds = assertions();
          console.log(`${new Date().toISOString()} ${label}: ${JSON.stringify(holds)}`);
          for (const hold of holds) {
            assert.equal(hold.seconds, awake.LEASE_MS / 1000);
            const command = childProcess.execFileSync(
              '/bin/ps',
              ['-o', 'command=', '-p', String(hold.pid)],
              {
                encoding: 'utf8'
              }
            );
            console.log(command.trim());
            assert.match(command, new RegExp(`caffeinate -i -t 600 -w ${hold.watched}\\s*$`));
          }
          return holds;
        };
        const a = await settle(readHold, (hold) => hold !== undefined, 'lease A was not written');
        assert.ok(a);
        await settle(assertions, (holds) => holds.length === 1, 'lease A has no OS assertion');
        const first = observe('lease A')[0];
        assert.ok(first);
        watchedHost = first.watched;
        assert.ok(
          Math.abs(a.until - a.writtenAt - awake.LEASE_MS) < 2000,
          'A is not a production lease'
        );

        await until(a.until - awake.REFILL_MARGIN_MS, 'waiting for nine-minute refill');
        const b = await settle(
          readHold,
          (hold) => hold !== undefined && hold.until > a.until,
          'lease B never refilled before A expired',
          Math.max(0, a.until - Date.now())
        );
        assert.ok(b);
        console.log(
          `${new Date().toISOString()} refill lateness: ${b.writtenAt - (a.until - awake.REFILL_MARGIN_MS)}ms`
        );
        assert.ok(Date.now() < a.until, 'refill arrived after the overlap window');
        await settle(assertions, (holds) => holds.length === 2, 'refill did not overlap A and B');
        assert.ok(
          Date.now() < b.writtenAt + awake.REFILL_MARGIN_MS,
          'off missed B’s actual overlap'
        );
        assert.ok(Date.now() < a.until, 'off missed A’s original overlap window');
        const overlap = observe('A/B immediately before off');
        assert.ok(
          overlap.some((hold) => hold.pid === first.pid),
          'A vanished before off'
        );
        assert.equal(overlap.length, 2);
        await boot.patchSettings({ 'squadron.cafe.enabled': false });
        await settle(assertions, (holds) => holds.length === 0, 'off retained A/B assertions');
        await settle(readHold, (hold) => hold === undefined, 'off retained the hold record');
        observe('off released A/B');

        await boot.patchSettings({ 'squadron.cafe.enabled': true });
        const c = await settle(readHold, (hold) => hold !== undefined, 'lease C was not written');
        assert.ok(c);
        await settle(assertions, (holds) => holds.length === 1, 'lease C has no OS assertion');
        const third = observe('lease C')[0];
        assert.ok(
          third && third.pid !== first.pid && !overlap.some((hold) => hold.pid === third.pid)
        );
        await card.click();
        await boot.panel().locator('#chat-interrupt').click();
        await card.and(boot.panel().locator('.idle')).waitFor({ timeout: 30_000 });
        await until(
          c.until - awake.REFILL_MARGIN_MS + 3000,
          'idle C approaching its refill margin'
        );
        const inputs = await Promise.all(
          (await fs.readdir(liveDir)).map(
            async (file) =>
              JSON.parse(await fs.readFile(path.join(liveDir, file), 'utf8')) as PublishedLive
          )
        );
        const sessions = inputs
          .map((record) => record.session)
          .filter((session) => session.windowId === active.session.windowId);
        assert.ok(
          sessions.some((session) => session.pid === Number(pid)),
          'owned input vanished'
        );
        assert.ok(
          sessions.every(
            (session) => session.status === 'idle' && session.activeTool === undefined
          ),
          'C margin had an owned session still working'
        );
        const idleInput: awake.AwakeInput = {
          sessions,
          power: c.power,
          now: Date.now(),
          enabled: true,
          holds: testPlatform() === 'darwin'
        };
        const idleVerdict = awake.decide(idleInput);
        console.log(
          `${new Date().toISOString()} C margin input: ${JSON.stringify(idleInput)} verdict: ${JSON.stringify(idleVerdict)}`
        );
        assert.deepEqual(idleVerdict, { drink: false, reason: 'idle', sessions: [] });
        assert.equal((await readHold())?.until, c.until, 'idle C was refilled');
        assert.deepEqual(
          observe('idle C declined refill').map((hold) => hold.pid),
          [third.pid]
        );
        await until(c.until, 'waiting for natural C lapse');
        // Observed 2026-10-03: caffeinate -t 600 exited 30s after the lease clock.
        await settle(
          assertions,
          (holds) => holds.length === 0,
          'C did not lapse naturally',
          60_000
        );
        await settle(
          readHold,
          (hold) => hold === undefined,
          'natural lapse retained the hold record'
        );
        observe('C lapsed naturally');

        await kit.composer().fill('held-tool Café disposal observation');
        await kit.composer().press('Enter');
        await card.and(boot.panel().locator('.busy')).waitFor({ timeout: 30_000 });
        const d = await settle(readHold, (hold) => hold !== undefined, 'lease D was not written');
        assert.ok(d);
        await settle(assertions, (holds) => holds.length === 1, 'lease D has no OS assertion');
        observe('lease D before host disposal');
        closingExpected = true;
        await boot.closeHost();
        await settle(assertions, (holds) => holds.length === 0, 'host disposal retained D');
        observe('host disposal released D');
      },
      45 * 60_000
    );
  },
  () => ({ 'window.title': 'Café lease smoke — leave open until test finishes' })
);
