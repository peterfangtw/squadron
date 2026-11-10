import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import type { AskResult } from '../../core/coordination/ask';
import type { Reply, RequestBody } from '../../core/coordination/requests';

type AskMod = typeof import('../../core/coordination/ask');
type Requests = typeof import('../../core/coordination/requests');

let home: string;
let askMod: AskMod;
let requests: Requests;
let openSession: typeof import('../../cli/open').openSession;

const dir = () => path.join(home, '.squadron', 'requests');
const body = (): RequestBody => ({ kind: 'close', windowId: 'w1', pid: 1, startedAt: 10 });

before(async () => {
  home = await tempHome();
  requests = await import('../../core/coordination/requests');
  askMod = await import('../../core/coordination/ask');
  ({ openSession } = await import('../../cli/open'));
});

function fail(result: AskResult): Extract<AskResult, { ok: false }> {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected a failure');
  return result;
}

async function claimSoon(windowId: string, reply: Reply | Promise<Reply>): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const names = await fs.readdir(dir()).catch(() => [] as string[]);
    if (names.some((name) => name.endsWith('.request.json'))) {
      await requests.claimRequests(windowId, () => reply);
      return;
    }
  }
  throw new Error('request never appeared');
}

describe('ask', () => {
  it('names a write that never landed as unwritable', async () => {
    const requestsDir = dir();
    await fs.rm(requestsDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(requestsDir), { recursive: true });
    await fs.writeFile(requestsDir, 'not-a-directory');
    try {
      const result = fail(await askMod.ask(body()));
      assert.equal(result.kind, 'unwritable');
      assert.equal(askMod.askExit(result), 5);
      assert.equal('file' in result, false);
    } finally {
      await fs.rm(requestsDir, { force: true });
    }
  });

  it('names a window that never answers as silent, and keeps the file path', async () => {
    const result = fail(await askMod.ask(body(), 200));
    assert.equal(result.kind, 'silent');
    assert.equal(askMod.askExit(result), 4);
    assert.equal(result.reason, askMod.UNANSWERED);
    assert.ok(result.file.endsWith('.request.json'));
  });

  it('waits for a slow start without a caller-supplied timeout', async () => {
    const pending = askMod.ask({ kind: 'open', windowId: 'w1', cwd: home, prompt: 'start' });
    const reply = new Promise<Reply>((resolve) =>
      setTimeout(() => resolve({ ok: true, pid: 7, startedAt: 70_000 }), 3_200)
    );
    await claimSoon('w1', reply);
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reply.pid, 7);
  });

  it('honours a shorter caller timeout even when the kind allows a slow start', async () => {
    const pending = askMod.ask({ kind: 'open', windowId: 'w1', cwd: home }, 200);
    const reply = new Promise<Reply>((resolve) =>
      setTimeout(() => resolve({ ok: true, pid: 7 }), 500)
    );
    await claimSoon('w1', reply);
    const result = fail(await pending);
    assert.equal(result.kind, 'silent');
  });

  it('names a negative reply as refused', async () => {
    const pending = askMod.ask(body(), 2_000);
    await claimSoon('w1', { ok: false, reason: 'no pipe' });
    const result = fail(await pending);
    assert.equal(result.kind, 'refused');
    assert.equal(askMod.askExit(result), 2);
    assert.equal(result.reason, 'no pipe');
    assert.equal(result.reply.ok, false);
  });

  it('reports a thrown open as outcome unknown, while an explicit refusal stays refused', async () => {
    const windows = path.join(home, '.squadron', 'windows');
    await fs.mkdir(windows, { recursive: true });
    await fs.writeFile(
      path.join(windows, 'w1.json'),
      JSON.stringify({
        id: 'w1',
        label: 'test window',
        app: 'VS Code',
        folder: home,
        shellPids: [],
        updatedAt: Date.now()
      })
    );
    for (const throws of [true, false]) {
      const pending = openSession({ cwd: home, prompt: 'start a lane' });
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const names = await fs.readdir(dir());
        if (!names.some((name) => name.endsWith('.request.json'))) continue;
        await requests.claimRequests('w1', () => {
          if (throws) throw new Error('start failed after admission');
          return { ok: false, outcome: 'stopped', reason: 'spawning is off' };
        });
        break;
      }
      const result = await pending;
      assert.ok(!result.ok);
      assert.equal(result.code, throws ? 4 : 2);
      if (throws) {
        assert.match(result.reason, /start failed after admission/);
        assert.ok(result.requestId);
        assert.ok(result.reason.includes(result.requestId));
        assert.match(result.reason, /before spawning again/);
        assert.equal(result.cause, undefined);
      } else {
        assert.equal(result.reason, 'spawning is off');
      }
    }
  });

  it('maps an unsure reply to 4 and keeps refusal and write failures distinct in combined results', () => {
    const unsure = { kind: 'refused', reply: { ok: false, unsure: true } } as const;
    const refused = { kind: 'refused' } as const;
    const unwritable = { kind: 'unwritable' } as const;
    const silent = { kind: 'silent' } as const;
    assert.equal(askMod.askExit({ kind: 'unexpected' }), 5);
    assert.equal(askMod.askExit(unsure), 4);
    assert.equal(askMod.askExit([silent, unsure]), 4);
    for (const failures of [
      [refused, silent],
      [silent, refused],
      [refused, unsure]
    ]) {
      assert.equal(askMod.askExit(failures), 2);
    }
    for (const failures of [
      [unwritable, refused],
      [refused, unwritable],
      [silent, unwritable]
    ]) {
      assert.equal(askMod.askExit(failures), 5);
    }
  });

  it('hands a positive reply through', async () => {
    const pending = askMod.ask({ kind: 'close', windowId: 'w1', pid: 2, startedAt: 20 }, 2_000);
    await claimSoon('w1', { ok: true, queued: 3 });
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.reply, { ok: true, queued: 3 });
    assert.ok(result.file.endsWith('.request.json'));
  });
});
