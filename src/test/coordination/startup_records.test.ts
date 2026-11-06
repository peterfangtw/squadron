import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { disposeHome, homeEnv, outRoot, tempHome, testPlatform } from '../helpers';
import * as executables from '../../core/platform/executables';
import * as platform from '../../core/platform';
import type { Snapshot } from '../../core/platform/processes';

let home: string;
let records: typeof import('../../core/coordination/startup_records');
let paths: typeof import('../../core/paths');
after(() => disposeHome(home));

before(async () => {
  home = await tempHome();
  records = await import('../../core/coordination/startup_records');
  paths = await import('../../core/paths');
});

async function reset(): Promise<void> {
  await fs.rm(paths.STARTUPS_DIR, { recursive: true, force: true });
  await fs.mkdir(paths.STARTUPS_DIR, { recursive: true });
}

/**
 * One admission in its own process. A refusal for another window's claim on
 * the admission lock is transient contention, retried here up to `tries`
 * times; any other refusal is the answer. All contenders in a campaign share
 * one policy time: native lock contention may itself take longer than a minute.
 */
function contender(tries = 1, decisionTime = Date.now()): Promise<string> {
  const script = `
    Date.now=()=>${decisionTime};
    const {processes}=require(${JSON.stringify(path.join(outRoot(), 'core/platform/index.js'))});
    const {reserveStartup}=require(${JSON.stringify(path.join(outRoot(), 'core/coordination/startup_records.js'))});
    const lease=processes.own(), snapshot=processes.snapshot.bind(processes), reads=[];
    processes.snapshot=async()=>{
      const at=performance.now(), result=await snapshot();
      reads.push({ms:performance.now()-at,supported:result.supported,status:result.status,reason:result.reason});
      return result;
    };
    (async()=>{
      try {
        for(let i=0;;i++){
          let reservation;
          try { reservation=await reserveStartup(require('crypto').randomUUID()); }
          catch(e){
            if(i+1>=${tries}||!/Another window is admitting/.test(e.message))return 'refused:'+e.message;
            await new Promise(t=>setTimeout(t,50+Math.random()*100));
            continue;
          }
          // Once reserved, a failed spawning receipt is uncertain and must never retry.
          await reservation.spawning();
          return 'admitted';
        }
      } finally {
        const disposal=await lease.dispose();
        console.error(JSON.stringify({stage:'native-reader',reads,disposal}));
        if(disposal.unresolved.length)throw new Error('reader cleanup unresolved');
      }
    })().then(v=>console.log(v)).catch(e=>{console.error(e);process.exitCode=1});`;
  return new Promise((resolve, reject) =>
    childProcess.execFile(
      process.execPath,
      ['-e', script],
      { env: homeEnv(home) },
      (error, stdout, stderr) => {
        process.stderr.write(stderr);
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout.trim());
      }
    )
  );
}

async function contenders(): Promise<string[]> {
  const decisionTime = Date.now();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 12 }, () => contender(40, decisionTime))
  );
  return outcomes.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    throw outcome.reason;
  });
}

