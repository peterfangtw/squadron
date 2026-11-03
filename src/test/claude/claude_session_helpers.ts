import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { onThreadState, outRoot, tempHome, threadState, type ThreadState } from '../helpers';
import * as executables from '../../core/platform/executables';

export type ClaudeSession = typeof import('../../core/claude/session');

export type AdapterModule = typeof import('../../core/adapter');

export type Pipe = typeof import('../../core/session');

export type Recorded = typeof import('../../core/record');

export type LiveState = import('../../core/live').LiveState;

export type Exchange = import('../../core/transcript').Exchange;

export let claude: ClaudeSession;

export let adapter: AdapterModule;

export let pipe: Pipe;

export let record: Recorded;

/**
 * The session's own cwd, and it must not be inside a repository.
 *
 * A drain baselines the working tree before it releases the turn
 * (`core/checkpoint.ts`), so a session pointed at `process.cwd()` stages this
 * whole checkout — 3,300 files — once per test, and leaves an index file per
 * session behind in `.git`. The transport spawns there too: the fake's `init`
 * reports its own cwd, and the reducer adopts that over the handle's.
 *
 * Set by `before`, which is also where `HOME` moves.
 */
export let nowhere = '';

/** The fake CLI, compiled beside these tests. Spawned through the real
 *  `childTransport`, so the transport is under test too — not stubbed out. */
export const FAKE = path.join(outRoot(), 'test', 'fixtures', 'fake-cli.js');

export const open = (origin?: string): InstanceType<ClaudeSession['OwnedSession']> =>
  new claude.OwnedSession(
    // The Claude launch line, passed rather than assumed: `childTransport`
    // spawns a child for whichever CLI asked and adds nothing of its own.
    pipe.childTransport({
      bin: executables.named(FAKE, process.execPath),
      cwd: nowhere,
      args: claude.PROTOCOL_ARGS,
      env: claude.PROTOCOL_ENV,
      origin
    }),
    { cwd: nowhere, startedAt: 1000 }
  );

/**
 * The first state that satisfies `want`, or a failure naming what was waited
 * for. Every assertion here is about a child process, so there is no
 * alternative to waiting — but a wait that times out silently is a test that
 * passes by accident later.
 */
export function until(
  session: InstanceType<ClaudeSession['OwnedSession']>,
  what: string,
  want: (state: ThreadState) => boolean
): Promise<ThreadState> {
  return new Promise((resolve, reject) => {
    if (want(threadState(session))) {
      resolve(threadState(session));
      return;
    }
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          `timed out waiting for ${what}; state was ${JSON.stringify(threadState(session))}`
        )
      );
    }, 5000);
    const stop = onThreadState(session, (state) => {
      if (want(state)) {
        clearTimeout(timer);
        stop();
        resolve(state);
      }
    });
  });
}

/**
 * The outbox once the drain has caught up.
 *
 * A drain is no longer synchronous with the act that frees it: it baselines the
 * working tree before releasing the turn (`core/checkpoint.ts`), so what a
 * `send` or an idle edge writes lands a tick or two later. Every assertion that
 * used to read `state.queued` in the same statement now waits for it.
 */
export const outbox = (
  session: InstanceType<ClaudeSession['OwnedSession']>,
  want: number
): Promise<ThreadState> =>
  until(session, `${want} left in the outbox`, (s) => s.queued.length === want);

/** The fake echoes every control response back as the session's own words. */
export function echoed(state: ThreadState): Record<string, unknown> {
  const marker = 'RESPONSE ';
  const at = state.words.indexOf(marker);
  assert.notEqual(at, -1, `no response echoed; text was ${JSON.stringify(state.words)}`);
  return JSON.parse(state.words.slice(at + marker.length)) as Record<string, unknown>;
}

export type Transport = ConstructorParameters<ClaudeSession['OwnedSession']>[0];

/** What the handle writes. The transport carries JSON now and says nothing
 *  about its shape, so the Claude spelling is named here — which is what these
 *  assertions are about. */
export type Outbound = import('../../core/claude/frames').Outbound;

/**
 * One line as the CLI would really put it on stdout.
 *
 * The stub feeds `onLine`, so every answer below goes through `readFrame` on
 * its way in — the wire spelling (`request_id`, a nested `event`) rather than
 * the narrowed one. That is the point: the parse is the handle's now, and a
 * test that injected already-narrowed frames would be the one place in the repo
 * where it was skipped.
 */
export type Line = Record<string, unknown>;

export const turnStarted = (model: string): Line => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { model } }
});

