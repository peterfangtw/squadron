import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { needsFileSymlinks, tempHome, testPlatform } from '../helpers';
import { pauseSource, preloadEnv } from '../fixtures/preload';
import { executionRepo } from '../execution_helpers';
import type { ExecutionBoundary, ExecutionRequest } from '../../core/checkpoint';

let checkpoint: typeof import('../../core/checkpoint');
let git: typeof import('../../core/git');
before(async () => {
  await tempHome();
  checkpoint = await import('../../core/checkpoint');
  git = await import('../../core/git');
});

const clean = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function index(directory: string, key: string): string {
  return path.join(
    directory,
    `squadron-${crypto.createHash('sha256').update(key).digest('hex')}.index`
  );
}

async function setup(name: string): Promise<{
  cwd: string;
  directory: string;
  context: string;
  request: ExecutionRequest;
  master: string;
}> {
  const { cwd, runtime } = await executionRepo(name, 'claude');
  const tree = await git.readTree(cwd);
  assert.ok(tree && runtime.contextFile);
  const request: ExecutionRequest = {
    cwd,
    owner: 'claude:cost-owner',
    runtime: runtime.runtime,
    actor: 'cost-owner',
    call: 'first',
    edge: 'before'
  };
  return {
    cwd,
    directory: tree.gitDir,
    context: runtime.contextFile,
    request,
    master: index(
      tree.gitDir,
      JSON.stringify(['execution-master', request.owner, request.runtime, tree.treeRoot])
    )
  };
}

