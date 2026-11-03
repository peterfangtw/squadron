/**
 * The reusable form of `win32_reader`: one PowerShell kept by an owner, which
 * answers one nonce-bound table per `read <nonce>` line on its stdin. `win32.ts`
 * reads through it while an owner (the extension host) holds a lease; CLI
 * callers keep the one-shot.
 *
 * It reads only when a caller asks, one request at a time, and keeps no table:
 * `scan` owns the one-second cache. A failed request closes its child, so no
 * later answer can come from a process that once broke the protocol.
 * Trailing bytes in a later chunk close the child without changing the settled read.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import * as win32Reader from './win32_reader';
import type { NativeRead } from './win32_reader';
import type { Disposal } from './index';
import * as win32Children from './win32_children';
import type { Children, Slot, Tracked } from './win32_children';

export type Timing = {
  /** First request of a child, PowerShell and WMI startup included. */
  coldMs: number;
  /** Every later request to the same child. */
  warmMs: number;
  /** A child with no request for this long is sent EOF. */
  idleMs: number;
  /** Delay after a child failed before answering its first request, doubled per failure. */
  backoffFirstMs: number;
  backoffMaxMs: number;
  /** How long an ended child has to exit on EOF before it is killed. */
  endGraceMs: number;
  /** After that, how long a kill has to bring its close before the child is unresolved. */
  closeWaitMs: number;
};

/**
 * 2026-10-26, streamed CIM: cold 450–484 ms (n=3), warm 54–74 ms (n=60).
 */
export const TIMING: Timing = {
  coldMs: win32Reader.TIMEOUT_MS,
  warmMs: 2_000,
  idleMs: 30_000,
  backoffFirstMs: 1_000,
  backoffMaxMs: 30_000,
  endGraceMs: 1_000,
  closeWaitMs: 5_000
};

/** Reads waiting or in flight. `scan` shares one read per burst, so more is a fault. */
export const MAX_QUEUE = 16;

export type OwnedEffects = {
  windowsDirectory: string | undefined;
  /** One hidden child with all three streams piped. */
  start(file: string, args: readonly string[]): ChildProcessWithoutNullStreams;
};

export type OwnedReader = {
  /** One fresh table. Never throws; fails at once after disposal or during backoff. */
  read(): Promise<NativeRead>;
  /** Fails pending reads, ends the child and resolves once it has closed. Idempotent. */
  dispose(): Promise<Disposal>;
};

type Session = {
  child: ChildProcessWithoutNullStreams;
  /** Its place in the backend's bound (`win32_children.ts`). */
  tracked: Tracked;
  /** Frames this child answered; zero means its next request is cold. */
  served: number;
  closed: Promise<void>;
  done: boolean;
  error?: string;
  /** True once it closed; false if its close deadline passed first. */
  ending?: Promise<boolean>;
  request?: Request;
};

type Request = {
  nonce: string;
  chunks: Buffer[];
  size: number;
  /** The first bytes of the line being received, enough to tell `end `. */
  head: Buffer;
  settle(result: NativeRead): void;
};

const DISPOSED = 'process reader disposed';

/**
 * `children` is the backend's, shared with its one-shot runs and every other
 * reader it makes, so no start here outruns a child still ending elsewhere.
 */
