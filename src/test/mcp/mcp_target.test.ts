import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, it } from 'node:test';
import { tempHome } from '../helpers';
import { resolveMcpTarget } from '../../core/mcp_target';
import type { McpActionRef } from '../../core/mcp_target';
import type { McpRow } from '../../core/mcp';

let foldNativeMcp: typeof import('./mcp_helpers').foldNativeMcp;
let home: string;
let mcp: typeof import('../../core/mcp');
let grok: typeof import('../../core/grok/mcp');
before(async () => {
  home = await tempHome();
  ({ foldNativeMcp } = await import('./mcp_helpers'));
  mcp = await import('../../core/mcp');
  grok = await import('../../core/grok/mcp');
});

function twoRepos(): McpRow[] {
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  return foldNativeMcp({
    texts: {
      grokProjectByRoot: {
        [a]: '[mcp_servers.same]\nurl = "https://a.example/mcp"\n',
        [b]: '[mcp_servers.same]\nurl = "https://b.example/mcp"\n'
      },
      mcpJsonByRoot: {},
      grokCredentials: JSON.stringify({
        'same:https://a.example/mcp': {},
        'same:https://b.example/mcp': {}
      })
    },
    board: { roots: [a, b], repos: [], repoOf: {} }
  }).rows;
}

it('disconnecting B preserves A’s same-named credential and routes with B’s read cwd', async () => {
  const rows = twoRepos();
  const b = mcp.foldMcpView({ rows }).groups.find((g) => g.root === path.join(home, 'b'))
    ?.servers[0]?.brands[0]?.target;
  assert.ok(b);
  const target = resolveMcpTarget(rows, b, 'disconnect');
  assert.ok(target);
  assert.equal(target.readCwd, path.join(home, 'b'));
  await fs.mkdir(path.join(home, '.grok'), { recursive: true });
  const file = path.join(home, '.grok', 'mcp_credentials.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      'same:https://a.example/mcp': { keep: true },
      'same:https://b.example/mcp': { remove: true }
    })
  );
  await grok.grokMcpLogout(target, home);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    'same:https://a.example/mcp': { keep: true }
  });
});

it('refuses absent, stale, cross-brand, ambiguous and unsupported selections', () => {
  const rows = twoRepos();
  const ref = rows[1]?.declarations?.[0]?.ref;
  assert.ok(ref);
  for (const bad of [
    undefined,
    {},
    { name: 'same' },
    { ...ref, brand: 'claude' },
    { ...ref, url: 'https://changed.example/mcp' },
    { ...ref, readCwd: path.join(home, 'a') },
    { ...ref, declaration: { scope: 'user' } }
  ]) {
    assert.equal(resolveMcpTarget(rows, bad, 'login'), undefined);
  }
  assert.equal(resolveMcpTarget(rows.slice(0, 1), ref, 'login'), undefined);
  assert.equal(resolveMcpTarget([...rows, rows[1]!], ref, 'login'), undefined);
  assert.equal(
    resolveMcpTarget(
      rows.map((r) => ({ ...r, canLogin: false })),
      ref,
      'login'
    ),
    undefined
  );
  assert.equal(
    resolveMcpTarget(
      rows.map((r) => ({ ...r, fromAccount: true })),
      ref,
      'disconnect'
    ),
    undefined
  );
});

it('overlays a login only on its selected declaration, preserving its capability when removed', () => {
  const rows = twoRepos();
  const target = rows[1]?.declarations?.[0]?.ref;
  assert.ok(target);
  const live = {
    target: { ...target, canLogin: true, canDisconnect: false },
    phase: 'error' as const,
    note: 'B refused'
  };
  const view = mcp.foldMcpView({ rows, live });
  assert.equal(
    view.groups.find((g) => g.root === path.join(home, 'a'))?.servers[0]?.brands[0]?.state,
    'ok'
  );
  assert.equal(
    view.groups.find((g) => g.root === path.join(home, 'b'))?.servers[0]?.brands[0]?.state,
    'error'
  );
  const orphan = mcp.foldMcpView({ rows: [], live }).groups[0]?.servers[0]?.brands[0];
  assert.deepEqual(orphan?.target, live.target);
  assert.equal(orphan?.supported, true);
  const before = mcp.foldMcpView({
    rows: [],
    live: { ...live, url: 'https://auth.example/first' }
  });
  const after = mcp.foldMcpView({
    rows: [],
    live: { ...live, url: 'https://auth.example/second' }
  });
  assert.equal(before.groups[0]?.servers[0]?.key, after.groups[0]?.servers[0]?.key);
});

it('keeps native aliases distinct at one URL and explicit user scope on an empty board', () => {
  const rows = grok.grokMcpRows(
    grok.parseGrokMcpServers(
      '[mcp_servers.first]\nurl = "https://shared.example/mcp"\n[mcp_servers.second]\nurl = "https://shared.example/mcp"\n'
    ),
    new Set(['second:https://shared.example/mcp'])
  );
  const cells = mcp.foldMcpView({ rows }).groups.flatMap((g) => g.servers.flatMap((s) => s.brands));
  assert.deepEqual(
    cells.map((c) => [c.name, c.canDisconnect]),
    [
      ['first', false],
      ['second', true]
    ]
  );
  const ref = cells[1]?.target;
  assert.ok(ref);
  assert.deepEqual(ref.declaration, { scope: 'user' });
  assert.equal(resolveMcpTarget(rows, ref, 'disconnect')?.name, 'second');
});

it('withholds an action when distinct read cwds collapse to the same displayed cell', () => {
  const rows = twoRepos();
  const row = rows[0]!;
  const ref = row.declarations![0]!.ref;
  const other: McpActionRef = {
    ...ref,
    readCwd: path.join(home, 'other'),
    declaration: { scope: 'project', root: path.join(home, 'other') }
  };
  row.declarations!.push({ sectionRoot: path.join(home, 'a'), ref: other });
  const cell = mcp.foldMcpView({ rows }).groups[0]?.servers[0]?.brands[0];
  assert.equal(cell?.target, undefined);
  assert.equal(cell?.supported, false);
  assert.equal(cell?.canDisconnect, false);
});
