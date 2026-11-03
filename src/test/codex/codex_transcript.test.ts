import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { CodexConnection, CodexRpc } from '../../core/codex/runtime';
let readStoredTranscript: typeof import('../../core/codex/transcript').readStoredTranscript;
let resetCodexFallbackForTest: typeof import('../../core/codex/transcript').resetCodexFallbackForTest;

class FakeRpc implements CodexRpc {
  readonly methods: string[] = [];
  request(method: string): Promise<unknown> {
    this.methods.push(method);
    if (method === 'thread/turns/list') {
      return Promise.resolve({
        data: [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2 }],
        nextCursor: null
      });
    }
    if (method === 'thread/items/list') {
      return Promise.resolve({
        data: [
          {
            turnId: 'turn-1',
            item: {
              type: 'userMessage',
              id: 'user-1',
              content: [{ type: 'text', text: 'hello', text_elements: [] }]
            }
          }
        ],
        nextCursor: null
      });
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  }
  notify(): void {}
  onNotification(): () => void {
    return () => undefined;
  }
}

beforeEach(() => resetCodexFallbackForTest());

describe('Codex stored transcript fallback', () => {
  it('coalesces concurrent polls onto one helper connection', async () => {
    const rpc = new FakeRpc();
    let connects = 0;
    let release: ((value: { ok: true; connection: CodexConnection }) => void) | undefined;
    const connected = new Promise<{ ok: true; connection: CodexConnection }>((resolve) => {
      release = resolve;
    });
    const connection: CodexConnection = {
      client: rpc,
      onExit: () => undefined,
      close: () => undefined
    };
    const connector = () => {
      connects++;
      return connected;
    };
    const session = { sessionId: 'thread-concurrent', cwd: '/repo' };
    const first = readStoredTranscript(session, undefined, connector, () => 100);
    const second = readStoredTranscript(session, undefined, connector, () => 101);
    assert.equal(connects, 1);
    assert.ok(release);
    release({ ok: true, connection });
    assert.strictEqual(await second, await first);
    assert.equal(connects, 1);
  });

  it('reads without resume, passes the configured binary, and holds one process across polls', async () => {
    const rpc = new FakeRpc();
    let connects = 0;
    let closes = 0;
    let override: string | undefined;
    const connector = (path?: string) => {
      connects++;
      override = path;
      const connection: CodexConnection = {
        client: rpc,
        onExit: () => undefined,
        close: () => {
          closes++;
        }
      };
      return Promise.resolve({ ok: true as const, connection });
    };
    const session = { sessionId: 'thread-1', cwd: '/repo' };
    const first = await readStoredTranscript(
      session,
      '/configured/codex',
      connector,
      () => 100_000
    );
    const second = await readStoredTranscript(
      session,
      '/configured/codex',
      connector,
      () => 100_001
    );
    assert.strictEqual(second, first);
    assert.deepEqual(rpc.methods, ['thread/turns/list', 'thread/items/list']);
    assert.ok(!rpc.methods.includes('thread/resume'));
    assert.equal(override, '/configured/codex');
    assert.equal(connects, 1);
    assert.equal(closes, 1);
    assert.equal(first.recent.exchanges.length, 1);
  });

  it('ages the held read from when it landed, not from when it was asked for', async () => {
    const rpc = new FakeRpc();
    const connection: CodexConnection = {
      client: rpc,
      onExit: () => undefined,
      close: () => undefined
    };
    const session = { sessionId: 'thread-slow', cwd: '/repo' };
    // The clock only moves inside the connect, so the two stampings disagree:
    // landing says 20_000, the call that asked for it says 0.
    let at = 0;
    const clock = () => at;
    await readStoredTranscript(
      session,
      undefined,
      () => {
        at = 20_000;
        return Promise.resolve({ ok: true as const, connection });
      },
      clock
    );
    at = 30_000;
    let again = 0;
    await readStoredTranscript(
      session,
      undefined,
      () => {
        again++;
        return Promise.resolve({ ok: true as const, connection });
      },
      clock
    );
    // 10s old off the landing, so held. Stamped at call time it would read as
    // 30s old and spawn a second helper.
    assert.equal(again, 0);
  });

  it('keeps the last complete read when a later helper cannot connect', async () => {
    const rpc = new FakeRpc();
    const connection: CodexConnection = {
      client: rpc,
      onExit: () => undefined,
      close: () => undefined
    };
    const session = { sessionId: 'thread-2', cwd: '/repo' };
    const good = await readStoredTranscript(
      session,
      undefined,
      () => Promise.resolve({ ok: true as const, connection }),
      () => 1
    );
    const held = await readStoredTranscript(
      session,
      undefined,
      () => Promise.resolve({ ok: false as const, reason: 'missing' }),
      () => 20_000
    );
    assert.strictEqual(held, good);
  });
});

