import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, describe, it } from 'node:test';

import type { ChangeOrigin } from '../../core/adapter';

import type { CodexRpc } from '../../core/codex/runtime';

import type { ToolCall } from '../../core/transcript';

let adapter: (typeof import('../../core/adapter'))['adapter'];

let openParams: (typeof import('../../core/codex/session'))['openParams'];

let openedThread: (typeof import('../../core/codex/session'))['openedThread'];

let refreshCodexModels: (typeof import('../../core/codex/models'))['refreshCodexModels'];

let resetCodexModelsForTest: (typeof import('../../core/codex/models'))['resetCodexModelsForTest'];

let toSession: (typeof import('../../core/live'))['toSession'];

let readRecord: (typeof import('../../core/record'))['readRecord'];

let recordFile: (typeof import('../../core/record'))['recordFile'];

let views: typeof import('../../ui/views');

let toolView: (typeof import('../../ui/activity'))['toolView'];

import { before } from 'node:test';

import { dispose, FIXTURES, setup, start, until, threadSession } from './codex_session_helpers';
import * as executables from '../../core/platform/executables';

before(async () => {
  await setup();
  ({ adapter } = await import('../../core/adapter'));
  ({ openParams } = await import('../../core/codex/session'));
  ({ openedThread } = await import('../../core/codex/session'));
  ({ refreshCodexModels } = await import('../../core/codex/models'));
  ({ resetCodexModelsForTest } = await import('../../core/codex/models'));
  ({ toSession } = await import('../../core/live'));
  ({ readRecord } = await import('../../core/record'));
  ({ recordFile } = await import('../../core/record'));
  views = await import('../../ui/views');
  ({ toolView } = await import('../../ui/activity'));
});

after(dispose);

