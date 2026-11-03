import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listPlan, listRows, parseArgs, windowLabels, type Row } from '../../cli/list';
import type { WaitRecord } from '../../core/coordination/wait';
import type { PendingRequest } from '../../core/live';
import { Session, WindowClaim } from '../../core/model';
import type { PublishedLive } from '../../core/published';

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'card',
  status: 'idle',
  hasCommand: false,
  startedAt: 0,
  updatedAt: 0,
  transcript: '/tmp/t.jsonl',
  source: 'owned',
  windowId: 'w1',
  ...over
});

/** Caller, one child, one grandchild — the shape `--mine` is about. */
const family = () => [
  session({ pid: 1, sessionId: 'me', name: 'caller' }),
  session({ pid: 2, sessionId: 'kid', name: 'child', parentSessionId: 'me' }),
  session({ pid: 3, sessionId: 'grand', name: 'grandchild', parentSessionId: 'kid' })
];

function rows(plan: ReturnType<typeof listPlan>): Row[] {
  assert.ok(plan.ok, plan.ok ? '' : `expected rows, got: ${plan.reason}`);
  return plan.rows;
}

function refusal(plan: ReturnType<typeof listPlan>): { code: 1 | 2; reason: string } {
  assert.ok(!plan.ok, 'expected a refusal');
  return plan;
}

describe('parseArgs', () => {
  // Stored as the empty string, like every other bare flag — presence is
  // `!== undefined`, which is what keeps `--mine` from being silently falsy.
  it('takes the bare flag and the caller', () => {
    assert.deepEqual(parseArgs(['--mine', '--caller-session-id', 'sid']), {
      mine: '',
      'caller-session-id': 'sid'
    });
  });

  it('takes no arguments at all', () => {
    assert.deepEqual(parseArgs([]), {});
  });

  it('refuses a flag it does not know', () => {
    assert.equal(parseArgs(['--all']), undefined);
  });
});

describe('what a list shows', () => {
  it('is empty for a machine with claims but nothing running', () => {
    assert.deepEqual(listRows([]), []);
  });

  // **This list is the machine's, and the panel's board is not** (row 71). A
  // session another window drives has no card here any more; `-send`, `-end`
  // and `-rename` still reach it, so a list that could not see it would be a
  // list of things the caller cannot address.
  it('keeps a session another window drives', () => {
    const theirs = session({ pid: 4, source: 'owned', windowId: 'w2' });
    assert.deepEqual(
      listRows([theirs], [], new Map([['w2', 'web — Window']])).map((r) => [r.pid, r.window]),
      [[4, 'web — Window']]
    );
  });

  // Not `source === 'owned'`: a session another window drives whose published
  // record never landed is still reachable by `send`.
  it('keeps a pipe session whose record never landed', () => {
    const twin = session({ pid: 7, source: undefined, status: 'unknown' });
    assert.deepEqual(
      listRows([twin]).map((r) => [r.pid, r.status]),
      [[7, 'unknown']]
    );
  });

  it('carries what a caller addresses and reads a session by', () => {
    const [row] = listRows([session({ pid: 42, sessionId: 'sid-42', transcript: '/t/42.jsonl' })]);
    assert.equal(row?.pid, 42);
    assert.equal(row?.sessionId, 'sid-42');
    assert.equal(row?.transcript, '/t/42.jsonl');
    assert.equal(row?.cwd, '/work/app');
  });

  // The coordinate an agent and its reader share, now that a board is one
  // window's and this list is the machine's.
  it('names the window by its claim’s label, not by the id behind it', () => {
    // The field exists so an agent and its reader share a coordinate, and a
    // `vscode.env.sessionId` GUID is not one a person can see anywhere.
    const windows = new Map([['w1', 'agentsview — Window']]);
    const [named] = listRows([session({ pid: 1, windowId: 'w1' })], [], windows);
    assert.equal(named?.window, 'agentsview — Window');

    // No claim to read: a session in Terminal.app, or one whose window has gone.
    const [loose] = listRows([session({ pid: 2, windowId: undefined })], [], windows);
    assert.equal('window' in (loose ?? {}), false, 'absent is “nobody can say”, never “this one”');
    const [gone] = listRows([session({ pid: 3, windowId: 'closed' })], [], windows);
    assert.equal('window' in (gone ?? {}), false, 'a window that has gone claims nothing');
  });

  it('falls back to the id when a claim carries no label', () => {
    const bare: WindowClaim = { id: 'w1', label: '', app: '', shellPids: [], updatedAt: 0 };
    const [row] = listRows([session({ pid: 1, windowId: 'w1' })], [], windowLabels([bare]));
    assert.equal(row?.window, 'w1', 'an empty label would read as a window that does not exist');
  });

  // `idle` wearing `done`'s face: the caller has to be able to tell.
  it('says a command is still running in an idle session', () => {
    const [row] = listRows([session({ status: 'idle', hasCommand: true })]);
    assert.equal(row?.status, 'idle');
    assert.equal(row?.hasCommand, true);
  });

  it('names no brand anywhere in a row', () => {
    const printed = JSON.stringify(listRows([session({ brand: 'grok' })]));
    assert.equal(/grok|claude|codex/i.test(printed), false, printed);
  });
});

