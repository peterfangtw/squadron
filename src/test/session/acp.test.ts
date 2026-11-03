import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AcpClient, JsonRpcFailure } from '../../core/acp';
import type { ExitInfo, SessionTransport } from '../../core/session';

/**
 * A pipe the test answers, the same stub `claude_session_helpers.ts` uses: writes are
 * recorded, `answer` is one JSON-RPC value on the way back.
 */
function stub(): {
  written: Record<string, unknown>[];
  answer: (value: unknown) => void;
  transport: SessionTransport;
  exit: () => void;
  end: () => void;
} {
  const written: Record<string, unknown>[] = [];
  const lines: ((value: unknown) => void)[] = [];
  const exits: ((info: ExitInfo) => void)[] = [];
  const ends: (() => void)[] = [];
  return {
    exit: () => exits.forEach((listener) => listener({ code: 1, signal: null, source: 'exit' })),
    end: () => ends.forEach((listener) => listener()),
    written,
    answer: (value) => {
      for (const listener of lines) {
        listener(value);
      }
    },
    transport: {
      write: (value) => written.push(value as Record<string, unknown>),
      onLine: (listener) => lines.push(listener),
      onExit: (listener) => {
        exits.push(listener);
      },
      onEnd: (listener) => {
        ends.push(listener);
      },
      close: () => undefined
    }
  };
}

describe('AcpClient', () => {
  it('retires cancelled and timed-out waiters without replaying their native writes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const peer = stub();
    const client = new AcpClient(peer.transport);
    const abort = new AbortController();
    const cancelled = client.request('initialize', {}, 30_000, abort.signal);
    abort.abort(new Error('opening cancelled'));
    await assert.rejects(cancelled, /cancelled/);
    const timed = client.request('session/new', {}, 30_000);
    t.mock.timers.tick(30_000);
    await assert.rejects(timed, /outcome unknown/);
    peer.answer({ jsonrpc: '2.0', id: 1, result: 'late' });
    peer.answer({ jsonrpc: '2.0', id: 2, result: 'late' });
    const next = client.request('ping');
    peer.answer({ jsonrpc: '2.0', id: 3, result: 'healthy' });
    assert.equal(await next, 'healthy');
    assert.equal(peer.written.length, 3);
  });
  for (const ending of ['exit', 'end'] as const) {
    it(`rejects pending and future requests after transport ${ending}`, async () => {
      const peer = stub();
      const client = new AcpClient(peer.transport);
      const request = client.request('initialize');
      peer[ending]();
      await assert.rejects(request, /stopped|closed|exited/i);
      await assert.rejects(client.request('session/new'), /stopped|closed|exited/i);
      assert.equal(peer.written.length, 1);
    });
  }
  it('drives initialize and a second request through a fake peer', async () => {
    const { written, answer, transport } = stub();
    const client = new AcpClient(transport);

    const init = client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'squadron', version: '0' }
    });
    assert.deepEqual(written[0], {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'squadron', version: '0' }
      }
    });
    answer({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    });
    const hello = await init;
    assert.equal(hello.protocolVersion, 1);
    assert.deepEqual(hello.agentCapabilities, { loadSession: true });

    const ping = client.request('ping', { n: 1 });
    assert.equal(written[1]?.method, 'ping');
    assert.equal(written[1]?.id, 2);
    answer({ jsonrpc: '2.0', id: 2, result: { n: 1 } });
    assert.deepEqual(await ping, { n: 1 });
  });

  it('rejects a result that is an error', async () => {
    const { answer, transport } = stub();
    const client = new AcpClient(transport);
    const pending = client.request('nope');
    answer({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' }
    });
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof JsonRpcFailure);
      assert.equal(err.code, -32601);
      assert.equal(err.message, 'Method not found');
      return true;
    });
  });

  it('delivers a notification and an incoming request', () => {
    const { written, answer, transport } = stub();
    const client = new AcpClient(transport);
    const notes: [string, unknown][] = [];
    const asks: [unknown, string, unknown][] = [];
    client.onNotification((method, params) => notes.push([method, params]));
    client.onRequest((id, method, params) => asks.push([id, method, params]));

    answer({ jsonrpc: '2.0', method: 'session/update', params: { text: 'hi' } });
    assert.deepEqual(notes, [['session/update', { text: 'hi' }]]);

    answer({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/a' } });
    assert.deepEqual(asks, [[7, 'fs/read_text_file', { path: '/a' }]]);
    client.reply(7, { content: 'x' });
    assert.deepEqual(written[0], { jsonrpc: '2.0', id: 7, result: { content: 'x' } });
  });

  it('drops a line that is not JSON-RPC 2.0', async () => {
    const { answer, transport } = stub();
    const client = new AcpClient(transport);
    const notes: string[] = [];
    client.onNotification((method) => notes.push(method));
    answer({ type: 'stream_event' });
    answer({ jsonrpc: '1.0', method: 'nope' });
    assert.deepEqual(notes, []);

    const pending = client.request('still');
    answer({ jsonrpc: '2.0', id: 1, result: 'ok' });
    assert.equal(await pending, 'ok');
  });
});
