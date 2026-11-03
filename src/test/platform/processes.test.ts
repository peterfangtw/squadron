import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import * as control from '../../core/control';
import * as platform from '../../core/platform';
import type * as processes from '../../core/platform/processes';
import * as darwin from '../../core/platform/processes/darwin';
import * as win32 from '../../core/platform/processes/win32';
import * as scan from '../../core/scan';
import { tablesSupplied, testPlatform } from '../helpers';

/** A `ps` that prints `stdout`, or fails as `execFile` does; every call recorded. */
function ps(stdout: string | Error): {
  effects: processes.Effects;
  calls: { file: string; args: readonly string[]; maxBuffer: number }[];
} {
  const calls: { file: string; args: readonly string[]; maxBuffer: number }[] = [];
  return {
    calls,
    effects: {
      run(file, args, { maxBuffer }) {
        calls.push({ file, args, maxBuffer });
        return stdout instanceof Error ? Promise.reject(stdout) : Promise.resolve(stdout);
      },
      kill() {
        throw new Error('a snapshot signals nothing');
      }
    }
  };
}

function rows(snapshot: processes.Snapshot): processes.Row[] {
  assert.ok(snapshot.supported && snapshot.status !== 'failed', JSON.stringify(snapshot));
  return snapshot.value.rows;
}

describe('process snapshot', () => {
  it('reads one bounded ps with the columns the rows are parsed by', async () => {
    const fake = ps('');
    await darwin.processes(fake.effects).snapshot();
    assert.deepEqual(fake.calls, [
      { file: '/bin/ps', args: ['-Ao', 'pid=,ppid=,pgid=,lstart=,command='], maxBuffer: 8388608 }
    ]);
  });

  it('reads a row whatever width the day of the month is', async () => {
    // `lstart` pads the day rather than printing it fixed-width, and the match
    // used to allow one optional space before it. Every process started on a
    // single-digit day was therefore dropped: on the 1st of a month, that is
    // every process the panel would ever watch start — no liveness, no
    // ancestry, no start time. Both spellings, in one test, so no future
    // tightening can pass on the 24th and fail on the 1st.
    const snapshot = await darwin
      .processes(
        ps(
          ' 4321  1 4321 Wed Jun 24 12:26:10 2026 /usr/local/bin/claude --resume\n' +
            '  902  1  902 Sat Aug  1 00:03:13 2026 /bin/zsh -c "npm test"\n'
        ).effects
      )
      .snapshot();
    assert.equal(snapshot.supported && snapshot.status, 'ok');
    assert.equal(
      snapshot.supported && snapshot.status === 'ok' && snapshot.value.source,
      'ps-lstart-v1'
    );
    assert.deepEqual(rows(snapshot), [
      {
        pid: 4321,
        ppid: 1,
        pgid: 4321,
        startedAt: Date.parse('Wed Jun 24 12:26:10 2026'),
        command: '/usr/local/bin/claude --resume'
      },
      {
        pid: 902,
        ppid: 1,
        pgid: 902,
        startedAt: Date.parse('Sat Aug  1 00:03:13 2026'),
        command: '/bin/zsh -c "npm test"'
      }
    ]);
  });

  it('reads the process group, which is not always the pid', async () => {
    // The two shapes this is read for: a tool-call shell leads its own group, so
    // its whole subtree can be signalled by it; a session inherits the group of
    // whatever started it, and signalling *that* would reach the IDE. Nothing
    // downstream may signal a group without checking which of these it has.
    const read = rows(
      await darwin
        .processes(
          ps(
            ' 30856 53873 30856 Fri Aug  1 09:12:03 2026 /bin/zsh -c "npm test"\n' +
              ' 53873 69477 81923 Fri Aug  1 04:20:11 2026 /bin/claude --print\n'
          ).effects
        )
        .snapshot()
    );
    assert.deepEqual(
      read.map((row) => [row.pid, row.pgid]),
      [
        [30856, 30856],
        [53873, 81923]
      ]
    );
  });

  it('says nothing for a line that is not a process, and calls the table incomplete', async () => {
    // A row that did not parse is a process nobody can see, so the table
    // cannot prove anything absent; the rows that did parse are still read.
    const snapshot = await darwin
      .processes(
        ps(
          '  PID  PPID  PGID COMMAND\n' +
            ' 4321  1 4321 Wed Jun 24 12:26:10 2026 /usr/local/bin/claude\n' +
            '\n'
        ).effects
      )
      .snapshot();
    assert.equal(snapshot.supported && snapshot.status, 'incomplete');
    assert.deepEqual(
      rows(snapshot).map((row) => row.pid),
      [4321]
    );
  });

  it('calls output cut off mid-row incomplete rather than short', async () => {
    const snapshot = await darwin
      .processes(
        ps(' 4321  1 4321 Wed Jun 24 12:26:10 2026 /usr/local/bin/claude\n  902  1  902 Sat Au')
          .effects
      )
      .snapshot();
    assert.equal(snapshot.supported && snapshot.status, 'incomplete');
    assert.deepEqual(
      rows(snapshot).map((row) => row.pid),
      [4321]
    );
  });

  it('answers empty output as an empty complete table, and a failed ps as failed', async () => {
    // Two different answers: no processes is a reading, a ps that could not
    // run (missing, killed, past its 8 MiB) is not one.
    const empty = await darwin.processes(ps('').effects).snapshot();
    assert.equal(empty.supported && empty.status, 'ok');
    assert.deepEqual(rows(empty), []);

    const failed = await darwin
      .processes(ps(new Error('stdout maxBuffer length exceeded')).effects)
      .snapshot();
    assert.deepEqual(failed, {
      supported: true,
      status: 'failed',
      reason: 'stdout maxBuffer length exceeded'
    });
  });
});