export const answeredOk = (requestId: string, payload?: Line): Line => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: payload }
});

export const answeredError = (requestId: string, error: string): Line => ({
  type: 'control_response',
  response: { subtype: 'error', request_id: requestId, error }
});

/**
 * The control request of a given kind, out of everything written.
 *
 * By subtype rather than by being the only one: a session asks for its own
 * usage on every idle edge and its own title on the first running turn
 * (`OwnedSession.drive`), so "the control request" has not been a single thing
 * since those moved off `host/sessions.ts` and into the handle. A test that
 * took the first would answer the wrong round trip and hang on the one it meant.
 */
export const control = (written: Outbound[], subtype: string): Outbound | undefined =>
  written.find(
    (frame) =>
      frame.type === 'control_request' &&
      (frame.request as { subtype?: unknown } | undefined)?.subtype === subtype
  );

export async function waitForControl(
  written: Outbound[],
  subtype: string,
  index = 0
): Promise<Outbound> {
  for (let look = 0; look < 200; look++) {
    const controls = written.filter(
      (frame) =>
        frame.type === 'control_request' &&
        (frame.request as { subtype?: unknown } | undefined)?.subtype === subtype
    );
    if (controls[index]) return controls[index];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the ${subtype} control request did not arrive`);
}

/**
 * A pipe with nobody on the other end of it, so a round trip can be left
 * unanswered for as long as a test wants. The child is the wrong tool for that:
 * the fake answers at once, which is exactly the timing the bug this rig exists
 * for does not happen at.
 */
export function stub(): {
  transport: Transport;
  written: Outbound[];
  answer: (line: Line) => void;
} {
  const written: Outbound[] = [];
  const lines: ((value: unknown) => void)[] = [];
  return {
    written,
    answer: (line) => lines.forEach((listener) => listener(line)),
    transport: {
      pid: 4242,
      write: (value) => written.push(value as Outbound),
      onLine: (listener) => lines.push(listener),
      onExit: () => undefined,
      close: () => undefined
    }
  };
}

/** `stub`, whose child can also exit and whose output can close, apart. */
export function dying(): ReturnType<typeof stub> & { exit: () => void; drained: () => void } {
  const rig = stub();
  const exits: ((info: import('../../core/session').ExitInfo) => void)[] = [];
  const ends: (() => void)[] = [];
  return {
    ...rig,
    exit: () =>
      exits.forEach((listener) => listener({ code: null, signal: 'SIGKILL', source: 'exit' })),
    drained: () => ends.forEach((listener) => listener()),
    transport: {
      ...rig.transport,
      onExit: (listener) => exits.push(listener),
      onEnd: (listener) => ends.push(listener)
    }
  };
}

/** An `assistant` frame in the CLI's own shape. */
export const spoke = (text: string): Line => ({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] }
});

/** Conversations these tests write under, so they share a record with
 *  nothing else in this file. */
export const ORDERED = 'ordered-1111-2222-3333-444444444444';

export const INTERRUPTED = 'interrupted-1111-2222-3333-444444444444';

export const BEFORE_CLEAR = 'before-clear-1111-2222-3333-444444444444';

export const AFTER_CLEAR = 'after-clear-1111-2222-3333-444444444444';

export const ANSWERED = 'answered-1111-2222-3333-444444444444';

export const RETURNED = 'returned-1111-2222-3333-444444444444';

export const MERGED = 'merged-1111-2222-3333-444444444444';

export const READOUT = 'readout-1111-2222-3333-444444444444';

/**
 * That conversation's record, once it holds `want` exchanges.
 *
 * Polled rather than awaited: the append queue is private on purpose — nothing
 * may wait on a store that is best-effort by design, and `record()` never
 * awaits into its caller — so a test that wants the file settled has to look.
 */
export async function recorded(sessionId: string, want: number): Promise<Exchange[]> {
  for (let look = 0; look < 200; look++) {
    const recent = await record.readRecord(sessionId);
    if (recent && recent.exchanges.length >= want) {
      return recent.exchanges;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the record never reached ${want} exchanges`);
}

export const alive: InstanceType<ClaudeSession['OwnedSession']>[] = [];

export const start = (origin?: string): InstanceType<ClaudeSession['OwnedSession']> => {
  const session = open(origin);
  alive.push(session);
  return session;
};

export async function setup(): Promise<void> {
  nowhere = await tempHome();
  adapter = await import('../../core/adapter');
  pipe = await import('../../core/session');
  claude = await import('../../core/claude/session');
  record = await import('../../core/record');
}

export function dispose(): void {
  for (const session of alive) {
    session.close();
  }
}
