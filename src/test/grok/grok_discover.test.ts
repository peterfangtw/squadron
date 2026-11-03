import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeHome, fakeGrok, FakeProcess, tempHome, testPlatform, writeJson } from '../helpers';
import type { Session } from '../../core/model';
import type { PublishedLive } from '../../core/published';

let discoverGrok: typeof import('../../core/grok/discover').discoverGrok;
let grokAdapter: typeof import('../../core/grok/adapter').grokAdapter;
let views: typeof import('../../ui/views');
let endPlan: typeof import('../../cli/end').endPlan;
let home: string;
let fake: FakeProcess;
/** The fake's start as `ps` states it — the clock a record is matched on. */
let fakeStart: number;

// Every import here is deferred past `tempHome()`, `ui/views` included: it
// reaches `core/arrange` and so `core/paths`, which freezes the state
// directory the first time it is required. A static one would freeze the real
// `~/.squadron`, and the lineage cases below both read and write it.
before(async () => {
  home = await tempHome();
  fake = await fakeGrok();
  ({ discoverGrok } = await import('../../core/grok/discover'));
  ({ grokAdapter } = await import('../../core/grok/adapter'));
  views = await import('../../ui/views');
  ({ endPlan } = await import('../../cli/end'));
  const { scanProcesses } = await import('../../core/scan');
  fakeStart = (await scanProcesses(true)).starts.get(fake.pid) ?? 0;
});
after(async () => {
  await fake.stop();
  await disposeHome(home);
});

/** What this machine's own window writes for a Grok session it drives. */
function record(session: Partial<Session> = {}): PublishedLive {
  return {
    schema: 1,
    session: {
      pid: fake.pid,
      sessionId: 'g1',
      cwd: '/tmp/project',
      name: '',
      status: 'idle',
      hasCommand: false,
      startedAt: fakeStart,
      updatedAt: 0,
      transcript: '',
      source: 'owned',
      brand: 'grok',
      ...session
    },
    pending: [],
    queued: []
  };
}

const liveFile = () => path.join(home, '.squadron', 'live', `${fake.pid}.json`);
const publish = () => writeJson(liveFile(), record());
const unpublish = () => fs.rm(liveFile(), { force: true });

describe('Grok discover', () => {
  it('drops a pid whose record names a session that started an hour apart', async () => {
    // A force-quit window leaves its record in `live/` for days, and a typed
    // grok can land on the recycled pid. The start is what tells them apart.
    await writeJson(liveFile(), record({ startedAt: fakeStart - 3600_000 }));
    assert.equal(
      (await discoverGrok()).find((s) => s.pid === fake.pid),
      undefined
    );
  });

  it('keeps a grok pid some window published, and drops one nobody did', async () => {
    // Grok states no channel on disk, so the record is the only proof a process
    // is ours. A grok somebody typed at a shell has none, and is not read.
    await unpublish();
    assert.equal(
      (await discoverGrok()).find((s) => s.pid === fake.pid),
      undefined
    );

    await publish();
    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(row);
    assert.equal(row.name, '');
    assert.equal(row.windowId, undefined);
  });

  it('states grok on the row it builds', async () => {
    await publish();
    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(row);
    assert.equal(row.brand, 'grok');
  });

  it('stamps brand from the adapter, and a published record boards the twin', async () => {
    await publish();
    const walked = (await grokAdapter.discover()).find((s) => s.pid === fake.pid);
    assert.ok(walked);
    assert.equal(walked.brand, 'grok');
    const record: PublishedLive = {
      schema: 1,
      session: {
        ...walked,
        source: 'owned',
        brand: 'grok',
        images: true,
        status: 'idle',
        sessionId: 'g1',
        cwd: '/tmp/project',
        name: 'review-pr',
        nameSource: 'ai-title'
      },
      pending: [],
      queued: []
    };
    const [card] = views.foldTwins([], [walked], new Map([[walked.pid, record]]));
    assert.ok(card);
    assert.equal(card.source, 'owned');
    assert.equal(card.brand, 'grok');
    assert.equal(card.name, 'review-pr');
    assert.equal(card.cwd, '/tmp/project');
  });
});

