/** Shared boot and readers for the engine suite. Registers no test and no hook. */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Bridge, Ended, Stopped } from '../../core/bridge/bridge';
import type { Act } from '../../core/coordination/route';
import type { PendingRequest } from '../../core/live';
import type { Session, WindowClaim } from '../../core/model';
import type { SessionAddr, Watched } from '../../core/bridge/model';
import type { Messenger } from '../../core/bridge/port';
import { tempHome } from '../helpers';

type Engine = typeof import('../../core/bridge/bridge');
type Catching = typeof import('../../core/bridge/catch_up');
type Fake = typeof import('../../core/bridge/fake');
type Store = typeof import('../../core/bridge/store');
type Paths = typeof import('../../core/paths');
type Words = typeof import('../../core/bridge/words');

export let engine: Engine;
export let catching: Catching;
export let fake: Fake;
export let store: Store;
export let paths: Paths;
export let words: Words;
export let home: string;

/** Bridges `trackBridge` recorded. `Bridge.stop` is idempotent and drains writers.
 *  A rejection stays in this collection, so the caller does not dispose the home. */
const opened: Bridge[] = [];

export function trackBridge(bridge: Bridge): void {
  opened.push(bridge);
}

/** `tempHome` before the bridge graph. A value import of `paths` earlier has
 *  already cached the real home, and `tempHome` then throws. */
export async function boot(): Promise<string> {
  home = await tempHome();
  engine = await import('../../core/bridge/bridge');
  catching = await import('../../core/bridge/catch_up');
  fake = await import('../../core/bridge/fake');
  store = await import('../../core/bridge/store');
  paths = await import('../../core/paths');
  words = await import('../../core/bridge/words');
  return home;
}

export async function stopBridges(): Promise<void> {
  const pending = opened.map((bridge) => bridge.stop());
  const results = await Promise.allSettled(pending);
  const rejected: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') rejected.push(result.reason);
  }
  if (rejected.length > 0) throw new AggregateError(rejected, 'a bridge stop failed');
  opened.length = 0;
}

export const APP = path.resolve('/repo/app');
export const SITE = path.resolve('/repo/site');
export const T0 = 1_700_000_000_000;
export const OWNER = 'T1:U1';

export function session(pid: number, over: Partial<Session> = {}): Session {
  return {
    pid,
    sessionId: `s${pid}`,
    cwd: APP,
    repoRoot: APP,
    name: `n${pid}`,
    status: 'idle',
    hasCommand: false,
    startedAt: T0 + pid,
    updatedAt: T0 + pid,
    transcript: `/t/${pid}.jsonl`,
    source: 'owned',
    windowId: 'w1',
    brand: 'claude',
    turnsEnded: 0,
    ...over
  };
}

export function watched(pid: number, over: Partial<Session> = {}, pending: PendingRequest[] = []) {
  return { session: session(pid, over), pending, label: `n${pid}` } satisfies Watched;
}

export const addr = (w: Watched): SessionAddr => ({
  pid: w.session.pid,
  startedAt: w.session.startedAt,
  windowId: 'w1'
});

export const permission = (requestId: string): PendingRequest => ({
  requestId,
  toolName: 'Bash',
  ask: false,
  input: { command: 'rm -rf build' }
});

export function claim(id: string, folder: string): WindowClaim {
  return { id, label: `window ${id}`, app: 'Code', folder, shellPids: [], updatedAt: T0 };
}

type Call = { verb: string; args: unknown[] };

/** Verbs that record each call and answer what the test set. */
export function verbs(answers: Partial<Record<string, Act | Stopped | Ended>> = {}) {
  const calls: Call[] = [];
  const act = (verb: string, ...args: unknown[]) => {
    calls.push({ verb, args });
    return Promise.resolve(answers[verb] ?? { ok: true as const });
  };
  let pid = 500;
  const port: import('../../core/bridge/bridge').SessionVerbs = {
    send: (a, text) => act('send', a, text),
    answer: (a, askId, text) => act('answer', a, askId, text),
    interrupt: (a) => act('interrupt', a),
    deny: (a, requestId, reason) => act('deny', a, requestId, reason),
    end: (a, members) => act('end', a, members),
    start(input) {
      calls.push({ verb: 'start', args: [input] });
      const refused = answers.start;
      // A canned refusal names no word, so it proves nothing stopped.
      if (refused && !refused.ok)
        return Promise.resolve({ ok: false, reason: refused.reason, outcome: 'unknown' });
      pid++;
      return Promise.resolve({
        ok: true,
        pid,
        startedAt: T0 + pid,
        brand: input.brand ?? 'claude'
      });
    },
    lastReply(a) {
      calls.push({ verb: 'lastReply', args: [a] });
      return Promise.resolve('All done.');
    }
  };
  return { port, calls, of: (verb: string) => calls.filter((c) => c.verb === verb) };
}

export function make(
  options: {
    messenger?: Messenger;
    fake?: import('../../core/bridge/fake').FakeOptions;
    answers?: Partial<Record<string, Act | Stopped | Ended>>;
    now?: () => number;
    observed?: import('../../core/bridge/bridge').Observed;
    fresh?: boolean;
  } = {}
) {
  const messenger = fake.fakeMessenger(options.fake);
  const v = verbs(options.answers);
  let now = T0 + 10_000;
  const logs: string[] = [];
  const bridge = new engine.Bridge({
    messenger: options.messenger ?? messenger,
    label: 'Test messenger',
    verbs: v.port,
    allowlist: [OWNER],
    clock: options.now ?? (() => now),
    resolve: () => Promise.resolve(new Map()),
    log: (line) => logs.push(line),
    ...(options.observed ? { observed: options.observed } : {}),
    ...(options.fresh ? { fresh: true } : {})
  });
  trackBridge(bridge);
  return {
    bridge,
    messenger,
    verbs: v,
    logs,
    advance: (ms: number) => (now += ms),
    now: () => now,
    /** Every event queued so far handled: the queue is one chain. */
    drain: () => bridge.tick(now)
  };
}

/** A root that finished a turn, so its conversation is open, with the post. */
export async function finished(t: ReturnType<typeof make>, root = watched(10)) {
  await t.bridge.observe([root], [claim('w1', APP)]);
  const after = { ...root, session: { ...root.session, turnsEnded: 1 } };
  await t.bridge.observe([after], [claim('w1', APP)]);
  const post = t.messenger.posts().at(-1);
  assert.ok(post);
  assert.equal(post.notice.kind, 'finished');
  return { root: after, post };
}

export const saved = () => store.readConversations();

/** The engine started in the host's order: the store read, a first pass over
 *  `board`, then the connection, so no event is routed against no board. */
export async function begin(
  bridge: Bridge,
  board: readonly Watched[] = [],
  claims: readonly WindowClaim[] = []
): Promise<void> {
  await bridge.load();
  await bridge.observe(board, claims);
  bridge.connect();
}

export async function chooseDefault(t: ReturnType<typeof make>): Promise<void> {
  const button = t.messenger
    .posts()
    .at(-1)
    ?.notice.buttons?.find((b) => b.label === 'Use window default');
  assert.ok(button);
  t.messenger.press(OWNER, button.payload);
  await t.drain();
}
