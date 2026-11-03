import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Ended } from '../../core/bridge/bridge';
import type { Session } from '../../core/model';
import type { SessionAddr, Watched } from '../../core/bridge/model';
import { disposeHome } from '../helpers';
import {
  boot,
  stopBridges,
  trackBridge,
  APP,
  SITE,
  T0,
  OWNER,
  home,
  engine,
  fake,
  paths,
  words,
  session,
  watched,
  addr,
  permission,
  claim,
  verbs,
  make,
  finished,
  saved,
  begin,
  chooseDefault
} from './bridge_engine_helpers';

before(async () => {
  await boot();
});

after(async () => {
  await stopBridges();
  await disposeHome(home);
});

beforeEach(() => fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true }));

describe('the engine: replies and buttons', () => {
  it('gives a held reply the receipt with Stop, and a delivered one none', async () => {
    const t = make({ answers: { send: { ok: true, queued: 1 } } });
    await begin(t.bridge);
    const { root, post } = await finished(t);
    const busy = { ...root, session: { ...root.session, status: 'busy' as const } };
    await t.bridge.observe([busy], []);
    t.messenger.say(OWNER, 'and the tests', { in: post.posted.anchor });
    await t.drain();
    const receipt = t.messenger.posts().at(-1);
    assert.equal(receipt?.notice.kind, 'receipt');
    assert.deepEqual(
      receipt?.notice.buttons?.map((b) => b.label),
      ['Stop']
    );
    assert.deepEqual(t.verbs.of('send')[0]?.args, [addr(root), 'and the tests']);

    // A scenario of its own: the store holds the first one's finish for the
    // same session, which no engine posts twice.
    await fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true });
    const quiet = make();
    await begin(quiet.bridge);
    const done = await finished(quiet);
    quiet.messenger.say(OWNER, 'thanks', { in: done.post.posted.anchor });
    await quiet.drain();
    assert.equal(quiet.messenger.posts().length, 1);
    assert.equal(quiet.verbs.of('send').length, 1);
  });

  it('stamps answeredAt on the first reply after a notice', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    t.advance(42_000);
    t.messenger.say(OWNER, 'next', { in: post.posted.anchor });
    await t.drain();
    const [record] = await saved();
    const notice = record?.notices[0];
    assert.ok(notice?.answeredAt !== undefined);
    assert.equal(notice.answeredAt - notice.postedAt, 42_000);
  });

  it('settles a button with the reason its verb refused', async () => {
    const t = make({ answers: { deny: { ok: false, reason: 'That window did not answer.' } } });
    await begin(t.bridge);
    const child = watched(11, { parentSessionId: 's10', status: 'waiting' }, [permission('p1')]);
    await t.bridge.observe([watched(10), child], []);
    const deny = t.messenger.posts()[0]?.notice.buttons?.find((b) => b.label === 'Deny');
    assert.ok(deny);
    t.messenger.press(OWNER, deny.payload);
    await t.drain();
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, 'That window did not answer.');
    assert.deepEqual(t.verbs.of('deny')[0]?.args, [addr(child), 'p1', words.DENY_REASON]);
  });

  it('settles Stop from what the verb says: stopped, or nothing to stop', async () => {
    for (const [answer, word] of [
      [{ ok: true }, words.STOPPED],
      [{ ok: true, idle: true }, words.NOTHING_TO_STOP]
    ] as const) {
      await fs.rm(paths.CONVERSATIONS_DIR, { recursive: true, force: true });
      const t = make({ answers: { send: { ok: true, queued: 1 }, interrupt: answer } });
      await begin(t.bridge);
      const { post } = await finished(t);
      // The board still reads idle: the turn began after the last pass.
      t.messenger.say(OWNER, 'and the tests', { in: post.posted.anchor });
      await t.drain();
      const stop = t.messenger.posts().at(-1)?.notice.buttons?.[0];
      assert.ok(stop);
      t.messenger.press(OWNER, stop.payload);
      await t.drain();
      assert.equal(t.verbs.of('interrupt').length, 1, word);
      assert.equal(t.messenger.settles().at(-1)?.notice.settled, word);
    }
  });

  it('settles Deny as denied when it lands', async () => {
    const t = make();
    await begin(t.bridge, [watched(10, { status: 'waiting' }, [permission('p0')])], []);
    const deny = t.messenger.posts()[0]?.notice.buttons?.[0];
    assert.ok(deny);
    t.messenger.press(OWNER, deny.payload);
    await t.drain();
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, words.DENIED);
  });

  it('confirms End with the counted descent, then ends exactly those after reload', async () => {
    const t = make();
    const messenger = t.messenger;
    await begin(t.bridge);
    const root = watched(10, { status: 'busy' }, [permission('p0')]);
    const child = watched(11, { parentSessionId: 's10' });
    await t.bridge.observe([root, child], []);
    const end = t.messenger.posts()[0]?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(end);
    t.messenger.press(OWNER, end.payload);
    await t.drain();
    const confirm = t.messenger.posts().at(-1);
    assert.equal(confirm?.notice.kind, 'confirm');
    assert.match(confirm?.notice.body ?? '', /the 1 session it started/);
    const yes = confirm?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes);
    await t.bridge.stop();
    const late = watched(12, { parentSessionId: 's10' });
    const reloaded = make({ messenger });
    await begin(reloaded.bridge, [root, child, late], []);
    messenger.press(OWNER, yes.payload);
    await reloaded.drain();
    assert.equal(t.verbs.of('end').length, 0);
    assert.deepEqual(
      reloaded.verbs.of('end').map((call) => call.args),
      [[addr(root), [addr(child)]]]
    );
    assert.equal(messenger.settles().at(-1)?.message, confirm?.posted.message);
    assert.equal(messenger.settles().at(-1)?.notice.settled, words.ENDED);
    await reloaded.bridge.stop();
  });

  it('cancels an End confirmation without ending any session', async () => {
    const t = make();
    const root = watched(10);
    await begin(t.bridge, [root], []);
    t.messenger.command(OWNER, 'end', '10');
    await t.drain();
    const confirm = t.messenger.posts().at(-1);
    assert.equal(confirm?.notice.kind, 'confirm');
    const cancel = confirm?.notice.buttons?.find((button) => button.label === 'Cancel');
    assert.ok(cancel);
    t.messenger.press(OWNER, cancel.payload);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0);
    assert.equal(t.messenger.settles().at(-1)?.message, confirm?.posted.message);
    assert.equal(t.messenger.settles().at(-1)?.notice.settled, words.CANCELLED);
    await t.bridge.stop();
  });

  it('starts a fresh session for a reply to an ended root, pointing at its record', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    await t.bridge.observe([], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'keep going', { in: post.posted.anchor });
    await t.drain();
    const [start] = t.verbs.of('start');
    const input = start?.args[0] as {
      windowId: string;
      cwd: string;
      prompt: string;
      brand: string;
    };
    assert.equal(input.windowId, 'w1');
    assert.equal(input.cwd, APP);
    assert.equal(input.brand, 'claude');
    assert.match(input.prompt, /^keep going\n\n/);
    assert.ok(input.prompt.includes(path.join(home, '.squadron', 'transcripts', 's10.jsonl')));
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'ended');
    const [record] = await saved();
    assert.deepEqual(record?.past, ['s10']);
    assert.equal(record?.root?.pid, 501);
  });
});

