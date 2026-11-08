import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { disposeHome, modeBitsSkip, resetDir, tempHome } from '../helpers';
import type { SessionHandle } from '../../core/adapter';
import type { Request } from '../../core/coordination/requests';
import type { Recipient } from '../../core/coordination/send';
import type { WaitRecord, WaitResolution } from '../../core/coordination/wait';
import type { LiveState, PendingRequest } from '../../core/live';

type Admit = typeof import('../../core/coordination/admit');
type Actions = typeof import('../../core/coordination/actions');
type Reports = typeof import('../../core/coordination/reports');
type Waits = typeof import('../../core/coordination/wait');
type Paths = typeof import('../../core/paths');
type Send = typeof import('../../core/coordination/send');
type Owned = typeof import('../../core/coordination/serve_owned');

let admit: Admit;
let actions: Actions;
let reports: Reports;
let waits: Waits;
let paths: Paths;
let send: Send;
let owned: Owned;
let home: string;
let refusal: typeof import('../../core/adapter').refusal;

before(async () => {
  // `core/paths.ts` resolves its directories once, at load.
  home = await tempHome();
  paths = await import('../../core/paths');
  admit = await import('../../core/coordination/admit');
  actions = await import('../../core/coordination/actions');
  reports = await import('../../core/coordination/reports');
  waits = await import('../../core/coordination/wait');
  send = await import('../../core/coordination/send');
  owned = await import('../../core/coordination/serve_owned');
  ({ refusal } = await import('../../core/adapter'));
});

after(() => disposeHome(home));

async function fresh(): Promise<void> {
  WINDOW = `window-${++windows}`;
  await resetDir(paths.ACTIONS_DIR);
  await resetDir(paths.REPORTS_DIR);
  await resetDir(paths.WAITS_DIR);
}

const PID = 7;
const STARTED = 70_000;
/** Per test: the burst guard also counts this process's recent actions in memory. */
let WINDOW = 'window-0';
let windows = 0;
const mine = async () =>
  (await actions.readActions()).filter((action) => action.windowId === WINDOW);
const SENDER = 'sender-session';
const SENDER_PID = 8;

const question: PendingRequest = {
  requestId: 'ask-1',
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [{ question: 'Which colour?', header: 'Colour', options: [], multiSelect: false }]
};

const state = (pending: PendingRequest[] = []): LiveState => ({
  cwd: '/work/app',
  startedAt: STARTED,
  sessionId: 'target-session',
  status: 'busy',
  queued: [],
  pending,
  running: true,
  turnsEnded: 0
});

/** A handle recording what reached it, in order, into a shared log. */
function handle(
  live: LiveState,
  log: string[],
  over: Partial<NonNullable<SessionHandle['messages']>> = {}
) {
  const sent: { text: string; describe?: string; ahead?: boolean; correlation?: string }[] = [];
  const owned = {
    state: live,
    messages: {
      images: true,
      pending: () => live.running || live.queued.length > 0,
      send(
        text: string,
        _images?: unknown,
        describe?: string,
        ahead?: boolean,
        _t?: unknown,
        correlation?: string
      ) {
        log.push(`send:${describe ?? text}`);
        sent.push({ text, describe, ahead, correlation });
        live.queued.push({ id: `q${live.queued.length}`, text, queuedAt: 0 });
      },
      dismiss: () => false,
      sendNow() {
        log.push('sendNow');
        live.queued.length = 0;
        return Promise.resolve();
      },
      ...over
    }
  } as unknown as SessionHandle;
  return { owned, sent };
}

function port(
  handles: (pid: number) => SessionHandle | undefined,
  over: Partial<import('../../core/coordination/admit').AdmissionPort> = {}
) {
  return {
    owned: handles,
    target: (pid: number): Recipient | undefined =>
      handles(pid) ? { pid, updatedAt: Date.now() } : undefined,
    windowId: WINDOW,
    orchestrators: () => true,
    ...over
  };
}

