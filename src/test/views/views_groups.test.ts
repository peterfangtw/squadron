import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Arrangement, ArrangeSlot } from '../../core/arrange';
import { Session } from '../../core/model';
import * as platform from '../../core/platform';
import type { PathKey } from '../../core/platform/paths';
import { buildGroups, buildLineage, groupKey, toThread } from '../../ui/views';
import { session } from '../views_helpers';
import { withFoldedKeys } from '../folded_keys';

describe('groupKey', () => {
  // One function, two callers (`buildGroups` and `serverContext`). Written
  // twice, a tree lands under a key no group holds — a live server with no
  // row and no way to stop.
  for (const { name, session, want } of [
    {
      name: 'an ordinary session groups where it began',
      session: { cwd: '/work/app' },
      want: '/work/app'
    },
    {
      name: 'a worktree folds into the repo it was cut from',
      session: {
        cwd: '/work/app/.claude/worktrees/wt',
        worktree: true,
        repoRoot: '/work/app'
      },
      want: '/work/app'
    },
    {
      name: 'a worktree kept outside its repo still folds by what git says',
      session: { cwd: '/elsewhere/wt2', worktree: true, repoRoot: '/work/app' },
      want: '/work/app'
    },
    {
      name: 'repoRoot without worktree is not a fold — a package stays put',
      session: { cwd: '/work/app/packages/api', repoRoot: '/work/app' },
      want: '/work/app/packages/api'
    },
    {
      name: 'a worktree flag with no repoRoot cannot fold',
      session: { cwd: '/work/app/.claude/worktrees/wt', worktree: true },
      want: '/work/app/.claude/worktrees/wt'
    }
  ] as const) {
    it(name, () => {
      assert.equal(groupKey(session), want);
    });
  }
});

