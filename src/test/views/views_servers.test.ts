import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionListener } from '../../core/devservers/listeners';
import { RunningServer } from '../../core/model';
import type { ServerContext } from '../../ui/server_views';
import { buildGroups } from '../../ui/views';
import { session } from '../views_helpers';
import { testPlatform } from '../helpers';
import { withFoldedKeys } from '../folded_keys';
import { withWin32Paths } from '../win32_paths';
import { repoOfTree } from '../../ui/server_views';

describe('the servers section', () => {
  it('keeps Windows case-distinct and cross-root packages outside a workspace tree', () =>
    withWin32Paths(() => {
      for (const tree of ['C:\\x\\Foo', '\\\\srv\\a']) {
        const servers = context({
          trees: new Map([[tree, [{ path: tree }]]]),
          workspaces: new Set([tree])
        });
        const child = tree === 'C:\\x\\Foo' ? 'c:/x/Foo/child' : '//srv/a/child';
        assert.equal(repoOfTree(child, servers), tree);
        for (const cwd of [
          'C:\\x\\foo\\child',
          'D:\\x\\Foo\\child',
          '\\\\srv\\b\\child',
          'C:\\x\\Foo\\..\\other',
          'C:\\x\\Foo2\\child'
        ])
          assert.equal(repoOfTree(cwd, servers), undefined, `${tree} refuses ${cwd}`);
      }
    }));

  const runner = { id: 'dev', label: 'npm run dev', command: 'npm run dev -- --port ${port}' };

  const context = (over: Partial<ServerContext> = {}): ServerContext => ({
    running: [],
    trees: new Map([
      [
        '/work/app',
        [
          { path: '/work/app', branch: 'main', main: true },
          { path: '/work/app/.claude/worktrees/wt', branch: 'side' }
        ]
      ]
    ]),
    runners: new Map([
      ['/work/app', [runner]],
      ['/work/app/.claude/worktrees/wt', [runner]]
    ]),
    remembered: new Map([['/work/app', { side: { dev: 3004 } }]]),
    workspaces: new Set<string>(),
    candidates: new Map<string, string[]>(),
    sessionServers: [],
    ...over
  });

  const running = (over: Partial<RunningServer> = {}): RunningServer => ({
    cwd: '/work/app',
    runnerId: 'dev',
    label: 'npm run dev',
    branch: 'main',
    windowId: 'me',
    port: 3000,
    url: 'http://localhost:3000',
    status: 'up',
    startedAt: 0,
    updatedAt: Date.now(),
    ...over
  });

  const rowsOf = (servers: ServerContext) =>
    buildGroups(
      [session({ pid: 1, cwd: '/work/app' })],
      undefined,
      new Map(),
      new Map(),
      servers
    )[0]?.servers ?? [];

  it('gives a branch with nothing running a row with the port it used last', () => {
    const side = rowsOf(context()).find((row) => row.branch === 'side');
    assert.equal(side?.remembered, 3004);
    assert.equal(side?.status, undefined);
    assert.equal(side?.port, undefined);
  });

  it('names the tree on a branch row, and on a server below a workspace tree', () => {
    const rows = rowsOf(
      context({
        running: [running({ cwd: '/work/app/apps/web', branch: 'main' })],
        workspaces: new Set(['/work/app'])
      })
    );
    assert.equal(rows.find((row) => row.branch === 'side')?.tree, '/work/app/.claude/worktrees/wt');
    assert.equal(rows.find((row) => row.cwd === '/work/app/apps/web')?.tree, '/work/app');
  });

  it('joins a running server without losing its repo’s session cards', () => {
    const [group] = buildGroups(
      [
        session({ pid: 1, cwd: '/work/app' }),
        session({
          pid: 2,
          cwd: '/work/app/.claude/worktrees/wt',
          worktree: true,
          repoRoot: '/work/app'
        })
      ],
      undefined,
      new Map(),
      new Map(),
      context({ running: [running()] })
    );
    assert.deepEqual(
      group?.sessions.map((card) => card.pid),
      [1, 2]
    );
    const main = group?.servers?.find((row) => row.branch === 'main');
    assert.equal(main?.status, 'up');
    assert.equal(main?.port, 3000);
    assert.equal(main?.url, 'http://localhost:3000');
  });

  it('puts what is running ahead of what is not, without reordering either', () => {
    // The section is one line and does not fold, so a glance lands on the
    // running end of it. `main` is git's first tree and would otherwise lead.
    const rows = rowsOf(
      context({ running: [running({ cwd: '/work/app/.claude/worktrees/wt', branch: 'side' })] })
    );
    assert.deepEqual(
      rows.map((row) => row.branch),
      ['side', 'main']
    );
  });

  it('carries the reason a start failed', () => {
    const rows = rowsOf(
      context({ running: [running({ status: 'failed', reason: 'port taken', url: undefined })] })
    );
    const main = rows.find((row) => row.branch === 'main');
    assert.equal(main?.status, 'failed');
    assert.equal(main?.reason, 'port taken');
  });

  it('folds a worktree’s row into the repo’s group', () => {
    const groups = buildGroups(
      [session({ pid: 1, cwd: '/work/app' })],
      undefined,
      new Map(),
      new Map(),
      context()
    );
    assert.deepEqual(
      groups.map((g) => g.cwd),
      ['/work/app']
    );
    assert.deepEqual(groups[0]?.servers?.map((row) => row.branch).sort(), ['main', 'side']);
  });

  it('seeds a group for a server whose repo has no cards at all', () => {
    const groups = buildGroups(
      [],
      undefined,
      new Map(),
      new Map(),
      context({ running: [running({ cwd: '/work/app/.claude/worktrees/wt', branch: 'side' })] })
    );
    const rows = groups.find((g) => g.cwd === '/work/app')?.servers ?? [];
    assert.equal(rows.find((row) => row.branch === 'side')?.status, 'up');
  });

  it('gives a nested foreign checkout its own repo, not the monorepo around it', () => {
    // `/mono` declares workspaces and `/mono/vendor/thing` is its own checkout.
    // Matching containment before an exact tree hands the server to whichever
    // repo iterates first, and the one server is then drawn in both groups.
    const servers = context({
      running: [running({ cwd: '/mono/vendor/thing', branch: 'main' })],
      trees: new Map([
        ['/mono', [{ path: '/mono', branch: 'main', main: true }]],
        ['/mono/vendor/thing', [{ path: '/mono/vendor/thing', branch: 'main', main: true }]]
      ]),
      runners: new Map([
        ['/mono', [runner]],
        ['/mono/vendor/thing', [runner]]
      ]),
      workspaces: new Set(['/mono'])
    });
    const groups = buildGroups(
      [session({ pid: 1, cwd: '/mono' }), session({ pid: 2, cwd: '/mono/vendor/thing' })],
      undefined,
      new Map(),
      new Map(),
      servers
    );
    const live = groups.flatMap((g) => g.servers ?? []).filter((r) => r.status === 'up');
    assert.equal(live.length, 1, 'the one server was drawn in more than one group');
    assert.equal(live[0]?.cwd, '/mono/vendor/thing');
    assert.equal(live[0]?.app, undefined, 'a repo of its own was named as an app');
  });

  it('draws a row for a live server whose tree this window cannot see', () => {
    // A worktree created since the last poll. Its repo is unknown here, so the
    // row heads its own group rather than being hidden — it is running, and a
    // row is the only way to stop it.
    const groups = buildGroups(
      [session({ pid: 1, cwd: '/work/app' })],
      undefined,
      new Map(),
      new Map(),
      context({
        running: [running({ cwd: '/work/app/.claude/worktrees/fresh', branch: 'fresh' })],
        trees: new Map([['/work/app', [{ path: '/work/app', branch: 'main', main: true }]]])
      })
    );
    const orphan = groups.find((g) => g.cwd === '/work/app/.claude/worktrees/fresh');
    assert.equal(orphan?.servers?.[0]?.branch, 'fresh');
    assert.equal(orphan?.servers?.[0]?.status, 'up');
  });

  it('gives a group no section when nothing there can be started', () => {
    const groups = buildGroups([session({ pid: 1, cwd: '/work/lib' })], undefined);
    assert.deepEqual(groups[0]?.servers, []);
  });

  it('keeps a tree with nothing to start, and says so', () => {
    // The section lists every branch. One that vanished would read as "no such
    // worktree" rather than "nothing here to start".
    const rows = rowsOf(context({ runners: new Map([['/work/app', [runner]]]) }));
    assert.deepEqual(
      rows.map((row) => row.branch),
      ['main', 'side']
    );
    const side = rows.find((row) => row.branch === 'side');
    assert.equal(side?.unrunnable, true);
    assert.equal(side?.status, undefined);
  });

  it('carries the scripts detection would not choose between, so the row is a button', () => {
    const rows = rowsOf(
      context({
        runners: new Map([['/work/app', [runner]]]),
        candidates: new Map([['/work/app/.claude/worktrees/wt', ['dev', 'start']]])
      })
    );
    const side = rows.find((row) => row.branch === 'side');
    assert.equal(side?.unrunnable, true);
    assert.deepEqual(side?.candidates, ['dev', 'start']);
    // The word slot is the invitation, so the label has to stop saying the
    // opposite — it is what the sheet titles itself with while it loads.
    assert.equal(side?.label, 'pick a script here');
  });

  it('lets the apps win when a workspace root is ambiguous in its own right', () => {
    // A stock `create-next-app` at the root of a monorepo is both. The chip has
    // one word slot, so a row saying `pick an app` must not also carry scripts
    // for the tip to list — the sheet offers both, which is where the press goes.
    const rows = rowsOf(
      context({
        runners: new Map(),
        workspaces: new Set(['/work/app']),
        candidates: new Map([['/work/app', ['dev', 'start']]])
      })
    );
    const main = rows.find((row) => row.branch === 'main');
    assert.equal(main?.workspaces, true);
    assert.equal(main?.candidates, undefined);
    assert.equal(main?.label, 'nothing to start here');
  });

  it('leaves a tree with no scripts at all saying so', () => {
    const rows = rowsOf(context({ runners: new Map([['/work/app', [runner]]]) }));
    const side = rows.find((row) => row.branch === 'side');
    assert.equal(side?.candidates, undefined);
    assert.equal(side?.label, 'nothing to start here');
  });

  describe('a server we did not start', () => {
    const heard = (over: Partial<SessionListener> = {}): SessionListener => ({
      port: 3000,
      pid: 4242,
      startedAt: 1234,
      command: 'node',
      cwd: '/work/app',
      session: 'Fix login',
      ...over
    });

    const devhost = { id: 'devhost', label: 'extension dev host', command: 'code', portless: true };

    it('joins its repo, our record and the listener when each spells the path its own way', () =>
      withFoldedKeys(() => {
        // The host read the repo as git spells it; the session and our record
        // spell it otherwise, and the listener a third way.
        const tree = '/WORK/app';
        const wt = `${tree}/.claude/worktrees/wt`;
        const groups = buildGroups(
          [session({ pid: 1, cwd: '/Work/App' })],
          undefined,
          new Map(),
          new Map(),
          context({
            trees: new Map([
              [
                tree,
                [
                  { path: tree, branch: 'main', main: true },
                  { path: wt, branch: 'side' }
                ]
              ]
            ]),
            runners: new Map([
              [tree, [runner]],
              [wt, [runner]]
            ]),
            remembered: new Map([[tree, { side: { dev: 3004 } }]]),
            running: [running({ cwd: '/WORK/APP' })],
            sessionServers: [heard({ cwd: '/work/APP/.claude/worktrees/WT', port: 3005, pid: 77 })]
          })
        );
        assert.deepEqual(
          groups.map((g) => g.cwd),
          ['/Work/App']
        );
        const rows = groups[0]?.servers ?? [];
        const main = rows.find((row) => row.branch === 'main');
        const side = rows.find((row) => row.branch === 'side');
        assert.equal(rows.length, 2);
        assert.deepEqual([main?.status, main?.port], ['up', 3000]);
        assert.deepEqual([side?.remembered, side?.port, side?.listener?.pid], [3004, 3005, 77]);
      }));

    it('keeps a workspace app’s server in its repo when the app spells the tree otherwise', () =>
      withFoldedKeys(() => {
        // Reached by containment under a declared workspace, never by an exact tree.
        const tree = '/WORK/app';
        const app = '/work/APP/apps/web';
        const groups = buildGroups(
          [session({ pid: 1, cwd: '/Work/App' })],
          undefined,
          new Map(),
          new Map(),
          context({
            trees: new Map([[tree, [{ path: tree, branch: 'main', main: true }]]]),
            runners: new Map([[tree, [runner]]]),
            workspaces: new Set([tree]),
            remembered: new Map(),
            running: [running({ cwd: app, port: 3001, url: undefined })]
          })
        );
        assert.deepEqual(
          groups.map((g) => g.cwd),
          ['/Work/App']
        );
        const served = groups[0]?.servers?.find((row) => row.cwd === app);
        assert.deepEqual([served?.status, served?.port], ['up', 3001]);
      }));

    it('fills its branch’s port slot and says whose it is', () => {
      const main = rowsOf(context({ sessionServers: [heard()] })).find(
        (row) => row.branch === 'main'
      );
      assert.equal(main?.port, 3000);
      assert.deepEqual(main?.listener, {
        command: 'node',
        pid: 4242,
        startedAt: 1234,
        session: 'Fix login'
      });
    });

    it('takes the tree of a session started in a plain repo’s subdirectory', () => {
      // No workspace declared, so `repoOfTree` alone refuses this directory, and
      // the session's server would vanish beside the session's own card.
      const main = rowsOf(context({ sessionServers: [heard({ cwd: '/work/app/src/web' })] })).find(
        (row) => row.branch === 'main'
      );
      assert.equal(main?.listener?.pid, 4242);
      assert.equal(main?.port, 3000);
    });

    it('makes no claim about health, having never probed it, and can be opened', () => {
      const main = rowsOf(context({ sessionServers: [heard()] })).find(
        (row) => row.branch === 'main'
      );
      assert.equal(main?.status, undefined);
      assert.equal(main?.url, 'http://localhost:3000');
    });

    it('sorts with what is happening, not with the idle branches', () => {
      // `main` is git's first tree and leads the section by default. A listener
      // on `side` has to overtake it: something is serving there, and the line
      // is read for what is happening. Counting `status` alone left it below.
      const rows = rowsOf(
        context({ sessionServers: [heard({ cwd: '/work/app/.claude/worktrees/wt' })] })
      );
      assert.deepEqual(
        rows.map((row) => row.branch),
        ['side', 'main']
      );
    });

    it('yields to our own record on that port rather than doubling it', () => {
      const rows = rowsOf(context({ running: [running()], sessionServers: [heard()] }));
      const main = rows.filter((row) => row.branch === 'main');
      assert.equal(main.length, 1);
      assert.equal(main[0]?.status, 'up');
      assert.equal(main[0]?.listener, undefined);
    });

    it('draws nothing for a listener under no tree we hold, and seeds no group', () => {
      const groups = buildGroups(
        [session({ pid: 1, cwd: '/work/app' })],
        undefined,
        new Map(),
        new Map(),
        context({ sessionServers: [heard({ cwd: '/elsewhere/thing' })] })
      );
      assert.equal(groups.length, 1);
      assert.ok(groups[0]?.servers?.every((row) => row.listener === undefined));
    });

    it('ignores a port in the ephemeral range', () => {
      const main = rowsOf(context({ sessionServers: [heard({ port: 49270 })] })).find(
        (row) => row.branch === 'main'
      );
      assert.equal(main?.port, undefined);
      assert.equal(main?.listener, undefined);
    });

    it('keeps one port per process — the inspector is not a second server', () => {
      // Measured: `workerd` serves on 8787 and binds 9229 for its V8 inspector,
      // one pid, one cwd. Every `wrangler dev` and every `node --inspect`.
      const rows = rowsOf(
        context({ sessionServers: [heard({ port: 8787 }), heard({ port: 9229 })] })
      ).filter((row) => row.listener !== undefined);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.port, 8787);
    });

    it('merges into a runner that takes a port, never into the dev host', () => {
      // `resolveRunners` appends the dev host rather than competing with it, so
      // any repo that is an extension has two rows sharing one cwd.
      //
      // **The dev host is first here on purpose, which is the opposite of
      // production order — do not "fix" it.** Appended last, a plain `find` on
      // the cwd lands on `dev` anyway and the assertion passes whether or not
      // anything skips a portless row. Putting it first is what makes this test
      // able to fail.
      const rows = rowsOf(
        context({
          runners: new Map([['/work/app', [devhost, runner]]]),
          sessionServers: [heard()]
        })
      );
      const carrying = rows.filter((row) => row.listener !== undefined);
      assert.equal(carrying.length, 1);
      assert.equal(carrying[0]?.runnerId, 'dev');
    });

    it('pushes a chip when every runner there is portless', () => {
      // An extension-only repo offers nothing that takes a port. Dropping would
      // hide a session's server in exactly the repo we cannot start one in.
      const rows = rowsOf(
        context({ runners: new Map([['/work/app', [devhost]]]), sessionServers: [heard()] })
      );
      const carrying = rows.filter((row) => row.listener !== undefined);
      assert.equal(carrying.length, 1);
      assert.equal(carrying[0]?.port, 3000);
      assert.equal(carrying[0]?.runnerId, '');
    });

    it('leaves a monorepo root its way into the sheet', () => {
      // The root resolves to no runner but declares workspaces, so its row is
      // the `pick an app` button — the repo's only door. A listener landing on
      // it must fill the port and nothing else.
      const rows = rowsOf(
        context({
          runners: new Map([['/work/app/.claude/worktrees/wt', [runner]]]),
          workspaces: new Set(['/work/app']),
          sessionServers: [heard()]
        })
      );
      const root = rows.find((row) => row.cwd === '/work/app');
      assert.equal(root?.port, 3000);
      assert.equal(root?.unrunnable, true);
      assert.equal(root?.workspaces, true);
    });

    it('never merges onto a row that already has a server of ours', () => {
      // `status` is the rule the wire states, and both the ✕ and the stop key
      // hang off it. A row carrying one must never also carry a listener.
      const rows = rowsOf(
        context({
          running: [running({ status: 'starting', port: undefined, url: undefined })],
          sessionServers: [heard()]
        })
      );
      const main = rows.find((row) => row.branch === 'main');
      assert.equal(main?.status, 'starting');
      assert.equal(main?.listener, undefined);
      assert.equal(main?.port, undefined);
    });

    it(
      'names a package chip after the branch it is inside, not its folder',
      {
        todo: testPlatform() === 'win32' && 'win32: the app label takes the native separator — W5.6'
      },
      () => {
        // Two worktrees each serving `apps/web` would otherwise draw two chips
        // both reading `web`, which names neither of them.
        const rows = rowsOf(
          context({
            workspaces: new Set(['/work/app/.claude/worktrees/wt']),
            sessionServers: [heard({ cwd: '/work/app/.claude/worktrees/wt/apps/web' })]
          })
        );
        const chip = rows.find((row) => row.listener !== undefined);
        assert.equal(chip?.branch, 'side');
        assert.equal(chip?.app, 'apps/web');
      }
    );

    it(
      'gives a package of a workspace tree its own chip, naming the app',
      {
        todo: testPlatform() === 'win32' && 'win32: the app label takes the native separator — W5.6'
      },
      () => {
        const rows = rowsOf(
          context({
            workspaces: new Set(['/work/app']),
            sessionServers: [heard({ cwd: '/work/app/apps/web' })]
          })
        );
        const chip = rows.find((row) => row.listener !== undefined);
        assert.equal(chip?.app, 'apps/web');
        assert.equal(chip?.cwd, '/work/app/apps/web');
        // No runner behind a listener, and `srvKey` stands the port in for the
        // empty id so two such rows do not fold into one node under the morph.
        assert.equal(chip?.runnerId, '');
        assert.equal(chip?.label, 'node');
      }
    );
  });
});