const sendRequest = (over: Partial<Extract<Request, { kind: 'send' }>> = {}) => ({
  kind: 'send' as const,
  id: 'req-1',
  createdAt: 0,
  windowId: WINDOW,
  pid: PID,
  startedAt: STARTED,
  text: 'hello',
  via: 'verb' as const,
  from: SENDER,
  ...over
});

const answerRequest = (over: Partial<Extract<Request, { kind: 'answer' }>> = {}) => ({
  kind: 'answer' as const,
  id: 'req-2',
  createdAt: 0,
  windowId: WINDOW,
  pid: PID,
  startedAt: STARTED,
  askId: 'ask-1',
  text: 'Blue',
  from: SENDER,
  ...over
});

const silent = (): void => {};

async function openWait(members = [SENDER_PID]): Promise<WaitRecord> {
  const record: WaitRecord = {
    schema: 1,
    id: 'w1',
    requesterPid: PID,
    members,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000
  };
  await waits.writeWait(record);
  return record;
}

async function park(n: number, at: number): Promise<void> {
  await reports.writeReport({
    schema: 1,
    id: `r${n}`,
    waitId: 'w1',
    requesterPid: PID,
    senderPid: SENDER_PID,
    senderSessionId: SENDER,
    payload: `held ${n}`,
    at
  });
}

describe('admit: send', () => {
  beforeEach(fresh);
  it('answers each precondition in order and delivers nothing', async () => {
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const none = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => undefined),
      silent
    );
    assert.deepEqual(none, { ok: false, reason: owned.NOT_HERE });
    const moved = await admit.admit(
      { kind: 'send', request: sendRequest({ startedAt: STARTED + 5_000 }) },
      port(() => h),
      silent
    );
    assert.deepEqual(moved, { ok: false, reason: owned.GONE });
    const mute = { ...h, messages: undefined } as SessionHandle;
    const noPipe = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => mute),
      silent
    );
    assert.deepEqual(noPipe, { ok: false, reason: refusal('messages') });
    const noTarget = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => h, { target: () => undefined }),
      silent
    );
    assert.deepEqual(noTarget, { ok: false, reason: owned.GONE });
    assert.deepEqual(log, []);
    assert.equal((await mine()).length, 0);
  });

  it('refuses with the guard reason when Orchestration is off', async () => {
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => h, { orchestrators: () => false }),
      silent
    );
    assert.equal(reply.ok, false);
    assert.deepEqual(log, []);
  });

  it('delivers the decided text with its correlation and records one action with its requestId', async () => {
    const log: string[] = [];
    const { owned: h, sent } = handle(state(), log);
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ correlation: 'c-1' }) },
      port(() => h),
      silent
    );
    assert.equal(reply.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, send.wrapMessage('hello', SENDER));
    assert.equal(sent[0]?.describe, 'hello');
    assert.equal(sent[0]?.correlation, 'c-1');
    const recorded = await mine();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.kind, 'send');
    assert.equal((recorded[0] as { requestId?: string }).requestId, 'req-1');
  });

  it('answers gone when the handle is replaced across the actions read', async () => {
    const log: string[] = [];
    const a = handle(state(), log).owned;
    const b = handle(state(), log).owned;
    let calls = 0;
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => (calls++ === 0 ? a : b), { target: (pid) => ({ pid, updatedAt: Date.now() }) }),
      silent
    );
    assert.deepEqual(reply, { ok: false, reason: owned.GONE });
    assert.deepEqual(log, []);
  });

  it('runs the interrupt after the chain, swallowing its refusal and re-reading queued', async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const live = state();
    const { owned: h } = handle(live, log, {
      sendNow() {
        log.push('sendNow');
        // Capture still holds one row after send-now returns.
        live.queued.length = 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => {
          throw new Error('pipe closed');
        });
      }
    });
    const first = admit.admit(
      { kind: 'send', request: sendRequest({ interrupt: true }) },
      port(() => h),
      silent
    );
    // A second admission completes while the first's sendNow hangs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = handle(state(), log).owned;
    const second = await admit.admit(
      { kind: 'send', request: sendRequest({ pid: 9, id: 'req-9' }) },
      port((pid) => (pid === 9 ? other : h)),
      silent
    );
    assert.equal(second.ok, true);
    release();
    const reply = await first;
    assert.equal(reply.ok, true);
    assert.equal(reply.queued, 1);
    assert.deepEqual(log.slice(0, 2), ['send:hello', 'sendNow']);
  });

  it('skips the interrupt when the handle was replaced before it', async () => {
    const log: string[] = [];
    const a = handle(state(), log).owned;
    const b = handle(state(), log).owned;
    let current = a;
    const wrapped = {
      ...a,
      messages: {
        ...a.messages!,
        send: (...args: Parameters<NonNullable<SessionHandle['messages']>['send']>) => {
          const done = a.messages!.send(...args);
          current = b;
          return done;
        }
      }
    } as SessionHandle;
    current = wrapped;
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ interrupt: true }) },
      port(() => current, { target: (pid) => ({ pid, updatedAt: Date.now() }) }),
      silent
    );
    assert.equal(reply.ok, true);
    assert.deepEqual(log, ['send:hello']);
  });

  it('reads message facts after the tail, on success and refusal, only when the start matches', async () => {
    const fact = { correlation: 'c-1', phase: 'queued' } as const;
    const log: string[] = [];
    // The answer's reply is admit's own, not the routed Act, so only the final
    // read can put facts on it; sendNow sets them, so an early read sees none.
    const live = state([question]);
    const { owned: h } = handle(live, log, {
      sendNow() {
        live.messageFacts = [fact];
        return Promise.resolve();
      }
    });
    const answered = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => h),
      silent
    );
    assert.deepEqual(answered, { ok: true, messageFacts: [fact] });
    const refused = await admit.admit(
      { kind: 'send', request: sendRequest() },
      port(() => h, { orchestrators: () => false }),
      silent
    );
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.messageFacts, [fact]);
    const replaced = { ...h, state: { ...live, startedAt: STARTED + 5_000 } } as SessionHandle;
    let calls = 0;
    const moved = await admit.admit(
      { kind: 'answer', request: answerRequest({ id: 'req-3' }) },
      port(() => (++calls === 1 ? h : replaced), {
        target: (pid) => ({ pid, updatedAt: Date.now() })
      }),
      silent
    );
    assert.equal(moved.messageFacts, undefined);
  });
});

