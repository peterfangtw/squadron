import * as assert from 'node:assert/strict';

import { after, before, describe, it } from 'node:test';

import {
  alive,
  answeredError,
  claude,
  ClaudeSession,
  dispose,
  FAKE,
  Line,
  LiveState,
  nowhere,
  outbox,
  pipe,
  setup,
  stub,
  Transport,
  turnStarted,
  until,
  waitForControl
} from './claude_session_helpers';
import * as executables from '../../core/platform/executables';

before(async () => {
  await setup();
});

after(dispose);

/**
 * How the last turn ended, read off the real pipe: Claude's `result` against the
 * fake child, and the drain's write superseding it. The reducer alone cannot
 * show either — the trailing `idle`, the hold across the baseline and the write
 * are all the handle's.
 */
describe('the last turn’s outcome, through the pipe', () => {
  type Owned = InstanceType<ClaudeSession['OwnedSession']>;
  type Seen = { line: Record<string, unknown>; after: LiveState };

  /** A session whose every inbound line is logged beside the state it left. */
  function tapped(): { session: Owned; lines: Seen[]; states: LiveState[] } {
    const inner = pipe.childTransport({
      bin: executables.named(FAKE, process.execPath),
      cwd: nowhere,
      args: claude.PROTOCOL_ARGS,
      env: claude.PROTOCOL_ENV
    });
    const lines: Seen[] = [];
    const states: LiveState[] = [];
    // Bound once the handle exists; no line arrives before its constructor returns.
    const bound: { session?: Owned } = {};
    const transport: Transport = {
      pid: inner.pid,
      write: (value) => inner.write(value),
      onLine: (listener) =>
        inner.onLine((line) => {
          listener(line);
          const after = bound.session?.state;
          if (after) lines.push({ line: line as Record<string, unknown>, after });
        }),
      onExit: (listener) => inner.onExit(listener),
      close: () => inner.close()
    };
    const session = new claude.OwnedSession(transport, { cwd: nowhere, startedAt: 1000 });
    bound.session = session;
    alive.push(session);
    session.onChange((state) => states.push(state));
    return { session, lines, states };
  }

  const isIdleLine = ({ line }: Seen) =>
    line.subtype === 'session_state_changed' && line.state === 'idle';

  async function seen(lines: Seen[], what: string, want: (seen: Seen) => boolean): Promise<Seen> {
    for (let look = 0; look < 500; look++) {
      const hit = lines.find(want);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`never saw ${what}`);
  }

  for (const text of ['api-529', 'api-403']) {
    it(`lands ${text} as an error, and keeps it through the idle behind it`, async () => {
      const { session, lines } = tapped();
      session.send(text);
      const idle = await seen(lines, 'the trailing idle', isIdleLine);
      const result = lines.find(({ line }) => line.type === 'result');
      assert.equal(result?.line.subtype, 'success', 'the CLI still says success');
      assert.equal(result?.after.lastOutcome, 'error');
      assert.equal(result?.after.status, 'idle');
      assert.equal(idle.after.lastOutcome, 'error', 'an idle states no outcome');
      assert.equal(idle.after.status, 'idle');
    });
  }

  it('holds a message across a failing turn; its write clears, its init reads busy', async () => {
    const { session, states } = tapped();
    session.send('api-retry');
    await until(session, 'the retrying turn', (s) => s.status === 'busy');
    session.send('next turn');
    assert.equal(session.state.queued.length, 1, 'held while the retries run');
    await until(session, 'the next turn to finish', (s) => s.lastOutcome === 'done');

    const failedAt = states.findIndex((s) => s.lastOutcome === 'error');
    assert.ok(failedAt >= 0, 'the failing turn recorded an error');
    assert.equal(states[failedAt]?.status, 'idle');
    const wroteAt = states.findIndex((s, at) => at > failedAt && s.queued.length === 0);
    assert.ok(wroteAt > failedAt, 'the held message drained behind the error');
    for (const held of states.slice(failedAt, wroteAt)) {
      assert.equal(held.lastOutcome, 'error', 'a held message supersedes nothing');
    }
    const wrote = states[wroteAt];
    assert.equal(wrote?.inFlight?.text, 'next turn');
    assert.equal(wrote?.lastOutcome, undefined, 'the write supersedes the error');
    assert.equal(wrote?.status, 'idle', 'not busy before the CLI speaks');
    const busyAt = states.findIndex((s, at) => at > wroteAt && s.status === 'busy');
    assert.ok(busyAt > wroteAt, 'the next init reads busy');
    assert.equal(states[busyAt]?.lastOutcome, undefined);
  });

  it('reads an interrupt as interrupted', async () => {
    const { session, lines } = tapped();
    session.send('slow work');
    await until(session, 'the turn to start', (s) => s.status === 'busy');
    await session.interrupt();
    const idle = await seen(lines, 'the trailing idle', isIdleLine);
    const result = lines.find(({ line }) => line.type === 'result');
    assert.equal(result?.line.terminal_reason, 'aborted_streaming');
    assert.equal(idle.after.lastOutcome, 'interrupted');
    assert.equal(idle.after.status, 'idle');
  });

  const FAILED: Line = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 529,
    terminal_reason: 'api_error'
  };

  it('keeps the error through a dismissed send, until a written one', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const states: LiveState[] = [];
    session.onChange((state) => states.push(state));
    rig.answer(turnStarted('claude-opus-5'));
    rig.answer(FAILED);
    assert.equal(session.state.lastOutcome, 'error');
    session.send('dropped');
    assert.equal(session.dismiss(session.state.queued[0]?.id ?? ''), true);
    assert.equal(session.state.lastOutcome, 'error');
    session.send('kept');
    const from = states.length;
    await until(session, 'the kept send written', (s) => s.inFlight?.text === 'kept');
    const turns = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(turns.length, 1);
    assert.ok(!JSON.stringify(turns[0]).includes('dropped'));
    const wroteAt = states.findIndex((s, at) => at >= from && s.inFlight?.text === 'kept');
    for (const held of states.slice(0, wroteAt).filter((s) => !s.running)) {
      assert.equal(held.lastOutcome, 'error');
    }
    assert.equal(states[wroteAt]?.lastOutcome, undefined);
  });

  it('keeps the error through a send the CLI refused', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const states: LiveState[] = [];
    session.onChange((state) => states.push(state));
    rig.answer(turnStarted('claude-opus-5'));
    session.send('first', [], undefined, false, { model: 'claude-sonnet-5' });
    session.send('second');
    rig.answer(FAILED);
    const request = await waitForControl(rig.written, 'set_model');
    rig.answer(answeredError(request.request_id as string, 'no'));
    // `second` can only be written once `first`'s refusal has been taken.
    await outbox(session, 1);
    const wroteAt = states.findIndex((s) => s.inFlight?.text === 'second');
    const failedAt = states.findIndex((s) => s.lastOutcome === 'error');
    for (const held of states.slice(failedAt, wroteAt)) {
      assert.equal(held.lastOutcome, 'error', 'a refused send supersedes nothing');
    }
    assert.equal(states[wroteAt]?.lastOutcome, undefined);
    assert.equal(session.state.queued[0]?.text, 'first');
  });
});
