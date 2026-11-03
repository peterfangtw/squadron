import * as assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { preloadEnv } from '../fixtures/preload';
import { repoRoot, testPlatform } from '../helpers';
import * as checkpoints from '../../../scripts/checkpoints.mjs';

/**
 * `scripts/timed.mjs`, driven as the process it is, in a throwaway repository with the
 * script copied in. `GIT_*` is stripped for the reason `release.test.ts` gives:
 * the pre-commit hook exports them, and they would aim every `git` here at this
 * checkout. `npm_*` goes because `npm test` sets `npm_lifecycle_event`, which
 * is the field under test.
 */

const REPO = repoRoot();

const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('SQUADRON_VERIFY_') &&
      key !== 'SQUADRON_TIMINGS_FILE' &&
      !key.startsWith('GIT_') &&
      !key.startsWith('npm_') &&
      !key.startsWith('SQUADRON_RUN') &&
      !key.startsWith('SQUADRON_GATE') &&
      key !== 'NODE_TEST_CONTEXT' &&
      key !== 'NO_COLOR' &&
      key !== 'FORCE_COLOR'
  )
);

type Line = {
  run: string;
  failed: string[];
  alongside: {
    start: { pid: number; script: string; worktree: string | null }[];
    end: { pid: number; script: string; worktree: string | null }[];
  };
  script: string | null;
  branch: string | null;
  sha: string;
  worktree: string;
  exit: number;
  ms: number;
  steps: { name: string; ms: number; exit: number }[];
  load: number[];
  waitedMs?: number;
};

const made: string[] = [];
after(() => Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function repo(git = true): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-timed-')));
  made.push(dir);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(REPO, 'scripts/timed.mjs'), path.join(dir, 'scripts/timed.mjs'));
  await fs.copyFile(
    path.join(REPO, 'scripts/observation.mjs'),
    path.join(dir, 'scripts/observation.mjs')
  );
  await fs.copyFile(
    path.join(REPO, 'scripts/checkpoints.mjs'),
    path.join(dir, 'scripts/checkpoints.mjs')
  );
  await fs.copyFile(
    path.join(REPO, 'scripts/verification_processes.mjs'),
    path.join(dir, 'scripts/verification_processes.mjs')
  );
  if (!git) return dir;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: CLEAN });
  run('init', '--quiet', '--initial-branch=work', '.');
  run(
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'x'
  );
  return dir;
}

function timed(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['scripts/timed.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...CLEAN,
      SQUADRON_GATE_DIR: path.join(dir, 'fixture-gate'),
      npm_lifecycle_event: 'check',
      ...env
    }
  });
}

/**
 * `node step.cjs <verb> …`: a step string goes to whichever shell the platform
 * has, sh or cmd.exe, and this is the form both run as written.
 */
const STEP = [
  "const fs = require('node:fs');",
  'const [verb, a, b] = process.argv.slice(2);',
  "const touch = (file) => fs.writeFileSync(file, '');",
  "if (verb === 'touch') touch(a);",
  "if (verb === 'exists') process.exitCode = fs.existsSync(a) ? 0 : 1;",
  "if (verb === 'sleep') touch(a), setTimeout(() => {}, Number(b));",
  '// Until the test writes go, and no longer than 30 s, so a step whose',
  '// runner was killed under it cannot outlive the test.',
  "if (verb === 'hold') {",
  '  touch(a);',
  '  const deadline = Date.now() + 30000;',
  '  const poll = setInterval(() => {',
  "    if (fs.existsSync('go')) clearInterval(poll), touch(b);",
  '    else if (Date.now() > deadline) clearInterval(poll), (process.exitCode = 1);',
  '  }, 50);',
  '}'
].join('\n');

async function stepScript(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'step.cjs'), STEP);
}

