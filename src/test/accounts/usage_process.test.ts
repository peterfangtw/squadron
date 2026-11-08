import * as assert from 'node:assert/strict';
import { before, describe, it, type TestContext } from 'node:test';
import * as executables from '../../core/platform/executables';
import { tempHome } from '../helpers';
import type { SessionTransport } from '../../core/session';
import type { UsageSource } from '../../core/adapter';

let pipe: typeof import('../../core/session');
let claude: typeof import('../../core/claude/usage_reader');
let codex: typeof import('../../core/codex/usage');
let runtime: typeof import('../../core/codex/runtime');
let store: typeof import('../../core/usage');
before(async () => {
  await tempHome();
  pipe = await import('../../core/session');
  claude = await import('../../core/claude/usage_reader');
  codex = await import('../../core/codex/usage');
  runtime = await import('../../core/codex/runtime');
  store = await import('../../core/usage');
});

function child(stubborn = false, outcome = 'success', flushMs = 0): SessionTransport {
  return pipe.childTransport({
    bin: executables.named(process.execPath),
    cwd: process.cwd(),
    args: [
      '-e',
      `
      const input = require('node:readline').createInterface({input:process.stdin});
      if (${stubborn}) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
      input.on('close', () => { if (!${stubborn}) setTimeout(() => process.exit(0), ${flushMs}); });
      input.on('line', line => {
        const r = JSON.parse(line), outcome = ${JSON.stringify(outcome)};
        if (outcome === 'silent' || outcome === 'abort') return;
        if (r.type === 'control_request') {
          const response = outcome === 'success' ? {subtype:'success',response:{rate_limits_available:true,rate_limits:{five_hour:{utilization:19}}}} : {subtype:'error',error:'refused'};
          console.log(JSON.stringify({type:'control_response',response:{request_id:r.request_id,...response}}));
        } else if (r.id !== undefined) {
          const success = outcome === 'success' || (outcome === 'request-error' && r.method === 'initialize');
          const result = r.method === 'initialize' ? {} : {rateLimits:{primary:{usedPercent:19,windowDurationMins:300}}};
          console.log(JSON.stringify({id:r.id,...(success?{result}:{error:{code:-32000,message:'refused'}})}));
        }
      });
    `
    ]
  });
}

function track(t: TestContext, transport: SessionTransport): () => boolean {
  let exited = false;
  transport.exited?.then((native) => {
    exited = native;
  });
  t.after(async () => {
    try {
      if (transport.pid) process.kill(transport.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await transport.exited;
  });
  return () => exited;
}

for (const brand of ['claude', 'codex'] as const) {
  describe(`${brand} temporary usage child`, () => {
    for (const stubborn of [false, true]) {
      it(`confirms native exit after a successful fetch${stubborn ? ' even when EOF and TERM are ignored' : ''}`, async (t) => {
        const transport = child(stubborn);
        const exited = track(t, transport);
        const reading =
          brand === 'claude'
            ? await claude.askUsage(transport)
            : await codex.readCodexUsage(undefined, () => runtime.openCodex(transport));
        assert.equal(reading?.windows.find((window) => window.id === 'session')?.pct, 19);
        assert.equal(exited(), true, 'usage returned while its temporary child was still alive');
        assert.throws(() => process.kill(transport.pid!, 0), { code: 'ESRCH' });
      });
    }
    for (const outcome of brand === 'claude'
      ? ['refused', 'silent', 'abort']
      : ['initialize-error', 'request-error', 'silent', 'abort']) {
      it(`confirms native exit after ${outcome}`, async (t) => {
        const controller = new AbortController();
        const transport = child(false, outcome);
        const exited = track(t, transport);
        const timer = outcome === 'abort' ? setTimeout(() => controller.abort(), 100) : undefined;
        t.after(() => clearTimeout(timer));
        const options = { signal: controller.signal };
        const pending =
          brand === 'claude'
            ? claude.askUsage(transport, options)
            : codex.readCodexUsage(
                undefined,
                () => runtime.openCodex(transport, 1000, options),
                options
              );
        const result = await pending.catch((error: unknown) => {
          assert.equal(controller.signal.aborted, true, String(error));
          return undefined;
        });
        assert.equal(result, undefined);
        assert.equal(exited(), true, 'failed fetch returned before the temporary child exited');
      });
    }
    it('keeps newer passive usage received during cleanup', async (t) => {
      await store.forgetUsageFor(brand);
      const transport = child(false, 'success', 350);
      track(t, transport);
      let responded!: () => void;
      const response = new Promise<void>((resolve) => {
        responded = resolve;
      });
      transport.onLine((value) => {
        const frame = value as {
          result?: { rateLimits?: unknown };
          response?: { response?: { rate_limits?: unknown } };
        };
        if (frame.result?.rateLimits || frame.response?.response?.rate_limits) responded();
      });
      const source: UsageSource = {
        windows: [{ id: 'session', short: '5h' }],
        everyMs: 60 * 60_000,
        noResetMs: 5 * 60 * 60_000,
        read: (_override, options) =>
          brand === 'claude'
            ? claude.askUsage(transport, options)
            : codex.readCodexUsage(
                undefined,
                () => runtime.openCodex(transport, undefined, options),
                options
              )
      };
      const pending = store.walkUsage(
        { brand, source, signedIn: true },
        {
          sessions: [],
          now: Date.now(),
          clock: Date.now
        }
      );
      await response;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const at = Date.now();
      await store.noteReading(brand, {
        at,
        windows: [{ id: 'session', short: '5h', pct: 31, at }]
      });
      await pending;
      assert.equal(
        (await store.readStoredUsage(brand))?.windows.find((window) => window.id === 'session')
          ?.pct,
        31
      );
    });
  });
}
