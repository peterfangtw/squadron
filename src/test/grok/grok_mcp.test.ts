import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeHome, modeBitsSkip, tempHome } from '../home';
import type { McpActionTarget } from '../../core/mcp_target';

const ALPHA = 'https://alpha.example/mcp';
const BETA = 'https://beta.example/mcp';
const GAMMA = 'https://gamma.example/mcp';
const ALPHA_KEY = `alpha:${ALPHA}`;
const BETA_KEY = `beta:${BETA}`;
const GAMMA_KEY = `gamma:${GAMMA}`;
const SENTINEL = 'sentinel-not-ours\n';
/** Above the eight 25 ms contention sleeps, and short enough that a stuck claim fails the run. */
const LOCK_CASE_MS = 30_000;

let home: string;
let api: typeof import('../../core/grok/mcp');
let paths: typeof import('../../core/paths');
let platform: typeof import('../../core/platform');
let initSettled: typeof import('../../core/grok/session').initSettled;

before(async () => {
  home = await tempHome();
  api = await import('../../core/grok/mcp');
  paths = await import('../../core/paths');
  platform = await import('../../core/platform');
  ({ initSettled } = await import('../../core/grok/session'));
});

after(async () => {
  if (home) await disposeHome(home);
});

describe('parseGrokMcpServers', () => {
  /** Observed 2026-08-17 on this machine, CLI 1.0.4, trimmed. */
  const TOML = [
    '[ui]',
    'permission_mode = "always-approve"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/mcp"',
    'enabled = true',
    '',
    '[mcp_servers.slack]',
    'url = "https://mcp.slack.com/mcp"',
    'enabled = true',
    '',
    '[mcp_servers.old]',
    'url = "https://old.example/mcp"',
    'enabled = false',
    '',
    '[privacy]'
  ].join('\n');

  it('reads enabled servers and skips a disabled one', () => {
    assert.deepEqual(api.parseGrokMcpServers(TOML), [
      { name: 'linear', url: 'https://mcp.linear.app/mcp', project: '', scope: 'user' },
      { name: 'slack', url: 'https://mcp.slack.com/mcp', project: '', scope: 'user' }
    ]);
  });

  it('skips a block with no url', () => {
    const toml = '[mcp_servers.stdio]\ncommand = "npx"\nenabled = true\n';
    assert.deepEqual(api.parseGrokMcpServers(toml), []);
  });

  it('ignores a # comment and an unquoted url', () => {
    const toml = '[mcp_servers.linear]\nurl = https://mcp.linear.app/mcp # trailing\n';
    assert.deepEqual(api.parseGrokMcpServers(toml), [
      { name: 'linear', url: 'https://mcp.linear.app/mcp', project: '', scope: 'user' }
    ]);
  });

  it('tags a repo file as project scope against that root', () => {
    // Same TOML as user; the caller says where it sat. Observed 2026-08-20:
    // `grok mcp add --scope project` writes `.grok/config.toml`.
    const toml = '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n';
    assert.deepEqual(api.parseGrokMcpServers(toml, { project: '/r', scope: 'project' }), [
      { name: 'linear', url: 'https://mcp.linear.app/mcp', project: '/r', scope: 'project' }
    ]);
  });
});

describe('deeperProjectWins', () => {
  const at = (dir: string, url: string) =>
    api.parseGrokMcpServers(`[mcp_servers.linear]\nurl = "${url}"\n`, {
      project: dir,
      scope: 'project'
    })[0]!;
  const checkout = () => '/repo';

  it('keeps the deeper file when one name is declared twice in a repo', () => {
    // Grok walks cwd → git root; cwd wins. Measured 2026-08-20, CLI 1.0.5.
    assert.equal(
      api.deeperProjectWins(
        [at('/repo', 'https://root.example/mcp'), at('/repo/pkg', 'https://pkg.example/mcp')],
        checkout
      )[0]?.url,
      'https://pkg.example/mcp'
    );
  });

  it('does not drop a user server of the same name', () => {
    const user = api.parseGrokMcpServers(
      '[mcp_servers.linear]\nurl = "https://user.example/mcp"\n'
    );
    assert.equal(
      api.deeperProjectWins([at('/repo', 'https://proj.example/mcp'), ...user], checkout).length,
      2
    );
  });
});

