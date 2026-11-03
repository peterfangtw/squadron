/**
 * The reusable stdin reader's lifetime against portable Node children that
 * speak (or break) its frame protocol, and one native PowerShell read.
 */

import * as assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, afterEach, before, describe, it } from 'node:test';
import * as owned from '../../core/platform/processes/win32_owned_reader';
import * as win32 from '../../core/platform/processes/win32';
import * as reader from '../../core/platform/processes/win32_reader';
import * as helpers from '../helpers';

let home: string;
let fake: string;

before(async () => {
  home = await helpers.tempHome();
  fake = path.join(home, 'fake_reader.js');
  await fs.promises.writeFile(fake, FAKE);
});

after(() => fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const nativeSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows PowerShell reader';

const FAST: owned.Timing = {
  coldMs: 3_000,
  warmMs: 1_000,
  idleMs: 10_000,
  backoffFirstMs: 100,
  backoffMaxMs: 400,
  endGraceMs: 300,
  closeWaitMs: 5_000
};

/**
 * A stand-in reader: answers `read <nonce>` lines per its mode and exits on
 * stdin EOF (except `ignore-eof`). Every request is logged with its time, and
 * `overlap` if one arrives while another is being answered.
 */
const FAKE = String.raw`
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
const b64 = (text) => 'b64:' + Buffer.from(text, 'utf8').toString('base64');
const note = (line) => fs.appendFileSync(log, line + '\n');
const KERNEL = '4 0 134374051838139320';
const command = process.env.FAKE_COMMAND || '中文 😀';
function frame(nonce, self = process.pid) {
  const rows = [KERNEL + ' ' + b64('System') + ' -', self + ' 4 134374051838571739 ' + b64('node.exe') + ' ' + b64(command)];
  return ['v3 ' + nonce, 'self ' + self, 'kernel ' + KERNEL, 'count ' + rows.length, ...rows, 'end ' + nonce + ' ' + rows.length, ''].join('\r\n');
}
let busy = false;
let served = 0;
let pending = '';
setTimeout(() => process.exit(3), 20000);
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  let at;
  while ((at = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    const nonce = /^read ([0-9a-f]{32})$/.exec(line)?.[1];
    if (!nonce) { note('bad ' + line); process.exit(4); }
    if (busy) note('overlap');
    note('start ' + nonce + ' ' + Date.now());
    answer(nonce, served++);
  }
});
process.stdin.on('end', () => { note('eof'); if (mode !== 'ignore-eof') process.exit(0); });
function done(nonce) { busy = false; note('done ' + nonce + ' ' + Date.now()); }
async function bytewise(buffer) {
  for (const byte of buffer) await new Promise((resolve) => process.stdout.write(Buffer.from([byte]), resolve));
}
async function answer(nonce, index) {
  busy = true;
  const text = frame(nonce);
  switch (mode) {
    case 'good': case 'ignore-eof':
      process.stdout.write(text, () => done(nonce)); return;
    case 'slow':
      // Logged before the reply: the reader can settle and the test read this log before a write callback runs.
      setTimeout(() => { done(nonce); process.stdout.write(text); }, 150); return;
    case 'split':
      await bytewise(Buffer.from(text, 'utf8')); done(nonce); return;
    case 'raw-split': {
      const raw = Buffer.from(text.replace(b64(command), '中文'), 'utf8');
      const cut = raw.indexOf(Buffer.from('中', 'utf8')) + 1;
      process.stdout.write(raw.subarray(0, cut));
      setTimeout(() => process.stdout.write(raw.subarray(cut), () => done(nonce)), 50);
      return;
    }
    case 'bad-utf8':
      process.stdout.write(Buffer.concat([Buffer.from(text.replace('self ', 'self \u0000'), 'utf8').subarray(0, 40), Buffer.from([0xff]), Buffer.from(text, 'utf8').subarray(40)]));
      return;
    case 'forged':
      process.stdout.write(frame('f'.repeat(32))); return;
    case 'oversize': {
      const block = Buffer.alloc(64 * 1024, 'x');
      for (let i = 0; i < 130; i++) process.stdout.write(block);
      return;
    }
    case 'partial-exit':
      process.stdout.write(text.slice(0, 60), () => process.exit(0)); return;
    case 'partial-hang':
      process.stdout.write(text.slice(0, 60)); return;
    case 'stall':
      return;
    case 'stall-second':
      if (index === 0) process.stdout.write(text, () => done(nonce));
      return;
    case 'stderr':
      process.stderr.write('boom'); return;
    case 'trailing':
      process.stdout.write(text + 'extra\r\n'); return;
    case 'unsolicited':
      process.stdout.write(text, () => { done(nonce); setTimeout(() => process.stdout.write('hello\r\n'), 50); });
      return;
    case 'fail-start':
      process.exit(5);
  }
}
`;

/** How a child closed; `PENDING` until its `close` event, which is not a signal exit. */
type End = { code: number | null; signal: NodeJS.Signals | null };
const PENDING = 'pending' as const;

type Harness = {
  effects: owned.OwnedEffects;
  children: ChildProcessWithoutNullStreams[];
  ends: Array<End | typeof PENDING>;
  /** Each child's close, captured at spawn so no event can be missed. */
  closed: Promise<End>[];
  closes: number[];
  starts: Array<{ file: string; args: readonly string[]; at: number }>;
  log: string;
  mode: string;
  lines(): string[];
};

const harnesses: Harness[] = [];
const readers: owned.OwnedReader[] = [];

function harness(mode: string, env: NodeJS.ProcessEnv = {}): Harness {
  const log = path.join(home, `log-${harnesses.length}-${mode}.txt`);
  const h: Harness = {
    mode,
    log,
    children: [],
    ends: [],
    closed: [],
    closes: [],
    starts: [],
    lines: () =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    effects: {
      windowsDirectory: 'D:\\Windows',
      start(file, args) {
        h.starts.push({ file, args, at: performance.now() });
        const child = spawn(process.execPath, [fake, h.mode, log], {
          stdio: 'pipe',
          windowsHide: true,
          env: { ...process.env, ...helpers.homeEnv(home), ...env }
        });
        const index = h.children.push(child) - 1;
        h.ends.push(PENDING);
        h.closed.push(
          new Promise((resolve) =>
            child.once('close', (code, signal) => {
              h.closes[index] = performance.now();
              h.ends[index] = { code, signal };
              resolve({ code, signal });
            })
          )
        );
        return child;
      }
    }
  };
  harnesses.push(h);
  return h;
}

function open(h: Harness, timing: Partial<owned.Timing> = {}): owned.OwnedReader {
  const r = owned.ownedReader(h.effects, { ...FAST, ...timing });
  readers.push(r);
  return r;
}

/**
 * A child whose `close` has not arrived once `dispose` returns outlived it.
 * `ChildProcess.kill` ends it through its own handle; a bare pid is never
 * probed or signalled, because Windows may already have reused it.
 */
afterEach(async () => {
  for (const r of readers.splice(0)) await r.dispose();
  const leaked = harnesses
    .splice(0)
    .flatMap((h) =>
      h.children.flatMap((child, i) =>
        h.ends[i] === PENDING ? [{ child, close: h.closed[i] }] : []
      )
    );
  for (const { child } of leaked) child.kill();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(leaked.map(({ close }) => close ?? Promise.resolve())),
    new Promise((resolve) => {
      timer = setTimeout(resolve, FAST.closeWaitMs);
    })
  ]);
  clearTimeout(timer);
  assert.deepEqual(
    leaked.map(({ child }) => `fixture reader ${child.pid} outlived disposal`),
    []
  );
});

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(check: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    assert.ok(Date.now() - started < ms, 'did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function reason(read: reader.NativeRead): string {
  return read.status === 'ok' ? 'ok' : read.reason;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a failure naming `what` once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not close within ${ms} ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets stream events and settled promises run; `setImmediate` is never mocked here. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * An in-process child that answers reads with a valid frame, records EOF and
 * kills, and closes only on EOF (`exitOnEof`), on kill, or by `close`. With
 * mocked timers it makes the shutdown policy deterministic.
 */
function scripted(exitOnEof: boolean) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events: string[] = [];
  const emitter = new EventEmitter();
  let ended = false;
  const close = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return;
    ended = true;
    process.nextTick(() => emitter.emit('close', code, signal));
  };
  const child = Object.assign(emitter, {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill: () => {
      events.push('kill');
      close(null, 'SIGTERM');
      return true;
    }
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const nonce = /^read ([0-9a-f]{32})$/.exec(line)?.[1];
      if (nonce) stdout.write(scriptedFrame(nonce));
    }
  });
  stdin.on('end', () => {
    events.push('eof');
    if (exitOnEof) close(0, null);
  });
  return { child, events, close };
}

