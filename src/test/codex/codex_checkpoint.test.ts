import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import type { SessionTransport } from '../../core/session';
import { tempHome } from '../helpers';
import { executionRepo } from '../execution_helpers';

let home: string;
let CodexSession: typeof import('../../core/codex/session').CodexSession;
let record: typeof import('../../core/record');
let checkpoint: typeof import('../../core/checkpoint');
before(async () => {
  home = await tempHome();
  ({ CodexSession } = await import('../../core/codex/session'));
  record = await import('../../core/record');
  checkpoint = await import('../../core/checkpoint');
});

class Peer {
  nextTurnId = 'turn';
  readonly written: { id?: number; method: string; params?: unknown }[] = [];
  private readonly lines: ((value: unknown) => void)[] = [];
  constructor(
    readonly cwd: string,
    readonly sid: string
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
                  id: this.sid,
                  cwd: this.cwd,
                  canAcceptDirectInput: true,
                  status: { type: 'idle' }
                }
              }
            : request.method === 'turn/start'
              ? { turn: { id: this.nextTurnId } }
              : {};
      queueMicrotask(() => {
        for (const listener of this.lines) listener({ id: request.id, result });
      });
    }
  };
  notify(method: string, params: Record<string, unknown>): void {
    for (const listener of this.lines)
      listener({ method, params: { threadId: this.sid, ...params } });
  }
}

