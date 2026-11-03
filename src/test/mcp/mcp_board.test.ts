import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { healthKey, type McpHealth } from '../../core/claude/mcp';
import { foldMcpView } from '../../core/mcp';

import { foldNativeMcp } from './mcp_helpers';

describe('native snapshots through the board', () => {
  const REPO = '/Users/x/project';
  const TREE = '/Users/x/project-wt';
  const SERVER = 'smoke-mcp';
  const SMOKE_URL = 'https://mcp.smoke.test/mcp';

  const emptyMaps = { grokProjectByRoot: {}, mcpJsonByRoot: {} };

  const board = (
    over: Partial<{ roots: string[]; repoOf: Record<string, string>; ownRoot?: string }> = {}
  ) => ({
    roots: over.roots ?? [REPO],
    repos: [{ root: REPO, label: 'project' }],
    repoOf: over.repoOf ?? { [REPO]: REPO },
    ownRoot: over.ownRoot ?? REPO
  });

  const filler = Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [
      `filler-${i}`,
      { type: 'http', url: `https://mcp.filler-${i}.test/mcp` }
    ])
  );

  const smokeTexts = () => ({
    claudeConfig: JSON.stringify({
      projects: {
        [REPO]: {
          mcpServers: {
            [SERVER]: { type: 'http', url: SMOKE_URL },
            ...filler
          }
        }
      }
    }),
    grokUserConfig: `[mcp_servers.${SERVER}]\nurl = "${SMOKE_URL}"\nenabled = true\n`,
    grokCredentials: JSON.stringify({ [`${SERVER}:${SMOKE_URL}`]: { token_response: {} } }),
    needsAuthCache: JSON.stringify({ [SERVER]: { timestamp: 1 } }),
    ...emptyMaps
  });

  it('remaps a project declaration through repoOf and leaves local on the directory it was written under', () => {
    const { rows } = foldNativeMcp({
      texts: {
        claudeConfig: JSON.stringify({
          projects: {
            [TREE]: { mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }
          }
        }),
        mcpJsonByRoot: {
          [TREE]: JSON.stringify({
            mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }
          })
        },
        grokProjectByRoot: {}
      },
      board: board({ roots: [TREE, REPO], repoOf: { [TREE]: REPO, [REPO]: REPO } }),
      canLogin: true
    });
    const slack = rows.find((r) => r.name === 'slack');
    const linear = rows.find((r) => r.name === 'linear');
    assert.deepEqual(slack?.entries, [{ root: TREE, scope: 'local' }]);
    assert.deepEqual(linear?.entries, [{ root: REPO, scope: 'project' }]);
  });

  it('uses repoOf[root] ?? root when remapping project', () => {
    const { rows } = foldNativeMcp({
      texts: {
        claudeConfig: '{}',
        mcpJsonByRoot: {
          [TREE]: JSON.stringify({
            mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }
          })
        },
        grokProjectByRoot: {}
      },
      board: board({ roots: [TREE], repoOf: {} }),
      canLogin: true
    });
    assert.deepEqual(rows[0]?.entries, [{ root: TREE, scope: 'project' }]);
  });

  it('does not overlay Claude health onto a Grok row of the same name', () => {
    const health = new Map<string, McpHealth>([
      [
        healthKey(REPO, 'linear'),
        { state: 'broken', url: 'https://mcp.linear.app/mcp', note: 'Claude-only' }
      ]
    ]);
    const { rows } = foldNativeMcp({
      texts: {
        grokProjectByRoot: {
          [REPO]: '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'
        },
        mcpJsonByRoot: {}
      },
      health,
      board: board(),
      canLogin: true
    });
    const grok = rows.find((r) => r.brand === 'grok');
    assert.equal(grok?.state, 'needs');
    assert.equal(grok?.answeredBy, undefined);
    assert.equal(grok?.note, undefined);
  });

  it('matches the smoke fixture fold: twelve repo rows, Grok of the same url trailing, one Authorise', () => {
    const { rows } = foldNativeMcp({
      texts: smokeTexts(),
      board: board(),
      canLogin: true
    });
    const view = foldMcpView({
      rows,
      repos: [{ root: REPO, label: 'project' }],
      ownRoot: REPO
    });
    const repo = view.groups.find((g) => g.root === REPO);
    const machine = view.groups.find((g) => g.root === '');
    assert.equal(repo?.servers.length, 12, 'every configured Claude server drew a row');
    assert.equal(repo?.servers.filter((s) => s.name === SERVER).length, 1);
    const claude = repo?.servers
      .find((s) => s.name === SERVER)
      ?.brands.find((c) => c.brand === 'claude');
    const grok = machine?.servers
      .find((s) => s.name === SERVER)
      ?.brands.find((c) => c.brand === 'grok');
    assert.equal(claude?.state, 'needs');
    assert.equal(claude?.supported, true);
    assert.equal(grok?.state, 'ok');
    assert.equal(
      repo?.servers.find((s) => s.name === SERVER)?.brands.some((c) => c.brand === 'grok'),
      false,
      "a machine-wide login is not the repo's"
    );
    const authorise = view.groups
      .flatMap((g) => g.servers.flatMap((s) => s.brands))
      .filter((c) => c.state === 'needs' && c.supported && !c.fromAccount);
    assert.equal(authorise.length, 1);
    assert.equal(authorise[0]?.name, SERVER);
    assert.equal(authorise[0]?.brand, 'claude');
  });
});

it('keeps declaration identity before repo remapping and URL alias folding', () => {
  const root = path.resolve('/repo/b');
  const nested = path.join(root, 'nested');
  const texts = {
    grokProjectByRoot: { [nested]: '[mcp_servers.alias_b]\nurl = "https://same.example/mcp"\n' },
    grokUserConfig: '[mcp_servers.alias_user]\nurl = "https://same.example/mcp"\n',
    mcpJsonByRoot: {}
  };
  const { rows } = foldNativeMcp({
    texts,
    board: {
      roots: [nested],
      repos: [{ root, label: 'b' }],
      repoOf: { [nested]: root }
    }
  });
  const view = foldMcpView({ rows });
  const project = view.groups.find((g) => g.root === root)?.servers.flatMap((s) => s.brands)[0];
  const user = view.groups.find((g) => g.root === '')?.servers.flatMap((s) => s.brands)[0];
  assert.equal(project?.name, 'alias_b');
  assert.deepEqual(project?.target?.declaration, { scope: 'project', root: nested });
  assert.equal(project?.target?.readCwd, nested);
  assert.equal(user?.name, 'alias_user');
  assert.deepEqual(user?.target?.declaration, { scope: 'user' });
});