function scriptedFrame(nonce: string): string {
  const b64 = (text: string) => 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  const kernel = '4 0 134374051838139320';
  const rows = [
    `${kernel} ${b64('System')} -`,
    `4242 4 134374051838571739 ${b64('node.exe')} ${b64('node fake')}`
  ];
  return [
    `v3 ${nonce}`,
    'self 4242',
    `kernel ${kernel}`,
    `count ${rows.length}`,
    ...rows,
    `end ${nonce} ${rows.length}`,
    ''
  ].join('\r\n');
}

/**
 * A child the OS will not end: its kill returns false and reports EPERM, or
 * throws. It ignores EOF and closes only when the test lets it. It answers
 * reads only when `answers` is set.
 */
function stubborn(how: 'false' | 'throws', answers: boolean, pid = 9100) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let closed = false;
  const events: string[] = [];
  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    kill: () => {
      events.push('kill');
      if (how === 'throws') throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      process.nextTick(() =>
        emitter.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))
      );
      return false;
    }
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const nonce = /^read ([0-9a-f]{32})$/.exec(line)?.[1];
      if (nonce && answers) stdout.write(scriptedFrame(nonce));
    }
  });
  stdin.on('end', () => events.push('eof'));
  return {
    child,
    events,
    close() {
      if (closed) return;
      closed = true;
      emitter.emit('close', null, 'SIGTERM');
    }
  };
}