describe('the engine: an End the bridge carries out', () => {
  const exited = (w: Watched): Watched => ({ ...w, exit: { code: 1, signal: null } });
  const root = watched(10, { status: 'busy', windowId: 'w2' }, [permission('p0')]);
  const child = watched(11, { status: 'busy', parentSessionId: 's10', windowId: 'w2' });

  /** End pressed on the root's permission, then confirmed. */
  async function endPressed(t: ReturnType<typeof make>): Promise<void> {
    await t.bridge.observe([root, child], []);
    const end = t.messenger.posts()[0]?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(end);
    t.messenger.press(OWNER, end.payload);
    await t.drain();
    const yes = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes);
    t.messenger.press(OWNER, yes.payload);
    await t.drain();
  }

  const stopped = (t: ReturnType<typeof make>) =>
    t.messenger.posts().filter((p) => p.notice.kind === 'stopped');

  it('refused for a child only, still reads the root it ended as ended', async () => {
    const left = [{ pid: 11, startedAt: child.session.startedAt, windowId: 'w2' }];
    const t = make({ answers: { end: { ok: false, reason: 'one was not ended', left } } });
    await begin(t.bridge);
    await endPressed(t);
    await t.bridge.observe([exited(root), child], []);
    assert.deepEqual(stopped(t), []);
  });

  it('refused for the root, reads its later exit as a stop', async () => {
    const left = [{ pid: 10, startedAt: root.session.startedAt, windowId: 'w2' }];
    const t = make({ answers: { end: { ok: false, reason: 'the root was not ended', left } } });
    await begin(t.bridge);
    await endPressed(t);
    await t.bridge.observe([exited(root), child], []);
    assert.equal(stopped(t).length, 1);
  });

  it('counts nobody as ending when the engine stopped before the End ran', async () => {
    let stopNow = false;
    const t = make({
      now: () => {
        if (stopNow) {
          stopNow = false;
          void t.bridge.stop();
        }
        return T0 + 10_000;
      }
    });
    await begin(t.bridge, [root, child], []);
    const end = t.messenger.posts()[0]?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(end);
    t.messenger.press(OWNER, end.payload);
    await t.drain();
    const yes = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes);
    stopNow = true;
    t.messenger.press(OWNER, yes.payload);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0, 'the End never ran');
    assert.deepEqual(t.bridge.observation()?.ending, []);
  });
});

