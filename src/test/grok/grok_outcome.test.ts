import * as assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import * as activity from '../../core/activity';
import type { GrokSession as Session } from '../../core/grok/session';
import { shownStatus, toSession, type LiveState } from '../../core/live';
import type { SessionTransport } from '../../core/session';
import { tempHome } from '../helpers';

let GrokSession: typeof Session;

before(async () => {
  await tempHome();
  ({ GrokSession } = await import('../../core/grok/session'));
});

const SESSION = 'g-outcome';
const WAKE = 'task-completed-wake';

/** A Grok peer that answers nothing on its own past the handshake: each
 *  `session/prompt` is held until the test replies to it, and every frame is
 *  sent by hand, so which turn a close names is the test's to choose. */
class Peer {
  /** Held `session/prompt` requests, by the `_meta.promptId` we sent. */
  readonly prompts: { rpc: number; id: string }[] = [];
  breakPrompts = false;
  /** Hold the next effort change instead of applying it. */
  holdEffort = false;
  readonly efforts: number[] = [];
  /** Every request and notification method written, in order. */
  readonly written: string[] = [];
  private readonly lines: ((value: unknown) => void)[] = [];

  readonly transport: SessionTransport = {
    onLine: (listener) => this.lines.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      const request = value as {
        id?: number;
        method: string;
        params?: { _meta?: { promptId?: string }; value?: string };
      };
      this.written.push(request.method);
      if (request.id === undefined) return;
      const rpc = request.id;
      if (request.method === 'session/prompt') {
        if (this.breakPrompts) throw new Error('EPIPE');
        this.prompts.push({ rpc, id: request.params?._meta?.promptId ?? '' });
        return;
      }
      if (request.method === 'session/set_config_option' && this.holdEffort) {
        this.efforts.push(rpc);
        return;
      }
      const result =
        request.method === 'session/set_config_option'
          ? {
              configOptions: [
                {
                  id: 'reasoning_effort',
                  currentValue: request.params?.value,
                  options: [{ value: 'low' }, { value: 'high' }]
                }
              ]
            }
          : request.method === 'initialize'
            ? { protocolVersion: 1, authMethods: [{ id: 'grok-cli' }] }
            : request.method === 'session/new'
              ? { sessionId: SESSION }
              : {};
      queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: rpc, result }));
    }
  };

  emit(value: unknown): void {
    for (const listener of this.lines) listener(value);
  }

  update(update: Record<string, unknown>): void {
    this.emit({
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: { sessionId: SESSION, update }
    });
  }

  closeTurn(promptId: string, stopReason: string): void {
    this.update({ sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: stopReason });
  }

  reply(rpc: number, stopReason: string): void {
    this.emit({ jsonrpc: '2.0', id: rpc, result: { stopReason } });
  }

  fail(rpc: number): void {
    this.emit({ jsonrpc: '2.0', id: rpc, error: { code: -32603, message: 'Internal error' } });
  }

  /** Answer a held effort change without applying it, which the session reads as refused. */
  refuseEffort(): void {
    for (const rpc of this.efforts.splice(0)) this.emit({ jsonrpc: '2.0', id: rpc, result: {} });
  }

  /** A turn Grok starts itself, named on the queue as the CLI names one. */
  wake(promptId = WAKE): void {
    this.emit({
      jsonrpc: '2.0',
      method: '_x.ai/queue/changed',
      params: { sessionId: SESSION, entries: [], runningPromptId: promptId }
    });
    this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'woke' } });
  }
}

async function opened(): Promise<{ peer: Peer; session: Session }> {
  const peer = new Peer();
  const session = new GrokSession(peer.transport, { cwd: '/tmp/project', startedAt: Date.now() });
  assert.equal((await session.opening).ok, true);
  return { peer, session };
}

async function effortHeld(peer: Peer): Promise<void> {
  for (let i = 0; i < 200 && peer.efforts.length === 0; i++) await setTimeout(5);
  assert.equal(peer.efforts.length, 1, 'the drain never asked for its effort');
}

async function prompted(peer: Peer, count: number): Promise<{ rpc: number; id: string }> {
  for (let i = 0; i < 200 && peer.prompts.length < count; i++) await setTimeout(5);
  const prompt = peer.prompts[count - 1];
  assert.ok(prompt, `prompt ${count} never reached the wire`);
  return prompt;
}

