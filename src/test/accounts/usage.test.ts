import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { stampWindows } from '../../core/limits';
import type { RateLimits, RateWindow, Session } from '../../core/model';
import { tempHome, win, writeJson } from '../helpers';

type Usage = typeof import('../../core/claude/usage');

let usage: Usage;
let store: typeof import('../../core/usage');
let state: string;
let home: string;

before(async () => {
  home = await tempHome();
  usage = await import('../../core/claude/usage');
  store = await import('../../core/usage');
  state = path.join(home, '.squadron');
});

beforeEach(async () => {
  // Memory, the age beside it, the read clock and the file — one forget, since
  // one module owns all four now.
  await store.forgetUsageFor('claude');
  await store.forgetUsageFor('grok');
  portSays = undefined;
  await fs.rm(state, { recursive: true, force: true });
});

const SECOND = 1000;

/**
 * A write the test can see whatever the clock's grain. NTFS moves a file's
 * mtime in timer ticks — about 1 ms, 15.6 ms by default — and a case runs in
 * a few, so two real writes can share one; every write here is a fresh file
 * renamed into place, so after this any write at all moves the mtime.
 */
async function stamped(file: string): Promise<number> {
  const old = new Date('2000-01-01T00:00:00Z');
  await fs.utimes(file, old, old);
  return (await fs.stat(file)).mtimeMs;
}
const soon = () => Math.floor(Date.now() / 1000) + 3600;
const passed = () => Math.floor(Date.now() / 1000) - 60;

/**
 * A session as discovery hands one over: only the reading is read here.
 *
 * Stamped, because every producer stamps — `claude/session.ts` on the round
 * trip's return — and the store ranks readings by nothing else.
 */
const reporting = (pct: number, resetsAt = soon(), at = Date.now()): Session =>
  ({
    pid: 1,
    sessionId: randomUUID(),
    rateLimits: {
      at,
      windows: [
        { id: 'session', short: '5h', pct, resetsAt },
        { id: 'weekly', short: 'wk', pct: pct * 2, resetsAt }
      ]
    }
  }) as Session;

/** A session whose two windows carry figures and resets of their own. */
const hourAndWeek = (
  hourPct: number,
  hourReset: number,
  weekPct: number,
  weekReset: number,
  at = Date.now()
): Session =>
  ({
    pid: 1,
    sessionId: randomUUID(),
    rateLimits: {
      at,
      windows: [
        { id: 'session', short: '5h', pct: hourPct, resetsAt: hourReset },
        { id: 'weekly', short: 'wk', pct: weekPct, resetsAt: weekReset }
      ]
    }
  }) as Session;

/**
 * What the port answers the next time the walk reads it: a reading a test put
 * there, or nothing. Stands in for any brand's own read — the store's rules
 * about it are the same whoever the source is.
 */
let portSays: RateLimits | undefined;

/** The port states these windows, taken `agoMs` ago. */
function portStates(windows: RateWindow[], agoMs = 0): void {
  portSays = stampWindows({ windows }, Date.now() - agoMs);
}

/** The same, as two windows with a figure and a reset each. */
function portReadsWindows(
  hourPct: number,
  hourReset: number,
  weekPct: number,
  weekReset: number,
  agoMs = 0
): void {
  portStates(
    [
      { id: 'session', short: '5h', pct: hourPct, resetsAt: hourReset },
      { id: 'weekly', short: 'wk', pct: weekPct, resetsAt: weekReset }
    ],
    agoMs
  );
}

/** The port reads `pct` on the 5-hour window and twice it on the weekly. */
function portReads(pct: number, resetsAt = soon(), agoMs = 0): void {
  portReadsWindows(pct, resetsAt, pct * 2, resetsAt, agoMs);
}

/** Moves a file's mtime back. */
async function aged(file: string, agoMs: number): Promise<string> {
  const when = new Date(Date.now() - agoMs);
  await fs.utimes(file, when, when);
  return file;
}

const cache = () => path.join(state, 'usage.claude.json');

/**
 * A port with Claude's windows and intervals, reading whatever `portSays`
 * holds. Built here rather than imported so a test can say what it is
 * exercising: a read, on this brand's interval, with this brand's rules about
 * age and about which of two figures for one window is the later.
 */
const claudePort = (): import('../../core/adapter').UsageSource => ({
  windows: [
    { id: 'session', short: '5h' },
    { id: 'weekly', short: 'wk' }
  ],
  read: () => Promise.resolve(portSays),
  everyMs: 0,

  noResetMs: usage.NO_RESET_MS
});

/**
 * One pass of the host's walk — the real one. `host/panel_auth.ts` adds the
 * registry and the auth status and nothing else, so calling `walkUsage` here is
 * calling what ships. A hand-rolled copy of it is what let two bugs through the
 * first review: it drifted from the walk it stood for.
 *
 * The figure is the stored reading `usageFor` paints. These scenarios ask
 * whether there is a reading at all, so a record with no figure comes back
 * as nothing.
 */

async function pass(sessions: Session[] = [], everyMs = 0): Promise<RateLimits | undefined> {
  const source = { ...claudePort(), everyMs };
  const now = Date.now();
  await store.walkUsage({ brand: 'claude', source, signedIn: true }, { sessions, now });
  const got = await store.usageFor('claude', source, { now });
  return got?.windows.some((window) => typeof window.pct === 'number') ? got : undefined;
}

/** A window that has just opened: nothing held, nothing read yet, the file as
 *  another window left it. */
function newWindow(): void {
  store.invalidate('claude');
}

