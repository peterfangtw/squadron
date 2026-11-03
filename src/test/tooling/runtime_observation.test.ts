import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { testPlatform } from '../helpers';

const ROOT = path.resolve('.');
const COMMAND_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('SQUADRON_RUN'))
);
const made: string[] = [];
after(() => Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function folder(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-observation-'));
  made.push(dir);
  return dir;
}
async function records(dir: string): Promise<Record<string, any>[]> {
  const files = (await fs.readdir(dir)).filter((name) => name.startsWith('observation-'));
  return (
    await Promise.all(files.map((file) => fs.readFile(path.join(dir, file), 'utf8')))
  ).flatMap((raw) =>
    raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
  );
}
function probe(dir: string, body: string, mode = 'spans') {
  return cp.spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...COMMAND_ENV,
      SQUADRON_RUN: dir,
      SQUADRON_RUN_OBSERVATION_MODE: mode,
      SQUADRON_RUN_OBSERVATION_DIR: dir
    }
  });
}
const IMPORT = "import * as observation from './scripts/observation.mjs';\n";

describe('runtime observation at the process boundary', () => {
  it('retains nested monotonic spans and a single terminal outcome after late completion', async () => {
    const dir = await folder();
    const ran = probe(
      dir,
      IMPORT +
        `
      const outer = observation.start('body');
      const inner = observation.start('action', { parent: outer.id });
      inner.end('cancelled');
      inner.end('passed');
      outer.end('failed');
    `
    );
    assert.equal(ran.status, 0, ran.stderr);
    const rows = await records(dir);
    const spans = rows.filter((row) => row.type === 'span');
    assert.equal(spans.length, 2);
    const inner = spans.find((row) => row.name === 'action');
    const outer = spans.find((row) => row.name === 'body');
    assert.ok(inner && outer);
    assert.equal(inner.outcome, 'cancelled');
    assert.equal(inner.parent, outer.id);
    assert.ok(inner.startMs >= outer.startMs);
    assert.ok(inner.startMs + inner.ms <= outer.startMs + outer.ms);
    assert.equal(rows.at(-1)?.type, 'process-end');
    assert.equal(rows.at(-1)?.complete, true);
  });

  it('keeps deliberate exits and missing terminals distinguishable without changing exit codes', async () => {
    const dir = await folder();
    assert.equal(
      probe(dir, IMPORT + "observation.start('unfinished'); process.exit(3);").status,
      3
    );
    const rows = await records(dir);
    assert.equal(rows.at(-1)?.complete, false);
    assert.equal(rows.at(-1)?.exit, 3);
    assert.equal(rows.find((row) => row.type === 'span')?.outcome, 'incomplete');
    const killed = await folder();
    const code =
      IMPORT +
      "observation.start('killed'); observation.flush(); process.kill(process.pid, 'SIGKILL');";
    const result = probe(killed, code);
    // On Windows process.kill uses TerminateProcess, which reports an exit status.
    if (testPlatform() === 'win32') {
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
    } else {
      assert.equal(result.signal, 'SIGKILL');
    }
    assert.equal(
      (await records(killed)).some((row) => row.type === 'process-end'),
      false
    );
  });

  it('collects opt-in resources once per process and stays passive on write failure or disabled mode', async () => {
    const dir = await folder();
    const ran = probe(
      dir,
      IMPORT +
        "await import('./scripts/observation.mjs?second-copy'); observation.start('work').end('passed');",
      'resources'
    );
    assert.equal(ran.status, 0, ran.stderr);
    const rows = await records(dir);
    const terminal = rows.filter((row) => row.type === 'process-end');
    assert.equal(terminal.length, 1);
    assert.ok(terminal[0]!.resources.peakRssKiB > 0);
    assert.ok(terminal[0]!.resources.userCpuMicros >= 0);
    assert.equal(terminal[0]!.resources.scope, 'process');
    const off = await folder();
    assert.equal(probe(off, IMPORT + "observation.start('work').end('passed');", 'off').status, 0);
    assert.deepEqual(await fs.readdir(off), []);
    const file = path.join(await folder(), 'file');
    await fs.writeFile(file, 'not a directory');
    const failed = probe(
      file,
      IMPORT + "observation.start('work').end('passed'); process.exitCode = 7;"
    );
    assert.equal(failed.status, 7, failed.stderr);
    assert.match(failed.stderr, /observation:/);
  });
});

