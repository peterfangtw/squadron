import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, RenamePlan, renamePlan } from '../../cli/rename';
import { Session } from '../../core/model';
import type { TargetContext } from '../../core/session_target';

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

/** Caller and a child — the child is what `--pid` reaches. */
const family = () => [
  session({ pid: 1, sessionId: 'me', name: 'caller' }),
  session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me' })
];

function refusal(plan: RenamePlan): { code: 1 | 2; reason: string } {
  assert.ok(!plan.ok, 'expected a refusal');
  return plan;
}

function renaming(plan: RenamePlan): { pid: number; title: string } {
  assert.ok(plan.ok, plan.ok ? '' : `expected a plan, got: ${plan.reason}`);
  return { pid: plan.target.pid, title: plan.title };
}

describe('parseArgs', () => {
  it('reads the title', () => {
    assert.deepEqual(parseArgs(['--name', 'checkout modal']), { name: 'checkout modal' });
  });

  it('reads a pid beside the title', () => {
    assert.deepEqual(parseArgs(['--name', 'kid', '--pid', '2']), { name: 'kid', pid: '2' });
  });

  it('is malformed on an unknown flag — including --caller-session-id, which this does not take', () => {
    assert.equal(parseArgs(['--caller-session-id', 'sid']), undefined);
    assert.equal(parseArgs(['--titel', 'x']), undefined);
  });

  it('is malformed when the title has no value', () => {
    assert.equal(parseArgs(['--name']), undefined);
  });
});

describe('renamePlan: the title', () => {
  it('is usage when no title is given', () => {
    assert.equal(refusal(renamePlan({}, family(), 'me')).code, 1);
  });

  it('is usage when the title is blank — the CLI answers `title must be non-empty`', () => {
    assert.equal(refusal(renamePlan({ name: '   ' }, family(), 'me')).code, 1);
  });

  it('folds a title onto one line: a newline would be a second command on the wire', () => {
    assert.equal(
      renaming(renamePlan({ name: 'checkout\nmodal' }, family(), 'me')).title,
      'checkout modal'
    );
  });

  it('cuts an over-long title the way --name does, rather than refusing it', () => {
    const long = 'a'.repeat(60);
    const { title } = renaming(renamePlan({ name: long }, family(), 'me'));
    assert.equal(title.length, 40);
    assert.ok(title.endsWith('…'));
  });

  it('strips a control character, which is what keeps one frame one command', () => {
    assert.equal(
      renaming(renamePlan({ name: 'checkout\u001b[Bmodal\u0000' }, family(), 'me')).title,
      'checkout [Bmodal'
    );
  });

  it('takes a title of any script', () => {
    assert.equal(
      renaming(renamePlan({ name: '買入 Modal 應收現金扣除折扣' }, family(), 'me')).title,
      '買入 Modal 應收現金扣除折扣'
    );
  });
});