describe('admit: parking', () => {
  beforeEach(fresh);
  it('parks a waited member’s report: nothing delivered, one action, heldForWait', async () => {
    await openWait();
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
      port((pid) => (pid === PID ? h : undefined)),
      silent
    );
    assert.equal(reply.ok, true);
    assert.equal(reply.heldForWait, PID);
    assert.deepEqual(log, []);
    assert.equal((await reports.readReports()).length, 1);
    assert.equal((await mine()).length, 1);
  });

  it('delivers when no wait is open — not parked is not lost', async () => {
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
      port((pid) => (pid === PID ? h : undefined)),
      silent
    );
    assert.equal(reply.ok, true);
    assert.equal(reply.heldForWait, undefined);
    assert.deepEqual(log, ['send:hello']);
  });

  it('never parks an interrupt', async () => {
    await openWait();
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID, interrupt: true }) },
      port((pid) => (pid === PID ? h : undefined)),
      silent
    );
    assert.deepEqual(log, ['send:hello', 'sendNow']);
    assert.equal((await reports.readReports()).length, 0);
  });

  it('does not trust a sender pid whose handle names another session', async () => {
    await openWait();
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const impostor = handle({ ...state(), sessionId: 'someone-else' }, []).owned;
    await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
      port((pid) => (pid === PID ? h : pid === SENDER_PID ? impostor : undefined)),
      silent
    );
    assert.deepEqual(log, ['send:hello']);
  });

  it('at the cap releases the held reports oldest first, then this one', async () => {
    await openWait();
    const { REPORTS_PER_MEMBER } = await import('../../core/coordination/guards');
    // One clock. `Date.now()` inside the loop reorders the ages when a write
    // takes longer than the `n` offset, and the release is ordered by `at`.
    const at = Date.now();
    for (let n = REPORTS_PER_MEMBER; n >= 1; n--) await park(n, at - 10_000 + n);
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    const lines: string[] = [];
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
      port((pid) => (pid === PID ? h : undefined)),
      (line) => lines.push(line)
    );
    assert.equal(reply.ok, true);
    const expected = Array.from({ length: REPORTS_PER_MEMBER }, (_, i) => `send:held ${i + 1}`);
    assert.deepEqual(log, [...expected, 'send:hello']);
    assert.equal((await reports.readReports()).length, 0);
    assert.ok(lines.some((line) => line.includes('reached its cap')));
  });

  it(
    'flushes the member’s held reports ahead when a park will not write',
    { skip: modeBitsSkip },
    async () => {
      await openWait();
      await park(1, Date.now() - 1_000);
      await fs.chmod(paths.REPORTS_DIR, 0o500);
      try {
        const log: string[] = [];
        const { owned: h } = handle(state(), log);
        const reply = await admit.admit(
          { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
          port((pid) => (pid === PID ? h : undefined)),
          silent
        );
        assert.equal(reply.ok, true);
        assert.deepEqual(log, ['send:held 1', 'send:hello']);
      } finally {
        await fs.chmod(paths.REPORTS_DIR, 0o700);
      }
    }
  );

  it('answers gone when the handle is replaced across the park’s store reads', async () => {
    // A wait for another member: the stores are read, no park applies, and the
    // send falls back to delivery — after the re-check the replacement fails.
    await openWait([SENDER_PID + 1]);
    const log: string[] = [];
    const a = handle(state(), log).owned;
    const b = handle(state(), log).owned;
    let target = a;
    let replaceOnRead = true;
    const reply = await admit.admit(
      { kind: 'send', request: sendRequest({ fromPid: SENDER_PID }) },
      port(
        (pid) => {
          if (pid === SENDER_PID) {
            // trustedSender asks for the sender just before the store reads.
            if (replaceOnRead) {
              replaceOnRead = false;
              queueMicrotask(() => (target = b));
            }
            return undefined;
          }
          return target;
        },
        { target: (pid) => ({ pid, updatedAt: Date.now() }) }
      ),
      silent
    );
    assert.deepEqual(reply, { ok: false, reason: owned.GONE });
    assert.deepEqual(log, []);
  });
});

