import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import type { ExecutionAdmission, ExecutionChild } from '../../core/execution';
import type { ExecutionRequest } from '../../core/checkpoint';
import type { BrandId } from '../../core/model';

/**
 * Every recorded case in `fixtures/execution-hooks-2026-10-04/`, replayed
 * through its brand's `decode`. The native child pass and Grok's background
 * completion are `execution.test.ts`; this file states what each of the other
 * cases yields, so a decode change that drops an edge a probe recorded fails
 * here rather than in a live session.
 */

type Fixture = {
  cases: {
    case: string;
    hooks: { payload: Record<string, unknown> }[];
    wire: { message: Record<string, unknown> }[];
  }[];
};

let adapters: typeof import('../../core/adapter');
before(async () => {
  await tempHome();
  adapters = await import('../../core/adapter');
});

async function replay(
  brand: BrandId,
  name: string
): Promise<{
  sid: string;
  requests: (ExecutionRequest & { hook: string })[];
  wire: Record<string, unknown>[];
}> {
  const fixture = JSON.parse(
    await fs.readFile(
      path.resolve(`src/test/fixtures/execution-hooks-2026-10-04/${brand}.json`),
      'utf8'
    )
  ) as Fixture;
  const recorded = fixture.cases.find((value) => value.case === name);
  assert.ok(recorded, `${brand} fixture records ${name}`);
  const first = recorded.hooks[0]?.payload;
  const sid = String(first?.[brand === 'grok' ? 'sessionId' : 'session_id']);
  const admission: ExecutionAdmission = {
    version: 1,
    runtime: 'runtime',
    brand,
    enabled: true,
    sessionId: sid,
    owner: adapters.conversationKey(brand, sid),
    turn: 'turn'
  };
  const integration = adapters.adapter(brand)?.execution;
  assert.ok(integration);
  const children: ExecutionChild[] = [];
  const requests: (ExecutionRequest & { hook: string })[] = [];
  for (const { payload } of recorded.hooks) {
    const decoded = integration.decode(payload, admission, children);
    if (decoded?.child)
      children.push({
        actor: decoded.child.actor,
        parent: decoded.child.parent,
        turn: admission.turn,
        ...(decoded.child.ended ? { ended: Date.now() } : {})
      });
    if (decoded?.request)
      requests.push({
        ...decoded.request,
        hook: String(payload.hook_event_name ?? payload.hookEventName)
      });
  }
  return { sid, requests, wire: recorded.wire.map((value) => value.message) };
}

/** Each call's edges in arrival order, so a pair reads `before after`. */
function edgesByCall(requests: readonly ExecutionRequest[]): string[][] {
  const calls = new Map<string, string[]>();
  for (const request of requests)
    calls.set(request.call, [...(calls.get(request.call) ?? []), request.edge]);
  return [...calls.values()];
}

