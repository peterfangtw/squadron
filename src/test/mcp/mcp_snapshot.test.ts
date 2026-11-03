import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, it } from 'node:test';
import { tempHome } from '../helpers';
import type { McpHealth } from '../../core/claude/mcp';
import type { McpSnapshot } from '../../core/mcp';

let home: string;
let claude: typeof import('../../core/claude/mcp');
let grok: typeof import('../../core/grok/mcp');
let mcp: typeof import('../../core/mcp');
let root: string;
let nested: string;
before(async () => {
  home = await tempHome();
  claude = await import('../../core/claude/mcp');
  grok = await import('../../core/grok/mcp');
  mcp = await import('../../core/mcp');
  root = path.join(home, 'repo');
  nested = path.join(root, 'nested');
  for (const dir of ['.grok', '.claude', path.join('repo', 'nested', '.grok')])
    await fs.mkdir(path.join(home, dir), { recursive: true });
});
beforeEach(async () => {
  for (const file of [
    '.claude.json',
    '.claude/mcp-needs-auth-cache.json',
    '.grok/config.toml',
    '.grok/mcp_credentials.json',
    'repo/.mcp.json',
    'repo/nested/.mcp.json',
    'repo/nested/.grok/config.toml'
  ])
    await fs.rm(path.join(home, file), { force: true });
});

const toml = '[mcp_servers.same]\nurl = "https://same.example/mcp"\n';
const project = JSON.stringify({ mcpServers: { same: { url: 'https://same.example/mcp' } } });

async function readFiles(): Promise<McpSnapshot[]> {
  return Promise.all([
    claude.readClaudeMcp({ roots: [nested, root, nested] }),
    grok.readGrokMcp({ roots: [nested, root, nested] })
  ]);
}

it('shows a Claude project declaration without a global config or another brand', async () => {
  const board = { roots: [nested, root], repos: [], repoOf: { [nested]: root } };
  // Nothing readable is an absent view, not an empty server list.
  assert.equal(mcp.foldBoard({ board, snapshots: await readFiles() }), undefined);

  await fs.writeFile(path.join(nested, '.mcp.json'), project);
  let snapshots = await readFiles();
  assert.equal(snapshots[0]?.opensBoard, true);
  assert.equal(snapshots[1]?.opensBoard, false);
  let reading = mcp.foldBoard({ board, snapshots });
  assert.equal(reading?.rows.length, 1);
  assert.equal(reading?.rows[0]?.brand, 'claude');
  assert.equal(reading?.rows[0]?.entries[0]?.root, root);
  assert.equal(reading?.rows[0]?.declarations?.[0]?.ref.readCwd, nested);
  const shown = mcp.foldMcpView({ rows: reading?.rows ?? [], ownRoot: root });
  assert.equal(shown.summary, 'All connected');
  assert.equal(shown.groups.find((group) => group.servers.length)?.servers[0]?.name, 'same');

  // Readable but server-less project text opens an empty board and invents no row.
  for (const text of [
    '',
    'not json',
    '{}',
    JSON.stringify({ mcpServers: { same: { command: 'bin' } } })
  ]) {
    await fs.writeFile(path.join(nested, '.mcp.json'), text);
    snapshots = await readFiles();
    assert.equal(snapshots[0]?.opensBoard, true);
    assert.equal(snapshots[1]?.opensBoard, false);
    reading = mcp.foldBoard({ board, snapshots });
    assert.deepEqual(reading?.rows, []);
    assert.equal(mcp.foldMcpView({ rows: reading?.rows ?? [] }).summary, undefined);
  }

  // A malformed sibling is read and adds nothing; the valid declaration stays.
  await fs.writeFile(path.join(root, '.mcp.json'), 'not json');
  await fs.writeFile(path.join(nested, '.mcp.json'), project);
  reading = mcp.foldBoard({ board, snapshots: await readFiles() });
  assert.deepEqual(
    reading?.rows.map((row) => [row.brand, row.name, row.declarations?.[0]?.ref.readCwd]),
    [['claude', 'same', nested]]
  );

  await fs.rm(path.join(nested, '.mcp.json'));
  await fs.rm(path.join(root, '.mcp.json'));
  // An empty global config still opens, and a cache file alone does not.
  await fs.writeFile(path.join(home, '.claude.json'), '');
  snapshots = await readFiles();
  assert.equal(snapshots[0]?.opensBoard, true);
  assert.deepEqual(mcp.foldBoard({ board, snapshots })?.rows, []);
  await fs.rm(path.join(home, '.claude.json'));
  await fs.writeFile(path.join(home, '.claude/mcp-needs-auth-cache.json'), '{"same":{}}');
  assert.equal(mcp.foldBoard({ board, snapshots: await readFiles() }), undefined);

  // A health probe can mint rows. Those rows are not a config, so they do not open the board.
  const probed = claude.claudeMcpSnapshot({
    roots: [nested],
    projectByRoot: {},
    health: new Map<string, McpHealth>([
      [`${nested}\0connector`, { state: 'ok', url: 'https://connector.example/mcp' }]
    ])
  });
  assert.equal(probed.opensBoard, false);
  assert.equal(
    probed.rows.some((row) => row.fromAccount),
    true
  );
  assert.equal(mcp.foldBoard({ board, snapshots: [probed] }), undefined);

  await fs.writeFile(path.join(nested, '.mcp.json'), project);
  for (const text of ['', 'not toml']) {
    await fs.writeFile(path.join(home, '.grok/config.toml'), text);
    reading = mcp.foldBoard({ board, snapshots: await readFiles() });
    assert.equal(reading?.rows.length, 1);
    assert.equal(reading?.rows[0]?.brand, 'claude');
    assert.equal(reading?.rows[0]?.declarations?.[0]?.ref.readCwd, nested);
  }
});

