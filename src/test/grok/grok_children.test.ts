import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import type { GrokSession as Session } from '../../core/grok/session';
import type { SessionTransport } from '../../core/session';
import { tempHome, threadText } from '../helpers';
import { executionRepo } from '../execution_helpers';

let GrokSession: typeof Session;
let recordFile: typeof import('../../core/record').recordFile;
let shownStatus: typeof import('../../core/live').shownStatus;

before(async () => {
  await tempHome();
  ({ GrokSession } = await import('../../core/grok/session'));
  ({ recordFile } = await import('../../core/record'));
  ({ shownStatus } = await import('../../core/live'));
});

class Peer {
  holdPrompts = false;
  readonly written: { method: string; params?: unknown }[] = [];
  private readonly promptIds: number[] = [];
  private readonly lines: ((value: unknown) => void)[] = [];

  constructor(readonly sessionId: string) {}

  readonly transport: SessionTransport = {
    onLine: (listener) => this.lines.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      const request = value as { id?: number; method: string; params?: unknown };
      this.written.push(request);
      if (request.id === undefined) return;
      if (request.method === 'session/prompt' && this.holdPrompts) {
        this.promptIds.push(request.id);
        return;
      }
      const result =
        request.method === 'initialize'
          ? { protocolVersion: 1, authMethods: [{ id: 'grok-cli' }] }
          : request.method === 'session/new'
            ? { sessionId: this.sessionId }
            : {};
      queueMicrotask(() => {
        for (const listener of this.lines) listener({ jsonrpc: '2.0', id: request.id, result });
      });
    }
  };

  update(
    sessionId: string | undefined,
    update: Record<string, unknown>,
    method = 'session/update'
  ): void {
    this.notify({ jsonrpc: '2.0', method, params: { sessionId, update } });
  }

  notify(message: unknown): void {
    for (const listener of this.lines) listener(message);
  }

  finishPrompts(): void {
    for (const id of this.promptIds.splice(0)) {
      for (const listener of this.lines) {
        listener({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }
    }
  }
}

describe('Grok native child isolation', () => {
  for (const ancestry of ['proven', 'missing', 'foreign'] as const) {
    it(`selects checkpoint coverage for metadata-bearing fixture child tools with ${ancestry} ancestry`, async (t) => {
      const fixture = JSON.parse(
        await fs.readFile(
          path.resolve('src/test/fixtures/execution-hooks-2026-10-04/grok.json'),
          'utf8'
        )
      ) as {
        cases: {
          case: string;
          hooks: { at: number; payload: Record<string, unknown> }[];
          wire: {
            at: number;
            message: {
              method?: string;
              params?: {
                sessionId: string;
                update?: Record<string, unknown>;
                _meta?: { promptId?: string };
              };
            };
          }[];
        }[];
      };
      const measured = fixture.cases.find((row) => row.case === 'child');
      assert.ok(measured);
      const start = measured.hooks.find(
        ({ payload }) => payload.hookEventName === 'subagent_start'
      )?.payload;
      assert.equal(typeof start?.sessionId, 'string');
      assert.equal(typeof start?.subagentId, 'string');
      const actor = String(start?.subagentId);
      const parent = String(start?.sessionId);
      const { cwd, runtime } = await executionRepo(`grok-fixture-child-${ancestry}`, 'grok');
      const checkpoint = await import('../../core/checkpoint');
      const execution = await import('../../core/execution');
      const grok = await import('../../core/grok/execution');
      const finished = t.mock.method(grok.ExecutionObserver.prototype, 'finish');
      const record = await import('../../core/record');
      const peer = new Peer(`${parent}-${ancestry}`);
      peer.holdPrompts = true;
      const session = new GrokSession(peer.transport, {
        cwd,
        startedAt: Date.now(),
        execution: runtime
      });
      t.after(() => session.close());
      assert.equal((await session.opening).ok, true);
      session.send('delegate measured child work');
      for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'session/prompt'); i++)
        await setTimeout(10);
      const prompt = peer.written.find((row) => row.method === 'session/prompt')?.params as
        { _meta: { promptId: string } } | undefined;
      assert.ok(prompt);
      const admission = await execution.readAdmission(runtime.contextFile!);
      assert.ok(admission);
      const delegate = measured.wire.filter(
        ({ message }) =>
          message.params?.update?.toolCallId === 'call-7c8e5f4b-6128-427b-b39c-219e0423a3ef-2'
      );
      for (const { message } of delegate) {
        assert.ok(message.params);
        peer.notify({
          ...message,
          params: {
            ...message.params,
            sessionId: peer.sessionId,
            _meta: { ...message.params._meta, promptId: prompt._meta.promptId }
          }
        });
      }
      if (ancestry !== 'missing')
        await execution.appendExecutionChild(runtime.contextFile!, {
          actor,
          parent: ancestry === 'proven' ? peer.sessionId : 'unrelated-parent',
          turn: admission.turn
        });
      const children = await execution.readExecutionChildren(runtime.contextFile!);
      for (const { message } of measured.wire) {
        if (message.params?.sessionId !== actor || !message.params._meta?.promptId) continue;
        peer.notify({
          ...message,
          params: { ...message.params, sessionId: peer.sessionId }
        });
      }
      await fs.writeFile(path.join(cwd, 'outside-gap.txt'), 'outside execution\n');
      const events = [
        ...measured.wire
          .filter(({ message }) => message.params?.sessionId === actor)
          .map((row) => ({ ...row, kind: 'wire' as const })),
        ...measured.hooks
          .filter(
            ({ payload }) => payload.sessionId === actor && typeof payload.toolUseId === 'string'
          )
          .map((row) => ({ ...row, kind: 'hook' as const }))
      ];
      events.sort((a, b) => a.at - b.at);
      for (const event of events) {
        if (event.kind === 'wire') {
          peer.notify(event.message);
          continue;
        }
        const decoded = grok.integration.decode({ ...event.payload, cwd }, admission, children);
        if (ancestry === 'proven') assert.ok(decoded?.request);
        else assert.equal(decoded, undefined, 'unproven child hooks cannot capture writes');
        if (decoded?.request) {
          if (decoded.request.edge === 'after')
            await fs.writeFile(
              path.join(
                cwd,
                decoded.request.call.endsWith('-1') ? 'child-native.txt' : 'child.txt'
              ),
              'child\n'
            );
          await checkpoint.captureExecution(decoded.request);
        }
      }
      assert.equal(session.state.running, true, 'child completion cannot release the held parent');
      assert.equal((await record.readRecord(peer.sessionId))?.execution?.size ?? 0, 0);
      if (ancestry !== 'missing')
        await execution.appendExecutionChild(runtime.contextFile!, {
          actor,
          parent: ancestry === 'proven' ? peer.sessionId : 'unrelated-parent',
          turn: admission.turn,
          ended: Date.now()
        });
      peer.update(peer.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'parent done' }
      });
      peer.finishPrompts();
      let read = await record.readRecord(peer.sessionId);
      for (let i = 0; i < 100 && !read?.execution?.size; i++) {
        await setTimeout(10);
        read = await record.readRecord(peer.sessionId);
      }
      const coverage = [...(read?.execution?.values() ?? [])][0];
      assert.ok(coverage);
      const observation = await finished.mock.calls.at(-1)?.result;
      assert.ok(observation);
      assert.equal(coverage.source, ancestry === 'proven' ? 'execution' : 'turn');
      if (ancestry === 'proven') {
        assert.equal(observation.observed, true);
        assert.deepEqual(
          observation.calls.filter((call) => call.actor === actor),
          [
            {
              actor,
              call: 'call-6f12c767-0a77-4ab0-8b95-bbbe3d7f27bb-0',
              eligibility: 'write',
              settled: true
            },
            {
              actor,
              call: 'call-6f12c767-0a77-4ab0-8b95-bbbe3d7f27bb-1',
              eligibility: 'write',
              settled: true
            }
          ]
        );
        assert.deepEqual(
          coverage.calls.filter((call) => call.actor === actor),
          [
            { actor, call: 'call-6f12c767-0a77-4ab0-8b95-bbbe3d7f27bb-0' },
            { actor, call: 'call-6f12c767-0a77-4ab0-8b95-bbbe3d7f27bb-1' }
          ]
        );
        assert.deepEqual(
          [...new Set(coverage.windows.flatMap((window) => window.changes.files))].sort(),
          [path.join(cwd, 'child-native.txt'), path.join(cwd, 'child.txt')].sort()
        );
      } else {
        assert.equal(observation.observed, false);
        assert.ok(coverage.calls.every((call) => call.actor === peer.sessionId));
      }
      assert.ok(
        observation.calls
          .filter((call) => call.actor === peer.sessionId)
          .every((call) => call.eligibility === 'delegate')
      );
      session.close();
      await session.flush();
    });
  }

  it('captures a proven child before the parent-only guard without taking its text or completion', async (t) => {
    const { cwd, runtime } = await executionRepo('grok-child-capture', 'grok');
    const checkpoint = await import('../../core/checkpoint');
    const execution = await import('../../core/execution');
    const record = await import('../../core/record');
    const peer = new Peer('parent-capture');
    peer.holdPrompts = true;
    const session = new GrokSession(peer.transport, {
      cwd,
      startedAt: Date.now(),
      execution: runtime
    });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    session.send('delegate work');
    for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'session/prompt'); i++)
      await setTimeout(10);
    const admission = await execution.readAdmission(runtime.contextFile!);
    assert.ok(admission);
    const child = { actor: 'native-child', parent: peer.sessionId, turn: admission.turn };
    peer.update(peer.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'spawn-child',
      _meta: { 'x.ai/tool': { name: 'spawn_subagent' } }
    });
    peer.update(peer.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'spawn-child',
      status: 'completed'
    });
    await execution.appendExecutionChild(runtime.contextFile!, child);
    const request = {
      cwd,
      owner: admission.owner,
      runtime: runtime.runtime,
      actor: child.actor,
      call: 'child-write'
    };
    await checkpoint.captureExecution({ ...request, edge: 'before' });
    peer.update(child.actor, {
      sessionUpdate: 'tool_call',
      toolCallId: request.call,
      _meta: { 'x.ai/tool': { name: 'write' } }
    });
    await fs.writeFile(path.join(cwd, 'child.txt'), 'child\n');
    await checkpoint.captureExecution({ ...request, edge: 'after' });
    peer.update(child.actor, {
      sessionUpdate: 'tool_call_update',
      toolCallId: request.call,
      status: 'completed'
    });
    peer.update(child.actor, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'private child prose' }
    });
    peer.update(
      child.actor,
      { sessionUpdate: 'turn_completed', prompt_id: 'child-turn', stop_reason: 'end_turn' },
      '_x.ai/session_notification'
    );
    assert.equal(session.state.running, true);
    await execution.appendExecutionChild(runtime.contextFile!, { ...child, ended: Date.now() });
    peer.update(peer.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'parent done' }
    });
    peer.finishPrompts();
    let read = await record.readRecord(peer.sessionId);
    for (let i = 0; i < 100 && !read?.execution?.size; i++) {
      await setTimeout(10);
      read = await record.readRecord(peer.sessionId);
    }
    const ex = [...(read?.execution?.values() ?? [])][0];
    assert.equal(ex?.source, 'execution');
    assert.deepEqual(
      ex?.windows.flatMap((window) => window.changes.files),
      [path.join(cwd, 'child.txt')]
    );
    assert.equal(JSON.stringify(read?.exchanges).includes('private child prose'), false);
    session.close();
    await session.flush();
    assert.equal(
      (await fs.readdir(path.join(cwd, '.git'))).some(
        (name) => name.startsWith('squadron-') && name.endsWith('.index')
      ),
      false
    );
  });

  it('keeps a parent busy and interruptible when a child finishes', async (t) => {
    const peer = new Peer('parent-running');
    const session = new GrokSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    peer.update(peer.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'parent-call',
      title: 'parent command'
    });
    peer.update('native-child', {
      sessionUpdate: 'tool_call',
      toolCallId: 'child-call',
      title: 'child command'
    });
    peer.update(
      'native-child',
      {
        sessionUpdate: 'turn_completed',
        prompt_id: 'child-turn',
        stop_reason: 'end_turn'
      },
      '_x.ai/session_notification'
    );
    assert.equal(session.state.status, 'busy');
    assert.equal(session.state.running, true);
    assert.equal(session.state.activeTool, 'parent command');
    await session.interrupt();
    assert.deepEqual(
      peer.written.filter((request) => request.method === 'session/cancel'),
      [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: peer.sessionId } }]
    );
    peer.update(
      peer.sessionId,
      {
        sessionUpdate: 'turn_completed',
        prompt_id: 'parent-turn',
        stop_reason: 'cancelled'
      },
      '_x.ai/session_notification'
    );
    assert.equal(session.state.status, 'idle');
  });

  it('excludes child text and completion from the parent transcript', async (t) => {
    const peer = new Peer('parent-record');
    const session = new GrokSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    peer.update(peer.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'PARENT' }
    });
    peer.update('native-child', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'CHILD' }
    });
    assert.equal(threadText(session), 'PARENT');
    peer.update(
      'native-child',
      {
        sessionUpdate: 'turn_completed',
        prompt_id: 'child-turn',
        stop_reason: 'end_turn'
      },
      '_x.ai/session_notification'
    );
    peer.update(
      peer.sessionId,
      {
        sessionUpdate: 'turn_completed',
        prompt_id: 'parent-turn',
        stop_reason: 'end_turn'
      },
      '_x.ai/session_notification'
    );
    peer.update(peer.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'SENTINEL' }
    });
    peer.update(
      peer.sessionId,
      {
        sessionUpdate: 'turn_completed',
        prompt_id: 'sentinel-turn',
        stop_reason: 'end_turn'
      },
      '_x.ai/session_notification'
    );
    let content = '';
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      content = await fs.readFile(recordFile(peer.sessionId), 'utf8').catch(() => '');
      if (content.includes('SENTINEL')) break;
      await setTimeout(10);
    }
    const rows = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      rows.filter((row) => row.role === 'assistant').map((row) => row.text),
      ['PARENT', 'SENTINEL']
    );
  });

  it('keeps accepting sessionless updates', async (t) => {
    const peer = new Peer('parent-legacy');
    const session = new GrokSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    peer.update(undefined, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'LEGACY' }
    });
    assert.equal(threadText(session), 'LEGACY');
    assert.equal(session.state.status, 'busy');
  });

  it('acknowledges send-now while the replacement turn is still running', async (t) => {
    const peer = new Peer('parent-replacement');
    peer.holdPrompts = true;
    const session = new GrokSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
    t.after(() => {
      session.close();
      peer.finishPrompts();
    });
    assert.equal((await session.opening).ok, true);
    peer.update(peer.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'parent-call',
      title: 'parent command'
    });
    await session.send('replacement', [], undefined, true);
    const acknowledged = await Promise.race([
      session.sendNow().then(() => true),
      setTimeout(1000, false)
    ]);
    assert.equal(acknowledged, true);
    assert.equal(peer.written.filter((request) => request.method === 'session/cancel').length, 1);
    assert.equal(peer.written.filter((request) => request.method === 'session/prompt').length, 1);
    assert.equal(session.state.inFlight?.text, 'replacement');
    assert.equal(shownStatus(session.state), 'busy');
  });
});
