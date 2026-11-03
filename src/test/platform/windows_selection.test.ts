/**
 * The Windows reader and guarded ending, selected together (processes Step 6):
 * one-shot reads with no lease, one owned child while any lease is held, and
 * the production capability's children on this machine. Portable cases run a
 * scripted child; native cases spawn the selected PowerShell under a temp home.
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import type * as processes from '../../core/platform/processes';
import * as win32 from '../../core/platform/processes/win32';
import * as helpers from '../helpers';

const SELF = 4242;
const START = 1_792_931_583_857;

describe('Windows process selection', () => {
  it('starts nothing at construction or when a lease is taken', () => {
    const fake = effects();
    const backend = win32.processes(fake.effects);
    const lease = backend.own();
    assert.deepEqual(fake.calls, { runs: 0, starts: 0, kills: [], recorded: 0 });
    void lease.dispose();
  });

  it('reads one bounded one-shot table when nothing holds a reader', async () => {
    const fake = effects();
    const backend = win32.processes(fake.effects);
    const snapshot = await backend.snapshot();
    assert.equal(snapshot.supported && snapshot.status, 'ok');
    assert.equal(
      snapshot.supported && snapshot.status === 'ok' && snapshot.value.source,
      'win32-filetime-ms-v1'
    );
    assert.deepEqual(rowOf(snapshot, SELF), {
      pid: SELF,
      ppid: 4,
      startedAt: START,
      command: 'node fake',
      image: 'node.exe',
      invocation: { program: 'node', args: 'fake' }
    });
    assert.equal(fake.calls.runs, 1);
    assert.equal(fake.calls.starts, 0);
    assert.equal(fake.calls.recorded, 1);
  });

  it('reads through one owned child while leased, and one-shot again after', async () => {
    const fake = effects();
    const backend = win32.processes(fake.effects);
    const lease = backend.own();
    for (let i = 0; i < 3; i++) assert.equal(statusOf(await backend.snapshot()), 'ok');
    assert.equal(fake.calls.starts, 1);
    assert.equal(fake.calls.runs, 0);
    assert.equal(fake.children[0]?.requests, 3);
    await lease.dispose();
    assert.deepEqual(fake.children[0]?.events, ['eof']);
    assert.equal(fake.children[0]?.closed, true);
    assert.equal(statusOf(await backend.snapshot()), 'ok');
    assert.equal(fake.calls.runs, 1);
    assert.equal(fake.calls.starts, 1);
    assert.equal(fake.calls.recorded, 4);
  });

  it('keeps the child until the last lease, and a disposed lease stays disposed', async () => {
    const fake = effects();
    const backend = win32.processes(fake.effects);
    const first = backend.own();
    const second = backend.own();
    await backend.snapshot();
    await first.dispose();
    await first.dispose();
    assert.deepEqual(fake.children[0]?.events, []);
    await backend.snapshot();
    assert.equal(fake.calls.starts, 1);
    await second.dispose();
    assert.deepEqual(fake.children[0]?.events, ['eof']);
    const third = backend.own();
    await backend.snapshot();
    assert.equal(fake.calls.starts, 2);
    await third.dispose();
    assert.deepEqual(fake.children[1]?.events, ['eof']);
  });

  it('selects the guarded ending with the reader', () => {
    const fake = effects();
    const backend = win32.processes(fake.effects);
    assert.deepEqual(backend.signals, { supported: true });
    const evidence = {
      complete: true,
      startSource: 'win32-filetime-ms-v1' as const,
      starts: new Map([[SELF, START]]),
      groups: new Map<number, number>()
    };
    assert.deepEqual(backend.signal([{ pid: SELF, startedAt: START }], 'kill', evidence), ['sent']);
    assert.deepEqual(backend.signal([{ pid: SELF, startedAt: START + 1 }], 'kill', evidence), [
      'absent'
    ]);
    const [stop] = backend.signal([{ pid: SELF, startedAt: START }], 'stop', evidence);
    assert.equal(
      typeof stop === 'object' && !stop.supported && /TerminateProcess/.test(stop.reason),
      true
    );
    assert.deepEqual(fake.calls.kills, [SELF]);
  });

  it('is what this machine selects: a reader with a guarded ending, whatever the OS', () => {
    assert.deepEqual(platform.processes.signals, { supported: true });
    assert.equal(typeof platform.processes.own, 'function');
  });
});

const nativeSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows PowerShell reader';

describe('the selected Windows reader on this machine', { skip: nativeSkip }, () => {
  let home: string;
  before(async () => {
    home = await helpers.tempHome();
  });
  after(() =>
    fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  );

  it('reads one complete table one-shot, and its PowerShell is gone after', async () => {
    const first = await platform.processes.snapshot();
    assert.equal(statusOf(first), 'ok', reasonOf(first));
    assert.ok(rowOf(first, process.pid));
    const readers = readersOf(first, process.pid);
    assert.equal(readers.length, 1, 'the one-shot sees itself under this process');
    const second = await platform.processes.snapshot();
    assert.equal(statusOf(second), 'ok', reasonOf(second));
    for (const reader of readers)
      assert.equal(rowOf(second, reader.pid)?.startedAt === reader.startedAt, false);
  });

  it('answers a lease from one PowerShell and leaves none after disposal', async () => {
    const lease = platform.processes.own();
    const reads: processes.Snapshot[] = [];
    try {
      for (let i = 0; i < 3; i++) reads.push(await platform.processes.snapshot());
    } finally {
      await lease.dispose();
    }
    for (const read of reads) assert.equal(statusOf(read), 'ok', reasonOf(read));
    const owners = reads.map((read) => readersOf(read, process.pid));
    assert.equal(owners[0]?.length, 1);
    assert.deepEqual(owners[1], owners[0]);
    assert.deepEqual(owners[2], owners[0]);
    const owner = owners[0]?.[0];
    assert.ok(owner);
    const after = await platform.processes.snapshot();
    assert.equal(rowOf(after, owner.pid)?.startedAt === owner.startedAt, false);
  });

  it('leaves no reader when its owner dies without disposing', async () => {
    const script = path.join(home, 'host.js');
    await fs.promises.writeFile(
      script,
      `const platform = require(${JSON.stringify(path.join(helpers.outRoot(), 'core', 'platform', 'index.js'))});
platform.processes.own();
platform.processes.snapshot().then((s) => {
  const rows = s.supported && s.status !== 'failed' ? s.value.rows : [];
  const mine = rows.filter((r) => r.ppid === process.pid && /^powershell\\.exe$/i.test(r.image ?? ''));
  process.stdout.write(JSON.stringify(mine.map((r) => [r.pid, r.startedAt])) + '\\n');
  setInterval(() => {}, 60000);
});`
    );
    const host = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      env: { ...process.env, ...helpers.homeEnv(home) }
    });
    const closed = new Promise<void>((resolve) => host.once('close', () => resolve()));
    try {
      const line = await firstLine(host.stdout, 15_000);
      const readers = JSON.parse(line) as Array<[number, number]>;
      assert.equal(readers.length, 1, line);
      host.kill();
      await closed;
      const [pid, startedAt] = readers[0] ?? [0, 0];
      const gone = await until(15_000, async () => {
        const table = await platform.processes.snapshot();
        return statusOf(table) === 'ok' && rowOf(table, pid)?.startedAt !== startedAt;
      });
      assert.ok(gone, `reader ${pid} outlived its killed owner`);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await closed;
    }
  });

  it('lets a standalone CLI read exit at once, with no PowerShell left behind', async () => {
    const script = path.join(home, 'cli.js');
    await fs.promises.writeFile(
      script,
      `const scan = require(${JSON.stringify(path.join(helpers.outRoot(), 'core', 'scan.js'))});
scan.scanProcesses().then((t) => {
  process.stdout.write(JSON.stringify({ complete: t.complete, self: t.starts.has(process.pid) }) + '\\n');
});`
    );
    const began = performance.now();
    const cli = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      env: { ...process.env, ...helpers.homeEnv(home) }
    });
    const pid = cli.pid ?? 0;
    const closed = new Promise<number>((resolve) =>
      cli.once('close', () => resolve(performance.now()))
    );
    const line = await firstLine(cli.stdout, 15_000);
    const answered = performance.now();
    const exited = await closed;
    assert.deepEqual(JSON.parse(line), { complete: true, self: true });
    assert.ok(
      exited - answered < 1_500,
      `exit ${Math.round(exited - answered)} ms after the answer`
    );
    assert.ok(exited - began < 10_000);
    const table = await platform.processes.snapshot();
    assert.equal(statusOf(table), 'ok', reasonOf(table));
    assert.deepEqual(readersOf(table, pid), []);
  });
});

function statusOf(snapshot: processes.Snapshot): string {
  return snapshot.supported ? snapshot.status : 'unsupported';
}

function reasonOf(snapshot: processes.Snapshot): string {
  return snapshot.supported && snapshot.status !== 'ok' ? snapshot.reason : '';
}

function rowOf(snapshot: processes.Snapshot, pid: number): processes.Row | undefined {
  if (!snapshot.supported || snapshot.status === 'failed') return undefined;
  return snapshot.value.rows.find((row) => row.pid === pid);
}

/** PowerShell children of `parent` in a table (a dead parent's pid stays in ppid). */
function readersOf(
  snapshot: processes.Snapshot,
  parent: number
): Array<{ pid: number; startedAt: number }> {
  if (!snapshot.supported || snapshot.status === 'failed') return [];
  return snapshot.value.rows
    .filter((row) => row.ppid === parent && /^powershell\.exe$/i.test(row.image ?? ''))
    .map(({ pid, startedAt }) => ({ pid, startedAt }));
}

