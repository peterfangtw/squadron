import * as assert from 'node:assert/strict';
import * as disk from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after } from 'node:test';
import * as boot from './boot';

const control = process.env['SQUADRON_CLEANUP_CONTROL'];
const mode = process.env['SQUADRON_CLEANUP_CASE'] ?? 'success';
const launcher = process.env['SQUADRON_SMOKE_LAUNCHER'];
if (!control) throw new Error('cleanup fixture needs independent control directory');

async function command(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!disk.existsSync(path.join(control!, name))) {
    if (Date.now() > deadline) throw new Error(`oracle did not send ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function ready(name: string): Promise<void> {
  assert.equal(await boot.ctx.page.evaluate(() => 6 * 7), 42);
  assert.equal(await boot.ctx.application.evaluate(() => process.pid), boot.ctx.hostPid);
  const helper = ['success', 'failure', 'relaunch', 'close-error'].includes(mode)
    ? await boot.ctx.application.evaluate<number>(`(() => {
        const cp = process.getBuiltinModule('node:child_process');
        const child = cp.spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        child.unref();
        return child.pid;
      })()`)
    : undefined;
  await fs.writeFile(
    path.join(control!, name),
    JSON.stringify({
      worker: process.pid,
      host: boot.ctx.hostPid,
      helper,
      home: boot.ctx.home,
      profile: boot.ctx.profile
    })
  );
}

function gatedLauncher(): Record<string, unknown> {
  if (mode === 'failed-launch') {
    if (!launcher) throw new Error('fixture has no launcher');
    const failed = path.join(path.dirname(launcher), 'failed.sh');
    disk.writeFileSync(failed, '#!/bin/sh\nexit 23\n', { mode: 0o700 });
    process.env['SQUADRON_SMOKE_LAUNCHER'] = failed;
    return {};
  }
  if (mode !== 'before-ack' && mode !== 'after-ack') return {};
  if (!launcher) throw new Error('fixture has no launcher');
  const source = disk.readFileSync(launcher, 'utf8');
  const gate = `echo $$ > '${control!}/launching'\ni=0\nwhile [ ! -f '${control!}/allow-launch' ]; do\n  i=$((i+1))\n  [ "$i" -lt 600 ] || exit 1\n  sleep 0.1\ndone\n`;
  const altered =
    mode === 'before-ack'
      ? source.replace('#!/bin/sh\n', () => '#!/bin/sh\n' + gate)
      : source.replace('exec "$SQUADRON_SMOKE_IDE"', () => gate + 'exec "$SQUADRON_SMOKE_IDE"');
  const gated = path.join(path.dirname(launcher), 'gated.sh');
  disk.writeFileSync(gated, altered, { mode: 0o700 });
  process.env['SQUADRON_SMOKE_LAUNCHER'] = gated;
  disk.writeFileSync(path.join(control!, 'worker'), String(process.pid));
  return {};
}

boot.section(
  'controlled cleanup fixture',
  () => {
    boot.step('controlled lifecycle', async () => {
      await ready('ready');
      if (mode === 'isolation') {
        for (let i = 1; i <= 3; i++) {
          await command(`ping-${i}`);
          await ready(`pong-${i}`);
        }
      }
      await command('go');
      if (mode === 'success') {
        await boot.closeHost();
        await fs.writeFile(path.join(control, 'closed'), '{}');
        await command('finish');
      }
      if (mode === 'failure' || mode === 'relaunch') assert.fail('injected assertion failure');
      if (mode === 'disposed') {
        // ElectronApplication.process() after disposal is the old closeHost failure.
        await boot.ctx.application.close();
        boot.ctx.application.process = () => {
          throw new Error('disposed process handle');
        };
      }
      if (mode === 'close-error') {
        const original = boot.ctx.page;
        boot.ctx.application.close = () => Promise.reject(new Error('injected close error'));
        await boot.closeHost();
        assert.ok(original.isClosed());
        await boot.closeHost();
      }
    });
  },
  gatedLauncher
);

if (mode === 'relaunch' || mode === 'failed-launch') {
  boot.section(
    'replacement host',
    () => {
      boot.step('replacement answers a page evaluation', async () => {
        await ready('replacement');
        await command('finish');
      });
    },
    () => {
      process.env['SQUADRON_SMOKE_LAUNCHER'] = launcher;
      return {};
    }
  );
}

if (mode === 'linger')
  after(() => {
    setInterval(() => undefined, 1000);
  });
