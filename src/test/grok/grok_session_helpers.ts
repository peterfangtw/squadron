import * as assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { onThreadState, outRoot, tempHome, threadState, type ThreadState } from '../helpers';

import type { SessionHandle } from '../../core/adapter';

import type { SessionTransport } from '../../core/session';
import * as executables from '../../core/platform/executables';

export type AdapterModule = typeof import('../../core/adapter');

export type SessionModule = typeof import('../../core/session');

export type LiveModule = typeof import('../../core/live');

export type RecordModule = typeof import('../../core/record');

export type GrokTranscript = typeof import('../../core/grok/transcript');

export let adapter: AdapterModule;

export let session: SessionModule;

export let live: LiveModule;

export let record: RecordModule;

export let grokTranscript: GrokTranscript;

export const FAKE = path.join(outRoot(), 'test', 'fixtures', 'fake-acp.js');

export type Start = {
  model?: string;
  resume?: string;
  sessionId?: string;
  skipPermissions?: boolean;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

export const open = (start: Start = {}): SessionHandle => {
  const cli = adapter.adapter('grok');
  assert.ok(cli);
  const { args } = cli.launch({
    bin: executables.named(FAKE),
    cwd: process.cwd(),
    model: start.model,
    resume: start.resume,
    skipPermissions: start.skipPermissions
  });
  return cli.connect(
    session.childTransport({
      bin: executables.named(FAKE, process.execPath),
      cwd: process.cwd(),
      args,
      env: start.env
    }),
    {
      // `/tmp/project` is in no repository, which is what keeps every other case
      // in this file from capturing this checkout: `readTree` answers nothing
      // outside one, so no baseline is taken and no pill is drawn.
      cwd: start.cwd ?? '/tmp/project',
      startedAt: 1000,
      sessionId: start.sessionId,
      model: start.model,
      resume: start.resume,
      skipPermissions: start.skipPermissions
    }
  );
};

export function until(
  handle: SessionHandle,
  what: string,
  want: (state: ThreadState) => boolean
): Promise<ThreadState> {
  return new Promise((resolve, reject) => {
    if (want(threadState(handle))) {
      resolve(threadState(handle));
      return;
    }
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(`timed out waiting for ${what}; state was ${JSON.stringify(threadState(handle))}`)
      );
    }, 5000);
    const stop = onThreadState(handle, (state) => {
      if (want(state)) {
        clearTimeout(timer);
        stop();
        resolve(state);
      }
    });
  });
}

export const alive: SessionHandle[] = [];

export const start = (opts: Start = {}): SessionHandle => {
  const handle = open(opts);
  alive.push(handle);
  return handle;
};

/**
 * Every line of the conversation's record, once the append queue has caught up
 * with what `want` is looking for.
 *
 * Polled rather than awaited: the queue is deliberately not something a caller
 * can wait on — a store that a session waited for is a session that stops
 * reading its own pipe (`GrokSession.record`).
 *
 * **Every session in this file is `g1`**, which is the id the fake mints, so
 * this one record holds every test's turns. Each case therefore asserts on text
 * only it sends.
 */
export type RpcRow = { method: string; params: Record<string, unknown> };

export function promptText(params: Record<string, unknown>): string | undefined {
  const prompt = params.prompt;
  if (!Array.isArray(prompt)) return undefined;
  const part = prompt.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string'
  ) as { text: string } | undefined;
  return part?.text;
}

export async function rpcLog(file: string): Promise<RpcRow[]> {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcRow);
}