describe('buildGroups', () => {
  it('supplies native ordinary leaf and parent labels while retaining raw cwd and root outputs', () => {
    for (const [cwd, label, app] of [
      ['C:\\work\\App', 'App', 'C:\\work'],
      ['c:/work\\App', 'App', 'c:/work'],
      ['\\\\srv\\share\\App', 'App', '\\\\srv\\share'],
      ['/work/literal\\name', 'literal\\name', '/work'],
      ['/', '', ''],
      ['C:/', '', 'C:'],
      ['C:\\', 'C:\\', ''],
      ['\\\\srv\\share', '\\\\srv\\share', ''],
      ['\\\\srv\\share\\', '\\\\srv\\share\\', ''],
      ['//srv/share', 'share', '//srv'],
      ['//srv/share/', '', '//srv/share'],
      ['C:', 'C:', ''],
      ['relative\\name', 'relative\\name', ''],
      ['\\\\?\\C:\\work\\App', '\\\\?\\C:\\work\\App', '']
    ]) {
      assert.ok(cwd !== undefined);
      const [group] = buildGroups([], cwd);
      assert.deepEqual([group?.label, group?.app, group?.cwd], [label, app, cwd]);
    }
  });
  it('groups sessions by cwd, verbatim', () => {
    const groups = buildGroups(
      [
        session({ pid: 1, cwd: '/work/app' }),
        session({ pid: 2, cwd: '/work/app' }),
        session({ pid: 3, cwd: '/work/lib' })
      ],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.length]),
      [
        ['/work/app', 2],
        ['/work/lib', 1]
      ]
    );
  });

  // The one grouping outcome this split flips, and it flips it right: a session
  // started in a monorepo *package* that steps into a worktree. The live flag
  // used to turn true and fold its card under the repo heading; the package is
  // where the work is, and only a worktree folds (see the fold above). Entering
  // one changes what it is standing on, never which piece of work it is.
  it('leaves a package’s session in its own group when it enters a worktree', () => {
    const groups = buildGroups(
      [
        session({
          pid: 1,
          cwd: '/work/app/apps/web',
          repoRoot: '/work/app',
          branch: 'side',
          liveWorktree: true
        })
      ],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid)]),
      [['/work/app/apps/web', [1]]]
    );
  });

  // The move that used to cost a heading: a session that *began* in a worktree
  // and has since stepped into the main checkout. Its branch is read where it
  // stands, but the pair that folds the card — `worktree` with `repoRoot` —
  // still describes where it began, so the card stays under the repo instead of
  // heading a group named after the tree.
  it('folds a worktree’s session that has since stepped out of it', () => {
    const groups = buildGroups(
      [
        session({
          pid: 1,
          cwd: '/work/app/.claude/worktrees/wt',
          repoRoot: '/work/app',
          worktree: true,
          branch: 'main',
          liveWorktree: false
        })
      ],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid)]),
      [['/work/app', [1]]]
    );
  });

  it('folds a worktree’s sessions into the repo they were cut from', () => {
    const groups = buildGroups(
      [
        session({ pid: 1, cwd: '/work/app', repoRoot: '/work/app', branch: 'main' }),
        session({
          pid: 2,
          cwd: '/work/app/.claude/worktrees/wt',
          repoRoot: '/work/app',
          branch: 'side',
          worktree: true
        }),
        // A worktree kept outside its repo folds by the same rule: the fold is
        // by what git says, never by one path containing another.
        session({
          pid: 3,
          cwd: '/elsewhere/wt2',
          repoRoot: '/work/app',
          branch: 'other',
          worktree: true
        })
      ],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid)]),
      [['/work/app', [1, 2, 3]]]
    );
  });

  it('keeps a monorepo’s siblings apart, repo root or not', () => {
    // Only a worktree folds. Two apps in one repository are still two pieces of
    // work, and had two headings before any of this — sharing a `repoRoot` is
    // not a reason to collapse them.
    const groups = buildGroups(
      [
        session({ pid: 1, cwd: '/work/app/packages/api', repoRoot: '/work/app', branch: 'main' }),
        session({ pid: 2, cwd: '/work/app/packages/web', repoRoot: '/work/app', branch: 'main' })
      ],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => g.cwd),
      ['/work/app/packages/api', '/work/app/packages/web']
    );
  });

  it('keeps a session outside any repository in a group of its own', () => {
    const groups = buildGroups(
      [session({ pid: 1, cwd: '/tmp/scratch' }), session({ pid: 2, cwd: '/work/app' })],
      undefined
    );
    assert.deepEqual(
      groups.map((g) => g.cwd),
      ['/tmp/scratch', '/work/app']
    );
  });

  it('does not seed a group for a worktree opened as its own window', () => {
    // The window's folder is a worktree, so its heading is the repo's — one
    // heading per repo, whether or not a session is running in the tree yet.
    const groups = buildGroups(
      [],
      '/work/app',
      new Map([['/work/app/.claude/worktrees/wt', '/work/app']])
    );
    assert.deepEqual(
      groups.map((g) => g.cwd),
      ['/work/app']
    );
  });

  it('always includes the workspace folder, sessions or not', () => {
    const groups = buildGroups([], '/work/fresh');
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.length]),
      [['/work/fresh', 0]]
    );
  });

  it('does not seed a group for a window with no folder open', () => {
    const groups = buildGroups([], undefined);
    assert.deepEqual(groups, []);
  });

  it('splits the heading into label and app at the last slash', () => {
    const [g] = buildGroups([session({ cwd: '/work/app' })], undefined);
    assert.equal(g?.label, 'app');
    assert.equal(g?.app, '/work');
  });

  it('sorts the workspace folder first, then by path', () => {
    const groups = buildGroups(
      [
        session({ pid: 3, cwd: '/zzz/last' }),
        session({ pid: 1, cwd: '/aaa/elsewhere' }),
        session({ pid: 4, cwd: '/bbb/middle' }),
        session({ pid: 2, cwd: '/work/mine' })
      ],
      '/work/mine'
    );
    // Ours first despite sorting after alphabetically, and seeding the
    // workspace folder does not empty the group its sessions land in.
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.length]),
      [
        ['/work/mine', 1],
        ['/aaa/elsewhere', 1],
        ['/bbb/middle', 1],
        ['/zzz/last', 1]
      ]
    );
  });

  it('makes a second section for a session whose cwd is elsewhere', () => {
    // What a `--cwd` fan-out looks like from the board that started it: the
    // child is this window's card, under a heading named for where it runs.
    // No window is attributed to either section — a section is a directory.
    const groups = buildGroups(
      [session({ pid: 1, cwd: '/work/mine' }), session({ pid: 2, cwd: '/work/web' })],
      '/work/mine'
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid)]),
      [
        ['/work/mine', [1]],
        ['/work/web', [2]]
      ]
    );
  });
});

