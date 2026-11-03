import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { resetDir, tempHome } from '../helpers';
import { executionRepo } from '../execution_helpers';
import * as identity from '../../core/identity';

before(async () => {
  await tempHome();
});

const exists = (file: string): Promise<boolean> =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

describe('execution runtime cleanup', () => {
  it('records the live host, and installs the runner its hook command names', async () => {
    const execution = await import('../../core/execution');
    const { runtime } = await executionRepo('cleanup-host-record', 'claude');
    assert.ok(runtime.contextFile);
    const host = await execution.readExecutionHost(path.dirname(runtime.contextFile));
    assert.ok(host);
    assert.equal(host.pid, process.pid);
    assert.equal(
      runtime.runner,
      path.join(
        path.dirname(path.dirname(runtime.contextFile)),
        'runners',
        path.basename(runtime.runner ?? '')
      )
    );
    assert.ok(runtime.runner && (await exists(runtime.runner)));
    assert.equal(await execution.executionHostAlive(host), true);
    assert.equal(
      await execution.executionHostAlive({ ...host, startedAt: host.startedAt - 3_600_000 }),
      false,
      'a reused pid is not the host that wrote the record'
    );
  });

  it('lists an admitted runtime whose host died, and neither a live one nor one never admitted', async () => {
    const execution = await import('../../core/execution');
    const prepare = async (name: string, dead: boolean, admitted: boolean) => {
      const { runtime } = await executionRepo(name, 'claude');
      assert.ok(runtime.contextFile);
      if (admitted) await execution.admitExecution(runtime, 'claude', name, 'turn');
      if (dead) {
        const file = path.join(path.dirname(runtime.contextFile), execution.HOST_FILE);
        const host = JSON.parse(await fs.readFile(file, 'utf8')) as { startedAt: number };
        await fs.writeFile(
          file,
          JSON.stringify({ ...host, startedAt: host.startedAt - 3_600_000 })
        );
      }
      return runtime;
    };
    const live = await prepare('orphan-live', false, true);
    const orphan = await prepare('orphan-dead', true, true);
    const unadmitted = await prepare('orphan-unadmitted', true, false);
    const listed = await execution.orphanedRuntimes();
    assert.deepEqual(
      listed.find((value) => value.runtime === orphan.runtime),
      { runtime: orphan.runtime, contextFile: orphan.contextFile }
    );
    assert.equal(
      listed.some((value) => [live.runtime, unadmitted.runtime].includes(value.runtime)),
      false
    );
  });

  it('keeps the runtime directory on a clean end, and a late hook then captures nothing', async () => {
    const execution = await import('../../core/execution');
    const checkpoint = await import('../../core/checkpoint');
    const { cwd, runtime } = await executionRepo('cleanup-clean-end', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    await execution.admitExecution(runtime, 'claude', 'clean-owner', 'turn');
    const request = {
      cwd,
      owner: identity.conversationKey('claude', 'clean-owner'),
      runtime: runtime.runtime,
      actor: 'clean-owner',
      edge: 'before' as const
    };
    await checkpoint.captureExecution({ ...request, call: 'call' }, contextFile);
    await new checkpoint.TurnCheckpoints('clean-end', contextFile).endExecution(
      runtime.runtime,
      contextFile
    );
    assert.ok(
      (await checkpoint.readExecution(cwd)).ended.some((end) => end.runtime === runtime.runtime)
    );
    assert.equal(await exists(path.dirname(contextFile)), true, 'core/prune.ts removes it');
    // The admission still reads enabled; only the journal's runtime-end stops the hook.
    assert.equal((await execution.readAdmission(contextFile))?.enabled, true);
    assert.equal(
      await hook(contextFile, {
        session_id: 'clean-owner',
        cwd,
        tool_name: 'Bash',
        tool_use_id: 'late-call',
        hook_event_name: 'PreToolUse'
      }),
      0
    );
    assert.equal(
      await checkpoint.captureExecution({ ...request, call: 'raced' }, contextFile),
      undefined
    );
    assert.deepEqual(
      (await checkpoint.readExecution(cwd)).edges.map((edge) => edge.call),
      ['call']
    );
  });

  it('captures nothing from a late hook once the directory is gone', async () => {
    const execution = await import('../../core/execution');
    const checkpoint = await import('../../core/checkpoint');
    const { cwd, runtime } = await executionRepo('cleanup-late-hook', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    await execution.admitExecution(runtime, 'claude', 'late-owner', 'turn');
    await resetDir(path.dirname(contextFile));
    assert.equal(
      await hook(contextFile, {
        session_id: 'late-owner',
        cwd,
        tool_name: 'Bash',
        tool_use_id: 'late-call',
        hook_event_name: 'PreToolUse'
      }),
      0
    );
    // Past admission too: a hook that read it before removal finds no journal.
    const owner = identity.conversationKey('claude', 'late-owner');
    assert.equal(
      await checkpoint.captureExecution(
        {
          cwd,
          owner,
          runtime: runtime.runtime,
          actor: 'late-owner',
          call: 'raced',
          edge: 'before'
        },
        contextFile
      ),
      undefined
    );
    assert.equal((await checkpoint.readExecution(cwd)).edges.length, 0);
    assert.equal(await exists(path.dirname(contextFile)), false, 'nothing recreated it');
  });

  it('leaves a recently dead runtime whose trees lack its end, for activation to end it', async () => {
    const execution = await import('../../core/execution');
    const checkpoint = await import('../../core/checkpoint');
    const prune = await import('../../core/prune');
    const { cwd, runtime } = await executionRepo('cleanup-half-ended', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    const directory = path.dirname(contextFile);
    await execution.admitExecution(runtime, 'claude', 'half-owner', 'turn');
    await checkpoint.captureExecution(
      {
        cwd,
        owner: identity.conversationKey('claude', 'half-owner'),
        runtime: runtime.runtime,
        actor: 'half-owner',
        call: 'call',
        edge: 'before'
      },
      contextFile
    );
    // The host died after the journal's runtime-end and before any tree's.
    await fs.appendFile(
      `${contextFile}.trees`,
      `${JSON.stringify({ kind: 'runtime-end', runtime: runtime.runtime, at: Date.now() })}\n`
    );
    await killHost(directory);

    await prune.pruneExecution();

    assert.equal(await exists(directory), true);
    assert.ok(
      (await execution.orphanedRuntimes()).some((orphan) => orphan.runtime === runtime.runtime)
    );
    await checkpoint.endExecutionRuntime(runtime.runtime, contextFile);
    assert.ok(
      (await checkpoint.readExecution(cwd)).ended.some((end) => end.runtime === runtime.runtime)
    );
    await age(directory, 8);
    await prune.pruneExecution();
    assert.equal(await exists(directory), false, 'a week untouched and dead');
  });

  it('keeps a runner every admission touches', async () => {
    const execution = await import('../../core/execution');
    const prune = await import('../../core/prune');
    const { runtime } = await executionRepo('runner-admitted', 'claude');
    assert.ok(runtime.runner);
    await age(runtime.runner, 30);

    await execution.admitExecution(runtime, 'claude', 'runner-owner', 'turn');

    assert.ok((await fs.stat(runtime.runner)).mtimeMs > Date.now() - prune.DAY_MS);
    await prune.pruneExecution();
    assert.equal(await exists(runtime.runner), true);
  });
});

/** Runs the bundled hook runner against `contextFile`, as the CLI would. */
function hook(contextFile: string, payload: unknown): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [path.resolve('dist/execution.js')], {
      env: { ...process.env, [identity.EXECUTION_CONTEXT_ENV]: contextFile }
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Moves the host record an hour back: this pid, reused by a host that died. */
async function killHost(directory: string): Promise<void> {
  const file = path.join(directory, 'host.json');
  const host = JSON.parse(await fs.readFile(file, 'utf8')) as { startedAt: number };
  await fs.writeFile(file, JSON.stringify({ ...host, startedAt: host.startedAt - 3_600_000 }));
}

/** Backdates a file, or a directory and everything under it, by `days`. */
async function age(target: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const inside = (await fs.stat(target)).isDirectory()
    ? await fs.readdir(target, { recursive: true })
    : [];
  for (const name of inside) await fs.utimes(path.join(target, name), when, when);
  await fs.utimes(target, when, when);
}
