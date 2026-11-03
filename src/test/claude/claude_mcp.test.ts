import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it } from 'node:test';
import {
  claudeMcpRows,
  claudeMcpSnapshot,
  healthKey,
  type McpHealth,
  localOverProject,
  mcpRows,
  parseMcpHealth,
  parseMcpServers,
  parseNeedsAuth,
  parseProjectMcpServers,
  parseUserMcpServers
} from '../../core/claude/mcp';
import { CONFIG } from '../mcp/mcp_helpers';
import * as platform from '../../core/platform';
import * as windowsPaths from '../../core/platform/paths/win32';
import * as sharedMcp from '../../core/mcp';

describe('parseMcpServers', () => {
  it('matches Windows path identities while retaining the exact CLI cwd for actions and health', (t) => {
    t.mock.method(platform.paths, 'key', windowsPaths.paths().key);
    const root = 'c:\\repo',
      recorded = 'C:/repo';
    const config = JSON.stringify({
      projects: { [recorded]: { mcpServers: { probe: { url: 'https://example.test/mcp' } } } }
    });
    const rows = claudeMcpRows({
      servers: parseMcpServers(config, [root]),
      health: new Map([
        [
          healthKey(recorded, 'probe'),
          { state: 'broken', url: 'https://example.test/mcp', note: 'server unavailable' }
        ]
      ])
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, 'broken');
    assert.equal(rows[0]?.declarations?.[0]?.ref.readCwd, recorded);
    assert.deepEqual(rows[0]?.entries, [{ root, scope: 'local' }]);
    assert.deepEqual(sharedMcp.healthRoots(rows, [root], 'claude'), [recorded]);
    assert.deepEqual(parseMcpServers(config, ['c:\\Repo']), [], 'component case stays significant');
  });

  it('refuses ambiguous Windows project aliases instead of choosing a declaration', (t) => {
    t.mock.method(platform.paths, 'key', windowsPaths.paths().key);
    const entry = { mcpServers: { probe: { url: 'https://example.test/mcp' } } };
    assert.deepEqual(
      parseMcpServers(JSON.stringify({ projects: { 'C:/repo': entry, 'c:\\repo': entry } }), [
        'c:\\repo'
      ]),
      []
    );
  });
  it('reads only the roots asked for', () => {
    const servers = parseMcpServers(CONFIG, ['/Users/x/acme-web']);
    assert.deepEqual(
      servers.map((s) => s.name),
      ['linear', 'slack']
    );
    assert.equal(servers[0]?.project, '/Users/x/acme-web');
  });

  it('keeps the url and ignores the oauth block beside it', () => {
    const slack = parseMcpServers(CONFIG, ['/Users/x/acme-web']).find((s) => s.name === 'slack');
    // callbackPort is deliberately not read: the port is the CLI's business.
    assert.deepEqual(slack, {
      name: 'slack',
      url: 'https://mcp.slack.com/mcp',
      project: '/Users/x/acme-web',
      scope: 'local'
    });
  });

  it('is empty for a project with no servers, and for one with no mcpServers key', () => {
    assert.deepEqual(parseMcpServers(CONFIG, ['/Users/x/empty']), []);
    assert.deepEqual(parseMcpServers(CONFIG, ['/Users/x/nokey']), []);
  });

  it('is empty for a root the file has never heard of', () => {
    assert.deepEqual(parseMcpServers(CONFIG, ['/Users/x/nowhere']), []);
  });

  it('degrades to empty on junk rather than throwing', () => {
    assert.deepEqual(parseMcpServers('not json', ['/Users/x/acme-web']), []);
    assert.deepEqual(parseMcpServers('{}', ['/Users/x/acme-web']), []);
    assert.deepEqual(parseMcpServers('null', ['/Users/x/acme-web']), []);
  });

  it('skips an entry with no usable url', () => {
    const config = JSON.stringify({
      projects: { '/r': { mcpServers: { good: { url: 'https://a/mcp' }, bad: { type: 'stdio' } } } }
    });
    assert.deepEqual(
      parseMcpServers(config, ['/r']).map((s) => s.name),
      ['good']
    );
  });
});

describe('parseProjectMcpServers', () => {
  /** `shop-app/.mcp.json`, read 2026-08-19. Same shape as the local
   *  block one level up: no `projects`, straight to `mcpServers`. */
  const PROJECT = JSON.stringify({
    mcpServers: {
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' }
    }
  });

  it("reads a repo's own .mcp.json against that root", () => {
    assert.deepEqual(
      parseProjectMcpServers(PROJECT, '/Users/x/shop').map((s) => [s.name, s.scope, s.project]),
      [
        ['notion', 'project', '/Users/x/shop'],
        ['linear', 'project', '/Users/x/shop']
      ]
    );
  });

  it('skips a stdio server, which has no url and no login to offer', () => {
    const text = JSON.stringify({ mcpServers: { local: { command: 'node', args: ['s.js'] } } });
    assert.deepEqual(parseProjectMcpServers(text, '/r'), []);
  });

  it('shrinks rather than throws on anything unreadable', () => {
    for (const text of ['not json', '{}', 'null', '[]', '{"mcpServers":null}']) {
      assert.deepEqual(parseProjectMcpServers(text, '/r'), []);
    }
  });
});

describe('parseUserMcpServers', () => {
  it('prefers a user declaration home health answer over an older project answer', () => {
    const rows = claudeMcpRows({
      servers: parseUserMcpServers(
        JSON.stringify({ mcpServers: { probe: { url: 'https://example.test/mcp' } } })
      ),
      health: new Map([
        [
          healthKey(path.join(os.homedir(), 'project'), 'probe'),
          { state: 'needs', url: 'https://example.test/mcp' }
        ],
        [
          healthKey(os.homedir(), 'probe'),
          { state: 'broken', url: 'https://example.test/mcp', note: 'offline' }
        ]
      ])
    });
    assert.equal(rows[0]?.state, 'broken');
    assert.equal(rows[0]?.canDisconnect, true);
  });
  it('reads the top-level block, which belongs to no repo', () => {
    const text = JSON.stringify({
      mcpServers: { everywhere: { type: 'http', url: 'https://mcp.example.com/mcp' } },
      projects: { '/a': { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } } }
    });
    assert.deepEqual(
      parseUserMcpServers(text).map((s) => [s.name, s.scope, s.project]),
      [['everywhere', 'user', '']]
    );
  });

  it("is empty on this machine's real shape — top-level mcpServers is {}", () => {
    assert.deepEqual(parseUserMcpServers(JSON.stringify({ mcpServers: {} })), []);
  });
});