export async function recorded(
  want: (lines: readonly Record<string, unknown>[]) => boolean
): Promise<Record<string, unknown>[]> {
  const file = record.recordFile('g1');
  for (let i = 0; i < 100; i++) {
    let lines: Record<string, unknown>[] = [];
    try {
      lines = (await fs.readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      lines = [];
    }
    if (want(lines)) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the record never held what was wanted (${file})`);
}

export type Message = Record<string, unknown>;

export type Grok = InstanceType<typeof import('../../core/grok/session').GrokSession>;

export let GrokSession: typeof import('../../core/grok/session').GrokSession;

export const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The far end of the pipe. Every request but a prompt is answered at once;
 *  a prompt waits for the case to `reply`. */
export class Wire {
  readonly id = randomUUID();
  readonly written: Message[] = [];
  /** A prompt write throws, as a pipe already gone does. */
  refuse = false;
  private readonly listeners: ((value: unknown) => void)[] = [];
  private readonly exits: Parameters<SessionTransport['onExit']>[0][] = [];
  readonly transport: SessionTransport = {
    pid: 4343,
    onLine: (listener) => this.listeners.push(listener),
    onExit: (listener) => this.exits.push(listener),
    close: () => undefined,
    write: (value) => {
      if (!isMessage(value)) return;
      if (this.refuse && value.method === 'session/prompt') throw new Error('EPIPE');
      this.written.push(value);
      if (value.id === undefined || value.method === 'session/prompt') return;
      const result =
        value.method === 'initialize'
          ? { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] }
          : value.method === 'session/new'
            ? { sessionId: this.id }
            : {};
      queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: value.id, result }));
    }
  };

  emit(value: unknown): void {
    for (const listener of this.listeners) listener(value);
  }

  /** The child dies; no reply to anything in flight ever comes. */
  exit(): void {
    for (const listener of this.exits) listener({ code: null, signal: 'SIGKILL', source: 'exit' });
  }

  prompts(): { id: unknown; promptId: string; text: string }[] {
    return this.written.flatMap((message) => {
      if (message.method !== 'session/prompt') return [];
      const params = message.params as {
        prompt: { text?: string }[];
        _meta: { promptId: string };
      };
      return [
        {
          id: message.id,
          promptId: params._meta.promptId,
          text: params.prompt.map((block) => block.text ?? '').join('')
        }
      ];
    });
  }

  reply(prompt: { id: unknown }, result: unknown): void {
    this.emit({ jsonrpc: '2.0', id: prompt.id, result });
  }

  fail(prompt: { id: unknown }, error: { code: number; message: string; data?: unknown }): void {
    this.emit({ jsonrpc: '2.0', id: prompt.id, error });
  }

  update(update: Message, meta?: Message): void {
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: this.id, update, ...(meta ? { _meta: meta } : {}) }
    });
  }

  /** Prose of one model call (`streamStartMs`), naming its prompt or not. */
  chunk(text: string, stream: number, promptId?: string): void {
    this.update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      { streamStartMs: stream, ...(promptId ? { promptId } : {}) }
    );
  }

  echo(text: string, index: number): void {
    this.update({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      _meta: { promptIndex: index }
    });
  }

  completed(
    promptId: string,
    stop: string,
    said?: string,
    cachedReadTokens?: number,
    inputTokens?: number
  ): void {
    this.emit({
      jsonrpc: '2.0',
      method: '_x.ai/session_notification',
      params: {
        sessionId: this.id,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: promptId,
          stop_reason: stop,
          ...(said === undefined ? {} : { agent_result: said }),
          ...(cachedReadTokens === undefined
            ? {}
            : {
                usage: { cachedReadTokens, ...(inputTokens === undefined ? {} : { inputTokens }) }
              })
        }
      }
    });
  }

  promptComplete(promptId: string, stop: string, said: string | null): void {
    this.emit({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId: this.id, promptId, stopReason: stop, agentResult: said }
    });
  }

  running(promptId: string | undefined): void {
    this.emit({
      jsonrpc: '2.0',
      method: '_x.ai/queue/changed',
      params: {
        sessionId: this.id,
        entries: [],
        ...(promptId ? { runningPromptId: promptId } : {})
      }
    });
  }
}

export async function opened(): Promise<{ wire: Wire; handle: Grok }> {
  const wire = new Wire();
  const handle = new GrokSession(wire.transport, { cwd: '/tmp/project', startedAt: 1 });
  alive.push(handle);
  assert.deepEqual(await handle.opening, { ok: true });
  return { wire, handle };
}

/** Sent, and on the wire: the prompt the drain wrote for it. */
export async function sent(
  wire: Wire,
  handle: Grok,
  text: string
): Promise<{ id: unknown; promptId: string; text: string }> {
  const before = wire.prompts().length;
  handle.messages.send(text);
  for (let i = 0; i < 200 && wire.prompts().length === before; i++) await tick(5);
  const prompt = wire.prompts()[before];
  assert.ok(prompt, `${text} never reached the wire`);
  return prompt;
}

export const tick = (ms = 0): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

/** The thread's completed history, as role and text with a cut mark. */
export function drawn(handle: Grok): string[] {
  return handle.thread
    .snapshot()
    .history.exchanges.map((x) =>
      'role' in x ? `${x.role}: ${x.text}${'cut' in x && x.cut ? ' [cut]' : ''}` : `[${x.mark}]`
    );
}

/** Memory, and the record the queue wrote, once it is idle: one answer. */
export async function converged(wire: Wire, handle: Grok): Promise<void> {
  await handle.flush();
  const read = await record.readRecordLines(wire.id);
  const fold = new record.RecordFold();
  for (const line of read?.lines ?? []) fold.push(line);
  assert.deepEqual(
    fold.snapshot().exchanges,
    handle.thread.snapshot().history.exchanges,
    'memory and the record agree'
  );
}

export async function setup(): Promise<void> {
  await tempHome();
  adapter = await import('../../core/adapter');
  session = await import('../../core/session');
  live = await import('../../core/live');
  record = await import('../../core/record');
  grokTranscript = await import('../../core/grok/transcript');
  ({ GrokSession } = await import('../../core/grok/session'));
}

export function dispose(): void {
  for (const handle of alive) {
    handle.close();
  }
}