/** What a backend sent, in order; `throws` fails a pid the way the OS does. */
function killer(throws: Record<number, string> = {}): {
  effects: processes.Effects;
  sent: { pid: number; signal: NodeJS.Signals }[];
} {
  const sent: { pid: number; signal: NodeJS.Signals }[] = [];
  return {
    sent,
    effects: {
      run: () => Promise.reject(new Error('no ps here')),
      kill(pid, signal) {
        sent.push({ pid, signal });
        const code = throws[pid];
        if (code) throw Object.assign(new Error(`kill ${code}`), { code });
      }
    }
  };
}

/**
 * A session at 4242 that ran a tool call: `claude` -> a `zsh -c` leading its own
 * group at 500 -> npm at 600 -> node at 700. The shape the group rule exists
 * for, and the one the machine was observed in on 2026-08-01.
 */
function evidence(over: Partial<processes.Evidence> = {}): processes.Evidence {
  return {
    complete: true,
    startSource: 'ps-lstart-v1',
    starts: new Map([
      [4242, 1000],
      [500, 2000],
      [600, 3000],
      [700, 4000]
    ]),
    // Only the tool-call shell leads a group. The session is in the IDE's.
    groups: new Map([
      [4242, 81923],
      [500, 500],
      [600, 500],
      [700, 500]
    ]),
    ...over
  };
}

/** The subtree below 4242, deepest first, as `control.snapshotTree` takes it. */
const tree: processes.Member[] = [
  { pid: 700, pgid: 500, startedAt: 4000 },
  { pid: 600, pgid: 500, startedAt: 3000 },
  { pid: 500, pgid: 500, startedAt: 2000 }
];

/** The session itself, shaped as a leader so `alone` is what keeps it by pid. */
const root: processes.Member = { pid: 4242, pgid: 4242, startedAt: 1000 };

function without(pid: number): processes.Evidence {
  const starts = new Map(evidence().starts);
  starts.delete(pid);
  return evidence({ starts });
}

function recycled(pid: number, startedAt: number): processes.Evidence {
  return evidence({ starts: new Map(evidence().starts).set(pid, startedAt) });
}

describe('guarded signal, as a root alone', () => {
  it('signals the CLI and nothing else', () => {
    // By pid even where it leads a group: a session's own group is never ours.
    // It used to hang up the hosting shell after the CLI, too; every session
    // left runs on a pipe with no shell of its own
    // (`docs/reference/process_signals.md` keeps what that path measured).
    const fake = killer();
    assert.deepEqual(
      darwin
        .processes(fake.effects)
        .signal(
          [root],
          'stop',
          evidence({ groups: new Map(evidence().groups).set(root.pid, root.pid) }),
          { alone: true }
        ),
      ['sent']
    );
    assert.deepEqual(fake.sent, [{ pid: 4242, signal: 'SIGTERM' }]);
  });

  it('reads a pid that is already gone as stopped', () => {
    // ESRCH is the outcome the caller wanted: nothing is running under that
    // number, which is what "stop it" was asking for.
    const fake = killer({ 4242: 'ESRCH' });
    assert.deepEqual(
      darwin.processes(fake.effects).signal([root], 'stop', evidence(), { alone: true }),
      ['absent']
    );
  });

  it('reads any other refusal as not stopped', () => {
    // A pid this user may not signal is still running, and saying otherwise
    // would leave a card claiming a session ended that has not.
    const fake = killer({ 4242: 'EPERM' });
    assert.deepEqual(
      darwin.processes(fake.effects).signal([root], 'stop', evidence(), { alone: true }),
      ['refused']
    );
  });
});

