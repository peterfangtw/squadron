import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as live from '../../core/live';
import { Session } from '../../core/model';
import { PublishedLive } from '../../core/published';
import type { StatedName } from '../../core/names';
import { EndingSessions } from '../../core/ending';
import { buildGroups, buildLineage, displayName, foldTwins, onBoard } from '../../ui/views';
import { session } from '../views_helpers';

describe('foldTwins', () => {
  const owned = session({ pid: 7, source: 'owned', status: 'busy' });
  const twin = session({ pid: 7, status: 'unknown', effort: 'high' });
  const other = session({ pid: 9 });

  it('keeps the pipe’s reading of a session this window drives', () => {
    const board = foldTwins([owned], [twin, other]);
    assert.deepEqual(
      board.map((s) => [s.pid, s.status]),
      [
        [7, 'busy'],
        [9, 'idle']
      ],
      'the twin is dropped, not merged over the owned card'
    );
  });

  it('takes the effort off the twin, which is the only thing that states it', () => {
    // No frame carries the effort, so without this an owned card could never
    // say what its session is thinking at.
    assert.equal(foldTwins([owned], [twin])[0]?.effort, 'high');
  });

  it('keeps the live effort when the twin states none', () => {
    // Codex states its effort on the pipe and `codex/discover.ts` reads none,
    // so a twin that silently won here erased the answer on every poll after
    // the first.
    const stated = session({ pid: 7, source: 'owned', status: 'busy', effort: 'medium' });
    const quiet = session({ pid: 7, status: 'unknown' });
    assert.equal(foldTwins([stated], [quiet])[0]?.effort, 'medium');
  });

  // The chip's flag belongs to whichever half supplied the branch beside it.
  // The two halves learn about a move at different moments — the pipe restates
  // its cwd on the next `init`, the twin reads it off the transcript's newest
  // entry — so for one poll they disagree, and taking the branch from one and
  // the flag from the other draws "worktree ·" over a main-checkout branch.
  it('takes the branch and its worktree flag off the same half', () => {
    const behind = session({ pid: 7, source: 'owned', branch: 'main', liveWorktree: undefined });
    const ahead = session({
      pid: 7,
      branch: 'feat/side',
      repoRoot: '/work/app',
      liveWorktree: true
    });
    const [card] = foldTwins([behind], [ahead]);
    assert.equal(card?.branch, 'feat/side');
    assert.equal(card?.liveWorktree, true);

    // And the other way: the twin has not noticed the move the pipe already
    // stated, so its branch wins and its flag must come with it.
    const stale = session({ pid: 7, branch: 'main', repoRoot: '/work/app' });
    const moved = session({ pid: 7, source: 'owned', branch: 'feat/side', liveWorktree: true });
    const [second] = foldTwins([moved], [stale]);
    assert.equal(second?.branch, 'main');
    assert.equal(second?.liveWorktree, undefined);
  });

  it('takes the running command off the twin, which the process table answers', () => {
    // A backgrounded command is a child shell of the CLI and is on no frame, so
    // the window driving the session was the one window that could not see it.
    const running = session({ pid: 7, hasCommand: true });
    assert.equal(foldTwins([owned], [running])[0]?.hasCommand, true);
    assert.equal(foldTwins([owned], [twin])[0]?.hasCommand, false);
  });

  it('takes a rename off the twin, which is the only record of one', () => {
    // `/rename` rewrites `sessions/<pid>.json` and deletes `nameSource` there,
    // and no frame carries the new name in a field — so the window driving the
    // session was the one window still printing the name it was spawned under.
    const spawned = session({ pid: 7, source: 'owned', name: 'Rename test' });
    const renamed = session({ pid: 7, name: 'yooy' });
    const [card] = foldTwins([spawned], [renamed]);
    assert.equal(card?.name, 'yooy');
    assert.equal(card?.nameSource, undefined);
  });

  it('leaves a derived name on the twin, where it says nothing', () => {
    // A derived name is the directory plus a suffix. Folding one would let a
    // file that has not caught up overwrite a title this window's own round
    // trip just produced — the card renaming itself backwards on a poll.
    const titled = session({ pid: 7, source: 'owned', name: 'Fix the fold' });
    const behind = session({
      pid: 7,
      name: 'app-7',
      nameSource: 'derived'
    });
    assert.equal(foldTwins([titled], [behind])[0]?.name, 'Fix the fold');
  });

  it('takes a title the twin read out of the transcript', () => {
    // `ai-title` is a statement like any other — the CLI's titler made it — and
    // it reaches a card that never asked for one only through the twin.
    const unnamed = session({ pid: 7, source: 'owned', name: 'app-7', nameSource: 'derived' });
    const titled = session({
      pid: 7,
      name: 'Trace the missing cards',
      nameSource: 'ai-title'
    });
    const [card] = foldTwins([unnamed], [titled]);
    assert.equal(card?.name, 'Trace the missing cards');
    // One vocabulary out of the fold: `ai-title` is what discover read it as
    // and `generated` is what the same claim publishes as (`core/naming.ts`).
    assert.equal(card?.nameSource, 'generated');
  });

  it('lets a title replace the prompt the card was spawned with', () => {
    // The live half wears the crop until a title exists — here the twin has one
    // first, off the transcript, because the round trip that asked for it is
    // the same CLI writing the same string.
    const crop = session({
      pid: 7,
      source: 'owned',
      name: 'trace why no card renames itself an…',
      nameSource: 'prompt'
    });
    const titled = session({
      pid: 7,
      name: 'Trace the missing cards',
      nameSource: 'ai-title'
    });
    assert.equal(foldTwins([crop], [titled])[0]?.name, 'Trace the missing cards');
  });

  it('keeps the prompt over a twin that only knows the directory', () => {
    // The other side of the same rung: a crop says more than `app-7` does, so
    // it holds until something better than a derived name turns up.
    const crop = session({
      pid: 7,
      source: 'owned',
      name: 'trace why no card renames itself an…',
      nameSource: 'prompt'
    });
    const behind = session({ pid: 7, name: 'app-7', nameSource: 'derived' });
    const [card] = foldTwins([crop], [behind]);
    assert.equal(card?.name, 'trace why no card renames itself an…');
    assert.equal(card?.nameSource, 'prompt');
  });

  describe('a name we stated ourselves', () => {
    const said = (over: Partial<StatedName> = {}): ReadonlyMap<string, StatedName> => {
      const record: StatedName = {
        schema: 1,
        brand: 'claude',
        sessionId: 'sid',
        name: 'Own the stated name',
        statedAt: 5,
        ...over
      };
      return new Map([[`${record.brand}\0${record.sessionId}`, record]]);
    };

    it('outranks a restamped ai-title, which is what this rung exists for', () => {
      // The transcript keeps restamping the pre-rename guess for the life of
      // the session, so without this rung a rename lands, is drawn, and is
      // undone by the next poll that reads the twin.
      const owned = session({ pid: 7, source: 'owned', name: 'app-7', nameSource: 'derived' });
      const guessed = session({
        pid: 7,
        name: 'Trace the missing cards',
        nameSource: 'ai-title'
      });
      const [card] = foldTwins([owned], [guessed], new Map(), said());
      assert.equal(card?.name, 'Own the stated name');
    });

    it('outranks a name the CLI’s own state states', () => {
      // Rung 2 is `sessions/<pid>.json` after a `--name` or a `/rename` — a
      // statement, and still the CLI’s rather than ours.
      const owned = session({ pid: 7, source: 'owned', name: 'app-7', nameSource: 'derived' });
      const renamed = session({ pid: 7, name: 'yooy', nameSource: 'user' });
      const [card] = foldTwins([owned], [renamed], new Map(), said());
      assert.equal(card?.name, 'Own the stated name');
    });

    it('publishes no nameSource, so displayName prints it verbatim', () => {
      // A card carrying our name must not be folded to `agent-7`, which is what
      // `displayName` does to a `derived` name that starts with the directory.
      const owned = session({ pid: 7, source: 'owned', name: 'app-7', nameSource: 'derived' });
      const twin = session({ pid: 7, name: 'app-7', nameSource: 'derived' });
      const [card] = foldTwins([owned], [twin], new Map(), said({ name: 'app-the-fold' }));
      assert.equal(card?.nameSource, undefined);
      assert.equal(card && displayName(card), 'app-the-fold');
    });

    it('reaches a card with no twin on disk yet', () => {
      // A session started this poll has no file naming it, and the window that
      // took the rename may not be the one drawing this board.
      const fresh = session({ pid: 7, source: 'owned', name: 'app-7', nameSource: 'derived' });
      assert.equal(foldTwins([fresh], [], new Map(), said())[0]?.name, 'Own the stated name');
    });

    it('reaches a twin no window published a half for', () => {
      const orphan = session({ pid: 7, status: 'unknown' });
      const [card] = foldTwins([], [orphan], new Map(), said());
      assert.equal(card?.name, 'Own the stated name');
    });

    it('reaches a card another window drives, off the record’s own id', () => {
      // Grok discovery is a pid walk that states no session id, so the key can
      // only come from the published half.
      const remote = session({
        pid: 7,
        source: 'owned',
        sessionId: 'sid',
        brand: 'grok',
        name: 'Investigate the turn limit',
        windowId: 'window-b',
        startedAt: 1000
      });
      const bare = session({ pid: 7, sessionId: '', startedAt: 1000 });
      const [card] = foldTwins(
        [],
        [bare],
        new Map([[7, { schema: 1, session: remote, pending: [], queued: [] }]]),
        said({ brand: 'grok' })
      );
      assert.equal(card?.name, 'Own the stated name');
    });

    it('does not answer for another brand sharing the session id', () => {
      // `conversationKey` carries the brand for exactly this reason.
      const owned = session({ pid: 7, source: 'owned', brand: 'claude', name: 'app-7' });
      const [card] = foldTwins([owned], [], new Map(), said({ brand: 'grok' }));
      assert.equal(card?.name, 'app-7');
    });

    /**
     * What a lost write costs, made visible — the rung order working exactly as
     * documented, against a record that has stopped being true.
     *
     * The store outranks the live half by design: it is the rung another
     * window's rename arrives on, and a card would otherwise ignore one. The
     * cost is that a record left behind by a *failed* second write does not
     * merely fail to update the card — it beats the newer statement the owning
     * window is still carrying on `LiveState.stated`, and the board reverts.
     *
     * So this is the hazard `host/sessions.ts` clears its `statedKey` for: with
     * the key retired, nothing rewrites this record and the revert is permanent.
     * Change the order here and that retry stops being needed; leave it, and it
     * is load-bearing.
     */
    it('lets a store record outrank a newer statement the live half carries', () => {
      const owned = session({ pid: 7, source: 'owned', sessionId: 'sid', name: 'the newer name' });
      assert.equal(foldTwins([owned], [], new Map(), said())[0]?.name, 'Own the stated name');
    });

    it('looks nothing up for a session the CLI has not named yet', () => {
      // A promptless owned start has no id until somebody types; its statement
      // is carried by the live half in the meantime.
      const nameless = session({ pid: 7, source: 'owned', sessionId: '', name: 'app-7' });
      assert.equal(foldTwins([nameless], [], new Map(), said())[0]?.name, 'app-7');
    });
  });

  it('takes the parent off the twin, so the owning window draws the family too', () => {
    // An owned card with no spawn parent takes `parentSessionId` from the
    // lineage join in `discover`. Without that fallback the window driving
    // the session was the one window whose board had no family box for it —
    // every other window saw the parent, because a promoted twin keeps what
    // the record does not state.
    const child = session({ pid: 7, parentSessionId: 'parent-sid' });
    const parent = session({ pid: 3, sessionId: 'parent-sid' });
    const board = foldTwins([owned], [child, parent]);
    assert.equal(board[0]?.parentSessionId, 'parent-sid');
    assert.equal(buildLineage(board).get(7)?.parent, 3);
  });

  it('takes the fan-out off the twin, so the owning window boxes it too', () => {
    // Same fallback as the parent above: the twin's lineage join, used when
    // the owned card does not already carry the stamp. Left off, the window
    // driving the session is the one window that draws it outside the box
    // every other window draws it inside.
    const child = session({
      pid: 7,
      parentSessionId: 'gone',
      originSessionId: 'origin-sid'
    });
    const origin = session({ pid: 3, sessionId: 'origin-sid' });
    const board = foldTwins([owned], [child, origin]);
    assert.equal(board[0]?.originSessionId, 'origin-sid');
    assert.equal(buildLineage(board).get(7)?.originId, 'origin-sid');
  });

  it('leaves a session with no twin yet as the frames describe it', () => {
    // Started this poll, before any file on disk names it.
    const fresh = session({ pid: 7, source: 'owned', effort: 'high', hasCommand: true });
    const board = foldTwins([fresh], [other]);
    assert.equal(board[0]?.effort, 'high');
    assert.equal(board[0]?.hasCommand, true);
  });

  it('keeps the owned checkout when the twin stated none', () => {
    const located = session({
      pid: 7,
      source: 'owned',
      branch: 'staging',
      worktree: true,
      repoRoot: '/work/app'
    });
    const bare = session({ pid: 7, status: 'unknown' });
    const [card] = foldTwins([located], [bare]);
    assert.equal(card?.branch, 'staging');
    assert.equal(card?.worktree, true);
    assert.equal(card?.repoRoot, '/work/app');
  });

  it('takes the twin checkout when discover stated one', () => {
    const located = session({ pid: 7, source: 'owned', branch: 'old', repoRoot: '/old' });
    const seen = session({
      pid: 7,
      branch: 'feat/x',
      worktree: true,
      repoRoot: '/work/app'
    });
    const [card] = foldTwins([located], [seen]);
    assert.equal(card?.branch, 'feat/x');
    assert.equal(card?.worktree, true);
    assert.equal(card?.repoRoot, '/work/app');
  });

  describe('a twin whose own window published its live half', () => {
    const remote = session({
      pid: 7,
      source: 'owned',
      status: 'waiting',
      name: 'Investigate the turn limit',
      windowId: 'window-b',
      startedAt: 1000
    });
    const record = (over: Partial<PublishedLive> = {}): PublishedLive => ({
      schema: 1,
      session: remote,
      pending: [],
      queued: [],
      ...over
    });
    /** As `discover` reports it: no status field is ever written for one. */
    const ghost = session({
      pid: 7,
      status: 'unknown',
      effort: 'high',
      branch: 'feat/x',
      worktree: true,
      repoRoot: '/work/app',
      startedAt: 1300
    });

    it('becomes an owned card, addressed to the window that drives it', () => {
      const [card] = foldTwins([], [ghost], new Map([[7, record()]]));
      assert.equal(card?.source, 'owned');
      assert.equal(card?.windowId, 'window-b');
      assert.deepEqual(card?.control, {
        canControl: true,
        owner: { kind: 'window', windowId: 'window-b' }
      });
      assert.equal(card?.status, 'waiting');
      assert.equal(card?.name, 'Investigate the turn limit');
    });

    it('does not donate the twin owner to an older publication missing its own owner', () => {
      const unclaimed = record({ session: { ...remote, windowId: undefined } });
      const observed = {
        ...ghost,
        windowId: 'unrelated',
        control: { canControl: false as const, reason: 'background' as const }
      };
      const [card] = foldTwins([], [observed], new Map([[7, unclaimed]]));
      assert.equal(card?.windowId, undefined);
      assert.deepEqual(card?.control, {
        canControl: true,
        owner: { kind: 'unclaimed', reason: 'owner-missing' }
      });
    });

    it('retains an invalid publication control result through promotion', () => {
      const malformed = record({
        session: { ...remote, control: { canControl: false, reason: 'invalid' } }
      });
      const [card] = foldTwins([], [ghost], new Map([[7, malformed]]));
      assert.deepEqual(card?.control, { canControl: false, reason: 'invalid' });
      assert.equal(card?.name, remote.name);
    });

    it('lets the twin-s title beat a placeholder the record is still wearing', () => {
      // The driving window publishes the crop until its own round trip answers;
      // the transcript on disk can carry the title first. A placeholder must
      // give way here exactly as it does inside the pipe.
      const waiting = record({
        session: { ...remote, name: 'investigate why the turn limit…', nameSource: 'prompt' }
      });
      const titled = { ...ghost, name: 'Investigate the turn limit', nameSource: 'ai-title' };
      const [card] = foldTwins([], [titled], new Map([[7, waiting]]));
      assert.equal(card?.name, 'Investigate the turn limit');
      assert.equal(card?.nameSource, 'generated');
    });

    it('keeps the record-s placeholder over a twin that only knows the directory', () => {
      const waiting = record({
        session: { ...remote, name: 'investigate why the turn limit…', nameSource: 'prompt' }
      });
      const behind = { ...ghost, name: 'app-7', nameSource: 'derived' };
      assert.equal(
        foldTwins([], [behind], new Map([[7, waiting]]))[0]?.name,
        'investigate why the turn limit…'
      );
    });

    it('keeps what the pipe cannot state — the effort, and where it is in git', () => {
      const [card] = foldTwins([], [ghost], new Map([[7, record()]]));
      assert.equal(card?.effort, 'high', 'stated only in the transcript');
      assert.equal(card?.branch, 'feat/x');
      assert.equal(card?.worktree, true);
      assert.equal(card?.repoRoot, '/work/app', 'and so which group it lands in');
    });

    it('keeps a published checkout when the twin stated none', () => {
      const located = record({
        session: session({
          ...remote,
          branch: 'staging',
          worktree: true,
          repoRoot: '/work/app'
        })
      });
      const bare = session({
        pid: 7,
        status: 'unknown',
        startedAt: 1000
      });
      const [card] = foldTwins([], [bare], new Map([[7, located]]));
      assert.equal(card?.branch, 'staging');
      assert.equal(card?.worktree, true);
      assert.equal(card?.repoRoot, '/work/app');
    });

    it('carries the model pick, which only the window holding the pipe knows', () => {
      // Nothing on disk states it: the alias was passed to a child another
      // window spawned, and the twin's own transcript names the CLI's spelling
      // at best. A watching window's pill ticks the right row only because the
      // record brings it (`core/live.ts`, `LiveState.modelPick`).
      const picked = record({ session: session({ ...remote, modelPick: 'opus[1m]' }) });
      const [card] = foldTwins([], [ghost], new Map([[7, picked]]));
      assert.equal(card?.modelPick, 'opus[1m]');
    });

    it('leaves a twin alone when the record is a recycled pid’s', () => {
      // Ten seconds apart is two different sessions wearing one pid, not two
      // clocks disagreeing — the observed gap between the two writers is under
      // half a second.
      const stale = record({ session: session({ ...remote, startedAt: 11_300 }) });
      const [card] = foldTwins([], [ghost], new Map([[7, stale]]));
      assert.equal(card?.status, 'unknown', 'the twin stands as it does today');
      assert.equal(card?.source, undefined);
      assert.deepEqual(card?.control, {
        canControl: true,
        owner: { kind: 'unclaimed', reason: 'unpublished' }
      });
    });

    it('leaves a twin alone when no window published anything for it', () => {
      assert.equal(foldTwins([], [ghost])[0]?.status, 'unknown');
    });

    it('never promotes over a session this window holds the pipe to', () => {
      const [card] = foldTwins([owned], [ghost], new Map([[7, record()]]));
      assert.equal(card?.status, 'busy', 'the live client wins, not a file');
      assert.equal(foldTwins([owned], [ghost], new Map([[7, record()]])).length, 1);
    });

    it('names the same parent in the owning window as in a watching one', () => {
      const kid = session({ ...ghost, parentSessionId: 'parent-sid' });
      const parent = session({ pid: 3, sessionId: 'parent-sid' });
      // Window B holds the pipe and sees the live half beside the twin; window
      // A has only the record B published. One family, both boards.
      const owning = buildLineage(foldTwins([remote], [kid, parent]));
      const watching = buildLineage(foldTwins([], [kid, parent], new Map([[7, record()]])));
      assert.equal(owning.get(7)?.parent, 3);
      assert.deepEqual(watching.get(7), owning.get(7));
      assert.deepEqual(watching.get(3)?.children, [7]);
    });

    it('keeps the running command too, which no frame the record holds can state', () => {
      // `fromLive` writes `hasCommand: false` on every frames-built session, so
      // the promoted card would say no command runs where the process table saw
      // one — the same gap the local fold reaches back to the twin for.
      const busy = session({ ...ghost, hasCommand: true });
      const [card] = foldTwins([], [busy], new Map([[7, record()]]));
      assert.equal(card?.hasCommand, true);
    });

    // Guards for what the fold and the board filter keep. Each names a session
    // that must survive, and each is green against the code as it stands — a
    // red one here means the reading behind a filter is wrong.
    describe('what a filter must not take with it', () => {
      it('keeps another window’s piped session when its record never landed', () => {
        // `publishLive` is best effort, and the fold is the shims' as well as
        // the panel's: a Claude twin discovery kept off its `sdk-cli` stays in
        // the fold, degraded rather than gone, so `squadron-list` still lists it.
        const [card] = foldTwins([], [ghost], new Map());
        assert.ok(card);
      });

      it('keeps it, owned, when the record did land', () => {
        const [card] = foldTwins([], [ghost], new Map([[7, record()]]));
        assert.ok(card);
        assert.equal(card.source, 'owned');
      });

      it('lets the record answer `background`, which it states by absence', () => {
        // `promote` spreads the record over the twin, so a field the record
        // does not carry survives from underneath — which for an optional flag
        // is the inverse of the guarantee the merge is documented to give.
        // A published record is only ever an owned session, and an owned
        // session is never background, so the record's silence is the answer.
        const stale = session({
          ...ghost,
          background: true,
          control: { canControl: false, reason: 'background' }
        });
        const [card] = foldTwins([], [stale], new Map([[7, record()]]));
        assert.equal(card?.source, 'owned');
        assert.equal(card?.background, undefined);
        assert.deepEqual(card?.control, {
          canControl: true,
          owner: { kind: 'window', windowId: 'window-b' }
        });
      });

      it('draws nothing at all for a record whose pid no longer runs', () => {
        // What makes `discover` load bearing: nothing in the repo builds a
        // session out of a record. Drop the twin and the card goes with it.
        assert.deepEqual(foldTwins([], [], new Map([[7, record()]])), []);
      });

      it('keeps a background session, which is not owned', () => {
        // A `bg` session is not owned here, so "owned" alone would take it off
        // the board — a whole session kind, run by the CLI's own agents
        // feature, deleted by a change that never names it.
        const bg = session({ ...ghost, background: true });
        assert.deepEqual(onBoard([bg]), [bg]);
      });
    });
  });
});