describe('a reusable reader whose child will not end', () => {
  const quick: owned.Timing = {
    ...FAST,
    coldMs: 100,
    warmMs: 100,
    backoffFirstMs: 1,
    backoffMaxMs: 1,
    endGraceMs: 30,
    closeWaitMs: 150
  };
  const stubborns = (how: 'false' | 'throws', answers: boolean) => {
    const children: ReturnType<typeof stubborn>[] = [];
    const effects: owned.OwnedEffects = {
      windowsDirectory: 'D:\\Windows',
      start: () => {
        const c = stubborn(how, answers);
        children.push(c);
        return c.child;
      }
    };
    return { children, effects };
  };

  for (const how of ['false', 'throws'] as const) {
    it(`starts no second child while the first is unresolved (kill ${how})`, async () => {
      const { children, effects } = stubborns(how, false);
      const r = owned.ownedReader(effects, quick);
      try {
        assert.equal((await r.read()).status, 'failed');
        await sleep(20);
        const second = await r.read();
        assert.equal(second.status, 'failed');
        assert.equal(children.length, 1, 'no replacement while the first has not closed');
        assert.match(reason(second), /did not close/);
        // EOF is asked first; the stream reports its `end` a tick later.
        assert.deepEqual(children[0]?.events.slice(0, 2).sort(), ['eof', 'kill']);
        assert.deepEqual(await within(r.dispose(), 2_000, 'disposal'), { unresolved: [9100] });
      } finally {
        for (const c of children) c.close();
      }
    });
  }

  it('reports an idle child that ignored EOF and refused its kill, and replaces it once it closes', async () => {
    const { children, effects } = stubborns('false', true);
    const r = owned.ownedReader(effects, { ...quick, idleMs: 30 });
    try {
      assert.equal((await r.read()).status, 'ok');
      await sleep(30 + 30 + 150 + 150);
      assert.deepEqual(children[0]?.events.slice().sort(), ['eof', 'kill']);
      assert.equal((await r.read()).status, 'failed');
      assert.equal(children.length, 1);
      children[0]?.close();
      await flush();
      assert.equal((await r.read()).status, 'ok');
      assert.equal(children.length, 2);
      children[1]?.close();
      assert.deepEqual(await within(r.dispose(), 2_000, 'disposal'), { unresolved: [] });
    } finally {
      for (const c of children) c.close();
    }
  });
});

