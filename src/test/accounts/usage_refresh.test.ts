import * as assert from 'node:assert/strict';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import type { UsageSource } from '../../core/adapter';
import type { Session } from '../../core/model';
import { disposeHome, tempHome, homeEnv, testPlatform } from '../helpers';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let store: typeof import('../../core/usage');
let home: string;
after(() => disposeHome(home));

/** Its child is non-detached and must outlive its Node host, a POSIX shape:
 *  on Windows that child is in the host's job and ends with it (Step 1). */
const survivalSkip =
  testPlatform() === 'win32' &&
  'win32: a non-detached child ends with its Node host (job), so it cannot outlive it — W3.5';

before(async () => {
  home = await tempHome();
  store = await import('../../core/usage');
});
beforeEach(async () => {
  await store.forgetUsageFor('claude');
});

afterEach(async () => {
  const paths = await import('../../core/paths');
  await fs.rm(paths.usageStateFile('claude'), { force: true });
});

const HOUR = 60 * 60_000;
const source = (read: UsageSource['read']): UsageSource => ({
  windows: [{ id: 'weekly', short: 'wk' }],
  read,
  everyMs: HOUR,

  noResetMs: 7 * 24 * HOUR
});

describe('hourly usage freshness', () => {
  it('uses a fresh session reading without spending an active read', async () => {
    let reads = 0;
    const now = Date.now();
    const port = source(() => {
      reads++;
      return Promise.resolve(undefined);
    });
    const session = {
      pid: 17,
      brand: 'claude',
      rateLimits: { at: now, windows: [{ id: 'weekly', short: 'wk', pct: 12, at: now }] }
    } as Session;
    await store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
      sessions: [session],
      now
    });
    assert.equal(reads, 0);
  });

  it('retains the failure cooldown when another window opens', async () => {
    let reads = 0;
    const now = Date.now();
    const port = source(() => {
      reads++;
      return Promise.reject(new Error('offline'));
    });
    const pass = (at: number) =>
      store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
        sessions: [],
        now: at
      });
    await pass(now);
    store.invalidate();

    await pass(now + 1000);
    assert.equal(reads, 1);
    assert.equal(await store.readStoredUsage('claude'), undefined);
  });
  it('postpones checks for unchanged fresh usage but not repeated snapshots', async () => {
    const now = Date.now() - 2 * HOUR;
    let reads = 0;
    const port = source(() => {
      reads++;
      return Promise.resolve(undefined);
    });
    const reading = (at: number) => ({ at, windows: [{ id: 'weekly', short: 'wk', pct: 12, at }] });
    await store.noteReading('claude', reading(now));
    const snapshot = { pid: 17, brand: 'claude', rateLimits: reading(now + HOUR / 2) } as Session;
    const pass = (at: number) =>
      store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
        sessions: [snapshot],
        now: at
      });
    await pass(now + HOUR);
    assert.equal(reads, 0);
    await pass(now + HOUR * 1.5 - 1);
    assert.equal(reads, 0);
    await pass(now + HOUR * 1.5);
    assert.equal(reads, 1, 'a repeated snapshot kept postponing the deadline');
  });

  it('preserves the last success timestamp when a stale fetch fails', async () => {
    const at = Date.now() - 2 * HOUR;
    await store.noteReading('claude', {
      at,
      windows: [{ id: 'weekly', short: 'wk', pct: 24, at }]
    });
    let reads = 0;
    const port = source(() => {
      reads++;
      return Promise.reject(new Error('offline'));
    });
    const now = at + 2 * HOUR;
    const pass = (when: number) =>
      store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
        sessions: [],
        now: when
      });
    await pass(now);
    await pass(now + HOUR - 1);
    assert.equal(reads, 1);
    assert.equal((await store.readStoredUsage('claude'))?.at, at);
    await pass(now + HOUR);
    assert.equal(reads, 2);
  });

  it('accepts a passive observation while a fetch is blocked and keeps the newer reading', async () => {
    const now = Date.now();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: import('../../core/model').RateLimits) => void;
    const port = source(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
      sessions: [],
      now
    });
    await entered;
    await store.noteReading('claude', {
      at: now,
      windows: [{ id: 'weekly', short: 'wk', pct: 30, at: now }]
    });
    finish({ at: now - 1000, windows: [{ id: 'weekly', short: 'wk', pct: 12, at: now - 1000 }] });
    await pending;
    assert.equal((await store.readStoredUsage('claude'))?.windows[0]?.pct, 30);
  });

  it('fences a response and retained session snapshot across sign-out', async () => {
    const coordination = await import('../../core/coordination/usage');
    const generation = await coordination.generation('claude');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (value: import('../../core/model').RateLimits) => void;
    const port = source(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const now = Date.now();
    const pending = store.walkUsage(
      [{ brand: 'claude', source: port, signedIn: true, generation }],
      { sessions: [], now }
    );
    await started;
    await store.forgetUsageFor('claude');
    const stale = { at: now, windows: [{ id: 'weekly', short: 'wk', pct: 12, at: now }] };
    finish(stale);
    await pending;
    assert.equal(await store.readStoredUsage('claude'), undefined);
    const session = {
      pid: 17,
      brand: 'claude',
      rateLimits: stale,
      usageGeneration: generation
    } as Session;
    await store.walkUsage(
      [{ brand: 'claude', source: source(() => Promise.resolve(undefined)), signedIn: true }],
      {
        sessions: [session],
        now: Date.now()
      }
    );
    assert.equal(await store.readStoredUsage('claude'), undefined);
  });

  it('shares attempt admission and failure cooldown between real processes', async () => {
    const marker = path.join(home, 'attempts');
    const module = require.resolve('../../core/usage');
    const code = `
      const fs = require('node:fs/promises');
      const usage = require(${JSON.stringify(module)});
      const source = {
        windows: [{id:'weekly',short:'wk'}], everyMs: ${HOUR}, noResetMs: ${7 * 24 * HOUR},
        read: async () => { await fs.appendFile(${JSON.stringify(marker)}, 'x'); await new Promise(r=>setTimeout(r,150)); return undefined; }
      };
      usage.walkUsage([{brand:'claude',source,signedIn:true}],{sessions:[],now:Date.now()}).catch(e=>{console.error(e);process.exitCode=1});
    `;
    const run = () =>
      promisify(execFile)(process.execPath, ['-e', code], {
        env: { ...process.env, ...homeEnv(home) },
        timeout: 10_000
      });
    await Promise.all([run(), run()]);
    await run();
    assert.equal(await fs.readFile(marker, 'utf8'), 'x');
  });
  it('does not start a fetch when attempt admission cannot be persisted', async (t) => {
    const files = await import('../../core/files');
    t.mock.method(files, 'writeAtomicJson', () => Promise.resolve(false));
    let reads = 0;
    await assert.rejects(
      store.walkUsage(
        [
          {
            brand: 'claude',
            source: source(() => {
              reads++;
              return Promise.resolve(undefined);
            }),
            signedIn: true
          }
        ],
        {
          sessions: [],
          now: Date.now()
        }
      ),
      /persist usage cooldown/
    );
    assert.equal(reads, 0);
  });

  it('retries publishing a completed cooldown without repeating the fetch', async (t) => {
    const files = await import('../../core/files');
    const original = files.writeAtomicJson;
    let failing = false;
    t.mock.method(files, 'writeAtomicJson', (...args: Parameters<typeof original>) =>
      failing ? Promise.resolve(false) : original(...args)
    );
    let reads = 0;
    const port = source(() => {
      reads++;
      failing = true;
      return Promise.resolve(undefined);
    });
    const now = Date.now();
    const pass = (at: number) =>
      store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
        sessions: [],
        now: at
      });
    await assert.rejects(pass(now), /persist usage cooldown/);
    failing = false;
    await pass(now + 1000);
    assert.equal(reads, 1);
  });
  for (const published of [true, false]) {
    it(`recovers an interrupted attempt ${published ? 'with a fresh cooldown' : 'only after native identity is known'}`, async () => {
      const coordination = await import('../../core/coordination/usage');
      const module = require.resolve('../../core/coordination/usage');
      const code = `
          const usage = require(${JSON.stringify(module)});
          (async () => {
            const attempt = await usage.admit('claude', undefined, Date.now(), ${HOUR});
            if (${published}) await usage.remember('claude', undefined, attempt, []);
            process.exit(23);
          })().catch(e => { console.error(e); process.exit(1); });
        `;
      await assert.rejects(
        promisify(execFile)(process.execPath, ['-e', code], {
          env: { ...process.env, ...homeEnv(home) },
          timeout: 10_000
        }),
        { code: 23 }
      );
      const now = Date.now() + 2 * HOUR;
      if (!published) {
        await assert.rejects(coordination.admit('claude', undefined, now), /no native identity/);
        return;
      }
      assert.equal(await coordination.admit('claude', undefined, now), undefined);
      assert.equal(await coordination.admit('claude', undefined, now + HOUR - 1), undefined);
      const attempt = await coordination.admit('claude', undefined, now + HOUR);
      assert.ok(attempt);
      await coordination.complete('claude', undefined, attempt, now + HOUR, HOUR);
    });
  }
  for (const observed of [false, true]) {
    it(`preserves new account eligibility after old cleanup (${observed ? 'fresh reading' : 'no reading'})`, async () => {
      const coordination = await import('../../core/coordination/usage');
      const now = Date.now();
      const old = await coordination.admit('claude', undefined, now);
      assert.ok(old);
      await store.forgetUsageFor('claude');
      const code = `
        const usage = require(${JSON.stringify(require.resolve('../../core/coordination/usage'))});
        usage.admit('claude', undefined, ${now}).then(attempt => {
          if (attempt) throw new Error('overlapping reader admitted');
        }).catch(e => { console.error(e); process.exitCode = 1; });
      `;
      await promisify(execFile)(process.execPath, ['-e', code], {
        env: { ...process.env, ...homeEnv(home) },
        timeout: 10_000
      });
      if (observed)
        await store.noteReading('claude', {
          at: now,
          windows: [{ id: 'weekly', short: 'wk', pct: 12, at: now }]
        });
      await coordination.complete('claude', undefined, old, now, HOUR);
      const next = await coordination.admit('claude', undefined, now);
      assert.equal(Boolean(next), !observed);
      if (next) await coordination.complete('claude', undefined, next, now, HOUR);
    });
  }
  it('bounds a future cooldown after the clock moves backwards', async () => {
    const coordination = await import('../../core/coordination/usage');
    const now = Date.now();
    await coordination.mutate('claude', undefined, (state) => {
      state.notBefore = now + 365 * 24 * HOUR;
    });
    let reads = 0;
    const port = source(() => {
      reads++;
      return Promise.resolve(undefined);
    });
    const pass = (at: number) =>
      store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
        sessions: [],
        now: at
      });
    await pass(now);
    await pass(now + 1000);
    assert.equal(reads, 0);
    await pass(now + HOUR);
    assert.equal(reads, 1);
  });
  it('drops another host cached reading after the account generation changes', async (t) => {
    const ready = path.join(home, 'cache-ready'),
      gate = path.join(home, 'cache-go');
    const at = Date.now() - 1000;
    await store.noteReading('claude', {
      at,
      windows: [
        { id: 'session', short: '5h', pct: 61, at },
        { id: 'weekly', short: 'wk', pct: 77, at }
      ]
    });
    const module = require.resolve('../../core/usage');
    const coordination = require.resolve('../../core/coordination/usage');
    const code = `
      const fs=require('node:fs/promises'), usage=require(${JSON.stringify(module)}), coordination=require(${JSON.stringify(coordination)});
      (async()=>{
        const source={windows:[{id:'session',short:'5h'},{id:'weekly',short:'wk'}],everyMs:${HOUR},noResetMs:${7 * 24 * HOUR},read:()=>Promise.resolve(undefined)};
        await usage.usageFor('claude',source);
        await fs.writeFile(${JSON.stringify(ready)},'1');
        while(!(await fs.access(${JSON.stringify(gate)}).then(()=>true,()=>false))) await new Promise(r=>setTimeout(r,10));
        const after=await usage.usageFor('claude',source);
        const at=Date.now();
        await usage.noteReading('claude',{at,windows:[{id:'session',short:'5h',pct:12,at}]},{generation:await coordination.generation('claude')});
        console.log(JSON.stringify({after,merged:await usage.readStoredUsage('claude')}));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const pending = promisify(execFile)(process.execPath, ['-e', code], {
      env: { ...process.env, ...homeEnv(home) },
      timeout: 10000
    });
    t.after(async () => {
      await fs.writeFile(gate, '1');
      await pending.catch(() => undefined);
    });
    const until = Date.now() + 5000;
    while (
      !(await fs.access(ready).then(
        () => true,
        () => false
      ))
    ) {
      assert.ok(Date.now() < until, 'second host did not hydrate usage');
      await new Promise((r) => setTimeout(r, 10));
    }
    await store.forgetUsageFor('claude');
    await fs.writeFile(gate, '1');
    const result = JSON.parse((await pending).stdout) as {
      after?: unknown;
      merged: { windows: { id: string; pct?: number }[] };
    };
    assert.equal(result.after, undefined);
    assert.equal(
      result.merged.windows.find((window) => window.id === 'weekly'),
      undefined
    );
  });

  it('retains an unidentified child after its host dies', { skip: survivalSkip }, async (t) => {
    const coordination = await import('../../core/coordination/usage');
    const childCode =
      "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);console.log('{}');";
    const code = `
      const usage=require(${JSON.stringify(require.resolve('../../core/coordination/usage'))});
      const scan=require(${JSON.stringify(require.resolve('../../core/scan'))});
      const pipe=require(${JSON.stringify(require.resolve('../../core/session'))});
      const temporary=require(${JSON.stringify(require.resolve('../../core/temporary_session'))});
      const executables=require(${JSON.stringify(require.resolve('../../core/platform/executables'))});
      (async()=>{
        const attempt=await usage.admit('claude',undefined,Date.now(),${HOUR});
        await usage.starting('claude',undefined,attempt);
        const table=await scan.scanProcesses(true);
        const transport=pipe.childTransport({bin:executables.named(process.execPath),cwd:process.cwd(),args:['-e',${JSON.stringify(childCode)}]});
        console.log(JSON.stringify({childPid:transport.pid,attempt:attempt.id}));
        const ready=new Promise(resolve=>transport.onLine(resolve));
        scan.scanProcesses=()=>Promise.resolve({...table,complete:false,starts:new Map(),parents:new Map(),groups:new Map()});
        await temporary.withTemporarySession(transport,async()=>{await ready;process.exit(23);},{remember:members=>usage.remember('claude',undefined,attempt,members)});
      })().catch(e=>{console.error(e);process.exit(1)});
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', code], {
      env: { ...process.env, ...homeEnv(home) },
      timeout: 10000
    }).then(
      (value) => ({ ...value, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error
    );
    const record = JSON.parse(result.stdout.trim().split('\n')[0]!) as {
      childPid: number;
      attempt: string;
    };
    const childPid = record.childPid;
    t.after(() => {
      try {
        if (childPid) process.kill(childPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });

    assert.equal(result.code, 23, result.stderr);
    assert.equal(process.kill(childPid, 0), true);
    await coordination.admit('claude', undefined, Date.now() + 2 * HOUR);
    assert.equal(
      (await coordination.readState('claude'))?.attempt?.id,
      record.attempt,
      'unknown root was mistaken for an operation with no child'
    );
  });
  it('persists owned quota while an earlier brand fetch is blocked', async (t) => {
    const { Reconciler } = await import('../../core/reconcile');
    const { UsageRefresher } = await import('../../core/usage_refresh');
    const coordination = await import('../../core/coordination/usage');
    await store.forgetUsageFor('codex');
    let started!: () => void, finish: ((reading: undefined) => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let codexReads = 0;
    const brands = [
      {
        brand: 'claude' as const,
        signedIn: true,
        generation: await coordination.generation('claude'),
        source: source(() => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        })
      },
      {
        brand: 'codex' as const,
        signedIn: true,
        generation: await coordination.generation('codex'),
        source: source(() => {
          codexReads++;
          return Promise.resolve(undefined);
        })
      }
    ];
    let sessions: Session[] = [];
    const runtime = new Reconciler();
    const refresher = new UsageRefresher(runtime, {
      brands: () => Promise.resolve(brands),
      observations: () => Promise.resolve(brands),
      sessions: () => sessions,
      now: Date.now,
      log: () => {}
    });
    t.after(async () => {
      finish?.(undefined);
      await refresher.dispose();
      runtime.dispose();
      await store.forgetUsageFor('codex');
    });
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const schedule = refresher.registration.schedule.bind(refresher.registration);
    t.mock.method(refresher.registration, 'schedule', (at: number | undefined) => {
      schedule(at);
      complete();
    });
    refresher.registration.requestCheck();
    await entered;
    const at = Date.now();
    sessions = [
      {
        pid: 19,
        brand: 'codex',
        usageGeneration: brands[1]!.generation,
        rateLimits: { at, windows: [{ id: 'weekly', short: 'wk', pct: 31, at }] }
      } as Session
    ];
    refresher.observations.requestCheck();
    const until = Date.now() + 2000;
    while ((await store.readStoredUsage('codex'))?.windows[0]?.pct !== 31) {
      assert.ok(Date.now() < until, 'passive usage was held behind the blocked fetch');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    finish?.(undefined);
    await done;
    assert.equal(codexReads, 0, 'a stale session snapshot caused an unnecessary later-brand fetch');
  });
  it('persists healthy passive quota after another brand store fails', async (t) => {
    const { Reconciler } = await import('../../core/reconcile');
    const { UsageRefresher } = await import('../../core/usage_refresh');
    const coordination = await import('../../core/coordination/usage');
    const paths = await import('../../core/paths');
    await store.forgetUsageFor('codex');
    const generation = await coordination.generation('claude');
    await fs.writeFile(paths.usageStateFile('claude'), '{}');
    const at = Date.now();
    const brands = [
      {
        brand: 'claude' as const,
        signedIn: true,
        generation,
        source: source(() => Promise.resolve(undefined))
      },
      {
        brand: 'codex' as const,
        signedIn: true,
        generation: await coordination.generation('codex'),
        source: source(() => Promise.resolve(undefined))
      }
    ];
    const runtime = new Reconciler();
    let ingest!: () => Promise<void>;
    const register = runtime.register.bind(runtime);
    t.mock.method(runtime, 'register', (...args: Parameters<typeof register>) => {
      if (args[0] === 'usage observations') ingest = args[2];
      return register(...args);
    });
    const refresher = new UsageRefresher(runtime, {
      brands: () => Promise.resolve([]),
      observations: () => Promise.resolve(brands),
      sessions: () => [
        {
          pid: 2,
          brand: 'claude',
          usageGeneration: generation,
          rateLimits: { at, windows: [{ id: 'weekly', short: 'wk', pct: 12, at }] }
        } as Session,
        {
          pid: 1,
          brand: 'codex',
          usageGeneration: brands[1]!.generation,
          rateLimits: { at, windows: [{ id: 'weekly', short: 'wk', pct: 31, at }] }
        } as Session
      ],
      now: Date.now,
      log: () => {}
    });
    t.after(async () => {
      await refresher.dispose();
      runtime.dispose();
      await store.forgetUsageFor('codex');
    });
    await ingest().catch(() => {});
    assert.equal((await store.readStoredUsage('codex'))?.windows[0]?.pct, 31);
  });

  it('retries unknown account auth independently of a fresh account quota deadline', async (t) => {
    const { Reconciler } = await import('../../core/reconcile');
    const { UsageRefresher } = await import('../../core/usage_refresh');
    const signin = await import('../../core/signin');
    signin.resetSignInForTest();
    t.after(() => signin.resetSignInForTest());
    let now = Date.now(),
      asks = 0;
    const auth = {
      stamp: () => Promise.resolve('new-account'),
      status: () => {
        asks++;
        return Promise.resolve(asks === 1 ? undefined : { loggedIn: true });
      }
    };
    await store.noteReading('claude', {
      at: now,
      windows: [{ id: 'weekly', short: 'wk', pct: 12, at: now }]
    });
    const runtime = new Reconciler();
    const refresher = new UsageRefresher(runtime, {
      brands: async () => {
        await signin.signInFor('grok', auth, { now });
        return [
          {
            brand: 'claude',
            source: source(() => {
              throw new Error('fresh quota fetched');
            }),
            signedIn: true
          }
        ];
      },
      observations: () => Promise.resolve([]),
      sessions: () => [],
      now: () => now,
      retryAt: () => signin.signInRetryAt(),
      log: () => {}
    });
    t.after(async () => {
      await refresher.dispose();
      runtime.dispose();
    });
    const check = (): Promise<number | undefined> =>
      new Promise((resolve) => {
        t.mock.method(refresher.registration, 'schedule', resolve);
        refresher.registration.requestCheck();
      });
    assert.equal(await check(), now + signin.RETRY_MS);
    now += signin.RETRY_MS;
    assert.equal(await check(), now - signin.RETRY_MS + HOUR);
    assert.equal(asks, 2);
  });
  it('does not discard another brand usage when one account signs out', async () => {
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const port = source(() => {
      started();
      return new Promise((resolve) => {
        finish = () => resolve({ windows: [{ id: 'weekly', short: 'wk', pct: 23 }] });
      });
    });
    const pending = store.walkUsage([{ brand: 'claude', source: port, signedIn: true }], {
      sessions: [],
      now: Date.now(),
      clock: Date.now
    });
    await entered;
    await store.forgetUsageFor('grok');
    finish();
    await pending;
    assert.equal((await store.readStoredUsage('claude'))?.windows[0]?.pct, 23);
  });
});
