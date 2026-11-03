import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, testPlatform } from '../helpers';
import type { ExecutionAdmission, ExecutionChild } from '../../core/execution';
import type { ExecutionBoundary, ExecutionStore } from '../../core/checkpoint';
import * as executables from '../../core/platform/executables';

let home: string;
let execution: typeof import('../../core/execution');
let adapters: typeof import('../../core/adapter');
before(async () => {
  home = await tempHome();
  execution = await import('../../core/execution');
  adapters = await import('../../core/adapter');
});

describe('scoped execution integration', () => {
  it('bounds Grok background uncertainty from the native task completion without output polling', async () => {
    const grok = await import('../../core/grok/execution');
    const checkpoint = await import('../../core/checkpoint');
    const fixture = JSON.parse(
      await fs.readFile(
        path.resolve('src/test/fixtures/execution-hooks-2026-10-04/grok.json'),
        'utf8'
      )
    ) as {
      cases: {
        case: string;
        wire: {
          message: {
            method?: string;
            params?: {
              sessionId: string;
              update: {
                sessionUpdate: string;
                task_snapshot: {
                  task_id: string;
                  owner_session_id: string;
                  completed: boolean;
                };
              };
            };
          };
        }[];
      }[];
    };
    const event = fixture.cases
      .find((value) => value.case === 'background')
      ?.wire.find((value) => value.message.method === '_x.ai/task_completed')?.message;
    assert.ok(event?.params && event.method);
    const { sessionId, update } = event.params;
    const task = update.task_snapshot.task_id;
    assert.deepEqual(grok.completedTask(event.method, event.params), { actor: sessionId, task });
    assert.equal(
      grok.completedTask(event.method, { ...event.params, sessionId: 'unrelated-peer' }),
      undefined,
      'the reporter must own the snapshot'
    );
    for (const snapshot of [
      { ...update.task_snapshot, completed: false },
      { ...update.task_snapshot, owner_session_id: 'unrelated-peer' }
    ])
      assert.equal(
        grok.completedTask(event.method, {
          ...event.params,
          update: { ...update, task_snapshot: snapshot }
        }),
        undefined
      );
    assert.deepEqual(
      grok.completedTask('session/update', {
        sessionId,
        update: {
          rawOutput: { type: 'TaskOutput', Result: { task_id: task, status: 'completed' } }
        }
      }),
      { actor: sessionId, task }
    );
    const tree = path.join(home, 'grok-task-completion');
    const at = Date.now();
    const edge: ExecutionBoundary = {
      version: 1,
      kind: 'execution',
      tree,
      owner: adapters.conversationKey('grok', sessionId),
      runtime: 'task-runtime',
      actor: sessionId,
      call: 'pending-call',
      edge: 'before',
      start: at - 100,
      end: at - 90
    };
    await checkpoint.appendExecution(tree, edge);
    await checkpoint.appendExecution(tree, {
      ...edge,
      edge: 'after',
      start: at - 80,
      end: at - 70,
      pending: true,
      task
    });
    const peer = {
      tree,
      from: { tree: 'a'.repeat(40), head: 'c'.repeat(40), at: at + 100 },
      to: { tree: 'b'.repeat(40), head: 'c'.repeat(40), at: at + 200 },
      changes: { files: [path.join(tree, 'peer.txt')], sizes: {} }
    };
    assert.deepEqual(
      checkpoint.attribute(peer, 'peer', await checkpoint.readWindows(tree)).files,
      []
    );
    await checkpoint.endPendingExecution(tree, edge.owner, edge.runtime, task);
    const store = await checkpoint.readExecution(tree);
    const endedAt = store.callEnds[0]?.at;
    assert.equal(typeof endedAt, 'number');
    assert.ok(endedAt);
    peer.from.at = endedAt + 100;
    peer.to.at = endedAt + 200;
    assert.deepEqual(
      checkpoint.attribute(peer, 'peer', await checkpoint.readWindows(tree)).files,
      peer.changes.files
    );
    assert.equal(store.callEnds.length, 1);
    assert.equal(store.coverage.length, 0);
  });

  it("ends a proven descendant's background call from its ancestor's completion, in either order", async () => {
    const checkpoint = await import('../../core/checkpoint');
    const { executionRepo } = await import('../execution_helpers');
    const { cwd, runtime } = await executionRepo('descendant-task-end', 'claude');
    const contextFile = runtime.contextFile;
    assert.ok(contextFile);
    const owner = adapters.conversationKey('claude', 'root');
    for (const child of [
      { actor: 'agent', parent: 'root', turn: 'turn' },
      { actor: 'grandchild', parent: 'agent', turn: 'turn' }
    ])
      await execution.appendExecutionChild(contextFile, child);
    const request = { cwd, owner, runtime: runtime.runtime };
    const pending = async (actor: string, call: string, task: string) => {
      await checkpoint.captureExecution({ ...request, actor, call, edge: 'before' }, contextFile);
      return checkpoint.captureExecution(
        { ...request, actor, call, edge: 'after', pending: true, task },
        contextFile
      );
    };
    // Published first: the stream's task_notification carries the root session id.
    await pending('agent', 'child-call', 'child-task');
    await pending('grandchild', 'grandchild-call', 'grandchild-task');
    await pending('unproven', 'unproven-call', 'unproven-task');
    for (const task of ['child-task', 'grandchild-task', 'unproven-task'])
      await checkpoint.endPendingExecution(cwd, owner, runtime.runtime, task, {
        contextFile,
        actor: 'root'
      });
    const ended = async () =>
      new Set((await checkpoint.readExecution(cwd)).callEnds.map((end) => end.call));
    assert.deepEqual(await ended(), new Set(['child-call', 'grandchild-call']));
    // Receipt first: the child's later post capture joins the ancestor's ending.
    await checkpoint.endPendingExecution(cwd, owner, runtime.runtime, 'late-task', {
      contextFile,
      actor: 'root'
    });
    await pending('agent', 'late-call', 'late-task');
    assert.ok((await ended()).has('late-call'));
    // A child's own report covers the child and never its ancestor.
    await pending('root', 'root-call', 'shared-task');
    await pending('agent', 'agent-call', 'shared-task');
    await checkpoint.endPendingExecution(cwd, owner, runtime.runtime, 'shared-task', {
      contextFile,
      actor: 'agent'
    });
    const after = await ended();
    assert.ok(after.has('agent-call'));
    assert.equal(after.has('root-call'), false);
    assert.equal(after.has('unproven-call'), false);
    await new checkpoint.TurnCheckpoints('cleanup').endExecution(runtime.runtime, contextFile);
  });

  it('skips an admission written by an unknown future brand', async () => {
    const file = path.join(home, 'future-admission.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        runtime: 'r',
        brand: 'future',
        enabled: true,
        sessionId: 'sid',
        owner: 'future\0sid',
        turn: 'turn'
      })
    );
    assert.equal(await execution.readAdmission(file), undefined);
  });

  it('serializes concurrent admission publications for one runtime', async () => {
    const runtime = {
      runtime: 'concurrent-admission',
      enabled: true,
      contextFile: path.join(home, 'concurrent-admission.json')
    };
    const accepted = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        execution.admitExecution(runtime, 'claude', 'owner', `turn-${i}`)
      )
    );
    assert.ok(accepted.every(Boolean));
    assert.equal((await execution.readAdmission(runtime.contextFile))?.turn, 'turn-23');
  });

  it('keeps the latest turn and disables admission when a toggle overlaps a send', async () => {
    const runtime = {
      runtime: 'toggle-admission',
      enabled: true,
      contextFile: path.join(home, 'toggle-admission.json')
    };
    await execution.admitExecution(runtime, 'claude', 'old-owner', 'old-turn');
    await Promise.all([
      execution.admitExecution(runtime, 'claude', 'new-owner', 'new-turn'),
      execution.setExecutionEnabled(runtime, false)
    ]);
    const current = await execution.readAdmission(runtime.contextFile);
    assert.equal(current?.enabled, false);
    assert.equal(current?.sessionId, 'new-owner');
    assert.equal(current?.turn, 'new-turn');
    await execution.setExecutionEnabled(runtime, true);
    assert.equal((await execution.readAdmission(runtime.contextFile))?.enabled, true);
  });

  it('gives Codex a native review command with the exact launch flags and no authored trust', async () => {
    const integration = adapters.adapter('codex')?.execution;
    assert.ok(integration);
    const args = await integration.configure('capture-command \'quoted\' "a b"', home);
    const text = await fs.readFile(path.join(home, 'codex-hook-review.txt'), 'utf8');
    const command = text.split('\n').find((line) => line.startsWith('codex '));
    assert.ok(command);
    const print = 'console.log(JSON.stringify(process.argv.slice(1)))';
    // The review is written for the host's own shell: Windows PowerShell 5.1
    // there, whose native rule codex.exe (Rust) and node (UCRT) parse alike.
    const probe =
      testPlatform() === 'win32'
        ? cp.spawnSync(
            path.win32.join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
            ),
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              command.replace(/^codex /, `& '${process.execPath}' -e '${print}' -- `)
            ],
            { encoding: 'utf8', windowsHide: true }
          )
        : cp.spawnSync(
            '/bin/sh',
            ['-c', `codex() { '${process.execPath}' -e '${print}' -- "$@"; }; ${command}`],
            { encoding: 'utf8' }
          );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), args);
    assert.equal(text.includes('trust all'), false);
  });

  it('publishes one complete immutable runner under simultaneous activation', async () => {
    const source = path.join(home, 'simultaneous-runner.js');
    const content = 'x'.repeat(2 * 1024 * 1024);
    await fs.writeFile(source, content);
    const integration = {
      configure: async (command: string): Promise<string> => {
        // The runner is the hook's last word, whichever runtime precedes it.
        const runner = command.match(/'([^']+\.js)'$/)?.[1];
        assert.ok(runner);
        assert.equal(await fs.readFile(runner, 'utf8'), content);
        return command;
      },
      hookShell: 'posix' as const,
      decode: () => undefined
    };
    const prepared = await Promise.all(
      Array.from({ length: 12 }, () => execution.prepareExecution(integration, source, true))
    );
    assert.ok(prepared.every((value) => value.runtime.enabled));
    assert.equal(new Set(prepared.map((value) => value.configuration)).size, 1);
  });

  for (const brand of ['claude', 'grok', 'codex'] as const) {
    it(`decodes ${brand}'s measured native hook spelling and rejects an unrelated session`, async () => {
      const fixture = JSON.parse(
        await fs.readFile(
          path.resolve(`src/test/fixtures/execution-hooks-2026-10-04/${brand}.json`),
          'utf8'
        )
      ) as {
        cases: {
          case: string;
          hooks: { at: number; payload: Record<string, unknown> }[];
          wire: { message: { method?: string; params?: unknown } }[];
        }[];
      };
      const childCase = fixture.cases.find((value) => value.case === 'child');
      assert.ok(childCase);
      const root = childCase.hooks[0]?.payload;
      const sid = String(root?.[brand === 'grok' ? 'sessionId' : 'session_id']);
      const admission: ExecutionAdmission = {
        version: 1,
        runtime: 'runtime',
        brand,
        enabled: true,
        sessionId: sid,
        owner: adapters.conversationKey(brand, sid),
        turn: 'local-turn'
      };
      const integration = adapters.adapter(brand)?.execution;
      assert.ok(integration);
      const children: ExecutionChild[] = [];
      const captured: { actor: string; call: string; edge: string }[] = [];
      const edges: ExecutionBoundary[] = [];
      for (const { payload } of childCase.hooks) {
        const decoded = integration.decode(payload, admission, children);
        if (decoded?.child)
          children.push({
            actor: decoded.child.actor,
            parent: decoded.child.parent,
            turn: admission.turn,
            ...(decoded.child.ended ? { ended: Date.now() } : {})
          });
        if (decoded?.request) captured.push(decoded.request);
        if (decoded?.request)
          edges.push({
            ...decoded.request,
            tree: '/fixture',
            version: 1,
            kind: 'execution',
            start: 100,
            end: 110
          });
      }
      assert.ok(captured.some((edge) => edge.edge === 'before'));
      assert.ok(captured.some((edge) => edge.edge === 'after'));
      assert.ok(
        captured.some((edge) => edge.actor !== sid),
        'native child work is captured'
      );
      const contextFile = path.join(home, `observer-${brand}`);
      for (const child of children) await execution.appendExecutionChild(contextFile, child);
      const observer =
        brand === 'claude'
          ? new (await import('../../core/claude/execution')).ExecutionObserver(sid, contextFile)
          : brand === 'grok'
            ? new (await import('../../core/grok/execution')).ExecutionObserver(sid, contextFile)
            : new (await import('../../core/codex/execution')).ExecutionObserver(sid);
      for (const { message } of childCase.wire) {
        if (brand === 'claude')
          (observer as import('../../core/claude/execution').ExecutionObserver).take(message);
        else
          (observer as import('../../core/grok/execution').ExecutionObserver).take(
            message.method ?? '',
            message.params
          );
      }
      const store: ExecutionStore = {
        readable: true,
        edges,
        coverage: [],
        active: [],
        ended: [],
        callEnds: [],
        windows: []
      };
      const observed = await observer.finish(store, admission.turn);
      assert.equal(observed.observed, true);
      const writes = observed.calls.filter((call) => call.eligibility === 'write');
      assert.ok(
        writes.some((call) => call.actor !== sid),
        'child calls are independently observed'
      );
      for (const edge of captured.filter((edge) => edge.edge === 'before')) {
        const call = writes.find((call) => call.actor === edge.actor && call.call === edge.call);
        assert.equal(
          call?.settled,
          true,
          `native call ${edge.call} joins completed stream evidence`
        );
      }
      const native = childCase.hooks.find(
        ({ payload }) => typeof payload[brand === 'grok' ? 'toolUseId' : 'tool_use_id'] === 'string'
      )?.payload;
      assert.ok(native);
      assert.equal(
        integration.decode(
          { ...native, [brand === 'grok' ? 'sessionId' : 'session_id']: 'unrelated-peer' },
          admission,
          children
        ),
        undefined
      );
      if (brand === 'grok') {
        const unproven = new (await import('../../core/grok/execution')).ExecutionObserver(sid);
        for (const { message } of childCase.wire)
          unproven.take(message.method ?? '', message.params);
        const missing = await unproven.finish(store, admission.turn);
        assert.equal(
          missing.observed,
          false,
          'missing ancestry cannot establish complete coverage'
        );
        assert.ok(missing.calls.every((call) => call.actor === sid));
        const floor = {
          tree: '/fixture',
          from: { tree: 'before', at: 1 },
          to: { tree: 'after', at: 200 },
          changes: { files: ['/fixture/child-native.txt'], sizes: {} }
        };
        const selected = await (
          await import('../../core/checkpoint')
        ).selectExecution(
          {
            owner: admission.owner,
            runtime: admission.runtime,
            turn: admission.turn,
            tree: floor.tree,
            start: 1,
            end: 200,
            observed: missing.observed,
            calls: missing.calls,
            floor
          },
          edges.filter((edge) => edge.actor === sid)
        );
        assert.equal(selected.source, 'turn');
        assert.deepEqual(selected.windows, [floor]);
        const child = childCase.hooks.find(
          ({ payload }) => payload.sessionId !== sid && typeof payload.toolUseId === 'string'
        )?.payload;
        assert.ok(child);
        assert.equal(
          integration.decode(child, admission, []),
          undefined,
          'inheritance alone is not ancestry'
        );
      }
    });
  }

  it('requires complete current-turn Grok ancestry for multiple and nested delegations', async () => {
    const grok = await import('../../core/grok/execution');
    const store: ExecutionStore = {
      readable: true,
      edges: [],
      coverage: [],
      active: [],
      ended: [],
      callEnds: [],
      windows: []
    };
    const child = { actor: 'child', parent: 'root', turn: 'turn', ended: 10 };
    const cases = [
      {
        name: 'complete',
        delegates: ['root', 'root'],
        children: [child, { ...child, actor: 'second' }],
        expected: true
      },
      { name: 'missing', delegates: ['root', 'root'], children: [child], expected: false },
      { name: 'duplicate', delegates: ['root', 'root'], children: [child, child], expected: false },
      {
        name: 'previous-turn',
        delegates: ['root'],
        children: [{ ...child, turn: 'old' }],
        expected: false
      },
      {
        name: 'unrelated',
        delegates: ['root'],
        children: [{ ...child, parent: 'peer' }],
        expected: false
      },
      {
        name: 'excess',
        delegates: ['root'],
        children: [child, { ...child, actor: 'second' }],
        expected: false
      },
      { name: 'nested-missing', delegates: ['root', 'child'], children: [child], expected: false },
      { name: 'failed', delegates: ['root'], children: [], expected: false }
    ];
    for (const value of cases) {
      const file = path.join(home, `grok-ancestry-${value.name}`);
      for (const proof of value.children) await execution.appendExecutionChild(file, proof);
      const observer = new grok.ExecutionObserver('root', file);
      value.delegates.forEach((actor, index) => {
        observer.take('session/update', {
          sessionId: actor,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `spawn-${index}`,
            _meta: { 'x.ai/tool': { name: 'spawn_subagent' } }
          }
        });
        observer.take('session/update', {
          sessionId: actor,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `spawn-${index}`,
            status: value.name === 'failed' ? 'failed' : 'completed'
          }
        });
      });
      const observed = await observer.finish(store, 'turn');
      assert.equal(observed.observed, value.expected, value.name);
    }
  });

  it('preserves a running bundle across version skew and keeps off runtimes independent', async () => {
    const source = path.join(home, 'runner.js');
    await fs.writeFile(source, 'first version');
    const integration = {
      configure: (command: string) => Promise.resolve(command),
      hookShell: 'posix' as const,
      decode: () => undefined
    };
    const first = await execution.prepareExecution(integration, source, true);
    await fs.writeFile(source, 'older version');
    const older = await execution.prepareExecution(integration, source, true);
    const off = await execution.prepareExecution(integration, source, false);
    assert.notEqual(first.configuration, older.configuration);
    const firstRunner = String(first.configuration).match(/'([^']+\.js)'$/)?.[1];
    assert.ok(firstRunner);
    assert.equal(await fs.readFile(firstRunner, 'utf8'), 'first version');
    assert.equal(off.runtime.enabled, false);
    assert.equal(off.configuration, undefined);
    assert.equal(
      await execution.admitExecution(first.runtime, 'claude', 'first-owner', 'first-turn'),
      true
    );
    assert.equal((await execution.readAdmission(first.runtime.contextFile!))?.enabled, true);
    older.runtime.enabled = false;
    await execution.admitExecution(older.runtime, 'claude', 'older-owner', 'older-turn');
    assert.equal((await execution.readAdmission(first.runtime.contextFile!))?.enabled, true);
    assert.equal((await execution.readAdmission(older.runtime.contextFile!))?.enabled, false);
  });

  it('keeps Grok scoped hooks when startup briefing is present or its file is unavailable', async () => {
    const cli = adapters.adapter('grok');
    assert.ok(cli?.execution);
    const configuration = await cli.execution.configure('capture-command', home);
    const options = { bin: executables.named('grok'), cwd: home, execution: configuration };
    const line = cli.launch({ ...options, briefing: 'startup instructions' });
    const plugin = line.args.indexOf('--plugin-dir');
    const profile = line.args.indexOf('--agent-profile');
    assert.ok(plugin >= 0 && profile >= 0);
    assert.equal(line.args[plugin + 1], configuration);
    assert.equal(line.args[profile + 1], line.files?.[0]?.path);
    assert.ok(line.files?.[0]?.content.includes('startup instructions'));
    const fallback = cli.launch(options);
    assert.equal(fallback.args[fallback.args.indexOf('--plugin-dir') + 1], configuration);
    assert.equal(fallback.args.includes('--agent-profile'), false);
  });

  it('merges Claude hooks with scoped context settings and startup briefing', async () => {
    const cli = adapters.adapter('claude');
    assert.ok(cli?.execution);
    const configuration = await cli.execution.configure('capture-command', home);
    const line = cli.launch({
      bin: executables.named('claude'),
      cwd: home,
      model: 'claude-opus-4-6',
      window: 200_000,
      briefing: 'startup instructions',
      execution: configuration
    });
    const position = line.args.indexOf('--settings');
    assert.ok(position >= 0);
    assert.equal(line.args.filter((arg) => arg === '--settings').length, 1);
    const settings = JSON.parse(line.args[position + 1]!) as { hooks: unknown; env?: unknown };
    assert.ok(settings.hooks);
    assert.equal(
      line.args[line.args.indexOf('--append-system-prompt') + 1],
      'startup instructions'
    );
    // The maintained catalog decides whether this model needs an env pin.
    const plain = cli.launch({
      bin: executables.named('claude'),
      cwd: home,
      model: 'claude-opus-4-6',
      window: 200_000
    });
    const plainPosition = plain.args.indexOf('--settings');
    if (plainPosition >= 0)
      assert.deepEqual(
        settings.env,
        (JSON.parse(plain.args[plainPosition + 1]!) as { env: unknown }).env
      );
  });
});
