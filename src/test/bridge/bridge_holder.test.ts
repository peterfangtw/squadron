import * as assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { disposeHome, tempHome, writeJson } from '../helpers';
import type { Acquired, Holder } from '../../core/remote/holder';
import type { ProcessTable } from '../../core/scan';
import type { StartSource } from '../../core/platform/processes';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

type HolderModule = typeof import('../../core/remote/holder');
type Paths = typeof import('../../core/paths');
type Scan = typeof import('../../core/scan');

let holder: HolderModule;
let paths: Paths;
let scan: Scan;

let home: string;
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  holder = await import('../../core/remote/holder');
  paths = await import('../../core/paths');
  scan = await import('../../core/scan');
});

beforeEach(() => fs.rm(paths.REMOTE_DIR, { recursive: true, force: true }));

const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

function window(id: string, pid: number, startedAt: number): Holder {
  return { windowId: id, label: `${id} · repo`, folder: '/repo', pid, startedAt, since: 1 };
}

/** Every window these tests name, claimed: what a press also needs to see a
 *  holder as alive, apart from the cases about claims. */
const CLAIMED = ['w1', 'w2', 'a', 'b', 'c', 'gone', 'crashed'].map((id) => ({ id }));

/** The clock this machine's table was read on, which a real identity carries. */
function clockOf(real: ProcessTable): StartSource {
  assert.ok(real.startSource, 'the table names its clock');
  return real.startSource;
}

/** A process table that knows exactly these starts, the only field read. */
function table(starts: Record<number, number>): Pick<ProcessTable, 'starts'> {
  return { starts: new Map(Object.entries(starts).map(([pid, at]) => [Number(pid), at])) };
}