describe("the account's reading, end to end", () => {
  it('takes the live reading over a port reading taken before it', async () => {
    portReads(90, soon(), 60 * SECOND);
    const view = await pass([reporting(4)]);
    assert.equal(win(view, 'session')?.pct, 4);
    assert.equal(win(view, 'weekly')?.pct, 8);
  });

  it('finds nothing when nothing reports', async () => {
    assert.equal(await pass(), undefined);
  });

  it('ignores a reading whose window has already rolled over', async () => {
    portReads(80, passed());
    assert.equal(await pass(), undefined);
  });

  it('drops only the window that expired, keeping the one that has not', async () => {
    portStates([
      { id: 'session', short: '5h', pct: 40, resetsAt: passed() },
      { id: 'weekly', short: 'wk', pct: 60, resetsAt: soon() }
    ]);

    const view = await pass();
    assert.equal(win(view, 'session')?.pct, undefined);
    assert.equal(win(view, 'weekly')?.pct, 60);
  });

  it('keeps a reading that came with no reset time at all', async () => {
    portStates([{ id: 'session', short: '5h', pct: 7 }]);
    assert.equal(win(await pass(), 'session')?.pct, 7);
  });

  /**
   * The case the file exists for: an account driven entirely from this panel
   * has its reading only on a pipe — a session answers `get_usage` — so before
   * this, closing the window took the only reading of it on the machine with
   * it.
   */
  describe('the reading it writes down', () => {
    it('keeps the live reading, and reads it back when nothing is reporting', async () => {
      assert.equal(win(await pass([reporting(9)]), 'session')?.pct, 9);

      // A second window, or this one after a reload: the process cache is gone
      // and no session is reporting, so an answer can only have come off disk.
      newWindow();
      const view = await pass();
      assert.equal(win(view, 'session')?.pct, 9);
      assert.equal(win(view, 'weekly')?.pct, 18);
    });

    it('carries the stamp a reading was taken at, live or off disk', async () => {
      const live = (await pass([reporting(9)]))?.at;
      assert.ok(live !== undefined && Date.now() - live < 5 * SECOND);

      // Written down twenty minutes ago and read back by another window: the
      // stamp travels in the record, so this is the age of the figure and not of
      // the process that hydrated it.
      newWindow();
      await writeJson(cache(), {
        at: Date.now() - 20 * 60 * SECOND,
        windows: [{ id: 'session', short: '5h', pct: 9, resetsAt: soon() }]
      });
      const at = (await pass())?.at;
      assert.ok(at !== undefined && Date.now() - at > 19 * 60 * SECOND);
    });

    /**
     * A reading three days old still names the weekly window this account is
     * in — `resets_at` is fixed for a window's life — so nothing about it has
     * expired. It is still three days old, and the reading beside it was taken
     * now.
     */
    it('leaves an old port reading behind the reading already held', async () => {
      const week = soon();
      await pass([hourAndWeek(2, soon(), 80, week)]);
      portReadsWindows(29, passed(), 28, week, 3 * 24 * 3600 * SECOND);

      newWindow();
      const view = await pass();
      assert.equal(win(view, 'weekly')?.pct, 80, 'a three-day-old reading beat our own');
      assert.equal(win(view, 'session')?.pct, 2);
    });

    /**
     * The bug this file was rewritten for, in the small. Both readings name one
     * window — same `resets_at`, so no rollover — and the newer one reads lower.
     * Ranked by figure, as this was, the newer one loses and keeps losing until
     * the window rolls: Claude's `seven_day` fell 27% → 1% mid-window on
     * 2026-09-02 (server-side re-base, `resets_at` unchanged), and the panel
     * held 27% behind it.
     *
     * The trade is the case above it, inverted: a reading can be minutes stale
     * in content and still rank newest. A figure a few minutes old is the price
     * of a figure that can fall.
     */
    it('lets a fresher reading lower a figure inside one window', async () => {
      const week = soon();
      const hour = soon();
      await pass([hourAndWeek(12, hour, 80, week, Date.now() - 60 * SECOND)]);

      newWindow();
      portReadsWindows(11, hour, 1, week);

      const view = await pass();
      assert.equal(win(view, 'weekly')?.pct, 1, 'the panel held a figure the account had left');
      assert.equal(win(view, 'session')?.pct, 11);

      // And it is what was written down, not only what this pass answered.
      newWindow();
      assert.equal(win(await pass(), 'weekly')?.pct, 1);
    });

    /**
     * The same rule as `keeps a window the newest reading has no figure for`,
     * through the store and the file rather than through the merge alone — a
     * window nobody restated keeps its figure, and keeps its own age with it.
     * Why it is that rule, and the two shipped versions before it, are on that
     * test and on `mergeReadings`.
     */
    it('updates the window a partial reading states and keeps the other', async () => {
      const week = soon();
      const hour = soon();
      await pass([hourAndWeek(12, hour, 80, week, Date.now() - 60 * SECOND)]);

      newWindow();
      portStates([{ id: 'session', short: '5h', pct: 30, resetsAt: hour }]);

      const view = await pass();
      assert.equal(win(view, 'session')?.pct, 30);
      assert.equal(win(view, 'weekly')?.pct, 80, 'dashed a weekly nobody had restated');
      // The minute-old stamp rides with it, so the next weekly to arrive — even
      // one taken before this pass — still outranks it.
      assert.ok((win(view, 'weekly')?.at ?? 0) < (win(view, 'session')?.at ?? 0));

      // And it is what was written down, not only what this pass answered.
      newWindow();
      assert.equal(win(await pass(), 'weekly')?.pct, 80);
    });

    /**
     * The one thing the store says out loud. It cannot tell a re-based figure
     * from an answer that should not have been believed — it takes the newest
     * either way — so the least it can do is leave a line saying a figure went
     * backwards inside its own period.
     */
    it('says so when an accepted reading lowers a figure inside its period', async () => {
      const said: string[] = [];
      store.setUsageLog((line) => said.push(line));
      try {
        const week = soon();
        const hour = soon();
        await pass([hourAndWeek(12, hour, 73, week, Date.now() - 60 * SECOND)]);

        newWindow();
        await pass([hourAndWeek(12, hour, 52, week)]);
        // Which source produced it, and both stamps: the investigation this was
        // written after failed at exactly that point — a figure was known to
        // have dropped, and nothing said which of the pass's two sources said so.
        assert.equal(said.length, 1, said.join(' | '));
        assert.match(said[0] ?? '', /^usage: claude\/sessions weekly 73%@\d+ -> 52%@\d+ /);
        assert.match(said[0] ?? '', new RegExp(`within one period \\(resets ${week}\\)$`));

        // A rollover is not this: the window that reset is expected to read
        // lower, and saying so every week would bury the reading that is not.
        said.length = 0;
        newWindow();
        await pass([hourAndWeek(12, hour, 1, week + 7 * 24 * 3600)]);
        assert.deepEqual(said, []);
      } finally {
        store.setUsageLog(() => {});
      }
    });

    /** The guard on the write: `panel.ts` watches every `.json` under the state
     *  root, so rewriting the file just read nudges every window on the machine
     *  into a poll for no change in it. */
    it('leaves the store alone when it already holds the answer', async () => {
      await pass([reporting(9)]);
      const first = await stamped(cache());

      newWindow();
      await pass();
      assert.equal((await fs.stat(cache())).mtimeMs, first, 'rewrote the file it had just read');
    });

    /**
     * The guard again, at the shape that got past it — and the reason the shape
     * matters. To reach `noteReading` at all, the partial has to survive the
     * merge over the board: two sessions with complementary gaps cancel, each
     * filling the window the other left, and hand over a reading with no
     * declaration in it. One source alternating which window it drops does not
     * cancel, and that is the observed bug's own shape — `get_usage` answered
     * `seven_day` alone, and the fold emitted a figureless `session` beside it.
     *
     * Measured at 5 writes in 6 passes before the sort. Every write under the
     * state root nudges every window on the machine into a poll.
     */
    it('leaves the store alone when one source alternates which window it drops', async () => {
      const hour = soon();
      const week = soon();
      // One session, one account, the same two figures throughout — only which
      // of them the answer carries moves.
      const at = Date.now();
      const half = (which: 'session' | 'weekly'): Session =>
        ({
          pid: 1,
          sessionId: randomUUID(),
          rateLimits: {
            at,
            windows: [
              which === 'session'
                ? { id: 'session', short: '5h', pct: 12, resetsAt: hour }
                : { id: 'session', short: '5h' },
              which === 'weekly'
                ? { id: 'weekly', short: 'wk', pct: 70, resetsAt: week }
                : { id: 'weekly', short: 'wk' }
            ]
          }
        }) as Session;

      await pass([hourAndWeek(12, hour, 70, week, at)]);
      const first = await stamped(cache());

      for (const which of ['session', 'weekly', 'session', 'weekly'] as const) {
        newWindow();
        await pass([half(which)]);
      }

      assert.equal(
        (await fs.stat(cache())).mtimeMs,
        first,
        'rewrote the file for a change in nothing but window order'
      );
    });

    /**
     * The same guard, where the memo inside `writeStoredUsage` cannot stand in
     * for it. That memo only knows what *this* process last wrote — an undated
     * live reading, here — so the dated record another window left on disk gets
     * past it, and only the comparison at the call site stops the rewrite. Which
     * is the case that matters: the nudge costs a poll in every window on the
     * machine, and every window is a different process.
     */
    it('does not rewrite a store another window already agrees with', async () => {
      await pass([reporting(9)]);
      const view = await pass();
      await writeJson(cache(), { at: Date.now() - 60 * SECOND, windows: view?.windows });
      const first = await stamped(cache());

      newWindow();
      await pass();
      assert.equal((await fs.stat(cache())).mtimeMs, first, 'rewrote a file that already agreed');
    });

    /**
     * A reading that states no reset time for a window is retired on its own
     * age, and the age is the reading's — so a live one is not aged out by an
     * older reading arriving beside it for the *other* window.
     */
    it('keeps a live no-reset window when an old reading answers the other one', async () => {
      const week = soon();
      await pass([
        {
          pid: 1,
          sessionId: randomUUID(),
          rateLimits: {
            at: Date.now(),
            windows: [
              { id: 'session', short: '5h', pct: 4 },
              { id: 'weekly', short: 'wk', pct: 80, resetsAt: week }
            ]
          }
        } as Session
      ]);

      portStates([{ id: 'weekly', short: 'wk', pct: 90, resetsAt: week }], 3 * 24 * 3600 * SECOND);

      newWindow();
      const view = await pass();
      assert.equal(win(view, 'weekly')?.pct, 80, 'a three-day-old reading took the weekly');
      assert.equal(win(view, 'session')?.pct, 4, 'a live 5-hour reading aged out on the weekly');
    });

    /**
     * `narrow`'s contract reaching the field that was added to it: a clock
     * stepped forward once writes a reading nothing can retire. Age is the only
     * thing that retires a window with no reset time of its own, and an age in
     * the future never arrives.
     */
    it('refuses a stored reading dated in the future', async () => {
      await writeJson(cache(), {
        at: Date.now() + 6 * 3600 * SECOND,
        windows: [{ id: 'session', short: '5h', pct: 99 }]
      });
      await aged(cache(), 6 * 3600 * SECOND);

      assert.equal(await pass(), undefined);
    });

    /**
     * The store is what the panel knows, not what the panel was told on the
     * pipe. A reading that only ever reached it from a live session left an
     * account whose figures came off the port with nothing written down, and
     * nothing to open with on the next launch.
     */
    it('writes down a reading the port answered', async () => {
      portReads(31, soon(), 60 * SECOND);
      assert.equal(win(await pass(), 'session')?.pct, 31);

      // The port goes quiet and the process restarts: only our own copy is left.
      portSays = undefined;
      newWindow();
      assert.equal(win(await pass(), 'session')?.pct, 31);
    });

    /**
     * A copy that dated itself would be a reading claiming to be an hour and a
     * half younger than the one it was copied from — and would beat its source
     * on the next pass, then outlive a no-reset window by the age it shed. So
     * the age travels inside the record, and the file's own mtime answers only
     * for a reading that was live when it was written.
     */
    it('keeps the age of the reading it copied', async () => {
      portReads(31, soon(), 90 * 60 * SECOND);
      await pass();

      // The port goes quiet, so the age can only be the one the copy carries.
      portSays = undefined;
      newWindow();
      const at = (await pass())?.at;
      assert.ok(
        at !== undefined && Date.now() - at > 89 * 60 * SECOND,
        'the copy claimed to be newer than the reading it came from'
      );
    });

    it('rewrites it only when the reading has changed', async () => {
      const resetsAt = soon();
      const snapshot = reporting(9, resetsAt);
      await pass([snapshot]);
      const first = await stamped(cache());

      await pass([snapshot]);
      assert.equal((await fs.stat(cache())).mtimeMs, first, 'wrote the same reading twice');

      await pass([reporting(10, resetsAt)]);
      assert.notEqual((await fs.stat(cache())).mtimeMs, first);
    });

    /**
     * The one guard a dated reading needs that a live one does not. In memory a
     * window with no reset time is bounded by the process; on disk it would be
     * bounded by nothing, and 4% of some morning five hours gone would sit on
     * the nav bar looking exactly like this window's.
     */
    it('stops believing a dated reading that states no reset at all', async () => {
      const hours = (n: number) => ({
        at: Date.now() - n * 3600 * SECOND,
        windows: [{ id: 'session', short: '5h', pct: 4 }]
      });

      await writeJson(cache(), hours(4));
      newWindow();
      assert.equal(win(await pass(), 'session')?.pct, 4);

      await writeJson(cache(), hours(6));
      newWindow();
      assert.equal(await pass(), undefined);
    });

    /**
     * The starvation the cache invites and the gate has to stop: a weekly window
     * sits days from its reset, so a remembered reading answered ahead of the
     * read would answer every poll for the rest of the week — while the window
     * next door rewrote the file this one exists to read.
     */
    it('reads the port on the interval, rather than holding what it remembers', async () => {
      await pass([reporting(9)]);
      portReads(31);

      // The session that was reporting has gone, and the interval is up. Nothing
      // is remembered hard enough to skip the look — a weekly window sits days
      // from its reset, and a store that answered ahead of the read would answer
      // every poll for the rest of the week.

      assert.equal(win(await pass(), 'session')?.pct, 31);
    });

    it('keeps what it remembered when the look finds nothing', async () => {
      await pass([reporting(9)]);
      await fs.rm(cache());

      const view = await pass();
      assert.equal(win(view, 'session')?.pct, 9, 'a fruitless read threw away a true reading');
      assert.ok(view?.at !== undefined, 'a remembered reading went out undated');
    });

    // Written as text rather than through `writeJson`, because the number this
    // is about cannot be spelled in a source file: `1e999` parses to `Infinity`,
    // which passes `typeof === 'number'` and draws a bar to nowhere.
    it('refuses a reading whose percentage will not draw', async () => {
      await fs.mkdir(state, { recursive: true });
      await fs.writeFile(
        cache(),
        `{"windows":[{"id":"session","short":"5h","pct":1e999},{"id":"weekly","short":"wk","pct":12,"resetsAt":${soon()}}]}`
      );
      const view = await pass();
      assert.equal(win(view, 'session')?.pct, undefined);
      assert.equal(win(view, 'weekly')?.pct, 12);
    });

    it('ignores a stored record that states no reading', async () => {
      await writeJson(cache(), { windows: [{ id: 'session', short: '5h', resetsAt: soon() }] });
      assert.equal(await pass(), undefined);
    });
  });

  describe('what it costs', () => {
    it('remembers a port reading rather than reading again', async () => {
      portReads(17);
      assert.equal(win(await pass(), 'session')?.pct, 17);

      // Nothing left for the port to say: an answer now can only be the
      // remembered one, which is the whole point of the cache.
      portSays = undefined;
      assert.equal(win(await pass(), 'session')?.pct, 17);
    });

    it('does not retry a fruitless read on the next poll', async () => {
      assert.equal(await pass([], 60 * 60_000), undefined);
      portReads(25);
      assert.equal(await pass([], 60 * 60_000), undefined);
    });

    it('takes a live reading over the one it remembered', async () => {
      portReads(17, soon(), 60 * SECOND);
      assert.equal(win(await pass(), 'session')?.pct, 17);
      // Inside the same window, and lower: the later reading is the answer, and
      // the one it replaces is a minute old.
      assert.equal(win(await pass([reporting(2)]), 'session')?.pct, 2);
    });

    // The reason the cache is not simply held until something replaces it: what
    // it holds stops being true on its own, at a moment printed inside it.
    it('drops a remembered reading once its window rolls over', async () => {
      // Three seconds out, and the sleep is measured to the boundary rather than
      // counted from here. `resetsAt` is truncated to a whole second, so `+ 1`
      // was anywhere from 1000ms of slack down to none — the first read had to
      // land inside that. It does on an idle machine and does not inside
      // `deploy.mjs`'s tmpdir, where `npm ci` has just run and the whole gate is
      // competing for the box: `v2026.32.20` failed at the *first* assertion,
      // the window already rolled over before anything was asked.
      const rollsOver = Math.floor(Date.now() / 1000) + 3;
      portReads(44, rollsOver);
      assert.equal(win(await pass(), 'session')?.pct, 44);

      await new Promise((done) => setTimeout(done, rollsOver * 1000 - Date.now() + 100));

      // Not read again either — the retry window has not passed — so this is the
      // remembered reading being refused rather than a fresh miss.
      assert.equal(await pass(), undefined);
    });
  });
});