async function settled(session: Session, want: (state: LiveState) => boolean): Promise<void> {
  for (let i = 0; i < 200 && !want(session.state); i++) await setTimeout(5);
  assert.ok(want(session.state), JSON.stringify(session.state));
}

/** The three facts every case pins together: outcome, activity, what is in flight. */
function reads(session: Session): {
  outcome: LiveState['lastOutcome'];
  status: LiveState['status'];
  inFlight: string | undefined;
} {
  const s = session.state;
  return { outcome: s.lastOutcome, status: shownStatus(s), inFlight: s.inFlight?.text };
}

function listenerClocks(session: Session): {
  activity: number;
  cache: number;
  prose: number;
  changes: { origin: activity.ChangeOrigin; cacheTraffic?: boolean }[];
} {
  const clocks = {
    activity: 0,
    cache: 0,
    prose: 0,
    changes: [] as {
      origin: activity.ChangeOrigin;
      cacheTraffic?: boolean;
    }[]
  };
  let wasRunning = session.state.running;
  session.onChange((state, origin, cacheTraffic) => {
    clocks.changes.push({ origin, cacheTraffic });
    if (
      activity.advancesActivityClock({
        origin,
        status: state.status,
        turned: true,
        warm: state.warmTurn !== undefined
      })
    )
      clocks.activity++;
    if (activity.advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic }))
      clocks.cache++;
    wasRunning = state.running;
  });
  session.onActivity(() => clocks.prose++);
  return clocks;
}

