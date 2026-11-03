import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codexMcpLogout, readCodexMcp, type CodexMcpRunner } from '../../core/codex/mcp';

const HOME = '/home/reader';
const REPO = '/repos/acme-web';

/** One server as `codex mcp list --json` prints it, 0.151.0. */
const http = (name: string, url: string, auth: string, over: object = {}) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport: {
    type: 'streamable_http',
    url,
    bearer_token_env_var: null,
    http_headers: { Authorization: 'Bearer sk-do-not-leak' },
    env_http_headers: null,
    http_headers_helper: null
  },
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: auth,
  ...over
});

const stdio = (name: string, command: string, over: object = {}) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport: {
    type: 'stdio',
    command,
    args: ['--app', 'desktop', '--token', 'do-not-leak'],
    env: { SECRET: 'do-not-leak' },
    env_vars: ['SECRET'],
    cwd: null
  },
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: 'unsupported',
  ...over
});

/** A CLI that answers per cwd, and records what it was asked. */
const cli = (byCwd: Record<string, unknown>) => {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: CodexMcpRunner = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const said = byCwd[cwd];
    if (said === undefined) return Promise.reject(new Error(`no answer for ${cwd}`));
    return Promise.resolve(typeof said === 'string' ? said : JSON.stringify(said));
  };
  return { exec, calls };
};

describe('codex mcp — reading the CLI', () => {
  it('keys an http row by its url, so it can join another brand', async () => {
    const { exec } = cli({ [HOME]: [http('linear', 'https://mcp.linear.app/mcp', 'o_auth')] });
    const {
      rows: [row]
    } = await readCodexMcp({ roots: [], home: HOME, exec });
    assert.equal(row?.key, 'https://mcp.linear.app/mcp');
    assert.equal(row?.url, 'https://mcp.linear.app/mcp');
    assert.equal(row?.host, 'mcp.linear.app');
    assert.equal(row?.brand, 'codex');
  });

  it('retains cwd capability differences even when a user name and endpoint coincide', async () => {
    for (const over of [{ auth_status: 'bearer_token' }, { enabled: false }]) {
      const { exec } = cli({
        [HOME]: [http('same', 'https://same.example/mcp', 'o_auth')],
        [REPO]: [http('same', 'https://same.example/mcp', 'o_auth', over)]
      });
      const { rows } = await readCodexMcp({ roots: [REPO], home: HOME, exec });
      assert.equal(rows.length, 2);
      const effective = rows.find((r) => r.declarations?.[0]?.ref.readCwd === REPO);
      assert.ok(effective);
      assert.equal(effective.canDisconnect, false);
      assert.equal(effective.declarations?.[0]?.ref.declaration.scope, 'effective');
    }
  });

  it('gives a stdio row a key that is not its command line', async () => {
    const { exec } = cli({
      [HOME]: [],
      [REPO]: [stdio('pencil', '/Applications/Pencil.app/Contents/mcp-server-darwin-arm64')]
    });
    const {
      rows: [row]
    } = await readCodexMcp({ roots: [REPO], home: HOME, exec });
    assert.ok(row);
    assert.equal(row.url, undefined, 'a process has no url');
    assert.equal(row.host, 'STDIO · mcp-server-darwin-arm64');
    assert.match(row.key, /pencil/);
    const serialised = JSON.stringify(row);
    assert.doesNotMatch(serialised, /do-not-leak/, 'no argument, env or header escapes');
    assert.doesNotMatch(serialised, /--app/, 'no argv on a row');
    assert.doesNotMatch(serialised, /Applications/, 'no full command path either');
  });

  it('keeps two projects’ same-named stdio servers apart', async () => {
    const other = '/repos/other';
    const { exec } = cli({
      [HOME]: [],
      [REPO]: [stdio('pencil', '/a/pencil')],
      [other]: [stdio('pencil', '/b/pencil')]
    });
    const { rows } = await readCodexMcp({ roots: [REPO, other], home: HOME, exec });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.key, rows[1]?.key, 'two processes, two rows');
  });

  it('maps every auth_status to a state and a credential answer', async () => {
    const table: [string, string, boolean][] = [
      ['o_auth', 'ok', true],
      ['bearer_token', 'ok', false],
      ['unsupported', 'ok', false],
      ['not_logged_in', 'needs', false],
      ['unknown', 'unknown', false]
    ];
    for (const [auth, state, canDisconnect] of table) {
      const { exec } = cli({ [HOME]: [http('s', 'https://s.example/mcp', auth)] });
      const {
        rows: [row]
      } = await readCodexMcp({ roots: [], home: HOME, exec });
      assert.equal(row?.state, state, auth);
      assert.equal(row?.canDisconnect, canDisconnect, auth);
    }
  });

  it('treats an auth_status it has never seen as unknown, not as connected', async () => {
    const { exec } = cli({ [HOME]: [http('s', 'https://s.example/mcp', 'invented_later')] });
    const {
      rows: [row]
    } = await readCodexMcp({ roots: [], home: HOME, exec });
    assert.equal(row?.state, 'unknown');
    assert.equal(row?.canDisconnect, false);
  });

  it('derives project scope by differencing the home run', async () => {
    const { exec, calls } = cli({
      [HOME]: [http('user_wide', 'https://user.example/mcp', 'o_auth')],
      [REPO]: [
        http('user_wide', 'https://user.example/mcp', 'o_auth'),
        http('repo_only', 'https://repo.example/mcp', 'not_logged_in')
      ]
    });
    const { rows } = await readCodexMcp({ roots: [REPO, REPO], home: HOME, exec });
    const user = rows.find((r) => r.name === 'user_wide');
    const repo = rows.find((r) => r.name === 'repo_only');
    assert.deepEqual(user?.entries, [], 'a user server belongs to no repo');
    assert.deepEqual(repo?.entries, [{ root: REPO, scope: 'project' }]);
    assert.deepEqual(repo?.projects, ['acme-web']);
    assert.equal(rows.filter((r) => r.name === 'user_wide').length, 1, 'not counted twice');
    assert.deepEqual(calls[0]?.args, ['mcp', 'list', '--json']);
    assert.deepEqual(
      calls.map((call) => call.cwd),
      [HOME, REPO]
    );
  });

  it('retains a repo endpoint that overrides a user server with the same native name', async () => {
    const { exec } = cli({
      [HOME]: [http('same', 'https://user.example/mcp', 'o_auth')],
      [REPO]: [http('same', 'https://repo.example/mcp', 'o_auth')]
    });
    const { rows } = await readCodexMcp({ roots: [REPO], home: HOME, exec });
    assert.deepEqual(
      rows.map((row) => [
        row.url,
        row.declarations?.[0]?.ref.declaration,
        row.declarations?.[0]?.ref.readCwd
      ]),
      [
        ['https://user.example/mcp', { scope: 'user' }, HOME],
        ['https://repo.example/mcp', { scope: 'effective', root: REPO }, REPO]
      ]
    );
  });

  it('keeps a root whose run failed out, rather than reporting it empty', async () => {
    const dead = '/repos/dead';
    const { exec } = cli({
      [HOME]: [],
      [REPO]: [http('alive', 'https://alive.example/mcp', 'o_auth')]
      // `dead` answers with a throw.
    });
    const { rows } = await readCodexMcp({ roots: [dead, REPO], home: HOME, exec });
    assert.deepEqual(
      rows.map((r) => r.name),
      ['alive'],
      'one bad root does not take the good one with it'
    );
  });

  it('reports nothing at all when the home run fails', async () => {
    const { exec, calls } = cli({});
    assert.deepEqual(await readCodexMcp({ roots: [REPO], home: HOME, exec }), {
      rows: [],
      opensBoard: false
    });
    assert.deepEqual(
      calls.map((call) => call.cwd),
      [HOME]
    );
  });

  it('survives output that is not the array it expects', async () => {
    for (const said of ['not json at all', '{"servers":[]}', 'null']) {
      const { exec } = cli({ [HOME]: said });
      assert.deepEqual(
        await readCodexMcp({ roots: [], home: HOME, exec }),
        { rows: [], opensBoard: false },
        said
      );
    }
  });

  it('drops a server with no name rather than drawing a nameless row', async () => {
    const { exec } = cli({ [HOME]: [{ enabled: true, auth_status: 'o_auth' }] });
    assert.deepEqual(await readCodexMcp({ roots: [], home: HOME, exec }), {
      rows: [],
      opensBoard: false
    });
  });

  it('keeps a disabled server, and says why it is not running', async () => {
    const { exec } = cli({
      [HOME]: [
        http('off', 'https://off.example/mcp', 'o_auth', {
          enabled: false,
          disabled_reason: 'Disabled in config.toml'
        })
      ]
    });
    const {
      rows: [row]
    } = await readCodexMcp({ roots: [], home: HOME, exec });
    assert.equal(row?.state, 'unknown', 'a disabled server has no live auth state');
    assert.equal(row?.canDisconnect, false);
    assert.equal(row?.note, 'Disabled in config.toml');
  });
});

