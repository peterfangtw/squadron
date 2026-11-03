import * as assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { before, after, afterEach, describe, it, type TestContext } from 'node:test';
import * as executables from '../../core/platform/executables';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/console_login/darwin';
import { Operation } from '../../core/platform/console_login/operation';
import { refused } from '../../core/platform/console_login';
import { foldMcpView, type McpLoginEvent } from '../../core/mcp';
import type { McpActionTarget } from '../../core/mcp_target';
import { tempHome } from '../helpers';

let home: Awaited<ReturnType<typeof tempHome>>;
let mcp: typeof import('../../core/claude/mcp');
let bin: typeof import('../../core/bin');
const hostSupport = platform.consoleLogin.support;
afterEach(() => {
  platform.consoleLogin.support = hostSupport;
});
const target: McpActionTarget = {
  brand: 'claude',
  name: 'probe',
  key: 'https://example.test/mcp',
  url: 'https://example.test/mcp',
  declaration: { scope: 'project', root: path.resolve('project') },
  readCwd: path.resolve('project'),
  canLogin: true,
  canDisconnect: false
};

before(async () => {
  home = await tempHome();
  mcp = await import('../../core/claude/mcp');
  bin = await import('../../core/bin');
});
after(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function login(t: TestContext, spawn: Parameters<typeof darwin.consoleLogin>[0]['spawn']): void {
  const backend = darwin.consoleLogin({ spawn });
  platform.consoleLogin.support = backend.support;
  t.mock.method(platform.consoleLogin, 'run', backend.run.bind(backend));
  t.mock.method(bin, 'claudeBinary', () =>
    Promise.resolve({
      ok: true,
      program: executables.named('claude'),
      path: 'claude',
      source: 'path'
    })
  );
  t.mock.method(platform.executables, 'exec', () =>
    Promise.resolve({ stdout: 'URL: https://example.test/mcp\nScope: Project\n', stderr: '' })
  );
}

async function start(events: McpLoginEvent[]) {
  const prepared = await mcp.prepareMcpLogin({ target });
  assert.ok(!('ok' in prepared));
  return prepared.start((event) => events.push(event));
}

describe('Claude MCP login through pty', () => {
  it('allows the full URL window after delayed readiness and ignores readiness after cancellation or failure', async (t) => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    login(t, () => new ChildProcess());
    for (const outcome of ['url', 'cancel', 'failure'] as const) {
      elapsed = 0;
      const child = new Operation(() => {});
      t.mock.method(platform.consoleLogin, 'run', () => ({
        supported: true,
        status: 'ok',
        value: child
      }));
      const events: McpLoginEvent[] = [];
      const running = await start(events);
      assert.ok(!('ok' in running));
      elapsed = 14000;
      t.mock.timers.tick(14000);
      if (outcome === 'cancel') running.cancel();
      if (outcome === 'failure') child.fail('preparation failed');
      child.markReady();
      elapsed = 43000;
      t.mock.timers.tick(29000);
      if (outcome === 'url') {
        const url = 'https://example.test/authorize?code_challenge=abc';
        child.output('stdout', Buffer.from(url + '\n'));
        child.finish({ kind: 'exited', code: 0 });
        assert.ok(events.some((event) => event.type === 'url' && event.url === url));
        assert.ok(events.some((event) => event.type === 'phase' && event.phase === 'done'));
      } else {
        child.finish({ kind: 'exited', code: 0 });
        assert.equal(child.ready, false);
        assert.equal(
          events.some((event) => event.type === 'phase' && event.phase === 'done'),
          false
        );
        assert.equal(
          events.some((event) => event.type === 'phase' && event.message?.includes('in time')),
          false
        );
      }
    }
  });
  it('rejects a late authorization URL before a delayed timer callback can run', async (t) => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    t.mock.method(child, 'kill', () => true);
    login(t, () => child);
    const events: McpLoginEvent[] = [];
    await start(events);
    elapsed = 30001;
    child.stdout.emit('data', Buffer.from('https://example.test/authorize?code_challenge=abc\n'));
    child.emit('close', 0);
    assert.equal(
      events.some((event) => event.type === 'url'),
      false
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'phase' && event.phase === 'error' && event.message?.includes('in time')
      )
    );
    assert.equal(
      events.some((event) => event.type === 'phase' && event.phase === 'done'),
      false
    );
  });
  it('refuses unsupported login before resolving a CLI and retains the panel fallback bytes', async (t) => {
    platform.consoleLogin.support = refused('win32').support;
    const resolve = t.mock.method(bin, 'claudeBinary', () => {
      throw new Error('must not resolve');
    });
    assert.deepEqual(await mcp.prepareMcpLogin({ target }), {
      ok: false,
      reason: 'Console login is unavailable here. Run the login command in a terminal instead.'
    });
    const rows = mcp.mcpRows(
      [{ name: target.name, url: target.url!, project: target.readCwd, scope: 'project' }],
      new Set()
    );
    assert.equal(rows[0]?.canLogin, false);
    const view = foldMcpView({
      rows,
      repos: [{ root: target.readCwd, label: 'project' }],
      ownRoot: target.readCwd
    });
    assert.equal(
      view.hint,
      'Authorising Claude is not available on this host. Run claude mcp login in a terminal instead.'
    );
    assert.equal(resolve.mock.callCount(), 0);
  });

  it('refuses a missing binary or changed declaration without starting pty', async (t) => {
    const spawned = t.mock.fn(() => new ChildProcess());
    login(t, spawned);
    t.mock.method(bin, 'claudeBinary', () => Promise.resolve({ ok: false, reason: 'missing CLI' }));
    assert.deepEqual(await mcp.prepareMcpLogin({ target }), { ok: false, reason: 'missing CLI' });
    t.mock.restoreAll();
    login(t, spawned);
    t.mock.method(platform.executables, 'exec', () =>
      Promise.resolve({ stdout: 'URL: https://changed.test/mcp\nScope: Project\n', stderr: '' })
    );
    assert.deepEqual(await mcp.prepareMcpLogin({ target }), {
      ok: false,
      reason: 'MCP declaration changed or could not be checked. Reopen MCP and try again.'
    });
    assert.equal(spawned.mock.callCount(), 0);
  });

  it('keeps starting, URL, browser, waiting and done events and sends cancellation to the wrapper', async (t) => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const killed = t.mock.method(child, 'kill', () => true);
    const spawn = t.mock.fn(() => child);
    login(t, spawn);
    const events: McpLoginEvent[] = [];
    const running = await start(events);
    assert.ok(!('ok' in running));
    const url = 'https://example.test/authorize?code_challenge=abc';
    child.stdout.emit('data', Buffer.from(`${url}\r\n`));
    child.stderr.emit('data', Buffer.from('Waiting for authorization\r\n'));
    child.emit('close', 0);
    assert.deepEqual(events, [
      { type: 'phase', phase: 'starting' },
      { type: 'url', url },
      { type: 'phase', phase: 'browser' },
      { type: 'phase', phase: 'waiting' },
      { type: 'phase', phase: 'done' }
    ]);
    assert.deepEqual(spawn.mock.calls[0]?.arguments, [
      'script',
      ['-q', '/dev/null', 'claude', 'mcp', 'login', 'probe', '--no-browser'],
      { cwd: target.readCwd, stdio: ['ignore', 'pipe', 'pipe'] }
    ]);
    running.cancel();
    assert.deepEqual(
      killed.mock.calls.map((call) => call.arguments),
      []
    );
  });

  it('preserves synchronous refusal and asynchronous error without a later done event', async (t) => {
    login(t, () => {
      throw new Error('spawn refused');
    });
    const sync: McpLoginEvent[] = [];
    assert.deepEqual(await start(sync), { ok: false, reason: 'spawn refused' });
    assert.deepEqual(sync, [
      { type: 'phase', phase: 'starting' },
      { type: 'error', message: 'spawn refused' }
    ]);
    t.mock.restoreAll();
    const child = new ChildProcess();
    login(t, () => child);
    const asyncEvents: McpLoginEvent[] = [];
    await start(asyncEvents);
    child.emit('error', new Error('ENOENT'));
    child.emit('close', 0);
    assert.deepEqual(asyncEvents, [
      { type: 'phase', phase: 'starting' },
      { type: 'phase', phase: 'error', message: 'ENOENT' }
    ]);
  });

  it('preserves CLI failure text, nonzero fallback and quiet cancellation close', async (t) => {
    for (const [output, code, message] of [
      ['No MCP server named probe\n', 1, 'No MCP server named probe'],
      ['', 1, 'Authorisation did not finish.'],
      ['', null, undefined],
      [
        "Couldn't complete authentication: use its terminal\n",
        0,
        "Couldn't complete authentication: use its terminal"
      ]
    ] as const) {
      const child = new ChildProcess();
      child.stderr = new PassThrough();
      login(t, () => child);
      const events: McpLoginEvent[] = [];
      await start(events);
      child.stderr.emit('data', Buffer.from(output));
      child.emit('close', code);
      assert.equal(
        events.some((event) => event.type === 'phase' && event.phase === 'done'),
        false
      );
      const failed = events.find((event) => event.type === 'phase' && event.phase === 'error');
      assert.equal(failed?.type === 'phase' ? failed.message : undefined, message);
      t.mock.restoreAll();
    }
  });
});