describe('guarded signal, as a tree', () => {
  it('signals a group leader by group and everything else alone', () => {
    // The negative pid is the whole point: the tool-call shell leads its own
    // group, so `-500` reaches children it spawns *after* this list was taken.
    const fake = killer();
    assert.deepEqual(darwin.processes(fake.effects).signal(tree, 'stop', evidence()), [
      'sent',
      'sent',
      'sent'
    ]);
    assert.deepEqual(fake.sent, [
      { pid: 700, signal: 'SIGTERM' },
      { pid: 600, signal: 'SIGTERM' },
      { pid: -500, signal: 'SIGTERM' }
    ]);
  });

  for (const [name, rememberedGroup, currentGroup, target] of [
    ['unknown group stays PID-only', undefined, undefined, 500],
    ['fresh leadership cannot upgrade an unknown remembered group', undefined, 500, 500],
    ['stale leader with a current nonleader uses PID', 500, 4242, 500],
    ['stale leader with no current group uses PID', 500, undefined, 500],
    ['observed leadership in both snapshots uses group', 500, 500, -500],
    ['a remembered nonleader stays PID-only', 4242, 500, 500]
  ] as const) {
    it(name, () => {
      const snapshot = (pgid: number | undefined): processes.Snapshot => ({
        supported: true,
        status: 'ok',
        value: {
          source: 'ps-lstart-v1',
          rows: [
            { pid: 4242, ppid: 1, startedAt: 1000, command: 'node session' },
            {
              pid: 500,
              ppid: 4242,
              ...(pgid === undefined ? {} : { pgid }),
              startedAt: 2000,
              command: 'node tool'
            }
          ]
        }
      });
      const members = control.snapshotTree(4242, scan.tableOf(snapshot(rememberedGroup)));
      const current = scan.tableOf(snapshot(currentGroup));
      const fake = killer();
      assert.deepEqual(darwin.processes(fake.effects).signal(members, 'stop', current), ['sent']);
      assert.deepEqual(fake.sent, [{ pid: target, signal: 'SIGTERM' }]);
    });
  }

  it('does not signal a pid the machine has since reused', () => {
    // A start time that moved is a different program wearing the same number.
    // Signalling it is the one outcome worse than leaving the orphan alone.
    const fake = killer();
    assert.deepEqual(darwin.processes(fake.effects).signal(tree, 'stop', recycled(600, 9999)), [
      'sent',
      'absent',
      'sent'
    ]);
    assert.deepEqual(
      fake.sent.map((s) => s.pid),
      [700, -500],
      '600 was recycled and must be left alone'
    );
  });

  it('does not signal a member that is already gone', () => {
    const fake = killer();
    darwin.processes(fake.effects).signal(tree, 'stop', without(700));
    assert.equal(
      fake.sent.some((s) => s.pid === 700),
      false
    );
  });

  it('still judges each member by its own row when the table is incomplete', () => {
    // One unreadable row elsewhere does not make a matched member a stranger;
    // whether an incomplete table may be acted on is the caller's question.
    const fake = killer();
    darwin.processes(fake.effects).signal(tree, 'kill', evidence({ complete: false }));
    assert.deepEqual(
      fake.sent.map((s) => s.pid),
      [700, 600, -500]
    );
  });

  it('sends nothing off another clock or to an unusable PID', () => {
    // A start is identity only against a start read the same way, and an
    // empty table that failed to read has no clock at all.
    const fake = killer();
    const backend = darwin.processes(fake.effects);
    assert.deepEqual(backend.signal(tree, 'kill', evidence({ startSource: undefined })), [
      'absent',
      'absent',
      'absent'
    ]);
    assert.deepEqual(
      backend.signal([{ pid: 1, pgid: 1, startedAt: 7 }], 'kill', {
        ...evidence(),
        starts: new Map([[1, 7]])
      }),
      ['absent']
    );
    for (const pid of [0, NaN, Infinity, 500.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(
        backend.signal(
          [{ pid, pgid: pid, startedAt: 7 }],
          'kill',
          evidence({
            starts: new Map([[pid, 7]]),
            groups: new Map([[pid, pid]])
          })
        ),
        ['absent']
      );
    }
    assert.deepEqual(fake.sent, []);
  });
});

describe('guarded signal, as the reap', () => {
  const members: processes.Member[] = [
    { pid: 700, pgid: 500, startedAt: 4000 },
    { pid: 500, pgid: 500, startedAt: 2000 }
  ];

  it('SIGKILLs what is still there, by group where it leads one', () => {
    // SIGKILL rather than a second SIGTERM: the observed orphan ignored SIGTERM
    // for sixteen hours because it was blocked in a write and never ran a
    // handler at all.
    const fake = killer();
    darwin.processes(fake.effects).signal(members, 'kill', evidence());
    assert.deepEqual(fake.sent, [
      { pid: 700, signal: 'SIGKILL' },
      { pid: -500, signal: 'SIGKILL' }
    ]);
  });

  it('leaves alone what the fresh table no longer shows', () => {
    const fake = killer();
    const gone = evidence({ starts: new Map([[4242, 1000]]) });
    darwin.processes(fake.effects).signal(members, 'kill', gone);
    assert.deepEqual(fake.sent, []);
  });

  it('leaves alone a pid whose start time moved', () => {
    const fake = killer();
    darwin.processes(fake.effects).signal(members, 'kill', recycled(500, 8888));
    assert.deepEqual(fake.sent, [{ pid: 700, signal: 'SIGKILL' }]);
  });

  it('reports a refusal rather than throwing it at the caller', () => {
    // This runs from a timer nobody awaits: an exception here would be an
    // unhandled rejection in the extension host, for a process it may simply
    // not own.
    const fake = killer({ 700: 'EPERM' });
    assert.deepEqual(darwin.processes(fake.effects).signal(members, 'kill', evidence()), [
      'refused',
      'sent'
    ]);
    assert.equal(fake.sent.length, 2);
  });
});

describe('guarded signal on win32', () => {
  it('asks no member to stop, and kills none read on another clock', () => {
    const sent: number[] = [];
    const backend = win32.processes(tablesSupplied((pid) => sent.push(pid)));
    assert.deepEqual(backend.signals, { supported: true });
    for (const outcome of backend.signal([root, ...tree], 'stop', evidence()))
      assert.equal(typeof outcome === 'object' && !outcome.supported, true);
    assert.deepEqual(backend.signal([root, ...tree], 'kill', evidence()), [
      'absent',
      'absent',
      'absent',
      'absent'
    ]);
    assert.deepEqual(sent, []);
  });
});

describe(
  'guarded signal on this machine',
  {
    skip:
      testPlatform() === 'win32' &&
      'win32: builds its tree with POSIX sh job control, and Windows has no groups — W3.4'
  },
  () => {
    it('ends a real tree it was handed, its leader by group and its root alone', async (t) => {
      // `set -m` gives the shell's job a group of its own, the shape a CLI's
      // tool call takes; the shell stays in this test's group, as a session
      // stays in the IDE's.
      const shell = spawn('sh', ['-c', "set -m; sh -c 'sleep 30 & wait' & wait"], {
        stdio: 'ignore'
      });
      const pid = shell.pid ?? 0;
      const killed = new Set<number>([pid]);
      t.after(() => {
        for (const each of killed) {
          try {
            process.kill(each, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      });
      let table = scan.tableOf(await platform.processes.snapshot());
      for (let tries = 0; tries < 100 && control.snapshotTree(pid, table).length < 2; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        table = scan.tableOf(await platform.processes.snapshot());
      }
      const members = control.snapshotTree(pid, table);
      t.diagnostic(
        `observed-group native fixture root/tools PIDs: ${[pid, ...members.map((member) => member.pid)].join(',')}`
      );
      for (const member of members) killed.add(member.pid);
      const own = table.starts.get(pid);
      assert.ok(
        members.length >= 2 && own !== undefined,
        'the job shell and its sleep never appeared'
      );
      assert.ok(
        members.some((member) => member.pgid === member.pid),
        'the job does not lead its own group'
      );

      assert.deepEqual(
        platform.processes.signal(members, 'kill', table),
        members.map(() => 'sent')
      );
      assert.deepEqual(
        platform.processes.signal([{ pid, pgid: pid, startedAt: own }], 'kill', table, {
          alone: true
        }),
        ['sent']
      );

      const everyone = [...members, { pid, startedAt: own }];
      const alive = (now: scan.ProcessTable): boolean =>
        everyone.some((member) => now.starts.get(member.pid) === member.startedAt);
      let now = scan.tableOf(await platform.processes.snapshot());
      for (let tries = 0; tries < 100 && alive(now); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        now = scan.tableOf(await platform.processes.snapshot());
      }
      assert.equal(alive(now), false, 'part of the tree outlived its SIGKILL');
    });
  }
);