describe('the backend bound on a child that will not end, across leases and one-shot reads', () => {
  const quick: owned.Timing = {
    ...FAST,
    coldMs: 100,
    warmMs: 100,
    backoffFirstMs: 1,
    backoffMaxMs: 1,
    endGraceMs: 30,
    closeWaitMs: 150
  };
  const status = (snapshot: import('../../core/platform/processes').Snapshot) =>
    snapshot.supported ? snapshot.status : 'unsupported';
  const failure = (snapshot: import('../../core/platform/processes').Snapshot) =>
    snapshot.supported && snapshot.status === 'failed' ? snapshot.reason : '';
  /** A backend whose leased children refuse to end and whose one-shot runs are counted. */
  function backend() {
    const children: ReturnType<typeof stubborn>[] = [];
    let oneShots = 0;
    const processes = win32.processes(
      {
        windowsDirectory: 'D:\\Windows',
        start: () => {
          const c = stubborn('false', true, 9100 + children.length);
          children.push(c);
          return c.child;
        },
        run: () => {
          oneShots += 1;
          return Promise.reject(new Error('one-shot sentinel'));
        },
        kill: () => {},
        record: () => {}
      },
      quick
    );
    return { children, processes, oneShots: () => oneShots };
  }

  it('keeps the exclusion after the last lease is released, and reacquired', async () => {
    const { children, processes, oneShots } = backend();
    try {
      const first = processes.own();
      assert.equal(status(await processes.snapshot()), 'ok');
      assert.deepEqual(await within(first.dispose(), 2_000, 'release'), { unresolved: [9100] });
      const late = await processes.snapshot();
      assert.equal(status(late), 'failed');
      assert.match(failure(late), /9100 did not close/);
      assert.equal(oneShots(), 0, 'no one-shot while the released child is open');
      const second = processes.own();
      assert.equal(status(await processes.snapshot()), 'failed');
      assert.equal(children.length, 1, 'no second reusable child either');
      assert.deepEqual(await within(second.dispose(), 2_000, 'release'), { unresolved: [9100] });
      children[0]?.close();
      await flush();
      const third = processes.own();
      assert.equal(status(await processes.snapshot()), 'ok');
      assert.equal(children.length, 2, 'a replacement once the first closed');
      children[1]?.close();
      assert.deepEqual(await within(third.dispose(), 2_000, 'release'), { unresolved: [] });
    } finally {
      for (const c of children) c.close();
    }
  });

  it('holds a one-shot read that arrives while the release is still ending its child', async () => {
    const { children, processes, oneShots } = backend();
    try {
      const lease = processes.own();
      assert.equal(status(await processes.snapshot()), 'ok');
      const releasing = lease.dispose();
      const late = await processes.snapshot();
      assert.equal(status(late), 'failed');
      assert.match(failure(late), /9100 did not close/);
      assert.equal(oneShots(), 0);
      assert.deepEqual(await within(releasing, 2_000, 'release'), { unresolved: [9100] });
      children[0]?.close();
      await flush();
      assert.equal(status(await processes.snapshot()), 'failed');
      assert.equal(oneShots(), 1, 'one-shot reads resume once it closed');
    } finally {
      for (const c of children) c.close();
    }
  });
});

describe('the handoff from an active one-shot read to a leased reader', () => {
  const status = (snapshot: import('../../core/platform/processes').Snapshot) =>
    snapshot.supported ? snapshot.status : 'unsupported';

  it('starts the leased child only after the one-shot child closed, then reuses it', async () => {
    const owned: ReturnType<typeof stubborn>[] = [];
    const oneShotClose: Array<() => void> = [];
    const processes = win32.processes({
      windowsDirectory: 'D:\\Windows',
      start: () => {
        const c = stubborn('false', true, 9101 + owned.length);
        owned.push(c);
        return c.child;
      },
      // A one-shot child that holds the backend slot until the test closes it.
      run: (_file, _args, options) =>
        new Promise((resolve) => {
          const tracked = options.slot?.started({ pid: 9100 });
          oneShotClose.push(() => {
            tracked?.closed();
            resolve({ stdout: '', stderr: '', code: 1 });
          });
        }),
      kill: () => {},
      record: () => {}
    });
    let lease: import('../../core/platform/processes').Lease | undefined;
    try {
      const first = processes.snapshot();
      await flush();
      assert.equal(oneShotClose.length, 1, 'the one-shot child is running');
      lease = processes.own();
      const leased = processes.snapshot();
      await flush();
      assert.equal(owned.length, 0, 'no leased child beside the running one-shot');
      oneShotClose[0]?.();
      assert.equal(status(await first), 'failed');
      assert.equal(status(await leased), 'ok');
      assert.equal(owned.length, 1, 'handed off once the one-shot closed');
      assert.equal(status(await processes.snapshot()), 'ok');
      assert.equal(owned.length, 1, 'the running leased child is reused');
    } finally {
      for (const c of owned) c.close();
      for (const close of oneShotClose) close();
    }
    assert.ok(lease);
    assert.deepEqual(await within(lease.dispose(), 2_000, 'release'), { unresolved: [] });
  });
});