describe('codex mcp — logout', () => {
  const target = {
    brand: 'codex' as const,
    name: 'linear',
    key: 'https://selected.example/mcp',
    url: 'https://selected.example/mcp',
    declaration: { scope: 'project' as const, root: REPO },
    readCwd: REPO,
    canLogin: true,
    canDisconnect: true
  };
  it('checks the effective endpoint and logs out at the selected declaration cwd', async () => {
    const { exec, calls } = cli({
      [REPO]: JSON.stringify([
        {
          name: 'linear',
          transport: { type: 'streamable_http', url: target.url },
          auth_status: 'o_auth'
        }
      ])
    });
    await codexMcpLogout(target, { exec });
    assert.deepEqual(calls, [
      { args: ['mcp', 'list', '--json'], cwd: REPO },
      { args: ['mcp', 'logout', 'linear'], cwd: REPO }
    ]);
  });
  it('refuses a changed or shadowed endpoint before logout', async () => {
    const { exec, calls } = cli({
      [REPO]: JSON.stringify([
        {
          name: 'linear',
          transport: { type: 'streamable_http', url: 'https://other.example/mcp' },
          auth_status: 'o_auth'
        }
      ])
    });
    await assert.rejects(codexMcpLogout(target, { exec }), /declaration changed/);
    assert.deepEqual(calls, [{ args: ['mcp', 'list', '--json'], cwd: REPO }]);
  });
});
