import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { randomUUID } from 'node:crypto';

import type { SessionHandle } from '../../core/adapter';

let adapter: (typeof import('../../core/adapter'))['adapter'];

let CodexSession: (typeof import('../../core/codex/session'))['CodexSession'];

import type { LiveState } from '../../core/live';

import type { ExitInfo, SessionTransport } from '../../core/session';

let childTransport: (typeof import('../../core/session'))['childTransport'];

import { outRoot, repoRoot, tempHome } from '../helpers';
import * as executables from '../../core/platform/executables';

type CodexSession = import('../../core/codex/session').CodexSession;

export const FAKE = path.join(outRoot(), 'test', 'fixtures', 'fake-codex.js');

export const FIXTURES = path.join(
  repoRoot(),
  'src',
  'test',
  'fixtures',
  'codex-app-server-0.151.0'
);

export type Start = {
  mode?: string;
  briefing?: string;
  requestLog?: string;
  configured?: string;
  log?: (line: string) => void;
  resume?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  skipPermissions?: boolean;
  requestMs?: number;
};

export function open(start: Start = {}): SessionHandle {
  const cli = adapter('codex');
  assert.ok(cli);
  const launch = cli.launch({
    bin: executables.named(FAKE, process.execPath),
    cwd: process.cwd(),
    resume: start.resume,
    model: start.model,
    effort: start.effort,
    skipPermissions: start.skipPermissions
  });
  const transport = childTransport({
    bin: launch.bin,
    cwd: process.cwd(),
    args: launch.args,
    env: {
      ...launch.env,
      FAKE_CODEX_MODE: start.mode ?? 'normal',
      FAKE_CODEX_REQUEST_LOG: start.requestLog,
      FAKE_CODEX_CONFIG: start.configured
    },
    terminateOnClose: launch.terminateOnClose
  });
  const options = {
    briefing: start.briefing,
    log: start.log,
    cwd: '/tmp/codex-project',
    startedAt: 1000,
    sessionId: start.sessionId,
    resume: start.resume,
    model: start.model,
    effort: start.effort,
    skipPermissions: start.skipPermissions
  };
  return start.requestMs === undefined
    ? cli.connect(transport, options)
    : new CodexSession(transport, options, start.requestMs);
}

export function until(
  handle: SessionHandle,
  what: string,
  want: (state: LiveState) => boolean
): Promise<LiveState> {
  return new Promise((resolve, reject) => {
    if (want(handle.state)) {
      resolve(handle.state);
      return;
    }
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what}; state was ${JSON.stringify(handle.state)}`));
    }, 5000);
    const stop = handle.onChange((state) => {
      if (want(state)) {
        clearTimeout(timer);
        stop();
        resolve(state);
      }
    });
  });
}

export const alive: SessionHandle[] = [];

export function start(options: Start = {}): SessionHandle {
  const handle = open(options);
  alive.push(handle);
  return handle;
}

export type ClientReply = { id: number; result?: unknown; error?: unknown };

export class ThreadPeer {
  readonly id = randomUUID();
  readonly methods: string[] = [];
  private readonly lines: ((value: unknown) => void)[] = [];
  private readonly exits: ((info: ExitInfo) => void)[] = [];
  private readonly ends: (() => void)[] = [];
  /** Methods whose reply waits for `reply`, and the id each is waiting under. */
  readonly holding = new Set<string>();
  private readonly held = new Map<string, number>();
  /** What the client answered our own requests with. */
  readonly replies: ClientReply[] = [];
  /** What each method was last sent with, and who waits for one to be sent. */
  readonly params = new Map<string, Record<string, unknown>>();
  private readonly watching = new Map<string, () => void>();
  readonly transport: SessionTransport = {
    onLine: (listener) => this.lines.push(listener),
    onExit: (listener) => this.exits.push(listener),
    onEnd: (listener) => this.ends.push(listener),
    close: () => this.end(),
    write: (value) => {
      const request = value as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.id === undefined) return;
      if (!request.method) {
        this.replies.push(value as ClientReply);
        return;
      }
      this.methods.push(request.method);
      this.params.set(request.method, request.params ?? {});
      this.watching.get(request.method)?.();
      if (this.holding.has(request.method)) {
        this.held.set(request.method, request.id);
        return;
      }
      const result =
        request.method === 'initialize'
          ? { userAgent: 'fixture', codexHome: '/tmp' }
          : request.method === 'thread/start'
            ? { thread: { id: this.id, cwd: '/tmp/codex-project', canAcceptDirectInput: true } }
            : {};
      queueMicrotask(() => {
        for (const listener of this.lines) listener({ id: request.id, result });
      });
    }
  };

  /** Resolves once `method` has been written. */
  sent(method: string): Promise<void> {
    if (this.methods.includes(method)) return Promise.resolve();
    return new Promise((resolve) => this.watching.set(method, resolve));
  }

  /** The held request's reply: `{ result }` or `{ error }`. */
  reply(method: string, body: { result: unknown } | { error: unknown }): void {
    const id = this.held.get(method);
    assert.ok(id !== undefined, `no ${method} is held`);
    this.held.delete(method);
    for (const listener of this.lines) listener({ id, ...body });
  }

  notify(method: string, params: Record<string, unknown>): void {
    for (const listener of this.lines)
      listener({ method, params: { threadId: this.id, ...params } });
  }

  /** A server request on this thread, which the client answers by `id`. */
  request(id: number, method: string, params: Record<string, unknown>): void {
    for (const listener of this.lines)
      listener({ id, method, params: { threadId: this.id, ...params } });
  }

  delta(itemId: string, delta: string, turnId = 'turn-a'): void {
    this.notify('item/agentMessage/delta', { itemId, delta, turnId });
  }

  completed(itemId: string, text: string, turnId = 'turn-a'): void {
    this.notify('item/completed', { turnId, item: { type: 'agentMessage', id: itemId, text } });
  }

  exit(): void {
    for (const listener of this.exits) listener({ code: null, signal: 'SIGKILL', source: 'exit' });
  }

  end(): void {
    for (const listener of this.ends) listener();
  }
}

export async function threadSession(
  options: { skipPermissions?: boolean; requestMs?: number } = {}
): Promise<{ peer: ThreadPeer; handle: CodexSession }> {
  const peer = new ThreadPeer();
  const handle = new CodexSession(
    peer.transport,
    {
      cwd: '/tmp/codex-project',
      startedAt: 1,
      ...(options.skipPermissions ? { skipPermissions: true } : {})
    },
    options.requestMs
  );
  alive.push(handle);
  assert.deepEqual(await handle.opening, { ok: true });
  await handle.thread.recovered;
  return { peer, handle };
}

export async function setup(): Promise<void> {
  await tempHome();
  ({ adapter } = await import('../../core/adapter'));
  ({ CodexSession } = await import('../../core/codex/session'));
  ({ childTransport } = await import('../../core/session'));
}

export function dispose(): void {
  for (const handle of alive) handle.close();
}