/**
 * A session with an id of its own and a start time, since lineage is resolved
 * by `sessionId` and ordered by `startedAt`. The pid doubles as the start, so a
 * higher pid is a later session unless a test says otherwise.
 */
const spawned = (pid: number, over: Partial<Session> = {}): Session =>
  session({ pid, sessionId: `s${pid}`, startedAt: pid, ...over });

describe('buildLineage', () => {
  it('resolves a running parent, and inverts it into children', () => {
    const lineage = buildLineage([spawned(1), spawned(2, { parentSessionId: 's1' })]);
    assert.equal(lineage.get(2)?.parent, 1);
    assert.deepEqual(lineage.get(1)?.children, [2]);
  });

  // Closed, `/clear`ed into a new id, swept, or never recorded: one absence,
  // and the panel is not allowed to tell them apart or to call any of them
  // "root".
  it('attaches nothing when no live session holds the recorded id', () => {
    const lineage = buildLineage([spawned(2, { parentSessionId: 'gone' })]);
    assert.equal(lineage.get(2), undefined);
  });

  it('attaches nothing to a session that carries no record at all', () => {
    assert.equal(buildLineage([spawned(1), spawned(2)]).size, 0);
  });

  it('collects a parent’s children in the order they started', () => {
    const lineage = buildLineage([
      spawned(1),
      spawned(3, { parentSessionId: 's1', startedAt: 30 }),
      spawned(2, { parentSessionId: 's1', startedAt: 20 })
    ]);
    assert.deepEqual(lineage.get(1)?.children, [2, 3]);
  });

  it('resolves one fan-out for a whole stamped chain', () => {
    const lineage = buildLineage([
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1' })
    ]);
    assert.deepEqual(
      [2, 3, 4].map((pid) => lineage.get(pid)?.originId),
      ['s1', 's1', 's1']
    );
  });

  it('keeps the fan-out when the generation in the middle has gone', () => {
    // The case the stamp exists for: gen3's parent is not on the board at all,
    // so there is no waypoint back to gen1 to walk.
    const lineage = buildLineage([
      spawned(1),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1' })
    ]);
    assert.equal(lineage.get(3)?.parent, undefined);
    assert.equal(lineage.get(3)?.originId, 's1');
    assert.equal(lineage.get(4)?.originId, 's1');
  });

  // The stamp is the fan-out, so it outlives the session it names: nothing here
  // asks whether that session is still running, and gen1 closing is the case
  // that used to drop the whole family.
  it('keeps the fan-out when the origin itself has closed', () => {
    const lineage = buildLineage([
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1' })
    ]);
    assert.equal(lineage.get(3)?.originId, 's1');
    assert.equal(lineage.get(4)?.originId, 's1');
  });

  it('has no fan-out for a session that carries no stamp', () => {
    const lineage = buildLineage([spawned(1), spawned(2, { parentSessionId: 's1' })]);
    assert.equal(lineage.get(2)?.originId, undefined);
    assert.equal(lineage.get(2)?.parent, 1);
  });

  it('has no record at all for a session with neither a stamp nor a live parent', () => {
    assert.equal(buildLineage([spawned(2, { parentSessionId: 'gone' })]).get(2), undefined);
  });

  // A session file whose id would not parse is kept on the board with `''`, and
  // it must not thereby be everybody's parent and everybody's fan-out.
  it('joins nothing to a session whose id would not parse', () => {
    const lineage = buildLineage([
      spawned(1, { sessionId: '' }),
      spawned(2, { parentSessionId: '', originSessionId: '' }),
      spawned(3, { parentSessionId: '', originSessionId: '' })
    ]);
    assert.equal(lineage.size, 0);
  });

  // Nothing on disk stops two sessions naming each other. The walk that could
  // have spun on it is gone, so this states the remaining shape: the edges are
  // recorded as written, and nothing here traverses them.
  it('records a cycle without traversing it', () => {
    const lineage = buildLineage([
      spawned(1, { parentSessionId: 's2' }),
      spawned(2, { parentSessionId: 's1' })
    ]);
    assert.equal(lineage.get(1)?.parent, 2);
    assert.equal(lineage.get(2)?.parent, 1);
    assert.equal(lineage.get(1)?.originId, undefined);
    assert.equal(lineage.get(2)?.originId, undefined);
  });
});

