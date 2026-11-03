import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as executables from '../../core/platform/executables';
import type { SessionTransport } from '../../core/session';
import { tempHome } from '../helpers';
import { executionRepo } from '../execution_helpers';

let adapters: typeof import('../../core/adapter');
let checkpoint: typeof import('../../core/checkpoint');
let git: typeof import('../../core/git');
let pipe: typeof import('../../core/session');
before(async () => {
  await tempHome();
  adapters = await import('../../core/adapter');
  checkpoint = await import('../../core/checkpoint');
  git = await import('../../core/git');
  pipe = await import('../../core/session');
});

describe('execution admission and unsent prompts', () => {
  it('rebaselines a Claude prompt when a native wake completes during model targeting', async () => {
    const { cwd, runtime } = await executionRepo('targeting-completed-wake', 'claude');
    runtime.enabled = false;
    let emit!: (value: unknown) => void;
    let entered!: (requestId: string) => void;
    const targeted = new Promise<string>((resolve) => {
      entered = resolve;
    });
    const writes: unknown[] = [];
    const session = adapters.adapter('claude')!.connect(
      {
        onLine: (listener) => {
          emit = listener;
        },
        onExit: () => undefined,
        close: () => undefined,
        write: (value) => {
          writes.push(value);
          const row = value as { request_id?: string; request?: { subtype?: string } };
          if (row.request?.subtype === 'set_model' && row.request_id) entered(row.request_id);
        }
      },
      {
        cwd,
        sessionId: 'completed-targeting-owner',
        startedAt: Date.now(),
        execution: runtime,
        named: true
      }
    );
    const assistant = (text: string): void =>
      emit({
        type: 'assistant',
        session_id: 'completed-targeting-owner',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      });
    const complete = (): void =>
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'completed-targeting-owner',
        result: 'done'
      });
    try {
      session.messages?.send('own prompt', [], undefined, false, { model: 'claude-sonnet-5' });
      const requestId = await targeted;
      assistant('native wake');
      await fs.writeFile(path.join(cwd, 'wake.txt'), 'wake\n');
      complete();
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: {} }
      });
      const deadline = Date.now() + 5000;
      while (
        !writes.some((value) => (value as { type?: string }).type === 'user') &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        writes.filter((value) => (value as { type?: string }).type === 'user').length,
        1
      );
      assistant('own turn');
      const file = path.join(cwd, 'own.txt');
      await fs.writeFile(file, 'own\n');
      complete();
      await session.flush?.();
      const coverage = (await checkpoint.readExecution(cwd)).coverage;
      const own = coverage.filter((ex) => ex.floor);
      assert.equal(own.length, 1);
      assert.equal(own[0]?.source, 'turn');
      assert.deepEqual(own[0]?.floor?.changes.files, [file]);
      assert.deepEqual(
        (await checkpoint.readWindows(cwd))
          .filter((window) => window.paths.length)
          .map((window) => window.paths),
        [[file]]
      );
    } finally {
      session.close();
      await session.flush?.();
    }
  });

  it('keeps autonomous uncertainty after model targeting discards an unsent Claude prompt', async () => {
    const { cwd, runtime } = await executionRepo('targeting-wake', 'claude');
    runtime.enabled = false;
    let emit!: (value: unknown) => void;
    let entered!: (requestId: string) => void;
    const targeted = new Promise<string>((resolve) => {
      entered = resolve;
    });
    const writes: unknown[] = [];
    const session = adapters.adapter('claude')!.connect(
      {
        onLine: (listener) => {
          emit = listener;
        },
        onExit: () => undefined,
        close: () => undefined,
        write: (value) => {
          writes.push(value);
          const row = value as { request_id?: string; request?: { subtype?: string } };
          if (row.request?.subtype === 'set_model' && row.request_id) entered(row.request_id);
        }
      },
      { cwd, sessionId: 'targeting-owner', startedAt: Date.now(), execution: runtime, named: true }
    );
    const peer = new checkpoint.TurnCheckpoints('targeting-peer');
    try {
      session.messages?.send('own prompt', [], undefined, false, { model: 'claude-sonnet-5' });
      const requestId = await targeted;
      await peer.open(cwd);
      emit({
        type: 'assistant',
        session_id: 'targeting-owner',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'autonomous wake' }] }
      });
      emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {}
        }
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await session.flush?.();
      assert.equal(
        writes.some((value) => (value as { type?: string }).type === 'user'),
        false
      );
      assert.equal(session.state.running, true);
      await fs.writeFile(path.join(cwd, 'autonomous.txt'), 'wake\n');
      const captured = await peer.close(cwd);
      assert.ok(captured);
      const attributed = checkpoint.attribute(captured, 'peer', await checkpoint.readWindows(cwd));
      assert.deepEqual(attributed.files, []);
      assert.equal(attributed.concurrent, true);
    } finally {
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'targeting-owner',
        result: 'wake done'
      });
      session.close();
      peer.end();
      await Promise.all([peer.flush(), session.flush?.()]);
    }
  });

  it('discards an unsent Claude collector instead of suppressing a peer write', async (t) => {
    const { cwd, runtime } = await executionRepo('unsent-claude', 'claude');
    const writes: unknown[] = [];
    const transport: SessionTransport = {
      onLine: () => undefined,
      onExit: () => undefined,
      close: () => undefined,
      write: (value) => writes.push(value)
    };
    // Retain the method across the mock; apply below supplies the original receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = checkpoint.TurnCheckpoints.prototype.open;
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    t.mock.method(
      checkpoint.TurnCheckpoints.prototype,
      'open',
      async function (
        this: InstanceType<typeof checkpoint.TurnCheckpoints>,
        ...args: Parameters<typeof original>
      ) {
        await original.apply(this, args);
        opened();
      }
    );
    const session = adapters.adapter('claude')!.connect(transport, {
      cwd,
      sessionId: 'unsent-owner',
      startedAt: Date.now(),
      execution: runtime,
      named: true
    });
    const peer = new checkpoint.TurnCheckpoints('peer-floor');
    try {
      session.messages?.send('never release this prompt');
      const queued = session.state.queued[0];
      assert.ok(queued);
      assert.equal(session.messages?.dismiss?.(queued.id), true);
      await ready;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await session.flush?.();
      assert.equal(
        writes.some((value) => (value as { type?: string }).type === 'user'),
        false
      );
      await peer.open(cwd);
      const file = path.join(cwd, 'peer-owned.txt');
      await fs.writeFile(file, 'peer\n');
      const captured = await peer.close(cwd);
      assert.ok(captured);
      const attributed = checkpoint.attribute(captured, 'peer', await checkpoint.readWindows(cwd));
      assert.deepEqual(attributed.files, [file]);
      assert.equal(attributed.concurrent, undefined);
    } finally {
      peer.end();
      await peer.flush();
      session.close();
      await session.flush?.();
    }
  });

  for (const [brand, fixture] of [
    ['claude', 'fake-cli.js'],
    ['grok', 'fake-acp.js'],
    ['codex', 'fake-codex.js']
  ] as const) {
    for (const scenario of [
      { name: 'dismissed', dismiss: true, enabled: true },
      { name: 'released', dismiss: false, enabled: false }
    ]) {
      it(`preserves ${brand} autonomous uncertainty when a wake finishes inside a ${scenario.name} baseline`, async (t) => {
        const { cwd, runtime } = await executionRepo(
          `wake-baseline-${brand}-${scenario.name}`,
          brand
        );
        runtime.enabled = scenario.enabled;
        const cli = adapters.adapter(brand)!;
        const line = cli.launch({
          bin: executables.named(path.resolve('out/test/fixtures', fixture), process.execPath),
          cwd,
          sessionId: `wake-${brand}`,
          skipPermissions: true
        });
        const transport = pipe.childTransport({ ...line, cwd });
        let emit!: (value: unknown) => void;
        const session = cli.connect(
          {
            ...transport,
            onLine: (listener) => {
              emit = listener;
              transport.onLine(listener);
            }
          },
          {
            cwd,
            sessionId: `wake-${brand}`,
            startedAt: Date.now(),
            skipPermissions: true,
            execution: runtime,
            named: true
          }
        );
        await session.opening;
        // Retain the method across the mock; apply below supplies the original receiver.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = checkpoint.TurnCheckpoints.prototype.open;
        let entered!: () => void;
        let release!: () => void;
        const baselined = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        t.mock.method(
          checkpoint.TurnCheckpoints.prototype,
          'open',
          async function (
            this: InstanceType<typeof checkpoint.TurnCheckpoints>,
            ...args: Parameters<typeof original>
          ) {
            await original.apply(this, args);
            if (args[1]?.runtime === runtime.runtime) {
              entered();
              await held;
            }
          }
        );
        const peer = new checkpoint.TurnCheckpoints(`wake-peer-${brand}`);
        try {
          session.messages?.send('dismiss this unsent prompt');
          await baselined;
          await peer.open(cwd);
          const sid = session.state.sessionId;
          assert.ok(sid);
          if (brand === 'claude')
            emit({
              type: 'assistant',
              session_id: sid,
              parent_tool_use_id: null,
              message: { role: 'assistant', content: [{ type: 'text', text: 'autonomous wake' }] }
            });
          else if (brand === 'grok') {
            emit({
              jsonrpc: '2.0',
              method: '_x.ai/queue/changed',
              params: {
                sessionId: sid,
                entries: [],
                runningPromptId: 'autonomous-wake',
                runningText: 'Background task completed'
              }
            });
            emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'autonomous wake' }
                }
              }
            });
          } else
            emit({
              method: 'turn/started',
              params: { threadId: sid, turn: { id: 'autonomous-wake' } }
            });
          assert.equal(session.state.running, true);
          const file = path.join(cwd, 'autonomous-owned.txt');
          await fs.writeFile(file, 'wake\n');
          if (brand === 'claude')
            emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: sid,
              result: 'wake complete'
            });
          else if (brand === 'grok')
            emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'turn_completed',
                  prompt_id: 'autonomous-wake',
                  stop_reason: 'end_turn'
                }
              }
            });
          else
            emit({
              method: 'turn/completed',
              params: {
                threadId: sid,
                turn: { id: 'autonomous-wake', status: 'completed' }
              }
            });
          assert.equal(session.state.running, false);
          const queued = session.state.queued[0];
          assert.ok(queued);
          if (scenario.dismiss) assert.equal(session.messages?.dismiss?.(queued.id), true);
          release();
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (!scenario.dismiss) {
            const deadline = Date.now() + 5000;
            while ((session.state.running || session.state.queued.length) && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
            assert.equal(session.state.running, false);
            assert.equal(session.state.queued.length, 0);
          }
          await session.flush?.();
          const store = await checkpoint.readExecution(cwd);
          assert.ok(
            !store.coverage.some((ex) => ex.floor?.changes.files.includes(file)),
            'the released prompt cannot claim a completed prior wake'
          );
          assert.ok(
            !(await checkpoint.readWindows(cwd)).some((window) => window.paths.includes(file)),
            'no legacy floor window claims the completed prior wake'
          );
          const captured = await peer.close(cwd);
          assert.ok(captured);
          const attributed = checkpoint.attribute(
            captured,
            `peer-${brand}`,
            await checkpoint.readWindows(cwd)
          );
          assert.deepEqual(attributed.files, [], 'a peer cannot claim the autonomous write');
          assert.equal(attributed.concurrent, true);
        } finally {
          release();
          peer.end();
          session.close();
          await Promise.all([peer.flush(), session.flush?.()]);
        }
      });
    }
  }

  for (const [brand, fixture] of [
    ['claude', 'fake-cli.js'],
    ['grok', 'fake-acp.js'],
    ['codex', 'fake-codex.js']
  ] as const) {
    it(`awaits ${brand} admission during close and never opens an unsent collector afterward`, async (t) => {
      const { cwd, runtime } = await executionRepo(`close-admission-${brand}`, brand);
      const cli = adapters.adapter(brand)!;
      const line = cli.launch({
        bin: executables.named(path.resolve('out/test/fixtures', fixture), process.execPath),
        cwd,
        sessionId: `close-${brand}`,
        skipPermissions: true
      });
      const transport = pipe.childTransport({ ...line, cwd });
      const session = cli.connect(transport, {
        cwd,
        sessionId: `close-${brand}`,
        startedAt: Date.now(),
        skipPermissions: true,
        execution: runtime,
        named: true
      });
      await session.opening;
      const original = fs.writeFile;
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof original>) => {
        if (args[0] === `${runtime.contextFile}.next`) {
          entered();
          await held;
        }
        await original(...args);
      });
      // Retain the method across the mock; call below supplies the original receiver.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalFlush = checkpoint.TurnCheckpoints.prototype.flush;
      let cleanupFinished!: () => void;
      const cleaned = new Promise<void>((resolve) => {
        cleanupFinished = resolve;
      });
      t.mock.method(
        checkpoint.TurnCheckpoints.prototype,
        'flush',
        async function (this: InstanceType<typeof checkpoint.TurnCheckpoints>) {
          await originalFlush.call(this);
          cleanupFinished();
        }
      );
      try {
        session.messages?.send('never release this prompt');
        await writing;
        session.close();
        let flushed = false;
        const done = session.flush?.().then(() => {
          flushed = true;
        });
        await cleaned;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(flushed, false, 'shutdown must await admission already in flight');
        release();
        await done;
        const tree = await git.readTree(cwd);
        assert.ok(tree);
        assert.deepEqual((await checkpoint.readExecution(cwd)).active, []);
        assert.equal(
          (await fs.readdir(tree.gitDir)).some(
            (name) => name.startsWith('squadron-') && name.endsWith('.index')
          ),
          false
        );
      } finally {
        release();
        session.close();
        await session.flush?.();
      }
    });
  }
});
