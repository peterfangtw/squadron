import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { it } from 'node:test';
import * as capture from '../smoke/capture';
import { testPlatform } from '../helpers';

it('copies the failed state and closes a slow copy before HOME can be reset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-capture-'));
  const source = path.join(root, 'home');
  const target = path.join(root, 'snapshot');
  const savedOptions = process.env['NODE_OPTIONS'];
  let slowPid: number | undefined;
  try {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'state'), 'failed');
    await capture.copy(source, target, 3000);
    assert.equal(await fs.readFile(path.join(target, 'state'), 'utf8'), 'failed');
    await fs.rm(target, { recursive: true });
    const preload = path.join(root, 'slow.cjs');
    // Stall the child's filesystem boundary, without a production hook.
    await fs.writeFile(
      preload,
      `const fs=require('node:fs');
require('node:fs/promises').cp=(source,target)=>new Promise(()=>{
  fs.writeFileSync(source+'.pid',String(process.pid));
  setTimeout(()=>fs.writeFileSync(target,'late copy'),5000);
});`
    );
    process.env['NODE_OPTIONS'] = `--require=${JSON.stringify(preload)}`;
    await assert.rejects(capture.copy(source, target, 1000), /copy exceeded/);
    slowPid = Number(await fs.readFile(`${source}.pid`, 'utf8'));
    assert.throws(() => process.kill(slowPid!, 0), { code: 'ESRCH' });
    await fs.writeFile(path.join(source, 'state'), 'reset');
    assert.equal(await fs.stat(target).catch(() => undefined), undefined);
  } finally {
    if (savedOptions === undefined) delete process.env['NODE_OPTIONS'];
    else process.env['NODE_OPTIONS'] = savedOptions;
    if (slowPid) {
      try {
        process.kill(slowPid, 'SIGKILL');
      } catch {
        /* already closed */
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('reports copy errors with filesystem context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-capture-'));
  try {
    await assert.rejects(
      capture.copy(path.join(root, 'missing'), path.join(root, 'copy'), 3000),
      /ENOENT.*missing/s
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it(
  'supervisor evidence excludes live sockets while ordinary capture reports them',
  {
    skip:
      testPlatform() === 'win32' &&
      'win32: Unix filesystem socket exclusion; Windows named-pipe acceptance remains W8.7'
  },
  async () => {
    // The sandbox temp prefix can exceed Darwin's Unix socket path limit.
    // eslint-disable-next-line squadron/temp-root -- the socket path limit above
    const root = await fs.mkdtemp('/tmp/sq-capture-');
    const source = path.join(root, 'home');
    const server = net.createServer();
    try {
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'state'), 'evidence');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path.join(source, 'socket'), resolve);
      });
      await assert.rejects(capture.copy(source, path.join(root, 'ordinary'), 3000), /socket/i);
      await capture.copy(source, path.join(root, 'supervisor'), 3000, true);
      assert.deepEqual(await fs.readdir(path.join(root, 'supervisor')), ['state']);
      assert.equal(await fs.readFile(path.join(root, 'supervisor', 'state'), 'utf8'), 'evidence');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