/**
 * Spawn facts enter as `OwnedFacts` on `toSession`. The family is whatever
 * `foldTwins` and `buildGroups` then produce. One brand: the
 * fold does not branch on it.
 */
describe('an ending child keeps the family it was spawned into', () => {
  type Spawn = {
    pid: number;
    startedAt: number;
    sessionId: string;
    parentSessionId?: string;
    originSessionId?: string;
  };

  function ownedFrom(facts: Spawn): Session {
    const state = live.initial({
      cwd: '/work/app',
      startedAt: facts.startedAt,
      sessionId: facts.sessionId
    });
    return live.toSession(
      state,
      {
        pid: facts.pid,
        startedAt: facts.startedAt,
        updatedAt: facts.startedAt,
        brand: 'claude',
        ...(facts.parentSessionId ? { parentSessionId: facts.parentSessionId } : {}),
        ...(facts.originSessionId ? { originSessionId: facts.originSessionId } : {})
      },
      'win'
    );
  }

  const origin = (): Session => ownedFrom({ pid: 1, startedAt: 1_000, sessionId: 'origin-a' });
  const bee = (): Session =>
    ownedFrom({
      pid: 2,
      startedAt: 2_000,
      sessionId: 'child-b',
      parentSessionId: 'origin-a',
      originSessionId: 'origin-a'
    });
  const cee = (): Session =>
    ownedFrom({
      pid: 3,
      startedAt: 3_000,
      sessionId: 'child-c',
      parentSessionId: 'origin-a',
      originSessionId: 'origin-a'
    });
  const twinB = (): Session =>
    session({
      pid: 2,
      sessionId: 'child-b',
      startedAt: 2_000,
      parentSessionId: 'origin-a',
      originSessionId: 'origin-a'
    });

  const boxed = [{ parent: 1, members: [1, 2, 3] }];

  function families(sessions: Session[]) {
    return buildGroups(sessions, '/work/app')[0]?.families;
  }

  it('keeps C boxed after its twin is gone', () => {
    const board = foldTwins([origin(), bee(), cee()], [twinB()]);
    assert.deepEqual(
      board.map((s) => s.pid),
      [1, 2, 3]
    );
    assert.deepEqual(families(board), boxed);
  });

  it('keeps the retained origin when the twin omits lineage or names another', () => {
    const omitted = session({ pid: 3, sessionId: 'child-c', startedAt: 3_000 });
    const quiet = foldTwins([origin(), bee(), cee()], [twinB(), omitted]);
    assert.equal(quiet.find((s) => s.pid === 3)?.parentSessionId, 'origin-a');
    assert.equal(quiet.find((s) => s.pid === 3)?.originSessionId, 'origin-a');
    assert.deepEqual(families(quiet), boxed);

    const other = session({
      pid: 3,
      sessionId: 'child-c',
      startedAt: 3_000,
      parentSessionId: 'other',
      originSessionId: 'other'
    });
    const disagreed = foldTwins([origin(), bee(), cee()], [twinB(), other]);
    assert.equal(disagreed.find((s) => s.pid === 3)?.originSessionId, 'origin-a');
    assert.deepEqual(families(disagreed), boxed);
  });

  it('boxes a spawned child before any twin exists', () => {
    const board = foldTwins([origin(), bee(), cee()], []);
    assert.deepEqual(
      board.map((s) => s.pid),
      [1, 2, 3]
    );
    assert.deepEqual(families(board), boxed);
  });

  it('stays boxed when an End attempt fails', () => {
    const endings = new EndingSessions();
    endings.retain(cee());
    endings.fail(cee());
    const board = foldTwins([origin(), bee(), ...endings.snapshot()], []);
    const stuck = board.find((s) => s.pid === 3);
    assert.equal(stuck?.endStuck, true);
    assert.equal(stuck?.closing, undefined);
    assert.deepEqual(families(board), boxed);
  });

  it('drops C when it leaves, and a reused pid with no lineage stays loose', () => {
    const replacement = ownedFrom({ pid: 3, startedAt: 9_000, sessionId: 'replacement' });
    const board = foldTwins([origin(), bee(), replacement], []);
    assert.deepEqual(families(board), [{ parent: 1, members: [1, 2] }]);
    assert.equal(board.find((s) => s.pid === 3)?.parentSessionId, undefined);
    assert.equal(board.find((s) => s.pid === 3)?.originSessionId, undefined);
  });

  it('keeps a later generation on the origin after the middle parent is gone', () => {
    const later = ownedFrom({
      pid: 3,
      startedAt: 3_000,
      sessionId: 'child-c',
      parentSessionId: 'middle-m',
      originSessionId: 'origin-a'
    });
    const board = foldTwins([origin(), later], []);
    assert.deepEqual(families(board), [{ parent: 1, members: [1, 3] }]);
  });

  it('lets a published spawn origin beat a twin that omits one or names another', () => {
    const anchor = session({ pid: 1, sessionId: 'origin-a', startedAt: 1_000 });
    const sibling = session({
      pid: 2,
      sessionId: 'child-b',
      startedAt: 2_000,
      parentSessionId: 'origin-a',
      originSessionId: 'origin-a'
    });
    const record = (sessionCard: Session): PublishedLive => ({
      schema: 1,
      session: sessionCard,
      pending: [],
      queued: []
    });
    const omitted = session({ pid: 3, sessionId: 'child-c', startedAt: 3_000, status: 'unknown' });
    const named = session({
      pid: 3,
      sessionId: 'child-c',
      startedAt: 3_000,
      status: 'unknown',
      parentSessionId: 'other',
      originSessionId: 'other'
    });
    const quiet = foldTwins([], [anchor, sibling, omitted], new Map([[3, record(cee())]]));
    const disagreed = foldTwins([], [anchor, sibling, named], new Map([[3, record(cee())]]));
    assert.equal(quiet.find((s) => s.pid === 3)?.originSessionId, 'origin-a');
    assert.equal(disagreed.find((s) => s.pid === 3)?.originSessionId, 'origin-a');
    assert.deepEqual(families(quiet), boxed);
    assert.deepEqual(families(disagreed), boxed);
  });

  it('invents no family when neither the spawn nor the twin states lineage', () => {
    const lone = ownedFrom({ pid: 5, startedAt: 5_000, sessionId: 'solo' });
    assert.equal('parentSessionId' in lone, false);
    assert.equal('originSessionId' in lone, false);
    const twin = session({ pid: 5, sessionId: 'solo', startedAt: 5_000 });
    const board = foldTwins([lone], [twin]);
    assert.equal(board[0]?.parentSessionId, undefined);
    assert.equal(board[0]?.originSessionId, undefined);
    assert.equal(families(board), undefined);
  });
});

