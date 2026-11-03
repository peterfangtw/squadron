/**
 * `caffeinate` for the lock and `pmset -g batt` for the battery. What both
 * print, and the commands that re-take them, is `docs/reference/macos_power.md`
 * — read it before editing either.
 */
import { EventEmitter } from 'node:events';
import type { Child, Effects, Lease, Power, Reading } from './index';

/**
 * A backstop, not a latency budget — the read measures at ~6 ms. Without it a
 * stalled read is invisible, because nothing throws.
 */
const SPAWN_MS = 2000;

export function power(effects: Effects): Power {
  return {
    holds: { supported: true },
    read: () => read(effects),
    hold: (leaseMs, hostPid) => hold(effects, leaseMs, hostPid)
  };
}

async function read(effects: Effects): ReturnType<Power['read']> {
  try {
    const stdout = await effects.run('/usr/bin/pmset', ['-g', 'batt'], { timeout: SPAWN_MS });
    return { supported: true, status: 'ok', value: parseBattery(stdout) };
  } catch (error) {
    return {
      supported: true,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * `-i` keeps idle system sleep off and leaves the display free to sleep. `-t`
 * releases a wedged host's lock; `-w` releases a dead host's at once.
 */
function hold(effects: Effects, leaseMs: number, hostPid: number): Lease {
  const args = ['-i', '-t', String(Math.round(leaseMs / 1000)), '-w', String(hostPid)];
  let child: Child;
  try {
    child = effects.spawn('/usr/bin/caffeinate', args);
  } catch (error) {
    child = unstarted(error instanceof Error ? error : new Error(String(error)));
  }
  return {
    release: () => {
      child.kill();
    },
    onFailed: (listener) => {
      child.once('error', (error) => listener(`caffeinate failed to start: ${error.message}`));
    },
    onEnded: (listener) => {
      child.once('exit', () => listener());
    }
  };
}

/** A spawn that threw, reported on the next tick as Node reports one that
 *  failed to start, so a listener attached after `hold` returns still hears it. */
function unstarted(error: Error): Child {
  const child = new EventEmitter();
  process.nextTick(() => {
    if (child.listenerCount('error') > 0) child.emit('error', error);
  });
  return Object.assign(child, { kill: () => false });
}

/**
 * `pmset -g batt` -> a reading.
 *
 * Two facts off two lines, and nothing else.
 *
 * **The source line, not the status word.** The first line names what the
 * machine is drawing from, quoted: `'AC Power'` or `'Battery Power'`. The status
 * word on the second line is not read at all — `discharging`, `charging`,
 * `finishing charge` and `charged` have all been seen, there is no list of them,
 * and switching on one would break the day a fifth appears. The source line
 * already answers the question.
 *
 * **`%;` is what makes the charge findable.** The battery line also carries an
 * `id=` full of digits and a `3:37` time estimate, and its columns are separated
 * by a tab that no other line has. A percentage immediately followed by a
 * semicolon is the one unambiguous shape.
 *
 * **A machine with no battery reads `undefined`, never zero.** A Mac desktop
 * prints no `InternalBattery` line. Defaulting that to 0 would look exactly like
 * a flat laptop and refuse to ever hold the lock — a plausible wrong answer,
 * which is the failure this whole file is arranged to avoid.
 */
export function parseBattery(stdout: string): Reading | undefined {
  const charge = /(\d{1,3})%;/.exec(stdout);
  const digits = charge?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const pct = Number(digits);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return undefined;
  }
  // Absence of the AC line is not evidence of battery: a dump we could not read
  // the source from is a dump we should not act on. Require one or the other to
  // be stated.
  const ac = /drawing from 'AC Power'/.test(stdout);
  const battery = /drawing from 'Battery Power'/.test(stdout);
  if (!ac && !battery) {
    return undefined;
  }
  return { pct, onAC: ac };
}