describe('localOverProject', () => {
  /** Verified 2026-08-19: one name in both scopes at two urls — `claude mcp get`
   *  reports `Scope: Local config` and `claude mcp list` prints only that one. */
  it('drops the project entry when local declares the same name in one root', () => {
    assert.deepEqual(
      localOverProject([
        { name: 'dup', url: 'https://project.example/mcp', project: '/r', scope: 'project' },
        { name: 'dup', url: 'https://local.example/mcp', project: '/r', scope: 'local' }
      ]).map((s) => [s.scope, s.url]),
      [['local', 'https://local.example/mcp']]
    );
  });

  it('leaves the same name alone in a different root', () => {
    assert.equal(
      localOverProject([
        { name: 'dup', url: 'https://a.example/mcp', project: '/a', scope: 'project' },
        { name: 'dup', url: 'https://b.example/mcp', project: '/b', scope: 'local' }
      ]).length,
      2
    );
  });

  it('never shadows a user server, whose scope has no root to collide in', () => {
    assert.equal(
      localOverProject([
        { name: 'dup', url: 'https://user.example/mcp', project: '', scope: 'user' },
        { name: 'dup', url: 'https://local.example/mcp', project: '/r', scope: 'local' }
      ]).length,
      2
    );
  });
});

describe('parseMcpHealth', () => {
  /** `claude mcp list` as CLI 2.1.226 printed it on 2026-08-19, server names
   *  and URLs swapped for public ones; the status words are verbatim.
   *  Exit 0 despite two failures, and `mcp-needs-auth-cache.json` stayed `{}` —
   *  which is the whole reason a dead server paints Connected today. */
  const REAL = [
    'Checking MCP server health…',
    '',
    'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected',
    'notion: https://mcp.notion.com/mcp (HTTP) - ✘ Failed to connect — MCP endpoint not found at https://mcp.notion.com. Check the URL in your MCP config.',
    'linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected',
    'sentry: https://mcp.sentry.dev/sse (SSE) - ✘ Failed to connect — HTTP 200: SSE error: Invalid content type, expected "text/event-stream"'
  ].join('\n');

  it('keeps the transport, and notes the one line that prints none', () => {
    // The connector is the only entry in this list that no config file on the
    // machine declares, and an absent transport is how it says so. Measured
    // 2026-08-19 — the line above is verbatim.
    const health = parseMcpHealth(REAL, '/r');
    assert.equal(health.get(healthKey('/r', 'claude.ai Slack'))?.transport, undefined);
    assert.equal(health.get(healthKey('/r', 'linear'))?.transport, 'HTTP');
    assert.equal(health.get(healthKey('/r', 'sentry'))?.transport, 'SSE');
  });

  it('reads all four, keyed by root and name', () => {
    for (const text of [REAL, REAL.replaceAll('✔', '√').replaceAll('✘', '×')]) {
      const health = parseMcpHealth(text, '/r');
      assert.deepEqual(
        [...health.entries()].map(([k, v]) => [k, v.state]),
        [
          [healthKey('/r', 'claude.ai Slack'), 'ok'],
          [healthKey('/r', 'notion'), 'broken'],
          [healthKey('/r', 'linear'), 'ok'],
          [healthKey('/r', 'sentry'), 'broken']
        ]
      );
    }
  });

  it('keeps the reason, which is the only thing that says what is wrong', () => {
    const health = parseMcpHealth(REAL, '/r');
    assert.match(health.get(healthKey('/r', 'sentry'))?.note ?? '', /Invalid content type/);
    assert.match(health.get(healthKey('/r', 'notion'))?.note ?? '', /endpoint not found/);
  });

  it('takes a name with a space in it, and a line with no (TYPE)', () => {
    // The claude.ai connector prints neither a transport nor a one-word name.
    assert.equal(parseMcpHealth(REAL, '/r').get(healthKey('/r', 'claude.ai Slack'))?.state, 'ok');
  });

  it('reads ⏸ as pending, which a two-marker parser would drop', () => {
    // Measured 2026-08-19 in a scratch dir whose .mcp.json was never approved.
    const text = [
      'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected',
      'probe-linear: https://mcp.linear.app/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)'
    ].join('\n');
    const health = parseMcpHealth(text, '/r');
    assert.equal(health.size, 2);
    assert.equal(health.get(healthKey('/r', 'probe-linear'))?.state, 'pending');
  });

  it('stops at the diagnostics block, whose lines also contain ": https://"', () => {
    const text = [
      'probe-dup: https://local.example/mcp (HTTP) - ✔ Connected',
      '',
      '[Conflicting scopes] ┌ Server "probe-dup" is defined in multiple scopes',
      'with different endpoints: project (https://p.example/mcp), local (https://local.example/mcp)'
    ].join('\n');
    assert.deepEqual([...parseMcpHealth(text, '/r').keys()], [healthKey('/r', 'probe-dup')]);
  });

  it('reads the ! marker, and its two-space padding', () => {
    // Verbatim `TASK_done_mcp_auth.md`, recorded 2026-08-10: the name is padded
    // to align with its neighbours. A three-marker single-space reader drops
    // this line, and it is the worst one to lose — an unauthenticated server
    // whose cache key is missing then goes on painting Connected.
    const text = [
      'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected',
      'linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected',
      'slack:  https://mcp.slack.com/mcp (HTTP) - ! Needs authentication'
    ].join('\n');
    const health = parseMcpHealth(text, '/r');
    assert.equal(health.size, 3);
    assert.equal(health.get(healthKey('/r', 'slack'))?.state, 'needs');
  });

  it('takes a transport label that is not one uppercase word', () => {
    // A dropped line is not a dropped server — the row keeps its disk state and
    // goes on saying Connected, so a rename here fails in the wrong direction.
    for (const label of ['(http)', '(Streamable HTTP)', '(SSE)']) {
      const text = `probe: https://x.example/mcp ${label} - ✘ Failed to connect — nope`;
      assert.equal(
        parseMcpHealth(text, '/r').get(healthKey('/r', 'probe'))?.state,
        'broken',
        label
      );
    }
  });

  it('keeps reading past a blank line between two entries', () => {
    const text = [
      'a: https://a.example/mcp - ✔ Connected',
      '',
      'b: https://b.example/mcp - ✔ Connected'
    ].join('\n');
    assert.equal(parseMcpHealth(text, '/r').size, 2);
  });

  it('is empty rather than wrong on output it does not recognise', () => {
    for (const text of ['', 'Checking MCP server health…', 'No MCP servers configured.']) {
      assert.equal(parseMcpHealth(text, '/r').size, 0);
    }
  });

  it('keeps the url, so a row can be joined to it', () => {
    assert.equal(
      parseMcpHealth(REAL, '/r').get(healthKey('/r', 'linear'))?.url,
      'https://mcp.linear.app/mcp'
    );
  });
});

