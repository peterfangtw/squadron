import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeHome, resetDir, tempHome, writeJson } from '../helpers';
import { MAX_TEXT } from '../../core/coordination/guards';
import type { WaitMember, WaitRecord } from '../../core/coordination/wait';

type Wait = typeof import('../../core/coordination/wait');
type Paths = typeof import('../../core/paths');

let wait: Wait;
let paths: Paths;

let home: string;

before(async () => {
  // Imported after the home moves: `core/paths.ts` resolves its directories
  // once, at load, and the store half of this suite writes into them.
  home = await tempHome();
  paths = await import('../../core/paths');
  wait = await import('../../core/coordination/wait');
});

after(async () => {
  await disposeHome(home);
});

/**
 * The wait's predicate, against a board a test wrote.
 *
 * Every case here is a scenario in `docs/PRD/PRD_shipped_wait.md` §7, and that is
 * the reason the rule is pure: a four-way fan-out with one member killed
 * halfway is not something anybody can reproduce twice by hand, and the ways it
 * goes wrong — hanging forever, or firing on half-written output — both look
 * like nothing happening.
 *
 * **This file importing the module is itself the `vscode`-free assertion.**
 * `node --test` runs outside the IDE, so there is no `vscode` to resolve: a
 * module that reached for one, at any depth, would fail to load right here.
 */

const NOW = 1_700_000_000_000;

function registered(over: number[], extra: Partial<WaitRecord> = {}): WaitRecord {
  return {
    schema: 1,
    id: `w-${over.join('-')}`,
    requesterPid: 100,
    requesterSessionId: 'requester-session',
    members: over,
    createdAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
    ...extra
  };
}

const done = (pid: number, name = `s${pid}`): WaitMember => ({
  pid,
  name,
  status: 'idle',
  ended: false
});
const busy = (pid: number, name = `s${pid}`): WaitMember => ({
  pid,
  name,
  status: 'busy',
  ended: false
});

describe('a wait on a pass whose process table was not complete', () => {
  // A failed or incomplete read drops twins: an owned idle session then reads
  // with no command, and another window's member is off the board. Neither is
  // evidence the command finished or the member went.
  it('does not report an idle member finished, nor a missing one stopped', () => {
    for (const board of [[done(201)], [] as WaitMember[]]) {
      assert.deepEqual(
        wait.resolveWaits({ waits: [registered([201])], board, processes: 'unknown', now: NOW }),
        []
      );
    }
  });

  it('still resolves on a member whose native exit this window watched', () => {
    const out = wait.resolveWaits({
      waits: [registered([201])],
      board: [{ ...done(201), ended: true }],
      processes: 'unknown',
      now: NOW
    });
    assert.deepEqual(out[0]?.members, [{ pid: 201, name: 's201', state: 'stopped' }]);
  });

  it('holds a workflow wait the board judged ready', () => {
    assert.deepEqual(
      wait.resolveWaits({
        waits: [registered([201], { workflow: { workflowId: 'ship' } })],
        board: [done(201)],
        workflowStates: new Map([['w-201', { state: 'ready' }]]),
        processes: 'unknown',
        now: NOW
      }),
      []
    );
  });

  it('delivers at the deadline, with what it could not judge as unread', () => {
    const out = wait.resolveWaits({
      waits: [registered([201, 202, 203], { expiresAt: NOW })],
      board: [done(201), { ...done(203), ended: true }],
      processes: 'unknown',
      now: NOW
    });
    assert.equal(out[0]?.expired, true);
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [201, 'unread'],
        [202, 'unread'],
        [203, 'stopped']
      ]
    );
  });
});

