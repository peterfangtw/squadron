import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fakeClaude, fakeShell, FakeProcess, testPlatform } from '../helpers';
import * as perf from '../../core/perf';
import {
  CACHE_MS,
  descendants,
  isClaudeProcess,
  isGrokProcess,
  isShellProcess,
  runsCommand,
  scanProcesses,
  tableCache,
  tableOf,
  wrapperOf
} from '../../core/scan';
import * as incoming from '../../core/incoming';
import type * as processes from '../../core/platform/processes';

/** One process row, as a snapshot reports it. */
function row(pid: number, ppid: number, command: string, pgid?: number): processes.Row {
  return pgid === undefined
    ? { pid, ppid, startedAt: pid * 10, command }
    : { pid, ppid, pgid, startedAt: pid * 10, command };
}

describe('tableOf', () => {
  it('classifies each row once, into the maps every reader shares', () => {
    const table = tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          row(100, 1, '/usr/local/bin/claude --resume', 100),
          row(200, 100, '/bin/zsh -c "npm test"', 200),
          row(300, 1, '/Users/x/.grok/bin/grok agent stdio', 300),
          row(400, 1, '/opt/homebrew/bin/codex app-server', 400)
        ]
      }
    });
    assert.equal(table.complete, true);
    assert.equal(table.startSource, 'ps-lstart-v1');
    assert.deepEqual([...table.claude.keys()], [100]);
    assert.deepEqual([...table.grok.keys()], [300]);
    assert.deepEqual([...table.codex.keys()], [400]);
    assert.deepEqual([...table.shellParents], [100]);
    assert.equal(table.parents.get(200), 100);
    assert.equal(table.starts.get(200), 2000);
    assert.equal(table.groups.get(200), 200);
  });

  it('refuses contradicted shell attribution without erasing observed processes', () => {
    const rows: processes.Row[] = [
      { pid: 100, ppid: 1, startedAt: 2000, command: 'codex app-server' },
      { pid: 200, ppid: 100, pgid: 200, startedAt: 1000, command: 'sh -c old' },
      { pid: 300, ppid: 100, startedAt: 1000, command: 'claude' },
      { pid: 400, ppid: 100, startedAt: 1000, command: 'grok' }
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const table = tableOf({
        supported: true,
        status: 'ok',
        value: { source: 'ps-lstart-v1', rows: ordered }
      });
      assert.equal(table.shellParents.has(100), false);
      assert.equal(table.parents.has(200), true);
      assert.equal(table.parents.size, 4);
      assert.equal(table.parents.get(200), undefined);
      assert.equal(table.starts.get(200), 1000);
      assert.equal(table.groups.get(200), 200);
      assert.equal(table.codex.get(100)?.startedAt, 2000);
      assert.equal(table.claude.get(300)?.ppid, 100);
      assert.equal(table.grok.get(400)?.ppid, 100);
    }
  });

  it('preserves equal starts and unknown evidence for relation and command attribution', () => {
    for (const [parentStart, childStart] of [
      [2000, 2000],
      [1000, 2000],
      [NaN, 1000],
      [2000, NaN],
      [Infinity, 1000],
      [2000, Infinity]
    ] as const) {
      const table = tableOf({
        supported: true,
        status: 'ok',
        value: {
          source: 'ps-lstart-v1',
          rows: [
            { pid: 200, ppid: 100, startedAt: childStart, command: 'sh' },
            { pid: 100, ppid: 1, startedAt: parentStart, command: 'codex' }
          ]
        }
      });
      assert.equal(table.parents.get(200), 100);
      assert.equal(table.shellParents.has(100), true);
      assert.deepEqual(descendants(100, table.parents), [200]);
    }
    for (const source of [undefined, 'future-clock']) {
      const table = tableOf({
        supported: true,
        status: 'ok',
        value: {
          source: source as processes.StartSource,
          rows: [
            { pid: 100, ppid: 1, startedAt: 2000, command: 'codex' },
            { pid: 200, ppid: 100, startedAt: 1000, command: 'sh' }
          ]
        }
      });
      assert.equal(table.parents.get(200), 100);
      assert.equal(table.shellParents.has(100), true);
    }
    const missing = tableOf({
      supported: true,
      status: 'ok',
      value: { source: 'ps-lstart-v1', rows: [row(200, 100, 'sh')] }
    });
    assert.equal(missing.parents.get(200), 100);
    assert.equal(missing.shellParents.has(100), true);
  });

  it('keeps an incomplete snapshot incomplete, with every row it did read', () => {
    // An action on an incomplete table still judges each process by its own
    // row; only a complete one can say a process is gone.
    const table = tableOf({
      supported: true,
      status: 'incomplete',
      reason: 'ps printed 1 unreadable rows',
      value: { source: 'ps-lstart-v1', rows: [row(100, 1, 'claude', 100)] }
    });
    assert.equal(table.complete, false);
    assert.equal(table.startSource, 'ps-lstart-v1');
    assert.equal(table.starts.get(100), 1000);
  });

  it('leaves a process with no reported group out of the groups', () => {
    // A group is signalled as a whole, so one this table did not observe must
    // not be made up from the pid.
    const table = tableOf({
      supported: true,
      status: 'ok',
      value: { source: 'ps-lstart-v1', rows: [row(500, 1, 'sh')] }
    });
    assert.equal(table.starts.get(500), 5000);
    assert.equal(table.groups.has(500), false);
  });

  it('reads no reader as an empty incomplete table that says why, and a failure as empty', () => {
    // Empty parents too: `grok/auth.ts` reads that as a scan that proved nothing.
    const none = tableOf({ supported: false, reason: 'processes.snapshot is unavailable' });
    assert.equal(none.complete, false);
    assert.equal(none.startSource, undefined);
    assert.deepEqual([none.parents.size, none.starts.size, none.groups.size], [0, 0, 0]);
    assert.equal(none.unavailable, 'processes.snapshot is unavailable');

    const failed = tableOf({ supported: true, status: 'failed', reason: 'ps exited 1' });
    assert.equal(failed.complete, false);
    assert.equal(failed.parents.size, 0);
    assert.equal(failed.unavailable, undefined);
  });
});

