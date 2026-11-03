import * as fixture from '../incoming_helpers';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import type { SessionVerbs, Started } from '../../core/bridge/bridge';
import type { SessionAddr, Watched } from '../../core/bridge/model';
import type { Reap, SignalEnd } from '../../core/control';
import type { Request, RequestBody } from '../../core/coordination/requests';
import type { RemoteStart, ServePort } from '../../core/coordination/serve_owned';
import type { LiveState, PendingRequest } from '../../core/live';
import type { BrandId, Decision, Session, WindowClaim } from '../../core/model';
import * as transcript from '../../core/transcript';
import type { Authored, Exchange } from '../../core/transcript';
import type { VerbPort } from '../../core/remote/verbs';
import { disposeHome, fakeClaude, tempHome, type FakeProcess } from '../helpers';

/** Loaded after `tempHome`, so every store resolves under the temp `HOME`. */
let ask: typeof import('../../core/coordination/ask');
let requests: typeof import('../../core/coordination/requests');
let serveOwned: typeof import('../../core/coordination/serve_owned');
let control: typeof import('../../core/control');
let scan: typeof import('../../core/scan');
let record: typeof import('../../core/record');
let paths: typeof import('../../core/paths');
let verbs: typeof import('../../core/remote/verbs');

const HERE = 'w-here';
const THERE = 'w-there';
const OLD = 'w-old';
const DEAD = 'w-dead';
const T0 = 1_700_000_000_000;

const say = (role: Authored['role'], text: string, extra: Partial<Authored> = {}): Authored => ({
  role,
  text,
  blocks: [{ text }],
  ...extra
});

const call = (name: string): Exchange => ({
  role: 'assistant',
  text: '',
  blocks: [{ call: { id: name, name, input: {} } }]
});

const question: PendingRequest = {
  requestId: 'ask-1',
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [{ question: 'Which colour?', header: 'Colour', options: [], multiSelect: false }]
};

const permission: PendingRequest = { requestId: 'perm-1', toolName: 'Write', ask: false };

type Handle = {
  owned: SessionHandle;
  calls: string[];
  sent: string[];
  correlations: (string | undefined)[];
  responses: { requestId: string; decision: Decision }[];
};

/** A handle that records what reached it, as `serve_owned.test.ts` builds one. */
function handle(startedAt: number, pending: PendingRequest[] = [], history: Exchange[] = []) {
  const live: LiveState = {
    cwd: '/work/app',
    startedAt,
    status: 'busy',
    queued: [],
    pending,
    running: true,
    turnsEnded: 0
  };
  const made: Handle = {
    owned: undefined as unknown as SessionHandle,
    calls: [],
    sent: [],
    correlations: [],
    responses: []
  };
  made.owned = {
    state: live,
    onChange: () => () => {},
    opening: Promise.resolve({ ok: true }),
    onActivity: () => () => {},
    close: () => {},
    readout: () => {},
    thread: {
      generation: () => 0,
      snapshot: () => ({
        conversation: '',
        generation: 0,
        history: { exchanges: history, firstSeen: new Map(), checkpoints: new Map() },
        recent: { exchanges: history, truncated: false },
        tail: []
      }),
      recovered: Promise.resolve(true),
      onChange: () => () => {}
    },
    messages: {
      images: true,
      pending: () => live.running || live.pending.length > 0 || live.queued.length > 0,
      send(text, _images, _describe, ahead, _target, correlation) {
        made.calls.push(ahead ? 'send-ahead' : 'send');
        made.sent.push(text);
        made.correlations.push(correlation);
        live.queued.push({
          id: `q${live.queued.length}`,
          text,
          queuedAt: 0,
          ...(correlation === undefined ? {} : { correlation })
        });
      },
      dismiss: () => false,
      sendNow() {
        made.calls.push('sendNow');
        live.queued.length = 0;
        return Promise.resolve();
      }
    },
    turn: {
      interrupt() {
        made.calls.push('interrupt');
        return Promise.resolve();
      }
    },
    asks: {
      respond(requestId, decision) {
        made.calls.push('respond');
        made.responses.push({ requestId, decision });
        return live.pending.some((open) => open.requestId === requestId);
      }
    }
  };
  return made;
}

/** One window's sessions, and what its End and start were asked. */
class Window {
  readonly handles = new Map<number, SessionHandle>();
  readonly ended: [number, number][] = [];
  readonly started: RemoteStart[] = [];
  /** What this window's default pick resolves a start with no brand to. */
  resolves: BrandId = 'claude';

