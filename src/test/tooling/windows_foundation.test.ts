import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as checkpoints from '../../../scripts/checkpoints.mjs';
import * as roots from '../../../scripts/fixture-roots.cjs';
import * as helpers from '../helpers';

const made: string[] = [];
// Not the enclosing gate's run, observation folder or holder: a nested fixture
// run would otherwise write its observations into the gate run under test.
const CLEAN = Object.fromEntries(
  Object.entries(checkpoints.cleanEnv(process.env)).filter(
    ([key]) => key !== 'NODE_TEST_CONTEXT' && !/^SQUADRON_(RUN|GATE)/.test(key)
  )
);
function home(): string {
  const dir = roots.create('squadron-foundation-');
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) roots.remove(dir);
});
const oracle = path.join(helpers.outRoot(), 'test/fixtures/invocation.js');
const timed = path.join(helpers.repoRoot(), 'scripts/timed.mjs');
const words = [
  '',
  'two words',
  '中文 café',
  '"quoted"',
  '%PATH%',
  '!value!',
  '&|<>^',
  'x=y',
  'C:\\end\\'
];

describe('Windows verification foundations', () => {
  it('isolates minimal child environments, stdin bytes, argv and nonzero exits', () => {
    const dir = home();
    const input = Buffer.from([0, 13, 10, 255, 34, 92]);
    const env = { ...roots.environment(dir), FIXTURE_VALUE: words.join('\n'), FIXTURE_EXIT: '23' };
    const result = cp.spawnSync(process.execPath, [oracle, 'echo', ...words], {
      env,
      cwd: dir,
      input,
      encoding: 'utf8',
      timeout: 8000
    });
    assert.equal(result.status, 23, result.stderr);
    const value = JSON.parse(result.stdout) as {
      args: string[];
      stdin: string;
      home: string;
      tmp: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
    };
    assert.deepEqual(value.args, words);
    assert.equal(value.stdin, input.toString('base64'));
    assert.equal(value.home, dir);
    assert.equal(value.tmp, path.join(dir, 'tmp'));
    assert.equal(value.cwd, dir);
    for (const key of ['HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'FIXTURE_VALUE'])
      assert.equal(value.env[key], env[key as keyof typeof env]);
  });

  it('holds with an explicit readiness/release handshake and exits without a helper', async () => {
    const dir = home();
    const child = cp.spawn(process.execPath, [oracle, 'hold', ...words], {
      env: roots.environment(dir)
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output === 'ready\n') child.stdin.write('release\n');
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(
      (JSON.parse(output.slice('ready\n'.length)) as { args: string[] }).args,
      words
    );
  });

  it('bounds a missing release rather than leaving a child running', () => {
    const result = cp.spawnSync(process.execPath, [oracle, 'hold'], {
      env: { ...roots.environment(home()), FIXTURE_TIMEOUT_MS: '100' },
      input: '',
      encoding: 'utf8',
      timeout: 8000
    });
    assert.equal(result.status, 124, result.stderr);
    assert.match(result.stderr, /deadline expired/);
  });

  it('creates sibling homes before moving temp and rejects unsafe cleanup targets', async () => {
    const previous = { ...process.env };
    const first = await helpers.tempHome();
    const second = await helpers.tempHome();
    try {
      assert.equal(path.dirname(first), path.dirname(second));
      assert.equal(os.tmpdir(), path.join(second, 'tmp'));
      const outside = home();
      const sentinel = path.join(outside, 'sentinel');
      fs.writeFileSync(sentinel, 'keep');
      assert.throws(() => roots.remove(path.parse(second).root), /unowned/);
      assert.throws(() => roots.remove(path.join(second, 'tmp')), /unowned/);
      for (const target of [
        path.parse(second).root,
        second,
        outside,
        `${second}-sibling`,
        '.',
        'Z:\\'
      ])
        await assert.rejects(helpers.resetDir(target), /refusing/);
      await helpers.linkDir(outside, path.join(second, 'escape'));
      await assert.rejects(helpers.resetDir(path.join(second, 'escape', 'sentinel')), /link/);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
      const safe = path.join(second, '.squadron');
      fs.mkdirSync(safe);
      fs.writeFileSync(path.join(safe, 'fixture'), 'owned');
      await helpers.resetDir(safe);
      assert.equal(fs.existsSync(safe), false);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      roots.remove(first);
      roots.remove(second);
    }
  });

  it('preserves the direct compiled-test import-order guard', () => {
    const script = `require(${JSON.stringify(path.join(helpers.outRoot(), 'core/paths.js'))});
      require(${JSON.stringify(path.join(helpers.outRoot(), 'test/helpers.js'))}).tempHome()
        .then(() => process.exit(9), e => { console.error(e.message); process.exit(0); });`;
    const result = cp.spawnSync(process.execPath, ['-e', script], {
      env: roots.environment(home()),
      encoding: 'utf8',
      timeout: 8000
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /required before tempHome/);
  });

  it('runs structured steps with exact forwarded argv and environment', () => {
    const dir = home();
    const env = {
      ...CLEAN,
      ...roots.environment(dir),
      FIXTURE_VALUE: words.join('\n'),
      SQUADRON_RUNS_DIR: path.join(dir, 'runs')
    };
    const result = cp.spawnSync(
      process.execPath,
      [timed, `echo=${JSON.stringify(['node', oracle, 'echo'])}`, '--', ...words],
      { cwd: dir, env, input: '', encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout.trim()) as { args: string[]; env: NodeJS.ProcessEnv };
    assert.deepEqual(value.args, words);
    assert.equal(value.env.FIXTURE_VALUE, env.FIXTURE_VALUE);
  });

  it('resolves npm.cmd through its JS entry and preserves job argv without cmd interpolation', async () => {
    const dir = home();
    const bin = path.join(dir, '工具 with spaces');
    fs.mkdirSync(bin);
    const entry = path.join(bin, 'npm-cli.js');
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
    let stdout = '',
      stderr = '';
    const result = await checkpoints.runOwned({
      runner: path.join(helpers.repoRoot(), 'scripts/checkpoints.mjs'),
      file: path.join(dir, 'job-argv.json'),
      command: 'npm.cmd',
      args: words,
      cwd: dir,
      env: {
        ...CLEAN,
        ...roots.environment(dir),
        npm_execpath: entry,
        SQUADRON_GATE_DIR: path.join(dir, 'gate')
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      onSpawn(child) {
        assert.ok(child.stdout);
        assert.ok(child.stderr);
        child.stdout.setEncoding('utf8').on('data', (text) => {
          stdout += text;
        });
        child.stderr.setEncoding('utf8').on('data', (text) => {
          stderr += text;
        });
      }
    });
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), words);
    assert.deepEqual(checkpoints.cleanEnv({ KEEP: '%PATH%', SQUADRON_VERIFY_ID: 'private' }), {
      KEEP: '%PATH%'
    });
  });

  it('dispatches every verification mode to fixtures and forwards flags through the npm shell', () => {
    const dir = home();
    const events = path.join(dir, 'events.jsonl');
    const collector = `require('node:fs').appendFileSync(process.env.FOUNDATION_EVENTS,
      JSON.stringify({args:process.argv.slice(2),slow:process.env.SQUADRON_SMOKE_SLOW})+'\\n');`;
    for (const file of [
      'emit.cjs',
      'scripts/affected.mjs',
      'out/test/smoke/runner.js',
      'out/test/smoke/cleanup.smoke.js'
    ]) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        file.endsWith('.mjs')
          ? `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${collector}`
          : collector
      );
    }
    const verify = path.join(helpers.repoRoot(), 'scripts/verify.mjs');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          compile: 'node emit.cjs compile',
          'format:check': 'node emit.cjs format',
          lint: 'node emit.cjs lint',
          test: `node "${verify}" test`
        }
      })
    );
    const env = {
      ...CLEAN,
      ...roots.environment(dir),
      PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
      FOUNDATION_EVENTS: events,
      SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
      SQUADRON_GATE_DIR: path.join(dir, 'gate')
    };
    const cases: [string, string[], string[][]][] = [
      ['test', ['--base', 'HEAD', '--all'], [['compile'], ['--base', 'HEAD', '--all']]],
      ['check', ['--all'], [['format'], ['lint'], ['compile'], ['--all']]],
      ['dev:host', [], [['compile']]],
      ['test:smoke', [], [['compile'], ['out/test/smoke/e2e.js']]],
      ['test:smoke:one', ['remote.js'], [['compile'], ['remote.js']]],
      ['test:smoke:cleanup', [], [['compile'], []]],
      ['test:smoke:slow', [], [['compile'], ['out/test/smoke/e2e.js']]]
    ];
    for (const [mode, args, expected] of cases) {
      fs.writeFileSync(events, '');
      const result = cp.spawnSync(process.execPath, [verify, mode, ...args], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 60000
      });
      assert.equal(result.status, 0, result.stderr);
      const rows = fs
        .readFileSync(events, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; slow?: string });
      assert.deepEqual(
        rows.map((row) => row.args),
        expected,
        mode
      );
      if (mode === 'test:smoke:slow') assert.ok(rows.every((row) => row.slow === '250'));
    }
    fs.writeFileSync(events, '');
    const npm = checkpoints.program('npm', ['test', '--', '--base', 'HEAD', '--all'], env);
    const invocation =
      helpers.testPlatform() === 'win32'
        ? {
            command: 'cmd.exe',
            args: [
              '/d',
              '/s',
              '/c',
              `""${npm.command}" "${npm.args[0]}" test -- --base HEAD --all"`
            ]
          }
        : npm;
    const result = cp.spawnSync(invocation.command, invocation.args, {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 60000,
      windowsVerbatimArguments: helpers.testPlatform() === 'win32'
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = fs
      .readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    assert.deepEqual(
      rows.map((row) => row.args),
      [['compile'], ['--base', 'HEAD', '--all']]
    );
  });

  it('serializes protected Node steps and releases the slot after child close', async () => {
    const dir = home();
    const step = path.join(dir, 'step.cjs');
    const log = path.join(dir, 'intervals.jsonl');
    fs.writeFileSync(
      step,
      `const fs=require('node:fs');
      const log=${JSON.stringify(log)};
      fs.appendFileSync(log,JSON.stringify(['start',process.pid])+'\\n');
      setTimeout(()=>fs.appendFileSync(log,JSON.stringify(['end',process.pid])+'\\n'),250);`
    );
    const env = {
      ...CLEAN,
      ...roots.environment(dir),
      SQUADRON_GATE_DIR: path.join(dir, 'gate'),
      SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
      // A slot the first run fails to leave fails here, not after 45 minutes.
      SQUADRON_GATE_TIMEOUT_MS: '30000'
    };
    const start = () => {
      const child = cp.spawn(
        process.execPath,
        [timed, `compile=${JSON.stringify(['node', step])}`],
        { cwd: dir, env }
      );
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stderr }));
      });
    };
    const runs = await Promise.all([start(), start()]);
    // Both runs' output: a leaked holder shows in the one that left, not the one that waited.
    const evidence = runs.map((run) => run.stderr).join('\n---\n');
    assert.deepEqual(
      runs.map((run) => run.code),
      [0, 0],
      evidence
    );
    const rows = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as [string, number]);
    assert.deepEqual(
      rows.map(([kind]) => kind),
      ['start', 'end', 'start', 'end']
    );
    assert.equal(rows[0]?.[1], rows[1]?.[1]);
    assert.equal(rows[2]?.[1], rows[3]?.[1]);
    assert.deepEqual(fs.readdirSync(env.SQUADRON_GATE_DIR), [], evidence);
  });

  it(
    'refuses unknown Windows gate ownership before any protected work',
    {
      skip: helpers.testPlatform() !== 'win32' && 'posix: Windows fail-closed bootstrap policy'
    },
    () => {
      for (const record of ['invalid json', JSON.stringify({ pid: 2147483647, protected: true })]) {
        const dir = home();
        const gate = path.join(dir, 'gate');
        fs.mkdirSync(gate);
        fs.writeFileSync(path.join(gate, 'holder'), record);
        const marker = path.join(dir, 'started');
        const result = cp.spawnSync(
          process.execPath,
          [
            timed,
            `compile=${JSON.stringify(['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`])}`
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 8000,
            env: {
              ...CLEAN,
              ...roots.environment(dir),
              SQUADRON_GATE_DIR: gate,
              SQUADRON_RUNS_DIR: path.join(dir, 'runs'),
              SQUADRON_GATE_TIMEOUT_MS: '100'
            }
          }
        );
        assert.equal(result.status, 75, result.stderr);
        assert.equal(fs.existsSync(marker), false);
        assert.equal(fs.readFileSync(path.join(gate, 'holder'), 'utf8'), record);
      }
    }
  );
});
