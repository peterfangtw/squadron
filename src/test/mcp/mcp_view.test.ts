import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpRow } from '../../core/claude/mcp';
import { mcpRows, parseMcpServers, parseUserMcpServers } from '../../core/claude/mcp';
import { grokMcpRows, parseGrokMcpServers } from '../../core/grok/mcp';
import type { McpActionTarget } from '../../core/mcp_target';
import { foldMcpView, type McpLoginLive } from '../../core/mcp';
import { CONFIG } from './mcp_helpers';

describe('foldMcpView', () => {
  /** Every row the view holds, in section order. The view itself carries no
   *  flat list: two representations of one set is one of them going stale. */
  const rows = (view: McpView): McpServerView[] => view.groups.flatMap((g) => g.servers);

  const claude = () =>
    mcpRows(parseMcpServers(CONFIG, ['/Users/x/acme-web']), new Set(['slack']), true);
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
  const liveTarget = (brand: BrandId, name: string, canLogin = true): McpActionTarget => {
    const row = [...claude(), ...grok()].find((row) => row.brand === brand && row.name === name);
    const ref = row?.declarations?.[0]?.ref ?? {
      brand,
      name,
      key: 'https://gone.example/mcp',
      url: 'https://gone.example/mcp',
      declaration: { scope: 'user' as const },
      readCwd: '/home/reader'
    };
    return { ...ref, canLogin, canDisconnect: row?.canDisconnect ?? false };
  };
  const fold = (
    claudeRows: readonly McpRow[],
    grokRows: readonly McpRow[] = [],
    extra?: { live?: McpLoginLive }
  ) => foldMcpView({ rows: [...claudeRows, ...grokRows], ...extra });

  it('is Claude-only when Grok lists nothing', () => {
    const view = fold(claude());
    assert.deepEqual(
      rows(view).map((s) => [s.name, s.brands.map((c) => c.brand)]),
      [
        ['linear', ['claude']],
        ['slack', ['claude']]
      ]
    );
    assert.equal(view.summary, 'Slack needs Claude');
  });

  it('is Grok-only when Claude lists nothing, with empty projects', () => {
    const view = fold([], grok());
    assert.deepEqual(rows(view)[0]?.projects, []);
    assert.deepEqual(
      rows(view).map((s) => [s.name, s.brands.map((c) => [c.brand, c.state])]),
      [
        ['linear', [['grok', 'ok']]],
        ['slack', [['grok', 'needs']]]
      ]
    );
    assert.equal(view.summary, 'Slack needs Grok');
  });

  it('keeps a repo row and a machine-wide one apart, even at one url', () => {
    // The price of the rule, and it was taken deliberately: Grok's *user*
    // config has no repo, so its `slack` is not acme-web's `slack` — it
    // only shares a url with it. Joining them put a machine-wide cell on a
    // repo's row, where Disconnect read as reaching that repo alone.
    const view = fold(claude(), grok());
    const repo = view.groups.find((g) => g.root === '/Users/x/acme-web');
    const machine = view.groups.find((g) => g.root === '');
    assert.deepEqual(
      repo?.servers.find((s) => s.name === 'slack')?.brands.map((c) => [c.brand, c.state]),
      [['claude', 'needs']]
    );
    assert.deepEqual(
      machine?.servers.find((s) => s.name === 'slack')?.brands.map((c) => [c.brand, c.state]),
      [['grok', 'needs']]
    );
    assert.equal(view.summary, 'Slack needs Claude');
  });

  it('folds a shared url into one row with two cells, inside one section', () => {
    // Both machine-wide, so both are on the same page and the join applies.
    const view = fold(
      mcpRows(
        parseUserMcpServers(
          JSON.stringify({
            mcpServers: {
              slack: { type: 'http', url: 'https://mcp.slack.com/mcp' }
            }
          })
        ),
        new Set(['slack']),
        true
      ),
      grok()
    );
    const machine = view.groups.find((g) => g.root === '');
    assert.equal(view.groups.length, 1, 'a user-scope server declares no repo');
    assert.deepEqual(
      machine?.servers
        .find((s) => s.name === 'slack')
        ?.brands.map((c) => [c.brand, c.state, c.label]),
      [
        ['claude', 'needs', 'Claude'],
        ['grok', 'needs', 'Grok']
      ]
    );
  });

  it('does not invent a Grok cell for a url only Claude has', () => {
    const view = fold(
      claude(),
      grokMcpRows(
        parseGrokMcpServers('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'),
        new Set()
      )
    );
    assert.deepEqual(
      rows(view)
        .find((s) => s.name === 'slack')
        ?.brands.map((c) => c.brand),
      ['claude']
    );
  });

  it('treats a missing Grok home as no Grok cells', () => {
    const view = fold(claude());
    assert.ok(rows(view).every((s) => s.brands.every((c) => c.brand === 'claude')));
  });

  it('says All connected when every cell is ok', () => {
    const view = fold(
      mcpRows(parseMcpServers(CONFIG, ['/Users/x/acme-web']), new Set(), true),
      grokMcpRows(
        parseGrokMcpServers('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'),
        new Set(['linear:https://mcp.linear.app/mcp'])
      )
    );
    assert.equal(view.summary, 'All connected');
  });

  it("carries a broken row's reason onto its cell, where the sheet draws it", () => {
    // The note is the only thing that says what is wrong. It rides McpRow ->
    // McpBrandCell; dropping it here leaves a cell saying Unreachable and no
    // more, which the type system does not notice.
    const view = fold([
      {
        brand: 'claude',
        canLogin: true,
        canDisconnect: true,
        name: 'sentry',
        key: 'https://mcp.sentry.dev/sse',
        url: 'https://mcp.sentry.dev/sse',
        host: 'mcp.sentry.dev',
        projects: ['shop'],
        entries: [{ root: '/Users/x/shop', scope: 'local' }],
        state: 'broken',
        note: 'Failed to connect — HTTP 200: SSE error: Invalid content type'
      }
    ]);
    assert.match(rows(view)[0]?.brands[0]?.note ?? '', /Invalid content type/);
  });

  it('does not say a broken server needs a login — it has one', () => {
    // "Sentry needs Claude" is false: it is authorised and unreachable.
    const view = fold([
      {
        brand: 'claude',
        canLogin: true,
        canDisconnect: true,
        name: 'sentry',
        key: 'https://mcp.sentry.dev/sse',
        url: 'https://mcp.sentry.dev/sse',
        host: 'mcp.sentry.dev',
        projects: ['shop'],
        entries: [{ root: '/Users/x/shop', scope: 'local' }],
        state: 'broken'
      }
    ]);
    assert.equal(view.summary, 'Sentry is unreachable');
  });

  it('says a pending server is unapproved rather than unauthorised', () => {
    const view = fold([
      {
        brand: 'claude',
        canLogin: true,
        canDisconnect: true,
        name: 'notion',
        key: 'https://mcp.notion.com/mcp',
        url: 'https://mcp.notion.com/mcp',
        host: 'mcp.notion.com',
        projects: ['shop'],
        entries: [{ root: '/Users/x/shop', scope: 'project' }],
        state: 'pending'
      }
    ]);
    assert.equal(view.summary, 'Notion is not approved');
  });

  it('has no summary when there are no servers', () => {
    const view = fold([]);
    assert.equal(view.summary, undefined);
    assert.match(view.hint ?? '', /claude mcp add/);
    assert.match(view.hint ?? '', /grok mcp add/);
  });

  it('lays the live login over its own brand cell and no other', () => {
    const view = fold(claude(), grok(), {
      live: {
        target: liveTarget('claude', 'slack'),
        phase: 'browser',
        note: 'Open this…',
        url: 'https://x?code_challenge=a'
      }
    });
    const claudeSlack = view.groups
      .find((g) => g.root === '/Users/x/acme-web')
      ?.servers.find((s) => s.name === 'slack');
    assert.equal(claudeSlack?.brands[0]?.state, 'busy');
    assert.equal(claudeSlack?.brands[0]?.url, 'https://x?code_challenge=a');
    const grokSlack = view.groups
      .find((g) => g.root === '')
      ?.servers.find((s) => s.name === 'slack');
    assert.equal(grokSlack?.brands[0]?.state, 'needs', 'the other brand is untouched');
    assert.equal(grokSlack?.brands[0]?.url, undefined);
  });

  it('draws an errored login as error, not busy', () => {
    const view = fold(claude(), [], {
      live: { target: liveTarget('claude', 'slack'), phase: 'error', note: 'nope' }
    });
    assert.equal(rows(view)[1]?.brands[0]?.state, 'error');
    assert.equal(rows(view)[1]?.brands[0]?.note, 'nope');
  });

  it('paints a finished login connected, before the disk can say so', () => {
    const view = fold(claude(), [], {
      live: { target: liveTarget('claude', 'slack'), phase: 'done' }
    });
    assert.equal(rows(view)[1]?.brands[0]?.state, 'ok');
  });

  it('keeps a row for a login whose server has left the config', () => {
    const view = fold([], [], {
      live: { target: liveTarget('grok', 'gone'), phase: 'waiting', note: 'Waiting…' }
    });
    assert.equal(rows(view).length, 1);
    assert.equal(rows(view)[0]?.name, 'gone');
    assert.equal(rows(view)[0]?.brands[0]?.state, 'busy');
    assert.doesNotMatch(view.hint ?? '', /No MCP servers configured/);
  });

  it("gives an orphaned login's cell the capability its live record carries, whatever the brand", () => {
    // A remaining Claude row says it can log in; the record's answer still wins.
    const claudeView = fold(claude(), [], {
      live: { target: liveTarget('claude', 'gone', false), phase: 'waiting' }
    });
    const orphan = rows(claudeView).find((s) => s.name === 'gone');
    assert.equal(orphan?.brands[0]?.supported, false);
    const grokView = fold([], [], {
      live: { target: liveTarget('grok', 'gone', false), phase: 'waiting' }
    });
    assert.equal(rows(grokView)[0]?.brands[0]?.supported, false);
  });

  it('marks Claude cells unsupported when their producer refuses login', () => {
    const view = fold(
      claude().map((r) => ({ ...r, canLogin: false })),
      grok()
    );
    const cells = rows(view).flatMap((s) => s.brands);
    assert.equal(
      cells.every((c) => c.supported === (c.brand !== 'claude')),
      true
    );
    assert.match(view.hint ?? '', /not available on this host/);
    assert.match(view.hint ?? '', /claude mcp login/);
  });

  it('no longer claims a login is machine-global', () => {
    const view = fold(claude(), grok());
    assert.match(view.hint ?? '', /own login/);
    assert.doesNotMatch(view.hint ?? '', /once per machine/);
  });

  it('names no surface of ours in any hint it can produce', () => {
    const hints = [
      fold([]).hint,
      fold(claude(), grok()).hint,
      fold(
        claude().map((r) => ({ ...r, canLogin: false })),
        grok()
      ).hint
    ];
    for (const hint of hints) {
      assert.doesNotMatch(hint ?? '', /\b(panel|board|dock|card|sheet)\b/i, hint);
    }
  });
});