describe('descendants', () => {
  /** `claude` -> a tool-call shell -> npm -> node, the shape this exists for. */
  const chain = new Map([
    [1, 0],
    [100, 1],
    [200, 100],
    [300, 200],
    [400, 300]
  ]);

  it('returns the whole subtree, deepest first', () => {
    // Deepest first is the contract, not an accident of the walk: a caller
    // signalling this list must never reach a parent before its own child.
    assert.deepEqual(descendants(100, chain), [400, 300, 200]);
  });

  it('is empty for a process that started nothing', () => {
    assert.deepEqual(descendants(400, chain), []);
    assert.deepEqual(descendants(9999, chain), []);
  });

  it('takes every branch, not just the first', () => {
    const forked = new Map([
      [100, 1],
      [200, 100],
      [201, 100],
      [300, 201]
    ]);
    const found = descendants(100, forked);
    assert.deepEqual(new Set(found), new Set([200, 201, 300]));
    assert.equal(found[0], 300, 'the deepest comes first');
  });

  it('terminates on a table that claims a cycle', () => {
    // `ps` cannot report one. A walk that would spin forever if it ever did is
    // not worth the bytes saved by assuming it never will.
    assert.deepEqual(descendants(100, new Map([[100, 100]])), []);
    const loop = new Map([
      [100, 300],
      [200, 100],
      [300, 200]
    ]);
    assert.deepEqual(new Set(descendants(100, loop)), new Set([200, 300]));
  });
});

describe('isClaudeProcess', () => {
  it('matches the CLI however it was invoked', () => {
    assert.equal(isClaudeProcess('claude'), true);
    assert.equal(isClaudeProcess('/usr/local/bin/claude --resume'), true);
    assert.equal(isClaudeProcess('/opt/homebrew/bin/claude -p "hello"'), true);
  });

  it('rejects the CLI’s own background plumbing', () => {
    assert.equal(isClaudeProcess('claude daemon'), false);
    assert.equal(isClaudeProcess('claude bg-pty-host'), false);
    assert.equal(isClaudeProcess('claude --bg-spare'), false);
  });

  it('rejects processes that merely mention it', () => {
    assert.equal(isClaudeProcess('node /path/to/claude'), false);
    assert.equal(isClaudeProcess('/usr/bin/claude-code'), false);
    assert.equal(isClaudeProcess('grep claude'), false);
  });
});

describe('isGrokProcess', () => {
  it('matches the installer name and the versioned download', () => {
    assert.equal(isGrokProcess('grok'), true);
    assert.equal(isGrokProcess('/Users/x/.grok/bin/grok agent --no-leader stdio'), true);
    assert.equal(isGrokProcess('grok-1.0.4-macos-aarch64'), true);
  });

  it('rejects processes that merely mention it', () => {
    assert.equal(isGrokProcess('node /path/to/grok'), false);
    assert.equal(isGrokProcess('grep grok'), false);
  });
});

