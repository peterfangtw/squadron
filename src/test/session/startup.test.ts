import * as assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { StartupAttempt, StartupStopped, StartupUnknown } from '../../core/startup';
import { SessionLifetime } from '../../core/session_lifetime';

describe('startup attempt ownership', () => {
  it('does not turn an uncertain durable replay into no-start proof', async () => {
    const attempt = new StartupAttempt('durable-replay');
    const result = await attempt.run(() =>
      Promise.reject(new StartupUnknown('Reconcile the original reservation.'))
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.unsure, true);
    assert.equal(result.ok === false && result.notStarted, undefined);
  });

  it('reconciles uncertain cancellation after a promptless handoff', async (t) => {
    const lifetime = new SessionLifetime({ close: () => {} });
    t.mock.method(lifetime, 'close', () => Promise.resolve('unresolved' as const));
    const attempt = new StartupAttempt('cancel-handoff');
    attempt.own(lifetime);
    await attempt.run(() => Promise.resolve({ ok: true, pid: 1, startedAt: 1, brand: 'claude' }));
    const cancelled = await attempt.cancelHandoff();
    assert.equal(cancelled?.ok, false);
    assert.equal(cancelled?.ok === false && cancelled.unsure, true);
    const confirmed = await attempt.reconcile();
    assert.equal(confirmed?.ok === false && confirmed.notStarted, true);
    assert.equal(confirmed?.ok === false && confirmed.unsure, undefined);
  });

  it('returns one terminal outcome to duplicate callers without repeating work', async () => {
    const attempt = new StartupAttempt('one');
    let calls = 0;
    const first = attempt.run(() => {
      calls++;
      return Promise.resolve({
        ok: false as const,
        cause: 'pick' as const,
        reason: 'Unavailable pick.'
      });
    });
    const duplicate = attempt.run(() => {
      calls++;
      return Promise.reject(new Error('must not run'));
    });
    assert.equal(first, duplicate);
    assert.deepEqual(await first, {
      ok: false,
      cause: 'pick',
      reason: 'Unavailable pick.',
      notStarted: true,
      unsure: undefined,
      startupVersion: 1,
      attemptId: 'one'
    });
    assert.equal(calls, 1);
  });
  it('cancels a pending stage and prevents its late continuation from handing off', async () => {
    const attempt = new StartupAttempt('cancelled');
    let release!: () => void;
    const preparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let spawned = false;
    const opening = attempt.wait('prepare', async () => {
      await preparation;
      attempt.check();
      spawned = true;
    });
    await Promise.resolve();
    attempt.stop();
    await assert.rejects(
      opening,
      (error: unknown) => error instanceof StartupStopped && error.cause === 'cancelled'
    );
    release();
    await Promise.resolve();
    assert.equal(spawned, false);
    attempt.finish('cancelled');
  });

  it('settles a silent opening at the host deadline without fabricating a native exit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const attempt = new StartupAttempt('silent', 90_000);
    const opening = attempt.wait('opening', () => new Promise<never>(() => {}));
    t.mock.timers.tick(90_000);
    await assert.rejects(
      opening,
      (error: unknown) => error instanceof StartupStopped && error.cause === 'timeout'
    );
    assert.equal(attempt.stage, 'opening');
    attempt.finish('timeout');
  });

  it('preserves positive prompt admission across the opening deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const attempt = new StartupAttempt('admitted-at-deadline', 10);
    const result = await attempt.run(() => {
      attempt.admitPrompt();
      now = 20;
      return Promise.resolve({ ok: true, pid: 42, startedAt: 1, brand: 'claude' });
    });
    assert.equal(result.ok, true);
    t.mock.timers.tick(20);
    assert.equal(attempt.signal.aborted, false);
  });

  it('keeps the opening deadline while prompt admission is still unconfirmed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const attempt = new StartupAttempt('uncertain-admission', 10);
    const outcome = attempt.run(() => {
      attempt.admitPrompt();
      return new Promise<never>(() => {});
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10);
    const result = await outcome;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.unsure, true);
    assert.equal(result.ok === false && result.notStarted, undefined);
  });

  it('retires its deadline at handoff and settles its outcome once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events: string[] = [];
    const attempt = new StartupAttempt('healthy', 90_000, (line) => events.push(line));
    assert.equal(await attempt.wait('opening', () => Promise.resolve(42)), 42);
    attempt.finish('handed-off');
    attempt.finish('failed');
    t.mock.timers.tick(1_000_000);
    attempt.stop();
    assert.equal(attempt.signal.aborted, false);
    assert.equal(events.filter((line) => line.includes('handed-off')).length, 1);
    assert.equal(
      events.some((line) => line.includes('failed')),
      false
    );
  });
});