describe('the engine: a remote-spawned session’s lifetime (U6, amended)', () => {
  const HOUR = 3_600_000;
  const W1 = [claim('w1', APP)];

  /** A job started from the messenger, then shown idle on a board with its
   *  cache last stamped `at`. */
  async function job(t: ReturnType<typeof make>, over: Partial<Session> = {}) {
    await begin(t.bridge, [], W1);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    await chooseDefault(t);
    const started = t.messenger.posts().at(-1);
    assert.equal(started?.notice.kind, 'started');
    const root = watched(501, {
      startedAt: T0 + 501,
      turnsEnded: 1,
      cache: { ttlMs: HOUR, source: 'measured', at: t.now() },
      ...over
    });
    await t.bridge.observe([root], W1);
    return { root, anchor: started?.posted.anchor };
  }

  const lapsed = (t: ReturnType<typeof make>) =>
    t.messenger.posts().filter((p) => p.notice.kind === 'lapsed');

  it('ends a job’s root once its cache is cold, says so once, and a reply starts afresh', async () => {
    const t = make();
    const { root, anchor } = await job(t);
    assert.equal(t.bridge.nextDeadline(), t.now() + HOUR);

    t.advance(HOUR - 1);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0);

    t.advance(1);
    await t.drain();
    assert.deepEqual(t.verbs.of('end')[0]?.args, [addr(root), []]);
    assert.equal(lapsed(t).length, 1);
    assert.equal(lapsed(t)[0]?.posted.anchor, anchor);

    // A pass that still shows it, as a slow close leaves it, ends nothing more.
    await t.bridge.observe([root], W1);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 1);
    assert.equal(lapsed(t).length, 1);

    // Before any pass shows it gone, a reply already takes D23's fresh path.
    t.messenger.say(OWNER, 'one more thing', { in: anchor });
    await t.drain();
    assert.equal(t.verbs.of('send').length, 0);
    assert.equal(t.verbs.of('start').length, 2);
    const [record] = await saved();
    assert.equal(record?.root?.pid, 502);
    assert.equal(record?.root?.remoteSpawned, true, 'a fresh root is remote-spawned too');
  });

  it('marks a root started by a folder pick', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP), claim('w2', SITE)]);
    t.messenger.say(OWNER, 'write docs');
    await t.drain();
    const site = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'site');
    assert.ok(site);
    t.messenger.press(OWNER, site.payload);
    await t.drain();
    await chooseDefault(t);
    const [record] = await saved();
    assert.equal(record?.root?.remoteSpawned, true);
  });

  it('ends the idle descent with the root, and a root that ended is said once with no retry', async () => {
    const child = { pid: 600, startedAt: T0 + 600, windowId: 'w1' };
    const t = make({ answers: { end: { ok: false, reason: 'one was not ended', left: [child] } } });
    const { root } = await job(t);
    const kid = watched(600, { startedAt: T0 + 600, parentSessionId: 's501' });
    await t.bridge.observe([root, kid], W1);
    t.advance(HOUR);
    await t.drain();
    assert.deepEqual(t.verbs.of('end')[0]?.args, [addr(root), [child]]);
    assert.equal(lapsed(t).length, 1);
    assert.equal(t.messenger.posts().filter((p) => p.notice.kind === 'refusal').length, 0);
    t.advance(HOUR);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 1);
  });

  it('keeps a root a reply just reached, though the board read before it says cold', async () => {
    const t = make();
    const { root, anchor } = await job(t);
    t.advance(HOUR - 2_000);
    t.messenger.say(OWNER, 'one more thing', { in: anchor });
    await t.drain();
    assert.equal(t.verbs.of('send').length, 1);
    // The deadline's pass, on a board read before the reply landed.
    t.advance(2_000);
    await t.bridge.observe([root], W1);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0);
    assert.equal(t.bridge.nextDeadline(), t.now() - 2_000 + HOUR);
  });

  it('a lifetime end keeps its mark though a stale End confirm for the same root is refused', async () => {
    const answers: Partial<Record<string, Ended>> = {};
    const t = make({ answers });
    const { root, anchor } = await job(t);
    // An End confirm posted while it was asking, pressed after the lifetime ended it.
    const asking = {
      ...root,
      session: { ...root.session, status: 'waiting' as const },
      pending: [permission('p1')]
    };
    await t.bridge.observe([asking], W1);
    const endButton = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(endButton);
    t.messenger.press(OWNER, endButton.payload);
    await t.drain();
    const yes = t.messenger
      .posts()
      .at(-1)
      ?.notice.buttons?.find((b) => b.label === 'End');
    assert.ok(yes);
    await t.bridge.observe([root], W1);
    t.advance(HOUR);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 1);
    answers.end = { ok: false, reason: 'its pipe would not close', left: [addr(root)] };
    t.messenger.press(OWNER, yes.payload);
    await t.drain();
    // Still counted as ending: a reply starts afresh, and no second lifetime end.
    t.messenger.say(OWNER, 'hello', { in: anchor });
    await t.drain();
    assert.equal(t.verbs.of('send').length, 0);
    await t.bridge.observe([root], W1);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 2);
  });

  it('lives on while Warm pings it, each ping being cache traffic', async () => {
    const t = make();
    const { root } = await job(t);
    t.advance(55 * 60_000);
    const pinged = {
      ...root,
      session: { ...root.session, cache: { ...root.session.cache!, at: t.now() } }
    };
    await t.bridge.observe([pinged], W1);
    t.advance(HOUR - 1);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0);
    assert.equal(t.bridge.nextDeadline(), t.now() + 1);
  });

  it('never ends a root that is working or waiting on the person', async () => {
    for (const over of [{ status: 'busy' as const }, { status: 'waiting' as const }]) {
      const t = make();
      try {
        await job(t, over);
        t.advance(2 * HOUR);
        await t.drain();
        assert.equal(t.verbs.of('end').length, 0, over.status);
        assert.equal(t.bridge.nextDeadline(), undefined);
      } finally {
        await t.bridge.stop();
      }
    }
  });

  it('never ends a session it did not start', async () => {
    const t = make();
    await begin(t.bridge);
    const cold = watched(10, { cache: { ttlMs: HOUR, source: 'measured', at: T0 } });
    await finished(t, cold);
    t.advance(2 * HOUR);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 0);
  });

  it('says once why an end was refused, and tries again a lifetime later', async () => {
    const left = [{ pid: 501, startedAt: T0 + 501, windowId: 'w1' }];
    const t = make({ answers: { end: { ok: false, reason: 'its window did not answer', left } } });
    await job(t);
    t.advance(HOUR);
    await t.drain();
    await t.drain();
    assert.equal(t.verbs.of('end').length, 1);
    const refusals = () => t.messenger.posts().filter((p) => p.notice.kind === 'refusal');
    assert.equal(refusals().length, 1);
    assert.match(refusals()[0]?.notice.body ?? '', /its window did not answer/);
    assert.deepEqual(lapsed(t), []);
    assert.equal(t.bridge.nextDeadline(), t.now() + HOUR);

    t.advance(HOUR);
    await t.drain();
    assert.equal(t.verbs.of('end').length, 2);
    assert.equal(refusals().length, 1);
  });
});