describe('lineage on the groups', () => {
  const groups = (sessions: Session[]) => buildGroups(sessions, undefined);
  const card = (built: GroupView[], pid: number) =>
    built.flatMap((g) => g.sessions).find((s) => s.pid === pid);

  it('carries the relation onto the cards as pids', () => {
    const built = groups([spawned(1), spawned(2, { parentSessionId: 's1' })]);
    assert.equal(card(built, 2)?.parent, 1);
    assert.deepEqual(card(built, 1)?.children, [2]);
    // A parent has no parent of its own, and a childless child no children —
    // both absent rather than empty, so no surface can render a zero.
    assert.equal(card(built, 1)?.parent, undefined);
    assert.equal(card(built, 2)?.children, undefined);
  });

  it('counts a child in another group toward its parent’s children', () => {
    const built = groups([
      spawned(1, { cwd: '/work/app' }),
      spawned(2, { cwd: '/work/lib', parentSessionId: 's1', originSessionId: 's1' })
    ]);
    assert.deepEqual(card(built, 1)?.children, [2]);
    // And the family follows the child, naming a parent whose card is elsewhere.
    assert.deepEqual(
      built.map((g) => [g.cwd, g.families]),
      [
        ['/work/app', undefined],
        ['/work/lib', [{ parent: 1, members: [2] }]]
      ]
    );
  });

  it('heads a family with the parent’s own card when it is in the group', () => {
    const built = groups([
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's1', originSessionId: 's1' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 2, 3] }]);
    // Layout, not membership: every card is still in the flat list the nav
    // tally, the status filter and the alert bar read.
    assert.deepEqual(
      built[0]?.sessions.map((s) => s.pid),
      [1, 2, 3]
    );
  });

  // A chain is one flat box, never a nested one and never three overlapping
  // ones: four generations are one piece of work, and the box is what says so.
  it('lays a whole chain out as one family, drawing no card twice', () => {
    const built = groups([
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 2, 3, 4] }]);
    const drawn = built[0]?.families?.flatMap((f) => f.members) ?? [];
    assert.deepEqual([...new Set(drawn)], drawn, 'a pid appears in two families');
  });

  it('holds the box together when the middle generation is dismissed', () => {
    const built = groups([
      spawned(1),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 3, 4] }]);
  });

  // The case the whole row is about: the box is the stamp, so the session that
  // started the fan-out closing costs it nothing but its head.
  it('holds the box together when the origin itself has gone', () => {
    const built = groups([
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' })
    ]);
    // Headed by the eldest survivor, because a closed session has no card to
    // name the box with and no name left on disk to borrow.
    assert.deepEqual(built[0]?.families, [{ parent: 2, members: [2, 3] }]);
  });

  it('holds the box together when the origin and the middle have both gone', () => {
    const built = groups([
      spawned(2, { parentSessionId: 's1', originSessionId: 's1', startedAt: 20 }),
      spawned(4, { parentSessionId: 's3', originSessionId: 's1', startedAt: 40 })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 2, members: [2, 4] }]);
  });

  // A box of one says nothing a card does not already say, and its heading
  // would name the only card inside it.
  it('draws no box for the last survivor of a fan-out', () => {
    const built = groups([spawned(2, { parentSessionId: 's1', originSessionId: 's1' })]);
    assert.equal(built[0]?.families, undefined);
    assert.deepEqual(
      built[0]?.sessions.map((s) => s.pid),
      [2]
    );
  });

  // The same shape with the origin still running is not the same thing: the
  // heading names a session in another group, which the card cannot say itself.
  it('keeps a box of one whose head is in another group', () => {
    const built = groups([
      spawned(1, { cwd: '/work/app' }),
      spawned(2, { cwd: '/work/lib', parentSessionId: 's1', originSessionId: 's1' })
    ]);
    assert.deepEqual(
      built.map((g) => [g.cwd, g.families]),
      [
        ['/work/app', undefined],
        ['/work/lib', [{ parent: 1, members: [2] }]]
      ]
    );
  });

  // An unstamped child is one an older build spawned. It stands alone rather
  // than being walked back into a family, which is what deleting the walk buys.
  it('leaves an unstamped child loose, drawing no card twice', () => {
    const built = groups([
      spawned(1),
      spawned(3, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(4, { parentSessionId: 's3' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 3] }]);
    const drawn = built[0]?.families?.flatMap((f) => f.members) ?? [];
    assert.deepEqual([...new Set(drawn)], drawn, 'a pid appears in two families');
    // Still on the board, still counted — a family is layout, never membership.
    assert.deepEqual(
      built[0]?.sessions.map((s) => s.pid),
      [1, 3, 4]
    );
  });

  // `squadron-spawn --parent-session-id <member>` opens a fan-out at that member on
  // purpose (`cli/spawn.ts:98`), so a stamp is not always a root: gen2 is a
  // member of gen1's box by its own stamp and the key of gen3's bucket. Heading
  // both would draw its card twice, which is why a session that carries a stamp
  // heads nothing.
  it('draws no card twice when a fan-out is opened at a member', () => {
    const built = groups([
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's2' })
    ]);
    assert.deepEqual(built[0]?.families, [
      { parent: 1, members: [1, 2] },
      { parent: 2, members: [3] }
    ]);
    const drawn = built[0]?.families?.flatMap((f) => f.members) ?? [];
    assert.deepEqual([...new Set(drawn)], drawn, 'a pid appears in two families');
  });

  // Both rules firing at once: gen2 carries a stamp so it heads nothing on its
  // own account, and the box that stamp named is a survivor of one and was
  // filtered away — leaving gen2 a loose card and the slot id of gen3's box.
  it('adopts a head that ended up in no box of its own', () => {
    const built = groups([
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's2' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 2, members: [2, 3] }]);
    // The slot list is what the collision would have cost: one entry per box or
    // loose card, and every card on the board named exactly once.
    const drawn = built[0]?.families?.flatMap((f) => f.members) ?? [];
    assert.deepEqual(drawn, [2, 3]);
  });

  // Two live sessions can claim one id (`claude --resume`), and the box belongs
  // to the elder — the one the stamp was written against.
  it('heads a box with the elder of two sessions claiming one id', () => {
    const built = groups([
      spawned(9, { sessionId: 'twin', startedAt: 50 }),
      spawned(1, { sessionId: 'twin', startedAt: 10 }),
      spawned(3, { parentSessionId: 'twin', originSessionId: 'twin', startedAt: 60 })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 3] }]);
  });

  // The ordinary case, and the one the stamp is transitive for: a member that
  // spawns without naming a parent hands its children the root's id.
  it('draws no card twice when a member has spawned children of its own', () => {
    const built = groups([
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3, { parentSessionId: 's2', originSessionId: 's1' })
    ]);
    assert.deepEqual(built[0]?.families, [{ parent: 1, members: [1, 2, 3] }]);
    const drawn = built[0]?.families?.flatMap((f) => f.members) ?? [];
    assert.deepEqual([...new Set(drawn)], drawn, 'a pid appears in two families');
  });

  it('orders the families by their earliest member', () => {
    const built = groups([
      spawned(1, { startedAt: 10 }),
      spawned(2, { startedAt: 40, parentSessionId: 's1', originSessionId: 's1' }),
      spawned(4, { startedAt: 5 }),
      spawned(3, { startedAt: 50, parentSessionId: 's4', originSessionId: 's4' })
    ]);
    assert.deepEqual(
      built[0]?.families?.map((f) => f.parent),
      [4, 1]
    );
  });

  it('leaves a board that has never spawned anything exactly as it was', () => {
    const built = groups([spawned(1), spawned(2)]);
    assert.equal(built[0]?.families, undefined);
    assert.deepEqual(
      built[0]?.sessions.map((s) => s.pid),
      [1, 2]
    );
  });

  // The dock's half of the same fold, and the seam nothing else covers: the
  // thread is built from one session, so its lineage can only arrive as an
  // input. Drop it there and every surface above still compiles, still passes,
  // and shows an empty block.
  it('carries the fold through to the thread the dock renders', () => {
    const lineage = buildLineage([spawned(1), spawned(2, { parentSessionId: 's1' })]);
    const child = toThread(spawned(2, { parentSessionId: 's1' }), {
      reachable: true,
      exchanges: [],
      lineage: lineage.get(2)
    });
    assert.equal(child.parent, 1);
    assert.equal(child.children, undefined);

    const parent = toThread(spawned(1), {
      reachable: true,
      exchanges: [],
      lineage: lineage.get(1)
    });
    assert.deepEqual(parent.children, [2]);
    assert.equal(parent.parent, undefined);
  });

  it('leaves a thread built without the fold carrying no lineage', () => {
    const view = toThread(spawned(2, { parentSessionId: 's1' }), {
      reachable: true,
      exchanges: []
    });
    assert.equal(view.parent, undefined);
    assert.equal(view.children, undefined);
  });
});

