import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { before, beforeEach, describe, it } from 'node:test';
import { homeEnv, tempHome } from '../helpers';

let coordination: typeof import('../../core/coordination/usage');
let store: typeof import('../../core/usage');
let policy: typeof import('../../core/usage_policy');
let home: string;
before(async () => {
  home = await tempHome();
  coordination = await import('../../core/coordination/usage');
  store = await import('../../core/usage');
  policy = await import('../../core/usage_policy');
});
beforeEach(async () => {
  const paths = await import('../../core/paths');
  await fs.rm(paths.usageStateFile('claude'), { force: true });
  await store.forgetUsageFor('claude');
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A turn ended a moment ago, and the store last heard of the account an hour ago. */
const ended = (now: number, observedAt: number | undefined = now - HOUR) => ({
  hint: { since: now - 3_000, busy: false },
  observedAt: () => Promise.resolve(observedAt)
});

describe('the live deadline', () => {
  const due = (over: Partial<Parameters<typeof policy.liveDue>[0]>) =>
    policy.liveDue({ busy: false, ...over });

  it('waits for nothing when nothing is active', () => {
    assert.equal(due({ observedAt: 1_000 }), undefined);
  });

  it('settles a turn end, then reads', () => {
    assert.equal(due({ since: 100_000, observedAt: 0 }), 100_000 + policy.LIVE_SETTLE_MS);
  });

  it('counts a push that came with the turn as covering it', () => {
    assert.equal(due({ since: 100_000, observedAt: 100_000 - 1_000 }), undefined);
  });

  it('holds a turn end inside the bound to a trailing read', () => {
    assert.equal(due({ since: 100_000, observedAt: 90_000 }), 90_000 + policy.LIVE_ACTIVE_MS);
  });

  it('reads a busy session once per bound, off the last observation', () => {
    assert.equal(due({ busy: true, observedAt: 500_000 }), 500_000 + policy.LIVE_ACTIVE_MS);
    assert.equal(due({ busy: true, observedAt: 500_000, activeAfter: 600_000 }), 600_000);
  });
});

describe('live admission', () => {
  it('admits a live read while the hourly fallback is not due', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    await coordination.mutate('claude', undefined, (state) => {
      state.notBefore = now + HOUR;
    });
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.ok('attempt' in answer, 'the hourly cooldown held back a live read');
  });

  it('defers within the bound of an observation another host just stored', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      hint: { since: now - 1_000, busy: false },
      observedAt: () => Promise.resolve(now - 10_000)
    });
    assert.deepEqual(answer, { after: now - 10_000 + policy.LIVE_ACTIVE_MS });
  });

  it('reads the stored observation inside the claim', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    let inside = false;
    // The raced mutate is the same promise joined below. Dropping it lets the
    // next reset remove a file this transaction has already read.
    let contender: Promise<boolean> | undefined;
    try {
      await coordination.admitLive('claude', undefined, now, {
        generation,
        hint: { since: now - 3_000, busy: false },
        observedAt: async () => {
          // A second transaction cannot start while the first holds the claim.
          contender = coordination.mutate('claude', undefined, () => false);
          void contender.catch(() => undefined);
          inside = await Promise.race([
            contender,
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200))
          ]);
          return now - HOUR;
        }
      });
      assert.equal(inside, true, 'the observation was read outside the claim');
    } finally {
      await contender;
    }
  });

  it('backs off a failed live read without moving the fallback', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const before = (await coordination.readState('claude'))?.notBefore;
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.ok('attempt' in answer);
    await coordination.completeLive('claude', undefined, answer.attempt, now + 1_000, false);
    const state = await coordination.readState('claude');
    assert.equal(state?.notBefore, before);
    assert.equal(state?.activeAfter, now + 1_000 + policy.LIVE_FAILURE_MS);
    assert.equal(state?.live, undefined);
  });

  /**
   * A host from before live reads knows only `attempt`, and its recovery
   * gives a dead owner's attempt the hourly cooldown. A live read therefore
   * holds a slot of its own that such a host neither recovers nor waits on.
   */
  it('keeps a live read out of the slot an older host recovers', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.ok('attempt' in answer);
    const state = await coordination.readState('claude');
    assert.equal(state?.attempt, undefined);
    assert.equal(state?.live?.id, answer.attempt.id);
  });

  it('retries a live release whose write failed, before the next read', async (t) => {
    const files = await import('../../core/files');
    const original = files.writeAtomicJson;
    let failing = false;
    t.mock.method(files, 'writeAtomicJson', (...args: Parameters<typeof original>) =>
      failing ? Promise.resolve(false) : original(...args)
    );
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.ok('attempt' in answer);
    failing = true;
    await assert.rejects(
      coordination.completeLive('claude', undefined, answer.attempt, now, true),
      /persist/
    );
    failing = false;
    assert.ok((await coordination.readState('claude'))?.live, 'the failed write landed anyway');
    await coordination.settle('claude');
    assert.equal((await coordination.readState('claude'))?.live, undefined);
    assert.ok(await coordination.admit('claude', undefined, now, HOUR, generation));
  });

  it('lets a held fallback attempt block a live one', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const fallback = await coordination.admit('claude', undefined, now, HOUR, generation);
    assert.ok(fallback);
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.equal('attempt' in answer, false);
  });

  it('clears an old account’s backoff on an account switch, and fences its completion', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    const first = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.ok('attempt' in first);
    await store.forgetUsageFor('claude');
    await coordination.completeLive('claude', undefined, first.attempt, now + 1_000, false);
    assert.equal((await coordination.readState('claude'))?.activeAfter, undefined);
  });

  it('bounds a backoff a clock jump left in the future', async () => {
    const now = Date.now();
    const generation = await coordination.generation('claude');
    await coordination.mutate('claude', undefined, (state) => {
      state.activeAfter = now + 10 * HOUR;
    });
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation,
      ...ended(now)
    });
    assert.deepEqual(answer, { after: now + policy.LIVE_FAILURE_MS });
  });

  it('reads a record written before live reads existed', async () => {
    const paths = await import('../../core/paths');
    await fs.mkdir(path.dirname(paths.usageStateFile('claude')), { recursive: true });
    await fs.writeFile(
      paths.usageStateFile('claude'),
      JSON.stringify({ version: 1, generation: 'old', notBefore: 0 })
    );
    const now = Date.now();
    const answer = await coordination.admitLive('claude', undefined, now, {
      generation: 'old',
      ...ended(now)
    });
    assert.ok('attempt' in answer);
  });

  it('admits one live read between real processes', async () => {
    const marker = path.join(home, 'live-attempts');
    await fs.rm(marker, { force: true });
    const generation = await coordination.generation('claude');
    const code = `
      const fs = require('node:fs/promises');
      const usage = require(${JSON.stringify(require.resolve('../../core/coordination/usage'))});
      (async () => {
        const now = Date.now();
        const answer = await usage.admitLive('claude', undefined, now, {
          generation: ${JSON.stringify(generation)},
          hint: { since: now - 3000, busy: false },
          observedAt: () => Promise.resolve(now - ${HOUR})
        });
        if (answer.attempt) await fs.appendFile(${JSON.stringify(marker)}, 'x');
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const run = () =>
      promisify(execFile)(process.execPath, ['-e', code], {
        env: { ...process.env, ...homeEnv(home) },
        timeout: 10_000
      });
    await Promise.all([run(), run()]);
    assert.equal(await fs.readFile(marker, 'utf8'), 'x');
  });

  it('recovers a dead host’s live attempt without postponing a due fallback', async () => {
    const generation = await coordination.generation('claude');
    const code = `
        const usage = require(${JSON.stringify(require.resolve('../../core/coordination/usage'))});
        (async () => {
          const now = Date.now();
          const answer = await usage.admitLive('claude', undefined, now, {
            generation: ${JSON.stringify(generation)},
            hint: { since: now - 3000, busy: false },
            observedAt: () => Promise.resolve(now - ${2 * HOUR})
          });
          process.exit(answer.attempt ? 23 : 1);
        })().catch(e=>{console.error(e);process.exit(1)});
      `;
    const code_ = await promisify(execFile)(process.execPath, ['-e', code], {
      env: { ...process.env, ...homeEnv(home) },
      timeout: 10_000
    }).then(
      () => 0,
      (error: { code: number }) => error.code
    );
    assert.equal(code_, 23);
    const now = Date.now();
    // The pass proves the owner gone, clears its slot and admits the due fallback.
    const fallback = await coordination.admit('claude', undefined, now, HOUR, generation);
    assert.ok(fallback, 'an abandoned live read postponed the fallback');
    const state = await coordination.readState('claude');
    assert.equal(state?.live, undefined);
    assert.ok((state?.activeAfter ?? 0) >= now + policy.LIVE_FAILURE_MS - 1_000);
    await coordination.complete('claude', undefined, fallback, now, HOUR);
  });
});

type Session = import('../../core/model').Session;
const card = (over: Partial<Session> & { pid: number }): Session => ({
  sessionId: `s${over.pid}`,
  cwd: '/',
  name: 'card',
  status: 'idle',
  hasCommand: false,
  startedAt: 1_000,
  updatedAt: 1_000,
  transcript: '',
  brand: 'claude',
  turnsEnded: 0,
  ...over
});

describe('activity hints', () => {
  let refresh: typeof import('../../core/usage_refresh');
  before(async () => {
    refresh = await import('../../core/usage_refresh');
  });

  it('takes every finished turn as a hint, from a card’s first sight on', () => {
    // An owned session never outlives the host that started it, so a card seen
    // for the first time with turns behind it finished them in this host: a
    // fast first turn can end before the first observation pass.
    const hints = new refresh.LiveHints();
    assert.equal(hints.observe([card({ pid: 1, turnsEnded: 0 })], 5_000), false);
    assert.deepEqual(hints.hint('claude'), { busy: false });
    assert.equal(hints.observe([card({ pid: 2, turnsEnded: 1 })], 10_000), true);
    assert.deepEqual(hints.hint('claude'), { since: 10_000, busy: false });
  });

  it('keeps the first unsatisfied turn end, however many follow', () => {
    const hints = new refresh.LiveHints();
    hints.observe(
      [1, 2, 3, 4, 5].map((pid) => card({ pid })),
      0
    );
    hints.observe(
      [1, 2, 3, 4, 5].map((pid) => card({ pid, turnsEnded: 1 })),
      20_000
    );
    hints.observe([card({ pid: 1, turnsEnded: 2 })], 30_000);
    assert.equal(hints.hint('claude').since, 20_000);
    hints.covered('claude', 30_000 - 4_000);
    assert.equal(hints.hint('claude').since, undefined, 'a covering observation kept the hint');
  });

  it('keeps the newest turn end an observation of an older one does not cover', () => {
    const hints = new refresh.LiveHints();
    hints.observe([card({ pid: 1 })], 0);
    hints.observe([card({ pid: 1, turnsEnded: 1 })], 10_000);
    hints.observe([card({ pid: 1, turnsEnded: 2 })], 30_000);
    assert.equal(hints.hint('claude').since, 10_000);
    hints.covered('claude', 20_000);
    assert.equal(hints.hint('claude').since, 30_000, 'a later turn end was dropped');
    hints.covered('claude', 30_000);
    assert.equal(hints.hint('claude').since, undefined);
  });

  it('keeps a hint an older observation does not cover', () => {
    const hints = new refresh.LiveHints();
    hints.observe([card({ pid: 1 })], 0);
    hints.observe([card({ pid: 1, turnsEnded: 1 })], 20_000);
    hints.covered('claude', 10_000);
    assert.equal(hints.hint('claude').since, 20_000);
  });

  it('reads busy as active, and a warm ping or a person’s answer as not', () => {
    const hints = new refresh.LiveHints();
    assert.equal(hints.observe([card({ pid: 1, status: 'busy' })], 0), true);
    assert.equal(hints.hint('claude').busy, true);
    hints.observe([card({ pid: 1, status: 'busy', warming: true })], 1_000);
    assert.equal(hints.hint('claude').busy, false);
    hints.observe([card({ pid: 1, status: 'waiting' })], 2_000);
    assert.deepEqual(hints.hint('claude'), { busy: false });
  });

  it('keeps brands apart', () => {
    const hints = new refresh.LiveHints();
    hints.observe([card({ pid: 1 }), card({ pid: 2, brand: 'codex' })], 0);
    hints.observe([card({ pid: 1 }), card({ pid: 2, brand: 'codex', turnsEnded: 1 })], 5_000);
    assert.deepEqual(hints.hint('claude'), { busy: false });
    assert.equal(hints.hint('codex').since, 5_000);
  });
});

describe('the live reader', () => {
  let refresh: typeof import('../../core/usage_refresh');
  before(async () => {
    refresh = await import('../../core/usage_refresh');
  });
  const source = (childless?: true) =>
    ({
      windows: [{ id: 'weekly', short: 'wk' }],
      everyMs: HOUR,
      noResetMs: HOUR,
      read: () => Promise.resolve({ windows: [{ id: 'weekly', short: 'wk', pct: 1 }] }),
      ...(childless ? { childless } : {})
    }) as import('../../core/adapter').UsageSource;

  it('asks an owned session first', async () => {
    const handle = {
      read: () => Promise.resolve({ windows: [{ id: 'weekly', short: 'wk', pct: 9 }] })
    };
    const read = refresh.liveReaderFor(source(), handle);
    assert.equal((await read?.())?.windows[0]?.pct, 9);
  });

  it('uses a source that starts no child when no session can answer', async () => {
    assert.equal((await refresh.liveReaderFor(source(true), undefined)?.())?.windows[0]?.pct, 1);
  });

  it('never starts a child for activity', () => {
    assert.equal(refresh.liveReaderFor(source(), undefined), undefined);
  });
});

describe('an activity-driven read', () => {
  const source = {
    windows: [{ id: 'weekly', short: 'wk' }],
    everyMs: HOUR,
    noResetMs: 7 * 24 * HOUR,
    read: () => Promise.reject(new Error('the fallback was spent'))
  } as import('../../core/adapter').UsageSource;
  const reset = () => Math.floor(Date.now() / 1000) + 24 * 3600;
  const figure = (pct: number) => () =>
    Promise.resolve({ windows: [{ id: 'weekly', short: 'wk', pct, resetsAt: reset() }] });

  /** Real files, a moved clock. Seeds an observation `ago` before `start`. */
  async function seeded(t: import('node:test').TestContext, ago: number) {
    const start = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now: start });
    await store.noteReading(
      'claude',
      { at: start - ago, windows: [{ id: 'weekly', short: 'wk', pct: 20, resetsAt: reset() }] },
      { refreshMs: HOUR }
    );
    store.invalidate();
    const generation = await coordination.generation('claude');
    const at = (ms: number) => {
      t.mock.timers.setTime(start + ms);
      return start + ms;
    };
    return { start, generation, at };
  }
  const entry = (generation: string) => ({ brand: 'claude' as const, source, generation });

  it('restamps an unchanged figure and postpones the fallback', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    let reads = 0;
    const read = () => {
      reads++;
      return figure(20)();
    };
    const now = at(3_000);
    await store.readLive(entry(generation), { since: start, busy: false }, read, { now });
    assert.equal(reads, 1);
    assert.equal((await store.readStoredUsage('claude'))?.at, now);
    assert.equal((await coordination.readState('claude'))?.notBefore, now + HOUR);
  });

  it('shares one read between sessions ending together', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    let reads = 0;
    const read = async () => {
      reads++;
      await new Promise((resolve) => setImmediate(resolve));
      return figure(21)();
    };
    const now = at(3_000);
    const hint = { since: start, busy: false };
    await Promise.all([1, 2, 3].map(() => store.readLive(entry(generation), hint, read, { now })));
    assert.equal(reads, 1);
  });

  it('holds a turn end inside the bound to one trailing read', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    let reads = 0;
    const read = () => {
      reads++;
      return figure(22)();
    };
    const first = at(3_000);
    await store.readLive(entry(generation), { since: start, busy: false }, read, { now: first });
    const hint = { since: first + 10_000, busy: false };
    const after = await store.readLive(entry(generation), hint, read, { now: at(12_000) + 2_000 });
    assert.equal(reads, 1, 'read again inside the bound');
    assert.equal(after, first + policy.LIVE_ACTIVE_MS);
    await store.readLive(entry(generation), hint, read, { now: at(3_000 + policy.LIVE_ACTIVE_MS) });
    assert.equal(reads, 2, 'the trailing read never came');
  });

  it('spends nothing when the turn’s own push covered it', async (t) => {
    const { start, generation, at } = await seeded(t, 1_000);
    let reads = 0;
    const read = () => {
      reads++;
      return figure(23)();
    };
    const after = await store.readLive(entry(generation), { since: start, busy: false }, read, {
      now: at(3_000)
    });
    assert.equal(reads, 0);
    assert.equal(after, undefined);
  });

  it('reads a busy session exactly once a minute', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    let reads = 0;
    const read = () => {
      reads++;
      return figure(24)();
    };
    const busy = { busy: true };
    for (let minute = 0; minute < 4; minute++) {
      const base = minute * policy.LIVE_ACTIVE_MS;
      await store.readLive(entry(generation), busy, read, { now: at(base + 500) });
      assert.equal(reads, minute + 1, `minute ${minute}`);
      const after = await store.readLive(entry(generation), busy, read, { now: at(base + 30_000) });
      assert.equal(reads, minute + 1, `read twice in minute ${minute}`);
      assert.equal(after, start + base + 500 + policy.LIVE_ACTIVE_MS);
    }
  });

  it('keeps the last stamp and the fallback when a read fails, and backs off', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    const before = await coordination.readState('claude');
    const now = at(3_000);
    const after = await store.readLive(
      entry(generation),
      { since: start, busy: false },
      () => Promise.reject(new Error('offline')),
      { now }
    );
    assert.equal((await store.readStoredUsage('claude'))?.at, start - 50 * MINUTE);
    assert.equal((await coordination.readState('claude'))?.notBefore, before?.notBefore);
    assert.equal(after, now + policy.LIVE_FAILURE_MS);
  });

  it('keeps a figureless answer’s rollover while backing off as for a failure', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    const now = at(3_000);
    const after = await store.readLive(
      entry(generation),
      { since: start, busy: false },
      () =>
        Promise.resolve({
          windows: [{ id: 'weekly', short: 'wk', resetsAt: reset() + 7 * 24 * 3600 }]
        }),
      { now }
    );
    const held = await store.readStoredUsage('claude');
    assert.equal(held?.windows.find((window) => window.id === 'weekly')?.pct, undefined);
    assert.equal(held?.at, start - 50 * MINUTE);
    assert.equal(after, now + policy.LIVE_FAILURE_MS);
  });

  it('takes a figureless answer as a failure, not an observation', async (t) => {
    const { start, generation, at } = await seeded(t, 50 * MINUTE);
    const now = at(3_000);
    const after = await store.readLive(
      entry(generation),
      { since: start, busy: false },
      () => Promise.resolve({ windows: [{ id: 'weekly', short: 'wk' }] }),
      { now }
    );
    assert.equal((await store.readStoredUsage('claude'))?.at, start - 50 * MINUTE);
    assert.equal(after, now + policy.LIVE_FAILURE_MS);
  });
});

describe('the refresher’s live tenant', () => {
  it('reads once after a turn ends, through the real scheduler', async (t) => {
    const { Reconciler } = await import('../../core/reconcile');
    const { UsageRefresher } = await import('../../core/usage_refresh');
    const reset = Math.floor(Date.now() / 1000) + 24 * 3600;
    const seededAt = Date.now() - 50 * MINUTE;
    await store.noteReading(
      'claude',
      { at: seededAt, windows: [{ id: 'weekly', short: 'wk', pct: 20, resetsAt: reset }] },
      { refreshMs: HOUR }
    );
    const source = {
      windows: [{ id: 'weekly', short: 'wk' }],
      everyMs: HOUR,
      noResetMs: 7 * 24 * HOUR,
      read: () => Promise.reject(new Error('the fallback was spent'))
    } as import('../../core/adapter').UsageSource;
    const generation = await coordination.generation('claude');
    let reads = 0;
    let sessions = [card({ pid: 7, turnsEnded: 0 })];
    const runtime = new Reconciler();
    const refresher = new UsageRefresher(runtime, {
      brands: () => Promise.resolve([]),
      observations: () =>
        Promise.resolve([{ brand: 'claude', source, signedIn: true, generation }]),
      sessions: () => sessions,
      liveReader: () => () => {
        reads++;
        return Promise.resolve({
          windows: [{ id: 'weekly', short: 'wk', pct: 20, resetsAt: reset }]
        });
      },
      now: Date.now,
      log: () => {}
    });
    t.after(async () => {
      await refresher.dispose();
      runtime.dispose();
    });
    refresher.observations.requestCheck();
    await until(() => reads === 0 && sessions.length === 1, 50);
    sessions = [card({ pid: 7, turnsEnded: 1 })];
    refresher.observations.requestCheck();
    await until(() => reads === 1, 8_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(reads, 1, 'one turn end spent more than one read');
    store.invalidate();
    assert.ok(((await store.readStoredUsage('claude'))?.at ?? 0) > seededAt + 40 * MINUTE);
  });
});

async function until(done: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The refresher over a runtime that records what each tenant schedules. */
async function scheduled(
  ports: Partial<import('../../core/usage_refresh').UsageRefreshPorts> & {
    sessions(): readonly Session[];
  }
) {
  const { UsageRefresher } = await import('../../core/usage_refresh');
  const checks = new Map<string, () => Promise<void>>();
  const deadlines = new Map<string, number | undefined>();
  const runtime = {
    register: (name: string, _delay: number, check: () => Promise<void>) => {
      checks.set(name, check);
      return {
        noticeChange: () => {},
        requestCheck: () => {},
        schedule: (at: number | undefined) => deadlines.set(name, at),
        dispose: () => {}
      };
    }
  } as unknown as import('../../core/reconcile').Reconciler;
  const refresher = new UsageRefresher(runtime, {
    brands: () => Promise.resolve([]),
    observations: () => Promise.resolve([]),
    now: Date.now,
    log: () => {},
    ...ports
  });
  return {
    refresher,
    run: (name: string) => checks.get(name)!(),
    deadline: (name: string) => deadlines.get(name)
  };
}

describe('the live tenant’s schedule', () => {
  const source = {
    windows: [{ id: 'weekly', short: 'wk' }],
    everyMs: HOUR,
    noResetMs: 7 * 24 * HOUR,
    read: () => Promise.reject(new Error('the fallback was spent'))
  } as import('../../core/adapter').UsageSource;
  const reset = () => Math.floor(Date.now() / 1000) + 24 * 3600;
  const note = (at: number) =>
    store.noteReading(
      'claude',
      { at, windows: [{ id: 'weekly', short: 'wk', pct: 20, resetsAt: reset() }] },
      { refreshMs: HOUR }
    );

  it('schedules the newer turn end a covering observation left behind', async (t) => {
    const start = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const at = (ms: number) => t.mock.timers.setTime(start + ms);
    await note(start);
    const generation = await coordination.generation('claude');
    let sessions = [card({ pid: 3, turnsEnded: 0 })];
    const rig = await scheduled({
      sessions: () => sessions,
      observations: () =>
        Promise.resolve([{ brand: 'claude', source, signedIn: true, generation }]),
      liveReader: () => () => Promise.reject(new Error('not reached'))
    });
    await rig.run('usage observations');
    at(10_000);
    sessions = [card({ pid: 3, turnsEnded: 1 })];
    await rig.run('usage observations');
    at(30_000);
    await note(start + 30_000); // another window's observation
    store.invalidate();
    at(50_000);
    sessions = [card({ pid: 3, turnsEnded: 2 })];
    await rig.run('usage observations');
    at(60_000);
    await rig.run('live usage');
    assert.equal(rig.deadline('live usage'), start + 30_000 + policy.LIVE_ACTIVE_MS);
    await rig.refresher.dispose();
  });

  it('retries after a read that threw', async (t) => {
    const files = await import('../../core/files');
    const original = files.writeAtomicJson;
    let failing = false;
    t.mock.method(files, 'writeAtomicJson', (...args: Parameters<typeof original>) =>
      failing && String(args[0]).endsWith('usage.claude.json')
        ? Promise.resolve(false)
        : original(...args)
    );
    const start = Date.now();
    await note(start - HOUR);
    store.invalidate();
    const generation = await coordination.generation('claude');
    let sessions = [card({ pid: 4, status: 'idle' })];
    const rig = await scheduled({
      sessions: () => sessions,
      observations: () =>
        Promise.resolve([{ brand: 'claude', source, signedIn: true, generation }]),
      liveReader: () => () => {
        failing = true;
        return Promise.resolve({
          windows: [{ id: 'weekly', short: 'wk', pct: 21, resetsAt: reset() }]
        });
      }
    });
    sessions = [card({ pid: 4, status: 'busy' })];
    await rig.run('usage observations');
    await rig.run('live usage');
    const due = rig.deadline('live usage');
    assert.ok(due !== undefined, 'a failed read left no retry');
    assert.ok(due <= Date.now() + policy.LIVE_FAILURE_MS);
    await rig.refresher.dispose();
  });
});