  constructor(readonly id: string) {}

  servePort(): ServePort {
    return {
      owned: (pid) => this.handles.get(pid),
      end: (pid, startedAt) => {
        this.ended.push([pid, startedAt]);
        return this.handles.delete(pid);
      },
      start: (start) => {
        this.started.push(start);
        return Promise.resolve({
          ok: true,
          pid: 4242,
          startedAt: T0 + 4242,
          brand: start.brand ?? this.resolves
        });
      },
      holder: () =>
        Promise.resolve({ windowId: HERE, label: 'here', pid: 1, startedAt: 1, since: 1 })
    };
  }
}

/** A claim loop for `window`, serving what `serveOwned` owns, as Step 11's
 *  helpers will. `answer` stands in for a window of another build. */
function serving(
  id: string,
  answer: (request: Request) => Promise<{ ok: boolean; reason?: string }>
) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      await requests.claimRequests(id, answer);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}

const session = (pid: number, windowId: string, over: Partial<Session> = {}): Session => ({
  pid,
  sessionId: `s${pid}`,
  cwd: '/work/app',
  name: `n${pid}`,
  status: 'idle',
  hasCommand: false,
  startedAt: T0 + pid,
  updatedAt: T0,
  transcript: '',
  source: 'owned',
  windowId,
  ...over
});

const claim = (id: string): WindowClaim => ({
  id,
  label: id,
  app: 'Code',
  shellPids: [],
  updatedAt: T0
});

type Rig = {
  here: Window;
  there: Window;
  board: Watched[];
  asked: RequestBody[];
  signalled: { pid: number; startedAt: number }[][];
  reaps: Set<Reap>;
  verbs: SessionVerbs;
  port: VerbPort;
};

function rig(over: Partial<VerbPort> = {}): Rig {
  const here = new Window(HERE);
  const there = new Window(THERE);
  const board: Watched[] = [];
  const asked: RequestBody[] = [];
  const signalled: { pid: number; startedAt: number }[][] = [];
  const reaps = new Set<Reap>();
  const port: VerbPort = {
    windowId: HERE,
    owned: (pid) => here.handles.get(pid),
    end: (pid, startedAt) => here.servePort().end(pid, startedAt),
    start: (start): Promise<Started> => {
      here.started.push(start);
      return Promise.resolve({
        ok: true,
        pid: 77,
        startedAt: T0 + 77,
        brand: start.brand ?? 'claude'
      });
    },
    ask: (body, timeoutMs) => {
      asked.push(body);
      // A dead window is waited on for a moment, not the protocol's seconds.
      return ask.ask(body, body.windowId === DEAD ? 300 : timeoutMs);
    },
    board: () => board,
    claims: () => Promise.resolve([claim(HERE), claim(THERE), claim(OLD)]),
    signal: (targets): Promise<SignalEnd[]> => {
      signalled.push([...targets]);
      return control.endBySignal(targets, {
        hold: (reap) => reaps.add(reap),
        release: (reap) => reaps.delete(reap)
      });
    },
    ...over
  };
  return { here, there, board, asked, signalled, reaps, verbs: verbs.remoteVerbs(port), port };
}

const addr = (pid: number, windowId: string, startedAt = T0 + pid): SessionAddr => ({
  pid,
  startedAt,
  windowId
});

const OLDER =
  'The window driving that session runs an older Squadron. Reload that window and try again.';

let stops: (() => void)[] = [];
let live: Rig;

let home: string;

before(async () => {
  home = await tempHome();
  ask = await import('../../core/coordination/ask');
  requests = await import('../../core/coordination/requests');
  serveOwned = await import('../../core/coordination/serve_owned');
  control = await import('../../core/control');
  scan = await import('../../core/scan');
  record = await import('../../core/record');
  paths = await import('../../core/paths');
  verbs = await import('../../core/remote/verbs');
  live = rig();
  const there = live.there.servePort();
  stops = [
    serving(
      THERE,
      (request) =>
        serveOwned.serveOwned(request, there) ?? Promise.resolve({ ok: false, reason: 'not mine' })
    ),
    // A window built before Remote: every pid-carrying kind it has no case for
    // answers the "older Squadron" refusal.
    serving(OLD, () => Promise.resolve({ ok: false, reason: OLDER }))
  ];
});

