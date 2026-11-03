import * as assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, it, mock } from 'node:test';
import { REAP_GRACE_MS, Reaps, closeTree, endBySignal, snapshotTree } from '../../core/control';
import type * as processes from '../../core/platform/processes';
import * as darwin from '../../core/platform/processes/darwin';
import * as win32 from '../../core/platform/processes/win32';
import { ProcessTable, descendants, scanProcesses } from '../../core/scan';
import * as scan from '../../core/scan';
import { tablesSupplied, testPlatform } from '../helpers';

/**
 * Ending signals real pids, so the signals are what is watched rather than
 * their effect: a test that spawned two processes to see one die before the
 * other would be timing the pty teardown this module exists to sequence.
 *
 * Every signal reaches `process.kill` through the POSIX processes backend, so
 * standing in for it records the pid, the signal and the order, which is
 * exactly what the rules here are about.
 */
const real = process.kill.bind(process);
let sent: { pid: number; signal: string | number | undefined }[] = [];

/** Records every signal, and fails the pids `throws` names the way the OS does. */
function record(throws: Record<number, string> = {}): void {
  sent = [];
  process.kill = (pid: number, signal?: string | number) => {
    sent.push({ pid, signal });
    const code = throws[pid];
    if (code) {
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return true;
  };
}

afterEach(() => {
  process.kill = real;
});

/**
 * A session at 4242 that ran a tool call: `claude` -> a `zsh -c` leading its own
 * group at 500 -> npm at 600 -> node at 700. The shape the sweep exists for, and
 * the one the machine was observed in on 2026-08-01.
 */
function table(overrides: Partial<ProcessTable> = {}): ProcessTable {
  return {
    complete: true,
    startSource: 'ps-lstart-v1',
    claude: new Map(),
    grok: new Map(),
    codex: new Map(),
    parents: new Map([
      [4242, 1],
      [500, 4242],
      [600, 500],
      [700, 600]
    ]),
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
    shellParents: new Set(),
    ...overrides
  };
}

/** This repo's POSIX backend, signalling through `process.kill` as `record` sees it. */
const posix = darwin.processes({
  run: () => Promise.reject(new Error('scans come from scan.scanProcesses here')),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  }
});

describe('snapshotTree', () => {
  it('takes the subtree deepest first, with each member’s identity', () => {
    assert.deepEqual(snapshotTree(4242, table()), [
      { pid: 700, pgid: 500, startedAt: 4000 },
      { pid: 600, pgid: 500, startedAt: 3000 },
      { pid: 500, pgid: 500, startedAt: 2000 }
    ]);
    assert.deepEqual(
      snapshotTree(
        4242,
        table({
          groups: new Map([
            [500, NaN],
            [600, 0]
          ]),
          starts: new Map([
            [500, NaN],
            [600, 0]
          ])
        })
      ),
      [
        { pid: 700, startedAt: 0 },
        { pid: 600, pgid: 0, startedAt: 0 },
        { pid: 500, pgid: NaN, startedAt: NaN }
      ]
    );
  });

  it('signals only chronologically possible native descendants, including equal-second siblings', () => {
    const rows: processes.Row[] = [
      { pid: 4242, ppid: 1, startedAt: 2000, command: 'codex app-server' },
      { pid: 500, ppid: 4242, pgid: 500, startedAt: 1000, command: 'sh -c old' },
      { pid: 600, ppid: 4242, pgid: 600, startedAt: 2000, command: 'sh -c valid' },
      { pid: 700, ppid: 600, pgid: 600, startedAt: 3000, command: 'node tool' }
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const current = scan.tableOf({
        supported: true,
        status: 'ok',
        value: { source: 'ps-lstart-v1', rows: ordered }
      });
      record();
      const members = snapshotTree(4242, current);
      assert.equal(closeTree(4242, members, current, 2000, posix), true);
      posix.signal(members, 'kill', current);
      assert.deepEqual(sent, [
        { pid: 700, signal: 'SIGTERM' },
        { pid: -600, signal: 'SIGTERM' },
        { pid: 4242, signal: 'SIGTERM' },
        { pid: 700, signal: 'SIGKILL' },
        { pid: -600, signal: 'SIGKILL' }
      ]);
      assert.equal(current.starts.get(500), 1000);
      assert.equal(current.groups.get(500), 500);
    }
  });

  it('is empty for a session that started nothing', () => {
    assert.deepEqual(snapshotTree(700, table()), []);
  });
});

