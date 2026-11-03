import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import type { Budget } from '../../core/platform/files';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';

type Awake = typeof import('../../core/awake');
type Paths = typeof import('../../core/paths');

let awake: Awake;
let paths: Paths;

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves its directories
  // once, at load.
  await tempHome();
  paths = await import('../../core/paths');
  awake = await import('../../core/awake');
});

const NOW = 1_800_000_000_000;

const record = (over: Partial<import('../../core/awake').HoldRecord> = {}) => ({
  windowId: 'w1',
  until: NOW + 600_000,
  sessions: [100],
  reason: 'drinking' as const,
  writtenAt: NOW,
  ...over
});

/**
 * The hold store, which `awake.test.ts` cannot reach because it touches disk.
 *
 * This is the whole of the change that let the cup say *why* it is empty: a
 * released hold rewrites its record with the lease in the past rather than
 * deleting it, and the sweep is on `writtenAt` rather than on `until`. A
 * regression to sweeping on the lease deletes exactly the records that carry
 * `battery` and `stale`, and every one of those explanations silently becomes
 * "nothing is working" — with no other test in the suite going red.
 */
describe('the hold store', () => {
  it('publishes beat budgets without adding Windows lock waits', async (context) => {
    let attempts = 0;
    let waits = 0;
    const backend = win32.files({
      stat: () => Promise.reject(new Error('target metadata unavailable')),
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: () => {
        attempts++;
        return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }));
      },
      sleep: () => {
        waits++;
        return Promise.resolve();
      }
    });
    const replace = context.mock.method(
      platform.files,
      'replace',
      async (source: string, destination: string, budget: Budget) => {
        assert.deepEqual(budget, { kind: 'beat' });
        await backend.replace(source, destination, budget);
      }
    );
    await awake.writeHold(record());
    assert.equal(attempts, 1);
    assert.equal(replace.mock.callCount(), 1);
    assert.equal(waits, 0);
  });

  it('round-trips a record', async () => {
    await awake.writeHold(record({ windowId: 'round-trip' }));
    const held = await awake.readHolds(NOW);
    const mine = held.find((h) => h.windowId === 'round-trip');
    assert.ok(mine, 'the record just written was not read back');
    assert.equal(mine.until, NOW + 600_000);
    assert.deepEqual(mine.sessions, [100]);
    await awake.clearHold('round-trip');
  });

  it('keeps a released record so the cup can say why it is empty', async () => {
    // `until` in the past is exactly what a released hold writes.
    await awake.writeHold(
      record({ windowId: 'released', until: 0, sessions: [], reason: 'battery' })
    );
    const held = await awake.readHolds(NOW);
    const mine = held.find((h) => h.windowId === 'released');
    assert.ok(mine, 'a released record was swept, so its reason is unreachable');
    assert.equal(mine.reason, 'battery');
    await awake.clearHold('released');
  });

  it('sweeps a record whose writer has gone quiet, and removes the file', async () => {
    const stale = record({ windowId: 'stale', writtenAt: NOW - awake.HOLD_STALE_MS - 1 });
    await awake.writeHold(stale);
    const held = await awake.readHolds(NOW);
    assert.equal(
      held.find((h) => h.windowId === 'stale'),
      undefined
    );
    const left = await fs.readdir(paths.AWAKE_DIR);
    assert.equal(
      left.includes('stale.json'),
      false,
      'a stale record was skipped but left on disk, so it is re-read every poll forever'
    );
  });

  it('keeps a record written exactly at the horizon', async () => {
    await awake.writeHold(record({ windowId: 'edge', writtenAt: NOW - awake.HOLD_STALE_MS }));
    const held = await awake.readHolds(NOW);
    assert.ok(held.find((h) => h.windowId === 'edge'));
    await awake.clearHold('edge');
  });

  it('clears only its own window', async () => {
    await awake.writeHold(record({ windowId: 'mine' }));
    await awake.writeHold(record({ windowId: 'theirs' }));
    await awake.clearHold('mine');
    const held = await awake.readHolds(NOW);
    assert.equal(
      held.find((h) => h.windowId === 'mine'),
      undefined
    );
    assert.ok(held.find((h) => h.windowId === 'theirs'));
    await awake.clearHold('theirs');
  });

  it('is untroubled by clearing a hold that was never written', async () => {
    await awake.clearHold('never-existed');
  });

  it('answers nothing at all when no window has ever held', async () => {
    for (const name of await fs.readdir(paths.AWAKE_DIR).catch(() => [])) {
      await fs.rm(path.join(paths.AWAKE_DIR, name), { force: true });
    }
    assert.deepEqual(await awake.readHolds(NOW), []);
  });

  describe('narrowing, since another process wrote these', () => {
    const badly = async (name: string, value: unknown) => {
      await fs.mkdir(paths.AWAKE_DIR, { recursive: true });
      await writeJson(path.join(paths.AWAKE_DIR, `${name}.json`), value);
    };

    it('rejects a record with no finite writtenAt, and removes it', async () => {
      // The trap `claims.ts` documents: cast rather than checked, `NOW -
      // undefined` is NaN, every comparison against NaN is false, so the file
      // is neither used nor swept and lives forever.
      await badly('nostamp', { windowId: 'nostamp', until: NOW + 1, sessions: [], reason: 'idle' });
      const held = await awake.readHolds(NOW);
      assert.equal(
        held.find((h) => h.windowId === 'nostamp'),
        undefined
      );
      const left = await fs.readdir(paths.AWAKE_DIR);
      assert.equal(left.includes('nostamp.json'), false, 'the immortal-file trap is back');
    });

    it('rejects records missing any other field it is read by', async () => {
      await badly('nountil', { windowId: 'nountil', sessions: [], reason: 'idle', writtenAt: NOW });
      await badly('nosessions', {
        windowId: 'nosessions',
        until: NOW + 1,
        reason: 'idle',
        writtenAt: NOW
      });
      await badly('notarecord', 'a string where an object should be');
      const held = await awake.readHolds(NOW);
      assert.deepEqual(
        held.map((h) => h.windowId),
        []
      );
    });
  });
});