/**
 * The board's population, per brand (row 71): owned here, or background.
 *
 * None of this touches `foldTwins`. The fold is the shims' path as well as the
 * panel's (`cli/board.ts`, `host/waits.ts`), so a record still promotes a twin
 * there exactly as before; what changed is that the panel passes no records and
 * filters what the fold hands back.
 */
describe('onBoard: the board is this window\u2019s', () => {
  /** A twin another window drives, as `discover` builds one. */
  const elsewhere = (over: Partial<Session> = {}): Session => session({ pid: 7, ...over });

  it('draws a session this window owns', () => {
    const mine = session({ pid: 1, source: 'owned' });
    assert.deepEqual(onBoard([mine]), [mine]);
  });

  it('draws a background session, which no window owns', () => {
    // Discovered and never owned, and the one card on the board the panel
    // cannot drive. It says so itself — `canControl` is `!background`.
    const bg = elsewhere({ background: true });
    assert.deepEqual(onBoard([bg]), [bg]);
  });

  for (const brand of ['claude', 'grok', 'codex'] as const) {
    it(`drops a ${brand} session another window drives, rather than ghosting it`, () => {
      const twin = elsewhere({ brand });
      assert.deepEqual(onBoard([twin]), []);
    });
  }

  it('drops what a record would have promoted, because no record is passed', () => {
    // The panel's call site hands `foldTwins` an empty map, so the twin never
    // becomes `owned` and the filter drops it. The fold itself is untouched:
    // pass the record and the same twin comes back owned, which is what
    // `squadron-list` still sees.
    const piped = elsewhere({});
    const published: PublishedLive = {
      schema: 1,
      session: session({ pid: 7, source: 'owned', sessionId: 'theirs', windowId: 'window-b' }),
      pending: [],
      queued: []
    };
    assert.deepEqual(onBoard(foldTwins([], [piped], new Map())), []);
    const [promoted] = foldTwins([], [piped], new Map([[7, published]]));
    assert.equal(promoted?.source, 'owned');
  });
});