describe('Grok lineage', () => {
  const lineageDir = () => path.join(home, '.squadron', 'lineage');

  async function reset(): Promise<void> {
    await fs.rm(lineageDir(), { recursive: true, force: true });
    await publish();
  }

  /** What the process table says this row started at — the clock the join bounds. */
  async function startedAt(): Promise<number> {
    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(row);
    return row.startedAt;
  }

  async function edge(pid: number, spawnedAt: number, over: object = {}): Promise<void> {
    await writeJson(path.join(lineageDir(), `${pid}.json`), {
      schema: 1,
      parentSessionId: 'parent-1',
      spawnedAt,
      cwd: '/tmp/project',
      requestId: 'req-1',
      ...over
    });
  }

  it('names the parent of a child spawned onto that pid', async () => {
    await reset();
    // The real-world sign, and the whole bug: `ps` states no sub-second field,
    // so the reported start sits *before* the `Date.now()` the edge was stamped
    // at. A floor at zero rejects every owned Grok child.
    await edge(fake.pid, (await startedAt()) + 1000, { originSessionId: 'gen1' });

    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.equal(row?.parentSessionId, 'parent-1');
    assert.equal(row?.originSessionId, 'gen1');
  });

  it('does not hand a row an edge stamped long after it started', async () => {
    await reset();
    await edge(fake.pid, (await startedAt()) + 10_000);

    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.equal(row?.parentSessionId, undefined);
  });

  it('lets a stale edge stamp neither field', async () => {
    await reset();
    await edge(fake.pid, (await startedAt()) - 3600_000, { originSessionId: 'gen1' });

    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.equal(row?.parentSessionId, undefined);
    assert.equal(row?.originSessionId, undefined);
  });

  it('writes no key at all when there is no edge', async () => {
    await reset();

    const row = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(row);
    // Absent, not `undefined`: the row is published as JSON, and an explicit
    // key would survive the round trip as one more thing to test for.
    assert.equal('parentSessionId' in row, false);
    assert.equal('originSessionId' in row, false);
  });

  it('lets the parent stop the child it spawned, and no one else', async () => {
    await reset();
    const walked = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(walked);
    await edge(fake.pid, walked.startedAt + 1000);
    const child = (await discoverGrok()).find((s) => s.pid === fake.pid);
    assert.ok(child);

    const record: PublishedLive = {
      schema: 1,
      session: {
        ...child,
        source: 'owned',
        brand: 'grok',
        images: true,
        status: 'idle',
        sessionId: 'g1',
        cwd: '/tmp/project'
      },
      pending: [],
      queued: []
    };
    const parent: Session = {
      pid: process.pid,
      sessionId: 'parent-1',
      cwd: '/tmp/project',
      name: 'parent',
      status: 'idle',
      hasCommand: false,
      startedAt: child.startedAt - 5000,
      updatedAt: child.startedAt,
      transcript: '',
      source: 'owned'
    };
    const board = [parent, ...views.foldTwins([], [child], new Map([[fake.pid, record]]))];

    const mine = endPlan({ pid: fake.pid }, board, 'parent-1');
    assert.equal(mine.ok, true, mine.ok ? '' : mine.reason);

    // The authority widened by exactly one edge: a session that did not spawn
    // it still cannot reach it.
    const sibling: Session = { ...parent, pid: 1, sessionId: 'sibling-1', name: 'sibling' };
    const theirs = endPlan({ pid: fake.pid }, [...board, sibling], 'sibling-1');
    assert.equal(theirs.ok, false);
  });
});

const commandTodo =
  testPlatform() === 'win32' &&
  'win32: its fixture symlinks a POSIX /bin/sh as the tool shell — W3.2b';
describe(
  'Grok discover reads a running command off the process table',
  { todo: commandTodo },
  () => {
    it('reports a shell child of the grok pid, and none while it has none', async () => {
      // A grok-named `sh` holding a zsh-named `sleep`: the shape the 1.0.46 probe
      // found for a backgrounded tool command. The trailing `:` keeps `sh` from
      // exec'ing its last command away.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-grok-sh-'));
      await fs.symlink('/bin/sh', path.join(dir, 'grok'));
      await fs.symlink('/bin/sleep', path.join(dir, 'zsh'));
      const grok = spawn(path.join(dir, 'grok'), ['-c', `${path.join(dir, 'zsh')} 120; :`], {
        stdio: 'ignore'
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const { scanProcesses } = await import('../../core/scan');
        const startedAt = (await scanProcesses(true)).starts.get(grok.pid ?? 0) ?? 0;
        await writeJson(path.join(home, '.squadron', 'live', `${grok.pid}.json`), {
          ...record(),
          session: { ...record().session, pid: grok.pid, startedAt }
        });
        const busy = (await discoverGrok()).find((s) => s.pid === grok.pid);
        assert.equal(busy?.hasCommand, true);
        await publish();
        const idle = (await discoverGrok()).find((s) => s.pid === fake.pid);
        assert.equal(idle?.hasCommand, false);
      } finally {
        grok.kill('SIGKILL');
        await fs.rm(path.join(home, '.squadron', 'live', `${grok.pid}.json`), { force: true });
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
);

/**
 * No supported Grok install wraps its CLI in a runtime (2026-10-27: the
 * installer drops a native binary), but the join is one rule with Codex's: a
 * native grok under a published runtime root is that root's session.
 */
describe('Grok discovery under a runtime root', () => {
  const ROOT = 2_000_001;
  const NATIVE = 2_000_002;
  const START = 1_700_000_000_000;
  const table = (shells: number[] = []): import('../../core/scan').ProcessTable => ({
    complete: true,
    startSource: testPlatform() === 'win32' ? 'win32-filetime-ms-v1' : 'ps-lstart-v1',
    claude: new Map(),
    codex: new Map(),
    grok: new Map([
      [NATIVE, { pid: NATIVE, ppid: ROOT, command: 'grok agent stdio', startedAt: START + 50 }]
    ]),
    parents: new Map([
      [ROOT, 1],
      [NATIVE, ROOT]
    ]),
    starts: new Map([
      [ROOT, START],
      [NATIVE, START + 50]
    ]),
    groups: new Map(),
    shellParents: new Set(shells)
  });
  const rootFile = () => path.join(home, '.squadron', 'live', `${ROOT}.json`);

  it('boards the root, with a command under the native child as its own', async () => {
    await writeJson(rootFile(), record({ pid: ROOT, startedAt: START }));
    try {
      const idle = (await discoverGrok(table())).find((s) => s.pid === ROOT);
      assert.equal(idle?.startedAt, START);
      assert.equal(idle?.hasCommand, false);
      const busy = (await discoverGrok(table([NATIVE]))).find((s) => s.pid === ROOT);
      assert.equal(busy?.hasCommand, true);
      assert.equal(
        (await discoverGrok(table())).some((s) => s.pid === NATIVE),
        false
      );
    } finally {
      await fs.rm(rootFile(), { force: true });
    }
  });

  it('drops the root when its record is another brand’s', async () => {
    await writeJson(rootFile(), record({ pid: ROOT, startedAt: START, brand: 'codex' }));
    try {
      assert.deepEqual(
        (await discoverGrok(table())).filter((s) => s.pid === ROOT || s.pid === NATIVE),
        []
      );
    } finally {
      await fs.rm(rootFile(), { force: true });
    }
  });
});
