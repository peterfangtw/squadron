import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as reconcile from '../../core/reconcile';

describe('Reconciler registration', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  });
  afterEach(() => mock.timers.reset());

  it('registers without starting work', () => {
    let calls = 0;
    const runtime = new reconcile.Reconciler();
    runtime.register('wait pass', 15_000, () => {
      calls++;

      return Promise.resolve();
    });
    mock.timers.tick(3_600_000);
    assert.equal(calls, 0);
  });

  for (const delay of [1_000, 15_000]) {
    it(`checks ${delay} ms after the first event despite continuing events`, () => {
      let calls = 0;
      const runtime = new reconcile.Reconciler();
      const registration = runtime.register('check', delay, () => {
        calls++;

        return Promise.resolve();
      });
      registration.noticeChange();
      mock.timers.tick(delay / 2);
      registration.noticeChange();
      mock.timers.tick(delay / 2 - 1);
      assert.equal(calls, 0);
      mock.timers.tick(1);
      assert.equal(calls, 1);
      mock.timers.tick(3_600_000);
      assert.equal(calls, 1);
    });
  }

  it('enters an idle targeted check before requestCheck returns', () => {
    const calls: string[] = [];
    const runtime = new reconcile.Reconciler();
    const wait = runtime.register('wait pass', 15_000, () => {
      calls.push('wait');

      return Promise.resolve();
    });
    const cafe = runtime.register('keep-awake check', 1_000, () => {
      calls.push('cafe');

      return Promise.resolve();
    });
    cafe.requestCheck();
    assert.deepEqual(calls, ['cafe']);
    wait.requestCheck();
    assert.deepEqual(calls, ['cafe', 'wait']);
  });

  it('disposes a registration idempotently without affecting another', () => {
    const calls: string[] = [];
    const runtime = new reconcile.Reconciler();
    const wait = runtime.register('wait pass', 15_000, () => {
      calls.push('wait');

      return Promise.resolve();
    });
    const cafe = runtime.register('keep-awake check', 1_000, () => {
      calls.push('cafe');

      return Promise.resolve();
    });
    wait.noticeChange();
    cafe.noticeChange();
    wait.dispose();
    wait.dispose();
    wait.noticeChange();
    wait.requestCheck();
    mock.timers.tick(3_600_000);
    assert.deepEqual(calls, ['cafe']);
  });

  it('disposes the runtime and makes late registrations inert', () => {
    let calls = 0;
    const runtime = new reconcile.Reconciler();
    const first = runtime.register('first', 200, () => {
      calls++;

      return Promise.resolve();
    });
    first.noticeChange();
    runtime.dispose();
    runtime.dispose();
    first.noticeChange();
    first.requestCheck();
    const late = runtime.register('late', 200, () => {
      calls++;

      return Promise.resolve();
    });
    late.noticeChange();
    late.requestCheck();
    mock.timers.tick(3_600_000);
    assert.equal(calls, 0);
  });
});