describe('the Remote holder', () => {
  it('takes an incoming holder only after its real native host dies; old release cannot remove the replacement', async () => {
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    assert.ok(host.pid);
    const exited = once(host, 'exit');
    try {
      const real = await scan.scanProcesses(true);
      const started = real.starts.get(host.pid);
      assert.ok(started !== undefined);
      const old = window('old', host.pid, started);
      old.incoming = {
        host: {
          version: 1,
          windowId: 'old',
          pid: host.pid,
          osStartedAt: started,
          startSource: clockOf(real),
          incarnation: randomUUID()
        },
        generation: 1
      };
      const next = window('next', process.pid, real.starts.get(process.pid)!);
      next.incoming = {
        host: {
          ...old.incoming.host,
          windowId: 'next',
          pid: process.pid,
          osStartedAt: next.startedAt,
          incarnation: randomUUID()
        },
        generation: 1
      };
      assert.deepEqual(await holder.acquireHolder(old, real, []), { ok: true });
      assert.equal((await holder.acquireHolder(next, real, [{ id: 'next' }])).ok, false);
      host.kill();
      await exited;
      assert.deepEqual(
        await holder.acquireHolder(next, await scan.scanProcesses(true), [{ id: 'next' }]),
        { ok: true }
      );
      await holder.releaseHolder(old);
      assert.deepEqual(await holder.namedHolder(), next);
    } finally {
      host.kill();
      await exited;
    }
  });
  it('keeps an incoming holder exclusive while its exact host lives, even after its claim expires', async () => {
    const real = await scan.scanProcesses(true);
    const startedAt = real.starts.get(process.pid)!;
    const first = window('w1', process.pid, startedAt);
    first.incoming = {
      host: {
        version: 1,
        windowId: 'w1',
        pid: process.pid,
        osStartedAt: startedAt,
        startSource: clockOf(real),
        incarnation: randomUUID()
      },
      generation: 1
    };
    assert.deepEqual(await holder.acquireHolder(first, real, CLAIMED), { ok: true });
    // Exclusive because its exact host is alive on this clock, not because a
    // foreign clock could not be judged.
    assert.deepEqual(await holder.incomingHolderNow('w1', first.incoming), first);
    const next = window('w2', process.pid + 1_000_000, startedAt);
    assert.deepEqual(await holder.acquireHolder(next, real, [{ id: 'w2' }]), {
      ok: false,
      holder: first
    });
    assert.deepEqual(await holder.acquireHolder(next, { starts: new Map() }, [{ id: 'w2' }]), {
      ok: false,
      holder: first
    });
    await holder.releaseHolder(first);
    assert.deepEqual(await holder.acquireHolder(next, real, CLAIMED), { ok: true });
  });
  it('refuses a second window while the first is alive, and names it', async () => {
    // The test's own process, read off the same table every reader reads.
    const real = await scan.scanProcesses(true);
    const startedAt = real.starts.get(process.pid);
    assert.ok(startedAt !== undefined, 'ps reports this process');
    const first = window('w1', process.pid, startedAt);
    const second = window('w2', process.pid + 1_000_000, startedAt);

    assert.deepEqual(await holder.acquireHolder(first, real, CLAIMED), { ok: true });
    assert.deepEqual(await holder.acquireHolder(second, real, CLAIMED), {
      ok: false,
      holder: first
    });
    assert.deepEqual(await holder.readHolder(real), first);
  });

  it('takes over from a holder whose pid was recycled', async () => {
    const dead = window('w1', 7001, 1_000);
    const next = window('w2', 7002, 5_000);
    // 7001 is alive, but started an hour after the holder wrote its file.
    const procs = table({ 7001: 1_000 + 3_600_000, 7002: 5_000 });
    await writeJson(paths.HOLDER_FILE, dead);

    assert.equal(holderAliveFor(dead, procs), false);
    assert.equal(await holder.readHolder(procs), undefined);
    assert.deepEqual(await holder.acquireHolder(next, procs, CLAIMED), { ok: true });
    assert.deepEqual(await holder.readHolder(procs), next);
  });

  it('gives a dead holder to exactly one of two windows racing for it', async () => {
    for (let round = 0; round < 40; round++) {
      await fs.rm(paths.REMOTE_DIR, { recursive: true, force: true });
      await writeJson(paths.HOLDER_FILE, window('gone', 7100, 1_000));
      const a = window('a', 7101, 2_000);
      const b = window('b', 7102, 3_000);
      const procs = table({ 7101: 2_000, 7102: 3_000 });

      const results = await Promise.all([
        holder.acquireHolder(a, procs, CLAIMED),
        holder.acquireHolder(b, procs, CLAIMED)
      ]);

      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
      const won = results[0]?.ok ? a : b;
      const lost = results.find((r) => !r.ok);
      assert.deepEqual(lost, { ok: false, holder: won }, `round ${round}`);
      assert.deepEqual(await holder.readHolder(procs), won, `round ${round}`);
    }
  });

  /**
   * Three windows and one dead holder, with B's file calls paused wherever the
   * test says: B judges, A takes over in full, B goes on some way, C acquires
   * in full, B finishes. Every pair of pause points is played, so the
   * interleaving that matters is chosen rather than hoped for.
   */
  it('gives a dead holder to exactly one of three windows, wherever one pauses', async (t) => {
    const steps = stepper(t);
    const a = window('a', 7601, 2_000);
    const b = window('b', 7602, 3_000);
    const c = window('c', 7603, 4_000);
    const procs = table({ 7601: 2_000, 7602: 3_000, 7603: 4_000 });
    const fresh = async () => {
      await fs.rm(paths.REMOTE_DIR, { recursive: true, force: true });
      await writeJson(paths.HOLDER_FILE, window('gone', 7600, 1_000));
    };

    await fresh();
    const total = await steps.count(() => holder.acquireHolder(b, procs, CLAIMED));

    for (let first = 0; first <= total; first++) {
      for (let second = 0; second <= total - first; second++) {
        await fresh();
        const late = steps.paused(first, () => holder.acquireHolder(b, procs, CLAIMED));
        await late.parked();
        const ra = await holder.acquireHolder(a, procs, CLAIMED);
        await late.resume(second);
        const rc = await holder.acquireHolder(c, procs, CLAIMED);
        const rb = await late.finish();

        const at = `B paused after ${first}, then ${second} more`;
        const won = [ra, rb, rc].flatMap((r, i) => (r.ok ? [[a, b, c][i]] : []));
        assert.equal(won.length, 1, `${at}: ${JSON.stringify([ra, rb, rc])}`);
        assert.deepEqual(await holder.readHolder(procs), won[0], at);
        assert.deepEqual(await fs.readdir(paths.REMOTE_DIR), ['holder.json'], at);
      }
    }
  });

  it('takes over past a window that died while removing a dead holder', async () => {
    const me = window('w1', 7701, 1_000);
    const procs = table({ 7701: 1_000 });
    await writeJson(paths.HOLDER_FILE, window('gone', 7700, 1_000));
    await writeJson(`${paths.HOLDER_FILE}.lock`, window('crashed', 7702, 1_000));

    assert.deepEqual(await holder.acquireHolder(me, procs, CLAIMED), { ok: true });
    assert.deepEqual(await holder.readHolder(procs), me);
    assert.deepEqual(await fs.readdir(paths.REMOTE_DIR), ['holder.json']);
  });

  it('refuses, naming nobody, while a live window removes the dead holder', async () => {
    const me = window('w1', 7801, 1_000);
    const remover = window('w2', 7802, 2_000);
    const procs = table({ 7801: 1_000, 7802: 2_000 });
    await writeJson(paths.HOLDER_FILE, window('gone', 7800, 1_000));
    await writeJson(`${paths.HOLDER_FILE}.lock`, remover);

    assert.deepEqual(await holder.acquireHolder(me, procs, CLAIMED), { ok: false });
    assert.equal(await holder.readHolder(procs), undefined);
  });

  it('leaves the file when a window that does not hold it releases', async () => {
    const me = window('w1', 7201, 1_000);
    const other = window('w2', 7202, 2_000);
    const procs = table({ 7201: 1_000, 7202: 2_000 });
    await holder.acquireHolder(me, procs, CLAIMED);

    await holder.releaseHolder(other);
    assert.deepEqual(await holder.readHolder(procs), me);

    await holder.releaseHolder(me);
    assert.equal(await exists(paths.HOLDER_FILE), false);
  });

  it('answers yes again to the window that already holds it', async () => {
    const me = window('w1', 7301, 1_000);
    const procs = table({ 7301: 1_000 });

    assert.deepEqual(await holder.acquireHolder(me, procs, CLAIMED), { ok: true });
    assert.deepEqual(await holder.acquireHolder(me, procs, CLAIMED), { ok: true });
  });

  it('takes a file that is not a holder as nobody holding it', async () => {
    await fs.mkdir(paths.REMOTE_DIR, { recursive: true });
    await fs.writeFile(paths.HOLDER_FILE, 'not json');
    const me = window('w1', 7401, 1_000);
    const procs = table({ 7401: 1_000 });

    assert.equal(await holder.readHolder(procs), undefined);
    assert.deepEqual(await holder.acquireHolder(me, procs, CLAIMED), { ok: true });
  });

  it('keeps ordinary ownership when optional incoming metadata is malformed or mismatched', async () => {
    const real = await scan.scanProcesses(true);
    const startedAt = real.starts.get(process.pid);
    assert.ok(startedAt !== undefined, 'ps reports this process');
    const live = window('w1', process.pid, startedAt);
    const next = window('w2', process.pid + 1_000_000, startedAt);
    const incoming = {
      host: {
        version: 1 as const,
        windowId: live.windowId,
        pid: live.pid,
        osStartedAt: live.startedAt,
        startSource: clockOf(real),
        incarnation: randomUUID()
      },
      generation: 1
    };
    await writeJson(paths.HOLDER_FILE, { ...live, incoming });
    assert.deepEqual(await holder.incomingHolderNow('w1', incoming), { ...live, incoming });

    for (const optional of [
      null,
      { ...incoming, generation: 'invalid' },
      { ...incoming, host: { ...incoming.host, pid: next.pid } },
      { ...incoming, host: { ...incoming.host, osStartedAt: startedAt + 1 } },
      { ...incoming, host: { ...incoming.host, windowId: 'w2' } }
    ]) {
      await writeJson(paths.HOLDER_FILE, { ...live, incoming: optional });
      assert.deepEqual(await holder.namedHolder(), live);
      assert.deepEqual(await holder.readHolder(real), live);
      assert.equal(await holder.incomingHolderNow('w1', incoming), undefined);
      assert.deepEqual(await holder.acquireHolder(next, real, CLAIMED), {
        ok: false,
        holder: live
      });
      assert.deepEqual(JSON.parse(await fs.readFile(paths.HOLDER_FILE, 'utf8')), {
        ...live,
        incoming: optional
      });
    }
  });

  it('takes an empty process table as unknown: no holder judged dead, none removed', async () => {
    const live = window('w2', 7902, 2_000);
    const me = window('w1', 7901, 1_000);
    await writeJson(paths.HOLDER_FILE, live);
    const failed = table({});

    assert.deepEqual(await holder.readHolder(failed), live);
    assert.deepEqual(await holder.acquireHolder(me, failed, CLAIMED), { ok: false, holder: live });
    assert.deepEqual(await holder.readHolder(table({ 7902: 2_000 })), live);
  });

  it('a press takes over a holder whose window no live claim names; every other reader sees it', async () => {
    // A live pid at its own start, as a forged file would name one.
    const real = await scan.scanProcesses(true);
    const startedAt = real.starts.get(process.pid);
    assert.ok(startedAt !== undefined, 'ps reports this process');
    const forged = window('forged', process.pid, startedAt);
    const me = window('w1', 7801, 1_000);
    await writeJson(paths.HOLDER_FILE, forged);
    const seen = { starts: new Map([...real.starts, [7801, 1_000]]) };
    const claims = [{ id: 'w1' }];

    assert.equal(holder.holderAlive(forged, seen), true);
    assert.deepEqual(await holder.readHolder(seen), forged);
    assert.deepEqual(await holder.acquireHolder(me, seen, claims), { ok: true });
    assert.deepEqual(await holder.readHolder(seen), me);
  });

  it('takes an empty claim list as unknown at a press, as it does an empty process table', async () => {
    const live = window('w2', 7952, 2_000);
    const me = window('w1', 7951, 1_000);
    await writeJson(paths.HOLDER_FILE, live);
    const procs = table({ 7951: 1_000, 7952: 2_000 });
    assert.deepEqual(await holder.acquireHolder(me, procs, []), { ok: false, holder: live });
  });

  it('leaves a remover its lock while its pid lives, whatever the claims say', async () => {
    const me = window('w1', 7811, 1_000);
    const remover = window('unclaimed', 7812, 2_000);
    const procs = table({ 7811: 1_000, 7812: 2_000 });
    await writeJson(paths.HOLDER_FILE, window('gone', 7810, 1_000));
    await writeJson(`${paths.HOLDER_FILE}.lock`, remover);

    assert.deepEqual(await holder.acquireHolder(me, procs, [{ id: 'w1' }]), { ok: false });
    assert.ok(await exists(`${paths.HOLDER_FILE}.lock`), 'the live remover keeps its lock');
  });

  it('removes a window’s claim only once Remote there has released', async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let unclaimed = false;
    const closing = holder.unclaimAfter(released, () => {
      unclaimed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unclaimed, false, 'the claim stays while the engine drains');
    release();
    await closing;
    assert.equal(unclaimed, true);
  });

  it('leaves nothing beside the file but the file', async () => {
    const me = window('w1', 7501, 1_000);
    const procs = table({ 7501: 1_000 });
    await writeJson(paths.HOLDER_FILE, window('gone', 7500, 1_000));

    await holder.acquireHolder(me, procs, CLAIMED);

    assert.deepEqual(await fs.readdir(paths.REMOTE_DIR), ['holder.json']);
  });
});

