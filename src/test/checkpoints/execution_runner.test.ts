import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, withoutForceColor } from '../helpers';
import { executionRepo } from '../execution_helpers';
import * as identity from '../../core/identity';
import * as executables from '../../core/platform/executables';

before(async () => {
  await tempHome();
});

describe('bundled execution runner', () => {
  it('awaits the owned record and index cleanup after synchronous close', async () => {
    const execution = await import('../../core/execution');
    const adapters = await import('../../core/adapter');
    const checkpoint = await import('../../core/checkpoint');
    const git = await import('../../core/git');
    const pipe = await import('../../core/session');
    const { cwd } = await executionRepo('shutdown-flush', 'claude');
    const cli = adapters.adapter('claude');
    assert.ok(cli);
    const prepared = await execution.prepareExecution(
      cli.execution,
      path.resolve('dist/execution.js'),
      true
    );
    const line = cli.launch({
      bin: executables.named(path.resolve('out/test/fixtures/fake-cli.js'), process.execPath),
      cwd,
      sessionId: 'shutdown-owner',
      execution: prepared.configuration
    });
    const transport = pipe.childTransport({
      ...line,
      cwd,
      env: { ...line.env, ...prepared.env }
    });
    const session = cli.connect(transport, {
      cwd,
      startedAt: Date.now(),
      sessionId: 'shutdown-owner',
      execution: prepared.runtime
    });
    session.messages?.send('execution-window-smoke-on');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await checkpoint.readExecution(cwd)).coverage.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    session.close();
    const flush = (session as { flush?: () => Promise<void> }).flush;
    assert.ok(flush, 'host shutdown must be able to await local writes');
    await flush.call(session);
    const tree = await git.readTree(cwd);
    assert.ok(tree);
    assert.equal(
      (await fs.readdir(tree.gitDir)).some(
        (name) => name.startsWith('squadron-') && name.endsWith('.index')
      ),
      false
    );
    assert.ok(
      (await checkpoint.readExecution(cwd)).ended.some(
        (end) => end.runtime === prepared.runtime.runtime
      )
    );
    const record = await (await import('../../core/record')).readRecord('shutdown-owner');
    assert.equal(record?.execution?.size, 1);
  });

  it('captures metadata with empty stdout and lets malformed, disabled and failed captures succeed', async () => {
    const execution = await import('../../core/execution');
    const checkpoint = await import('../../core/checkpoint');
    const { cwd, runtime } = await executionRepo('runner-io', 'claude');
    assert.ok(runtime.contextFile);
    await execution.admitExecution(runtime, 'claude', 'runner-owner', 'turn');
    const run = (input: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.resolve('dist/execution.js')], {
          env: withoutForceColor({
            ...process.env,
            [identity.EXECUTION_CONTEXT_ENV]: runtime.contextFile!
          })
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          try {
            assert.equal(code, 0);
            assert.equal(stdout, '');
            assert.equal(stderr, '');
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(input);
      });
    const payload = {
      session_id: 'runner-owner',
      cwd,
      tool_name: 'Bash',
      tool_use_id: 'call',
      prompt_id: 'prompt',
      tool_input: { command: 'secret shell body' }
    };
    await run(JSON.stringify({ ...payload, hook_event_name: 'PreToolUse' }));
    await fs.writeFile(path.join(cwd, 'written.txt'), 'written\n');
    await run(JSON.stringify({ ...payload, hook_event_name: 'PostToolUse' }));
    const store = await checkpoint.readExecution(cwd);
    assert.equal(store.edges.length, 2);
    assert.ok(store.edges.every((edge) => edge.snapshot));
    assert.equal(
      (await fs.readFile(checkpoint.windowsFile(cwd), 'utf8')).includes('secret shell body'),
      false
    );
    await run('{invalid');
    await run('x'.repeat(4 * 1024 * 1024 + 1));
    await run(
      JSON.stringify({ ...payload, cwd: path.dirname(cwd), hook_event_name: 'PreToolUse' })
    );
    runtime.enabled = false;
    await execution.admitExecution(runtime, 'claude', 'runner-owner', 'off');
    await run(
      JSON.stringify({ ...payload, tool_use_id: 'off-call', hook_event_name: 'PreToolUse' })
    );
    assert.equal((await checkpoint.readExecution(cwd)).edges.length, 2);
  });

  it('scrubs an ancestor capture context and admits only the owned launch’s explicit context', async () => {
    const pipe = await import('../../core/session');
    const prior = process.env[identity.EXECUTION_CONTEXT_ENV];
    process.env[identity.EXECUTION_CONTEXT_ENV] = 'ancestor-context';
    try {
      for (const context of [undefined, 'owned-context']) {
        const transport = pipe.childTransport({
          bin: executables.named(process.execPath),
          cwd: process.cwd(),
          args: [
            '-e',
            `console.log(JSON.stringify({ context: process.env.${identity.EXECUTION_CONTEXT_ENV} ?? null }))`
          ],
          ...(context ? { env: { [identity.EXECUTION_CONTEXT_ENV]: context } } : {})
        });
        const value = await new Promise<unknown>((resolve, reject) => {
          transport.onLine(resolve);
          transport.onExit((info) => {
            if (info.code) reject(new Error('environment probe failed'));
          });
        });
        assert.deepEqual(value, { context: context ?? null });
        transport.close();
      }
    } finally {
      if (prior === undefined) delete process.env[identity.EXECUTION_CONTEXT_ENV];
      else process.env[identity.EXECUTION_CONTEXT_ENV] = prior;
    }
  });
});