describe('isShellProcess', () => {
  it('matches the shells a command is run under', () => {
    assert.equal(isShellProcess('/bin/zsh -c "npm test"'), true);
    assert.equal(isShellProcess('/bin/bash'), true);
    assert.equal(isShellProcess('sh -c ls'), true);
    assert.equal(isShellProcess('/opt/homebrew/bin/fish'), true);
  });

  it('rejects the other children a session holds', () => {
    // All observed under a live session: an MCP server, the wake lock the CLI
    // takes, and a plain binary. None of them is a command the user ran.
    assert.equal(isShellProcess('/Users/x/.pencil/mcp/mcp-server-darwin-arm64'), false);
    assert.equal(isShellProcess('caffeinate -i'), false);
    assert.equal(isShellProcess('node /path/to/thing.js'), false);
  });

  it('rejects a name that merely contains one', () => {
    assert.equal(isShellProcess('/usr/bin/sshd'), false);
    assert.equal(isShellProcess('zsh-autosuggestions'), false);
  });
});

describe('tableCache', () => {
  /** A Windows table: no groups, the reader's own clock, a Grok named by its image. */
  const windows = (pid: number): processes.Snapshot => ({
    supported: true,
    status: 'ok',
    value: {
      source: 'win32-filetime-ms-v1',
      rows: [{ pid, ppid: 4, startedAt: 1_792_994_000_000, command: null, image: 'grok.exe' }]
    }
  });

  /** Each read waits until the test settles it, so overlap is the test's to arrange. */
  function source() {
    const reads: Array<(snapshot: processes.Snapshot) => void> = [];
    return {
      reads,
      snapshot: () => new Promise<processes.Snapshot>((resolve) => reads.push(resolve))
    };
  }

  it('shares one read among concurrent callers, then reads again once a second has passed', async () => {
    let now = 0;
    const native = source();
    const scanned = tableCache(native.snapshot, () => now);
    const [a, b] = [scanned(), scanned()];
    assert.equal(native.reads.length, 1, 'a burst is one read');
    native.reads[0]?.(windows(100));
    assert.equal(await a, await b);
    now = CACHE_MS - 1;
    assert.equal(await scanned(), await a);
    assert.equal(native.reads.length, 1);
    now = CACHE_MS;
    const later = scanned();
    assert.equal(native.reads.length, 2, 'a stale table is read again');
    native.reads[1]?.(windows(101));
    assert.notEqual(await later, await a);
    assert.equal((await later).grok.has(101), true);
  });

  it('reads fresh for an action, every time, and lets a display reuse that read', async () => {
    const native = source();
    const scanned = tableCache(native.snapshot, () => 0);
    const shown = scanned();
    native.reads[0]?.(windows(100));
    await shown;
    const [first, second] = [scanned(true), scanned(true)];
    assert.equal(native.reads.length, 3, 'actions never share a read');
    native.reads[1]?.(windows(101));
    native.reads[2]?.(windows(102));
    assert.equal((await first).grok.has(101), true);
    assert.equal(await scanned(), await second, 'the newest fresh read refills the cache');
    assert.equal(native.reads.length, 3);
  });

  it('keeps no failed, unsupported or empty answer, whatever the reader is doing', async () => {
    // A reusable reader in its failure backoff answers at once with a
    // failure: the next caller must read again, not get that for a second.
    const native = source();
    const scanned = tableCache(native.snapshot, () => 0);
    const answers: processes.Snapshot[] = [
      { supported: true, status: 'failed', reason: 'backoff' },
      { supported: false, reason: 'no reader' },
      {
        supported: true,
        status: 'incomplete',
        reason: 'x',
        value: { source: 'win32-filetime-ms-v1', rows: [] }
      }
    ];
    for (const answer of answers) {
      const table = scanned();
      native.reads.at(-1)?.(answer);
      assert.equal((await table).parents.size, 0);
    }
    const table = scanned();
    assert.equal(native.reads.length, 4);
    native.reads[3]?.(windows(100));
    assert.equal((await table).complete, true);
    assert.equal(await scanned(), await table);
  });

  it('lets a late failed read not evict the newer table that replaced it', async () => {
    const native = source();
    const scanned = tableCache(native.snapshot, () => 0);
    const slow = scanned();
    const fresh = scanned(true);
    native.reads[1]?.(windows(101));
    await fresh;
    native.reads[0]?.({ supported: true, status: 'failed', reason: 'timeout' });
    assert.equal((await slow).parents.size, 0);
    assert.equal(await scanned(), await fresh);
    assert.equal(native.reads.length, 2);
  });
});

