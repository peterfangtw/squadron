import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionsFromCodexProcesses } from '../../core/codex/discover';
import type { Session } from '../../core/model';
import type { PublishedLive } from '../../core/published';
import type { Ancestry, Proc } from '../../core/scan';
import { foldTwins } from '../../ui/views';

function proc(pid: number, command: string, ppid = 1): Proc {
  return { pid, ppid, command, startedAt: 1_000 + pid };
}

/** A table holding these codex processes, each under its own `ppid`. */
function table(procs: Proc[], shells: number[] = []): Ancestry {
  return {
    codex: new Map(procs.map((p) => [p.pid, p])),
    claude: new Map(),
    grok: new Map(),
    shellParents: new Set(shells),
    parents: new Map(procs.map((p) => [p.pid, p.ppid])),
    starts: new Map(procs.map((p) => [p.pid, p.startedAt]))
  };
}

function published(pid: number): PublishedLive {
  const session: Session = {
    pid,
    sessionId: 'codex-thread',
    cwd: '/repo',
    name: 'Owned Codex',
    status: 'idle',
    hasCommand: false,
    startedAt: 1_000 + pid,
    updatedAt: 2_000,
    transcript: '',
    source: 'owned',
    brand: 'codex',
    images: true,
    windowId: 'owner'
  };
  return { schema: 1, session, pending: [], queued: [] };
}

describe('Codex process discovery', () => {
  it('keeps a published pid, promotes it, and drops everything else', () => {
    // Codex states no channel on disk, so the record is the only proof a
    // process is ours. A typed TUI, somebody else's app-server and one of our
    // own unpublished helpers all look the same from here: nobody's card.
    const tui = proc(10, 'codex', 100);
    const owned = proc(20, 'codex app-server --listen stdio://');
    const helper = proc(30, 'codex app-server --listen stdio://');
    const daemon = proc(40, 'codex -c features.code_mode_host=true app-server --analytics-default');
    const record = published(owned.pid);
    const found = sessionsFromCodexProcesses(
      table([tui, owned, helper, daemon], [owned.pid]),
      new Map([[owned.pid, record]])
    );
    assert.deepEqual(
      found.map((row) => row.pid),
      [owned.pid]
    );
    assert.equal(found[0]?.hasCommand, true);

    const [card] = foldTwins([], found, new Map([[owned.pid, record]]));
    assert.equal(card?.sessionId, 'codex-thread');
    assert.equal(card?.brand, 'codex');
    assert.equal(card?.source, 'owned');
    assert.equal(card?.hasCommand, true, 'the live process fact survives publication promotion');
  });

  it('names the parent of a Codex session this machine spawned', () => {
    // The one brand with no parentage test, and its `spawnedBy` call site moved
    // when the slack stopped being a per-brand argument. `proc` starts at
    // `1_000 + pid`, and the edge is stamped after the fork, which on the `ps`
    // clock puts the start inside the slack rather than after the edge.
    const owned = proc(20, 'codex app-server --listen stdio://');
    const found = sessionsFromCodexProcesses(
      table([owned]),
      // Published, or it is nobody's and dropped before it reaches the join.
      new Map([[owned.pid, published(owned.pid)]]),
      new Map([
        [
          owned.pid,
          {
            kind: 'spawn' as const,
            schema: 1 as const,
            parentSessionId: 'parent-1',
            originSessionId: 'gen1',
            spawnedAt: owned.startedAt + 500,
            cwd: '/repo',
            requestId: 'req-1'
          }
        ]
      ])
    );
    assert.equal(found[0]?.parentSessionId, 'parent-1');
    assert.equal(found[0]?.originSessionId, 'gen1');
  });

  it('states codex on the row it builds', () => {
    const owned = proc(20, 'codex app-server --listen stdio://');
    const found = sessionsFromCodexProcesses(
      table([owned]),
      new Map([[owned.pid, published(owned.pid)]])
    );
    assert.equal(found[0]?.brand, 'codex');
  });

  it('keeps that brand when the fold has no record to promote', () => {
    // Discovery emits the row only beside a record. The panel then folds with
    // an empty map, so nothing promotes over the twin and its own brand remains.
    const owned = proc(20, 'codex app-server --listen stdio://');
    const found = sessionsFromCodexProcesses(
      table([owned]),
      new Map([[owned.pid, published(owned.pid)]])
    );
    const [card] = foldTwins([], found, new Map());
    assert.equal(card?.brand, 'codex');
    assert.equal(card?.source, undefined);
  });

  it('drops a pid whose record names a session that started an hour apart', () => {
    // A force-quit window leaves its record for days; a typed codex can land
    // on the recycled pid. The start is what tells them apart.
    const reused = proc(20, 'codex');
    const stale = published(reused.pid);
    stale.session.startedAt = reused.startedAt - 3600_000;
    assert.deepEqual(
      sessionsFromCodexProcesses(table([reused]), new Map([[reused.pid, stale]])),
      []
    );
  });

  it('does not resurrect a stale publication with no live pid', () => {
    const record = published(99);
    assert.deepEqual(sessionsFromCodexProcesses(table([]), new Map([[99, record]])), []);
  });
});