type Fs = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Holds every `fs/promises` call one acquire makes until the test lets it
 * through, counted. The acquire is told apart by its async context, so the
 * other windows' calls pass straight through.
 */
function stepper(t: TestContext) {
  const context = new AsyncLocalStorage<true>();
  let budget = Infinity;
  let calls = 0;
  let waiting = false;
  let resume: (() => void) | undefined;
  let onPark: (() => void) | undefined;
  const real = fs as unknown as Fs;
  for (const name of ['mkdir', 'writeFile', 'link', 'readFile', 'rename', 'rm', 'unlink']) {
    const original = real[name];
    if (original === undefined) continue;
    t.mock.method(real, name, async (...args: unknown[]) => {
      if (context.getStore()) {
        calls++;
        while (budget <= 0) {
          await new Promise<void>((done) => {
            resume = done;
            waiting = true;
            onPark?.();
          });
        }
        budget--;
      }
      return original.apply(fs, args);
    });
  }

  const release = (more: number) => {
    budget = more;
    waiting = false;
    const go = resume;
    resume = undefined;
    go?.();
  };

  return {
    /** How many file calls the acquire makes when nothing holds it. */
    async count(run: () => Promise<unknown>): Promise<number> {
      calls = 0;
      budget = Infinity;
      await context.run(true, run);
      return calls;
    },
    /** Starts `run`, letting `first` calls through before it waits. */
    paused(first: number, run: () => Promise<Acquired>) {
      budget = first;
      const done = context.run(true, run);
      const parked = () =>
        waiting
          ? Promise.resolve()
          : Promise.race([done.then(() => undefined), new Promise<void>((r) => (onPark = r))]);
      return {
        parked,
        /** `more` calls further, then waits again, or finishes. */
        resume(more: number) {
          release(more);
          return parked();
        },
        finish() {
          release(Infinity);
          return done;
        }
      };
    }
  };
}

function holderAliveFor(h: Holder, procs: Pick<ProcessTable, 'starts'>): boolean {
  return holder.holderAlive(h, procs);
}