describe('scanProcesses', () => {
  let fake: FakeProcess;

  before(async () => {
    fake = await fakeClaude();
  });
  after(() => fake.stop());

  it('sees every process, with its parent and start time', async () => {
    const { parents, starts } = await scanProcesses();

    assert.equal(parents.get(process.pid), process.ppid);
    // Parsed, not NaN — the whole `lstart` reconciliation rests on this.
    const started = starts.get(process.pid) ?? 0;
    assert.ok(started > 0 && started <= Date.now() + 1000, `implausible start ${started}`);
  });

  it(
    'reads the process group off the real table',
    { skip: testPlatform() === 'win32' && 'win32: no process groups — W3.4' },
    async () => {
      // Against the machine rather than a fixture, because the column was added to
      // a `ps` invocation whose other fields are position-dependent: a row that
      // parsed before and does not now would take liveness and ancestry with it,
      // and no hand-written row would notice.
      //
      // Checked against a second `ps` rather than a node API, there being none —
      // the runtime exposes `getgid`, which is the *user* group and a different
      // number entirely.
      const { groups } = await scanProcesses();
      const own = Number(
        execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)])
          .toString()
          .trim()
      );
      assert.ok(own > 0, `no process group for ${process.pid}`);
      assert.equal(groups.get(process.pid), own);
    }
  );

  it('picks out live claude processes', async () => {
    const { claude } = await scanProcesses();
    const found = claude.get(fake.pid);
    assert.ok(found, `fake claude ${fake.pid} was not found`);
    assert.equal(found?.ppid, process.pid);
  });

  it(
    'marks a process that is running a shell of its own',
    {
      skip:
        testPlatform() === 'win32' &&
        "win32: this process's own reader is a PowerShell child of it, so the set cannot single out the fixture — windows_consumers covers command status"
    },
    async () => {
      const shell = await fakeShell();
      try {
        const { shellParents } = await scanProcesses(true);
        assert.equal(shellParents.has(process.pid), true, 'this process holds a shell');
        // The shell's own child is `sleep`, not a shell, so it is not in here —
        // the set is "runs a command", not "is somewhere above one".
        assert.equal(shellParents.has(shell.pid), false, 'a shell parenting no shell');
      } finally {
        await shell.stop();
      }
    }
  );

  it('reuses one scan for a burst, then scans again', async () => {
    // Identity, not contents: two tables that merely look alike could each have
    // cost a `ps`, which is the whole thing being avoided. Concurrently, because
    // a cache that only stored the settled result would still double-scan there
    // — and concurrent is what a burst of watcher nudges actually is.
    //
    // Asked inside the interval, which is aged from the request: a cold native
    // read can itself take longer than `CACHE_MS`, so a caller after it settles
    // may correctly read again. The age rules are `tableCache`'s tests above.
    const began = performance.now();
    const first = scanProcesses();
    const racing = scanProcesses();
    const later = scanProcesses();
    assert.ok(performance.now() - began < CACHE_MS);
    assert.equal(racing, first, 'callers racing should share one scan');
    assert.equal(later, first, 'a later caller inside the interval should reuse it too');
    const a = await first;

    const wait = CACHE_MS + 50 - (performance.now() - began);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    assert.notEqual(await scanProcesses(), a, 'a stale scan should be redone');
  });

  it('rescans on demand, for the callers that act on the answer', async () => {
    const cached = await scanProcesses();
    assert.notEqual(await scanProcesses(true), cached, 'fresh should bypass the cache');
  });

  it('lets a display read reuse the table an action just scanned', async () => {
    // A fresh scan is still the shared one: an End's `ps` warms the board.
    // Ask before awaiting: a cold native read can outlast the cache interval,
    // which starts at the action's request, not when its answer arrives.
    const began = performance.now();
    const fresh = scanProcesses(true);
    const display = scanProcesses();
    assert.ok(performance.now() - began < CACHE_MS);
    assert.equal(display, fresh, 'the display should share the action scan');
    assert.equal(await display, await fresh);
  });

  it('dates its own process on the clock persisted identities are decoded on', async () => {
    // An identity minted off this table is written down and read back by
    // another process; a source spelling the decoder refuses loses it.
    const table = await scanProcesses(true);
    const identity = {
      version: 1,
      windowId: 'w',
      pid: process.pid,
      osStartedAt: table.starts.get(process.pid),
      startSource: table.startSource,
      incarnation: '00000000-0000-4000-8000-000000000000'
    };
    const decoded = incoming.readHostIdentity(JSON.parse(JSON.stringify(identity)));
    assert.ok(decoded, 'the decoder refused an identity from a real table');
    assert.equal(incoming.ownerDead(decoded, table), false);
  });

  it('counts each ps it spawns, and none for a read the cache answered', async () => {
    perf.reset();
    const began = performance.now();
    const fresh = scanProcesses(true);
    const display = scanProcesses();
    assert.ok(performance.now() - began < CACHE_MS);
    assert.equal(display, fresh, 'the cached read must not start another scan');
    await Promise.all([fresh, display]);
    assert.match(perf.report(), /ps\s.*\b1 calls/);
    await scanProcesses(true);
    assert.match(perf.report(), /ps\s.*\b2 calls/);
  });
});

