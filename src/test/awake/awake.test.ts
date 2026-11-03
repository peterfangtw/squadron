import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AwakeDeadlines,
  BATTERY_FLOOR_PCT,
  BATTERY_RECHECK_MS,
  HoldRecord,
  LEASE_MS,
  SILENCE_MS,
  cafeView,
  decide,
  latestUntil,
  leaseWanted
} from '../../core/awake';
import type { Session } from '../../core/model';

const NOW = 1_800_000_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 's',
  cwd: '/repo',
  name: 'one',
  status: 'busy',
  hasCommand: false,
  startedAt: NOW - 60_000,
  updatedAt: NOW - 1_000,
  transcript: '/transcript.jsonl',
  ...over
});

const base = {
  power: { pct: 90, onAC: false },
  now: NOW,
  enabled: true,
  holds: true
};

describe('decide', () => {
  it('drinks while a session is busy', () => {
    const verdict = decide({ ...base, sessions: [session()] });
    assert.equal(verdict.drink, true);
    assert.equal(verdict.reason, 'drinking');
    assert.deepEqual(verdict.sessions, [100]);
  });

  it('does not drink where there is no caffeinate to run', () => {
    const verdict = decide({ ...base, holds: false, sessions: [session()] });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'unsupported');
  });

  it('does nothing at all when the setting is off', () => {
    const verdict = decide({ ...base, enabled: false, sessions: [session()] });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'off');
  });

  it('refuses on a nearly flat battery that is discharging', () => {
    const power = { pct: BATTERY_FLOOR_PCT - 1, onAC: false };
    const verdict = decide({ ...base, power, sessions: [session()] });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'battery');
  });

  it('drinks on a nearly flat battery that is charging', () => {
    // The case the floor must not catch: plugged in at 8% is not the laptop
    // about to die in a bag, it is one filling up.
    const power = { pct: BATTERY_FLOOR_PCT - 1, onAC: true };
    const verdict = decide({ ...base, power, sessions: [session()] });
    assert.equal(verdict.drink, true);
  });

  it('drinks exactly at the floor, and refuses below it', () => {
    const at = decide({
      ...base,
      power: { pct: BATTERY_FLOOR_PCT, onAC: false },
      sessions: [session()]
    });
    assert.equal(at.drink, true);
    const under = decide({
      ...base,
      power: { pct: BATTERY_FLOOR_PCT - 1, onAC: false },
      sessions: [session()]
    });
    assert.equal(under.drink, false);
  });

  it('drinks when the battery cannot be read at all', () => {
    // A desktop, or a pmset that failed. No opinion about power must not become
    // "refuse", or the feature dies on every machine without a battery.
    const verdict = decide({ ...base, power: undefined, sessions: [session()] });
    assert.equal(verdict.drink, true);
  });

  it('does not drink when nothing is busy', () => {
    const sessions = [
      session({ pid: 1, status: 'idle' }),
      session({ pid: 2, status: 'waiting' }),
      session({ pid: 3, status: 'unknown' })
    ];
    const verdict = decide({ ...base, sessions });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'idle');
  });

  it('treats waiting as a reason to sleep, not to hold', () => {
    // Blocked on a human at 3am is exactly when sleep is fine.
    const verdict = decide({ ...base, sessions: [session({ status: 'waiting' })] });
    assert.equal(verdict.drink, false);
  });

  it('stops counting a silent session past the bound, with or without an open tool', () => {
    const silent = NOW - SILENCE_MS - 1;
    for (const one of [
      session({ updatedAt: silent }),
      session({ activeTool: 'Bash', updatedAt: silent })
    ]) {
      const verdict = decide({ ...base, sessions: [one] });
      assert.equal(verdict.drink, false);
      assert.equal(verdict.reason, 'stale');
      assert.deepEqual(verdict.sessions, []);
    }
  });

  it('keeps counting a session silent past the old 10 min, with or without an open tool', () => {
    // One bound for both: a session with no tool open is not cut sooner.
    const quiet = NOW - 30 * 60_000;
    for (const one of [
      session({ updatedAt: quiet }),
      session({ activeTool: 'Bash', updatedAt: quiet }),
      session({ status: 'idle', hasCommand: true, updatedAt: quiet })
    ]) {
      const verdict = decide({ ...base, sessions: [one] });
      assert.equal(verdict.drink, true);
      assert.deepEqual(verdict.sessions, [100]);
    }
  });

  it('still drinks when one busy session is silent and another is live', () => {
    // The bound is per session. One wedged session beside one working session
    // is a machine that is still working.
    const sessions = [
      session({ pid: 1, updatedAt: NOW - SILENCE_MS - 1 }),
      session({ pid: 2, updatedAt: NOW - 1_000 })
    ];
    const verdict = decide({ ...base, sessions });
    assert.equal(verdict.drink, true);
    assert.deepEqual(verdict.sessions, [2], 'the silent one should not be counted as working');
  });

  it('keeps drinking for an idle session whose backgrounded command still runs', () => {
    // Observed 2026-10-06 02:23: a child backgrounded the smoke barrel and ended
    // its turn, the parent sat on a wait, and the refill at 02:29:37 found
    // nothing `busy`. The lease timed out at 02:30:37 and idle sleep followed
    // five seconds later, freezing the barrel and the chain behind it.
    const smoking = session({ status: 'idle', hasCommand: true });
    const verdict = decide({ ...base, sessions: [smoking] });
    assert.equal(verdict.drink, true);
    assert.deepEqual(verdict.sessions, [100]);
  });

  it('stops counting a backgrounded command once it has been silent past the bound', () => {
    // A forgotten command must not keep the machine awake forever.
    const forgotten = session({
      status: 'idle',
      hasCommand: true,
      updatedAt: NOW - SILENCE_MS - 1
    });
    const verdict = decide({ ...base, sessions: [forgotten] });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'stale');
  });

  it('does not drink for an empty machine', () => {
    const verdict = decide({ ...base, sessions: [] });
    assert.equal(verdict.drink, false);
    assert.equal(verdict.reason, 'idle');
  });

  it('answers unsupported before off, since the platform is the deeper reason', () => {
    const verdict = decide({ ...base, enabled: false, holds: false, sessions: [session()] });
    assert.equal(verdict.reason, 'unsupported');
  });
});