describe('parseNeedsAuth', () => {
  it('reads the observed cache shape', () => {
    const names = parseNeedsAuth('{"linear":{"timestamp":1786384631074},"slack":{"timestamp":1}}');
    assert.deepEqual([...names].sort(), ['linear', 'slack']);
  });

  it('reads the empty cache the machine keeps when everything is connected', () => {
    assert.equal(parseNeedsAuth('{}').size, 0);
  });

  it('degrades to empty on junk', () => {
    assert.equal(parseNeedsAuth('').size, 0);
    assert.equal(parseNeedsAuth('[1,2]').size, 0);
  });
});

describe('mcpRows', () => {
  it('marks a server the cache names as needing auth', () => {
    const rows = mcpRows(parseMcpServers(CONFIG, ['/Users/x/acme-web']), new Set(['slack']), true);
    assert.deepEqual(
      rows.map((r) => [r.name, r.state]),
      [
        ['linear', 'ok'],
        ['slack', 'needs']
      ]
    );
    assert.equal(
      rows.every((r) => r.brand === 'claude' && r.canLogin === true),
      true
    );
  });

  it('folds two projects sharing one url into one row', () => {
    const config = JSON.stringify({
      projects: {
        '/a': { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } },
        '/b': { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } }
      }
    });
    const rows = mcpRows(parseMcpServers(config, ['/a', '/b']), new Set());
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.projects, ['a', 'b']);
  });

  it('keeps two rows when the same name points at different urls', () => {
    const config = JSON.stringify({
      projects: {
        '/a': { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } },
        '/b': { mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }
      }
    });
    // Different url = different keychain key = a separate login. Two rows.
    assert.equal(mcpRows(parseMcpServers(config, ['/a', '/b']), new Set()).length, 2);
  });

  it('drops a cache key with no configured server — the ghost', () => {
    // `claude mcp remove` leaves the key behind; observed 2026-08-11.
    const rows = mcpRows(parseMcpServers(CONFIG, ['/Users/x/empty']), new Set(['probeserver']));
    assert.deepEqual(rows, []);
  });

  it('carries every root and scope that reaches the url, not just the basename', () => {
    // `projects` is basenames and cannot be grouped by — two repos can share a
    // leaf name, as these two do. `entries` is what a per-repo section reads.
    const local = JSON.stringify({
      projects: { '/one/shop': { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } } }
    });
    const project = JSON.stringify({
      mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } }
    });
    const rows = mcpRows(
      [...parseMcpServers(local, ['/one/shop']), ...parseProjectMcpServers(project, '/two/shop')],
      new Set()
    );
    assert.equal(rows.length, 1);
    // The two repos collapse to one name here — `projects` dedupes by basename,
    // so one of them is simply gone. That is the loss `entries` exists to undo.
    assert.deepEqual(rows[0]?.projects, ['shop']);
    assert.deepEqual(rows[0]?.entries, [
      { root: '/one/shop', scope: 'local' },
      { root: '/two/shop', scope: 'project' }
    ]);
  });

  it('draws the host, not the whole url', () => {
    const rows = mcpRows(parseMcpServers(CONFIG, ['/Users/x/shop']), new Set());
    assert.equal(rows[0]?.host, 'mcp.sentry.dev');
  });
});

