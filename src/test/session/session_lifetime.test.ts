import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { childTransport } from '../../core/session';
import { SessionLifetime, type NativeChild } from '../../core/session_lifetime';
import * as scan from '../../core/scan';
import { StartupAttempt } from '../../core/startup';
import * as executables from '../../core/platform/executables';
import * as win32 from '../../core/platform/processes/win32';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/processes/darwin';
import type * as processes from '../../core/platform/processes';

describe('native session lifetime', () => {
  it('allows native terminateOnClose after a failed durable begin without table signaling or release', async (t) => {
    const transport = childTransport({
      bin: executables.named(process.execPath),
      cwd: process.cwd(),
      args: ['-e', 'process.stdin.resume();console.log("{}");'],
      terminateOnClose: true
    });
    t.after(async () => {
      transport.close();
      await transport.exited;
    });
    await new Promise<void>((resolve) => transport.onLine(() => resolve()));
    let signals = 0;
    let releases = 0;
    t.mock.method(platform.processes, 'signal', () => {
      signals++;
      return [];
    });
    const lifetime = new SessionLifetime(transport, {
      durableObservation: {
        begin: () => Promise.reject(new Error('durable write refused')),
        commit: () => Promise.resolve()
      },
      gone: () => {
        releases++;
        return Promise.resolve();
      }
    });
    await assert.rejects(lifetime.capture(), /durable write refused/);
    assert.equal(await lifetime.shutdown(), 'unresolved');
    assert.equal(await transport.exited, true);
    assert.equal(signals, 0);
    assert.equal(releases, 0);
  });

  it('records unprovable durable ownership once, never releases it and stops retrying', async (t) => {
    // The root exited before any table showed it: nothing was ever retained, so
    // no later observation can learn a member, and native exit proves nothing durable.
    const empty: scan.ProcessTable = {
      complete: true,
      startSource: 'ps-lstart-v1',
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map(),
      starts: new Map(),
      groups: new Map(),
      shellParents: new Set()
    };
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(empty));
    let begins = 0;
    let releases = 0;
    let unprovable = 0;
    // Not a literal: `unprovable` is an optional hook of the durable contract.
    const durable = {
      begin: () => Promise.resolve(++begins),
      commit: () => Promise.resolve(),
      unprovable: () => {
        unprovable++;
        return Promise.resolve();
      }
    };
    const lifetime = new SessionLifetime(
      { pid: 4242, exited: Promise.resolve(true), close() {} },
      {
        durableObservation: durable,
        gone: () => {
          releases++;
          return Promise.resolve();
        }
      }
    );
    await lifetime.capture();
    assert.equal(await lifetime.close(), 'unresolved');
    const observed = begins;
    assert.equal(await lifetime.reconcile(), 'unresolved');
    assert.equal(begins, observed, 'a futile reconcile must not observe again');
    assert.equal(releases, 0);
    assert.equal(unprovable, 1);
    assert.equal(lifetime.initialRoot, undefined);
  });

  it('closes pipes synchronously on shutdown before a pending scan returns', async (t) => {
    let observed!: (table: scan.ProcessTable) => void;
    const pending = new Promise<scan.ProcessTable>((resolve) => {
      observed = resolve;
    });
    t.mock.method(scan, 'scanProcesses', () => pending);
    let closed = 0;
    const scope = new SessionLifetime({
      pid: 42,
      close() {
        closed++;
      }
    });
    const cleanup = scope.shutdown();
    assert.equal(closed, 1);
    observed({
      complete: false,
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map(),
      starts: new Map(),
      groups: new Map(),
      shellParents: new Set()
    });
    assert.equal(await cleanup, 'unresolved');
    assert.equal(closed, 1);
  });

  it('allows a native child to flush on shutdown before escalation', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-flush-'));
    const marker = path.join(dir, 'flushed');
    const transport = childTransport({
      bin: executables.named(process.execPath),
      cwd: process.cwd(),
      args: [
        '-e',
        `let flushing=false;const finish=()=>{if(flushing)return;flushing=true;setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'flushed');process.exit(0)},400)};process.stdin.resume();process.stdin.on('end',finish);process.on('SIGTERM',finish);console.log('{}');`
      ]
    });
    const fixture: processes.Member[] = [];
    t.after(async () => {
      await killExact(fixture);
      await transport.exited;
      await fs.rm(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => transport.onLine(() => resolve()));
    fixture.push(identity(await scan.scanProcesses(true), transport.pid!));
    const lifetime = new SessionLifetime(transport);
    assert.equal(await lifetime.shutdown(), 'gone');
    assert.equal(await fs.readFile(marker, 'utf8'), 'flushed');
  });

  it('automatically refreshes unresolved cleanup after a late native exit', async (t) => {
    let nativeExit!: (native: boolean) => void;
    const exited = new Promise<boolean>((resolve) => {
      nativeExit = resolve;
    });
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve({
        complete: false,
        claude: new Map(),
        codex: new Map(),
        grok: new Map(),
        parents: new Map(),
        starts: new Map(),
        groups: new Map(),
        shellParents: new Set()
      })
    );
    let releases = 0;
    const lifetime = new SessionLifetime(
      {
        pid: 42,
        exited,
        close() {}
      },
      {
        gone: () => {
          releases++;
          return Promise.resolve();
        }
      }
    );
    const attempt = new StartupAttempt('late-native-exit');
    attempt.own(lifetime);
    const initial = await attempt.run(() =>
      Promise.resolve({ ok: false, reason: 'Opening failed.' })
    );
    assert.equal(initial.ok === false && initial.outcome, 'unknown');
    assert.equal(await lifetime.close(), 'unresolved');
    nativeExit(true);
    // No panel action or explicit reconcile: native exit is the lifecycle event.
    const until = Date.now() + 3000;
    let result = await lifetime.close();
    while (result !== 'gone' && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = await lifetime.close();
    }
    assert.equal(result, 'gone');
    assert.equal(releases, 1);
    assert.equal(attempt.outcome?.ok === false && attempt.outcome.outcome, 'stopped');
  });

  it('uses native root exit proof when descendant coverage is incomplete', async (t) => {
    let childKnown = false;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve({
        complete: false,
        claude: new Map(),
        codex: new Map(),
        grok: new Map(),
        parents: new Map(childKnown ? [[77, 42]] : []),
        starts: new Map(
          childKnown
            ? [
                [42, 10],
                [77, 11]
              ]
            : [[42, 10]]
        ),
        groups: new Map(),
        shellParents: new Set()
      })
    );
    const scope = new SessionLifetime({
      pid: 42,
      exited: Promise.resolve(true),
      close() {}
    });
    assert.equal(await scope.close(), 'gone');
    assert.equal(scope.descendantCoverage, 'limited');
    childKnown = true;
    const knownChild = new SessionLifetime({
      pid: 42,
      exited: Promise.resolve(true),
      close() {}
    });
    assert.equal(
      await knownChild.close(),
      'unresolved',
      'native root exit did not prove the known child exited'
    );
  });

  it('reports limited ancestry separately from confirmed native exit', async (t) => {
    const table = (root: boolean): scan.ProcessTable => ({
      complete: true,
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map(root ? [[42, 1]] : [[77, 1]]),
      starts: new Map(root ? [[42, 10]] : [[77, 11]]),
      groups: new Map(),
      shellParents: new Set()
    });
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table(++reads === 1)));
    const scope = new SessionLifetime({
      pid: 42,
      exited: Promise.resolve(true),
      close() {}
    });
    assert.equal(await scope.close(), 'gone');
    assert.equal(scope.descendantCoverage, 'limited');
    assert.equal(await scope.reconcile(), 'gone');
    assert.equal(scope.descendantCoverage, 'limited');
  });

  it('keeps a stubborn failed-start child through escalation and closes native resources once', async (t) => {
    const transport = childTransport({
      bin: executables.named(process.execPath),
      cwd: process.cwd(),
      args: [
        '-e',
        "const child=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);console.log(JSON.stringify({child:child.pid}));"
      ]
    });
    const fixture: processes.Member[] = [];
    t.after(async () => {
      await killExact(fixture);
      await transport.exited;
    });
    const scope = new SessionLifetime(transport);
    const attempt = new StartupAttempt('stubborn-start');
    t.after(() => attempt.stop());
    attempt.own(scope);
    let closes = 0;
    scope.register(() => {
      closes++;
    });
    const child = await new Promise<number>((resolve) =>
      transport.onLine((value) => resolve((value as { child: number }).child))
    );
    const opened = await scan.scanProcesses(true);
    const root = identity(opened, transport.pid!);
    const grandchild = identity(opened, child);
    fixture.push(grandchild, root);
    assert.equal(opened.parents.get(child), root.pid);
    const failed = attempt.run(() => Promise.resolve({ ok: false, reason: 'Opening failed.' }));
    const first = scope.close();
    assert.equal(scope.close(), first);
    const outcome = await failed;
    assert.equal(closes, 1);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.outcome, 'unknown');
    assert.equal((await scan.scanProcesses(true)).starts.get(root.pid), root.startedAt);
    assert.equal(await first, 'gone');
    assert.equal(attempt.outcome?.ok === false && attempt.outcome.outcome, 'stopped');
    assert.equal(await transport.exited, true);
    const closed = await scan.scanProcesses(true);
    assert.equal(closed.complete, true);
    gone(closed, root);
    gone(closed, grandchild);
  });

  it('cannot call an incomplete native scan proof of termination', async (t) => {
    const table: scan.ProcessTable = {
      complete: false,
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map(),
      starts: new Map(),
      groups: new Map(),
      shellParents: new Set()
    };
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table));
    let closed = 0;
    const scope = new SessionLifetime({
      pid: 42,
      close() {
        closed++;
      }
    });
    assert.equal(await scope.close(), 'unresolved');
    assert.equal(closed, 1);
  });

  it('automatically retries a transient scan failure without a native-exit event', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const table = (complete: boolean, alive: boolean): scan.ProcessTable => ({
      complete,
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map(),
      starts: new Map(alive ? [[42, 10]] : []),
      groups: new Map(),
      shellParents: new Set()
    });
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(
        ++reads <= 2 ? table(true, true) : reads === 3 ? table(false, false) : table(true, false)
      )
    );
    let closed = 0;
    let released = 0;
    const scope = new SessionLifetime(
      {
        pid: 42,
        exited: Promise.resolve(false),
        close() {
          closed++;
        }
      },
      {
        gone: () => {
          released++;
          return Promise.resolve();
        }
      }
    );
    const closing = scope.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5000);
    assert.equal(await closing, 'unresolved');
    t.mock.timers.tick(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await scope.close(), 'gone');
    assert.equal(closed, 1);
    assert.equal(released, 1);
    const observed = reads;
    t.mock.timers.runAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, observed, 'confirmed cleanup left a retry timer alive');
  });

  it('does not adopt a later PID identity after the initial native observation failed', async (t) => {
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve({
        complete: ++reads > 1,
        claude: new Map(),
        codex: new Map(),
        grok: new Map(),
        parents: new Map(),
        starts: new Map(reads > 1 ? [[42, 20]] : []),
        groups: new Map(),
        shellParents: new Set()
      })
    );
    const signals = t.mock.method(process, 'kill', () => {
      throw new Error('Unidentified PID must not be signalled.');
    });
    const scope = new SessionLifetime({
      pid: 42,
      close() {}
    });
    assert.equal(await scope.close(), 'unresolved');
    assert.deepEqual(scope.knownMembers, []);
    assert.equal(signals.mock.callCount(), 0);
  });

  it('never signals a PID that changed identity during the close grace', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const table = (start: number): scan.ProcessTable => ({
      complete: true,
      claude: new Map(),
      codex: new Map(),
      grok: new Map(),
      parents: new Map([[42, 1]]),
      starts: new Map([[42, start]]),
      groups: new Map([[42, 1]]),
      shellParents: new Set()
    });
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(table(++reads <= 2 ? 10 : 20)));
    const signals = t.mock.method(process, 'kill', () => {
      throw new Error('A reused PID must not be signalled.');
    });
    const scope = new SessionLifetime({
      pid: 42,
      close() {}
    });
    const result = scope.close();
    for (const ms of [5_000, 2_000, 6_000, 100]) {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      t.mock.timers.tick(ms);
    }
    assert.equal(await result, 'gone');
    assert.equal(signals.mock.callCount(), 0);
  });
});