describe('admit: release', () => {
  beforeEach(fresh);
  it('stops at the first refusal, keeping that report and the later ones', async () => {
    await park(1, 1);
    await park(2, 2);
    await park(3, 3);
    const log: string[] = [];
    let n = 0;
    const { owned: h } = handle(state(), log, {
      send(_text, _images, describe) {
        log.push(`send:${describe ?? ''}`);
        if (++n === 2) throw new Error('pipe closed');
      }
    });
    const held = await reports.readReports();
    const result = await admit.release(held, h, 'test', silent);
    assert.equal(result.ok, false);
    assert.deepEqual(log, ['send:held 1', 'send:held 2']);
    assert.deepEqual((await reports.readReports()).map((r) => r.id).sort(), ['r2', 'r3']);
  });
});

describe('admit: answer', () => {
  beforeEach(fresh);
  it('refuses a closed question and a permission', async () => {
    const log: string[] = [];
    const closed = handle(state([]), log).owned;
    const none = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => closed),
      silent
    );
    assert.equal(none.ok, false);
    const perm = handle(state([{ requestId: 'ask-1', toolName: 'Write', ask: false }]), log).owned;
    const refused = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => perm),
      silent
    );
    assert.equal(refused.ok, false);
    assert.deepEqual(log, []);
  });

  it('delivers ahead, records askId and requestId, and replies exactly ok', async () => {
    const log: string[] = [];
    const { owned: h, sent } = handle(state([question]), log);
    const reply = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => h),
      silent
    );
    assert.deepEqual(reply, { ok: true });
    assert.equal(sent[0]?.ahead, true);
    assert.deepEqual(log.at(-1), 'sendNow');
    const [recorded] = await mine();
    assert.equal(recorded?.kind, 'answer');
    assert.equal((recorded as { askId?: string }).askId, 'ask-1');
    assert.equal((recorded as { requestId?: string }).requestId, 'req-2');
  });

  it('answers no longer open when the question closes across the actions read', async () => {
    const log: string[] = [];
    const live = state([question]);
    const { owned: h } = handle(live, log);
    let calls = 0;
    const reply = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(
        () => {
          if (++calls === 2) live.pending = [];
          return h;
        },
        { target: (pid) => ({ pid, updatedAt: Date.now() }) }
      ),
      silent
    );
    assert.deepEqual(reply, { ok: false, reason: 'That question is no longer open.' });
    assert.deepEqual(log, []);
  });

  it('skips the interrupt when the question closes during the send', async () => {
    const log: string[] = [];
    const live = state([question]);
    const { owned: h } = handle(live, log, {
      send(_text, _images, describe) {
        log.push(`send:${describe ?? ''}`);
        live.pending = [];
      }
    });
    const reply = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => h),
      silent
    );
    assert.equal(reply.ok, true);
    assert.equal(log.includes('sendNow'), false);
  });

  it('answers a throwing send as a refusal, not unsure, and records nothing', async () => {
    const log: string[] = [];
    const { owned: h } = handle(state([question]), log, {
      send() {
        throw new Error('pipe closed');
      }
    });
    const reply = await admit.admit(
      { kind: 'answer', request: answerRequest() },
      port(() => h),
      silent
    );
    assert.equal(reply.ok, false);
    assert.equal(reply.unsure, undefined);
    assert.equal((await mine()).length, 0);
  });
});

