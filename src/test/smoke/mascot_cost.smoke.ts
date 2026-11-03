import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before } from 'node:test';
import * as boot from './boot';
import { busyMinute } from '../mascot_busy';

/**
 * What the mascot costs on stock VS Code, read the way the café's dismount was
 * (`8103a2ea`): CPU time of this host's renderer and GPU helper processes over
 * a minute, as a percentage of one core. Idle panel with the chick off, then
 * on, then the busy minute of `mascot_busy.ts` with it off and on.
 *
 * **Opt-in and run alone**, never in the barrel: it holds the host for about
 * ten minutes and asserts nothing — the figures go to the log and to
 * `$SQUADRON_RUN/mascot_cost.json` (or the system temp), and
 * `docs/reference/mascot_performance.md` is where they are judged.
 *
 *   npm run test:smoke:one -- out/test/smoke/mascot_cost.smoke.js
 */

const MINUTE_MS = 60_000;
const SETTLE_MS = 10_000;
const ROUNDS = 2;

interface Proc {
  pid: number;
  ppid: number;
  seconds: number;
  name: string;
}

/** `ps`'s cumulative CPU time, `[[h:]m:]s.cc`, in seconds. */
function seconds(time: string): number {
  return time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** This host's helper processes and their CPU so far, by kind. */
function helpers(): { renderer: number; gpu: number; each: Proc[] } {
  const all: Proc[] = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,command='], {
    encoding: 'utf8'
  })
    .split('\n')
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/.exec(line);
      return m
        ? [{ pid: Number(m[1]), ppid: Number(m[2]), seconds: seconds(m[3]!), name: m[4]! }]
        : [];
    });
  const mine = new Set([boot.ctx.hostPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) {
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  const each = all.filter((p) => mine.has(p.pid));
  // By Chromium's own --type flag, not the executable: VS Code's GPU process
  // is a plain "Code Helper", indistinguishable from its utility processes by
  // name, which read as a GPU of 0% the first time.
  const sum = (type: string): number =>
    each.filter((p) => p.name.includes(`--type=${type}`)).reduce((s, p) => s + p.seconds, 0);
  return { renderer: sum('renderer'), gpu: sum('gpu-process'), each };
}

const results: unknown[] = [];

/** A minute's reading, in percent of one core. */
async function minute(name: string, round: number, during?: () => Promise<void>): Promise<void> {
  const a = helpers();
  const t0 = Date.now();
  await (during ? during() : new Promise((r) => setTimeout(r, MINUTE_MS)));
  const b = helpers();
  const s = (Date.now() - t0) / 1000;
  const row = {
    round,
    name,
    seconds: +s.toFixed(1),
    renderer: +((100 * (b.renderer - a.renderer)) / s).toFixed(2),
    gpu: +((100 * (b.gpu - a.gpu)) / s).toFixed(2),
    // Each renderer apart: the workbench's window and the panel's webview
    // frame are separate processes, and only one of them draws the chick.
    renderers: b.each
      .filter((p) => p.name.includes('--type=renderer'))
      .map((p) => {
        const before = a.each.find((q) => q.pid === p.pid)?.seconds ?? 0;
        return { pid: p.pid, pct: +((100 * (p.seconds - before)) / s).toFixed(2) };
      })
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

/** The busy minute, pushed by the page itself while the host's own pushes are
 *  held, so the minute is the fixture's and not the poll's. */
function busy(mascot: boolean): () => Promise<void> {
  const plan = busyMinute().map(({ at, state }) => ({ at, state: { ...state, mascot } }));
  return () =>
    boot.holdingHostState(() =>
      boot
        .panel()
        .locator('body')
        .evaluate(
          async (_, { plan, ms }) => {
            const push = (data: unknown): void => {
              window.dispatchEvent(new MessageEvent('message', { data }));
            };
            for (const { at, state } of plan) setTimeout(() => push(state), at * 1000);
            await new Promise((r) => setTimeout(r, ms));
          },
          { plan, ms: MINUTE_MS }
        )
    );
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SETTLE_MS));

boot.section('the mascot’s cost, on stock VS Code', () => {
  before(async () => {
    await boot.openPanel();
  });

  for (let round = 0; round < ROUNDS; round++) {
    const step = (name: string, fn: () => Promise<void>): void =>
      boot.step(`${name} (round ${round + 1})`, fn, MINUTE_MS + 4 * SETTLE_MS + 60_000);
    step('idle panel, chick off', async () => {
      await boot.patchSettings({ 'squadron.mascot.enabled': false });
      await settle();
      await minute('off, idle', round);
    });
    step('idle panel, chick on', async () => {
      await boot.patchSettings({ 'squadron.mascot.enabled': true });
      await boot.panel().locator('#mascot').waitFor({ state: 'attached', timeout: 30_000 });
      await settle();
      await minute('on, idle', round);
    });
    step('busy minute, chick off', async () => {
      await settle();
      await minute('off, busy minute', round, busy(false));
    });
    step('busy minute, chick on', async () => {
      await settle();
      await minute('on, busy minute', round, busy(true));
    });
  }

  boot.step('writes the readings', () => {
    const dir = process.env.SQUADRON_RUN ?? fs.realpathSync(os.tmpdir());
    const file = path.join(dir, 'mascot_cost.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ host: helpers().each.map((p) => p.name.slice(0, 160)), results }, null, 1)
    );
    console.log(`mascot cost readings: ${file}`);
  });
});