describe('execution index cache', () => {
  it('isolates rolled owners and runtimes, then sweeps an orphan master and interrupted temporary', async () => {
    const value = await setup('cost-identities');
    const execution = await import('../../core/execution');
    await fs.writeFile(path.join(value.cwd, 'file'), 'content');
    await checkpoint.captureExecution(value.request, value.context);
    await checkpoint.captureExecution({ ...value.request, edge: 'after' }, value.context);
    const rolled = { ...value.request, owner: 'rolled-owner', call: 'rolled' };
    await checkpoint.captureExecution(rolled, value.context);
    await checkpoint.captureExecution({ ...rolled, edge: 'after' }, value.context);
    const other = await executionRepo('cost-other-runtime', 'claude');
    assert.ok(other.runtime.contextFile);
    await execution.admitExecution(other.runtime, 'claude', 'other-owner', 'turn');
    const request = { ...value.request, runtime: other.runtime.runtime };
    await checkpoint.captureExecution(request, other.runtime.contextFile);
    await checkpoint.captureExecution({ ...request, edge: 'after' }, other.runtime.contextFile);
    const master = index(
      value.directory,
      JSON.stringify(['execution-master', request.owner, request.runtime, value.cwd])
    );
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
    assert.ok(await fs.stat(master));
    assert.equal(
      (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
      1
    );
    assert.ok(
      (
        await checkpoint.captureExecution(
          { ...request, call: 'still-live' },
          other.runtime.contextFile
        )
      )?.snapshot
    );
    await fs.writeFile(`${master}.interrupted.next`, 'interrupted');
    const hostFile = path.join(path.dirname(other.runtime.contextFile), 'host.json');
    const host = JSON.parse(await fs.readFile(hostFile, 'utf8')) as { startedAt: number };
    await fs.writeFile(
      hostFile,
      JSON.stringify({ ...host, startedAt: host.startedAt - 3_600_000 })
    );
    const orphan = (await execution.orphanedRuntimes()).find(
      (row) => row.runtime === other.runtime.runtime
    );
    assert.ok(orphan);
    await checkpoint.endExecutionRuntime(orphan.runtime, orphan.contextFile);
    assert.equal(
      (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
      0
    );
  });

  it('discards a hook paused between Git commands when runtime shutdown removes its index', async () => {
    const value = await setup('cost-git-shutdown');
    const execution = await import('../../core/execution');
    const identity = await import('../../core/identity');
    await execution.admitExecution(
      { runtime: value.request.runtime, enabled: true, contextFile: value.context },
      'claude',
      value.request.actor,
      'turn'
    );
    await fs.writeFile(path.join(value.cwd, 'file'), 'content');
    const bin = path.join(value.cwd, '.git', 'probe-bin');
    await fs.mkdir(bin);
    const ready = path.join(bin, 'ready'),
      release = path.join(bin, 'release');
    const env = preloadEnv(
      bin,
      pauseSource(ready, release) +
        `
const cp = require('node:child_process');
const run = cp.execFile;
cp.execFile = function(file, args, ...rest) {
  if (file === 'git' && args[0] === 'write-tree') pause();
  return run.call(this, file, args, ...rest);
};
`
    );
    const child = cp.spawn(process.execPath, [path.resolve('dist/execution.js')], {
      env: {
        ...clean(),
        ...env,
        [identity.EXECUTION_CONTEXT_ENV]: value.context
      }
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: value.request.actor,
        cwd: value.cwd,
        tool_name: 'Bash',
        tool_use_id: value.request.call
      })
    );
    try {
      const deadline = Date.now() + 5000;
      while (!(await fs.stat(ready).catch(() => undefined)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(await fs.stat(ready));
      await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
      await fs.writeFile(release, 'continue');
      assert.equal(await closed, 0);
      assert.deepEqual((await checkpoint.readExecution(value.cwd)).edges, []);
      assert.equal(
        (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
        0
      );
    } finally {
      child.kill();
      await fs.writeFile(release, 'continue');
      await closed;
    }
  });

  it('recovers a corrupt cache without stealing an active call lock', async () => {
    const value = await setup('cost-corrupt');
    await fs.writeFile(path.join(value.cwd, 'file'), 'content');
    await fs.writeFile(value.master, 'corrupt');
    const recovered = await checkpoint.captureExecution(value.request, value.context);
    assert.ok(recovered?.snapshot);
    await checkpoint.captureExecution({ ...value.request, edge: 'after' }, value.context);
    const locked = { ...value.request, call: 'locked' };
    const privateIndex = index(
      value.directory,
      checkpoint.executionKey({ ...locked, tree: value.cwd })
    );
    await fs.writeFile(`${privateIndex}.lock`, 'active');
    await fs.writeFile(privateIndex, 'owned by active Git');
    await checkpoint.forgetIndex(
      (await git.readTree(value.cwd))!,
      checkpoint.executionKey({ ...locked, tree: value.cwd })
    );
    assert.equal(await fs.readFile(privateIndex, 'utf8'), 'owned by active Git');
    const failed = await checkpoint.captureExecution(locked, value.context);
    assert.equal(failed?.snapshot, undefined);
    assert.equal(await fs.readFile(`${privateIndex}.lock`, 'utf8'), 'active');
    await fs.rm(`${privateIndex}.lock`);
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
    assert.equal(
      (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
      0
    );
  });

  it('uses separate call indexes and complete master generations under parallel publishers', async () => {
    const value = await setup('cost-parallel');
    await fs.writeFile(path.join(value.cwd, 'file'), 'initial');
    const calls = Array.from({ length: 8 }, (_, i) => ({
      ...value.request,
      actor: `actor-${i}`,
      call: `call-${i}`
    }));
    const before = await Promise.all(
      calls.map((call) => checkpoint.captureExecution(call, value.context))
    );
    assert.ok(before.every((edge) => edge?.snapshot));
    const userIndex = await fs.readFile(path.join(value.directory, 'index')).catch(() => undefined);
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.cwd, env: clean() });
    await fs.writeFile(path.join(value.cwd, 'file'), 'changed');
    const after = await Promise.all(
      calls.map(
        (call) =>
          new Promise<ExecutionBoundary>((resolve, reject) => {
            cp.execFile(
              process.execPath,
              [
                '-e',
                `require(${JSON.stringify(path.resolve('out/core/checkpoint.js'))}).captureExecution(JSON.parse(process.argv[1]),process.argv[2]).then(edge=>process.stdout.write(JSON.stringify(edge)))`,
                JSON.stringify({ ...call, edge: 'after' }),
                value.context
              ],
              { env: clean() },
              (error, stdout) => {
                if (error) reject(new Error(error.message));
                else resolve(JSON.parse(stdout) as ExecutionBoundary);
              }
            );
          })
      )
    );
    assert.ok(after.every((edge) => edge?.snapshot));
    assert.equal(new Set(after.map((edge) => edge?.snapshot?.tree)).size, 1);
    const next = await checkpoint.captureExecution(
      { ...value.request, call: 'next' },
      value.context
    );
    assert.equal(next?.snapshot?.tree, after[0]?.snapshot?.tree);
    assert.deepEqual(
      await fs.readFile(path.join(value.directory, 'index')).catch(() => undefined),
      userIndex
    );
    assert.deepEqual(
      cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.cwd, env: clean() }),
      head
    );
    await fs.writeFile(`${value.master}.dead.next`, 'interrupted publication');
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
    assert.equal(
      (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
      0
    );
  });

  for (const phase of ['seed', 'publish'] as const) {
    it(`removes a late ${phase} after runtime shutdown`, async (t) => {
      const value = await setup(`cost-shutdown-${phase}`);
      await fs.writeFile(path.join(value.cwd, 'file'), 'content');
      await checkpoint.captureExecution(value.request, value.context);
      await checkpoint.captureExecution({ ...value.request, edge: 'after' }, value.context);
      const next = { ...value.request, call: 'raced' };
      if (phase === 'publish') await checkpoint.captureExecution(next, value.context);
      const write = fs.writeFile;
      let intercepted = false;
      t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
        if (!intercepted && typeof args[0] === 'string' && args[0].endsWith('.next')) {
          intercepted = true;
          await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
        }
        return write(...args);
      });
      await checkpoint.captureExecution(
        { ...next, edge: phase === 'seed' ? 'before' : 'after' },
        value.context
      );
      assert.equal(intercepted, true);
      assert.equal(
        (await fs.readdir(value.directory)).filter((name) => name.startsWith('squadron-')).length,
        0
      );
    });
  }

  it('seeds each new private call index with the previous successful after stat cache', async (t) => {
    const value = await setup('cost-reuse');
    await fs.writeFile(path.join(value.cwd, 'unchanged'), 'old\n');
    await checkpoint.captureExecution(value.request, value.context);
    const after = await checkpoint.captureExecution(
      { ...value.request, edge: 'after' },
      value.context
    );
    assert.ok(after?.snapshot);
    const bytes = await fs.readFile(value.master);
    const next = { ...value.request, call: 'second' };
    const privateIndex = index(
      value.directory,
      checkpoint.executionKey({ ...next, tree: value.cwd })
    );
    const link = fs.link;
    let seeded = false;
    t.mock.method(fs, 'link', async (...args: Parameters<typeof link>) => {
      await link(...args);
      if (args[1] === privateIndex) {
        assert.deepEqual(await fs.readFile(privateIndex), bytes);
        assert.ok((await fs.stat(privateIndex)).mtimeMs <= (await fs.stat(value.master)).mtimeMs);
        seeded = true;
      }
    });
    const before = await checkpoint.captureExecution(next, value.context);
    assert.ok(before?.snapshot);
    assert.equal(seeded, true, 'a new call must start with the warmed stat entries');
    assert.equal(before.snapshot.tree, after.snapshot.tree);
    assert.notEqual(privateIndex, value.master);
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
  });

  it(
    'matches a fresh tree after stale cached edits, deletion, modes, symlinks and checkout',
    { skip: needsFileSymlinks() },
    async () => {
      const value = await setup('cost-stale');
      const tree = await git.readTree(value.cwd);
      assert.ok(tree);
      const file = path.join(value.cwd, 'file');
      await fs.writeFile(file, 'aaaa\n');
      await fs.writeFile(path.join(value.cwd, 'deleted'), 'delete\n');
      await fs.writeFile(path.join(value.cwd, '.gitignore'), 'ignored\n');
      cp.execFileSync('git', ['add', '--', 'file', 'deleted', '.gitignore'], {
        cwd: value.cwd,
        env: clean()
      });
      cp.execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'files'],
        { cwd: value.cwd, env: clean() }
      );
      await checkpoint.captureExecution(value.request, value.context);
      await checkpoint.captureExecution({ ...value.request, edge: 'after' }, value.context);
      const firstMaster = await fs.readFile(value.master);
      const firstCutoff = (await fs.stat(value.master)).mtime;
      const stamp = await fs.stat(file);
      await fs.writeFile(file, 'bbbb\n');
      await fs.utimes(file, stamp.atime, stamp.mtime);
      await fs.rm(path.join(value.cwd, 'deleted'));
      await fs.writeFile(path.join(value.cwd, 'new'), 'new\n');
      await fs.rename(path.join(value.cwd, 'new'), path.join(value.cwd, 'renamed'));
      await fs.chmod(path.join(value.cwd, 'renamed'), 0o755);
      await fs.symlink('file', path.join(value.cwd, 'link'));
      await fs.writeFile(path.join(value.cwd, 'ignored'), 'ignored\n');
      for (const call of ['second', 'third']) {
        if (call === 'third') {
          // Simulate an older publisher winning after a newer one.
          await fs.writeFile(value.master, firstMaster);
          await fs.utimes(value.master, firstCutoff, firstCutoff);
          await fs.writeFile(file, 'cccc\n');
        }
        const before = await checkpoint.captureExecution({ ...value.request, call }, value.context);
        const fresh = await checkpoint.capture(tree, `fresh-${call}`);
        assert.ok(before?.snapshot && fresh);
        assert.equal(before.snapshot.tree, fresh.tree);
        await checkpoint.captureExecution({ ...value.request, call, edge: 'after' }, value.context);
        await checkpoint.forgetIndex(tree, `fresh-${call}`);
      }
      cp.execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'changed'],
        { cwd: value.cwd, env: clean() }
      );
      cp.execFileSync('git', ['checkout', '--detach', 'HEAD~1'], { cwd: value.cwd, env: clean() });
      const switched = await checkpoint.captureExecution(
        { ...value.request, call: 'checkout' },
        value.context
      );
      const fresh = await checkpoint.capture(tree, 'fresh-checkout');
      assert.equal(switched?.snapshot?.tree, fresh?.tree);
      await checkpoint.forgetIndex(tree, 'fresh-checkout');
      await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
    }
  );

  it('preserves racy-clean protection through both copy legs', async (t) => {
    const value = await setup('cost-racy');
    const tree = await git.readTree(value.cwd);
    assert.ok(tree);
    const file = path.join(value.cwd, 'file');
    await fs.writeFile(file, 'aaaa\n');
    const shot = await checkpoint.capture(tree, 'racy-source');
    assert.ok(shot);
    await fs.writeFile(file, 'bbbb\n');
    const stat = await fs.stat(file, { bigint: true });
    const source = index(value.directory, 'racy-source');
    const bytes = await fs.readFile(source);
    assert.equal(bytes.readUInt32BE(4), 2);
    // A valid synthetic racy entry: matching stat/size, old blob. No weak stat config.
    for (const [offset, ns] of [
      // Git for Windows' `lstat` reports CreationTime as `st_ctime`; Node's
      // `ctimeNs` there is NTFS ChangeTime, which git never reads.
      [12, testPlatform() === 'win32' ? stat.birthtimeNs : stat.ctimeNs],
      [20, stat.mtimeNs]
    ] as const) {
      bytes.writeUInt32BE(Number(ns / 1_000_000_000n), offset);
      bytes.writeUInt32BE(Number(ns % 1_000_000_000n), offset + 4);
    }
    bytes.writeUInt32BE(Number(stat.size), 48);
    crypto
      .createHash('sha1')
      .update(bytes.subarray(0, -20))
      .digest()
      .copy(bytes, bytes.length - 20);
    await fs.writeFile(value.master, bytes);
    await fs.utimes(
      value.master,
      Number(stat.mtimeNs / 1_000_000_000n),
      Number(stat.mtimeNs / 1_000_000_000n)
    );
    const naive = index(value.directory, 'naive');
    await fs.copyFile(value.master, naive);
    await fs.utimes(
      naive,
      Number(stat.mtimeNs / 1_000_000_000n) + 2,
      Number(stat.mtimeNs / 1_000_000_000n) + 2
    );
    const old = await checkpoint.capture(tree, 'naive');
    const fresh = await checkpoint.capture(tree, 'racy-fresh');
    assert.equal(old?.tree, shot.tree, 'control must reproduce the unsafe-copy old blob');
    assert.notEqual(fresh?.tree, shot.tree);
    const safe = await checkpoint.captureExecution(value.request, value.context);
    assert.equal(safe?.snapshot?.tree, fresh?.tree);
    const privateIndex = index(
      value.directory,
      checkpoint.executionKey({ ...value.request, tree: value.cwd })
    );
    const rename = fs.rename;
    let published = false;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
      if (args[1] === value.master) {
        assert.deepEqual(await fs.readFile(args[0]), await fs.readFile(privateIndex));
        assert.ok((await fs.stat(args[0])).mtimeMs <= (await fs.stat(privateIndex)).mtimeMs);
        published = true;
      }
      return rename(...args);
    });
    const after = await checkpoint.captureExecution(
      { ...value.request, edge: 'after' },
      value.context
    );
    assert.ok(after?.snapshot);
    assert.equal(after?.snapshot?.tree, fresh?.tree);
    assert.equal(published, true);
    assert.ok((await fs.stat(value.master)).mtimeMs <= after.snapshot.at);
    for (const key of ['racy-source', 'naive', 'racy-fresh'])
      await checkpoint.forgetIndex(tree, key);
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
  });
});