/**
 * Codex at the fold. Its reader is tested in `codex_mcp.test.ts`; these are
 * about what the brand-free registry does once its rows arrive — which is
 * mostly the same thing it does for the other two, and once deliberately not.
 */
describe('the fold — Codex rows', () => {
  const ACME = '/repos/acme-web';

  const codexHttp = (over: Partial<McpRow> = {}): McpRow => ({
    brand: 'codex',
    canLogin: true,
    canDisconnect: true,
    name: 'linear',
    key: 'https://mcp.linear.app/mcp',
    url: 'https://mcp.linear.app/mcp',
    host: 'mcp.linear.app',
    projects: [],
    entries: [],
    state: 'ok',
    ...over
  });

  const codexStdio = (over: Partial<McpRow> = {}): McpRow => ({
    brand: 'codex',
    canLogin: true,
    canDisconnect: false,
    name: 'pencil',
    key: `codex|${ACME}|pencil`,
    host: 'STDIO · pencil-server',
    projects: ['acme-web'],
    entries: [{ root: ACME, scope: 'project' }],
    state: 'ok',
    ...over
  });

  const claudeAt = (): McpRow => ({
    brand: 'claude',
    canLogin: true,
    canDisconnect: true,
    name: 'linear',
    key: 'https://mcp.linear.app/mcp',
    url: 'https://mcp.linear.app/mcp',
    host: 'mcp.linear.app',
    projects: [],
    entries: [],
    state: 'needs'
  });

  const seen = (view: McpView) => view.groups.flatMap((g) => g.servers);

  it('joins a Codex http row onto another brand’s row for the same url', () => {
    const view = foldMcpView({ rows: [claudeAt(), codexHttp()] });
    const [row, ...rest] = seen(view);
    assert.deepEqual(rest, [], 'one url is one row');
    assert.deepEqual(
      row?.brands.map((c) => [c.brand, c.state]),
      [
        ['claude', 'needs'],
        ['codex', 'ok']
      ]
    );
  });

  it('keeps a STDIO row to itself, since nobody else is talking to that process', () => {
    const view = foldMcpView({ rows: [claudeAt(), codexStdio()] });
    assert.equal(seen(view).length, 2);
    const stdio = seen(view).find((s) => s.name === 'pencil');
    assert.deepEqual(
      stdio?.brands.map((c) => c.brand),
      ['codex']
    );
  });

  it('carries the credential answer through to the cell, both ways', () => {
    const view = foldMcpView({ rows: [codexHttp({ canDisconnect: false })] });
    assert.equal(seen(view)[0]?.brands[0]?.canDisconnect, false);
    const owned = foldMcpView({ rows: [codexHttp({ canDisconnect: true })] });
    assert.equal(seen(owned)[0]?.brands[0]?.canDisconnect, true);
  });

  it('says a status was not checked rather than naming a brand to blame', () => {
    const view = foldMcpView({ rows: [codexHttp({ state: 'unknown', canDisconnect: false })] });
    assert.equal(view.summary, 'Status not checked');
    assert.equal(view.summaryWants, false, 'nothing here is the reader’s to fix');
  });

  it('lets a real failure outrank an unknown one', () => {
    const view = foldMcpView({
      rows: [codexHttp({ state: 'unknown', canDisconnect: false }), claudeAt()]
    });
    assert.equal(view.summary, 'Linear needs Claude');
    assert.equal(view.summaryWants, true);
  });

  it('files a project-scoped Codex row under its repo', () => {
    const { groups } = foldMcpView({
      rows: [codexStdio()],
      repos: [{ root: ACME, label: 'acme-web' }],
      ownRoot: ACME
    });
    assert.deepEqual(
      groups.map((g) => [g.label, g.servers.map((s) => s.name)]),
      [['acme-web', ['pencil']]]
    );
  });

  it('leaves a user-scoped Codex row in the section for what belongs to no repo', () => {
    const { groups } = foldMcpView({
      rows: [codexHttp()],
      repos: [{ root: ACME, label: 'acme-web' }],
      ownRoot: ACME
    });
    assert.deepEqual(
      groups.at(-1)?.servers.map((s) => s.name),
      ['linear']
    );
    assert.equal(groups.at(-1)?.root, '', 'the trailing section has no root');
  });
});
