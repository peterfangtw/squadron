import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import * as util from 'node:util';
import * as darwinProcesses from '../../core/platform/processes/darwin';
import * as scan from '../../core/scan';

// This driver imports no boot or candidate ownership code; it owns the oracle.
type Row = { pid: number; ppid: number; pgid: number; startedAt: number; command: string };
const exec = util.promisify(childProcess.execFile);
const repo = path.join(__dirname, '..', '..', '..');
const runner = path.join(__dirname, 'runner.js');
const fixture = path.join(__dirname, 'cleanup_fixture.js');
const deadlineMs = 45_000;

async function rows(): Promise<Map<number, Row>> {
  const { stdout } = await exec('/bin/ps', ['-Ao', 'stat=,pid=,ppid=,pgid=,lstart=,command='], {
    timeout: 3000,
    env: { ...process.env, LC_ALL: 'C' }
  });
  const result = new Map<number, Row>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(line);
    const row = darwinProcesses.parseRow(m?.[2] ?? '');
    if (row && !m?.[1]?.startsWith('Z')) result.set(row.pid, row);
  }
  assert.ok(result.has(process.pid), 'oracle process table incomplete');
  return result;
}

async function until<T>(
  read: () => Promise<T>,
  matches: (v: T) => boolean,
  label: string
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label} exceeded ${deadlineMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Case = {
  base: string;
  root: string;
  control: string;
  child: childProcess.ChildProcess;
  result: Promise<number | null>;
  witnesses: Map<number, Row>;
  observe: () => Promise<void>;
  marker: (name: string) => Promise<any>;
  go: (name?: string) => Promise<void>;
  finish: (expected: number, gone?: boolean) => Promise<void>;
};

async function start(
  t: TestContext,
  mode: string,
  timed = false,
  mutation?: 'disabled' | 'cleanup-error' | 'finish-disabled'
): Promise<Case> {
  // eslint-disable-next-line squadron/temp-root -- run/control.sock must fit Darwin's socket path
  const base = await fs.realpath(await fs.mkdtemp('/tmp/sq-oracle-'));
  const root = path.join(base, 'run');
  const control = path.join(base, 'control');
  await fs.mkdir(control);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== 'ELECTRON_RUN_AS_NODE' &&
        !key.startsWith('VSCODE_') &&
        !key.startsWith('SQUADRON_SMOKE_')
    )
  );
  let candidate = runner;
  if (mutation) {
    candidate = path.join(__dirname, `cleanup_broken_${process.pid}.js`);
    const source = await fs.readFile(runner, 'utf8');
    if (mutation === 'finish-disabled') {
      const broken = path.join(__dirname, `cleanup_ownership_${process.pid}.js`);
      const source = await fs.readFile(path.join(__dirname, 'ownership.js'), 'utf8');
      const target = 'await cleanupLaunch(launch);\n        return null;';
      assert.ok(source.includes(target), 'finish mutation no longer matches supervisor');
      await fs.writeFile(broken, source.replace(target, 'return null;'));
      await fs.writeFile(
        candidate,
        (await fs.readFile(runner, 'utf8')).replace(
          '"./ownership"',
          JSON.stringify('./' + path.basename(broken))
        )
      );
      t.after(() => fs.rm(broken, { force: true }));
    } else {
      assert.ok(
        source.includes('shutdown = supervisor.shutdown()'),
        'red mutation no longer matches runner'
      );
      let mutated = source.replace(
        'shutdown = supervisor.shutdown()',
        'shutdown = ' +
          (mutation === 'disabled'
            ? '(() => { for (const launch of supervisor.launches.values()) if (launch) launch.closed = true; return supervisor.shutdown(); })()'
            : "supervisor.shutdown().then(() => { throw new Error('injected cleanup error'); })")
      );
      if (mutation === 'disabled')
        mutated = mutated.replaceAll('ownership.cleanupLaunch(workerTree)', 'Promise.resolve()');
      await fs.writeFile(candidate, mutated);
    }
    t.after(() => fs.rm(candidate, { force: true }));
  }
  const command = `exec '${process.execPath}' '${candidate}' '${fixture}'`;
  const child = childProcess.spawn(
    process.execPath,
    timed ? [path.join(repo, 'scripts/timed.mjs'), `smoke=${command}`] : [candidate, fixture],
    {
      cwd: timed ? base : repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        SQUADRON_SMOKE_ROOT: root,
        SQUADRON_CLEANUP_CONTROL: control,
        SQUADRON_CLEANUP_CASE: mode,
        SQUADRON_RUN: path.join(base, 'evidence'),
        SQUADRON_RUNS_DIR: path.join(base, 'timings')
      }
    }
  );
  let output = '';
  const started = Date.now();
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const result = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve(code);
    });
  });
  const witnesses = new Map<number, Row>();
  const observe = async (): Promise<void> => {
    const table = await rows();
    const parents = new Map([...table].map(([pid, p]) => [pid, p.ppid]));
    const roots = [
      child.pid ?? 0,
      ...[...witnesses.values()]
        .filter((p) => table.get(p.pid)?.startedAt === p.startedAt)
        .map((p) => p.pid)
    ];
    for (const pid of roots)
      for (const member of [pid, ...scan.descendants(pid, parents)]) {
        const row = table.get(member);
        if (row && !witnesses.has(member)) witnesses.set(member, row);
      }
  };
  let observing: Promise<void> | undefined;
  let observationError: Error | undefined;
  const sampler = setInterval(() => {
    observing ??= observe()
      .catch((error: unknown) => {
        observationError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        observing = undefined;
      });
  }, 50);
  const marker = async (name: string): Promise<any> => {
    const value = await until(
      async () => {
        const value = await fs.readFile(path.join(control, name), 'utf8').catch(() => '');
        if (!value && exit) {
          throw new Error(
            `runner exited before ${name}: code=${exit.code}, signal=${exit.signal}, elapsed=${Date.now() - started} ms\n${output}`
          );
        }
        return value;
      },
      Boolean,
      name
    );
    await observe();
    return JSON.parse(value);
  };
  const c: Case = {
    base,
    root,
    control,
    child,
    result,
    witnesses,
    observe,
    marker,
    go: (name = 'go') => fs.writeFile(path.join(control, name), ''),
    finish: async (expected, gone = true) => {
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('runner exit exceeded oracle deadline')),
            deadlineMs
          );
        })
      ]).finally(() => clearTimeout(timer));
      if (expected >= 0) assert.equal(code, expected, output);
      if (gone) {
        await until(
          async () => {
            const table = await rows();
            return [...witnesses.values()].filter(
              (p) => table.get(p.pid)?.startedAt === p.startedAt
            );
          },
          (live) => live.length === 0,
          `owned processes gone: ${output}`
        );
        assert.equal(
          await fs.stat(root).then(
            () => true,
            () => false
          ),
          false,
          output
        );
      }
    }
  };
  t.after(async () => {
    clearInterval(sampler);
    await observing;
    await fs
      .cp(root, path.join(base, 'before-oracle-cleanup'), {
        recursive: true,
        filter: async (file) => (await fs.lstat(file).catch(() => undefined))?.isSocket() === false
      })
      .catch(() => undefined);
    await observe();
    const table = await rows();
    for (const p of [...witnesses.values()].reverse()) {
      const fresh = (await rows()).get(p.pid);
      if (fresh?.startedAt === p.startedAt && fresh.pgid === p.pgid) {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    if (table.has(child.pid ?? 0)) await result;
    const remaining = await until(
      async () => {
        const fresh = await rows();
        return [...witnesses.values()].filter((p) => fresh.get(p.pid)?.startedAt === p.startedAt);
      },
      (live) => live.length === 0,
      'oracle fallback cleanup'
    );
    await fs.writeFile(
      path.join(base, 'witnesses.json'),
      JSON.stringify(
        {
          witnesses: [...witnesses.values()],
          remaining,
          observationError: observationError?.message ?? ''
        },
        null,
        2
      )
    );
    await fs.writeFile(path.join(base, 'driver.log'), output);
    const retained = process.env['SQUADRON_RUN'];
    if (retained) {
      const evidence = path.join(retained, 'cleanup-oracle', path.basename(base));
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.cp(base, evidence, {
        recursive: true,
        filter: async (file) => (await fs.lstat(file).catch(() => undefined))?.isSocket() === false
      });
      console.log(`  evidence: ${evidence}`);
    }
    await fs.rm(base, { recursive: true, force: true });
    if (observationError) throw observationError;
  });
  await observe();
  return c;
}

describe('independent stock-host cleanup oracle', { timeout: 600_000 }, () => {
  for (const mode of ['success', 'failure', 'disposed', 'close-error']) {
    it(mode, { timeout: 90_000 }, async (t) => {
      const c = await start(t, mode);
      const ready = (await c.marker('ready')) as { helper?: number };
      await c.go();
      if (mode === 'success') {
        await c.marker('closed');
        assert.equal(
          (await rows()).has(ready.helper!),
          false,
          'normal close reaped detached child'
        );
        await c.go('finish');
      }
      await c.finish(mode === 'failure' ? 1 : 0);
      if (mode === 'failure') {
        const logs = path.join(c.base, 'evidence', 'cleanup', 'host', 'profile', 'data', 'logs');
        assert.ok((await fs.readdir(logs)).length > 0, 'failed scenario retained host logs');
      }
    });
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`worker ${signal} after readiness`, { timeout: 90_000 }, async (t) => {
      const c = await start(t, 'hold');
      const ready = (await c.marker('ready')) as { worker: number };
      process.kill(ready.worker, signal);
      await c.finish(1);
      const report = await fs
        .readFile(path.join(c.base, 'evidence', 'cleanup', 'supervisor.json'), 'utf8')
        .catch(() => '');
      if (report) assert.equal((JSON.parse(report) as { forced: boolean }).forced, false);
    });
  }
  for (const phase of ['before-ack', 'after-ack']) {
    it(`worker death ${phase}`, { timeout: 90_000 }, async (t) => {
      const c = await start(t, phase);
      await c.marker('launching');
      const worker = (await c.marker('worker')) as number;
      process.kill(worker, 'SIGKILL');
      await c.go('allow-launch');
      await c.finish(1);
    });
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`outer timed ${signal}`, { timeout: 90_000 }, async (t) => {
      const c = await start(t, 'success', true);
      await c.marker('ready');
      process.kill(c.child.pid!, signal);
      if (signal === 'SIGKILL') await c.go();
      await c.finish(signal === 'SIGTERM' ? 143 : -1);
    });
  }
  it(
    'relaunch confirms the old tree before using its profile again',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'relaunch');
      const first = (await c.marker('ready')) as { host: number; helper: number };
      await c.go();
      const second = (await c.marker('replacement')) as { host: number };
      assert.notEqual(first.host, second.host);
      assert.equal((await rows()).has(first.host), false);
      assert.equal((await rows()).has(first.helper), false, 'relaunch reaped detached child');
      await c.go('finish');
      await c.finish(1);
    }
  );
  it(
    'a failed launch retires its ID and permits the next section',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'failed-launch');
      await c.marker('replacement');
      await c.go('finish');
      await c.finish(1);
    }
  );
  it(
    'disabled finish leaves a detached child: normal-close oracle turns red',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'success', false, 'finish-disabled');
      const ready = (await c.marker('ready')) as { helper: number };
      await c.go();
      await c.marker('closed');
      assert.ok(
        (await rows()).has(ready.helper),
        'broken finish failed to reproduce detached-child leak'
      );
      await c.go('finish');
      await c.finish(0);
    }
  );
  it(
    'two real hosts stay isolated during ready-state and startup deaths',
    { timeout: 120_000 },
    async (t) => {
      const standinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-standin-'));
      const standinPath = path.join(standinDir, 'Code');
      await fs.symlink('/bin/sleep', standinPath);
      const standin = childProcess.spawn(standinPath, ['180'], { stdio: 'ignore' });
      const standinExit = new Promise<void>((resolve) => standin.once('exit', () => resolve()));
      const standinRow = await until(
        async () => (await rows()).get(standin.pid ?? 0),
        Boolean,
        'stand-in ready'
      );
      assert.ok(standinRow);
      t.after(async () => {
        if ((await rows()).get(standinRow.pid)?.startedAt === standinRow.startedAt)
          standin.kill('SIGKILL');
        await standinExit;
        await fs.rm(standinDir, { recursive: true, force: true });
      });
      const b = await start(t, 'isolation');
      await b.marker('ready');
      let ping = 0;
      for (const phase of ['hold', 'after-ack', 'relaunch']) {
        const a = await start(t, phase);
        let worker: number;
        if (phase === 'after-ack') {
          await a.marker('launching');
          worker = (await a.marker('worker')) as number;
        } else {
          worker = ((await a.marker('ready')) as { worker: number }).worker;
          if (phase === 'relaunch') {
            await a.go();
            await a.marker('replacement');
          }
        }
        process.kill(worker, 'SIGKILL');
        if (phase === 'after-ack') await a.go('allow-launch');
        await a.finish(1);
        await b.go(`ping-${++ping}`);
        await b.marker(`pong-${ping}`);
        assert.equal((await rows()).get(standinRow.pid)?.startedAt, standinRow.startedAt);
      }
      await b.go();
      await b.finish(0);
    }
  );
  it(
    'disabled cleanup leaves a host: the regression oracle turns red',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'hold', false, 'disabled');
      const ready = (await c.marker('ready')) as { worker: number; host: number };
      process.kill(ready.worker, 'SIGKILL');
      await c.finish(1, false);
      assert.ok(
        (await rows()).has(ready.host),
        'broken cleanup failed to reproduce worker-death leak'
      );
    }
  );
  it(
    'cleanup exceptions make a green scenario red and retain diagnostics',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'success', false, 'cleanup-error');
      await c.marker('ready');
      await c.go();
      await c.marker('closed');
      await c.go('finish');
      await c.finish(1, false);
      const log = await fs.readFile(
        path.join(c.base, 'evidence', 'cleanup', 'supervisor.json'),
        'utf8'
      );
      assert.match(log, /injected cleanup error/);
      assert.ok(await fs.stat(c.root));
    }
  );
  it(
    'a completed worker cannot pin the runner with a lingering timer',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'linger');
      await c.marker('ready');
      await c.go();
      await c.finish(-1);
      assert.match(
        await fs.readFile(path.join(c.base, 'evidence', 'cleanup', 'supervisor.json'), 'utf8'),
        /"forced": true/
      );
    }
  );
  it(
    'supervisor SIGKILL is outside the guarantee; oracle still removes its tree',
    { timeout: 90_000 },
    async (t) => {
      const c = await start(t, 'hold');
      await c.marker('ready');
      process.kill(c.child.pid!, 'SIGKILL');
      await c.result;
      assert.ok(await fs.stat(c.root));
    }
  );
});