describe('Windows owned reusable process reader', () => {
  it('starts nothing at construction and keeps the planned bounds', async () => {
    const h = harness('good');
    const r = open(h);
    assert.equal(h.starts.length, 0);
    await sleep(50);
    assert.equal(h.starts.length, 0, 'no autonomous read');
    assert.deepEqual(owned.TIMING, {
      coldMs: 5_000,
      warmMs: 2_000,
      idleMs: 30_000,
      backoffFirstMs: 1_000,
      backoffMaxMs: 30_000,
      endGraceMs: 1_000,
      closeWaitMs: 5_000
    });
    await r.dispose();
    assert.equal(h.starts.length, 0);
  });

  it('serves each read with a fresh nonce from one child, then closes it on disposal', async () => {
    const h = harness('good');
    // Unscaled grace: this checks the EOF exit, not how fast a loaded machine kills.
    const r = open(h, { endGraceMs: 10_000 });
    const first = await r.read();
    const second = await r.read();
    assert.equal(first.status, 'ok', reason(first));
    assert.equal(second.status, 'ok', reason(second));
    assert.equal(h.starts.length, 1);
    const start = h.starts[0];
    assert.equal(start?.file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(start?.args.slice(0, 5), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ]);
    const pid = h.children[0]?.pid;
    if (first.status !== 'ok') return;
    assert.equal(first.value.selfPid, pid);
    const row = first.value.rows.find((item) => item.pid === pid);
    assert.equal(row?.command, '中文 😀');
    assert.equal(row?.image, 'node.exe');
    const nonces = h.lines().filter((line) => line.startsWith('start '));
    assert.equal(nonces.length, 2);
    assert.notEqual(nonces[0]?.split(' ')[1], nonces[1]?.split(' ')[1]);
    await r.dispose();
    const end = h.closed[0];
    assert.ok(end);
    assert.deepEqual(await within(end, 15_000, 'the reader child'), { code: 0, signal: null });
    assert.equal(alive(pid), false);
    assert.ok(h.lines().includes('eof'));
  });

  it('reassembles a frame split byte by byte, and never decodes split raw UTF-8 as text', async () => {
    const split = await open(harness('split')).read();
    assert.equal(split.status, 'ok', reason(split));
    if (split.status === 'ok') assert.ok(split.value.rows.some((row) => row.command === '中文 😀'));
    const raw = await open(harness('raw-split')).read();
    assert.equal(raw.status, 'incomplete', reason(raw));
    if (raw.status === 'incomplete')
      assert.ok(raw.value.rows.every((row) => !row.command?.includes('\ufffd')));
    const h = harness('bad-utf8');
    const bad = await open(h).read();
    assert.match(reason(bad), /not UTF-8/);
    await waitUntil(() => !alive(h.children[0]?.pid));
  });

  for (const [mode, expected] of [
    ['forged', /nonce mismatch/],
    ['oversize', /exceeds 8 MiB/],
    ['partial-exit', /exited/],
    ['trailing', /after the frame/],
    ['stderr', /stderr/]
  ] as const) {
    it(`fails a ${mode} reply with no rows and closes that child`, async () => {
      const h = harness(mode);
      const r = open(h);
      const read = await r.read();
      assert.equal(read.status, 'failed');
      assert.match(reason(read), expected);
      assert.equal('value' in read, false);
      assert.equal(alive(h.children[0]?.pid), false, 'child closed before the read settled');
    });
  }

  it('times out a cold and a warm request at their own bounds and closes the child', async () => {
    const cold = harness('partial-hang');
    const began = performance.now();
    const coldRead = await open(cold, { coldMs: 400 }).read();
    const coldMs = performance.now() - began;
    assert.match(reason(coldRead), /timed out/);
    assert.ok(coldMs >= 390 && coldMs < 2_500, `cold bound took ${coldMs} ms`);
    assert.equal(alive(cold.children[0]?.pid), false);

    const warm = harness('stall-second');
    const r = open(warm, { coldMs: 5_000, warmMs: 300 });
    assert.equal((await r.read()).status, 'ok');
    const warmBegan = performance.now();
    const warmRead = await r.read();
    const warmMs = performance.now() - warmBegan;
    assert.match(reason(warmRead), /timed out/);
    assert.ok(warmMs >= 290 && warmMs < 2_000, `warm bound took ${warmMs} ms`);
    assert.equal(alive(warm.children[0]?.pid), false);
  });

  it('serializes overlapping reads, writing each request only after the last reply', async () => {
    const h = harness('slow');
    const r = open(h);
    const reads = await Promise.all([r.read(), r.read(), r.read()]);
    assert.deepEqual(
      reads.map((read) => read.status),
      ['ok', 'ok', 'ok']
    );
    const lines = h.lines();
    assert.equal(lines.includes('overlap'), false);
    const events = lines
      .filter((line) => /^(start|done) /.test(line))
      .map((line) => line.split(' '));
    assert.deepEqual(
      events.map(([kind]) => kind),
      ['start', 'done', 'start', 'done', 'start', 'done']
    );
    assert.equal(new Set(events.map(([, nonce]) => nonce)).size, 3);
    assert.equal(h.starts.length, 1);
  });

  it('bounds the queue rather than holding unlimited callers', async () => {
    const h = harness('slow');
    const r = open(h);
    const reads = Array.from({ length: owned.MAX_QUEUE + 2 }, () => r.read());
    const results = await Promise.all(reads);
    assert.equal(results.filter((read) => read.status === 'ok').length, owned.MAX_QUEUE);
    assert.ok(results.slice(owned.MAX_QUEUE).every((read) => /busy/.test(reason(read))));
  });

  it('closes a child that writes when no request is open, and starts a fresh one', async () => {
    const h = harness('unsolicited');
    const r = open(h);
    assert.equal((await r.read()).status, 'ok');
    await waitUntil(() => !alive(h.children[0]?.pid));
    assert.equal((await r.read()).status, 'ok');
    assert.equal(h.starts.length, 2);
  });

  it('fails in-flight and queued work on disposal and rejects later work without a start', async () => {
    const h = harness('stall');
    const r = open(h, { coldMs: 10_000 });
    const inflight = r.read();
    const queued = r.read();
    await waitUntil(() => h.lines().some((line) => line.startsWith('start ')));
    const began = performance.now();
    await r.dispose();
    assert.ok(performance.now() - began < 2_500);
    assert.match(reason(await inflight), /disposed/);
    assert.match(reason(await queued), /disposed/);
    assert.equal(alive(h.children[0]?.pid), false);
    assert.match(reason(await r.read()), /disposed/);
    assert.equal(h.starts.length, 1);
    await r.dispose();
  });

  it('sends EOF exactly at idle and never kills a child that exits on it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = scripted(true);
    const r = owned.ownedReader(
      { windowsDirectory: 'D:\\Windows', start: () => fake.child },
      { ...FAST, idleMs: 1_000, endGraceMs: 300 }
    );
    assert.equal((await r.read()).status, 'ok');
    await flush();
    t.mock.timers.tick(999);
    await flush();
    assert.deepEqual(fake.events, [], 'not idle yet');
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(fake.events, ['eof']);
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(fake.events, ['eof'], 'its close cancelled the grace');
    await r.dispose();
  });

  it('kills a deaf child once, exactly when its grace ends, and not if it closes first', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timing = { ...FAST, idleMs: 200, endGraceMs: 1_000 };
    const deaf = scripted(false);
    const d = owned.ownedReader(
      { windowsDirectory: 'D:\\Windows', start: () => deaf.child },
      timing
    );
    assert.equal((await d.read()).status, 'ok');
    await flush();
    t.mock.timers.tick(200);
    await flush();
    t.mock.timers.tick(999);
    await flush();
    assert.deepEqual(deaf.events, ['eof'], 'still inside the grace');
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(deaf.events, ['eof', 'kill']);
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(deaf.events, ['eof', 'kill'], 'one kill');
    await d.dispose();

    const late = scripted(false);
    const l = owned.ownedReader(
      { windowsDirectory: 'D:\\Windows', start: () => late.child },
      timing
    );
    assert.equal((await l.read()).status, 'ok');
    await flush();
    t.mock.timers.tick(200);
    await flush();
    late.close(0, null);
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(late.events, ['eof'], 'a close inside the grace cancels the kill');
    await l.dispose();
  });

  it('ends a real idle child by EOF, and a deaf one by kill after EOF', async () => {
    const h = harness('good');
    // Unscaled grace: the EOF exit is under test, not the kill timer's margin.
    const r = open(h, { idleMs: 200, endGraceMs: 10_000 });
    assert.equal((await r.read()).status, 'ok');
    const first = h.closed[0];
    assert.ok(first);
    assert.deepEqual(await within(first, 15_000, 'the idle child'), { code: 0, signal: null });
    assert.ok(h.lines().includes('eof'));
    assert.equal((await r.read()).status, 'ok');
    assert.equal(h.starts.length, 2, 'the next read starts a fresh child');

    const deaf = harness('ignore-eof');
    const d = open(deaf, { idleMs: 200, endGraceMs: 300 });
    assert.equal((await d.read()).status, 'ok');
    const killed = deaf.closed[0];
    assert.ok(killed);
    assert.deepEqual(await within(killed, 15_000, 'the deaf child'), {
      code: null,
      signal: 'SIGTERM'
    });
    assert.ok(deaf.lines().includes('eof'), 'EOF came before the kill');
  });

  it('backs failed starts off from the first delay to the cap, and resets on success', async () => {
    const h = harness('fail-start');
    const r = open(h);
    const refusals: string[] = [];
    // Each failed child takes a Node startup before its failure starts the delay.
    const began = performance.now();
    while (h.starts.length < 5) {
      assert.ok(performance.now() - began < 10_000, `only ${h.starts.length} starts`);
      const read = await r.read();
      assert.equal(read.status, 'failed');
      if (/backing off/.test(reason(read))) refusals.push(reason(read));
      await sleep(10);
    }
    const ends = h.children.map((child) => child.exitCode);
    assert.deepEqual(ends.slice(0, 4), [5, 5, 5, 5]);
    const gaps = h.starts.slice(1).map((start, index) => {
      const closedAt = h.closes[index];
      assert.ok(closedAt !== undefined);
      return start.at - closedAt;
    });
    assert.ok(refusals.length > 0, 'reads during backoff fail without a start');
    for (const [index, expected] of [100, 200, 400, 400].entries()) {
      const gap = gaps[index] ?? 0;
      assert.ok(gap >= expected && gap < expected + 300, `gap ${index} was ${gap}`);
    }

    // A success resets the delay to its first step.
    h.mode = 'good';
    await sleep(450);
    assert.equal((await r.read()).status, 'ok');
    h.mode = 'fail-start';
    h.children.at(-1)?.kill();
    await waitUntil(() =>
      h.children.every((child) => child.exitCode !== null || child.signalCode !== null)
    );
    assert.equal((await r.read()).status, 'failed');
    const failedAt = performance.now();
    const delay = Number(/backing off for (\d+) ms/.exec(reason(await r.read()))?.[1]);
    assert.ok(delay > 0 && delay <= 100, `delay after reset was ${delay}`);
    await sleep(Math.max(0, 110 - (performance.now() - failedAt)));
    const count = h.starts.length;
    await r.read();
    assert.equal(h.starts.length, count + 1);
  });

  it('settles later reads after a start returns a child whose stdin write throws', async () => {
    const h = harness('good');
    const start = h.effects.start.bind(h.effects);
    let broken = true;
    h.effects.start = (file, args) => {
      const child = start(file, args);
      if (broken) {
        broken = false;
        child.stdin.write = () => {
          throw new Error('broken stdin contract');
        };
      }
      return child;
    };
    const r = open(h);
    const [first, queued] = await Promise.all([r.read(), r.read()]);
    assert.equal(first.status, 'failed');
    assert.match(reason(first), /broken stdin contract/);
    assert.equal(alive(h.children[0]?.pid), false);
    assert.equal(queued.status, 'ok', reason(queued));
    const later = await r.read();
    assert.equal(later.status, 'ok', reason(later));
    assert.equal(h.starts.length, 2);
  });

  it('fails a start whose executable cannot spawn, without throwing', async () => {
    const r = owned.ownedReader(
      {
        windowsDirectory: 'D:\\Windows',
        start: () =>
          spawn(path.join(home, 'missing-reader.exe'), [], { stdio: 'pipe', windowsHide: true })
      },
      FAST
    );
    readers.push(r);
    const read = await r.read();
    assert.equal(read.status, 'failed');
    assert.match(reason(read), /ENOENT/);
  });

  it('refuses a missing or relative Windows directory before any start', async () => {
    const h = harness('good');
    const r = owned.ownedReader({ ...h.effects, windowsDirectory: 'Windows' }, FAST);
    readers.push(r);
    assert.equal((await r.read()).status, 'failed');
    assert.equal(h.starts.length, 0);
  });

  it(
    'sees an owned start and its own row across warm reads, then leaves no PowerShell',
    { skip: nativeSkip },
    async () => {
      const dir = await fs.promises.mkdtemp(path.join(home, 'owned-native-'));
      const release = path.join(dir, 'release');
      const ready = path.join(dir, 'ready');
      const script = path.join(dir, 'hold.js');
      await fs.promises.writeFile(
        script,
        `const fs = require('fs');\n` +
          `fs.writeFileSync(process.argv[3], 'ready');\n` +
          `const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.exit(0); } }, 20);\n` +
          `setTimeout(() => process.exit(3), 20000);\n`
      );
      const child = spawn(process.execPath, [script, release, ready], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ...helpers.homeEnv(home) }
      });
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.once('error', () => {});
      const started: ChildProcessWithoutNullStreams[] = [];
      const r = owned.ownedReader(
        {
          windowsDirectory: process.env.SystemRoot,
          start: (file, args) => {
            const reader = spawn(file, [...args], {
              stdio: 'pipe',
              windowsHide: true,
              env: { ...process.env, ...helpers.homeEnv(home) }
            });
            started.push(reader);
            return reader;
          }
        },
        { ...owned.TIMING, coldMs: 15_000 }
      );
      readers.push(r);
      try {
        await waitUntil(() => fs.existsSync(ready));
        const first = await r.read();
        const second = await r.read();
        assert.equal(first.status, 'ok', reason(first));
        assert.equal(second.status, 'ok', reason(second));
        if (first.status !== 'ok' || second.status !== 'ok') return;
        assert.equal(started.length, 1);
        const readerPid = started[0]?.pid;
        assert.equal(first.value.selfPid, readerPid);
        assert.equal(second.value.selfPid, readerPid);
        const self = second.value.rows.find((row) => row.pid === readerPid);
        assert.equal(self?.ppid, process.pid);
        assert.equal(self?.image, 'powershell.exe');
        const found = second.value.rows.find((row) => row.pid === child.pid);
        assert.ok(found);
        assert.equal(found.image, 'node.exe');
        const filetime = await new Promise<string>((resolve, reject) =>
          execFile(
            reader.powershellPath(process.env.SystemRoot) ?? '',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `[Console]::Out.WriteLine((Get-Process -Id ${child.pid}).StartTime.ToFileTime())`
            ],
            { windowsHide: true, timeout: 8_000 },
            (error, stdout) => (error ? reject(new Error(error.message)) : resolve(stdout))
          )
        );
        assert.equal(
          found.startedAt,
          Number((BigInt(filetime.trim()) - 116444736000000000n) / 10000n)
        );
        await r.dispose();
        assert.equal(alive(readerPid), false);
        assert.equal(started[0]?.exitCode, 0, 'PowerShell ended on stdin EOF');
        assert.equal(started[0]?.stdout.destroyed && started[0]?.stderr.destroyed, true);
      } finally {
        await fs.promises.writeFile(release, '1').catch(() => {});
        if (child.exitCode === null) child.kill();
        await closed;
        for (const reader of started) if (alive(reader.pid)) reader.kill();
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
  );
});
