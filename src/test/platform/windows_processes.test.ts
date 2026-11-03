/**
 * Step 1 controls for Windows process observation: the facts recorded in
 * docs/reference/cli_state/claude/processes.md and process_signals.md
 * (2026-10-26) that the reader, scan and signal steps build on.
 */

import * as assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as control from '../../core/control';
import * as scan from '../../core/scan';
import type * as processes from '../../core/platform/processes';
import * as darwin from '../../core/platform/processes/darwin';
import * as win32 from '../../core/platform/processes/win32';
import * as reader from '../../core/platform/processes/win32_reader';
import * as helpers from '../helpers';

const NONCE = 'b'.repeat(32);
/** Fixture children and the reader's PowerShell run with this home and its temp. */
let home: string;

before(async () => {
  home = await helpers.tempHome();
});

// Every fixture's disposal has confirmed its processes gone by now.
after(() => fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const nativeSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows process table';

function row(
  pid: number,
  ppid: number,
  dmtf: string,
  command: string | null,
  image: string | null = null
): string {
  return `${pid} ${ppid} ${filetime(dmtf)} ${field(image)} ${field(command)}`;
}

function field(value: string | null): string {
  return value === null ? '-' : `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
}

/** A sample recorded in DMTF, as the FILETIME the reader carries; `?` stays unusable. */
function filetime(dmtf: string): string {
  if (dmtf === '?') return dmtf;
  const ms = reader.dmtfToUnixMs(dmtf);
  assert.ok(ms !== undefined, dmtf);
  const subMs = BigInt(Number(dmtf.slice(15, 21)) % 1000) * 10n;
  return String(BigInt(ms) * 10_000n + subMs + 116_444_736_000_000_000n);
}

function frame(
  rows: string[],
  kernel = `kernel 4 0 ${filetime('20261026121319.721000+480')}`
): string {
  return [
    `v3 ${NONCE}`,
    'self 10',
    kernel,
    `count ${rows.length}`,
    ...rows,
    `end ${NONCE} ${rows.length}`,
    ''
  ].join('\n');
}

const KERNEL = row(4, 0, '20261026121319.721000+480', null);
const SELF = row(10, 4, '20261026140000.000000+480', 'powershell');

/** Spellings WMI reported on 2026-10-26 for launches of each brand and tool shell. */
const OBSERVED = {
  nodeSpawnedClaude: 'C:/Users/me/.local/bin/claude.exe -p --input-format stream-json',
  ideSpawnedClaude: 'C:\\Users\\me\\.local\\bin\\claude.exe --print --verbose',
  cmdWrappedClaude: '"C:/Users/me/.local/bin/claude.exe"  -p --input-format stream-json',
  grokAcp: 'C:/Users/me/.grok/bin/grok.exe agent --no-leader stdio',
  grokUpdater: '"C:\\Users\\me\\.grok\\bin\\grok.exe" update --trigger=auto_background',
  codexAppServer: 'C:/Users/me/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe app-server',
  claudeToolLauncher:
    '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1-x.sh"',
  claudeToolShell:
    '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1-x.sh"',
  grokToolShell:
    '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "ping -n 10 127.0.0.1"',
  conhost: '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4',
  /** Step 3's Codex probe: `codex exec`'s tool call, a newline inside its quotes. */
  codexToolShell:
    '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nping -n 10 127.0.0.1"',
  codexModeHost:
    '"C:\\Users\\me\\.codex\\packages\\standalone\\releases\\0.163.0-x86_64-pc-windows-msvc\\bin\\codex-code-mode-host.exe"',
  ping: '"C:\\WINDOWS\\system32\\PING.EXE" -n 10 127.0.0.1'
};

describe('Windows process facts the later steps depend on', () => {
  it('keeps a start-less row out of the table and a command-less row in it', () => {
    const read = reader.parseFrame(
      frame([
        KERNEL,
        SELF,
        row(20, 10, '?', 'claude'),
        row(21, 10, '20261026140001.000000+480', null)
      ]),
      NONCE
    );
    assert.equal(read.status, 'incomplete');
    if (read.status !== 'incomplete') return;
    assert.equal(read.reason, '1 rows had no usable start');
    // Missing identity: no row at all, so nothing can match it later.
    assert.equal(
      read.value.rows.some((item) => item.pid === 20),
      false
    );
    // Missing command metadata: still a process with an identity.
    assert.deepEqual(
      read.value.rows.find((item) => item.pid === 21),
      { pid: 21, ppid: 10, startedAt: Date.UTC(2026, 9, 26, 6, 0, 1), image: null, command: null }
    );
  });

  it('tells an incomplete acquisition from a failed one', () => {
    const missingKernel = reader.parseFrame(frame([SELF], 'kernel missing'), NONCE);
    assert.equal(missingKernel.status, 'incomplete');
    assert.equal(
      missingKernel.status === 'incomplete' && missingKernel.reason,
      'kernel witness missing'
    );
    const truncated = reader.parseFrame(frame([KERNEL, SELF]).replace(/end .*\n$/, ''), NONCE);
    assert.deepEqual(truncated, {
      supported: true,
      status: 'failed',
      reason: 'truncated frame'
    });
  });

  it('reports a gone or younger parent as WMI gave it, without judging the edge', () => {
    // 2026-10-26: `Secure System` and `Registry` were created 4 s before their
    // parent, pid 4. A user child whose parent number now names a younger
    // process looks the same. A missing parent row is a gone parent.
    const read = reader.parseFrame(
      frame([
        KERNEL,
        SELF,
        row(236, 4, '20261026121315.576000+480', null),
        row(30, 10, '20261026135900.000000+480', 'node child'),
        row(31, 999, '20261026135900.000000+480', 'node orphan')
      ]),
      NONCE
    );
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    const byPid = new Map(read.value.rows.map((item) => [item.pid, item]));
    assert.equal(byPid.get(236)?.ppid, 4);
    assert.ok((byPid.get(236)?.startedAt ?? 0) < (byPid.get(4)?.startedAt ?? 0));
    assert.equal(byPid.get(30)?.ppid, 10);
    assert.ok((byPid.get(10)?.startedAt ?? 0) > (byPid.get(30)?.startedAt ?? 0));
    assert.equal(byPid.get(31)?.ppid, 999);
    assert.equal(byPid.has(999), false);
  });

  it('refutes a younger parent only on the ps clock, so kernel-born rows would also be refuted there', () => {
    const snapshot = {
      supported: true as const,
      status: 'ok' as const,
      value: {
        source: 'ps-lstart-v1' as const,
        rows: [
          { pid: 4, ppid: 0, startedAt: 2_000, command: 'System' },
          { pid: 236, ppid: 4, startedAt: 1_000, command: 'Secure System' }
        ]
      }
    };
    const table = scan.tableOf(snapshot);
    assert.equal(table.parents.has(236), true);
    assert.equal(table.parents.get(236), undefined);
    assert.equal(scan.descendants(4, table.parents).length, 0);
  });

  it('leaves the POSIX readers of a ps table blind to Windows spellings', () => {
    // The Windows names are read only off a Windows table (below); a ps row
    // keeps its own grammar, so macOS classification is unchanged.
    for (const command of [
      OBSERVED.nodeSpawnedClaude,
      OBSERVED.ideSpawnedClaude,
      OBSERVED.cmdWrappedClaude
    ])
      assert.equal(scan.isClaudeProcess(command), false, command);
    for (const command of [OBSERVED.grokAcp, OBSERVED.grokUpdater])
      assert.equal(scan.isGrokProcess(command), false, command);
    for (const command of [
      OBSERVED.claudeToolLauncher,
      OBSERVED.claudeToolShell,
      OBSERVED.grokToolShell,
      OBSERVED.conhost
    ])
      assert.equal(scan.isShellProcess(command), false, command);
    const table = scan.tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          { pid: 40, ppid: 1, startedAt: 1_000, command: OBSERVED.codexAppServer },
          { pid: 41, ppid: 1, startedAt: 1_000, command: '/usr/local/bin/codex app-server' }
        ]
      }
    });
    assert.deepEqual([...table.codex.keys()], [41]);
  });

  it('kills nothing on evidence that names no clock, even an exact row in a complete table', () => {
    const sent: number[] = [];
    const processes = win32.processes(helpers.tablesSupplied((pid) => sent.push(pid)));
    assert.equal(processes.signals.supported, true);
    const evidence = {
      complete: true,
      starts: new Map([[30, 1_792_994_000_000]]),
      groups: new Map<number, number>()
    };
    const member = [{ pid: 30, startedAt: 1_792_994_000_000 }];
    const [stop] = processes.signal(member, 'stop', evidence);
    assert.equal(typeof stop === 'object' && !stop.supported, true);
    assert.deepEqual(processes.signal(member, 'kill', evidence), ['absent']);
    assert.deepEqual(sent, []);
  });

  it('cleans up a fixture whose setup fails, before the failure settles', async () => {
    // Readiness never comes: the root and its child start, then setup times out.
    let stalled: Tree | undefined;
    await assert.rejects(
      withTree({ kids: [{ name: 'child', detached: true }] }, async () => {}, {
        ready: ['root', 'child', 'never'],
        readyMs: 1_000,
        created: (tree) => (stalled = tree)
      }),
      /fixture did not reach its state/
    );
    assert.ok(stalled);
    assert.deepEqual(stalled.ended.map(([name]) => name).sort(), ['child', 'root']);
    for (const [, pid] of stalled.ended) assert.equal(alive(pid), false, `pid ${pid} still alive`);
    assert.equal(fs.existsSync(stalled.dir), false);

    // The executable cannot start at all.
    let unstarted: Tree | undefined;
    await assert.rejects(
      withTree({ kids: [] }, async () => {}, {
        executable: path.join(os.tmpdir(), 'squadron-missing-node'),
        created: (tree) => (unstarted = tree)
      }),
      /ENOENT/
    );
    assert.ok(unstarted);
    assert.deepEqual(unstarted.ended, []);
    assert.equal(fs.existsSync(unstarted.dir), false);
    await unstarted.dispose();
  });

  it(
    'shows a detached descendant outliving its root with the dead parent number',
    { skip: nativeSkip },
    () =>
      withTree(
        {
          kids: [
            { name: 'detached', detached: true },
            { name: 'attached', detached: false }
          ]
        },
        async (tree) => {
          const before = await readNative();
          const root = byPid(before, tree.root.pid);
          assert.ok(root, 'root missing from the first table');
          assert.equal(byPid(before, tree.pid('detached'))?.ppid, tree.root.pid);
          assert.equal(byPid(before, tree.pid('attached'))?.ppid, tree.root.pid);

          tree.root.kill();
          await tree.closed;
          await waitUntil(() => !alive(tree.pid('attached')));

          const after = await readNative();
          const rootAfter = byPid(after, tree.root.pid);
          assert.ok(rootAfter === undefined || rootAfter.startedAt !== root.startedAt);
          // Measured outcome only: the non-detached child ended with its Node
          // parent; the detached one did not, and still names that parent.
          assert.equal(byPid(after, tree.pid('attached')), undefined);
          assert.equal(byPid(after, tree.pid('detached'))?.ppid, tree.root.pid);
        }
      )
  );

  it('does not see a descendant started after the table was read', { skip: nativeSkip }, () =>
    withTree(
      { kids: [{ name: 'late', detached: true, after: 'go' }] },
      async (tree) => {
        const before = await readNative();
        assert.ok(byPid(before, tree.root.pid));
        assert.equal(tree.pidMaybe('late'), undefined, 'late child started before the first read');
        await tree.touch('go');
        await waitUntil(() => tree.pidMaybe('late') !== undefined);
        const after = await readNative();
        assert.equal(byPid(after, tree.pid('late'))?.ppid, tree.root.pid);
        assert.equal(byPid(before, tree.pid('late')), undefined);
      },
      { ready: ['root'] }
    )
  );

  it('reads pid 4 with no command line in a complete table', { skip: nativeSkip }, async () => {
    const table = await readNative();
    const kernel = byPid(table, 4);
    assert.ok(kernel);
    assert.equal(kernel.command, null);
    assert.ok(table.rows.every((item) => Number.isSafeInteger(item.startedAt)));
  });
});

/** A Windows identity on the sample day, in `win32-filetime-ms-v1` milliseconds. */
const WIN_START = 1_792_994_000_000;

function windowsEvidence(
  rows: Array<[number, number]>,
  extra: Partial<processes.Evidence> = {}
): processes.Evidence {
  return {
    complete: true,
    startSource: 'win32-filetime-ms-v1',
    starts: new Map(rows),
    groups: new Map(),
    ...extra
  };
}

/** The unselected Windows ending, its `kill` effect recorded and failing as `throws` says. */
function recordedEnding(throws: Record<number, string | Error> = {}): {
  sent: Array<[number, NodeJS.Signals]>;
  ending: Pick<processes.Processes, 'signals' | 'signal'>;
} {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const ending = win32.signalling({
    kill: (pid, signal) => {
      sent.push([pid, signal]);
      const failure = throws[pid];
      if (failure instanceof Error) throw failure;
      if (failure) throw Object.assign(new Error(`kill ${failure}`), { code: failure });
    }
  });
  return { sent, ending };
}

describe('Windows guarded ending, on supplied evidence', () => {
  it('ends only exact members on this clock, by pid, with TerminateProcess', () => {
    const { sent, ending } = recordedEnding();
    assert.deepEqual(ending.signals, { supported: true });
    const members = [
      { pid: 40, startedAt: WIN_START },
      // A remembered "leader" is still one pid: Windows has no group to signal.
      { pid: 44, pgid: 44, startedAt: WIN_START + 1 }
    ];
    const evidence = windowsEvidence(
      [
        [40, WIN_START],
        [44, WIN_START + 1]
      ],
      { groups: new Map([[44, 44]]) }
    );
    assert.deepEqual(ending.signal(members, 'kill', evidence), ['sent', 'sent']);
    assert.deepEqual(ending.signal(members, 'kill', evidence, { alone: true }), ['sent', 'sent']);
    assert.deepEqual(sent, [
      [40, 'SIGKILL'],
      [44, 'SIGKILL'],
      [40, 'SIGKILL'],
      [44, 'SIGKILL']
    ]);

    // The same numbers on another clock, or on none, prove nothing here.
    sent.length = 0;
    const posix = { ...evidence, startSource: 'ps-lstart-v1' as const };
    const untagged = { ...evidence, startSource: undefined };
    assert.deepEqual(ending.signal(members, 'kill', posix), ['absent', 'absent']);
    assert.deepEqual(ending.signal(members, 'kill', untagged), ['absent', 'absent']);
    assert.deepEqual(sent, []);
  });

  it('refuses a recycled or missing member and the kernel pids, sending nothing', () => {
    const { sent, ending } = recordedEnding();
    const evidence = windowsEvidence([
      [0, WIN_START],
      [4, WIN_START],
      [40, WIN_START]
    ]);
    const outcomes = ending.signal(
      [
        { pid: 40, startedAt: WIN_START + 1 },
        { pid: 48, startedAt: WIN_START },
        { pid: 0, startedAt: WIN_START },
        { pid: 4, startedAt: WIN_START },
        { pid: -40, startedAt: WIN_START },
        { pid: 40.5, startedAt: WIN_START },
        { pid: Number.NaN, startedAt: WIN_START }
      ],
      'kill',
      evidence
    );
    assert.deepEqual(outcomes, Array(7).fill('absent'));
    assert.deepEqual(sent, []);
  });

  it('acts on an exact row of an incomplete table, as the reap does', () => {
    // Completeness is the caller's gate: one unreadable row elsewhere spares
    // no member whose own row still matches (Darwin's reap rule, kept).
    const { sent, ending } = recordedEnding();
    const evidence = windowsEvidence([[40, WIN_START]], { complete: false });
    assert.deepEqual(ending.signal([{ pid: 40, startedAt: WIN_START }], 'kill', evidence), [
      'sent'
    ]);
    assert.deepEqual(sent, [[40, 'SIGKILL']]);
  });

  it('answers stop as unsupported, because TerminateProcess asks nothing to flush', () => {
    const { sent, ending } = recordedEnding();
    const evidence = windowsEvidence([[40, WIN_START]]);
    const outcomes = ending.signal(
      [
        { pid: 40, startedAt: WIN_START },
        { pid: 44, startedAt: WIN_START }
      ],
      'stop',
      evidence
    );
    assert.equal(outcomes.length, 2);
    for (const outcome of outcomes) {
      assert.equal(typeof outcome === 'object' && outcome.supported, false);
      assert.match(
        typeof outcome === 'object' ? outcome.reason : '',
        /^processes\.signal stop is unavailable on win32: .*not a flush request/
      );
    }
    assert.deepEqual(sent, []);
  });

  it('maps what the OS answered and never throws', () => {
    const { ending } = recordedEnding({
      40: 'ESRCH',
      44: 'EPERM',
      48: 'EACCES',
      52: new Error('no code')
    });
    const evidence = windowsEvidence([
      [40, WIN_START],
      [44, WIN_START],
      [48, WIN_START],
      [52, WIN_START]
    ]);
    const members = [40, 44, 48, 52].map((pid) => ({ pid, startedAt: WIN_START }));
    assert.deepEqual(ending.signal(members, 'kill', evidence), [
      'absent',
      'refused',
      'refused',
      'refused'
    ]);
  });
});

describe('Windows guarded ending, on native fixture trees', () => {
  /** The selected ending, its kills recorded; these tests read their own tables. */
  const windows = (kill: (pid: number) => void = () => {}): processes.Processes =>
    win32.processes(
      helpers.tablesSupplied((pid, signal) => {
        kill(pid);
        process.kill(pid, signal);
      })
    );

  it(
    'ends a tree deepest first by start-checked TerminateProcess, root last',
    { skip: nativeSkip },
    () =>
      withTree(
        {
          kids: [{ name: 'child', detached: true, kids: [{ name: 'grandchild', detached: true }] }]
        },
        async (tree) => {
          const root = tree.root.pid;
          assert.ok(root);
          const { table, rows } = await readBoth();
          const members = control.snapshotTree(root, table);
          // Each console Node also owns a conhost: an ordinary member (decision 3).
          assert.deepEqual(
            members.map((member) => member.pid).filter((pid) => !isConhost(rows, pid)),
            [tree.pid('grandchild'), tree.pid('child')]
          );
          assert.ok(members.every((member) => !('pgid' in member)));
          const order: number[] = [];
          assert.equal(
            control.closeTree(
              root,
              members,
              table,
              undefined,
              windows((pid) => order.push(pid))
            ),
            true
          );
          assert.deepEqual(order, [...members.map((member) => member.pid), root]);
          await tree.closed;
          // Detached members are in no job, so only our own TerminateProcess ends them.
          await waitUntil(() => members.every((member) => !alive(member.pid)));
          const after = await readTable();
          for (const { pid, startedAt } of [
            ...members,
            { pid: root, startedAt: table.starts.get(root) }
          ])
            assert.notEqual(after.starts.get(pid), startedAt, `${pid} still has its identity`);
        }
      )
  );

  it('refuses a recycled member natively and leaves it running', { skip: nativeSkip }, () =>
    withTree({ kids: [{ name: 'child', detached: true }] }, async (tree) => {
      const table = await readTable();
      const child = tree.pid('child');
      const startedAt = table.starts.get(child);
      assert.ok(startedAt !== undefined);
      const ending = windows();
      assert.deepEqual(ending.signal([{ pid: child, startedAt: startedAt + 1 }], 'kill', table), [
        'absent'
      ]);
      assert.deepEqual(
        ending.signal([{ pid: child, startedAt }], 'kill', {
          ...table,
          startSource: 'ps-lstart-v1'
        }),
        ['absent']
      );
      assert.equal(alive(child), true);
    })
  );

  it(
    'leaves a descendant started after the read unsignalled and visible to the next read',
    { skip: nativeSkip },
    () =>
      withTree(
        { kids: [{ name: 'late', detached: true, after: 'go' }] },
        async (tree) => {
          const root = tree.root.pid;
          assert.ok(root);
          const { table, rows } = await readBoth();
          await tree.touch('go');
          await waitUntil(() => tree.pidMaybe('late') !== undefined);
          const late = tree.pid('late');
          const members = control.snapshotTree(root, table);
          assert.ok(members.every((member) => isConhost(rows, member.pid)));
          assert.equal(control.closeTree(root, members, table, undefined, windows()), true);
          await tree.closed;
          // Unresolved, not contained: the late child outlives its root, and
          // only a later read finds it, through the dead root's number.
          const after = await readTable();
          assert.equal(alive(late), true);
          assert.ok(scan.descendants(root, after.parents).includes(late));
        },
        { ready: ['root'] }
      )
  );
});

/** 14:mm:ss local (+480) on the sample day, `ms` past it. */
function at(seconds: number, ms = 0): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `2026102614${mm}${ss}.${String(ms * 1000).padStart(6, '0')}+480`;
}

/** A WMI frame, through the shared snapshot the capability will publish, into scan. */
function windowsTable(rows: string[]): scan.ProcessTable {
  return scan.tableOf(win32.snapshotOf(reader.parseFrame(frame([KERNEL, SELF, ...rows]), NONCE)));
}

const NODE_WRAPPER =
  '"C:\\Program Files\\nodejs\\node.exe" -e "require(\'child_process\').spawn(\'C:/Users/me/.local/bin/claude.exe\')"';

describe('Windows rows through scan', () => {
  for (const first of ['"daemon"', '"--bg-pty-host"'])
    it(`excludes Claude plumbing with first argument ${first}`, () => {
      const table = windowsTable([row(100, 10, at(1), `claude.exe ${first}`, 'claude.exe')]);
      assert.equal(table.claude.has(100), false);
    });

  it('folds image case and fails closed on an ambiguous image-less program', () => {
    const table = windowsTable([
      row(100, 10, at(1), 'CLAUDE.EXE -p', 'CLAUDE.EXE'),
      row(110, 10, at(1), 'Grok.exe agent stdio', 'Grok.exe'),
      row(111, 110, at(2), 'POWERSHELL.EXE -Command ping', 'POWERSHELL.EXE'),
      // Without an image, an unquoted space in argv0 intentionally fails closed.
      row(120, 10, at(1), 'C:\\Program Files\\Codex\\codex.exe exec', null)
    ]);
    assert.deepEqual([...table.claude.keys()], [100]);
    assert.deepEqual([...table.grok.keys()], [110]);
    assert.equal(table.shellParents.has(110), true);
    assert.equal(table.codex.size, 0);
  });

  for (const command of ['claude.exe --type=renderer', 'claude.exe -p'])
    it(`refuses a stale Claude pid file against a different Windows start: ${command}`, async (t) => {
      const discover = await import('../../core/claude/discover');
      const table = windowsTable([row(100, 10, at(60), command, 'claude.exe')]);
      assert.equal(table.claude.has(100), true);
      t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table));
      const file = path.join(home, '.claude', 'sessions', '100.json');
      try {
        await helpers.writeJson(file, {
          pid: 100,
          sessionId: 'stale',
          entrypoint: 'sdk-cli',
          cwd: home,
          procStart: helpers.utcProcStart(reader.dmtfToUnixMs(at(1)) ?? 0)
        });
        assert.deepEqual(await discover.discover(), []);
      } finally {
        await fs.promises.rm(file, { force: true });
      }
    });

  it('requires a Windows start even when a Claude pid file omits procStart', async (t) => {
    const discover = await import('../../core/claude/discover');
    const table = windowsTable([row(100, 10, at(1), 'claude.exe -p', 'claude.exe')]);
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table));
    const file = path.join(home, '.claude', 'sessions', '100.json');
    try {
      await helpers.writeJson(file, {
        pid: 100,
        sessionId: 'missing',
        entrypoint: 'sdk-cli',
        cwd: home
      });
      assert.deepEqual(await discover.discover(), []);
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  });

  it('keeps a Windows Claude pid file whose process start matches', async (t) => {
    const discover = await import('../../core/claude/discover');
    const table = windowsTable([row(100, 10, at(1, 500), 'claude.exe -p', 'claude.exe')]);
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table));
    const file = path.join(home, '.claude', 'sessions', '100.json');
    try {
      await helpers.writeJson(file, {
        pid: 100,
        sessionId: 'matching',
        entrypoint: 'sdk-cli',
        cwd: home,
        // The CLI's win32 spelling: the same FILETIME the Windows table carries.
        procStart: filetime(at(1, 500))
      });
      assert.deepEqual(
        (await discover.discover()).map((session) => session.pid),
        [100]
      );
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  });

  it('names each brand from its image and its quoted, slashed or backslashed command', () => {
    const table = windowsTable([
      row(100, 10, at(1), OBSERVED.nodeSpawnedClaude, 'claude.exe'),
      row(101, 10, at(1), OBSERVED.ideSpawnedClaude, 'claude.exe'),
      row(102, 10, at(1), OBSERVED.cmdWrappedClaude, 'claude.exe'),
      // WMI gave no image: the command's program token still names the file.
      row(103, 10, at(1), OBSERVED.nodeSpawnedClaude, null),
      // Internal plumbing stays out, and a Claude whose arguments are unknown
      // cannot be told apart from it.
      row(104, 10, at(1), 'C:\\Users\\me\\.local\\bin\\claude.exe daemon', 'claude.exe'),
      row(105, 10, at(1), null, 'claude.exe'),
      row(110, 10, at(1), OBSERVED.grokAcp, 'grok.exe'),
      row(111, 110, at(2), OBSERVED.grokUpdater, 'grok.exe'),
      // The second updater run had no command line, only its versioned image.
      row(112, 110, at(2), null, 'grok-1.0.70-windows-x86_64.exe'),
      row(120, 10, at(1), OBSERVED.codexAppServer, 'codex.exe'),
      row(121, 120, at(2), OBSERVED.codexModeHost, 'codex-code-mode-host.exe'),
      // A runtime wrapper is the wrapper, not the CLI it starts.
      row(130, 10, at(1), NODE_WRAPPER, 'node.exe'),
      row(131, 130, at(2), OBSERVED.nodeSpawnedClaude, 'claude.exe'),
      row(140, 100, at(2), OBSERVED.conhost, 'conhost.exe')
    ]);
    assert.equal(table.complete, true);
    assert.equal(table.startSource, 'win32-filetime-ms-v1');
    assert.deepEqual([...table.claude.keys()].sort(), [100, 101, 102, 103, 131]);
    assert.deepEqual([...table.grok.keys()].sort(), [110, 111, 112]);
    assert.deepEqual([...table.codex.keys()], [120]);
    assert.equal(table.claude.get(100)?.ppid, 10);
    assert.equal(table.grok.get(112)?.command, null);
    // The reader's own PowerShell is a shell below whoever started it; only a
    // CLI's pid is ever asked whether it runs one.
    assert.deepEqual([...table.shellParents], [4]);
  });

  it('gives each brand command status from its observed tool chain, never from conhost or the updater', () => {
    const table = windowsTable([
      // Claude: Git's launcher bash, then MSYS's bash twice, then the command.
      row(200, 10, at(10), OBSERVED.ideSpawnedClaude, 'claude.exe'),
      row(201, 200, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(202, 200, at(11), OBSERVED.claudeToolLauncher, 'bash.exe'),
      row(203, 202, at(11), OBSERVED.claudeToolShell, 'bash.exe'),
      row(204, 203, at(11), OBSERVED.conhost, 'conhost.exe'),
      row(205, 203, at(11), OBSERVED.claudeToolShell, 'bash.exe'),
      row(206, 205, at(12), OBSERVED.ping, 'PING.EXE'),
      // Grok: a bare "powershell.exe".
      row(300, 10, at(10), 'C:/Users/me/.grok/bin/grok.exe -p "x"', 'grok.exe'),
      row(301, 300, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(302, 300, at(11), OBSERVED.grokToolShell, 'powershell.exe'),
      row(303, 302, at(11), OBSERVED.conhost, 'conhost.exe'),
      row(304, 302, at(12), OBSERVED.ping, 'PING.EXE'),
      // Codex: the absolute Windows PowerShell beside its code-mode host.
      row(
        400,
        10,
        at(10),
        'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe exec',
        'codex.exe'
      ),
      row(401, 400, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(402, 400, at(11), OBSERVED.codexModeHost, 'codex-code-mode-host.exe'),
      row(403, 402, at(11), OBSERVED.conhost, 'conhost.exe'),
      row(404, 400, at(11), OBSERVED.codexToolShell, 'powershell.exe'),
      row(405, 404, at(11), OBSERVED.conhost, 'conhost.exe'),
      row(406, 404, at(12), OBSERVED.ping, 'PING.EXE'),
      // Idle: a console host only, and Grok's updater with its own.
      row(500, 10, at(10), OBSERVED.nodeSpawnedClaude, 'claude.exe'),
      row(501, 500, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(600, 10, at(10), OBSERVED.grokAcp, 'grok.exe'),
      row(601, 600, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(602, 600, at(11), OBSERVED.grokUpdater, 'grok.exe'),
      row(603, 602, at(11), OBSERVED.conhost, 'conhost.exe')
    ]);
    for (const pid of [200, 300, 400]) assert.equal(table.shellParents.has(pid), true, `${pid}`);
    for (const pid of [500, 600, 602]) assert.equal(table.shellParents.has(pid), false, `${pid}`);
    // The launcher and the first MSYS bash each run a shell too, as nested
    // shells do on POSIX; only the CLI's own pid is ever asked.
    assert.deepEqual(
      [...table.shellParents].sort((a, b) => a - b),
      [4, 200, 202, 203, 300, 400]
    );
    // conhost and the updater are still ordinary descendants to clean up.
    assert.deepEqual(new Set(scan.descendants(600, table.parents)), new Set([601, 602, 603]));
    const claudeTree = scan.descendants(200, table.parents);
    assert.deepEqual(new Set(claudeTree), new Set([201, 202, 203, 204, 205, 206]));
    assert.equal(claudeTree[0], 206, 'the deepest comes first');
  });

  it('refutes a recycled or kernel-born parent on the Windows clock, with no pid-4 exemption', () => {
    const table = windowsTable([
      // The number 710 now names a grok younger than the shell that kept it.
      row(700, 710, at(60), OBSERVED.grokToolShell, 'powershell.exe'),
      row(701, 700, at(61), OBSERVED.ping, 'PING.EXE'),
      row(710, 10, at(120), OBSERVED.grokAcp, 'grok.exe'),
      row(740, 750, at(60), OBSERVED.claudeToolLauncher, 'bash.exe'),
      row(750, 10, at(120), OBSERVED.ideSpawnedClaude, 'claude.exe'),
      // 2026-10-26: `Secure System` was created 4 s before pid 4.
      row(236, 4, '20261026121315.576000+480', null, 'Secure System'),
      // The same millisecond is not a contradiction.
      row(720, 10, at(130, 5), OBSERVED.grokAcp, 'grok.exe'),
      row(721, 720, at(130, 5), OBSERVED.grokToolShell, 'powershell.exe'),
      // A parent missing from the table is unknown evidence, not refutation.
      row(730, 999, at(130), OBSERVED.grokToolShell, 'powershell.exe')
    ]);
    for (const pid of [700, 740, 236]) {
      assert.equal(table.parents.has(pid), true, `${pid} stays present`);
      assert.equal(table.parents.get(pid), undefined, `${pid}'s edge is refuted`);
    }
    assert.deepEqual(scan.descendants(710, table.parents), []);
    assert.deepEqual(scan.descendants(750, table.parents), []);
    assert.equal(scan.descendants(4, table.parents).includes(236), false);
    assert.equal(table.shellParents.has(710), false);
    assert.equal(table.shellParents.has(750), false);
    assert.equal(table.parents.get(701), 700, 'below the cut, the edge stands');
    assert.equal(table.parents.get(721), 720);
    assert.equal(table.shellParents.has(720), true);
    assert.equal(table.parents.get(730), 999);
    assert.equal(table.shellParents.has(999), true);
  });

  it('keeps groups absent through members, so no backend can signal a Windows group', () => {
    const table = windowsTable([
      row(200, 10, at(10), OBSERVED.ideSpawnedClaude, 'claude.exe'),
      row(201, 200, at(10), OBSERVED.conhost, 'conhost.exe'),
      row(202, 200, at(11), OBSERVED.claudeToolLauncher, 'bash.exe'),
      row(203, 202, at(11), OBSERVED.claudeToolShell, 'bash.exe')
    ]);
    assert.equal(table.groups.size, 0);
    const members = control.snapshotTree(200, table);
    assert.deepEqual(
      members.map((member) => Object.keys(member).sort()),
      members.map(() => ['pid', 'startedAt'])
    );
    for (const member of members) assert.equal(member.startedAt, table.starts.get(member.pid));

    const kills: number[] = [];
    const posix = darwin.processes({
      run: () => Promise.reject(new Error('no scan here')),
      kill: (pid) => void kills.push(pid)
    });
    // Another clock's evidence proves nothing to this backend.
    assert.deepEqual(
      posix.signal(members, 'kill', table),
      members.map(() => 'absent')
    );
    assert.deepEqual(kills, []);
    // Even on a clock it accepts, a member with no group is its own pid.
    posix.signal(members, 'stop', { ...table, startSource: 'ps-lstart-v1' });
    assert.deepEqual(kills.sort(), [201, 202, 203]);

    const handed: processes.Member[][] = [];
    const recording: processes.Processes = {
      snapshot: () => Promise.reject(new Error('no scan here')),
      own: () => ({ dispose: () => Promise.resolve({ unresolved: [] }) }),
      signals: { supported: true },
      signal: (batch) => {
        handed.push([...batch]);
        return batch.map(() => 'sent');
      }
    };
    assert.equal(control.closeTree(200, members, table, undefined, recording), true);
    assert.equal(
      handed.flat().some((member) => member.pgid !== undefined),
      false
    );
  });

  it('carries a reader result into the shared snapshot without inventing metadata', () => {
    const failed = { supported: true as const, status: 'failed' as const, reason: 'x' };
    assert.deepEqual(win32.snapshotOf(failed), failed);

    const read = reader.parseFrame(
      frame([
        SELF,
        row(50, 10, at(1), OBSERVED.cmdWrappedClaude, 'claude.exe'),
        row(51, 10, at(1), null, null)
      ]),
      NONCE
    );
    const snapshot = win32.snapshotOf(read);
    assert.equal(snapshot.supported && snapshot.status, 'incomplete');
    if (!snapshot.supported || snapshot.status !== 'incomplete') return;
    assert.equal(snapshot.reason, 'kernel witness missing');
    assert.equal(snapshot.value.source, 'win32-filetime-ms-v1');
    const byId = new Map(snapshot.value.rows.map((item) => [item.pid, item]));
    assert.deepEqual(byId.get(50), {
      pid: 50,
      ppid: 10,
      startedAt: reader.dmtfToUnixMs(at(1)),
      command: OBSERVED.cmdWrappedClaude,
      image: 'claude.exe',
      invocation: {
        program: 'C:/Users/me/.local/bin/claude.exe',
        args: '-p --input-format stream-json'
      }
    });
    assert.deepEqual(byId.get(51), {
      pid: 51,
      ppid: 10,
      startedAt: reader.dmtfToUnixMs(at(1)),
      command: null
    });
  });

  it('splits a command at its program token the way Windows starts one', () => {
    for (const [command, expected] of [
      [
        OBSERVED.cmdWrappedClaude,
        ['C:/Users/me/.local/bin/claude.exe', '-p --input-format stream-json']
      ],
      [OBSERVED.ideSpawnedClaude, ['C:\\Users\\me\\.local\\bin\\claude.exe', '--print --verbose']],
      [OBSERVED.conhost, ['\\??\\C:\\WINDOWS\\system32\\conhost.exe', '0x4']],
      [OBSERVED.codexModeHost, [OBSERVED.codexModeHost.slice(1, -1), '']],
      ['"C:\\Program Files\\x', ['C:\\Program Files\\x', '']],
      ['ping\t-n 1', ['ping', '-n 1']]
    ] as const)
      assert.deepEqual(
        win32.invocationOf(command),
        { program: expected[0], args: expected[1] },
        command
      );
    for (const command of ['', ' claude.exe', '""'])
      assert.equal(win32.invocationOf(command), undefined, JSON.stringify(command));
  });
});