import { mcpAuthUrlFrom, mcpLoginReader } from '../../core/claude/mcp';
import type { McpLoginEvent } from '../../core/mcp';

describe('mcpAuthUrlFrom', () => {
  /** Captured 2026-08-11 from `script -q /dev/null claude mcp login … --no-browser`,
   *  CLI 2.1.226. The OSC-8 hyperlink wrapper is what a pty adds. */
  const PTY = [
    'Starting authentication for "probe2"…',
    'Visit this URL to authorize:',
    '  \x1b]8;;https://mcp.notion.com/authorize?response_type=code&code_challenge=BYZ8&code_challenge_method=S256\x07' +
      'https://mcp.notion.com/authorize?response_type=code&code_challenge=BYZ8&code_challenge_method=S256\x1b]8;;\x07',
    '',
    'Waiting for authorization… (^C to cancel)'
  ].join('\n');

  it('finds the url through the OSC-8 wrapper a pty adds', () => {
    assert.equal(
      mcpAuthUrlFrom(PTY),
      'https://mcp.notion.com/authorize?response_type=code&code_challenge=BYZ8&code_challenge_method=S256'
    );
  });

  it('finds it on an authorize path that is not /oauth/authorize', () => {
    // Notion's endpoint is /authorize; Claude login's fallback requires
    // /oauth/authorize and was measured not to match this output.
    assert.ok(mcpAuthUrlFrom(PTY)?.includes('mcp.notion.com/authorize'));
  });

  it('finds a url split off its label by a newline', () => {
    const text = 'Visit this URL to authorize:\n  https://x/auth?code_challenge=abc&state=1\n';
    assert.equal(mcpAuthUrlFrom(text), 'https://x/auth?code_challenge=abc&state=1');
  });

  it('says nothing when there is no PKCE challenge to key off', () => {
    assert.equal(mcpAuthUrlFrom('Visit https://example.com/ to authorize'), undefined);
    assert.equal(mcpAuthUrlFrom(''), undefined);
  });

  it('says nothing for the piped failure, which prints no url at all', () => {
    const piped =
      'Couldn\'t complete authentication for "probe2": stdin isn\'t a terminal, so ' +
      "authentication can't be completed here.";
    assert.equal(mcpAuthUrlFrom(piped), undefined);
  });

  it('strips CSI sequences the CLI redraws its prompt with', () => {
    // `script` ends every line CRLF, which is what terminates the url here.
    const text = '\x1b[1G\x1b[0Jhttps://x/auth?code_challenge=zz\x1b[33G\r\n';
    assert.equal(mcpAuthUrlFrom(text), 'https://x/auth?code_challenge=zz');
  });

  it('refuses a url that has not finished arriving', () => {
    // A chunk boundary inside the OSC-8 target leaves the escape unterminated,
    // so the strip does not fire and a raw url *prefix* is left in the text —
    // which matches `code_challenge=` just as well as the whole thing does.
    for (const cut of [95, 100, 140]) {
      assert.equal(mcpAuthUrlFrom(PTY.slice(0, cut)), undefined, `cut at ${cut}`);
    }
  });

  it('allows an unterminated url once the stream has ended', () => {
    const partial = 'Visit:\n  https://x/auth?code_challenge=abc';
    assert.equal(mcpAuthUrlFrom(partial), undefined);
    assert.equal(mcpAuthUrlFrom(partial, 'eof'), 'https://x/auth?code_challenge=abc');
  });
});

