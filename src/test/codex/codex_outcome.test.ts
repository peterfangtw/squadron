import * as assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import type { CodexSession as Session } from '../../core/codex/session';
import { toSession, type LiveState } from '../../core/live';
import type { SessionTransport } from '../../core/session';
import { tempHome } from '../helpers';

let CodexSession: typeof Session;

before(async () => {
  await tempHome();
  ({ CodexSession } = await import('../../core/codex/session'));
});

const THREAD = 'thread-1';
const HELD = { pid: 7, startedAt: 1, updatedAt: 1, brand: 'codex' as const };

/** A Codex peer that answers the handshake and holds `turn/start` when asked,
 *  so a test can deliver `turn/completed` before the response names the turn. */
class Peer {
  readonly turns: { rpc: number; turnId: string }[] = [];
  readonly interrupts: string[] = [];
  holdTurns = false;
  private turnNumber = 0;
  private readonly lines: ((value: unknown) => void)[] = [];

  readonly transport: SessionTransport = {
    onLine: (listener) => this.lines.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      const request = value as { id?: number; method?: string };
      if (request.id === undefined || request.method === undefined) return;
      const rpc = request.id;
      if (request.method === 'turn/interrupt') {
        const params = (value as { params?: { turnId?: string } }).params;
        this.interrupts.push(params?.turnId ?? '');
      }
      if (request.method === 'turn/start') {
        const turnId = `turn-${++this.turnNumber}`;
        this.turns.push({ rpc, turnId });
        if (this.holdTurns) return;
        queueMicrotask(() => this.reply(rpc, { turn: { id: turnId, status: 'inProgress' } }));
        return;
      }
      const result =
        request.method === 'initialize'
          ? { userAgent: 'fixture', codexHome: '/tmp' }
          : request.method === 'thread/start'
            ? {
                thread: {
                  id: THREAD,
                  cwd: '/tmp/codex-project',
                  canAcceptDirectInput: true,
                  status: { type: 'idle' }
                }
              }
            : {};
      queueMicrotask(() => this.reply(rpc, result));
    }
  };

  reply(rpc: number, result: unknown): void {
    for (const listener of this.lines) listener({ id: rpc, result });
  }

  fail(rpc: number): void {
    for (const listener of this.lines)
      listener({ id: rpc, error: { code: -32603, message: 'Internal error' } });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    for (const listener of this.lines)
      listener({ method, params: { threadId: THREAD, ...params } });
  }
}

async function opened(requestMs?: number): Promise<{ peer: Peer; session: Session }> {
  const peer = new Peer();
  const session = new CodexSession(
    peer.transport,
    { cwd: '/tmp/codex-project', startedAt: 1 },
    requestMs
  );
  assert.equal((await session.opening).ok, true);
  return { peer, session };
}

async function prompted(peer: Peer, count: number): Promise<{ rpc: number; turnId: string }> {
  for (let i = 0; i < 400 && peer.turns.length < count; i++) await setTimeout(5);
  const turn = peer.turns[count - 1];
  assert.ok(turn, `turn/start ${count} never reached the wire`);
  return turn;
}

async function settled(session: Session, want: (state: LiveState) => boolean): Promise<void> {
  for (let i = 0; i < 400 && !want(session.state); i++) await setTimeout(5);
  assert.ok(want(session.state), JSON.stringify(session.state));
}

function reads(session: Session): {
  outcome: LiveState['lastOutcome'];
  status: LiveState['status'];
  inFlight: string | undefined;
} {
  const card = toSession(session.state, HELD, 'w');
  return { outcome: card.turnOutcome, status: card.status, inFlight: session.state.inFlight?.text };
}

/** The `sleep` an interrupt leaves running (`cli_state/codex/protocol.md`). */
function sleep(status: 'inProgress' | 'completed'): Record<string, unknown> {
  return { type: 'commandExecution', id: 'call-1', command: 'sleep 25', status };
}

/** Reply, then the completion, once `turn/start` has named the turn. */
async function finish(peer: Peer, session: Session, text: string, status: string): Promise<string> {
  session.send(text);
  const turn = await prompted(peer, peer.turns.length + 1);
  await setTimeout(10);
  peer.notify('turn/completed', { turn: { id: turn.turnId, status } });
  await settled(session, (state) => !state.running);
  return turn.turnId;
}