/**
 * An npm-installed Codex: the published pid is the `node …/bin/codex.js` root
 * the window spawned, and the native `codex` is its child (observed
 * 2026-10-27). The session is the root's; the native child only stands for it.
 */
describe('Codex discovery under a runtime root', () => {
  const root = proc(50, 'node /Users/me/.npm/bin/codex app-server --listen stdio://');
  const native = proc(51, '/Users/me/.npm/vendor/bin/codex app-server', root.pid);

  function wrapped(extra: Proc[] = [], shells: number[] = []): Ancestry {
    const all = [root, native, ...extra];
    return {
      codex: new Map(
        [native, ...extra.filter((p) => /codex/.test(p.command ?? ''))].map((p) => [p.pid, p])
      ),
      claude: new Map(),
      grok: new Map(),
      shellParents: new Set(shells),
      parents: new Map(all.map((p) => [p.pid, p.ppid])),
      starts: new Map(all.map((p) => [p.pid, p.startedAt]))
    };
  }

  it('joins the native child to its root’s record, under the root’s pid and start', () => {
    const found = sessionsFromCodexProcesses(wrapped(), new Map([[root.pid, published(root.pid)]]));
    assert.deepEqual(
      found.map(({ pid, startedAt }) => [pid, startedAt]),
      [[root.pid, root.startedAt]]
    );
    assert.equal(found[0]?.hasCommand, false);
    const [card] = foldTwins([], found, new Map([[root.pid, published(root.pid)]]));
    assert.equal(card?.sessionId, 'codex-thread');
    assert.equal(card?.source, 'owned');
  });

  it('reads a tool shell under the native child as the session’s command', () => {
    const found = sessionsFromCodexProcesses(
      wrapped([], [native.pid]),
      new Map([[root.pid, published(root.pid)]])
    );
    assert.equal(found[0]?.hasCommand, true);
  });

  it('names the parent the root was spawned by', () => {
    const found = sessionsFromCodexProcesses(
      wrapped(),
      new Map([[root.pid, published(root.pid)]]),
      new Map([
        [
          root.pid,
          {
            kind: 'spawn' as const,
            schema: 1 as const,
            parentSessionId: 'parent-1',
            spawnedAt: root.startedAt + 500,
            cwd: '/repo',
            requestId: 'req-1'
          }
        ]
      ])
    );
    assert.equal(found[0]?.parentSessionId, 'parent-1');
  });

  it('drops a native child whose root nobody published', () => {
    assert.deepEqual(sessionsFromCodexProcesses(wrapped(), new Map()), []);
  });

  it('drops a root whose record names a session that started an hour apart', () => {
    const stale = published(root.pid);
    stale.session.startedAt = root.startedAt - 3600_000;
    assert.deepEqual(sessionsFromCodexProcesses(wrapped(), new Map([[root.pid, stale]])), []);
  });

  it('drops a root whose record is another brand’s, or a brandless legacy one', () => {
    const grok = published(root.pid);
    grok.session.brand = 'grok';
    const legacy = published(root.pid);
    delete legacy.session.brand;
    for (const record of [grok, legacy]) {
      assert.deepEqual(sessionsFromCodexProcesses(wrapped(), new Map([[root.pid, record]])), []);
    }
  });

  it('drops a native child whose parent edge was refuted', () => {
    const table = wrapped();
    table.parents.set(native.pid, undefined);
    assert.deepEqual(
      sessionsFromCodexProcesses(table, new Map([[root.pid, published(root.pid)]])),
      []
    );
  });

  it('emits one row for a native root and none for its own codex helper', () => {
    // A direct launch whose native codex re-executes itself for a helper.
    const helper = proc(52, '/Users/me/.npm/vendor/bin/codex sandbox', native.pid);
    const found = sessionsFromCodexProcesses(
      wrapped([helper]),
      new Map([[native.pid, published(native.pid)]])
    );
    assert.deepEqual(
      found.map((row) => row.pid),
      [native.pid]
    );
  });
});
