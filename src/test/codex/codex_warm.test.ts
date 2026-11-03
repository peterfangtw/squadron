import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import { after, describe, it } from 'node:test';

import type { ChangeOrigin } from '../../core/adapter';

import type { LiveState } from '../../core/live';

let advancesActivityClock: (typeof import('../../core/adapter'))['advancesActivityClock'];

let advancesCacheClock: (typeof import('../../core/adapter'))['advancesCacheClock'];

let CodexSession: (typeof import('../../core/codex/session'))['CodexSession'];

let shownStatus: (typeof import('../../core/live'))['shownStatus'];

let toSession: (typeof import('../../core/live'))['toSession'];

let WARM_PROMPT: (typeof import('../../core/coordination/send'))['WARM_PROMPT'];

let readRecord: (typeof import('../../core/record'))['readRecord'];

let recordedActivityAt: (typeof import('../../core/record'))['recordedActivityAt'];

let recordFile: (typeof import('../../core/record'))['recordFile'];

let transcript: typeof import('../../core/transcript');

let views: typeof import('../../ui/views');

let warm: typeof import('../../core/warm_policy');

type CodexSession = import('../../core/codex/session').CodexSession;

import { before } from 'node:test';

import { alive, dispose, setup, ThreadPeer, threadSession, until } from './codex_session_helpers';

before(async () => {
  await setup();
  ({ advancesActivityClock } = await import('../../core/adapter'));
  ({ advancesCacheClock } = await import('../../core/adapter'));
  ({ CodexSession } = await import('../../core/codex/session'));
  ({ shownStatus } = await import('../../core/live'));
  ({ toSession } = await import('../../core/live'));
  ({ WARM_PROMPT } = await import('../../core/coordination/send'));
  ({ readRecord } = await import('../../core/record'));
  ({ recordedActivityAt } = await import('../../core/record'));
  ({ recordFile } = await import('../../core/record'));
  transcript = await import('../../core/transcript');
  views = await import('../../ui/views');
  warm = await import('../../core/warm_policy');
});

after(dispose);