/**
 * The one rule the store settles every reading with, on its own. Moved here from
 * `views.test.ts` when the fold stopped being a view-model question: the panel
 * takes one reading per brand, and which one is this file's answer.
 */
describe('the newest of several readings', () => {
  /** One account's windows, as a source states them at a moment. */
  const taken = (
    at: number,
    session5h?: [number, number],
    weekly?: [number, number]
  ): RateLimits => ({
    at,
    windows: [
      ...(session5h
        ? [{ id: 'session', short: '5h', pct: session5h[0], resetsAt: session5h[1] }]
        : []),
      ...(weekly ? [{ id: 'weekly', short: 'wk', pct: weekly[0], resetsAt: weekly[1] }] : [])
    ]
  });

  it('takes the reading with the later stamp, however low it reads', () => {
    const usage = store.mergeReadings([taken(1000, [71, 5000]), taken(2000, [3, 5000])]);
    assert.deepEqual(win(usage, 'session'), {
      id: 'session',
      short: '5h',
      pct: 3,
      resetsAt: 5000,
      at: 2000
    });
    // And the record says when it was taken, since that is what the next one is
    // weighed against. The reading's stamp is the newest of its windows' now,
    // which for a reading whose windows all came from one source is that source's.
    assert.equal(usage?.at, 2000);
  });

  it('leaves an older reading behind, however high it reads', () => {
    const usage = store.mergeReadings([taken(2000, [10, 5000]), taken(1000, [42, 5000])]);
    assert.equal(win(usage, 'session')?.pct, 10);
  });

  it('settles a tie on the stamp with the later caller', () => {
    // What `noteReading` leans on: it passes what it held first and what just
    // arrived second, and two readings of one second are not a reason to keep
    // the older news.
    const usage = store.mergeReadings([taken(1000, [10, 5000]), taken(1000, [42, 5000])]);
    assert.equal(win(usage, 'session')?.pct, 42);
  });

  it('ranks an unstamped reading below every stamped one', () => {
    const undated: RateLimits = { windows: [{ id: 'session', short: '5h', pct: 90 }] };
    assert.equal(win(store.mergeReadings([taken(1000, [7, 5000]), undated]), 'session')?.pct, 7);
  });

  /**
   * Window by window, because a window is the thing that gets observed.
   *
   * This merge was tried once and dropped, for a good reason: a window carried
   * out of an older reading took the newer one's stamp with it, so an update for
   * that window arriving later but stamped earlier then lost to a figure that
   * had inherited a recency it never had. The answer is not to stop merging but
   * to stop the stamp being a property of the reading — each window carries when
   * *it* was seen, so nothing can inherit a recency it never had.
   *
   * What made this worth revisiting, observed 2026-09-10: a `get_usage` answer
   * came back with `seven_day` alone, and because the fold always emits both
   * windows it arrived as a figureless `session` beside it. Taking that reading
   * whole discarded a five-hour figure read minutes earlier, and the nav chip
   * drew `5h -` for the eight minutes until the next poll.
   */
  it('keeps a window the newest reading has no figure for', () => {
    const usage = store.mergeReadings([
      taken(1000, [80, 5000], [22, 9000]),
      taken(2000, [4, 5000])
    ]);
    assert.deepEqual(win(usage, 'session'), {
      id: 'session',
      short: '5h',
      pct: 4,
      resetsAt: 5000,
      at: 2000
    });
    // Carried, and honest about its age: the weekly is the older reading's, and
    // says so, so the next weekly to arrive outranks it on its own stamp.
    assert.deepEqual(win(usage, 'weekly'), {
      id: 'weekly',
      short: 'wk',
      pct: 22,
      resetsAt: 9000,
      at: 1000
    });
  });

  /** The bug this file's merge was restored for, at the shape it actually had:
   *  the newer reading *states* the window and simply has no figure for it. */
  it('keeps a figure a newer reading declares the window without', () => {
    const usage = store.mergeReadings([
      { at: 1000, windows: [{ id: 'session', short: '5h', pct: 18, resetsAt: 5000 }] },
      { at: 2000, windows: [{ id: 'session', short: '5h' }] }
    ]);
    assert.equal(win(usage, 'session')?.pct, 18);
  });

  /** A newer figure still wins outright — the merge is per window, not a
   *  preference for whatever read highest or first. */
  it('takes a newer figure for a window over an older one', () => {
    const usage = store.mergeReadings([
      taken(1000, [80, 5000], [22, 9000]),
      taken(2000, [4, 5000], [3, 9000])
    ]);
    assert.equal(win(usage, 'weekly')?.pct, 3);
  });

  /**
   * The case the merge must not break. At a rollover the figure it would carry
   * is *last period's*, which is not evidence about this one — so a stated reset
   * time that differs from the held figure's retires that figure rather than
   * carrying it. This is the one thing separating "no figure yet for this
   * window" from "a new period this window has no figure for yet".
   */
  it('drops a figure when the newer reading states a different period', () => {
    const rolled = Math.floor(Date.now() / 1000) - 60;
    const usage = store.mergeReadings([
      { at: 1000, windows: [{ id: 'weekly', short: 'wk', pct: 32, resetsAt: rolled }] },
      { at: 2000, windows: [{ id: 'weekly', short: 'wk', resetsAt: rolled + 7 * 24 * 3600 }] }
    ]);
    assert.equal(win(usage, 'weekly')?.pct, undefined);
  });

  /**
   * Found in review, 2026-09-10, and it is the same phenomenon as the bug this
   * merge was written for. The merged list was seeded from the declarations and
   * only then filled from the figures — and `Map.set` on a key it already holds
   * keeps the original slot — so whichever window a reading *declared* jumped to
   * the front of the record, whatever order the held one had it in.
   *
   * That reaches the store: `sameWindows` compares the list as it stands, so a
   * source alternating which window it declares rewrote the file for no change
   * in any figure. Measured at 5 writes in 6 passes; the store test below is the
   * same case end to end. A held record does *not* pin it — that was checked and
   * is wrong, because the held reading's figures are set into a map the
   * declarations already seeded.
   */
  it('states its windows in one order however the readings arrived', () => {
    const declaredHour = {
      at: 1000,
      windows: [
        { id: 'session', short: '5h' },
        { id: 'weekly', short: 'wk', pct: 70, resetsAt: 900 }
      ]
    };
    const declaredWeek = {
      at: 2000,
      windows: [
        { id: 'session', short: '5h', pct: 20, resetsAt: 800 },
        { id: 'weekly', short: 'wk' }
      ]
    };
    const ids = (view: RateLimits | undefined) => view?.windows.map((window) => window.id);
    assert.deepEqual(ids(store.mergeReadings([declaredHour, declaredWeek])), ['session', 'weekly']);
    assert.deepEqual(ids(store.mergeReadings([declaredWeek, declaredHour])), ['session', 'weekly']);
  });

  /**
   * The other half of the rollover clause. A reading that names a period is only
   * evidence against a figure of an *earlier* one — restating a period already
   * gone says nothing about the figure we hold, and retiring on it would also
   * leave the window carrying a reset time that has passed.
   */
  it('keeps a figure when a newer reading restates an older period', () => {
    const usage = store.mergeReadings([
      { windows: [{ id: 'weekly', short: 'wk', pct: 3, resetsAt: 900, at: 5000 }] },
      { windows: [{ id: 'weekly', short: 'wk', resetsAt: 100, at: 9000 }] }
    ]);
    assert.equal(win(usage, 'weekly')?.pct, 3);
    assert.equal(win(usage, 'weekly')?.resetsAt, 900);
  });

  it('says nothing at all when nothing reported', () => {
    assert.equal(store.mergeReadings([]), undefined);
    assert.equal(store.mergeReadings([undefined]), undefined);
    assert.equal(store.mergeReadings([{ windows: [] }]), undefined);
  });

  it('keeps a reading that came without a reset time', () => {
    const usage = store.mergeReadings([
      { at: 1000, windows: [{ id: 'session', short: '5h', pct: 10 }] }
    ]);
    assert.deepEqual(win(usage, 'session'), { id: 'session', short: '5h', pct: 10, at: 1000 });
  });
});

