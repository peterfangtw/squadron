import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memberPids, parseArgs } from '../../cli/wait';
import { registered, waitPlan, type WaitPlan } from '../../cli/wait_plan';
import { WAIT_TTL_MS } from '../../core/coordination/guards';
import { checkResolution, recipient } from '../../core/coordination/send';
import { DEFAULT_WARM_POLICY, WARM_LIMITS } from '../../core/warm_policy';
import { Session } from '../../core/model';

/**
 * What one `squadron-wait` invocation would register, or why it would not.
 *
 * The plan is pure for `sendPlan`'s reason: a refusal an agent cannot act on
 * is worse than no verb at all, and the only way to hold a sentence to that is
 * to assert on it. Registration reaches no window, so there is no reply here to
 * be unsure about — the exit codes below stop at 3.
 */

const NOW = 1_700_000_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'card',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: NOW - 60_000,
  transcript: '/tmp/t.jsonl',
  source: 'owned',
  windowId: 'w1',
  ...over
});

const board = () => [
  session({ pid: 1, sessionId: 'me', name: 'caller' }),
  session({ pid: 201, sessionId: 'sid-201' }),
  session({ pid: 202, sessionId: 'sid-202' })
];

function plan(
  members: readonly number[] = [201, 202],
  sessions = board(),
  callerId: string | undefined = 'me'
): WaitPlan {
  return waitPlan(members, sessions, callerId, NOW);
}

function badPids(raw: string | undefined): { code: 1; reason: string } {
  const parsed = memberPids(raw);
  assert.ok(!parsed.ok, 'expected a usage error');
  return parsed;
}

function refusal(result: WaitPlan): { code: 2; reason: string } {
  assert.ok(!result.ok, 'expected a refusal');
  return result;
}

function accepted(result: WaitPlan): Extract<WaitPlan, { ok: true }> {
  assert.ok(result.ok, result.ok ? '' : `expected a plan, got: ${result.reason}`);
  return result;
}

describe('parseArgs', () => {
  it('takes the one required flag and the one optional', () => {
    assert.deepEqual(parseArgs(['--pids', '201,202', '--caller-session-id', 'me']), {
      pids: '201,202',
      'caller-session-id': 'me'
    });
  });

  it('refuses a flag it does not declare', () => {
    // The rule `cli/args.ts` exists for: `--pid` here is a typo for `--pids`,
    // and parsing it would report "--pids is required" to a caller that is
    // passing one.
    assert.equal(parseArgs(['--pid', '201']), undefined);
  });
});

describe('what a registration decides', () => {
  it('registers over every member named', () => {
    const { record } = accepted(plan());
    assert.deepEqual(record.members, [201, 202]);
    assert.equal(record.requesterPid, 1);
    assert.equal(record.requesterSessionId, 'me');
    assert.equal(record.schema, 1);
    assert.ok(record.id);
  });

  it('names no window', () => {
    // Registration is a direct write, which is what deletes the exit-4 class:
    // a `windowId` here is a window a reload could strand.
    const { record } = accepted(plan());
    assert.equal('windowId' in record, false);
  });

  it('expires inside the requester’s own staleness window', () => {
    // The fixture's caller has been idle a minute, and that minute is spent.
    const { record } = accepted(plan());
    assert.equal(record.createdAt, NOW);
    assert.equal(record.expiresAt, NOW + WAIT_TTL_MS - 60_000);
  });

  it('tolerates spacing and counts a repeated member once', () => {
    const parsed = memberPids(' 201 , 202 , 201 ');
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const { record } = accepted(waitPlan(parsed.pids, board(), 'me', NOW));
    assert.deepEqual(record.members, [201, 202]);
  });

  it('reads a missing --pids as usage, not as a refusal', () => {
    assert.equal(badPids(undefined).code, 1);
    assert.match(badPids(undefined).reason, /--pids is required\nusage: squadron-wait/);
    assert.match(badPids('').reason, /at least one process id\nusage: squadron-wait/);
    assert.match(badPids('abc').reason, /"abc" is not one/);
    assert.match(badPids('0').reason, /"0" is not one/);
  });

  it('refuses an empty list, and names no flag', () => {
    const { code, reason } = refusal(waitPlan([], board(), 'me', NOW));
    assert.equal(code, 2);
    assert.equal(reason, 'a wait needs a session, and none was named');
    assert.doesNotMatch(reason, /usage:/);
    assert.doesNotMatch(reason, /--pids/);
  });

  it('refuses a caller no window could ever wake', () => {
    // `sendPlan`'s guards, and this verb needs them more: registration asks no
    // window, so nothing downstream would refuse. Without them the shim promises
    // a wake, the caller ends its turn, and the record is claimed by no window
    // and swept silently at a day — the hang the feature exists to prevent,
    // reproduced inside it.
    const orphan = session({ pid: 1, sessionId: 'me', windowId: undefined });
    assert.match(
      refusal(plan([201, 202], [orphan, session({ pid: 201 })])).reason,
      /no window claims it/
    );
  });

  it('refuses a background caller as one, not as a pipe gone astray', () => {
    const bg = session({ pid: 1, sessionId: 'me', windowId: undefined, background: true });
    const why = refusal(plan([201, 202], [bg, session({ pid: 201 })])).reason;
    assert.match(why, /background/);
    assert.equal(/have a pipe/.test(why), false);
  });

  it('resolves only the requester and refuses its matching exit before recording a wake', () => {
    const caller = session({ pid: 1, sessionId: 'me' });
    const published = new Map([[1, { session: caller, exit: { code: 0, signal: null } }]]);
    assert.match(
      refusal(waitPlan([201, 999999], [caller], 'me', NOW, { published })).reason,
      /exited/
    );
    assert.ok(
      waitPlan([201, 999999], [caller, session({ pid: 201, background: true })], 'me', NOW, {
        claims: []
      }).ok
    );
    assert.match(
      refusal(waitPlan([201], [{ ...caller, source: undefined }], 'me', NOW)).reason,
      /publishes a pipe/
    );
  });

  it('refuses a caller it cannot place on the board', () => {
    // Ownership of the requester's pipe is what picks the resolving window, so
    // a caller nothing can find is a record no window would ever claim.
    assert.equal(refusal(waitPlan([201], board(), undefined, NOW)).code, 2);
    assert.match(refusal(plan([201, 202], board(), 'nobody')).reason, /no session on the board/);
  });

  it('refuses a wait over yourself', () => {
    // It would converge the instant the registering turn ended — a billed wake
    // that says nothing, which is the cost this feature exists to remove.
    const result = refusal(plan([1, 201]));
    assert.equal(result.code, 2);
    assert.match(result.reason, /is you/);
  });

  it('accepts a member that is not on the board (OQ9)', () => {
    // The predicate resolves a dead member and names it as gone, so refusing
    // here would only move the same answer earlier — and any check is advisory
    // against a member that dies between it and the write.
    const { record } = accepted(plan([201, 999999]));
    assert.deepEqual(record.members, [201, 999999]);
  });
});