after(async () => {
  for (const stop of stops) stop();
  for (const reap of live.reaps) reap.dispose();
  await disposeHome(home);
});

/** The first answer `read` gives, polled every 20 ms (an interval). */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

async function requestFiles(): Promise<string[]> {
  return fs.readdir(paths.REQUESTS_DIR).catch(() => []);
}

describe('remoteVerbs message evidence', () => {
  it('forwards identity for sends and typed answers through local and real request-file paths', async () => {
    for (const windowId of [HERE, THERE]) {
      const made = handle(T0 + 991, [question]);
      (windowId === HERE ? live.here : live.there).handles.set(991, made.owned);
      const facts = [{ correlation: 'historic', phase: 'done' as const }];
      made.owned.state.messageFacts = facts;
      const sent = await live.verbs.send(addr(991, windowId), 'same words', 'send-identity');
      assert.deepEqual(sent, { ok: true, queued: 1, messageFacts: facts });
      assert.equal(made.owned.state.queued[0]?.correlation, 'send-identity');
      const answered = await live.verbs.answer(
        addr(991, windowId),
        'ask-1',
        'blue',
        'answer-identity'
      );
      assert.deepEqual(answered, { ok: true, queued: 0, messageFacts: facts });
      assert.deepEqual(made.correlations, ['send-identity', 'answer-identity']);
      const request = live.asked.at(-1);
      if (windowId === THERE)
        assert.equal(
          request && 'correlation' in request ? request.correlation : undefined,
          'answer-identity'
        );
    }
  });

  it('carries initial-prompt identity through local and foreign launch selection', async () => {
    const t = rig();
    const selected = {
      cwd: '/work/app',
      prompt: 'go',
      brand: 'codex' as const,
      correlation: 'initial-message'
    };
    await t.verbs.start({ windowId: HERE, ...selected });
    await live.verbs.start({ windowId: THERE, ...selected });
    assert.deepEqual(t.here.started.at(-1), selected);
    assert.deepEqual(live.there.started.at(-1), selected);
  });

  it('preserves uncertainty after a send, answer or start acknowledgement is lost and never retries', async () => {
    let attempts = 0;
    const t = rig({
      ask: () => {
        attempts++;
        return Promise.resolve({
          ok: false,
          kind: 'silent',
          reason: ask.UNANSWERED,
          file: 'request'
        });
      }
    });
    assert.deepEqual(await t.verbs.send(addr(991, THERE), 'go', 'lost-send'), {
      ok: false,
      reason: ask.UNANSWERED,
      unsure: true
    });
    assert.deepEqual(await t.verbs.answer(addr(991, THERE), 'ask-1', 'blue', 'lost-answer'), {
      ok: false,
      reason: ask.UNANSWERED,
      unsure: true
    });
    assert.deepEqual(
      await t.verbs.start({
        windowId: THERE,
        cwd: '/work',
        prompt: 'go',
        correlation: 'lost-start'
      }),
      { ok: false, reason: ask.UNANSWERED, unsure: true }
    );
    assert.equal(attempts, 3);
  });
});