/**
 * Remote (D4) is one more reason to hold and nothing else: a person away from
 * the desk is waiting on this machine whether or not a session is busy.
 */
describe('decide, with Remote on', () => {
  const remote = { ...base, remote: true };

  it('drinks with nothing busy at all', () => {
    const verdict = decide({ ...remote, sessions: [] });
    assert.equal(verdict.drink, true);
    assert.equal(verdict.reason, 'drinking');
    assert.equal(verdict.remote, true);
    assert.deepEqual(verdict.sessions, []);
  });

  it('still names the sessions that are working', () => {
    const sessions = [session({ pid: 1 }), session({ pid: 2, status: 'idle' })];
    assert.deepEqual(decide({ ...remote, sessions }).sessions, [1]);
  });

  it('does not count a stale session, and drinks anyway', () => {
    // The brake still decides who is working; it no longer decides the verdict.
    const stale = session({ updatedAt: NOW - SILENCE_MS - 1 });
    const verdict = decide({ ...remote, sessions: [stale] });
    assert.equal(verdict.drink, true);
    assert.deepEqual(verdict.sessions, []);
  });

  it('gives way to the setting, the battery and the platform', () => {
    // U11: off is a person saying "never hold this machine", and Remote does
    // not overrule it.
    const cases: [Partial<typeof remote>, string][] = [
      [{ enabled: false }, 'off'],
      [{ power: { pct: BATTERY_FLOOR_PCT - 1, onAC: false } }, 'battery'],
      [{ holds: false }, 'unsupported']
    ];
    for (const [over, reason] of cases) {
      const verdict = decide({ ...remote, ...over, sessions: [session()] });
      assert.equal(verdict.drink, false, reason);
      assert.equal(verdict.reason, reason);
      assert.equal(verdict.remote, undefined, reason);
    }
  });

  it('looks again an interval later when the battery refuses it, and holds once plugged in', () => {
    // No session frame comes while Remote holds for nobody, and nothing tells
    // the keeper the power changed: only a deadline brings the next look.
    const flat = { pct: BATTERY_FLOOR_PCT - 1, onAC: false };
    const refused = decide({ ...remote, power: flat, sessions: [] });
    assert.equal(refused.reason, 'battery');
    assert.equal(refused.recheckAt, NOW + BATTERY_RECHECK_MS);
    const plugged = decide({
      ...remote,
      power: { ...flat, onAC: true },
      now: refused.recheckAt ?? NOW,
      sessions: []
    });
    assert.equal(plugged.drink, true);
    assert.equal(plugged.recheckAt, undefined);
    // Off, a session's own frames bring the next look.
    assert.equal(decide({ ...base, power: flat, sessions: [session()] }).recheckAt, undefined);
  });

  it('changes no verdict while it is off', () => {
    // Scenario 7: a machine that never turned Remote on.
    const boards = [
      [],
      [session()],
      [session({ status: 'idle' })],
      [session({ updatedAt: NOW - SILENCE_MS - 1 })]
    ];
    for (const sessions of boards) {
      assert.deepEqual(decide({ ...base, remote: false, sessions }), decide({ ...base, sessions }));
    }
  });
});