describe('a Codex turn outcome', () => {
  it('records the invalid-effort sequence once the completion says failed', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('banana');
    const turn = await prompted(peer, 1);
    await setTimeout(10);
    peer.notify('thread/status/changed', { status: { type: 'systemError' } });
    assert.equal(session.state.status, 'unknown');
    assert.equal(reads(session).outcome, undefined);
    peer.notify('error', {
      message:
        "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'banana'"
    });
    peer.notify('turn/completed', {
      turn: { id: turn.turnId, status: 'failed', error: { message: 'invalid effort' } }
    });
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it("drops A's duplicate close while turn/start has not named B", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'completed');
    peer.holdTurns = true;
    session.send('B');
    await prompted(peer, 2);
    assert.equal(reads(session).status, 'busy');
    peer.notify('turn/completed', { turn: { id: a, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    const b = peer.turns[1];
    assert.ok(b);
    peer.reply(b.rpc, { turn: { id: b.turnId, status: 'inProgress' } });
    await setTimeout(10);
    peer.notify('turn/completed', { turn: { id: b.turnId, status: 'completed' } });
    await settled(session, (state) => !state.running);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it("drops A's late close once B's id is known", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'completed');
    peer.holdTurns = true;
    session.send('B');
    const b = await prompted(peer, 2);
    peer.reply(b.rpc, { turn: { id: b.turnId, status: 'inProgress' } });
    await setTimeout(10);
    peer.notify('turn/completed', { turn: { id: a, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    peer.notify('turn/completed', { turn: { id: b.turnId, status: 'completed' } });
    await settled(session, (state) => !state.running);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it('keeps a completion that arrives before turn/start names the turn', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('fast');
    const turn = await prompted(peer, 1);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'fast' });
    peer.reply(turn.rpc, { turn: { id: turn.turnId, status: 'inProgress' } });
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    session.send('next');
    const next = await prompted(peer, 2);
    peer.holdTurns = false;
    peer.reply(next.rpc, { turn: { id: next.turnId, status: 'inProgress' } });
    await setTimeout(10);
    peer.notify('turn/completed', { turn: { id: next.turnId, status: 'completed' } });
    await settled(session, (state) => !state.running);
    assert.equal(peer.turns.length, 2, 'the finished id was not restored over the next prompt');
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it('strips a repeat of the completion taken before turn/start replies', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('fast');
    const turn = await prompted(peer, 1);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'failed' } });
    peer.notify('item/agentMessage/delta', { delta: 'late' });
    assert.equal(session.state.running, true);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'fast' });
    peer.reply(turn.rpc, { turn: { id: turn.turnId, status: 'inProgress' } });
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it('keeps a turn/started after the completion out of the card', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('fast');
    const turn = await prompted(peer, 1);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'failed' } });
    peer.notify('turn/started', { turn: { id: turn.turnId } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'fast' });
    peer.reply(turn.rpc, { turn: { id: turn.turnId, status: 'inProgress' } });
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    peer.holdTurns = false;
    session.send('next');
    await prompted(peer, 2);
  });

  it("drops A's close after B's early completion", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'completed');
    peer.holdTurns = true;
    session.send('B');
    const b = await prompted(peer, 2);
    peer.notify('turn/completed', { turn: { id: b.turnId, status: 'failed' } });
    peer.notify('turn/started', { turn: { id: b.turnId } });
    peer.notify('turn/completed', { turn: { id: a, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    peer.reply(b.rpc, { turn: { id: b.turnId, status: 'inProgress' } });
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it("ends a card A's late frames re-busied, without A's outcome", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'completed');
    assert.equal(reads(session).outcome, 'done');
    peer.notify('item/agentMessage/delta', { delta: 'late' });
    assert.equal(session.state.running, true);
    peer.notify('turn/completed', { turn: { id: a, status: 'failed' } });
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
  });

  it("stays idle when an interrupted turn's command finishes after it", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'interrupted');
    peer.notify('item/commandExecution/outputDelta', { turnId: a, itemId: 'call-1', delta: 'x' });
    peer.notify('item/completed', { turnId: a, item: sleep('completed') });
    assert.equal(session.state.running, false);
    assert.equal(reads(session).status, 'idle');
    session.send('B');
    await prompted(peer, 2);
  });

  it('sends now past a command that outlives the interrupted turn', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    await setTimeout(10);
    peer.notify('item/started', { turnId: a.turnId, item: sleep('inProgress') });
    session.send('B');
    await session.sendNow();
    assert.deepEqual(peer.interrupts, [a.turnId]);
    peer.notify('turn/completed', { turn: { id: a.turnId, status: 'interrupted' } });
    const b = await prompted(peer, 2);
    await setTimeout(10);
    peer.notify('item/agentMessage/delta', {
      turnId: b.turnId,
      itemId: 'b-message',
      delta: 'on B'
    });
    peer.notify('item/completed', { turnId: a.turnId, item: sleep('completed') });
    peer.notify('item/agentMessage/delta', {
      turnId: b.turnId,
      itemId: 'b-message',
      delta: ' still on B'
    });
    const tail = session.thread.snapshot().tail;
    assert.equal(tail.length, 1);
    assert.equal(tail[0]?.id, 'b-message');
    assert.equal(tail[0]?.exchange.text, 'on B still on B', "A's late command closed B's row");
    peer.notify('turn/completed', { turn: { id: b.turnId, status: 'completed' } });
    await settled(session, (state) => !state.running);
    peer.notify('item/completed', { turnId: a.turnId, item: sleep('completed') });
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it("still reads a completed turn's usage, which is the thread's", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const a = await finish(peer, session, 'A', 'completed');
    peer.notify('thread/tokenUsage/updated', {
      turnId: a,
      tokenUsage: { last: { totalTokens: 1234 } }
    });
    assert.equal(session.state.contextTokens, 1234);
    assert.equal(session.state.running, false);
  });

  it('reads an app-server error on turn/start as a failed turn', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('refused');
    const turn = await prompted(peer, 1);
    peer.fail(turn.rpc);
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it('ends a malformed turn/start without stating how', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('malformed');
    const turn = await prompted(peer, 1);
    peer.reply(turn.rpc, {});
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
  });

  it('ends a timed-out turn/start on a silent transport without stating how', async (t) => {
    const { peer, session } = await opened(50);
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('silent');
    await settled(session, (state) => state.queued.length === 0 && !state.inFlight);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
  });
});

