/**
 * Line-delimited JSON-RPC 2.0, the family ACP speaks.
 *
 * A `SessionTransport` already splits and parses lines; this file only
 * correlates ids. stderr is not on that transport — MCP worker noise lives
 * there on at least one ACP agent (`docs/reference/cli_state/grok/protocol.md`) — and
 * nothing here reads it.
 *
 * Brand extensions (`_meta`, `_x.ai/*`, a particular `authenticate`) belong
 * in that brand's adapter. This is the family: request, result, error,
 * notification, and the `initialize` handshake every ACP peer starts with.
 */

import type { SessionTransport } from './session';

const JSONRPC = '2.0' as const;

export type JsonRpcId = number | string;

export type JsonRpcErrorBody = {
  code: number;
  message: string;
  data?: unknown;
};

/** ACP / LSP RequestCancelled — a client dropping an inbound request it
 *  will not answer. JSON-RPC 2.0's -32600 is Invalid Request, a parse
 *  shape, and is the wrong code for this. */
export const REQUEST_CANCELLED = -32800;

/** A result that came back as `error` rather than as `result`. */
export class AcpExited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpExited';
  }
}

export class JsonRpcFailure extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(body: JsonRpcErrorBody) {
    super(body.message);
    this.name = 'JsonRpcFailure';
    this.code = body.code;
    this.data = body.data;
  }
}

export type InitializeParams = {
  protocolVersion: number;
  clientInfo: { name: string; version: string };
  clientCapabilities?: unknown;
};

export type InitializeResult = {
  protocolVersion: number;
  agentCapabilities?: unknown;
  authMethods?: unknown;
};

type Pending = {
  dispose: () => void;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(value: unknown): JsonRpcErrorBody {
  if (!isRecord(value) || typeof value.code !== 'number' || typeof value.message !== 'string') {
    return { code: -32603, message: 'Malformed JSON-RPC error' };
  }
  return { code: value.code, message: value.message, data: value.data };
}

function asId(value: unknown): JsonRpcId | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/**
 * One ACP peer on a byte transport.
 *
 * Ids are ours and increment from 1. A line that is not JSON-RPC 2.0 is
 * dropped — same rule as a line that would not parse, one level up.
 */
export class AcpClient {
  private stopped?: Error;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly notes: ((method: string, params: unknown) => void)[] = [];
  private readonly incoming: ((id: JsonRpcId, method: string, params: unknown) => void)[] = [];

  constructor(private readonly transport: SessionTransport) {
    transport.onLine((value) => this.receive(value));
    transport.onExit(() => this.stop(new AcpExited('ACP transport exited.')));
    transport.onEnd?.(() => this.stop(new AcpExited('ACP output closed.')));
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.stopped || signal?.aborted)
      return Promise.reject(
        this.stopped ??
          (signal?.reason instanceof Error
            ? signal.reason
            : new Error('Opening request cancelled.'))
      );
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: JSONRPC, id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const done = new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error): void => {
        this.pending.get(id)?.dispose();
        this.pending.delete(id);
        reject(error);
      };
      const abort = (): void => fail(signal?.reason as Error);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => fail(new Error(`Timed out waiting for ACP ${method}; outcome unknown.`)),
              timeoutMs
            );
      const dispose = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.transport.write(message);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return done;
  }

  notify(method: string, params?: unknown): void {
    if (this.stopped) return;
    const message: Record<string, unknown> = { jsonrpc: JSONRPC, method };
    if (params !== undefined) {
      message.params = params;
    }
    this.transport.write(message);
  }

  initialize(
    params: InitializeParams,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<InitializeResult> {
    return this.request('initialize', params, timeoutMs, signal) as Promise<InitializeResult>;
  }

  /** A notification the peer sent. Not a request: those have an id to answer. */
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notes.push(listener);
    return () => {
      const at = this.notes.indexOf(listener);
      if (at >= 0) {
        this.notes.splice(at, 1);
      }
    };
  }

  /** A request the peer sent. Answer with `reply` / `fail` or it hangs. */
  onRequest(listener: (id: JsonRpcId, method: string, params: unknown) => void): () => void {
    this.incoming.push(listener);
    return () => {
      const at = this.incoming.indexOf(listener);
      if (at >= 0) {
        this.incoming.splice(at, 1);
      }
    };
  }

  reply(id: JsonRpcId, result: unknown): void {
    if (this.stopped) return;
    this.transport.write({ jsonrpc: JSONRPC, id, result });
  }

  fail(id: JsonRpcId, error: JsonRpcErrorBody): void {
    if (this.stopped) return;
    this.transport.write({ jsonrpc: JSONRPC, id, error });
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== JSONRPC) {
      return;
    }
    if (typeof value.method === 'string') {
      const id = asId(value.id);
      if (id !== undefined) {
        for (const listener of this.incoming) {
          listener(id, value.method, value.params);
        }
        return;
      }
      for (const listener of this.notes) {
        listener(value.method, value.params);
      }
      return;
    }
    const id = asId(value.id);
    if (id === undefined) {
      return;
    }
    const waiter = this.pending.get(id);
    if (waiter === undefined) {
      return;
    }
    this.pending.delete(id);
    waiter.dispose();
    if (value.error !== undefined) {
      waiter.reject(new JsonRpcFailure(asError(value.error)));
      return;
    }
    waiter.resolve(value.result);
  }

  private stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = error;
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
