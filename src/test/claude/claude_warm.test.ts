import * as assert from 'node:assert/strict';

import { after, before, describe, it } from 'node:test';

import {
  ClaudeSession,
  Line,
  LiveState,
  Outbound,
  alive,
  answeredError,
  claude,
  dispose,
  dying,
  nowhere,
  record,
  setup,
  stub,
  waitForControl
} from './claude_session_helpers';

before(async () => {
  await setup();
});

after(dispose);

describe('a cache-warming ping', () => {
  type Owned = InstanceType<ClaudeSession['OwnedSession']>;
  const INIT: Line = { type: 'system', subtype: 'init', session_id: 'warm-s', cwd: '/w' };
  const IDLE: Line = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  const result = (subtype = 'success'): Line => ({ type: 'result', subtype, is_error: false });
  const read = (tokens: number): Line => ({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 2, cache_read_input_tokens: tokens }
      }
    }
  });
  const toolStart: Line = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Bash' }
    }
  };
  const asks: Line = {
    type: 'control_request',
    request_id: 'req-w',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 't1',
      input: { command: 'ls' }
    }
  };
  const users = (written: Outbound[]) => written.filter((frame) => frame.type === 'user');
  const controls = (written: Outbound[], subtype: string) =>
    written.filter(
      (frame) =>
        frame.type === 'control_request' &&
        (frame.request as { subtype?: unknown } | undefined)?.subtype === subtype
    );

  async function settled(session: Owned, what: string, want: (state: LiveState) => boolean) {
    for (let look = 0; look < 300; look++) {
      if (want(session.state)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`never reached ${what}`);
  }

  /** An idle session that has had one conversation turn, on a stub pipe. */
  function idle(rig = stub()) {
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    alive.push(session);
    rig.answer(INIT);
    rig.answer(result());
    rig.answer(IDLE);
    session.state.contextPct = 10;
    return { session, rig };
  }

  it('projects Claude captured warm reply identity through persisted recovery', async () => {
    const { session, rig } = idle();
    assert.equal(session.warm?.ping().ok, true);
    const warmId = session.state.warmTurn?.id;
    assert.ok(warmId);
    rig.answer(INIT);
    rig.answer({
      type: 'assistant',
      message: { id: 'warm-reply', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
    });
    rig.answer(result());
    await session.flush();
    const { Thread } = await import('../../core/thread');
    const saved = await record.readRecordLines(session.state.sessionId!);
    assert.ok(saved);
    const recovered = new Thread({ brand: 'claude' }, session.state.sessionId);
    await recovered.current.recover(() =>
      Promise.resolve({ lines: saved.lines, ours: true, partial: false })
    );
    const views = await import('../../ui/views');
    const state = await import('../../core/live');
    for (const shot of [session.thread.snapshot(), recovered.snapshot()]) {
      const reply = shot.history.exchanges.find((x) => 'role' in x && x.text === 'OK');
      assert.ok(reply && 'role' in reply && reply.maintenance === true);
      assert.equal(reply.warmId, warmId);
      const view = views.composeThread(
        state.toSession(
          session.state,
          { pid: 1, brand: 'claude', startedAt: 1, updatedAt: 1 },
          'w'
        ),
        {
          history: {
            exchanges: shot.history.exchanges.map((x) =>
              'role' in x ? { ...x, blocks: [{ prose: x.text }] } : x
            )
          },
          live: session.state
        },
        {}
      );
      assert.ok(!view.exchanges.some((x) => 'role' in x && x.text === 'OK'));
      const ping = view.exchanges.find((x): x is AuthoredView => 'role' in x && x.role === 'warm');
      assert.equal(ping?.warmId, warmId);
    }
  });

  /** Whether each change moved the host's cache clock, as `moveClock` reads it. */
  async function cacheClock(session: Owned): Promise<boolean[]> {
    const { advancesCacheClock } = await import('../../core/activity');
    const moved: boolean[] = [];
    let wasRunning = session.state.running;
    session.onChange((state, origin, cacheTraffic) => {
      moved.push(advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic }));
      wasRunning = state.running;
    });
    return moved;
  }

  it('moves no cache clock for a ping the API never answered', async () => {
    const { session, rig } = idle();
    const moved = await cacheClock(session);
    assert.equal(session.warm?.ping().ok, true);
    // protocol.md, the 529 row: a synthetic reply and an `api_error` result.
    rig.answer(INIT);
    rig.answer({
      type: 'assistant',
      error: 'server_error',
      is_api_error_message: true,
      message: {
        id: 'warm-529',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }]
      }
    });
    rig.answer({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 529
    });
    rig.answer(IDLE);
    assert.equal(session.state.warmTurn?.failed, true);
    assert.ok(moved.length > 0);
    assert.deepEqual(
      moved.filter((x) => x),
      []
    );
    assert.equal(session.state.warmTurn?.trafficAt, undefined);
  });

  it('moves the cache clock when the model starts answering, not when the turn opens', async () => {
    const { session, rig } = idle();
    const moved = await cacheClock(session);
    assert.equal(session.warm?.ping().ok, true);
    rig.answer(INIT);
    assert.equal(moved.includes(true), false, 'init is the CLI, not the API');
    rig.answer(read(900));
    assert.equal(moved.at(-1), true);
    assert.ok(session.state.warmTurn?.trafficAt);
  });

  it('dates a successful reply-only result without an opening frame', () => {
    const { session, rig } = idle();
    session.warm?.ping();
    rig.answer({ ...result(), terminal_reason: 'completed' });
    assert.equal(session.state.warmTurn?.phase, 'closed');
    assert.ok(session.state.warmTurn?.trafficAt);
    const confirmed = session.state.warmTurn.trafficAt;
    rig.answer(IDLE);
    assert.equal(session.state.warmTurn?.trafficAt, confirmed);
  });

  it('writes one wrapped prompt straight to the pipe and keeps the card idle', () => {
    const { session, rig } = idle();
    const origins: string[] = [];
    session.onChange((_, origin) => origins.push(origin));
    assert.deepEqual(session.warm?.ping(), { ok: true });
    const [sent] = users(rig.written);
    assert.match(JSON.stringify(sent), /squadron-warm/);
    assert.deepEqual(session.state.queued, [], 'never through the outbox');
    assert.equal(session.state.firstPrompt, undefined, 'never a first prompt');
    assert.equal(session.state.warmTurn?.phase, 'written');
    assert.deepEqual(origins, ['prompt']);
    assert.deepEqual(session.warm?.ping(), { ok: false, reason: 'The session is not idle.' });

    rig.answer(INIT);
    rig.answer(read(900));
    assert.equal(session.state.warmTurn?.phase, 'open');
    assert.equal(session.state.warmTurn?.cached, 900);
    assert.equal(session.state.running, true);
    rig.answer(result());
    rig.answer(IDLE);
    assert.equal(session.state.warmTurn?.phase, 'closed');
    assert.equal(session.state.warmTurn?.failed, undefined);
    assert.equal(users(rig.written).length, 1);
  });

  it('writes warm pings regardless of context usage', () => {
    for (const pct of [undefined, -1, NaN, Infinity, 80, 100]) {
      const { session, rig } = idle();
      session.state.contextPct = pct;
      assert.deepEqual(session.warm?.ping(), { ok: true });
      assert.equal(users(rig.written).length, 1);
    }
  });

  it('refuses a session with no conversation, a held message, or a turn running', () => {
    const bare = stub();
    const fresh = new claude.OwnedSession(bare.transport, { cwd: nowhere, startedAt: 1000 });
    alive.push(fresh);
    assert.deepEqual(fresh.warm?.ping(), {
      ok: false,
      reason: 'The session has no conversation to keep warm.'
    });
    const { session, rig } = idle();
    rig.answer(INIT);
    assert.equal(session.warm?.ping().ok, false, 'a turn is running');
    session.send('held');
    rig.answer(result());
    assert.equal(session.warm?.ping().ok, false, 'a message waits or is being written');
    assert.equal(
      users(rig.written).some((frame) => /squadron-warm/.test(JSON.stringify(frame))),
      false
    );
  });

  it('holds a real message behind the ping and writes it once the ping closes', async () => {
    const { session, rig } = idle();
    session.warm?.ping();
    session.send('real work');
    assert.equal(session.state.queued.length, 1);
    rig.answer(IDLE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(users(rig.written).length, 1, 'a stale idle frees nothing');
    rig.answer(INIT);
    rig.answer(result());
    await settled(session, 'the held message written', (s) => s.queued.length === 0);
    assert.equal(users(rig.written).length, 2);
    assert.equal(session.state.warmTurn, undefined, 'the real drain clears the latch');
  });

  it('denies a tool request, opens nothing, and interrupts the ping', () => {
    const { session, rig } = idle();
    session.warm?.ping();
    rig.answer(INIT);
    rig.answer(asks);
    assert.deepEqual(session.state.pending, [], 'no dialog for a maintenance turn');
    const deny = rig.written.find((frame) => frame.type === 'control_response');
    assert.match(JSON.stringify(deny), /"behavior":"deny"/);
    assert.match(JSON.stringify(deny), /req-w/);
    assert.equal(controls(rig.written, 'interrupt').length, 1);
    assert.equal(session.state.warmTurn?.failed, true);
    assert.equal(session.state.warmTurn?.phase, 'open', 'cut, not yet ended');
    rig.answer(result('error_during_execution'));
    assert.equal(session.state.warmTurn?.phase, 'closed');
    assert.equal(session.state.warmTurn?.failed, true);
  });

  it('interrupts once when the ping starts a tool nobody had to allow', () => {
    const { session, rig } = idle();
    session.warm?.ping();
    rig.answer(INIT);
    rig.answer(toolStart);
    rig.answer(toolStart);
    assert.equal(controls(rig.written, 'interrupt').length, 1);
    assert.equal(session.state.warmTurn?.failed, true);
  });

  it('closes a ping the CLI ended before its turn opened, and frees the drain', async () => {
    const { session, rig } = idle();
    session.warm?.ping();
    session.send('after');
    rig.answer({ ...result('error_during_execution'), terminal_reason: 'aborted_streaming' });
    assert.equal(session.state.warmTurn?.phase, 'closed');
    await settled(session, 'the held message written', (s) => s.queued.length === 0);
  });

  it('closes failed when the child dies while the ping is in flight', () => {
    const rig = dying();
    const { session } = idle(rig);
    session.warm?.ping();
    rig.exit();
    assert.equal(session.state.warmTurn?.phase, 'closed');
    assert.equal(session.state.warmTurn?.failed, true);
  });

  it('asks no title off a ping', async () => {
    const { session, rig } = idle();
    session.send('name me after this');
    await settled(session, 'the first message written', (s) => s.queued.length === 0);
    rig.answer(INIT);
    const asked = await waitForControl(rig.written, 'generate_session_title');
    rig.answer(answeredError(String(asked.request_id), 'no'));
    rig.answer(result());
    rig.answer(IDLE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.warm?.ping();
    rig.answer(INIT);
    rig.answer(result());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(controls(rig.written, 'generate_session_title').length, 1);
  });
});