/** True only when neither side has a key the other lacks. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : never;

/**
 * This shape is declared twice — `RateLimits` in `core/model.ts` and `UsageView`
 * in `webview/protocol.d.ts` — and `panel.ts` hands one straight into the other
 * with no conversion, so it compiles by structural identity and nothing states
 * that it must. Adding `at` meant editing both in lockstep; adding it to one
 * would have meant a field that silently never reached the panel, with every
 * test green and no error anywhere to read.
 *
 * So the compiler is made to state it. Both key sets *and* both directions of
 * assignability: matching keys would not notice a `pct` that changed type on one
 * side, and assignability alone would not notice an added optional field, since
 * excess-property checking only ever applies to object literals.
 *
 * The wire types need no import — `protocol.d.ts` has no import or export of its
 * own and joins this compilation through tsconfig `files`, which is what makes
 * it ambient in both halves.
 */
describe('the shape the wire carries', () => {
  it('is the one core states, field for field', () => {
    const limits: SameKeys<RateLimits, UsageView> = true;
    const window: SameKeys<RateWindow, UsageWindow> = true;
    const core: RateLimits = { windows: [] };
    const wire: UsageView = { windows: [] };
    const toWire: UsageView = core;
    const toCore: RateLimits = wire;
    assert.ok(limits && window && toWire && toCore);
  });
});

