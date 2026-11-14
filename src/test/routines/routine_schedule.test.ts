import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { describe, it } from 'node:test';
import * as schedule from '../../core/routines/schedule';
import type * as types from '../../core/routines/types';

function definition(
  cadence: types.Schedule,
  extra: Partial<types.Definition> = {}
): types.Definition {
  return {
    id: 'routine',
    definitionRevision: 1,
    name: 'Review',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    task: {
      doc: { type: 'doc', content: [] },
      delivered: 'Review',
      targetChoice: { kind: 'default' },
      images: {},
      savedFromCwd: '/repo'
    },
    schedule: cadence,
    scheduleEpoch: 'epoch',
    handled: [],
    ...extra
  };
}

describe('routine occurrences', () => {
  it('uses native compatible DST disambiguation for nonexistent and repeated local times', () => {
    const module = require.resolve('../../core/routines/schedule');
    const cases = [
      { time: '02:30', now: '2026-03-08T12:00:00Z', due: '2026-03-08T07:30:00.000Z' },
      { time: '01:30', now: '2026-11-01T12:00:00Z', due: '2026-11-01T05:30:00.000Z' }
    ];
    for (const example of cases) {
      const input = definition({ kind: 'daily', time: example.time });
      const script = `const {occurrence}=require(${JSON.stringify(module)});const result=occurrence(${JSON.stringify(input)},Date.parse(${JSON.stringify(example.now)}));process.stdout.write(new Date(result.dueAt).toISOString());`;
      const result = childProcess.spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: 'America/New_York' },
        encoding: 'utf8',
        timeout: 5000
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, example.due);
    }
  });
  it('handles calendar days early without moving the following due time', () => {
    const routine = definition({ kind: 'daily', time: '09:00' });
    const now = new Date(2026, 10, 14, 10).getTime();
    const first = schedule.occurrence(routine, now);
    assert.equal(first.key, 'epoch/day/2026-11-14');
    assert.equal(first.dueAt, new Date(2026, 10, 14, 9).getTime());
    routine.handled.push({ key: first.key, outcome: 'completed', at: now });
    assert.equal(schedule.occurrence(routine, now).nextDueAt, new Date(2026, 10, 15, 9).getTime());
    const early = schedule.occurrence(routine, new Date(2026, 10, 15, 8).getTime());
    assert.equal(early.key, 'epoch/day/2026-11-15');
    assert.equal(early.handled, undefined);
  });

  it('uses the current Monday for weekly reminders and coalesces missed weeks', () => {
    const routine = definition({ kind: 'weekly', weekday: 1, time: '09:00' });
    const result = schedule.occurrence(routine, new Date(2026, 10, 18, 10).getTime());
    assert.equal(result.key, 'epoch/week/2026-11-16');
    assert.equal(result.dueAt, new Date(2026, 10, 16, 9).getTime());
  });

  it('retains unanchored manual credit and anchors intervals without completion drift', () => {
    const anchorAt = Date.UTC(2026, 10, 14, 10);
    const routine = definition({ kind: 'interval', hours: 4 }, { enabled: false });
    const manual = schedule.occurrence(routine, anchorAt - 2 * 3_600_000);
    assert.equal(manual.key, 'epoch/interval/1');
    assert.equal(manual.nextDueAt, undefined);
    routine.handled.push({ key: manual.key, outcome: 'completed', at: anchorAt - 3_600_000 });
    routine.anchorAt = anchorAt;
    assert.equal(schedule.occurrence(routine, anchorAt).nextDueAt, Date.UTC(2026, 10, 14, 18));
    const late = schedule.occurrence(routine, Date.UTC(2026, 10, 14, 23));
    assert.equal(late.key, 'epoch/interval/3');
    assert.equal(late.dueAt, Date.UTC(2026, 10, 14, 22));
  });
});