describe('runtime comparison contract', () => {
  async function sample(ms: number, changes: Record<string, unknown> = {}): Promise<string> {
    const dir = await folder();
    const identity = {
      source: { kind: 'checkout', sha: 'same', dirty: false, content: 'same' },
      environment: {
        node: process.version,
        npmVersion: '10.0.0',
        platform: testPlatform(),
        arch: process.arch,
        osRelease: 'test',
        cpu: 'test',
        memoryBytes: 1024,
        lock: 'lock',
        cores: 8
      },
      mode: 'spans',
      cache: 'warm'
    };
    await fs.writeFile(
      path.join(dir, 'runtime.json'),
      JSON.stringify({
        schema: 1,
        kind: 'command',
        command: ['node', 'work.js'],
        identity,
        sourceStable: true,
        ms,
        queueMs: 0,
        exit: 0,
        outcome: 'passed',
        ...changes
      })
    );
    await fs.writeFile(
      path.join(dir, 'observation-fixture.jsonl'),
      [
        { schema: 1, process: 'fixture', type: 'process-start', mode: 'spans' },
        { schema: 1, process: 'fixture', type: 'process-end', complete: true, exit: 0, ms }
      ]
        .map((row) => JSON.stringify(row) + '\n')
        .join('')
    );
    return dir;
  }
  function compare(a: string[], b: string[], extra: string[] = []) {
    return cp.spawnSync(
      process.execPath,
      [
        'scripts/compare-runtime.mjs',
        '--baseline=' + a.join(','),
        '--candidate=' + b.join(','),
        ...extra
      ],
      { cwd: ROOT, encoding: 'utf8' }
    );
  }
  it('reports repeated paired wall times without adding overlapping spans', async () => {
    const a = [await sample(100), await sample(120)];
    const b = [await sample(80), await sample(90)];
    const ran = compare(a, b);
    assert.equal(ran.status, 0, ran.stderr);
    const result = JSON.parse(ran.stdout);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.wallMs.baselineMedian, 110);
    assert.equal(result.wallMs.candidateMedian, 85);
    assert.equal(result.wallMs.pairedDeltaMedian, -25);
  });
  it('checks identities of nested work rather than only the wrapper', async () => {
    async function withChild(sha: string, extra: Record<string, unknown> = {}): Promise<string> {
      const dir = await sample(100);
      const own = JSON.parse(await fs.readFile(path.join(dir, 'runtime.json'), 'utf8'));
      const file = path.join(dir, 'observation-fixture.jsonl');
      const text = await fs.readFile(file, 'utf8');
      const rows = text
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as Record<string, any>);
      rows.splice(
        1,
        0,
        {
          schema: 1,
          process: 'fixture',
          type: 'event',
          name: 'run',
          details: { folder: '/not-retained' }
        },
        {
          schema: 1,
          process: 'fixture',
          type: 'event',
          name: 'run:complete',
          details: {
            folder: '/not-retained',
            command: ['node', 'child.js'],
            scope: { files: ['test.js'] },
            sourceStable: true,
            exit: 0,
            outcome: 'passed',
            identity: { ...own.identity, ...extra, source: { ...own.identity.source, sha } }
          }
        }
      );
      await fs.writeFile(file, rows.map((row) => JSON.stringify(row) + '\n').join(''));
      return dir;
    }
    const a = [await withChild('old'), await withChild('old')];
    const b = [await withChild('new'), await withChild('new')];
    assert.equal(compare(a, b).status, 1, 'different nested source was accepted');
    assert.equal(compare(a, b, ['--allow-source-change']).status, 0);
    const unknown = [
      await withChild('old', { cache: 'unknown' }),
      await withChild('old', { cache: 'unknown' })
    ];
    assert.equal(compare(unknown, unknown).status, 1, 'unknown nested cache was accepted');

    const file = path.join(b[0]!, 'observation-fixture.jsonl');
    const events = (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);
    await fs.writeFile(
      file,
      events
        .filter((row) => row.name !== 'run:complete')
        .map((row) => JSON.stringify(row) + '\n')
        .join('')
    );
    assert.equal(
      compare(a, b, ['--allow-source-change']).status,
      1,
      'missing child completion was accepted'
    );
  });
  it('refuses mismatched scope, unknown identity, mixed modes and missing process exits', async () => {
    const a = [await sample(100), await sample(100)];
    for (const change of [
      { command: ['node', 'different.js'] },
      { identity: null },
      { identity: { source: {}, environment: { lock: 'same' }, mode: 'spans', cache: 'warm' } },
      { sourceStable: false },
      { outcome: 'cancelled', exit: 130 },
      { identity: { source: { sha: 'same' }, environment: {}, mode: 'resources', cache: 'warm' } }
    ]) {
      const b = [await sample(80, change), await sample(80, change)];
      const ran = compare(a, b);
      assert.equal(ran.status, 1, ran.stdout + ran.stderr);
      assert.match(ran.stderr, /compare-runtime:/);
    }
    const b = [await sample(80), await sample(80)];
    await fs.writeFile(
      path.join(b[0]!, 'observation-fixture.jsonl'),
      JSON.stringify({ schema: 1, process: 'fixture', type: 'process-start' }) + '\n'
    );
    assert.equal(compare(a, b).status, 1);
  });
});