describe('a wait that could not be delivered', () => {
  const failed = (over: Partial<WaitRecord> = {}): WaitRecord => ({
    schema: 1,
    id: 'w1',
    requesterPid: 100,
    members: [201],
    createdAt: 1,
    expiresAt: 2,
    failed: { reason: 'Session 100 is at 85% of its context', at: 3 },
    ...over
  });

  it('shows up on the row of the session it was owed to', () => {
    // The one failure the requester itself cannot be told about — a resolution
    // obeys `checkSend` like any other send, and this is the refusal.
    const [row] = listRows([session({ pid: 100 })], [failed()]);
    assert.match(row?.waitFailed ?? '', /85% of its context/);
  });

  it('says nothing on a session that has no such wait', () => {
    const [row] = listRows([session({ pid: 999 })], [failed()]);
    assert.equal(row?.waitFailed, undefined);
    // And nothing at all for a wait still pending: it has not failed.
    const [alive] = listRows([session({ pid: 100 })], [{ ...failed(), failed: undefined }]);
    assert.equal(alive?.waitFailed, undefined);
  });

  it('takes the newest reason when a requester has several', () => {
    const [row] = listRows(
      [session({ pid: 100 })],
      [
        failed({ id: 'old', failed: { reason: 'gone cold', at: 1 } }),
        failed({ id: 'new', failed: { reason: 'too full', at: 9 } })
      ]
    );
    assert.equal(row?.waitFailed, 'too full');
  });
});

describe('listPlan', () => {
  it('shows the whole board when nothing narrows it', () => {
    assert.deepEqual(
      rows(listPlan({}, family(), 'me')).map((r) => r.pid),
      [1, 2, 3]
    );
  });

  it('narrows to the caller’s descent, and not the caller', () => {
    assert.deepEqual(
      rows(listPlan({ mine: '' }, family(), 'me')).map((r) => r.pid),
      [2, 3]
    );
  });

  // Showing everything would be the answer most likely to be acted on wrongly.
  it('refuses --mine when it cannot tell who is asking', () => {
    assert.equal(refusal(listPlan({ mine: '' }, family(), undefined)).code, 2);
    assert.match(refusal(listPlan({ mine: '' }, family(), '')).reason, /--caller/);
  });

  it('refuses --mine from a caller no longer on the board', () => {
    assert.equal(refusal(listPlan({ mine: '' }, family(), 'ghost')).code, 2);
  });

  it('shows a whole board to a caller it cannot identify', () => {
    assert.equal(rows(listPlan({}, family(), undefined)).length, 3);
  });

  // Degrades rather than refusing: a session whose lineage edge expired, or
  // which was never joined, is simply not below anybody.
  it('says nothing is below a caller with no children', () => {
    const alone = [session({ pid: 1, sessionId: 'me' })];
    assert.deepEqual(rows(listPlan({ mine: '' }, alone, 'me')), []);
  });
});

describe('what a session is asking', () => {
  const question: PendingRequest = {
    requestId: 'req_7',
    toolName: 'AskUserQuestion',
    toolUseId: 'toolu_1',
    ask: true,
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'the usual', preview: 'CREATE …' },
          { label: 'SQLite' }
        ]
      }
    ],
    input: { questions: [] }
  };
  const permission: PendingRequest = {
    requestId: 'req_8',
    toolName: 'Bash',
    ask: false,
    label: 'rm -rf build/',
    input: { command: 'rm -rf build/' }
  };
  const published = (
    pending: PendingRequest[],
    over: Partial<PublishedLive> = {}
  ): Map<number, PublishedLive> =>
    new Map([
      [
        100,
        {
          schema: 1,
          session: session({ pid: 100, status: 'waiting' }),
          pending,
          queued: [],
          ...over
        }
      ]
    ]);
  const asked = (
    records: Map<number, PublishedLive>,
    over: Partial<Session> = {}
  ): Row | undefined =>
    listRows([session({ pid: 100, status: 'waiting', ...over })], [], new Map(), records)[0];

  it('carries an open question in the shape an answer is written against', () => {
    assert.deepEqual(asked(published([question]))?.asking, [
      {
        requestId: 'req_7',
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiSelect: false,
            options: [{ label: 'Postgres', description: 'the usual' }, { label: 'SQLite' }]
          }
        ]
      }
    ]);
  });

  it('lists a permission so the answerer knows to pass it to a person', () => {
    assert.deepEqual(asked(published([permission]))?.asking, [
      { requestId: 'req_8', kind: 'permission', label: 'rm -rf build/' }
    ]);
  });

  it('lists an ask it could not read as a permission', () => {
    const [open] = asked(published([{ ...question, questions: [] }]))?.asking ?? [];
    assert.equal(open?.kind, 'permission');
  });

  it('ignores a record from an earlier run of the same pid', () => {
    const stale = published([question], { session: session({ pid: 100, startedAt: 5_000 }) });
    assert.equal(asked(stale, { startedAt: 90_000 })?.asking, undefined);
  });

  it('ignores a record whose session has exited', () => {
    const ended = published([question], { exit: { code: 0, signal: null } });
    assert.equal(asked(ended)?.asking, undefined);
  });

  it('prints no key when nothing is open', () => {
    const row = asked(published([]));
    assert.equal(row && 'asking' in row, false);
  });
});
