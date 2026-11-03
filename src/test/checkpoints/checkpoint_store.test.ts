import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, describe, it } from 'node:test';
import { linkDir, tempHome, testPlatform } from '../helpers';

/**
 * The cross-session half of `core/checkpoint.ts`: one file per live working
 * tree, holding what each turn on it changed, so a neighbour's contested paths
 * can be subtracted from a turn's pills.
 *
 * Split from `checkpoint.test.ts` because this half reads `STATE_DIR`, which
 * `core/paths.ts` resolves off `os.homedir()` at import — so `HOME` has to move
 * before the module is required, and that means a dynamic import. The other
 * half runs git against temp repos and needs no home at all.
 */

type Checkpoint = typeof import('../../core/checkpoint');

let home: string;
let checkpoint: Checkpoint;

before(async () => {
  home = await tempHome();
  checkpoint = await import('../../core/checkpoint');
});

describe('the per-tree store', () => {
  it(
    'reads one physical journal through either drive-case alias',
    {
      skip: testPlatform() !== 'win32' && 'posix: drive-case aliases require native Win32 paths'
    },
    async () => {
      const { executionRepo } = await import('../execution_helpers');
      const { readTree } = await import('../../core/git');
      const { cwd, runtime } = await executionRepo('journal-drive-alias', 'claude');
      const lower = cwd[0]!.toLowerCase() + cwd.slice(1);
      const upper = cwd[0]!.toUpperCase() + cwd.slice(1);
      const tree = await readTree(lower);
      assert.ok(tree);
      const request = {
        cwd: lower,
        owner: 'alias-owner',
        runtime: runtime.runtime,
        actor: 'root',
        call: 'call'
      };
      const before = await checkpoint.captureExecution(
        { ...request, edge: 'before' },
        runtime.contextFile
      );
      const after = await checkpoint.captureExecution(
        { ...request, edge: 'after' },
        runtime.contextFile
      );
      assert.ok(before && after);
      const legacy = { sid: 'legacy', start: 1, end: 2, paths: [] };
      await checkpoint.appendWindow(upper, legacy);
      const distinct = path.join(home, 'distinct-journal-source');
      const other = { ...legacy, sid: 'distinct' };
      await checkpoint.appendWindow(distinct, other);
      for (const spelling of [lower, upper]) {
        const store = await checkpoint.readExecution(spelling, [lower, upper]);
        assert.equal(store.edges.length, 2);
        assert.strictEqual(await checkpoint.readExecution(spelling, [lower, upper]), store);
        const selected = await checkpoint.selectExecution(
          {
            owner: request.owner,
            runtime: request.runtime,
            turn: 'turn',
            tree: tree.treeRoot,
            start: before.start,
            end: after.end,
            observed: true,
            calls: [
              { actor: request.actor, call: request.call, settled: true, eligibility: 'write' }
            ]
          },
          store.edges
        );
        assert.equal(selected.source, 'execution');
        assert.equal(
          (await checkpoint.readWindows(spelling, [lower, upper])).filter(
            (row) => row.sid === 'legacy'
          ).length,
          1
        );
        const merged = await checkpoint.readWindows(spelling, [lower, upper, distinct]);
        assert.equal(merged.filter((row) => row.sid === 'legacy').length, 1);
        assert.equal(merged.filter((row) => row.sid === 'distinct').length, 1);
      }
    }
  );

  it('joins an edge published while its completion receipt is held and keeps the first terminal bound', async (t) => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('pending-completion-receipt', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    const request = { cwd, owner: 'owner', runtime: runtime.runtime, actor: 'root', call: 'call' };
    await checkpoint.captureExecution({ ...request, edge: 'before' }, contextFile);
    const append = fs.appendFile;
    let entered!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof fs.appendFile>) => {
      if (args[0] === `${contextFile}.trees` && typeof args[1] === 'string') {
        const row = JSON.parse(args[1]) as {
          kind?: string;
          owner?: string;
          actor?: string;
          task?: string;
          runtime?: string;
        };
        if (
          row.kind === 'task-end' &&
          row.owner === request.owner &&
          row.actor === request.actor &&
          row.task === 'task' &&
          row.runtime === request.runtime
        ) {
          entered();
          await held;
        }
      }
      return append(...args);
    });
    const completion = checkpoint.endPendingExecution(cwd, request.owner, request.runtime, 'task', {
      contextFile,
      actor: request.actor
    });
    try {
      await publishing;
      const edge = await checkpoint.captureExecution(
        { ...request, edge: 'after', pending: true, task: 'task' },
        contextFile
      );
      assert.ok(edge);
      for (const [owner, runtimeId, actor, task] of [
        ['foreign', request.runtime, request.actor, 'task'],
        [request.owner, 'foreign', request.actor, 'task'],
        [request.owner, request.runtime, 'foreign', 'task'],
        [request.owner, request.runtime, request.actor, 'foreign']
      ] as const)
        await checkpoint.endPendingExecution(cwd, owner, runtimeId, task, { contextFile, actor });
      assert.equal((await checkpoint.readExecution(cwd)).callEnds.length, 0);
      assert.equal((await checkpoint.readWindows(cwd))[0]?.end, Infinity);
      release();
      await completion;
      const store = await checkpoint.readExecution(cwd);
      assert.equal(store.callEnds.length, 1);
      const stop = store.callEnds[0];
      assert.ok(stop && stop.at >= edge.end);
      await checkpoint.appendExecution(cwd, { ...stop, at: stop.at + 1000 });
      assert.equal((await checkpoint.readWindows(cwd))[0]?.end, stop.at);
      assert.equal(store.coverage.length, 0);
    } finally {
      release();
      await completion;
      await new checkpoint.TurnCheckpoints('cleanup').endExecution(request.runtime, contextFile);
    }
  });

  it('retains task completion that overtakes pending edge publication on another registered tree', async (t) => {
    const { executionRepo } = await import('../execution_helpers');
    const parent = await executionRepo('pending-completion-parent', 'grok');
    const child = await executionRepo('pending-completion-tree', 'grok');
    const contextFile = parent.runtime.contextFile;
    assert.ok(contextFile);
    const request = {
      cwd: child.cwd,
      owner: 'owner',
      runtime: parent.runtime.runtime,
      actor: 'root',
      call: 'pending-call'
    };
    await checkpoint.captureExecution({ ...request, edge: 'before' }, contextFile);
    await fs.writeFile(path.join(child.cwd, 'background.txt'), 'background\n');
    const append = fs.appendFile;
    let entered!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof fs.appendFile>) => {
      if (args[0] === checkpoint.windowsFile(child.cwd) && typeof args[1] === 'string') {
        const row = JSON.parse(args[1]) as { kind?: string; edge?: string };
        if (row.kind === 'execution' && row.edge === 'after') {
          entered();
          await held;
        }
      }
      return append(...args);
    });
    const pending = checkpoint.captureExecution(
      { ...request, edge: 'after', pending: true, task: 'task' },
      contextFile
    );
    const peer = new checkpoint.TurnCheckpoints('later-peer');
    try {
      await publishing;
      await checkpoint.endPendingExecution(parent.cwd, request.owner, request.runtime, 'task', {
        contextFile,
        actor: 'unrelated-child'
      });
      await checkpoint.endPendingExecution(parent.cwd, 'unrelated-owner', request.runtime, 'task', {
        contextFile,
        actor: request.actor
      });
      await checkpoint.endPendingExecution(parent.cwd, request.owner, 'unrelated-runtime', 'task', {
        contextFile,
        actor: request.actor
      });
      await checkpoint.endPendingExecution(parent.cwd, request.owner, request.runtime, 'task', {
        contextFile,
        actor: request.actor
      });
      release();
      const edge = await pending;
      assert.ok(edge);
      const store = await checkpoint.readExecution(child.cwd);
      assert.equal(store.callEnds.length, 1);
      assert.ok(store.callEnds[0] && store.callEnds[0].at >= edge.end);
      assert.ok(store.windows.every((window) => window.end < Infinity));
      assert.equal(store.coverage.length, 0);
      await peer.open(child.cwd);
      const own = path.join(child.cwd, 'peer.txt');
      await fs.writeFile(own, 'peer\n');
      const ck = await peer.close(child.cwd);
      assert.ok(ck);
      assert.deepEqual(
        checkpoint.attribute(ck, 'later-peer', await checkpoint.readWindows(child.cwd)).files,
        [own]
      );
    } finally {
      release();
      await pending;
      await peer.flush();
      await peer.endExecution('unused');
      await new checkpoint.TurnCheckpoints('cleanup').endExecution(request.runtime, contextFile);
    }
  });

  it('refuses a different-tree capture whose lookup finishes after runtime end', async (t) => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('runtime-delayed-parent', 'claude');
    const child = await executionRepo('runtime-delayed-child', 'claude');
    const git = await import('../../core/git');
    const tree = await git.readTree(child.cwd);
    assert.ok(tree);
    const collector = new checkpoint.TurnCheckpoints('delayed-parent');
    await collector.open(cwd, {
      owner: 'owner',
      runtime: runtime.runtime,
      turn: 'turn',
      enabled: true
    });
    const read = git.readTree;
    let entered!: () => void;
    let release!: () => void;
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(git, 'readTree', async (directory: string) => {
      if (directory === child.cwd) {
        entered();
        await held;
      }
      return read(directory);
    });
    const pending = checkpoint.captureExecution(
      {
        cwd: child.cwd,
        owner: 'owner',
        runtime: runtime.runtime,
        actor: 'child',
        call: 'late',
        edge: 'before'
      },
      runtime.contextFile
    );
    try {
      await lookup;
      await collector.endExecution(runtime.runtime, runtime.contextFile);
      release();
      assert.equal(await pending, undefined);
      assert.deepEqual(
        (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')),
        []
      );
    } finally {
      release();
      await pending;
      await collector.endExecution(runtime.runtime, runtime.contextFile);
    }
  });

  it('removes a pre-only call index while its evidence publication is held across runtime end', async (t) => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('runtime-publishing-call', 'claude');
    const tree = await (await import('../../core/git')).readTree(cwd);
    assert.ok(tree);
    const append = fs.appendFile;
    let entered!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof fs.appendFile>) => {
      if (
        args[0] === checkpoint.windowsFile(cwd) &&
        typeof args[1] === 'string' &&
        (JSON.parse(args[1]) as { kind?: string }).kind === 'execution'
      ) {
        entered();
        await held;
      }
      return append(...args);
    });
    const pending = checkpoint.captureExecution(
      {
        cwd,
        owner: 'owner',
        runtime: runtime.runtime,
        actor: 'actor',
        call: 'held',
        edge: 'before'
      },
      runtime.contextFile
    );
    const collector = new checkpoint.TurnCheckpoints('unused-floor');
    try {
      await publishing;
      assert.equal(
        (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')).length,
        1
      );
      await collector.endExecution(runtime.runtime, runtime.contextFile);
      assert.deepEqual(
        (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')),
        []
      );
      release();
      await pending;
      assert.deepEqual(
        (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')),
        []
      );
    } finally {
      release();
      await pending;
      await collector.endExecution(runtime.runtime, runtime.contextFile);
    }
  });

  it('timestamps autonomous uncertainty before a delayed tree lookup', async (t) => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('unknown-tree-delay', 'claude');
    const git = await import('../../core/git');
    const peer = new checkpoint.TurnCheckpoints('delayed-tree-peer');
    const autonomous = new checkpoint.TurnCheckpoints('delayed-tree-autonomous');
    await peer.open(cwd);
    const read = git.readTree;
    let entered!: () => void;
    let release!: () => void;
    let blocked = false;
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(git, 'readTree', async (directory: string) => {
      if (directory === cwd && !blocked) {
        blocked = true;
        entered();
        await held;
      }
      return read(directory);
    });
    try {
      const opened = autonomous.openUnknown(cwd, {
        owner: 'autonomous',
        runtime: runtime.runtime,
        turn: 'wake'
      });
      await lookup;
      await fs.writeFile(path.join(cwd, 'autonomous.txt'), 'wake\n');
      const captured = await peer.close(cwd);
      assert.ok(captured);
      release();
      await opened;
      const closed = await autonomous.closeExecution(cwd);
      assert.equal(closed.ex?.source, 'none');
      const attributed = checkpoint.attribute(captured, 'peer', await checkpoint.readWindows(cwd));
      assert.deepEqual(attributed.files, []);
      assert.equal(attributed.concurrent, true);
    } finally {
      release();
      peer.end();
      await autonomous.endExecution(runtime.runtime);
      await peer.flush();
    }
  });

  it('bounds other-tree captures and drops only this runtime’s pre-only indexes on exit', async () => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('runtime-other-tree', 'claude');
    const tree = await (await import('../../core/git')).readTree(cwd);
    assert.ok(tree);
    const request = {
      cwd,
      owner: 'owner',
      runtime: runtime.runtime,
      actor: 'child',
      call: 'unfinished',
      edge: 'before' as const
    };
    await checkpoint.captureExecution(request, runtime.contextFile);
    await checkpoint.captureExecution({ ...request, runtime: 'other-runtime', call: 'other' });
    assert.equal(
      (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')).length,
      2
    );
    const turn = new checkpoint.TurnCheckpoints('unused-floor');
    await turn.endExecution(runtime.runtime, runtime.contextFile);
    assert.equal(
      (await fs.readdir(tree.gitDir)).filter((name) => name.endsWith('.index')).length,
      1
    );
    const windows = await checkpoint.readWindows(cwd);
    assert.ok(windows.some((window) => window.end < Infinity));
    assert.ok(windows.some((window) => window.end === Infinity));
  });

  it('joins independently observed calls, publishes active evidence, and retains the floor after a missing hook', async () => {
    const cwd = path.join(await fs.realpath(home), 'collector');
    await fs.mkdir(cwd);
    const run = promisify(execFile);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    await run('git', ['init', '-b', 'main'], { cwd, env });
    await run(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'base'
      ],
      { cwd, env }
    );
    const turn = new checkpoint.TurnCheckpoints('isolated-floor');
    const context = {
      owner: 'brand\0owner',
      runtime: 'collector-runtime',
      turn: 'first',
      enabled: true
    };
    await turn.open(cwd, context);
    assert.equal((await checkpoint.readWindows(cwd))[0]?.uncertain, true);
    const call = {
      actor: 'root',
      call: 'first-call',
      context: 'native-context',
      eligibility: 'write' as const,
      settled: false
    };
    const request = {
      cwd,
      owner: context.owner,
      runtime: context.runtime,
      actor: call.actor,
      call: call.call,
      context: call.context
    };
    assert.ok((await checkpoint.captureExecution({ ...request, edge: 'before' }))?.snapshot);
    await fs.writeFile(path.join(cwd, 'written'), 'one\n');
    assert.ok((await checkpoint.captureExecution({ ...request, edge: 'after' }))?.snapshot);
    await fs.writeFile(path.join(cwd, 'gap'), 'unowned gap\n');
    const first = await turn.closeExecution(cwd, () =>
      Promise.resolve({ observed: true, calls: [{ ...call, settled: true }] })
    );
    assert.equal(first.ex?.source, 'execution');
    assert.equal(first.ck?.changes.files.length, 2);
    assert.deepEqual(
      first.ex?.windows.flatMap((window) => window.changes.files),
      [path.join(cwd, 'written')]
    );
    assert.equal(
      (await checkpoint.readWindows(cwd)).some((window) => window.uncertain),
      false
    );
    await turn.open(cwd, { ...context, turn: 'second' });
    await fs.writeFile(path.join(cwd, 'fallback'), 'two\n');
    const second = await turn.closeExecution(cwd, () =>
      Promise.resolve({ observed: true, calls: [{ ...call, call: 'missing', settled: true }] })
    );
    assert.equal(second.ex?.source, 'turn');
    assert.deepEqual(second.ex?.windows[0]?.changes.files, [path.join(cwd, 'fallback')]);
    await turn.endExecution(context.runtime);
  });

  it('round-trips metadata-only execution edges, including an explicit capture failure', async () => {
    const tree = '/repo/execution-round-trip';
    const edge = {
      version: 1 as const,
      kind: 'execution' as const,
      tree,
      owner: 'brand\0owner',
      runtime: 'runtime',
      actor: 'actor',
      call: 'call',
      edge: 'before' as const,
      start: 100,
      end: 110
    };
    assert.equal(await checkpoint.appendExecution(tree, edge), true);
    const read = await checkpoint.readExecution(tree);
    assert.equal(read.readable, true);
    assert.deepEqual(read.edges, [edge]);
    assert.equal(await checkpoint.readExecution(tree), read);
    assert.equal(read.windows[0]?.uncertain, true);
  });

  it('keeps active uncertainty until final coverage, and replaces the retained coarse source', async () => {
    const tree = '/repo/execution-selection';
    const owner = 'brand\0owner';
    await checkpoint.appendExecution(tree, {
      version: 1,
      kind: 'active',
      tree,
      owner,
      runtime: 'runtime',
      turn: 'turn',
      start: 100
    });
    assert.equal((await checkpoint.readWindows(tree))[0]?.uncertain, true);
    await checkpoint.appendWindow(tree, {
      sid: owner,
      start: 100,
      end: 300,
      paths: [`${tree}/gap`, `${tree}/command`]
    });
    const floor = {
      tree,
      from: { tree: 'a'.repeat(40), head: 'a'.repeat(40), at: 100 },
      to: { tree: 'b'.repeat(40), head: 'a'.repeat(40), at: 300 },
      changes: { files: [`${tree}/gap`, `${tree}/command`], sizes: {} }
    };
    await checkpoint.appendExecution(tree, {
      version: 1,
      kind: 'coverage',
      tree,
      owner,
      runtime: 'runtime',
      turn: 'turn',
      start: 100,
      end: 300,
      source: 'execution',
      floor,
      calls: [],
      windows: [
        {
          ...floor,
          from: { ...floor.from, at: 120 },
          to: { ...floor.to, at: 180 },
          changes: { files: [`${tree}/command`], sizes: {} }
        }
      ]
    });
    const windows = await checkpoint.readWindows(tree);
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0]?.paths, [`${tree}/command`]);
    assert.equal(windows[0]?.uncertain, undefined);
  });

  it('bounds an unresolved historical interval on runtime end without inventing a capture', async () => {
    const tree = '/repo/execution-death';
    await checkpoint.appendExecution(tree, {
      version: 1,
      kind: 'execution',
      tree,
      owner: 'owner',
      runtime: 'runtime',
      actor: 'actor',
      call: 'call',
      edge: 'before',
      start: 100,
      end: 110
    });
    await checkpoint.appendExecution(tree, {
      version: 1,
      kind: 'runtime-end',
      tree,
      runtime: 'runtime',
      at: 200
    });
    assert.deepEqual(await checkpoint.readWindows(tree), [
      { sid: 'owner', start: 100, end: 200, paths: [], uncertain: true }
    ]);
    assert.equal((await checkpoint.readExecution(tree)).edges.length, 1);
  });

  it('bounds a yielded call on native task completion without converting its early return into precise coverage', async () => {
    const tree = '/repo/execution-background';
    const edge = {
      version: 1 as const,
      kind: 'execution' as const,
      tree,
      owner: 'owner',
      runtime: 'runtime',
      actor: 'actor',
      call: 'call',
      start: 100,
      end: 110
    };
    await checkpoint.appendExecution(tree, { ...edge, edge: 'before' });
    await checkpoint.appendExecution(tree, {
      ...edge,
      edge: 'after',
      start: 120,
      end: 130,
      pending: true,
      task: 'task'
    });
    assert.equal((await checkpoint.readWindows(tree))[0]?.end, Infinity);
    await checkpoint.appendExecution(tree, {
      version: 1,
      kind: 'call-end',
      tree,
      owner: 'owner',
      runtime: 'runtime',
      actor: 'actor',
      call: 'call',
      at: 200
    });
    assert.deepEqual(await checkpoint.readWindows(tree), [
      { sid: 'owner', start: 100, end: 200, paths: [], uncertain: true }
    ]);
    assert.equal((await checkpoint.readExecution(tree)).edges[1]?.pending, true);
  });

  it('distinguishes an absent store from an unreadable one', async () => {
    assert.equal((await checkpoint.readExecution('/repo/no-execution-store')).readable, true);
    const tree = '/repo/execution-unreadable';
    await fs.mkdir(checkpoint.windowsFile(tree), { recursive: true });
    assert.equal((await checkpoint.readExecution(tree)).readable, false);
    assert.equal((await checkpoint.readWindows(tree))[0]?.unavailable, true);
  });

  it('refuses invalid times and foreign tenancy and persists no extra native payload', async () => {
    const tree = '/repo/execution-validate';
    const edge = {
      version: 1 as const,
      kind: 'execution' as const,
      tree,
      owner: 'owner',
      runtime: 'runtime',
      actor: 'actor',
      call: 'call',
      edge: 'before' as const,
      start: 100,
      end: 110
    };
    assert.equal(await checkpoint.appendExecution(tree, { ...edge, start: NaN }), false);
    assert.equal(
      await checkpoint.appendExecution(tree, { ...edge, tree: '/other-worktree' }),
      false
    );
    assert.equal(await checkpoint.appendExecution(tree, { ...edge, start: 120 }), false);
    assert.equal(
      await checkpoint.appendExecution(tree, {
        ...edge,
        tool_input: { command: 'private shell body' }
      } as typeof edge),
      true
    );
    assert.equal(
      (await fs.readFile(checkpoint.windowsFile(tree), 'utf8')).includes('private shell body'),
      false
    );
  });

  it('reads historical alias stores alongside the canonical store and keeps the cache stable', async () => {
    const root = path.join(home, 'real-tree');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const alias = path.join(home, 'tree-alias');
    await linkDir(root, alias);
    const git = await import('../../core/git');
    const canonical = (await git.readTree(alias))?.treeRoot;
    assert.ok(canonical);
    await checkpoint.appendWindow(alias, {
      sid: 'old',
      start: 1,
      end: 2,
      paths: [path.join(alias, 'gone')]
    });
    await checkpoint.appendWindow(canonical, { sid: 'new', start: 3, end: 4, paths: [] });
    const windows = await checkpoint.readWindows(canonical);
    assert.deepEqual(windows.map((w) => w.sid).sort(), ['new', 'old']);
    assert.equal(await checkpoint.readWindows(canonical), windows);
  });

  it('round-trips a turn window', async () => {
    const tree = '/repo/one';
    await checkpoint.appendWindow(tree, {
      sid: 'a',
      start: 10,
      end: 20,
      paths: ['/repo/one/x.ts']
    });
    assert.deepEqual(await checkpoint.readWindows(tree), [
      { sid: 'a', start: 10, end: 20, paths: ['/repo/one/x.ts'] }
    ]);
  });

  it('writes under the state directory and nowhere near the tree', () => {
    const file = checkpoint.windowsFile('/repo/one');
    assert.ok(file.startsWith(path.join(home, '.squadron')), file);
    assert.ok(file.endsWith('.jsonl'), 'never .json — host/watch.ts watches those');
  });

  /**
   * Two worktrees of one repository must not read each other's windows, which
   * is the whole reason the key is the working tree and not `repoRoot`. Their
   * basenames can collide, so the discriminator has to be the full path.
   */
  it('keeps two trees apart, including two that share a basename', async () => {
    await checkpoint.appendWindow('/a/feat', { sid: 'a', start: 1, end: 2, paths: ['/a/feat/x'] });
    await checkpoint.appendWindow('/b/feat', { sid: 'b', start: 1, end: 2, paths: ['/b/feat/y'] });
    assert.deepEqual(
      (await checkpoint.readWindows('/a/feat')).map((w) => w.sid),
      ['a']
    );
    assert.deepEqual(
      (await checkpoint.readWindows('/b/feat')).map((w) => w.sid),
      ['b']
    );
    assert.notEqual(checkpoint.windowsFile('/a/feat'), checkpoint.windowsFile('/b/feat'));
  });

  /**
   * Several windows append to one tree's file, so the single-writer argument a
   * record rests on is not available here. `O_APPEND` on one short line is what
   * replaces it.
   */
  it('survives many writers appending at once', async () => {
    const tree = '/repo/busy';
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        checkpoint.appendWindow(tree, {
          sid: `s${i}`,
          start: i,
          end: i + 1,
          paths: [`/repo/busy/f${i}.ts`]
        })
      )
    );
    const all = await checkpoint.readWindows(tree);
    assert.equal(all.length, 40);
    assert.equal(new Set(all.map((w) => w.sid)).size, 40);
  });

  it('drops a torn last line rather than losing the file', async () => {
    const tree = '/repo/torn';
    await checkpoint.appendWindow(tree, { sid: 'a', start: 1, end: 2, paths: [] });
    await fs.appendFile(checkpoint.windowsFile(tree), '{"sid":"b","start":3,"en');
    assert.deepEqual(
      (await checkpoint.readWindows(tree)).map((w) => w.sid),
      ['a']
    );
  });

  it('drops a line that parses but is not a window', async () => {
    const tree = '/repo/junk';
    const file = checkpoint.windowsFile(tree);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        '{"sid":"a","start":1,"end":2,"paths":[]}',
        '{"hello":"world"}',
        '{"sid":"c","start":1,"end":2,"paths":"not an array"}',
        '[]',
        'null',
        ''
      ].join('\n')
    );
    assert.deepEqual(
      (await checkpoint.readWindows(tree)).map((w) => w.sid),
      ['a']
    );
  });

  it('answers an empty list for a tree nothing has written', async () => {
    assert.deepEqual(await checkpoint.readWindows('/repo/never'), []);
  });

  /** Read every poll while the dock is open, so an unchanged file must not be
   *  re-parsed — the contract `readRecord` states for the same reason. */
  it('hands back the same array while the file has not moved', async () => {
    const tree = '/repo/stable';
    await checkpoint.appendWindow(tree, { sid: 'a', start: 1, end: 2, paths: [] });
    const first = await checkpoint.readWindows(tree);
    assert.equal(await checkpoint.readWindows(tree), first);
    await checkpoint.appendWindow(tree, { sid: 'b', start: 3, end: 4, paths: [] });
    assert.notEqual(await checkpoint.readWindows(tree), first);
  });
});