function held(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  // Drain the callback and scheduler continuations without advancing timers.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

describe('Reconciler deadlines and isolation', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  });
  afterEach(() => mock.timers.reset());

  it('runs other registrations while one check is held', async () => {
    const gate = held();
    const calls: string[] = [];
    const runtime = new reconcile.Reconciler();
    const wait = runtime.register('wait pass', 15_000, async () => {
      calls.push('wait');
      await gate.promise;
    });
    const cafe = runtime.register('keep-awake check', 1_000, () => {
      calls.push('cafe');

      return Promise.resolve();
    });
    wait.requestCheck();
    cafe.noticeChange();
    mock.timers.tick(1_000);
    assert.deepEqual(calls, ['wait', 'cafe']);
    gate.resolve();
    await settle();
  });

  it('coalesces due requests into one serial rerun', async () => {
    const gate = held();
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const registration = new reconcile.Reconciler().register('check', 200, async () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      await gate.promise;
      active--;
    });
    registration.requestCheck();
    registration.requestCheck();
    registration.requestCheck();
    assert.equal(calls, 1);
    gate.resolve();
    await settle();
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
    mock.timers.tick(3_600_000);
    assert.equal(calls, 2);
  });

  it('keeps raw events delayed when a held pass finishes before the nudge', async () => {
    const gate = held();
    let calls = 0;
    const registration = new reconcile.Reconciler().register('check', 200, async () => {
      calls++;
      await gate.promise;
    });
    registration.requestCheck();
    registration.noticeChange();
    mock.timers.tick(100);
    registration.noticeChange();
    gate.resolve();
    await settle();
    assert.equal(calls, 1);
    mock.timers.tick(99);
    assert.equal(calls, 1);
    mock.timers.tick(1);
    assert.equal(calls, 2);
  });

  it('queues one extra pass when both independent timers fire during a held pass', async () => {
    const gate = held();
    let calls = 0;
    const registration = new reconcile.Reconciler().register('check', 200, async () => {
      calls++;
      await gate.promise;
    });
    registration.requestCheck();
    registration.noticeChange();
    registration.schedule(Date.now() + 1_000);
    mock.timers.tick(1_000);
    assert.equal(calls, 1);
    gate.resolve();
    await settle();
    assert.equal(calls, 2);
    mock.timers.tick(3_600_000);
    await settle();
    assert.equal(calls, 2);
  });

  it('runs a deadline before a later nudge without merging their passes', async () => {
    const times: number[] = [];
    const registration = new reconcile.Reconciler().register('check', 15_000, () => {
      times.push(Date.now());

      return Promise.resolve();
    });
    registration.noticeChange();
    registration.schedule(Date.now() + 2_000);
    mock.timers.tick(1_999);
    assert.deepEqual(times, []);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(times, [102_000]);
    mock.timers.tick(13_000);
    await settle();
    assert.deepEqual(times, [102_000, 115_000]);
    mock.timers.tick(3_600_000);
    assert.equal(times.length, 2);
  });

  it('replaces a deadline at call time without removing a nudge', async () => {
    const times: number[] = [];
    const registration = new reconcile.Reconciler().register('check', 200, () => {
      times.push(Date.now());

      return Promise.resolve();
    });
    registration.noticeChange();
    registration.schedule(Date.now() + 1_000);
    registration.schedule(Date.now() + 2_000);
    mock.timers.tick(200);
    await settle();
    mock.timers.tick(800);
    assert.deepEqual(times, [100_200]);
    mock.timers.tick(1_000);
    await settle();
    assert.deepEqual(times, [100_200, 102_000]);
    mock.timers.tick(3_600_000);
    assert.equal(times.length, 2);
  });

  it('cancels only the deadline and leaves the nudge armed', async () => {
    let calls = 0;
    const registration = new reconcile.Reconciler().register('check', 200, () => {
      calls++;

      return Promise.resolve();
    });
    registration.schedule(Date.now() + 1_000);
    registration.noticeChange();
    registration.schedule(undefined);
    mock.timers.tick(200);
    await settle();
    assert.equal(calls, 1);
    mock.timers.tick(3_600_000);
    assert.equal(calls, 1);
  });

  for (const offset of [-10_000, 0, 500, 1_000]) {
    it(`applies a one-second deadline floor for offset ${offset}`, async () => {
      let calls = 0;
      const registration = new reconcile.Reconciler().register('check', 200, () => {
        calls++;

        return Promise.resolve();
      });
      registration.schedule(Date.now() + offset);
      mock.timers.tick(999);
      assert.equal(calls, 0);
      mock.timers.tick(1);
      assert.equal(calls, 1);
      await settle();
      mock.timers.tick(3_600_000);
      assert.equal(calls, 1);
    });
  }

  it('requires explicit rearming and limits a past deadline to once per second', async () => {
    const times: number[] = [];
    const registration = new reconcile.Reconciler().register('check', 200, () => {
      times.push(Date.now());
      registration.schedule(0);

      return Promise.resolve();
    });
    registration.schedule(0);
    for (let i = 1; i <= 3; i++) {
      mock.timers.tick(999);
      assert.equal(times.length, i - 1);
      mock.timers.tick(1);
      await settle();
      assert.equal(times.length, i);
    }
    assert.deepEqual(times, [101_000, 102_000, 103_000]);
    registration.schedule(undefined);
    mock.timers.tick(3_600_000);
    assert.equal(times.length, 3);
  });

  it('preserves schedule B after cancel A during an awaited check', async () => {
    const gate = held();
    let calls = 0;
    const registration = new reconcile.Reconciler().register('check', 200, async () => {
      calls++;
      if (calls === 1) {
        await gate.promise;
        registration.schedule(Date.now() + 2_000);
      }
    });
    registration.schedule(Date.now() + 1_000);
    registration.requestCheck();
    registration.schedule(undefined);
    mock.timers.tick(100);
    gate.resolve();
    await settle();
    mock.timers.tick(1_999);
    assert.equal(calls, 1);
    mock.timers.tick(1);
    assert.equal(calls, 2);
    await settle();
    mock.timers.tick(3_600_000);
    assert.equal(calls, 2);
  });

  for (const owner of ['registration', 'runtime']) {
    it(`suppresses a queued rerun and late scheduling after ${owner} disposal`, async () => {
      const gate = held();
      let calls = 0;
      const runtime = new reconcile.Reconciler();
      const registration = runtime.register('check', 200, async () => {
        calls++;
        await gate.promise;
        registration.schedule(Date.now() + 1_000);
        registration.noticeChange();
        registration.requestCheck();
      });
      registration.requestCheck();
      registration.requestCheck();
      registration.noticeChange();
      registration.schedule(Date.now() + 1_000);
      if (owner === 'runtime') {
        runtime.dispose();
      } else {
        registration.dispose();
      }
      gate.resolve();
      await settle();
      mock.timers.tick(3_600_000);
      await settle();
      assert.equal(calls, 1);
    });
  }

  it('logs a failed pass, drops queued reruns, and accepts a later explicit request', async () => {
    const gate = held();
    const logs: string[] = [];
    let calls = 0;
    const registration = new reconcile.Reconciler((line) => logs.push(line)).register(
      'wait pass',
      15_000,
      async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
        }
      }
    );
    registration.requestCheck();
    registration.requestCheck();
    registration.requestCheck();
    gate.reject(new Error('cannot read'));
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(logs, ['wait pass failed: cannot read']);
    mock.timers.tick(3_600_000);
    assert.equal(calls, 1);
    registration.requestCheck();
    assert.equal(calls, 2);
  });

  for (const timer of ['nudge', 'deadline']) {
    it(`preserves an unfired ${timer} across failure`, async () => {
      const gate = held();
      const logs: string[] = [];
      let calls = 0;
      const registration = new reconcile.Reconciler((line) => logs.push(line)).register(
        'keep-awake check',
        200,
        async () => {
          calls++;
          if (calls === 1) {
            await gate.promise;
          }
        }
      );
      registration.requestCheck();
      registration.requestCheck();
      if (timer === 'nudge') {
        registration.noticeChange();
      } else {
        registration.schedule(Date.now() + 1_000);
      }
      gate.reject('lost power reading');
      await settle();
      assert.equal(calls, 1);
      assert.deepEqual(logs, ['keep-awake check failed: lost power reading']);
      const delay = timer === 'nudge' ? 200 : 1_000;
      mock.timers.tick(delay - 1);
      assert.equal(calls, 1);
      mock.timers.tick(1);
      assert.equal(calls, 2);
      await settle();
      mock.timers.tick(3_600_000);
      assert.equal(calls, 2);
    });
  }

  it('catches a synchronous callback throw and releases its guard', async () => {
    let calls = 0;
    const logs: string[] = [];
    const registration = new reconcile.Reconciler((line) => logs.push(line)).register(
      'check',
      200,
      () => {
        calls++;
        if (calls === 1) {
          throw new Error('immediate failure');
        }
        return Promise.resolve();
      }
    );
    registration.requestCheck();
    await settle();
    assert.deepEqual(logs, ['check failed: immediate failure']);
    registration.requestCheck();
    assert.equal(calls, 2);
  });
});