const record = (over: Partial<HoldRecord> = {}): HoldRecord => ({
  windowId: 'w1',
  until: NOW + LEASE_MS,
  sessions: [100],
  reason: 'drinking',
  writtenAt: NOW,
  ...over
});

/**
 * The merge, and only the merge. This used to be `cupFill` and returned the
 * cup's level, dividing by `LEASE_MS` against a `now` it took as an argument —
 * a number that differed on every push and so kept the panel from ever skipping
 * one (`TASK_done_panel_repaint_cost.md`). The division is
 * `webview/cafe.ts`'s now, and the clamps that went with it are scenarios in
 * `cafe.test.ts`. What is left here is the part a test was ever really about.
 *
 * **It filters nothing.** A lapsed record is the caller's to drop — `cafeView`
 * keeps only the holds still running before it asks — so this is a plain
 * maximum, and a max over expired records is honestly an expired answer.
 */
describe('latestUntil', () => {
  it('is nothing at all with no records', () => {
    assert.equal(latestUntil([]), 0);
  });

  it('is the deadline itself when one window holds', () => {
    assert.equal(latestUntil([record()]), NOW + LEASE_MS);
  });

  it('takes the LATEST until when two windows hold', () => {
    // The whole reason the records are per-window rather than one shared file.
    // The machine stays awake until the last assertion lapses, so a window that
    // drank more recently is what the cup must draw.
    const older = record({ windowId: 'w1', until: NOW + 60_000 });
    const newer = record({ windowId: 'w2', until: NOW + LEASE_MS });
    assert.equal(latestUntil([older, newer]), NOW + LEASE_MS);
    assert.equal(latestUntil([newer, older]), NOW + LEASE_MS, 'order must not matter');
  });

  it('lets a live window outvote one whose lease already ran out', () => {
    const expired = record({ windowId: 'w1', until: NOW - 1 });
    const live = record({ windowId: 'w2', until: NOW + LEASE_MS / 2 });
    assert.equal(latestUntil([expired, live]), NOW + LEASE_MS / 2);
  });
});

/**
 * What the cup shows, given every window's hold. The collapse this suite
 * exists for: a record still saying `drinking` after its lease ran out used
 * to draw a cup empty while claiming to be full. The type now forbids that
 * pairing; these rows prove the reason that lands instead.
 */