describe('parseGrokCredentials / grokMcpRows', () => {
  it('treats a present name:url key as ok and a missing one as needs', () => {
    const creds = api.parseGrokCredentials(
      JSON.stringify({
        'linear:https://mcp.linear.app/mcp': { token_response: {} },
        noise: { skip: true }
      })
    );
    assert.ok(creds.has('linear:https://mcp.linear.app/mcp'));
    assert.equal(creds.has('noise'), false);
    const rows = api.grokMcpRows(
      api.parseGrokMcpServers(
        [
          '[mcp_servers.linear]',
          'url = "https://mcp.linear.app/mcp"',
          '[mcp_servers.slack]',
          'url = "https://mcp.slack.com/mcp"'
        ].join('\n')
      ),
      creds
    );
    assert.deepEqual(
      rows.map((r) => [r.name, r.state, r.host, r.entries]),
      [
        ['linear', 'ok', 'mcp.linear.app', []],
        ['slack', 'needs', 'mcp.slack.com', []]
      ]
    );
    assert.equal(
      rows.every((r) => r.brand === 'grok' && r.canLogin === true),
      true
    );
  });

  it('carries a project file as an entry on that repo', () => {
    const rows = api.grokMcpRows(
      api.parseGrokMcpServers('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n', {
        project: '/Users/x/shop',
        scope: 'project'
      }),
      new Set()
    );
    assert.deepEqual(rows[0]?.entries, [{ root: '/Users/x/shop', scope: 'project' }]);
    assert.deepEqual(rows[0]?.projects, ['shop']);
  });

  it('does not invent a row from a credential whose server has left the config', () => {
    // Ghost cache, Grok-shaped: a leftover key is not a server.
    const creds = api.parseGrokCredentials(
      JSON.stringify({ 'gone:https://gone.example/mcp': { token_response: {} } })
    );
    assert.equal(api.grokMcpRows([], creds).length, 0);
  });
});