describe('admit: wait', () => {
  beforeEach(fresh);
  const resolution = (): WaitResolution => ({
    requesterPid: PID,
    waits: [],
    members: [],
    expired: false,
    text: 'all done',
    unattached: [],
    attached: []
  });

  it('refuses a requester with no handle, no pipe, or a guard refusal, and settles with it', async () => {
    const settled: string[] = [];
    const settle = (outcome: import('../../core/coordination/admit').WakeOutcome) => {
      settled.push(outcome.kind);
      return Promise.resolve();
    };
    const gone = await admit.admit(
      { kind: 'wait', resolution: resolution(), settle },
      port(() => undefined),
      silent
    );
    assert.equal(gone.kind, 'refused');
    const log: string[] = [];
    const mute = { ...handle(state(), log).owned, messages: undefined } as SessionHandle;
    const noPipe = await admit.admit(
      { kind: 'wait', resolution: resolution(), settle },
      port(() => mute),
      silent
    );
    assert.equal(noPipe.kind, 'refused');
    const h = handle(state(), log).owned;
    const stale = await admit.admit(
      { kind: 'wait', resolution: resolution(), settle },
      port(() => h, { target: (pid) => ({ pid, updatedAt: 0 }) }),
      silent
    );
    assert.equal(stale.kind, 'refused');
    assert.deepEqual(settled, ['refused', 'refused', 'refused']);
    assert.deepEqual(log, []);
  });

  it('answers undelivered with no action when the routed send fails', async () => {
    const { owned: h } = handle(state(), [], {
      send() {
        throw new Error('pipe closed');
      }
    });
    const outcome = await admit.admit(
      { kind: 'wait', resolution: resolution(), settle: () => Promise.resolve() },
      port(() => h),
      silent
    );
    assert.equal(outcome.kind, 'undelivered');
    assert.equal((await mine()).length, 0);
  });

  it('delivers, records a wait action, then settles inside the chain', async () => {
    const log: string[] = [];
    const { owned: h } = handle(state(), log);
    let concurrent: Promise<unknown> | undefined;
    const outcome = await admit.admit(
      {
        kind: 'wait',
        resolution: resolution(),
        settle: async () => {
          concurrent = admit.admit(
            { kind: 'send', request: sendRequest() },
            port(() => h),
            silent
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          log.push('settled');
        }
      },
      port(() => h),
      silent
    );
    await concurrent;
    assert.equal(outcome.kind, 'delivered');
    assert.deepEqual(log, ['send:all done', 'settled', 'send:hello']);
    const kinds = (await mine()).map((a) => a.kind).sort();
    assert.deepEqual(kinds, ['send', 'wait']);
  });
});