describe('execution evidence that cannot outlive its turn or runtime', () => {
  const owner = 'brand\0bounded';

  it('skips an invalid or newer-version row like a torn line instead of silencing the tree', async () => {
    const tree = '/repo/execution-skip-invalid';
    await checkpoint.appendWindow(tree, {
      sid: 'peer',
      start: 100,
      end: 200,
      paths: [`${tree}/peer`]
    });
    await fs.appendFile(
      checkpoint.windowsFile(tree),
      [
        JSON.stringify({ version: 2, kind: 'execution', tree, runtime: 'next-build' }),
        JSON.stringify({ version: 1, kind: 'active', tree, owner, runtime: 'runtime' }),
        ''
      ].join('\n')
    );
    assert.equal((await checkpoint.readExecution(tree)).readable, true);
    assert.deepEqual(await checkpoint.readWindows(tree), [
      { sid: 'peer', start: 100, end: 200, paths: [`${tree}/peer`] }
    ]);
  });

  it('selects the retained floor when no observer can prove the turn', async () => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('unobserved-close', 'claude');
    const turn = new checkpoint.TurnCheckpoints('unobserved', runtime.contextFile);
    await turn.open(cwd, { owner, runtime: runtime.runtime, turn: 'unobserved', enabled: true });
    await fs.writeFile(path.join(cwd, 'shell.txt'), 'shell\n');
    const closed = await turn.closeExecution(cwd);
    assert.equal(closed.ex?.source, 'turn');
    assert.deepEqual(closed.ex?.windows[0]?.changes.files, [path.join(cwd, 'shell.txt')]);
    await turn.endExecution(runtime.runtime, runtime.contextFile);
  });

  it('ends a returned call whose after edge never came when its turn closes', async () => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('unpaired-close', 'claude');
    const turn = new checkpoint.TurnCheckpoints('unpaired', runtime.contextFile);
    const context = { owner, runtime: runtime.runtime, turn: 'first', enabled: true };
    const request = { cwd, owner, runtime: runtime.runtime, actor: 'root' };
    const call = (id: string, settled: boolean) => ({
      actor: 'root',
      call: id,
      eligibility: 'write' as const,
      settled
    });
    const open = async (): Promise<{ ended: string[]; unbounded: number }> => {
      const store = await checkpoint.readExecution(cwd);
      return {
        ended: store.callEnds.map((end) => end.call),
        unbounded: store.windows.filter((window) => window.end === Infinity).length
      };
    };
    await turn.open(cwd, context);
    // A hook timeout: the call returned, its after edge never landed.
    await checkpoint.captureExecution({ ...request, call: 'returned', edge: 'before' });
    // A background child still running: the turn did not complete.
    await checkpoint.captureExecution({ ...request, call: 'running', edge: 'before' });
    await turn.closeExecution(cwd, () =>
      Promise.resolve({ observed: false, calls: [call('returned', true), call('running', false)] })
    );
    assert.deepEqual(await open(), { ended: ['returned'], unbounded: 1 });
    await turn.open(cwd, { ...context, turn: 'second' });
    // An interrupt: unsettled, but the turn completed with no child left running.
    await checkpoint.captureExecution({ ...request, call: 'interrupted', edge: 'before' });
    await turn.closeExecution(cwd, () =>
      Promise.resolve({ observed: true, calls: [call('interrupted', false)] })
    );
    // The background child's call stays open: another turn's close never ends it.
    assert.deepEqual(await open(), { ended: ['returned', 'interrupted'], unbounded: 1 });
    await turn.endExecution(runtime.runtime, runtime.contextFile);
  });

  it('ends a returned call on another tree the runtime registered when its turn closes', async () => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('unpaired-origin', 'claude');
    const { cwd: other } = await executionRepo('unpaired-other', 'claude');
    const turn = new checkpoint.TurnCheckpoints('unpaired-trees', runtime.contextFile);
    const request = { owner, runtime: runtime.runtime, actor: 'root', edge: 'before' as const };
    const call = (id: string, settled: boolean) => ({
      actor: 'root',
      call: id,
      eligibility: 'write' as const,
      settled
    });
    await turn.open(cwd, { owner, runtime: runtime.runtime, turn: 'first', enabled: true });
    // A shell call that cd'd into another repo: its hook registered that tree in the journal only.
    await checkpoint.captureExecution(
      { ...request, cwd: other, call: 'returned' },
      runtime.contextFile
    );
    await checkpoint.captureExecution(
      { ...request, cwd: other, call: 'running' },
      runtime.contextFile
    );
    await turn.closeExecution(cwd, () =>
      Promise.resolve({ observed: false, calls: [call('returned', true), call('running', false)] })
    );
    assert.deepEqual(
      (await checkpoint.readExecution(other)).callEnds.map((end) => end.call),
      ['returned']
    );
    await turn.endExecution(runtime.runtime, runtime.contextFile);
  });

  it('ends a runtime whose host died, through the trees only its journal names, once', async () => {
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('orphaned-runtime', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    const crashed = new checkpoint.TurnCheckpoints('crashed', contextFile);
    await crashed.open(cwd, { owner, runtime: runtime.runtime, turn: 'crash', enabled: true });
    assert.equal((await checkpoint.readWindows(cwd))[0]?.end, Infinity);
    await checkpoint.endExecutionRuntime(runtime.runtime, contextFile);
    const bounded = await checkpoint.readWindows(cwd);
    assert.equal(bounded.length, 1);
    assert.ok(Number.isFinite(bounded[0]?.end));
    await checkpoint.endExecutionRuntime(runtime.runtime, contextFile);
    assert.equal((await checkpoint.readExecution(cwd)).ended.length, 1);
    assert.equal((await checkpoint.readWindows(cwd))[0]?.end, bounded[0]?.end);
  });
});
