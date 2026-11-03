/**
 * The recorded wire of one real Grok turn, replayed.
 *
 * Session 01a019f2 (2026-08-19, CLI 1.0.5): one prompt, 101 tool calls, 17
 * `agent_message_chunk`. It is the session that showed the bug — the live bubble
 * held all 17 paragraphs at once while `chat_history.jsonl` already had each of
 * them as its own `assistant` row, so every paragraph was on screen twice.
 *
 * The memory thread must keep each delivered paragraph exactly once across all
 * tool boundaries, then converge to the fixture's seventeen assistant rows.
 *
 * `fixtures/grok-01a019f2/` is the real files, trimmed. Kept verbatim: every
 * line's order, envelope and method; `agent_message_chunk` text; `assistant`
 * text. Trimmed: tool `rawInput` and tool output (`applyEvent` reads neither —
 * `tool-start` takes only `name`, `tool-update` returns the state unchanged),
 * `_meta` down to the two keys our code reads, the `data:` twin of
 * `<image_files>`, and the injected `<user_info>` / `<system-reminder>` bodies.
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { before, describe, it } from 'node:test';
import { repoRoot, tempHome } from '../helpers';
import type { SessionTransport } from '../../core/session';
import type { LiveState } from '../../core/live';
import type { ThreadSnapshot } from '../../core/thread';

let GrokSession: typeof import('../../core/grok/session').GrokSession;
let readGrokTranscript: typeof import('../../core/grok/transcript').readGrokTranscript;

before(async () => {
  await tempHome();
  ({ GrokSession } = await import('../../core/grok/session'));
  ({ readGrokTranscript } = await import('../../core/grok/transcript'));
});

const DIR = path.join(repoRoot(), 'src', 'test', 'fixtures', 'grok-01a019f2');
const SESSION = '01a019f2-2c42-7622-a8e1-6bba12ea2a11';

async function replay(): Promise<{
  snapshots: ThreadSnapshot[];
  delivered: string[][];
  state: LiveState;
}> {
  const body = await fs.readFile(path.join(DIR, 'updates.jsonl'), 'utf8');
  const listeners: ((value: unknown) => void)[] = [];
  const transport: SessionTransport = {
    onLine: (listener) => listeners.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      const request = value as { id?: number; method?: string };
      if (request.id === undefined) return;
      const result =
        request.method === 'initialize'
          ? { protocolVersion: 1, authMethods: [{ id: 'grok-cli' }] }
          : request.method === 'session/new'
            ? { sessionId: SESSION }
            : {};
      queueMicrotask(() =>
        listeners.forEach((listener) => listener({ jsonrpc: '2.0', id: request.id, result }))
      );
    }
  };
  const session = new GrokSession(transport, { cwd: '/tmp', startedAt: 1 });
  assert.equal((await session.opening).ok, true);
  const snapshots: ThreadSnapshot[] = [];
  const delivered: string[][] = [];
  const said: string[] = [];
  try {
    for (const line of body.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as {
        method: string;
        params: { update?: { sessionUpdate?: string; content?: { text?: string } } };
      };
      const update = row.params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text)
        said.push(update.content.text);
      listeners.forEach((listener) =>
        listener({ jsonrpc: '2.0', method: row.method, params: row.params })
      );
      snapshots.push(session.thread.snapshot());
      delivered.push([...said]);
    }
    return { snapshots, delivered, state: session.state };
  } finally {
    session.close();
    await session.flush();
  }
}

function assistantWords(shot: ThreadSnapshot): string[] {
  return [...shot.recent.exchanges, ...shot.tail.map((row) => row.exchange)].flatMap((row) =>
    'role' in row && row.role === 'assistant' && row.text.trim() ? [row.text.trim()] : []
  );
}

/** The words each `assistant` row of the turn put on disk, in transcript order. */
async function paragraphs(): Promise<string[]> {
  const recent = await readGrokTranscript(path.join(DIR, 'chat_history.jsonl'));
  return recent.exchanges
    .filter((e) => 'role' in e && e.role === 'assistant' && e.text.trim())
    .map((e) => ('role' in e ? e.text.trim() : ''));
}

describe('the recorded Grok turn 01a019f2', () => {
  it('is still the fixture the bug was found in', async () => {
    // A trim that guts the interleaving would leave every assertion below
    // trivially green, so the shape is pinned rather than assumed.
    const body = await fs.readFile(path.join(DIR, 'updates.jsonl'), 'utf8');
    const kinds = new Map<string, number>();
    for (const line of body.split('\n')) {
      if (!line) {
        continue;
      }
      const row = JSON.parse(line) as { params?: { update?: { sessionUpdate?: string } } };
      const kind = row.params?.update?.sessionUpdate ?? '?';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    assert.equal(kinds.get('agent_message_chunk'), 17, '17 paragraphs is what made the blob');
    assert.equal(kinds.get('tool_call'), 101, 'one prompt, 101 tools');
    assert.equal(kinds.get('turn_completed'), 1, 'one turn, ending once');
    const said = await paragraphs();
    assert.equal(said.length, 17, 'all 17 are on disk as their own rows');
    // The count below is "how many finished paragraphs are inside the live
    // copy". That only reads as a count if no paragraph sits inside another.
    for (const [i, one] of said.entries()) {
      for (const [j, other] of said.entries()) {
        assert.ok(i === j || !other.includes(one), `paragraph ${i} is inside paragraph ${j}`);
      }
    }
  });

  it('keeps every delivered paragraph once across all tool boundaries', async () => {
    const { snapshots, delivered } = await replay();
    for (const [at, shot] of snapshots.entries()) {
      assert.deepEqual(assistantWords(shot), delivered[at], `wire line ${at}`);
      assert.ok(shot.tail.length <= 1, `wire line ${at} opened multiple text rows`);
    }
  });

  it('ends streaming with all seventeen paragraphs kept apart', async () => {
    const { snapshots, state } = await replay();
    const last = snapshots.at(-1);
    assert.ok(last);
    assert.equal(last.tail.length, 0);
    assert.equal(state.running, false);
    assert.equal(state.status, 'idle');
    assert.equal(state.activeTool, undefined);
    assert.deepEqual(assistantWords(last), await paragraphs());
  });
});