describe('a wait converges once, and says how each member finished', () => {
  it('preserves ordinary session outcomes when coalescing workflow waits', () => {
    const workflow = registered([201, 202], { id: 'workflow', workflow: { workflowId: 'ship' } });
    const ordinary = registered([201, 203], { id: 'ordinary' });
    const out = wait.resolveWaits({
      waits: [workflow, ordinary],
      board: [done(201), busy(202)],
      workflowStates: new Map([['workflow', { state: 'ready' }]]),
      now: NOW
    });
    assert.equal(out.length, 1);
    assert.match(out[0]?.text ?? '', /201 s201: finished/);
    assert.match(out[0]?.text ?? '', /202 s202: ready to check the next step/);
    assert.match(out[0]?.text ?? '', /203: stopped without finishing/);
    assert.deepEqual(
      out[0]?.members.find((member) => member.pid === 201),
      { pid: 201, name: 's201', state: 'reported' }
    );
  });

  it('does not treat idle as completion of a workflow dependency', () => {
    assert.deepEqual(
      wait.resolveWaits({
        waits: [registered([201], { workflow: { workflowId: 'ship', armedAt: NOW } })],
        board: [done(201)],
        now: NOW
      }),
      []
    );
  });

  it('does not resolve while one member is still working (S1, before)', () => {
    const out = wait.resolveWaits({
      waits: [registered([201, 202, 203])],
      board: [done(201), done(202), busy(203)],
      now: NOW
    });
    assert.deepEqual(out, []);
  });

  it('resolves once, naming all three, when the last one lands (S1)', () => {
    const out = wait.resolveWaits({
      waits: [registered([201, 202, 203])],
      board: [done(201), done(202), done(203)],
      now: NOW
    });
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.equal(only.requesterPid, 100);
    assert.equal(only.expired, false);
    assert.deepEqual(
      only.members.map((m) => [m.pid, m.state]),
      [
        [201, 'reported'],
        [202, 'reported'],
        [203, 'reported']
      ]
    );
    // Every member is in the body, because that is where a reader can match
    // them against `squadron-list` — the recorded author is this window, and
    // a window id matches no row there.
    for (const pid of [201, 202, 203]) {
      assert.match(only.text, new RegExp(String(pid)));
    }
    assert.match(only.text, /^All 3 sessions you were waiting on have finished\./);
  });

  it('agrees with itself about one member', () => {
    // The count is the subject of that sentence, and a wait over one session
    // is the common case — a fan-out of one, or the last of a fold.
    const out = wait.resolveWaits({
      waits: [registered([201])],
      board: [done(201)],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.match(only.text, /^All 1 session you were waiting on has finished\./);
  });

  it('holds a member that is idle with a command still running', () => {
    // `hasCommand` is `idle` wearing `done`'s face. Firing here would collect
    // half-written output, which is the failure the status word cannot see.
    const out = wait.resolveWaits({
      waits: [registered([201])],
      board: [{ pid: 201, name: 's201', status: 'idle', hasCommand: true, ended: false }],
      now: NOW
    });
    assert.deepEqual(out, []);
  });

  it('holds a member blocked on a dialog', () => {
    // Mid-turn, and about to continue the moment somebody answers.
    const out = wait.resolveWaits({
      waits: [registered([201])],
      board: [{ pid: 201, name: 's201', status: 'waiting', ended: false }],
      now: NOW
    });
    assert.deepEqual(out, []);
  });

  it('resolves on a member that is gone, and names it as stopped (S2)', () => {
    // A session that was stopped or went with its window is never going to be
    // idle. Unresolved, it hangs the wait forever — worse than the problem.
    const out = wait.resolveWaits({
      waits: [registered([201, 202, 203])],
      board: [done(201), done(203)],
      now: NOW
    });
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.equal(only.expired, false);
    assert.deepEqual(
      only.members.map((m) => [m.pid, m.state]),
      [
        [201, 'reported'],
        [202, 'stopped'],
        [203, 'reported']
      ]
    );
    assert.match(only.text, /202: stopped without finishing/);
    // The head is read before the line under it, so it must not claim they all
    // finished while 202 says it did not.
    assert.match(only.text, /^Your wait over 3 sessions is over\. Not all of them finished\./);
  });

  it('does not resolve on a member nobody can read (S3, before the deadline)', () => {
    // `unknown` is a twin whose published record never landed. Folding it into
    // idle would report work as finished on the strength of a missing file.
    const out = wait.resolveWaits({
      waits: [registered([201, 202])],
      board: [done(201), { pid: 202, name: 's202', status: 'unknown', ended: false }],
      now: NOW
    });
    assert.deepEqual(out, []);
  });

  it('ends that wait at its deadline, with the member named unread (S3)', () => {
    const record = registered([201, 202], { expiresAt: NOW - 1 });
    const out = wait.resolveWaits({
      waits: [record],
      board: [done(201), { pid: 202, name: 's202', status: 'unknown', ended: false }],
      now: NOW
    });
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.equal(only.expired, true);
    assert.deepEqual(
      only.members.map((m) => [m.pid, m.state]),
      [
        [201, 'reported'],
        [202, 'unread']
      ]
    );
    assert.match(only.text, /reached its deadline/);
    // The member that did finish is still reported as having finished: expiry
    // changes the first line, not the accounting.
    assert.match(only.text, /201 s201: finished/);
  });

  it('resolves on a member whose process died, though it is still on the board (S8)', () => {
    // The 2026-08-22 live run: a member killed mid-turn resolved correctly and
    // **339 seconds late** (`src/test/live_session/wait_convergence.md`, row
    // 11). An owned session that dies is kept on the board on purpose —
    // `host/sessions.ts` only forgets one when a reader stops or dismisses it —
    // and `toSession` folds it to `unknown`, so it is neither absent (S2) nor
    // readable (S3) and nothing ended the wait until the entry was removed.
    const out = wait.resolveWaits({
      waits: [registered([201, 202])],
      board: [done(201), { pid: 202, name: 's202', status: 'unknown', ended: true }],
      now: NOW
    });
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.equal(only.expired, false);
    assert.deepEqual(
      only.members.map((m) => [m.pid, m.state]),
      [
        [201, 'reported'],
        [202, 'stopped']
      ]
    );
    // Named, where S2's absent member can only be a pid: the board still has
    // the card, so the requester gets told which of its peers this was.
    assert.match(only.text, /202 s202: stopped without finishing/);
    assert.match(only.text, /^Your wait over 2 sessions is over\. Not all of them finished\./);
  });

  it('does not fold a dead member into finished, whatever its last status was (S8)', () => {
    // **This board cannot occur today**, and the test is for the day it can:
    // `toSession` folds an exited session to `unknown`, so `ended` currently
    // arrives with the word already unreadable. What is pinned is that the two
    // are independent — `ended` is read before the status word, so a fold that
    // stopped overwriting it could not make a dead member read as finished.
    // Without this the case above passes with the branch in either order.
    const out = wait.resolveWaits({
      waits: [registered([201])],
      board: [{ pid: 201, name: 's201', status: 'idle', ended: true }],
      now: NOW
    });
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.deepEqual(
      only.members.map((m) => [m.pid, m.state]),
      [[201, 'stopped']]
    );
  });

  it('leaves a wait that already could not be delivered where it is (S6)', () => {
    // The requester is the one party that cannot be told, so the record stays
    // on disk to be read. Re-evaluating it would remake the same refusal
    // against the same board, once per frame for the life of the wait.
    const out = wait.resolveWaits({
      waits: [registered([201], { failed: { reason: 'at 85% of its context', at: NOW } })],
      board: [done(201)],
      now: NOW
    });
    assert.deepEqual(out, []);
  });

  it('coalesces two of one requester’s waits into one message (S7)', () => {
    const out = wait.resolveWaits({
      waits: [registered([201, 202, 203]), registered([204, 205])],
      board: [done(201), done(202), done(203), done(204), done(205)],
      now: NOW
    });
    // One resolution, so one send, so one wake — the feature's own promise
    // applied to itself, and what keeps the pair cap out of reach.
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.equal(only.waits.length, 2);
    assert.deepEqual(
      only.members.map((m) => m.pid),
      [201, 202, 203, 204, 205]
    );
  });

  it('names a member shared by two of them once', () => {
    const out = wait.resolveWaits({
      waits: [registered([201, 202]), registered([202, 203])],
      board: [done(201), done(202), done(203)],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.deepEqual(
      only.members.map((m) => m.pid),
      [201, 202, 203]
    );
  });

  it('keeps two requesters’ waits apart', () => {
    const out = wait.resolveWaits({
      waits: [registered([201]), registered([202], { requesterPid: 101, id: 'other' })],
      board: [done(201), done(202)],
      now: NOW
    });
    assert.deepEqual(out.map((r) => r.requesterPid).sort(), [100, 101]);
  });
});

/**
 * The store, on a real disk under a temporary home.
 *
 * `claims.ts` is the idiom, and its lesson is the one case here that is not
 * bookkeeping: a record that fails the narrowing is **removed**, not skipped.
 * Skipped, a wait with no `expiresAt` would compare false against every clock,
 * so nothing would ever resolve it and nothing would ever sweep it — the
 * immortal file that made a dead window look live for a fortnight.
 */
describe('the one clock', () => {
  // Every trigger the resolver has fires on activity, and expiry is needed
  // precisely when there is none. This is the arithmetic behind that timer.
  it('answers nothing at all when nothing is pending', () => {
    // The whole of "an idle machine does no work": no answer, so no timer.
    assert.equal(wait.nextDeadline([], NOW), undefined);
  });

  it('takes the deadline that comes first', () => {
    assert.equal(
      wait.nextDeadline(
        [
          registered([201], { expiresAt: NOW + 5_000 }),
          registered([202], { expiresAt: NOW + 1_000 }),
          registered([203], { expiresAt: NOW + 9_000 })
        ],
        NOW
      ),
      NOW + 1_000
    );
  });

  it('arms nothing for a wait that could not be delivered', () => {
    // Nothing will evaluate it again, so a timer for it would wake the machine
    // to do nothing.
    assert.equal(
      wait.nextDeadline(
        [registered([201], { failed: { reason: 'too full', at: NOW }, expiresAt: NOW + 1_000 })],
        NOW
      ),
      undefined
    );
  });

  it('never answers the past', () => {
    // A deadline already behind us belongs to a wait the pass that just ran
    // should have resolved. Answered as now, so the caller arms a timer that
    // fires once rather than looping on a negative delay.
    assert.equal(wait.nextDeadline([registered([201], { expiresAt: NOW - 60_000 })], NOW), NOW);
  });
});

describe('a wake whose send failed', () => {
  // Measured against the first cut (2026-11-07 review): retrying off
  // `nextDeadline` slept a converged wait until its expiry, ten minutes away,
  // and a global floor pushed an unrelated two-second expiry to fifteen.
  const none = () => undefined;

  it('retries a wait that converged early at its retry time, not its expiry', () => {
    const converged = registered([201], { expiresAt: NOW + 600_000 });
    const retryAt = new Map([[converged.id, NOW + wait.WAKE_RETRY_MS]]);
    assert.equal(
      wait.passDeadline({ pending: [converged], retryAt, checkAt: none, now: NOW }),
      NOW + wait.WAKE_RETRY_MS
    );
  });

  it('does not delay an unrelated earlier deadline', () => {
    const failed = registered([201], { expiresAt: NOW - 1_000 });
    const other = registered([202], { expiresAt: NOW + 2_000 });
    const retryAt = new Map([[failed.id, NOW + wait.WAKE_RETRY_MS]]);
    assert.equal(
      wait.passDeadline({ pending: [failed, other], retryAt, checkAt: none, now: NOW }),
      NOW + 2_000
    );
  });

  it('does not bring an overdue held wait back at once', () => {
    const failed = registered([201], { expiresAt: NOW - 1_000 });
    const retryAt = new Map([[failed.id, NOW + wait.WAKE_RETRY_MS]]);
    assert.equal(
      wait.passDeadline({ pending: [failed], retryAt, checkAt: () => NOW, now: NOW }),
      NOW + wait.WAKE_RETRY_MS
    );
  });

  it('holds the wake through a pass that comes back early, then frees it', () => {
    // A change callback already queued runs the pass whatever was scheduled.
    const failed = registered([201]);
    const retryAt = new Map([[failed.id, NOW + wait.WAKE_RETRY_MS]]);
    assert.equal(wait.heldUntil([failed], retryAt, NOW + 1_000), NOW + wait.WAKE_RETRY_MS);
    assert.equal(wait.heldUntil([failed], retryAt, NOW + wait.WAKE_RETRY_MS), undefined);
    assert.equal(wait.heldUntil([registered([202])], retryAt, NOW + 1_000), undefined);
  });

  it('holds a wait folded beside a held one until the same time', () => {
    // One requester: A failed at NOW, B expires at NOW + 2 s, and the resolver
    // folds both into one resolution at that pass (review round 2).
    const a = registered([201]);
    const b = registered([202], { expiresAt: NOW + 2_000 });
    const folded = wait.resolveWaits({
      waits: [a, b],
      board: [],
      workflowStates: new Map(),
      processes: 'complete',
      running: new Set(),
      retired: new Set(),
      records: 'complete',
      reports: [],
      now: NOW + 2_000
    } as unknown as Parameters<typeof wait.resolveWaits>[0]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0]?.waits.length, 2);
    const retryAt = new Map([[a.id, NOW + wait.WAKE_RETRY_MS]]);
    const until = wait.heldUntil(folded[0]?.waits ?? [], retryAt, NOW + 2_000);
    assert.equal(until, NOW + wait.WAKE_RETRY_MS);
    for (const one of folded[0]?.waits ?? []) retryAt.set(one.id, until);
    assert.equal(
      wait.passDeadline({ pending: [a, b], retryAt, checkAt: () => undefined, now: NOW + 2_000 }),
      NOW + wait.WAKE_RETRY_MS
    );
  });
});

describe('a member’s report rides its wait', () => {
  const said = (pid: number, at: number, payload: string) => ({
    id: `r-${pid}-${at}`,
    waitId: 'w1',
    senderPid: pid,
    payload,
    at
  });

  it('puts each member’s own words under its own line (S1)', () => {
    // The measured 2026-08-26 run, delivered as one message instead of four.
    const out = wait.resolveWaits({
      waits: [registered([201, 202], { id: 'w1' })],
      board: [done(201, 'wait-exp A'), done(202, 'wait-exp B')],
      reports: [
        said(201, NOW - 3_000, 'child A done, count in /tmp/wait-exp/a.md'),
        said(202, NOW - 2_000, 'child B starting'),
        said(202, NOW - 1_000, 'child B done (note: src/core/frames.ts does not exist)')
      ],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.deepEqual(only.unattached, []);
    assert.equal(
      only.text.split('\n').slice(0, 6).join('\n'),
      [
        'All 2 sessions you were waiting on have finished.',
        '',
        '- 201 wait-exp A: finished',
        '    child A done, count in /tmp/wait-exp/a.md',
        '- 202 wait-exp B: finished',
        '    child B starting'
      ].join('\n')
    );
  });

  it('keeps a member’s reports in the order they were accepted', () => {
    // Out of order here, and in `at` order in the message: a correction that
    // read before the thing it corrects is worse than either of them alone.
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1' })],
      board: [done(201)],
      reports: [said(201, NOW - 1_000, 'second'), said(201, NOW - 9_000, 'first')],
      now: NOW
    });
    assert.deepEqual(out[0]?.members[0]?.reports, ['first', 'second']);
  });

  it('reads only the reports of the records it is resolving', () => {
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1' })],
      board: [done(201)],
      reports: [{ ...said(201, NOW - 1_000, 'another wait’s'), waitId: 'w2' }],
      now: NOW
    });
    assert.deepEqual(out[0]?.members[0]?.reports, undefined);
    assert.doesNotMatch(String(out[0]?.text), /another wait/);
  });

  it('indents every line of a report that spans several', () => {
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1' })],
      board: [done(201)],
      reports: [said(201, NOW - 1_000, 'one\ntwo')],
      now: NOW
    });
    assert.match(String(out[0]?.text), /\n {4}one\n {4}two\n/);
  });

  it('rides an expired convergence rather than being released (5.5, narrowed)', () => {
    // Expiry is a resolution and not a deletion — `resolveWaits` says so above
    // — so the message goes out either way and the words may as well be on it.
    // Releasing them instead would cost N wakes to carry what one already does.
    const out = wait.resolveWaits({
      waits: [registered([201, 202], { id: 'w1', expiresAt: NOW - 1 })],
      board: [done(201), busy(202)],
      reports: [said(202, NOW - 1_000, 'half way through')],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.equal(only.expired, true);
    assert.deepEqual(only.unattached, []);
    assert.match(only.text, /half way through/);
  });

  it('does not call a member that sent words “never reported”', () => {
    // `never reported` printed directly above that member's own report reads as
    // a bug in the message. The state is about finishing; the word has to stop
    // claiming they were silent.
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1', expiresAt: NOW - 1 })],
      board: [busy(201)],
      reports: [said(201, NOW - 1_000, 'still going')],
      now: NOW
    });
    const [only] = out;
    assert.equal(only?.members[0]?.state, 'unread');
    assert.doesNotMatch(String(only?.text), /never reported/);
  });

  it('still says “never reported” about one that really was silent', () => {
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1', expiresAt: NOW - 1 })],
      board: [busy(201)],
      now: NOW
    });
    assert.match(String(out[0]?.text), /never reported/);
  });

  it('hands back what will not fit rather than composing a message that is refused', () => {
    // The convergence is run through `checkSend` by `host/waits.ts`, and
    // `checkSend` refuses over `MAX_TEXT`. One legal report may be that long on
    // its own, so a per-member *count* bounds nothing that matters here: over
    // the limit is refused, and refused is `markFailed`, which is the most
    // broken path the feature has.
    // Two that each fit alone and cannot both fit, so the case does not depend
    // on the exact length of the prose around them.
    const half = 'x'.repeat(Math.floor(MAX_TEXT / 2));
    const out = wait.resolveWaits({
      waits: [registered([201, 202], { id: 'w1' })],
      board: [done(201), done(202)],
      reports: [said(201, NOW - 2_000, half), said(202, NOW - 1_000, `${half}-mine`)],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.ok(only.text.length <= MAX_TEXT, `composed ${only.text.length} over ${MAX_TEXT}`);
    // The earlier one rode; the later one came back whole.
    assert.deepEqual(only.members[0]?.reports, [half]);
    assert.deepEqual(
      only.unattached.map((r) => r.payload),
      [`${half}-mine`]
    );
  });

  it('drops no report on the floor when nothing fits at all', () => {
    const out = wait.resolveWaits({
      waits: [registered([201], { id: 'w1' })],
      board: [done(201)],
      reports: [said(201, NOW - 1_000, 'y'.repeat(MAX_TEXT + 1))],
      now: NOW
    });
    const [only] = out;
    assert.ok(only);
    assert.ok(only.text.length <= MAX_TEXT);
    assert.equal(only.unattached.length, 1);
  });

  it('leaves the message byte-for-byte unchanged when nothing is parked', () => {
    const board = [done(201), done(202)];
    const waits = [registered([201, 202], { id: 'w1' })];
    const withNone = wait.resolveWaits({ waits, board, reports: [], now: NOW });
    const withNothingSaid = wait.resolveWaits({ waits, board, now: NOW });
    assert.equal(withNone[0]?.text, withNothingSaid[0]?.text);
  });
});