describe('cafeView', () => {
  for (const { name, holds, want } of [
    {
      name: 'nothing on disk is idle — that is what absence already means',
      holds: [] as HoldRecord[],
      want: { reason: 'idle' as const }
    },
    {
      name: 'a live drinking lease is drinking, until the last one lapses',
      holds: [record()],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'an expired drinking record reads idle, not drinking',
      holds: [record({ until: NOW - 1 })],
      want: { reason: 'idle' as const }
    },
    {
      name: 'a lease that ends now is already gone',
      holds: [record({ until: NOW })],
      want: { reason: 'idle' as const }
    },
    {
      name: 'the freshest refusal names why the cup is empty',
      holds: [record({ reason: 'battery', until: NOW - 1 })],
      want: { reason: 'battery' as const }
    },
    {
      name: 'stale survives the same way battery does',
      holds: [record({ reason: 'stale', until: NOW - 1 })],
      want: { reason: 'stale' as const }
    },
    {
      name: 'two live leases, the later until wins',
      holds: [
        record({ windowId: 'w1', until: NOW + 60_000 }),
        record({ windowId: 'w2', until: NOW + LEASE_MS })
      ],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'a live lease outvotes any expired record, whatever its reason',
      holds: [
        record({ windowId: 'w1', reason: 'battery', until: NOW - 1, writtenAt: NOW }),
        record({ windowId: 'w2', until: NOW + LEASE_MS, writtenAt: NOW - 1 })
      ],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'an expired drinking record that is the freshest still reads idle',
      holds: [
        record({
          windowId: 'w1',
          reason: 'battery',
          until: NOW - 10,
          writtenAt: NOW - 100
        }),
        record({ windowId: 'w2', reason: 'drinking', until: NOW - 1, writtenAt: NOW })
      ],
      want: { reason: 'idle' as const }
    },
    {
      name: 'counts each session once, however many windows hold for it',
      holds: [
        record({ windowId: 'w1', sessions: [100, 101] }),
        record({ windowId: 'w2', sessions: [101, 102] })
      ],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 3 }
    },
    {
      name: 'counts no session from a lease that already ran out',
      holds: [
        record({ windowId: 'w1', sessions: [100] }),
        record({ windowId: 'w2', sessions: [200, 201], until: NOW - 1 })
      ],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'says Remote holds when any live lease was poured for it',
      holds: [
        record({ windowId: 'w1', sessions: [], remote: true }),
        record({ windowId: 'w2', sessions: [100], until: NOW + 60_000 })
      ],
      want: {
        reason: 'drinking' as const,
        until: NOW + LEASE_MS,
        sessions: 1,
        remote: true as const
      }
    },
    {
      name: 'does not say Remote for a Remote lease that ran out',
      holds: [
        record({ windowId: 'w1', sessions: [], remote: true, until: NOW - 1 }),
        record({ windowId: 'w2', sessions: [100] })
      ],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'counts each warm session once across live leases, and none from an expired one',
      holds: [
        record({ windowId: 'w1', sessions: [], warmSessions: [7, 8] }),
        record({ windowId: 'w2', sessions: [], warmSessions: [8, 9] }),
        record({ windowId: 'w3', sessions: [], warmSessions: [10], until: NOW - 1 })
      ],
      want: {
        reason: 'drinking' as const,
        until: NOW + LEASE_MS,
        sessions: 0,
        warmSessions: 3
      }
    },
    {
      name: 'ignores a warmSessions field that is not a list',
      holds: [record({ warmSessions: 'x' as unknown as number[] })],
      want: { reason: 'drinking' as const, until: NOW + LEASE_MS, sessions: 1 }
    },
    {
      name: 'a stale record fresher than an expired drink names stale',
      holds: [
        record({
          windowId: 'w1',
          reason: 'drinking',
          until: NOW - 1,
          writtenAt: NOW - 100
        }),
        record({ windowId: 'w2', reason: 'stale', until: NOW - 1, writtenAt: NOW })
      ],
      want: { reason: 'stale' as const }
    }
  ]) {
    it(name, () => {
      assert.deepEqual(cafeView(holds, NOW), want);
    });
  }
});