describe('the engine: a root it just started', () => {
  const at = (pid: number): SessionAddr => ({ pid, startedAt: T0 + pid, windowId: 'w1' });

  it('sends a reply that arrives before any board shows the new root', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    await chooseDefault(t);
    const started = t.messenger.posts().at(-1);
    assert.equal(started?.notice.kind, 'started');
    t.messenger.say(OWNER, 'and the tests', { in: started?.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('start').length, 1);
    assert.deepEqual(t.verbs.of('send')[0]?.args, [at(501), 'and the tests']);
  });

  it('sends to a fresh root the same way, and starts again once it is gone', async () => {
    const t = make();
    await begin(t.bridge);
    const { post } = await finished(t);
    await t.bridge.observe([], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'keep going', { in: post.posted.anchor });
    await t.drain();
    t.messenger.say(OWNER, 'and then this', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('start').length, 1);
    assert.deepEqual(t.verbs.of('send')[0]?.args, [at(501), 'and then this']);

    // On a board, then off it: ended like any root.
    const fresh = watched(501, { sessionId: 'f501', startedAt: T0 + 501 });
    await t.bridge.observe([fresh], [claim('w1', APP)]);
    await t.bridge.observe([], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'once more', { in: post.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('start').length, 2);
  });

  it('posts the finish of a root whose first turn ended before any board showed it', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'what does the retry do?');
    await t.drain();
    await chooseDefault(t);
    const started = t.messenger.posts().at(-1);
    assert.equal(started?.notice.kind, 'started');

    const quick = watched(501, { startedAt: T0 + 501, turnsEnded: 1, endedOutcome: 'done' });
    // A session it did not start is a baseline on its first observation.
    const other = watched(30, { turnsEnded: 1, endedOutcome: 'done' });
    await t.bridge.observe([quick, other], [claim('w1', APP)]);
    const posts = t.messenger.posts().filter((p) => p.notice.kind === 'finished');
    assert.deepEqual(
      posts.map((p) => [p.notice.kind, p.posted.anchor]),
      [['finished', started?.posted.anchor]]
    );
  });

  it('says a root it started that died before any board showed it working', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'what does the retry do?');
    await t.drain();
    await chooseDefault(t);
    const started = t.messenger.posts().at(-1);
    assert.equal(started?.notice.kind, 'started');
    const dead: Watched = {
      ...watched(501, { startedAt: T0 + 501 }),
      exit: { code: 1, signal: null }
    };
    await t.bridge.observe([dead], [claim('w1', APP)]);
    const stopped = t.messenger.posts().at(-1);
    assert.equal(stopped?.notice.kind, 'stopped');
    assert.equal(stopped?.posted.anchor, started?.posted.anchor);
  });

  it('reads that finish off the status where the window publishes no count', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'what does the retry do?');
    await t.drain();
    await chooseDefault(t);
    const { turnsEnded: _count, ...older } = session(501, { startedAt: T0 + 501 });
    const quick: Watched = {
      session: { ...older, status: 'idle', turnOutcome: 'done' },
      pending: [],
      label: 'n501'
    };
    await t.bridge.observe([quick], [claim('w1', APP)]);
    assert.equal(t.messenger.posts().at(-1)?.notice.kind, 'finished');
  });

  it('gives up on a start no board has shown within STARTING_MS', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'fix the build');
    await t.drain();
    await chooseDefault(t);
    const started = t.messenger.posts().at(-1);
    t.advance(engine.STARTING_MS);
    await t.bridge.observe([], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'still there?', { in: started?.posted.anchor });
    await t.drain();
    assert.equal(t.verbs.of('send').length, 0);
    assert.equal(t.verbs.of('start').length, 2);
  });
});