describe('closeTree', () => {
  it('does not signal any of a tree when its root pid was reused', () => {
    record();
    const current = table();
    assert.equal(closeTree(4242, snapshotTree(4242, current), current, 20_000), false);
    assert.deepEqual(sent, []);
  });

  it('carries on past a member that refuses, and answers for the CLI', () => {
    // One EPERM descendant is not a failed stop: the question the caller asked
    // was whether the session ended.
    record({ 600: 'EPERM', 700: 'ESRCH' });
    assert.equal(closeTree(4242, snapshotTree(4242, table()), table(), undefined, posix), true);
    assert.equal(sent.length, 4, 'every member is still attempted');
  });
});

/**
 * `endBySignal` takes its own fresh `ps`, so the session here is a real
 * process: a Node parent holding a Node child, the subtree a tool call leaves. Signals
 * are still recorded rather than sent, and the pair is killed for real after.
 */
describe('endBySignal', () => {
  let parent: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let kids: number[] = [];
  // Windows has no stop, so its End is TerminateProcess at once; that order is
  // pinned in "endBySignal on the Windows ending" below.
  const posixStopTodo =
    testPlatform() === 'win32' &&
    'win32: expects a POSIX SIGTERM first, where Windows ends by TerminateProcess at once — W4.1';

  afterEach(async () => {
    mock.timers.reset();
    process.kill = real;
    parent?.stdin?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('fixture parent did not close')), 5000);
        })
      ]);
    } catch (error) {
      parent?.kill('SIGKILL');
      clearTimeout(timer);
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('killed fixture parent did not close')),
              2000
            );
          })
        ]);
      } catch {
        // Preserve the first teardown failure after the owned child was killed.
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parent = undefined;
      closed = undefined;
      kids = [];
    }
  });

  /** The parent's pid and start, once its child is in the table. */
  async function session(): Promise<{ pid: number; startedAt: number }> {
    parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      process.stdin.resume();
      process.stdin.on('end', () => child.kill('SIGKILL'));
      child.on('close', () => process.stdin.destroy());
    `
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    );
    closed = new Promise<void>((resolve, reject) => {
      parent!.once('close', () => resolve());
      parent!.once('error', reject);
    });
    void closed.catch(() => {});
    const pid = parent.pid ?? 0;
    for (let tries = 0; tries < 50; tries++) {
      const table = await scanProcesses(true);
      kids = descendants(pid, table.parents);
      const startedAt = table.starts.get(pid);
      if (kids.length > 0 && startedAt !== undefined) return { pid, startedAt };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the Node child never appeared under its parent');
  }

  function owner(): {
    held: unknown[];
    released: unknown[];
    hold(r: unknown): void;
    release(r: unknown): void;
  } {
    const held: unknown[] = [];
    const released: unknown[] = [];
    return { held, released, hold: (r) => held.push(r), release: (r) => released.push(r) };
  }

  it('does not claim exit or signal when its final process scan is incomplete', async (t) => {
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table({ complete: false })));
    record();
    const reaps = owner();
    assert.deepEqual(await endBySignal([{ pid: 42, startedAt: 10000 }], reaps, posix), ['failed']);
    assert.deepEqual(sent, []);
    assert.equal(reaps.held.length, 0);
  });

  it('never signals a session whose start time does not match', async () => {
    // The pid is reused the moment its session exits; a number that answers to
    // another start is another program.
    const { pid, startedAt } = await session();
    record();
    const reaps = owner();
    assert.deepEqual(await endBySignal([{ pid, startedAt: startedAt + 60_000 }], reaps), ['gone']);
    assert.deepEqual(sent, []);
    assert.equal(reaps.held.length, 0, 'nothing swept, so nothing to reap');
  });

  it(
    'signals the subtree and then the session, and hands the reap to its caller',
    { todo: posixStopTodo },
    async () => {
      const { pid, startedAt } = await session();
      record();
      const reaps = owner();
      mock.timers.enable({ apis: ['setTimeout'] });
      assert.deepEqual(await endBySignal([{ pid, startedAt }], reaps), ['ended']);
      assert.deepEqual(sent, [
        ...kids.map((kid) => ({ pid: kid, signal: 'SIGTERM' })),
        { pid, signal: 'SIGTERM' }
      ]);
      assert.equal(reaps.held.length, 1);

      // The grace runs out: the subtree is SIGKILLed off a fresh table, and the
      // reap lets go of itself once that read has settled.
      mock.timers.tick(REAP_GRACE_MS);
      mock.timers.reset();
      for (let tries = 0; tries < 50 && reaps.released.length === 0; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(reaps.released, reaps.held);
      assert.deepEqual(
        sent.filter((s) => s.signal === 'SIGKILL'),
        kids.map((kid) => ({ pid: kid, signal: 'SIGKILL' }))
      );
    }
  );

  it('sends no SIGKILL once its caller disposes the reap', { todo: posixStopTodo }, async () => {
    const { pid, startedAt } = await session();
    record();
    const reaps = owner();
    mock.timers.enable({ apis: ['setTimeout'] });
    await endBySignal([{ pid, startedAt }], reaps);
    (reaps.held[0] as { dispose(): void }).dispose();
    mock.timers.tick(REAP_GRACE_MS);
    assert.equal(
      sent.some((s) => s.signal === 'SIGKILL'),
      false
    );
    assert.equal(reaps.released.length, 0);
  });

  it('answers each target in order and reaps them all together', async () => {
    const { pid, startedAt } = await session();
    record();
    const reaps = owner();
    assert.deepEqual(
      await endBySignal(
        [
          { pid, startedAt: startedAt - 60_000 },
          { pid, startedAt }
        ],
        reaps
      ),
      ['gone', 'ended']
    );
    assert.equal(reaps.held.length, 1, 'one timer for the whole list');
  });
});

/**
 * Two sessions under one End: 4242 with its tool-call tree, and 8000 whose
 * one child at 8100 leads its own group.
 */
function batch(overrides: Partial<ProcessTable> = {}): ProcessTable {
  const base = table();
  return table({
    parents: new Map([...base.parents, [8000, 1], [8100, 8000]]),
    starts: new Map([...base.starts, [8000, 5000], [8100, 6000]]),
    groups: new Map([...base.groups, [8000, 81923], [8100, 8100]]),
    ...overrides
  });
}

describe('endBySignal, its batch and its reap', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const targets = [
    { pid: 4242, startedAt: 1000 },
    { pid: 8000, startedAt: 5000 }
  ];

  it('scans once for the whole batch and once when its reap fires, killing matched members off an incomplete table', async (t) => {
    // One `ps` per End however many sessions it takes down, one more for the
    // reap; never one per member. The reap's table being incomplete does not
    // spare a member whose own row still matches.
    let scans = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(++scans === 1 ? batch() : batch({ complete: false }))
    );
    record();
    mock.timers.enable({ apis: ['setTimeout'] });
    const reaps = new Reaps();
    assert.deepEqual(await endBySignal(targets, reaps, posix), ['ended', 'ended']);
    assert.equal(scans, 1);
    assert.equal(reaps.size, 1, 'one reap for the whole batch');
    assert.deepEqual(sent, [
      { pid: 700, signal: 'SIGTERM' },
      { pid: 600, signal: 'SIGTERM' },
      { pid: -500, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGTERM' },
      { pid: -8100, signal: 'SIGTERM' },
      { pid: 8000, signal: 'SIGTERM' }
    ]);

    mock.timers.tick(REAP_GRACE_MS);
    await settle();
    assert.equal(scans, 2);
    assert.equal(reaps.size, 0, 'a fired reap is no longer held');
    assert.deepEqual(
      sent.filter((s) => s.signal === 'SIGKILL'),
      [
        { pid: 700, signal: 'SIGKILL' },
        { pid: 600, signal: 'SIGKILL' },
        { pid: -500, signal: 'SIGKILL' },
        { pid: -8100, signal: 'SIGKILL' }
      ],
      'the sessions themselves are never SIGKILLed here'
    );
  });

  it('sends no SIGKILL once the owner is disposed inside the grace, nor for a reap handed over after', async (t) => {
    let scans = 0;
    t.mock.method(scan, 'scanProcesses', () => {
      scans++;
      return Promise.resolve(batch());
    });
    record();
    mock.timers.enable({ apis: ['setTimeout'] });
    const reaps = new Reaps();
    await endBySignal(targets, reaps, posix);
    reaps.dispose();
    assert.equal(reaps.size, 0);
    await endBySignal(targets, reaps, posix);
    assert.equal(reaps.size, 0, 'a disposed owner holds nothing');
    mock.timers.tick(REAP_GRACE_MS);
    await settle();
    assert.equal(scans, 2, 'no reap scanned');
    assert.equal(
      sent.some((s) => s.signal === 'SIGKILL'),
      false
    );
  });

  it('refuses every target where this OS has no guarded signal, before any scan', async (t) => {
    const scans = t.mock.method(scan, 'scanProcesses', () => Promise.resolve(batch()));
    record();
    const reaps = new Reaps();
    const refusal: processes.Outcome = {
      supported: false,
      reason: 'processes.signal is unavailable on plan9: no guarded tree signal'
    };
    const refusing: processes.Processes = {
      snapshot: () => Promise.resolve(refusal),
      own: () => ({ dispose: () => Promise.resolve({ unresolved: [] }) }),
      signals: refusal,
      signal: (members) => members.map(() => refusal)
    };
    assert.deepEqual(await endBySignal(targets, reaps, refusing), [refusal, refusal]);
    assert.equal(scans.mock.callCount(), 0);
    assert.deepEqual(sent, []);
    assert.equal(reaps.size, 0);
  });
});

describe('endBySignal on the Windows ending', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const targets = [
    { pid: 4242, startedAt: 1000 },
    { pid: 8000, startedAt: 5000 }
  ];
  /** The batch on the Windows clock: no groups, so nothing can be signalled by one. */
  const windowsBatch = (overrides: Partial<ProcessTable> = {}): ProcessTable =>
    batch({ startSource: 'win32-filetime-ms-v1', groups: new Map(), ...overrides });
  /** The unselected Windows ending, its TerminateProcess through `record`'s `process.kill`. */
  const windows = (): processes.Processes =>
    win32.processes(tablesSupplied((pid, signal) => process.kill(pid, signal)));

  it('ends each tree deepest first by pid, its root last, and reaps survivors once', async (t) => {
    let scans = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(++scans === 1 ? windowsBatch() : windowsBatch({ complete: false }))
    );
    record();
    mock.timers.enable({ apis: ['setTimeout'] });
    const reaps = new Reaps();
    assert.deepEqual(await endBySignal(targets, reaps, windows()), ['ended', 'ended']);
    // No flush request exists, so End is TerminateProcess at once, never a group.
    assert.deepEqual(sent, [
      { pid: 700, signal: 'SIGKILL' },
      { pid: 600, signal: 'SIGKILL' },
      { pid: 500, signal: 'SIGKILL' },
      { pid: 4242, signal: 'SIGKILL' },
      { pid: 8100, signal: 'SIGKILL' },
      { pid: 8000, signal: 'SIGKILL' }
    ]);
    assert.equal(scans, 1);
    assert.equal(reaps.size, 1);

    mock.timers.tick(REAP_GRACE_MS);
    await settle();
    assert.equal(scans, 2);
    assert.deepEqual(sent.slice(6), [
      { pid: 700, signal: 'SIGKILL' },
      { pid: 600, signal: 'SIGKILL' },
      { pid: 500, signal: 'SIGKILL' },
      { pid: 8100, signal: 'SIGKILL' }
    ]);
  });

  it('sends nothing to a recycled root or member', async (t) => {
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(
        windowsBatch({
          starts: new Map([
            [4242, 1000],
            [500, 2000],
            [600, 3001],
            [700, 4000],
            [8000, 90_000],
            [8100, 6000]
          ])
        })
      )
    );
    record();
    const reaps = new Reaps();
    const tree = snapshotTree(4242, windowsBatch());
    assert.deepEqual(await endBySignal(targets, reaps, windows()), ['ended', 'gone']);
    reaps.dispose();
    // 600 was read at 3000 and now starts at 3001: another process wears its number.
    assert.deepEqual(
      sent.map((s) => s.pid),
      [700, 600, 500, 4242]
    );
    assert.equal(
      closeTree(
        4242,
        tree,
        windowsBatch({
          starts: new Map([...windowsBatch().starts, [600, 3001]])
        }),
        undefined,
        windows()
      ),
      true
    );
    assert.deepEqual(
      sent.slice(4).map((s) => s.pid),
      [700, 500, 4242]
    );
  });

  it('fails an End whose root the OS refuses, and still attempts every member', async (t) => {
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(windowsBatch()));
    record({ 4242: 'EPERM', 600: 'EPERM' });
    const reaps = new Reaps();
    assert.deepEqual(await endBySignal(targets, reaps, windows()), ['failed', 'ended']);
    assert.equal(sent.length, 6);
    reaps.dispose();
  });

  it('sends no reap once its owner is disposed inside the grace', async (t) => {
    let scans = 0;
    t.mock.method(scan, 'scanProcesses', () => {
      scans++;
      return Promise.resolve(windowsBatch());
    });
    record();
    mock.timers.enable({ apis: ['setTimeout'] });
    const reaps = new Reaps();
    await endBySignal(targets, reaps, windows());
    const ended = sent.length;
    reaps.dispose();
    mock.timers.tick(REAP_GRACE_MS);
    await settle();
    assert.equal(scans, 1, 'no reap scanned');
    assert.equal(sent.length, ended, 'no member was terminated again');
  });
});

describe('a reap disposed while its read is in flight (Sol F2)', () => {
  afterEach(() => {
    mock.timers.reset();
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const targets = [{ pid: 4242, startedAt: 1000 }];
  const windows = (): processes.Processes =>
    win32.processes(tablesSupplied((pid, signal) => process.kill(pid, signal)));

  for (const [name, backend, startSource] of [
    ['the POSIX', posix, 'ps-lstart-v1'],
    ['the Windows', windows(), 'win32-filetime-ms-v1']
  ] as const) {
    const current = (): ProcessTable =>
      table({
        startSource,
        ...(startSource === 'ps-lstart-v1' ? {} : { groups: new Map() })
      });

    it(`sends nothing once disposed during the reap's read, on ${name} ending`, async (t) => {
      let scans = 0;
      let finish!: (table: ProcessTable) => void;
      t.mock.method(scan, 'scanProcesses', () =>
        ++scans === 1
          ? Promise.resolve(current())
          : new Promise<ProcessTable>((resolve) => {
              finish = resolve;
            })
      );
      record();
      mock.timers.enable({ apis: ['setTimeout'] });
      const reaps = new Reaps();
      await endBySignal(targets, reaps, backend);
      const ended = sent.length;
      mock.timers.tick(REAP_GRACE_MS);
      await settle();
      assert.equal(scans, 2, 'the reap is reading');
      assert.equal(reaps.size, 1, 'a reap is held until its read settles');
      reaps.dispose();
      finish(current());
      await settle();
      assert.equal(sent.length, ended, 'a disposed owner sent a kill');
      assert.equal(reaps.size, 0);
    });

    it(`sends no reap when disposed before the reap is handed over, on ${name} ending`, async (t) => {
      let scans = 0;
      let finish!: (table: ProcessTable) => void;
      t.mock.method(scan, 'scanProcesses', () => {
        scans++;
        return scans === 1
          ? new Promise<ProcessTable>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(current());
      });
      record();
      mock.timers.enable({ apis: ['setTimeout'] });
      const reaps = new Reaps();
      const ending = endBySignal(targets, reaps, backend);
      reaps.dispose();
      finish(current());
      assert.deepEqual(await ending, ['ended']);
      const ended = sent.length;
      mock.timers.tick(REAP_GRACE_MS);
      await settle();
      assert.equal(scans, 1, 'no reap read');
      assert.equal(sent.length, ended);
    });
  }
});
