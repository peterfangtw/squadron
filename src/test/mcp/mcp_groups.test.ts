import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpRow } from '../../core/claude/mcp';
import { grokMcpRows, parseGrokMcpServers } from '../../core/grok/mcp';
import { foldMcpView } from '../../core/mcp';

describe('foldMcpView sections', () => {
  /**
   * The machine as it was read on 2026-08-19, which is what the sections were
   * designed against: two repos declaring servers, one open window declaring
   * none, one url in both repos, and Grok's user config.
   */
  const SHOP = '/Users/x/shop-app';
  const ACME = '/Users/x/acme-web';
  const OWN = '/Users/x/agentsview';

  const claude = (): McpRow[] => [
    {
      brand: 'claude',
      canLogin: true,
      canDisconnect: true,
      name: 'linear',
      key: 'https://mcp.linear.app/mcp',
      url: 'https://mcp.linear.app/mcp',
      host: 'mcp.linear.app',
      projects: ['shop-app', 'acme-web'],
      entries: [
        { root: SHOP, scope: 'project' },
        { root: ACME, scope: 'local' }
      ],
      state: 'ok'
    },
    {
      brand: 'claude',
      canLogin: true,
      canDisconnect: true,
      name: 'notion',
      key: 'https://mcp.notion.com/mcp',
      url: 'https://mcp.notion.com/mcp',
      host: 'mcp.notion.com',
      projects: ['shop-app'],
      entries: [{ root: SHOP, scope: 'project' }],
      state: 'pending',
      note: 'Run claude in that directory to approve it'
    },
    {
      brand: 'claude',
      canLogin: true,
      canDisconnect: true,
      name: 'sentry',
      key: 'https://mcp.sentry.dev/sse',
      url: 'https://mcp.sentry.dev/sse',
      host: 'mcp.sentry.dev',
      projects: ['shop-app'],
      entries: [{ root: SHOP, scope: 'local' }],
      state: 'broken'
    },
    {
      brand: 'claude',
      canLogin: true,
      canDisconnect: true,
      name: 'slack',
      key: 'https://mcp.slack.com/mcp',
      url: 'https://mcp.slack.com/mcp',
      host: 'mcp.slack.com',
      projects: ['acme-web'],
      entries: [{ root: ACME, scope: 'local' }],
      state: 'ok'
    },
    {
      brand: 'claude',
      canLogin: true,
      canDisconnect: false,
      name: 'claude.ai Slack',
      key: 'https://mcp.slack.com/mcp',
      url: 'https://mcp.slack.com/mcp',
      host: 'mcp.slack.com',
      projects: [],
      entries: [],
      state: 'ok',
      fromAccount: true
    }
  ];

  const grok = () =>
    grokMcpRows(
      parseGrokMcpServers(
        [
          '[mcp_servers.linear]',
          'url = "https://mcp.linear.app/mcp"',
          '[mcp_servers.slack]',
          'url = "https://mcp.slack.com/mcp"'
        ].join('\n')
      ),
      new Set(['linear:https://mcp.linear.app/mcp'])
    );

  const repos = [
    { root: SHOP, label: 'shop-app', path: '~/shop-app' },
    { root: ACME, label: 'acme-web', path: '~/acme-web' },
    { root: OWN, label: 'agentsview', path: '~/agentsview' }
  ];

  const group = (
    claudeRows: readonly McpRow[],
    grokRows: readonly McpRow[] = [],
    extra: {
      repos?: readonly { root: string; label: string; path?: string }[];
      ownRoot?: string;
    } = { repos, ownRoot: OWN }
  ) => foldMcpView({ rows: [...claudeRows, ...grokRows], ...extra }).groups;

  const board = () => group(claude(), grok());

  it('draws one section per repo, this window first and the rest by name', () => {
    assert.deepEqual(
      board().map((g) => [g.label, g.servers.map((s) => s.name)]),
      [
        ['agentsview', []],
        ['acme-web', ['linear', 'slack']],
        ['shop-app', ['linear', 'notion', 'sentry']],
        ['Not from a repo', ['claude.ai Slack', 'linear']]
      ]
    );
    assert.equal(board()[0]?.here, true);
    assert.equal(board()[1]?.here, undefined);
  });

  it('gives a repo with nothing configured a line rather than an empty section', () => {
    const own = board()[0];
    assert.equal(own?.servers.length, 0);
    assert.match(own?.emptyLine ?? '', /claude mcp add/);
    assert.equal(board()[1]?.emptyLine, undefined, 'a section with servers says nothing');
  });

  it('draws a url two repos declare in both, each tagged with the other', () => {
    const groups = board();
    const shop = groups.find((g) => g.root === SHOP);
    const acme = groups.find((g) => g.root === ACME);
    const there = shop?.servers.find((s) => s.name === 'linear');
    const here = acme?.servers.find((s) => s.name === 'linear');
    assert.deepEqual(there?.alsoIn, ['acme-web']);
    assert.deepEqual(here?.alsoIn, ['shop-app']);
    // One name, two scopes: which one is the thing the chip is for.
    assert.equal(there?.scope, 'project');
    assert.equal(here?.scope, 'local');
  });

  it('gives each copy of a shared row the root of the section it is in', () => {
    // A verb is about the repo the reader is looking at, and each brand keys
    // its token by name *and* url hash.
    const groups = board();
    assert.equal(
      groups.find((g) => g.root === SHOP)?.servers.find((s) => s.name === 'linear')?.brands[0]
        ?.root,
      SHOP
    );
    assert.equal(
      groups.find((g) => g.root === ACME)?.servers.find((s) => s.name === 'linear')?.brands[0]
        ?.root,
      ACME
    );
  });

  it('keeps user-scope Grok out of the repo sections', () => {
    // `~/.grok/config.toml` belongs to no repo. A project `.grok/config.toml`
    // is the other case, and lands in the repo section below.
    const repoCells = board()
      .filter((g) => g.root)
      .flatMap((g) => g.servers.flatMap((s) => s.brands));
    assert.equal(
      repoCells.every((c) => c.brand === 'claude'),
      true
    );
  });

  it("draws a project .grok/config.toml in that repo's section", () => {
    const groups = group(
      claude(),
      grokMcpRows(
        parseGrokMcpServers('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n', {
          project: ACME,
          scope: 'project'
        }),
        new Set()
      )
    );
    const acme = groups.find((g) => g.root === ACME);
    const linear = acme?.servers.find((s) => s.name === 'linear');
    assert.deepEqual(
      linear?.brands.map((c) => c.brand),
      ['claude', 'grok']
    );
    assert.equal(linear?.scope, 'local', "Claude's local chip is this copy's");
    const machine = groups.find((g) => g.root === '');
    assert.equal(
      machine?.servers.some((s) => s.brands.some((c) => c.brand === 'grok')),
      false,
      'project Grok does not also sit in the trailing section'
    );
  });

  it('gives a Grok-only project server a project chip in its repo', () => {
    const groups = group(
      [],
      grokMcpRows(
        parseGrokMcpServers('[mcp_servers.probe]\nurl = "https://probe.example/mcp"\n', {
          project: OWN,
          scope: 'project'
        }),
        new Set()
      )
    );
    const own = groups.find((g) => g.root === OWN);
    const probe = own?.servers.find((s) => s.name === 'probe');
    assert.equal(probe?.scope, 'project');
    assert.equal(probe?.brands[0]?.brand, 'grok');
    assert.equal(probe?.brands[0]?.root, OWN);
  });

  it('joins the two brands at one url in the trailing section, and only there', () => {
    // Grok's `slack` and the claude.ai connector are both
    // https://mcp.slack.com/mcp, and both are machine-wide — so they are one
    // row with two cells. acme-web's `slack` is the same url and stays
    // its own row, because it is not the same declaration.
    const machine = board().find((g) => g.root === '');
    const slack = machine?.servers.find((s) => s.host === 'mcp.slack.com');
    assert.deepEqual(
      slack?.brands.map((c) => [c.brand, c.state]),
      [
        ['claude', 'ok'],
        ['grok', 'needs']
      ]
    );
    assert.equal(slack?.brands[0]?.fromAccount, true, 'nothing to disconnect on the connector');
  });

  it('still draws a repo the board never mentioned, if a server names it', () => {
    // Degrade by shrinking a label, never by losing a server.
    const groups = group(claude(), [], { repos: [], ownRoot: undefined });
    assert.deepEqual(
      groups.map((g) => g.label),
      ['acme-web', 'shop-app', 'Not from a repo']
    );
  });

  it('keeps both machine-wide rows at one url, as two cells on one row', () => {
    // `mcpRows` folds Claude's own rows by url, but the connector is appended
    // after it — so two entry-less rows can arrive at one url, and a `set` on
    // that url dropped whichever came first along with its Authorise.
    const groups = group(
      [
        {
          brand: 'claude',
          canLogin: true,
          canDisconnect: true,
          name: 'slack',
          key: 'https://mcp.slack.com/mcp',
          url: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: [],
          entries: [],
          state: 'needs'
        },
        {
          brand: 'claude',
          canLogin: true,
          canDisconnect: false,
          name: 'claude.ai Slack',
          key: 'https://mcp.slack.com/mcp',
          url: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: [],
          entries: [],
          state: 'ok',
          fromAccount: true
        }
      ],
      [],
      { repos: [] }
    );
    const machine = groups.find((g) => g.root === '');
    assert.equal(machine?.servers.length, 1, 'one url is one row');
    assert.deepEqual(
      machine?.servers[0]?.brands.map((c) => [c.name, c.state]),
      [
        ['slack', 'needs'],
        ['claude.ai Slack', 'ok']
      ],
      'and the user-scope login is still there to authorise'
    );
  });

  it('gives this window a section even when the board named no repo for it', () => {
    // `repoRoots` is worktrees-only, so a window on an ordinary checkout is in
    // neither half of that map. Without this the sheet opens with every section
    // shut and the repo the reader is standing in is the one that is missing.
    const groups = group([], [], {
      repos: [{ root: '/r/other', label: 'other' }],
      ownRoot: '/r/mine'
    });
    assert.deepEqual(
      groups.map((g) => [g.label, g.here]),
      [
        ['mine', true],
        ['other', undefined]
      ]
    );
    assert.match(groups[0]?.emptyLine ?? '', /claude mcp add/);
  });

  it('does not duplicate this window when the board did name it', () => {
    const groups = group([], [], {
      repos: [{ root: '/var/folders/t/x', label: 'x', path: '~/x' }],
      ownRoot: '/private/var/folders/t/x'
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.path, '~/x', "the board's own row, not a synthesised one");
  });

  it('matches this window through the /private symlink macOS hands back', () => {
    // `os.tmpdir()` is /var/folders/…, a symlink to /private/var/folders/… —
    // a miss here shuts every section, including the one that should be open.
    const groups = group([], [], {
      repos: [{ root: '/var/folders/t/x', label: 'x' }],
      ownRoot: '/private/var/folders/t/x'
    });
    assert.equal(groups[0]?.here, true);
  });
});