/**
 * An npm-installed Codex, observed 2026-10-27 on macOS: the spawned and
 * published pid is `node …/bin/codex.js`, and the native `codex` is its child.
 * Its tool shells are the native child's. Windows' `followShim` starts the
 * same `node.exe codex.js` root.
 */
describe('a runtime root and its native CLI', () => {
  const wrapped = (rows: processes.Row[] = []) =>
    tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          row(100, 1, 'node /Users/me/.npm/bin/codex app-server --listen stdio://'),
          row(
            101,
            100,
            '/Users/me/.npm/lib/@openai/codex-darwin-arm64/vendor/bin/codex app-server'
          ),
          ...rows
        ]
      }
    });

  it('names the root a recognized CLI was started under', () => {
    const table = wrapped();
    const native = table.codex.get(101);
    assert.ok(native);
    assert.equal(wrapperOf(table, native), 100);
  });

  it('names no root for a CLI whose parent is itself a CLI', () => {
    // A native codex re-executes itself for its helpers; the helper is not a
    // session under a wrapper.
    const table = wrapped([row(102, 101, '/Users/me/.npm/vendor/bin/codex sandbox')]);
    const helper = table.codex.get(102);
    assert.ok(helper);
    assert.equal(wrapperOf(table, helper), undefined);
  });

  it('names no root across a refuted parent edge', () => {
    // A parent younger than its child is a recycled pid, not the wrapper.
    const table = tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          { pid: 100, ppid: 1, startedAt: 5_000, command: 'node /x/codex.js app-server' },
          { pid: 101, ppid: 100, startedAt: 1_000, command: '/x/vendor/bin/codex app-server' }
        ]
      }
    });
    const native = table.codex.get(101);
    assert.ok(native);
    assert.equal(wrapperOf(table, native), undefined);
  });

  it('reads a command under the native child as the root session’s', () => {
    const table = wrapped([row(103, 101, '/bin/zsh -c "npm test"')]);
    assert.equal(runsCommand(table, 100, 'codex'), true);
    assert.equal(runsCommand(wrapped(), 100, 'codex'), false);
  });

  it('reads a command under the root itself, wrapped or not', () => {
    assert.equal(runsCommand(wrapped([row(103, 100, '/bin/zsh -c ls')]), 100, 'codex'), true);
    assert.equal(runsCommand(wrapped([row(103, 101, '/bin/zsh -c ls')]), 101, 'codex'), true);
  });

  it('does not read another brand’s CLI child, or any other child, as the root’s command', () => {
    const other = tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          row(100, 1, 'node /x/runner.js'),
          row(101, 100, '/usr/local/bin/claude --print'),
          row(102, 101, '/bin/zsh -c ls'),
          row(104, 100, 'node /x/worker.js'),
          row(105, 104, '/bin/zsh -c ls')
        ]
      }
    });
    assert.equal(runsCommand(other, 100, 'codex'), false);
  });

  it('does not reach through a native root into its own CLI helpers', () => {
    // Direct launch: the root is the CLI, and only its own shells are its.
    const table = wrapped([
      row(102, 101, '/x/vendor/bin/codex sandbox'),
      row(103, 102, '/bin/zsh -c ls')
    ]);
    assert.equal(runsCommand(table, 101, 'codex'), false);
  });
});
