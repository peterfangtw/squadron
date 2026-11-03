import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexClient, CodexFailure } from '../../core/codex/client';
import type { ExitInfo, SessionTransport } from '../../core/session';

class Peer {
  readonly written: unknown[] = [];
  private lines: ((value: unknown) => void)[] = [];
  private exits: ((info: ExitInfo) => void)[] = [];

  readonly transport: SessionTransport = {
    pid: 7,
    write: (value) => this.written.push(value),
    onLine: (listener) => this.lines.push(listener),
    onExit: (listener) => this.exits.push(listener),
    close: () => undefined
  };

  line(value: unknown): void {
    for (const listener of this.lines) listener(value);
  }

  exit(info: ExitInfo): void {
    for (const listener of this.exits) listener(info);
  }
}

describe('CodexClient', () => {
  it('writes the app-server envelope and correlates numeric responses', async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const pending = client.request('thread/start', { cwd: '/tmp/project' });
    assert.deepEqual(peer.written, [
      { method: 'thread/start', id: 1, params: { cwd: '/tmp/project' } }
    ]);
    assert.ok(!('jsonrpc' in (peer.written[0] as Record<string, unknown>)));
    peer.line({ id: 1, result: { thread: 't1' } });
    assert.deepEqual(await pending, { thread: 't1' });
  });

  it('keeps notifications and incoming requests distinct', () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const notifications: unknown[] = [];
    const requests: unknown[] = [];
    client.onNotification((method, params) => notifications.push({ method, params }));
    client.onRequest((id, method, params) => requests.push({ id, method, params }));

    peer.line({ method: 'thread/status/changed', params: { status: { type: 'idle' } } });
    peer.line({ id: 'ask-1', method: 'item/tool/requestUserInput', params: { questions: [] } });

    assert.deepEqual(notifications, [
      { method: 'thread/status/changed', params: { status: { type: 'idle' } } }
    ]);
    assert.deepEqual(requests, [
      {
        id: 'ask-1',
        method: 'item/tool/requestUserInput',
        params: { questions: [] }
      }
    ]);
  });

  it('does not accept JSON-RPC frames on the Codex correlator', async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const pending = client.request('initialize');
    peer.line({ jsonrpc: '2.0', id: 1, result: { wrongWire: true } });
    peer.line({ id: 1, result: { userAgent: 'codex' } });
    assert.deepEqual(await pending, { userAgent: 'codex' });
  });

  it('omits params for app-server methods whose request has none', async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const pending = client.request('account/logout');
    assert.deepEqual(peer.written, [{ method: 'account/logout', id: 1 }]);
    peer.line({ id: 1, result: {} });
    await pending;
  });

  it('rejects protocol errors with their code and data', async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const pending = client.request('initialize');
    peer.line({ id: 1, error: { code: -32000, message: 'refused', data: { why: 'fixture' } } });
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof CodexFailure);
      assert.equal(error.code, -32000);
      assert.deepEqual(error.data, { why: 'fixture' });
      return true;
    });
  });

  it('rejects every pending and future request when the child exits', async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const first = client.request('initialize');
    const second = client.request('thread/start');
    peer.exit({ code: 17, signal: null, stderr: 'fixture refusal', source: 'exit' });
    await assert.rejects(first, /exited with code 17: fixture refusal/);
    await assert.rejects(second, /exited with code 17: fixture refusal/);
    await assert.rejects(client.request('thread/read'), /exited with code 17/);
  });

  it('times out a silent request', async () => {
    const client = new CodexClient(new Peer().transport, 5);
    await assert.rejects(client.request('initialize'), /Timed out waiting for Codex initialize/);
  });
});

it(
  'bounds an optional startup request without changing the default timeout',
  { timeout: 1000 },
  async () => {
    const peer = new Peer();
    const client = new CodexClient(peer.transport);
    const optional = client.request(
      'config/read',
      { cwd: '/tmp/project', includeLayers: false },
      5
    );
    const ordinary = client.request('thread/start', { cwd: '/tmp/project' });
    await assert.rejects(optional, /Timed out waiting for Codex config\/read/);
    peer.line({ id: 2, result: { thread: 'still-pending' } });
    assert.deepEqual(await ordinary, { thread: 'still-pending' });
  }
);