describe('mcpLoginReader', () => {
  it('refuses oversized incomplete lines and authorization URLs without emitting a truncated URL', () => {
    for (const text of [
      'x'.repeat(65537),
      `https://example.test/authorize?code_challenge=${'x'.repeat(16384)}\n`,
      `https://example.test/authorize?code_challenge=${'x'.repeat(16384)}`
    ]) {
      const events: McpLoginEvent[] = [];
      const reader = mcpLoginReader((event) => events.push(event));
      reader.read(text);
      assert.equal(reader.failed(), true, 'the limit applies before EOF');
      reader.finalise();
      assert.equal(reader.failed(), true);
      assert.equal(
        events.some((event) => event.type === 'url'),
        false
      );
    }
  });
  const drive = (chunks: string[], finalise = true) => {
    const events: string[] = [];
    const reader = mcpLoginReader((e) =>
      events.push(
        e.type === 'phase' ? `phase:${e.phase}` : e.type === 'url' ? `url:${e.url}` : `error`
      )
    );
    for (const chunk of chunks) reader.read(chunk);
    if (finalise) reader.finalise();
    return { events, reader };
  };

  it('emits the url once, whole, however the chunks fall', () => {
    for (const url of [
      'https://mcp.notion.com/authorize?code_challenge=BYZ8&code_challenge_method=S256',
      'http://127.0.0.1:3118/authorize?code_challenge=BYZ8&code_challenge_method=S256'
    ]) {
      const text = `Visit this URL to authorize:\r\n  ${url}\r\n\r\nWaiting for authorization… (^C to cancel)\r\n`;
      for (const size of [1, 7, 40, 200]) {
        const chunks = text.match(new RegExp(`.{1,${size}}`, 'gs')) ?? [];
        const { events } = drive(chunks);
        assert.deepEqual(
          events,
          [`url:${url}`, 'phase:browser', 'phase:waiting'],
          `${new URL(url).protocol} chunk size ${size}`
        );
      }
    }
  });

  it('says waiting exactly once however long the CLI keeps writing', () => {
    const { events } = drive([
      'https://x/auth?code_challenge=a\n',
      'Waiting for authorization…\n',
      'Waiting for authorization…\n',
      'still here\n'
    ]);
    assert.equal(events.filter((e) => e === 'phase:waiting').length, 1);
  });

  it('reports the piped refusal and emits no url', () => {
    const { events, reader } = drive([
      'Couldn\'t complete authentication for "x": stdin isn\'t a terminal.\n'
    ]);
    assert.ok(reader.failed());
    assert.deepEqual(events, ['error', 'phase:error']);
  });

  it('reports a failure that straddles a chunk boundary', () => {
    const { reader } = drive(["Couldn't complete authent", 'ication for "x": stdin.\n']);
    assert.ok(reader.failed());
  });

  it('still sees a failure after the buffer has been trimmed', () => {
    // The trim only runs once url and waiting are latched, so get there first,
    // then push far more than the cap before the line that matters.
    const { reader, events } = drive(
      [
        'https://x/auth?code_challenge=a\n',
        'Waiting for authorization…\n',
        'noise\n'.repeat(4000),
        'Couldn\'t complete authentication for "x": gave up.\n'
      ],
      false
    );
    assert.ok(reader.failed(), 'a trimmed buffer still catches the failure');
    assert.ok(events.includes('phase:error'));
  });

  it('keeps the unfinished line across a trim', () => {
    const { reader } = drive(
      [
        'https://x/auth?code_challenge=a\n',
        'Waiting for authorization…\n',
        'noise\n'.repeat(4000),
        "Couldn't complete authent",
        'ication for "x": gave up.\n'
      ],
      false
    );
    assert.ok(reader.failed(), 'the half line survived the trim that followed it');
  });

  it('emits the whole failure line, not the part that had arrived', () => {
    // The message goes onto the popover as the reader's only instruction, and
    // `[^\n]*` matches to the end of a buffer whose newline has not come yet.
    const line =
      'Couldn\'t complete authentication for "x": stdin isn\'t a terminal. ' +
      'Re-run in an interactive terminal and paste the redirect URL.\n';
    const messages: string[] = [];
    const reader = mcpLoginReader((e) => {
      if (e.type === 'error') messages.push(e.message);
    });
    reader.read(line.slice(0, 60));
    assert.equal(messages.length, 0, 'nothing emitted while the line is half there');
    reader.read(line.slice(60));
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.endsWith('paste the redirect URL.'), messages[0]);
  });

  it('quotes an early refusal that never printed a url', () => {
    const line = 'No MCP server named "linear". Configured servers: claude.ai Slack\n';
    const { reader } = drive([line]);
    assert.equal(reader.failed(), false, 'this sentence is not the stdin wall');
    assert.equal(
      reader.lastLine(),
      'No MCP server named "linear". Configured servers: claude.ai Slack'
    );
  });

  it('does not treat a later line as the reason once a url was shown', () => {
    const { reader } = drive([
      'https://x/auth?code_challenge=a\n',
      'Waiting for authorization…\n',
      'No MCP server named "linear".\n'
    ]);
    assert.equal(reader.lastLine(), undefined);
  });

  it('does not mangle a multi-byte character split across chunks', () => {
    // The em-dash is three bytes and the CLI really does emit one. Cut *inside*
    // it — `dash + 1` — and read the value back, so a U+FFFD would show. The
    // earlier version of this test cut on the boundary and asserted a substring
    // before it, and so passed with the decoder removed.
    const text = 'Couldn\'t complete authentication for "x": no tty — run it in a terminal.\n';
    const bytes = Buffer.from(text, 'utf8');
    const dash = bytes.indexOf(Buffer.from('—', 'utf8'));
    assert.ok(dash > 0, 'fixture contains the em-dash');
    const messages: string[] = [];
    const reader = mcpLoginReader((e) => {
      if (e.type === 'error') messages.push(e.message);
    });
    reader.read(bytes.subarray(0, dash + 1));
    reader.read(bytes.subarray(dash + 1));
    reader.finalise();
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('—'), messages[0]);
    assert.ok(!messages[0]?.includes('�'), 'no replacement character');
  });
});