async function lines(dir: string): Promise<Line[]> {
  const raw = await fs.readFile(path.join(dir, '.git', 'squadron-timings.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);
}

describe('scripts/timed.mjs', () => {
  it('refuses protected dispatch when native launch evidence is denied', async () => {
    const dir = await repo();
    const env = preloadEnv(
      dir,
      `
      const cp=require('node:child_process');const run=cp.execFileSync;
      cp.execFileSync=function(command,args,options){
        if(command==='powershell.exe'||command==='ps') throw Error('fixture native evidence denied');
        return run.apply(this,arguments);
      };
    `
    );
    const ran = timed(
      dir,
      ["compile=node -e \"require('node:fs').writeFileSync('started','yes')\""],
      env
    );
    assert.notEqual(ran.status, 0, ran.stderr);
    assert.equal(await fs.stat(path.join(dir, 'started')).catch(() => undefined), undefined);
  });
  it('logs each step, the branch and the script, and passes the exit code through', async () => {
    const dir = await repo();
    const ran = timed(dir, ['one=exit 0', 'two=exit 3', 'three=echo never']);
    assert.equal(ran.status, 3);
    assert.doesNotMatch(ran.stdout, /never/);
    const [line, ...rest] = await lines(dir);
    assert.equal(rest.length, 0);
    assert.equal(line?.script, 'check');
    assert.equal(line?.branch, 'work');
    assert.equal(line?.worktree, dir);
    assert.equal(line?.exit, 3);
    assert.deepEqual(
      line?.steps.map(({ name, exit }) => ({ name, exit })),
      [
        { name: 'one', exit: 0 },
        { name: 'two', exit: 3 }
      ]
    );
    assert.equal(line?.load.length, 2);
  });

  it('copies both streams without ANSI and names the red step and its evidence', async () => {
    const dir = await repo();
    // The evidence line a beat later, so it reaches the log after `red`, as it
    // would from the next command.
    await fs.writeFile(
      path.join(dir, 'red.cjs'),
      "const e = String.fromCharCode(27); process.stdout.write(e+'[31mred'+e+'[0m\\n'); setTimeout(() => { process.stderr.write('evidence: /tmp/capture\\n'); console.log(process.env.SQUADRON_RUN); process.exitCode = 1; }, 50);"
    );
    const ran = timed(dir, ['red=node red.cjs']);
    assert.equal(ran.status, 1);
    const line = (await lines(dir))[0]!;
    const log = await fs.readFile(path.join(line.run, 'red.log'), 'utf8');
    assert.match(log, /^red\n/);
    assert.equal(log.includes(String.fromCharCode(27)), false);
    assert.ok(log.includes(line.run));
    assert.ok(ran.stderr.includes(path.join(line.run, 'red.log')));
    assert.match(ran.stderr, /evidence: \/tmp\/capture/);
    assert.ok(Array.isArray(line.alongside.start));
    assert.ok(Array.isArray(line.alongside.end));
  });

  // One `lsof` a runner made a start O(runners): under a full gate a follower
  // missed a follower's fifteen seconds before it ever reached the line.
  it(
    'names every other runner and its worktree with one lsof a side, however many run',
    { skip: testPlatform() === 'win32' && 'win32: no lsof — W3.6' },
    async () => {
      const real = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).stdout.trim();
      if (!real) return;
      const dir = await repo();
      const env = preloadEnv(
        dir,
        `
const cp = require('node:child_process'), fs = require('node:fs');
const run = cp.spawnSync;
cp.spawnSync = function(file, ...args) {
  if (file === 'lsof') fs.appendFileSync(${JSON.stringify(path.join(dir, 'lsof-calls'))}, '\\n');
  return run.call(this, file, ...args);
};
`
      );
      const others = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-other-')));
      made.push(others);
      await fs.writeFile(
        path.join(others, 'timed.mjs'),
        "setTimeout(()=>process.exit(124),30000);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('ready');"
      );
      const decoys = Array.from({ length: 5 }, () =>
        spawn(process.execPath, [path.join(others, 'timed.mjs'), 'decoy'], {
          cwd: others,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      );
      const closed = decoys.map(
        (child) => new Promise<void>((resolve) => child.once('close', () => resolve()))
      );
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            decoys.map(
              (child) =>
                new Promise<void>((resolve, reject) => {
                  child.stdout.once('data', () => resolve());
                  child.once('error', reject);
                  child.once('close', () => reject(new Error('decoy exited before ready')));
                })
            )
          ),
          new Promise<never>((_, reject) => {
            readyTimer = setTimeout(() => reject(new Error('decoys did not become ready')), 4000);
          })
        ]);
        clearTimeout(readyTimer);
        const ran = timed(dir, ['a=true'], env);
        assert.equal(ran.status, 0, ran.stderr);
        const [line] = await lines(dir);
        for (const decoy of decoys) {
          assert.deepEqual(
            line?.alongside.start.find((other) => other.pid === decoy.pid),
            { pid: decoy.pid, script: 'decoy', worktree: others }
          );
        }
        const calls = (await fs.readFile(path.join(dir, 'lsof-calls'), 'utf8')).split('\n');
        assert.equal(calls.length - 1, 2, 'one lsof at the start and one at the end');
      } finally {
        clearTimeout(readyTimer);
        for (const decoy of decoys) decoy.stdin.end();
        const timer = setTimeout(() => {
          for (const decoy of decoys) decoy.kill('SIGKILL');
        }, 1000);
        try {
          await Promise.all(closed);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  );

  it('strips colour sequences split across output chunks', async () => {
    const dir = await repo();
    await fs.writeFile(
      path.join(dir, 'chunks.cjs'),
      "process.stdout.write(String.fromCharCode(27)+'['); setTimeout(()=>process.stdout.write('31mred'+String.fromCharCode(27)+'[0m\\n'), 30);"
    );
    assert.equal(timed(dir, ['test=node chunks.cjs']).status, 0);
    const line = (await lines(dir))[0]!;
    assert.equal(await fs.readFile(path.join(line.run, 'test.log'), 'utf8'), 'red\n');
  });

  it('parses failing names from real spec and dot reporters, capped at twenty', async () => {
    const dir = await repo();
    await fs.writeFile(
      path.join(dir, 'red.cjs'),
      "const { test } = require('node:test'); for(let i=0;i<22;i++) test('failure '+i, () => {throw Error('red')});"
    );
    for (const reporter of ['spec', 'dot']) {
      const ran = timed(dir, [`test=node --test --test-reporter=${reporter} red.cjs`]);
      assert.equal(ran.status, 1);
      const line = (await lines(dir)).at(-1)!;
      assert.equal(line.failed.length, 20);
      assert.deepEqual(line.failed.slice(0, 2), ['failure 0', 'failure 1']);
    }
  });

  it('keeps twenty run folders and leaves unrelated entries alone', async () => {
    const dir = await repo();
    const root = path.join(dir, '.git', 'squadron-runs');
    await fs.mkdir(root);
    for (let i = 0; i < 23; i++)
      await fs.mkdir(
        path.join(root, `2020-01-01T00-00-${String(i).padStart(2, '0')}.000Z-check-999999`)
      );
    await fs.mkdir(path.join(root, 'someone-elses-folder'));
    const ran = timed(dir, ['a=node -e 0']);
    assert.equal(ran.status, 0);
    const folders = await fs.readdir(root, { withFileTypes: true });
    assert.equal(
      folders.filter((entry) => entry.isDirectory() && entry.name !== 'someone-elses-folder')
        .length,
      20
    );
    assert.ok(folders.some((entry) => entry.name === 'someone-elses-folder'));
  });

  it('does not prune an override root it did not create', async () => {
    const dir = await repo();
    const root = path.join(dir, 'external');
    await fs.mkdir(root);
    for (let i = 0; i < 23; i++)
      await fs.mkdir(
        path.join(root, `2020-01-01T00-00-${String(i).padStart(2, '0')}.000Z-check-999999`)
      );
    const ran = timed(dir, ['a=node -e 0'], { SQUADRON_RUNS_DIR: root });
    assert.equal(ran.status, 0);
    assert.equal(
      (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
        .length,
      24
    );
  });

  it(
    'records another live runner at both edges with its script and cwd',
    {
      todo: testPlatform() === 'win32' && 'win32: alongside() has no ps/lsof — W3.6',
      timeout: 60_000
    },
    async () => {
      const dir = await repo();
      await stepScript(dir);
      const child = spawn(
        process.execPath,
        ['scripts/timed.mjs', 'wait=node step.cjs sleep started 3000'],
        {
          cwd: dir,
          env: {
            ...CLEAN,
            SQUADRON_GATE_DIR: path.join(dir, 'fixture-gate'),
            npm_lifecycle_event: 'test:smoke:one'
          },
          stdio: 'ignore'
        }
      );
      const closed = new Promise((resolve) => child.on('close', resolve));
      try {
        const deadline = Date.now() + 10000;
        while (!(await fs.stat(path.join(dir, 'started')).catch(() => undefined))) {
          assert.equal(child.exitCode, null, 'runner exited before starting');
          assert.equal(child.signalCode, null, 'runner was killed before starting');
          assert.ok(Date.now() < deadline, 'runner did not start within ten seconds');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(timed(dir, ['a=true']).status, 0);
        const line = (await lines(dir))[0]!;
        for (const edge of [line.alongside.start, line.alongside.end]) {
          assert.deepEqual(
            edge.find((row) => row.pid === child.pid),
            { pid: child.pid, script: 'test:smoke:one', worktree: dir }
          );
        }
      } finally {
        child.kill('SIGTERM');
        await closed;
      }
    }
  );

  it(
    'drains both terminal streams for a slow piped reader before exit',
    { skip: testPlatform() === 'win32' && 'win32: Node writes stdio pipes synchronously — W8.2' },
    async () => {
      const dir = await repo();
      const size = 1024 * 1024;
      await fs.writeFile(
        path.join(dir, 'output.cjs'),
        `process.stdout.write('a'.repeat(${size})); process.stderr.write('b'.repeat(${size})); process.exitCode = 1;`
      );
      const child = spawn(process.execPath, ['scripts/timed.mjs', 'red=node output.cjs'], {
        cwd: dir,
        env: CLEAN
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (text: string) => {
        stdout += text;
      });
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        stderr += text;
      });
      child.stdout.pause();
      child.stderr.pause();
      const closed = new Promise((resolve) => child.on('close', resolve));
      try {
        const deadline = Date.now() + 10000;
        while (
          !(await fs.stat(path.join(dir, '.git', 'squadron-timings.jsonl')).catch(() => undefined))
        ) {
          assert.equal(child.exitCode, null, 'runner exited before its timings line');
          assert.ok(Date.now() < deadline, 'runner did not finish its step');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        child.stdout.resume();
        child.stderr.resume();
        await closed;
        assert.equal(child.exitCode, 1);
        assert.equal(stdout.length, size);
        assert.equal(stdout, 'a'.repeat(size));
        assert.ok(stderr.startsWith('b'.repeat(size)));
        assert.match(stderr, /timed: red failed \(exit 1\)/);
        assert.ok(stderr.includes(path.join((await lines(dir))[0]!.run, 'red.log')));
      } finally {
        child.stdout.resume();
        child.stderr.resume();
        child.kill('SIGTERM');
        await closed;
      }
    }
  );

  it('hands what npm appended to the last step, quoted', async () => {
    const dir = await repo();
    // `node`, not `echo`: cmd's `echo` prints the quotes it was handed.
    const argv = `node -e "console.log(process.argv.slice(1).join(' '))"`;
    const ran = timed(dir, ['a=node -e 0', `b=${argv}`, "it's", '--flag=x']);
    assert.equal(ran.status, 0);
    assert.equal(ran.stdout, "it's --flag=x\n");
    assert.deepEqual(
      (await lines(dir))[0]?.steps.map(({ name }) => name),
      ['a', 'b']
    );
  });

  it('appends one line per run to the log every worktree shares', async () => {
    const dir = await repo();
    const tree = path.join(dir, '.worktrees', 'side');
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', tree], { cwd: dir, env: CLEAN });
    await fs.mkdir(path.join(tree, 'scripts'), { recursive: true });
    await fs.copyFile(path.join(dir, 'scripts/timed.mjs'), path.join(tree, 'scripts/timed.mjs'));
    await fs.copyFile(
      path.join(dir, 'scripts/checkpoints.mjs'),
      path.join(tree, 'scripts/checkpoints.mjs')
    );
    await fs.copyFile(
      path.join(REPO, 'scripts/observation.mjs'),
      path.join(tree, 'scripts/observation.mjs')
    );
    await fs.copyFile(
      path.join(REPO, 'scripts/verification_processes.mjs'),
      path.join(tree, 'scripts/verification_processes.mjs')
    );
    timed(dir, ['a=true']);
    timed(tree, ['a=true']);
    const [main, side] = await lines(dir);
    assert.equal(main?.worktree, dir);
    assert.equal(side?.worktree, tree);
    assert.equal(side?.branch, null);
    assert.equal(side?.sha, main?.sha);
  });

  /**
   * Runs `step` then a step that must never run, and SIGTERMs this process once
   * `step` touches `started` — which it does only when its handler is in place,
   * or a signal in between takes the shell's default and logs 143.
   */
  async function interrupt(step: string) {
    const dir = await repo();
    const child = spawn(
      process.execPath,
      ['scripts/timed.mjs', `slow=${step}`, 'never=touch reached'],
      {
        cwd: dir,
        env: CLEAN
      }
    );
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    while (!(await fs.stat(path.join(dir, 'started')).catch(() => undefined))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // To this process alone, as a command timeout sends it — not to its group.
    child.kill('SIGTERM');
    const code = await exited;
    const [line] = await lines(dir);
    const reached = await fs.stat(path.join(dir, 'reached')).catch(() => undefined);
    return { code, line, reached };
  }

  it(
    'logs a run a signal ended, and stops the step it was on',
    {
      skip:
        testPlatform() === 'win32' && 'win32: SIGTERM is TerminateProcess; no handler runs — W4.2'
    },
    async () => {
      const { code, line, reached } = await interrupt('touch started; exec sleep 30');
      assert.equal(code, 143);
      assert.equal(line?.exit, 143);
      assert.deepEqual(
        line?.steps.map(({ name, exit }) => ({ name, exit })),
        [{ name: 'slow', exit: 143 }]
      );
      assert.equal(reached, undefined);
    }
  );

  // `node --test` is this step: it catches SIGINT and SIGTERM and exits 1, the
  // same code as a red test.
  it(
    'logs the signal, not the exit 1 a step that caught it chose',
    {
      skip:
        testPlatform() === 'win32' && 'win32: SIGTERM is TerminateProcess; no handler runs — W4.2'
    },
    async () => {
      const { code, line, reached } = await interrupt(
        'trap "kill $!; exit 1" TERM; sleep 30 & touch started; wait'
      );
      assert.equal(code, 143);
      assert.equal(line?.exit, 143);
      assert.deepEqual(
        line?.steps.map(({ name, exit }) => ({ name, exit })),
        [{ name: 'slow', exit: 1 }]
      );
      assert.equal(reached, undefined);
    }
  );

  it('still runs the steps outside a git checkout, and logs nothing', async () => {
    const dir = await repo(false);
    const ran = timed(dir, ['a=node -e "console.log(process.env.SQUADRON_RUN)"']);
    assert.equal(ran.status, 0);
    const run = ran.stdout.trim();
    made.push(run);
    assert.equal(await fs.readFile(path.join(run, 'a.log'), 'utf8'), ran.stdout);
    assert.equal(await fs.stat(path.join(dir, '.git')).catch(() => undefined), undefined);
    assert.equal(ran.stderr, `timed: run: ${run}\n`);
  });
});

const gateLivenessTodo: false | string =
  testPlatform() === 'win32' && 'win32: gate liveness has no process groups or start times — W3.6';

/**
 * The line every run from `compile` onward waits in. Each test gets its own
 * gate folder, so nothing here queues behind a real run on this machine.
 */
describe('scripts/timed.mjs gate', () => {
  for (const field of ['version', 'gate', 'token', 'generation']) {
    const replace = `
      const holder = path.join(process.env.SQUADRON_GATE_DIR, 'holder');
      const record = JSON.parse(disk.readFileSync(holder, 'utf8'));
      const field = ${JSON.stringify(field)};
      if (field === 'version') record.version++;
      if (field === 'gate') record.gate = path.join(record.gate, 'replacement');
      if (field === 'token') record.token = require('node:crypto').randomUUID();
      if (field === 'generation') record.generation++;
      const replacement = JSON.stringify(record, null, 2);
      disk.writeFileSync(holder, replacement);
      disk.writeFileSync('replacement.json', replacement);
    `;

    it(`preserves a changed ${field} holder after command completion`, async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      await fs.writeFile(
        path.join(dir, 'replace.cjs'),
        `const disk = require('node:fs'), path = require('node:path'); ${replace}`
      );
      const ran = timed(dir, [`compile=${JSON.stringify([process.execPath, 'replace.cjs'])}`], {
        SQUADRON_GATE_DIR
      });
      assert.equal(ran.status, 0, ran.stderr);
      const replacement = await fs.readFile(path.join(dir, 'replacement.json'), 'utf8');
      assert.equal(await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8'), replacement);
    });

    for (const phase of ['reservation', 'binding']) {
      it(`refuses ${phase} publication over a changed ${field} holder`, async () => {
        const dir = await repo();
        const SQUADRON_GATE_DIR = await gate();
        const ran = timed(
          dir,
          ["compile=node -e \"require('node:fs').writeFileSync('started','yes')\""],
          {
            SQUADRON_GATE_DIR,
            ...preloadEnv(
              dir,
              `
              const disk = require('node:fs'), path = require('node:path');
              const mkdir = disk.mkdirSync;
              let replaced = false;
              disk.mkdirSync = function(target, ...args) {
                const result = mkdir.call(this, target, ...args);
                if (!replaced && String(target) === path.join(process.env.SQUADRON_GATE_DIR, '.lock')) {
                  const file = path.join(process.env.SQUADRON_GATE_DIR, 'holder');
                  const current = disk.existsSync(file) && JSON.parse(disk.readFileSync(file, 'utf8'));
                  if (current && (${JSON.stringify(phase)} === 'reservation' ? !current.job : current.job && !current.job.wrapper)) {
                    replaced = true;
                    ${replace}
                  }
                }
                return result;
              };
              `
            )
          }
        );
        const replacement = await fs.readFile(path.join(dir, 'replacement.json'), 'utf8');
        assert.equal(
          await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8'),
          replacement
        );
        assert.notEqual(ran.status, 0, ran.stderr);
        assert.equal(await exists(path.join(dir, 'started')), false);
      });
    }
  }

  it('retains a reservation when its writer dies before wrapper spawn', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const ready = path.join(dir, 'reserved');
    const first = runner(
      dir,
      ["compile=node -e \"require('node:fs').writeFileSync('started','yes')\""],
      {
        SQUADRON_GATE_DIR,
        ...preloadEnv(
          dir,
          `
        const cp=require('node:child_process'),fs=require('node:fs');const spawn=cp.spawn;
        cp.spawn=function(command,args,options){
          if(args?.includes('--job')) {
            fs.writeFileSync(${JSON.stringify(ready)},args[args.indexOf('--job')+1]);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
            throw Error('fixture reservation deadline');
          }
          return spawn.apply(this,arguments);
        };
      `
        )
      }
    );
    try {
      await until(() => exists(ready), 'reservation before actual spawn');
      const job = await fs.readFile(ready, 'utf8');
      const holder = JSON.parse(
        await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8')
      ) as { job: { file: string } };
      assert.equal(holder.job.file, job, 'owner must publish reservation before spawning');
      first.child.kill('SIGKILL');
      await closedWithin(first.closed);
      const follower = timed(dir, ['compile=node -e 0'], {
        SQUADRON_GATE_DIR,
        SQUADRON_GATE_TIMEOUT_MS: '100'
      });
      assert.equal(follower.status, 75, follower.stderr);
      assert.equal(await exists(path.join(dir, 'started')), false);
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8')),
        holder
      );
    } finally {
      first.child.kill('SIGKILL');
      await closedWithin(first.closed);
    }
  });
  it('requires inherited authority for nested admission, including generation zero', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const holder = {
      ...checkpoints.processIdentity(process.pid),
      token: '00000000-0000-4000-8000-000000000003',
      generation: 0,
      gate: SQUADRON_GATE_DIR,
      script: 'outer'
    };
    await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(holder));
    const inherited = {
      SQUADRON_GATE_DIR,
      SQUADRON_GATE_HOLDER: String(process.pid),
      SQUADRON_GATE_TOKEN: holder.token,
      SQUADRON_GATE_GENERATION: '0',
      SQUADRON_GATE_TIMEOUT_MS: '25'
    };
    for (const invalid of [
      { SQUADRON_GATE_TOKEN: undefined },
      { SQUADRON_GATE_TOKEN: 'stale' },
      { SQUADRON_GATE_GENERATION: '2' }
    ]) {
      const ran = timed(dir, ['compile=node -e 0'], { ...inherited, ...invalid });
      assert.equal(ran.status, 75, ran.stderr);
    }
    for (const invalid of [
      { ...holder, version: 2 },
      { ...holder, version: undefined },
      { ...holder, gate: undefined },
      { ...holder, gate: path.join(SQUADRON_GATE_DIR, 'replacement') },
      { ...holder, token: undefined },
      { ...holder, generation: undefined },
      { ...holder, generation: -1 },
      { ...holder, generation: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(invalid));
      const ran = timed(dir, ['compile=node -e 0'], inherited);
      assert.equal(ran.status, 75, ran.stderr);
    }
    // Nested admission alone cannot authorize dispatch with a malformed token.
    await fs.writeFile(
      path.join(SQUADRON_GATE_DIR, 'holder'),
      JSON.stringify({ ...holder, token: 'malformed' })
    );
    const legacy = timed(
      dir,
      ["compile=node -e \"require('node:fs').writeFileSync('malformed-started','yes')\""],
      {
        ...inherited,
        SQUADRON_GATE_TOKEN: 'malformed'
      }
    );
    assert.equal(legacy.status, 127, legacy.stderr);
    assert.equal(await exists(path.join(dir, 'malformed-started')), false);
    await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(holder));
    const ran = timed(dir, ['compile=node -e 0'], inherited);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8')),
      holder
    );
  });
  async function gate(): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-gate-')));
    made.push(dir);
    return dir;
  }

  function runner(dir: string, args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, ['scripts/timed.mjs', ...args], {
      cwd: dir,
      env: {
        ...CLEAN,
        SQUADRON_GATE_DIR: path.join(dir, 'fixture-gate'),
        npm_lifecycle_event: 'check',
        ...env
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    child.stdout.resume();
    const closed = new Promise<number | null>((resolve) =>
      child.on('close', (code, signal) =>
        resolve(code ?? (signal ? 128 + os.constants.signals[signal] : null))
      )
    );
    return { child, closed, stderr: () => stderr };
  }

  async function until(check: () => unknown, what: string) {
    const deadline = Date.now() + 15000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `${what} within fifteen seconds`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** A step that holds until the test writes `go`. */
  const RELEASED = 'while [ ! -e go ]; do sleep 0.05; done';

  async function closedWithin(closed: Promise<number | null>): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('runner did not close within fifteen seconds')),
            15000
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const exists = (file: string) =>
    fs.stat(file).then(
      () => true,
      () => false
    );

  /** A live process that is not a runner, with the start time the gate checks. */
  function bystander() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      stdio: 'ignore'
    });
    // win32 has no `ps` start time, and the gate reads an absent one as unknown.
    const started =
      testPlatform() === 'win32'
        ? undefined
        : execFileSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' }
          }).trim();
    return {
      child,
      record: {
        pid: child.pid,
        ...(started !== undefined && { started }),
        script: 'check',
        worktree: '/elsewhere',
        at: Date.now()
      }
    };
  }

  it('runs a second run once the first leaves, and logs its wait apart from its steps', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    await stepScript(dir);
    const first = runner(dir, ['compile=node step.cjs hold a-start a-end'], { SQUADRON_GATE_DIR });
    await until(() => exists(path.join(dir, 'a-start')), 'first run started');
    const second = runner(
      dir,
      ['lint=node step.cjs touch b-lint', 'compile=node step.cjs exists a-end'],
      { SQUADRON_GATE_DIR }
    );
    await until(() => /waiting for the gate/.test(second.stderr()), 'second run waiting');
    assert.equal(await exists(path.join(dir, 'b-lint')), true, 'lint ran before the line');
    await fs.writeFile(path.join(dir, 'go'), '');
    assert.equal(await first.closed, 0);
    assert.equal(await second.closed, 0);
    assert.match(second.stderr(), /waiting for the gate: 1 ahead — check \(pid \d+/);
    const line = (await lines(dir)).find((row) => row.waitedMs && row.waitedMs > 0);
    assert.ok(line, 'the second run logged a wait');
    assert.ok(line.steps.every((step) => step.ms < line.ms));
    assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), []);
  });

  it('excludes a separate archive from a clone using the same explicit gate root', async () => {
    const clone = await repo();
    const archive = await repo(false);
    const SQUADRON_GATE_DIR = await gate();
    await stepScript(clone);
    const first = runner(clone, ['compile=node step.cjs hold started finished'], {
      SQUADRON_GATE_DIR
    });
    let second: ReturnType<typeof runner> | undefined;
    try {
      await until(() => exists(path.join(clone, 'started')), 'clone dispatch');
      second = runner(
        archive,
        ["compile=node -e \"require('node:fs').writeFileSync('dispatched','yes')\""],
        { SQUADRON_GATE_DIR }
      );
      await until(() => /waiting for the gate/.test(second!.stderr()), 'archive excluded');
      assert.equal(await exists(path.join(archive, 'dispatched')), false);
      await fs.writeFile(path.join(clone, 'go'), '');
      assert.equal(await first.closed, 0, first.stderr());
      assert.equal(await second.closed, 0, second.stderr());
      assert.equal(await exists(path.join(archive, 'dispatched')), true);
    } finally {
      await fs.writeFile(path.join(clone, 'go'), '');
      await first.closed;
      if (second) await second.closed;
    }
  });

  it(
    'stops a cancelled step’s descendants before admitting another runner',
    {
      skip:
        testPlatform() === 'win32' &&
        'win32: SIGTERM is TerminateProcess; no handler runs — W4.2/W3.4'
    },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      await stepScript(dir);
      const first = runner(dir, [`compile=(${RELEASED}; touch done) & touch started; wait`], {
        SQUADRON_GATE_DIR
      });
      try {
        await until(() => exists(path.join(dir, 'started')), 'first run started');
        first.child.kill('SIGTERM');
        assert.equal(await closedWithin(first.closed), 143);
        assert.equal(await exists(path.join(SQUADRON_GATE_DIR, 'holder')), false);
        const follower = timed(dir, ['compile=node step.cjs touch admitted'], {
          SQUADRON_GATE_DIR,
          SQUADRON_GATE_TIMEOUT_MS: '1000'
        });
        assert.equal(follower.status, 0, follower.stderr);
        assert.equal(await exists(path.join(dir, 'admitted')), true);
      } finally {
        // The left shell waits for `go` alone, and a follower for that shell.
        // The signal too: a runner not yet at its step would start it after
        // `after` removed `dir`, where no `go` can appear.
        first.child.kill('SIGTERM');
        await fs.writeFile(path.join(dir, 'go'), '');
      }
    }
  );

  it('keeps competing work outside the gate during acknowledged cleanup', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const cancellation = path.join(dir, 'cancel');
    await fs.writeFile(
      path.join(dir, 'cleanup.cjs'),
      `const fs=require('node:fs');
process.on('SIGTERM',()=>{fs.writeFileSync('cleaning','yes');setInterval(()=>{if(fs.existsSync('go'))process.exit(1);},10);});
fs.writeFileSync('worker-pid',String(process.pid));fs.writeFileSync('started','yes');setTimeout(()=>process.exit(124),10000);`
    );
    const first = runner(dir, ['compile=' + JSON.stringify(['node', 'cleanup.cjs'])], {
      SQUADRON_GATE_DIR,
      ...(testPlatform() === 'win32'
        ? preloadEnv(
            dir,
            `
              const fs=require('node:fs');
              const poll=setInterval(()=>{
                if(!fs.existsSync(${JSON.stringify(cancellation)}))return;
                clearInterval(poll);process.emit('SIGTERM');
              },10);poll.unref();
              `
          )
        : {})
    });
    let second: ReturnType<typeof runner> | undefined;
    try {
      await until(() => exists(path.join(dir, 'started')), 'step started');
      const workerPid = Number(await fs.readFile(path.join(dir, 'worker-pid'), 'utf8'));
      const wrapperPid = (
        JSON.parse(await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8')) as {
          workerPid: number;
        }
      ).workerPid;
      const identities = [workerPid, wrapperPid].map((pid) => checkpoints.processIdentity(pid));
      assert.ok(identities.every((identity) => identity.source !== 'unknown'));
      // Windows kill is TerminateProcess. This exercises handlers, not console delivery.
      if (testPlatform() === 'win32') await fs.writeFile(cancellation, 'cancel');
      else first.child.kill('SIGTERM');
      await until(() => exists(path.join(dir, 'cleaning')), 'cleanup acknowledged');
      second = runner(
        dir,
        ["compile=node -e \"require('node:fs').writeFileSync('admitted','yes')\""],
        { SQUADRON_GATE_DIR, SQUADRON_GATE_TIMEOUT_MS: '5000' }
      );
      await until(
        async () =>
          /waiting for the gate/.test(second!.stderr()) || exists(path.join(dir, 'admitted')),
        'follower attempts admission'
      );
      assert.equal(await exists(path.join(dir, 'admitted')), false);
      await fs.writeFile(path.join(dir, 'go'), '');
      assert.equal(await closedWithin(first.closed), 143);
      for (const pid of [workerPid, wrapperPid])
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      console.log('cleanup worker and wrapper exited:', JSON.stringify(identities));
      assert.equal(await closedWithin(second.closed), 0, second.stderr());
      assert.equal(await exists(path.join(dir, 'admitted')), true);
      assert.equal(await exists(path.join(SQUADRON_GATE_DIR, 'holder')), false);
    } finally {
      await fs.writeFile(path.join(dir, 'go'), '');
      first.child.kill('SIGTERM');
      await closedWithin(first.closed);
      if (second) {
        second.child.kill('SIGTERM');
        await closedWithin(second.closed);
      }
    }
  });

  it(
    'suspends and resumes a held step with its runner',
    { skip: testPlatform() === 'win32' && 'win32: no job-control signals — W4' },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      const first = runner(dir, ['compile=touch started; exec sleep 30'], { SQUADRON_GATE_DIR });
      try {
        await until(() => exists(path.join(dir, 'started')), 'step started');
        const read = async () =>
          JSON.parse(await fs.readFile(path.join(SQUADRON_GATE_DIR, 'holder'), 'utf8')) as {
            pgid?: number;
          };
        await until(async () => (await read()).pgid, 'holder names the step');
        const holder = (await read()) as { pgid: number };
        const state = (pid: number | undefined) =>
          execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
        first.child.kill('SIGTSTP');
        // Both, before continuing: a SIGCONT that beats the runner's own stop is lost.
        await until(
          () => state(holder.pgid).startsWith('T') && state(first.child.pid).startsWith('T'),
          'step stopped with its runner'
        );
        first.child.kill('SIGCONT');
        await until(() => !state(holder.pgid).startsWith('T'), 'step resumed with its runner');
      } finally {
        first.child.kill('SIGCONT');
        first.child.kill('SIGTERM');
        await first.closed;
      }
    }
  );

  it(
    'does not count a reused pid that leads a group as the held step',
    { skip: testPlatform() === 'win32' && 'win32: no process groups — W3.4' },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      const leader = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
      try {
        await fs.writeFile(
          path.join(SQUADRON_GATE_DIR, 'holder'),
          JSON.stringify({
            version: 1,
            pid: 999999,
            gate: SQUADRON_GATE_DIR,
            token: '00000000-0000-4000-8000-000000000001',
            generation: 0,
            source: 'ps-lstart-v1',
            started: 'Thu Jan  1 00:00:00 1970',
            pgid: leader.pid,
            groupStarted: 'Thu Jan  1 00:00:00 1970',
            script: 'check'
          })
        );
        const ran = timed(dir, ['compile=true'], {
          SQUADRON_GATE_DIR,
          SQUADRON_GATE_TIMEOUT_MS: '5000'
        });
        assert.equal(ran.status, 0, ran.stderr);
      } finally {
        leader.kill();
      }
    }
  );

  it('retains an aged legacy lock whose authority is unknown', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const lock = path.join(SQUADRON_GATE_DIR, '.lock');
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner'), '999999-0-fixture');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const ran = timed(dir, ['compile=node -e 0'], {
      SQUADRON_GATE_DIR,
      SQUADRON_GATE_TIMEOUT_MS: '5000'
    });
    assert.equal(ran.status, 75, ran.stderr);
    assert.equal(await fs.readFile(path.join(lock, 'owner'), 'utf8'), '999999-0-fixture');
  });

  /**
   * Counts each attempt to make the gate's lock, failing those `fail(n)` picks
   * with EPERM; `extra` is more preload source, run first.
   */
  function lockAttempts(dir: string, fail: string, count: string, extra = '') {
    return preloadEnv(
      dir,
      `${extra}
const disk = require('node:fs');
const make = disk.mkdirSync;
let n = 0;
disk.mkdirSync = function (target, ...rest) {
  if (String(target).endsWith('.lock') && (${fail})(++n))
    throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' });
  return make.call(this, target, ...rest);
};
process.on('exit', () => disk.writeFileSync(${JSON.stringify(count)}, String(n)));
`
    );
  }

  it(
    'takes and leaves the slot through a lock still pending deletion',
    { skip: testPlatform() !== 'win32' && 'posix: mkdir EPERM is a real denial there' },
    async () => {
      const dir = await repo();
      // win32 refuses to make a directory another run has just removed until its
      // last handle closes: three refusals before the release's lock, then
      // before the claim's and the release's.
      for (const fail of ['(n) => n >= 2 && n <= 4', '(n) => n % 4 !== 0']) {
        const SQUADRON_GATE_DIR = await gate();
        const ran = timed(dir, ['compile=node -e 0'], {
          SQUADRON_GATE_DIR,
          SQUADRON_GATE_TIMEOUT_MS: '5000',
          ...lockAttempts(dir, fail, path.join(dir, 'attempts'))
        });
        assert.equal(ran.status, 0, ran.stderr);
        assert.doesNotMatch(ran.stderr, /could not leave the gate/);
        assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), [], fail);
      }
    }
  );

  it(
    'records the step in a holder another run is reading',
    { skip: testPlatform() !== 'win32' && 'posix: rename replaces a file being read' },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      // win32 refuses to replace a file another run has open until it closes it:
      // three refusals to put the step's record over the holder the claim wrote.
      const ran = timed(dir, ['compile=node -e 0'], {
        SQUADRON_GATE_DIR,
        SQUADRON_GATE_TIMEOUT_MS: '5000',
        ...preloadEnv(
          dir,
          `
const disk = require('node:fs');
const move = disk.renameSync;
let n = 0;
disk.renameSync = function (from, to, ...rest) {
  if (String(to).endsWith('holder') && disk.existsSync(to) && ++n <= 3)
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  return move.call(this, from, to, ...rest);
};
`
        )
      });
      assert.equal(ran.status, 0, ran.stderr);
      assert.doesNotMatch(ran.stderr, /could not record the step/);
      assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), []);
    }
  );

  it(
    'fails a run whose slot stays held after release, and keeps the holder',
    { skip: testPlatform() !== 'win32' && 'posix: mkdir EPERM is a real denial there' },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      await stepScript(dir);
      const ran = timed(dir, ['compile=node step.cjs touch completed'], {
        SQUADRON_GATE_DIR,
        SQUADRON_GATE_TIMEOUT_MS: '5000',
        ...lockAttempts(
          dir,
          `() => disk.existsSync(${JSON.stringify(path.join(dir, 'completed'))})`,
          path.join(dir, 'attempts')
        )
      });
      const holder = path.join(SQUADRON_GATE_DIR, 'holder');
      assert.equal(ran.status, 74, ran.stderr);
      assert.ok(ran.stderr.includes(`gate slot was not released: ${holder}`), ran.stderr);
      assert.match(ran.stderr, /remove that file by hand/);
      assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), ['holder']);
      const run = /^ {2}run: (.+)$/m.exec(ran.stderr)?.[1] ?? '';
      const summary = JSON.parse(await fs.readFile(path.join(run, 'runtime.json'), 'utf8')) as {
        exit: number;
        gate: string;
        gateRelease?: { outcome: string; holder: string };
      };
      assert.equal(summary.exit, 74);
      assert.equal(summary.gate, 'held');
      assert.equal(summary.gateRelease?.outcome, 'failed');
      assert.equal(summary.gateRelease?.holder, holder);
    }
  );

  it('leaves no scratch record behind when writing the step into the holder fails', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    // A partial write, then a full disk, once the claim has written the holder.
    const ran = timed(dir, ['compile=node -e 0'], {
      SQUADRON_GATE_DIR,
      SQUADRON_GATE_TIMEOUT_MS: '5000',
      ...preloadEnv(
        dir,
        `
const disk = require('node:fs');
const path = require('node:path');
const write = disk.writeFileSync;
disk.writeFileSync = function (target, data, ...rest) {
  const file = String(target);
  if (path.basename(file).startsWith('.write-') && disk.existsSync(path.join(path.dirname(file), 'holder'))) {
    write.call(this, target, 'partial');
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  }
  return write.call(this, target, data, ...rest);
};
`
      )
    });
    assert.notEqual(ran.status, 0, ran.stderr);
    assert.match(ran.stderr, /could not start compile: ENOSPC/);
    assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), []);
  });

  /** Gives every gate watch event the null filename some platforms deliver. */
  const UNNAMED = `
const unnamed = require('node:fs');
const watch = unnamed.watch;
unnamed.watch = function (target, ...rest) {
  const listener = rest.find((arg) => typeof arg === 'function');
  const options = rest.filter((arg) => typeof arg !== 'function');
  return watch.call(this, target, ...options, (event) => listener(event, null));
};
`;

  it('does not wake a waiting run for its own lock traffic', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const other = bystander();
    try {
      await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(other.record));
      // Named events, then unnamed ones the run cannot tell from its own.
      for (const [label, extra] of [
        ['named', ''],
        ['unnamed', UNNAMED]
      ] as const) {
        const attempts = path.join(dir, `attempts-${label}`);
        const ran = timed(dir, ['compile=node -e 0'], {
          SQUADRON_GATE_DIR,
          SQUADRON_GATE_TIMEOUT_MS: '3000',
          ...lockAttempts(dir, '() => false', attempts, extra)
        });
        assert.equal(ran.status, 75, ran.stderr);
        // One claim on entry and one per two-second nap, not one per lock it made.
        const made = Number(await fs.readFile(attempts, 'utf8'));
        assert.ok(made >= 1 && made <= 10, `${label}: ${made} lock attempts in three seconds`);
      }
    } finally {
      other.child.kill();
    }
  });

  it('waits for a live holder even when its own ticket is the oldest, and gives up at the cap', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const other = bystander();
    try {
      await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(other.record));
      await stepScript(dir);
      const ran = timed(dir, ['compile=node step.cjs touch reached'], {
        SQUADRON_GATE_DIR,
        SQUADRON_GATE_TIMEOUT_MS: '1500'
      });
      assert.equal(ran.status, 75);
      assert.match(ran.stderr, new RegExp(`gave up waiting .*pid ${other.child.pid}`));
      assert.equal(await exists(path.join(dir, 'reached')), false);
      const [line] = await lines(dir);
      assert.equal(line?.exit, 75);
      assert.deepEqual(line?.steps, []);
      assert.ok((line?.waitedMs ?? 0) >= 1500);
      assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), ['holder']);
    } finally {
      other.child.kill();
    }
  });

  it(
    'retains unconfirmed ownership after a killed runner’s step exits',
    { todo: gateLivenessTodo, timeout: 60_000 },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      await stepScript(dir);
      const first = runner(dir, ['compile=node step.cjs hold started done'], {
        SQUADRON_GATE_DIR
      });
      try {
        await until(() => exists(path.join(dir, 'started')), 'first run started');
        const exited = new Promise((resolve) => first.child.once('exit', resolve));
        first.child.kill('SIGKILL');
        await exited;
        for (const released of [false, true]) {
          if (released) {
            await fs.writeFile(path.join(dir, 'go'), '');
            await closedWithin(first.closed);
            await until(() => exists(path.join(dir, 'done')), 'released step finished');
          }
          const follower = timed(dir, ['compile=node step.cjs touch admitted'], {
            SQUADRON_GATE_DIR,
            SQUADRON_GATE_TIMEOUT_MS: '100'
          });
          assert.equal(follower.status, 75, follower.stderr);
          assert.equal(await exists(path.join(dir, 'admitted')), false);
        }
      } finally {
        // Releases the orphaned step even when the follower never waited.
        await fs.writeFile(path.join(dir, 'go'), '');
        first.child.kill('SIGKILL');
        await closedWithin(first.closed);
        await until(() => exists(path.join(dir, 'done')), 'released step finished');
      }
    }
  );

  it(
    'skips a dead ticket and a reused pid, and clears both',
    { todo: gateLivenessTodo, timeout: 60_000 },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      const other = bystander();
      try {
        await fs.writeFile(
          path.join(SQUADRON_GATE_DIR, '000000000000001-999999'),
          JSON.stringify({
            ...checkpoints.processIdentity(process.pid),
            ...other.record,
            pid: 999999,
            gate: SQUADRON_GATE_DIR,
            token: '00000000-0000-4000-8000-000000000001',
            generation: 0
          })
        );
        await fs.writeFile(
          path.join(SQUADRON_GATE_DIR, `000000000000002-${other.child.pid}`),
          JSON.stringify({
            ...other.record,
            version: 1,
            source: 'ps-lstart-v1',
            started: 'Thu Jan  1 00:00:00 1970',
            gate: SQUADRON_GATE_DIR,
            token: '00000000-0000-4000-8000-000000000002',
            generation: 0
          })
        );
        const ran = timed(dir, ['compile=node -e 0'], {
          SQUADRON_GATE_DIR,
          SQUADRON_GATE_TIMEOUT_MS: '5000'
        });
        assert.equal(ran.status, 0, ran.stderr);
        assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), []);
      } finally {
        other.child.kill();
      }
    }
  );

  it(
    'leaves the line on a signal while waiting, and starts nothing',
    {
      skip:
        testPlatform() === 'win32' && 'win32: SIGTERM is TerminateProcess; no handler runs — W4.2'
    },
    async () => {
      const dir = await repo();
      const SQUADRON_GATE_DIR = await gate();
      const other = bystander();
      try {
        await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(other.record));
        const waiting = runner(dir, ['compile=touch reached'], { SQUADRON_GATE_DIR });
        await until(() => /waiting for the gate/.test(waiting.stderr()), 'runner waiting');
        waiting.child.kill('SIGTERM');
        assert.equal(await waiting.closed, 143);
        assert.equal(await exists(path.join(dir, 'reached')), false);
        assert.deepEqual(await fs.readdir(SQUADRON_GATE_DIR), ['holder']);
        assert.equal((await lines(dir))[0]?.exit, 143);
      } finally {
        other.child.kill();
      }
    }
  );

  it('lets a run its own holder started pass through the line', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    await stepScript(dir);
    const ran = timed(dir, ['compile=node scripts/timed.mjs "compile=node step.cjs touch inner"'], {
      SQUADRON_GATE_DIR,
      SQUADRON_GATE_TIMEOUT_MS: '3000'
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(await exists(path.join(dir, 'inner')), true);
  });

  it('takes no ticket for a script with no compile step', async () => {
    const dir = await repo();
    const SQUADRON_GATE_DIR = await gate();
    const other = bystander();
    try {
      await fs.writeFile(path.join(SQUADRON_GATE_DIR, 'holder'), JSON.stringify(other.record));
      assert.equal(timed(dir, ['a=node -e 0'], { SQUADRON_GATE_DIR }).status, 0);
    } finally {
      other.child.kill();
    }
  });
});

