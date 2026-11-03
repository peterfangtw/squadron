/**
 * The Windows backend's one admission (`win32_children.ts`): one child at a
 * time across one-shot and leased readers, its waiting bounded before it
 * begins. Children are plain objects and every ending settles when the test
 * says: nothing here waits on a clock.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as win32Children from '../../core/platform/processes/win32_children';
import type { Slot } from '../../core/platform/processes/win32_children';
import * as oneShot from '../../core/platform/processes/win32_reader';

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

/** An admission's state without waiting on it. */
function watch(admission: Promise<Slot | string>) {
  const seen: { value?: Slot | string } = {};
  void admission.then((value) => (seen.value = value));
  return seen;
}

/** What an admission said, as text. */
const said = (value: Slot | string | undefined): string =>
  typeof value === 'string' ? value : value ? 'a slot' : 'nothing yet';

const slotOf = (value: Slot | string | undefined): Slot => {
  assert.ok(value && typeof value !== 'string', `a slot, not ${said(value)}`);
  return value;
};

/** A guard, not a margin: an unbounded admission would otherwise hang the file. */
const GUARD = { timeout: 10_000 };

describe('the backend admission', () => {
  it(
    'admits one of two simultaneous starts, and the other once the first closes',
    GUARD,
    async () => {
      const children = win32Children.children();
      const first = watch(children.admit());
      const second = watch(children.admit());
      await flush();
      const held = slotOf(first.value);
      assert.equal(second.value, undefined, 'the second waits');
      const tracked = held.started({ pid: 9100 });
      await flush();
      assert.equal(second.value, undefined, 'a running child holds the slot');
      tracked.closed();
      await flush();
      slotOf(second.value).release();
    }
  );

  it('frees a reservation whose spawn failed', async () => {
    const children = win32Children.children();
    slotOf(await children.admit()).release();
    slotOf(await children.admit()).release();
  });

  it(
    'holds starts while a child ends, refuses them once its termination failed, and admits after a late close',
    GUARD,
    async () => {
      const children = win32Children.children();
      const tracked = slotOf(await children.admit()).started({ pid: 9100 });
      const settled = deferred<boolean>();
      tracked.ending(settled.promise);
      const waiting = watch(children.admit());
      await flush();
      assert.equal(waiting.value, undefined, 'held while it ends');
      settled.resolve(false);
      await flush();
      assert.match(said(waiting.value), /9100 did not close/);
      assert.deepEqual(children.unresolved(), [9100]);
      assert.match(said(await children.admit()), /9100 did not close/);
      tracked.closed();
      assert.deepEqual(children.unresolved(), []);
      slotOf(await children.admit()).release();
    }
  );

  it('leaves a pending admission when its reader is disposed, taking nothing', GUARD, async () => {
    const children = win32Children.children();
    const tracked = slotOf(await children.admit()).started({ pid: 9100 });
    const leaving = new AbortController();
    const pending = watch(children.admit(leaving.signal));
    await flush();
    leaving.abort();
    await flush();
    assert.equal(pending.value, 'process reader disposed');
    tracked.closed();
    slotOf(await children.admit()).release();
  });

  it(
    'refuses as busy past its bound before waiting, while another child is ending',
    GUARD,
    async () => {
      const children = win32Children.children();
      const tracked = slotOf(await children.admit()).started({ pid: 9100 });
      const settled = deferred<boolean>();
      tracked.ending(settled.promise);
      const waiting = Array.from({ length: win32Children.MAX_WAITING }, () =>
        watch(children.admit())
      );
      const over = await children.admit();
      assert.equal(over, 'process reader busy');
      await flush();
      assert.ok(waiting.every((one) => one.value === undefined));
      settled.resolve(true);
      await flush();
      const admitted = waiting.filter((one) => one.value !== undefined);
      assert.equal(admitted.length, 1, 'one slot, one admission');
      slotOf(admitted[0]?.value).release();
    }
  );
});

describe('one-shot reads through the backend admission', () => {
  it('bounds a burst while another reader is ending, and starts no run for it', GUARD, async () => {
    const children = win32Children.children();
    const tracked = slotOf(await children.admit()).started({ pid: 9100 });
    const settled = deferred<boolean>();
    tracked.ending(settled.promise);
    let runs = 0;
    const reader = oneShot.reader(
      {
        windowsDirectory: 'D:\\Windows',
        run: (_file, _args, options) => {
          runs += 1;
          options.slot?.started({ pid: 9200 + runs }).closed();
          return Promise.resolve({ stdout: '', stderr: '', code: 1 });
        }
      },
      children
    );
    const burst = Array.from({ length: win32Children.MAX_WAITING + 4 }, () => reader.read());
    await flush();
    assert.equal(runs, 0, 'no run while the other child ends');
    settled.resolve(true);
    const results = await Promise.all(burst);
    const busy = results.filter(
      (one) => one.status === 'failed' && one.reason === 'process reader busy'
    );
    assert.equal(busy.length, 4, 'refused before waiting');
    assert.equal(runs, win32Children.MAX_WAITING, 'the rest ran one at a time');
  });
});