async function until(ms: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function firstLine(stream: NodeJS.ReadableStream, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`no line within ${ms} ms: ${text}`)), ms);
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const at = text.indexOf('\n');
      if (at !== -1) {
        clearTimeout(timer);
        resolve(text.slice(0, at));
      }
    });
  });
}

type Scripted = {
  child: ChildProcessWithoutNullStreams;
  events: string[];
  requests: number;
  closed: boolean;
};

/** What the backend asked of its effects, and the children it started. */
function effects(): {
  effects: win32.Win32Effects;
  calls: { runs: number; starts: number; kills: number[]; recorded: number };
  children: Scripted[];
} {
  const calls = { runs: 0, starts: 0, kills: [] as number[], recorded: 0 };
  const children: Scripted[] = [];
  return {
    calls,
    children,
    effects: {
      windowsDirectory: 'D:\\Windows',
      run(_file, args) {
        calls.runs += 1;
        const script = Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');
        const nonce = /\$nonce = '([0-9a-f]{32})'/.exec(script)?.[1] ?? '';
        return Promise.resolve({ stdout: frame(nonce), stderr: '', code: 0 });
      },
      start() {
        calls.starts += 1;
        const scripted = scriptedChild();
        children.push(scripted);
        return scripted.child;
      },
      kill(pid) {
        calls.kills.push(pid);
      },
      record() {
        calls.recorded += 1;
      }
    }
  };
}

