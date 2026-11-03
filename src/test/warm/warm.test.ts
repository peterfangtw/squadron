import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as warm from '../../core/warm';
import * as cacheTtl from '../../core/cache_ttl';
import * as live from '../../core/live';
import type { Session } from '../../core/model';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../../core/warm_policy';

const at = 1_000_000;
const minute = 60_000;
const policy = DEFAULT_WARM_POLICY;
function session(overrides: Partial<Session> = {}): Session {
  return {
    pid: 1,
    sessionId: 'one',
    cwd: '/repo',
    transcript: '/repo/one.jsonl',
    name: 'one',
    status: 'idle',
    hasCommand: false,
    startedAt: at,
    updatedAt: at,
    warm: true,
    contextPct: 20,
    cache: { at, ...cacheTtl.ttlFor('claude', policy) },
    ...overrides
  };
}
function port(overrides: Partial<warm.WarmPortFacts> = {}): warm.WarmPortFacts {
  return {
    status: 'idle',
    running: false,
    queued: 0,
    pending: 0,
    exited: false,
    inFlight: false,
    ...overrides
  };
}

describe('warm admission and deadlines', () => {
  it('warms Claude at 55 minutes and 55 minutes after the ping, independently of real idle', () => {
    assert.deepEqual(warm.warmDue(session(), port(), undefined, at + 54 * minute, policy), {
      due: false,
      reason: 'not-yet',
      nextAt: at + 55 * minute
    });
    assert.deepEqual(warm.warmDue(session(), port(), undefined, at + 55 * minute, policy), {
      due: true
    });
    const refreshed = session({
      cache: { at: at + 55 * minute, ...cacheTtl.ttlFor('claude', policy) }
    });
    assert.equal(
      warm.nextWarmAt(warm.warmDue(refreshed, port(), undefined, at + 56 * minute, policy)),
      at + 110 * minute
    );
    assert.deepEqual(warm.warmDue(refreshed, port(), undefined, at + 110 * minute, policy), {
      due: true
    });
  });

  it('uses established 30-minute retention at 25 minutes and configured Grok at 10', () => {
    for (const [ttlMs, source, dueMinutes] of [
      [30 * minute, 'measured', 25],
      [15 * minute, 'configured', 10]
    ] as const) {
      const s = session({ cache: { at, ttlMs, source } });
      assert.equal(
        warm.warmDue(s, port(), undefined, at + (dueMinutes - 1) * minute, policy).nextAt,
        at + dueMinutes * minute
      );
      assert.equal(warm.warmDue(s, port(), undefined, at + dueMinutes * minute, policy).due, true);
    }
  });

  const cases: {
    label: string;
    s?: Partial<Session>;
    p?: Partial<warm.WarmPortFacts>;
    unsupported?: true;
    failure?: number;
    reason: warm.WarmReason;
  }[] = [
    { label: 'off', s: { warm: false }, reason: 'off' },
    { label: 'unstated', s: { warm: undefined }, reason: 'off' },
    { label: 'unsupported', unsupported: true, reason: 'unsupported' },
    { label: 'shown busy', s: { status: 'busy' }, reason: 'busy' },
    { label: 'raw busy behind idle display', p: { status: 'busy' }, reason: 'busy' },
    { label: 'raw running', p: { running: true }, reason: 'busy' },
    { label: 'unknown', p: { status: 'unknown' }, reason: 'busy' },
    { label: 'ask', p: { pending: 1 }, reason: 'ask' },
    { label: 'public ask', s: { waitingFor: 'permission' }, reason: 'ask' },
    { label: 'outbox', p: { queued: 1 }, reason: 'queued' },
    { label: 'inflight real write', p: { inFlight: true }, reason: 'busy' },
    { label: 'exit', p: { exited: true }, reason: 'ended' },
    { label: 'closing', s: { closing: true }, reason: 'ended' },
    { label: 'warming written', p: { turn: { phase: 'written' } }, reason: 'warming' },
    { label: 'warming open', p: { turn: { phase: 'open' } }, reason: 'warming' },
    {
      label: '5-minute cache',
      s: { cache: { at, ttlMs: 5 * minute, source: 'measured' } },
      reason: 'short-ttl'
    },
    {
      label: 'shorter cache',
      s: { cache: { at, ttlMs: minute, source: 'measured' } },
      reason: 'short-ttl'
    },
    {
      label: 'no cache stamp',
      s: { cache: { ttlMs: 60 * minute, source: 'measured' } },
      reason: 'no-cache'
    },
    { label: 'no metadata', s: { cache: undefined }, reason: 'no-cache' },
    { label: 'refused before', failure: at, reason: 'failed' },
    { label: 'failed latch', p: { turn: { phase: 'closed', failed: true } }, reason: 'failed' }
  ];
  for (const c of cases)
    it(`holds ${c.label} without a timer`, () => {
      const result = warm.warmDue(
        session(c.s),
        c.unsupported ? undefined : port(c.p),
        c.failure,
        at + 55 * minute,
        policy
      );
      assert.deepEqual(
        result,
        c.reason === 'off'
          ? { due: false, reason: c.reason }
          : { due: false, reason: c.reason, held: c.reason }
      );
      assert.equal(warm.nextWarmAt(result), undefined);
    });

  it('admits any context usage and cache reuse while fresh, but never after expiry', () => {
    for (const contextPct of [undefined, -1, NaN, Infinity, 80, 100]) {
      for (const cached of [0, 1000, 30_000]) {
        const s = session({ contextPct });
        const p = port({ turn: { phase: 'closed', prefix: 30_000, cached } });
        assert.deepEqual(warm.warmDue(s, p, undefined, at + 55 * minute, policy), { due: true });
        assert.deepEqual(warm.warmDue(s, p, undefined, at + 60 * minute, policy), {
          due: false,
          reason: 'expired'
        });
      }
    }
  });

  it('holds exact expiry and later, including a wake after sleep', () => {
    for (const elapsed of [60, 61, 119])
      assert.deepEqual(warm.warmDue(session(), port(), undefined, at + elapsed * minute, policy), {
        due: false,
        reason: 'expired'
      });
    assert.equal(
      warm.warmDue(session(), port(), undefined, at + 60 * minute - 1, policy).due,
      true
    );
  });

  it('never warms at or beyond two hours, or arms a ping outside the window', () => {
    const s = session({ cache: { at: at + 110 * minute, ...cacheTtl.ttlFor('claude', policy) } });
    for (const elapsed of [119, 120, 121])
      assert.deepEqual(warm.warmDue(s, port(), undefined, at + elapsed * minute, policy), {
        due: false,
        reason: 'window-over'
      });
  });

  it('admits just inside the idle window', () => {
    const s = session({
      cache: { at: at + 64 * minute, ...cacheTtl.ttlFor('claude', policy) }
    });
    assert.equal(warm.warmDue(s, port(), undefined, at + 120 * minute - 1, policy).due, true);
  });

  it('times the ping, the window and its lapse off the policy it is given', () => {
    const custom: WarmPolicy = {
      ttlMs: { ...policy.ttlMs, claude: 20 * minute },
      marginMs: 3 * minute,
      windowMs: 40 * minute
    };
    const s = session({ cache: { at, ...cacheTtl.ttlFor('claude', custom) } });
    assert.deepEqual(warm.warmDue(s, port(), undefined, at + minute, custom), {
      due: false,
      reason: 'not-yet',
      nextAt: at + 17 * minute
    });
    assert.equal(warm.warmEndsAt(s, custom), at + 40 * minute);
    assert.equal(warm.warmLapsed(s, at + 40 * minute - 1, custom, at), false);
    assert.equal(warm.warmLapsed(s, at + 40 * minute, custom, at), true);
  });

  it('holds a window too short for the first ping, and only while it lasts', () => {
    // Claude's 60 minutes less the 5-minute buffer lands the first ping on the end.
    const short: WarmPolicy = { ...policy, windowMs: 55 * minute };
    assert.deepEqual(warm.warmDue(session(), port(), undefined, at + 10 * minute, short), {
      due: false,
      reason: 'window-short',
      held: 'window-short'
    });
    assert.deepEqual(warm.warmDue(session(), port(), undefined, at + 55 * minute, short), {
      due: false,
      reason: 'window-over'
    });
    const fits = { ...short, windowMs: 56 * minute };
    assert.equal(
      warm.warmDue(session(), port(), undefined, at + 10 * minute, fits).nextAt,
      at + 55 * minute
    );
  });

  it('only real activity clears a failure; cache traffic alone does not', () => {
    assert.equal(
      warm.warmDue(
        session({ cache: { at: at + minute, ...cacheTtl.ttlFor('claude', policy) } }),
        port(),
        at,
        at + 56 * minute,
        policy
      ).reason,
      'failed'
    );
    assert.equal(
      warm.warmDue(session({ updatedAt: at + 1 }), port(), at, at + 55 * minute, policy).due,
      true
    );
  });

  it('does not invent a miss from missing counts, a zero prefix or partial reuse', () => {
    for (const turn of [
      { phase: 'closed' },
      { phase: 'closed', prefix: 30_000 },
      { phase: 'closed', prefix: 0, cached: 0 },
      { phase: 'closed', prefix: 30_000, cached: 20_000 },
      { phase: 'closed', prefix: 30_000, cached: 29_000 }
    ] as const) {
      assert.equal(
        warm.warmDue(session(), port({ turn }), undefined, at + 55 * minute, policy).due,
        true
      );
    }
  });

  it('rejects invalid cache arithmetic and never returns a past timer when due', () => {
    for (const ttlMs of [NaN, Infinity, 0, -1])
      assert.equal(
        warm.warmDue(
          session({ cache: { at, ttlMs, source: 'measured' } }),
          port(),
          undefined,
          at,
          policy
        ).nextAt,
        undefined
      );
    for (const stamp of [NaN, Infinity])
      assert.equal(
        warm.warmDue(
          session({ cache: { at: stamp, ...cacheTtl.ttlFor('claude', policy) } }),
          port(),
          undefined,
          at,
          policy
        ).reason,
        'no-cache'
      );
    for (const elapsed of [55, 56, 59])
      assert.equal(
        warm.nextWarmAt(warm.warmDue(session(), port(), undefined, at + elapsed * minute, policy)),
        undefined
      );
  });
});

