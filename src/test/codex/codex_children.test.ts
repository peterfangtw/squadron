import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import type { CodexSession as Session } from '../../core/codex/session';
import type { SessionTransport } from '../../core/session';
import { tempHome } from '../helpers';
import { executionRepo } from '../execution_helpers';

let CodexSession: typeof Session;

before(async () => {
  await tempHome();
  ({ CodexSession } = await import('../../core/codex/session'));
});

class Peer {
  readonly written: { method: string; params?: unknown }[] = [];
  private readonly lines: ((value: unknown) => void)[] = [];
  private turns = 0;

  constructor(
    readonly threadId: string,
    readonly cwd = '/tmp'
  ) {}

  readonly transport: SessionTransport = {
    onLine: (listener) => this.lines.push(listener),
    onExit: () => undefined,
    close: () => undefined,
    write: (value) => {
      const request = value as { id?: number; method: string; params?: unknown };
      this.written.push(request);
      if (request.id === undefined) return;
      const result =
        request.method === 'initialize'
          ? { userAgent: 'fixture', codexHome: '/tmp' }
          : request.method === 'thread/start'
            ? {
                thread: {
                  id: this.threadId,
                  cwd: this.cwd,
                  canAcceptDirectInput: true,
                  status: { type: 'idle' }
                }
              }
            : request.method === 'turn/start'
              ? { turn: { id: ++this.turns === 1 ? 'parent-turn' : `parent-turn-${this.turns}` } }
              : {};
      queueMicrotask(() => {
        for (const listener of this.lines) listener({ id: request.id, result });
      });
    }
  };

  notify(method: string, params: unknown): void {
    for (const listener of this.lines) listener({ method, params });
  }
}

