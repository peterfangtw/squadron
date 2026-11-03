/**
 * Correlation for Codex app-server's newline-delimited JSON protocol.
 *
 * The objects look like JSON-RPC requests and responses but 0.151.0 sends no
 * `jsonrpc` member. Keeping this separate from `AcpClient` prevents either
 * family from silently accepting the other's frames.
 */

import type { ExitInfo, SessionTransport } from '../session';

export type CodexId = number | string;

export type CodexErrorBody = {
  code: number;
  message: string;
  data?: unknown;
};

export class CodexFailure extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(body: CodexErrorBody) {
    super(body.message);
    this.name = 'CodexFailure';
    this.code = body.code;
    this.data = body.data;
  }
}

/** Every request still pending, and every one made after, when the app-server
 *  has exited. Its stdout may still hold frames the exit outran. */
export class CodexExited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexExited';
  }
}

type Pending = {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  dispose: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asId(value: unknown): CodexId | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function asError(value: unknown): CodexErrorBody {
  if (!isRecord(value) || typeof value.code !== 'number' || typeof value.message !== 'string') {
    return { code: -32603, message: 'Malformed Codex app-server error' };
  }
  return { code: value.code, message: value.message, data: value.data };
}

function exitReason(info: ExitInfo): string {
  const status =
    info.signal ?? (info.code === null ? 'without a status' : `with code ${info.code}`);
  return info.stderr
    ? `Codex app-server exited ${status}: ${info.stderr}`
    : `Codex app-server exited ${status}`;
}

export const CODEX_REQUEST_MS = 30_000;

export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<CodexId, Pending>();
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly incoming = new Set<(id: CodexId, method: string, params: unknown) => void>();
  private stopped: Error | undefined;

  constructor(
    private readonly transport: SessionTransport,
    private readonly requestMs = CODEX_REQUEST_MS
  ) {
    transport.onLine((value) => this.receive(value));
    transport.onExit((info) => this.stop(new CodexExited(exitReason(info))));
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = this.requestMs,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.stopped || signal?.aborted) {
      return Promise.reject(
        this.stopped ??
          (signal?.reason instanceof Error
            ? signal.reason
            : new Error('Opening request cancelled.'))
      );
    }
    const id = this.nextId++;
    const done = new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error): void => {
        this.pending.get(id)?.dispose();
        this.pending.delete(id);
        reject(error);
      };
      const abort = (): void => fail(signal?.reason as Error);
      const timer = setTimeout(
        () => {
          fail(new Error(`Timed out waiting for Codex ${method}; outcome unknown.`));
        },
        Math.min(this.requestMs, timeoutMs)
      );
      const dispose = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { method, timer, resolve, reject, dispose });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.transport.write(params === undefined ? { method, id } : { method, id, params });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return done;
  }

  notify(method: string, params?: unknown): void {
    if (this.stopped) {
      return;
    }
    this.transport.write(params === undefined ? { method } : { method, params });
  }

  reply(id: CodexId, result: unknown): void {
    if (!this.stopped) {
      this.transport.write({ id, result });
    }
  }

  fail(id: CodexId, error: CodexErrorBody): void {
    if (!this.stopped) {
      this.transport.write({ id, error });
    }
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(listener: (id: CodexId, method: string, params: unknown) => void): () => void {
    this.incoming.add(listener);
    return () => this.incoming.delete(listener);
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || Object.hasOwn(value, 'jsonrpc')) {
      return;
    }
    const id = asId(value.id);
    const method = typeof value.method === 'string' ? value.method : undefined;
    if (method) {
      if (id === undefined) {
        for (const listener of this.notifications) listener(method, value.params);
      } else {
        for (const listener of this.incoming) listener(id, method, value.params);
      }
      return;
    }
    if (id === undefined) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    pending.dispose();
    if (Object.hasOwn(value, 'error')) {
      pending.reject(new CodexFailure(asError(value.error)));
    } else if (Object.hasOwn(value, 'result')) {
      pending.resolve(value.result);
    } else {
      pending.reject(new Error(`Malformed Codex ${pending.method} response`));
    }
  }

  private stop(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.stopped = error;
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
