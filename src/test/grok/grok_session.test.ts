import * as assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import { onThreadState, threadState, writeJson } from '../helpers';

import type { Launch, SessionHandle } from '../../core/adapter';

import {
  adapter,
  dispose,
  grokTranscript,
  live,
  opened,
  promptText,
  recorded,
  rpcLog,
  sent,
  setup,
  start,
  tick,
  until,
  type Wire
} from './grok_session_helpers';
import * as executables from '../../core/platform/executables';

let pickAuth: typeof import('../../core/grok/session').pickAuth;
before(async () => {
  await setup();
  ({ pickAuth } = await import('../../core/grok/session'));
});

after(dispose);

describe('promptBlocks', () => {
  it('omits empty text and maps mediaType to the ACP mimeType field', async () => {
    const { promptBlocks } = await import('../../core/grok/session');
    assert.deepEqual(promptBlocks('', [{ mediaType: 'image/png', data: 'abcd' }]), [
      { type: 'image', data: 'abcd', mimeType: 'image/png' }
    ]);
    assert.deepEqual(promptBlocks('look', [{ mediaType: 'image/jpeg', data: 'xy' }]), [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'xy', mimeType: 'image/jpeg' }
    ]);
  });
});

describe('the Grok adapter', () => {
  it('leaves failed-opening pipe close to its lifetime owner', async () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    let receive: (value: unknown) => void = () => {};
    let closes = 0;
    let requested = 0;
    const handle = cli.connect(
      {
        write(value) {
          const request = value as { id: number };
          queueMicrotask(() =>
            receive({ jsonrpc: '2.0', id: request.id, result: { authMethods: [] } })
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

  it('classifies only explicit native model rejection as a pick refusal', async () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    for (const [label, modelResult, cause] of [
      [
        'rejected',
        { error: { code: -32602, message: 'Invalid params', data: 'unknown model id' } },
        'pick'
      ],
      [
        'protocol',
        { error: { code: -32603, message: 'Internal error', data: 'model service failed' } },
        undefined
      ],
      ['malformed', { result: {} }, undefined]
    ] as const) {
      let receive: (value: unknown) => void = () => {};
      const handle: SessionHandle = cli.connect(
        {
          write(value) {
            const request = value as { id: number; method: string };
            const result: unknown =
              request.method === 'initialize'
                ? { authMethods: [{ id: 'api_key', name: 'API key' }] }
                : request.method === 'session/new'
                  ? { sessionId: randomUUID() }
                  : request.method === 'session/set_model'
                    ? modelResult
                    : {};
            queueMicrotask(() =>
              receive({
                jsonrpc: '2.0',
                id: request.id,
                ...(request.method === 'session/set_model' ? modelResult : { result })
              })
            );
          },
          onLine(listener) {
            receive = listener;
          },
          onExit() {},
          close() {}
        },
        { cwd: '/tmp', startedAt: 1, model: 'grok-4.7' }
      );
      const result = await handle.opening;
      assert.equal(result.ok, false, label);
      assert.equal((result as { cause?: string }).cause, cause, label);
      handle.close();
    }
  });

  it('cancels initial model selection through the opening context', async () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const controller = new AbortController();
    let receive: (value: unknown) => void = () => {};
    const exits: (() => void)[] = [];
    const handle = cli.connect(
      {
        write(value) {
          const request = value as { id: number; method: string };
          if (request.method === 'session/set_model') {
            controller.abort(new Error('Opening cancelled.'));
            return;
          }
          const result =
            request.method === 'initialize'
              ? { authMethods: [{ id: 'api_key', name: 'API key' }] }
              : request.method === 'session/new'
                ? { sessionId: randomUUID() }
                : {};
          queueMicrotask(() => receive({ jsonrpc: '2.0', id: request.id, result }));
        },
        onLine(listener) {
          receive = listener;
        },
        onExit(listener) {
          exits.push(() => listener({ code: 0, signal: null, source: 'exit' }));
        },
        close() {
          for (const exit of exits) exit();
        }
      },
      {
        cwd: '/tmp',
        startedAt: 1,
        model: 'grok-4.7',
        opening: {
          signal: controller.signal,
          check() {
            if (controller.signal.aborted) throw controller.signal.reason;
          },
          remaining: () => 30_000
        }
      }
    );
    const result = await Promise.race([
      handle.opening,
      new Promise<'unsettled'>((resolve) => setTimeout(() => resolve('unsettled'), 100))
    ]);
    handle.close();
    assert.notEqual(result, 'unsettled', 'initial model request ignored opening cancellation');
    assert.equal(typeof result === 'object' && result.ok, false);
  });

  it('records a sent prompt when Grok writes its echo only to disk', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const handle = start({ env: { SQUADRON_FAKE_ACP_ECHO_AT_MS: String(now - 3) } });
    assert.equal((await handle.opening)?.ok, true);
    handle.messages?.send('no-user-echo: remember this');
    await until(
      handle,
      'the disk-only prompt to finish',
      (s) => s.status === 'idle' && s.queued.length === 0
    );
    const lines = await recorded((rows) => {
      const user = rows.findIndex((row) => row.text === 'no-user-echo: remember this');
      return user >= 0 && rows[user + 1]?.role === 'assistant';
    });
    const at = lines.findIndex((row) => row.text === 'no-user-echo: remember this');
    assert.ok(at >= 0);
    assert.equal(lines[at]?.role, 'user');
    assert.equal(typeof lines[at]?.m, 'string', 'the disk prompt index is its witness');
    assert.equal(lines[at + 1]?.role, 'assistant', 'the user turn precedes the reply');
    const transcript = handle.state.transcript;
    assert.ok(transcript);
    await fs.writeFile(
      transcript,
      JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_query>no-user-echo: remember this</user_query>' }],
        prompt_index: Number(lines[at]?.m)
      }) + '\n'
    );
    const chosen = await adapter.readSessionTranscript({
      pid: 1,
      sessionId: 'g1',
      cwd: '/tmp/project',
      transcript,
      brand: 'grok'
    } as import('../../core/model').Session);
    assert.equal(chosen.ours, true, 'the complete own record hides the reconstruction notice');
  });

  it('records a readout as a local CLI turn, without sending it', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    handle.readout('Session renamed to: grok readout');
    const lines = await recorded((rows) =>
      rows.some((row) => row.text === 'Session renamed to: grok readout')
    );
    const line = lines.find((row) => row.text === 'Session renamed to: grok readout');
    assert.equal(line?.role, 'cli');
    assert.equal(line?.local, true);
    assert.deepEqual(line?.blocks, [{ text: 'Session renamed to: grok readout' }]);
    assert.equal(handle.state.queued.length, 0, 'nothing reached the outbox');
  });

  it('keeps copied images on a disk-only image prompt', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const handle = start({
      env: { SQUADRON_FAKE_ACP_NO_USER_ECHO: '1', SQUADRON_FAKE_ACP_ECHO_AT_MS: String(now + 2) }
    });
    assert.equal((await handle.opening)?.ok, true);
    handle.messages?.send('', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    await until(
      handle,
      'the image prompt to finish',
      (s) => s.status === 'idle' && s.queued.length === 0
    );
    const lines = await recorded((rows) =>
      rows.some((row) => row.role === 'user' && row.text === '' && row.m === '0')
    );
    const turn = lines.find((row) => row.role === 'user' && row.text === '' && row.m === '0');
    const images = turn?.images as { id: string; mediaType?: string }[] | undefined;
    assert.equal(images?.length, 1);
    assert.match(images[0]?.id ?? '', /^r\|g1-/);
  });

  it('retries a disk echo that arrives after the first recovery read', async () => {
    const handle = start({ env: { SQUADRON_FAKE_ACP_DELAY_USER_ECHO_MS: '2200' } });
    assert.equal((await handle.opening)?.ok, true);
    handle.messages?.send('no-user-echo slow');
    await until(handle, 'the slow turn', (s) => s.status === 'busy');
    const transcript = handle.state.transcript;
    assert.ok(transcript);
    const updates = path.join(path.dirname(transcript), 'updates.jsonl');
    let diskEcho = false;
    for (let i = 0; i < 250 && !diskEcho; i++) {
      diskEcho = (await fs.readFile(updates, 'utf8').catch(() => '')).includes('no-user-echo slow');
      if (!diskEcho) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(diskEcho, 'the delayed disk echo arrived before interrupt');
    const lines = await recorded((rows) => rows.some((row) => row.text === 'no-user-echo slow'));
    const turn = lines.find((row) => row.text === 'no-user-echo slow');
    assert.equal(turn?.role, 'user');
    assert.equal(typeof turn.m, 'string');
    handle.turn?.interrupt();
  });

  it('launches agent flags before stdio, and always approves', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const on = ['agent', '--no-leader', '--always-approve', '-m', 'grok-4.6', 'stdio'];
    assert.deepEqual(
      cli.launch({ bin: executables.named('/bin/grok'), cwd: '/tmp', model: 'grok-4.6' }).args,
      on
    );
    assert.deepEqual(
      cli.launch({
        bin: executables.named('/bin/grok'),
        cwd: '/tmp',
        model: 'grok-4.6',
        skipPermissions: true
      }).args,
      on
    );
    assert.ok(!on.slice(on.indexOf('stdio') + 1).includes('--no-leader'));
  });

  /**
   * This CLI's own spelling, and the reason the launch target carries an
   * effort rather than a scale: Claude takes `--effort`, this takes
   * `--reasoning-effort`, and Codex takes neither — it is thread-open config.
   * Nothing above `core/` knows which is which.
   */
  it('spells effort --reasoning-effort, and says nothing without one', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const args = (effort?: string) =>
      cli.launch({ bin: executables.named('/bin/grok'), cwd: '/tmp', model: 'grok-4.6', effort })
        .args;
    assert.deepEqual(args('high'), [
      'agent',
      '--no-leader',
      '--always-approve',
      '-m',
      'grok-4.6',
      '--reasoning-effort',
      'high',
      'stdio'
    ]);
    // Absent is "let the CLI decide", so the flag is left off rather than sent
    // empty — the same bargain `--model` makes, and what `startOwned` folds an
    // unset setting down to before it ever gets here.
    assert.ok(!args().includes('--reasoning-effort'), 'an absent effort reached the line');
    assert.ok(!args('').includes('--reasoning-effort'), 'an empty effort reached the line');
  });

  it('states the effort it was started on before the pipe restates one', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const handle = cli.connect(
      {
        pid: 1,
        write: () => undefined,
        onLine: () => undefined,
        onExit: () => undefined,
        close: () => undefined
      },
      { cwd: '/tmp', startedAt: 1, effort: 'high' }
    );
    assert.equal(handle.state.effort, 'high');
    handle.close();
  });

  it('states the launch on the card: always-approve, or ask when skip is off', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const nowhere = (): import('../../core/session').SessionTransport => ({
      pid: 1,
      write: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      close: () => undefined
    });
    const at = (skip?: boolean) => {
      const handle = cli.connect(nowhere(), { cwd: '/tmp', startedAt: 1, skipPermissions: skip });
      const mode = handle.state.permissionMode;
      handle.close();
      return mode;
    };
    assert.equal(at(), 'always-approve');
    assert.equal(at(true), 'always-approve');
    assert.equal(at(false), 'ask');
  });

  it('puts --permission-mode default on the root when skip is off', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const { args } = cli.launch({
      bin: executables.named('/bin/grok'),
      cwd: '/tmp',
      model: 'grok-4.6',
      skipPermissions: false
    });
    assert.deepEqual(args, [
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      '-m',
      'grok-4.6',
      'stdio'
    ]);
    assert.ok(!args.includes('--always-approve'));
  });

  it('does not put --resume on the launch line', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const { args } = cli.launch({ bin: executables.named('/bin/grok'), cwd: '/tmp', resume: 'g1' });
    assert.ok(!args.includes('--resume'));
  });

  it('does not put a Claude model id on the launch line', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const { args } = cli.launch({
      bin: executables.named('/bin/grok'),
      cwd: '/tmp',
      model: 'opus'
    });
    assert.deepEqual(args, ['agent', '--no-leader', '--always-approve', 'stdio']);
  });

  it('offers targeted delivery without direct model or naming ports', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    const handle = start();
    assert.equal(handle.messages?.images, true);
    assert.ok(handle.turn);
    assert.ok(handle.asks);
    assert.ok(handle.warm);
    assert.equal(handle.model, undefined);
    assert.equal(handle.naming, undefined);
  });

  it('does not treat a minted sessionId as a load', async () => {
    const handle = start({ sessionId: 'fresh-mint' });
    assert.equal(handle.state.transcript, undefined);
    assert.ok(handle.opening);
    const ready = await handle.opening;
    assert.equal(ready.ok, true);
    await until(handle, 'session/new', (s) => s.sessionId === 'g1');
    assert.equal(handle.state.transcript, grokTranscript.grokTranscriptPath('/tmp/project', 'g1'));
  });

  it('runs the first prompt on the requested model', async () => {
    const handle = start({
      model: 'grok-4.5',
      env: { SQUADRON_FAKE_ACP_HOLD_MODEL_MS: '200' }
    });
    handle.messages?.send('model-check-4.5');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handle.state.queued.length, 1, 'prompt left before Grok confirmed the model');
    assert.equal((await handle.opening)?.ok, true);
    await until(
      handle,
      'first prompt completed',
      (state) => state.queued.length === 0 && state.status === 'idle'
    );
    assert.equal(handle.state.model, 'grok-4.5');
  });

  it('refuses a model Grok rejects instead of reporting a sign-in failure', async () => {
    const handle = start({ model: 'grok-unknown' });
    assert.deepEqual(await handle.opening, {
      ok: false,
      reason: 'Grok could not select model grok-unknown.',
      cause: 'pick'
    });
  });

  it('sets effort before its prompt and follows the returned option list', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.equal(handle.state.effort, 'high', 'session/new did not read top-level configOptions');
    assert.ok(handle.messages);

    handle.messages.send('effort-low', [], undefined, false, { effort: 'low' });
    const changed = await until(
      handle,
      'the effort configuration',
      (state) => state.effort === 'low'
    );
    assert.equal(changed.effort, 'low');
    await until(handle, 'the targeted turn', (state) => state.queued.length === 0);
  });

  it('keeps a targeted prompt while its effort change is in flight', async () => {
    const handle = start({ env: { SQUADRON_FAKE_ACP_HOLD_CONFIG_MS: '200' } });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);

    handle.messages.send('keep-me', [], undefined, false, { effort: 'low' });
    await until(handle, 'queued while effort applies', (state) => state.queued.length === 1);
    // Past the drain's baseline (none on `/tmp/project`) and into the held
    // `set_config_option`, which is the window this case exists to close.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const id = handle.state.queued[0]?.id ?? '';
    assert.equal(handle.state.queued.length, 1, 'the hold is still open');
    assert.equal(handle.messages.dismiss(id), false);
    handle.messages.send('ahead', [], undefined, true);
    assert.equal(handle.state.queued[0]?.text, 'keep-me');
    await until(handle, 'the targeted turn', (state) => state.queued.length === 0);
    const lines = await recorded(
      (rows) =>
        rows.some((row) => row.text === 'keep-me') && rows.some((row) => row.text === 'ahead')
    );
    assert.deepEqual(
      lines.filter((row) => row.text === 'keep-me' || row.text === 'ahead').map((row) => row.text),
      ['keep-me', 'ahead']
    );
  });

  it('keeps a targeted prompt when a queued effort change is refused', async () => {
    const handle = start({ env: { SQUADRON_FAKE_ACP_FAIL_CONFIG: '1' } });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);

    handle.messages.send('refused-keep', [], undefined, false, { effort: 'low' });
    await until(handle, 'the refused prompt stayed', (state) =>
      state.queued.some((row) => row.text === 'refused-keep')
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handle.state.queued[0]?.text, 'refused-keep');
    handle.messages.send('refused-after');
    await until(
      handle,
      'later drain around the refused row',
      (state) => state.queued.length === 1 && state.queued[0]?.text === 'refused-keep'
    );
    const lines = await recorded((rows) => rows.some((row) => row.text === 'refused-after'));
    assert.equal(
      lines.some((row) => row.text === 'refused-keep'),
      false
    );
  });

  it('surfaces an effort value the CLI refuses before queueing its prompt', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);

    await assert.rejects(
      Promise.resolve(
        handle.messages?.send('effort-banana', [], undefined, false, { effort: 'banana' })
      ),
      /unknown reasoning_effort value/
    );
    assert.equal(handle.state.queued.length, 0);
  });

  it('applies a model, then its effort, then the prompt', async () => {
    const file = path.join(os.tmpdir(), `sq-acp-${randomUUID()}.jsonl`);
    const handle = start({ env: { SQUADRON_FAKE_ACP_REQUESTS: file } });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    handle.messages.send('switch-4.5', [], undefined, false, { model: 'grok-4.5', effort: 'high' });
    const done = await until(
      handle,
      'the switched turn',
      (state) =>
        state.queued.length === 0 &&
        !state.inFlight &&
        state.status === 'idle' &&
        state.model === 'grok-4.5' &&
        state.turnsEnded > 0
    );
    assert.equal(done.model, 'grok-4.5');
    const rows = await rpcLog(file);
    const at = rows.findIndex(
      (row) => row.method === 'session/prompt' && promptText(row.params) === 'switch-4.5'
    );
    assert.ok(at >= 2, 'the prompt had no model change ahead of it');
    assert.deepEqual(
      rows.slice(at - 2, at + 1).map((row) => row.method),
      ['session/set_model', 'session/set_config_option', 'session/prompt']
    );
    assert.equal(rows[at - 2]?.params.modelId, 'grok-4.5');
    assert.equal(rows[at - 1]?.params.value, 'high');
  });

  it('accepts a model switch off xhigh and lands on the effort the new model offers', async () => {
    const handle = start();
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    handle.messages.send('seat-xhigh', [], undefined, false, { effort: 'xhigh' });
    await until(handle, 'xhigh on the opening model', (state) => state.effort === 'xhigh');
    let refused = false;
    try {
      const pending = handle.messages.send('switch-off-xhigh', [], undefined, false, {
        model: 'grok-4.5',
        effort: 'high'
      });
      if (pending) await pending;
    } catch {
      refused = true;
    }
    assert.equal(refused, false, 'send() refused an effort the next model offers');
    const done = await until(
      handle,
      'high on grok-4.5',
      (state) =>
        state.model === 'grok-4.5' &&
        state.effort === 'high' &&
        state.queued.length === 0 &&
        state.status === 'idle'
    );
    assert.equal(done.model, 'grok-4.5');
    assert.equal(done.effort, 'high');
  });

  it('does not check the next model’s effort against the model in force', async () => {
    const handle = start({ model: 'grok-4.5' });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    // open's pin leaves effortValues on session/new's list. One effort change
    // on grok-4.5 replaces it with the values that model offers.
    handle.messages.send('seat-4.5', [], undefined, false, { effort: 'high' });
    await until(
      handle,
      'seated on grok-4.5',
      (state) => state.queued.length === 0 && state.status === 'idle' && state.effort === 'high'
    );
    let refused = false;
    try {
      const pending = handle.messages.send('up-xhigh', [], undefined, false, {
        model: 'grok-4.7',
        effort: 'xhigh'
      });
      if (pending) await pending;
    } catch {
      refused = true;
    }
    assert.equal(refused, false, 'send() checked xhigh against grok-4.5');
    const done = await until(
      handle,
      'xhigh on grok-4.7',
      (state) =>
        state.model === 'grok-4.7' &&
        state.effort === 'xhigh' &&
        state.queued.length === 0 &&
        state.status === 'idle'
    );
    assert.equal(done.model, 'grok-4.7');
    assert.equal(done.effort, 'xhigh');
  });

  it('keeps a row when the model change is refused and drains a later send around it', async () => {
    const handle = start({ env: { SQUADRON_FAKE_ACP_FAIL_MODEL: '1' } });
    assert.equal((await handle.opening)?.ok, true);
    assert.ok(handle.messages);
    handle.messages.send('model-refused', [], undefined, false, {
      model: 'grok-4.5',
      effort: 'high'
    });
    await until(handle, 'the refused prompt stayed', (state) =>
      state.queued.some((row) => row.text === 'model-refused')
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handle.state.queued[0]?.text, 'model-refused');
    handle.messages.send('model-after');
    await until(
      handle,
      'later drain around the refused row',
      (state) => state.queued.length === 1 && state.queued[0]?.text === 'model-refused'
    );
    const lines = await recorded((rows) => rows.some((row) => row.text === 'model-after'));
    assert.equal(
      lines.some((row) => row.text === 'model-refused'),
      false
    );
  });

  it('loads a known id and does not paint the replay as a live turn', async () => {
    const handle = start({ resume: 'g1', sessionId: 'g1' });
    const file = grokTranscript.grokTranscriptPath('/tmp/project', 'g1');
    assert.equal(handle.state.transcript, file);
    assert.doesNotMatch(handle.state.transcript ?? '', /\.claude\/projects/);
    assert.ok(handle.opening);
    const ready = await handle.opening;
    assert.equal(ready.ok, true);
    await until(handle, 'loaded', (s) => s.sessionId === 'g1');
    assert.equal(threadState(handle).words, '');
    assert.equal(handle.state.status, 'idle');
    assert.equal(handle.state.transcript, file);
  });

  it('refreshes a resumed session for a silent prompt, not its load-time idle roster', async () => {
    const handle = start({ resume: 'g1', sessionId: 'g1' });
    let turned = false;
    let advances = 0;
    const origins: string[] = [];
    handle.onChange((state, origin) => {
      origins.push(origin);
      if (adapter.advancesActivityClock({ origin, status: state.status, turned, warm: false })) {
        turned = true;
        advances += 1;
      }
    });
    assert.equal((await handle.opening)?.ok, true);
    await until(handle, 'load-time roster', (state) => state.title === 'Loaded session');
    assert.equal(advances, 0, 'the resumed session moved before its first prompt');

    handle.messages?.send('silent-completion');
    await until(
      handle,
      'silent prompt completion',
      (state) => state.status === 'idle' && state.queued.length === 0 && !state.inFlight
    );
    assert.ok(origins.includes('prompt'), 'the prompt dispatch did not carry activity');
    assert.ok(advances >= 2, 'the prompt and its completion did not both refresh activity');
  });

  it('fails ready on a stale id rather than minting a session', async () => {
    const handle = start({ resume: 'gone', sessionId: 'gone' });
    const file = grokTranscript.grokTranscriptPath('/tmp/project', 'gone');
    assert.equal(handle.state.transcript, file);
    assert.ok(handle.opening);
    const ready = await handle.opening;
    assert.equal(ready.ok, false);
    assert.notEqual(handle.state.sessionId, 'g1');
    assert.equal(handle.state.transcript, file);
  });

  it('reduces a fake ACP child from busy through text to idle', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    // The stream is three lines in one tick; subscribe before send so busy
    // and the text are seen rather than only the idle that follows them.
    const seen = { busy: false, text: false };
    onThreadState(handle, (s) => {
      if (s.status === 'busy') {
        seen.busy = true;
      }
      if (s.words.includes('pong')) {
        seen.text = true;
      }
    });
    handle.messages?.send('Reply with exactly: pong.');
    const done = await until(
      handle,
      'idle after the turn',
      (s) => seen.text && s.status === 'idle' && !s.running
    );
    assert.equal(seen.busy, true);
    assert.equal(seen.text, true);
    assert.equal(done.words, 'pong');
    assert.equal(done.sessionId, 'g1');

    const card = live.toSession(
      done,
      { pid: 7, startedAt: 1000, updatedAt: 2000, brand: 'grok' },
      'window-a'
    );
    assert.equal(card.brand, 'grok');
    assert.equal(card.sessionId, 'g1');
  });

  it('opens a question as waiting and replies accepted', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('ask');
    const blocked = await until(
      handle,
      'waiting on the ask',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === true
    );
    const pending = blocked.pending[0];
    assert.ok(pending);
    assert.equal(pending.questions?.length, 2);
    assert.equal(pending.questions?.[0]?.multiSelect, false);
    assert.equal(pending.questions?.[1]?.multiSelect, true);
    assert.equal(pending.canNote, false);
    assert.equal(pending.canReply, false);
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('accepted:')) {
        echoed = s.words;
      }
    });
    const took = handle.asks?.respond(pending.requestId, {
      allow: true,
      picks: [[0], [0]]
    });
    assert.equal(took, true);
    await until(
      handle,
      'accepted then idle',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running
    );
    assert.match(echoed, /"outcome":"accepted"/);
    assert.match(echoed, /Which route should we take\?/);
    assert.equal(
      handle.asks?.respond(pending.requestId, { allow: true, picks: [[0], [0]] }),
      false
    );
  });

  it('opens a permission as waiting and replies selected allow-once', async () => {
    const handle = start({ skipPermissions: false });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('perm');
    const blocked = await until(
      handle,
      'waiting on the permission',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === false
    );
    const pending = blocked.pending[0];
    assert.ok(pending);
    assert.equal(blocked.activeTool, undefined, 'permission is not a running tool');
    assert.equal(
      live.toSession(
        blocked,
        { pid: 7, startedAt: 1000, updatedAt: 2000, brand: 'grok' },
        'window-a'
      ).waitingFor,
      'permission prompt'
    );
    assert.equal(pending.toolName, 'Write');
    assert.match(pending.label ?? '', /probe-write\.txt/);
    assert.equal(pending.suggestions?.[0]?.where, 'this session only');
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('perm:')) {
        echoed = s.words;
      }
    });
    assert.equal(handle.asks?.respond(pending.requestId, { allow: true }), true);
    await until(
      handle,
      'allowed then idle',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running
    );
    assert.match(echoed, /"optionId":"allow-once"/);
    assert.equal(pending.input?.variant, 'Write');
    assert.equal(handle.asks?.respond(pending.requestId, { allow: true }), false);
  });

  it('replies selected allow-edits-session when always is set', async () => {
    const handle = start({ skipPermissions: false });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('perm');
    const blocked = await until(
      handle,
      'waiting on the permission',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === false
    );
    const pending = blocked.pending[0];
    assert.ok(pending);
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('perm:')) {
        echoed = s.words;
      }
    });
    assert.equal(handle.asks?.respond(pending.requestId, { allow: true, always: true }), true);
    await until(handle, 'always then idle', (s) => s.pending.length === 0 && !s.running);
    assert.match(echoed, /"optionId":"allow-edits-session"/);
  });

  it('auto-allows leftover permission when skip is on, preferring session-always', async () => {
    const handle = start({ skipPermissions: true });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    let waited = false;
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.status === 'waiting') {
        waited = true;
      }
      if (s.words.includes('perm:')) {
        echoed = s.words;
      }
    });
    handle.messages?.send('perm');
    await until(
      handle,
      'auto-allowed then idle',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running && echoed.includes('perm:')
    );
    assert.equal(waited, false);
    assert.match(echoed, /"optionId":"allow-edits-session"/);
  });

  it('auto-allows once when skip is on and the request has no always option', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    let waited = false;
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.status === 'waiting') {
        waited = true;
      }
      if (s.words.includes('perm:')) {
        echoed = s.words;
      }
    });
    handle.messages?.send('perm-once');
    await until(
      handle,
      'auto-once then idle',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running && echoed.includes('perm:')
    );
    assert.equal(waited, false);
    assert.match(echoed, /"optionId":"allow-once"/);
  });

  it('fails an unparseable permission instead of opening a dialog', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('failed:')) {
        echoed = s.words;
      }
      assert.equal(s.pending.length, 0, 'unparseable permission must not open waiting');
    });
    handle.messages?.send('perm-empty');
    await until(
      handle,
      'failed then idle',
      (s) =>
        s.status === 'idle' && s.pending.length === 0 && !s.running && echoed.includes('failed:')
    );
    assert.match(echoed, /Invalid params/);
  });

  it('replies selected reject-once on a permission deny', async () => {
    const handle = start({ skipPermissions: false });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('perm');
    const blocked = await until(
      handle,
      'waiting on the permission',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === false
    );
    const pending = blocked.pending[0];
    assert.ok(pending);
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('perm:')) {
        echoed = s.words;
      }
    });
    assert.equal(handle.asks?.respond(pending.requestId, { allow: false }), true);
    await until(handle, 'denied then idle', (s) => s.pending.length === 0 && !s.running);
    assert.match(echoed, /"optionId":"reject-once"/);
  });

  it('fails an unparseable ask instead of opening a dialog', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    let echoed = '';
    onThreadState(handle, (s) => {
      if (s.words.includes('failed:')) {
        echoed = s.words;
      }
      assert.equal(s.pending.length, 0, 'unparseable ask must not open waiting');
    });
    handle.messages?.send('ask-empty');
    await until(
      handle,
      'failed then idle',
      (s) =>
        s.status === 'idle' && s.pending.length === 0 && !s.running && echoed.includes('failed:')
    );
    assert.match(echoed, /Invalid params/);
  });

  it('reads session-dir chrome onto live, and a later file replaces it', async () => {
    const cwd = '/tmp/project';
    const id = 'g1';
    const dir = path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), id);
    await writeJson(path.join(dir, 'summary.json'), {
      session_summary: 'First title',
      current_model_id: 'grok-4.6'
    });
    await writeJson(path.join(dir, 'signals.json'), {
      contextWindowUsage: 7,
      contextWindowTokens: 500000
    });
    const handle = start();
    await until(
      handle,
      'first chrome',
      (s) => s.title === 'First title' && s.model === 'grok-4.6' && s.contextPct === 7
    );
    await writeJson(path.join(dir, 'summary.json'), {
      generated_title: 'Review the PR',
      current_model_id: 'grok-4.5'
    });
    await writeJson(path.join(dir, 'signals.json'), {
      contextWindowUsage: 12,
      contextWindowTokens: 500000
    });
    handle.messages?.send('Reply with exactly: pong.');
    const next = await until(
      handle,
      'refreshed chrome',
      (s) => s.title === 'Review the PR' && s.model === 'grok-4.5' && s.contextPct === 12
    );
    assert.equal(next.sessionId, id);
  });

  it('puts a pasted image on the prompt, not only the text', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('look', [{ mediaType: 'image/png', data: 'aaaa' }]);
    const done = await until(handle, 'the image reply', (s) => s.words.includes('saw-1-image'));
    assert.match(done.words, /saw-1-image/);
    await until(handle, 'idle after the image', (s) => s.status === 'idle' && !s.running);
  });

  it('interrupts a mid-turn prompt and stays up', async () => {
    const handle = start();
    handle.messages?.send('slow please');
    await until(handle, 'the thought', (s) => s.status === 'busy');
    await handle.turn?.interrupt();
    const done = await until(handle, 'idle after cancel', (s) => s.status === 'idle' && !s.running);
    assert.equal(done.exit, undefined);
    handle.messages?.send('after-cancel');
    const again = await until(handle, 'the next turn', (s) => s.words.includes('pong'));
    assert.match(again.words, /pong/);
    await until(handle, 'idle again', (s) => s.status === 'idle' && !s.running);
  });

  it('sendNow interrupts a running turn and drains the held message', async () => {
    const handle = start();
    handle.messages?.send('slow please');
    await until(handle, 'the thought', (s) => s.status === 'busy');
    handle.messages?.send('held-now');
    assert.equal(handle.state.queued.length, 1);
    await handle.messages?.sendNow();
    const done = await until(
      handle,
      'held message ran',
      (s) => s.queued.length === 0 && s.words.includes('pong')
    );
    assert.match(done.words, /pong/);
    await until(handle, 'idle after sendNow', (s) => s.status === 'idle' && !s.running);
  });

  it('drains the whole outbox as one prompt', async () => {
    const handle = start();
    handle.messages?.send('slow please');
    await until(handle, 'the thought', (s) => s.status === 'busy');
    handle.messages?.send('one');
    handle.messages?.send('two');
    assert.equal(handle.state.queued.length, 2);
    // `slow please` ends on a cancel and nothing else, so Send now is the only
    // idle edge available here.
    await handle.messages?.sendNow();
    const drained = await until(handle, 'both drained', (s) => s.queued.length === 0);
    assert.equal(drained.inFlight?.text, 'one\n\ntwo', 'one prompt, both messages in it');
    await until(handle, 'idle after the merged turn', (s) => s.status === 'idle' && !s.running);
  });

  it('sendNow drains a held message when busy is a latch, not a live turn', async () => {
    // Cancel is a notify and this prompt ignores it, so interrupt cannot
    // produce an idle edge — the outbox would sit forever without sendNow
    // ending the local turn. (01a02d08 was the product case; this fake is
    // the adapter latch, not a disk `turn_ended`.)
    const handle = start();
    handle.messages?.send('hang-busy');
    await until(handle, 'latched busy', (s) => s.status === 'busy');
    await handle.turn?.interrupt();
    assert.equal(handle.state.status, 'busy', 'cancel of a latch leaves us running');
    assert.equal(handle.state.running, true);
    handle.messages?.send('unstick-me');
    assert.equal(handle.state.queued.length, 1);
    await handle.messages?.sendNow();
    const done = await until(
      handle,
      'latched sendNow drained',
      (s) => s.queued.length === 0 && s.words.includes('pong')
    );
    assert.match(done.words, /pong/);
    await until(handle, 'idle after latched sendNow', (s) => s.status === 'idle' && !s.running);
  });

  // A turn Grok starts itself: a background command finishing wakes one, and
  // 1.0.5 gives it exactly one closer where a turn we sent has two (probe
  // 2026-08-25, `cli_state/grok/protocol.md` § Closing a self-started turn).
  describe('a turn Grok started itself', () => {
    it('goes busy on the wake and idles again when it closes', async () => {
      const handle = start();
      handle.messages?.send('self-started');
      await until(handle, 'our own turn done', (s) => s.status === 'idle' && !s.running);
      // The wake is a real turn. `busy` is the honest word while it streams —
      // this is not fixed by hiding it.
      await until(handle, 'the wake re-busies', (s) => s.running && s.words.includes('woke'));
      await until(handle, 'the wake closes', (s) => s.status === 'idle' && !s.running);
    });

    // The second defect, and it needs no dropped frame at all: `tryDrain` was
    // reachable only from `ready`, `send`, `respond`, `sendNow` and its own
    // tail, so a message queued during a wake sat there after the wake ended.
    // `ClaudeSession.handle` re-drains on every frame; this is that line.
    it('drains a message queued during a healthy wake, once it closes', async () => {
      const handle = start();
      handle.messages?.send('self-started');
      await until(handle, 'the wake is streaming', (s) => s.running && s.words.includes('woke'));
      handle.messages?.send('pong-please');
      const done = await until(
        handle,
        'held message went out on its own',
        (s) => s.queued.length === 0 && s.words.includes('pong')
      );
      assert.match(done.words, /pong/);
      await until(handle, 'idle after the drain', (s) => s.status === 'idle' && !s.running);
    });

    // The reported bug. The wake never emits `turn_completed`, so nothing on
    // the wire can idle the card: roster `idle` is filtered while
    // `writePending || running`, `prompt_complete` never fires for a wake, and
    // the queue opens the turn but never closes it. Before the fix this card
    // stayed busy and `canDrain` refused every queued message forever.
    it('recovers from a wake that never closes, without sendNow', async () => {
      const handle = start();
      handle.messages?.send('self-started-nofinish');
      await until(handle, 'the latch', (s) => s.running && s.words.includes('woke'));
      handle.messages?.send('unstick-me');
      assert.equal(handle.state.queued.length, 1);
      // No `sendNow`. The drain has to resume on its own, and the prompt it
      // writes is what gives the stuck turn its second closer.
      const done = await until(
        handle,
        'held message reached the wire',
        (s) => s.queued.length === 0 && s.words.includes('pong')
      );
      assert.match(done.words, /pong/);
      await until(handle, 'idle again', (s) => s.status === 'idle' && !s.running);
    });

    // The predecessor's outbox regression, asserted rather than assumed. A card
    // idled while its drain is still locked paints the held message as *sent*
    // with no outbox block and no Send-now button (`webview/chat.ts`), which is
    // worse than the latch. Two halves: the card stays `busy` while the wake
    // holds the message, so the block is drawn; and once it recovers the lock
    // is genuinely gone, so a *second* message goes out too.
    it('keeps the outbox honest through a latch and after it', async () => {
      const handle = start();
      handle.messages?.send('self-started-nofinish');
      await until(handle, 'the latch', (s) => s.running && s.words.includes('woke'));
      handle.messages?.send('unstick-me');
      // Busy with one held: `queues` is true in chat.ts, so `draining` is false
      // and the block with its Send-now button is drawn. Never idle-with-held.
      assert.equal(handle.state.status, 'busy');
      assert.equal(handle.state.queued.length, 1);
      await until(handle, 'first drained', (s) => s.queued.length === 0);
      await until(handle, 'idle again', (s) => s.status === 'idle' && !s.running);
      // If the fix had left `writePending` stuck, this one would never move.
      handle.messages?.send('second-one');
      const done = await until(
        handle,
        'second message drained too',
        (s) => s.queued.length === 0 && s.status === 'idle' && !s.running
      );
      assert.equal(done.queued.length, 0);
    });

    // Finding 1 of the peer review, and the reason `closesSomeoneElsesTurn`
    // exists. `endTurn` clears `inFlight` whenever a turn was running, which
    // was safe only while `canDrain` refused to take a message unless idle —
    // the premise `canWrite` deliberately breaks. Without the guard, the
    // wake's `turn_completed` wipes the `inFlight` of a message we drained
    // behind it and idles the card while the drain is still locked: `sending`
    // goes falsy, `draining` goes true, and the next held message paints as
    // *sent* with no outbox block. Live that window is our whole prompt,
    // because Grok runs ours only once the wake has finished.
    it('holds the card busy across the wake handoff, drain still locked', async () => {
      const handle = start();
      handle.messages?.send('self-started');
      await until(handle, 'the wake is streaming', (s) => s.running && s.words.includes('woke'));
      handle.messages?.send('m1');
      handle.messages?.send('m2');
      // The gate opens mid-wake and takes m1; the fake queues it behind the
      // wake exactly as 1.0.5 does, so m1 is answered only after the handoff.
      await until(handle, 'm1 taken by the drain', (s) => s.inFlight !== undefined);
      const bad: string[] = [];
      // **Scoped to the handoff, and stopped at m1's own answer.** Our *own*
      // `turn_completed` lands 1-8 ms ahead of the RPC result (protocol.md
      // § Order), and in that window `endTurn` clears `inFlight` with m2 still
      // held — the same shape, on a turn we started, and pre-existing:
      // `core/live.ts` names it for Claude and this fix neither causes nor
      // closes it. `answered` ends the watch before it, because the frames
      // after the reply arrive in one stdout chunk and are applied before an
      // `await` here can resume.
      let answered = false;
      const stop = onThreadState(handle, (s) => {
        if (s.words.includes('pong')) {
          answered = true;
        }
        if (!answered && s.inFlight === undefined && s.status === 'idle' && s.queued.length > 0) {
          bad.push(`idle with ${s.queued.length} held and nothing in flight`);
        }
      });
      const done = await until(handle, 'm1 answered', (s) => s.words.includes('pong'));
      stop();
      assert.deepEqual(bad, [], 'card idled while its drain was still locked');
      assert.equal(done.words, 'pong', "the wake's words leaked into our reply");
      const shot = handle.thread.snapshot();
      assert.ok(shot.tail.length <= 1, 'the wake left a second streaming row');
      assert.ok(
        shot.recent.exchanges.some((row) => 'role' in row && row.text === 'woke'),
        'the wake is closed in history'
      );
      assert.ok(!shot.tail.some((row) => row.exchange.text.includes('woke')));
    });

    // Finding 4. The two halves of the fix cover each other everywhere the
    // queue names the running turn, so nothing isolated the re-drain line.
    // A wake that names its turn nowhere is where it alone can help: the gate
    // stays shut because no frame ever says the turn is foreign, and only a
    // `tryDrain` on the closing frame gets the outbox moving again. It is
    // also the monitor/hook shape (`reduce.ts`, session 01a00dcb).
    it('drains after an unannounced wake, which only the re-drain can rescue', async () => {
      const handle = start();
      handle.messages?.send('self-started-noqueue');
      await until(handle, 'the wake is streaming', (s) => s.running && s.words.includes('woke'));
      handle.messages?.send('after-the-wake');
      // Nothing named this turn, so the gate is shut and the message waits.
      assert.equal(handle.state.queued.length, 1);
      const done = await until(
        handle,
        'drained on the closing frame alone',
        (s) => s.queued.length === 0 && s.words.includes('pong')
      );
      assert.match(done.words, /pong/);
    });

    // Findings 2 and 3. The gate must refuse a turn of **ours** even when the
    // CLI has left it running — that is the predecessor's competing latch,
    // out of scope here, and `sendNow` is its escape. This is also the only
    // test that can see `_meta.promptId` disappear: drop it and the queue's
    // Grok-minted id reads as foreign, the gate opens, and the message goes
    // out on a turn we started.
    it('refuses a turn of ours the CLI left running after its result', async () => {
      const handle = start();
      handle.messages?.send('late-rebusy');
      // Wait for the turn to be *over*, not merely answered: the reply streams
      // before the roster idle and the RPC result, so a message queued on the
      // text alone is held by `writePending` and drains for the ordinary
      // reason — which tests nothing.
      await until(handle, 'turn fully over', (s) => s.status === 'idle' && !s.running);
      await until(
        handle,
        're-busied by a late frame',
        (s) => s.running && s.activeTool === 'late-work'
      );
      handle.messages?.send('must-wait');
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(handle.state.queued.length, 1, 'our own turn still holds the outbox');
      assert.equal(handle.state.running, true);
      // And the escape hatch still works on it.
      await handle.messages?.sendNow();
      await until(handle, 'sendNow drained it', (s) => s.queued.length === 0);
    });

    // Step 1's whole product: the running turn is ours or it is not, decided
    // by `_meta.promptId` against `sentPrompts`. On a healthy wire both halves
    // are redundant — `writePending` covers our turn, and `turn_completed`
    // clears the queue's running id on the way out. They earn their place in
    // the one case this whole file exists for: **a `turn_completed` that never
    // arrives**, here on a turn of ours. Nothing then clears the running id,
    // so a client that could not recognise its own would call its own turn
    // foreign and open the drain gate on it — the one thing the gate must
    // never do.
    it("still knows its own turn when that turn's close is the one lost", async () => {
      const handle = start();
      handle.messages?.send('late-rebusy-lost');
      await until(handle, 'turn fully over', (s) => s.status === 'idle' && !s.running);
      await until(
        handle,
        're-busied by a late frame',
        (s) => s.running && s.activeTool === 'late-work'
      );
      handle.messages?.send('must-wait');
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(handle.state.queued.length, 1, 'the still-named turn is ours, not a wake');
      assert.equal(handle.state.running, true);
    });

    // **This one pins the order of the two checks, not the gate.**
    // `hang-busy` never resolves its RPC, so `tryDrain` returns at
    // `writePending` before `canWrite` is ever called — no change to the gate
    // can make it red, and it is kept for the ordering rather than billed as
    // a gate test. The gate's own shut direction is the two tests above.
    it('does not drain through a latched turn of our own', async () => {
      const handle = start();
      handle.messages?.send('hang-busy');
      await until(handle, 'latched busy', (s) => s.status === 'busy');
      handle.messages?.send('still-held');
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(handle.state.queued.length, 1, 'our own turn still holds the outbox');
      assert.equal(handle.state.running, true);
      assert.equal(handle.state.status, 'busy');
    });
  });

  it('interrupts a waiting ask and drops the dialog', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('ask');
    await until(
      handle,
      'waiting on the ask',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === true
    );
    await handle.turn?.interrupt();
    const done = await until(
      handle,
      'idle after cancel of ask',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running
    );
    assert.equal(done.exit, undefined);
  });

  it('interrupts a waiting permission and drops the dialog', async () => {
    const handle = start({ skipPermissions: false });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('perm');
    await until(
      handle,
      'waiting on the permission',
      (s) => s.status === 'waiting' && s.pending[0]?.ask === false
    );
    await handle.turn?.interrupt();
    const done = await until(
      handle,
      'idle after cancel of permission',
      (s) => s.status === 'idle' && s.pending.length === 0 && !s.running
    );
    assert.equal(done.exit, undefined);
  });
});