describe('remoteVerbs, here', () => {
  it('sends through the handle and reports how deep the outbox is left', async () => {
    const { here, verbs: v, asked } = rig();
    const made = handle(T0 + 1);
    here.handles.set(1, made.owned);
    assert.deepEqual(await v.send(addr(1, HERE), 'carry on'), { ok: true, queued: 1 });
    assert.deepEqual(made.sent, ['carry on']);
    assert.equal(asked.length, 0);
  });

  it('answers an open question ahead of the outbox and drains it', async () => {
    const { here, verbs: v } = rig();
    const made = handle(T0 + 2, [question]);
    here.handles.set(2, made.owned);
    assert.deepEqual(await v.answer(addr(2, HERE), 'ask-1', 'blue'), { ok: true, queued: 0 });
    assert.deepEqual(made.calls, ['send-ahead', 'sendNow']);
  });

  it('delivers an answer to a question that closed as a plain message', async () => {
    const { here, verbs: v } = rig();
    const made = handle(T0 + 3);
    here.handles.set(3, made.owned);
    assert.deepEqual(await v.answer(addr(3, HERE), 'ask-1', 'blue'), { ok: true, queued: 1 });
    assert.deepEqual(made.calls, ['send']);
    assert.deepEqual(made.sent, ['blue']);
  });

  it('interrupts the turn', async () => {
    const { here, verbs: v } = rig();
    const made = handle(T0 + 4);
    here.handles.set(4, made.owned);
    assert.deepEqual(await v.interrupt(addr(4, HERE)), { ok: true });
    assert.deepEqual(made.calls, ['interrupt']);
  });

  it('says when there was no turn to interrupt, here and by request', async () => {
    const { here, verbs: v } = rig();
    const idle = handle(T0 + 5);
    idle.owned.state.running = false;
    here.handles.set(5, idle.owned);
    assert.deepEqual(await v.interrupt(addr(5, HERE)), { ok: true, idle: true });
    const there = handle(T0 + 6);
    there.owned.state.running = false;
    live.there.handles.set(6, there.owned);
    assert.deepEqual(await live.verbs.interrupt(addr(6, THERE)), { ok: true, idle: true });
    assert.deepEqual([...idle.calls, ...there.calls], []);
  });

  it('denies an open permission, with its reason', async () => {
    const { here, verbs: v } = rig();
    const made = handle(T0 + 5, [permission]);
    here.handles.set(5, made.owned);
    assert.deepEqual(await v.deny(addr(5, HERE), 'perm-1', 'not now'), { ok: true });
    assert.deepEqual(made.responses, [
      { requestId: 'perm-1', decision: { allow: false, message: 'not now' } }
    ]);
  });

  it('refuses a stale start before acting or writing a file', async () => {
    const { here, verbs: v, asked } = rig();
    const made = handle(T0 + 6);
    here.handles.set(6, made.owned);
    const stale = addr(6, HERE, T0 + 6 + 60_000);
    const sent = await v.send(stale, 'hello');
    assert.equal(sent.ok, false);
    assert.deepEqual(made.calls, []);
    assert.equal(asked.length, 0);
  });

  it('starts through the port, with no request', async () => {
    const { here, verbs: v, asked } = rig();
    const started = await v.start({
      windowId: HERE,
      cwd: '/work/app',
      prompt: 'go',
      brand: 'grok'
    });
    assert.deepEqual(started, { ok: true, pid: 77, startedAt: T0 + 77, brand: 'grok' });
    assert.deepEqual(here.started, [{ cwd: '/work/app', prompt: 'go', brand: 'grok' }]);
    assert.equal(asked.length, 0);
  });

  it("reads the last reply off the handle's thread", async () => {
    const { here, verbs: v } = rig();
    const made = handle(T0 + 8, [], [say('user', 'fix it'), say('assistant', 'Fixed.')]);
    here.handles.set(8, made.owned);
    assert.equal(await v.lastReply(addr(8, HERE)), 'Fixed.');
  });

  it('quotes the turn that ended, not the held reply it drained into', async () => {
    // A coalesced finish: the turn ended and its pass found the next one
    // already written, so the thread's tail is the in-flight turn's.
    const { here, verbs: v } = rig();
    const made = handle(
      T0 + 9,
      [],
      [
        say('user', 'fix it'),
        say('assistant', 'FINAL-A'),
        say('user', 'then tidy up'),
        say('assistant', 'Let me look.')
      ]
    );
    made.owned.state.inFlight = { id: 'q0', text: 'then tidy up', queuedAt: T0 };
    here.handles.set(9, made.owned);
    assert.equal(await v.lastReply(addr(9, HERE)), 'FINAL-A');
  });
});

