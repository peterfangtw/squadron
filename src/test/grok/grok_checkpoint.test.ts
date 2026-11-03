import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { onThreadState } from '../helpers';

import type { SessionHandle } from '../../core/adapter';

import { dispose, record, recorded, setup, start, until } from './grok_session_helpers';

before(async () => {
  await setup();
});

after(dispose);

/**
 * The turn checkpoints of a Grok session, against a real repository.
 *
 * `checkpoint.test.ts` drives the lifecycle with no session and every other
 * case in this file points at `/tmp/project`, which is in no repository — so
 * the join is only reachable here. What these cases assert is the half
 * `GrokSession` owns: that the baseline is taken before the turn is released,
 * that it survives a second drain arriving inside its window, and that the
 * `{ck}` note lands on the turn that earned it.
 *
 * Every write is through `fs` and never through a frame. That is the feature —
 * a heredoc and a `sed` carry no tool call for the reader to see.
 */
describe('a Grok turn checkpoint on a real tree', () => {
  const run = promisify(execFile);
  /** `GIT_*` stripped, per `src/test/CLAUDE.md`: the pre-commit hook exports
   *  `GIT_DIR` and `GIT_INDEX_FILE` at this checkout, and they beat `-C`. */
  const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const litter: string[] = [];

  after(async () => {
    await Promise.all(litter.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /** The realpath matters: `os.tmpdir()` is a symlink on macOS, and the tree
   *  root a capture reports is the resolved one. */
  async function repo(): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-grok-')));
    litter.push(dir);
    const git = (...args: string[]) => run('git', args, { cwd: dir, env: CLEAN });
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a\n');
    await git('add', '-A');
    await git('commit', '-m', 'first');
    return dir;
  }

  /** Every `{ck}` note on the shared `g1` record for one tree, right now. This
   *  file writes one record for every session in it, so the tree is what tells
   *  a case's notes from its neighbours'. */
  async function notesNow(tree: string): Promise<Record<string, unknown>[]> {
    const raw = await fs.readFile(record.recordFile('g1'), 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => (line.ck as { tree?: string } | undefined)?.tree === tree);
  }

  /** Polled until at least `want` notes exist, for `recorded`'s reason: the
   *  append queue is deliberately not something a caller can wait on. */
  async function notes(tree: string, want = 1): Promise<Record<string, unknown>[]> {
    for (let look = 0; look < 200; look++) {
      const mine = await notesNow(tree);
      if (mine.length >= want) {
        return mine;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return notesNow(tree);
  }

  const changed = (note: Record<string, unknown>): string[] =>
    (note.ck as { changes: { files: string[] } }).changes.files;

  /**
   * Run one ordinary turn that writes a file of its own, and wait for the note
   * naming it.
   *
   * Absence is otherwise sampled on a timer, which is the dual of the poller
   * review caught last round: a wrongly-kept baseline whose closing capture is
   * slow under load is still unwritten when the clock runs out, and the case
   * passes for the wrong reason. A note that could only have been filed *after*
   * the one being denied is proof the chain has gone past it.
   *
   * No false positive from the mark itself: this turn's baseline is taken
   * before its own write, so an earlier file is inside that snapshot and
   * subtracts back out.
   */
  async function drainPast(handle: SessionHandle, dir: string, mark: string): Promise<void> {
    await until(handle, 'idle before the sentinel', (s) => !s.running && !s.inFlight);
    handle.messages?.send(`sentinel-${mark}`);
    await until(handle, 'the sentinel turn', (s) => s.inFlight !== undefined);
    const file = path.join(dir, `${mark}.txt`);
    await fs.writeFile(file, 's\n');
    for (let look = 0; look < 300; look++) {
      if ((await notesNow(dir)).some((note) => changed(note).includes(file))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('the sentinel turn never filed a note of its own');
  }

  it('claims a write no frame carried, across one turn', async () => {
    const dir = await repo();
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    handle.messages?.send('slow');
    await until(handle, 'the turn', (s) => s.running);
    // The write the turn makes with no tool call to its name. `fake-acp` will
    // not make it, which is the point: a checkpoint sees a heredoc.
    await fs.writeFile(path.join(dir, 'by-shell.txt'), 'one\ntwo\n');
    await handle.turn?.interrupt();
    await until(handle, 'idle', (s) => !s.running);

    const mine = await notes(dir);
    assert.equal(mine.length, 1, 'one note for one turn');
    assert.deepEqual(changed(mine[0] ?? {}), [path.join(dir, 'by-shell.txt')]);
  });

  it('captures nothing across a cache-warming ping, even one that wrote', async () => {
    const dir = await repo();
    const handle = start({ cwd: dir, env: { SQUADRON_FAKE_ACP_WARM: 'slow' } });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.state.contextPct = 10;
    assert.deepEqual(handle.warm?.ping(), { ok: true });
    await until(handle, 'the ping runs', (s) => s.running);
    const wrote = path.join(dir, 'by-ping.txt');
    await fs.writeFile(wrote, 'one\n');
    await handle.turn?.interrupt();
    await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');

    await drainPast(handle, dir, 'after-ping');
    const mine = await notesNow(dir);
    assert.equal(mine.length, 1, "the sentinel's note, and none for the ping");
    assert.ok(!changed(mine[0] ?? {}).includes(wrote));
    // A self-started turn opens execution coverage with no baseline, so what an
    // ungated ping would leave is a second coverage line rather than a path.
    const raw = await fs.readFile(record.recordFile('g1'), 'utf8');
    // The tree as a JSON line spells it: a win32 path's backslashes escaped.
    const tree = JSON.stringify(dir).slice(1, -1);
    const executions = raw
      .split('\n')
      .filter((line) => line.includes('"ex":') && line.includes(tree));
    assert.equal(executions.length, 1, executions.join('\n'));
  });

  it('leaves the window row a neighbour subtracts against', async () => {
    const dir = await repo();
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('slow');
    await until(handle, 'the turn', (s) => s.running);
    await fs.writeFile(path.join(dir, 'windowed.txt'), 'x\n');
    await handle.turn?.interrupt();
    await notes(dir);

    const checkpoint = await import('../../core/checkpoint');
    const windows = await checkpoint.readWindows(dir);
    assert.equal(windows.length, 1, 'every owned session on the tree leaves one');
    assert.deepEqual(windows[0]?.paths, [path.join(dir, 'windowed.txt')]);
    assert.ok((windows[0]?.end ?? 0) >= (windows[0]?.start ?? 0));
  });

  /**
   * The case Step 2's `capturing` latch exists for, and the one `drainGen`
   * could never have covered: it is bumped only by `sendNow`, so every other
   * caller — `send`, `respond`, `ready`, `tryDrain`'s own tail, and the end of
   * every notification — shares one generation and would pass the same gate.
   *
   * Two sends, back to back, with nothing awaited between them. The second
   * reaches `tryDrain` while the first is still on its baseline.
   */
  it('lets no second drain through the window the baseline is open in', async () => {
    const dir = await repo();
    const checkpoint = await import('../../core/checkpoint');
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // **`open` stubbed to a promise this test holds**, per the plan's own
    // Done-when: hoping a real `git add` is slow makes the window a coin toss,
    // and a merged prompt hides the damage a second drain does. Counted as
    // well as held — a second `open` is what replaces the first baseline.
    // Read off the prototype on purpose, and called back with an explicit
    // receiver below — which is the one thing `unbound-method` cannot see.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = checkpoint.TurnCheckpoints.prototype.open;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opens = 0;
    checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
      // **This case's own tree only.** The stub is on the prototype, so it is
      // every `TurnCheckpoints` in the process — and handles from earlier cases
      // stay in `alive` until the file's `after`. Unfiltered, a stray open from
      // one of them takes this counter's `1` and parks this case's first turn on
      // a promise nothing will resolve.
      if (cwd !== dir) {
        return real.call(this, cwd);
      }
      opens += 1;
      return held;
    };
    try {
      handle.messages?.send('latch-a');
      handle.messages?.send('latch-b');
      // Both drains are past `await this.opening` by now; the first is parked on
      // the baseline and the second has had every chance at the gate.
      await new Promise((settled) => setTimeout(settled, 150));
      assert.equal(opens, 1, 'one baseline in flight, not two');
      assert.ok(!handle.state.running, 'nothing is released while it is open');
      assert.ok(handle.state.queued.length > 0, 'and the outbox still holds its head');
    } finally {
      checkpoint.TurnCheckpoints.prototype.open = real;
      release();
    }
    // Released, the turn goes as it always would — the latch delays a drain, it
    // does not lose one.
    await until(handle, 'the turn', (s) => s.running);
    await until(handle, 'idle', (s) => !s.running);
    const lines = await recorded((all) =>
      all.some((line) => typeof line.text === 'string' && line.text.includes('latch-a'))
    );
    const users = lines.filter(
      (line) =>
        line.role === 'user' && typeof line.text === 'string' && line.text.includes('latch-a')
    );
    assert.equal(users.length, 1, 'the head is written once, not twice');
  });

  /**
   * Rule 1 is unreachable for a turn Grok started itself — it is already
   * running by the time `queue/changed` names it — and `canWrite` lets a drain
   * ride one. A baseline taken there would span the wake's tail plus our own
   * turn and charge one to the other, so it is skipped and the turn draws the
   * same silence the wake already gets.
   */
  it('takes no baseline on a drain riding a turn Grok started itself', async () => {
    const dir = await repo();
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // Our own turn first, and it earns a note like any other — the wake is what
    // it leaves running behind it. Counted across that, because what is asserted
    // is the drain *inside* the wake and not this one.
    handle.messages?.send('self-started-nofinish');
    // **`words` and not `running`.** The first `tryDrain` applies its own
    // busy edge before the wake exists, so `running` alone resolves on our
    // turn — the same trap the existing latch case avoids by waiting for the
    // word the wake streams.
    await until(handle, 'the wake', (s) => s.running && s.words.includes('woke'));
    const before = (await notes(dir)).length;

    // `canWrite` is true through a wake and `canDrain` is not, so this drain
    // writes without baselining. A baseline here would span the wake's tail
    // plus our own turn and charge one to the other. Written *before* the send,
    // so the file cannot land inside a baseline this test is arguing was never
    // taken — inside one, it subtracts back out and proves nothing.
    await fs.writeFile(path.join(dir, 'not-ours.txt'), 'z\n');
    handle.messages?.send('during-the-wake');
    // The prompt is what gives the stuck wake its second closer, so this turn
    // does end — and its idle edge is exactly where an unwanted note would be
    // filed. Waited out rather than polled for, because what is asserted is
    // that nothing arrives.
    await until(handle, 'the wake closes', (s) => !s.running || s.queued.length === 0);
    // A note that can only have been filed after this drain's would have been,
    // rather than a fixed wait.
    await drainPast(handle, dir, 'after-the-wake');

    const after = await notesNow(dir);
    assert.ok(before >= 1, 'our own turn filed one, so the path is alive at all');
    assert.equal(
      after.filter((note) => !changed(note).includes(path.join(dir, 'after-the-wake.txt'))).length,
      before,
      'the drain riding the wake files no note'
    );
    assert.ok(
      !after.some((note) => changed(note).includes(path.join(dir, 'not-ours.txt'))),
      'and no note claims what was written during it'
    );
  });

  /**
   * Finding 1 of the 2026-08-27 review, and the hole `canDrain`-before-`open`
   * does not cover on its own. The skip only runs at the *start* of the await:
   * a wake that begins inside those 43ms leaves `canWrite()` true on the far
   * side — that exception exists to write during a wake — so the drain goes on
   * to release a turn carrying a baseline taken while the session was idle, and
   * the idle edge after it charges the wake's writes to our turn.
   */
  it('drops a baseline a wake ran inside of', async () => {
    const dir = await repo();
    const checkpoint = await import('../../core/checkpoint');
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // The capture runs **now**, against the tree as it is; only the resolution
    // is held. A stub that deferred the capture itself would baseline *after*
    // the write below and subtract it back out — green, and proving nothing.
    // Read off the prototype on purpose, and called back with an explicit
    // receiver below — which is the one thing `unbound-method` cannot see.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = checkpoint.TurnCheckpoints.prototype.open;
    let release = (): void => {};
    let baselined = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taken = new Promise<void>((resolve) => {
      baselined = resolve;
    });
    let opens = 0;
    checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
      // This case's own tree only, for the reason the latch case states.
      if (cwd !== dir) {
        return real.call(this, cwd);
      }
      opens += 1;
      // The first turn baselines and proceeds. The second is held open across
      // the wake, and announces when its snapshot is actually on the object.
      return opens === 1
        ? real.call(this, cwd)
        : real.call(this, cwd).then(() => {
            baselined();
            return held;
          });
    };
    try {
      handle.messages?.send('self-started-nofinish');
      // **Queued only once our turn is running**, so it is a second drain and
      // not a merge. Sent together, `mergeQueued` folds both into one prompt
      // and there is no second `open` to hold at all.
      await until(handle, 'our turn', (s) => s.running);
      handle.messages?.send('behind-the-wake');

      // **Both waits, in this order.** The captures serialise on one chain, so
      // the second baseline lands behind the first turn's closing capture —
      // written before it, the file is inside the snapshot and subtracts back
      // out. Written before that closing capture finishes, it is claimed by the
      // *first* turn, which is a different case entirely and how the first
      // build of this test failed.
      await taken;
      await until(handle, 'the wake', (s) => s.running && s.words.includes('woke'));
      await fs.writeFile(path.join(dir, 'wake-wrote.txt'), 'w\n');
    } finally {
      checkpoint.TurnCheckpoints.prototype.open = real;
      release();
    }

    await until(handle, 'the held drain releases', (s) => s.queued.length === 0);
    await drainPast(handle, dir, 'after-the-open-wake');
    assert.ok(
      !(await notesNow(dir)).some((note) =>
        changed(note).includes(path.join(dir, 'wake-wrote.txt'))
      ),
      'no note claims what the wake wrote'
    );
  });

  /**
   * The half a state check cannot see, and the reason the latch exists.
   *
   * Review proposed `!canDrain()` on the far side of the baseline, which is
   * right for a wake still running — the case above. A plain `self-started`
   * wake closes itself 60ms in: it opens, writes, and is gone before the drain
   * resumes, so `canDrain` reads a quiet session and keeps a baseline the wake
   * has already written through. Nothing on `LiveState` remembers it happened.
   */
  it('drops a baseline a wake both opened and closed inside of', async () => {
    const dir = await repo();
    const checkpoint = await import('../../core/checkpoint');
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // Read off the prototype on purpose, and called back with an explicit
    // receiver below — which is the one thing `unbound-method` cannot see.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = checkpoint.TurnCheckpoints.prototype.open;
    let release = (): void => {};
    let baselined = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taken = new Promise<void>((resolve) => {
      baselined = resolve;
    });
    let opens = 0;
    checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
      // This case's own tree only, for the reason the latch case states.
      if (cwd !== dir) {
        return real.call(this, cwd);
      }
      opens += 1;
      return opens === 1
        ? real.call(this, cwd)
        : real.call(this, cwd).then(() => {
            baselined();
            return held;
          });
    };
    // **Latched, not waited for.** This wake lives 60ms and the baseline capture
    // it runs inside of takes 20-50ms — more under a loaded suite — so by the
    // time the capture resolves the wake may already be over. Waiting to *see*
    // it running is then a timeout, which is how this case first failed in
    // `check` while passing alone.
    let sawWake = false;
    const watching = onThreadState(handle, (st) => {
      if (st.words.includes('woke')) {
        sawWake = true;
      }
    });
    try {
      handle.messages?.send('self-started');
      await until(handle, 'our turn', (s) => s.running);
      handle.messages?.send('behind-the-wake');

      await taken;
      for (let look = 0; look < 200 && !sawWake; look++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(sawWake, 'the wake ran while the baseline was held open');
      // **Over before the drain resumes**, which is the whole point: `canDrain`
      // is true again and the session looks exactly as it did when the baseline
      // was taken. Written after it, so the baseline this turn would carry is
      // demonstrably stale.
      await until(handle, 'the wake closes', (s) => !s.running);
      await fs.writeFile(path.join(dir, 'closed-wake-wrote.txt'), 'w\n');
    } finally {
      watching();
      checkpoint.TurnCheckpoints.prototype.open = real;
      release();
    }

    await until(handle, 'the held drain releases', (s) => s.queued.length === 0);
    await drainPast(handle, dir, 'after-the-closed-wake');
    assert.ok(
      !(await notesNow(dir)).some((note) =>
        changed(note).includes(path.join(dir, 'closed-wake-wrote.txt'))
      ),
      'no note claims what the closed wake wrote'
    );
  });

  /**
   * The empty-outbox guard, which is deviation 1 of the plan's Notes. `tryDrain`
   * runs at the end of **every** notification, so without it a session pays 43ms
   * for a baseline on each one and — worse — leaves it open for whatever idle
   * edge comes next to diff.
   *
   * Counted rather than damaged: the harm needs an idle edge with no `open`
   * between, which no unit-reachable path stages. What the guard promises is
   * exactly one baseline per turn, and that is directly observable.
   */
  it('takes no baseline for a drain with nothing to send', async () => {
    const dir = await repo();
    const checkpoint = await import('../../core/checkpoint');
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    let opens = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = checkpoint.TurnCheckpoints.prototype.open;
    checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
      if (cwd === dir) {
        opens += 1;
      }
      return real.call(this, cwd);
    };
    try {
      // A wake gives this its notifications: every frame it streams ends in a
      // `tryDrain`, and the outbox is empty for all of them.
      let sawWake = false;
      const watching = onThreadState(handle, (st) => {
        if (st.words.includes('woke')) {
          sawWake = true;
        }
      });
      handle.messages?.send('self-started');
      await until(handle, 'the turn', (s) => s.running);
      // Latched while the wake is the most recent assistant row.
      for (let look = 0; look < 200 && !sawWake; look++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      watching();
      assert.ok(sawWake, 'the wake ran, so its frames each ended in a drain');
      await until(handle, 'idle again', (s) => !s.running);
      await new Promise((settled) => setTimeout(settled, 300));
      assert.equal(opens, 1, 'one message sent, one baseline taken');
    } finally {
      checkpoint.TurnCheckpoints.prototype.open = real;
    }
  });

  /**
   * The two bails that discard, asserted on the call rather than on damage.
   *
   * An abandoned baseline only shows itself at an idle edge with no `open`
   * between, and every such edge a unit test can reach is either guarded by
   * `capturing` or preceded by `end`. What `discard` *does* is covered in
   * `checkpoint.test.ts`, including that it cannot steal a `close` already on
   * the chain; what is left to pin is that these two exits call it.
   */
  for (const shape of [
    { name: 'the outbox empties inside its window', kill: false },
    { name: 'the session is stopped inside its window', kill: true }
  ]) {
    it(`discards the baseline when ${shape.name}`, async () => {
      const dir = await repo();
      const checkpoint = await import('../../core/checkpoint');
      const handle = start({ cwd: dir });
      await until(handle, 'handshake', (s) => s.sessionId === 'g1');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realOpen = checkpoint.TurnCheckpoints.prototype.open;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realDiscard = checkpoint.TurnCheckpoints.prototype.discard;
      let release = (): void => {};
      let baselined = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const taken = new Promise<void>((resolve) => {
        baselined = resolve;
      });
      let mine = false;
      let discards = 0;
      checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
        if (cwd !== dir) {
          return realOpen.call(this, cwd);
        }
        mine = true;
        return realOpen.call(this, cwd).then(() => {
          baselined();
          return held;
        });
      };
      checkpoint.TurnCheckpoints.prototype.discard = function (): void {
        if (mine) {
          discards += 1;
        }
        realDiscard.call(this);
      };
      try {
        handle.messages?.send('bail-on-me');
        await taken;
        if (shape.kill) {
          handle.close();
        } else {
          const [queued] = handle.state.queued;
          assert.ok(queued, 'the row this drain took a baseline for');
          assert.ok(handle.messages?.dismiss(queued.id), 'and the reader takes it back');
        }
      } finally {
        checkpoint.TurnCheckpoints.prototype.open = realOpen;
        release();
      }
      for (let look = 0; look < 200 && discards === 0; look++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      checkpoint.TurnCheckpoints.prototype.discard = realDiscard;
      assert.equal(discards, 1, 'the baseline this drain never released is given back');
    });
  }

  /**
   * Send now is the escape hatch from a latched-busy card, and a capture may
   * not stand in it.
   *
   * Deterministic where the pre-existing latched-`sendNow` case is only
   * probabilistic: that one needs a stray frame to land inside the real 43ms
   * window, and it did — twice under a loaded `check`, and every time with the
   * window widened by 200ms. Here the baseline is simply never released, so a
   * drain that waits on one waits forever.
   */
  it('sends now without waiting on a baseline', async () => {
    const dir = await repo();
    const checkpoint = await import('../../core/checkpoint');
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = checkpoint.TurnCheckpoints.prototype.open;
    const never = new Promise<void>(() => {});
    let opens = 0;
    checkpoint.TurnCheckpoints.prototype.open = function (cwd: string): Promise<void> {
      if (cwd !== dir) {
        return real.call(this, cwd);
      }
      opens += 1;
      // The first turn baselines and runs. Anything after it hangs.
      return opens === 1 ? real.call(this, cwd) : never;
    };
    try {
      // `hang-busy` ignores `session/cancel`, so the card stays busy on a turn
      // that will never return and the ordinary drain refuses forever.
      handle.messages?.send('hang-busy');
      await until(handle, 'the latched turn', (s) => s.running);
      handle.messages?.send('unstick-me');
      assert.equal(handle.state.queued.length, 1, 'held behind the latch');

      await handle.messages?.sendNow();
      await until(handle, 'the held message went', (s) => s.queued.length === 0);
    } finally {
      checkpoint.TurnCheckpoints.prototype.open = real;
    }
  });

  /**
   * Step 3's Done-when, and the reason the turn-end moved behind the tee flush
   * on both driven paths. `readRecord` folds a note onto the last non-marker
   * exchange written before it and never onto a user turn — so a `{ck}`
   * enqueued ahead of its own turn's assistant line lands on the turn before,
   * or is dropped on the prompt.
   */
  it('appends the note behind its own turn, not the one before it', async () => {
    const dir = await repo();
    const handle = start({ cwd: dir });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');

    // **`late-rebusy-lost`, and it has to be.** On every other path the fake
    // emits `turn_completed` a beat ahead of the RPC result, and the
    // notification handler records *before* it applies — so the tee has already
    // closed the assistant line and the order is right however the drain ends
    // its turn. This scenario withholds that frame, which leaves the
    // `session/prompt` result as the only closer and puts the flush and the
    // turn-end in the same `finally`. That is the one the reorder governs.
    handle.messages?.send('ordered-me late-rebusy-lost');
    await until(handle, 'the answer', (s) => s.words.includes('pong'));
    await fs.writeFile(path.join(dir, 'ordered.txt'), 'q\n');
    await notes(dir);

    const raw = (await fs.readFile(record.recordFile('g1'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const note = raw.findIndex((line) => (line.ck as { tree?: string } | undefined)?.tree === dir);
    const prompt = raw.findIndex(
      (line) => typeof line.text === 'string' && line.text.includes('ordered-me')
    );
    assert.ok(prompt >= 0, 'the prompt reached the record');
    assert.ok(note > prompt, 'the note is written after its own prompt');
    // The fold in `readRecord` attaches a note to the last non-marker exchange
    // written before it and never to a user turn. Applied ahead of the flush,
    // this note sits between the prompt and its own answer — where it lands on
    // the previous turn or is dropped outright.
    const between = raw.slice(prompt + 1, note).filter((line) => line.role === 'assistant');
    assert.ok(between.length >= 1, "that turn's own assistant line is already on the chain");
  });
});
