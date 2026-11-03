import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, it } from 'node:test';
import { outRoot, tempHome } from '../helpers';
import type { McpActionTarget } from '../../core/mcp_target';
import type { McpLoginEvent } from '../../core/mcp';
import * as executables from '../../core/platform/executables';
import { alive, ownHeld, until, watchTable } from '../fixtures/root_only';

let home: string;
let grok: typeof import('../../core/grok/mcp');
let claude: typeof import('../../core/claude/mcp');
let codex: typeof import('../../core/codex/mcp');
let adapter: typeof import('../../core/adapter');
let session: typeof import('../../core/session');
before(async () => {
  home = await tempHome();
  grok = await import('../../core/grok/mcp');
  codex = await import('../../core/codex/mcp');
  claude = await import('../../core/claude/mcp');
  adapter = await import('../../core/adapter');
  session = await import('../../core/session');
});

async function peer(name: string, scope: 'user' | 'project' = 'project'): Promise<McpActionTarget> {
  const cwd = path.join(home, name);
  await fs.mkdir(cwd, { recursive: true });
  for (const file of ['mcp', 'agent'])
    await fs.copyFile(path.join(outRoot(), 'test', 'fixtures', 'mcp-cli.js'), path.join(cwd, file));
  const url = `https://${name}.example/mcp`;
  await fs.writeFile(
    path.join(cwd, 'mcp-fixture.json'),
    JSON.stringify({ name: 'same', url, scope })
  );
  return {
    brand: 'grok',
    name: 'same',
    key: url,
    url,
    declaration: scope === 'user' ? { scope } : { scope, root: cwd },
    readCwd: cwd,
    canLogin: true,
    canDisconnect: true
  };
}
type NativeCall = { method?: string; args?: string[]; params?: unknown };

async function calls(target: McpActionTarget): Promise<NativeCall[]> {
  return (await fs.readFile(path.join(target.readCwd, 'mcp-calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as NativeCall);
}

it('authorises B through a fresh child while A’s same-named live session receives no trigger', async (t) => {
  const a = await peer('live-a');
  const b = await peer('selected-b');
  const cli = adapter.adapter('grok');
  assert.ok(cli);
  const live = cli.connect(
    session.childTransport({
      bin: executables.named(process.execPath),
      args: ['agent'],
      cwd: a.readCwd
    }),
    { cwd: a.readCwd, startedAt: Date.now() }
  );
  t.after(() => live.close());
  assert.equal((await live.opening)?.ok, true);
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const complete = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const events: McpLoginEvent[] = [];
  const prepared = await grok.prepareGrokMcpLogin({ target: b, binOverride: process.execPath });
  assert.ok(!('ok' in prepared));
  const child = prepared.start((event) => {
    events.push(event);
    if (event.type === 'error') fail(new Error(event.message));
    if (event.type === 'phase' && event.phase === 'done') finish();
  });
  assert.ok(!('ok' in child));
  t.after(() => child.cancel());
  await complete;
  assert.equal(
    (await calls(a)).some((c) => c.method === '_x.ai/mcp/auth_trigger'),
    false
  );
  assert.deepEqual((await calls(b)).find((c) => c.method === '_x.ai/mcp/auth_trigger')?.params, {
    session_id: await fs.realpath(b.readCwd),
    server_name: 'same'
  });
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'done'));
});

it('refuses user-scope authorisation when that cwd resolves a project shadow', async () => {
  const target = await peer('shadow');
  const user = { ...target, declaration: { scope: 'user' as const } };
  const result = await grok.prepareGrokMcpLogin({ target: user, binOverride: process.execPath });
  assert.ok('ok' in result && !result.ok);
  assert.equal(
    (await calls(target)).some((c) => c.method === 'session/new'),
    false
  );
});

it('Codex disconnect verifies and uses the selected cwd while another repo keeps its same name', async () => {
  const a = await peer('codex-a');
  const b = await peer('codex-b');
  await codex.codexMcpLogout({ ...b, brand: 'codex' }, { binOverride: process.execPath });
  assert.deepEqual(
    (await calls(b)).map((c) => c.args),
    [
      ['list', '--json'],
      ['logout', 'same']
    ]
  );
  await assert.rejects(fs.readFile(path.join(a.readCwd, 'mcp-calls.jsonl')), { code: 'ENOENT' });
});

it('Claude disconnect checks scope and reaches only the selected repo', async () => {
  const a = await peer('claude-a');
  const b = await peer('claude-b');
  await claude.mcpLogout({ ...b, brand: 'claude' }, process.execPath);
  assert.deepEqual(
    (await calls(b)).map((c) => c.args),
    [
      ['get', 'same'],
      ['logout', 'same']
    ]
  );
  await assert.rejects(fs.readFile(path.join(a.readCwd, 'mcp-calls.jsonl')), { code: 'ENOENT' });
  await assert.rejects(
    claude.mcpLogout({ ...b, brand: 'claude', declaration: { scope: 'user' } }, process.execPath),
    /declaration changed/
  );
  assert.deepEqual(
    (await calls(b)).map((c) => c.args),
    [
      ['get', 'same'],
      ['logout', 'same'],
      ['get', 'same']
    ]
  );
});

it('Claude refuses ambiguous endpoint text before logout', async () => {
  const target = await peer('claude-ambiguous');
  await fs.writeFile(
    path.join(target.readCwd, 'mcp-fixture.json'),
    JSON.stringify({
      name: 'same',
      scope: 'project',
      url: target.url + '\n  URL: https://other.example/mcp'
    })
  );
  await assert.rejects(
    claude.mcpLogout({ ...target, brand: 'claude' }, process.execPath),
    /declaration changed/
  );
  assert.deepEqual(
    (await calls(target)).map((call) => call.args),
    [['get', 'same']]
  );
});

it('Codex login cancellation ends only its root and leaves a held descendant unsignalled', async (t) => {
  const target = await peer('codex-login');
  await fs.writeFile(
    path.join(target.readCwd, 'mcp-fixture.json'),
    JSON.stringify({ name: 'same', url: target.url, scope: 'project', holdLogin: true })
  );
  const prepared = await codex.prepareCodexMcpLogin({
    target: { ...target, brand: 'codex' },
    binOverride: process.execPath
  });
  assert.ok(!('ok' in prepared));
  // Owned before the spawn, and cancelled by teardown however the test ends.
  const held = ownHeld(t, () =>
    fs.readFile(path.join(target.readCwd, 'login-ready'), 'utf8').catch(() => undefined)
  );
  const table = await watchTable(t);
  const child = prepared.start(() => {});
  t.after(() => {
    if (!('ok' in child)) child.cancel();
  });
  assert.ok(!('ok' in child));
  const { root, descendant } = await held.pids();
  child.cancel();
  await until(() => !alive(root));
  assert.equal(table.reads(), 0);
  assert.equal(table.signals(), 0);
  assert.equal(alive(descendant), true);
  assert.deepEqual(
    (await calls(target)).map((c) => c.args),
    [
      ['list', '--json'],
      ['login', 'same']
    ]
  );
});