describe('native session lifetime, signalling through the processes capability', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const transport = (exited: Promise<boolean>): NativeChild => ({
    pid: 42,
    exited,
    close() {}
  });

  it('releases owned cleanup on native root exit where this OS has no process table, and not before', async (t) => {
    // No table proves nothing either way, so close alone stays unresolved and
    // keeps retrying; the root's own exit is independent proof, and with no
    // descendant ever observed it releases the slot with limited coverage.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const none = scan.tableOf({
      supported: false,
      reason: 'processes.snapshot is unavailable here'
    });
    const reads = t.mock.method(scan, 'scanProcesses', () => Promise.resolve(none));
    const signals = t.mock.method(process, 'kill', () => {
      throw new Error('Nothing may be signalled without a table.');
    });
    let nativeExit!: (native: boolean) => void;
    let released = 0;
    const observed: string[] = [];
    const lifetime = new SessionLifetime(
      transport(
        new Promise<boolean>((resolve) => {
          nativeExit = resolve;
        })
      ),
      {
        observed: (result) => {
          observed.push(result);
        },
        gone: () => {
          released++;
          return Promise.resolve();
        }
      }
    );
    assert.equal(await lifetime.close(), 'unresolved');
    assert.deepEqual(observed, ['unresolved'], 'missing evidence is not a failed End');
    assert.equal(released, 0);

    nativeExit(true);
    await settle();
    assert.equal(await lifetime.close(), 'gone');
    assert.equal(released, 1);
    assert.deepEqual(observed, ['unresolved', 'gone']);
    assert.equal(lifetime.descendantCoverage, 'limited');
    assert.equal(signals.mock.callCount(), 0);
    const readCount = reads.mock.callCount();
    t.mock.timers.runAll();
    await settle();
    assert.equal(reads.mock.callCount(), readCount, 'released cleanup left a retry timer alive');
  });

  it('keeps a remembered child through a refuted link and reparenting after root exit', async (t) => {
    const posix = darwin.processes({
      run: () => Promise.reject(new Error('scans are mocked')),
      kill: (pid, signal) => {
        process.kill(pid, signal);
      }
    });
    t.mock.method(platform.processes, 'signal', posix.signal.bind(posix));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let killed = false;
    const table = (rows: import('../../core/platform/processes').Row[]): scan.ProcessTable =>
      scan.tableOf({
        supported: true,
        status: 'ok',
        value: { source: 'ps-lstart-v1', rows }
      });
    const root = { pid: 42, ppid: 1, startedAt: 10, command: 'codex' };
    const child = { pid: 77, ppid: 42, pgid: 77, startedAt: 11, command: 'sh' };
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () => {
      reads++;
      return Promise.resolve(
        table(
          reads === 1
            ? [root, child]
            : reads === 2
              ? [root, { ...child, ppid: 88 }, { pid: 88, ppid: 1, startedAt: 12, command: 'node' }]
              : killed
                ? []
                : [{ ...child, ppid: 1 }]
        )
      );
    });
    const sent: [number, string | number | undefined][] = [];
    t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      sent.push([pid, signal]);
      if (signal === 'SIGKILL') killed = true;
      return true;
    });
    const remembered: number[][] = [];
    let nativeExit!: (native: boolean) => void;
    const lifetime = new SessionLifetime(
      transport(
        new Promise<boolean>((resolve) => {
          nativeExit = resolve;
        })
      ),
      {
        remember: (members) => {
          remembered.push(members.map((member) => member.pid));
          return Promise.resolve();
        }
      }
    );
    await settle();
    nativeExit(true);
    await settle();
    const result = lifetime.close();
    for (const ms of [2_000, 100]) {
      await settle();
      t.mock.timers.tick(ms);
    }
    assert.equal(await result, 'gone');
    assert.deepEqual(sent, [
      [-77, 'SIGTERM'],
      [-77, 'SIGKILL']
    ]);
    assert.ok(remembered.every((pids) => pids.includes(77)));
  });

  for (const rootSurvives of [false, true]) {
    it(`preserves ${rootSurvives ? 'the live root flush grace' : 'one sweep after root exit'} until disappearance confirms release`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const posix = darwin.processes({
        run: () => Promise.reject(new Error('scans are mocked')),
        kill: (pid, signal) => {
          process.kill(pid, signal);
        }
      });
      t.mock.method(platform.processes, 'signal', posix.signal.bind(posix));
      const root = { pid: 42, ppid: 1, startedAt: 10, command: 'codex' };
      const child = { pid: 77, ppid: 42, startedAt: 11, command: 'tool' };
      const unrelated = { pid: 88, ppid: 1, startedAt: 12, command: 'other' };
      let rootAlive = true;
      let childVisible = true;
      t.mock.method(scan, 'scanProcesses', () =>
        Promise.resolve(
          scan.tableOf({
            supported: true,
            status: 'ok',
            value: {
              source: 'ps-lstart-v1',
              rows: [
                unrelated,
                ...(rootAlive ? [root] : []),
                ...(childVisible ? [{ ...child, ppid: rootAlive ? root.pid : 1 }] : [])
              ]
            }
          })
        )
      );
      const sent: [number, string | number | undefined][] = [];
      t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
        sent.push([pid, signal]);
        return true;
      });
      let nativeExit!: (native: boolean) => void;
      let releases = 0;
      const lifetime = new SessionLifetime(
        transport(
          new Promise<boolean>((resolve) => {
            nativeExit = resolve;
          })
        ),
        {
          gone: () => {
            releases++;
            return Promise.resolve();
          }
        }
      );
      await lifetime.capture();
      rootAlive = rootSurvives;
      if (!rootSurvives) nativeExit(true);
      await settle();
      const result = lifetime.close();
      await settle();
      if (rootSurvives) {
        assert.deepEqual(sent, []);
        t.mock.timers.tick(5_000);
        await settle();
      }
      const stopped: [number, string][] = rootSurvives
        ? [
            [77, 'SIGTERM'],
            [42, 'SIGTERM']
          ]
        : [[77, 'SIGTERM']];
      assert.deepEqual(sent, stopped);
      t.mock.timers.tick(1_999);
      await settle();
      assert.deepEqual(sent, stopped);
      t.mock.timers.tick(1);
      await settle();
      if (rootSurvives) {
        assert.deepEqual(sent, [...stopped, [77, 'SIGKILL']]);
        t.mock.timers.tick(5_999);
        await settle();
        assert.deepEqual(sent, [...stopped, [77, 'SIGKILL']]);
        t.mock.timers.tick(1);
        await settle();
      }
      const beforeConfirmation = sent.map(([pid, signal]) => [pid, signal]);
      const held = releases;
      // Successful KILL delivery is not proof the native row has disappeared.
      rootAlive = false;
      childVisible = false;
      t.mock.timers.tick(100);
      await settle();
      assert.equal(await result, 'gone');
      assert.equal(held, 0);
      assert.equal(releases, 1);
      const expected = rootSurvives
        ? [...stopped, [77, 'SIGKILL'], [77, 'SIGKILL'], [42, 'SIGKILL']]
        : [...stopped, [77, 'SIGKILL']];
      assert.deepEqual(beforeConfirmation, expected);
      assert.equal(await lifetime.reconcile(), 'gone');
      assert.equal(releases, 1);
      assert.deepEqual(sent, expected);
    });
  }

  it('retries cleanup whose member observation could not be saved', async (t) => {
    // A durable observation that failed to write keeps the slot held: the
    // lifetime does not release what it could not record, and its own retry
    // finishes the job once the root is proven gone.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let alive = true;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve({
        complete: true,
        startSource: 'ps-lstart-v1' as const,
        claude: new Map(),
        codex: new Map(),
        grok: new Map(),
        parents: new Map(alive ? [[42, 1]] : []),
        starts: new Map(alive ? [[42, 10]] : []),
        groups: new Map(alive ? [[42, 1]] : []),
        shellParents: new Set<number>()
      })
    );
    const signals = t.mock.method(process, 'kill', () => true);
    let failing = true;
    let released = 0;
    const lifetime = new SessionLifetime(transport(Promise.resolve(false)), {
      remember: () => (failing ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      gone: () => {
        released++;
        return Promise.resolve();
      }
    });
    assert.equal(await lifetime.close(), 'unresolved');
    assert.equal(released, 0);
    assert.equal(signals.mock.callCount(), 0);

    failing = false;
    alive = false;
    t.mock.timers.tick(1_000);
    await settle();
    assert.equal(await lifetime.close(), 'gone');
    assert.equal(released, 1);
  });
});