describe('warm window lapse', () => {
  const ends = at + policy.windowMs;

  it('ends a switched-on session the warm window after its last real turn', () => {
    assert.equal(warm.warmEndsAt(session(), policy), ends);
    assert.equal(warm.warmEndsAt(session({ warm: false }), policy), undefined);
  });

  it('lapses an idle session at the window end, and not a minute before', () => {
    assert.equal(warm.warmLapsed(session(), ends - minute, policy, at), false);
    assert.equal(warm.warmLapsed(session(), ends, policy, at), true);
  });

  it('keeps a switch armed after the window, until a real turn opens the next', () => {
    assert.equal(
      warm.warmLapsed(session({ warmArmedAt: ends + minute }), ends + 2 * minute, policy, at),
      false
    );
    assert.equal(warm.warmLapsed(session({ warmArmedAt: ends - minute }), ends, policy, at), true);
    const next = session({ updatedAt: ends + 3 * minute, warmArmedAt: ends + minute });
    assert.equal(warm.warmLapsed(next, ends + 3 * minute + policy.windowMs, policy, at), true);
  });

  it('does not lapse a window that had ended when the policy last changed', () => {
    assert.equal(warm.warmLapsed(session(), ends + minute, policy, ends + 1), false);
    assert.equal(warm.warmLapsed(session(), ends + minute, policy, ends), true);
  });

  it('arms a resumed conversation from its pipe, not from its last turn', () => {
    const resumedAt = ends + 30 * minute;
    const resumed = session({ startedAt: resumedAt, warmArmedAt: resumedAt });
    assert.equal(warm.warmLapsed(resumed, resumedAt + minute, policy, at), false);
  });

  it('carries since when the switch has been armed', () => {
    const state = live.initial({ cwd: '/repo', startedAt: at });
    const held = { pid: 1, startedAt: at, updatedAt: at, brand: 'claude' as const, warm: true };
    assert.equal(live.toSession(state, { ...held, warmArmedAt: at }, 'window').warmArmedAt, at);
    assert.equal(live.toSession(state, held, 'window').warmArmedAt, undefined);
  });

  it('never lapses a session that is off, working, waiting on a dialog, or mid-ping', () => {
    assert.equal(warm.warmLapsed(session({ warm: false }), ends, policy, at), false);
    assert.equal(warm.warmLapsed(session({ status: 'busy' }), ends, policy, at), false);
    assert.equal(
      warm.warmLapsed(session({ status: 'waiting' }), ends, policy, at),
      false,
      'a dialog is mid-turn'
    );
    assert.equal(
      warm.warmLapsed(
        session({ warmPort: port({ status: 'busy', running: true }) }),
        ends,
        policy,
        at
      ),
      false
    );
  });
});