describe('remoteVerbs, by request', () => {
  it("sends the composer's send to the session's window", async () => {
    const made = handle(T0 + 11);
    live.there.handles.set(11, made.owned);
    assert.deepEqual(await live.verbs.send(addr(11, THERE), 'from the phone'), {
      ok: true,
      queued: 1
    });
    assert.deepEqual(made.sent, ['from the phone']);
    const body = live.asked.at(-1);
    assert.equal(body?.kind, 'send');
    assert.equal(body && 'via' in body ? body.via : undefined, undefined);
  });

  it('answers, interrupts and denies through the new kinds, naming this window as holder', async () => {
    const asking = handle(T0 + 12, [question]);
    const blocked = handle(T0 + 18, [permission]);
    live.there.handles.set(12, asking.owned);
    live.there.handles.set(18, blocked.owned);
    assert.deepEqual(await live.verbs.answer(addr(12, THERE), 'ask-1', 'red'), {
      ok: true,
      queued: 0
    });
    assert.deepEqual(await live.verbs.interrupt(addr(12, THERE)), { ok: true });
    assert.deepEqual(await live.verbs.deny(addr(18, THERE), 'perm-1'), { ok: true });
    assert.deepEqual(asking.calls, ['send-ahead', 'sendNow', 'interrupt']);
    assert.deepEqual(blocked.responses, [{ requestId: 'perm-1', decision: { allow: false } }]);
    const kinds = live.asked
      .slice(-3)
      .map((body) => [body.kind, 'remote' in body ? body.remote : '']);
    assert.deepEqual(kinds, [
      ['personAnswer', HERE],
      ['interrupt', HERE],
      ['deny', HERE]
    ]);
  });

  it('opens a session in another window as a person’s start, and gives its pid and start', async () => {
    const started = await live.verbs.start({ windowId: THERE, cwd: '/work/b', prompt: 'go' });
    assert.deepEqual(started, { ok: true, pid: 4242, startedAt: T0 + 4242, brand: 'claude' });
    assert.deepEqual(live.there.started.at(-1), { cwd: '/work/b', prompt: 'go' });
    const body = live.asked.at(-1);
    assert.equal(body?.kind === 'open' ? body.via : undefined, 'remote');
    assert.equal(body?.kind === 'open' ? body.remote : undefined, HERE);
  });

  it("records the brand the serving window resolved its start to, not Claude's", async () => {
    live.there.resolves = 'codex';
    try {
      const started = await live.verbs.start({ windowId: THERE, cwd: '/work/b', prompt: 'go' });
      assert.deepEqual(started, { ok: true, pid: 4242, startedAt: T0 + 4242, brand: 'codex' });
    } finally {
      live.there.resolves = 'claude';
    }
  });

  it('says a window that never answers left the outcome unknown', async () => {
    const sent = await live.verbs.interrupt(addr(13, DEAD));
    assert.deepEqual(sent, { ok: false, reason: ask.UNANSWERED });
  });

  it("passes an older window's refusal through verbatim", async () => {
    assert.deepEqual(await live.verbs.interrupt(addr(14, OLD)), { ok: false, reason: OLDER });
  });

  it('refuses a start the board shows has moved on, before any file is written', async () => {
    const asked = live.asked.length;
    live.board.push({ session: session(15, THERE), pending: [], label: 'n15' });
    const before = await requestFiles();
    const sent = await live.verbs.send(addr(15, THERE, T0 + 15 + 60_000), 'hello');
    assert.equal(sent.ok, false);
    assert.equal(live.asked.length, asked);
    assert.deepEqual(await requestFiles(), before);
  });

  it("reads another window's last reply from its record, by the board's sessionId", async () => {
    live.board.push({
      session: session(16, THERE, { sessionId: 'rec-16' }),
      pending: [],
      label: 'n16'
    });
    await record.appendLine('rec-16', say('user', 'look'));
    await record.appendLine('rec-16', say('assistant', 'Looked.'));
    assert.equal(await live.verbs.lastReply(addr(16, THERE)), 'Looked.');
    assert.equal(await live.verbs.lastReply(addr(17, THERE)), undefined);
  });

  it("quotes another window's ended turn, past one its record shows begun", async () => {
    const busy = {
      session: session(18, THERE, { sessionId: 'rec-18', status: 'busy' as const }),
      pending: [],
      label: 'n18'
    };
    const idle = {
      session: session(19, THERE, { sessionId: 'rec-19' }),
      pending: [],
      label: 'n19'
    };
    live.board.push(busy, idle);
    for (const line of [
      say('user', 'look'),
      say('assistant', 'FINAL-A'),
      say('user', 'more'),
      say('assistant', 'Let me look.')
    ]) {
      await record.appendLine('rec-18', line);
    }
    // Idle on the last pass, and the next prompt already written since.
    for (const line of [say('user', 'look'), say('assistant', 'FINAL-A'), say('user', 'more')]) {
      await record.appendLine('rec-19', line);
    }
    assert.equal(await live.verbs.lastReply(addr(18, THERE)), 'FINAL-A');
    assert.equal(await live.verbs.lastReply(addr(19, THERE)), 'FINAL-A');
  });
});