describe('Codex on the shared thread', () => {
  describe('a cache-warming ping', () => {
    async function warmSession(
      options: Parameters<typeof threadSession>[0] = {}
    ): Promise<{ peer: ThreadPeer; handle: CodexSession }> {
      const fixture = await threadSession(options);
      fixture.peer.notify('thread/tokenUsage/updated', {
        threadId: fixture.peer.id,
        tokenUsage: { last: { totalTokens: 1000 }, modelContextWindow: 200000 }
      });
      return fixture;
    }

    const PING = 'turn-w';

    /** The ping, which admission put on the wire before `ping` returned. */
    function pinged(peer: ThreadPeer, handle: CodexSession): void {
      peer.holding.add('turn/start');
      const before = starts(peer);
      assert.deepEqual(handle.warm?.ping(), { ok: true });
      assert.equal(starts(peer), before + 1, 'written synchronously');
      assert.match(JSON.stringify(peer.params.get('turn/start')), /<squadron-warm>/);
    }

    /** The ping's start answered and its turn opened. */
    function running(peer: ThreadPeer): void {
      peer.reply('turn/start', { result: { turn: { id: PING } } });
      peer.notify('turn/started', { turn: { id: PING } });
    }

    function usage(peer: ThreadPeer, turnId: string, cached: number): void {
      peer.notify('thread/tokenUsage/updated', {
        turnId,
        tokenUsage: {
          last: { totalTokens: 30_000, cachedInputTokens: cached },
          modelContextWindow: 258_400
        }
      });
    }

    function ended(peer: ThreadPeer, status = 'completed', turnId = PING): void {
      peer.notify('turn/completed', { turn: { id: turnId, status } });
    }

    const starts = (peer: ThreadPeer) => peer.methods.filter((m) => m === 'turn/start').length;
    const interrupts = (peer: ThreadPeer) =>
      peer.methods.filter((m) => m === 'turn/interrupt').length;
    const startText = (peer: ThreadPeer) =>
      JSON.stringify((peer.params.get('turn/start') ?? {}).input);
    const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

    async function startsReach(peer: ThreadPeer, count: number): Promise<void> {
      for (let i = 0; i < 200 && starts(peer) < count; i++) await tick(5);
      assert.equal(starts(peer), count, `turn/start ${String(count)} never reached the wire`);
    }

    /** Every state the card was handed, so a transient one is not missed. */
    function states(handle: CodexSession): LiveState[] {
      const seen: LiveState[] = [];
      handle.onChange((state) => seen.push(state));
      return seen;
    }

    /** Calls into the session's checkpoints, by method, still delegated. */
    function captures(handle: CodexSession): Map<string, number> {
      const calls = new Map<string, number>();
      const target = (handle as unknown as { checkpoints: Record<string, unknown> }).checkpoints;
      for (const name of ['open', 'openUnknown', 'uncertainExecution', 'closeExecution']) {
        const real = target[name] as (...args: unknown[]) => unknown;
        target[name] = (...args: unknown[]): unknown => {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          return real.apply(target, args);
        };
      }
      return calls;
    }

    async function recordRoles(peer: ThreadPeer): Promise<string[]> {
      const text = await fs.readFile(recordFile(peer.id), 'utf8').catch(() => '');
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          const row = JSON.parse(line) as { role?: string };
          return row.role ? [row.role] : [];
        });
    }

    function maintenanceClocks(handle: CodexSession): {
      real: number[];
      cache: number[];
      shown: string[];
      changes: number;
    } {
      const trace = {
        real: [] as number[],
        cache: [] as number[],
        shown: [] as string[],
        changes: 0
      };
      let wasRunning = handle.state.running;
      let realStarted = false;
      handle.onChange((state, origin, cacheTraffic, observedAt) => {
        trace.changes++;
        if (origin === 'prompt' && !state.warmTurn) realStarted = true;
        if (realStarted) {
          wasRunning = state.running;
          return;
        }
        trace.shown.push(shownStatus(state));
        const at = observedAt ?? Date.now();
        if (
          advancesActivityClock({
            origin,
            status: state.status,
            turned: true,
            warm: state.warmTurn !== undefined
          })
        )
          trace.real.push(at);
        if (advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic }))
          trace.cache.push(at);
        wasRunning = state.running;
      });
      handle.onActivity((observedAt) => {
        if (realStarted) return;
        if (advancesCacheClock({ origin: 'agent', running: handle.state.running, wasRunning }))
          trace.cache.push(observedAt ?? Date.now());
        wasRunning = handle.state.running;
        if (
          advancesActivityClock({
            origin: 'agent',
            status: handle.state.status,
            turned: true,
            warm: handle.state.warmTurn !== undefined
          })
        )
          trace.real.push(observedAt ?? Date.now());
      });
      return trace;
    }

    for (const beforeResponse of [false, true]) {
      for (const status of ['completed', 'failed', 'interrupted']) {
        for (const queued of [false, true]) {
          it(`admits native idle then ${status} ${beforeResponse ? 'before' : 'after'} start response with ${queued ? 'queued' : 'new'} work`, async (t) => {
            const { peer, handle } = await warmSession();
            let now = 1000;
            t.mock.method(Date, 'now', () => now);
            const trace = maintenanceClocks(handle);
            pinged(peer, handle);
            if (queued) handle.send('real next');
            if (!beforeResponse) {
              peer.reply('turn/start', { result: { turn: { id: PING } } });
              await tick();
            }
            now = 2000;
            peer.notify('thread/status/changed', { status: { type: 'active' } });
            now = 3000;
            peer.notify('turn/started', { turn: { id: PING } });
            now = 4000;
            peer.completed('native-reply', 'OK', PING);
            now = 5000;
            usage(peer, PING, 900);
            now = 6000;
            peer.notify('thread/status/changed', { status: { type: 'idle' } });
            assert.equal(starts(peer), 1, 'thread idle cannot release the native owner');
            now = 7000;
            peer.notify('turn/completed', {
              turn: {
                id: PING,
                status,
                ...(status === 'failed' ? { error: { message: 'native failure' } } : {})
              }
            });
            if (beforeResponse) {
              assert.deepEqual(trace.real, []);
              now = 9000;
              peer.reply('turn/start', { result: { turn: { id: PING } } });
              await tick();
            }
            const warmState = trace.shown;
            assert.ok(
              warmState.every((shown) => shown === 'idle'),
              'maintenance has no work-status edge'
            );
            assert.deepEqual(trace.real, [], 'maintenance cannot make the card unread');
            assert.deepEqual(
              trace.cache,
              status === 'completed' ? [2000, 5000, 6000, 7000] : [2000, 5000, 6000]
            );
            if (!queued) {
              assert.equal(handle.state.warmTurn?.phase, 'closed');
              assert.equal(
                handle.state.warmTurn?.failed,
                status === 'completed' ? undefined : true
              );
              assert.equal(handle.state.warmTurn?.trafficAt, status === 'completed' ? 7000 : 6000);
              assert.equal(handle.state.lastOutcome, undefined);
              assert.equal(handle.state.inFlight, undefined);
              const before = handle.state;
              const publications = trace.changes;
              now = 10000;
              ended(peer, 'failed');
              assert.equal(handle.state, before, 'a duplicate receipt is clock-neutral');
              assert.equal(trace.changes, publications);
              handle.send('real next');
            }
            await startsReach(peer, 2);
            assert.match(startText(peer), /real next/);
            assert.equal(handle.state.warmTurn, undefined);
            peer.reply('turn/start', { result: { turn: { id: 'real-next' } } });
            await tick();
            const real = handle.state;
            const publications = trace.changes;
            ended(peer, 'failed');
            assert.equal(handle.state, real, 'the old warm completion cannot terminate real work');
            assert.equal(trace.changes, publications);
            ended(peer, 'completed', 'real-next');
            await handle.flush();
            const rows = (await readRecord(peer.id))?.exchanges ?? [];
            const ping = rows.find((row) => 'role' in row && row.role === 'warm');
            assert.ok(ping && 'role' in ping && ping.warmEvidence);
            assert.equal(ping.warmEvidence.failed, status === 'completed' ? undefined : true);
            assert.equal(ping.warmEvidence.trafficAt, status === 'completed' ? 7000 : 6000);
            const diagnostic = rows.find((row) => 'role' in row && row.text === 'native failure');
            if (status === 'failed') {
              assert.ok(diagnostic && 'role' in diagnostic);
              assert.equal(diagnostic.warmId, ping.warmId);
              assert.equal(diagnostic.maintenance, true);
            }
          });
        }
      }
    }

    const callbacks = [
      {
        kind: 'command',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls' },
        denial: { decision: 'decline' }
      },
      {
        kind: 'files',
        method: 'item/fileChange/requestApproval',
        params: { grantRoot: '/tmp' },
        denial: { decision: 'decline' }
      },
      {
        kind: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { permissions: { network: { enabled: true } } },
        denial: { permissions: {}, scope: 'turn' }
      },
      {
        kind: 'question',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [{ id: 'q', question: 'Which?', options: [{ label: 'Left' }] }],
          isBlocking: true
        },
        denial: undefined
      }
    ];

    for (const callback of callbacks) {
      for (const matching of [false, true]) {
        for (const settlement of ['success', 'refused', 'malformed', 'timeout']) {
          it(`correlates early ${matching ? 'matching' : 'foreign'} ${callback.kind} callback on ${settlement}`, async (t) => {
            const { peer, handle } = await warmSession({ skipPermissions: true, requestMs: 50 });
            let now = 1000;
            t.mock.method(Date, 'now', () => now);
            const trace = maintenanceClocks(handle);
            pinged(peer, handle);
            const pending = handle.state;
            now = 2000;
            peer.request(81, callback.method, {
              ...callback.params,
              turnId: matching ? PING : 'foreign',
              itemId: 'early-tool'
            });
            peer.request(81, callback.method, {
              ...callback.params,
              turnId: matching ? PING : 'foreign',
              itemId: 'early-tool'
            });
            assert.equal(handle.state, pending, 'no ownership before the start response');
            assert.deepEqual(peer.replies, [], 'no auto-allow or refusal before correlation');
            assert.equal(interrupts(peer), 0);
            now = 9000;
            if (settlement === 'success')
              peer.reply('turn/start', { result: { turn: { id: PING } } });
            else if (settlement === 'refused')
              peer.reply('turn/start', { error: { code: -32603, message: 'refused' } });
            else if (settlement === 'malformed') peer.reply('turn/start', { result: {} });
            else await tick(100);
            await tick(10);
            const admitted = matching && settlement === 'success';
            assert.equal(
              handle.state.warmTurn?.failed,
              admitted || settlement === 'refused' ? true : undefined
            );
            assert.equal(interrupts(peer), admitted ? 1 : 0);
            if (admitted) {
              assert.deepEqual(peer.params.get('turn/interrupt'), {
                threadId: peer.id,
                turnId: PING
              });
              assert.deepEqual(
                peer.replies,
                callback.denial ? [{ id: 81, result: callback.denial }] : []
              );
              assert.equal(handle.state.warmTurn?.phase, 'written');
              assert.deepEqual(trace.cache, []);
              peer.notify('serverRequest/resolved', { requestId: 81 });
              ended(peer, 'interrupted');
            } else {
              assert.deepEqual(peer.replies, [
                { id: 81, error: { code: -32602, message: 'Invalid params' } }
              ]);
              assert.deepEqual(trace.cache, []);
              if (settlement === 'success') {
                ended(peer);
                assert.equal(handle.state.warmTurn?.failed, undefined);
              }
            }
            assert.deepEqual(trace.real, []);
            assert.ok(trace.shown.every((shown) => shown === 'idle'));
            assert.equal(handle.state.pending.length, 0);
            assert.equal(
              handle.respond('n:81', { allow: true }),
              false,
              'no stale answerable request'
            );
            assert.equal(
              (handle as unknown as { requests: Map<string, unknown> }).requests.size,
              0
            );
          });
        }
      }
      for (const retirement of ['resolved', 'completed', 'completed-first']) {
        it(`retires early ${callback.kind} callback ${retirement} before correlation`, async () => {
          const { peer, handle } = await warmSession({ skipPermissions: true });
          pinged(peer, handle);
          const request = () =>
            peer.request(82, callback.method, {
              ...callback.params,
              turnId: PING,
              itemId: 'retired-tool'
            });
          if (retirement === 'completed-first') ended(peer);
          request();
          if (retirement === 'resolved') peer.notify('serverRequest/resolved', { requestId: 82 });
          else if (retirement === 'completed') ended(peer);
          peer.reply('turn/start', { result: { turn: { id: PING } } });
          await tick(10);
          assert.deepEqual(peer.replies, [], 'no response to an already retired native callback');
          assert.equal(interrupts(peer), 0);
          assert.equal(handle.state.warmTurn?.failed, undefined);
          assert.equal(handle.state.pending.length, 0);
          assert.equal(handle.respond('n:82', { allow: true }), false);
          assert.equal((handle as unknown as { requests: Map<string, unknown> }).requests.size, 0);
          if (retirement === 'resolved') ended(peer);
        });
      }
    }

    for (const callback of callbacks) {
      it(`admits a matching real ${callback.kind} callback only after start correlation`, async (t) => {
        const { peer, handle } = await warmSession();
        let now = 1000;
        t.mock.method(Date, 'now', () => now);
        peer.holding.add('turn/start');
        handle.send('real input');
        await startsReach(peer, 1);
        const pending = handle.state;
        const observed: number[] = [];
        handle.onChange((_state, origin, _traffic, at) => {
          if (origin === 'agent') observed.push(at ?? Date.now());
        });
        now = 2000;
        peer.request(83, callback.method, {
          ...callback.params,
          turnId: 'real-owner',
          itemId: 'real-tool'
        });
        peer.request(84, callback.method, {
          ...callback.params,
          turnId: 'foreign',
          itemId: 'foreign-tool'
        });
        assert.equal(handle.state, pending);
        assert.deepEqual(peer.replies, []);
        now = 9000;
        peer.reply('turn/start', { result: { turn: { id: 'real-owner' } } });
        await tick();
        assert.equal(handle.state.pending.length, 1);
        assert.equal(handle.state.pending[0]?.requestId, 'n:83');
        assert.deepEqual(observed, [2000]);
        assert.deepEqual(peer.replies, [
          { id: 84, error: { code: -32602, message: 'Invalid params' } }
        ]);
        assert.equal(interrupts(peer), 0);
        assert.equal(handle.respond('n:83', { allow: true, picks: [[0]] }), true);
        const result =
          callback.kind === 'question'
            ? { answers: { q: { answers: ['Left'] } } }
            : callback.kind === 'permissions'
              ? { permissions: callback.params.permissions, scope: 'turn' }
              : { decision: 'accept' };
        assert.deepEqual(peer.replies[1], { id: 83, result });
        assert.equal(handle.state.pending.length, 0);
        assert.equal(handle.respond('n:83', { allow: true }), false);
        ended(peer, 'completed', 'real-owner');
      });

      it(`refuses a current warm ${callback.kind} callback after idle before native completion`, async (t) => {
        const { peer, handle } = await warmSession({ skipPermissions: true });
        let now = 1000;
        t.mock.method(Date, 'now', () => now);
        const trace = maintenanceClocks(handle);
        pinged(peer, handle);
        running(peer);
        await tick();
        now = 2000;
        peer.notify('thread/status/changed', { status: { type: 'idle' } });
        assert.equal(handle.state.warmTurn?.phase, 'closed');
        const before = handle.state;
        const publications = trace.changes;
        now = 3000;
        peer.request(85, callback.method, {
          ...callback.params,
          turnId: 'foreign',
          itemId: 'foreign-tool'
        });
        assert.equal(handle.state, before);
        assert.equal(trace.changes, publications);
        peer.request(86, callback.method, {
          ...callback.params,
          turnId: PING,
          itemId: 'current-tool'
        });
        await tick(10);
        assert.equal(handle.state.warmTurn?.failed, true);
        assert.equal(interrupts(peer), 1);
        assert.deepEqual(peer.params.get('turn/interrupt'), { threadId: peer.id, turnId: PING });
        assert.deepEqual(peer.replies, [
          { id: 85, error: { code: -32602, message: 'Invalid params' } },
          ...(callback.denial ? [{ id: 86, result: callback.denial }] : [])
        ]);
        assert.equal(handle.state.pending.length, 0);
        assert.deepEqual(trace.real, []);
        assert.deepEqual(trace.cache, [1000, 2000]);
        ended(peer, 'interrupted');
        handle.send('real next');
        await startsReach(peer, 2);
        peer.reply('turn/start', { result: { turn: { id: 'real-next' } } });
        await tick();
        ended(peer, 'completed', 'real-next');
      });
    }

    it('keeps current warm text, tool and repeated start ownership between idle and completion', async (t) => {
      const { peer, handle } = await warmSession();
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      const trace = maintenanceClocks(handle);
      const captured = captures(handle);
      pinged(peer, handle);
      running(peer);
      await tick();
      now = 2000;
      peer.notify('thread/status/changed', { status: { type: 'idle' } });
      const warmId = handle.state.warmTurn?.id;
      now = 3000;
      peer.notify('turn/started', { turn: { id: PING } });
      now = 4000;
      peer.delta('after-idle', 'still warm', PING);
      now = 5000;
      peer.notify('item/started', {
        turnId: PING,
        item: { type: 'commandExecution', id: 'after-idle-tool', command: 'ls' }
      });
      await tick(10);
      assert.equal(handle.state.warmTurn?.id, warmId);
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(interrupts(peer), 1);
      assert.deepEqual([...captured], []);
      assert.deepEqual(trace.real, []);
      assert.deepEqual(trace.cache, [1000, 2000, 3000, 4000, 5000]);
      ended(peer, 'interrupted');
      await handle.flush();
      const rows = (await readRecord(peer.id))?.exchanges ?? [];
      const reply = rows.find((row) => 'role' in row && row.text === 'still warm');
      assert.ok(reply && 'role' in reply);
      assert.equal(reply.maintenance, true);
      assert.equal(reply.warmId, warmId);
    });

    it('dates a successful completion before its start response without any opening or text', async (t) => {
      const { peer, handle } = await warmSession();
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      let cacheAt = 1000;
      let prior = false;
      handle.onChange((state, origin, cacheTraffic, observedAt) => {
        if (advancesCacheClock({ origin, running: state.running, wasRunning: prior, cacheTraffic }))
          cacheAt = observedAt ?? Date.now();
        prior = state.running;
      });
      pinged(peer, handle);
      now = 2000;
      ended(peer);
      assert.equal(cacheAt, 1000, 'native ownership awaits the start response');
      usage(peer, PING, 900);
      assert.equal(handle.state.warmTurn?.cached, undefined);
      now = 9000;
      peer.reply('turn/start', { result: { turn: { id: PING } } });
      await tick();
      const saved = cacheAt;
      assert.equal(saved, 2000);
      assert.equal(handle.state.warmTurn?.trafficAt, 2000);
      assert.equal(handle.state.warmTurn?.cached, 900, 'buffered matching usage is correlated');
      ended(peer);
      assert.equal(cacheAt, saved, 'duplicate close and local response cleanup are neutral');
      await handle.flush();
      const rec = await import('../../core/record');
      assert.equal(
        await rec.recordedActivityAt(peer.id, { includeWarm: true }),
        handle.state.warmTurn?.trafficAt
      );
    });

    for (const maintenance of [false, true]) {
      for (const status of ['completed', 'failed', 'interrupted']) {
        it(`correlates ${maintenance ? 'warm' : 'real'} ${status} completion and items before start response`, async (t) => {
          const { peer, handle } = await warmSession();
          let now = 1000;
          t.mock.method(Date, 'now', () => now);
          let updatedAt = 1000;
          let cacheAt = 1000;
          let wasRunning = handle.state.running;
          handle.onChange((state, origin, cacheTraffic, observedAt) => {
            const at = observedAt ?? Date.now();
            if (
              advancesActivityClock({
                origin,
                status: state.status,
                turned: true,
                warm: state.warmTurn !== undefined
              })
            )
              updatedAt = at;
            if (advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic }))
              cacheAt = at;
            wasRunning = state.running;
          });
          peer.holding.add('turn/start');
          if (maintenance) pinged(peer, handle);
          else {
            handle.messages.send('real input');
            await startsReach(peer, 1);
          }
          const input = handle.state.warmTurn?.id;
          const pending = handle.state;
          peer.completed('foreign-item', 'foreign real evidence', 'foreign');
          peer.notify('turn/completed', {
            turn: { id: 'foreign', status: 'failed', error: { message: 'foreign error' } }
          });
          assert.equal(handle.state, pending, 'unknown events cannot capture the pending owner');
          now = 2000;
          peer.completed('early-item', 'early reply', PING);
          peer.notify('turn/completed', {
            turn: { id: PING, status, error: { message: 'matching diagnostic' } }
          });
          usage(peer, PING, 900);
          assert.equal(handle.state, pending);
          assert.equal(updatedAt, 1000);
          assert.equal(cacheAt, 1000);
          now = 9000;
          peer.reply('turn/start', { result: { turn: { id: PING } } });
          await tick();
          assert.equal(handle.state.running, false);
          assert.equal(updatedAt, maintenance ? 1000 : 2000);
          assert.equal(cacheAt, maintenance && status !== 'completed' ? 1000 : 2000);
          if (maintenance) {
            assert.equal(
              handle.state.warmTurn?.trafficAt,
              status === 'completed' ? 2000 : undefined
            );
            assert.equal(handle.state.warmTurn?.failed, status === 'completed' ? undefined : true);
            assert.equal(handle.state.warmTurn?.cached, 900);
          }
          now = 12000;
          peer.completed('late-item', 'late reply', PING);
          await handle.flush();
          const rec = await import('../../core/record');
          const { Conversation } = await import('../../core/thread');
          const saved = await rec.readRecordLines(peer.id);
          assert.ok(saved);
          const recovered = new Conversation(peer.id, 0, {
            cwd: '/tmp/codex-project',
            brand: 'codex'
          });
          await recovered.recover(() =>
            Promise.resolve({ lines: saved.lines, partial: false, ours: true })
          );
          const disk = (await readRecord(peer.id))?.exchanges;
          assert.ok(disk);
          for (const rows of [
            handle.thread.snapshot().history.exchanges,
            disk,
            recovered.snapshot().history.exchanges
          ]) {
            for (const text of [
              'early reply',
              'late reply',
              ...(status === 'failed' ? ['matching diagnostic'] : [])
            ]) {
              const row = rows.find((x) => 'role' in x && x.text === text);
              assert.ok(row && 'role' in row, text);
              assert.equal(row.maintenance, maintenance, text);
              assert.equal(row.warmId, input, text);
            }
            for (const text of ['foreign real evidence', 'foreign error']) {
              const row = rows.find((x) => 'role' in x && x.text === text);
              assert.ok(row && 'role' in row);
              assert.equal(row.maintenance, false);
              assert.equal(row.warmId, undefined);
            }
            const view = views.composeThread(
              toSession(
                handle.state,
                { pid: 4242, brand: 'codex', startedAt: 1, updatedAt: 1 },
                'w'
              ),
              {
                history: {
                  exchanges: rows.map((x) =>
                    'role' in x ? { ...x, blocks: [{ prose: x.text }] } : x
                  )
                },
                live: handle.state
              },
              {}
            );
            assert.equal(
              view.exchanges.some((x) => 'role' in x && x.text === 'early reply'),
              !maintenance
            );
            assert.ok(
              view.exchanges.some((x) => 'role' in x && x.text === 'foreign real evidence')
            );
          }
          assert.equal(await recordedActivityAt(peer.id), maintenance ? 1000 : 12000);
          assert.equal(
            await recordedActivityAt(peer.id, { includeWarm: true }),
            maintenance ? (status === 'completed' ? 2000 : 1000) : 12000
          );
        });
      }
    }

    for (const failure of ['refused', 'malformed', 'timeout']) {
      it(`keeps uncorrelated notifications real after a ${failure} warm start`, async () => {
        const { peer, handle } = await warmSession({ requestMs: 50 });
        pinged(peer, handle);
        peer.completed('unbound-item', 'unbound prose', 'unbound');
        peer.notify('turn/completed', {
          turn: { id: 'unbound', status: 'failed', error: { message: 'unbound diagnostic' } }
        });
        usage(peer, 'unbound', 0);
        if (failure === 'refused')
          peer.reply('turn/start', { error: { code: -32603, message: 'refused' } });
        else if (failure === 'malformed') peer.reply('turn/start', { result: {} });
        else await tick(100);
        await tick();
        assert.equal(handle.state.warmTurn?.trafficAt, undefined);
        assert.equal(handle.state.warmTurn?.cached, undefined);
        if (failure !== 'refused') {
          const pending = handle.state;
          peer.notify('turn/started', { turn: { id: 'later-unknown' } });
          peer.notify('turn/completed', { turn: { id: 'later-unknown', status: 'completed' } });
          usage(peer, 'later-unknown', 0);
          assert.equal(handle.state, pending, 'a failed start supplies no native owner later');
        }
        await handle.flush();
        const rows = (await readRecord(peer.id))?.exchanges ?? [];
        for (const text of ['unbound prose', 'unbound diagnostic']) {
          const row = rows.find((x) => 'role' in x && x.text === text);
          assert.ok(row && 'role' in row);
          assert.equal(row.maintenance, false);
          assert.equal(row.warmId, undefined);
        }
        const real = rows.find((x) => 'role' in x && x.text === 'unbound diagnostic');
        assert.ok(real && 'role' in real);
        assert.equal(await recordedActivityAt(peer.id), real.at);
        assert.equal(await recordedActivityAt(peer.id, { includeWarm: true }), real.at);
      });
    }

    it('keeps unsolicited streaming and disk activity after a warm completion', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      peer.delta('ok-owned', 'OK', PING);
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'unsolicited' } });
      peer.delta('real-owned', 'real work', 'unsolicited');
      const tail = handle.thread.snapshot().tail.find((row) => row.exchange.text === 'real work');
      assert.equal(tail?.exchange.maintenance, false);
      ended(peer, 'completed', 'unsolicited');
      await handle.flush();
      const rec = await import('../../core/record');
      const rows = (await rec.readRecord(peer.id))?.exchanges ?? [];
      assert.ok(rows.some((x) => 'role' in x && x.text === 'real work' && x.maintenance === false));
      assert.ok(await rec.recordedActivityAt(peer.id));
    });

    it('captures buffered named text under the response-confirmed ping before closing it', async (t) => {
      const { peer, handle } = await warmSession();
      let now = 1000;
      t.mock.method(Date, 'now', () => now);
      pinged(peer, handle);
      now = 2000;
      peer.delta('early-stream', 'O', PING);
      peer.delta('early-stream', 'K', PING);
      peer.completed('early-stream', 'OK', PING);
      now = 3000;
      ended(peer);
      assert.equal(handle.thread.snapshot().tail.length, 0);
      now = 9000;
      peer.reply('turn/start', { result: { turn: { id: PING } } });
      await tick();
      assert.equal(handle.state.warmTurn?.trafficAt, 3000);
      await handle.flush();
      const rows = (await readRecord(peer.id))?.exchanges ?? [];
      const reply = rows.find((x) => 'role' in x && x.text === 'OK');
      assert.ok(reply && 'role' in reply);
      assert.equal(reply.at, 2000);
      assert.equal(reply.maintenance, true);
      assert.equal(reply.warmId, handle.state.warmTurn?.id);
      assert.equal(await recordedActivityAt(peer.id), undefined);
      assert.equal(await recordedActivityAt(peer.id, { includeWarm: true }), 3000);
    });

    it('keeps unknown late completions and usage off the retained closed ping', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      ended(peer);
      const before = handle.state;
      peer.notify('turn/completed', {
        turn: { id: 'unknown-close', status: 'failed', error: { message: 'unowned diagnostic' } }
      });
      usage(peer, 'unknown-close', 0);
      assert.equal(handle.state, before);
      await handle.flush();
      const rows = (await readRecord(peer.id))?.exchanges ?? [];
      const diagnostic = rows.find((x) => 'role' in x && x.text === 'unowned diagnostic');
      assert.ok(diagnostic && 'role' in diagnostic);
      assert.equal(diagnostic.maintenance, false);
      assert.equal(diagnostic.warmId, undefined);
    });

    it('does not seed cache warmth after an ambiguous timeout without frames', async () => {
      const { peer, handle } = await warmSession({ requestMs: 50 });
      pinged(peer, handle);
      await tick(120);
      assert.equal(handle.state.warmTurn?.trafficAt, undefined);
      await handle.flush();
      const rec = await import('../../core/record');
      assert.equal(await rec.recordedActivityAt(peer.id, { includeWarm: true }), undefined);
    });

    it('keeps a late warm item owned by its completed native turn after unsolicited work', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'unsolicited' } });
      peer.completed('real', 'real work', 'unsolicited');
      ended(peer, 'completed', 'unsolicited');
      peer.completed('late-warm', 'OK', PING);
      await handle.flush();
      const rec = await import('../../core/record');
      const rows = (await rec.readRecord(peer.id))?.exchanges ?? [];
      const real = rows.find((x) => 'role' in x && x.text === 'real work');
      const late = rows.find((x) => 'role' in x && x.text === 'OK');
      assert.equal(late && 'role' in late && late.maintenance, true);
      assert.equal(
        await rec.recordedActivityAt(peer.id),
        real && 'role' in real ? real.at : undefined
      );
    });

    for (const stage of ['real-running', 'warm-running', 'warm-idle']) {
      it(`seeds resume clocks from confirmed traffic across late W1 items at ${stage}`, async (t) => {
        const { peer, handle } = await warmSession();
        let now = 1000;
        t.mock.method(Date, 'now', () => now);
        pinged(peer, handle);
        running(peer);
        await tick();
        now = 2000;
        ended(peer);
        now = 3000;
        peer.notify('turn/started', { turn: { id: 'real-r' } });
        now = 4000;
        peer.completed('real-r-item', 'real R', 'real-r');
        if (stage !== 'real-running') {
          ended(peer, 'completed', 'real-r');
          now = 5000;
          pinged(peer, handle);
          peer.reply('turn/start', { result: { turn: { id: 'W2' } } });
          peer.notify('turn/started', { turn: { id: 'W2' } });
          peer.notify('item/completed', {
            turnId: 'W2',
            item: {
              type: 'userMessage',
              id: 'w2-echo',
              clientId: peer.params.get('turn/start')?.clientUserMessageId,
              content: []
            }
          });
          await tick();
          if (stage === 'warm-idle') {
            now = 6000;
            ended(peer, 'completed', 'W2');
          }
        }
        const before = handle.state;
        now = 3600000;
        peer.completed('old-receipt', 'old W1 reply', PING);
        assert.equal(handle.state, before);
        await handle.flush();
        const rec = await import('../../core/record');
        const { Conversation } = await import('../../core/thread');
        const saved = await rec.readRecordLines(peer.id);
        assert.ok(saved);
        const recovered = new Conversation(peer.id, 0, {
          cwd: '/tmp/codex-project',
          brand: 'codex'
        });
        await recovered.recover(() =>
          Promise.resolve({ lines: saved.lines, partial: false, ours: true })
        );
        assert.deepEqual(
          recovered.snapshot().history.exchanges,
          (await readRecord(peer.id))?.exchanges
        );
        const updatedAt = await recordedActivityAt(peer.id);
        const cacheAt = await recordedActivityAt(peer.id, { includeWarm: true });
        assert.ok(
          (await readRecord(peer.id))?.exchanges.some(
            (x) => 'role' in x && x.text === 'old W1 reply'
          )
        );
        assert.equal(updatedAt, 4000);
        assert.equal(
          cacheAt,
          stage === 'warm-idle' ? 6000 : stage === 'warm-running' ? 5000 : 4000
        );
        const resumed = toSession(
          handle.state,
          { pid: 4242, brand: 'codex', startedAt: now, updatedAt: updatedAt ?? 1, cacheAt },
          'w'
        );
        if (stage !== 'real-running') assert.equal(resumed.cache?.at, cacheAt);
      });
    }

    it('keeps a first-seen late real item visible during a newer warm turn', async () => {
      const { peer, handle } = await warmSession();
      peer.notify('turn/started', { turn: { id: 'real-before' } });
      ended(peer, 'completed', 'real-before');
      pinged(peer, handle);
      running(peer);
      await tick();
      peer.completed('late-real', 'real work', 'real-before');
      ended(peer);
      await handle.flush();

      const memory = handle.thread.snapshot().history.exchanges;
      const persisted = (await readRecord(peer.id))?.exchanges;
      assert.ok(persisted);
      for (const rows of [memory, persisted]) {
        const index = rows.findIndex((x) => 'role' in x && x.text === 'real work');
        const real = rows[index];
        assert.ok(real && 'role' in real);
        assert.equal(real.maintenance, false, 'native real ownership beats the active ping');
        assert.equal(transcript.warmOwned(rows)[index], false);
        const view = views.composeThread(
          toSession(handle.state, { pid: 4242, brand: 'codex', startedAt: 1, updatedAt: 1 }, 'w'),
          {
            history: {
              exchanges: rows.map((x) => ('role' in x ? { ...x, blocks: [{ prose: x.text }] } : x))
            },
            live: handle.state
          },
          {}
        );
        assert.ok(view.exchanges.some((x) => 'role' in x && x.text === 'real work'));
        assert.equal(await recordedActivityAt(peer.id), real.at);
      }
    });

    it('keeps the card idle and its activity still, warms the cache clock, and keeps red', async () => {
      const { peer, handle } = await warmSession();
      peer.holding.add('turn/start');
      handle.messages?.send('one that fails');
      await peer.sent('turn/start');
      peer.reply('turn/start', { error: { code: -32603, message: 'boom' } });
      await until(handle, 'the red turn', (s) => !s.running && s.lastOutcome === 'error');
      await tick(10);

      let cacheAt = 1000;
      let wasRunning = handle.state.running;
      let activity = 0;
      const shown: string[] = [];
      const moves = (origin: ChangeOrigin) => {
        const state = handle.state;
        if (
          advancesActivityClock({
            origin,
            status: state.status,
            turned: true,
            warm: state.warmTurn !== undefined
          })
        )
          activity++;
      };
      handle.onChange((state, origin) => {
        shown.push(shownStatus(state));
        moves(origin);
        if (advancesCacheClock({ origin, running: state.running, wasRunning })) cacheAt++;
        wasRunning = state.running;
      });
      handle.onActivity(() => {
        moves('agent');
        if (advancesCacheClock({ origin: 'agent', running: handle.state.running, wasRunning }))
          cacheAt++;
      });

      pinged(peer, handle);
      assert.equal(handle.state.warmTurn?.phase, 'written');
      assert.equal(cacheAt, 1000, 'a write is not traffic');
      running(peer);
      await tick();
      peer.delta('ok', 'OK', PING);
      assert.equal(handle.state.warmTurn?.phase, 'open');
      assert.ok(cacheAt > 1000, 'its reply is');
      usage(peer, PING, 29_440);
      peer.completed('ok', 'OK', PING);
      ended(peer);
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');

      assert.equal(handle.state.warmTurn?.failed, undefined);
      assert.equal(handle.state.warmTurn?.cached, 29_440);
      assert.equal(handle.state.inFlight, undefined);
      assert.equal(handle.state.lastOutcome, 'error', 'a ping does not clear red');
      assert.equal(activity, 0, 'nothing a reader did');
      assert.deepEqual([...new Set(shown)], ['idle']);
      await handle.flush();
      assert.ok((await recordRoles(peer)).includes('warm'));
      assert.ok(
        JSON.stringify(peer.params.get('turn/start')).includes(WARM_PROMPT),
        'the wrapped keep-alive'
      );
    });

    it('writes warm pings regardless of context usage', async () => {
      for (const pct of [undefined, -1, NaN, Infinity, 80, 100]) {
        const { peer, handle } = await warmSession();
        handle.state.contextPct = pct;
        pinged(peer, handle);
        assert.equal(starts(peer), 1);
        running(peer);
        await tick();
        ended(peer);
        await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      }
    });

    it('is refused with no conversation, a turn running, an ask open, or a message held', async () => {
      const early = new ThreadPeer();
      const fresh = new CodexSession(early.transport, { cwd: '/tmp/codex-project', startedAt: 1 });
      alive.push(fresh);
      assert.deepEqual(fresh.warm?.ping(), {
        ok: false,
        reason: 'The session has no conversation to keep warm.'
      });
      await fresh.opening;

      const { peer, handle } = await warmSession();
      peer.holding.add('turn/start');
      handle.messages?.send('a turn of its own');
      await peer.sent('turn/start');
      assert.deepEqual(handle.warm?.ping(), { ok: false, reason: 'The session is not idle.' });
      peer.reply('turn/start', { result: { turn: { id: 'turn-a' } } });
      peer.notify('turn/started', { turn: { id: 'turn-a' } });
      peer.request(41, 'item/tool/requestUserInput', {
        turnId: 'turn-a',
        itemId: 'ask-a',
        questions: [{ id: 'q', header: 'Pick', question: 'Which?', options: [{ label: 'Left' }] }],
        isBlocking: true
      });
      await until(handle, 'the ask', (s) => s.status === 'waiting');
      assert.equal(handle.warm?.ping().ok, false, 'an ask is open');
      handle.messages?.send('held behind it');
      assert.deepEqual(handle.warm?.ping(), {
        ok: false,
        reason: 'A message is waiting to be sent.'
      });
      assert.ok(!startText(peer).includes('squadron-warm'));
      assert.equal(starts(peer), 1);
    });

    it('holds a message sent during it, and sends that once it closes', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      assert.deepEqual(handle.warm?.ping(), { ok: false, reason: 'The session is not idle.' });
      handle.messages?.send('after the ping');
      running(peer);
      await tick(20);
      assert.equal(starts(peer), 1, 'nothing is written onto a ping');
      assert.equal(handle.state.queued.length, 1);
      peer.delta('ok', 'OK', PING);
      ended(peer);
      await startsReach(peer, 2);
      assert.match(startText(peer), /after the ping/);
      assert.equal(handle.state.warmTurn, undefined, 'a real turn clears the latch');
    });

    it('declines a permission it asks, even with approval off, and never shows it', async () => {
      const { peer, handle } = await warmSession({ skipPermissions: true });
      const seen = states(handle);
      pinged(peer, handle);
      running(peer);
      peer.request(51, 'item/commandExecution/requestApproval', {
        turnId: PING,
        itemId: 'cmd-w',
        command: 'touch /tmp/warm.txt'
      });
      await tick(10);
      assert.deepEqual(
        peer.replies.find((reply) => reply.id === 51),
        { id: 51, result: { decision: 'decline' } }
      );
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(interrupts(peer), 1);
      ended(peer, 'interrupted');
      await until(handle, 'the cut ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.ok(seen.every((s) => s.pending.length === 0 && s.status !== 'waiting'));
    });

    it('leaves a question it asks to the interrupt, and never shows it', async () => {
      const { peer, handle } = await warmSession();
      const seen = states(handle);
      pinged(peer, handle);
      running(peer);
      peer.request(52, 'item/tool/requestUserInput', {
        turnId: PING,
        itemId: 'ask-w',
        questions: [{ id: 'q', header: 'Pick', question: 'Which?', options: [{ label: 'Left' }] }],
        isBlocking: true
      });
      await tick(10);
      // An error reply is submitted as empty answers and the turn goes on.
      assert.equal(
        peer.replies.find((reply) => reply.id === 52),
        undefined,
        'neither answered nor failed'
      );
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(interrupts(peer), 1);
      peer.notify('serverRequest/resolved', { requestId: 52 });
      ended(peer, 'interrupted');
      await until(handle, 'the cut ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.ok(seen.every((s) => s.pending.length === 0 && s.status !== 'waiting'));
    });

    it('cuts a ping that reaches for a tool, once, and holds the pipe until it ends', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      peer.notify('item/started', {
        turnId: PING,
        item: { type: 'commandExecution', id: 'cmd-w', command: 'ls' }
      });
      assert.equal(handle.state.warmTurn?.failed, true);
      await tick(10);
      assert.equal(interrupts(peer), 1);
      peer.notify('item/commandExecution/outputDelta', {
        turnId: PING,
        itemId: 'cmd-w',
        delta: 'notes.md\n'
      });
      await tick(10);
      assert.equal(interrupts(peer), 1, 'one interrupt for one ping');
      assert.equal(handle.warm?.ping().ok, false, 'still its turn');
      handle.messages?.send('waits for the close');
      await tick(20);
      assert.equal(starts(peer), 1);
      ended(peer, 'interrupted');
      await startsReach(peer, 2);
      assert.match(startText(peer), /waits for the close/);
    });

    it('closes failed, off the cache clock and unrecorded, when Codex refuses its start', async () => {
      const { peer, handle } = await warmSession();
      let cacheAt = 1000;
      let wasRunning = handle.state.running;
      handle.onChange((state, origin) => {
        if (advancesCacheClock({ origin, running: state.running, wasRunning })) cacheAt++;
        wasRunning = state.running;
      });
      pinged(peer, handle);
      peer.reply('turn/start', { error: { code: -32600, message: 'refused' } });
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.equal(handle.state.inFlight, undefined);
      assert.equal(cacheAt, 1000);
      await handle.flush();
      assert.deepEqual(await recordRoles(peer), []);
    });

    it('holds the pipe past a start that timed out, until Send now', async () => {
      const { peer, handle } = await warmSession({ requestMs: 50 });
      const seen = states(handle);
      pinged(peer, handle);
      await tick(120);
      assert.equal(handle.state.warmTurn?.phase, 'written', 'the ping may still be running');
      assert.deepEqual(handle.warm?.ping(), { ok: false, reason: 'The session is not idle.' });
      handle.messages?.send('urgent');
      await tick(20);
      assert.equal(starts(peer), 1, 'no write onto a ping that may be running');
      await handle.messages?.sendNow?.();
      assert.ok(seen.some((s) => s.warmTurn?.phase === 'closed' && s.warmTurn.failed === true));
      await startsReach(peer, 2);
      assert.match(startText(peer), /urgent/);
    });

    it('closes failed when the thread falls into systemError', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      peer.notify('thread/status/changed', { status: { type: 'systemError' } });
      assert.equal(handle.state.warmTurn?.phase, 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
    });

    it('closes failed, capturing nothing, when the child exits under it', async () => {
      const { peer, handle } = await warmSession();
      const calls = captures(handle);
      pinged(peer, handle);
      running(peer);
      peer.delta('ok', 'O', PING);
      peer.exit();
      await until(handle, 'the exit', (s) => s.exit !== undefined);
      assert.equal(handle.state.warmTurn?.phase, 'closed');
      assert.equal(handle.state.warmTurn?.failed, true);
      assert.deepEqual([...calls], []);
    });

    it('takes cached input from its own turn only, however late', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      usage(peer, 'turn-other', 7);
      assert.equal(handle.state.warmTurn?.cached, undefined, "another turn's usage");
      peer.delta('ok', 'OK', PING);
      ended(peer);
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      usage(peer, PING, 900);
      assert.equal(handle.state.warmTurn?.cached, 900, 'its own, after its completion');
      usage(peer, PING, 800);
      assert.equal(handle.state.warmTurn?.cached, 900, 'the first request tests the cache');

      handle.messages?.send('a real one');
      await startsReach(peer, 2);
      peer.reply('turn/start', { result: { turn: { id: 'turn-r' } } });
      peer.notify('turn/started', { turn: { id: 'turn-r' } });
      assert.equal(handle.state.warmTurn, undefined);
      usage(peer, 'turn-r', 5);
      assert.equal(handle.state.warmTurn, undefined, 'a real turn has no verdict');
    });

    it('persists late usage after real work supersedes the live latch', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'real-next' } });
      usage(peer, PING, 0);
      assert.equal(handle.state.warmTurn, undefined);
      ended(peer, 'completed', 'real-next');
      await handle.flush();
      const rec = await import('../../core/record');
      const ping = (await rec.readRecord(peer.id))?.exchanges.find(
        (x) => 'role' in x && x.role === 'warm'
      );
      assert.ok(ping && 'warmEvidence' in ping && ping.warmEvidence?.cached === 0);
    });

    for (const realRunning of [true, false]) {
      it(`keeps late warm usage historical and clock-neutral while real work is ${realRunning ? 'running' : 'idle'}`, async () => {
        const { peer, handle } = await warmSession();
        pinged(peer, handle);
        running(peer);
        await tick();
        peer.completed('ok', 'OK', PING);
        ended(peer);
        peer.notify('turn/started', { turn: { id: 'real-next' } });
        peer.notify('thread/tokenUsage/updated', {
          turnId: 'real-next',
          tokenUsage: { last: { totalTokens: 60_000 }, modelContextWindow: 200_000 }
        });
        if (!realRunning) ended(peer, 'completed', 'real-next');
        assert.equal(handle.state.warmTurn, undefined);
        assert.equal(handle.state.running, realRunning);

        let updatedAt = 1000;
        let cacheAt = 2000;
        let wasRunning = handle.state.running;
        handle.onChange((state, origin, cacheTraffic) => {
          if (
            advancesActivityClock({
              origin,
              status: state.status,
              turned: true,
              warm: state.warmTurn !== undefined
            })
          )
            updatedAt++;
          if (advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic }))
            cacheAt++;
          wasRunning = state.running;
        });
        const contextTokens = handle.state.contextTokens;
        const windowStated = handle.state.windowStated;
        const contextPct = handle.state.contextPct;
        usage(peer, PING, 0);
        await handle.flush();

        const ping = (await readRecord(peer.id))?.exchanges.find(
          (x) => 'role' in x && x.role === 'warm'
        );
        assert.ok(ping && 'warmEvidence' in ping && ping.warmEvidence);
        assert.equal(ping.warmEvidence.cached, 0);
        assert.equal(warm.warmVerdict(ping.warmEvidence), 'miss');
        assert.equal(handle.state.warmTurn, undefined, 'history must not restore the latch');
        assert.equal(handle.state.running, realRunning);
        assert.deepEqual(
          {
            contextTokens: handle.state.contextTokens,
            windowStated: handle.state.windowStated,
            contextPct: handle.state.contextPct,
            updatedAt,
            cacheAt
          },
          { contextTokens, windowStated, contextPct, updatedAt: 1000, cacheAt: 2000 }
        );
      });
    }

    for (const stage of [
      'real-running',
      'real-idle',
      'warm-running',
      'second-real-running',
      'second-real-idle'
    ]) {
      for (const receipt of ['usage', 'completion']) {
        it(`retains W1 accounting without live publication at ${stage} on late ${receipt}`, async () => {
          const { peer, handle } = await warmSession();
          pinged(peer, handle);
          running(peer);
          await tick();
          ended(peer);
          peer.notify('turn/started', { turn: { id: 'real-r' } });
          peer.completed('real-r-item', 'real R', 'real-r');
          if (stage !== 'real-running') ended(peer, 'failed', 'real-r');
          if (stage.includes('warm') || stage.startsWith('second')) {
            pinged(peer, handle);
            peer.reply('turn/start', { result: { turn: { id: 'warm-w2' } } });
            peer.notify('turn/started', { turn: { id: 'warm-w2' } });
            await tick();
            if (stage.startsWith('second')) {
              ended(peer, 'completed', 'warm-w2');
              peer.notify('turn/started', { turn: { id: 'real-s' } });
              if (stage.endsWith('idle')) ended(peer, 'failed', 'real-s');
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
              advancesActivityClock({
                origin,
                status: state.status,
                turned: true,
                warm: state.warmTurn !== undefined
              })
            )
              updatedAt++;
            if (
              advancesCacheClock({
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
          if (receipt === 'usage') usage(peer, PING, 0);
          else ended(peer, 'failed');
          assert.deepEqual(
            handle.state,
            before,
            'status, outcome, context and current latch stay intact'
          );
          assert.deepEqual(
            { updatedAt, cacheAt, publications },
            { updatedAt: 1000, cacheAt: 2000, publications: 0 }
          );
          if (stage === 'warm-running') ended(peer, 'completed', 'warm-w2');
          if (stage.endsWith('running') && stage !== 'warm-running')
            ended(peer, 'completed', stage.startsWith('second') ? 'real-s' : 'real-r');
          await handle.flush();
          const persisted = (await readRecord(peer.id))?.exchanges;
          assert.ok(persisted);
          for (const rows of [handle.thread.snapshot().history.exchanges, persisted]) {
            const pings = rows.filter((x) => 'role' in x && x.role === 'warm');
            const first = pings[0];
            assert.ok(first && 'warmEvidence' in first && first.warmEvidence?.trafficAt);
            assert.equal(first.warmEvidence.cached, receipt === 'usage' ? 0 : undefined);
            if (pings.length === 2) {
              const second = pings[1];
              assert.ok(second && 'warmEvidence' in second);
              assert.equal(second.warmEvidence?.cached, undefined, 'W1 usage never charges W2');
            }
          }
        });
      }
    }

    it('retains W1 native ownership for existing and first-seen late items during W2', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      peer.delta('existing-w1', 'partial', PING);
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'real-r' } });
      peer.completed('real-r-item', 'real R', 'real-r');
      ended(peer, 'completed', 'real-r');
      pinged(peer, handle);
      peer.reply('turn/start', { result: { turn: { id: 'warm-w2' } } });
      peer.notify('turn/started', { turn: { id: 'warm-w2' } });
      const before = handle.state;
      peer.completed('existing-w1', 'old reply', PING);
      peer.completed('first-seen-w1', 'late W1', PING);
      peer.completed('first-seen-real', 'late real R', 'real-r');
      assert.deepEqual(handle.state, before);
      ended(peer, 'completed', 'warm-w2');
      await handle.flush();
      const persisted = (await readRecord(peer.id))?.exchanges;
      assert.ok(persisted);
      for (const rows of [handle.thread.snapshot().history.exchanges, persisted]) {
        for (const text of ['old reply', 'late W1']) {
          const index = rows.findIndex((x) => 'role' in x && x.text === text);
          const row = rows[index];
          assert.ok(row && 'role' in row);
          assert.equal(row.maintenance, true);
          const owner = rows.find((x) => 'role' in x && x.role === 'warm');
          assert.ok(owner && 'role' in owner);
          assert.equal(row.warmId, owner.warmId);
          assert.equal(transcript.warmOwned(rows)[index], true);
        }
        const real = rows.find((x) => 'role' in x && x.text === 'late real R');
        assert.ok(real && 'role' in real && real.maintenance === false);
        const view = views.composeThread(
          toSession(handle.state, { pid: 4242, brand: 'codex', startedAt: 1, updatedAt: 1 }, 'w'),
          {
            history: {
              exchanges: rows.map((x) => ('role' in x ? { ...x, blocks: [{ prose: x.text }] } : x))
            },
            live: handle.state
          },
          {}
        );
        assert.ok(view.exchanges.some((x) => 'role' in x && x.text === 'late real R'));
        assert.ok(!view.exchanges.some((x) => 'role' in x && x.text === 'late W1'));
        assert.equal(await recordedActivityAt(peer.id), real.at);
      }
    });

    for (const road of ['usage', 'callbacks', 'idle-callbacks']) {
      it(`isolates named old real ${road} from the current warm owner`, async () => {
        const { peer, handle } = await warmSession({ skipPermissions: true });
        peer.notify('turn/started', { turn: { id: 'real-r' } });
        ended(peer, 'completed', 'real-r');
        if (road !== 'idle-callbacks') {
          pinged(peer, handle);
          running(peer);
        }
        await tick();
        const before = handle.state;
        let publications = 0;
        handle.onChange(() => publications++);
        handle.onActivity(() => publications++);
        if (road === 'usage') usage(peer, 'real-r', 0);
        else {
          peer.request(71, 'item/commandExecution/requestApproval', {
            turnId: 'real-r',
            itemId: 'old-tool',
            command: 'ls'
          });
          peer.request(72, 'item/tool/requestUserInput', {
            turnId: 'real-r',
            itemId: 'old-ask',
            questions: [
              { id: 'q', header: 'Pick', question: 'Which?', options: [{ label: 'Left' }] }
            ],
            isBlocking: true
          });
          assert.ok(peer.replies.find((reply) => reply.id === 71)?.error);
          assert.ok(peer.replies.find((reply) => reply.id === 72)?.error);
        }
        assert.equal(interrupts(peer), 0);
        assert.deepEqual(handle.state, before);
        assert.equal(publications, 0);
        if (road !== 'idle-callbacks') ended(peer);
        await handle.flush();
      });
    }

    it('keeps W2 anonymous rows open across named old real completion', async () => {
      const { peer, handle } = await warmSession();
      peer.notify('turn/started', { turn: { id: 'real-r' } });
      ended(peer, 'completed', 'real-r');
      pinged(peer, handle);
      running(peer);
      await tick();
      peer.notify('item/agentMessage/delta', { itemId: 'unlabelled', delta: 'current warm reply' });
      const before = handle.thread.snapshot();
      const state = handle.state;
      let publications = 0;
      handle.onChange(() => publications++);
      handle.onActivity(() => publications++);
      ended(peer, 'failed', 'real-r');
      assert.deepEqual(handle.thread.snapshot(), before);
      assert.deepEqual(handle.state, state);
      assert.equal(publications, 0);
      ended(peer);
      await handle.flush();
    });

    it('rejects a named callback for an ended warm turn while real work is idle', async () => {
      const { peer, handle } = await warmSession({ skipPermissions: true });
      pinged(peer, handle);
      running(peer);
      await tick();
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'real-r' } });
      ended(peer, 'completed', 'real-r');
      const before = handle.state;
      peer.request(61, 'item/commandExecution/requestApproval', {
        turnId: PING,
        itemId: 'old-tool',
        command: 'ls'
      });
      peer.request(62, 'item/tool/requestUserInput', {
        turnId: PING,
        itemId: 'old-ask',
        questions: [{ id: 'q', header: 'Pick', question: 'Which?', options: [{ label: 'Left' }] }],
        isBlocking: true
      });
      assert.deepEqual(handle.state, before);
      assert.ok(peer.replies.find((reply) => reply.id === 61)?.error);
      assert.ok(peer.replies.find((reply) => reply.id === 62)?.error);
    });

    it('keeps an anonymous current stream open across an identified historical warm close', async () => {
      const { peer, handle } = await warmSession();
      pinged(peer, handle);
      running(peer);
      await tick();
      ended(peer);
      peer.notify('turn/started', { turn: { id: 'real-r' } });
      ended(peer, 'completed', 'real-r');
      peer.notify('turn/started', { turn: { id: 'real-s' } });
      peer.notify('item/agentMessage/delta', { itemId: 'unlabelled', delta: 'current reply' });
      const before = handle.thread.snapshot();
      ended(peer);
      assert.deepEqual(
        handle.thread.snapshot(),
        before,
        'W1 cannot cut a row with no native owner'
      );
      ended(peer, 'completed', 'real-s');
      await handle.flush();
    });

    it('opens and closes no checkpoint, and a turn Codex starts itself after it does', async () => {
      const { peer, handle } = await warmSession();
      const calls = captures(handle);
      pinged(peer, handle);
      running(peer);
      peer.delta('ok', 'OK', PING);
      ended(peer);
      await until(handle, 'the ping closes', (s) => s.warmTurn?.phase === 'closed');
      await handle.flush();
      assert.deepEqual([...calls], [], 'a ping is maintenance');

      peer.notify('turn/started', { turn: { id: 'turn-s' } });
      assert.equal(handle.state.warmTurn, undefined, 'its own turn is real activity');
      ended(peer, 'completed', 'turn-s');
      await handle.flush();
      assert.deepEqual([...calls].sort(), [
        ['closeExecution', 1],
        ['openUnknown', 1]
      ]);
    });
  });
});