describe('AwakeDeadlines', () => {
  const lease = NOW + LEASE_MS;
  const refillAt = lease - 60_000;

  it('a battery recheck outlives the lease it was set beside', () => {
    const deadlines = new AwakeDeadlines();
    deadlines.refill(refillAt);
    // The refill deadline's check, refused for the battery.
    deadlines.served(refillAt);
    deadlines.recheck(refillAt + BATTERY_RECHECK_MS);
    // The lease in hand wears off about as the recheck comes due.
    assert.equal(deadlines.refill(undefined), refillAt + BATTERY_RECHECK_MS);
  });

  it('keeps the earlier of the two', () => {
    const deadlines = new AwakeDeadlines();
    deadlines.recheck(refillAt + 5_000);
    assert.equal(deadlines.refill(refillAt), refillAt);
    assert.equal(deadlines.refill(undefined), refillAt + 5_000);
    assert.equal(deadlines.recheck(undefined), undefined);
  });

  it('a check that runs serves every deadline already due, and no later one', () => {
    const deadlines = new AwakeDeadlines();
    deadlines.refill(refillAt);
    deadlines.recheck(refillAt + 1);
    deadlines.served(refillAt);
    assert.equal(deadlines.recheck(refillAt + 1), refillAt + 1);
    deadlines.served(refillAt + 1);
    assert.equal(deadlines.refill(undefined), undefined);
  });
});

describe('decide, with a warm ping pending', () => {
  const warm = { ...base, warm: [7] };

  it('drinks with nothing busy at all', () => {
    const verdict = decide({ ...warm, sessions: [] });
    assert.equal(verdict.drink, true);
    assert.equal(verdict.reason, 'drinking');
    assert.deepEqual(verdict.warmSessions, [7]);
    assert.equal(verdict.remote, undefined);
    assert.deepEqual(verdict.sessions, []);
  });

  it('still names the sessions that are working', () => {
    const sessions = [session({ pid: 1 }), session({ pid: 2, status: 'idle' })];
    assert.deepEqual(decide({ ...warm, sessions }).sessions, [1]);
  });

  it('gives way to the setting, the battery and the platform', () => {
    const cases: [Partial<typeof warm>, string][] = [
      [{ enabled: false }, 'off'],
      [{ power: { pct: BATTERY_FLOOR_PCT - 1, onAC: false } }, 'battery'],
      [{ holds: false }, 'unsupported']
    ];
    for (const [over, reason] of cases) {
      const verdict = decide({ ...warm, ...over, sessions: [] });
      assert.equal(verdict.drink, false, reason);
      assert.equal(verdict.reason, reason);
      assert.equal(verdict.warmSessions, undefined, reason);
    }
  });

  it('looks again an interval later when the battery refuses it', () => {
    const flat = { pct: BATTERY_FLOOR_PCT - 1, onAC: false };
    assert.equal(
      decide({ ...warm, power: flat, sessions: [] }).recheckAt,
      NOW + BATTERY_RECHECK_MS
    );
  });

  it('changes no verdict while nothing is pending', () => {
    const boards = [[], [session()], [session({ status: 'idle' })]];
    for (const sessions of boards) {
      assert.deepEqual(decide({ ...base, warm: [], sessions }), decide({ ...base, sessions }));
    }
  });

  it('says Remote and Warm together when both hold', () => {
    const verdict = decide({ ...warm, remote: true, sessions: [] });
    assert.equal(verdict.remote, true);
    assert.deepEqual(verdict.warmSessions, [7]);
  });
});

describe('leaseWanted', () => {
  it('keeps any lease poured for a session, whatever Remote or Warm does', () => {
    assert.equal(leaseWanted({ optional: false }, false), true);
    assert.equal(leaseWanted({ optional: false }, true), true);
  });

  it('keeps a lease poured for Remote or Warm alone while either holds', () => {
    assert.equal(leaseWanted({ optional: true }, true), true);
  });

  it('cuts a lease poured for Remote or Warm alone once neither holds', () => {
    assert.equal(leaseWanted({ optional: true }, false), false);
  });
});