// Roster `working` busies the card without naming a turn, so roster `idle` is
// its only closer. 1.0.62 sent no roster frame before a prompt in five starts
// (protocol.md § Handshake); a first send must still not strand behind one.
describe('roster activity owned by no turn', () => {
  const roster = (wire: Wire, activity: 'working' | 'idle'): void =>
    wire.emit({
      jsonrpc: '2.0',
      method: '_x.ai/sessions/changed',
      params: { upserted: [{ sessionId: wire.id, activity }], removed: [] }
    });

  it('lets the first send through after a working/idle pair', async () => {
    const { wire, handle } = await opened();
    roster(wire, 'working');
    roster(wire, 'idle');
    await sent(wire, handle, 'first words');
  });

  it('keeps a turn the roster did not open busy through roster idle', async () => {
    const { wire, handle } = await opened();
    wire.chunk('woke', 1);
    await until(handle, 'the wake busies the card', (s) => s.running);
    roster(wire, 'idle');
    await tick(20);
    assert.equal(handle.state.running, true);
  });
});

describe('Grok startup briefing', () => {
  it('declares a deterministic extend profile before stdio in both permission modes', () => {
    const cli = adapter.adapter('grok');
    assert.ok(cli);
    for (const skipPermissions of [false, true]) {
      const options = { bin: executables.named('/bin/grok'), cwd: '/tmp', skipPermissions };
      const plain = cli.launch(options);
      assert.equal(plain.files, undefined);
      assert.ok(!plain.args.includes('--agent-profile'));
      const launch: Launch = cli.launch({ ...options, briefing: 'startup instructions' });
      const same = cli.launch({ ...options, briefing: 'startup instructions' });
      const different = cli.launch({ ...options, briefing: 'changed instructions' });
      const file = launch.files?.[0];
      assert.ok(file);
      assert.match(file.content, /promptMode: extend/);
      assert.ok(file.content.endsWith('startup instructions\n'));
      assert.deepEqual(
        [...launch.args],
        [...plain.args.slice(0, -1), '--agent-profile', file.path, 'stdio']
      );
      assert.equal(same.files?.[0]?.path, file.path);
      assert.notEqual(different.files?.[0]?.path, file.path);
    }
  });
});

describe('pickAuth', () => {
  it('takes the first non-interactive method, not grok.com', () => {
    assert.equal(
      pickAuth({
        authMethods: [{ id: 'grok.com' }, { id: 'cached_token' }],
        _meta: { defaultAuthMethodId: 'grok.com' }
      }),
      'cached_token'
    );
  });

  it('honours a non-interactive defaultAuthMethodId', () => {
    assert.equal(
      pickAuth({
        authMethods: [{ id: 'other' }, { id: 'cached_token' }],
        _meta: { defaultAuthMethodId: 'cached_token' }
      }),
      'cached_token'
    );
  });

  it('refuses when every method is interactive', () => {
    assert.equal(pickAuth({ authMethods: [{ id: 'grok.com' }] }), undefined);
  });
});