describe('recorded native hook cases, decoded', () => {
  it('Claude first: shell, native write and a failing shell each close, the failure through PostToolUseFailure', async () => {
    const { sid, requests } = await replay('claude', 'first');
    assert.deepEqual(edgesByCall(requests), [
      ['before', 'after'],
      ['before', 'after'],
      ['before', 'after']
    ]);
    assert.ok(requests.every((request) => request.actor === sid && !request.pending));
    assert.deepEqual(
      requests.map((request) => request.hook),
      ['PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUseFailure']
    );
    assert.equal(new Set(requests.map((request) => request.context)).size, 1);
  });

  it('Claude background: the post edge is pending on backgroundTaskId, and the stream names its completion', async () => {
    const claude = await import('../../core/claude/execution');
    const { sid, requests, wire } = await replay('claude', 'background');
    assert.deepEqual(edgesByCall(requests), [['before', 'after']], 'reads write no edge');
    const [before, after] = requests;
    assert.equal(before?.pending, undefined);
    assert.equal(after?.pending, true);
    assert.equal(typeof after?.task, 'string');
    const completed = wire
      .map((message) => claude.completedTask(message, sid))
      .filter((task) => task !== undefined);
    assert.deepEqual(completed, [after?.task]);
    assert.deepEqual(
      wire.map((message) => claude.completedTask(message, 'unrelated-peer')).filter(Boolean),
      []
    );
  });

  it("Claude child: the subagent's own task completion is a task, not a pending call", async () => {
    const claude = await import('../../core/claude/execution');
    const { sid, requests, wire } = await replay('claude', 'child');
    assert.ok(requests.every((request) => !request.pending));
    const completed = wire
      .map((message) => claude.completedTask(message, sid))
      .filter((task) => task !== undefined);
    assert.equal(completed.length, 1);
    assert.ok(
      requests.some((request) => request.actor !== sid && request.actor === completed[0]),
      'the completed task is the subagent whose calls were captured'
    );
  });

  it('Grok first: every pair closes, including the failing shell', async () => {
    const { sid, requests } = await replay('grok', 'first');
    assert.deepEqual(edgesByCall(requests), [
      ['before', 'after'],
      ['before', 'after'],
      ['before', 'after']
    ]);
    assert.ok(requests.every((request) => request.actor === sid && !request.pending));
  });

  it('Grok background: BackgroundTaskStarted is a pending post edge carrying its task id', async () => {
    const grok = await import('../../core/grok/execution');
    const { sid, requests, wire } = await replay('grok', 'background');
    assert.deepEqual(edgesByCall(requests), [['before', 'after']], 'polls and reads write none');
    const after = requests[1];
    assert.equal(after?.pending, true);
    assert.equal(typeof after?.task, 'string');
    const completed = wire
      .map((message) => grok.completedTask(String(message.method), message.params))
      .filter((value) => value !== undefined);
    // `_x.ai/task_completed` and the later output poll both report it.
    assert.equal(completed.length, 2);
    for (const value of completed) assert.deepEqual(value, { actor: sid, task: after?.task });
  });

  for (const brand of ['claude', 'grok', 'codex'] as const) {
    it(`${brand} cancel, deny, timeout, resume and death yield only the edges the CLI ran`, async () => {
      const cancel = await replay(brand, 'cancel');
      const deny = await replay(brand, 'deny');
      const timeout = await replay(brand, 'timeout');
      const resume = await replay(brand, 'resume');
      const death = await replay(brand, 'death');
      const child = await replay(brand, 'child');
      // Grok's cancel did not stop the executing shell: it completed with a post.
      assert.deepEqual(
        edgesByCall(cancel.requests),
        brand === 'grok' ? [['before', 'after']] : [['before']]
      );
      assert.deepEqual(edgesByCall(deny.requests), [['before']], 'a denied call never runs');
      assert.deepEqual(edgesByCall(death.requests), [['before']], 'death leaves the pre alone');
      // The recorder outlived the native timeout; the payloads it was handed still decode.
      assert.deepEqual(edgesByCall(timeout.requests), [['before', 'after']]);
      assert.deepEqual(edgesByCall(resume.requests), [['before', 'after']]);
      for (const replayed of [cancel, deny, timeout, resume, death])
        assert.ok(
          replayed.requests.every(
            (request) => request.actor === replayed.sid && !request.pending && !request.task
          )
        );
      assert.equal(resume.sid, child.sid, 'resume reopens the child case session');
      const old = new Set(child.requests.map((request) => request.call));
      assert.ok(resume.requests.every((request) => !old.has(request.call)));
      if (brand !== 'grok') {
        // Grok's tool hooks carry no prompt id; its join is through ACP metadata.
        const contexts = new Set(child.requests.map((request) => request.context));
        assert.ok(resume.requests.every((request) => request.context !== undefined));
        assert.ok(resume.requests.every((request) => !contexts.has(request.context)));
      }
    });
  }

  it('Codex background: both shells close, and nothing is marked pending', async () => {
    const { sid, requests } = await replay('codex', 'background');
    assert.deepEqual(edgesByCall(requests), [
      ['before', 'after'],
      ['before', 'after']
    ]);
    assert.ok(requests.every((request) => request.actor === sid && !request.pending));
  });
});