describe('Codex child thread isolation', () => {
  it('captures a proven child before the parent-only guard while keeping the parent turn open', async (t) => {
    const { cwd, runtime } = await executionRepo('codex-child-capture', 'codex');
    const checkpoint = await import('../../core/checkpoint');
    const execution = await import('../../core/execution');
    const record = await import('../../core/record');
    const peer = new Peer('parent-capture', cwd);
    const session = new CodexSession(peer.transport, {
      cwd,
      startedAt: Date.now(),
      execution: runtime
    });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    session.send('delegate work');
    for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'turn/start'); i++)
      await setTimeout(10);
    const admission = await execution.readAdmission(runtime.contextFile!);
    assert.ok(admission);
    peer.notify('turn/started', { threadId: peer.threadId, turn: { id: 'parent-turn' } });
    const delegation = {
      threadId: peer.threadId,
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'delegation',
        kind: 'started',
        agentThreadId: 'native-child'
      }
    };
    peer.notify('item/started', delegation);
    peer.notify('item/completed', delegation);
    const request = {
      cwd,
      owner: admission.owner,
      runtime: runtime.runtime,
      actor: 'native-child',
      call: 'child-write',
      context: 'child-turn'
    };
    await checkpoint.captureExecution({ ...request, edge: 'before' });
    const item = {
      threadId: 'native-child',
      turnId: 'child-turn',
      item: { type: 'commandExecution', id: request.call }
    };
    peer.notify('item/started', item);
    await fs.writeFile(path.join(cwd, 'child.txt'), 'child\n');
    await checkpoint.captureExecution({ ...request, edge: 'after' });
    peer.notify('item/completed', item);
    peer.notify('item/completed', {
      threadId: 'native-child',
      item: { type: 'agentMessage', id: 'child-prose', text: 'private child prose' }
    });
    peer.notify('turn/completed', {
      threadId: 'native-child',
      turn: { id: 'child-turn', status: 'completed' }
    });
    assert.equal(session.state.running, true);
    peer.notify('item/completed', {
      threadId: peer.threadId,
      item: { type: 'agentMessage', id: 'parent-reply', text: 'parent done' }
    });
    peer.notify('turn/completed', {
      threadId: peer.threadId,
      turn: { id: 'parent-turn', status: 'completed' }
    });
    let read = await record.readRecord(peer.threadId);
    for (let i = 0; i < 100 && !read?.execution?.size; i++) {
      await setTimeout(10);
      read = await record.readRecord(peer.threadId);
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

  for (const childCompleted of [false, true]) {
    it(`interrupts the parent while its child is ${childCompleted ? 'finished' : 'running'}`, async (t) => {
      const peer = new Peer(`parent-child-${childCompleted ? 'finished' : 'running'}`);
      const session = new CodexSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
      t.after(() => session.close());
      assert.equal((await session.opening).ok, true);
      peer.notify('turn/started', { threadId: peer.threadId, turn: { id: 'parent-turn' } });
      peer.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
      if (childCompleted) {
        peer.notify('turn/completed', {
          threadId: 'child',
          turn: { id: 'child-turn', status: 'completed' }
        });
      }
      assert.equal(session.state.status, 'busy');
      await session.interrupt();
      assert.deepEqual(
        peer.written.filter((request) => request.method === 'turn/interrupt'),
        [
          {
            method: 'turn/interrupt',
            id: 3,
            params: { threadId: peer.threadId, turnId: 'parent-turn' }
          }
        ]
      );
      peer.notify('turn/completed', {
        threadId: peer.threadId,
        turn: { id: 'parent-turn', status: 'interrupted' }
      });
      assert.equal(session.state.status, 'idle');
    });
  }

  it('records only the owned thread, including its interrupt marker', async (t) => {
    const peer = new Peer('parent-transcript');
    const session = new CodexSession(peer.transport, { cwd: '/tmp', startedAt: 1 });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    peer.notify('item/completed', {
      threadId: 'child',
      item: { type: 'agentMessage', id: 'child-message', text: 'child output' }
    });
    peer.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'interrupted' }
    });
    peer.notify('item/completed', {
      threadId: peer.threadId,
      item: { type: 'agentMessage', id: 'parent-message', text: 'parent output' }
    });
    peer.notify('turn/completed', {
      threadId: peer.threadId,
      turn: { id: 'parent-turn', status: 'interrupted' }
    });
    peer.notify('item/completed', {
      threadId: peer.threadId,
      item: { type: 'agentMessage', id: 'sentinel', text: 'record flushed' }
    });
    assert.ok(session.state.transcript);
    const deadline = Date.now() + 2000;
    let content = '';
    while (Date.now() < deadline) {
      content = await fs.readFile(session.state.transcript, 'utf8').catch(() => '');
      if (content.includes('sentinel')) break;
      await setTimeout(10);
    }
    const rows = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      rows.slice(1).map((row) => row.m ?? row.mark),
      ['parent-message', 'break', 'sentinel']
    );
    assert.equal(rows[1]?.text, 'parent output');
    assert.equal(rows[2]?.mark, 'break');
  });

  /**
   * Codex 0.160.0 follows up an existing worker with `subAgentActivity` kind
   * `interacted`, never `started` again, and the observer is new every turn.
   */
  for (const scenario of [
    { name: 'a worker it spawned, with hooks capturing', worker: 'spawned', hooks: true },
    { name: 'a worker it spawned, with hooks untrusted', worker: 'spawned', hooks: false },
    { name: 'a worker it never proved native', worker: 'stranger', hooks: false },
    { name: 'a worker writing with no interaction', worker: 'silent', hooks: false }
  ] as const) {
    it(`keeps a second turn's interacted child honest: ${scenario.name}`, async (t) => {
      const { cwd, runtime } = await executionRepo(
        `codex-interacted-${scenario.worker}-${scenario.hooks}`,
        'codex'
      );
      const checkpoint = await import('../../core/checkpoint');
      const execution = await import('../../core/execution');
      const record = await import('../../core/record');
      const peer = new Peer(`interacted-${scenario.worker}-${scenario.hooks}`, cwd);
      const session = new CodexSession(peer.transport, {
        cwd,
        startedAt: Date.now(),
        execution: runtime
      });
      t.after(() => session.close());
      assert.equal((await session.opening).ok, true);
      const decisions = async (count: number) => {
        let read = await record.readRecord(peer.threadId);
        for (let i = 0; i < 200 && (read?.execution?.size ?? 0) < count; i++) {
          await setTimeout(10);
          read = await record.readRecord(peer.threadId);
        }
        return [...(read?.execution?.values() ?? [])];
      };
      const turn = async (prompt: string, id: string, count: number) => {
        session.send(prompt);
        for (
          let i = 0;
          i < 200 && peer.written.filter((row) => row.method === 'turn/start').length < count;
          i++
        )
          await setTimeout(10);
        peer.notify('turn/started', { threadId: peer.threadId, turn: { id } });
      };
      const activity = (turnId: string, id: string, kind: string, agentThreadId: string) => {
        const row = {
          threadId: peer.threadId,
          turnId,
          item: { type: 'subAgentActivity', id, kind, agentThreadId }
        };
        peer.notify('item/started', row);
        peer.notify('item/completed', row);
      };
      const childWrite = async (child: string, turnId: string, call: string, file: string) => {
        const admission = await execution.readAdmission(runtime.contextFile!);
        assert.ok(admission);
        const request = {
          cwd,
          owner: admission.owner,
          runtime: runtime.runtime,
          actor: child,
          call,
          context: turnId
        };
        const item = { threadId: child, turnId, item: { type: 'commandExecution', id: call } };
        peer.notify('turn/started', { threadId: child, turn: { id: turnId } });
        peer.notify('item/started', item);
        if (scenario.hooks) await checkpoint.captureExecution({ ...request, edge: 'before' });
        await fs.writeFile(path.join(cwd, file), `${call}\n`);
        if (scenario.hooks) await checkpoint.captureExecution({ ...request, edge: 'after' });
        peer.notify('item/completed', item);
        peer.notify('turn/completed', {
          threadId: child,
          turn: { id: turnId, status: 'completed' }
        });
      };
      const complete = (id: string) => {
        peer.notify('item/completed', {
          threadId: peer.threadId,
          turnId: id,
          item: { type: 'agentMessage', id: `${id}-reply`, text: 'done' }
        });
        peer.notify('turn/completed', {
          threadId: peer.threadId,
          turn: { id, status: 'completed' }
        });
      };

      await turn('spawn a worker', 'parent-turn', 1);
      activity('parent-turn', 'spawn', 'started', 'worker');
      await childWrite('worker', 'worker-turn-1', 'first-write', 'child-first.txt');
      complete('parent-turn');
      await decisions(1);

      await turn('follow up with the worker', 'parent-turn-2', 2);
      const child = scenario.worker === 'stranger' ? 'stranger' : 'worker';
      // The child's own frames can land before the parent's interaction item.
      await childWrite(child, 'worker-turn-2', 'second-write', 'child-second.txt');
      if (scenario.worker !== 'silent') activity('parent-turn-2', 'followup', 'interacted', child);
      complete('parent-turn-2');
      const second = (await decisions(2))[1];
      const written = path.join(cwd, 'child-second.txt');
      if (scenario.worker === 'spawned' && scenario.hooks) {
        assert.equal(second?.source, 'execution');
        assert.deepEqual(
          second?.windows.flatMap((window) => window.changes.files),
          [written]
        );
      } else {
        assert.equal(second?.source, 'turn', 'an unbracketed child write keeps the floor');
        assert.deepEqual(second?.windows[0]?.changes.files, [written]);
      }
      session.close();
      await session.flush();
    });
  }

  it('cannot call a turn complete after interacting with a worker nothing proved, even one that stays silent', async () => {
    const { ExecutionObserver } = await import('../../core/codex/execution');
    const interact = (observer: InstanceType<typeof ExecutionObserver>, worker: string) => {
      observer.take('item/completed', {
        threadId: 'parent',
        turnId: 'turn',
        item: {
          type: 'subAgentActivity',
          id: 'followup',
          kind: 'interacted',
          agentThreadId: worker
        }
      });
      observer.take('turn/completed', { threadId: worker, turn: { id: 'w', status: 'completed' } });
      observer.take('turn/completed', {
        threadId: 'parent',
        turn: { id: 'turn', status: 'completed' }
      });
    };
    const stranger = new ExecutionObserver('parent');
    interact(stranger, 'stranger');
    assert.equal((await stranger.finish()).observed, false);
    const known = new ExecutionObserver('parent', new Set(['worker']));
    interact(known, 'worker');
    assert.equal((await known.finish()).observed, true);
  });
});