describe('a Grok turn outcome, owned turn by turn', () => {
  for (const old of ['self-started', 'evicted-owned'] as const) {
    for (const current of ['named wake', 'anonymous activity'] as const) {
      it(`keeps ${old} A's stale close outside ${current}'s outcome`, async (t) => {
        const checkpoint = await import('../../core/checkpoint');
        const closes = t.mock.method(checkpoint.TurnCheckpoints.prototype, 'closeExecution');
        const { peer, session } = await opened();
        t.after(() => session.close());
        await session.send('A', [], undefined, false, { effort: 'high' });
        const a = await prompted(peer, 1);
        peer.reply(a.rpc, 'end_turn');
        await settled(session, (s) => !s.running);
        let oldId = a.id;
        if (old === 'self-started') {
          oldId = 'self-started-A';
          peer.wake(oldId);
          peer.closeTurn(oldId, 'end_turn');
        } else {
          for (let count = 2; count <= 17; count++) {
            await session.send(`real ${count}`);
            const prompt = await prompted(peer, count);
            peer.reply(prompt.rpc, 'end_turn');
            await settled(session, (s) => !s.running);
          }
          const sent: unknown = Reflect.get(session, 'sentPrompts');
          assert.ok(Array.isArray(sent));
          assert.ok(!sent.includes(oldId));
        }
        const real: unknown = Reflect.get(session, 'realPrompts');
        assert.ok(real instanceof Set);
        assert.ok(real.has(oldId));
        const clocks = listenerClocks(session);
        if (current === 'named wake') {
          peer.wake('self-started-B');
          peer.holdEffort = true;
          await session.send('queued behind B', [], undefined, false, { effort: 'high' });
          await effortHeld(peer);
          assert.equal(session.state.queued.length, 1);
        } else {
          peer.update({ sessionUpdate: 'tool_call', toolCallId: 'anonymous', title: 'real work' });
        }
        assert.deepEqual(reads(session), {
          outcome: undefined,
          status: 'busy',
          inFlight: undefined
        });
        const before = session.state;
        const beforeClocks = structuredClone(clocks);
        const beforeCloses = closes.mock.callCount();
        peer.closeTurn(oldId, 'error');
        assert.deepEqual(reads(session), {
          outcome: undefined,
          status: current === 'named wake' ? 'busy' : 'idle',
          inFlight: undefined
        });
        assert.deepEqual(session.state.queued, before.queued);
        assert.equal(clocks.activity, beforeClocks.activity);
        assert.equal(clocks.cache, beforeClocks.cache);
        assert.equal(clocks.prose, beforeClocks.prose);
        if (current === 'named wake') {
          assert.equal(session.state, before, 'A cannot mutate B');
          assert.equal(Reflect.get(session, 'foreignTurn'), 'self-started-B');
          assert.equal(closes.mock.callCount(), beforeCloses, 'B keeps its checkpoint open');
          assert.deepEqual(clocks, beforeClocks, 'A publishes no live change');
          peer.closeTurn('self-started-B', 'end_turn');
          assert.deepEqual(reads(session), {
            outcome: 'done',
            status: 'idle',
            inFlight: undefined
          });
          assert.equal(Reflect.get(session, 'foreignTurn'), undefined);
          assert.equal(closes.mock.callCount(), beforeCloses + 1, 'B closes its own checkpoint');
          assert.equal(clocks.cache, beforeClocks.cache + 1, 'B is confirmed model traffic');
          peer.refuseEffort();
          await settled(session, (s) => !s.running);
        } else {
          assert.equal(Reflect.get(session, 'foreignTurn'), undefined);
          assert.equal(closes.mock.callCount(), beforeCloses + 1, 'anonymous activity settles');
          assert.deepEqual(clocks.changes.slice(beforeClocks.changes.length), [
            { origin: 'local', cacheTraffic: false }
          ]);
        }
      });
    }
  }

  it("ignores A's late error close while B runs", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    session.send('B');
    const b = await prompted(peer, 2);
    assert.notEqual(a.id, b.id);
    peer.closeTurn(a.id, 'error');
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    peer.closeTurn(b.id, 'end_turn');
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it("does not make a wake's error the outcome of the prompt queued behind it", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.wake();
    assert.equal(session.state.running, true);
    session.send('P');
    const p = await prompted(peer, 1);
    peer.closeTurn(WAKE, 'error');
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'P' });
    peer.closeTurn(p.id, 'end_turn');
    peer.reply(p.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it("ignores the old turn's reply and close after Send now", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    session.send('B');
    await session.sendNow();
    const b = await prompted(peer, 2);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    peer.closeTurn(a.id, 'error');
    peer.fail(a.rpc);
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'busy', inFlight: 'B' });
    peer.reply(b.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
  });

  it('moves no cache clock for a turn the API refused', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const clocks = listenerClocks(session);
    session.send('A');
    const a = await prompted(peer, 1);
    // transcript.md, "Immediate-fail order": the prompt's echo, then an error close.
    peer.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'A' } });
    peer.closeTurn(a.id, 'error');
    peer.reply(a.rpc, 'error');
    await settled(session, (s) => !s.running);
    await setTimeout(10);
    assert.equal(clocks.cache, 0);
  });

  it('moves no cache clock when only the reply says the turn failed', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const clocks = listenerClocks(session);
    session.send('A');
    const a = await prompted(peer, 1);
    peer.fail(a.rpc);
    await settled(session, (s) => !s.running);
    assert.equal(clocks.cache, 0);
  });

  it('moves the cache clock when the turn completes', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    const clocks = listenerClocks(session);
    session.send('A');
    const a = await prompted(peer, 1);
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    peer.closeTurn(a.id, 'end_turn');
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    assert.ok(clocks.cache > 0);
  });

  it('records an error the notification and the reply both state once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.closeTurn(a.id, 'error');
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    peer.reply(a.rpc, 'error');
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it('records a completion the reply alone states', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.reply(a.rpc, 'rate_limit');
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it('reads a JSON-RPC error reply as a failed turn', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.fail(a.rpc);
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
  });

  it('ends a turn whose write failed without stating how', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.breakPrompts = true;
    session.send('A');
    await settled(session, (s) => s.queued.length === 0 && !s.running);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
  });

  for (const word of ['interrupted', 'max_tokens']) {
    it(`leaves stop_reason ${word} unclassified`, async (t) => {
      const { peer, session } = await opened();
      t.after(() => session.close());
      session.send('A');
      const a = await prompted(peer, 1);
      peer.closeTurn(a.id, word);
      peer.reply(a.rpc, word);
      await settled(session, (s) => !s.running);
      assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
    });
  }

  // A's frames keep coming after its reply; its own late close is then the
  // only thing that can end the re-busied card. It ends it, stating nothing.
  it("lets A's late close end a card A re-busied, without its outcome", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.closeTurn(a.id, 'end_turn');
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    peer.update({ sessionUpdate: 'tool_call', toolCallId: 'late', title: 'late-work' });
    assert.equal(session.state.running, true);
    const origins: string[] = [];
    session.onChange((_state, origin) => origins.push(origin));
    peer.closeTurn(a.id, 'error');
    // The re-busy began a turn, which cleared `done`; A's `error` is not recorded.
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
    assert.deepEqual(origins, ['local'], 'the historical close is not new model traffic');
  });

  // Send now on a row with an effort target: B's effort change is on the
  // wire, no prompt is held, and A's frames re-busy the card.
  it("lets A's close end the card while B's effort change is out, then refused", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    await session.send('B', [], undefined, false, { effort: 'high' });
    peer.holdEffort = true;
    await session.sendNow();
    await effortHeld(peer);
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail' } });
    assert.equal(session.state.running, true);
    const origins: string[] = [];
    session.onChange((_state, origin) => origins.push(origin));
    peer.closeTurn(a.id, 'cancelled');
    assert.deepEqual(origins, ['local'], 'the historical close is not new model traffic');
    peer.refuseEffort();
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
    assert.equal(peer.prompts.length, 1, 'B was refused, never sent');
  });

  // The drain rides a wake with an effort target. The wake closes while only
  // the effort change is out; refused, nothing else is left to close it.
  it("lets a wake's close through while only an effort change is out", async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    await session.send('warm', [], undefined, false, { effort: 'high' });
    const warm = await prompted(peer, 1);
    peer.reply(warm.rpc, 'end_turn');
    await settled(session, (s) => !s.running);
    peer.holdEffort = true;
    peer.wake();
    await session.send('P', [], undefined, false, { effort: 'high' });
    await effortHeld(peer);
    peer.closeTurn(WAKE, 'end_turn');
    peer.refuseEffort();
    await settled(session, (s) => !s.running);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
    assert.equal(peer.prompts.length, 1, 'P was refused, never sent');
  });
});