describe('grokMcpLogout', { concurrency: 1 }, () => {
  it('names the credential lock under the home it was given', () => {
    const dir = path.join(home, 'lock-path');
    assert.equal(
      paths.grokMcpCredentialLock(dir),
      path.join(dir, '.squadron', 'grok-mcp-credentials.lock')
    );
    assert.notEqual(paths.grokMcpCredentialLock(dir), paths.grokMcpCredentialLock());
  });

  it('drops only the named key', async () => {
    const dir = await sandbox('named');
    const file = await plant(dir, {
      'linear:https://mcp.linear.app/mcp': { keep: false },
      'slack:https://mcp.slack.com/mcp': { keep: true }
    });
    await api.grokMcpLogout(target('linear', 'https://mcp.linear.app/mcp', dir), dir);
    const next = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(next['linear:https://mcp.linear.app/mcp'], undefined);
    assert.ok(next['slack:https://mcp.slack.com/mcp']);
    await assertClaimReleased(dir);
  });

  it('is a no-op when the file is missing', async () => {
    const dir = await sandbox('missing');
    await api.grokMcpLogout(target('linear', 'https://mcp.linear.app/mcp', dir), dir);
    await assertClaimReleased(dir);
    const file = await plant(dir, { [BETA_KEY]: { keep: false } });
    await api.grokMcpLogout(target('beta', BETA, dir), dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    await assertClaimReleased(dir);
  });

  it(
    'drops both named keys when two logouts overlap and keeps the third',
    { timeout: LOCK_CASE_MS },
    async () => {
      const dir = await sandbox('overlap');
      const file = await plant(dir, {
        [ALPHA_KEY]: { n: 1 },
        [BETA_KEY]: { n: 2 },
        [GAMMA_KEY]: { keep: true }
      });
      const settled = await Promise.allSettled([
        api.grokMcpLogout(target('alpha', ALPHA, dir), dir),
        api.grokMcpLogout(target('beta', BETA, dir), dir)
      ]);
      let body: unknown;
      try {
        body = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        body = `unreadable:${error instanceof Error ? error.message : 'read failed'}`;
      }
      assert.deepEqual(
        {
          calls: settled.map((item) =>
            item.status === 'fulfilled' ? 'fulfilled' : `rejected:${String(item.reason)}`
          ),
          body
        },
        {
          calls: ['fulfilled', 'fulfilled'],
          body: { [GAMMA_KEY]: { keep: true } }
        }
      );
      await assertClaimReleased(dir);
    }
  );

  for (const [label, body] of [
    ['live pid', JSON.stringify({ pid: process.pid, attemptId: 'occupied-live' })],
    ['empty', ''],
    ['malformed', '{'],
    ['orphan-shaped', JSON.stringify({ pid: 0, attemptId: 'orphan' })]
  ] as const) {
    it(
      `leaves credentials and the ${label} lock untouched`,
      { timeout: LOCK_CASE_MS },
      async () => {
        const dir = await sandbox(`occupied-${label.replace(/ /g, '-')}`);
        const file = await plant(dir, {
          [ALPHA_KEY]: { keep: true },
          [BETA_KEY]: { keep: true }
        });
        const lock = paths.grokMcpCredentialLock(dir);
        await fs.mkdir(path.dirname(lock), { recursive: true });
        await fs.writeFile(lock, body);
        const credentials = await fs.readFile(file);
        const lockBytes = await fs.readFile(lock);
        await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
        assert.deepEqual(await fs.readFile(file), credentials);
        assert.deepEqual(await fs.readFile(lock), lockBytes);
      }
    );
  }

  it('releases after a successful publish so a later logout can acquire', async (t) => {
    const dir = await sandbox('release-success');
    const file = await plant(dir, {
      [ALPHA_KEY]: { n: 1 },
      [BETA_KEY]: { n: 2 }
    });
    let attempts = 0;
    const rename = fs.rename;
    const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === file) attempts++;
      await rename(...args);
    });
    try {
      await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    } finally {
      mocked.mock.restore();
    }
    assert.equal(attempts, 1);
    const next = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(next[ALPHA_KEY], undefined);
    assert.deepEqual(next[BETA_KEY], { n: 2 });
    await assertClaimReleased(dir);
    await api.grokMcpLogout(target('beta', BETA, dir), dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    await assertClaimReleased(dir);
  });

  for (const [label, body] of [
    ['an absent key', JSON.stringify({ [BETA_KEY]: { keep: true } })],
    ['a malformed file', '{'],
    ['a non-object file', '[]']
  ] as const) {
    it(`releases after ${label} and a later logout still deletes`, async () => {
      const dir = await sandbox(`release-${label.replace(/ /g, '-')}`);
      const file = await plant(dir, body);
      const before = await fs.readFile(file);
      await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
      assert.deepEqual(await fs.readFile(file), before);
      await assertClaimReleased(dir);
      await fs.writeFile(file, JSON.stringify({ [BETA_KEY]: { n: 1 } }));
      await api.grokMcpLogout(target('beta', BETA, dir), dir);
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
      await assertClaimReleased(dir);
    });
  }

  it('leaves credentials in place when publish fails and a later logout succeeds', async (t) => {
    const dir = await sandbox('publish-fails');
    const file = await plant(dir, { [ALPHA_KEY]: { keep: true } });
    const before = await fs.readFile(file);
    let replaces = 0;
    const replace = platform.files.replace.bind(platform.files);
    const mocked = t.mock.method(
      platform.files,
      'replace',
      (source: string, destination: string) => {
        if (destination !== file) return replace(source, destination);
        replaces += 1;
        return Promise.reject(Object.assign(new Error('replace refused'), { code: 'EPERM' }));
      }
    );
    try {
      await assert.rejects(() => api.grokMcpLogout(target('alpha', ALPHA, dir), dir), {
        code: 'EPERM'
      });
    } finally {
      mocked.mock.restore();
    }
    assert.equal(replaces, 1);
    assert.deepEqual(await fs.readFile(file), before);
    await assertClaimReleased(dir);
    await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    await assertClaimReleased(dir);
  });

  it('removes a temp it opened when the temp write fails', async (t) => {
    const dir = await sandbox('temp-write-fails');
    const file = await plant(dir, { [ALPHA_KEY]: { keep: true } });
    const before = await fs.readFile(file);
    const realOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const opened = args[0];
      if (typeof opened === 'string' && opened.startsWith(`${file}.`)) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (data: string | Uint8Array) => {
          const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
          await write(text.slice(0, 1));
          throw Object.assign(new Error('short write'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    try {
      await assert.rejects(() => api.grokMcpLogout(target('alpha', ALPHA, dir), dir), {
        code: 'ENOSPC'
      });
    } finally {
      mocked.mock.restore();
    }
    assert.deepEqual(await fs.readFile(file), before);
    await assertClaimReleased(dir);
    await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    await assertClaimReleased(dir);
  });

  it('removes its lock when the lock body cannot be written', async (t) => {
    const dir = await sandbox('lock-body-fails');
    const file = await plant(dir, { [ALPHA_KEY]: { keep: true } });
    const before = await fs.readFile(file);
    const lock = paths.grokMcpCredentialLock(dir);
    const realOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === lock) {
        t.mock.method(handle, 'writeFile', () =>
          Promise.reject(Object.assign(new Error('lock body'), { code: 'ENOSPC' }))
        );
      }
      return handle;
    });
    try {
      await assert.rejects(() => api.grokMcpLogout(target('alpha', ALPHA, dir), dir), {
        code: 'ENOSPC'
      });
    } finally {
      mocked.mock.restore();
    }
    assert.deepEqual(await fs.readFile(file), before);
    await assertClaimReleased(dir);
    await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
    await assertClaimReleased(dir);
  });

  it('does not remove a temp whose exclusive create reports EEXIST', async (t) => {
    const dir = await sandbox('temp-eexist');
    const file = await plant(dir, { [ALPHA_KEY]: { keep: true } });
    const before = await fs.readFile(file);
    let sentinel = '';
    const realOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const opened = args[0];
      if (typeof opened === 'string' && opened.startsWith(`${file}.`)) {
        sentinel = opened;
        const planted = await realOpen(opened, 'wx', 0o600);
        await planted.writeFile(SENTINEL);
        await planted.close();
        throw Object.assign(new Error('temp exists'), { code: 'EEXIST' });
      }
      return realOpen(...args);
    });
    try {
      await assert.rejects(() => api.grokMcpLogout(target('alpha', ALPHA, dir), dir), {
        code: 'EEXIST'
      });
    } finally {
      mocked.mock.restore();
    }
    assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL);
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(fs.lstat(paths.grokMcpCredentialLock(dir)), { code: 'ENOENT' });
    await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
  });

  it('publishes the credential file owner-only', { skip: modeBitsSkip }, async () => {
    const dir = await sandbox('mode');
    const file = await plant(dir, { [ALPHA_KEY]: { n: 1 }, [BETA_KEY]: { n: 2 } });
    await api.grokMcpLogout(target('alpha', ALPHA, dir), dir);
    const mode = (await fs.stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `mode ${mode.toString(8)}`);
  });

  it('does not change credentials when the target has no url', async () => {
    const dir = await sandbox('no-url');
    const file = await plant(dir, { [ALPHA_KEY]: { keep: true } });
    const before = await fs.readFile(file);
    const bare: McpActionTarget = { ...target('alpha', ALPHA, dir), url: undefined };
    await api.grokMcpLogout(bare, dir);
    assert.deepEqual(await fs.readFile(file), before);
    await assertClaimReleased(dir);
  });
});