describe('the Codex adapter', () => {
  it('reads quota on its existing pipe and accepts account-wide updates as maintenance', async (t) => {
    const { peer, handle } = await threadSession();
    const origins: ChangeOrigin[] = [];
    const status = handle.state.status;
    const stop = handle.onChange((_state, origin) => origins.push(origin));
    t.after(stop);
    peer.holding.add('account/rateLimits/read');
    assert.ok(handle.usage);
    const pending = handle.usage.read();
    await peer.sent('account/rateLimits/read');
    peer.reply('account/rateLimits/read', {
      result: {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 19, windowDurationMins: 300 } }
      }
    });
    assert.equal((await pending)?.windows[0]?.pct, 19);
    peer.notify('account/rateLimits/updated', {
      threadId: undefined,
      rateLimits: { limitId: 'codex', primary: { usedPercent: 21, windowDurationMins: 300 } }
    });
    assert.equal(handle.state.usage?.windows[0]?.pct, 21);
    assert.equal(handle.state.status, status);
    assert.deepEqual(origins, ['local', 'local']);
  });

  it('leaves failed-opening pipe close to its lifetime owner', async () => {
    const cli = adapter('codex');
    assert.ok(cli);
    let receive: (value: unknown) => void = () => {};
    let closes = 0;
    let requested = 0;
    const handle = cli.connect(
      {
        write(value) {
          const request = value as { id: number };
          queueMicrotask(() =>
            receive({ id: request.id, error: { code: -32001, message: 'Opening refused.' } })
          );
        },
        onLine(listener) {
          receive = listener;
        },
        onExit() {},
        close() {
          closes++;
        }
      },
      {
        cwd: '/tmp',
        startedAt: 1,
        failOpening() {
          requested++;
        }
      }
    );
    assert.equal((await handle.opening).ok, false);
    assert.equal(requested, 1);
    assert.equal(closes, 0, 'native pipe closed before its owner could capture descendants');
    handle.close();
    assert.equal(closes, 1);
  });

  it('launches one stdio app-server', () => {
    const cli = adapter('codex');
    assert.ok(cli);
    const bin = executables.named('/bin/codex');
    assert.deepEqual(cli.launch({ bin, cwd: '/tmp' }), {
      bin,
      args: ['app-server', '--listen', 'stdio://'],
      terminateOnClose: true
    });
  });

  it('maps permission, model, and effort onto thread-open params', () => {
    assert.deepEqual(
      openParams({
        cwd: '/tmp/project',
        startedAt: 1,
        model: 'gpt-5.6-sol',
        effort: 'high'
      }),
      {
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: false,
        model: 'gpt-5.6-sol',
        config: { model_reasoning_effort: 'high' }
      }
    );
    assert.deepEqual(openParams({ cwd: '/tmp/project', startedAt: 1, skipPermissions: true }), {
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false
    });
  });

  it('accepts the recorded 0.151.0 thread/start response', async () => {
    const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, 'start.json'), 'utf8')) as {
      response: unknown;
    };
    assert.deepEqual(openedThread(fixture.response), {
      id: '<thread-1>',
      cwd: '<cwd>',
      model: 'gpt-5.6-sol',
      effort: 'high',
      title: undefined,
      permissionMode: 'on-request+workspaceWrite',
      status: 'idle'
    });
  });

  it('reads a recorded never-but-sandboxed resume as unattended, not unleashed', async () => {
    // `resume.json` is the pair disagreeing, as observed: the policy asks for
    // nothing and the sandbox still boxes the work in. A card that read the
    // policy alone would paint this one as bypassing.
    const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, 'resume.json'), 'utf8')) as {
      response: unknown;
    };
    assert.equal(openedThread(fixture.response)?.permissionMode, 'never+workspaceWrite');
    const cli = adapter('codex');
    assert.ok(cli);
    assert.deepEqual(cli.permissionView('never+workspaceWrite'), {
      label: 'auto',
      holds: false,
      bypass: false
    });
    assert.deepEqual(cli.permissionView('never+dangerFullAccess'), {
      label: 'bypass',
      holds: false,
      bypass: true
    });
  });

  it('says nothing for the start it composes, and one word for the rest', () => {
    const cli = adapter('codex');
    assert.ok(cli);
    // The ordinary start, which is nearly every Codex card.
    assert.equal(cli.permissionView('on-request+workspaceWrite'), undefined);
    assert.equal(cli.permissionView('on-request'), undefined);
    assert.equal(cli.permissionView('on-failure+readOnly')?.label, 'read only');
    // Sandbox gone, reader still in the loop: not bypass, and not silent.
    assert.deepEqual(cli.permissionView('on-request+dangerFullAccess'), {
      label: 'full access',
      holds: false,
      bypass: false
    });
    // A policy nothing here has read, under the sandbox everything runs in:
    // its own word, not a compound nobody can look up.
    assert.equal(cli.permissionView('untrusted+workspaceWrite')?.label, 'untrusted');
  });

  it('opens an owned thread before declaring readiness', async () => {
    const handle = start({
      sessionId: 'unused-host-id',
      model: 'gpt-5.6-sol',
      effort: 'high'
    });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.sessionId, 'thread-c1');
    assert.equal(handle.state.transcript, recordFile('thread-c1'));
    assert.equal(handle.state.cwd, '/tmp/codex-project');
    assert.equal(handle.state.originCwd, '/tmp/codex-project');
    assert.equal(handle.state.model, 'gpt-5.6-sol');
    assert.equal(handle.state.effort, 'high');
    assert.equal(handle.state.permissionMode, 'on-request+workspaceWrite');
    assert.equal(handle.state.status, 'idle');
    assert.ok(handle.messages);
    assert.ok(handle.turn);
    assert.ok(handle.model);
    assert.ok(handle.naming);
    assert.ok(handle.asks);
  });

  it('records a readout as a local CLI turn, without sending it', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    handle.readout('Session renamed to: codex readout');
    let line: Record<string, unknown> | undefined;
    for (let look = 0; look < 100 && !line; look++) {
      const text = await fs.readFile(recordFile('thread-c1'), 'utf8').catch(() => '');
      line = text
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row) as Record<string, unknown>)
        .find((row) => row.text === 'Session renamed to: codex readout');
      if (!line) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(line?.role, 'cli');
    assert.equal(line?.local, true);
    assert.deepEqual(line?.blocks, [{ text: 'Session renamed to: codex readout' }]);
    assert.equal(handle.state.queued.length, 0, 'nothing reached the outbox');
  });

  it('deliberately enables the experimental request surface on an owned session', async () => {
    const handle = start({ mode: 'require-experimental' });
    assert.equal((await handle.opening)?.ok, true);
  });

  it('falls back to the stable request surface when experimental initialize is refused', async () => {
    const handle = start({ mode: 'stable-only' });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.status, 'idle');
  });

  it('keeps parallel protocol ids distinct and answers each exactly once', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('request pair');
    const waiting = await until(
      handle,
      'parallel Codex requests',
      (state) => state.pending.length === 2
    );
    assert.deepEqual(
      waiting.pending.map((request) => request.requestId),
      ['n:41', 's:41']
    );
    assert.equal(waiting.pending[0]?.canDenyReason, false);
    assert.equal(waiting.pending[1]?.questions?.[0]?.canOther, true);

    assert.equal(handle.asks.respond('n:41', { allow: true, always: true }), true);
    await until(
      handle,
      'command approval response',
      (state) => state.title === 'answered:command:{"decision":"acceptForSession"}'
    );
    assert.deepEqual(
      handle.state.pending.map((request) => request.requestId),
      ['s:41']
    );
    assert.equal(handle.asks.respond('n:41', { allow: false }), false, 'the protocol id is spent');

    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[1]] }), true);
    await until(
      handle,
      'question response',
      (state) => state.title === 'answered:question:{"answers":{"route":{"answers":["Right"]}}}'
    );
    const idle = await until(handle, 'request turn idle', (state) => state.status === 'idle');
    assert.deepEqual(idle.pending, []);
    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[0]] }), false);
  });

  it('records an answered question on a call of its own', async () => {
    // App-server completes no item for a `requestUserInput`, so without this
    // line the record has no call for the answer to replay on.
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('request pair');
    await until(handle, 'parallel Codex requests', (state) => state.pending.length === 2);
    // This suite's record file outlives the run (`thread-c1` under the real
    // state directory), so only a line written after this answer counts.
    const since = Date.now();
    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[1]] }), true);
    let call: ToolCall | undefined;
    for (let look = 0; look < 100 && !call; look++) {
      const recorded = await readRecord('thread-c1');
      call = recorded?.exchanges
        .filter((exchange) => 'at' in exchange && (exchange.at ?? 0) >= since)
        .flatMap((exchange) => ('blocks' in exchange ? (exchange.blocks ?? []) : []))
        .map((block) => ('call' in block ? block.call : undefined))
        .find((one) => one?.id === 'question-pair');
      if (!call) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(call && toolView(call).ask, {
      questions: [
        {
          question: 'Which route?',
          header: 'Route',
          multiSelect: false,
          canOther: true,
          options: [
            { label: 'Left', description: 'Scenic' },
            { label: 'Right', description: 'Direct' }
          ]
        }
      ],
      picks: [[1]],
      texts: [''],
      notes: ['']
    });
  });

  it('drops a retracted request and refuses the stale decision', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('retract request');
    await until(handle, 'retractable request', (state) => state.pending.length === 1);
    const settled = await until(
      handle,
      'server request retraction',
      (state) => state.status === 'idle' && state.pending.length === 0
    );
    assert.deepEqual(settled.pending, []);
    assert.equal(handle.asks.respond('n:42', { allow: true }), false);
  });

  it('ignores a duplicate protocol id without killing the first open request', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('duplicate request');
    await until(handle, 'first duplicate request', (state) => state.pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(
      handle.state.pending.map((request) => request.requestId),
      ['n:44']
    );
    assert.equal(handle.asks.respond('n:44', { allow: true }), true);
    await until(handle, 'duplicate request turn idle', (state) => state.status === 'idle');
  });

  it('cancels a callback that unexpectedly outlives its completed turn', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('complete request');
    await until(handle, 'callback before completion', (state) => state.pending.length === 1);
    const settled = await until(
      handle,
      'callback after completion',
      (state) => state.pending.length === 0 && state.status === 'idle'
    );
    assert.deepEqual(settled.pending, []);
    assert.equal(handle.asks.respond('n:45', { allow: true }), false);
  });

  it('auto-grants exactly the requested permission profile in bypass mode', async () => {
    const handle = start({ skipPermissions: true });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    handle.messages.send('permission request');
    const answered = await until(
      handle,
      'bypassed permission request',
      (state) => state.title?.startsWith('answered:permissions:') === true
    );
    assert.deepEqual(answered.pending, []);
    assert.equal(
      answered.title,
      'answered:permissions:{"permissions":{"network":{"enabled":true},"fileSystem":{"write":["/tmp/codex-project/shared"]}},"scope":"turn"}'
    );
    await until(handle, 'bypassed permission turn idle', (state) => state.status === 'idle');
  });

  it('fails a secret question closed without drawing a plain-text dialog', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    handle.messages.send('secret request');
    const failed = await until(
      handle,
      'secret request refusal',
      (state) => state.title === 'answered:secret:{"answers":{}}'
    );
    assert.deepEqual(failed.pending, []);
    await until(handle, 'secret request turn idle', (state) => state.status === 'idle');
  });

  it('interrupt retracts every open request before a stale answer can land', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.turn && handle.asks);
    handle.messages.send('request pair');
    await until(handle, 'requests before interrupt', (state) => state.pending.length === 2);
    await handle.turn.interrupt();
    const idle = await until(
      handle,
      'interrupted request turn',
      (state) => state.status === 'idle' && state.pending.length === 0
    );
    assert.deepEqual(idle.pending, []);
    assert.equal(handle.asks.respond('n:41', { allow: true }), false);
    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[0]] }), false);
  });

  it('keeps requests answerable when the interrupt round trip fails', async () => {
    const handle = start({ mode: 'error-interrupt' });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.turn && handle.asks);
    handle.messages.send('request pair');
    await until(handle, 'requests before failed interrupt', (state) => state.pending.length === 2);
    await assert.rejects(handle.turn.interrupt(), /fake interrupt refusal/);
    assert.deepEqual(
      handle.state.pending.map((request) => request.requestId),
      ['n:41', 's:41']
    );
    assert.equal(handle.asks.respond('n:41', { allow: true }), true);
    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[0]] }), true);
    await until(
      handle,
      'answered requests after failed interrupt',
      (state) => state.status === 'idle'
    );
  });

  it('closing the child clears every open request before its buttons can answer', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.asks);
    handle.messages.send('request pair');
    await until(handle, 'requests before close', (state) => state.pending.length === 2);
    handle.close();
    assert.deepEqual(handle.state.pending, []);
    assert.equal(handle.asks.respond('n:41', { allow: true }), false);
    assert.equal(handle.asks.respond('s:41', { allow: true, picks: [[0]] }), false);
  });

  it('drains and merges the panel outbox after interrupting the current turn', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages && handle.turn);
    handle.messages.send('slow first');
    await until(
      handle,
      'first turn',
      (state) => state.title?.startsWith('sent:slow first') === true
    );
    handle.messages.send('second');
    handle.messages.send('third');
    assert.equal(handle.state.queued.length, 2);
    await handle.messages.sendNow();
    const merged = await until(
      handle,
      'merged second turn',
      (state) => state.title?.startsWith('sent:second\n\nthird|') === true
    );
    assert.deepEqual(merged.queued, []);
    await until(handle, 'merged turn idle', (state) => state.status === 'idle');
  });

  it('renames over thread/name/set and applies a send target to the next turn', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.naming && handle.model && handle.messages);
    const origins: ChangeOrigin[] = [];
    handle.onChange((_state, origin) => origins.push(origin));
    handle.naming.rename('Reader title');
    await until(handle, 'renamed thread', (state) => state.title === 'Reader title');
    assert.deepEqual(origins, ['local'], 'the panel rename was marked as agent activity');
    origins.length = 0;
    handle.messages.send('model probe', [], undefined, false, { model: 'gpt-c2-next' });
    const sent = await until(
      handle,
      'model override',
      (state) =>
        state.title?.includes('|model:gpt-c2-next|') === true && state.model === 'gpt-c2-next'
    );
    assert.equal(sent.model, 'gpt-c2-next');
    assert.ok(origins.includes('prompt'), 'the model turn was not marked as prompt activity');
  });

  it('resumes the requested id and applies the same overrides', async () => {
    const handle = start({
      resume: 'existing-thread',
      sessionId: 'existing-thread',
      model: 'gpt-resumed',
      effort: 'low',
      skipPermissions: true
    });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.sessionId, 'existing-thread');
    assert.equal(handle.state.model, 'gpt-resumed');
    assert.equal(handle.state.effort, 'low');
    // Both halves of the mode, and in the words the CLI answers in whichever
    // spelling it echoed: a bypassing resume is the one card that must not read
    // as merely unattended.
    assert.equal(handle.state.permissionMode, 'never+dangerFullAccess');
  });

  it('uses a queued target for one turn and follows the settings reading', async () => {
    const handle = start({ model: 'gpt-5.6-sol', effort: 'medium' });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.effort, 'medium');
    await handle.messages?.send('targeted turn', [], undefined, false, {
      model: 'gpt-5.6-sol',
      effort: 'high'
    });

    const sent = await until(
      handle,
      'targeted Codex settings',
      (state) => state.title?.includes('|effort:high|') === true && state.effort === 'high'
    );
    assert.equal(sent.effort, 'high');
  });

  it('keeps a targeted effort on later turns when no settings push restates it', async () => {
    const handle = start({ mode: 'stable-only', model: 'gpt-5.6-sol', effort: 'low' });
    assert.equal((await handle.opening)?.ok, true);
    await handle.messages?.send('targeted turn', [], undefined, false, { effort: 'high' });
    await until(
      handle,
      'the targeted turn',
      (state) => state.title?.startsWith('sent:targeted turn|') === true
    );
    await handle.messages?.send('next turn');
    const next = await until(
      handle,
      'the next turn',
      (state) => state.title?.startsWith('sent:next turn|') === true
    );
    assert.match(
      next.title ?? '',
      /\|effort:high\|/,
      'the next turn went back to the launch effort'
    );
  });

  it('updates thread attachments from the targeted turn’s model', async (t) => {
    const models: CodexRpc = {
      request: () =>
        Promise.resolve({
          data: [
            {
              id: 'text-only',
              model: 'text-only',
              displayName: 'Text only',
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text']
            },
            {
              id: 'vision',
              model: 'vision',
              displayName: 'Vision',
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image']
            }
          ]
        }),
      notify: () => undefined,
      onNotification: () => () => undefined
    };
    t.after(resetCodexModelsForTest);
    const handle = start({ model: 'vision' });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(await refreshCodexModels(models), true);
    const held = {
      pid: 4242,
      brand: 'codex' as const,
      startedAt: 1,
      updatedAt: 1,
      session: handle
    };
    const canAttach = () =>
      views.toThread(toSession(handle.state, held, 'w'), { reachable: true, exchanges: [] })
        .canAttach;
    assert.equal(canAttach(), true);

    await handle.messages?.send('switch to text', [], undefined, false, { model: 'text-only' });
    await until(handle, 'text-only turn', (state) => state.model === 'text-only');
    assert.equal(handle.messages?.images, false);
    assert.equal(canAttach(), false);

    await until(handle, 'idle after text-only turn', (state) => !state.running);
    await handle.messages?.send('switch to vision', [], undefined, false, { model: 'vision' });
    await until(handle, 'vision turn', (state) => state.model === 'vision');
    assert.equal(handle.messages?.images, true);
    assert.equal(canAttach(), true);
  });

  it('sends a resumed thread’s live effort when no target overrides it', async () => {
    const handle = start({
      mode: 'resume-high',
      resume: 'existing-thread-high',
      sessionId: 'existing-thread-high',
      model: 'gpt-5.6-sol',
      effort: 'low'
    });
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.effort, 'high');
    await handle.messages?.send('resumed turn');

    await until(
      handle,
      'resumed effort on turn/start',
      (state) => state.title?.includes('|effort:high|') === true
    );
  });

  it('reduces a fake live turn without interpreting item text', async () => {
    const handle = start({ mode: 'auto-turn' });
    let sawBusy = false;
    handle.onChange((state) => {
      sawBusy ||= state.status === 'busy';
    });
    assert.equal((await handle.opening)?.ok, true);
    const settled = await until(
      handle,
      'completed fixture turn',
      (state) =>
        state.title === 'Codex C1 fixture' &&
        state.contextTokens === 1234 &&
        state.status === 'idle'
    );
    assert.equal(sawBusy, true);
    assert.equal(settled.model, 'gpt-codex-runtime');
    assert.equal(settled.effort, 'high');
    assert.equal(settled.contextTokens, 1234);
    assert.equal(settled.windowStated, 258_400);
  });

  for (const [mode, reason] of [
    ['bad-initialize', /malformed initialize response/],
    ['error-initialize', /fake initialize refusal/],
    ['bad-thread', /did not open an input-capable thread/],
    ['no-input', /did not open an input-capable thread/],
    ['early-exit', /exited with code 17/]
  ] as const) {
    it(`refuses ${mode}`, async () => {
      const handle = start({ mode });
      const ready = await handle.opening;
      assert.equal(ready?.ok, false);
      assert.match(ready && !ready.ok ? ready.reason : '', reason);
    });
  }

  it('times out a silent handshake, refuses readiness, and terminates the child', async () => {
    const handle = start({ mode: 'silent', requestMs: 5 });
    const ready = await handle.opening;
    assert.equal(ready?.ok, false);
    assert.match(ready && !ready.ok ? ready.reason : '', /Timed out waiting for Codex initialize/);
    const exited = await until(handle, 'timed-out child exit', (state) => Boolean(state.exit));
    assert.equal(exited.exit?.signal, 'SIGTERM');
  });

  it('close is idempotent and terminates the private child', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    const exited = until(
      handle,
      'private child exit',
      (state) => state.exit?.code === 0 || state.exit?.signal === 'SIGTERM'
    );
    handle.close();
    handle.close();
    assert.equal((await exited).running, false);
  });
});