describe('observed command boundary', () => {
  it(
    'propagates command failures, admits inside the existing lock and cancels queued work',
    {
      skip: testPlatform() === 'win32' && 'win32: no lockf or flock to hold the heavy lock — W8.5'
    },
    async () => {
      const dir = await folder();
      const lock = path.join(dir, 'heavy.lock');
      const ready = path.join(dir, 'ready');
      const release = path.join(dir, 'release');
      const marker = path.join(dir, 'ran');
      const lockArgs = testPlatform() === 'darwin' ? ['-k', '-t', '10', lock] : ['-w', '10', lock];
      const holder = cp.spawn(testPlatform() === 'darwin' ? 'lockf' : 'flock', [
        ...lockArgs,
        process.execPath,
        '-e',
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10);setTimeout(()=>process.exit(),10000).unref();`
      ]);
      const holderClosed = new Promise((resolve) => holder.once('close', resolve));
      const until = async (check: () => Promise<boolean>) => {
        const end = Date.now() + 5000;
        while (!(await check())) {
          assert.ok(Date.now() < end, 'command boundary did not arrive');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const env: NodeJS.ProcessEnv = {
        ...COMMAND_ENV,
        SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
        SQUADRON_RUN_OBSERVATION_LOCK: lock,
        SQUADRON_RUN_OBSERVATION_MODE: 'spans',
        SQUADRON_RUN_OBSERVATION_HEAVY: '',
        SQUADRON_RUN_OBSERVATION_WRAPPER: '',
        SQUADRON_RUN_OBSERVATION_DIR: ''
      };
      delete env.SQUADRON_RUN_OBSERVATION_DIR;
      const args = [
        'scripts/observe.mjs',
        '--heavy',
        '--cache=warm',
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'');process.exitCode=3;`
      ];
      try {
        await until(() =>
          fs.access(ready).then(
            () => true,
            () => false
          )
        );
        const queued = cp.spawn(process.execPath, args, {
          cwd: ROOT,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        queued.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        const ended = new Promise<number | null>((resolve) => queued.once('close', resolve));
        await until(() => Promise.resolve(output.includes('observe: run:')));
        queued.kill('SIGTERM');
        assert.equal(await ended, 143, output);
        assert.equal(
          await fs.access(marker).then(
            () => true,
            () => false
          ),
          false
        );
        const first = /observe: run: (.+)/.exec(output)?.[1];
        assert.ok(first);
        const cancelled = JSON.parse(await fs.readFile(path.join(first, 'runtime.json'), 'utf8'));
        assert.equal(cancelled.outcome, 'cancelled');
        assert.equal(cancelled.unadmitted, true);
        await fs.writeFile(release, '');
        await holderClosed;
        const ran = cp.spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' });
        assert.equal(ran.status, 3, ran.stderr);
        const run = /observe: run: (.+)/.exec(ran.stderr)?.[1];
        assert.ok(run);
        const result = JSON.parse(await fs.readFile(path.join(run, 'runtime.json'), 'utf8'));
        assert.equal(result.outcome, 'failed');
        assert.equal(result.unadmitted, false);
        assert.ok(result.queueMs >= 0 && result.queueMs <= result.ms);
        assert.equal(result.admission.heavy, true);
        assert.equal(await fs.readFile(marker, 'utf8'), '');
        const nested = cp.spawnSync(process.execPath, args, {
          cwd: ROOT,
          env: { ...env, SQUADRON_RUN_OBSERVATION_HEAVY: '1' },
          encoding: 'utf8'
        });
        assert.equal(nested.status, 1);
        assert.match(nested.stderr, /nested --heavy/);
      } finally {
        await fs.writeFile(release, '');
        await holderClosed;
      }
    }
  );
});

describe('archive and storage observation boundaries', () => {
  it('measures archived source bytes independently of the expected digest', async () => {
    const dir = await folder();
    const ran = probe(
      await folder(),
      IMPORT +
        `
      import * as fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'source.js'))}, 'before');
      const before = observation.identity(${JSON.stringify(dir)}, 'expected');
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'source.js'))}, 'after');
      const after = observation.identity(${JSON.stringify(dir)}, 'expected');
      console.log(JSON.stringify({before:before.source, after:after.source}));
    `
    );
    assert.equal(ran.status, 0, ran.stderr);
    const result = JSON.parse(ran.stdout);
    assert.notEqual(result.before.tree, result.after.tree);
    assert.equal(result.before.expected, 'expected');
  });

  it('anchors relative storage before a child changes directory', async () => {
    const dir = await folder();
    const other = await folder();
    const ran = probe(
      await folder(),
      IMPORT +
        `
      process.chdir(${JSON.stringify(dir)});
      process.env.SQUADRON_RUNS_DIR = 'relative-runs';
      delete process.env.SQUADRON_RUN_OBSERVATION_DIR;
      const run = observation.createRun('probe');
      const file = observation.configure(run);
      process.chdir(${JSON.stringify(other)});
      observation.start('after-chdir').end('passed');
      console.log(JSON.stringify({run,file}));
    `
    );
    assert.equal(ran.status, 0, ran.stderr);
    const result = JSON.parse(ran.stdout) as { run: string; file: string };
    assert.equal(path.isAbsolute(result.run), true);
    assert.equal(path.isAbsolute(result.file), true);
    const text = await fs.readFile(result.file, 'utf8');
    assert.equal(
      (JSON.parse(text.trim().split('\n').at(-1)!) as { type: string }).type,
      'process-end'
    );
  });

  it('keeps an unmarked caller-owned run root outside automatic retention', async () => {
    const dir = await folder();
    for (let i = 1; i <= 24; i++)
      await fs.mkdir(
        path.join(dir, `2000-01-${String(i).padStart(2, '0')}T00-00-00.000Z-owned-2147483646`)
      );
    const ran = probe(
      await folder(),
      IMPORT +
        `
      process.env.SQUADRON_RUNS_DIR = ${JSON.stringify(dir)};
      observation.createRun('probe');
    `
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal((await fs.readdir(dir)).filter((name) => name.includes('-owned-')).length, 24);
  });
});

describe('admitted command observation', () => {
  it(
    'forwards one cancellation once to a running command',
    {
      skip:
        testPlatform() === 'win32' && 'win32: SIGTERM is TerminateProcess; no handler runs — W4.2'
    },
    async () => {
      const dir = await folder();
      const ready = path.join(dir, 'ready');
      const signals = path.join(dir, 'signals');
      const env = {
        ...COMMAND_ENV,
        SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
        SQUADRON_RUN_OBSERVATION_WRAPPER: '',
        SQUADRON_RUN_OBSERVATION_HEAVY: ''
      };
      const body = `const fs=require('node:fs');let count=0;process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(signals)},'x');if(++count===1)setTimeout(()=>process.exit(0),150)});fs.writeFileSync(${JSON.stringify(ready)},'');setTimeout(()=>process.exit(4),5000);`;
      const child = cp.spawn(
        process.execPath,
        ['scripts/observe.mjs', '--cache=warm', '--', process.execPath, '-e', body],
        { cwd: ROOT, env, stdio: 'ignore' }
      );
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
      const deadline = Date.now() + 5000;
      while (
        !(await fs.access(ready).then(
          () => true,
          () => false
        ))
      ) {
        assert.ok(Date.now() < deadline, 'command never reached admission');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGTERM');
      assert.equal(await closed, 143);
      assert.equal(await fs.readFile(signals, 'utf8'), 'x');
    }
  );
  it('refuses nested wrappers before their hidden work can run', async () => {
    const dir = await folder();
    const marker = path.join(dir, 'ran');
    const ran = cp.spawnSync(
      process.execPath,
      [
        'scripts/observe.mjs',
        '--cache=warm',
        '--',
        process.execPath,
        'scripts/observe.mjs',
        '--cache=warm',
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'')`
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...COMMAND_ENV,
          SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
          SQUADRON_RUN_OBSERVATION_WRAPPER: ''
        }
      }
    );
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /nested.*wrapper/);
    const timed = cp.spawnSync(
      process.execPath,
      ['scripts/timed.mjs', 'inside=node scripts/observe.mjs --cache=warm -- node --version'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...COMMAND_ENV,
          SQUADRON_RUN: '',
          SQUADRON_RUNS_DIR: path.join(dir, 'timed'),
          SQUADRON_RUN_OBSERVATION_WRAPPER: ''
        }
      }
    );
    assert.equal(timed.status, 1, timed.stderr);
    assert.match(timed.stderr, /nested.*wrapper/);

    assert.equal(
      await fs.access(marker).then(
        () => true,
        () => false
      ),
      false
    );
  });
  it('records the npm version used by command tooling', async () => {
    const dir = await folder();
    const ran = probe(
      dir,
      IMPORT + 'console.log(JSON.stringify(observation.identity().environment));'
    );
    assert.equal(ran.status, 0, ran.stderr);
    const identity = JSON.parse(ran.stdout) as { npmVersion?: string };
    assert.equal(typeof identity.npmVersion, 'string');
    assert.match(identity.npmVersion ?? '', /^\d+\./);
  });
});

describe('completed observation retention', () => {
  it('retains a long run that completed after newer short runs', async () => {
    const dir = await folder();
    const long = path.join(dir, '2000-01-01T00-00-00.000Z-observe-2147483646');
    await fs.mkdir(long);
    await fs.utimes(long, new Date(), new Date());
    for (let i = 1; i <= 24; i++) {
      const short = path.join(
        dir,
        `2020-01-${String(i).padStart(2, '0')}T00-00-00.000Z-probe-2147483646`
      );
      await fs.mkdir(short);
      await fs.utimes(short, new Date(1000 + i), new Date(1000 + i));
    }
    const ran = probe(await folder(), IMPORT + `observation.prune(${JSON.stringify(dir)});`);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(
      await fs.access(long).then(
        () => true,
        () => false
      ),
      true,
      'recently completed parent was pruned by its old start time'
    );
    assert.equal((await fs.readdir(dir)).filter((name) => !name.startsWith('.')).length, 20);
  });
});
