import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { commandEnv } from '../fixtures/preload';
import { repoRoot, testPlatform } from '../helpers';

const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GIT_') &&
      !key.startsWith('npm_') &&
      !key.startsWith('SQUADRON_') &&
      key !== 'NODE_TEST_CONTEXT'
  )
);
const pathKey = Object.keys(CLEAN).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
for (const key of Object.keys(CLEAN)) {
  if (key.toUpperCase() === 'PATH' && key !== pathKey) delete CLEAN[key];
}
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(mode = 'pass') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-integrate-'));
  dirs.push(dir);
  const source = path.join(dir, 'source');
  const remote = path.join(dir, 'remote.git');
  const stateFile = path.join(dir, 'backend.json');
  const gateFile = path.join(dir, 'gate.json');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.mkdirSync(path.join(source, '.githooks'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const env: NodeJS.ProcessEnv = {
    ...CLEAN,
    [pathKey]: path.join(dir, 'bin') + path.delimiter + (CLEAN[pathKey] ?? ''),
    INTEGRATE_FIXTURE: stateFile
  };
  env.SQUADRON_GATE_DIR = path.join(dir, 'gate');
  const git = (...args: string[]): string =>
    cp
      .execFileSync('git', args, {
        cwd: source,
        env,
        encoding: 'utf8',
        stdio: 'pipe'
      })
      .trim();
  const run = (number = 1) =>
    cp.spawnSync(process.execPath, ['scripts/integrate.mjs', String(number)], {
      cwd: source,
      env,
      encoding: 'utf8'
    });
  for (const file of [
    'integrate.mjs',
    'integration.mjs',
    'checkpoints.mjs',
    'verification_processes.mjs',
    'observation.mjs',
    'timed.mjs'
  ])
    fs.copyFileSync(path.join(repoRoot(), 'scripts', file), path.join(source, 'scripts', file));
  for (const file of ['pre-push', 'reference-transaction']) {
    fs.copyFileSync(path.join(repoRoot(), '.githooks', file), path.join(source, '.githooks', file));
    fs.chmodSync(path.join(source, '.githooks', file), 0o755);
  }
  fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n.worktrees/\n');
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        check:
          mode === 'timed-hang'
            ? 'node scripts/timed.mjs compile="node fixture-check.cjs"'
            : 'node fixture-check.cjs'
      }
    })
  );
  fs.writeFileSync(
    path.join(source, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } }
    })
  );
  fs.writeFileSync(path.join(source, 'fixture-check.cjs'), CHECK);
  const backendScript = path.join(dir, 'bin', 'gh.cjs');
  fs.writeFileSync(backendScript, BACKEND);
  Object.assign(env, commandEnv(dir, 'gh', backendScript));
  if (mode === 'cleanup-race') {
    fs.appendFileSync(path.join(source, '.githooks', 'pre-push'), '\nnode fixture-race.cjs\n');
    fs.writeFileSync(
      path.join(source, 'fixture-race.cjs'),
      `const fs = require('node:fs');
const cp = require('node:child_process');
const file = process.env.INTEGRATE_FIXTURE;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (s.merged) {
  const git = (...args) => cp.execFileSync('git', ['--git-dir', s.remote, ...args], {encoding:'utf8'}).trim();
  const next = git('commit-tree', git('rev-parse', s.head+'^{tree}'), '-p', s.head, '-m', 'racing work');
  git('update-ref', 'refs/heads/feat/change', next, s.head);
}
`
    );
  }
  git('init', '--quiet', '--initial-branch=staging');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  git('checkout', '--quiet', '-b', 'feat/change');
  fs.writeFileSync(path.join(source, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('commit', '--quiet', '-m', 'feature');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', 'staging');
  fs.writeFileSync(path.join(source, 'staging.txt'), 'staging\n');
  git('add', 'staging.txt');
  git('commit', '--quiet', '-m', 'staging');
  const base = git('rev-parse', 'HEAD');
  git('init', '--quiet', '--bare', remote);
  git('--git-dir', remote, 'config', 'user.name', 'test');
  git('--git-dir', remote, 'config', 'user.email', 'test@example.com');
  git('config', `url.${remote}.insteadOf`, 'https://github.com/test/project.git');
  git('remote', 'add', 'origin', 'https://github.com/test/project.git');
  git('push', '--quiet', 'origin', 'staging', 'feat/change');
  git('config', 'core.hooksPath', '.githooks');
  fs.writeFileSync(stateFile, JSON.stringify({ remote, mode, gateFile, calls: 0 }));
  const evidence = () =>
    JSON.parse(
      fs.readFileSync(path.join(source, '.git', 'squadron-integrations', 'pr-1.json'), 'utf8')
    ) as { status: string; worktree: string; commit?: string };
  const backend = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { calls: number };
  return { source, remote, git, run, env, base, head, evidence, backend, gateFile };
}

const CHECK = `
const fs = require('node:fs');
const cp = require('node:child_process');
const s = JSON.parse(fs.readFileSync(process.env.INTEGRATE_FIXTURE, 'utf8'));
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const old = fs.existsSync(s.gateFile) ? JSON.parse(fs.readFileSync(s.gateFile)) : {calls:0};
fs.writeFileSync(s.gateFile, JSON.stringify({calls:old.calls+1, cwd:process.cwd(),
  args:process.argv.slice(2), parents:git('show','-s','--format=%P','HEAD'),
  feature:fs.readFileSync('feature.txt','utf8'), staging:fs.readFileSync('staging.txt','utf8')}));
if (s.mode === 'fail') process.exit(1);
if (s.mode === 'hold' && old.calls === 0) {
  const deadline = Date.now()+30000;
  while (!fs.existsSync(s.gateFile+'.release') && Date.now()<deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
if (s.mode === 'hang' || s.mode === 'timed-hang') {
  const child = cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(124),30000)'],{stdio:'ignore'});
  fs.writeFileSync(s.gateFile+'.pids',JSON.stringify([process.pid,child.pid]));
  setTimeout(()=>process.exit(124),30000);
}
if (s.mode === 'dirty') fs.writeFileSync('feature.txt','changed');
if (s.mode === 'committed-dirty') {
  fs.writeFileSync('feature.txt','changed');
  git('add','feature.txt');
  git('commit','--quiet','-m','changed during check');
}
if (s.mode === 'drift-base' || s.mode === 'drift-head') {
  const ref = s.mode === 'drift-base' ? 'staging' : 'feat/change';
  const base = git('--git-dir',s.remote,'rev-parse',ref);
  const tree = git('--git-dir',s.remote,'rev-parse',base+'^{tree}');
  const commit = git('--git-dir',s.remote,'commit-tree',tree,'-p',base,'-m','concurrent');
  git('--git-dir',s.remote,'update-ref','refs/heads/'+ref,commit,base);
}
`;

const BACKEND = `
const fs = require('node:fs');
const cp = require('node:child_process');
const file = process.env.INTEGRATE_FIXTURE;
const s = JSON.parse(fs.readFileSync(file,'utf8'));
const args = process.argv.slice(2);
const git = (...a) => cp.execFileSync('git',['--git-dir',s.remote,...a],{encoding:'utf8'}).trim();
const base = git('rev-parse','staging');
const head = s.head ?? git('rev-parse','feat/change');
if (args[0] === 'repo') {
  console.log(s.mode==='other-default'?'upstream/project':'test/project'); process.exit(0);
}
if (args[0] !== 'api') throw new Error('unexpected CLI operation');
if (s.mode==='other-default' && (!args.includes('github.com') || !args.some(a=>a==='repos/test/project/pulls/1'||a==='repos/test/project/pulls/1/merge')))
  throw new Error('wrong API destination');
if (args.includes('PUT')) {
  if (!args.includes('sha='+head) || !args.includes('merge_method=merge'))
    throw new Error('merge requires the expected head and explicit merge method');
  s.calls++;
  if (s.mode === 'rejected-response') {
    fs.writeFileSync(file,JSON.stringify(s));
    process.exit(1);
  }
  const tree = git('merge-tree','--write-tree',base,head).split('\\n')[0];
  let actualBase = base;
  if (s.mode === 'race') {
    actualBase = git('commit-tree',git('rev-parse',base+'^{tree}'),'-p',base,'-m','racing merge');
    git('update-ref','refs/heads/staging',actualBase,base);
  }
  s.merged = git('commit-tree',tree,'-p',actualBase,'-p',head,'-m','Merge pull request #1');
  git('update-ref','refs/heads/staging',s.merged,actualBase);
  s.head = head;
  if (s.mode === 'cleanup-drift') {
    const next = git('commit-tree',tree,'-p',head,'-m','new work');
    git('update-ref','refs/heads/feat/change',next,head);
  }
  if (s.mode === 'cleanup-denied') git('config','receive.denyDeletes','true');
  if (s.mode === 'cleanup-absent') git('update-ref','-d','refs/heads/feat/change',head);
  fs.writeFileSync(file,JSON.stringify(s));
  if (s.mode === 'lost-response') process.exit(1);
  console.log(JSON.stringify({merged:true,sha:s.merged}));
} else {
  console.log(JSON.stringify({state:s.merged?'closed':'open',draft:s.mode==='draft',merged:!!s.merged,
    merge_commit_sha:s.merged,
    base:{ref:'staging',sha:base,repo:{full_name:'test/project'}},
    head:{ref:'feat/change',sha:head,repo:{full_name:'test/project'}}}));
}
`;

describe('local PR integration', () => {
  it('checks the combined result in isolation and records the actual PR merge', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.source, 'uncommitted.txt'), 'keep');
    const ran = f.run();
    assert.equal(ran.status, 0, ran.stderr);
    const gate = JSON.parse(fs.readFileSync(f.gateFile, 'utf8')) as {
      cwd: string;
      args: string[];
      parents: string;
      feature: string;
      staging: string;
    };
    assert.deepEqual(gate.args, ['--base', f.base]);
    assert.equal(gate.parents, `${f.base} ${f.head}`);
    assert.equal(gate.feature, 'feature\n');
    assert.equal(gate.staging, 'staging\n');
    assert.notEqual(gate.cwd, f.source);
    assert.equal(f.git('rev-parse', 'staging'), f.base);
    assert.equal(fs.readFileSync(path.join(f.source, 'uncommitted.txt'), 'utf8'), 'keep');
    assert.equal(f.evidence().status, 'passed');
    assert.equal(f.evidence().commit, f.git('--git-dir', f.remote, 'rev-parse', 'staging'));
    assert.equal(fs.existsSync(gate.cwd), false);
    assert.equal(f.backend().calls, 1);
    assert.equal(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'), '');
    assert.equal(f.git('rev-parse', 'feat/change'), f.head);
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(f.backend().calls, 1);
  });

  it('retains newer work and reports deletion failures without failing a verified merge', () => {
    for (const mode of ['cleanup-drift', 'cleanup-race', 'cleanup-denied', 'cleanup-absent']) {
      const f = fixture(mode);
      const ran = f.run();
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(f.evidence().status, 'passed');
      const remote = f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change');
      if (mode === 'cleanup-absent') {
        assert.equal(remote, '');
        assert.doesNotMatch(ran.stderr, /cleanup incomplete/);
      } else {
        assert.match(ran.stderr, /branch cleanup incomplete/);
        assert.ok(remote);
        assert.equal(remote.startsWith(f.head), mode === 'cleanup-denied');
        if (mode === 'cleanup-denied') {
          f.git('--git-dir', f.remote, 'config', 'receive.denyDeletes', 'false');
          const again = f.run();
          assert.equal(again.status, 0, again.stderr);
          assert.equal(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'), '');
          assert.equal(f.backend().calls, 1);
        }
      }
    }
  });

  it('never requests a merge after a failed check, source mutation, or changed remote input', () => {
    for (const mode of ['fail', 'dirty', 'committed-dirty', 'drift-base', 'drift-head']) {
      const f = fixture(mode);
      const ran = f.run();
      assert.notEqual(ran.status, 0, mode);
      assert.equal(f.backend().calls, 0, mode);
      assert.equal(f.evidence().status, 'failed', mode);
      assert.match(ran.stderr, /failed|changed/);
      assert.ok(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'));
    }
  });

  it('reconciles a lost merge response without another check or merge request', () => {
    const f = fixture('lost-response');
    assert.notEqual(f.run().status, 0);
    assert.equal(f.evidence().status, 'unknown');
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(f.evidence().status, 'passed');
    assert.equal(f.backend().calls, 1);
    const gate = JSON.parse(fs.readFileSync(f.gateFile, 'utf8')) as { calls: number };
    assert.equal(gate.calls, 1);
    assert.equal(fs.existsSync(f.evidence().worktree), false);
    assert.equal(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'), '');
  });

  it('does not retry an uncertain request while the PR still appears open', () => {
    const f = fixture('rejected-response');
    assert.notEqual(f.run().status, 0);
    assert.equal(f.evidence().status, 'unknown');
    const again = f.run();
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /No merge was retried/);
    assert.equal(f.backend().calls, 1);
    assert.ok(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'));
  });

  it('refuses a draft PR before installing dependencies or checking', () => {
    const f = fixture('draft');
    const ran = f.run();
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /non-draft/);
    assert.equal(fs.existsSync(f.gateFile), false);
    assert.equal(f.backend().calls, 0);
  });

  it('reports a raced merge as unverified without rewriting staging', () => {
    const f = fixture('race');
    const ran = f.run();
    assert.notEqual(ran.status, 0);
    assert.equal(f.evidence().status, 'mismatch');
    assert.match(ran.stderr, /different result/);
    assert.notEqual(f.git('--git-dir', f.remote, 'rev-parse', 'staging'), f.base);
    assert.equal(f.backend().calls, 1);
    assert.ok(f.git('ls-remote', '--refs', 'origin', 'refs/heads/feat/change'));
  });

  it('lets feature pushes through without checks and blocks ordinary staging pushes', () => {
    const f = fixture();
    f.git('push', '--quiet', 'origin', 'feat/change:feat/another');
    assert.equal(fs.existsSync(f.gateFile), false);
    const next = f.git(
      'commit-tree',
      f.git('rev-parse', `${f.base}^{tree}`),
      '-p',
      f.base,
      '-m',
      'direct'
    );
    const staging = cp.spawnSync('git', ['push', 'origin', `${next}:staging`], {
      cwd: f.source,
      env: f.env,
      encoding: 'utf8'
    });
    assert.notEqual(staging.status, 0);
    assert.match(staging.stderr, /verified integration/);
    assert.equal(fs.existsSync(f.gateFile), false);
  });

  it('holds repository ownership until the async verification and merge finish', async () => {
    const f = fixture('hold');
    const child = cp.spawn(process.execPath, ['scripts/integrate.mjs', '1'], {
      cwd: f.source,
      env: f.env,
      stdio: 'pipe'
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      const deadline = Date.now() + 45_000;
      while (!fs.existsSync(f.gateFile) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(f.gateFile), output);
      const competing = f.run();
      assert.notEqual(competing.status, 0);
      assert.match(competing.stderr, /busy|ownership/);
      fs.writeFileSync(f.gateFile + '.release', 'release');
      assert.equal(await done, 0, output);
      assert.equal(f.backend().calls, 1);
    } finally {
      fs.writeFileSync(f.gateFile + '.release', 'release');
      if (child.exitCode === null) child.kill();
      await done;
    }
  });
  it(
    'keeps a dead coordinator’s live verification job from admitting another integration',
    {
      skip:
        testPlatform() === 'win32' &&
        'win32: native orphan process-group recovery remains W3.6/W8.3'
    },
    async () => {
      const f = fixture('timed-hang');
      f.env.SQUADRON_GATE_TIMEOUT_MS = '1000';
      const child = cp.spawn(process.execPath, ['scripts/integrate.mjs', '1'], {
        cwd: f.source,
        env: f.env,
        stdio: 'pipe'
      });
      child.stdout.resume();
      child.stderr.resume();
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      let group: number | undefined;
      let phase: number | undefined;
      const active = (pid = group): boolean => {
        if (!pid) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(f.gateFile) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(fs.existsSync(f.gateFile));
        const store = path.join(f.source, '.git', 'squadron-integrations');
        const job = fs.readdirSync(store).find((name) => /^job-[^.]+\.json$/.test(name));
        assert.ok(job);
        group = (
          JSON.parse(fs.readFileSync(path.join(store, job + '.ready.json'), 'utf8')) as {
            wrapper: { pid: number };
          }
        ).wrapper.pid;
        child.kill('SIGKILL');
        await done;
        const competing = f.run();
        assert.notEqual(competing.status, 0);
        assert.match(competing.stderr, /child processes.*ownership/);
        assert.equal(f.backend().calls, 0);
        phase = (
          JSON.parse(fs.readFileSync(path.join(f.env.SQUADRON_GATE_DIR!, 'holder'), 'utf8')) as {
            pgid: number;
          }
        ).pgid;
        process.kill(-group, 'SIGKILL');
        const workerStoppedBy = Date.now() + 2000;
        while (active() && Date.now() < workerStoppedBy)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(active(), false);
        assert.equal(active(phase), true);
        const otherPR = f.run(2);
        assert.notEqual(otherPR.status, 0);
        assert.match(otherPR.stderr, /child processes.*ownership/);
        process.kill(-phase, 'SIGTERM');
        const stoppedBy = Date.now() + 5000;
        while (active(phase) && Date.now() < stoppedBy)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(active(phase), false);
      } finally {
        if (phase && active(phase)) process.kill(-phase, 'SIGKILL');
        if (group && active()) process.kill(-group, 'SIGKILL');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await done;
      }
    }
  );

  it('uses origin even when GitHub CLI defaults and host overrides point elsewhere', () => {
    const f = fixture('other-default');
    f.env.GH_HOST = 'elsewhere.example';
    f.env.GH_REPO = 'elsewhere.example/upstream/project';
    const ran = f.run();
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(f.backend().calls, 1);
  });

  it('isolates all Git operations from inherited repository and index overrides', () => {
    const f = fixture();
    const index = path.join(f.source, '.git', 'external-index');
    fs.copyFileSync(path.join(f.source, '.git', 'index'), index);
    const before = fs.readFileSync(index);
    f.env.GIT_DIR = path.join(f.source, '.git');
    f.env.GIT_WORK_TREE = f.source;
    f.env.GIT_INDEX_FILE = index;
    const ran = f.run();
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(fs.readFileSync(index), before);
    assert.equal(f.git('rev-parse', 'staging'), f.base);
    const gate = JSON.parse(fs.readFileSync(f.gateFile, 'utf8')) as { parents: string };
    assert.equal(gate.parents, `${f.base} ${f.head}`);
  });

  it(
    'stops verification descendants before releasing ownership on SIGHUP',
    {
      skip:
        testPlatform() === 'win32' &&
        'win32: no POSIX SIGHUP handler or process-group cancellation — W4.2/W8.3'
    },
    async () => {
      const f = fixture('timed-hang');
      const child = cp.spawn(process.execPath, ['scripts/integrate.mjs', '1'], {
        cwd: f.source,
        env: f.env,
        stdio: 'pipe'
      });
      child.stdout.resume();
      child.stderr.resume();
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      let pids: number[] = [];
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(f.gateFile + '.pids') && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        pids = JSON.parse(fs.readFileSync(f.gateFile + '.pids', 'utf8')) as number[];
        child.kill('SIGHUP');
        assert.notEqual(await done, 0);
        const stoppedBy = Date.now() + 2000;
        while (pids.some(alive) && Date.now() < stoppedBy)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(
          pids.every((pid) => !alive(pid)),
          'verification descendant leaked'
        );
        assert.equal(
          fs.existsSync(path.join(f.source, '.git', 'squadron-integrations', '.verification-lock')),
          false
        );
        assert.equal(f.backend().calls, 0);
        const reclaimed = cp.spawnSync(
          process.execPath,
          ['scripts/timed.mjs', 'compile=node -e "process.exit(0)"'],
          { cwd: f.source, env: { ...f.env, SQUADRON_GATE_TIMEOUT_MS: '1000' }, encoding: 'utf8' }
        );
        assert.equal(reclaimed.status, 0, reclaimed.stderr);
      } finally {
        for (const pid of pids) {
          if (alive(pid)) process.kill(pid, 'SIGKILL');
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await done;
      }
    }
  );
});
