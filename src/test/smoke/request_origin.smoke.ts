import * as platform from '../../core/platform';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CountedAction, SpawnAction } from '../../core/coordination/actions';
import type { Reply, RequestBody } from '../../core/coordination/requests';
import * as boot from './boot';

const state = (): string => path.join(boot.homeDir(), '.squadron');
const cwd = (): string => path.join(boot.homeDir(), 'project');
let windowId: string;
const started: { pid: number; startedAt: number }[] = [];

boot.section(
  'request origin admission in the real host',
  () => {
    boot.step('preserves bare-open and agent lineage classification', async () => {
      windowId = await until('the host claim', async () => {
        const claims = await rows<{ id: string; folder?: string }>('windows');
        return claims.find(
          (claim) =>
            claim.folder !== undefined &&
            platform.paths.key(claim.folder) === platform.paths.key(cwd())
        )?.id;
      });
      for (const origin of [undefined, 'composer'] as const) {
        const { reply, id } = await ask({
          kind: 'open',
          windowId,
          cwd: cwd(),
          brand: 'claude',
          ...(origin ? { origin } : {})
        });
        assert.equal(reply.ok, true, reply.reason);
        assert.ok(reply.pid && reply.startedAt);
        started.push({ pid: reply.pid, startedAt: reply.startedAt });
        assert.ok(!(await rows<SpawnAction>('lineage')).some((row) => row.requestId === id));
      }
      for (const origin of [undefined, 'agent'] as const) {
        const { reply, id } = await ask({
          kind: 'open',
          windowId,
          cwd: cwd(),
          prompt: 'classification work',
          brand: 'claude',
          ...(origin ? { origin } : {})
        });
        assert.equal(reply.ok, true, reply.reason);
        assert.ok(reply.pid && reply.startedAt);
        started.push({ pid: reply.pid, startedAt: reply.startedAt });
        const lineage = await until('the accepted spawn lineage', async () =>
          (await rows<SpawnAction>('lineage')).find((row) => row.requestId === id)
        );
        assert.equal(platform.paths.key(lineage.cwd), platform.paths.key(cwd()));
        assert.equal(lineage.parentSessionId, undefined);
      }
      const rejected = await ask({
        kind: 'open',
        windowId,
        cwd: cwd(),
        prompt: 'conflict',
        origin: 'composer'
      });
      assert.equal(rejected.reply.ok, false);
      assert.equal(rejected.reply.reason, 'That request could not be read.');
      assert.ok(!(await rows<SpawnAction>('lineage')).some((row) => row.requestId === rejected.id));
    });

    boot.step(
      'selects guards and accounting while retaining caller and holder checks',
      async () => {
        const target = started[0];
        assert.ok(target);
        const send = { kind: 'send' as const, windowId, ...target, text: 'classification message' };
        const uncounted: string[] = [];
        for (const body of [
          { ...send, from: 'legacy-caller' },
          { ...send, origin: 'composer' as const },
          { ...send, remote: 'old-holder', from: 'legacy-remote' }
        ]) {
          const result = await ask(body);
          assert.equal(result.reply.ok, true, result.reply.reason);
          uncounted.push(result.id);
        }
        for (const body of [
          { ...send, origin: 'agent' as const, via: 'verb' as const },
          { ...send, origin: 'remote' as const, remote: 'not-the-holder' },
          { ...send, origin: 'composer' as const, via: 'verb' as const, from: 'caller' }
        ]) {
          const result = await ask(body);
          assert.equal(result.reply.ok, false);
          uncounted.push(result.id);
        }
        const accepted: string[] = [];
        for (const origin of [undefined, 'agent'] as const) {
          const result = await ask({
            ...send,
            via: 'verb',
            from: 'caller',
            ...(origin ? { origin } : {})
          });
          assert.equal(result.reply.ok, true, result.reply.reason);
          accepted.push(result.id);
        }
        const actions = await rows<CountedAction>('actions');
        for (const id of accepted)
          assert.equal(
            actions.filter(
              (row) => 'requestId' in row && row.requestId === id && row.kind === 'send'
            ).length,
            1
          );
        for (const id of uncounted)
          assert.ok(!actions.some((row) => 'requestId' in row && row.requestId === id));
      }
    );

    boot.step('closes each started session through the unchanged kind policy', async () => {
      for (const target of started) {
        const result = await ask({ kind: 'close', windowId, ...target });
        assert.equal(result.reply.ok, true, result.reply.reason);
      }
    });
  },
  () => ({ 'squadron.orchestrators.enabled': true })
);

async function ask(body: RequestBody): Promise<{ reply: Reply; id: string }> {
  const id = crypto.randomUUID();
  const dir = path.join(state(), 'requests');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.request.json`);
  await fs.writeFile(file, JSON.stringify({ ...body, id, createdAt: Date.now() }));
  const replyFile = file.replace('.request.json', '.reply.json');
  const reply = await until(`${body.kind} reply`, async () => {
    const text = await fs.readFile(replyFile, 'utf8').catch(() => undefined);
    return text ? (JSON.parse(text) as Reply) : undefined;
  });
  await fs.rm(replyFile, { force: true });
  return { reply, id };
}

async function rows<T>(directory: string): Promise<T[]> {
  const dir = path.join(state(), directory);
  const files = await fs.readdir(dir).catch(() => []);
  return (
    await Promise.all(
      files
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => undefined);
          return text ? { value: JSON.parse(text) as T } : undefined;
        })
    )
  ).flatMap((row) => (row === undefined ? [] : [row.value]));
}

async function until<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await boot.ctx.page.waitForTimeout(50);
  }
}
