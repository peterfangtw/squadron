import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, WarmPlan, warmPlan } from '../../cli/warm';
import { Session } from '../../core/model';

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'card',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '',
  source: 'owned',
  windowId: 'w1',
  ...over
});

function refusal(plan: WarmPlan): { code: 1 | 2; reason: string } {
  assert.ok(!plan.ok, 'expected a refusal');
  return plan;
}

describe('squadron-warm parseArgs', () => {
  it('reads a pid, and --off as a bare flag', () => {
    assert.deepEqual(parseArgs(['--pid', '7']), { pid: '7' });
    assert.deepEqual(parseArgs(['--pid', '7', '--off']), { pid: '7', off: '' });
    assert.deepEqual(parseArgs(['--off', '--pid', '7']), { off: '', pid: '7' });
  });

  it('is malformed on an unknown flag, including --caller-session-id', () => {
    assert.equal(parseArgs(['--caller-session-id', 'sid']), undefined);
    assert.equal(parseArgs(['--on']), undefined);
  });
});

describe('warmPlan', () => {
  it('turns a card on by pid, and off with --off', () => {
    const on = warmPlan({ pid: '100' }, [session()]);
    assert.ok(on.ok);
    assert.equal(on.on, true);
    assert.deepEqual(on.address, { pid: 100, startedAt: 0, windowId: 'w1' });
    const off = warmPlan({ pid: '100', off: '' }, [session()]);
    assert.ok(off.ok);
    assert.equal(off.on, false);
  });

  it('is usage without a pid, or with one that is not a process id', () => {
    assert.equal(refusal(warmPlan({}, [session()])).code, 1);
    assert.equal(refusal(warmPlan({ pid: 'x' }, [session()])).code, 1);
    assert.equal(refusal(warmPlan({ pid: '-3' }, [session()])).code, 1);
  });

  it('refuses a pid no card has', () => {
    const why = refusal(warmPlan({ pid: '9' }, [session()]));
    assert.equal(why.code, 2);
    assert.match(why.reason, /no session on the board has pid 9/);
  });

  it('refuses a background session', () => {
    const row = session({ background: true, source: undefined, windowId: undefined });
    const why = refusal(warmPlan({ pid: '100' }, [row]));
    assert.equal(why.code, 2);
    assert.match(why.reason, /background/);
  });

  it('refuses a session that has gone', () => {
    const why = refusal(
      warmPlan({ pid: '100' }, [session()], {
        published: new Map([
          [100, { session: { pid: 100, startedAt: 0 }, exit: { code: 0, signal: null } }]
        ])
      })
    );
    assert.equal(why.code, 2);
    assert.match(why.reason, /has exited/);
  });
});
