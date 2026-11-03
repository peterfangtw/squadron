import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { LEASE_MS } from '../../core/awake';
import * as platform from '../../core/platform';
import { refused, type Effects, type Lease } from '../../core/platform/power';
import * as darwin from '../../core/platform/power/darwin';
import * as win32 from '../../core/platform/power/win32';
import { testPlatform } from '../helpers';

/**
 * Both fixtures are verbatim `pmset -g batt` on this machine, hours apart —
 * `docs/reference/macos_power.md` records where they came from. The tab before
 * the percentage is the real one, so a parser leaning on whitespace shape is
 * tested against what it will actually meet.
 */
const ON_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=6815843)\t86%; discharging; 3:37 remaining present: true
`;

const ON_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=6815843)\t99%; finishing charge; 0:15 remaining present: true
`;

/** A desktop: drawing from AC, and no battery line at all. */
const DESKTOP = `Now drawing from 'AC Power'
`;

type Call = { file: string; args: readonly string[]; timeout?: number };

/** A darwin backend over recorded effects: `run` answers `stdout` (or rejects
 *  with it), `spawn` hands back a child the test drives. */
function recorded(stdout: string | Error = ON_BATTERY, spawnError?: Error) {
  const calls: Call[] = [];
  const child = new (class extends EventEmitter {
    kills = 0;
    kill(): void {
      this.kills++;
    }
  })();
  const effects: Effects = {
    run(file, args, options) {
      calls.push({ file, args, timeout: options.timeout });
      return stdout instanceof Error ? Promise.reject(stdout) : Promise.resolve(stdout);
    },
    spawn(file, args) {
      calls.push({ file, args });
      if (spawnError) throw spawnError;
      return child;
    }
  };
  return { power: darwin.power(effects), calls, child };
}

function leaseOf(held: Lease | { supported: false }): Lease {
  assert.ok(!('supported' in held), 'darwin refused a hold');
  return held;
}

describe('parseBattery', () => {
  it('reads the charge and the source while discharging', () => {
    assert.deepEqual(darwin.parseBattery(ON_BATTERY), { pct: 86, onAC: false });
  });

  it('reads AC as AC even mid-charge', () => {
    assert.deepEqual(darwin.parseBattery(ON_AC), { pct: 99, onAC: true });
  });

  it('does not switch on the status word, so an unseen one still parses', () => {
    // `charged` and `charging` are both real; there is no list of them anywhere,
    // and the source line already answers the only question asked.
    const charged = ON_AC.replace('finishing charge', 'charged');
    assert.deepEqual(darwin.parseBattery(charged), { pct: 99, onAC: true });
    const unknown = ON_BATTERY.replace('discharging', 'some future word');
    assert.deepEqual(darwin.parseBattery(unknown), { pct: 86, onAC: false });
  });

  it('answers nothing for a machine with no battery, rather than a flat one', () => {
    // The failure this guards: `undefined` degrades to "no opinion", where a
    // defaulted 0 would read as a dying battery and refuse to ever hold.
    assert.equal(darwin.parseBattery(DESKTOP), undefined);
  });

  it('answers nothing for a truncated or empty dump', () => {
    assert.equal(darwin.parseBattery(''), undefined);
    assert.equal(darwin.parseBattery('Now drawing from '), undefined);
    assert.equal(darwin.parseBattery(' -InternalBattery-0 (id=1)\t50%; discharging;'), undefined);
  });

  it('takes the battery percentage, not another number on the line', () => {
    // `id=` carries digits and `3:37` carries a colon-separated pair; only the
    // figure with a trailing `%;` is the charge.
    const parsed = darwin.parseBattery(ON_BATTERY);
    assert.equal(parsed?.pct, 86);
  });

  it('reads a single-digit charge', () => {
    const low = ON_BATTERY.replace('86%', '7%');
    assert.deepEqual(darwin.parseBattery(low), { pct: 7, onAC: false });
  });

  it('reads a full charge', () => {
    const full = ON_AC.replace('99%', '100%');
    assert.deepEqual(darwin.parseBattery(full), { pct: 100, onAC: true });
  });
});