describe('a Grok prompt before the CLI opens its turn', () => {
  const HELD = { pid: 7, startedAt: 1, updatedAt: 1, brand: 'grok' as const };

  function unsettled(session: Session): boolean {
    return (session.state.messageFacts ?? []).some((fact) => fact.phase === 'processing');
  }

  it('reads busy with no turn open until the CLI opens one', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    await prompted(peer, 1);
    const card = toSession(session.state, HELD, 'w');
    assert.equal(session.state.running, false);
    assert.equal(card.status, 'busy');
    assert.equal(card.turnPending, true);
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    assert.equal(session.state.running, true);
    assert.equal(toSession(session.state, HELD, 'w').turnPending, undefined);
  });

  it('counts a reply that no frame opened, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.inFlight);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(unsettled(session), false);
  });

  it('counts a turn closed by turn_completed and then by its reply, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    peer.closeTurn(a.id, 'end_turn');
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.inFlight && !s.running);
    await setTimeout(10);
    assert.equal(session.state.turnsEnded, 1);
  });

  it('counts a turn_completed that no frame opened, then its reply, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.closeTurn(a.id, 'end_turn');
    peer.reply(a.rpc, 'end_turn');
    await settled(session, (s) => !s.inFlight);
    await setTimeout(10);
    assert.deepEqual(reads(session), { outcome: 'done', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
  });

  it('counts a JSON-RPC error reply that no frame opened, once', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    peer.fail(a.rpc);
    await settled(session, (s) => !s.inFlight);
    assert.deepEqual(reads(session), { outcome: 'error', status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
    assert.equal(unsettled(session), false);
  });

  it('ends a write that threw without leaving the card busy', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    peer.breakPrompts = true;
    session.send('A');
    await settled(session, (s) => s.queued.length === 0 && !s.inFlight);
    assert.deepEqual(reads(session), { outcome: undefined, status: 'idle', inFlight: undefined });
    assert.equal(session.state.turnsEnded, 1);
  });

  it('cancels the unopened prompt before Send now writes the next', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    await prompted(peer, 1);
    session.send('B');
    await session.sendNow();
    await prompted(peer, 2);
    const cancel = peer.written.indexOf('session/cancel');
    assert.ok(cancel >= 0, 'Send now sent no session/cancel');
    assert.ok(
      cancel < peer.written.lastIndexOf('session/prompt'),
      'the second prompt went out before the cancel'
    );
    assert.equal(session.state.inFlight?.text, 'B');
    assert.equal(session.state.turnsEnded, 1, "A's interrupted turn was not counted");
  });

  it('writes no second prompt before the first turn closes', async (t) => {
    const { peer, session } = await opened();
    t.after(() => session.close());
    session.send('A');
    const a = await prompted(peer, 1);
    session.send('B');
    await setTimeout(30);
    assert.equal(peer.prompts.length, 1);
    peer.reply(a.rpc, 'end_turn');
    await prompted(peer, 2);
  });
});