describe('Codex startup briefing', () => {
  it('keeps launch args unchanged with a briefing', () => {
    const cli = adapter('codex');
    assert.ok(cli);
    assert.deepEqual(
      cli.launch({ bin: executables.named('/bin/codex'), cwd: '/tmp', briefing: 'brief' }),
      cli.launch({ bin: executables.named('/bin/codex'), cwd: '/tmp' })
    );
  });
  it('reads cwd configuration once before start/resume, preserves instructions and skips unsafe overrides', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-codex-briefing-'));
    try {
      for (const resume of [undefined, 'resumed-briefing']) {
        for (const configured of [
          '  user\nproject  ',
          '',
          'null',
          'absent',
          'malformed',
          'bad-response',
          'refused',
          'timeout'
        ]) {
          const requestLog = path.join(
            root,
            `${resume ?? 'start'}-${configured.length}-${configured.trim().replace(/[^a-z]/g, '')}.jsonl`
          );
          const logs: string[] = [];
          const handle = start({
            briefing: 'brief',
            configured,
            resume,
            requestLog,
            requestMs: 1000,
            log: (line) => logs.push(line)
          });
          assert.deepEqual(await handle.opening, { ok: true });
          handle.messages?.send('first briefing test');
          await until(
            handle,
            'first turn settled',
            (s) => s.title?.startsWith('sent:first briefing test') === true && s.status === 'idle'
          );
          handle.messages?.send('second briefing test');
          await until(
            handle,
            'second turn settled',
            (s) => s.title?.startsWith('sent:second briefing test') === true && s.status === 'idle'
          );
          handle.close();
          const requests = (await fs.readFile(requestLog, 'utf8'))
            .trim()
            .split('\n')
            .map(
              (line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }
            );
          const reads = requests.filter((r) => r.method === 'config/read');
          assert.equal(reads.length, 1);
          assert.deepEqual(reads[0]?.params, { cwd: '/tmp/codex-project', includeLayers: false });
          const opened = requests.find(
            (r) => r.method === (resume ? 'thread/resume' : 'thread/start')
          );
          assert.ok(opened);
          assert.ok(requests.indexOf(reads[0]) < requests.indexOf(opened));
          const unsafe = ['malformed', 'bad-response', 'refused', 'timeout'].includes(configured);
          assert.equal(
            opened.params?.developerInstructions,
            unsafe
              ? undefined
              : configured === '  user\nproject  '
                ? configured + '\n\nbrief'
                : 'brief'
          );
          assert.equal(logs.length, unsafe ? 1 : 0);
          assert.ok(logs.every((line) => !line.includes('user') && !line.includes('project')));
          assert.ok(
            requests
              .filter((r) => r.method === 'turn/start')
              .every((r) => !Object.hasOwn(r.params ?? {}, 'developerInstructions'))
          );
        }
      }
      const requestLog = path.join(root, 'disabled.jsonl');
      const handle = start({ requestLog });
      assert.deepEqual(await handle.opening, { ok: true });
      handle.close();
      const requests = (await fs.readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
      assert.ok(!requests.some((r) => r.method === 'config/read'));
      assert.ok(
        !Object.hasOwn(
          requests.find((r) => r.method === 'thread/start')?.params ?? {},
          'developerInstructions'
        )
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