describe('native session lifetime, on the Windows ending', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  type Row = import('../../core/platform/processes').Row;
  const windowsTable = (rows: Row[], complete = true): scan.ProcessTable =>
    scan.tableOf({
      supported: true,
      status: complete ? 'ok' : 'incomplete',
      value: { source: 'win32-filetime-ms-v1', rows },
      ...(complete ? {} : { reason: 'one row unreadable' })
    } as import('../../core/platform/processes').Snapshot);
  const ROOT = { pid: 42, ppid: 1, startedAt: 1_792_994_000_000, command: 'codex.exe' };
  const TOOL = { pid: 77, ppid: 42, startedAt: 1_792_994_000_500, command: 'powershell.exe' };
  /** The unselected Windows ending standing in for `platform.processes`, kills recorded. */
  const windowsEnding = (
    t: import('node:test').TestContext,
    refuse = false
  ): [number, string][] => {
    const sent: [number, string][] = [];
    const ending = win32.signalling({
      kill: (pid, signal) => {
        sent.push([pid, signal]);
        if (refuse) throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
      }
    });
    t.mock.method(platform.processes, 'signal', ending.signal.bind(ending));
    return sent;
  };
  const exitable = (): { exited: Promise<boolean>; exit(): void } => {
    let exit!: () => void;
    const exited = new Promise<boolean>((resolve) => {
      exit = () => resolve(true);
    });
    return { exited, exit };
  };

  it('serializes durable capture and close through the first committed observation', async (t) => {
    let firstCommit!: () => void;
    const held = new Promise<void>((resolve) => {
      firstCommit = resolve;
    });
    const events: string[] = [];
    let generation = 0;
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable(++reads === 1 ? [ROOT] : []))
    );
    const lifetime = new SessionLifetime(
      { pid: ROOT.pid, close() {} },
      {
        durableObservation: {
          begin: () => {
            events.push(`begin:${++generation}`);
            return Promise.resolve(generation);
          },
          commit: async (generation) => {
            events.push(`commit:${generation}`);
            if (generation === 1) await held;
          }
        }
      }
    );
    const closed = lifetime.close();
    await settle();
    assert.deepEqual(events, ['begin:1', 'commit:1']);
    firstCommit();
    assert.equal(await closed, 'gone');
    assert.deepEqual(events, ['begin:1', 'commit:1', 'begin:2', 'commit:2']);
    assert.equal(lifetime.initialRoot?.startSource, 'win32-filetime-ms-v1');
  });

  it('never establishes a missing initial root from a later occupant of its PID', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    let signals = 0;
    const commits: boolean[] = [];
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(
        ++reads === 1
          ? windowsTable([], false)
          : windowsTable([{ ...ROOT, startedAt: ROOT.startedAt + 10 }])
      )
    );
    t.mock.method(platform.processes, 'signal', () => {
      signals++;
      return [];
    });
    const lifetime = new SessionLifetime(
      { pid: ROOT.pid, close() {} },
      {
        durableObservation: {
          begin: () => Promise.resolve(1),
          commit: (_generation, _members, table) => {
            commits.push(table.complete === true);
            return Promise.resolve();
          }
        }
      }
    );
    await lifetime.capture();
    assert.equal(await lifetime.close(), 'unresolved');
    assert.equal(lifetime.initialRoot, undefined);
    assert.deepEqual(lifetime.knownMembers, []);
    assert.deepEqual(commits, [false, true]);
    assert.equal(signals, 0);
  });

  it('reports refused native shutdown on every attempt, retaining its graces and ownership', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t, true);
    let visible = true;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable(visible ? [ROOT, TOOL] : []))
    );
    let released = 0;
    const observed: string[] = [];
    const lifetime = new SessionLifetime(
      { pid: 42, exited: exitable().exited, close() {} },
      {
        observed: (result) => {
          observed.push(result);
        },
        gone: () => {
          released++;
          return Promise.resolve();
        }
      }
    );
    await lifetime.capture();
    const result = lifetime.close();
    await settle();
    t.mock.timers.tick(5_000);
    await settle();
    // `stop` asks nothing on Windows, so the stdin grace's end sends nothing.
    assert.deepEqual(sent, []);
    t.mock.timers.tick(2_000);
    await settle();
    assert.deepEqual(sent, [[77, 'SIGKILL']]);
    t.mock.timers.tick(6_000);
    await settle();
    assert.deepEqual(sent, [
      [77, 'SIGKILL'],
      [77, 'SIGKILL'],
      [42, 'SIGKILL']
    ]);
    // A delivered TerminateProcess is not a death: only a read without them is.
    t.mock.timers.tick(100);
    await settle();
    assert.equal(await result, 'failed');
    assert.equal(released, 0);
    assert.deepEqual(observed, ['failed']);
    t.mock.timers.tick(1_000);
    await settle();
    t.mock.timers.tick(5_000);
    await settle();
    t.mock.timers.tick(2_000);
    await settle();
    t.mock.timers.tick(6_000);
    await settle();
    t.mock.timers.tick(100);
    await settle();
    assert.deepEqual(observed, ['failed', 'failed'], 'automatic retry did not report failure');
    visible = false;
    assert.equal(await lifetime.reconcile(), 'gone');
    assert.equal(released, 1);
    assert.deepEqual(observed, ['failed', 'failed', 'gone']);
  });

  it('terminates a retained member that kept its dead root number after native exit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    const native = exitable();
    let rootAlive = true;
    let toolAlive = true;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable([...(rootAlive ? [ROOT] : []), ...(toolAlive ? [TOOL] : [])]))
    );
    t.mock.method(process, 'kill', () => true);
    const lifetime = new SessionLifetime({ pid: 42, exited: native.exited, close() {} });
    await lifetime.capture();
    rootAlive = false;
    native.exit();
    await settle();
    const result = lifetime.close();
    await settle();
    t.mock.timers.tick(2_000);
    await settle();
    assert.deepEqual(sent, [[77, 'SIGKILL']]);
    toolAlive = false;
    t.mock.timers.tick(100);
    await settle();
    assert.equal(await result, 'gone');
  });

  it('never terminates a member whose Windows start changed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    const native = exitable();
    let reads = 0;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(
        windowsTable(++reads === 1 ? [ROOT, TOOL] : [{ ...TOOL, startedAt: TOOL.startedAt + 1 }])
      )
    );
    const lifetime = new SessionLifetime({ pid: 42, exited: native.exited, close() {} });
    await lifetime.capture();
    native.exit();
    await settle();
    assert.equal(await lifetime.close(), 'gone');
    assert.deepEqual(sent, []);
  });

  it('holds capacity while a Windows member observation cannot be saved', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    t.mock.method(scan, 'scanProcesses', () => Promise.resolve(windowsTable([ROOT, TOOL])));
    let released = 0;
    const lifetime = new SessionLifetime(
      { pid: 42, exited: exitable().exited, close() {} },
      {
        remember: () => Promise.reject(new Error('disk full')),
        gone: () => {
          released++;
          return Promise.resolve();
        }
      }
    );
    assert.equal(await lifetime.close(), 'unresolved');
    assert.equal(released, 0);
    assert.deepEqual(sent, []);
  });

  // Sol's review, 2026-10-26 (F1): a retained tool's own child, seen in every
  // action read after the root exited, must not be released as gone.
  const R = { pid: 420, ppid: 1, startedAt: 1_792_994_000_000, command: 'codex.exe' };
  const T = { pid: 770, ppid: 420, startedAt: 1_792_994_000_500, command: 'node.exe' };
  const G = { pid: 880, ppid: 770, startedAt: 1_792_994_001_000, command: 'node.exe' };

  it('retains and terminates a grandchild of a retained tool, and does not release while it is visible', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events: string[] = [];
    const ending = win32.signalling({
      kill: (pid) => {
        events.push(`kill ${pid}`);
      }
    });
    t.mock.method(platform.processes, 'signal', ending.signal.bind(ending));
    let phase: 'capture' | 'tool' | 'grand' | 'none' = 'capture';
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(
        windowsTable(
          phase === 'capture' ? [R, T] : phase === 'tool' ? [T, G] : phase === 'grand' ? [G] : []
        )
      )
    );
    const native = exitable();
    let released = 0;
    const lifetime = new SessionLifetime(
      { pid: R.pid, exited: native.exited, close() {} },
      {
        remember: (members) => {
          events.push(`remember ${members.map((member) => member.pid).join(',')}`);
          return Promise.resolve();
        },
        gone: () => {
          released++;
          return Promise.resolve();
        }
      }
    );
    await lifetime.capture();
    phase = 'tool';
    native.exit();
    await settle();
    const result = lifetime.close();
    await settle();
    t.mock.timers.tick(2_000);
    await settle();
    // Deepest first, and only after 880 was durably remembered.
    const kills = events.filter((event) => event.startsWith('kill'));
    assert.deepEqual(kills, ['kill 880', 'kill 770']);
    const remembered = events.findIndex(
      (event) => event.startsWith('remember') && event.split(' ')[1]?.split(',').includes('880')
    );
    assert.ok(remembered !== -1 && remembered < events.indexOf('kill 880'));
    phase = 'grand';
    t.mock.timers.tick(100);
    await settle();
    assert.equal(
      await result,
      'unresolved',
      'successful kill delivery is not proof of failure or exit'
    );
    assert.equal(released, 0);
    assert.ok(lifetime.knownMembers.some((member) => member.pid === G.pid));
    phase = 'none';
    assert.equal(await lifetime.reconcile(), 'gone');
    assert.equal(released, 1);
  });

  it('never adopts the child of a retained member whose start changed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    let reads = 0;
    // 770 now belongs to another process, and 880 is that process's child.
    const recycled = { ...T, startedAt: T.startedAt + 1 };
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable(++reads === 1 ? [R, T] : [recycled, G]))
    );
    const native = exitable();
    const lifetime = new SessionLifetime({ pid: R.pid, exited: native.exited, close() {} });
    await lifetime.capture();
    native.exit();
    await settle();
    assert.equal(await lifetime.close(), 'gone');
    assert.deepEqual(sent, []);
    assert.ok(lifetime.knownMembers.every((member) => member.pid !== G.pid));
  });

  it('never adopts a child of a bare dead root number', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    let reads = 0;
    // The root's number now names nothing; 880 claims it as parent.
    const orphan = { ...G, ppid: R.pid };
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable(++reads === 1 ? [R] : [orphan]))
    );
    const native = exitable();
    const lifetime = new SessionLifetime({ pid: R.pid, exited: native.exited, close() {} });
    await lifetime.capture();
    native.exit();
    await settle();
    assert.equal(await lifetime.close(), 'gone');
    assert.deepEqual(sent, []);
  });

  it('terminates a growing tree deepest first, by its current ancestry (F3)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = windowsEnding(t);
    let reads = 0;
    let visible = true;
    t.mock.method(scan, 'scanProcesses', () =>
      Promise.resolve(windowsTable(!visible ? [] : ++reads === 1 ? [R, T] : [R, T, G]))
    );
    const lifetime = new SessionLifetime({ pid: R.pid, exited: exitable().exited, close() {} });
    await lifetime.capture();
    const result = lifetime.close();
    await settle();
    t.mock.timers.tick(5_000);
    await settle();
    t.mock.timers.tick(2_000);
    await settle();
    assert.deepEqual(
      sent.map(([pid]) => pid),
      [880, 770]
    );
    t.mock.timers.tick(6_000);
    await settle();
    assert.deepEqual(
      sent.map(([pid]) => pid),
      [880, 770, 880, 770, 420]
    );
    visible = false;
    t.mock.timers.tick(100);
    await settle();
    assert.equal(await result, 'gone');
  });
});

/**
 * A fixture process by its exact start. Windows hands a freed pid to the next
 * process within seconds under a gate's load, so a bare pid proves nothing, and
 * teardown never signals one.
 */
function identity(table: scan.ProcessTable, pid: number): processes.Member {
  const startedAt = table.starts.get(pid);
  assert.ok(startedAt !== undefined, `fixture pid ${pid} is not in the table`);
  return { pid, startedAt };
}

/** Kills only the rows that still carry these exact starts. */
async function killExact(members: readonly processes.Member[]): Promise<void> {
  if (members.length > 0)
    platform.processes.signal(members, 'kill', await scan.scanProcesses(true));
}

function gone(table: scan.ProcessTable, member: processes.Member): void {
  assert.notEqual(
    table.starts.get(member.pid),
    member.startedAt,
    `pid ${member.pid} still starts at ${member.startedAt} (${String(table.startSource)})`
  );
}
