import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import type { LiveState } from '../../core/live';
import {
  UNROUTED,
  isRefused,
  routeTo,
  type Act,
  type RoutedHandle
} from '../../core/coordination/route';

const state = (queued = 0): LiveState => ({
  cwd: '/work/app',
  startedAt: 0,
  status: 'idle',
  queued: Array.from({ length: queued }, (_, i) => ({
    id: `q${i}`,
    text: '',
    queuedAt: 0
  })),
  pending: [],
  running: false,
  turnsEnded: 0
});

function handle(over: Partial<SessionHandle> = {}): SessionHandle {
  return {
    state: state(),
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
        history: { exchanges: [], firstSeen: new Map(), checkpoints: new Map() },
        recent: { exchanges: [], truncated: false },
        tail: []
      }),
      recovered: Promise.resolve(true),
      onChange: () => () => {}
    },
    ...over
  };
}

function routed(
  over: {
    owned?: SessionHandle;
    stateName?: (title: string) => Promise<Act>;
  } = {}
) {
  return routeTo({
    owned: over.owned,
    ...(over.stateName ? { stateName: over.stateName } : {})
  });
}

function ok(result: ReturnType<typeof routeTo>): RoutedHandle {
  assert.equal(isRefused(result), false, 'expected a handle');
  return result as RoutedHandle;
}