describe('execution hook registration', () => {
  for (const brand of ['claude', 'codex', 'grok'] as const) {
    it(`${brand} registers writer matchers and unrestricted ancestry hooks`, async () => {
      const value = await setup(`cost-config-${brand}`);
      const native = (await import(
        `../../core/${brand}/execution`
      )) as typeof import('../../core/claude/execution');
      const target = path.join(value.cwd, 'config');
      await fs.mkdir(target);
      const configuration = await native.integration.configure('record-call', target);
      const hooks =
        brand === 'grok'
          ? JSON.parse(
              await fs.readFile(path.join(String(configuration), 'hooks/hooks.json'), 'utf8')
            ).hooks
          : brand === 'codex'
            ? Object.fromEntries(
                (configuration as string[])
                  .filter((_, i) => i % 2 === 1)
                  .map((arg) => [
                    arg.match(/^hooks\.(\w+)/)?.[1],
                    [{ matcher: arg.match(/matcher="([^"]+)"/)?.[1] }]
                  ])
              )
            : (configuration as { hooks: Record<string, { matcher?: string }[]> }).hooks;
      const writers =
        brand === 'claude'
          ? ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']
          : brand === 'codex'
            ? ['Bash', 'apply_patch']
            : [
                'run_terminal_command',
                'write',
                'edit',
                'edit_file',
                'apply_patch',
                'search_replace'
              ];
      const reads =
        brand === 'claude'
          ? ['Read', 'Grep', 'Glob', 'ToolSearch', 'Agent']
          : brand === 'codex'
            ? ['collaborationspawn_agent', 'collaborationwait_agent', 'update_plan']
            : [
                'read_file',
                'grep',
                'glob',
                'list_dir',
                'spawn_subagent',
                'get_command_or_subagent_output'
              ];
      for (const event of [
        'PreToolUse',
        'PostToolUse',
        ...(brand === 'claude' ? ['PostToolUseFailure'] : [])
      ]) {
        const groups = hooks[event] as { matcher?: string }[];
        assert.equal(groups.length, 1);
        const matches = (name: string): boolean =>
          !groups[0]?.matcher || new RegExp(groups[0].matcher).test(name);
        assert.ok(writers.every(matches));
        assert.ok(
          reads.every((name) => !matches(name)),
          `${event} must reject known reads/delegates before spawning`
        );
        assert.equal(matches('not-a-writer'), false);
      }
      if (brand !== 'codex') {
        for (const event of ['SubagentStart', 'SubagentStop'])
          assert.equal(hooks[event][0].matcher, undefined);
      }
    });
  }
});

describe('skipped read attribution', () => {
  it('retains the floor without making skipped reads uncover or overlap a writer', async () => {
    const value = await setup('cost-read-attribution');
    const before = await checkpoint.captureExecution(value.request, value.context);
    await fs.writeFile(path.join(value.cwd, 'written'), 'writer');
    const after = await checkpoint.captureExecution(
      { ...value.request, edge: 'after' },
      value.context
    );
    assert.ok(before?.snapshot && after?.snapshot);
    await fs.writeFile(path.join(value.cwd, 'editor-gap'), 'editor');
    const tree = await git.readTree(value.cwd);
    assert.ok(tree);
    const end = await checkpoint.capture(tree, 'turn-floor');
    assert.ok(end);
    const floor = {
      tree: value.cwd,
      from: before.snapshot,
      to: end,
      changes: {
        files: [path.join(value.cwd, 'written'), path.join(value.cwd, 'editor-gap')],
        sizes: {}
      }
    };
    const turn = {
      owner: value.request.owner,
      runtime: value.request.runtime,
      turn: 'turn',
      tree: value.cwd,
      start: before.start,
      end: end.at,
      observed: true,
      calls: [
        {
          actor: value.request.actor,
          call: 'read-before',
          eligibility: 'read' as const,
          settled: true
        },
        {
          actor: value.request.actor,
          call: value.request.call,
          eligibility: 'write' as const,
          settled: true
        },
        {
          actor: value.request.actor,
          call: 'read-after',
          eligibility: 'read' as const,
          settled: true
        }
      ],
      floor
    };
    const coverage = await checkpoint.selectExecution(turn, [before, after]);
    assert.equal(coverage.source, 'execution');
    assert.deepEqual(
      coverage.windows.flatMap((window) => window.changes.files),
      [path.join(value.cwd, 'written')]
    );
    assert.equal(coverage.floor, floor);
    await checkpoint.appendExecution(value.cwd, coverage);
    const store = await checkpoint.readExecution(value.cwd);
    assert.equal(
      store.windows.some((window) => window.uncertain),
      false
    );
    assert.equal(
      store.windows.some((window) => window.paths.includes(path.join(value.cwd, 'editor-gap'))),
      false
    );
    const readOnly = await checkpoint.selectExecution({ ...turn, calls: [turn.calls[0]!] }, []);
    assert.equal(readOnly.source, 'execution');
    assert.deepEqual(readOnly.windows, []);
    assert.equal(readOnly.floor, floor);
    for (const incomplete of [
      { ...turn, observed: false },
      {
        ...turn,
        calls: [
          {
            actor: value.request.actor,
            call: 'unknown',
            eligibility: 'unknown' as const,
            settled: true
          }
        ]
      }
    ])
      assert.equal((await checkpoint.selectExecution(incomplete, [before, after])).source, 'turn');
    assert.equal((await checkpoint.selectExecution(turn, [before])).source, 'turn');
    await checkpoint.forgetIndex(tree, 'turn-floor');
    await checkpoint.endExecutionRuntime(value.request.runtime, value.context);
  });
});