describe('remoteVerbs end', () => {
  const strays: FakeProcess[] = [];

  after(async () => {
    for (const stray of strays) await stray.stop();
  });

  /** A real process no window answers for, at the start `ps` gives it. */
  async function stray(): Promise<{ pid: number; startedAt: number; proc: FakeProcess }> {
    const proc = await fakeClaude(60);
    strays.push(proc);
    const table = await scan.scanProcesses(true);
    return { pid: proc.pid, startedAt: table.starts.get(proc.pid) ?? 0, proc };
  }

  const alive = async (pid: number) => (await scan.scanProcesses(true)).starts.has(pid);

  it('ends here in memory and there by close, together, and is ok when all ended', async () => {
    const { here, there } = live;
    here.handles.set(21, handle(T0 + 21).owned);
    there.handles.set(22, handle(T0 + 22).owned);
    const before = live.signalled.length;
    assert.deepEqual(await live.verbs.end(addr(21, HERE), [addr(22, THERE)]), { ok: true });
    assert.deepEqual(here.ended.at(-1), [21, T0 + 21]);
    assert.deepEqual(there.ended.at(-1), [22, T0 + 22]);
    assert.equal(live.signalled.length, before);
  });

  it('signals a member whose window holds no claim, and never one whose start moved', async () => {
    live.here.handles.set(23, handle(T0 + 23).owned);
    const orphan = await stray();
    const moved = await stray();
    const ended = await live.verbs.end(addr(23, HERE), [
      addr(orphan.pid, DEAD, orphan.startedAt),
      addr(moved.pid, DEAD, moved.startedAt + 60_000)
    ]);
    assert.deepEqual(ended, { ok: true });
    assert.deepEqual(
      live.signalled.at(-1)?.map((one) => one.pid),
      [orphan.pid]
    );
    // SIGTERM is enough for `sleep`; the reap is a backstop.
    for (let i = 0; i < 50 && (await alive(orphan.pid)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await alive(orphan.pid), false);
    assert.equal(await alive(moved.pid), true);
  });

  it('keeps a deliberate refusal terminal while completing the other members', async () => {
    const refused = await stray();
    const claimed = rig();
    claimed.here.handles.set(24, handle(T0 + 24).owned);
    const ended = await claimed.verbs.end(addr(24, HERE), [
      addr(refused.pid, OLD, refused.startedAt)
    ]);
    assert.equal(ended.ok, false);
    assert.equal(claimed.signalled.length, 0);
    assert.deepEqual(claimed.here.ended, [[24, T0 + 24]]);
    assert.equal(await alive(refused.pid), true);
  });

  it('falls back to the signal for an unanswered close', async () => {
    const unanswered = await stray();
    const claimed = rig({ claims: () => Promise.resolve([claim(HERE), claim(DEAD)]) });
    claimed.here.handles.set(24, handle(T0 + 24).owned);
    const ended = await claimed.verbs.end(addr(24, HERE), [
      addr(unanswered.pid, DEAD, unanswered.startedAt)
    ]);
    for (const reap of claimed.reaps) reap.dispose();
    assert.deepEqual(ended, { ok: true });
    assert.deepEqual(
      claimed.asked.map((body) => [body.kind, body.windowId]),
      [
        ['close', DEAD],
        ['close', DEAD]
      ]
    );
    assert.deepEqual(
      claimed.signalled.at(-1)?.map((one) => one.pid),
      [unanswered.pid]
    );
  });

  it('signals a member whose close threw, and still signals the rest of the cascade', async () => {
    const local = await stray();
    const child = await stray();
    const signalled: { pid: number; startedAt: number }[][] = [];
    const { here, verbs: v } = rig({
      end: () => {
        throw new Error('the pipe has broken');
      },
      signal: (targets) => {
        signalled.push([...targets]);
        return Promise.resolve(targets.map((): SignalEnd => 'ended'));
      }
    });
    here.handles.set(local.pid, handle(local.startedAt).owned);
    const ended = await v.end(addr(local.pid, HERE, local.startedAt), [
      addr(child.pid, DEAD, child.startedAt)
    ]);
    assert.deepEqual(ended, { ok: true });
    assert.deepEqual(
      signalled.at(-1)?.map((one) => one.pid),
      [local.pid, child.pid]
    );
  });

  it('arms no reap for an End still in flight when its owner is disposed', async () => {
    // The host disposes its reaps before the bridge drains, and an End
    // waiting on another window's close outlives that: its SIGKILL timer must
    // not be held by an owner that has gone.
    // A child under it, or there is no subtree for a reap to sweep.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      process.stdin.resume();
      process.stdin.on('end', () => child.kill('SIGKILL'));
      child.on('close', () => process.stdin.destroy());
    `
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    );
    const closed = new Promise<void>((resolve, reject) => {
      parent.once('close', () => resolve());
      parent.once('error', reject);
    });
    void closed.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitForClose = (ms: number) =>
      Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('fixture parent did not close')), ms);
        })
      ]);
    const closeParent = async () => {
      parent.stdin?.end();
      try {
        await waitForClose(5000);
      } catch (error) {
        parent.kill('SIGKILL');
        clearTimeout(timer);
        try {
          await waitForClose(2000);
        } catch {
          /* Preserve the first close failure. */
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const pid = parent.pid ?? 0;
      const table = await until(async () => {
        const fresh = await scan.scanProcesses(true);
        if (fresh.unavailable) throw new Error(fresh.unavailable);
        return [...fresh.parents].some(([, parent]) => parent === pid) ? fresh : undefined;
      });
      const orphan = { pid, startedAt: table.starts.get(pid) ?? 0 };
      const reaps = new control.Reaps();
      const { verbs: v } = rig({
        claims: () => Promise.resolve([claim(HERE), claim(DEAD)]),
        signal: (targets) => control.endBySignal(targets, reaps)
      });
      const ending = v.end(addr(orphan.pid, DEAD, orphan.startedAt), []);
      reaps.dispose();
      assert.deepEqual(await ending, { ok: true });
      assert.equal(reaps.size, 0, 'a reap was held after its owner went');
    } finally {
      await closeParent();
    }
  });

  it('names each session that was not ended, and why', async () => {
    const { verbs: v, board } = rig({
      signal: (targets) => Promise.resolve(targets.map((): SignalEnd => 'failed'))
    });
    const root = await stray();
    const child = await stray();
    board.push({
      session: session(child.pid, DEAD, { startedAt: child.startedAt }),
      pending: [],
      label: 'the child'
    });
    const ended = await v.end(addr(root.pid, HERE, root.startedAt), [
      addr(child.pid, DEAD, child.startedAt)
    ]);
    assert.equal(ended.ok, false);
    const reason = ended.ok ? '' : ended.reason;
    assert.match(reason, new RegExp(`pid ${root.pid}`));
    assert.match(reason, /the child/);
  });

  it('says what it ended when the root went and a member did not', async () => {
    const { here, verbs: v } = rig({
      signal: (targets) => Promise.resolve(targets.map((): SignalEnd => 'failed'))
    });
    here.handles.set(27, handle(T0 + 27).owned);
    const child = await stray();
    const childAddr = addr(child.pid, DEAD, child.startedAt);
    const ended = await v.end(addr(27, HERE), [childAddr]);
    assert.equal(ended.ok, false);
    assert.match(ended.ok ? '' : ended.reason, new RegExp(`^Ended,.*pid ${child.pid}`));
    assert.deepEqual(ended.ok ? [] : ended.left, [childAddr], 'names who is still running');
  });
});

describe('lastAnswer', () => {
  it('reads the text of the last answer after the last prompt, past a tool-heavy turn', () => {
    const turn: Exchange[] = [
      say('user', 'old prompt'),
      say('assistant', 'old answer'),
      say('user', 'fix the build'),
      say('assistant', 'Let me look.'),
      call('Read'),
      call('Bash'),
      call('Edit'),
      say('assistant', 'Fixed: the import was wrong.'),
      call('TodoWrite')
    ];
    assert.equal(transcript.lastAnswer(turn), 'Fixed: the import was wrong.');
  });

  it('joins the text blocks of that answer and leaves its calls out', () => {
    const mixed: Authored = {
      role: 'assistant',
      text: 'one two',
      blocks: [{ text: 'one' }, { call: { id: 'c', name: 'Bash', input: {} } }, { text: 'two' }]
    };
    assert.equal(transcript.lastAnswer([say('user', 'go'), mixed]), 'one\n\ntwo');
  });

  it("takes a CLI turn as the answer, and a wait's arrival as a prompt", () => {
    assert.equal(
      transcript.lastAnswer([say('user', 'go'), say('cli', 'API Error: overloaded')]),
      'API Error: overloaded'
    );
    assert.equal(
      transcript.lastAnswer([
        say('user', 'go'),
        say('assistant', 'done'),
        say('wait', 'all finished')
      ]),
      undefined
    );
  });

  it('skips a warm ping and its answer', () => {
    assert.equal(
      transcript.lastAnswer([
        say('user', 'go'),
        say('assistant', 'Real answer.'),
        say('warm', 'ping'),
        say('assistant', 'pong')
      ]),
      'Real answer.'
    );
  });

  it('skips the turn in flight, prompt and all, when told one is', () => {
    const exchanges = [
      say('user', 'go'),
      say('assistant', 'FINAL-A'),
      say('user', 'next'),
      say('assistant', 'Let me look.')
    ];
    assert.equal(transcript.lastAnswer(exchanges), 'Let me look.');
    assert.equal(transcript.lastAnswer(exchanges, { inFlight: true }), 'FINAL-A');
    assert.equal(transcript.lastAnswer(exchanges.slice(0, 3), { inFlight: true }), 'FINAL-A');
  });

  it('says a record ends on a prompt nothing has answered yet', () => {
    assert.equal(transcript.unanswered([say('user', 'go'), say('assistant', 'done')]), false);
    assert.equal(
      transcript.unanswered([
        say('user', 'go'),
        say('assistant', 'done'),
        say('wait', 'all finished')
      ]),
      true
    );
    assert.equal(
      transcript.unanswered([
        say('assistant', 'done'),
        say('warm', 'ping'),
        say('assistant', 'pong')
      ]),
      false
    );
    assert.equal(transcript.unanswered([]), false);
  });

  it('has nothing to say for a turn with no text', () => {
    assert.equal(transcript.lastAnswer([say('user', 'go'), call('Bash')]), undefined);
    assert.equal(transcript.lastAnswer([]), undefined);
  });
});

describe('remote selection requests', () => {
  it('forwards the same complete target locally and through a request file', async () => {
    const there = new Window('w-selection');
    const stop = serving(
      'w-selection',
      (request) =>
        serveOwned.serveOwned(request, there.servePort()) ?? Promise.resolve({ ok: false })
    );
    try {
      const t = rig();
      const selected = {
        cwd: '/work/app',
        prompt: 'go',
        brand: 'claude' as const,
        model: 'claude-opus-5',
        window: 200_000,
        effort: 'high',
        selection: 'catalog' as const
      };
      assert.equal((await t.verbs.start({ windowId: HERE, ...selected })).ok, true);
      assert.equal((await t.verbs.start({ windowId: 'w-selection', ...selected })).ok, true);
      assert.deepEqual(t.here.started.at(-1), selected);
      assert.deepEqual(there.started.at(-1), selected);
      assert.deepEqual(t.asked.at(-1), {
        kind: 'open',
        origin: 'remote',
        windowId: 'w-selection',
        ...selected,
        via: 'remote',
        remote: HERE
      });
    } finally {
      stop();
    }
  });

  it('preserves only positive pre-launch acknowledgments on failed replies', async () => {
    for (const reply of [
      {
        ok: false,
        reason: 'before child',
        notStarted: true as const,
        selectionInvalid: true as const
      },
      { ok: false, reason: 'after child' }
    ]) {
      const t = rig({
        ask: () =>
          Promise.resolve({
            ok: false,
            kind: 'refused',
            reason: reply.reason,
            reply,
            file: 'request'
          })
      });
      assert.deepEqual(
        await t.verbs.start({ windowId: THERE, cwd: '/work', prompt: 'go', selection: 'default' }),
        reply
      );
    }
  });
});

describe('incoming capability discovery', () => {
  it('preserves the whole envelope on local and foreign paths and drops malformed or wrong-window capability', async () => {
    for (const windowId of [HERE, THERE]) {
      const incomingAccess = {
        version: 1 as const,
        host: { ...fixture.host, windowId },
        localRoot: fixture.receiver.cwd
      };
      const models = { models: { brands: [], models: [] }, incomingAccess };
      const t = rig({
        models: () => Promise.resolve(models),
        ask: () => Promise.resolve({ ok: true, reply: { ok: true, ...models }, file: 'request' })
      });
      assert.deepEqual(await t.verbs.models!(windowId), models);
      for (const invalid of [
        { ...incomingAccess, version: 2 },
        { ...incomingAccess, host: fixture.holder.host }
      ]) {
        const raw = { ...models, incomingAccess: invalid } as unknown as typeof models;
        const bad = rig({
          models: () => Promise.resolve(raw),
          ask: () => Promise.resolve({ ok: true, reply: { ok: true, ...raw }, file: 'request' })
        });
        assert.deepEqual(await bad.verbs.models!(windowId), { models: models.models });
      }
    }
  });
});