/**
 * The chip's labels before any brand is known: the first source's declared
 * windows, as labels only. A declaration is not a reading, so its `pct: null`
 * (a window this brand lacks) stays behind.
 */
describe('the windows a chip waits with', () => {
  const declared = {
    windows: [
      { id: 'session', short: '5h', pct: null },
      { id: 'weekly', short: 'wk' }
    ]
  };

  it('takes the first brand with a usage port, labels only', () => {
    assert.deepEqual(store.pendingUsageWindows([undefined, declared]), [
      { id: 'session', short: '5h' },
      { id: 'weekly', short: 'wk' }
    ]);
  });

  it('prefers the earlier brand when several have one', () => {
    const other = { windows: [{ id: 'daily', short: '1d' }] };
    assert.deepEqual(store.pendingUsageWindows([other, declared]), [{ id: 'daily', short: '1d' }]);
  });

  it('has nothing to wait with when no brand states usage', () => {
    assert.equal(store.pendingUsageWindows([undefined, undefined]), undefined);
  });
});

/**
 * The mirror: what the panel holds between polls, and the file it is a mirror
 * of. Every rule here is the store's, so the port arrives as a literal — a
 * brand is `windows` plus two facts about its own reading, and neither needs a
 * CLI to state.
 */
describe('the reading this process holds', () => {
  const FIVE_HOURS = 5 * 60 * 60 * 1000;

  /** A port, as a brand declares one. `read` is never called here — the host
   *  calls it and hands the answer to `noteReading`. */
  const port = (over: { everyMs?: number } = {}) =>
    ({
      windows: [
        { id: 'session', short: '5h' },
        { id: 'weekly', short: 'wk' }
      ],
      read: () => Promise.resolve(undefined),
      everyMs: over.everyMs ?? 60_000,

      noResetMs: FIVE_HOURS
    }) as import('../../core/adapter').UsageSource;

  const week = (pct: number, resetsAt = soon(), at = Date.now()): RateLimits => ({
    at,
    windows: [{ id: 'weekly', short: 'wk', pct, resetsAt }]
  });

  const stored = async (): Promise<RateLimits | undefined> => await store.readStoredUsage('claude');

  beforeEach(() => {
    store.invalidate();
  });

  it('notices another process replacing the store without a file event', async () => {
    await store.writeStoredUsage('claude', week(40));
    await stamped(path.join(state, 'usage.claude.json'));
    assert.equal((await store.usageFor('claude', port()))?.windows[0]?.pct, 40);

    await store.writeStoredUsage('claude', week(70));
    assert.equal((await store.usageFor('claude', port()))?.windows[0]?.pct, 70);
  });

  it('writes a reading through to disk', async () => {
    await store.noteReading('claude', week(12));
    assert.equal((await stored())?.windows[0]?.pct, 12);
    assert.equal((await store.usageFor('claude', port()))?.windows[0]?.pct, 12);
  });

  it('paints held windows in the adapter order after its declarations change', async () => {
    await store.writeStoredUsage('codex', week(29));
    const codex = {
      ...port(),
      windows: [
        { id: 'session', short: '5h', pct: null },
        { id: 'weekly', short: 'wk' }
      ]
    } as import('../../core/adapter').UsageSource;
    const view = await store.usageFor('codex', codex);
    assert.deepEqual(
      view?.windows.map((window) => [window.short, window.pct]),
      [
        ['5h', null],
        ['wk', 29]
      ]
    );
  });

  it('does not rewrite the file for a figure that did not change', async () => {
    const snapshot = week(12);
    await store.noteReading('claude', snapshot);
    const first = await stamped(path.join(state, 'usage.claude.json'));
    await store.noteReading('claude', snapshot);
    const second = (await fs.stat(path.join(state, 'usage.claude.json'))).mtimeMs;
    // A write nudges every window on the machine into a poll, so an unchanged
    // reading writing itself back is a poll storm with one author.
    assert.equal(first, second);
  });

  it('keeps the stored figure when an older reading arrives carrying none', async () => {
    await store.noteReading('claude', week(40));
    // Unstamped, so it ranks oldest and loses — which is what a record written by
    // a build that stamped nothing is worth. A *newer* reading with no figure is
    // a source saying it has none, and takes the record.
    await store.noteReading('claude', { windows: [{ id: 'weekly', short: 'wk' }] });
    assert.equal((await stored())?.windows[0]?.pct, 40);
  });

  it('lets a figure fall inside a window, for every brand', async () => {
    const reset = soon();
    await store.noteReading('grok', week(40, reset, Date.now() - SECOND));
    await store.noteReading('grok', week(10, reset));
    // Grok: credits topped up inside the period. Claude: `seven_day` re-based
    // server-side, 27% → 1% on one `resets_at` (2026-09-02). Neither is a brand
    // fact any more — the later reading is the true one, and that is the rule.
    assert.equal((await store.readStoredUsage('grok'))?.windows[0]?.pct, 10);

    await store.noteReading('claude', week(40, reset, Date.now() - SECOND));
    await store.noteReading('claude', week(10, reset));
    assert.equal((await stored())?.windows[0]?.pct, 10);
  });

  it('leaves an older reading behind the one already held', async () => {
    const reset = soon();
    await store.noteReading('claude', week(40, reset));
    await store.noteReading('claude', week(10, reset, Date.now() - 60 * SECOND));
    assert.equal(
      (await stored())?.windows[0]?.pct,
      40,
      'a minute-old reading overwrote a live one'
    );
  });

  it('leaves memory and file alone when a source answers nothing', async () => {
    await store.noteReading('claude', week(40));
    await store.noteReading('claude', undefined);
    assert.equal((await stored())?.windows[0]?.pct, 40);
    assert.equal((await store.usageFor('claude', port()))?.windows[0]?.pct, 40);
  });

  /**
   * The stamp on disk is what the *next* process ranks this reading by, so it
   * may not trail the one in memory for ever: a window opening on an hour-old
   * record ranks it an hour old, and a reading taken since would outrank a figure
   * this window confirmed a minute before the reload.
   */
  it('persists a fresh observation even when the percentage is unchanged', async () => {
    const now = Date.now();
    const reset = soon();
    await store.noteReading('claude', week(20, reset, now - 30_000));
    await store.noteReading('claude', week(20, reset, now));
    store.invalidate();
    assert.equal((await store.readStoredUsage('claude'))?.at, now);
    assert.equal((await store.usageFor('claude', port()))?.windows[0]?.pct, 20);
  });

  it('leaves memory where disk is when a write cannot land, and retries', async () => {
    // `.squadron` as a file, so every write under it fails. `writeAtomicJson`
    // reports that by returning false rather than by throwing, which is why
    // memory may not move on its own say-so.
    const stubborn = path.join(home, 'stubborn');
    await fs.mkdir(stubborn, { recursive: true });
    await fs.writeFile(path.join(stubborn, '.squadron'), 'not a directory');
    await assert.rejects(store.noteReading('claude', week(40), { home: stubborn }));
    assert.equal(await store.usageFor('claude', port(), { home: stubborn }), undefined);

    await fs.rm(path.join(stubborn, '.squadron'));
    await store.noteReading('claude', week(40), { home: stubborn });
    // Memory that advanced on a failed write would compare equal here and never
    // write again — the figure would be gone from the file for good.
    assert.equal(win(await store.readStoredUsage('claude', stubborn), 'weekly')?.pct, 40);
    await store.forgetUsageFor('claude', stubborn);
  });

  it('forgets memory and file together, and only when told', async () => {
    await store.noteReading('claude', week(40));
    await store.forgetUsageFor('claude');
    assert.equal(await stored(), undefined);
    assert.equal(await store.usageFor('claude', port()), undefined);
  });
});