describe('the waits on disk', () => {
  const record = (over: Partial<WaitRecord> = {}): WaitRecord => ({
    schema: 1,
    id: 'w1',
    requesterPid: 100,
    requesterSessionId: 'requester-session',
    members: [201, 202],
    createdAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
    ...over
  });

  async function clear(): Promise<void> {
    await resetDir(paths.WAITS_DIR);
  }

  it('round-trips a registration', async () => {
    await clear();
    assert.equal(await wait.writeWait(record()), true);
    assert.deepEqual(await wait.readWaits(), [record()]);
  });

  it('round-trips workflow identity and rejects malformed dependency waits', async () => {
    await clear();
    const workflow = record({ workflow: { workflowId: 'ship', armedAt: NOW } });
    assert.equal(await wait.writeWait(workflow), true);
    assert.deepEqual(await wait.readWaits(), [workflow]);
    for (const invalid of [null, {}, { workflowId: '' }, { workflowId: 'ship', armedAt: 'now' }]) {
      await writeJson(path.join(paths.WAITS_DIR, 'w1.json'), { ...record(), workflow: invalid });
      assert.deepEqual(await wait.readWaits(), []);
    }
    await writeJson(path.join(paths.WAITS_DIR, 'w1.json'), {
      ...workflow,
      requesterSessionId: undefined
    });
    assert.deepEqual(await wait.readWaits(), []);
  });

  it('forgets one by id', async () => {
    await clear();
    await wait.writeWait(record());
    await wait.writeWait(record({ id: 'w2' }));
    await wait.dropWait('w1');
    assert.deepEqual(
      (await wait.readWaits()).map((w) => w.id),
      ['w2']
    );
  });

  it('removes a record with no deadline as it reads it', async () => {
    await clear();
    const { expiresAt, ...lame } = record();
    void expiresAt;
    await writeJson(path.join(paths.WAITS_DIR, 'lame.json'), lame);
    assert.deepEqual(await wait.readWaits(), []);
    assert.deepEqual(await fs.readdir(paths.WAITS_DIR), []);
  });

  it('removes a record that is not one of ours', async () => {
    await clear();
    // `schema` is checked rather than assumed: a later record type sharing this
    // directory must not read as a wait.
    await writeJson(path.join(paths.WAITS_DIR, 'other.json'), { ...record(), schema: 2 });
    assert.deepEqual(await wait.readWaits(), []);
    assert.deepEqual(await fs.readdir(paths.WAITS_DIR), []);
  });

  it('takes the id from the filename, not from the field inside', async () => {
    await clear();
    // Written equal; edited apart, a resolution would otherwise delete the file
    // the field names instead of the one it just read.
    await writeJson(path.join(paths.WAITS_DIR, 'real.json'), record({ id: 'somewhere-else' }));
    const [only] = await wait.readWaits();
    assert.equal(only?.id, 'real');
    await wait.dropWait('real');
    assert.deepEqual(await fs.readdir(paths.WAITS_DIR), []);
  });

  it('keeps an expired record for the resolver rather than sweeping it', async () => {
    await clear();
    // Expiry is a resolution, not a deletion: the requester is owed the
    // sentence naming the members that never reported.
    await wait.writeWait(record({ expiresAt: NOW - 1 }));
    assert.equal((await wait.readWaits()).length, 1);
  });

  it('sweeps what a dead host left behind', async () => {
    await clear();
    await wait.writeWait(record());
    const file = path.join(paths.WAITS_DIR, 'w1.json');
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await fs.utimes(file, new Date(old), new Date(old));
    await wait.pruneWaits();
    assert.deepEqual(await fs.readdir(paths.WAITS_DIR), []);
  });

  it('is a store the home tree makes on activate', () => {
    // `prune.ts` sweeps no name it does not know and `ensureHome` creates from
    // this list, so a store left out of it is a directory that may not exist
    // and never gets swept.
    assert.ok(paths.STORE_DIRS.includes(paths.WAITS_DIR));
  });
});