describe('power.read', () => {
  it('runs pmset -g batt under the 2-second backstop, laptop, AC and desktop alike', async () => {
    const low = ON_BATTERY.replace('86%', '4%');
    const cases: [string, { pct: number; onAC: boolean } | undefined][] = [
      [ON_BATTERY, { pct: 86, onAC: false }],
      [low, { pct: 4, onAC: false }],
      [ON_AC, { pct: 99, onAC: true }],
      [DESKTOP, undefined]
    ];
    for (const [stdout, value] of cases) {
      const { power, calls } = recorded(stdout);
      assert.deepEqual(await power.read(), { supported: true, status: 'ok', value });
      assert.deepEqual(calls, [{ file: '/usr/bin/pmset', args: ['-g', 'batt'], timeout: 2000 }]);
    }
  });

  it('answers failed, never a reading, when pmset is missing or stalls', async () => {
    const missing = Object.assign(new Error('spawn /usr/bin/pmset ENOENT'), { code: 'ENOENT' });
    const { power } = recorded(missing);
    assert.deepEqual(await power.read(), {
      supported: true,
      status: 'failed',
      reason: 'spawn /usr/bin/pmset ENOENT'
    });
  });

  it('says nothing on a platform with no pmset', async () => {
    for (const power of [win32.power(), refused('linux', 'no sleep assertion or battery reader')]) {
      const read = await power.read();
      assert.equal(read.supported, false);
    }
    const read = await win32.power().read();
    assert.match(
      read.supported ? '' : read.reason,
      /^power\.read is unavailable on win32: .*W7\.1/
    );
  });

  it('reads this machine when it is a mac', async function () {
    if (testPlatform() !== 'darwin') {
      return;
    }
    const read = await platform.power.read();
    assert.ok(read.supported && read.status === 'ok', JSON.stringify(read));
    // A mac laptop answers; a mac desktop has no battery and answers nothing.
    // Both are correct, so this asserts the shape rather than the presence.
    if (read.value) {
      assert.ok(
        read.value.pct >= 0 && read.value.pct <= 100,
        `charge out of range: ${read.value.pct}`
      );
      assert.equal(typeof read.value.onAC, 'boolean');
    }
  });
});

describe('power.hold', () => {
  it('starts caffeinate -i -t 600 -w <host pid> and nothing else', () => {
    const { power, calls } = recorded();
    leaseOf(power.hold(LEASE_MS, 4242));
    assert.deepEqual(calls, [
      { file: '/usr/bin/caffeinate', args: ['-i', '-t', '600', '-w', '4242'] }
    ]);
  });

  it('reports the child ending, and a release kills it', () => {
    const { power, child } = recorded();
    const lease = leaseOf(power.hold(LEASE_MS, 1));
    let ended = 0;
    lease.onEnded(() => ended++);
    lease.release();
    assert.equal(child.kills, 1);
    assert.equal(ended, 0, 'a release is not an end until the child exits');
    child.emit('exit', null, 'SIGTERM');
    assert.equal(ended, 1);
  });

  it('names caffeinate when the child fails to start', () => {
    const { power, child } = recorded();
    const lease = leaseOf(power.hold(LEASE_MS, 1));
    const reasons: string[] = [];
    lease.onFailed((reason) => reasons.push(reason));
    child.emit('error', new Error('spawn /usr/bin/caffeinate ENOENT'));
    assert.deepEqual(reasons, ['caffeinate failed to start: spawn /usr/bin/caffeinate ENOENT']);
  });

  it('turns a spawn that throws into a failure on the next tick, never a throw', async () => {
    const { power } = recorded(ON_BATTERY, new Error('spawn EAGAIN'));
    const lease = leaseOf(power.hold(LEASE_MS, 1));
    const failed = new Promise<string>((resolve) => lease.onFailed(resolve));
    assert.equal(await failed, 'caffeinate failed to start: spawn EAGAIN');
    lease.release();
  });

  it('refuses on win32 and other POSIX hosts, with the support answered first', () => {
    const cases = [
      [win32.power(), /^power\.hold is unavailable on win32: .*W7\.1/],
      [refused('linux', 'no sleep assertion or battery reader'), /unavailable on linux/]
    ] as const;
    for (const [power, reason] of cases) {
      assert.equal(power.holds.supported, false);
      const held = power.hold(LEASE_MS, 1);
      assert.ok('supported' in held && !held.supported);
      assert.match(held.reason, reason);
      assert.deepEqual(held, power.holds);
    }
  });

  it('composes the host’s answer once, with no effect', () => {
    assert.equal(platform.power.holds.supported, testPlatform() === 'darwin');
  });
});