/** An in-process reader child: answers each `read <nonce>`, exits on EOF. */
function scriptedChild(): Scripted {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const scripted: Scripted = {
    child: Object.assign(emitter, {
      pid: SELF,
      stdin,
      stdout,
      stderr,
      kill: () => {
        scripted.events.push('kill');
        close();
        return true;
      }
    }) as unknown as ChildProcessWithoutNullStreams,
    events: [],
    requests: 0,
    closed: false
  };
  const close = () => {
    if (scripted.closed) return;
    scripted.closed = true;
    process.nextTick(() => emitter.emit('close', 0, null));
  };
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const nonce = /^read ([0-9a-f]{32})$/.exec(line)?.[1];
      if (!nonce) continue;
      scripted.requests += 1;
      stdout.write(frame(nonce));
    }
  });
  stdin.on('end', () => {
    scripted.events.push('eof');
    close();
  });
  return scripted;
}

function frame(nonce: string): string {
  const b64 = (text: string) => 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  const kernel = '4 0 134374051838139320';
  const rows = [
    `${kernel} ${b64('System')} -`,
    `${SELF} 4 134374051838571739 ${b64('node.exe')} ${b64('node fake')}`
  ];
  return [
    `v3 ${nonce}`,
    `self ${SELF}`,
    `kernel ${kernel}`,
    `count ${rows.length}`,
    ...rows,
    `end ${nonce} ${rows.length}`,
    ''
  ].join('\r\n');
}