describe('what the caller is told', () => {
  it('says to end the turn, and names the members', () => {
    const { record } = accepted(plan());
    const said = registered(record);
    assert.match(said, /201, 202/);
    assert.match(said, /End your turn/);
    // The one failure mode a returning-immediately verb invites is a caller
    // that runs it in a loop to check.
    assert.match(said, /do not poll/);
  });
});

describe('requester cache deadline', () => {
  it('uses the requester TTL even while it is busy and has no cache stamp', () => {
    for (const [ttlMs, budget] of [
      [60 * 60_000, WAIT_TTL_MS],
      [30 * 60_000, 26.5 * 60_000],
      [5 * 60_000, 215_000]
    ]) {
      const { record } = accepted(
        plan(
          [201],
          [
            session({
              pid: 1,
              sessionId: 'me',
              status: 'busy',
              cache: { ttlMs: ttlMs!, source: 'measured' }
            })
          ]
        )
      );
      assert.equal(record.expiresAt, NOW + budget!);
    }
  });
  it('leaves a positive budget at the shortest lifetime a setting can hold', () => {
    // Busy, as a requester is when it runs the verb: an idle one may have spent
    // a short lifetime already, and is refused for it below.
    const ttlMs = WARM_LIMITS.ttlMinutes.min * 60_000;
    const { record } = accepted(
      plan(
        [201],
        [
          session({
            pid: 1,
            sessionId: 'me',
            status: 'busy',
            cache: { ttlMs, source: 'configured' }
          })
        ]
      )
    );
    assert.ok(record.expiresAt > NOW, `budget ${record.expiresAt - NOW} ms`);
  });
  it('refuses a lifetime with no positive wait budget', () => {
    const result = plan(
      [201],
      [session({ pid: 1, sessionId: 'me', cache: { ttlMs: 60_000, source: 'measured' } })]
    );
    assert.match(refusal(result).reason, /cache/);
  });
  it('keeps the existing cap with malformed TTL evidence', () => {
    for (const ttlMs of [0, -1, NaN, Infinity]) {
      const { record } = accepted(
        plan([201], [session({ pid: 1, sessionId: 'me', cache: { ttlMs, source: 'measured' } })])
      );
      assert.equal(record.expiresAt, NOW + WAIT_TTL_MS - 60_000);
    }
  });

  it('lets an idle requester’s resolution through at expiry', () => {
    // Grok's 10 minutes, idle 2 already: the guard refuses at 9m10s idle, so a
    // wait budgeted from now (8m10s) would expire past it.
    const caller = session({
      pid: 1,
      sessionId: 'me',
      status: 'idle',
      updatedAt: NOW - 2 * 60_000,
      cache: { ttlMs: DEFAULT_WARM_POLICY.ttlMs.grok, source: 'configured' }
    });
    const { record } = accepted(plan([201], [caller]));
    const verdict = checkResolution({
      windowId: 'w1',
      target: recipient(caller),
      text: 'All finished.',
      now: record.expiresAt,
      actions: []
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it('refuses an idle requester already too cold to be woken', () => {
    const caller = session({
      pid: 1,
      sessionId: 'me',
      status: 'idle',
      updatedAt: NOW - 9 * 60_000,
      cache: { ttlMs: DEFAULT_WARM_POLICY.ttlMs.grok, source: 'configured' }
    });
    assert.match(refusal(plan([201], [caller])).reason, /cache/);
  });

  it('budgets a busy requester from now, however long ago it last moved', () => {
    const caller = session({
      pid: 1,
      sessionId: 'me',
      status: 'busy',
      updatedAt: NOW - 9 * 60_000,
      cache: { ttlMs: DEFAULT_WARM_POLICY.ttlMs.grok, source: 'configured' }
    });
    const { record } = accepted(plan([201], [caller]));
    assert.equal(record.expiresAt, NOW + 10 * 60_000 - 50_000 - 60_000);
  });
});