export function ownedReader(
  effects: OwnedEffects,
  timing: Timing = TIMING,
  children: Children = win32Children.children()
): OwnedReader {
  let disposed = false;
  // Leaves a pending admission when this reader is disposed.
  const leaving = new AbortController();
  let current: Session | undefined;
  const sessions = new Set<Session>();
  const queue: Array<(result: NativeRead) => void> = [];
  let pumping: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let failures = 0;
  let retryAt = 0;

  return {
    read() {
      if (disposed) return Promise.resolve(failed(DISPOSED));
      if (queue.length >= MAX_QUEUE) return Promise.resolve(failed('process reader busy'));
      return new Promise((resolve) => {
        queue.push(resolve);
        pumping ??= pump();
      });
    },
    async dispose() {
      disposed = true;
      leaving.abort();
      clearTimeout(idle);
      for (const resolve of queue.splice(pumping ? 1 : 0)) resolve(failed(DISPOSED));
      const session = current;
      if (session) {
        const busy = session.request;
        busy?.settle(failed(DISPOSED));
        void end(session, busy ? 'kill' : 'eof');
      }
      await pumping;
      const ends = await Promise.all(
        [...sessions].map(async (session) => ({
          pid: session.child.pid ?? 0,
          closed: await (session.ending ?? end(session, 'kill'))
        }))
      );
      return { unresolved: ends.filter((one) => !one.closed).map((one) => one.pid) };
    }
  };

  async function pump(): Promise<void> {
    clearTimeout(idle);
    try {
      for (let resolve = queue[0]; resolve; resolve = queue[0]) {
        let result: NativeRead;
        try {
          result = await serve();
        } catch (error) {
          if (current) await end(current, 'kill');
          result = failed(error instanceof Error ? error.message : String(error));
        }
        queue.shift();
        resolve(result);
      }
    } finally {
      pumping = undefined;
      if (current && !disposed) {
        const session = current;
        idle = setTimeout(() => void end(session, 'eof'), timing.idleMs);
        idle.unref();
      }
    }
  }

  async function serve(): Promise<NativeRead> {
    if (disposed) return failed(DISPOSED);
    const wait = retryAt - performance.now();
    if (wait > 0) return failed(`process reader backing off for ${Math.ceil(wait)} ms`);
    const file = win32Reader.powershellPath(effects.windowsDirectory);
    if (!file) return failed('Windows directory must be an absolute local path');
    // Its own running child is reused and asks for nothing; a new one waits
    // for the backend's slot, which an active one-shot holds until it closes.
    let slot: Slot | undefined;
    if (!current) {
      const admitted = await children.admit(leaving.signal);
      if (typeof admitted === 'string') return failed(admitted);
      if (disposed) {
        admitted.release();
        return failed(DISPOSED);
      }
      slot = admitted;
    }
    const session = current ?? (slot ? begin(file, slot) : DISPOSED);
    if (typeof session === 'string') {
      backOff();
      return failed(session);
    }
    const cold = session.served === 0;
    const result = await exchange(session, cold ? timing.coldMs : timing.warmMs);
    if (result.status === 'failed') {
      await end(session, 'kill');
      if (cold) backOff();
      return result;
    }
    session.served += 1;
    failures = 0;
    retryAt = 0;
    return result;
  }

  function backOff(): void {
    failures += 1;
    retryAt =
      performance.now() +
      Math.min(timing.backoffFirstMs * 2 ** (failures - 1), timing.backoffMaxMs);
  }

  /** A child, or why none started. */
  function begin(file: string, slot: Slot): Session | string {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = effects.start(file, win32Reader.loopArgs());
    } catch (error) {
      slot.release();
      return error instanceof Error ? error.message : String(error);
    }
    let markClosed: () => void = () => {};
    const session: Session = {
      child,
      tracked: slot.started(child),
      served: 0,
      done: false,
      closed: new Promise((resolve) => (markClosed = resolve))
    };
    current = session;
    sessions.add(session);
    child.stdin.on('error', () => {
      // EPIPE after the child died; its `close` reports the failure.
    });
    child.stdout.on('data', (chunk: Buffer) => receive(session, chunk));
    child.stderr.on('data', () => {
      session.request?.settle(failed('powershell wrote to stderr'));
      void end(session, 'kill');
    });
    child.on('error', (error) => {
      session.error ??= error.message;
      session.request?.settle(failed(error.message));
    });
    child.once('close', (code) => {
      session.done = true;
      if (current === session) current = undefined;
      sessions.delete(session);
      session.tracked.closed();
      session.request?.settle(failed(session.error ?? `powershell exited ${code ?? 'by signal'}`));
      markClosed();
    });
    return session;
  }

  function exchange(session: Session, ms: number): Promise<NativeRead> {
    if (session.done) return Promise.resolve(failed(session.error ?? 'powershell exited'));
    return new Promise((resolve) => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const timer = setTimeout(() => request.settle(failed('powershell timed out')), ms);
      const request: Request = {
        nonce,
        chunks: [],
        size: 0,
        head: Buffer.alloc(0),
        settle(result) {
          if (session.request !== request) return;
          clearTimeout(timer);
          session.request = undefined;
          resolve(result);
        }
      };
      session.request = request;
      session.child.stdin.write(`read ${nonce}\n`);
    });
  }

  /** Frame bytes are kept whole until `end `, then decoded strictly, once. */
  function receive(session: Session, chunk: Buffer): void {
    const request = session.request;
    if (!request) {
      void end(session, 'kill');
      return;
    }
    request.size += chunk.length;
    if (request.size > win32Reader.MAX_OUTPUT) {
      request.settle(failed('output exceeds 8 MiB'));
      return;
    }
    request.chunks.push(chunk);
    for (let at = 0; ;) {
      const newline = chunk.indexOf(0x0a, at);
      const piece = chunk.subarray(at, newline === -1 ? chunk.length : newline);
      if (request.head.length < 4)
        request.head = Buffer.concat([request.head, piece.subarray(0, 4 - request.head.length)]);
      if (newline === -1) return;
      if (request.head.toString('latin1') === 'end ') {
        if (newline + 1 < chunk.length) request.settle(failed('output after the frame'));
        else request.settle(decode(Buffer.concat(request.chunks), request.nonce));
        return;
      }
      request.head = Buffer.alloc(0);
      at = newline + 1;
    }
  }

  /**
   * EOF always, then a kill: now (`kill`) or after the grace (`eof`). Settles
   * true on the child's close and false at its deadline. A kill that returned
   * false, threw or reported an error does not close anything, so only
   * `close` is closure.
   */
  function end(session: Session, how: 'eof' | 'kill'): Promise<boolean> {
    if (current === session) current = undefined;
    if (!session.done) {
      try {
        session.child.stdin.end();
      } catch {
        // Its close, or the deadline, answers for it.
      }
      if (how === 'kill') terminate(session);
    }
    if (session.ending) return session.ending;
    let grace: NodeJS.Timeout | undefined;
    if (how === 'eof' && !session.done)
      grace = setTimeout(() => terminate(session), timing.endGraceMs);
    let cap: NodeJS.Timeout | undefined;
    session.ending = Promise.race([
      session.closed.then(() => true),
      new Promise<boolean>((resolve) => {
        cap = setTimeout(() => resolve(false), timing.endGraceMs + timing.closeWaitMs);
        cap.unref();
      })
    ]).finally(() => {
      clearTimeout(grace);
      clearTimeout(cap);
    });
    // From here no other child starts until this one closes or is unresolved.
    session.tracked.ending(session.ending);
    return session.ending;
  }
}

/** A kill that is refused is recorded, never thrown. */
function terminate(session: Session): void {
  if (session.done) return;
  try {
    if (!session.child.kill()) session.error ??= 'powershell could not be killed';
  } catch (error) {
    session.error ??= error instanceof Error ? error.message : String(error);
  }
}

function decode(bytes: Buffer, nonce: string): NativeRead {
  let text: string;
  try {
    text = new util.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return failed('frame is not UTF-8');
  }
  return win32Reader.parseFrame(text, nonce);
}

function failed(reason: string): NativeRead {
  return { supported: true, status: 'failed', reason };
}