describe('owned warm facts', () => {
  it('carries effective choice, actual support and raw occupancy through the idle display', () => {
    const state = {
      ...live.initial({ cwd: '/repo', startedAt: at }),
      status: 'busy' as const,
      running: true,
      warmTurn: { phase: 'open' as const },
      inFlight: { id: 'ping', text: 'warm', queuedAt: at, warm: true as const }
    };
    const held = {
      pid: 1,
      startedAt: at,
      updatedAt: at,
      cacheAt: at,
      brand: 'claude' as const,
      warm: true,
      warmSupported: true,
      warmFailureAt: at
    };
    const shown = live.toSession(state, held, 'window');
    assert.equal(shown.status, 'idle');
    assert.equal(shown.warm, true);
    assert.equal(shown.warmFailureAt, at);
    assert.equal(shown.warmPort?.status, 'busy');
    assert.equal(shown.warmPort?.running, true);
    assert.equal(shown.warmPort?.inFlight, true);
    assert.equal(shown.cache?.at, at);
    assert.equal(
      live.toSession(state, { ...held, warmSupported: false }, 'window').warmPort,
      undefined
    );
    assert.equal(live.toSession(state, { ...held, warm: false }, 'window').warm, false);
  });
});

describe('warm cache evidence boundaries', () => {
  it('requires most of the saved prefix for a hit, and less than half establishes a miss', () => {
    for (const [cached, verdict] of [
      [0, 'miss'],
      [14999, 'miss'],
      [15000, 'partial'],
      [26999, 'partial'],
      [27000, 'hit'],
      [30000, 'hit']
    ] as const) {
      assert.equal(warm.warmVerdict({ phase: 'closed', prefix: 30000, cached }), verdict);
    }
    assert.equal(warm.warmVerdict({ phase: 'closed', cached: 0 }), 'unknown');
    assert.equal(warm.warmVerdict({ phase: 'closed', prefix: 30000 }), 'unknown');
  });
});

describe('warm on', () => {
  const on = (s: Partial<Session>): number[] => warm.warmOn([session(s)]);

  it('counts a session with the switch on, whatever its ping is doing', () => {
    for (const s of [
      {},
      { warmPort: port({ turn: { phase: 'open' as const } }) },
      { warmFailureAt: at },
      { cache: undefined },
      { warmPort: undefined }
    ])
      assert.deepEqual(on(s), [1]);
  });

  it('skips a session with the switch off or unstated', () => {
    assert.deepEqual(on({ warm: false }), []);
    assert.deepEqual(on({ warm: undefined }), []);
  });
});