describe('Codex turn captures', () => {
  for (const status of ['interrupted', 'completed']) {
    it(`excludes a late command from a ${status} turn from the next turn's execution coverage`, async () => {
      const { cwd, runtime } = await executionRepo(`codex-late-${status}`, 'codex');
      const peer = new Peer(cwd, `codex-late-${status}`);
      const session = new CodexSession(peer.transport, {
        cwd,
        startedAt: Date.now(),
        execution: runtime
      });
      try {
        assert.equal((await session.opening).ok, true);
        session.send('start a command that outlives this turn');
        for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'turn/start'); i++)
          await setTimeout(10);
        assert.equal(peer.written.filter((row) => row.method === 'turn/start').length, 1);
        peer.notify('turn/started', { turn: { id: 'turn' } });
        peer.notify('item/started', {
          turnId: 'turn',
          item: { type: 'commandExecution', id: 'late-command', command: 'write later' }
        });
        peer.notify('item/completed', {
          turnId: 'turn',
          item: { type: 'agentMessage', id: 'reply-1', text: 'command still running' }
        });
        peer.notify('turn/completed', { turn: { id: 'turn', status } });
        await session.flush();
        const first = [...((await record.readRecord(peer.sid))?.execution?.values() ?? [])];
        assert.equal(first.length, 1);
        assert.deepEqual(first[0]?.calls, [{ actor: peer.sid, call: 'late-command' }]);
        assert.equal(first[0]?.source, 'turn');

        peer.nextTurnId = 'turn-2';
        session.send('reply without writing files');
        for (
          let i = 0;
          i < 100 && peer.written.filter((row) => row.method === 'turn/start').length < 2;
          i++
        )
          await setTimeout(10);
        assert.equal(peer.written.filter((row) => row.method === 'turn/start').length, 2);
        peer.notify('turn/started', { turn: { id: 'turn-2' } });
        const file = path.join(cwd, 'late-write.txt');
        await fs.writeFile(file, 'written by the first turn after it ended\n');
        peer.notify('item/completed', {
          turnId: 'turn',
          item: {
            type: 'commandExecution',
            id: 'late-command',
            command: 'write later',
            status: 'completed',
            exitCode: 0
          }
        });
        peer.notify('item/completed', {
          turnId: 'turn-2',
          item: { type: 'agentMessage', id: 'reply-2', text: 'done without writes' }
        });
        peer.notify('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
        await session.flush();
        const read = await record.readRecord(peer.sid);
        assert.deepEqual(
          session.thread.snapshot().history,
          read,
          'memory and the record converge, including notes'
        );
        const coverage = [...(read?.execution?.values() ?? [])];
        assert.equal(coverage.length, 2);
        assert.deepEqual(coverage[1]?.calls, [], 'the next observer cannot settle a prior call');
        assert.equal(coverage[1]?.source, 'execution');
        assert.deepEqual(coverage[1]?.windows, [], 'the next turn claims no writes');
        assert.deepEqual(coverage[1]?.floor?.changes.files, [file]);
        assert.deepEqual(coverage[0], first[0], 'the first turn keeps its original coverage');
        assert.deepEqual((await checkpoint.readExecution(cwd)).coverage, coverage);
      } finally {
        session.close();
        await session.flush();
      }
    });
  }

  for (const completed of [false, true]) {
    it(`rechecks a native wake ${completed ? 'completed' : 'running'} during attachment preparation`, async (t) => {
      const { cwd, runtime } = await executionRepo(`codex-input-${completed}`, 'codex');
      const peer = new Peer(cwd, `codex-input-${completed}`);
      const session = new CodexSession(peer.transport, {
        cwd,
        startedAt: Date.now(),
        execution: runtime
      });
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      t.mock.method(record, 'writeAttachment', async () => {
        entered();
        await held;
        return undefined;
      });
      try {
        assert.equal((await session.opening).ok, true);
        session.send('queued prompt', [{ mediaType: 'image/png', data: 'eA==' }]);
        await preparing;
        peer.notify('turn/started', { turn: { id: 'native-wake' } });
        await fs.writeFile(path.join(cwd, 'wake.txt'), 'native wake\n');
        if (completed)
          peer.notify('turn/completed', { turn: { id: 'native-wake', status: 'completed' } });
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await session.flush();
        if (!completed) {
          assert.equal(peer.written.filter((row) => row.method === 'turn/start').length, 0);
          assert.equal(session.state.queued.length, 1);
          assert.equal(session.state.running, true);
          peer.notify('turn/completed', { turn: { id: 'native-wake', status: 'completed' } });
        }
        for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'turn/start'); i++)
          await setTimeout(10);
        assert.equal(peer.written.filter((row) => row.method === 'turn/start').length, 1);
        peer.notify('turn/started', { turn: { id: 'turn' } });
        peer.notify('item/completed', {
          turnId: 'turn',
          item: { type: 'agentMessage', id: 'reply', text: 'done' }
        });
        peer.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
        await session.flush();
        const read = await record.readRecord(peer.sid);
        assert.deepEqual(
          session.thread.snapshot().history,
          read,
          'memory and the record converge, including notes'
        );
        assert.equal(read?.checkpoints.size, 1);
        assert.deepEqual([...read.checkpoints.values()][0]?.changes.files, []);
      } finally {
        release();
        session.close();
        await session.flush();
      }
    });
  }

  it('retains a before-send floor with execution off and closes only on the parent turn', async (t) => {
    const cwd = path.join(await fs.realpath(home), 'codex-floor');
    await fs.mkdir(cwd);
    const run = promisify(execFile);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    await run('git', ['init', '-b', 'main'], { cwd, env });
    await run(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'base'
      ],
      { cwd, env }
    );
    const peer = new Peer(cwd, 'codex-floor');
    const session = new CodexSession(peer.transport, { cwd, startedAt: Date.now() });
    t.after(() => session.close());
    assert.equal((await session.opening).ok, true);
    session.send('write using a shell');
    for (let i = 0; i < 100 && !peer.written.some((row) => row.method === 'turn/start'); i++)
      await setTimeout(10);
    assert.ok(peer.written.some((row) => row.method === 'turn/start'));
    await fs.writeFile(path.join(cwd, 'shell.txt'), 'written\n');
    peer.notify('turn/started', { turn: { id: 'turn' } });
    peer.notify('item/completed', {
      turnId: 'turn',
      item: { type: 'agentMessage', id: 'reply', text: 'done' }
    });
    peer.notify('turn/completed', {
      threadId: 'child',
      turn: { id: 'child-turn', status: 'completed' }
    });
    assert.equal((await record.readRecord(peer.sid))?.checkpoints.size ?? 0, 0);
    peer.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    await session.flush();
    const read = await record.readRecord(peer.sid);
    assert.deepEqual(
      session.thread.snapshot().history,
      read,
      'memory and the record converge, including notes'
    );
    assert.equal(read?.checkpoints.size, 1);
    assert.deepEqual([...read.checkpoints.values()][0]?.changes.files, [
      path.join(cwd, 'shell.txt')
    ]);
    assert.equal([...(read.execution?.values() ?? [])][0]?.source, 'turn');
    const windows = await checkpoint.readWindows(cwd);
    assert.deepEqual(
      windows.map((window) => window.paths),
      [[path.join(cwd, 'shell.txt')]]
    );
  });
});