describe('the engine: stop', () => {
  it('closes admission before shutdown callbacks can deliver another message', async () => {
    const messenger = fake.fakeMessenger({ now: () => T0 });
    const v = verbs();
    const bridge = new engine.Bridge({
      messenger,
      verbs: v.port,
      allowlist: [OWNER],
      clock: () => T0,
      register: () => ({
        schedule: () => undefined,
        dispose: () => {
          messenger.say(OWNER, 'arrived during shutdown');
        }
      })
    });
    trackBridge(bridge);
    await begin(bridge, [], [claim('w1', APP)]);
    await bridge.stop();
    assert.deepEqual(await saved(), []);
    assert.deepEqual(v.calls, []);
  });

  it('logs each event it drops for stopping, by kind and id and never by its words', async () => {
    const t = make();
    await begin(t.bridge, [], [claim('w1', APP)]);
    t.messenger.say(OWNER, 'a secret plan');
    await t.bridge.stop();
    assert.equal(t.verbs.of('start').length, 0);
    const dropped = t.logs.filter((line) => /dropped/.test(line));
    assert.equal(dropped.length, 1, t.logs.join('\n'));
    assert.match(dropped[0] ?? '', /message/);
    assert.doesNotMatch(dropped[0] ?? '', /secret plan/);
  });

  it('resolves once the pass in flight has drained, and nothing after it posts or writes', async () => {
    const t = make();
    let reached!: () => void;
    const asked = new Promise<void>((r) => (reached = r));
    let reply!: (text: string) => void;
    t.verbs.port.lastReply = () => {
      reached();
      return new Promise((r) => (reply = r));
    };
    await begin(t.bridge, [watched(10)], [claim('w1', APP)]);
    const pass = t.bridge.observe([watched(10, { turnsEnded: 1 })], [claim('w1', APP)]);
    await asked;

    let drained = false;
    const stopped = t.bridge.stop().then(() => (drained = true));
    const later = t.bridge.observe(
      [watched(10, { status: 'waiting' }, [permission('p0')])],
      [claim('w1', APP)]
    );
    const attached = t.bridge.attach(addr(watched(10)), {
      bytes: Buffer.from('x'),
      name: 'stop.txt',
      mime: 'text/plain'
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(drained, false);

    reply('All done.');
    await stopped;
    await Promise.all([pass, later]);
    assert.equal((await attached).ok, false);
    assert.equal(t.messenger.posts().length, 0);
    assert.equal(t.messenger.attachments().length, 0);
    assert.deepEqual(await saved(), []);
  });
});