describe('the fold — Codex rows', () => {
  const ACME = '/repos/acme-web';

  /**
   * The regression this pair exists for: `canDisconnect` was stamped `true` for
   * every Claude and Grok row, so a `needs` cell drew Disconnect where
   * Authorise belongs — and nothing on the sheet could start a login again.
   *
   * jsdom missed it because the panel fixtures stamp the flag themselves, so
   * they were right while the seams were wrong. Only smoke caught it. These
   * assert the *seams*, which is the half a fixture cannot stand in for.
   */
  it('never offers Disconnect on a Claude row that still needs auth', () => {
    const rows = mcpRows(
      parseMcpServers(
        JSON.stringify({
          projects: { [ACME]: { mcpServers: { linear: { type: 'http', url: 'https://l/mcp' } } } }
        }),
        [ACME]
      ),
      new Set(['linear']),
      true
    );
    assert.equal(rows[0]?.state, 'needs');
    assert.equal(rows[0]?.canDisconnect, false, 'a login to start, not a token to remove');
  });
});

it('does not apply a shadowing project’s health to a user declaration', () => {
  const root = path.resolve('/repo');
  for (const url of ['https://project.example/mcp', 'https://user.example/mcp']) {
    const rows = claudeMcpRows({
      servers: [
        { name: 'same', url: 'https://user.example/mcp', project: '', scope: 'user' },
        { name: 'same', url, project: root, scope: 'project' }
      ],
      health: parseMcpHealth(
        `same: ${url} (HTTP) - ⏸ Pending approval (run \`claude\` to approve)`,
        root
      ),
      canLogin: true
    });
    const user = rows.find((row) => row.declarations?.[0]?.ref.declaration.scope === 'user');
    const project = rows.find((row) => row.entries.length > 0);
    assert.equal(user?.state, 'ok');
    assert.equal(user?.canDisconnect, true);
    assert.equal(project?.state, 'pending');
  }
});