describe('renamePlan: whose card', () => {
  it('renames the caller when no pid is given', () => {
    assert.equal(renaming(renamePlan({ name: 'mine' }, family(), 'me')).pid, 1);
  });

  it('renames the pid it was handed — any card on the board, no descent asked', () => {
    const board = [...family(), session({ pid: 3, sessionId: 'peer', name: 'sibling' })];
    assert.equal(renaming(renamePlan({ name: 'kid', pid: '2' }, board, 'me')).pid, 2);
    assert.equal(renaming(renamePlan({ name: 'sib', pid: '3' }, board, 'me')).pid, 3);
  });

  it('needs no caller identity on the pid path', () => {
    assert.equal(renaming(renamePlan({ name: 'kid', pid: '2' }, family(), undefined)).pid, 2);
  });

  it('is usage when --pid is not a process id', () => {
    assert.equal(refusal(renamePlan({ name: 'x', pid: 'two' }, family(), 'me')).code, 1);
    assert.equal(refusal(renamePlan({ name: 'x', pid: '0' }, family(), 'me')).code, 1);
  });

  it('refuses a pid no card has', () => {
    const { code, reason } = refusal(renamePlan({ name: 'x', pid: '99' }, family(), 'me'));
    assert.equal(code, 2);
    assert.match(reason, /no session on the board has pid 99/);
  });

  it('refuses a pid no window drives, as it does on the self path', () => {
    const board = [session({ pid: 7, sessionId: 'tty', source: undefined, windowId: 'w-bare' })];
    const why = refusal(renamePlan({ name: 'x', pid: '7' }, board, 'me')).reason;
    assert.match(why, /no window publishes a pipe/);
    assert.doesNotMatch(why, /no window claims it/);
  });

  it('refuses when nothing says which session is asking', () => {
    const { code, reason } = refusal(renamePlan({ name: 'mine' }, family(), undefined));
    assert.equal(code, 2);
    assert.match(reason, /which session is asking/);
  });

  it('refuses an empty caller the same way as none at all', () => {
    assert.equal(refusal(renamePlan({ name: 'mine' }, family(), '')).code, 2);
  });

  it('refuses two live sessions on one id rather than naming whichever folded first', () => {
    const twins = [
      session({ pid: 1, sessionId: 'me', name: 'panel card' }),
      session({ pid: 9, sessionId: 'me', name: 'resumed at a shell' })
    ];
    const { code, reason } = refusal(renamePlan({ name: 'mine' }, twins, 'me'));
    assert.equal(code, 2);
    assert.match(reason, /--pid \(1, 9\)/);
  });

  it('names one twin by pid where the id alone was refused', () => {
    const twins = [
      session({ pid: 1, sessionId: 'me', name: 'panel card' }),
      session({ pid: 9, sessionId: 'me', name: 'resumed at a shell' })
    ];
    assert.equal(renaming(renamePlan({ name: 'mine', pid: '9' }, twins, 'me')).pid, 9);
  });

  it('refuses a caller no card has', () => {
    assert.equal(refusal(renamePlan({ name: 'mine' }, family(), 'ghost')).code, 2);
  });

  it('refuses a session no window drives — there is no pipe to write to', () => {
    const board = [session({ pid: 1, sessionId: 'me', source: undefined, windowId: 'w-bare' })];
    const { code, reason } = refusal(renamePlan({ name: 'mine' }, board, 'me'));
    assert.equal(code, 2);
    assert.match(reason, /no window publishes a pipe/);
    assert.doesNotMatch(reason, /no window claims it/);
  });

  it('refuses when no window claims it, rather than addressing a request to nobody', () => {
    const board = [session({ pid: 1, sessionId: 'me', windowId: undefined })];
    const why = refusal(renamePlan({ name: 'mine' }, board, 'me')).reason;
    assert.match(why, /has a pipe, but no window claims it/);
  });

  it('renames a busy caller: a rename is queued to the turn boundary, not refused', () => {
    const board = [session({ pid: 1, sessionId: 'me', status: 'busy' })];
    const plan = renamePlan({ name: 'mine' }, board, 'me');
    assert.equal(renaming(plan).pid, 1);
    assert.ok(plan.ok);
    assert.deepEqual(plan.address, { pid: 1, startedAt: 0, windowId: 'w1' });
  });
});

describe('renamePlan: the resolved address', () => {
  const owned = {
    canControl: true as const,
    owner: { kind: 'window' as const, windowId: 'w-owned' }
  };
  const mine = (over: Partial<Session> = {}, context: TargetContext = {}) =>
    renamePlan(
      { name: 'mine' },
      [session({ pid: 1, sessionId: 'me', name: 'caller', ...over })],
      'me',
      context
    );

  it('refuses a background caller as background, not as an unpublished pipe', () => {
    const why = refusal(mine({ background: true, source: undefined, windowId: undefined })).reason;
    assert.match(why, /background/);
    assert.doesNotMatch(why, /publishes a pipe/);
  });

  it('uses the owner fact when the session itself has no window id', () => {
    const plan = mine({ windowId: undefined, control: owned });
    assert.ok(plan.ok);
    assert.deepEqual(plan.address, { pid: 1, startedAt: 0, windowId: 'w-owned' });
  });

  it('keeps a missing owner claim advisory', () => {
    const plan = mine({}, { claims: [{ id: 'elsewhere' }] });
    assert.ok(plan.ok);
    assert.equal(plan.address.windowId, 'w1');
  });

  it('refuses a matching exit, including while the caller is busy', () => {
    const why = refusal(
      mine(
        { status: 'busy' },
        {
          published: new Map([
            [1, { session: { pid: 1, startedAt: 0 }, exit: { code: null, signal: 'SIGTERM' } }]
          ])
        }
      )
    ).reason;
    assert.match(why, /has exited/);
  });

  it('keeps a nonmatching publication from donating an exit or a start', () => {
    const plan = mine(
      { startedAt: 2500 },
      {
        published: new Map([
          [1, { session: { pid: 1, startedAt: 90_000 }, exit: { code: 0, signal: null } }]
        ])
      }
    );
    assert.ok(plan.ok);
    assert.deepEqual(plan.address, { pid: 1, startedAt: 2500, windowId: 'w1' });
  });

  it('fails closed on contradictory control and still refuses an ambiguous self first', () => {
    const row = session({
      pid: 1,
      sessionId: 'me',
      name: 'kept',
      background: true,
      source: 'owned',
      windowId: 'w1',
      control: owned
    });
    const why = refusal(renamePlan({ name: 'mine' }, [row], 'me')).reason;
    assert.match(why, /invalid control facts/);
    assert.doesNotMatch(why, /background/);
    const twins = [
      session({ pid: 1, sessionId: 'me', background: true }),
      session({ pid: 9, sessionId: 'me', background: true })
    ];
    assert.match(refusal(renamePlan({ name: 'mine' }, twins, 'me')).reason, /--pid \(1, 9\)/);
  });
});