describe('routeTo', () => {
  it('reads a send to an idle session as on the pipe, and one to a busy session as held', async () => {
    for (const [running, held] of [
      [false, 0],
      [true, 1]
    ] as const) {
      const live = { ...state(), running };
      const owned = handle({
        state: live,
        messages: {
          images: false,
          pending: () => running,
          // Enqueued and not yet written, as a handle capturing a baseline is.
          send: (text) => void live.queued.push({ id: 'q', text, queuedAt: 0 }),
          dismiss: () => true,
          sendNow: async () => {}
        }
      });
      const act = await ok(routed({ owned })).messages?.send('hello', []);
      assert.deepEqual(act, { ok: true, queued: held });
    }
  });

  it('forwards message identity and reports only the handle’s authoritative facts', async () => {
    const live = state();
    const facts = [{ correlation: 'earlier', phase: 'done' as const }];
    let received: string | undefined;
    const owned = handle({
      state: live,
      messages: {
        images: false,
        pending: () => false,
        send(_text, _images, _describe, _ahead, _target, correlation) {
          received = correlation;
          live.messageFacts = facts;
        },
        dismiss: () => false,
        sendNow: async () => {}
      }
    });
    const sent = await ok(routed({ owned })).messages?.send(
      'same words',
      [],
      undefined,
      undefined,
      undefined,
      'current'
    );
    assert.equal(received, 'current');
    assert.deepEqual(sent, { ok: true, queued: 0, messageFacts: facts });
    assert.equal(
      sent?.messageFacts?.some((fact) => fact.correlation === 'current'),
      false
    );
  });

  it('wraps the owned handle, carrying its capabilities through', () => {
    const owned = handle({
      turn: { interrupt: async () => {} },
      messages: {
        images: false,
        pending: () => false,
        send: () => {},
        dismiss: () => true,
        sendNow: async () => {}
      }
    });
    const result = ok(routed({ owned }));
    assert.ok(result.turn);
    assert.equal(result.messages?.images, false);
  });

  it('offers naming on an owned handle whose CLI has no rename door', () => {
    // The whole point of the writer being passed in: `SessionHandle.naming`
    // says whether the *CLI* can be told, and the statement is ours either way.
    const said: string[] = [];
    const result = ok(
      routed({
        owned: handle(),
        stateName: (title) => {
          said.push(title);
          return Promise.resolve({ ok: true });
        }
      })
    );
    assert.ok(result.naming);
    return result.naming.rename('Own the stated name').then((act) => {
      assert.deepEqual(act, { ok: true });
      assert.deepEqual(said, ['Own the stated name']);
    });
  });

  it('routes an owned rename through the writer, never the handle', () => {
    // A brand with a door still gets it — `stateName` calls it last — but the
    // route must not reach past the one writer to do it, or the store and the
    // paint are skipped for whichever door took this path.
    let direct = 0;
    const result = ok(
      routed({
        owned: handle({ naming: { rename: () => void direct++ } }),
        stateName: () => Promise.resolve({ ok: true })
      })
    );
    return result.naming?.rename('Own the stated name').then(() => {
      assert.equal(direct, 0);
    });
  });

  it('carries the writer’s refusal back verbatim', () => {
    const result = ok(
      routed({
        owned: handle(),
        stateName: () => Promise.resolve({ ok: false, reason: 'A rename needs a name.' })
      })
    );
    return result.naming?.rename(' ').then((act) => {
      assert.deepEqual(act, { ok: false, reason: 'A rename needs a name.' });
    });
  });

  it('refuses when no window can write', () => {
    const result = routed();
    assert.ok(isRefused(result));
    assert.equal(result.sentence, UNROUTED);
  });

  it('calls the owned interrupt while a turn runs and reports it as an Act', async () => {
    // The `Act` shape outlived the arm it was adopted for: a remote call was a
    // round trip and this one is not, but `wrapOwned` is still where a thrown
    // verb becomes a sentence the dock paints.
    let called = false;
    const owned = handle({
      state: { ...state(), running: true },
      turn: {
        interrupt: () => {
          called = true;
          return Promise.resolve();
        }
      }
    });
    const local = ok(routed({ owned }));
    assert.deepEqual(await local.turn?.interrupt(), { ok: true });
    assert.equal(called, true);
  });

  it('returns an interrupt refusal when a running turn throws', async () => {
    const owned = handle({
      state: { ...state(), running: true },
      turn: { interrupt: () => Promise.reject(new Error('pipe closed')) }
    });
    const local = ok(routed({ owned }));
    assert.deepEqual(await local.turn?.interrupt(), {
      ok: false,
      reason: 'That session did not answer the interrupt: pipe closed'
    });
  });

  it('returns idle without an adapter call, from the handle state at the call', async () => {
    // The reducer replaces `state`. A flag copied when the route is built
    // would still see the first object.
    let called = 0;
    let current = { ...state(), running: true };
    const owned = handle({
      turn: {
        interrupt: () => {
          called += 1;
          return Promise.resolve();
        }
      }
    });
    Object.defineProperty(owned, 'state', { get: () => current });
    const local = ok(routed({ owned }));
    current = { ...current, running: false };
    assert.deepEqual(await local.turn?.interrupt(), { ok: true, idle: true });
    assert.equal(called, 0);
    current = { ...current, running: true };
    assert.deepEqual(await local.turn?.interrupt(), { ok: true });
    assert.equal(called, 1);
  });

  it('returns an asynchronous send refusal instead of losing it', async () => {
    const local = ok(
      routed({
        owned: handle({
          messages: {
            images: true,
            pending: () => false,
            send: () => Promise.reject(new Error('model refused')),
            dismiss: () => true,
            sendNow: () => Promise.resolve()
          }
        })
      })
    );

    assert.deepEqual(await local.messages?.send('hello'), {
      ok: false,
      reason: 'Could not send that message: model refused'
    });
  });

  it('does not call every unsent answer a withdrawn request', async () => {
    const local = ok(
      routed({
        owned: handle({ asks: { respond: () => false } })
      })
    );
    assert.deepEqual(await local.asks?.respond('req', { allow: true }), {
      ok: false,
      reason: 'That request is no longer open, or this answer is not supported.'
    });
  });

  it('does not call a refused dismiss a success', async () => {
    const local = ok(
      routed({
        owned: handle({
          messages: {
            images: true,
            pending: () => false,
            send: () => {},
            dismiss: () => false,
            sendNow: () => Promise.resolve()
          }
        })
      })
    );
    assert.deepEqual(await local.messages?.dismiss('q1'), {
      ok: false,
      reason: 'That message had already been sent.'
    });
  });

  it('offers no model group, whatever the handle carries', () => {
    // `RoutedHandle` has no `model`: the model pick is the panel's own path and
    // never went through a route.
    const owned = handle({
      turn: { interrupt: () => Promise.resolve() },
      model: { set: () => Promise.resolve() }
    });
    const result = ok(routed({ owned }));
    assert.ok(result.turn);
    assert.equal('model' in result, false);
    assert.equal(isRefused(result), false);
  });
});