import { foldMcpView } from '../../core/mcp';
import type { foldNativeMcp } from '../mcp/mcp_helpers';

describe('Claude snapshot health before presentation grouping', () => {
  const REPO = '/Users/x/project';
  const TREE = '/Users/x/project-wt';
  const emptyMaps = { grokProjectByRoot: {}, mcpJsonByRoot: {} };
  const board = (
    over: Partial<{ roots: string[]; repoOf: Record<string, string>; ownRoot: string }> = {}
  ) => ({
    roots: over.roots ?? [REPO],
    repos: [{ root: REPO, label: 'project' }],
    repoOf: over.repoOf ?? {},
    ownRoot: over.ownRoot ?? REPO
  });
  const nativeSnapshot = (opts: Parameters<typeof foldNativeMcp>[0]) =>
    claudeMcpSnapshot({
      roots: opts.board.roots,
      config: opts.texts.claudeConfig,
      projectByRoot: opts.texts.mcpJsonByRoot,
      needsAuthCache: opts.texts.needsAuthCache,
      health: opts.health,
      canLogin: opts.canLogin
    });
  it('leaves a row with no health answer as it was', () => {
    const health = new Map<string, McpHealth>([
      [healthKey(REPO, 'other'), { state: 'broken', url: 'https://other.example/mcp' }]
    ]);
    const { rows } = nativeSnapshot({
      texts: {
        claudeConfig: JSON.stringify({
          projects: {
            [REPO]: { mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }
          }
        }),
        ...emptyMaps
      },
      health,
      board: board(),
      canLogin: true
    });
    assert.equal(rows[0]?.state, 'ok');
    assert.equal(rows[0]?.answeredBy, undefined);
  });
  it('takes the first answering root and records it as answeredBy', () => {
    const health = new Map<string, McpHealth>([
      [
        healthKey(REPO, 'linear'),
        { state: 'pending', url: 'https://mcp.linear.app/mcp', note: 'run claude here' }
      ]
    ]);
    const { rows } = nativeSnapshot({
      texts: {
        claudeConfig: JSON.stringify({
          projects: {
            [REPO]: { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
            [TREE]: { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }
          }
        }),
        grokProjectByRoot: {},
        mcpJsonByRoot: {}
      },
      health,
      board: board({ roots: [REPO, TREE], repoOf: { [REPO]: REPO, [TREE]: TREE } }),
      canLogin: true
    });
    const linear = rows.find((r) => r.name === 'linear');
    assert.equal(linear?.state, 'pending');
    assert.equal(linear?.answeredBy, REPO);
    assert.match(linear?.note ?? '', /run claude here/);
  });
  it('matches user-scope health on name and endpoint', () => {
    const health = new Map<string, McpHealth>([
      [
        healthKey(REPO, 'slack'),
        { state: 'broken', url: 'https://mcp.slack.com/mcp', note: 'down' }
      ]
    ]);
    const { rows } = nativeSnapshot({
      texts: {
        claudeConfig: JSON.stringify({
          mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } }
        }),
        ...emptyMaps
      },
      health,
      board: board(),
      canLogin: true
    });
    assert.equal(rows[0]?.state, 'broken');
    assert.equal(rows[0]?.answeredBy, REPO);
  });
  it('keeps cache needs over a list that says ok', () => {
    const health = new Map<string, McpHealth>([
      [healthKey(REPO, 'slack'), { state: 'ok', url: 'https://mcp.slack.com/mcp' }]
    ]);
    const { rows } = nativeSnapshot({
      texts: {
        claudeConfig: JSON.stringify({
          projects: {
            [REPO]: { mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }
          }
        }),
        needsAuthCache: JSON.stringify({ slack: { timestamp: 1 } }),
        ...emptyMaps
      },
      health,
      board: board(),
      canLogin: true
    });
    assert.equal(rows[0]?.state, 'needs');
    assert.equal(rows[0]?.answeredBy, undefined);
  });
  it('appends the account connector from health with no transport at an http url', () => {
    const health = new Map<string, McpHealth>([
      [healthKey(REPO, 'claude.ai Slack'), { state: 'ok', url: 'https://mcp.slack.com/mcp' }]
    ]);
    const { rows } = nativeSnapshot({
      texts: {
        claudeConfig: JSON.stringify({
          projects: {
            [REPO]: { mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }
          }
        }),
        ...emptyMaps
      },
      health,
      board: board(),
      canLogin: true
    });
    const connector = rows.find((r) => r.fromAccount);
    assert.equal(connector?.name, 'claude.ai Slack');
    assert.equal(connector?.brand, 'claude');
    assert.equal(connector?.canLogin, true);
    assert.equal(connector?.fromAccount, true);
    assert.equal(connector?.state, 'ok');
    assert.deepEqual(connector?.entries, []);
    const view = foldMcpView({
      rows,
      repos: [{ root: REPO, label: 'project' }],
      ownRoot: REPO
    });
    assert.doesNotMatch(view.hint ?? '', /macOS/);
  });
  it('does not call a stdio health line the account connector', () => {
    const health = new Map<string, McpHealth>([
      [healthKey(REPO, 'stdio'), { state: 'ok', url: '/usr/bin/mcp', transport: 'STDIO' }]
    ]);
    const { rows } = nativeSnapshot({
      texts: { ...emptyMaps },
      health,
      board: board(),
      canLogin: true
    });
    assert.equal(
      rows.some((r) => r.fromAccount),
      false
    );
  });
});