it('unavailable or malformed Claude input does not hide a valid Grok project or retain stale rows', async () => {
  await fs.writeFile(path.join(nested, '.grok/config.toml'), toml);
  const board = { roots: [root, nested], repos: [], repoOf: {} };
  for (const config of [undefined, '', 'not json']) {
    if (config !== undefined) await fs.writeFile(path.join(home, '.claude.json'), config);
    const reading = mcp.foldBoard({ board, snapshots: await readFiles() });
    assert.deepEqual(
      reading?.rows.map((row) => [row.brand, row.name, row.state]),
      [['grok', 'same', 'needs']]
    );
  }
  await fs.rm(path.join(nested, '.grok/config.toml'));
  assert.deepEqual((await grok.readGrokMcp({ roots: [nested] })).rows, []);
});

it('native readers apply optional cache/credential defaults and retain distinct cwd declarations', async () => {
  await fs.writeFile(path.join(home, '.claude.json'), '{}');
  await fs.writeFile(path.join(root, '.mcp.json'), project);
  await fs.writeFile(path.join(nested, '.mcp.json'), project);
  await fs.writeFile(path.join(nested, '.grok/config.toml'), toml);
  for (const text of [undefined, 'not json', '{}']) {
    if (text !== undefined) {
      await fs.writeFile(path.join(home, '.claude/mcp-needs-auth-cache.json'), text);
      await fs.writeFile(path.join(home, '.grok/mcp_credentials.json'), text);
    }
    const snapshots = await readFiles();
    const c = snapshots[0]?.rows[0];
    const g = snapshots[1]?.rows[0];
    assert.equal(c?.state, 'ok');
    assert.equal(g?.state, 'needs');
    assert.deepEqual(
      c?.declarations?.map((d) => d.ref.readCwd),
      [nested, root]
    );
    assert.equal(g?.declarations?.[0]?.ref.readCwd, nested);
  }
  await fs.writeFile(path.join(home, '.claude/mcp-needs-auth-cache.json'), '{"same":{}}');
  await fs.writeFile(
    path.join(home, '.grok/mcp_credentials.json'),
    '{"same:https://same.example/mcp":{}}'
  );
  const snapshots = await readFiles();
  assert.equal(snapshots[0]?.rows[0]?.state, 'needs');
  assert.equal(snapshots[0]?.rows[0]?.canDisconnect, false);
  assert.equal(snapshots[1]?.rows[0]?.state, 'ok');
  assert.equal(snapshots[1]?.rows[0]?.canDisconnect, true);
});

it('neutral grouping preserves producer provenance and capabilities without mutating snapshots', () => {
  const snapshot = grok.grokMcpSnapshot({
    roots: [nested, root],
    projectByRoot: {
      [nested]: toml,
      [root]: toml
    },
    credentials: '{"same:https://same.example/mcp":{}}'
  });
  const before = structuredClone(snapshot);
  const reading = mcp.foldBoard({
    snapshots: [snapshot],
    board: {
      roots: [root, nested],
      repos: [],
      repoOf: { [nested]: root }
    }
  });
  assert.equal(reading?.rows[0]?.entries[0]?.root, root);
  assert.deepEqual(
    reading?.rows[0]?.declarations?.map((d) => d.ref.readCwd),
    [nested, root]
  );
  assert.equal(reading?.rows[0]?.canLogin, true);
  assert.equal(reading?.rows[0]?.canDisconnect, true);
  assert.deepEqual(snapshot, before);
  assert.equal(
    mcp.foldMcpView({ rows: reading?.rows ?? [] }).groups[0]?.servers[0]?.brands[0]?.target,
    undefined,
    'grouping two declarations must not choose a native cwd'
  );
});