/**
 * The walk the host runs once per pass. `host/panel_auth.ts` adds the registry
 * and the auth status and nothing else, so everything a poll decides about
 * usage is decided here — which is the point of it being here.
 */
describe('one pass of the walk', () => {
  const port = (
    read: () => Promise<RateLimits | undefined>,
    over: { everyMs?: number } = {}
  ): import('../../core/adapter').UsageSource => ({
    windows: [
      { id: 'session', short: '5h' },
      { id: 'weekly', short: 'wk' }
    ],
    read,
    everyMs: over.everyMs ?? 60_000,

    noResetMs: 5 * 60 * 60 * 1000
  });

  const reading = (pct: number, resetsAt = soon()): RateLimits => ({
    windows: [{ id: 'session', short: '5h', pct, resetsAt }]
  });

  beforeEach(async () => {
    await store.forgetUsageFor('claude');
    store.invalidate();
  });

  it('writes nothing for a brand nobody is signed in to', async () => {
    let reads = 0;
    const source = port(() => {
      reads += 1;
      return Promise.resolve(reading(50));
    });
    // Signing out does not stop the sessions: `claude /logout` leaves them
    // running and answering on their pipes, so a walk that folded them in would
    // put the old account's figure straight back on disk, one poll after the
    // forget cleared it.
    await store.walkUsage(
      { brand: 'claude', source, signedIn: false },
      {
        sessions: [reporting(31)],

        now: Date.now()
      }
    );
    assert.equal(await store.readStoredUsage('claude'), undefined);
    assert.equal(reads, 0);
  });

  /**
   * The interval is the whole pacing. A turn ending used to spend a read of its
   * own here; it is answered on the pipe now (`claude/session.ts`), which is
   * where an owned session's figure comes from, and a second read was never
   * what a turn ending was worth.
   */
  it('spends one read per interval, whatever the sessions are doing', async () => {
    let reads = 0;
    const source = port(
      () => {
        reads += 1;
        return Promise.resolve(reading(50));
      },
      { everyMs: 60 * 60 * 1000 }
    );
    const walk = (sessions: Session[], now = Date.now()) =>
      store.walkUsage(
        { brand: 'claude', source, signedIn: true },
        {
          sessions,

          now
        }
      );

    await walk([{ pid: 7, status: 'busy' } as Session]);
    assert.equal(reads, 1, 'the first ask is always due');
    await walk([{ pid: 7, status: 'idle' } as Session]);
    assert.equal(reads, 1, 'the turn ended, and the hour is not up');

    await walk([], Date.now() + 60 * 60_000 + 1000);
    assert.equal(reads, 2);
  });

  /**
   * A session sitting on a permission prompt has not finished its turn. Read off
   * `busy` alone, `waiting` looked like an end: the read went on the prompt and
   * the baseline was cleared, so the end that followed found nothing to compare
   * against and passed unnoticed.
   */
  it('does not spend reads on permission prompts or turn completion', async () => {
    let reads = 0;
    const source = port(
      () => {
        reads += 1;
        return Promise.resolve(reading(50));
      },
      { everyMs: 60 * 60 * 1000 }
    );
    const walk = (status: Session['status']) =>
      store.walkUsage(
        { brand: 'claude', source, signedIn: true },
        {
          sessions: [{ pid: 7, status } as Session],

          now: Date.now()
        }
      );

    await walk('busy');
    assert.equal(reads, 1, 'the first ask is always due');

    await walk('waiting');
    assert.equal(reads, 1, 'a prompt is not the end of a turn');
    await walk('idle');
    assert.equal(reads, 1, 'turn completion does not bypass the hourly deadline');
  });

  it('stamps a reading its source did not date', async () => {
    const source = port(() => Promise.resolve(reading(50)));
    const now = Date.now() - 30 * SECOND;
    await store.walkUsage(
      { brand: 'claude', source, signedIn: true },
      {
        sessions: [],

        now
      }
    );
    // The pass's clock, so a source that answers with a bare figure is ranked
    // like every other reading rather than losing to all of them.
    assert.equal((await store.readStoredUsage('claude'))?.at, now);
  });

  it('keeps what a throwing brand held, and still walks the next brand', async () => {
    const boom = port(() => Promise.reject(new Error('no socket')));
    const fine = port(() => Promise.resolve(reading(12)));
    await store.noteReading('claude', reading(40));
    const now = Date.now();
    await store.walkUsage({ brand: 'claude', source: boom, signedIn: true }, { sessions: [], now });
    await store.walkUsage({ brand: 'grok', source: fine, signedIn: true }, { sessions: [], now });
    assert.equal(win(await store.readStoredUsage('claude'), 'session')?.pct, 40);
    assert.equal(win(await store.readStoredUsage('grok'), 'session')?.pct, 12);
    await store.forgetUsageFor('grok');
  });
});

