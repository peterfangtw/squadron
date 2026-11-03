import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import { after, before, describe, it } from 'node:test';

let WARM_PROMPT: (typeof import('../../core/coordination/send'))['WARM_PROMPT'];

let DEFAULT_WARM_POLICY: (typeof import('../../core/warm_policy'))['DEFAULT_WARM_POLICY'];

import {
  adapter,
  alive,
  converged,
  dispose,
  drawn,
  Grok,
  GrokSession,
  live,
  opened,
  record,
  sent,
  setup,
  tick,
  until,
  Wire
} from './grok_session_helpers';

before(async () => {
  await setup();
  ({ WARM_PROMPT } = await import('../../core/coordination/send'));
  ({ DEFAULT_WARM_POLICY } = await import('../../core/warm_policy'));
});

after(dispose);

describe('a Grok session on its thread', () => {
  describe('a cache-warming ping', () => {
    async function warmSession(): Promise<{ wire: Wire; handle: Grok }> {
      const fixture = await opened();
      fixture.handle.state.contextPct = 10;
      return fixture;
    }

    type Prompt = { id: unknown; promptId: string; text: string };
    for (const maintenance of [false, true]) {
      for (const stop of ['end_turn', 'error', 'cancelled']) {
        it(`owns ${maintenance ? 'warm' : 'real'} ${stop} as the first notification before prompt response`, async () => {
          const { wire, handle } = await warmSession();
          const prompt = maintenance
            ? pinged(wire, handle)
            : await sent(wire, handle, 'real input');
          const id = handle.state.warmTurn?.id;
          const pending = handle.state;
          wire.completed('foreign', 'error', 'foreign diagnostic');
          assert.equal(handle.state, pending);
          wire.completed(
            prompt.promptId,
            stop,
            stop === 'error' ? 'matching diagnostic' : undefined
          );
          wire.reply(prompt, { stopReason: stop });
          await until(handle, 'matching completion closes', (s) => !s.running);
          for (const view of await projected(handle, wire)) {
            const foreign = view.exchanges.find(
              (x) => 'role' in x && x.text === 'foreign diagnostic'
            );
            assert.ok(foreign && 'role' in foreign && foreign.maintenance === false);
            if (stop === 'error') {
              const row = view.exchanges.find(
                (x) => 'role' in x && x.text === 'matching diagnostic'
              );
              assert.ok(row && 'role' in row);
              assert.equal(row.maintenance === true, maintenance);
              assert.equal(row.warmId, id);
            }
          }
          if (maintenance)
            assert.equal(handle.state.warmTurn?.failed === true, stop !== 'end_turn');
        });
      }
    }
    const PERMISSION = {
      toolCall: {
        toolCallId: 'call-warm-1',
        kind: 'edit',
        title: 'Write `/tmp/warm.txt`',
        rawInput: { variant: 'Write', file_path: '/tmp/warm.txt', content: 'x\n' }
      },
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'No', kind: 'reject_once' }
      ]
    };
    const QUESTION = {
      toolCallId: 'call-warm-ask',
      questions: [
        {
          question: 'Which?',
          options: [{ label: 'Left' }, { label: 'Right' }],
          multiSelect: false
        }
      ],
      mode: 'default'
    };

    /** The ping, which admission put on the wire before `ping` returned. */
    function pinged(wire: Wire, handle: Grok): Prompt {
      const before = wire.prompts().length;
      assert.deepEqual(handle.warm?.ping(), { ok: true });
      const prompt = wire.prompts()[before];
      assert.ok(prompt, 'written synchronously');
      assert.match(prompt.text, /<squadron-warm>/);
      return prompt;
    }

    const cancels = (wire: Wire) =>
      wire.written.filter((message) => message.method === 'session/cancel').length;
    const answerTo = (wire: Wire, id: number) =>
      wire.written.find((message) => message.id === id && message.method === undefined);
    const pings = (wire: Wire) =>
      wire.prompts().filter((prompt) => /<squadron-warm>/.test(prompt.text)).length;

    async function written(wire: Wire, count: number): Promise<Prompt> {
      for (let i = 0; i < 200 && wire.prompts().length < count; i++) await tick(5);
      const prompt = wire.prompts()[count - 1];
      assert.ok(prompt, `prompt ${String(count)} never reached the wire`);
      return prompt;
    }

    /** Every state the card was handed, so a transient one is not missed. */
    function states(handle: Grok): Grok['state'][] {
      const seen: Grok['state'][] = [];
      handle.onChange((state) => seen.push(state));
      return seen;
    }

    it('dates reply-only completion once, publishes its cache and schedules the second deadline', async () => {
      const { wire, handle } = await warmSession();
      let cacheAt = 1000;
      let prior = false;
      handle.onChange((state, origin, cacheTraffic) => {
        if (
          adapter.advancesCacheClock({
            origin,
            running: state.running,
            wasRunning: prior,
            cacheTraffic
          })
        )
          cacheAt = Date.now();
        prior = state.running;
      });
      const ping = pinged(wire, handle);
      wire.reply(ping, { stopReason: 'end_turn' });
      await until(handle, 'reply-only warm end', (s) => s.warmTurn?.phase === 'closed');
      assert.ok(cacheAt > 1000);
      const published = live.toSession(
        handle.state,
        {
          pid: 1,
          brand: 'grok',
          startedAt: 1000,
          updatedAt: cacheAt - 10 * 60000,
          cacheAt,
          warm: true,
          warmSupported: true
        },
        'window'
      );
      assert.equal(published.status, 'idle');
      assert.equal(published.cache?.at, cacheAt);
      const policy = await import('../../core/warm');
      assert.equal(
        policy.warmDue(published, published.warmPort, undefined, cacheAt, DEFAULT_WARM_POLICY)
          .nextAt,
        cacheAt + DEFAULT_WARM_POLICY.ttlMs.grok - DEFAULT_WARM_POLICY.marginMs
      );
      const saved = cacheAt;
      wire.completed(ping.promptId, 'end_turn', undefined, 0, 32000);
      assert.equal(cacheAt, saved, 'late usage is evidence, not another completion');
      assert.equal(live.warmVerdict(handle.state.warmTurn!), 'miss');
      assert.equal(handle.state.warmTurn?.prefix, 32000);
      await converged(wire, handle);
      const raw = await record.readRecord(handle.state.sessionId!);
      const input = raw?.exchanges.find((x) => 'role' in x && x.role === 'warm');
      assert.ok(input && 'warmEvidence' in input && input.warmEvidence?.trafficAt);
      assert.equal(
        await record.recordedActivityAt(handle.state.sessionId!, { includeWarm: true }),
        input.warmEvidence.trafficAt
      );
    });

    it('uses turn-correlated input evidence before completion to stop tiny-prefix warming', async () => {
      const { wire, handle } = await warmSession();
      const ping = pinged(wire, handle);
      wire.running(ping.promptId);
      wire.completed(ping.promptId, 'end_turn', undefined, 1024, 32000);
      assert.equal(live.warmVerdict(handle.state.warmTurn!), 'miss');
      wire.reply(ping, { stopReason: 'end_turn' });
      await until(handle, 'cold ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.equal(live.warmVerdict(handle.state.warmTurn!), 'miss');
    });

    it('keeps the card idle and its activity still, warms the cache clock, and keeps red', async () => {
      const { wire, handle } = await warmSession();
      const red = await sent(wire, handle, 'one that fails');
      wire.fail(red, { code: -32603, message: 'boom' });
      await until(handle, 'the red turn', (s) => !s.running && s.lastOutcome === 'error');

      let cacheAt = 1000;
      let wasRunning = handle.state.running;
      let activity = 0;
      const shown: string[] = [];
      const moves = (origin: Parameters<typeof adapter.advancesCacheClock>[0]['origin']) => {
        const state = handle.state;
        if (
          adapter.advancesActivityClock({
            origin,
            status: state.status,
            turned: true,
            warm: state.warmTurn !== undefined
          })
        )
          activity++;
      };
      handle.onChange((state, origin, cacheTraffic) => {
        shown.push(live.shownStatus(state));
        moves(origin);
        if (
          adapter.advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic })
        )
          cacheAt++;
        wasRunning = state.running;
      });
      handle.onActivity(() => {
        moves('agent');
        if (
          adapter.advancesCacheClock({ origin: 'agent', running: handle.state.running, wasRunning })
        )
          cacheAt++;
      });

      const ping = pinged(wire, handle);
      assert.equal(handle.state.warmTurn?.phase, 'written');
      assert.equal(cacheAt, 1000, 'a write is not traffic');
      wire.running(ping.promptId);
      wire.chunk('OK', 300, ping.promptId);
      assert.equal(handle.state.warmTurn?.phase, 'open');
      assert.ok(cacheAt > 1000, 'its reply is');
      wire.completed(ping.promptId, 'end_turn', undefined, 900);
      wire.reply(ping, { stopReason: 'end_turn' });
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');

      assert.equal(handle.state.warmTurn?.failed, undefined);
      assert.equal(handle.state.warmTurn?.cached, 900);
      assert.equal(handle.state.lastOutcome, 'error', 'a ping does not clear red');
      assert.equal(activity, 0, 'nothing a reader did');
      assert.deepEqual([...new Set(shown)], ['idle']);
      await converged(wire, handle);
      assert.ok(drawn(handle).includes(`warm: ${WARM_PROMPT}`), drawn(handle).join('\n'));
    });

    it('writes warm pings regardless of context usage', async () => {
      for (const pct of [undefined, -1, NaN, Infinity, 80, 100]) {
        const { wire, handle } = await warmSession();
        handle.state.contextPct = pct;
        const ping = pinged(wire, handle);
        assert.equal(pings(wire), 1);
        wire.reply(ping, { stopReason: 'end_turn' });
        await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      }
    });

    it('is refused with no conversation, a turn running, an ask open, or a message held', async () => {
      const early = new Wire();
      const fresh = new GrokSession(early.transport, { cwd: '/tmp/project', startedAt: 1 });
      alive.push(fresh);
      assert.deepEqual(fresh.warm?.ping(), {
        ok: false,
        reason: 'The session has no conversation to keep warm.'
      });
      await fresh.opening;

      const { wire, handle } = await warmSession();
      await sent(wire, handle, 'a turn of its own');
      assert.deepEqual(handle.warm?.ping(), { ok: false, reason: 'The session is not idle.' });
      wire.emit({
        jsonrpc: '2.0',
        id: 41,
        method: '_x.ai/ask_user_question',
        params: { sessionId: wire.id, ...QUESTION }
      });
      await until(handle, 'the ask', (s) => s.status === 'waiting');
      assert.equal(handle.warm?.ping().ok, false, 'an ask is open');
      handle.messages.send('held behind it');
      assert.deepEqual(handle.warm?.ping(), {
        ok: false,
        reason: 'A message is waiting to be sent.'
      });
      assert.equal(pings(wire), 0);
    });

    it('holds a message sent during it, and sends that once it closes', async () => {
      const { wire, handle } = await warmSession();
      const ping = pinged(wire, handle);
      assert.deepEqual(handle.warm?.ping(), { ok: false, reason: 'The session is not idle.' });
      handle.messages.send('after the ping');
      await tick(20);
      assert.equal(wire.prompts().length, 1, 'nothing is written onto a ping');
      assert.equal(handle.state.queued.length, 1);
      wire.chunk('OK', 300, ping.promptId);
      wire.completed(ping.promptId, 'end_turn');
      wire.reply(ping, { stopReason: 'end_turn' });
      assert.equal((await written(wire, 2)).text, 'after the ping');
      assert.equal(handle.state.warmTurn, undefined, 'a real turn clears the latch');
    });

    it('denies a permission it asks, with approval on, and never shows it', async () => {
      const { wire, handle } = await warmSession();
      const seen = states(handle);
      const ping = pinged(wire, handle);
      wire.running(ping.promptId);
      wire.emit({
        jsonrpc: '2.0',
        id: 51,
        method: 'session/request_permission',
        params: { sessionId: wire.id, ...PERMISSION }
      });
      await tick(10);
      assert.match(JSON.stringify(answerTo(wire, 51)?.result), /reject-once/);
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(cancels(wire), 1);
      wire.completed(ping.promptId, 'cancelled');
      wire.reply(ping, { stopReason: 'cancelled' });
      await until(handle, 'the cut ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.ok(seen.every((s) => s.pending.length === 0 && s.status !== 'waiting'));
    });

    it('fails a question it asks, and never shows it', async () => {
      const { wire, handle } = await warmSession();
      const seen = states(handle);
      const ping = pinged(wire, handle);
      wire.emit({
        jsonrpc: '2.0',
        id: 52,
        method: '_x.ai/ask_user_question',
        params: { sessionId: wire.id, ...QUESTION }
      });
      await tick(10);
      assert.ok(answerTo(wire, 52)?.error, 'the RPC is failed, not answered');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(cancels(wire), 1);
      wire.reply(ping, { stopReason: 'cancelled' });
      await until(handle, 'the cut ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.ok(seen.every((s) => s.pending.length === 0 && s.status !== 'waiting'));
    });

    it('cuts a ping that reaches for a tool, keeps the call, and holds the pipe until it ends', async () => {
      const { wire, handle } = await warmSession();
      const ping = pinged(wire, handle);
      wire.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-warm-tool',
        title: 'Read the notes',
        rawInput: { variant: 'Read' }
      });
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(cancels(wire), 1);
      wire.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-warm-tool' });
      assert.equal(cancels(wire), 1, 'one cancel for one ping');
      assert.equal(handle.warm?.ping().ok, false, 'still its turn');
      handle.messages.send('waits for the close');
      await tick(20);
      assert.equal(wire.prompts().length, 1);
      wire.completed(ping.promptId, 'cancelled');
      wire.reply(ping, { stopReason: 'cancelled' });
      assert.equal((await written(wire, 2)).text, 'waits for the close');
      assert.match(JSON.stringify(handle.thread.snapshot()), /Read the notes/);
    });

    it('closes failed, and off the cache clock, when its write never leaves', async () => {
      const { wire, handle } = await warmSession();
      let cacheAt = 1000;
      let wasRunning = handle.state.running;
      handle.onChange((state, origin, cacheTraffic) => {
        if (
          adapter.advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic })
        )
          cacheAt++;
        wasRunning = state.running;
      });
      wire.refuse = true;
      assert.deepEqual(handle.warm?.ping(), { ok: true });
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(cacheAt, 1000);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), []);
    });

    it('is cut by Send now, which sends the held message', async () => {
      const { wire, handle } = await warmSession();
      const seen = states(handle);
      const ping = pinged(wire, handle);
      wire.chunk('O', 300, ping.promptId);
      handle.messages.send('urgent');
      await handle.messages.sendNow?.();
      assert.equal(cancels(wire), 1);
      assert.ok(seen.some((s) => s.warmTurn?.phase === 'closed' && s.warmTurn.failed === true));
      assert.equal((await written(wire, 2)).text, 'urgent');
      wire.reply(ping, { stopReason: 'cancelled' });
      await tick(10);
      assert.equal(handle.state.warmTurn, undefined);
    });

    it('closes failed when the child exits under it', async () => {
      const { wire, handle } = await warmSession();
      const ping = pinged(wire, handle);
      wire.chunk('O', 300, ping.promptId);
      wire.exit();
      await until(handle, 'the exit', (s) => s.exit !== undefined);
      assert.equal(handle.state.warmTurn?.phase, 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
    });

    for (const stage of [
      'real-running',
      'real-idle',
      'warm-running',
      'second-real-running',
      'second-real-idle'
    ]) {
      it(`retains W1 accounting without live publication at ${stage} on late completion`, async () => {
        const { wire, handle } = await warmSession();
        const first = pinged(wire, handle);
        wire.reply(first, { stopReason: 'end_turn' });
        await until(handle, 'W1 reply closes', (s) => s.warmTurn?.phase === 'closed');
        const real = await sent(wire, handle, 'real R');
        wire.running(real.promptId);
        wire.chunk('real answer', 100, real.promptId);
        if (stage !== 'real-running') {
          wire.reply(real, { stopReason: 'error' });
          await until(handle, 'R closes', (s) => !s.running);
          await tick();
        }
        let second: Prompt | undefined;
        let nextReal: Prompt | undefined;
        if (stage === 'warm-running' || stage.startsWith('second')) {
          second = pinged(wire, handle);
          if (stage.startsWith('second')) {
            wire.reply(second, { stopReason: 'end_turn' });
            await until(handle, 'W2 closes', (s) => !s.running);
            await tick();
            nextReal = await sent(wire, handle, 'real S');
            wire.running(nextReal.promptId);
            if (stage.endsWith('idle')) {
              wire.reply(nextReal, { stopReason: 'error' });
              await until(handle, 'S closes', (s) => !s.running);
              await tick();
            }
          }
        }
        const before = handle.state;
        let updatedAt = 1000;
        let cacheAt = 2000;
        let prior = before.running;
        let publications = 0;
        handle.onChange((state, origin, cacheTraffic) => {
          publications++;
          if (
            adapter.advancesActivityClock({
              origin,
              status: state.status,
              turned: true,
              warm: state.warmTurn !== undefined
            })
          )
            updatedAt++;
          if (
            adapter.advancesCacheClock({
              origin,
              running: state.running,
              wasRunning: prior,
              cacheTraffic
            })
          )
            cacheAt++;
          prior = state.running;
        });
        handle.onActivity(() => {
          publications++;
        });
        wire.completed(first.promptId, 'error', undefined, 0, 32000);
        assert.deepEqual(handle.state, before, 'historical completion preserves all current state');
        assert.deepEqual(
          { updatedAt, cacheAt, publications },
          { updatedAt: 1000, cacheAt: 2000, publications: 0 }
        );
        wire.promptComplete(first.promptId, 'error', null);
        if (stage === 'warm-running' && second) wire.reply(second, { stopReason: 'end_turn' });
        if (stage.endsWith('running') && stage !== 'warm-running')
          wire.reply(nextReal ?? real, { stopReason: 'end_turn' });
        await until(handle, 'all current work closes', (s) => !s.running);
        await tick();
        handle.close();
        await converged(wire, handle);
        const persisted = (await record.readRecord(wire.id))?.exchanges;
        assert.ok(persisted);
        for (const rows of [handle.thread.snapshot().history.exchanges, persisted]) {
          const pings = rows.filter((x) => 'role' in x && x.role === 'warm');
          const old = pings[0];
          assert.ok(old && 'warmEvidence' in old && old.warmEvidence?.trafficAt);
          assert.equal(old.warmEvidence.cached, 0);
          assert.equal(live.warmVerdict(old.warmEvidence), 'miss');
          if (second) {
            const newer = pings[1];
            assert.ok(newer && 'warmEvidence' in newer);
            assert.equal(newer.warmEvidence?.cached, undefined);
          }
        }
      });
    }

    for (const late of ['text', 'tool', 'close', 'echo']) {
      it(`isolates named historical ${late} from W2's unlabelled open row`, async () => {
        const { wire, handle } = await warmSession();
        const first = pinged(wire, handle);
        wire.reply(first, { stopReason: 'end_turn' });
        await until(handle, 'W1 closes', (s) => !s.running);
        const real = await sent(wire, handle, 'real R');
        wire.reply(real, { stopReason: 'end_turn' });
        await until(handle, 'R closes', (s) => !s.running);
        await tick();
        const second = pinged(wire, handle);
        wire.chunk('new ', 200);
        const before = handle.state;
        if (late === 'text') wire.chunk('old reply', 100, first.promptId);
        else if (late === 'tool')
          wire.update(
            {
              sessionUpdate: 'tool_call',
              toolCallId: 'old-tool',
              title: 'Read',
              rawInput: { path: '/tmp/old' }
            },
            { promptId: first.promptId }
          );
        else if (late === 'echo')
          wire.update(
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: first.text },
              _meta: { promptIndex: 17 }
            },
            { promptId: first.promptId }
          );
        else wire.completed(first.promptId, 'end_turn', undefined, 900, 1000);
        assert.deepEqual(handle.state, before);
        wire.chunk('reply', 200);
        wire.reply(second, { stopReason: 'end_turn' });
        await until(handle, 'W2 closes', (s) => !s.running);
        handle.close();
        await converged(wire, handle);
        const persisted = (await record.readRecord(wire.id))?.exchanges;
        assert.ok(persisted);
        for (const rows of [handle.thread.snapshot().history.exchanges, persisted]) {
          const current = rows.find((x) => 'role' in x && x.text === 'new reply');
          assert.ok(current && 'role' in current && current.maintenance === true);
          assert.equal(current.blocks?.filter((b) => 'call' in b).length, 0);
          if (late === 'echo') {
            const warm = rows.filter((x) => 'role' in x && x.role === 'warm');
            assert.equal(warm.length, 2);
          } else if (late !== 'close') {
            const old = rows.find(
              (x) =>
                'role' in x &&
                (late === 'text'
                  ? x.text === 'old reply'
                  : x.blocks?.some((b) => 'call' in b && b.call.id === 'old-tool'))
            );
            assert.ok(old && 'role' in old && old.maintenance === true);
          }
        }
        if (late === 'echo') {
          const raw = (await fs.readFile(record.recordFile(wire.id), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          const warm = raw.filter((line) => line.role === 'warm');
          assert.equal(warm[1]?.m, undefined, 'W1 cannot witness W2 with its ordinal');
        }
      });
    }

    for (const nextPing of [false, true]) {
      it(`rejects named historical warm callbacks with ${nextPing ? 'W2 running' : 'real work idle'}`, async () => {
        const { wire, handle } = await warmSession();
        const first = pinged(wire, handle);
        wire.reply(first, { stopReason: 'end_turn' });
        await until(handle, 'W1 closes', (s) => !s.running);
        const real = await sent(wire, handle, 'real R');
        wire.reply(real, { stopReason: 'end_turn' });
        await until(handle, 'R closes', (s) => !s.running);
        await tick();
        const second = nextPing ? pinged(wire, handle) : undefined;
        const before = handle.state;
        wire.emit({
          jsonrpc: '2.0',
          id: 61,
          method: 'session/request_permission',
          params: { sessionId: wire.id, _meta: { promptId: first.promptId }, ...PERMISSION }
        });
        wire.emit({
          jsonrpc: '2.0',
          id: 62,
          method: '_x.ai/ask_user_question',
          params: { sessionId: wire.id, _meta: { promptId: first.promptId }, ...QUESTION }
        });
        assert.deepEqual(handle.state, before);
        assert.equal(cancels(wire), 0);
        assert.match(JSON.stringify(answerTo(wire, 61)?.result), /reject-once/);
        assert.ok(answerTo(wire, 62)?.error);
        if (second) wire.reply(second, { stopReason: 'end_turn' });
        handle.close();
        await handle.flush();
      });
    }

    async function projected(handle: Grok, wire: Wire): Promise<ThreadView[]> {
      const views = await import('../../ui/views');
      const { toolView } = await import('../../ui/activity');
      const { Conversation } = await import('../../core/thread');
      handle.close();
      await converged(wire, handle);
      const saved = await record.readRecordLines(wire.id);
      assert.ok(saved);
      const recovered = new Conversation(wire.id, 0, { cwd: '/tmp/project', brand: 'grok' });
      await recovered.recover(() =>
        Promise.resolve({ lines: saved.lines, partial: false, ours: true })
      );
      return [handle.thread.snapshot(), recovered.snapshot()].map((shot) =>
        views.composeThread(
          live.toSession(
            handle.state,
            { pid: 4343, brand: 'grok', startedAt: 1, updatedAt: 1 },
            'w'
          ),
          {
            history: {
              exchanges: shot.history.exchanges.map((x) =>
                'role' in x
                  ? {
                      ...x,
                      blocks: (x.blocks ?? [{ text: x.text }]).map((b) =>
                        'text' in b ? { prose: b.text } : toolView(b.call)
                      )
                    }
                  : x
              )
            },
            live: handle.state
          },
          {}
        )
      );
    }

    for (const existing of [false, true]) {
      it(`keeps named old real tool receipts out of W2 with ${existing ? 'existing' : 'first-seen'} rows`, async () => {
        const { wire, handle } = await warmSession();
        const first = pinged(wire, handle);
        wire.reply(first, { stopReason: 'end_turn' });
        await until(handle, 'W1 closes', (s) => !s.running);
        const real = await sent(wire, handle, 'real R');
        if (existing)
          wire.update(
            { sessionUpdate: 'tool_call', toolCallId: 'real-tool', title: 'Read' },
            { promptId: real.promptId }
          );
        wire.chunk('real prose', 100, real.promptId);
        wire.reply(real, { stopReason: 'end_turn' });
        await until(handle, 'R closes', (s) => !s.running);
        await tick();
        const second = pinged(wire, handle);
        const before = handle.state;
        let changes = 0;
        let activity = 0;
        let clocks = 0;
        handle.onChange((state, origin, cacheTraffic) => {
          changes++;
          if (
            adapter.advancesActivityClock({
              origin,
              status: state.status,
              turned: true,
              warm: state.warmTurn !== undefined
            }) ||
            adapter.advancesCacheClock({
              origin,
              running: state.running,
              wasRunning: before.running,
              cacheTraffic
            })
          )
            clocks++;
        });
        handle.onActivity(() => activity++);
        if (!existing)
          wire.update(
            { sessionUpdate: 'tool_call', toolCallId: 'real-tool', title: 'Read' },
            { promptId: real.promptId }
          );
        wire.update(
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'real-tool',
            status: 'completed',
            rawOutput: 'real result'
          },
          { promptId: real.promptId }
        );
        wire.chunk('late real prose', 150, real.promptId);
        wire.completed(real.promptId, 'error', 'old real error', 0, 1000);
        assert.equal(cancels(wire), 0);
        assert.deepEqual(handle.state, before);
        assert.deepEqual({ changes, activity, clocks }, { changes: 0, activity: 0, clocks: 0 });
        wire.chunk('OK', 200, second.promptId);
        wire.completed(second.promptId, 'end_turn', undefined, 1000, 1000);
        wire.reply(second, { stopReason: 'end_turn' });
        await until(handle, 'W2 closes', (s) => !s.running);
        for (const view of await projected(handle, wire)) {
          assert.ok(
            view.exchanges.some(
              (x) => 'role' in x && x.text === 'late real prose' && x.maintenance === false
            )
          );
          const tool = view.exchanges.find(
            (x) => 'role' in x && x.blocks?.some((b) => 'summary' in b && b.summary === 'Read file')
          );
          assert.ok(tool && 'role' in tool && tool.maintenance === false);
          assert.ok(tool.blocks?.some((b) => 'summary' in b && b.output === 'real result'));
          assert.equal(
            view.exchanges.filter((x): x is AuthoredView => 'role' in x && x.role === 'warm').at(-1)
              ?.text,
            '✓ Kept the prompt cache warm'
          );
        }
      });
    }

    for (const existing of [false, true]) {
      it(`associates a late W1 error with W1 after successful W2 (${existing ? 'existing' : 'first-seen'} alarm)`, async () => {
        const { wire, handle } = await warmSession();
        const first = pinged(wire, handle);
        if (existing) wire.completed(first.promptId, 'error');
        wire.reply(first, { stopReason: existing ? 'error' : 'end_turn' });
        await until(handle, 'W1 closes', (s) => !s.running);
        const real = await sent(wire, handle, 'real R');
        wire.chunk('real prose', 100, real.promptId);
        wire.reply(real, { stopReason: 'end_turn' });
        await until(handle, 'R closes', (s) => !s.running);
        await tick();
        const second = pinged(wire, handle);
        wire.chunk('OK', 200, second.promptId);
        wire.completed(second.promptId, 'end_turn', undefined, 1000, 1000);
        wire.reply(second, { stopReason: 'end_turn' });
        await until(handle, 'W2 closes', (s) => !s.running);
        const before = handle.state;
        let publications = 0;
        handle.onChange(() => publications++);
        handle.onActivity(() => publications++);
        wire.completed(first.promptId, 'error', 'old W1 diagnostic');
        assert.deepEqual(handle.state, before);
        assert.equal(publications, 0);
        for (const view of await projected(handle, wire)) {
          const pings = view.exchanges.filter(
            (x): x is AuthoredView => 'role' in x && x.role === 'warm'
          );
          assert.equal(pings[0]?.text, '✗ Cache warm failed');
          assert.equal(pings[1]?.text, '✓ Kept the prompt cache warm');
          const alarm = view.exchanges.find((x) => 'role' in x && x.role === 'cli');
          assert.ok(alarm && 'role' in alarm);
          assert.ok(pings[0]);
          assert.equal(alarm.warmId, pings[0].warmId);
          assert.ok(view.exchanges.some((x) => 'role' in x && x.text === 'real prose'));
        }
      });
    }

    it('suppresses clean named late W1 after real output and keeps chronological real prose', async () => {
      const { wire, handle } = await warmSession();
      const first = pinged(wire, handle);
      wire.completed(first.promptId, 'end_turn', undefined, 1000, 1000);
      wire.reply(first, { stopReason: 'end_turn' });
      await until(handle, 'W1 closes', (s) => !s.running);
      const real = await sent(wire, handle, 'real R');
      wire.chunk('real prose', 100, real.promptId);
      wire.reply(real, { stopReason: 'end_turn' });
      await until(handle, 'R closes', (s) => !s.running);
      const before = handle.state;
      wire.chunk('OK', 150, first.promptId);
      assert.deepEqual(handle.state, before);
      for (const view of await projected(handle, wire)) {
        assert.deepEqual(
          view.exchanges.filter((x) => 'role' in x).map((x) => [x.role, x.text]),
          [
            ['warm', '✓ Kept the prompt cache warm'],
            ['user', 'real R'],
            ['assistant', 'real prose']
          ]
        );
      }
    });

    for (const stage of ['real-running', 'warm-running', 'warm-idle']) {
      it(`seeds resume clocks from confirmed traffic across late W1 items at ${stage}`, async (t) => {
        const { wire, handle } = await warmSession();
        let now = 1000;
        t.mock.method(Date, 'now', () => now);
        const first = pinged(wire, handle);
        now = 2000;
        wire.completed(first.promptId, 'end_turn');
        wire.reply(first, { stopReason: 'end_turn' });
        await until(handle, 'W1 closes', (s) => !s.running);
        now = 3000;
        const real = await sent(wire, handle, 'real R');
        now = 4000;
        wire.chunk('real prose', 100, real.promptId);
        if (stage !== 'real-running') {
          wire.reply(real, { stopReason: 'end_turn' });
          await until(handle, 'R closes', (s) => !s.running);
          now = 5000;
          const second = pinged(wire, handle);
          if (stage === 'warm-idle') {
            now = 6000;
            wire.completed(second.promptId, 'end_turn');
            wire.reply(second, { stopReason: 'end_turn' });
            await until(handle, 'W2 closes', (s) => !s.running);
          }
        }
        const before = handle.state;
        now = 3600000;
        wire.chunk('old W1 reply', 150, first.promptId);
        assert.equal(handle.state, before);
        await projected(handle, wire);
        const updatedAt = await record.recordedActivityAt(wire.id);
        const cacheAt = await record.recordedActivityAt(wire.id, { includeWarm: true });
        assert.equal(updatedAt, 4000);
        assert.equal(cacheAt, stage === 'warm-idle' ? 6000 : 4000);
      });
    }

    it('rejects old real callbacks without cutting W2 and still refuses current W2 tool use', async () => {
      const { wire, handle } = await warmSession();
      const real = await sent(wire, handle, 'real R');
      wire.reply(real, { stopReason: 'end_turn' });
      await until(handle, 'R closes', (s) => !s.running);
      await tick();
      const second = pinged(wire, handle);
      const before = handle.state;
      let publications = 0;
      handle.onChange(() => publications++);
      wire.emit({
        jsonrpc: '2.0',
        id: 71,
        method: 'session/request_permission',
        params: { sessionId: wire.id, _meta: { promptId: real.promptId }, ...PERMISSION }
      });
      wire.emit({
        jsonrpc: '2.0',
        id: 72,
        method: '_x.ai/ask_user_question',
        params: { sessionId: wire.id, _meta: { promptId: real.promptId }, ...QUESTION }
      });
      assert.equal(cancels(wire), 0);
      assert.deepEqual(handle.state, before);
      assert.equal(publications, 0);
      assert.match(JSON.stringify(answerTo(wire, 71)?.result), /reject-once/);
      assert.ok(answerTo(wire, 72)?.error);
      wire.update(
        { sessionUpdate: 'tool_call', toolCallId: 'current-tool', title: 'Read' },
        { promptId: second.promptId }
      );
      assert.equal(cancels(wire), 1);
      assert.equal(handle.state.warmTurn?.failed, true);
      wire.reply(second, { stopReason: 'cancelled' });
      await until(handle, 'W2 closes', (s) => !s.running);
      for (const view of await projected(handle, wire)) {
        assert.equal(
          view.exchanges.find((x): x is AuthoredView => 'role' in x && x.role === 'warm')?.text,
          '✗ Cache warm failed'
        );
        assert.ok(
          view.exchanges.some(
            (x) => 'role' in x && x.blocks?.some((b) => 'summary' in b && b.summary === 'Read file')
          )
        );
      }
    });

    it('takes cached input from its own turn only, before its reply or after', async () => {
      const { wire, handle } = await warmSession();
      const ping = pinged(wire, handle);
      wire.chunk('OK', 300, ping.promptId);
      wire.completed('task-wake', 'end_turn', undefined, 7);
      assert.equal(handle.state.warmTurn?.cached, undefined, "another turn's usage");
      wire.reply(ping, { stopReason: 'end_turn' });
      await until(handle, 'the reply closes it', (s) => s.warmTurn?.phase === 'closed');
      wire.completed(ping.promptId, 'end_turn', undefined, 900);
      assert.equal(handle.state.warmTurn?.cached, 900, 'its own, after the reply');
      assert.equal(handle.state.warmTurn?.phase, 'closed');

      const real = await sent(wire, handle, 'a real one');
      assert.equal(handle.state.warmTurn, undefined);
      wire.completed(real.promptId, 'end_turn', undefined, 5);
      assert.equal(handle.state.warmTurn, undefined, 'a real turn has no verdict');
    });
  });
});