describe('the arrangement on the groups', () => {
  const CWD = '/work/app';
  const stored = (slots: ArrangeSlot[], cwd = CWD): Map<PathKey, Arrangement> =>
    new Map([[platform.paths.key(cwd), { schema: 1, cwd, updatedAt: 0, slots }]]);
  const built = (sessions: Session[], arrangements?: Map<PathKey, Arrangement>) =>
    buildGroups(sessions, undefined, new Map(), arrangements);

  it('says nothing about a group nobody has arranged', () => {
    const groups = built([spawned(1), spawned(2)]);
    assert.equal(groups[0]?.slots, undefined);
    assert.deepEqual(
      groups[0]?.sessions.map((s) => s.pid),
      [1, 2]
    );
  });

  it('places the stored order, newest sessions after it', () => {
    // 3 started after the drag, so it is in no stored slot and appends —
    // exactly where its add-card was.
    const groups = built(
      [spawned(1), spawned(2), spawned(3)],
      stored([
        { pid: 2, startedAt: 2 },
        { pid: 1, startedAt: 1 }
      ])
    );
    assert.deepEqual(groups[0]?.slots, [2, 1, 3]);
  });

  it('places nothing for a slot whose session is gone', () => {
    const groups = built(
      [spawned(1)],
      stored([
        { pid: 9, startedAt: 9 },
        { pid: 1, startedAt: 1 }
      ])
    );
    assert.deepEqual(groups[0]?.slots, [1]);
  });

  // The recycled-pid guard, at the tolerance `promote` already uses: two clocks
  // and two writers miss by a third of a second, a pid the kernel handed to
  // something else misses by minutes.
  it('refuses a pid whose session started too far from the stored one', () => {
    const far = built(
      [spawned(1, { startedAt: 7000 }), spawned(2)],
      stored([{ pid: 1, startedAt: 1000 }])
    );
    assert.deepEqual(far[0]?.slots, [2, 1], 'a 6s miss placed a card');

    const near = built(
      [spawned(1, { startedAt: 5000 }), spawned(2)],
      stored([{ pid: 1, startedAt: 1000 }])
    );
    assert.deepEqual(near[0]?.slots, [1, 2], 'a 4s miss refused one');
  });

  it('holds a family as one slot, named by the parent it is headed by', () => {
    const groups = built(
      [spawned(1), spawned(2, { parentSessionId: 's1', originSessionId: 's1' }), spawned(3)],
      stored([
        { pid: 3, startedAt: 3 },
        { pid: 1, startedAt: 1 }
      ])
    );
    // 2 is inside the box and is not a slot of its own — the box is the unit
    // that moves.
    assert.deepEqual(groups[0]?.slots, [3, 1]);
  });

  // A box outlives its origin and re-heads at the eldest survivor, so its slot
  // id changes. The arrangement then names a slot nothing produces any more: the
  // box falls into the tail and every other stored slot holds its place.
  it('keeps the stored order when a box re-heads itself', () => {
    const groups = built(
      [
        spawned(2, { startedAt: 2, parentSessionId: 's1', originSessionId: 's1' }),
        spawned(3, { startedAt: 3, parentSessionId: 's2', originSessionId: 's1' }),
        spawned(4, { startedAt: 4 })
      ],
      // Arranged while gen1 still headed the box, so the box's slot is pid 1.
      stored([
        { pid: 1, startedAt: 1 },
        { pid: 4, startedAt: 4 }
      ])
    );
    assert.deepEqual(groups[0]?.slots, [4, 2]);
  });

  it('places a duplicated pid once, whatever a hand-edited file says', () => {
    const groups = built(
      [spawned(1), spawned(2)],
      stored([
        { pid: 2, startedAt: 2 },
        { pid: 2, startedAt: 2 },
        { pid: 1, startedAt: 1 }
      ])
    );
    assert.deepEqual(groups[0]?.slots, [2, 1]);
  });

  // The tally contract: an arrangement is layout, exactly as a family is, and
  // the nav count, the status filter and the alert bar all read the flat list.
  it('changes no card, only their order', () => {
    const sessions = [
      spawned(1),
      spawned(2, { parentSessionId: 's1', originSessionId: 's1' }),
      spawned(3)
    ];
    const plain = built(sessions);
    const arranged = built(sessions, stored([{ pid: 3, startedAt: 3 }]));
    assert.deepEqual(
      arranged.flatMap((g) => g.sessions),
      plain.flatMap((g) => g.sessions)
    );
    assert.deepEqual(arranged[0]?.families, plain[0]?.families);
  });

  it('leaves a group with no arrangement of its own on the derived order', () => {
    const groups = built(
      [spawned(1, { cwd: '/work/app' }), spawned(2, { cwd: '/work/lib' })],
      stored([{ pid: 1, startedAt: 1 }])
    );
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.slots]),
      [
        ['/work/app', [1]],
        ['/work/lib', undefined]
      ]
    );
  });
});

describe('one directory spelled two ways', () => {
  it('is one group, headed by the first spelling, with its arrangement and its place', () =>
    withFoldedKeys(() => {
      const arranged = new Map<PathKey, Arrangement>([
        [
          platform.paths.key('/work/app'),
          {
            schema: 1,
            cwd: '/work/app',
            updatedAt: 0,
            slots: [
              { pid: 2, startedAt: 2 },
              { pid: 1, startedAt: 1 }
            ]
          }
        ]
      ]);
      const groups = buildGroups(
        [
          spawned(1, { cwd: '/Work/App' }),
          spawned(3, { cwd: '/aaa' }),
          spawned(2, { cwd: '/work/app' })
        ],
        '/WORK/APP',
        new Map(),
        arranged
      );
      assert.deepEqual(
        groups.map((g) => [g.cwd, g.sessions.map((s) => s.pid), g.slots]),
        [
          ['/WORK/APP', [1, 2], [2, 1]],
          ['/aaa', [3], undefined]
        ]
      );
    }));
});