describe('archive timing history', () => {
  it('records explicit archive history with planned and unstarted phases', async () => {
    const dir = await repo(false);
    const ledger = path.join(dir, 'history.jsonl');
    const ran = timed(dir, ['one=exit 0', 'two=exit 3', 'three=echo never'], {
      SQUADRON_TIMINGS_FILE: ledger
    });
    assert.equal(ran.status, 3);
    const line = JSON.parse(await fs.readFile(ledger, 'utf8')) as {
      sha: null;
      plannedSteps: string[];
      notRun: string[];
      steps: { name: string; outcome: string }[];
      run: string;
    };
    made.push(line.run);
    const observation = JSON.parse(await fs.readFile(path.join(line.run, 'runtime.json'), 'utf8'));
    assert.equal(observation.kind, 'timed');
    assert.equal(observation.outcome, 'failed');
    assert.equal(observation.steps[1].outcome, 'failed');
    const evidence = (await fs.readdir(line.run)).filter((name) => name.startsWith('observation-'));
    assert.ok(evidence.length > 0);
    const events = (await fs.readFile(path.join(line.run, evidence[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as Record<string, any>);
    assert.equal(events.at(-1)?.type, 'process-end');
    assert.equal(events.at(-1)?.complete, true);
    assert.ok(events.some((row) => row.name === 'run:complete'));
    assert.equal(line.sha, null);
    assert.deepEqual(line.plannedSteps, ['one', 'two', 'three']);
    assert.deepEqual(line.notRun, ['three']);
    assert.equal(line.steps[1]?.outcome, 'failed');
    assert.match(
      await fs.readFile(path.join(line.run, 'events.jsonl'), 'utf8'),
      /"outcome":"started"/
    );
  });
});
