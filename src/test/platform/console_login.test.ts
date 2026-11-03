import * as assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import * as executables from '../../core/platform/executables';
import * as darwin from '../../core/platform/console_login/darwin';
import { refused } from '../../core/platform/console_login';
import * as platform from '../../core/platform';
import { testPlatform } from '../helpers';
import * as win32 from '../../core/platform/console_login/win32';
import * as crypto from 'node:crypto';

const ARGS = ['mcp', 'login', "space '日本", '--no-browser', '{"x":1}', 'line\nbreak', ''];

describe('console login execution', () => {
  it('rejects late preflight before starting a helper even when its timer has not fired', async (t) => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    const bytes = Buffer.alloc(512),
      errors: string[] = [];
    let complete!: (bytes: Buffer) => void,
      spawns = 0;
    const backend = win32.consoleLogin({
      architecture: 'x64',
      ownerPid: 42,
      artifact: () => ({
        executable: 'C:\\bundle\\helper.exe',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }),
      readArtifact: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      spawn() {
        spawns++;
        throw new Error('late preflight must not spawn');
      }
    });
    t.after(() => backend.dispose());
    const result = backend.run(executables.named('C:\\cli.exe'), [], { cwd: 'C:\\project' });
    assert.ok(result.supported && result.status === 'ok');
    result.value.on('error', (error) => errors.push(error.message));
    const done = new Promise((resolve) => result.value.on('close', resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    elapsed = 5001;
    complete(bytes);
    await done;
    assert.equal(spawns, 0);
    assert.deepEqual(errors, ['Console login preparation expired.']);
  });

  it('rejects late output and success after clock rollback without waiting for the timer callback', (t) => {
    let elapsed = 0,
      utc = 1000;
    t.mock.method(performance, 'now', () => elapsed);
    t.mock.method(Date, 'now', () => utc);
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    t.mock.method(child, 'kill', () => true);
    const result = darwin
      .consoleLogin({ spawn: () => child })
      .run(executables.named('claude'), [], { cwd: path.resolve('.') });
    assert.ok(result.supported && result.status === 'ok');
    const completions: unknown[] = [],
      output: string[] = [];
    result.value.on('error', () => {});
    result.value.on('close', (completion) => completions.push(completion));
    result.value.stdout.on('data', (bytes: Buffer) => output.push(bytes.toString()));
    elapsed = 300001;
    utc = -60000;
    child.stdout.emit('data', Buffer.from('late'));
    child.emit('close', 0);
    assert.deepEqual(output, []);
    assert.deepEqual(completions, [
      { kind: 'failed', reason: 'Console login output or lifetime limit exceeded.' }
    ]);
  });
  it('keeps cancelled asynchronous preflight in the admission slot until it settles, without a late spawn', async (t) => {
    const bytes = Buffer.alloc(512);
    let complete!: (bytes: Buffer) => void;
    let spawns = 0;
    const backend = win32.consoleLogin({
      architecture: 'x64',
      ownerPid: 42,
      artifact: () => ({
        executable: 'C:\\bundle\\helper.exe',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }),
      readArtifact: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      spawn() {
        spawns++;
        throw new Error('cancelled preparation must not spawn');
      }
    });
    t.after(() => backend.dispose());
    const run = () => backend.run(executables.named('C:\\cli.exe'), [], { cwd: 'C:\\project' });
    const result = run();
    assert.ok(result.supported && result.status === 'ok');
    const completion = new Promise((resolve) => result.value.on('close', resolve));
    result.value.on('error', (error) => assert.fail(error));
    await new Promise<void>((resolve) => setImmediate(resolve));
    result.value.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const busy = run();
    complete(bytes);
    assert.ok(busy.supported && busy.status === 'failed');
    assert.deepEqual(await completion, { kind: 'cancelled', reason: 'Login cancelled.' });
    assert.equal(spawns, 0);
    assert.deepEqual(await backend.dispose(), { unresolved: [] });
  });
  it('retains uncertain job cleanup after protocol failure and monitor close, and reports unresolved disposal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bytes = Buffer.alloc(512);
    const children: ChildProcess[] = [];
    const backend = win32.consoleLogin({
      architecture: 'x64',
      ownerPid: 42,
      artifact: () => ({
        executable: 'C:\\bundle\\helper.exe',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }),
      readArtifact: () => Promise.resolve(bytes),
      spawn(_file, args) {
        const child = new ChildProcess();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        Object.defineProperty(child, 'pid', { value: 4242 });
        children.push(child);
        t.mock.method(child, 'kill', () => true);
        queueMicrotask(() => {
          if (args.length) {
            const body = Buffer.from(JSON.stringify({ version: 1, pid: 42, birth: '123456789' }));
            const head = Buffer.alloc(5);
            head[0] = 1;
            head.writeUInt32LE(body.length, 1);
            child.stdout?.emit('data', Buffer.concat([head, body]));
            child.emit('close', 0);
          } else child.stdout?.emit('data', Buffer.from([1, 255, 255, 255, 255]));
        });
        return child;
      }
    });
    const run = () => backend.run(executables.named('C:\\cli.exe'), [], { cwd: 'C:\\project' });
    const result = run();
    assert.ok(result.supported && result.status === 'ok');
    const events: unknown[] = [];
    result.value.on('error', (error) => events.push(error.message));
    result.value.on('close', (completion) => events.push(completion));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.deepEqual(events, ['Console login frame limit exceeded.']);
    const busy = run();
    assert.ok(busy.supported && busy.status === 'failed');
    const disposal = backend.dispose();
    t.mock.timers.tick(5000);
    const unresolved = {
      unresolved: [
        { kind: 'job', pid: undefined, birth: undefined, monitor: { pid: 4242, birth: undefined } }
      ]
    };
    assert.deepEqual(await disposal, unresolved);
    assert.equal(events.length, 1, 'a timer cannot manufacture confirmed close');
    children[1]!.emit('close', 31);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events[1], { kind: 'failed', reason: 'Console login frame limit exceeded.' });
    const replacement = run();
    assert.ok(replacement.supported && replacement.status === 'failed');
    assert.deepEqual(
      await backend.dispose(),
      unresolved,
      'a dead monitor does not prove an empty job'
    );
  });
  it('passes the program to a wrapper after the wrapper’s own arguments', () => {
    for (const runner of [undefined, process.execPath]) {
      const child = new ChildProcess();
      const seen: unknown[] = [];
      const login = darwin.consoleLogin({
        spawn(file, args, options) {
          seen.push([file, args, options]);
          return child;
        }
      });
      const file = path.resolve('CLI 日本', "it's.js");
      const cwd = path.resolve('project with spaces');
      const result = login.run(executables.named(file, runner), ARGS, { cwd });
      assert.equal(result.supported && result.status, 'ok');
      assert.deepEqual(seen, [
        [
          'script',
          ['-q', '/dev/null', ...(runner ? [runner, file] : [file]), ...ARGS],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
        ]
      ]);
      child.emit('close', 0);
    }
  });

  it('forwards both streams and native failure/close events, and cancels only its wrapper', (t) => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kills = t.mock.method(child, 'kill', () => true);
    const result = darwin
      .consoleLogin({ spawn: () => child })
      .run(executables.named('claude'), [], { cwd: path.resolve('.') });
    assert.ok(result.supported && result.status === 'ok');
    const login = result.value;
    const seen: unknown[] = [];
    login.stdout?.on('data', (chunk: Buffer) => seen.push(chunk.toString()));
    login.stderr?.on('data', (chunk: Buffer) => seen.push(chunk.toString()));
    login.on('error', (error) => seen.push(error.message));
    login.on('close', (completion) => seen.push(completion));
    child.stdout.emit('data', Buffer.from('out'));
    child.stderr.emit('data', Buffer.from('err'));
    child.emit('error', new Error('ENOENT'));
    child.emit('close', null, 'SIGTERM');
    login.cancel();
    assert.deepEqual(seen, ['out', 'err', 'ENOENT', { kind: 'failed', reason: 'ENOENT' }]);
    assert.deepEqual(
      kills.mock.calls.map((call) => call.arguments),
      [['SIGTERM']]
    );
  });

  it('answers synchronous spawn failure as a refusal', () => {
    const result = darwin
      .consoleLogin({
        spawn() {
          throw new Error('cannot start script');
        }
      })
      .run(executables.named('claude'), [], { cwd: path.resolve('.') });
    assert.deepEqual(result, { supported: true, status: 'failed', reason: 'cannot start script' });
  });

  it('refuses unadmitted hosts with terminal guidance and no child', () => {
    for (const backend of [
      win32.consoleLogin({
        architecture: 'arm64',
        ownerPid: 42,
        artifact() {
          throw new Error('unadmitted target read artifact');
        },
        readArtifact() {
          throw new Error('unadmitted target read bytes');
        },
        spawn() {
          throw new Error('unadmitted target spawned');
        }
      }),
      ...(
        [
          'linux',
          'freebsd',
          'openbsd',
          'sunos',
          'aix',
          'android',
          'cygwin',
          'netbsd',
          'haiku'
        ] as const
      ).map(refused)
    ]) {
      assert.equal(backend.support.supported, false);
      const result = backend.run(executables.named('claude'), ARGS, { cwd: path.resolve('.') });
      assert.equal(result, backend.support);
      assert.ok(!result.supported);
      assert.match(result.reason, /W7\.2.*Run the login command in a terminal instead\./);
    }
    assert.equal(
      platform.consoleLogin.support.supported,
      ['darwin', 'win32'].includes(testPlatform())
    );
  });
});