describe('machine-wide startup admission', () => {
  it('finishes a receipt read before publishing its next phase', async (t) => {
    await reset();
    const id = randomUUID();
    const slot = await records.reserveStartup(id);
    const file = path.join(paths.STARTUPS_DIR, `${id}.json`);
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    let opened!: () => void;
    let unblock!: () => void;
    const reading = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let held = false;
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      const text = await readFile(...args);
      if (args[0] === file) {
        held = true;
        opened();
        await released;
        held = false;
      }
      return text;
    });
    const link = fs.link;
    t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      try {
        return await link(...args);
      } finally {
        if (args[1] === lock && held) unblock();
      }
    });
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === file && held) {
        unblock();
        throw Object.assign(new Error('receipt reader denies replacement'), { code: 'EPERM' });
      }
      return rename(...args);
    });
    const admission = records.reserveStartup(randomUUID());
    await reading;
    const results = await Promise.allSettled([admission, slot.spawning()]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'fulfilled']
    );
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).phase, 'spawning');
  });

  it('failed and incomplete native reads cannot admit or rewrite durable startup receipts', async (t) => {
    await reset();
    const slot = await records.reserveStartup(randomUUID());
    await slot.spawning();
    const files = await fs.readdir(paths.STARTUPS_DIR);
    const prior = await Promise.all(
      files.map((file) => fs.readFile(path.join(paths.STARTUPS_DIR, file), 'utf8'))
    );
    const failures = [
      { supported: true, status: 'failed', reason: 'controlled-reader-failure' },
      {
        supported: true,
        status: 'incomplete',
        reason: 'controlled-partial-frame',
        value: { source: 'win32-filetime-ms-v1', rows: [] }
      }
    ] satisfies Snapshot[];
    for (const result of failures) {
      const mocked = t.mock.method(platform.processes, 'snapshot', () => Promise.resolve(result));
      await assert.rejects(
        records.reserveStartup(randomUUID()),
        /Native process identity is unavailable/
      );
      assert.deepEqual(await fs.readdir(paths.STARTUPS_DIR), files);
      assert.deepEqual(
        await Promise.all(
          files.map((file) => fs.readFile(path.join(paths.STARTUPS_DIR, file), 'utf8'))
        ),
        prior
      );
      t.diagnostic(
        JSON.stringify({
          stage: 'pre-admission-refusal',
          status: result.supported && result.status,
          reason: result.reason
        })
      );
      mocked.mock.restore();
    }
  });
  it(
    'reports a held startup receipt without advancing it or retrying publication',
    {
      skip: testPlatform() !== 'win32' && 'posix: an open read handle does not deny replacement'
    },
    async (t) => {
      await reset();
      const id = randomUUID();
      const slot = await records.reserveStartup(id);
      const file = path.join(paths.STARTUPS_DIR, `${id}.json`);
      const original = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      const handle = await fs.open(file, 'r');
      const rename = fs.rename;
      let denied = 0;
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
        try {
          await rename(...args);
        } catch (error) {
          if (args[1] === file) {
            assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
            denied++;
          }
          throw error;
        }
      });
      try {
        await assert.rejects(slot.spawning(), /Startup reservation could not be saved/);
        assert.equal(denied, 1);
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
        assert.deepEqual(await fs.readdir(paths.STARTUPS_DIR), [`${id}.json`]);
      } finally {
        await handle.close();
      }
      await slot.spawning();
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
        ...original,
        phase: 'spawning'
      });
      await slot.release();
    }
  );

  it('reports durable attempt replay as unknown without replacing its receipt', async () => {
    await reset();
    const { StartupUnknown } = await import('../../core/startup');
    const id = randomUUID();
    const slot = await records.reserveStartup(id);
    await slot.spawning();
    await assert.rejects(records.reserveStartup(id), StartupUnknown);
    const raw = JSON.parse(
      await fs.readFile(path.join(paths.STARTUPS_DIR, `${id}.json`), 'utf8')
    ) as { phase: string };
    assert.equal(raw.phase, 'spawning');
  });

  it('removes a partial claim when its initial write fails', async (t) => {
    await reset();
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      await write(...args);
      if (typeof args[0] === 'string' && args[0].includes('admission.lock.'))
        throw new Error('Injected partial write failure');
    });
    await assert.rejects(records.reserveStartup('partial-write'), /Injected partial write/);
    assert.deepEqual(await fs.readdir(paths.STARTUPS_DIR), []);
  });

  it('prunes abandoned claim temporaries without deleting live claims or uncertain receipts', async () => {
    await reset();
    const { scanProcesses } = await import('../../core/scan');
    const table = await scanProcesses(true);
    const startedAt = table.starts.get(process.pid)!;
    // Tagged with the clock they were read on, as every new record is.
    const alive = {
      pid: process.pid,
      startedAt,
      startSource: table.startSource,
      generation: 'alive'
    };
    const dead = { ...alive, startedAt: startedAt - 60000, generation: 'dead' };
    const recoveryTemporary = `settling.json.${process.pid}.0.tmp`;
    const files = [
      [
        recoveryTemporary,
        JSON.stringify({
          schema: 1,
          id: 'recovering',
          admittedAt: 0,
          owner: dead,
          phase: 'spawning'
        })
      ],
      ['admission.lock.dead.tmp', JSON.stringify(dead)],
      ['admission.lock.alive.tmp', JSON.stringify(alive)],
      ['orphan.json.old.tmp', 'partial'],
      ['fresh.json.new.tmp', 'partial'],
      ['admission.lock', JSON.stringify(dead)],
      [
        'uncertain.json',
        JSON.stringify({
          schema: 1,
          id: 'uncertain',
          admittedAt: 0,
          owner: dead,
          phase: 'spawning'
        })
      ]
    ];
    for (const [name, text] of files) {
      const file = path.join(paths.STARTUPS_DIR, name!);
      await fs.writeFile(file, text!);
      if (!name!.startsWith('fresh')) await fs.utimes(file, new Date(0), new Date(0));
    }
    await records.pruneStartupRecords();
    assert.deepEqual((await fs.readdir(paths.STARTUPS_DIR)).sort(), [
      'admission.lock.alive.tmp',
      'fresh.json.new.tmp',
      recoveryTemporary,
      'uncertain.json'
    ]);
  });

  it('keeps an untagged claim temporary unless this machine reads the legacy clock', async () => {
    await reset();
    const { scanProcesses } = await import('../../core/scan');
    const table = await scanProcesses(true);
    // No tag means `ps-lstart-v1`: on any other clock it can be neither judged
    // dead nor relabelled, so it stays.
    const legacy = {
      pid: process.pid,
      startedAt: table.starts.get(process.pid)! - 60000,
      generation: 'legacy'
    };
    const file = path.join(paths.STARTUPS_DIR, 'admission.lock.legacy.tmp');
    await fs.writeFile(file, JSON.stringify(legacy));
    await fs.utimes(file, new Date(0), new Date(0));
    await records.pruneStartupRecords();
    const kept = (await fs.readdir(paths.STARTUPS_DIR)).includes('admission.lock.legacy.tmp');
    assert.equal(kept, table.startSource !== 'ps-lstart-v1');
  });

  it('recovers dead-owner bound receipts beyond the fleet limit', async () => {
    await reset();
    const { scanProcesses } = await import('../../core/scan');
    const table = await scanProcesses(true);
    const startedAt = table.starts.get(process.pid)!;
    // Exact mismatches model recycled native identities, not elapsed-age guesses.
    for (let i = 0; i < 16; i++) {
      const id = `dead-bound-${i}`;
      await fs.writeFile(
        path.join(paths.STARTUPS_DIR, `${id}.json`),
        JSON.stringify({
          schema: 1,
          id,
          admittedAt: Date.now() - 120000,
          owner: {
            pid: process.pid,
            startedAt: startedAt - 60000,
            startSource: table.startSource,
            generation: id
          },
          phase: 'spawned',
          child: { pid: process.pid, startedAt: startedAt - 60000, startSource: table.startSource },
          members: [
            { pid: process.pid, startedAt: startedAt - 60000, startSource: table.startSource }
          ]
        })
      );
    }
    const slot = await records.reserveStartup('after-dead-hosts');
    await slot.release();
    for (let i = 0; i < 16; i++) {
      const record = JSON.parse(
        await fs.readFile(path.join(paths.STARTUPS_DIR, `dead-bound-${i}.json`), 'utf8')
      ) as { phase: string };
      assert.equal(record.phase, 'settled');
    }
  });

  it('reclaims capacity after sixteen ordinary confirmed native exits', async (t) => {
    await reset();
    const { childTransport } = await import('../../core/session');
    const { SessionLifetime } = await import('../../core/session_lifetime');
    const { scanProcesses } = await import('../../core/scan');
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 16; i++) {
      now += 61_000;
      const slot = await records.reserveStartup(randomUUID());
      await slot.spawning();
      const transport = childTransport({
        bin: executables.named(process.execPath),
        cwd: process.cwd(),
        args: ['-e', 'process.stdin.resume()']
      });
      const scope = new SessionLifetime(transport, {
        remember: (members) => slot.remember(members),
        gone: () => slot.release()
      });
      t.after(async () => {
        transport.close();
        await scope.shutdown();
      });
      assert.ok(transport.pid);
      await slot.bind(transport.pid);
      await scanProcesses(true);
      transport.close();
      assert.equal(await transport.exited, true);
      assert.equal(await scope.close(), 'gone');
      assert.equal(scope.descendantCoverage, 'limited');
    }
    const receipts = (await fs.readdir(paths.STARTUPS_DIR)).filter((name) =>
      name.endsWith('.json')
    );
    assert.equal(receipts.length, 16);
    for (const file of receipts) {
      const raw = JSON.parse(await fs.readFile(path.join(paths.STARTUPS_DIR, file), 'utf8')) as {
        phase: string;
      };
      assert.equal(raw.phase, 'settled');
    }
  });

  it(
    'cleans remembered reparented tools by exact PID without groups before releasing capacity',
    { timeout: 20_000 },
    async (t) => {
      await reset();
      const { childTransport } = await import('../../core/session');
      const { SessionLifetime } = await import('../../core/session_lifetime');
      const scan = await import('../../core/scan');
      const platform = await import('../../core/platform');
      const control = await import('../../core/control');
      // The extension holds this lease; cold PowerShell per read exhausts the native test budget.
      const reader = platform.processes.own();
      const owned: {
        transport?: ReturnType<typeof childTransport>;
        sibling?: childProcess.ChildProcess;
        siblingClosed?: Promise<void>;
        lifetime?: InstanceType<typeof SessionLifetime>;
        members: ReturnType<typeof control.snapshotTree>;
      } = { members: [] };
      t.after(async () => {
        try {
          const alive = owned.transport?.processAlive?.();
          const fresh = await scan.scanProcesses(true);
          const pid = owned.transport?.pid;
          const root =
            owned.members.find((member) => member.pid === pid) ??
            (fresh.complete &&
            alive &&
            owned.transport?.processAlive?.() &&
            pid !== undefined &&
            fresh.starts.has(pid)
              ? control.snapshotMember(pid, fresh)
              : undefined);
          const retained = owned.members.length ? owned.members : root ? [root] : [];
          const members = owned.lifetime?.knownMembers ?? [
            ...retained,
            ...(root && fresh.starts.get(root.pid) === root.startedAt
              ? control.snapshotTree(root.pid, fresh)
              : [])
          ];
          platform.processes.signal(members, 'kill', fresh, { alone: true });
          owned.transport?.close();
          owned.sibling?.kill('SIGKILL');
          await Promise.all([owned.transport?.exited, owned.siblingClosed]);
          await owned.lifetime?.reconcile();
          assert.ok(
            pid === undefined || members.length > 0,
            'native fixture ownership is required'
          );
          const confirmation = await scan.scanProcesses(true);
          assert.ok(confirmation.complete);
          assert.ok(
            members.every((member) => confirmation.starts.get(member.pid) !== member.startedAt)
          );
        } finally {
          assert.deepEqual(await reader.dispose(), { unresolved: [] });
        }
      });
      const snapshot = platform.processes.snapshot.bind(platform.processes);
      t.mock.method(platform.processes, 'snapshot', async () => {
        const observed = await snapshot();
        if (!observed.supported || observed.status === 'failed') return observed;
        return {
          ...observed,
          value: {
            ...observed.value,
            rows: observed.value.rows.map(({ pgid: _pgid, ...row }) => row)
          }
        };
      });
      const directory = await fs.mkdtemp(path.join(home, 'process-tree-'));
      const fixture = path.join(outRoot(), 'test/fixtures/process-tree.js');
      const id = randomUUID();
      const slot = await records.reserveStartup(id);
      await slot.spawning();
      const transport = childTransport({
        bin: executables.named(process.execPath),
        cwd: directory,
        env: homeEnv(home),
        args: [fixture, 'root', directory, testPlatform() === 'win32' ? 'detach' : '']
      });
      owned.transport = transport;
      const rootReady = new Promise<void>((resolve) => transport.onLine(() => resolve()));
      const initial = await scan.scanProcesses(true);
      if (transport.pid !== undefined && initial.starts.has(transport.pid))
        owned.members = [
          ...control.snapshotTree(transport.pid, initial),
          control.snapshotMember(transport.pid, initial)
        ];
      assert.ok(initial.complete);
      assert.ok(owned.members.length > 0);
      const sibling = childProcess.spawn(process.execPath, [fixture, 'sibling', directory], {
        cwd: directory,
        env: { ...process.env, ...homeEnv(home) },
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc']
      });
      owned.sibling = sibling;
      owned.siblingClosed = new Promise<void>((resolve) => sibling.once('close', () => resolve()));
      const siblingReady = new Promise((resolve) => sibling.once('message', resolve));
      await Promise.all([rootReady, siblingReady]);
      const pids = await Promise.all(
        ['root', 'tool', 'leaf', 'sibling'].map(async (role) =>
          Number(await fs.readFile(path.join(directory, `${role}.pid`), 'utf8'))
        )
      );
      const [root, child, leaf, unrelated] = pids as [number, number, number, number];
      t.diagnostic(`native fixture root/tool/leaf/unrelated PIDs: ${pids.join(',')}`);
      const realKill = process.kill.bind(process);
      const sent: [number, string | number | undefined][] = [];
      t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
        sent.push([pid, signal]);
        return realKill(pid, signal);
      });
      let captured!: () => void;
      const remembered = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const scope: InstanceType<typeof SessionLifetime> = new SessionLifetime(transport, {
        remember: async (members) => {
          await slot.remember(members);
          captured();
        },
        gone: async () => {
          const confirmation = await scan.scanProcesses(true);
          assert.ok(confirmation.complete);
          assert.ok(
            scope.knownMembers.every(
              (member) => confirmation.starts.get(member.pid) !== member.startedAt
            )
          );
          await slot.release();
        }
      });
      owned.lifetime = scope;
      await slot.bind(root);
      await remembered;
      const known = scope.knownMembers.map((member) => member.pid);
      const windows = testPlatform() === 'win32';
      if (windows) {
        // Each console process may own a conhost.exe: an ordinary member,
        // remembered and ended like any other (processes Step 1, decision 3).
        assert.ok(
          [root, child, leaf].every((pid) => known.includes(pid)),
          known.join(',')
        );
        assert.ok(!known.includes(unrelated));
      } else {
        assert.deepEqual(
          known.sort((a, b) => a - b),
          [root, child, leaf].sort((a, b) => a - b)
        );
      }
      const before = await scan.scanProcesses(true);
      const siblingStart = before.starts.get(unrelated);
      assert.ok(siblingStart !== undefined);
      assert.equal(before.groups.size, 0);
      const native = await snapshot();
      assert.ok(native.supported && native.status === 'ok');
      if (!windows) {
        assert.equal(native.value.rows.find((row) => row.pid === unrelated)?.pgid, unrelated);
        assert.notEqual(native.value.rows.find((row) => row.pid === child)?.pgid, child);
      }
      transport.close();
      assert.equal(await transport.exited, true);
      const reparented = await scan.scanProcesses(true);
      // POSIX reparents to init; Windows keeps the dead parent's number.
      assert.equal(reparented.parents.get(child), windows ? root : 1);
      const cleanup = scope.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const file = path.join(paths.STARTUPS_DIR, `${id}.json`);
      const held = JSON.parse(await fs.readFile(file, 'utf8')) as {
        phase: string;
        members: { pid: number }[];
      };
      assert.equal(held.phase, 'spawned');
      assert.ok([child, leaf].every((pid) => held.members.some((member) => member.pid === pid)));
      assert.ok((await scan.scanProcesses(true)).starts.has(child));
      assert.equal(await cleanup, 'gone');
      const final = await scan.scanProcesses(true);
      assert.ok(final.complete);
      assert.ok(
        scope.knownMembers.every((member) => final.starts.get(member.pid) !== member.startedAt)
      );
      assert.equal(final.starts.get(unrelated), siblingStart);
      const ended = JSON.parse(await fs.readFile(file, 'utf8')) as { phase: string };
      assert.equal(ended.phase, 'settled');
      if (windows) {
        // No stop on Windows: TerminateProcess by positive pid, deepest first,
        // only to remembered members.
        assert.ok(
          sent.every(([pid, signal]) => pid > 0 && signal === 'SIGKILL'),
          JSON.stringify(sent)
        );
        assert.ok(
          sent.every(([pid]) => known.includes(pid)),
          JSON.stringify(sent)
        );
        const order = sent.map(([pid]) => pid);
        assert.ok(
          order.indexOf(leaf) !== -1 && order.indexOf(leaf) < order.indexOf(child),
          JSON.stringify(sent)
        );
      } else {
        assert.deepEqual(sent, [
          [leaf, 'SIGTERM'],
          [child, 'SIGTERM'],
          [leaf, 'SIGKILL'],
          [child, 'SIGKILL']
        ]);
      }
      t.diagnostic(`native product signals: ${JSON.stringify(sent)}`);
      t.diagnostic(
        'product cleanup confirmed root/tool/leaf absent, unrelated group alive, durable receipt settled before teardown'
      );
    }
  );

  it('keeps a dead root receipt while a durably known member survives', async () => {
    await reset();
    const { scanProcesses } = await import('../../core/scan');
    const table = await scanProcesses(true);
    const startedAt = table.starts.get(process.pid)!;
    const startSource = table.startSource;
    const file = path.join(paths.STARTUPS_DIR, 'known-survivor.json');
    const raw = {
      schema: 1,
      id: 'known-survivor',
      admittedAt: Date.now() - 120000,
      owner: { pid: process.pid, startedAt: startedAt - 60000, startSource, generation: 'dead' },
      child: { pid: process.pid, startedAt: startedAt - 60000, startSource },
      phase: 'spawned',
      members: [{ pid: process.pid, startedAt, startSource }]
    };
    await fs.writeFile(file, JSON.stringify(raw));
    await (await records.reserveStartup('beside-survivor')).release();
    assert.equal(
      (JSON.parse(await fs.readFile(file, 'utf8')) as { phase: string }).phase,
      'spawned'
    );
    raw.members[0]!.startedAt -= 60000;
    await fs.writeFile(file, JSON.stringify(raw));
    await (await records.reserveStartup('after-survivor')).release();
    assert.equal(
      (JSON.parse(await fs.readFile(file, 'utf8')) as { phase: string }).phase,
      'settled'
    );
  });

  it('admits only five of simultaneous processes before any child can open or write lineage', async () => {
    await reset();
    // Lock contention is a fair refusal; retried within a bound, every
    // contender ends admitted or refused for the burst limit, never over five.
    const outcomes = await contenders();
    assert.equal(outcomes.filter((value) => value === 'admitted').length, 5, outcomes.join('\n'));
    assert.ok(
      outcomes.filter((value) => value !== 'admitted').every((value) => /limit is 5/.test(value)),
      outcomes.join('\n')
    );
    const receipts = await Promise.all(
      (await fs.readdir(paths.STARTUPS_DIR)).map(
        async (file) =>
          JSON.parse(await fs.readFile(path.join(paths.STARTUPS_DIR, file), 'utf8')) as {
            phase: string;
            child?: unknown;
          }
      )
    );
    assert.equal(receipts.length, 5);
    assert.ok(
      receipts.every(
        (receipt: { phase: string; child?: unknown }) =>
          receipt.phase === 'spawning' && receipt.child === undefined
      )
    );
  });

  it(
    'admits after a transient refusal reading the admission lock',
    { skip: testPlatform() !== 'win32' && 'posix: EPERM here is a real refusal' },
    async (t) => {
      await reset();
      const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
      await fs.writeFile(lock, '{}');
      const readFile = fs.readFile;
      let refused = 0;
      t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] !== lock || refused) return readFile(...args);
        refused++;
        await fs.rm(lock);
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      });
      const slot = await records.reserveStartup(randomUUID());
      await slot.release();
      assert.equal(refused, 1);
    }
  );

  it('reports a refusal reading the admission lock that never clears', async (t) => {
    await reset();
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    await fs.writeFile(lock, '{}');
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] !== lock) return readFile(...args);
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    await assert.rejects(records.reserveStartup(randomUUID()), /EPERM/);
  });

  it('fences concurrent recovery of a claim whose native owner died', async () => {
    await reset();
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    const script = `const fs=require('fs'); require(${JSON.stringify(path.join(outRoot(), 'core/scan.js'))}).scanProcesses(true).then(table=>fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,startedAt:table.starts.get(process.pid),startSource:table.startSource,generation:'crashed-owner'})));`;
    await new Promise<void>((resolve, reject) =>
      childProcess.execFile(process.execPath, ['-e', script], { env: homeEnv(home) }, (error) =>
        error ? reject(new Error(error.message)) : resolve()
      )
    );
    const outcomes = await contenders();
    assert.equal(outcomes.filter((value) => value === 'admitted').length, 5, outcomes.join('\n'));
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
  });

  it('retains crash-during-spawn uncertainty through age pruning', async () => {
    await reset();
    assert.equal(await contender(), 'admitted');
    const file = (await fs.readdir(paths.STARTUPS_DIR)).find((name) => name.endsWith('.json'));
    assert.ok(file);
    await records.pruneStartupRecords(Date.now() + 8 * 24 * 60 * 60_000);
    await fs.access(path.join(paths.STARTUPS_DIR, file));
    const raw = JSON.parse(await fs.readFile(path.join(paths.STARTUPS_DIR, file), 'utf8')) as {
      phase: string;
      child?: unknown;
    };
    assert.equal(raw.phase, 'spawning');
    assert.equal(raw.child, undefined);
  });

  it('holds fifteen live slots across opening and uncertain cleanup and counts lineage once', async () => {
    await reset();
    await fs.mkdir(paths.LINEAGE_DIR, { recursive: true });
    for (let i = 0; i < 15; i++) {
      const id = randomUUID();
      const slot = await records.reserveStartup(id);
      await slot.spawning();
      const file = path.join(paths.STARTUPS_DIR, `${id}.json`);
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { admittedAt: number };
      raw.admittedAt = Date.now() - 120_000;
      await fs.writeFile(file, JSON.stringify(raw));
      if (i === 0)
        await fs.writeFile(
          path.join(paths.LINEAGE_DIR, `${process.pid}.json`),
          JSON.stringify({ spawnedAt: Date.now(), requestId: id })
        );
    }
    await assert.rejects(
      records.reserveStartup(randomUUID()),
      /15 agent session slots.*limit is 15/
    );
    await fs.rm(path.join(paths.LINEAGE_DIR, `${process.pid}.json`));
  });

  it('retains the burst charge after confirmed cleanup releases live capacity', async () => {
    await reset();
    for (let i = 0; i < 5; i++) {
      const slot = await records.reserveStartup(randomUUID());
      await slot.spawning();
      await slot.release();
    }
    await assert.rejects(records.reserveStartup(randomUUID()), /limit is 5/);
  });

  it('refuses partial claims and unsupported records without stealing or silently dropping capacity', async () => {
    await reset();
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    await fs.writeFile(lock, '{partial');
    await assert.rejects(records.reserveStartup(randomUUID()), /Unfinished admission claim/);
    assert.equal(await fs.readFile(lock, 'utf8'), '{partial');
    await fs.rm(lock);
    await fs.writeFile(
      path.join(paths.STARTUPS_DIR, 'unknown.json'),
      JSON.stringify({ schema: 2 })
    );
    await assert.rejects(records.reserveStartup(randomUUID()), /Unsupported startup record/);
  });

  it('never expires a paused live claim by age', async (t) => {
    await reset();
    const scan = await import('../../core/scan');
    const table = await scan.scanProcesses(true);
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    const text = JSON.stringify({
      pid: process.pid,
      startedAt: table.starts.get(process.pid),
      generation: 'paused-live-owner',
      since: 0
    });
    await fs.writeFile(lock, text);
    t.after(() => fs.rm(lock, { force: true }));
    await assert.rejects(records.reserveStartup(randomUUID()), /Another window is admitting/);
    assert.equal(await fs.readFile(lock, 'utf8'), text);
  });
});