/**
 * Only a figure is an observation of the account's quota. A window without one
 * is a declaration — Grok's answer just after a rollover, a `pct: null` "no
 * such window" row — and it may retire a figure, but it says nothing about how
 * fresh the account's quota is (PRD_planned_live_account_usage.md).
 */
describe('what counts as an observation', () => {
  const coordination = async () => await import('../../core/coordination/usage');
  const weekly = (at: number, resetsAt: number, pct?: number): RateLimits => ({
    at,
    windows: [
      { id: 'session', short: '5h', pct: null },
      pct === undefined
        ? { id: 'weekly', short: 'wk', resetsAt }
        : { id: 'weekly', short: 'wk', pct, resetsAt }
    ]
  });

  beforeEach(() => {
    store.invalidate();
  });

  it('leaves the stamp and the fallback where they were for a figureless answer', async () => {
    const now = Date.now();
    const reset = soon();
    await store.noteReading('claude', weekly(now - 30_000, reset, 32), { refreshMs: 60_000 });
    const before = (await (await coordination()).readState('claude'))?.notBefore;
    await store.noteReading('claude', weekly(now, reset), { refreshMs: 60_000 });
    store.invalidate();
    assert.equal((await store.readStoredUsage('claude'))?.at, now - 30_000);
    assert.equal(win(await store.readStoredUsage('claude'), 'weekly')?.pct, 32);
    assert.equal((await (await coordination()).readState('claude'))?.notBefore, before);
  });

  it('retires a figure on a later period without restamping the account', async () => {
    const now = Date.now();
    const reset = soon();
    await store.noteReading('claude', weekly(now - 30_000, reset, 32), { refreshMs: 60_000 });
    const before = (await (await coordination()).readState('claude'))?.notBefore;
    await store.noteReading('claude', weekly(now, reset + 7 * 24 * 3600), { refreshMs: 60_000 });
    store.invalidate();
    const held = await store.readStoredUsage('claude');
    assert.equal(win(held, 'weekly')?.pct, undefined, 'last period’s figure was carried');
    assert.equal(held?.at, now - 30_000);
    assert.equal((await (await coordination()).readState('claude'))?.notBefore, before);
  });

  it('advances both for an unchanged figure read again', async () => {
    const now = Date.now();
    const reset = soon();
    await store.noteReading('claude', weekly(now - 30_000, reset, 32), { refreshMs: 60_000 });
    await store.noteReading('claude', weekly(now, reset, 32), { refreshMs: 60_000 });
    store.invalidate();
    assert.equal((await store.readStoredUsage('claude'))?.at, now);
    assert.equal((await (await coordination()).readState('claude'))?.notBefore, now + 60_000);
  });
});