/**
 * The gate in front of `auth_trigger`.
 *
 * Measured 2026-08-17, CLI 1.0.4: a trigger fired as soon as `session/new`
 * returns is discarded — no browser, no listener, RPC never resolves. The frame
 * that says init is over is `_x.ai/mcp/init_progress`.
 */
describe('initSettled', () => {
  it('holds while servers are still being attempted', () => {
    assert.equal(initSettled({ total: 3, connected: 0 }), false);
    assert.equal(initSettled({ total: 3, connected: 2 }), false);
  });

  it('opens once every server has been attempted', () => {
    assert.equal(initSettled({ total: 3, connected: 3 }), true);
  });

  // `connected` counts attempts, not health: slack was among the three that
  // reached 3/3 while its own handshake had failed for want of auth.
  it('counts a failed handshake as attempted', () => {
    assert.equal(initSettled({ total: 1, connected: 1, sessionId: 'x' }), true);
  });

  it('never opens on a frame it cannot read', () => {
    for (const bad of [undefined, null, 'x', [], {}, { total: 0, connected: 0 }]) {
      assert.equal(initSettled(bad), false);
    }
  });
});

describe('the fold — Codex rows', () => {
  it('never offers Disconnect on a Grok row with no stored credential', () => {
    const rows = api.grokMcpRows(
      api.parseGrokMcpServers('[mcp_servers.slack]\nurl = "https://mcp.slack.com/mcp"'),
      new Set()
    );
    assert.equal(rows[0]?.state, 'needs');
    assert.equal(rows[0]?.canDisconnect, false);
  });
});

function target(name: string, url: string, dir: string): McpActionTarget {
  return {
    brand: 'grok',
    name,
    key: url,
    url,
    declaration: { scope: 'user' },
    readCwd: dir,
    canLogin: true,
    canDisconnect: true
  };
}

async function sandbox(name: string): Promise<string> {
  const dir = path.join(home, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** `body` is either raw file text or a JSON value. */
async function plant(dir: string, body: unknown): Promise<string> {
  const grok = path.join(dir, '.grok');
  await fs.mkdir(grok, { recursive: true });
  const file = path.join(grok, 'mcp_credentials.json');
  await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

async function assertClaimReleased(dir: string): Promise<void> {
  await assert.rejects(fs.lstat(paths.grokMcpCredentialLock(dir)), { code: 'ENOENT' });
  const names = await fs.readdir(path.join(dir, '.grok')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(
    names.filter((name) => name === 'mcp_credentials.json.tmp' || name.endsWith('.tmp')),
    []
  );
}