import { before } from 'node:test';

import { CodexFailure } from '../../core/codex/client';

import type { Session } from '../../core/model';

import { wrapWarm } from '../../core/coordination/send';

import { tempHome } from '../helpers';

type AdapterModule = typeof import('../../core/adapter');

type RecordModule = typeof import('../../core/record');

let adapter: AdapterModule;

let record: RecordModule;

let readPaginated: typeof import('../../core/codex/transcript').readPaginated;

let registerTranscriptReader: typeof import('../../core/codex/transcript').registerTranscriptReader;

let transcriptFromPages: typeof import('../../core/codex/transcript').transcriptFromPages;

before(async () => {
  await tempHome();
  ({ readStoredTranscript, resetCodexFallbackForTest } =
    await import('../../core/codex/transcript'));
  adapter = await import('../../core/adapter');
  record = await import('../../core/record');
  ({ readPaginated, registerTranscriptReader, transcriptFromPages } =
    await import('../../core/codex/transcript'));
});

describe('the Codex paginated fallback', () => {
  it('reads a declined tool call as failed, as the live reducer does', () => {
    // `reduce.ts` treats `declined` as failed for every item type. `genericCall`
    // did not, so a declined MCP call painted failed live and not-failed on
    // replay from the record. The `resume.json` fixture cannot catch this: both
    // of its declined items are `fileChange`, which `fileLine` already covered.
    const [exchange] = transcriptFromPages(
      [{ id: 't1', status: 'completed', startedAt: 1, completedAt: 2 }] as never[],
      [
        {
          turnId: 't1',
          item: {
            id: 'i1',
            type: 'mcpToolCall',
            server: 'srv',
            tool: 'do',
            status: 'declined',
            arguments: { a: 1 }
          }
        }
      ],
      '/repo'
    ).recent.exchanges;
    const block = exchange && 'blocks' in exchange ? exchange.blocks?.[0] : undefined;
    const call = block && 'call' in block ? block.call : undefined;
    assert.equal(call?.failed, true);
    // Settled, so an absent output is empty rather than still pending.
    assert.equal(call?.output, '');
  });

  it('follows opaque turn and item cursors and joins by turn id', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const requester = {
      request(method: string, raw: unknown): Promise<unknown> {
        const params = raw as Record<string, unknown>;
        calls.push({ method, params });
        if (method === 'thread/turns/list') {
          return Promise.resolve(
            params.cursor
              ? {
                  data: [
                    {
                      id: 'turn-2',
                      items: [],
                      itemsView: 'notLoaded',
                      status: 'interrupted',
                      startedAt: 3,
                      completedAt: 4
                    }
                  ],
                  nextCursor: null,
                  backwardsCursor: null
                }
              : {
                  data: [
                    {
                      id: 'turn-1',
                      items: [],
                      itemsView: 'notLoaded',
                      status: 'completed',
                      startedAt: 1,
                      completedAt: 2
                    }
                  ],
                  nextCursor: 'turn-cursor',
                  backwardsCursor: null
                }
          );
        }
        if (method === 'thread/items/list') {
          return Promise.resolve(
            params.cursor
              ? {
                  data: [
                    {
                      turnId: 'turn-2',
                      item: {
                        type: 'agentMessage',
                        id: 'assistant-2',
                        text: 'partial',
                        phase: 'commentary'
                      }
                    }
                  ],
                  nextCursor: null,
                  backwardsCursor: null
                }
              : {
                  data: [
                    {
                      turnId: 'turn-1',
                      item: {
                        type: 'userMessage',
                        id: 'user-1',
                        clientId: null,
                        content: [{ type: 'text', text: 'hello', text_elements: [] }]
                      }
                    },
                    {
                      turnId: 'turn-1',
                      item: {
                        type: 'agentMessage',
                        id: 'assistant-1',
                        text: 'world',
                        phase: 'final_answer'
                      }
                    }
                  ],
                  nextCursor: 'item-cursor',
                  backwardsCursor: null
                }
          );
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      }
    };

    const read = await readPaginated(requester, { sessionId: 'thread-1', cwd: '/repo' });
    assert.deepEqual(
      read.recent.exchanges.map((one) => ('mark' in one ? one.mark : `${one.role}:${one.text}`)),
      ['user:hello', 'assistant:world', 'assistant:partial', 'break']
    );
    assert.deepEqual(read.witnessed, new Set(['user-1', 'assistant-1', 'assistant-2']));
    assert.deepEqual(
      calls.map((call) => [call.method, call.params.cursor ?? null]),
      [
        ['thread/turns/list', null],
        ['thread/turns/list', 'turn-cursor'],
        ['thread/items/list', null],
        ['thread/items/list', 'item-cursor']
      ]
    );
    // Whole, not just the cursor: `unmaterialized` classifies every -32600 off
    // the first of these as an empty thread, and Codex answers -32600 for a
    // malformed param too. These assertions are what keeps that reading honest.
    assert.deepEqual(calls[0]?.params, {
      threadId: 'thread-1',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'notLoaded'
    });
    assert.deepEqual(calls[2]?.params, {
      threadId: 'thread-1',
      limit: 100,
      sortDirection: 'asc'
    });
  });

  it('reads a thread with no first user message as empty rather than throwing', async () => {
    const asked: string[] = [];
    const requester = {
      request(method: string): Promise<unknown> {
        asked.push(method);
        return Promise.reject(
          new CodexFailure({
            code: -32600,
            message: 'thread thread-new is not materialized yet; thread/turns/list is unavailable'
          })
        );
      }
    };
    const read = await readPaginated(requester, { sessionId: 'thread-new', cwd: '/repo' });
    assert.deepEqual(read.recent, { exchanges: [], truncated: false });
    assert.deepEqual(read.witnessed, new Set());
    assert.deepEqual(asked, ['thread/turns/list'], 'no item page is asked for an empty thread');
  });

  it('still throws for a turn list that failed for any other reason', async () => {
    const requester = {
      request(): Promise<unknown> {
        return Promise.reject(new CodexFailure({ code: -32603, message: 'internal error' }));
      }
    };
    await assert.rejects(
      () => readPaginated(requester, { sessionId: 'thread-1', cwd: '/repo' }),
      /internal error/
    );
  });

  it('degrades a reader that throws to an empty transcript', async () => {
    const session = {
      pid: 2,
      sessionId: 'codex-refused',
      cwd: '/repo',
      transcript: '',
      brand: 'codex'
    } as Session;
    const stop = registerTranscriptReader(session.sessionId, () =>
      Promise.reject(new Error('app-server refused the read'))
    );
    try {
      const drawn = await adapter.readSessionTranscript(session);
      assert.equal(drawn.ours, false);
      assert.deepEqual(drawn.recent, { exchanges: [], truncated: false });
    } finally {
      stop();
    }
  });

  it('applies the whole-record rule without a pseudo transcript path', async () => {
    const session = {
      pid: 1,
      sessionId: 'codex-whole',
      cwd: '/repo',
      transcript: '',
      brand: 'codex'
    } as Session;
    await record.appendLine(session.sessionId, {
      role: 'user',
      text: 'ours',
      blocks: [{ text: 'ours' }],
      m: 'user-1'
    });
    const stop = registerTranscriptReader(session.sessionId, () =>
      Promise.resolve({
        recent: {
          exchanges: [{ role: 'user' as const, text: 'fallback', blocks: [{ text: 'fallback' }] }],
          truncated: false
        },
        witnessed: new Set(['user-1']),
        order: [{ key: 'user-1', from: 0 }]
      })
    );
    try {
      const drawn = await adapter.readSessionTranscript(session);
      assert.equal(drawn.ours, true);
      assert.equal(
        drawn.recent.exchanges[0] && 'text' in drawn.recent.exchanges[0]
          ? drawn.recent.exchanges[0].text
          : undefined,
        'ours'
      );
      assert.equal(session.transcript, '', 'the durable thread id was not smuggled into a path');
    } finally {
      stop();
    }
  });
});

it('uses native turn boundaries for warm fallback ownership without another user item', () => {
  const read = transcriptFromPages(
    [
      { id: 'warm', status: 'completed' },
      { id: 'real', status: 'completed' }
    ],
    [
      {
        turnId: 'warm',
        item: {
          id: 'u-w',
          type: 'userMessage',
          content: [{ type: 'text', text: wrapWarm('ping') }]
        }
      },
      { turnId: 'warm', item: { id: 'a-w', type: 'agentMessage', text: 'OK' } },
      { turnId: 'real', item: { id: 'a-r', type: 'agentMessage', text: 'real work' } }
    ],
    '/repo'
  );
  const outputs = read.recent.exchanges.filter((x) => 'role' in x && x.role === 'assistant');
  assert.ok(outputs[0] && 'maintenance' in outputs[0] && outputs[0].maintenance === true);
  assert.ok(outputs[1] && 'maintenance' in outputs[1] && outputs[1].maintenance === false);
});
