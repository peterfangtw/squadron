/**
 * The host's shutdown order and bounds (`host/extension.ts` `deactivate`):
 * readers of process evidence settle (or the budget passes) before the process
 * reader is released, nothing waits past its budget, and every failure is
 * reported together by name. Timers are injected: nothing here waits on a clock.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLOSE_ALL_MS,
  SHUTDOWN_BUDGET,
  drain,
  settleThenRelease,
  startAfter,
  within,
  type Budget,
  type Participant,
  type Timers
} from '../../core/shutdown';

const BUDGET: Budget = { notesMs: 50, settleMs: 1_000, releaseMs: 300 };

/** Timers that fire only when the test says, and say which are still set. */
function manual(): Timers & { fire(ms: number): void; live(): number[] } {
  let next = 0;
  const set = new Map<number, { run: () => void; ms: number }>();
  return {
    set(run, ms) {
      next += 1;
      set.set(next, { run, ms });
      return next;
    },
    clear(handle) {
      set.delete(handle as number);
    },
    fire(ms) {
      for (const [id, timer] of [...set])
        if (timer.ms === ms) {
          set.delete(id);
          timer.run();
        }
    },
    live: () => [...set.values()].map((timer) => timer.ms)
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const never = new Promise<never>(() => {});

const messages = (error: unknown) =>
  error instanceof AggregateError ? error.errors.map((one) => String(one)) : [String(error)];

/** A guard, not a margin: an unbounded shutdown would otherwise hang the file. */
const GUARD = { timeout: 10_000 };

describe('settleThenRelease', () => {
  it('releases only after every reader settled, even when another rejected early', async () => {
    const timers = manual();
    const order: string[] = [];
    const owned = deferred();
    const done = settleThenRelease(
      [
        {
          name: 'usage refresh',
          done: Promise.reject(new Error('usage ingest failed')),
          reader: true
        },
        { name: 'owned sessions', done: owned.promise, reader: true }
      ],
      () => {
        order.push('reader released');
        return Promise.resolve({ unresolved: [] });
      },
      BUDGET,
      timers
    );
    await flush();
    assert.equal(order.length, 0, 'not released while owned shutdown reads');
    order.push('owned shutdown completed');
    owned.resolve();
    await assert.rejects(done, (error: unknown) =>
      /usage ingest failed/.test(messages(error)[0] ?? '')
    );
    assert.deepEqual(order, ['owned shutdown completed', 'reader released']);
    assert.deepEqual(timers.live(), [], 'every timer cleared');
  });

  it('reports a reader child that did not close', async () => {
    const timers = manual();
    await assert.rejects(
      settleThenRelease(
        [{ name: 'owned sessions', done: Promise.resolve(), reader: true }],
        () => Promise.resolve({ unresolved: [4242] }),
        BUDGET,
        timers
      ),
      (error: unknown) => /4242/.test(messages(error)[0] ?? '')
    );
    assert.deepEqual(timers.live(), []);
  });

  it('resolves when every participant and the release succeeded', async () => {
    const timers = manual();
    await settleThenRelease(
      [{ name: 'owned sessions', done: Promise.resolve(1), reader: true }],
      () => Promise.resolve({ unresolved: [] }),
      BUDGET,
      timers
    );
    await settleThenRelease([], () => Promise.resolve(undefined), BUDGET, timers);
    assert.deepEqual(timers.live(), []);
  });

  it(
    'releases at the budget past a hung reader, and names it with every other failure',
    GUARD,
    async () => {
      const timers = manual();
      let released = false;
      const participants: Participant[] = [
        { name: 'Remote teardown', done: never, reader: true },
        { name: 'server records', done: Promise.reject(new Error('server record kept')) },
        { name: 'owned sessions', done: Promise.resolve(), reader: true }
      ];
      const done = settleThenRelease(
        participants,
        () => {
          released = true;
          return Promise.reject(new Error('lease threw'));
        },
        BUDGET,
        timers
      );
      await flush();
      assert.equal(released, false, 'held while a reader is unsettled and the budget remains');
      timers.fire(BUDGET.settleMs);
      await assert.rejects(done, (error: unknown) => {
        assert.deepEqual(messages(error), [
          `Error: Remote teardown did not settle within ${BUDGET.settleMs} ms`,
          'Error: server record kept',
          'Error: lease threw'
        ]);
        return true;
      });
      assert.equal(released, true);
      assert.deepEqual(timers.live(), []);
    }
  );

  it(
    'bounds a release that never finishes, and a participant that is not a reader',
    GUARD,
    async () => {
      const timers = manual();
      const done = settleThenRelease(
        [
          { name: 'held report note', done: never },
          { name: 'owned sessions', done: Promise.resolve(), reader: true }
        ],
        () => never,
        BUDGET,
        timers
      );
      await flush();
      timers.fire(BUDGET.releaseMs);
      await flush();
      timers.fire(BUDGET.settleMs);
      await assert.rejects(done, (error: unknown) => {
        assert.deepEqual(messages(error), [
          `Error: held report note did not settle within ${BUDGET.settleMs} ms`,
          `Error: process reader release did not finish within ${BUDGET.releaseMs} ms`
        ]);
        return true;
      });
      assert.deepEqual(timers.live(), []);
    }
  );
});

describe('the host shape: owned shutdown and its lifetime cleanups', () => {
  /**
   * `deactivate` as wired: `closeAll` starts after the note, hands its
   * lifetime cleanups to the drain, and returns at its own 1.5 s bound.
   */
  function host(
    timers: ReturnType<typeof manual>,
    consumers: { name: string; done: Promise<unknown> }[]
  ) {
    const cleanup = drain('owned session cleanup');
    let released = false;
    const closing = startAfter(
      Promise.resolve(),
      SHUTDOWN_BUDGET.notesMs,
      async () => {
        cleanup.start(consumers);
        await within(Promise.allSettled(consumers.map((one) => one.done)), CLOSE_ALL_MS, timers);
      },
      timers
    );
    const done = settleThenRelease(
      [
        { name: 'owned sessions', done: closing },
        cleanup.participant,
        { name: 'usage refresh', done: Promise.resolve(), reader: true }
      ],
      () => {
        released = true;
        return Promise.resolve({ unresolved: [] });
      },
      SHUTDOWN_BUDGET,
      timers
    );
    return { done, released: () => released };
  }

  it(
    'keeps the reader past the closeAll bound until a pending cleanup scan finishes',
    GUARD,
    async () => {
      const timers = manual();
      const scan = deferred();
      const shape = host(timers, [{ name: 'session 7101 cleanup', done: scan.promise }]);
      await flush();
      timers.fire(CLOSE_ALL_MS);
      await flush();
      assert.equal(shape.released(), false, 'not released at 1500 ms while the scan reads');
      scan.resolve();
      await shape.done;
      assert.equal(shape.released(), true);
      assert.deepEqual(timers.live(), []);
    }
  );

  it('waits for the other cleanups when one fails, and reports the failure', GUARD, async () => {
    const timers = manual();
    const other = deferred();
    const shape = host(timers, [
      { name: 'session 7101 cleanup', done: Promise.reject(new Error('7101 scan failed')) },
      { name: 'session 7102 cleanup', done: other.promise }
    ]);
    await flush();
    timers.fire(CLOSE_ALL_MS);
    await flush();
    assert.equal(shape.released(), false, 'the failure does not end the drain');
    other.resolve();
    await assert.rejects(shape.done, (error: unknown) => {
      assert.match(messages(error).join(' '), /owned session cleanup failed/);
      const inner = (error as AggregateError).errors[0] as AggregateError;
      assert.deepEqual(inner.errors.map(String), ['Error: 7101 scan failed']);
      return true;
    });
    assert.equal(shape.released(), true);
    assert.deepEqual(timers.live(), []);
  });

  it('releases at the settlement budget and names the cleanups still reading', GUARD, async () => {
    const timers = manual();
    const shape = host(timers, [
      { name: 'session 7101 cleanup', done: Promise.resolve() },
      { name: 'session 7102 cleanup', done: never }
    ]);
    await flush();
    timers.fire(CLOSE_ALL_MS);
    await flush();
    assert.equal(shape.released(), false);
    timers.fire(SHUTDOWN_BUDGET.settleMs);
    await assert.rejects(shape.done, (error: unknown) => {
      assert.deepEqual(messages(error), [
        `Error: owned session cleanup did not settle within ${SHUTDOWN_BUDGET.settleMs} ms: session 7102 cleanup`
      ]);
      return true;
    });
    assert.equal(shape.released(), true);
    assert.deepEqual(timers.live(), []);
  });
});

describe('startAfter', () => {
  it('starts owned shutdown once the report read settles, and clears its timer', async () => {
    const timers = manual();
    const notes = deferred();
    let started = false;
    const next = startAfter(
      notes.promise,
      BUDGET.notesMs,
      () => {
        started = true;
        return Promise.resolve();
      },
      timers
    );
    await flush();
    assert.equal(started, false);
    notes.reject(new Error('reports unreadable'));
    await next;
    assert.equal(started, true);
    assert.deepEqual(timers.live(), []);
  });

  it('starts owned shutdown at its budget when the report read stalls', GUARD, async () => {
    const timers = manual();
    let started = false;
    const next = startAfter(
      never,
      BUDGET.notesMs,
      () => {
        started = true;
        return Promise.resolve();
      },
      timers
    );
    await flush();
    assert.equal(started, false);
    timers.fire(BUDGET.notesMs);
    await next;
    assert.equal(started, true);
    assert.deepEqual(timers.live(), []);
  });
});
