import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import {
  forgetWindows,
  learnWindow,
  loadWindows,
  windowFor,
  windowsWritten
} from '../../core/claude/context';
import { readFrame } from '../../core/claude/frames';
import { reduce } from '../../core/claude/reduce';
import { initial, type LiveState } from '../../core/live';
import { writeJson } from '../helpers';

// Every `learnWindow` in this file writes, and the store's default path is the
// machine's own — `paths.ts` resolved it from the real home before any of this
// ran, so `tempHome` is too late to move it. Pointed once here, and nothing
// resets it, so a case that never mentions the store still cannot reach the one
// in `~/.squadron`.
before(async () => {
  await loadWindows(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-windows-')));
});

/** The store's contents, or nothing when it was never written — which is the
 *  assertion half of these tests as often as the contents are. */
async function readable(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

describe('windowFor', () => {
  it('knows the sizes observed on a machine that had dumps', () => {
    assert.equal(windowFor('claude-opus-5'), 1_000_000);
    // The million-token variant is its own id, which is why two sessions on one
    // id can never disagree about the window they answer in.
    assert.equal(windowFor('claude-opus-4-8[1m]'), 1_000_000);
  });

  it('has no answer for a model nobody has seen, rather than a plausible one', () => {
    assert.equal(windowFor('claude-sonnet-7'), undefined);
    assert.equal(windowFor(undefined), undefined);
  });

  it('takes a size from a dump, which outranks what was observed elsewhere', () => {
    learnWindow('claude-sonnet-7', 200_000);
    assert.equal(windowFor('claude-sonnet-7'), 200_000);
    // A model shipped with a bigger window later says so itself, and is
    // believed over the reading before it.
    learnWindow('claude-sonnet-7', 1_000_000);
    assert.equal(windowFor('claude-sonnet-7'), 1_000_000);
  });

  it('ignores a dump that stated the size in some other shape', () => {
    // Every field of that file has been seen missing, and a changed CLI writing
    // a string here would otherwise put a wrong percentage on every card
    // answering as this model — not just on its own.
    learnWindow('claude-haiku-9', '1000000');
    learnWindow('claude-haiku-9', 0);
    learnWindow('claude-haiku-9', Number.NaN);
    assert.equal(windowFor('claude-haiku-9'), undefined);
    learnWindow(undefined, 1_000_000);
    learnWindow('', 1_000_000);
    assert.equal(windowFor(''), undefined);
  });
});

// The map is module-global and `learnWindow` writes to it, so without this a
// size one test taught it is a size every later test — and every later suite in
// the same process — reads back. `usage.forgetUsage` is the same export for the
// same reason.
describe('forgetWindows', () => {
  it('drops what a dump taught it', () => {
    learnWindow('claude-sonnet-7', 200_000);
    assert.equal(windowFor('claude-sonnet-7'), 200_000);

    forgetWindows();

    assert.equal(windowFor('claude-sonnet-7'), undefined);
  });

  it('goes back to the seed rather than to nothing', () => {
    // Emptying the map would be the worse reset: the seed is what a card reads
    // before any dump on this machine has been written, so a cleared map leaves
    // every card on its token count instead of its percentage.
    learnWindow('claude-opus-5', 500_000);
    assert.equal(windowFor('claude-opus-5'), 500_000);

    forgetWindows();

    assert.equal(windowFor('claude-opus-5'), 1_000_000);
  });
});

describe('windowFor, the `[1m]` suffix', () => {
  beforeEach(() => forgetWindows());

  it('reads a million out of the suffix for an id nobody has met', () => {
    // The CLI's own first test, so this is a reading rather than a guess: an id
    // spelled this way answers in a million whatever else is known about the
    // model. Every 1M variant ships unseen once, and this is the pass where a
    // card would otherwise sit on a token count.
    assert.equal(windowFor('claude-opus-5[1m]'), 1_000_000);
    assert.equal(windowFor('claude-sonnet-9[1M]'), 1_000_000);
  });

  it('still has no answer for an unknown id without it', () => {
    assert.equal(windowFor('claude-sonnet-9'), undefined);
  });

  it('loses to a size something actually stated', () => {
    // The rule is the floor, not the ruling. A dump or a `result` frame is this
    // machine reporting the window in force — including the one case the rule
    // cannot see, a session run with `CLAUDE_CODE_DISABLE_1M_CONTEXT` set.
    learnWindow('claude-sonnet-9[1m]', 200_000);
    assert.equal(windowFor('claude-sonnet-9[1m]'), 200_000);
  });
});

describe("windowFor, the catalog's figure", () => {
  beforeEach(() => forgetWindows());

  /**
   * The reading three models actually report, and the one no other tier can
   * answer: the store learns `claude-opus-4-5` off `modelUsage` while every
   * card reads the dated spelling, so a machine holding the right size showed
   * `31k used` (observed 2026-08-29).
   */
  it('answers a dated reading that no dump and no `modelUsage` key spells', () => {
    assert.equal(windowFor('claude-opus-4-5-20251101'), 200_000);
    assert.equal(windowFor('claude-haiku-4-5-20251001'), 200_000);
    assert.equal(windowFor('claude-sonnet-4-5-20250929'), 200_000);
  });

  it('says nothing for a reading that names two sizes', () => {
    // `claude-sonnet-5` is the spelling for the 1M start and the 200k one
    // alike, so an id cannot settle it. Answering the wider would print `3%`
    // for a session sitting at `15%`, which is the guess this file refuses.
    // (`claude-fable-5` is the same shape and answers 1M anyway — it is in
    // `SEED`, and a seeded size is a reading that outranks this tier.)
    assert.equal(windowFor('claude-sonnet-5'), undefined);
  });

  it('says nothing where 200k is what a flag buys, not what a launch gets', () => {
    // The subtler half, and the one that would be wrong five times over. A
    // plain `claude-opus-4-7` runs at a million; its 200k entry is reached by
    // `CLAUDE_CODE_DISABLE_1M_CONTEXT`, so reading the size off that entry
    // would put `3%` on a card sitting at `15%` — `reach` is what tells the
    // two apart. Neither id is in `SEED`, so nothing else is answering here.
    assert.equal(windowFor('claude-opus-4-7'), undefined);
    // And the row where a plain launch *does* land on 200k still answers.
    assert.equal(windowFor('claude-opus-4-6'), 200_000);
  });

  it('loses to anything this machine actually observed', () => {
    // A row states what a model *has*; a dump or a `result` frame states what
    // this session is in — including a start held to 200k by an environment no
    // catalog can see.
    learnWindow('claude-opus-4-5-20251101', 120_000);
    assert.equal(windowFor('claude-opus-4-5-20251101'), 120_000);
  });

  it('still has no answer for a model no row names', () => {
    assert.equal(windowFor('claude-sonnet-7'), undefined);
  });
});

describe('the learnt sizes on disk', () => {
  let home: string;

  beforeEach(async () => {
    forgetWindows();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-windows-'));
  });

  const stored = (): string => path.join(home, '.squadron', 'models.claude.json');

  it('writes a learnt size where the next window can read it', async () => {
    await loadWindows(home);
    learnWindow('claude-sonnet-9', 400_000);
    await windowsWritten();

    assert.deepEqual(JSON.parse(await fs.readFile(stored(), 'utf8')), {
      'claude-sonnet-9': 400_000
    });
  });

  it('reads back what an earlier launch learnt', async () => {
    await writeJson(stored(), { 'claude-sonnet-9': 300_000 });

    await loadWindows(home);

    // The whole point of the store: this process has met no session answering
    // as that id, and the card still gets a percentage rather than a count.
    assert.equal(windowFor('claude-sonnet-9'), 300_000);
  });

  it('keeps the seed out of the file, so a corrected seed is not shadowed', async () => {
    await loadWindows(home);
    // Restating what the seed already says is not news, and writing it down is
    // what would pin this machine to today's figure forever.
    learnWindow('claude-opus-5', 1_000_000);
    await windowsWritten();
    assert.equal(await readable(stored()), undefined);

    // Contradicting it is news, and is exactly what the file is for.
    learnWindow('claude-opus-5', 500_000);
    await windowsWritten();
    assert.deepEqual(JSON.parse((await readable(stored())) ?? ''), { 'claude-opus-5': 500_000 });
  });

  it('keeps an id another window learnt, rather than writing our map over it', async () => {
    // The trap the whole-map record sets, and the reason a write reads first.
    // Ours is the only process that has met `sonnet-9`; the file is the only
    // place `haiku-9` exists — and an old session's model may never report
    // again for us to learn it back, which is what this store is for.
    await loadWindows(home);
    learnWindow('claude-sonnet-9', 400_000);
    await windowsWritten();
    await writeJson(stored(), { 'claude-sonnet-9': 400_000, 'claude-haiku-9': 123_000 });

    learnWindow('claude-fable-9', 500_000);
    await windowsWritten();

    assert.deepEqual(JSON.parse(await fs.readFile(stored(), 'utf8')), {
      'claude-sonnet-9': 400_000,
      'claude-haiku-9': 123_000,
      'claude-fable-9': 500_000
    });
  });

  it('does not rewrite a store another window already agrees with', async () => {
    // The memo cannot answer this: it knows what *this* process wrote, and the
    // figures got there some other way. A write nobody needed nudges every
    // window on the machine into a poll, so the guard is against the file.
    await loadWindows(home);
    const settled = JSON.stringify({ 'claude-sonnet-9': 400_000 }, null, 2);
    await fs.mkdir(path.dirname(stored()), { recursive: true });
    await fs.writeFile(stored(), settled);

    // Learnt here, not read: the map reaches the same figure the file already
    // holds without this process ever having written it.
    learnWindow('claude-sonnet-9', 400_000);
    await windowsWritten();

    assert.equal(await fs.readFile(stored(), 'utf8'), settled);
  });

  it('puts back an id a window that overlapped us wrote over', async () => {
    // Two merges can still overlap — we read, they read, we write, they write
    // the merge they computed before ours — and there is no lock anywhere to
    // have stopped it. The pass after is where whoever still holds the id
    // notices, since it has read the file anyway to hydrate from it.
    await loadWindows(home);
    learnWindow('claude-sonnet-9', 400_000);
    await windowsWritten();
    await writeJson(stored(), { 'claude-haiku-9': 123_000 });

    await loadWindows(home);
    await windowsWritten();

    assert.deepEqual(JSON.parse(await fs.readFile(stored(), 'utf8')), {
      'claude-haiku-9': 123_000,
      'claude-sonnet-9': 400_000
    });
  });

  it('keeps a size this window watched over one the store disagrees with', async () => {
    // Two sessions on one id can genuinely sit in different windows — the CLI
    // reads the environment before it reads the model. The card is drawn off
    // what this window watched its own session report, not off what the window
    // next door wrote down.
    await loadWindows(home);
    learnWindow('claude-sonnet-9', 1_000_000);
    await windowsWritten();
    await writeJson(stored(), { 'claude-sonnet-9': 200_000 });

    await loadWindows(home);

    assert.equal(windowFor('claude-sonnet-9'), 1_000_000);
  });

  it('does not argue with the other window about it, pass after pass', async () => {
    // The storm the presence-only repair exists to avoid: neither window is
    // short an id, so neither rewrites, and a disagreement is settled by
    // whoever wrote last. Every write nudges every window on the machine into a
    // poll, so a repair that fired on a disagreement would cost one of those
    // per window per pass, for as long as both sessions ran.
    await loadWindows(home);
    learnWindow('claude-sonnet-9', 1_000_000);
    await windowsWritten();
    const theirs = JSON.stringify({ 'claude-sonnet-9': 200_000 }, null, 2);
    await fs.writeFile(stored(), theirs);

    await loadWindows(home);
    await windowsWritten();
    await loadWindows(home);
    await windowsWritten();

    assert.equal(await fs.readFile(stored(), 'utf8'), theirs);
  });

  it('does not write back the file it just read', async () => {
    // `panel.ts` watches every `.json` under the state root, so a needless write
    // nudges every window on the machine into a poll. Told apart from a write of
    // the same content by the formatting, which only this test's own write has.
    const formatted = JSON.stringify({ 'claude-sonnet-9': 300_000 }, null, 2);
    await fs.mkdir(path.dirname(stored()), { recursive: true });
    await fs.writeFile(stored(), formatted);

    await loadWindows(home);
    await windowsWritten();

    assert.equal(await fs.readFile(stored(), 'utf8'), formatted);
  });
});

/**
 * Which owned sessions may teach the store, and which may not. Both halves
 * matter and the second is the easy one to lose: an *unpinned* owned session
 * must keep feeding it. `claude/reduce.ts` states the reasoning.
 */
describe('what an owned turn teaches the store', () => {
  let home: string;

  beforeEach(async () => {
    forgetWindows();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-windows-'));
    await loadWindows(home);
  });

  const stored = (): string => path.join(home, '.squadron', 'models.claude.json');

  /** One turn on `claude-sonnet-9`, ending in a `result` that states a window.
   *  An id the seed does not carry, so anything written is news. */
  const turn = (windowReach?: 'plain' | 'suffix' | 'flag') => {
    let state = initial({
      cwd: '/repo/app',
      startedAt: 1000,
      model: 'claude-sonnet-9',
      window: windowReach === undefined ? undefined : 200_000,
      windowReach
    });
    for (const wire of [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-9', session_id: 's1' },
      { type: 'result', modelUsage: { 'claude-sonnet-9': { contextWindow: 200_000 } } }
    ]) {
      const frame = readFrame(wire);
      assert.ok(frame, 'the fixture should be a frame this reader recognises');
      state = reduce(state, frame);
    }
    return state;
  };

  it('writes nothing when the launch pinned the window', async () => {
    const state = turn('flag');
    await windowsWritten();
    // The card still knows its own size — it is on the session, not in the
    // store, which is the whole shape of this decision.
    assert.equal(state.windowStated, 200_000);
    assert.equal(await readable(stored()), undefined, 'a pinned session wrote to the store');
  });

  /** A `plain` window is the model's own answer, not this session's — the gear
   *  writes a window for every pick, so keying the guard on "a window is set"
   *  stopped the store learning from owned sessions almost entirely. */
  it('still writes for a window the launch line never spelled', async () => {
    turn('plain');
    await windowsWritten();
    assert.deepEqual(JSON.parse((await readable(stored())) ?? ''), {
      'claude-sonnet-9': 200_000
    });
  });

  it('still writes when the launch asked for nothing', async () => {
    turn();
    await windowsWritten();
    assert.deepEqual(JSON.parse((await readable(stored())) ?? ''), {
      'claude-sonnet-9': 200_000
    });
  });

  /**
   * A flagged line that has since switched models, and it lands on a *seeded*
   * flagship. Switching back onto Opus 5's 200k pill used to leave the reach
   * `undefined` — the target reaches it by flag and the rewritten field no
   * longer said the line was flagged — so the guard opened and
   * `claude-opus-5: 200000` overwrote the seed's million and `save()`d it.
   *
   * The post-switch state is built here rather than driven through
   * `OwnedSession`: this suite has no transport rig. It is what `setModel`
   * applies, and that it leaves `launchReach` alone is pinned by
   * `claude_session.test.ts` § *leaves the launch line's reach alone*.
   */
  it('does not overwrite a seeded flagship after a switch on a flagged line', async () => {
    let state: LiveState = {
      ...initial({
        cwd: '/repo/app',
        startedAt: 1000,
        model: 'claude-opus-5',
        window: 200_000,
        windowReach: 'flag' as const
      }),
      modelPick: 'claude-opus-5',
      windowAsked: 200_000,
      windowStated: undefined
    };
    for (const wire of [
      { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
      { type: 'result', modelUsage: { 'claude-opus-5': { contextWindow: 200_000 } } }
    ]) {
      const frame = readFrame(wire);
      assert.ok(frame, 'the fixture should be a frame this reader recognises');
      state = reduce(state, frame);
    }
    await windowsWritten();
    assert.equal(windowFor('claude-opus-5'), 1_000_000, 'the seed was overwritten');
    assert.equal(await readable(stored()), undefined, 'a flagged session wrote to the store');
  });

  /**
   * The same bug in the wide direction, and the half the launch line alone does
   * not answer. An unflagged line can still spell `[1m]` on a *switch*, and
   * that window is the session's rather than the model's just as much as a
   * pinned one is — `modelUsage` reports under the unsuffixed spelling on some
   * models, so the store would learn a million for the bare id and every
   * discovered card on it would draw against a window it is not in.
   *
   * There is no field for it: the reach a switch achieved is not recorded any
   * more, deliberately. It is derived from what the session picked, which is
   * exactly what `setModel` computed before that write was deleted.
   */
  it('writes nothing for a window this session spelled the suffix for', async () => {
    let state: LiveState = {
      ...initial({
        cwd: '/repo/app',
        startedAt: 1000,
        model: 'claude-haiku-4-5',
        window: 200_000,
        windowReach: 'plain' as const
      }),
      modelPick: 'claude-opus-4-6',
      windowAsked: 1_000_000,
      windowStated: undefined
    };
    for (const wire of [
      { type: 'system', subtype: 'init', model: 'claude-opus-4-6[1m]', session_id: 's1' },
      { type: 'result', modelUsage: { 'claude-opus-4-6': { contextWindow: 1_000_000 } } }
    ]) {
      const frame = readFrame(wire);
      assert.ok(frame, 'the fixture should be a frame this reader recognises');
      state = reduce(state, frame);
    }
    await windowsWritten();
    // Opus 4.6 runs at 200k without the suffix, so a store saying a million
    // would be wrong for every discovered card on that model — and the store is
    // read *ahead* of the catalog, so it would win.
    assert.equal(await readable(stored()), undefined, 'a suffixed window was written');
    assert.equal(windowFor('claude-opus-4-6'), 200_000, 'the catalog’s plain figure was lost');
  });
});