describe('a Codex prompt before the CLI opens its turn', () => {
  function facts(session: Session): {
    running: boolean;
    status: LiveState['status'];
    turnPending: boolean;
    turnsEnded: number;
  } {
    const card = toSession(session.state, HELD, 'w');
    return {
      running: session.state.running,
      status: card.status,
      turnPending: card.turnPending === true,
      turnsEnded: session.state.turnsEnded
    };
  }

  function unsettled(session: Session): boolean {
    return (session.state.messageFacts ?? []).some((fact) => fact.phase === 'processing');
  }

  it('reads busy with no turn open until the CLI opens one', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('A');
    const turn = await prompted(peer, 1);
    assert.deepEqual(facts(session), {
      running: false,
      status: 'busy',
      turnPending: true,
      turnsEnded: 0
    });
    peer.reply(turn.rpc, { turn: { id: turn.turnId, status: 'inProgress' } });
    await setTimeout(10);
    peer.notify('turn/started', { turn: { id: turn.turnId } });
    assert.deepEqual(facts(session), {
      running: true,
      status: 'busy',
      turnPending: false,
      turnsEnded: 0
    });
  });

  it('counts a completion that no frame opened, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const turn = await prompted(peer, 1);
    await setTimeout(10);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'completed' } });
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(unsettled(session), false);
  });

  it('counts a completion before turn/start names the turn, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('fast');
    const turn = await prompted(peer, 1);
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'completed' } });
    peer.reply(turn.rpc, { turn: { id: turn.turnId, status: 'inProgress' } });
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
  });

  it('counts a turn closed by idle and then by its completion, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const turn = await prompted(peer, 1);
    await setTimeout(10);
    peer.notify('turn/started', { turn: { id: turn.turnId } });
    peer.notify('thread/status/changed', { status: { type: 'idle' } });
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'completed' } });
    await settled(session, (state) => !state.inFlight && !state.running);
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(reads(session).status, 'idle');
  });

  it('counts a systemError before any opening, then its failed completion, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const turn = await prompted(peer, 1);
    await setTimeout(10);
    peer.notify('thread/status/changed', { status: { type: 'systemError' } });
    peer.notify('turn/completed', { turn: { id: turn.turnId, status: 'failed' } });
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(unsettled(session), false);
  });

  it('counts a refused turn/start, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('refused');
    const turn = await prompted(peer, 1);
    peer.fail(turn.rpc);
    await settled(session, (state) => !state.inFlight);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(unsettled(session), false);
  });

  it('writes no second prompt before the first turn closes', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.holdTurns = true;
    session.send('A');
    const a = await prompted(peer, 1);
    session.send('B');
    await setTimeout(30);
    assert.equal(peer.turns.length, 1);
    peer.reply(a.rpc, { turn: { id: a.turnId, status: 'inProgress' } });
    await setTimeout(30);
    assert.equal(peer.turns.length, 1);
    peer.holdTurns = false;
    peer.notify('turn/completed', { turn: { id: a.turnId, status: 'completed' } });
    await prompted(peer, 2);
  });
});