type Table = { rows: readonly reader.NativeRow[] };

function byPid(table: Table, pid: number | undefined): reader.NativeRow | undefined {
  return table.rows.find((item) => item.pid === pid);
}

function fixtureEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...helpers.homeEnv(home) };
}

async function readNative(): Promise<Table> {
  const read = await nativeRead();
  assert.equal(read.status, 'ok', read.status === 'ok' ? '' : read.reason);
  return read.status === 'ok' ? read.value : { rows: [] };
}

/** One native read, through the shared snapshot, as scan's table. */
async function readTable(): Promise<scan.ProcessTable> {
  return (await readBoth()).table;
}

/** The table and the rows it came from, which keep each image. */
async function readBoth(): Promise<{
  table: scan.ProcessTable;
  rows: readonly reader.NativeRow[];
}> {
  const read = await nativeRead();
  assert.equal(read.status, 'ok', read.status === 'ok' ? '' : read.reason);
  return {
    table: scan.tableOf(win32.snapshotOf(read)),
    rows: read.status === 'ok' ? read.value.rows : []
  };
}

function isConhost(rows: readonly reader.NativeRow[], pid: number): boolean {
  return rows.find((item) => item.pid === pid)?.image?.toLowerCase() === 'conhost.exe';
}

function nativeRead(): Promise<reader.NativeRead> {
  return reader
    .reader({
      windowsDirectory: process.env.SystemRoot,
      run: (file, args, options) =>
        new Promise((resolve, reject) => {
          execFile(
            file,
            [...args],
            {
              maxBuffer: options.maxBuffer,
              timeout: options.timeoutMs,
              windowsHide: true,
              env: fixtureEnv()
            },
            (error, stdout, stderr) => {
              if (error && typeof error.code !== 'number')
                reject(new Error(error.message, { cause: error }));
              else
                resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : 0 });
            }
          );
        })
    })
    .read();
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(check: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    assert.ok(Date.now() - started < ms, 'fixture did not reach its state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** `after` names a file the root waits for before it spawns this kid. */
type Kid = { name: string; detached: boolean; after?: string; kids?: Kid[] };

function kidNames(kids: readonly Kid[]): string[] {
  return kids.flatMap((kid) => [kid.name, ...kidNames(kid.kids ?? [])]);
}

type Tree = {
  dir: string;
  root: ChildProcess;
  /** Settles on the root's `close`, or on its spawn `error`. */
  closed: Promise<void>;
  error?: Error;
  /** Each process disposal saw and then confirmed gone, by name. */
  ended: Array<[string, number]>;
  pid(name: string): number;
  pidMaybe(name: string): number | undefined;
  touch(name: string): Promise<void>;
  /** Bounded and idempotent; removes the directory only after every process is gone. */
  dispose(): Promise<void>;
};

/**
 * Runs `body` against a Node root that spawns `kids`, each holding until a
 * `release` file or 20 s. Cleanup is owned from the moment the directory
 * exists, so a failed spawn or readiness still ends every process and removes
 * the directory before the failure settles.
 */
async function withTree(
  spec: { kids: Kid[] },
  body: (tree: Tree) => Promise<void>,
  options: {
    ready?: string[];
    readyMs?: number;
    executable?: string;
    created?: (tree: Tree) => void;
  } = {}
): Promise<void> {
  const tree = createTree(spec, options.executable ?? process.execPath);
  options.created?.(tree);
  try {
    const ready = options.ready ?? ['root', ...kidNames(spec.kids)];
    await waitUntil(() => {
      if (tree.error) throw tree.error;
      if (tree.root.exitCode !== null || tree.root.signalCode !== null)
        throw new Error('fixture root ended before it was ready');
      return ready.every((name) => tree.pidMaybe(name) !== undefined);
    }, options.readyMs);
    await body(tree);
  } finally {
    await tree.dispose();
  }
}

function createTree(spec: { kids: Kid[] }, executable: string): Tree {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-wintree-'));
  const names = ['root', ...kidNames(spec.kids)];
  const pidMaybe = (name: string): number | undefined => {
    try {
      return Number(fs.readFileSync(path.join(dir, `${name}.pid`), 'utf8')) || undefined;
    } catch {
      return undefined;
    }
  };
  let root: ChildProcess | undefined;
  let disposing: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const tree: Tree = {
    dir,
    get root() {
      assert.ok(root, 'fixture root was never spawned');
      return root;
    },
    closed: new Promise<void>((resolve) => (resolveClosed = resolve)),
    ended: [],
    pidMaybe,
    pid(name) {
      const value = pidMaybe(name);
      assert.ok(value, `${name} has no pid`);
      return value;
    },
    touch: (name) => fs.promises.writeFile(path.join(dir, name), '1'),
    dispose() {
      disposing ??= (async () => {
        await fs.promises.writeFile(path.join(dir, 'release'), '1').catch(() => {});
        if (root?.pid && root.exitCode === null && root.signalCode === null) root.kill();
        if (root) await Promise.race([tree.closed, new Promise((r) => setTimeout(r, 5_000))]);
        const seen = names.flatMap((name): Array<[string, number]> => {
          const pid = name === 'root' ? root?.pid : pidMaybe(name);
          return pid ? [[name, pid]] : [];
        });
        const gone = () => seen.every(([, pid]) => !alive(pid));
        try {
          await waitUntil(gone, 3_000);
        } catch {
          for (const [, pid] of seen) {
            try {
              process.kill(pid);
            } catch {
              // Already gone between the check and the kill.
            }
          }
          await waitUntil(gone, 5_000);
        }
        tree.ended.push(...seen);
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      })();
      return disposing;
    }
  };
  try {
    fs.writeFileSync(
      path.join(dir, 'hold.js'),
      `const fs = require('fs'), path = require('path'), { spawn } = require('child_process');\n` +
        `const [dir, name, spec] = process.argv.slice(2);\n` +
        `fs.writeFileSync(path.join(dir, name + '.pid'), String(process.pid));\n` +
        `const start = (kid) => spawn(process.execPath, [__filename, dir, kid.name, JSON.stringify({ kids: kid.kids || [] })], { detached: kid.detached, stdio: 'ignore', windowsHide: true }).unref();\n` +
        `for (const kid of JSON.parse(spec).kids || []) {\n` +
        `  if (!kid.after) start(kid);\n` +
        `  else { const wait = setInterval(() => { if (fs.existsSync(path.join(dir, kid.after))) { clearInterval(wait); start(kid); } }, 25); }\n` +
        `}\n` +
        `setInterval(() => { if (fs.existsSync(path.join(dir, 'release'))) process.exit(0); }, 25);\n` +
        `setTimeout(() => process.exit(3), 20000);\n`
    );
    root = spawn(executable, [path.join(dir, 'hold.js'), dir, 'root', JSON.stringify(spec)], {
      stdio: 'ignore',
      windowsHide: true,
      env: fixtureEnv()
    });
    root.once('close', () => resolveClosed());
    root.once('error', (error) => {
      tree.error = error;
      resolveClosed();
    });
  } catch (error) {
    tree.error = error instanceof Error ? error : new Error(String(error));
    resolveClosed();
  }
  return tree;
}
